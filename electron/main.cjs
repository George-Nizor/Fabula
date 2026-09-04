"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, session, ipcMain } = require("electron");

const MEDIA_ROOT = path.join(__dirname, "..", "media");
const POINTER = path.join(MEDIA_ROOT, "current-project.json");

// core/ is ESM and this file is CJS; the engines arrive async and the feed
// simply lacks their derived fields until they land (a poll tick at worst).
let core = null;
Promise.all(
  ["shot-engine.mjs", "cut-engine.mjs", "compose-engine.mjs", "stage-engine.mjs"].map((name) =>
    import(pathToFileURL(path.join(__dirname, "..", "core", name)).href)
  )
).then(([shot, cut, compose, stage]) => { core = { shot, cut, compose, stage }; })
  .catch((error) => console.error("core engines failed to load:", error));

// The review state is a file the MCP server rewrites; the window polls its
// mtime rather than using fs.watch because the app may run on Windows while
// the file lives on the WSL share, where change notifications do not travel.
function projectDir() {
  try {
    const pointer = JSON.parse(fs.readFileSync(POINTER, "utf8"));
    return path.join(MEDIA_ROOT, pointer.dir);
  } catch {
    return null;
  }
}

function reviewPath() {
  const dir = projectDir();
  return dir ? path.join(dir, "review.json") : null;
}

// The server records the video by its own (WSL) absolute path; resolve the
// staged file relative to this process instead, so the same review.json plays
// whether the app runs on Linux or from the Windows side of the share.
function stagedVideoUrl(dir) {
  try {
    const name = fs.readdirSync(dir).find((entry) => /^raw\.(mp4|mov|mkv|webm|m4v)$/i.test(entry));
    return name ? pathToFileURL(path.join(dir, name)).href : null;
  } catch {
    return null;
  }
}

function attachDerived(review, dir) {
  review.videoUrl = stagedVideoUrl(dir);
  review.shots = review.shotPlan && core
    ? core.shot.punchPlan(review.words, review.cuts, review.duration, review.shotPlan)
    : null;
  return review;
}

function readReview(dir) {
  try {
    const review = JSON.parse(fs.readFileSync(path.join(dir, "review.json"), "utf8"));
    return attachDerived(review, dir);
  } catch {
    return null; // absent, or mid-rewrite; the next tick settles it
  }
}

// The compose stage exists once the clean render and its transcript do.
// Scenes resolve to seconds here, so the window and the export capture read
// the same numbers from the same engine.
function readCompose(dir) {
  if (!core) return null;
  try {
    const cleanVideo = path.join(dir, "out", "clean.mp4");
    if (!fs.existsSync(cleanVideo)) return null;
    const words = core.cut.flattenWords(
      JSON.parse(fs.readFileSync(path.join(dir, "clean.json"), "utf8"))
    );
    const config = JSON.parse(fs.readFileSync(path.join(dir, "compose.json"), "utf8"));
    const scenes = core.compose.resolveScenes(config.scenes ?? [], words);
    for (const scene of scenes) {
      if (scene.graphic?.src) scene.graphic.url = pathToFileURL(path.join(dir, scene.graphic.src)).href;
    }
    const duration = words.at(-1)?.end ?? 0;
    return {
      videoUrl: pathToFileURL(cleanVideo).href,
      words,
      scenes,
      captions: config.captions ? core.compose.resolveCaptions(words) : null,
      stage: core.stage.DEFAULT_STAGE,
      layoutTimeline: core.stage.resolveLayoutTimeline(scenes, duration),
      theme: config.theme ?? null,
    };
  } catch {
    return null; // compose files absent or mid-write; cut review still works
  }
}

function readState() {
  const dir = projectDir();
  if (!dir) return null;
  const state = { review: readReview(dir), compose: readCompose(dir) };
  if (!state.review) {
    // Staged but not yet transcribed: the window shows what to ask for.
    try {
      const pointer = JSON.parse(fs.readFileSync(POINTER, "utf8"));
      const video = fs.readdirSync(dir).find((n) => /^raw\.(mp4|mov|mkv|webm|m4v)$/i.test(n));
      if (video) state.pending = { project: pointer.dir };
    } catch {
      /* no pending project */
    }
  }
  return state;
}

// Drag-drop ingest: copy the clip into a project folder and point the
// review at it. The pipeline itself (transcribe, cuts, scenes, renders)
// belongs to the agent over MCP — the app stages, Claude works.
function ingest(sourcePath) {
  const ext = path.extname(sourcePath).toLowerCase();
  if (!/^\.(mp4|mov|mkv|webm|m4v)$/.test(ext)) {
    return { ok: false, error: `unsupported container: ${ext}` };
  }
  if (!fs.existsSync(sourcePath)) return { ok: false, error: "file not found" };
  const name = path.basename(sourcePath, ext).replace(/[^a-z0-9-_]/gi, "_").toLowerCase() || "project";
  const dir = path.join(MEDIA_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  const staged = path.join(dir, `raw${ext}`);
  if (!fs.existsSync(staged)) fs.copyFileSync(sourcePath, staged);
  fs.writeFileSync(POINTER, JSON.stringify({ dir: name }, null, 2));
  return { ok: true, project: name };
}

// The one write the window owns: flipping a cut. Everything else about the
// review file belongs to the MCP server; both sides reread before writing.
function setCutEnabled(index, enabled) {
  const file = reviewPath();
  if (!file) return null;
  const review = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!review.cuts[index]) return null;
  review.cuts[index].enabled = Boolean(enabled);
  fs.writeFileSync(file, JSON.stringify(review, null, 2));
  return attachDerived(review, projectDir());
}

function stateStamp() {
  const dir = projectDir();
  if (!dir) return "none";
  return ["review.json", "compose.json", "clean.json", path.join("out", "clean.mp4")]
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

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#faf9f5",
    icon: path.join(__dirname, "..", "brand", "fabula-mark-256.png"),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      // The preload imports core/'s ESM engines to bridge them; a sandboxed
      // preload cannot load files. Isolation stays on; the page gets no node.
      sandbox: false,
      nodeIntegration: false,
    },
  });
  window.once("ready-to-show", () => window.show());
  window.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  startReviewFeed(window);
  return window;
}

app.whenReady().then(() => {
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
  ipcMain.handle("fabula:set-cut", (event, index, enabled) => {
    const review = setCutEnabled(index, enabled);
    if (review) event.sender.send("fabula:state", readState());
    return review !== null;
  });

  // The inspector's two writes. Both re-validate through the same core
  // engine the MCP server uses, so the window cannot save a plan the
  // pipeline would refuse.
  const editCompose = (event, mutate) => {
    try {
      const dir = projectDir();
      const file = path.join(dir, "compose.json");
      const config = JSON.parse(fs.readFileSync(file, "utf8"));
      mutate(config);
      const words = core.cut.flattenWords(
        JSON.parse(fs.readFileSync(path.join(dir, "clean.json"), "utf8"))
      );
      core.compose.validateScenes(config.scenes ?? [], words);
      core.compose.validateTheme(config.theme);
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
        if (patch[field] === null || patch[field] === "" ) delete scene[field];
        else scene[field] = patch[field];
      }
    })
  );
  ipcMain.handle("fabula:set-theme", (event, theme) =>
    editCompose(event, (config) => {
      if (theme?.accent) config.theme = { ...config.theme, accent: theme.accent };
      else delete config.theme;
    })
  );
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
