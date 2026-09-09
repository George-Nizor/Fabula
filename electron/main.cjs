"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, session, ipcMain, dialog, Menu, screen, shell } = require("electron");
const { AssistantSession, choiceArgs, EFFORTS: ASSISTANT_EFFORTS } = require("./assistant-session.cjs");
const settings = require("../scripts/settings.cjs");

// The projects live in media/ beside the checkout unless fabula.settings.json
// names another folder (as the pipeline sees it; mapped here for this host).
const DEFAULT_MEDIA_ROOT = path.join(__dirname, "..", "media");
function mediaRoot() {
  const configured = settings.configuredProjectsRoot();
  return configured ? toLocalPath(configured) : DEFAULT_MEDIA_ROOT;
}
const pointerFile = () => path.join(mediaRoot(), "current-project.json");
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
  ...["shot-engine.mjs", "cut-engine.mjs", "compose-engine.mjs", "stage-engine.mjs", "themes.mjs", "reanchor.mjs", "formats.mjs"].map((name) =>
    import(pathToFileURL(path.join(__dirname, "..", "core", name)).href)
  ),
  import(pathToFileURL(path.join(__dirname, "..", "scripts", "pipeline.mjs")).href),
  import(pathToFileURL(path.join(__dirname, "..", "scripts", "inbox.mjs")).href),
  import(pathToFileURL(path.join(__dirname, "..", "scripts", "theme-store.mjs")).href),
  import(pathToFileURL(path.join(__dirname, "..", "scripts", "project-state.mjs")).href),
  import(pathToFileURL(path.join(__dirname, "..", "scripts", "shorts.mjs")).href),
  import(pathToFileURL(path.join(__dirname, "..", "core", "personas.mjs")).href),
]).then(([shot, cut, compose, stage, themes, reanchor, formats, pipeline, inbox, themeStore, projectState, shorts, personas]) => {
  core = { shot, cut, compose, stage, themes, reanchor, formats, pipeline, inbox, themeStore, projectState, shorts, personas };
})
  .catch((error) => console.error("core engines failed to load:", error));

// The server reads these files on every tool call: write beside and
// rename, so neither side ever reads a truncated file.
function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

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
  const pointer = readJson(pointerFile());
  return pointer?.dir ? path.join(mediaRoot(), pointer.dir) : null;
}

// Footage is referenced, never copied: a 19 GB recording stays where it was
// recorded. source.json holds the path as WSL sees it, because the pipeline
// runs there; this process maps it to wherever it happens to be running.
// Older projects that staged a raw.<ext> copy keep working.
const WSL_PREFIX = (() => {
  const match = /^\\\\wsl(?:\.localhost|\$)\\[^\\]+/i.exec(__dirname);
  return match ? match[0] : null;
})();
const WSL_DISTRO = WSL_PREFIX ? WSL_PREFIX.slice(WSL_PREFIX.lastIndexOf("\\") + 1) : null;
const REPO = path.join(__dirname, "..");

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
      captions: core.compose.captionsBurnedIn(config.captions) ? core.compose.resolvePhraseCaptions(words, { emphasis: config.captionEmphasis }) : null,
      wordSpans: core.compose.resolveCaptions(words),
      captionsOn: core.compose.captionsBurnedIn(config.captions),
      captionMode: core.compose.captionMode(config.captions),
      stage: core.formats.stageOf(core.projectState.readProjectMeta(dir)),
      layoutTimeline: core.stage.resolveLayoutTimeline(scenes, duration, { transition: theme.transition, transitionSeconds: theme.transitionSeconds }),
      theme,
      themeConfig: config.theme ?? {},
      savedThemes: core.themeStore.listSavedThemes(mediaRoot()).map((s) => ({ id: s.id, name: s.name })),
      inserts,
      pendingToAgent: core.inbox.pendingInbox(dir).length,
      punch,
      punchSpans: punch && map?.pieces ? core.shot.punchSpans(map.pieces, punch.zoom) : [],
    };
  } catch {
    return null; // compose files absent or mid-write; cut review still works
  }
}

// The look, independent of the compose stage: a theme can be chosen before
// the clean cut exists, and the Look page needs the presets to draw.
function readLook(dir) {
  if (!core) return null;
  try {
    const config = readJson(path.join(dir, "compose.json")) ?? {};
    const theme = core.themes.resolveTheme(config.theme ?? null);
    if (theme.logo) theme.logoUrl = pathToFileURL(path.join(dir, theme.logo.src)).href;
    const presets = core.themes.describePresets();
    // Each preset resolved in full, so a preset card can be previewed by the
    // real painter rather than by a drawing of what it is supposed to be.
    const presetThemes = Object.fromEntries(Object.keys(core.themes.PRESETS).map((id) => [id, core.themes.resolveTheme({ preset: id })]));
    return {
      theme,
      themeConfig: config.theme ?? {},
      presets,
      presetThemes,
      // The vocabularies, so the window never keeps its own copy of a list
      // core owns: a style added to the kit appears in the gallery by itself.
      titleStyles: [...core.themes.TITLE_STYLES],
      calloutStyles: [...core.themes.CALLOUT_STYLES],
      captionStyles: [...core.themes.CAPTION_STYLES],
      transitions: [...core.themes.TRANSITIONS],
      layouts: [...core.stage.LAYOUTS],
      imageMotions: [...core.compose.IMAGE_MOTIONS],
      graphicKinds: [...core.compose.GRAPHIC_KINDS],
      fonts: core.themes.VENDORED_FONTS,
      savedThemes: core.themeStore.listSavedThemes(mediaRoot()).map((s) => ({ id: s.id, name: s.name, theme: core.themes.resolveTheme(s.theme) })),
      captionMode: core.compose.captionMode(config.captions),
      punch: config.punch ?? null,
    };
  } catch {
    return null;
  }
}

