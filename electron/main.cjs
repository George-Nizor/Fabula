"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, session, ipcMain, dialog, Menu, screen } = require("electron");

const MEDIA_ROOT = path.join(__dirname, "..", "media");
const POINTER = path.join(MEDIA_ROOT, "current-project.json");
const VIDEO_RE = /^\.(mp4|mov|mkv|webm|m4v)$/;

// The Instrumenta launcher's runtime check: it runs the bundle with this
// flag and a marker path, and expects the marker written and a clean exit
// before it will open the product. No window, no state, no side effects.
const checkFlag = process.argv.indexOf("--instrumenta-launch-check");
if (checkFlag >= 0) {
  const marker = process.argv[checkFlag + 1];
  try {
    fs.writeFileSync(marker, `FABULA_LAUNCH_OK ${app.getVersion()}\n`, "utf8");
    app.exit(0);
  } catch (error) {
    console.error(`launch check could not write ${marker}: ${error.message}`);
    app.exit(1);
  }
}

// core/ is ESM and this file is CJS; the engines arrive async and the feed
// simply lacks their derived fields until they land (a poll tick at worst).
let core = null;
Promise.all([
  ...["shot-engine.mjs", "cut-engine.mjs", "compose-engine.mjs", "stage-engine.mjs", "themes.mjs"].map((name) =>
    import(pathToFileURL(path.join(__dirname, "..", "core", name)).href)
  ),
  import(pathToFileURL(path.join(__dirname, "..", "scripts", "pipeline.mjs")).href),
  import(pathToFileURL(path.join(__dirname, "..", "scripts", "inbox.mjs")).href),
]).then(([shot, cut, compose, stage, themes, pipeline, inbox]) => { core = { shot, cut, compose, stage, themes, pipeline, inbox }; })
  .catch((error) => console.error("core engines failed to load:", error));

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null; // absent, or mid-rewrite; the next tick settles it
  }
}

// The review state is a file the MCP server rewrites; the window polls its
// mtime rather than using fs.watch because the app may run on Windows while
// the file lives on the WSL share, where change notifications do not travel.
function projectDir() {
  const pointer = readJson(POINTER);
  return pointer?.dir ? path.join(MEDIA_ROOT, pointer.dir) : null;
}

// Footage is referenced, never copied: a 19 GB recording stays where it was
// recorded. source.json holds the path as WSL sees it, because the pipeline
// runs there; this process maps it to wherever it happens to be running.
// Older projects that staged a raw.<ext> copy keep working.
const WSL_PREFIX = (() => {
  const match = /^\\\\wsl(?:\.localhost|\$)\\[^\\]+/i.exec(__dirname);
  return match ? match[0] : null;
})();

function toPosixPath(localPath) {
  if (process.platform !== "win32") return localPath;
  let match = /^([a-zA-Z]):[\\/](.*)$/.exec(localPath);
  if (match) return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
  match = /^\\\\wsl(?:\.localhost|\$)\\[^\\]+\\(.*)$/i.exec(localPath);
  if (match) return `/${match[1].replace(/\\/g, "/")}`;
  return null;
}

