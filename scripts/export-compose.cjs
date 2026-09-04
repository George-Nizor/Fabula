"use strict";

// The layered render. The head and screen tracks were rendered once by the
// clean render; here ffmpeg places them on the stage from expressions the
// stage engine generates, and the browser is asked only for what changes:
// the cards and the head's shadow (under the head), the titles, captions and
// kinetic type (over it), each captured as a transparent frame exactly when
// its picture changes. The film is built in chunks, encoded in parallel and
// cached by everything that can alter their pixels, so a tweaked title
// re-renders one chunk and the stitch copies the rest with the untouched
// audio. Run by the MCP server's render_final, or by hand:
//
//   npx electron --no-sandbox --no-zygote scripts/export-compose.cjs [--from=s] [--to=s] [--out=file] [--fresh] media/<project>

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const REPO_ROOT = path.join(__dirname, "..");
const FFMPEG = path.join(REPO_ROOT, "tools", "ffmpeg", "ffmpeg");
const FPS = 30;
const PARALLEL_ENCODES = 3;

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

const sha1 = (text) => crypto.createHash("sha1").update(text).digest("hex").slice(0, 16);
const fmt = (seconds) => `${Math.floor(seconds / 60)}:${(seconds - Math.floor(seconds / 60) * 60).toFixed(1).padStart(4, "0")}`;
const stamp = (file) => { const s = fs.statSync(file); return `${s.size}:${Math.round(s.mtimeMs)}`; };

function run(args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ["-y", "-v", "error", "-nostats", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`${label} failed (${code}): ${err.slice(-800)}`))));
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
function glowImage(file, size, accent) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(accent.slice(i, i + 2), 16));
  const reach = (0.62 * (size / 2) * Math.SQRT2).toFixed(2);
  runSync([
    "-f", "lavfi", "-i", `color=c=black@0:s=${size}x${size},format=rgba`, "-frames:v", "1",
    "-vf", `geq=r='${r}':g='${g}':b='${b}':a='255*0.07*max(0,1-hypot(X-${size / 2},Y-${size / 2})/${reach})'`,
    file,
  ], "glow");
}