// The Export page's reading: the deliverables in out/, what is out of date
// and why, the job in flight or the last failure, and whether the film can
// be rendered from here at all.
function readExport(dir) {
  if (!core) return null;
  try {
    const ps = core.projectState;
    const paths = ps.projectPaths(dir);
    const running = core.pipeline.runningJob(dir);
    const progress = core.pipeline.readProgress(dir);
    const failed = !running && progress && typeof progress.detail === "string" && progress.detail.startsWith("failed:");
    const config = readJson(paths.compose) ?? {};
    const have = {
      review: fs.existsSync(paths.review),
      clean: fs.existsSync(paths.clean),
      cleanTranscript: fs.existsSync(paths.cleanTranscript) && core.pipeline.cleanTranscriptCurrent(paths.cleanTranscript, paths.clean, ps.readCleanMap(dir)),
      scenes: (config.scenes ?? []).length > 0,
      final: fs.existsSync(paths.final),
      previousTranscript: fs.existsSync(paths.previousCleanTranscript),
    };
    return {
      outputs: ps.outputs(dir),
      stale: ps.staleness(dir),
      running,
      lastFailure: failed ? { stage: progress.stage, error: progress.detail.slice(8), log: path.join(dir, "out", `${progress.stage}.log`) } : null,
      clean: ps.cleanSummary(dir),
      captionMode: core.compose.captionMode(config.captions),
      have,
      canRenderFinal: have.clean && have.cleanTranscript && have.scenes,
      canRefreshClean: have.review,
      bridge: process.platform === "win32" ? (WSL_DISTRO ? `WSL (${WSL_DISTRO})` : null) : "local",
    };
  } catch {
    return null;
  }
}

// Starts a render from the window with the same spec the MCP tools use.
// On Linux the app itself is node enough to run the pipeline; on Windows
// the pipeline lives on the WSL side and is reached through wsl.exe with a
// login shell, so the same node and ffmpeg the server uses do the work.
function startRender(kind, options = {}) {
  const dir = projectDir();
  if (!dir) return { ok: false, error: "No project is open." };
  if (!core) return { ok: false, error: "Still loading; try again in a moment." };
  const ps = core.projectState;
  try {
    const paths = ps.projectPaths(dir);
    if (kind === "final") {
      if (!fs.existsSync(paths.compose)) throw new Error("No scenes yet. Ask the assistant to plan them first.");
      if (!fs.existsSync(paths.clean)) throw new Error("No clean cut yet. Render it first.");
      if (!core.pipeline.cleanTranscriptCurrent(paths.cleanTranscript, paths.clean, ps.readCleanMap(dir))) {
        throw new Error("The clean transcript does not match the clean cut. Refresh the clean cut first.");
      }
    }
    if (kind === "refresh" && !fs.existsSync(paths.review)) throw new Error("Nothing to cut yet: no review.");
    if (kind === "first" && !paths.video) throw new Error("This project has no recording.");
    const allowed = { fresh: Boolean(options.fresh) };
    if (process.platform === "win32") {
      const root = toPosixPath(REPO);
      const posixDir = toPosixPath(dir);
      if (!root || !posixDir || !WSL_DISTRO) throw new Error("Renders run in WSL, and this window cannot reach it from where it is installed.");
      const spec = ps.jobSpec(kind, posixDir, { ...allowed, root });
      const line = ps.shellLine(spec, { root });
      core.pipeline.startJob(dir, spec.stage, spec.label, "wsl.exe", ["-d", WSL_DISTRO, "--", "bash", "-lc", line], { cwd: undefined });
    } else {
      const spec = ps.jobSpec(kind, dir, allowed);
      ps.launchJob(dir, spec, { node: process.execPath, nodeEnv: { ELECTRON_RUN_AS_NODE: "1" }, electron: process.execPath });
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error.message ?? error) };
  }
}

// Only files of the open project may be opened or revealed from the page.
function projectFile(file) {
  const dir = projectDir();
  if (!dir || typeof file !== "string") return null;
  const resolved = path.resolve(file);
  return resolved.startsWith(path.resolve(dir) + path.sep) && fs.existsSync(resolved) ? resolved : null;
}

