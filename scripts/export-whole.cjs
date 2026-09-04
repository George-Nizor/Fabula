"use strict";

// The composited render: the 1080p stage — charcoal field, the talking head
// and the screen track as layers, the scene overlays — captured frame by
// frame through the same runtime and the same stage engine the preview uses,
// streamed straight into ffmpeg and muxed with the clean cut's untouched
// audio. One re-encode, behind the gate. Run by the MCP server's
// render_final, or by hand:
//
//   npx electron --no-sandbox --no-zygote scripts/export-compose.cjs [--from=s] [--to=s] [--out=file] [--png] media/<project>

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const REPO_ROOT = path.join(__dirname, "..");
const FFMPEG = path.join(REPO_ROOT, "tools", "ffmpeg", "ffmpeg");
const FPS = 30;

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
const usePng = argv.includes("--png");

async function main() {
  const { flattenWords } = await import(pathToFileURL(path.join(REPO_ROOT, "core", "cut-engine.mjs")).href);
  const engine = await import(pathToFileURL(path.join(REPO_ROOT, "core", "compose-engine.mjs")).href);
  const stageEngine = await import(pathToFileURL(path.join(REPO_ROOT, "core", "stage-engine.mjs")).href);
  const { probeDuration, probeDimensions } = await import(pathToFileURL(path.join(REPO_ROOT, "scripts", "pipeline.mjs")).href);

  const cleanVideo = path.join(projectDir, "out", "clean.mp4");
  const screenVideo = path.join(projectDir, "out", "screen.mp4");
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
  const compose = {
    videoUrl: pathToFileURL(cleanVideo).href,
    screenUrl: fs.existsSync(screenVideo) ? pathToFileURL(screenVideo).href : null,
    scenes,
    captions: composeFile.captions ? engine.resolvePhraseCaptions(words) : null,
    wordSpans: engine.resolveCaptions(words),
    stage,
    theme: composeFile.theme ?? null,
  };
  const timeline = stageEngine.resolveLayoutTimeline(scenes, duration);

  const from = Math.max(Number(flag("from") ?? 0), 0);
  const to = Math.min(Number(flag("to") ?? duration), duration);
  const outPath = flag("out") ?? path.join(projectDir, "out", "final.mp4");
  const span = Math.max(to - from, 0);
  const frameCount = Math.ceil(span * FPS);
  console.log(`${frameCount} frames over ${fmt(from)}–${fmt(to)} of ${fmt(duration)} on a ${stage.width}x${stage.height} stage${compose.screenUrl ? " with a screen track" : ""}`);

  const window = new BrowserWindow({
    show: false,
    width: stage.width,
    height: stage.height,
    frame: false,
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

  await contents.executeJavaScript(`__setCompose(${JSON.stringify(compose)})`);

  // Frames stream into ffmpeg as they are captured: no frame files, no
  // second pass. JPEG at 93 keeps text edges intact at a fraction of PNG's
  // encode cost; --png is there for a lossless comparison.
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const audioArgs = span < duration - 0.01 ? ["-ss", String(from), "-t", String(span)] : [];
  const mux = spawn(FFMPEG, [
    "-y", "-v", "error",
    "-f", "image2pipe", "-framerate", String(FPS), "-i", "pipe:0",
    ...audioArgs, "-i", cleanVideo,
    "-map", "0:v", "-map", "1:a",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "copy",
    "-shortest",
    outPath,
  ], { stdio: ["pipe", "ignore", "pipe"] });
  let muxError = "";
  mux.stderr.on("data", (chunk) => { muxError += chunk; });
  const muxDone = new Promise((resolve, reject) => {
    mux.once("error", reject);
    mux.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg mux failed (${code}): ${muxError.slice(-600)}`))));
  });
  const write = (buffer) => new Promise((resolve, reject) => {
    if (mux.exitCode !== null) { reject(new Error(`ffmpeg exited early: ${muxError.slice(-600)}`)); return; }
    if (mux.stdin.write(buffer)) resolve();
    else mux.stdin.once("drain", resolve);
  });

  const started = Date.now();
  for (let i = 0; i < frameCount; i += 1) {
    const t = Math.min(from + i / FPS, Math.max(duration - 0.001, 0));
    const layout = stageEngine.layoutAt(timeline, t, videoAspect, stage);
    await contents.executeJavaScript(`__renderAt(${t}, ${JSON.stringify(layout)})`);
    const shot = await contents.debugger.sendCommand("Page.captureScreenshot",
      usePng ? { format: "png" } : { format: "jpeg", quality: 93 });
    await write(Buffer.from(shot.data, "base64"));
    if (i > 0 && i % 300 === 0) {
      const rate = i / ((Date.now() - started) / 1000);
      console.log(`  ${i}/${frameCount} frames (${rate.toFixed(1)} fps capture)`);
    }
  }
  const captureSeconds = (Date.now() - started) / 1000;
  console.log(`captured ${frameCount} frames in ${captureSeconds.toFixed(1)}s (${(frameCount / captureSeconds).toFixed(1)} fps)`);
  console.log("muxing");
  mux.stdin.end();
  await muxDone;
  console.log(`wrote ${outPath} (${(fs.statSync(outPath).size / 1e6).toFixed(1)} MB)`);
  app.quit();
}

function fmt(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

app.whenReady().then(() =>
  main().catch((error) => {
    console.error(error);
    app.exit(1);
  }),
);
