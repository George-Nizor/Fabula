"use strict";

// The layered render. The head and screen tracks were rendered once by the
// clean render; here ffmpeg places them on the stage from expressions the
// stage engine generates — punch-ins included, so the clean cut never
// re-renders for a shot decision — and the browser is asked only for what
// changes: the cards and the head's shadow (under the head), the titles,
// captions and kinetic type (over it), each captured as a transparent frame
// exactly when its picture changes. The film is built in chunks, encoded in
// parallel and cached by everything that can alter their pixels, so a
// tweaked title re-renders one chunk and the stitch copies the rest with
// the untouched audio.
//
// Runs as a detached job started by the MCP server's render_final, writing
// progress.json itself so the window and a later session follow it. By hand:
//
//   npx electron --no-sandbox --no-zygote scripts/export-compose.cjs [--from=s] [--to=s] [--out=file] [--fresh] media/<project>

const { app, BrowserWindow, protocol } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { spawn, spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const REPO_ROOT = path.join(__dirname, "..");
// Motion scenes draw in sandboxed frames that load only over this scheme.
const motionProtocol = require(path.join(REPO_ROOT, "electron", "motion-protocol.cjs"));
motionProtocol.registerMotionScheme(protocol);
// Every page here may host a motion frame: sealed off the network (motion-protocol.cjs).
app.on("web-contents-created", (_event, contents) => motionProtocol.sealMotionFrames(contents));

// A voice quieter than this, with nothing levelling it, is worth warning
// about at the render gate: platforms play at -14 to -16 LUFS.
const QUIET_VOICE_LUFS = -22;
const FPS = 30;
const PARALLEL_ENCODES = 4;
const CAPTURE_WINDOWS = 3;
const STAGE = "render_final";

// Same WSL reality as the capture spike: both flags must be on the CLI —
// zygote-forked renderers die on this kernel before this file runs.
if (!app.commandLine.hasSwitch("no-zygote")) {
  console.error("Run with: npx electron --no-sandbox --no-zygote scripts/export-compose.cjs <project-dir>");
  app.exit(2);
}
app.commandLine.appendSwitch("disable-gpu");
if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  app.commandLine.appendSwitch("ozone-platform", "headless");
}

// Electron leaves its own switches in argv; ours carry a value after "=",
// the project dir is the one argument that is not a flag.
const argv = process.argv.slice(2);
const flag = (name) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const dirArg = argv.filter((arg) => !arg.startsWith("--")).pop();
const projectDir = path.resolve(REPO_ROOT, dirArg ?? "");
const fresh = argv.includes("--fresh");
// Keep each chunk's captured states and graph after encoding, for looking
// at what a render was actually given.
const keepWork = argv.includes("--keep-work");

const sha1 = (text) => crypto.createHash("sha1").update(text).digest("hex").slice(0, 16);
const fmt = (seconds) => `${Math.floor(seconds / 60)}:${(seconds - Math.floor(seconds / 60) * 60).toFixed(1).padStart(4, "0")}`;
const stamp = (file) => { const s = fs.statSync(file); return `${s.size}:${Math.round(s.mtimeMs)}`; };

let pipeline = null;
let FFMPEG = null;

function run(args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ["-y", "-v", "error", "-nostats", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`${label} failed (${code}): ${err.slice(-800)}`))));
  });
}

// ffmpeg at its default level, for a filter that reports what it measured.
function ffmpegLog(args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ["-hide_banner", "-nostats", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve(err) : reject(new Error(`${label} failed (${code}): ${err.slice(-800)}`))));
  });
}