function toLocalPath(posixPath) {
  if (process.platform !== "win32") return posixPath;
  const match = /^\/mnt\/([a-z])\/(.*)$/i.exec(posixPath);
  if (match) return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, "\\")}`;
  if (WSL_PREFIX) return `${WSL_PREFIX}${posixPath.replace(/\//g, "\\")}`;
  return posixPath;
}

function stagedVideoPath(dir) {
  try {
    const raw = fs.readdirSync(dir).find((entry) => /^raw\.(mp4|mov|mkv|webm|m4v)$/i.test(entry));
    if (raw) return path.join(dir, raw);
    const source = readJson(path.join(dir, "source.json"));
    return source?.path ? toLocalPath(source.path) : null;
  } catch {
    return null;
  }
}

function fileUrl(file) {
  return file && fs.existsSync(file) ? pathToFileURL(file).href : null;
}

// Punch-ins are the compose stage's: compose.json holds them, and a project
// from before that carries them as review.shotPlan until plan_shots moves
// them. Either way the Cut tab previews them over the raw footage.
function readPunch(dir, review) {
  const config = readJson(path.join(dir, "compose.json"));
  if (config && "punch" in config) return config.punch ?? null;
  const zoom = review?.shotPlan?.zoom;
  return zoom ? { zoom } : null;
}

function attachDerived(review, dir) {
  review.videoUrl = fileUrl(stagedVideoPath(dir));
  const punch = readPunch(dir, review);
  review.shotPlan = punch ? { type: "punch-alternate", zoom: punch.zoom } : null;
  review.shots = punch && core
    ? core.shot.punchPlan(review.words, review.cuts, review.duration, { zoom: punch.zoom })
    : null;
  review.framing = readJson(path.join(dir, "framing.json"));
  return review;
}

function readReview(dir) {
  const review = readJson(path.join(dir, "review.json"));
  return review ? attachDerived(review, dir) : null;
}

// The compose stage exists once the clean render and its transcript do.
// Scenes resolve to seconds here, so the window and the export capture read
// the same numbers from the same engine.
function readCompose(dir) {
  if (!core) return null;
  try {
    const cleanVideo = path.join(dir, "out", "clean.mp4");
    const cleanTranscript = path.join(dir, "clean.json");
    if (!fs.existsSync(cleanVideo) || !fs.existsSync(cleanTranscript)) return null;
    const map = readJson(path.join(dir, "out", "clean-map.json"));
    // The transcript must belong to THIS render: by the cut identity both
    // carry, or by file time for older projects. An older clean.json against
    // a clean.mp4 still being written is not a compose stage, it is a race.
    if (!core.pipeline.cleanTranscriptCurrent(cleanTranscript, cleanVideo, map)) return null;
    const words = core.cut.flattenWords(readJson(cleanTranscript));
    const config = readJson(path.join(dir, "compose.json")) ?? { scenes: [] };
    const punch = readPunch(dir, readJson(path.join(dir, "review.json")));
    const scenes = core.compose.resolveScenes(config.scenes ?? [], words);
    const assetUrl = (src) => pathToFileURL(path.join(dir, src)).href;
    for (const scene of scenes) {
      if (scene.graphic?.src) scene.graphic.url = assetUrl(scene.graphic.src);
      for (const item of scene.graphic?.items ?? []) if (item.src) item.url = assetUrl(item.src);
      if (scene.graphic?.kind === "custom") {
        const base = assetUrl("assets/");
        scene.graphic = { ...scene.graphic, html: scene.graphic.html.replaceAll("assets/", base), css: (scene.graphic.css ?? "").replaceAll("assets/", base) };
      }
    }
    const theme = core.themes.resolveTheme(config.theme ?? null);
    if (theme.logo) theme.logoUrl = assetUrl(theme.logo.src);
    const inserts = core.compose.resolveInserts(config.inserts ?? [], words);
    for (const insert of inserts) {
      for (const option of insert.options) {
        for (const scene of option.scenes) {
          if (scene.graphic?.src) scene.graphic.url = assetUrl(scene.graphic.src);
          for (const item of scene.graphic?.items ?? []) if (item.src) item.url = assetUrl(item.src);
        }
      }
    }
    const duration = words.at(-1)?.end ?? 0;
    return {
      videoUrl: pathToFileURL(cleanVideo).href,
      screenUrl: fileUrl(path.join(dir, "out", "screen.mp4")),
      screenSpans: map?.screenSpans ?? [],
      words,
      scenes,
      captions: config.captions ? core.compose.resolvePhraseCaptions(words) : null,
      wordSpans: core.compose.resolveCaptions(words),
      captionsOn: Boolean(config.captions),
      stage: core.stage.DEFAULT_STAGE,
      layoutTimeline: core.stage.resolveLayoutTimeline(scenes, duration),
      theme,
      themeConfig: config.theme ?? {},
      inserts,
      pendingToAgent: core.inbox.pendingInbox(dir).length,
      punch,
      punchSpans: punch && map?.pieces ? core.shot.punchSpans(map.pieces, punch.zoom) : [],
    };
  } catch {
    return null; // compose files absent or mid-write; cut review still works
  }
}

function readState() {
  const dir = projectDir();
  if (!dir) return null;
  const state = {
    project: path.basename(dir),
    review: readReview(dir),
    compose: readCompose(dir),
    progress: readJson(path.join(dir, "progress.json")),
  };
  // Staged but not yet transcribed: the window shows what to ask for.
  if (!state.review && stagedVideoPath(dir)) state.pending = { project: path.basename(dir) };
  return state;
}

// Ingest: open a project folder that references the clip where it lives,
// and point the review at it. The pipeline itself (transcribe, cuts, scenes,
// renders) belongs to the agent over MCP — the app stages, Claude works.
function ingest(sourcePath) {
  const ext = path.extname(sourcePath).toLowerCase();
  if (!VIDEO_RE.test(ext)) return { ok: false, error: `Fabula cannot open ${ext || "that"} files.` };
  if (!fs.existsSync(sourcePath)) return { ok: false, error: "That file could not be found." };
  const posix = toPosixPath(sourcePath);
  if (!posix) return { ok: false, error: "That location is not reachable from the pipeline." };
  const name = path.basename(sourcePath, ext).replace(/[^a-z0-9-_]/gi, "_").toLowerCase() || "project";
  const dir = path.join(MEDIA_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  if (!stagedVideoPath(dir)) {
    const bytes = fs.statSync(sourcePath).size;
    fs.writeFileSync(path.join(dir, "source.json"), JSON.stringify({ path: posix, container: ext, bytes }, null, 2));
  }
  fs.writeFileSync(POINTER, JSON.stringify({ dir: name }, null, 2));
  return { ok: true, project: name };
}

// The one write the window owns in the cut stage: flipping a cut. Everything
// else about the review file belongs to the MCP server; both sides reread
// before writing.
function setCutEnabled(index, enabled) {
  const dir = projectDir();
  const file = dir && path.join(dir, "review.json");
  const review = file && readJson(file);
  if (!review?.cuts?.[index]) return null;
  review.cuts[index].enabled = Boolean(enabled);
  fs.writeFileSync(file, JSON.stringify(review, null, 2));
  return attachDerived(review, dir);
}

function stateStamp() {
  const dir = projectDir();
  if (!dir) return "none";
  return [
    "review.json", "compose.json", "clean.json", "framing.json", "progress.json", "source.json", "inbox.json",
    path.join("out", "clean.mp4"), path.join("out", "screen.mp4"), path.join("out", "clean-map.json"), path.join("out", "final.mp4"),
  ]
    .map((name) => {
      try {
        const stat = fs.statSync(path.join(dir, name));
        return `${name}:${stat.mtimeMs}:${stat.size}`;
      } catch {
        return `${name}:missing`;
      }
    })
    .join("|") + `@${dir}`;
}

function startReviewFeed(window) {
  let lastStamp = "";
  const tick = () => {
    if (window.isDestroyed()) return;
    const stamp = stateStamp();
    if (stamp !== lastStamp) {
      lastStamp = stamp;
      window.webContents.send("fabula:state", readState());
    }
  };
  const timer = setInterval(tick, 500);
  window.on("closed", () => clearInterval(timer));
}

// Where the window was last left, if that place still exists on a screen.
const boundsFile = () => path.join(app.getPath("userData"), "window.json");

function savedBounds() {
  const saved = readJson(boundsFile());
  if (!saved || !Number.isFinite(saved.width) || !Number.isFinite(saved.height)) return null;
  const visible = screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return saved.x + saved.width > area.x + 40 && saved.x < area.x + area.width - 40
      && saved.y >= area.y - 8 && saved.y < area.y + area.height - 40;
  });
  return visible ? saved : null;
}