// After a re-cut: move every scene's word anchors onto the new clean
// transcript, the way the reanchor_scenes tool does, and say what could
// not be placed.
function reanchorProject() {
  const dir = projectDir();
  if (!dir || !core) return { ok: false, error: "No project is open." };
  try {
    const ps = core.projectState;
    const paths = ps.projectPaths(dir);
    if (!fs.existsSync(paths.compose)) throw new Error("No scenes to re-anchor.");
    if (!fs.existsSync(paths.previousCleanTranscript)) throw new Error("The previous transcript was not kept; ask the assistant to place the scenes again.");
    const oldWords = core.cut.flattenWords(readJson(paths.previousCleanTranscript));
    const newWords = core.cut.flattenWords(readJson(paths.cleanTranscript));
    const config = readJson(paths.compose) ?? { scenes: [] };
    const report = core.reanchor.reanchorScenes(config.scenes ?? [], oldWords, newWords);
    const lastId = newWords.at(-1)?.id ?? 0;
    const clamp = (id) => Math.min(Math.max(id, 0), lastId);
    for (const entry of report) {
      const scene = config.scenes[entry.index];
      if (!scene) continue;
      if (entry.ok) { scene.fromWordId = entry.fromWordId; scene.toWordId = entry.toWordId; }
      else { scene.fromWordId = clamp(scene.fromWordId); scene.toWordId = clamp(Math.max(scene.toWordId, scene.fromWordId)); }
    }
    core.compose.validateScenes(config.scenes ?? [], newWords);
    config.cutIdentity = ps.cleanTranscriptStamp(dir) ?? config.cutIdentity;
    if (!config.cutIdentity) delete config.cutIdentity;
    writeJsonAtomic(paths.compose, config);
    const unresolved = report.filter((r) => !r.ok);
    return { ok: true, moved: report.length - unresolved.length, unresolved: unresolved.map((r) => ({ index: r.index, type: r.type, reason: r.reason })) };
  } catch (error) {
    return { ok: false, error: String(error.message ?? error) };
  }
}

// The projects as the window lists them: every staged folder under media/,
// with the footage checked where this process runs and the open one marked.
function listProjects() {
  if (!core) return [];
  const current = projectDir();
  return core.projectState.listProjects(mediaRoot(), { videoPresent: (file) => fs.existsSync(toLocalPath(file)) })
    .map((project) => ({ ...project, current: Boolean(current) && path.basename(current) === project.name }));
}

function switchProject(name) {
  if (typeof name !== "string" || !core?.projectState.PROJECT_NAME_RE.test(name)) return { ok: false, error: "That is not a project name." };
  const dir = path.join(mediaRoot(), name);
  if (!core.projectState.describeProject(dir)) return { ok: false, error: `There is no project called “${name}”.` };
  fs.writeFileSync(pointerFile(), JSON.stringify({ dir: name }, null, 2));
  return { ok: true, project: name };
}

function closeProject() {
  fs.rmSync(pointerFile(), { force: true });
  return { ok: true };
}

// Removing a project moves its derived folder to the recycle bin; the
// recording itself was never copied and is not touched.
async function removeProject(window, name) {
  if (typeof name !== "string" || !core?.projectState.PROJECT_NAME_RE.test(name)) return { ok: false, error: "That is not a project name." };
  const dir = path.join(mediaRoot(), name);
  const project = core.projectState.describeProject(dir);
  if (!project) return { ok: false, error: `There is no project called “${name}”.` };
  const running = readJson(path.join(dir, "progress.json"));
  const busy = running && !running.finishedAt && !(typeof running.detail === "string" && running.detail.startsWith("failed:"));
  const choice = await dialog.showMessageBox(window, {
    type: "warning",
    title: `Remove ${name}`,
    message: `Move the project “${name}” to the recycle bin?`,
    detail: `Its transcripts, cuts, scenes and renders (${project.stageLabel}) go to the recycle bin. The recording ${project.videoName} stays where it is.${busy ? "\n\nA job appears to be running on this project; its output would be lost." : ""}`,
    buttons: ["Move to recycle bin", "Keep"],
    defaultId: 1,
    cancelId: 1,
  });
  if (choice.response !== 0) return { ok: false, cancelled: true };
  try {
    await shell.trashItem(dir);
  } catch (error) {
    return { ok: false, error: `Could not remove it: ${error.message}` };
  }
  if (project.current || path.basename(projectDir() ?? "") === name) closeProject();
  return { ok: true };
}

// ---- Where the projects live ----

function describeProjectsRoot() {
  const configured = settings.configuredProjectsRoot();
  return { local: mediaRoot(), posix: configured ?? toPosixPath(DEFAULT_MEDIA_ROOT) ?? DEFAULT_MEDIA_ROOT, isDefault: !configured };
}

// A job that wrote progress and has not finished or failed is treated as
// running; the pid belongs to the pipeline host and cannot be probed here.
function jobLooksBusy(dir) {
  const progress = readJson(path.join(dir, "progress.json"));
  return Boolean(progress && !progress.finishedAt && !(typeof progress.detail === "string" && progress.detail.startsWith("failed:")));
}