function runSync(args, label) {
  const result = spawnSync(FFMPEG, ["-y", "-v", "error", "-nostats", ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${label} failed (${result.status}): ${(result.stderr || "").slice(-800)}`);
}

// A white rounded rectangle on black: alphamerge reads it as the alpha of
// a scaled track. Radius is a share of the width, matching the window.
function roundedMask(file, w, h, radius) {
  const R = radius.toFixed(2);
  runSync([
    "-f", "lavfi", "-i", `color=c=black:s=${w}x${h},format=gray`, "-frames:v", "1",
    "-vf", `geq=lum='255*clip(${R}+0.5-hypot(X-clip(X,${R},W-1-${R}),Y-clip(Y,${R},H-1-${R})),0,1)'`,
    file,
  ], "mask");
}

// The drifting pool of accent light: the window's radial gradient, rendered
// once and moved by expression.
function glowImage(file, size, accent, strength) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(accent.slice(i, i + 2), 16));
  const reach = (0.62 * (size / 2) * Math.SQRT2).toFixed(2);
  runSync([
    "-f", "lavfi", "-i", `color=c=black@0:s=${size}x${size},format=rgba`, "-frames:v", "1",
    "-vf", `geq=r='${r}':g='${g}':b='${b}':a='255*${strength.toFixed(3)}*max(0,1-hypot(X-${size / 2},Y-${size / 2})/${reach})'`,
    file,
  ], "glow");
}

// Everything logged is also the window's progress line.
let label = "Rendering the film";
function say(text) {
  console.log(`[${new Date().toISOString()}] ${text}`);
  pipeline.reportProgress(projectDir, STAGE, label, text, { pid: process.pid });
}

async function main() {
  const started = Date.now();
  const { flattenWords } = await import(pathToFileURL(path.join(REPO_ROOT, "core", "cut-engine.mjs")).href);
  const engine = await import(pathToFileURL(path.join(REPO_ROOT, "core", "compose-engine.mjs")).href);
  const stageEngine = await import(pathToFileURL(path.join(REPO_ROOT, "core", "stage-engine.mjs")).href);
  const shotEngine = await import(pathToFileURL(path.join(REPO_ROOT, "core", "shot-engine.mjs")).href);
  const themes = await import(pathToFileURL(path.join(REPO_ROOT, "core", "themes.mjs")).href);
  const formats = await import(pathToFileURL(path.join(REPO_ROOT, "core", "formats.mjs")).href);
  const templates = await import(pathToFileURL(path.join(REPO_ROOT, "core", "templates.mjs")).href);
  const plan = await import(pathToFileURL(path.join(REPO_ROOT, "core", "render-plan.mjs")).href);
  pipeline = await import(pathToFileURL(path.join(REPO_ROOT, "scripts", "pipeline.mjs")).href);
  FFMPEG = pipeline.FFMPEG;
  const { probeDuration, probeDimensions } = pipeline;

  const cleanVideo = path.join(projectDir, "out", "clean.mp4");
  const screenVideo = path.join(projectDir, "out", "screen.mp4");
  const hasScreen = fs.existsSync(screenVideo);
  const transcript = JSON.parse(fs.readFileSync(path.join(projectDir, "clean.json"), "utf8"));
  const composeFile = JSON.parse(fs.readFileSync(path.join(projectDir, "compose.json"), "utf8"));
  const cleanMap = JSON.parse(fs.readFileSync(path.join(projectDir, "out", "clean-map.json"), "utf8"));

  const words = flattenWords(transcript);
  const duration = probeDuration(cleanVideo);
  const dims = probeDimensions(cleanVideo);
  const videoAspect = dims.width / dims.height;
  // A draft: the same film at a fraction of the stage, for looking at the
  // whole thing in a fraction of the time. Everything downstream reads the
  // stage's size, so scaling that one object scales the capture windows,
  // the head's rectangles, the glow and the masks together.
  const scale = Math.min(Math.max(Number(flag("scale") ?? 1), 0.25), 1);
  const draft = scale < 1;
  // The canvas is the project's delivery format, so the capture windows, the
  // field plate, the glow and every rectangle follow from one number.
  const meta = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(projectDir, "project.json"), "utf8")); } catch { return {}; }
  })();
  const fullStage = formats.stageOf(meta);
  const stage = draft ? { width: Math.round(fullStage.width * scale / 2) * 2, height: Math.round(fullStage.height * scale / 2) * 2 } : fullStage;
  if (draft) say(`draft at ${Math.round(scale * 100)}%: ${stage.width}×${stage.height}`);
  const scenes = engine.resolveScenes(templates.refreshTemplates(composeFile.scenes ?? [], { format: formats.resolveFormat(meta).id }), words, { durationSeconds: duration });
  const assetUrl = (src) => pathToFileURL(path.join(projectDir, src)).href;
  const projectState = await import(pathToFileURL(path.join(REPO_ROOT, "scripts", "project-state.mjs")).href);
  projectState.attachSceneMedia(projectDir, scenes, assetUrl);
  motionProtocol.handleMotionProtocol(protocol, { projectDir: () => projectDir });
  const theme = themes.resolveTheme(composeFile.theme ?? null);
  if (theme.logo) theme.logoUrl = assetUrl(theme.logo.src);
  const accent = theme.accent;
  const punchSpans = composeFile.punch ? shotEngine.punchSpans(cleanMap.pieces, composeFile.punch.zoom) : [];
  const phrases = engine.resolvePhraseCaptions(words, { emphasis: composeFile.captionEmphasis });
  const compose = {
    videoUrl: pathToFileURL(cleanVideo).href,
    screenUrl: hasScreen ? pathToFileURL(screenVideo).href : null,
    duration,
    scenes,
    captions: engine.captionsBurnedIn(composeFile.captions) ? phrases : null,
    wordSpans: engine.resolveCaptions(words),
    stage,
    // A draft is a smaller stage; a motion scene still draws at the film's
    // own pixels and is scaled down, so its type sits where the film's will.
    logicalStage: fullStage,
    theme,
    punchSpans,
  };
  const timeline = stageEngine.resolveLayoutTimeline(scenes, duration, { transition: theme.transition, transitionSeconds: theme.transitionSeconds, stage });

  const from = Math.round(Math.max(Number(flag("from") ?? 0), 0) * FPS) / FPS;
  const to = Math.min(Number(flag("to") ?? duration), duration);
  const outPath = flag("out") ?? path.join(projectDir, "out", draft ? "draft.mp4" : "final.mp4");
  const wholeFilm = outPath === path.join(projectDir, "out", "final.mp4");
  // The whole film, as the film or as a draft: the sound is finished on it
  // and its own chunk cache is pruned after it. A preview span is neither.
  const wholeOutput = flag("from") === undefined && flag("to") === undefined;
  label = wholeFilm ? "Rendering the film" : draft && wholeOutput ? "Rendering a draft" : "Rendering a preview span";
  const chunkSeconds = Number(flag("chunk") ?? plan.chunkSecondsFor(to - from, PARALLEL_ENCODES));
  const chunks = plan.chunkPlan(from, to, FPS, chunkSeconds);
  const total = chunks.reduce((n, c) => n + c.frames, 0);

  const cacheDir = path.join(projectDir, "out", draft ? "chunks-draft" : "chunks");
  fs.mkdirSync(cacheDir, { recursive: true });
  // Leftovers of an interrupted run are never resumable: their captures
  // belong to a chunk hash that may no longer exist.
  for (const entry of fs.readdirSync(cacheDir)) {
    if (entry.endsWith(".work") || entry.startsWith("sound-")) fs.rmSync(path.join(cacheDir, entry), { recursive: true, force: true });
  }
  const clipFiles = [...new Set(scenes.filter((s) => s.graphic?.kind === "clip").map((s) => s.graphic.src))];
  const media = { clean: stamp(cleanVideo), screen: hasScreen ? stamp(screenVideo) : null, clips: Object.fromEntries(clipFiles.map((src) => [src, stamp(path.join(projectDir, src))])) };
  const encoder = pipeline.videoEncoderArgs(draft ? "draft" : "film", FPS);
  // The painter's own files are part of every chunk's identity: a change to
  // a stylesheet or the overlay script is a new picture, and a cached chunk
  // from the old one must never be stitched in.
  const painter = sha1(["overlays.js", "overlays.css", "fonts.css", "export.html", "export-page.js", "motion/host.html", "motion/runtime.js"]
    .map((name) => fs.readFileSync(path.join(REPO_ROOT, "renderer", name), "utf8")).join("\n"));
  const context = { scenes, timeline, captions: compose.captions, wordSpans: compose.wordSpans, theme, stage, videoAspect, media, fps: FPS, punch: punchSpans, encoder: encoder.join(" "), painter };
  for (const chunk of chunks) {
    chunk.hash = sha1(plan.chunkIdentity(chunk, context));
    chunk.cached = path.join(cacheDir, `${chunk.hash}.mp4`);
    chunk.ready = !fresh && fs.existsSync(chunk.cached);
  }
  const todo = chunks.filter((chunk) => !chunk.ready);
  say(`${total} frames over ${fmt(from)}–${fmt(to)} of ${fmt(duration)} in ${chunks.length} chunks, ${chunks.length - todo.length} cached${hasScreen ? ", with a screen track" : ""}${punchSpans.length ? `, ${punchSpans.filter((s) => s.scale > 1).length} punch-ins` : ""}, ${encoder[1]}`);

  // The sound: the clean cut's voice as it is, or the voice normalised with
  // a music bed under it, ducked from the transcript (core/audio-engine.mjs).
  // It lives only in the stitch, so a change to it never re-renders a chunk,
  // and it is made alongside the picture rather than after it: the level is
  // converged with audio-only passes (the graph measured on its own, no
  // encode), then the track is encoded once while the chunks render, and the
  // stitch copies it in. Re-encoding the whole AAC track up to three times
  // after the picture, while the level settled, was most of a long film's
  // stitch. Input 0 is a placeholder so the graph's inputs keep the numbers
  // they were written with (1 = the voice).
  const span = to - from;
  const audioSeek = span < duration - 0.01 ? ["-ss", String(from), "-t", String(span)] : [];
  const audioEngine = await import(pathToFileURL(path.join(REPO_ROOT, "core", "audio-engine.mjs")).href);
  const musicSrc = composeFile.audio?.music?.src;
  const musicPath = musicSrc ? path.join(projectDir, musicSrc) : null;
  if (musicSrc && !fs.existsSync(musicPath)) throw new Error(`the music bed ${musicSrc} is not in the project; import_audio puts it there`);
  // The voice's measured loudness, from the bed's own setting when it was
  // measured there, else from the clean render's measurement when it
  // describes this clean cut — so a target set before the clean cut existed
  // (a short's) still lands exactly.
  const cleanAudio = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(projectDir, "out", "clean-audio.json"), "utf8")); } catch { return null; }
  })();
  const voiceLoudness = composeFile.audio?.voice?.measured
    ?? (cleanAudio && cleanAudio.identity === cleanMap.identity && typeof cleanAudio.voiceLoudness === "number" ? cleanAudio.voiceLoudness : undefined);
  const graphFor = (voiceTrimDb) => audioEngine.audioGraph({ audio: composeFile.audio, words, from, span, musicPath, voiceLoudness, voiceTrimDb, clips: scenes, clipPath: (src) => path.join(projectDir, src), effectPath: (src) => path.join(projectDir, src) });
  const soundInputs = (graph) => ["-f", "lavfi", "-t", "0.04", "-i", "color=c=black:s=16x16", ...audioSeek, "-i", cleanVideo, ...graph.inputs];
  const loudnessOf = async (graph) => {
    const file = path.join(cacheDir, `sound-measure-${sha1(graph.filter)}.txt`);
    fs.writeFileSync(file, `${graph.filter.trimEnd()};\n${graph.map}ebur128=framelog=quiet[measured]\n`);
    try {
      const log = await ffmpegLog([...soundInputs(graph), "-/filter_complex", file, "-map", "[measured]", "-f", "null", "-"], "measuring the sound");
      const match = log.match(/\bI:\s+(-?\d+(?:\.\d+)?)\s+LUFS/);
      return match ? Number(match[1]) : null;
    } finally { fs.rmSync(file, { force: true }); }
  };
  const note = (text) => console.log(`[${new Date().toISOString()}] ${text}`);
  const makeSound = async () => {
    let sound = graphFor(0);
    if (!sound) return { track: null };
    const parts = [sound.windows ? `music bed under the voice, up in ${sound.windows.length} pause(s)` : "voice only"];
    if (sound.nats?.length) parts.push(`${sound.nats.length} clip(s) with their own sound under it`);
    if (sound.hits?.length) parts.push(`${sound.hits.length} sound effect(s)`);
    if (composeFile.audio?.voice?.loudness != null) parts.push(`voice to ${composeFile.audio.voice.loudness} LUFS`);
    note(`sound: ${parts.join(", ")}`);
    // The ceiling takes a little off a voice that needed a lot of gain:
    // measure what the graph makes and trim the difference in, a few times
    // at most, before anything is encoded.
    let level = null;
    if (sound.voiceTarget !== null && sound.voiceTarget !== undefined && wholeOutput) {
      let trim = 0;
      for (let pass = 0; pass < 4; pass += 1) {
        level = await loudnessOf(sound);
        if (typeof level !== "number" || Math.abs(level - sound.voiceTarget) <= 0.3 || pass === 3) break;
        trim += sound.voiceTarget - level;
        note(`voice measured ${level} LUFS against ${sound.voiceTarget}; the gain ${trim >= 0 ? "up" : "down"} ${Math.abs(trim).toFixed(1)} dB`);
        sound = graphFor(trim);
      }
      if (typeof level === "number") parts.push(`measured ${level} LUFS`);
    }
    const soundFile = path.join(cacheDir, `sound-${sha1(sound.filter)}.txt`);
    const track = path.join(cacheDir, `sound-${sha1(sound.filter + JSON.stringify([sound.inputs, audioSeek]))}.m4a`);
    fs.writeFileSync(soundFile, sound.filter);
    try {
      await run([...soundInputs(sound), "-/filter_complex", soundFile, "-map", sound.map, "-c:a", "aac", "-b:a", "192k", "-vn", track], "sound");
    } finally { fs.rmSync(soundFile, { force: true }); }
    note(`sound encoded${typeof level === "number" ? `, voice at ${level} LUFS` : ""}`);
    return { track, summary: `sound: ${parts.join(", ")}` };
  };
  // Settled, never rejected: a failure is thrown at the stitch, where the
  // render would have met it anyway, and not as an unhandled rejection in
  // the middle of a capture.
  const soundJob = makeSound().then((value) => value, (error) => ({ error }));

  const assetsDir = path.join(cacheDir, `assets-${sha1(JSON.stringify({ theme, stage, dims, v: plan.RENDERER_VERSION }))}`);
  const encodes = [];
  const motionProblems = new Set();
  if (todo.length > 0) {
    // Capture runs in several browsers at once, one chunk each: the
    // captures are the critical path, and each renderer is its own
    // process. Encodes queue behind the captures, several at a time.
    const makeWindow = async () => {
      const window = new BrowserWindow({
        show: false,
        width: stage.width,
        height: stage.height,
        frame: false,
        transparent: true,
        webPreferences: { offscreen: true, sandbox: true, backgroundThrottling: false },
      });
      const watchdog = setTimeout(() => {
        console.error("load watchdog fired: renderer never became ready");
        app.exit(3);
      }, 15000);
      await window.loadFile(path.join(REPO_ROOT, "renderer", "export.html"));
      clearTimeout(watchdog);
      const contents = window.webContents;
      if (!contents.isPainting()) contents.startPainting();
      // Every capture waits for two painted frames; at the default 60 Hz
      // that wait was most of a capture. The pixels are the same.
      contents.setFrameRate(240);
      contents.debugger.attach("1.3");
      await contents.executeJavaScript(`__setCompose(${JSON.stringify(compose)}, { media: false })`);
      return window;
    };
    const shoot = async (contents, file, alpha) => {
      const shot = await contents.debugger.sendCommand("Page.captureScreenshot", { format: "png", omitBackground: alpha, optimizeForSpeed: true });
      fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
    };
    const windows = [];
    for (let i = 0; i < Math.min(CAPTURE_WINDOWS, todo.length); i += 1) windows.push(await makeWindow());
    const first = windows[0].webContents;

    // Plates shared by every chunk: the field, the glow, the head's mask,
    // and one empty transparent frame for layers with nothing to show.
    const assets = assetsDir;
    fs.mkdirSync(assets, { recursive: true });
    const field = path.join(assets, "field.png");
    const glow = path.join(assets, "glow.png");
    const headMask = path.join(assets, "mask-head.png");
    const empty = path.join(assets, "empty.png");
    const glowSize = Math.round(stage.width * 0.9);
    if (!fs.existsSync(field)) { await first.executeJavaScript("__fieldOnly()"); await shoot(first, field, false); }
    if (!fs.existsSync(glow)) glowImage(glow, glowSize, accent, theme.glow);
    const HEAD_RADIUS = (await first.executeJavaScript("FabulaStage.HEAD_RADIUS")) * theme.radius;
    const SCREEN_RADIUS = (await first.executeJavaScript("FabulaStage.SCREEN_RADIUS")) * theme.radius;
    if (!fs.existsSync(headMask)) roundedMask(headMask, dims.width, dims.height, HEAD_RADIUS * dims.width);
    if (!fs.existsSync(empty)) { await first.executeJavaScript("__renderLayer(0, null, 'none')"); await shoot(first, empty, true); }
    const screenMask = (w, h) => {
      const file = path.join(assets, `mask-screen-${w}x${h}.png`);
      if (!fs.existsSync(file)) roundedMask(file, w, h, SCREEN_RADIUS * w);
      return file;
    };

    const pool = (items) => {
      const free = [...items];
      const waiters = [];
      return {
        take: () => new Promise((resolve) => { if (free.length) resolve(free.pop()); else waiters.push(resolve); }),
        give: (item) => { const next = waiters.shift(); if (next) next(item); else free.push(item); },
      };
    };
    const captureSlots = pool(windows);
    const encodeSlots = pool(Array.from({ length: PARALLEL_ENCODES }, (_, i) => i));
    let encoded = 0;
    let liveEncodes = 0;
    let failure = null;

    const captureChunk = async (contents, chunk, tag, work) => {
      const captureStart = Date.now();
      const ts = [];
      const layouts = [];
      for (let i = 0; i < chunk.frames; i += 1) {
        const t = Math.min(chunk.start + i / FPS, Math.max(duration - 0.001, 0));
        ts.push(t);
        layouts.push(stageEngine.layoutAt(timeline, t, videoAspect, stage));
      }
      const keys = await contents.executeJavaScript(`__keysRange(${JSON.stringify(ts)}, ${JSON.stringify(layouts)})`);

      // Capture each layer only when its signature changes; an empty layer
      // is the shared transparent plate.
      const states = { under: [], over: [] };
      for (const layer of ["under", "over"]) {
        let last = null;
        for (let i = 0; i < chunk.frames; i += 1) {
          const key = keys[i][layer];
          if (key === last) continue;
          last = key;
          let file = empty;
          if (key !== "[]") {
            file = path.join(work, `${layer}-${String(i).padStart(5, "0")}.png`);
            await contents.executeJavaScript(`__renderLayer(${ts[i]}, ${JSON.stringify(layouts[i])}, ${JSON.stringify(layer)})`);
            await shoot(contents, file, true);
          }
          states[layer].push({ at: i / FPS, file });
        }
        // Every state on the film's own clock. The image demuxer reads a PNG
        // on a 1/25 s grid unless told otherwise, and states a film frame
        // apart (every frame of a motion scene or a build) then share a
        // timestamp: ffmpeg drops or pushes them, and a long motion scene
        // left the layer seconds out of step — the cover that vanished two
        // seconds early in the first made film. So each file is read at the
        // film's rate, and durations carry enough digits that thousands of
        // them do not add up to a frame.
        const list = ["ffconcat version 1.0"];
        states[layer].forEach((state, k) => {
          const next = states[layer][k + 1];
          const durationSeconds = (next ? next.at : chunk.frames / FPS) - state.at;
          list.push(`file '${state.file}'`, `option framerate ${FPS}`, `duration ${durationSeconds.toFixed(6)}`);
        });
        list.push(`file '${states[layer].at(-1).file}'`, `option framerate ${FPS}`);
        fs.writeFileSync(path.join(work, `${layer}.txt`), list.join("\n") + "\n");
      }

      // Screen scenes inside this chunk, with the rect the page measured.
      const screenScenes = [];
      for (let i = 0; i < chunk.frames; i += 1) {
        const s = keys[i].screen;
        if (!s) continue;
        const known = screenScenes.find((x) => x.start === s.start && x.end === s.end);
        if (!known) screenScenes.push({ start: s.start, end: s.end, rect: s.rect, edgeIn: s.edgeIn, edgeOut: s.edgeOut });
      }
      // Clip (B-roll) scenes likewise, each with its file and offset.
      const clipScenes = [];
      for (let i = 0; i < chunk.frames; i += 1) {
        const c = keys[i].clip;
        if (!c) continue;
        if (!clipScenes.find((x) => x.start === c.start && x.end === c.end && x.src === c.src)) clipScenes.push({ start: c.start, end: c.end, rect: c.rect, src: c.src, in: c.in, fit: c.fit, edgeIn: c.edgeIn, edgeOut: c.edgeOut });
      }
      const screens = [...(hasScreen ? plan.screenPlacements(screenScenes, chunk) : []), ...plan.clipPlacements(clipScenes, chunk)];
      // What the motion scenes said while this chunk was captured. One that
      // stopped answering stops the render: its frames would be wrong, and
      // the film would wait on it at every frame. An error one threw goes in
      // the log for whoever reads it (wait_render hands the tail over).
      const problems = await contents.executeJavaScript("__motionErrors()").catch(() => ({}));
      for (const [src, errors] of Object.entries(problems ?? {})) {
        const stuck = errors.find((error) => /did not draw within/.test(error));
        if (stuck) throw new Error(`${stuck}, so the render stops rather than film it wrong. preview_motion ${path.basename(src, ".html")} shows what it does; a render(t) that never returns is the usual cause`);
        for (const error of errors) motionProblems.add(`${src}: ${error}`);
      }
      const captured = states.under.length + states.over.length;
      say(`${tag}: ${captured} states captured in ${((Date.now() - captureStart) / 1000).toFixed(1)}s (under ${states.under.length}, over ${states.over.length}, screens ${screens.length}); ${encoded} of ${todo.length} encoded`);
      return screens;
    };

    const encodeChunk = async (chunk, tag, work, screens) => {
      const graph = plan.chunkGraph({ chunk, timeline, videoAspect, stage, glowSize, screens, punch: punchSpans, fps: FPS, grade: theme.grade });
      const graphFile = path.join(work, "graph.txt");
      fs.writeFileSync(graphFile, graph);
      const D = String(chunk.frames / FPS);
      const seek = chunk.start > 0 ? ["-ss", String(chunk.start)] : [];
      const args = [
        // Stills are read once; the graph repeats them (render-plan ONCE).
        "-framerate", String(FPS), "-i", field,
        "-framerate", String(FPS), "-i", glow,
        ...seek, "-t", D, "-i", cleanVideo,
        "-framerate", String(FPS), "-i", headMask,
        "-f", "concat", "-safe", "0", "-i", path.join(work, "under.txt"),
        "-f", "concat", "-safe", "0", "-i", path.join(work, "over.txt"),
      ];
      for (const screen of screens) {
        // The screen track is read at the chunk's own time; a clip from its
        // own offset, for as long as its card is on.
        if (screen.src) args.push("-ss", String(screen.offset), "-t", String(Math.max(0.1, screen.end - Math.max(0, screen.start))), "-i", path.join(projectDir, screen.src));
        else args.push(...seek, "-t", D, "-i", screenVideo);
        args.push("-framerate", String(FPS), "-i", screenMask(screen.rect.w, screen.rect.h));
      }
      args.push(
        // The filter graph is the encode's bottleneck: give it the cores the
        // other running encodes are not using.
        "-filter_complex_threads", String(Math.max(4, Math.floor(os.cpus().length / Math.max(1, liveEncodes)))), "-/filter_complex", graphFile,
        "-map", "[out]", "-r", String(FPS), "-frames:v", String(chunk.frames),
        ...encoder,
        "-an", path.join(work, "chunk.mp4"),
      );
      const encodeStart = Date.now();
      liveEncodes += 1;
      try { await run(args, tag); } finally { liveEncodes -= 1; }
      fs.renameSync(path.join(work, "chunk.mp4"), chunk.cached);
      if (!keepWork) fs.rmSync(work, { recursive: true, force: true });
      encoded += 1;
      say(`${tag} encoded in ${((Date.now() - encodeStart) / 1000).toFixed(1)}s; ${encoded} of ${todo.length} encoded`);
    };

    for (const [n, chunk] of todo.entries()) {
      const tag = `chunk ${n + 1}/${todo.length} (${fmt(chunk.start)}–${fmt(chunk.end)})`;
      const work = path.join(cacheDir, `${chunk.hash}.work`);
      fs.rmSync(work, { recursive: true, force: true });
      fs.mkdirSync(work, { recursive: true });
      encodes.push((async () => {
        if (failure) return;
        const window = await captureSlots.take();
        let screens;
        try {
          screens = await captureChunk(window.webContents, chunk, tag, work);
        } catch (error) {
          failure = failure ?? error;
          return;
        } finally {
          captureSlots.give(window);
        }
        const slot = await encodeSlots.take();
        try {
          if (!failure) await encodeChunk(chunk, tag, work, screens);
        } catch (error) {
          failure = failure ?? error;
        } finally {
          encodeSlots.give(slot);
        }
      })());
    }
    await Promise.all(encodes);
    for (const window of windows) window.destroy();
    if (failure) throw failure;
  }

  if (motionProblems.size) say(`WARNING: motion scenes reported errors while they were filmed — ${[...motionProblems].slice(0, 6).join("; ")}${motionProblems.size > 6 ? ` (and ${motionProblems.size - 6} more)` : ""}. preview_motion shows each scene with its errors.`);

  // The stitch: every chunk copied in order, the clean cut's audio alongside.
  say(`stitching ${chunks.length} chunks`);
  const list = ["ffconcat version 1.0", ...chunks.map((chunk) => `file '${chunk.cached}'`)];
  const listFile = path.join(cacheDir, `stitch-${sha1(list.join("\n"))}.txt`);
  fs.writeFileSync(listFile, list.join("\n") + "\n");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const partial = outPath.replace(/\.mp4$/, ".partial.mp4");
  const made = await soundJob;
  if (made.error) throw made.error;
  if (made.track) say(made.summary);
  // A film nobody can hear is not a film. The clean render measured the
  // voice; when nothing is normalising it and it sits well under what
  // platforms play at, say so here, where the person is watching the render
  // — status says it too, but nobody has to read status to press render.
  if (wholeOutput && composeFile.audio?.voice?.loudness == null) {
    const measured = cleanAudio?.voiceLoudness;
    if (typeof measured === "number" && measured < QUIET_VOICE_LUFS && measured > -60) { // under -60 is no voice: a silent motion film
      say(`WARNING: the voice measures ${measured} LUFS and nothing is levelling it; platforms play at -14 to -16, so this film will be far too quiet. set_audio voice_loudness -16 (a film) or -14 (a short) and render again — the sound is only the stitch, so it takes seconds.`);
    }
  }
  if (made.track) {
    await run(["-f", "concat", "-safe", "0", "-i", listFile, "-i", made.track, "-map", "0:v", "-map", "1:a", "-c", "copy", "-movflags", "+faststart", "-shortest", partial], "stitch");
    fs.rmSync(made.track, { force: true });
  } else {
    await run(["-f", "concat", "-safe", "0", "-i", listFile, ...audioSeek, "-i", cleanVideo, "-map", "0:v", "-map", "1:a", "-c:a", "copy", "-c:v", "copy", "-movflags", "+faststart", "-shortest", partial], "stitch");
  }
  fs.renameSync(partial, outPath);
  fs.rmSync(listFile, { force: true });
  // The captions as files beside the film, whatever the mode: a player's CC
  // track when they are not in the picture, a transcript when they are.
  for (const format of ["srt", "vtt"]) {
    fs.writeFileSync(outPath.replace(/\.mp4$/, `.${format}`), engine.subtitleFile(phrases, format, from, to));
  }

  // The credits the film owes, beside it: every asset with a source. Written
  // with the whole film, so handing over out/ hands over the credits.
  if (wholeOutput) {
    try {
      const { listAssets } = await import(pathToFileURL(path.join(REPO_ROOT, "scripts", "images.mjs")).href);
      const credited = listAssets(path.join(projectDir, "assets")).filter((asset) => asset.attribution && (asset.attribution.author || asset.attribution.license || asset.attribution.pageUrl));
      const creditsFile = path.join(projectDir, "out", "credits.md");
      if (credited.length) {
        const lines = ["# Credits", "", ...credited.map(({ src, attribution: a }) => {
          const name = src.replace(/^assets\//, "");
          const link = a.pageUrl ? `[${name}](${a.pageUrl})` : name;
          return `- ${a.author ? `${a.author}: ` : ""}${link}${a.license ? ` — ${a.license}.` : ""}`;
        }), ""];
        fs.writeFileSync(creditsFile, lines.join("\n"));
        say(`credits: ${credited.length} asset(s) in out/credits.md`);
      }
    } catch (error) { say(`credits not written: ${error.message}`); }
  }

  // After a whole film, chunks no plan references any more are dead weight,
  // and so are plates from an older accent or renderer; a preview span's
  // chunks are cheap to make again.
  if (wholeOutput) {
    const keep = new Set(chunks.map((chunk) => path.basename(chunk.cached)));
    for (const entry of fs.readdirSync(cacheDir)) {
      const file = path.join(cacheDir, entry);
      if (entry.endsWith(".mp4") && !keep.has(entry)) fs.rmSync(file, { force: true });
      if (entry.startsWith("assets-") && file !== assetsDir) fs.rmSync(file, { recursive: true, force: true });
    }
  }
  console.log(`[${new Date().toISOString()}] wrote ${outPath} (${(fs.statSync(outPath).size / 1e6).toFixed(1)} MB) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  pipeline.clearProgress(projectDir);
  app.quit();
}

// The capture window is destroyed before the stitch; without this, Electron
// takes "no windows left" as its cue to quit and the stitch dies with it.
app.on("window-all-closed", () => {});

app.whenReady().then(() =>
  main().catch((error) => {
    console.error(error);
    try {
      if (pipeline) pipeline.reportProgress(projectDir, STAGE, label, `failed: ${String(error.message ?? error).slice(0, 200)}`);
    } catch { /* the note is best effort */ }
    app.exit(1);
  }),
);