function createWindow() {
  const bounds = savedBounds();
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    ...(bounds ?? {}),
    minWidth: 960,
    minHeight: 620,
    backgroundColor: "#faf9f5",
    icon: path.join(__dirname, "..", "brand", "fabula-mark-256.png"),
    show: false,
    // On Windows the masthead is the title bar: the window's own frame would
    // put a second, grey strip above the brand row. The system controls
    // overlay the top-right corner in the app's own colours.
    ...(process.platform === "win32"
      ? { titleBarStyle: "hidden", titleBarOverlay: { color: "#faf9f5", symbolColor: "#6e6b63", height: 56 } }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      // The preload imports core/'s ESM engines to bridge them; a sandboxed
      // preload cannot load files. Isolation stays on; the page gets no node.
      sandbox: false,
      nodeIntegration: false,
    },
  });
  if (bounds?.maximized) window.maximize();
  window.once("ready-to-show", () => window.show());
  window.on("close", () => {
    try {
      const rect = window.getNormalBounds();
      fs.mkdirSync(path.dirname(boundsFile()), { recursive: true });
      fs.writeFileSync(boundsFile(), JSON.stringify({ ...rect, maximized: window.isMaximized() }));
    } catch { /* not worth a dialog */ }
  });
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F12" || (input.control && input.shift && input.key.toUpperCase() === "I")) {
      window.webContents.toggleDevTools();
      event.preventDefault();
    }
  });
  window.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  startReviewFeed(window);
  return window;
}

