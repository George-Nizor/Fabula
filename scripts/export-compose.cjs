"use strict";

// The composited render: the 1080p stage — charcoal field, the talking head
// as an animated layer, the scene overlays — captured frame by frame through
// the same runtime and the same stage engine the preview uses, then muxed
// with the clean cut's untouched audio. One re-encode, behind the gate.
// Run by the MCP server's render_final, or by hand:
//
//   npx electron --no-sandbox --no-zygote scripts/export-compose.cjs media/<project>

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
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

// Electron leaves its own switches in argv; the project dir is the one
// argument that is not a flag.
const dirArg = process.argv.slice(2).filter((arg) => !arg.startsWith("--")).pop();
const projectDir = path.resolve(REPO_ROOT, dirArg ?? "");

async function main() {
  const { flattenWords } = await import(pathToFileURL(path.join(REPO_ROOT, "core", "cut-engine.mjs")).href);
  const engine = await import(pathToFileURL(path.join(REPO_ROOT, "core", "compose-engine.mjs")).href);
  const stageEngine = await import(pathToFileURL(path.join(REPO_ROOT, "core", "stage-engine.mjs")).href);
  const { probeDuration, probeDimensions } = await import(pathToFileURL(path.join(REPO_ROOT, "scripts", "pipeline.mjs")).href);

  const cleanVideo = path.join(projectDir, "out", "clean.mp4");
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
    scenes,
    captions: composeFile.captions ? engine.resolveCaptions(words) : null,
    stage,
    theme: composeFile.theme ?? null,
  };
  const timeline = stageEngine.resolveLayoutTimeline(scenes, duration);
  const frameCount = Math.ceil(duration * FPS);
  console.log(`${frameCount} frames over ${duration.toFixed(1)}s on a ${stage.width}x${stage.height} stage`);

  const framesDir = path.join(projectDir, "out", "stage-frames");
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });

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

  const started = Date.now();
  for (let i = 0; i < frameCount; i += 1) {
    const t = Math.min(i / FPS, Math.max(duration - 0.001, 0));
    const layout = stageEngine.layoutAt(timeline, t, videoAspect, stage);
    await contents.executeJavaScript(`__renderAt(${t}, ${JSON.stringify(layout)})`);
    const shot = await contents.debugger.sendCommand("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(
      path.join(framesDir, `frame-${String(i).padStart(5, "0")}.png`),
      Buffer.from(shot.data, "base64")
    );
    if (i > 0 && i % 300 === 0) {
      const rate = i / ((Date.now() - started) / 1000);
      console.log(`  ${i}/${frameCount} frames (${rate.toFixed(1)} fps capture)`);
    }
  }
  const captureSeconds = (Date.now() - started) / 1000;
  console.log(`captured ${frameCount} frames in ${captureSeconds.toFixed(1)}s (${(frameCount / captureSeconds).toFixed(1)} fps)`);

  const finalPath = path.join(projectDir, "out", "final.mp4");
  const mux = spawnSync(FFMPEG, [
    "-y", "-v", "error",
    "-framerate", String(FPS),
    "-i", path.join(framesDir, "frame-%05d.png"),
    "-i", cleanVideo,
    "-map", "0:v", "-map", "1:a",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "copy",
    "-shortest",
    finalPath,
  ], { encoding: "utf8" });
  if (mux.status !== 0) {
    console.error((mux.stderr || "").slice(-800));
    throw new Error("ffmpeg mux failed");
  }
  fs.rmSync(framesDir, { recursive: true, force: true });
  console.log(`wrote ${finalPath} (${(fs.statSync(finalPath).size / 1e6).toFixed(1)} MB)`);
  app.quit();
}

app.whenReady().then(() =>
  main().catch((error) => {
    console.error(error);
    app.exit(1);
  }),
);