async function main() {
  const started = Date.now();
  const { flattenWords } = await import(pathToFileURL(path.join(REPO_ROOT, "core", "cut-engine.mjs")).href);
  const engine = await import(pathToFileURL(path.join(REPO_ROOT, "core", "compose-engine.mjs")).href);
  const stageEngine = await import(pathToFileURL(path.join(REPO_ROOT, "core", "stage-engine.mjs")).href);
  const plan = await import(pathToFileURL(path.join(REPO_ROOT, "core", "render-plan.mjs")).href);
  const { probeDuration, probeDimensions } = await import(pathToFileURL(path.join(REPO_ROOT, "scripts", "pipeline.mjs")).href);

  const cleanVideo = path.join(projectDir, "out", "clean.mp4");
  const screenVideo = path.join(projectDir, "out", "screen.mp4");
  const hasScreen = fs.existsSync(screenVideo);
  const transcript = JSON.parse(fs.readFileSync(path.join(projectDir, "clean.json"), "utf8"));
  const composeFile = JSON.parse(fs.readFileSync(path.join(projectDir, "compose.json"), "utf8"));

  const words = flattenWords(transcript);
  const duration = probeDuration(cleanVideo);
  const dims = probeDimensions(cleanVideo);
  const videoAspect = dims.width / dims.height;
  const stage = stageEngine.DEFAULT_STAGE;
  const scenes = engine.resolveScenes(composeFile.scenes ?? [], words);
  for (const scene of scenes) {
    if (scene.graphic?.src) scene.graphic.url = pathToFileURL(path.join(projectDir, scene.graphic.src)).href;
  }
  const accent = composeFile.theme?.accent ?? "#d97757";
  const compose = {
    videoUrl: pathToFileURL(cleanVideo).href,
    screenUrl: hasScreen ? pathToFileURL(screenVideo).href : null,
    scenes,
    captions: composeFile.captions ? engine.resolvePhraseCaptions(words) : null,
    wordSpans: engine.resolveCaptions(words),
    stage,
    theme: composeFile.theme ?? null,
  };
  const timeline = stageEngine.resolveLayoutTimeline(scenes, duration);

  const from = Math.round(Math.max(Number(flag("from") ?? 0), 0) * FPS) / FPS;
  const to = Math.min(Number(flag("to") ?? duration), duration);
  const outPath = flag("out") ?? path.join(projectDir, "out", "final.mp4");
  const chunkSeconds = Number(flag("chunk") ?? plan.DEFAULT_CHUNK_SECONDS);
  const chunks = plan.chunkPlan(from, to, FPS, chunkSeconds);
  const total = chunks.reduce((n, c) => n + c.frames, 0);

  const cacheDir = path.join(projectDir, "out", "chunks");
  fs.mkdirSync(cacheDir, { recursive: true });
  const media = { clean: stamp(cleanVideo), screen: hasScreen ? stamp(screenVideo) : null };
  const context = { scenes, timeline, captions: compose.captions, wordSpans: compose.wordSpans, theme: compose.theme, stage, videoAspect, media, fps: FPS };
  for (const chunk of chunks) {
    chunk.hash = sha1(plan.chunkIdentity(chunk, context));
    chunk.cached = path.join(cacheDir, `${chunk.hash}.mp4`);
    chunk.ready = !fresh && fs.existsSync(chunk.cached);
  }
  const todo = chunks.filter((chunk) => !chunk.ready);
  console.log(`${total} frames over ${fmt(from)}–${fmt(to)} of ${fmt(duration)} in ${chunks.length} chunks, ${chunks.length - todo.length} cached${hasScreen ? ", with a screen track" : ""}`);

  const encodes = [];
  if (todo.length > 0) {
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
    contents.debugger.attach("1.3");
    const shoot = async (file, alpha) => {
      const shot = await contents.debugger.sendCommand("Page.captureScreenshot", { format: "png", omitBackground: alpha, optimizeForSpeed: true });
      fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
    };

    await contents.executeJavaScript(`__setCompose(${JSON.stringify(compose)}, { media: false })`);

    // Plates shared by every chunk: the field, the glow, the head's mask,
    // and one empty transparent frame for layers with nothing to show.
    const assets = path.join(cacheDir, `assets-${sha1(JSON.stringify({ accent, stage, dims, v: plan.RENDERER_VERSION }))}`);
    fs.mkdirSync(assets, { recursive: true });
    const field = path.join(assets, "field.png");
    const glow = path.join(assets, "glow.png");
    const headMask = path.join(assets, "mask-head.png");
    const empty = path.join(assets, "empty.png");
    const glowSize = Math.round(stage.width * 0.9);
    if (!fs.existsSync(field)) { await contents.executeJavaScript("__fieldOnly()"); await shoot(field, false); }
    if (!fs.existsSync(glow)) glowImage(glow, glowSize, accent);
    const HEAD_RADIUS = await contents.executeJavaScript("FabulaStage.HEAD_RADIUS");
    const SCREEN_RADIUS = await contents.executeJavaScript("FabulaStage.SCREEN_RADIUS");
    if (!fs.existsSync(headMask)) roundedMask(headMask, dims.width, dims.height, HEAD_RADIUS * dims.width);
    if (!fs.existsSync(empty)) { await contents.executeJavaScript("__renderLayer(0, null, 'none')"); await shoot(empty, true); }
    const screenMask = (w, h) => {
      const file = path.join(assets, `mask-screen-${w}x${h}.png`);
      if (!fs.existsSync(file)) roundedMask(file, w, h, SCREEN_RADIUS * w);
      return file;
    };

    let inFlight = 0;
    const waiters = [];
    const slot = () => new Promise((resolve) => { if (inFlight < PARALLEL_ENCODES) { inFlight += 1; resolve(); } else waiters.push(resolve); });
    const release = () => { inFlight -= 1; const next = waiters.shift(); if (next) { inFlight += 1; next(); } };

    for (const [n, chunk] of todo.entries()) {
      const label = `chunk ${n + 1}/${todo.length} (${fmt(chunk.start)}–${fmt(chunk.end)})`;
      const work = path.join(cacheDir, `${chunk.hash}.work`);
      fs.rmSync(work, { recursive: true, force: true });
      fs.mkdirSync(work, { recursive: true });
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
            await shoot(file, true);
          }
          states[layer].push({ at: i / FPS, file });
        }
        const list = ["ffconcat version 1.0"];
        states[layer].forEach((state, k) => {
          const next = states[layer][k + 1];
          const durationSeconds = (next ? next.at : chunk.frames / FPS) - state.at;
          list.push(`file '${state.file}'`, `duration ${durationSeconds.toFixed(4)}`);
        });
        list.push(`file '${states[layer].at(-1).file}'`);
        fs.writeFileSync(path.join(work, `${layer}.txt`), list.join("\n") + "\n");
      }

      // Screen scenes inside this chunk, with the rect the page measured.
      const screenScenes = [];
      for (let i = 0; i < chunk.frames; i += 1) {
        const s = keys[i].screen;
        if (!s) continue;
        const known = screenScenes.find((x) => x.start === s.start && x.end === s.end);
        if (!known) screenScenes.push({ start: s.start, end: s.end, rect: s.rect });
      }
      const screens = hasScreen ? plan.screenPlacements(screenScenes, chunk) : [];
      const captured = states.under.length + states.over.length;
      console.log(`  ${label}: ${captured} states captured in ${((Date.now() - captureStart) / 1000).toFixed(1)}s (under ${states.under.length}, over ${states.over.length}, screens ${screens.length})`);

      const graph = plan.chunkGraph({ chunk, timeline, videoAspect, stage, glowSize, screens });
      const graphFile = path.join(work, "graph.txt");
      fs.writeFileSync(graphFile, graph);
      const D = String(chunk.frames / FPS);
      const seek = chunk.start > 0 ? ["-ss", String(chunk.start)] : [];
      const args = [
        "-loop", "1", "-framerate", String(FPS), "-t", D, "-i", field,
        "-loop", "1", "-framerate", String(FPS), "-t", D, "-i", glow,
        ...seek, "-t", D, "-i", cleanVideo,
        "-loop", "1", "-framerate", String(FPS), "-t", D, "-i", headMask,
        "-f", "concat", "-safe", "0", "-i", path.join(work, "under.txt"),
        "-f", "concat", "-safe", "0", "-i", path.join(work, "over.txt"),
      ];
      for (const screen of screens) {
        args.push(...seek, "-t", D, "-i", screenVideo);
        args.push("-loop", "1", "-framerate", String(FPS), "-t", D, "-i", screenMask(screen.rect.w, screen.rect.h));
      }
      args.push(
        "-filter_complex_threads", "4", "-/filter_complex", graphFile,
        "-map", "[out]", "-r", String(FPS), "-frames:v", String(chunk.frames),
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
        "-an", path.join(work, "chunk.mp4"),
      );

      await slot();
      const encodeStart = Date.now();
      encodes.push(run(args, label).then(() => {
        fs.renameSync(path.join(work, "chunk.mp4"), chunk.cached);
        fs.rmSync(work, { recursive: true, force: true });
        console.log(`  ${label} encoded in ${((Date.now() - encodeStart) / 1000).toFixed(1)}s`);
      }).finally(release));
    }
    await Promise.all(encodes);
    window.destroy();
  }

  // The stitch: every chunk copied in order, the clean cut's audio alongside.
  console.log("stitching");
  const list = ["ffconcat version 1.0", ...chunks.map((chunk) => `file '${chunk.cached}'`)];
  const listFile = path.join(cacheDir, `stitch-${sha1(list.join("\n"))}.txt`);
  fs.writeFileSync(listFile, list.join("\n") + "\n");
  const span = to - from;
  const audioSeek = span < duration - 0.01 ? ["-ss", String(from), "-t", String(span)] : [];
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await run([
    "-f", "concat", "-safe", "0", "-i", listFile,
    ...audioSeek, "-i", cleanVideo,
    "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "copy", "-movflags", "+faststart", "-shortest",
    outPath,
  ], "stitch");
  fs.rmSync(listFile, { force: true });
  console.log(`wrote ${outPath} (${(fs.statSync(outPath).size / 1e6).toFixed(1)} MB) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  app.quit();
}

app.whenReady().then(() =>
  main().catch((error) => {
    console.error(error);
    app.exit(1);
  }),
);