app.whenReady().then(() => {
  // A review tool has no menu to offer; the masthead carries what it needs.
  Menu.setApplicationMenu(null);
  // Local review tool: no permission has a reason to be granted, no external
  // navigation has a reason to happen.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
  });

  ipcMain.handle("fabula:get-state", () => readState());
  ipcMain.handle("fabula:ingest", (event, sourcePath) => {
    const result = ingest(sourcePath);
    if (result.ok) event.sender.send("fabula:state", readState());
    return result;
  });
  ipcMain.handle("fabula:pick", async (event) => {
    const picked = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: "Open a recording",
      properties: ["openFile"],
      filters: [{ name: "Recordings", extensions: ["mp4", "mov", "mkv", "webm", "m4v"] }],
    });
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, cancelled: true };
    const result = ingest(picked.filePaths[0]);
    if (result.ok) event.sender.send("fabula:state", readState());
    return result;
  });
  ipcMain.handle("fabula:set-cut", (event, index, enabled) => {
    const review = setCutEnabled(index, enabled);
    if (review) event.sender.send("fabula:state", readState());
    return review !== null;
  });

  // The inspector's writes. Each re-validates through the same core engine
  // the MCP server uses, so the window cannot save a plan the pipeline would
  // refuse.
  const editCompose = (event, mutate) => {
    try {
      const dir = projectDir();
      const file = path.join(dir, "compose.json");
      const config = readJson(file) ?? { scenes: [] };
      mutate(config);
      const words = core.cut.flattenWords(readJson(path.join(dir, "clean.json")));
      core.compose.validateScenes(config.scenes ?? [], words);
      if (config.inserts) core.compose.validateInserts(config.inserts, words);
      core.themes.validateTheme(config.theme);
      if (config.punch && !(config.punch.zoom >= 1.02 && config.punch.zoom <= 1.5)) throw new Error("punch zoom must be 1.02–1.5");
      fs.writeFileSync(file, JSON.stringify(config, null, 2));
      event.sender.send("fabula:state", readState());
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error.message ?? error) };
    }
  };

  const SCENE_PATCH_FIELDS = ["text", "accent", "layout", "corner", "flair"];
  ipcMain.handle("fabula:update-scene", (event, index, patch) =>
    editCompose(event, (config) => {
      const scene = config.scenes?.[index];
      if (!scene) throw new Error(`no scene ${index}`);
      for (const field of SCENE_PATCH_FIELDS) {
        if (!(field in patch)) continue;
        if (patch[field] === null || patch[field] === "") delete scene[field];
        else scene[field] = patch[field];
      }
      if ("label" in patch && scene.graphic) {
        if (patch.label) scene.graphic.label = patch.label;
        else delete scene.graphic.label;
      }
    })
  );
  ipcMain.handle("fabula:set-project", (event, patch) =>
    editCompose(event, (config) => {
      if ("accent" in patch) patch = { ...patch, theme: { ...(patch.theme ?? {}), accent: patch.accent || null } };
      if (patch.themeReset) config.theme = config.theme?.preset ? { preset: config.theme.preset } : {};
      if (patch.theme && typeof patch.theme === "object") {
        const theme = { ...(config.theme ?? {}) };
        for (const [key, value] of Object.entries(patch.theme)) {
          if (key === "logoCorner") { if (theme.logo) theme.logo = { ...theme.logo, corner: value }; continue; }
          if (value === null || value === "") delete theme[key];
          else theme[key] = value;
        }
        config.theme = theme;
      }
      if ("captions" in patch) config.captions = Boolean(patch.captions);
      if ("punch" in patch) config.punch = patch.punch ? { zoom: Number(patch.punch) } : null;
    })
  );

  // Insert points: a choice materialises an option's scenes (validated like
  // any other write) and tells the agent; a request in words is filed for
  // the agent to answer.
  const editInsert = (event, insertId, optionId, note) =>
    editCompose(event, (config) => {
      const next = core.compose.applyInsertChoice(config, insertId, optionId, note);
      config.scenes = next.scenes;
      config.inserts = next.inserts;
    });
  ipcMain.handle("fabula:choose-insert", (event, insertId, optionId) => {
    const result = editInsert(event, insertId, optionId);
    if (result.ok) core.inbox.appendInbox(projectDir(), { type: "insert-chosen", insertId, optionId });
    return result;
  });
  ipcMain.handle("fabula:insert-note", (event, insertId, text) => {
    const note = String(text ?? "").trim().slice(0, 500);
    if (!note) return { ok: false, error: "Say what you want there." };
    const result = editInsert(event, insertId, "other", note);
    if (result.ok) core.inbox.appendInbox(projectDir(), { type: "insert-other", insertId, text: note });
    return result;
  });
  ipcMain.handle("fabula:ask", (event, text) => {
    const message = String(text ?? "").trim().slice(0, 1000);
    if (!message) return { ok: false, error: "Type something first." };
    const dir = projectDir();
    if (!dir) return { ok: false, error: "No project is open." };
    core.inbox.appendInbox(dir, { type: "message", text: message });
    event.sender.send("fabula:state", readState());
    return { ok: true };
  });

  // A picture for the brand: copied into the project's assets so the film
  // never depends on a file elsewhere on the disk.
  ipcMain.handle("fabula:pick-asset", async (event) => {
    const picked = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: "Choose a logo",
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, cancelled: true };
    try {
      const dir = projectDir();
      const source = picked.filePaths[0];
      const name = path.basename(source).replace(/[^a-z0-9._-]/gi, "_").toLowerCase();
      fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
      fs.copyFileSync(source, path.join(dir, "assets", name));
      return { ok: true, src: `assets/${name}` };
    } catch (error) {
      return { ok: false, error: String(error.message ?? error) };
    }
  });
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