// Point Fabula at another folder, offering to carry the projects along.
// `target` is a local path here (from the picker) or null for the default.
async function changeProjectsRoot(window, target, report = () => {}) {
  const from = mediaRoot();
  let posix = null;
  let to = DEFAULT_MEDIA_ROOT;
  if (target !== null) {
    posix = toPosixPath(target);
    if (!posix) return { ok: false, error: "That folder is not reachable from the pipeline in WSL. Choose a folder on a local drive." };
    try { posix = settings.validateProjectsRoot(posix); } catch (error) { return { ok: false, error: error.message }; }
    to = toLocalPath(posix);
  }
  if (path.resolve(to) === path.resolve(from)) return { ok: false, cancelled: true };
  if (path.resolve(to).startsWith(path.resolve(from) + path.sep)) return { ok: false, error: "The new folder cannot be inside the current projects folder." };
  const movable = core ? core.projectState.listProjects(from).map((project) => project.name) : [];
  if (fs.existsSync(path.join(from, "themes"))) movable.push("themes");
  const busy = movable.filter((name) => name !== "themes" && jobLooksBusy(path.join(from, name)));
  let move = false;
  if (movable.length > 0) {
    const count = movable.filter((name) => name !== "themes").length;
    const choice = await dialog.showMessageBox(window, {
      type: "question",
      title: "Change the projects folder",
      message: `Move ${count} project${count === 1 ? "" : "s"}${movable.includes("themes") ? " and the saved themes" : ""} to the new folder?`,
      detail: `New folder: ${to}\n\nMoving copies each project's transcripts, cuts, scenes and renders there and removes the originals; recordings are never touched. Starting empty leaves everything where it is, out of the list until you switch back.${busy.length ? `\n\nA job appears to be running on: ${busy.join(", ")}. Wait for it before moving.` : ""}${posix && posix.startsWith("/mnt/") ? "\n\nRenders are written there through WSL, which is slower than the checkout's own disk." : ""}`,
      buttons: busy.length ? ["Start empty there", "Cancel"] : ["Move them", "Start empty there", "Cancel"],
      defaultId: 0,
      cancelId: busy.length ? 1 : 2,
    });
    if (choice.response === (busy.length ? 1 : 2)) return { ok: false, cancelled: true };
    move = !busy.length && choice.response === 0;
  }
  fs.mkdirSync(to, { recursive: true });
  const skipped = [];
  if (move) {
    const pointer = readJson(pointerFile());
    for (const name of movable) {
      const source = path.join(from, name);
      const destination = path.join(to, name);
      if (fs.existsSync(destination)) { skipped.push(name); continue; }
      report(`Moving ${name}…`);
      await fs.promises.cp(source, destination, { recursive: true });
      await fs.promises.rm(source, { recursive: true, force: true });
    }
    if (pointer?.dir && !skipped.includes(pointer.dir)) fs.writeFileSync(path.join(to, "current-project.json"), JSON.stringify(pointer, null, 2));
    fs.rmSync(pointerFile(), { force: true });
  }
  settings.writeProjectsRoot(posix);
  return { ok: true, moved: move ? movable.length - skipped.length : 0, skipped, root: describeProjectsRoot() };
}

function readState() {
  const dir = projectDir();
  const projects = listProjects();
  const where = describeProjectsRoot();
  const formats = core ? core.formats.describeFormats() : [];
  if (!dir || !fs.existsSync(dir)) return { project: null, projects, projectsRoot: where, formats };
  const meta = core ? core.projectState.readProjectMeta(dir) : {};
  const format = core ? core.formats.resolveFormat(meta) : null;
  const state = {
    project: path.basename(dir),
    title: meta.title || path.basename(dir),
    format: format && { id: format.id, label: format.label, about: format.about, stage: format.stage, shortForm: format.shortForm, duration: format.duration },
    derivedFrom: typeof meta.derivedFrom === "string" ? meta.derivedFrom : null,
    projects,
    projectsRoot: where,
    formats,
    review: readReview(dir),
    compose: readCompose(dir),
    look: readLook(dir),
    progress: readJson(path.join(dir, "progress.json")),
    export: readExport(dir),
  };
  // Staged but not yet transcribed: the window shows what to ask for.
  if (!state.review && stagedVideoPath(dir)) state.pending = { project: path.basename(dir), title: state.title, videoName: path.basename(stagedVideoPath(dir)) };
  return state;
}

// Ingest: open a project folder that references the clip where it lives,
// and point the review at it. The pipeline itself (transcribe, cuts, scenes,
// renders) belongs to the agent over MCP — the app stages, the assistant works.
function ingest(sourcePath, title = null, format = null) {
  const ext = path.extname(sourcePath).toLowerCase();
  if (!VIDEO_RE.test(ext)) return { ok: false, error: `Fabula cannot open ${ext || "that"} files.` };
  if (!fs.existsSync(sourcePath)) return { ok: false, error: "That file could not be found." };
  const posix = toPosixPath(sourcePath);
  if (!posix) return { ok: false, error: "That location is not reachable from the pipeline." };
  const ps = core?.projectState;
  let cleanTitle;
  try { cleanTitle = ps ? ps.cleanTitle(title ?? path.basename(sourcePath, ext)) : (title ?? path.basename(sourcePath, ext)); }
  catch (error) { return { ok: false, error: error.message }; }
  const name = ps ? ps.slugify(cleanTitle) : cleanTitle.replace(/[^a-z0-9-_]/gi, "_").toLowerCase();
  const dir = path.join(mediaRoot(), name);
  const existing = stagedVideoPath(dir);
  if (existing && toPosixPath(existing) !== posix) {
    return { ok: false, error: `A project called “${cleanTitle}” already exists with a different recording. Choose another name.` };
  }
  fs.mkdirSync(dir, { recursive: true });
  if (!existing) {
    const bytes = fs.statSync(sourcePath).size;
    fs.writeFileSync(path.join(dir, "source.json"), JSON.stringify({ path: posix, container: ext, bytes }, null, 2));
  }
  if (ps && (!existing || title !== null)) ps.writeProjectTitle(dir, cleanTitle);
  // The shape is set once, when the project is made: the clean cut's ceiling
  // and every layout follow from it. Reopening a project never changes it.
  if (ps && !existing) {
    try { ps.writeProjectFormat(dir, format ?? core.formats.DEFAULT_FORMAT); }
    catch (error) { return { ok: false, error: error.message }; }
  }
  fs.writeFileSync(pointerFile(), JSON.stringify({ dir: name }, null, 2));
  return { ok: true, project: name, title: cleanTitle, format: ps ? ps.projectFormat(dir) : null, reopened: Boolean(existing) };
}

