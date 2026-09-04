"use strict";

// The composited render: clean.mp4 plus the scene overlays, through the same
// overlay runtime the preview uses. The overlays are captured as an alpha PNG
// per *state* (an instant the picture changes), not per frame — a caption
// holds for a word, a title for a phrase — then ffmpeg composites them over
// the untouched video pixels and copies the audio. One re-encode, behind the
// gate. Run by the MCP server's render_final, or by hand:
//
//   npx electron --no-sandbox --no-zygote scripts/export-compose.cjs media/<project>

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const REPO_ROOT = path.join(__dirname, "..");
const FFMPEG = path.join(REPO_ROOT, "tools", "ffmpeg", "ffmpeg");

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
  const { probeDuration, probeDimensions } = await import(pathToFileURL(path.join(REPO_ROOT, "scripts", "pipeline.mjs")).href);

  const cleanVideo = path.join(projectDir, "out", "clean.mp4");
  const transcript = JSON.parse(fs.readFileSync(path.join(projectDir, "clean.json"), "utf8"));
  const composeFile = JSON.parse(fs.readFileSync(path.join(projectDir, "compose.json"), "utf8"));

  const words = flattenWords(transcript);
  const duration = probeDuration(cleanVideo);
  const { width, height } = probeDimensions(cleanVideo);
  const scenes = engine.resolveScenes(composeFile.scenes ?? [], words);
  const captions = composeFile.captions ? engine.resolveCaptions(words) : null;
  const states = engine.renderSchedule(scenes, captions, duration, { fps: 30 });
  console.log(`${states.length} overlay states over ${duration.toFixed(1)}s at ${width}x${height}`);

  const framesDir = path.join(projectDir, "out", "overlay-frames");
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });

  const window = new BrowserWindow({
    show: false,
    width,
    height,
    transparent: true,
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

  await contents.executeJavaScript(
    `__setCompose(${JSON.stringify({ scenes, captions })})`
  );

  const started = Date.now();
  const listLines = ["ffconcat version 1.0"];
  for (let i = 0; i < states.length; i += 1) {
    const name = `state-${String(i).padStart(4, "0")}.png`;
    await contents.executeJavaScript(
      `__renderAt(${states[i].t}); new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`
    );
    const shot = await contents.debugger.sendCommand("Page.captureScreenshot", {
      format: "png",
      omitBackground: true,
    });
    fs.writeFileSync(path.join(framesDir, name), Buffer.from(shot.data, "base64"));
    listLines.push(`file '${name}'`, `duration ${states[i].duration.toFixed(4)}`);
  }
  // The concat demuxer holds the last entry only if it is named again.
  listLines.push(`file 'state-${String(states.length - 1).padStart(4, "0")}.png'`);
  const listPath = path.join(framesDir, "states.ffconcat");
  fs.writeFileSync(listPath, listLines.join("\n") + "\n");
  const captureSeconds = (Date.now() - started) / 1000;
  console.log(`captured ${states.length} states in ${captureSeconds.toFixed(1)}s`);

  const finalPath = path.join(projectDir, "out", "final.mp4");
  const mux = spawnSync(FFMPEG, [
    "-y", "-v", "error",
    "-i", cleanVideo,
    "-safe", "0", "-i", listPath,
    "-filter_complex", "[0:v][1:v]overlay=0:0:eof_action=pass[v]",
    "-map", "[v]", "-map", "0:a",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18",
    "-c:a", "copy",
    finalPath,
  ], { encoding: "utf8" });
  if (mux.status !== 0) {
    console.error((mux.stderr || "").slice(-800));
    throw new Error("ffmpeg composite failed");
  }
  console.log(`wrote ${finalPath} (${(fs.statSync(finalPath).size / 1e6).toFixed(1)} MB)`);
  app.quit();
}

app.whenReady().then(() =>
  main().catch((error) => {
    console.error(error);
    app.exit(1);
  }),
);