function renameProject(name, title) {
  if (typeof name !== "string" || !core?.projectState.PROJECT_NAME_RE.test(name)) return { ok: false, error: "That is not a project name." };
  const dir = path.join(mediaRoot(), name);
  if (!core.projectState.describeProject(dir)) return { ok: false, error: "That project is gone." };
  try {
    return { ok: true, title: core.projectState.writeProjectTitle(dir, title) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// ---- The assistant chooser ----
//
// The window offers real choices; the terminal opens already running.
const CLAUDE_MODELS = [
  { id: "fable", label: "Fable (latest)" },
  { id: "opus", label: "Opus (latest)" },
  { id: "sonnet", label: "Sonnet (latest)" },
];

// Codex keeps the models an account can use in ~/.codex/models_cache.json.
// From Windows that home is inside the WSL distribution the checkout lives in.
function codexModels() {
  const candidates = [path.join(os.homedir(), ".codex", "models_cache.json")];
  if (process.platform === "win32" && WSL_PREFIX) {
    try {
      for (const user of fs.readdirSync(`${WSL_PREFIX}\\home`)) candidates.push(`${WSL_PREFIX}\\home\\${user}\\.codex\\models_cache.json`);
    } catch { /* no reachable home */ }
  }
  for (const file of candidates) {
    const cache = readJson(file);
    if (!cache) continue;
    const models = [];
    const walk = (node) => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (!node || typeof node !== "object") return;
      if (typeof node.slug === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(node.slug) && !models.some((m) => m.id === node.slug)) {
        models.push({ id: node.slug, label: typeof node.display_name === "string" ? node.display_name : node.slug });
      }
      Object.values(node).forEach(walk);
    };
    walk(cache);
    if (models.length) return models.filter((m) => !/review|reserve/i.test(m.id));
  }
  return [{ id: "gpt-6-astra", label: "GPT-6-Astra" }, { id: "gpt-5.6-luna", label: "GPT-5.6-Luna" }, { id: "gpt-5.5", label: "GPT-5.5" }];
}

function assistantOptions() {
  const prefs = readJson(path.join(REPO, ".assistant-preferences.json"));
  return {
    provider: prefs?.provider === "claude" ? "claude" : prefs?.provider === "codex" ? "codex" : "claude",
    profiles: prefs?.profiles && typeof prefs.profiles === "object" ? prefs.profiles : {},
    // Who the session works as: a film editor, or the short-form farmer.
    personas: core?.personas ? core.personas.describePersonas() : [],
    persona: core?.personas && core.personas.PERSONA_IDS.includes(prefs?.persona) ? prefs.persona : "editor",
    efforts: ASSISTANT_EFFORTS,
    models: { claude: CLAUDE_MODELS, codex: codexModels() },
  };
}

const assistant = new AssistantSession();

// The one write the window owns in the cut stage: flipping a cut. Everything
// else about the review file belongs to the MCP server; both sides reread
// before writing.
function setCutEnabled(index, enabled) {
  const dir = projectDir();
  const file = dir && path.join(dir, "review.json");
  const review = file && readJson(file);
  if (!review?.cuts?.[index]) return null;
  review.cuts[index].enabled = Boolean(enabled);
  writeJsonAtomic(file, review);
  return attachDerived(review, dir);
}

function stateStamp() {
  const dir = projectDir();
  let roster = "";
  try { roster = `settings:${fs.statSync(settings.SETTINGS_FILE).mtimeMs};`; } catch { roster = "settings:default;"; }
  try {
    roster += fs.readdirSync(mediaRoot()).map((name) => {
      try { return `${name}:${fs.statSync(path.join(mediaRoot(), name, "source.json")).mtimeMs}`; } catch { return name; }
    }).join(",");
  } catch { /* no media folder yet */ }
  if (!dir) return `none|${roster}`;
  return [
    "review.json", "compose.json", "clean.json", "framing.json", "progress.json", "source.json", "inbox.json",
    "project.json", // the title and the shape; both change from the assistant's side too
    path.join("..", "themes"),
    "out", path.join("out", "clean.mp4"), path.join("out", "screen.mp4"), path.join("out", "clean-map.json"), path.join("out", "final.mp4"),
  ]
    .map((name) => {
      try {
        const stat = fs.statSync(path.join(dir, name));
        return `${name}:${stat.mtimeMs}:${stat.size}`;
      } catch {
        return `${name}:missing`;
      }
    })
    .join("|") + `@${dir}|${roster}`;
}

function startReviewFeed(window) {
  let lastStamp = "";
  const tick = () => {
    if (window.isDestroyed()) return;
    const stamp = stateStamp();
    if (stamp !== lastStamp) {
      lastStamp = stamp;
      const state = readState();
      const title = state?.project ? `${state.project} — Fabula` : "Fabula";
      if (window.getTitle() !== title) window.setTitle(title);
      window.webContents.send("fabula:state", state);
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

// A look at the window without a display. FABULA_SNAPSHOT=<dir> opens the
// app headless (pass --ozone-platform=headless --no-sandbox --no-zygote on
// the command line), captures the home screen, the Assistant sheet, and — a
// project opened — the Export step, writes them as PNGs and quits. It is how
// the window is checked from a machine that cannot show it.
const SNAPSHOT_DIR = process.env.FABULA_SNAPSHOT || null;

async function snapshotWindow(window) {
  const contents = window.webContents;
  const shots = [];
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const shoot = async (name) => {
    const shot = await contents.debugger.sendCommand("Page.captureScreenshot", { format: "png" });
    const file = path.join(SNAPSHOT_DIR, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
    shots.push(file);
  };
  const run = (code) => contents.executeJavaScript(code).catch((error) => { console.error(`snapshot: ${error.message}`); return null; });
  try {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    await new Promise((resolve) => contents.once("did-finish-load", resolve));
    if (!contents.isPainting()) contents.startPainting();
    contents.debugger.attach("1.3");
    await wait(1500);
    await shoot("1-home");
    await run(`document.getElementById("open-assistant").click(); true`);
    await wait(900);
    await shoot("2-assistant");
    await run(`document.getElementById("assistant").close(); true`);
    const project = process.env.FABULA_SNAPSHOT_PROJECT;
    if (project) {
      await run(`window.fabula.switchProject(${JSON.stringify(project)})`);
      await wait(2500);
      await shoot("3-project");
      await run(`document.getElementById("tab-export").click(); true`);
      await wait(1200);
      await shoot("4-export");
      // The Look step, scrolled to one of its galleries, when one is named.
      const gallery = process.env.FABULA_SNAPSHOT_LOOK;
      if (gallery) {
        await run(`document.getElementById("tab-look").click(); true`);
        await wait(1800);
        await run(`(document.getElementById(${JSON.stringify(gallery)}) ?? document.body).scrollIntoView({ block: "start" }); true`);
        await wait(1200);
        await shoot("6-look");
      }
      // A scene's inspector, when one is named: the Scenes step, then the
      // timeline block for that index.
      const scene = process.env.FABULA_SNAPSHOT_SCENE;
      if (scene !== undefined) {
        await run(`document.getElementById("tab-scenes").click(); true`);
        await wait(1500);
        await run(`(document.querySelector('[data-scene="${Number(scene)}"]') ?? {click(){}}).click(); true`);
        await wait(900);
        await shoot("5-scene");
      }
    }
    // A question for the page, when one is asked: its answer, as JSON.
    if (process.env.FABULA_SNAPSHOT_EVAL) {
      const answer = await run(process.env.FABULA_SNAPSHOT_EVAL);
      console.log(JSON.stringify({ eval: answer }));
    }
    console.log(JSON.stringify({ snapshots: shots }));
  } catch (error) {
    console.error(`snapshot failed: ${error.message}`);
  } finally {
    app.exit(0);
  }
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
      ...(SNAPSHOT_DIR ? { offscreen: true, backgroundThrottling: false } : {}),
    },
  });
  if (SNAPSHOT_DIR) snapshotWindow(window);
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
  // Fabula opens on its home screen. Whatever was open last time is in the
  // list there; nothing is current until the person opens it, and the
  // assistant's status agrees.
  fs.rmSync(pointerFile(), { force: true });
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
  ipcMain.handle("fabula:assistant-options", () => assistantOptions());
  ipcMain.handle("fabula:assistant-status", () => ({ running: assistant.running, choice: assistant.choice }));
  // The assistant runs in a real terminal on the pipeline host and is shown
  // in the window's own pane; its bytes come back over these channels.
  ipcMain.handle("fabula:assistant-start", (event, choice, size) => {
    try {
      const repo = toPosixPath(path.resolve(REPO));
      if (!repo) throw new Error("This checkout cannot be mapped to WSL. Open Fabula from its WSL checkout.");
      const args = choiceArgs(choice ?? {});
      const extra = process.env.FABULA_ASSISTANT_DRY_RUN ? ["--dry-run"] : [];
      const sender = event.sender;
      const onData = (data) => { if (!sender.isDestroyed()) sender.send("fabula:assistant-data", new Uint8Array(data)); };
      const onExit = (code) => {
        assistant.off("data", onData);
        if (!sender.isDestroyed()) sender.send("fabula:assistant-exit", code);
      };
      assistant.on("data", onData);
      assistant.once("exit", onExit);
      assistant.start({ repo, distro: WSL_DISTRO, cols: size?.cols, rows: size?.rows, args, extra, choice });
      return { ok: true, choice };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle("fabula:assistant-input", (_event, data) => { assistant.write(data); });
  ipcMain.handle("fabula:assistant-resize", (_event, cols, rows) => { assistant.resize(cols, rows); });
  ipcMain.handle("fabula:assistant-stop", () => { assistant.stop(); return { ok: true }; });
  app.on("before-quit", () => assistant.stop());
  ipcMain.handle("fabula:list-projects", () => listProjects());
  ipcMain.handle("fabula:switch-project", (event, name) => {
    const result = switchProject(name);
    if (result.ok) event.sender.send("fabula:state", readState());
    return result;
  });
  ipcMain.handle("fabula:close-project", (event) => {
    const result = closeProject();
    event.sender.send("fabula:state", readState());
    return result;
  });
  ipcMain.handle("fabula:remove-project", async (event, name) => {
    const result = await removeProject(BrowserWindow.fromWebContents(event.sender), name);
    if (result.ok) event.sender.send("fabula:state", readState());
    return result;
  });
  let rootChanging = false;
  ipcMain.handle("fabula:choose-projects-root", async (event, useDefault) => {
    if (rootChanging) return { ok: false, error: "Already changing the projects folder." };
    const window = BrowserWindow.fromWebContents(event.sender);
    let target = null;
    if (!useDefault) {
      const picked = await dialog.showOpenDialog(window, {
        title: "Choose where Fabula keeps its projects",
        defaultPath: mediaRoot(),
        properties: ["openDirectory", "createDirectory"],
      });
      if (picked.canceled || picked.filePaths.length === 0) return { ok: false, cancelled: true };
      target = picked.filePaths[0];
    }
    rootChanging = true;
    try {
      const result = await changeProjectsRoot(window, target, (text) => event.sender.send("fabula:projects-root-progress", text));
      if (result.ok) event.sender.send("fabula:state", readState());
      return result;
    } catch (error) {
      return { ok: false, error: `Could not change the projects folder: ${error.message}` };
    } finally { rootChanging = false; }
  });
  ipcMain.handle("fabula:reveal-projects-root", () => {
    fs.mkdirSync(mediaRoot(), { recursive: true });
    shell.openPath(mediaRoot());
    return { ok: true };
  });
  ipcMain.handle("fabula:reveal-project", (event, name) => {
    if (typeof name !== "string" || !core?.projectState.PROJECT_NAME_RE.test(name)) return { ok: false, error: "That is not a project name." };
    const dir = path.join(mediaRoot(), name);
    if (!fs.existsSync(dir)) return { ok: false, error: "That project folder is gone." };
    shell.openPath(dir);
    return { ok: true };
  });
  ipcMain.handle("fabula:pick-recording", async (event) => {
    const picked = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: "Choose a recording",
      properties: ["openFile"],
      filters: [{ name: "Recordings", extensions: ["mp4", "mov", "mkv", "webm", "m4v"] }],
    });
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, cancelled: true };
    const file = picked.filePaths[0];
    return { ok: true, path: file, suggestedTitle: path.basename(file, path.extname(file)) };
  });
  ipcMain.handle("fabula:create-project", (event, sourcePath, title, format) => {
    if (typeof sourcePath !== "string") return { ok: false, error: "Choose a recording first." };
    const result = ingest(sourcePath, typeof title === "string" ? title : null, typeof format === "string" ? format : null);
    if (result.ok) {
      // The mechanical part needs nobody: transcript, framing scan, cut
      // proposals start at once, and the window shows them landing.
      const dir = projectDir();
      if (dir && !fs.existsSync(path.join(dir, "review.json")) && !core?.pipeline.runningJob(dir)) {
        const started = startRender("first");
        if (!started.ok) result.firstPass = started.error;
      }
      event.sender.send("fabula:state", readState());
    }
    return result;
  });
  // A cut the person drew over words in the Cut step.
  ipcMain.handle("fabula:add-cut", (event, wordIds) => {
    const dir = projectDir();
    const file = dir && path.join(dir, "review.json");
    const review = file && readJson(file);
    if (!review || !core) return { ok: false, error: "No cuts to add to yet." };
    if (!Array.isArray(wordIds) || wordIds.length === 0 || wordIds.length > 5000 || !wordIds.every(Number.isInteger)) return { ok: false, error: "Select some words first." };
    try {
      review.cuts = core.cut.addWordCut(review.cuts, review.words, wordIds);
      writeJsonAtomic(file, review);
      event.sender.send("fabula:state", readState());
      return { ok: true, cuts: review.cuts.length };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  // ---- Shorts ----
  //
  // Reading the film for moments that could stand alone is pure and fast, so
  // it happens on demand rather than in the poll: the person presses Find,
  // reads the words, and picks. Making one writes a project and nothing else —
  // its clean cut is rendered from the recording like any other.
  ipcMain.handle("fabula:suggest-clips", (event, format) => {
    const dir = projectDir();
    if (!dir || !core) return { ok: false, error: "No project is open." };
    try {
      return { ok: true, ...core.shorts.suggestClips(dir, { format: typeof format === "string" ? format : "vertical" }) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle("fabula:create-short", (event, clip) => {
    const dir = projectDir();
    if (!dir || !core) return { ok: false, error: "No project is open." };
    if (!clip || !Number.isInteger(clip.fromWordId) || !Number.isInteger(clip.toWordId)) return { ok: false, error: "Choose a moment first." };
    try {
      const short = core.shorts.createShort(dir, {
        fromWordId: clip.fromWordId, toWordId: clip.toWordId,
        title: typeof clip.title === "string" && clip.title.trim() ? clip.title : undefined,
        format: typeof clip.format === "string" ? clip.format : "vertical",
        root: mediaRoot(),
      });
      event.sender.send("fabula:state", readState());
      return { ok: true, ...short };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle("fabula:rename-project", (event, name, title) => {
    const result = renameProject(name, title);
    if (result.ok) event.sender.send("fabula:state", readState());
    return result;
  });
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
      const transcript = readJson(path.join(dir, "clean.json"));
      const words = transcript ? core.cut.flattenWords(transcript) : [];
      if ((config.scenes ?? []).length > 0 || (config.inserts ?? []).length > 0) {
        if (words.length === 0) throw new Error("no clean transcript yet");
        core.compose.validateScenes(config.scenes ?? [], words);
        if (config.inserts) core.compose.validateInserts(config.inserts, words);
      }
      core.themes.validateTheme(config.theme);
      if (config.punch && !(config.punch.zoom >= 1.02 && config.punch.zoom <= 1.5)) throw new Error("punch zoom must be 1.02–1.5");
      writeJsonAtomic(file, config);
      event.sender.send("fabula:state", readState());
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error.message ?? error) };
    }
  };

  // What the inspector may change on one scene. Everything else about a
  // scene — its type, what kind of card it is — is the assistant's to write,
  // because changing it means rewriting the fields that go with it.
  const SCENE_PATCH_FIELDS = ["text", "subtitle", "style", "accent", "layout", "corner", "flair", "transition", "fromWordId", "toWordId"];
  const setOrDelete = (object, field, value) => {
    if (value === null || value === "" || value === undefined) delete object[field];
    else object[field] = value;
  };
  ipcMain.handle("fabula:update-scene", (event, index, patch) =>
    editCompose(event, (config) => {
      const scene = config.scenes?.[index];
      if (!scene) throw new Error(`no scene ${index}`);
      for (const field of SCENE_PATCH_FIELDS) {
        if (field in patch) setOrDelete(scene, field, patch[field]);
      }
      // graphic.* arrives as one object so a card's own fields (a stat's
      // value, an image's motion, a chart's rows) travel the same path.
      if (patch.graphic && scene.graphic) {
        for (const [key, value] of Object.entries(patch.graphic)) setOrDelete(scene.graphic, key, value);
      }
      if ("label" in patch && scene.graphic) setOrDelete(scene.graphic, "label", patch.label);
    })
  );
  // Duplicate and remove, so a plan can be adjusted without a round trip to
  // the assistant for something the eye can see needs doing.
  ipcMain.handle("fabula:duplicate-scene", (event, index) =>
    editCompose(event, (config) => {
      const scene = config.scenes?.[index];
      if (!scene) throw new Error(`no scene ${index}`);
      const { insertId, ...copy } = structuredClone(scene);
      config.scenes.splice(index + 1, 0, copy);
    })
  );
  ipcMain.handle("fabula:remove-scene", (event, index) =>
    editCompose(event, (config) => {
      if (!config.scenes?.[index]) throw new Error(`no scene ${index}`);
      config.scenes.splice(index, 1);
    })
  );
  ipcMain.handle("fabula:set-project", (event, patch) =>
    editCompose(event, (config) => {
      if ("accent" in patch) patch = { ...patch, theme: { ...(patch.theme ?? {}), accent: patch.accent || null } };
      if (patch.themeReset) config.theme = config.theme?.preset ? { preset: config.theme.preset } : {};
      if (patch.themeUse) config.theme = { ...core.themeStore.loadTheme(mediaRoot(), patch.themeUse) };
      if (patch.themeSave) {
        const { logo, ...look } = config.theme ?? {};
        core.themeStore.saveTheme(mediaRoot(), patch.themeSave, look);
      }
      if (patch.theme && typeof patch.theme === "object") {
        const theme = { ...(config.theme ?? {}) };
        for (const [key, value] of Object.entries(patch.theme)) {
          if (key === "logoCorner") { if (theme.logo) theme.logo = { ...theme.logo, corner: value }; continue; }
          if (value === null || value === "") delete theme[key];
          else theme[key] = value;
        }
        config.theme = theme;
      }
      if ("captions" in patch) config.captions = core.compose.captionMode(patch.captions);
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

  // The Export page: renders start here with the server's own job specs;
  // outputs open in the system player or their folder.
  ipcMain.handle("fabula:render", (event, kind, options) => {
    const result = startRender(String(kind), options && typeof options === "object" ? options : {});
    event.sender.send("fabula:state", readState());
    return result;
  });
  ipcMain.handle("fabula:reveal", (event, file) => {
    const target = projectFile(file);
    if (!target) return { ok: false, error: "That file is not in this project." };
    shell.showItemInFolder(target);
    return { ok: true };
  });
  ipcMain.handle("fabula:open-output", async (event, file) => {
    const target = projectFile(file);
    if (!target) return { ok: false, error: "That file is not in this project." };
    const error = await shell.openPath(target);
    return error ? { ok: false, error } : { ok: true };
  });
  ipcMain.handle("fabula:reanchor", (event) => {
    const result = reanchorProject();
    event.sender.send("fabula:state", readState());
    return result;
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
