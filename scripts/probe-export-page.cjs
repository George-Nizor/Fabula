"use strict";
// One-frame probe of the export page: renders t, dumps the overlay DOM, and
// saves a screenshot. Diagnostic only.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const REPO_ROOT = path.join(__dirname, "..");
if (!app.commandLine.hasSwitch("no-zygote")) {
  console.error("run with --no-sandbox --no-zygote");
  app.exit(2);
}
app.commandLine.appendSwitch("disable-gpu");
if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  app.commandLine.appendSwitch("ozone-platform", "headless");
}

// argv still carries electron's switches and the script path itself.
const args = process.argv.slice(2).filter((a) => !a.startsWith("--") && !a.endsWith(".cjs"));
const projectDir = path.resolve(REPO_ROOT, args[0] ?? "media/sample");
const T = Number(args[1] ?? "0.8");

async function main() {
  const { flattenWords } = await import(pathToFileURL(path.join(REPO_ROOT, "core", "cut-engine.mjs")).href);
  const engine = await import(pathToFileURL(path.join(REPO_ROOT, "core", "compose-engine.mjs")).href);
  const stageEngine = await import(pathToFileURL(path.join(REPO_ROOT, "core", "stage-engine.mjs")).href);
  const { probeDuration, probeDimensions } = await import(pathToFileURL(path.join(REPO_ROOT, "scripts", "pipeline.mjs")).href);

  const cleanVideo = path.join(projectDir, "out", "clean.mp4");
  const words = flattenWords(JSON.parse(fs.readFileSync(path.join(projectDir, "clean.json"), "utf8")));
  const cfg = JSON.parse(fs.readFileSync(path.join(projectDir, "compose.json"), "utf8"));
  const dims = probeDimensions(cleanVideo);
  const scenes = engine.resolveScenes(cfg.scenes ?? [], words);
  for (const s of scenes) if (s.graphic?.src) s.graphic.url = pathToFileURL(path.join(projectDir, s.graphic.src)).href;
  const compose = {
    videoUrl: pathToFileURL(cleanVideo).href,
    scenes,
    captions: cfg.captions ? engine.resolveCaptions(words) : null,
    stage: stageEngine.DEFAULT_STAGE,
    theme: cfg.theme ?? null,
  };
  const timeline = stageEngine.resolveLayoutTimeline(scenes, probeDuration(cleanVideo));
  const layout = stageEngine.layoutAt(timeline, T, dims.width / dims.height, stageEngine.DEFAULT_STAGE);

  const win = new BrowserWindow({
    show: false, width: 1920, height: 1080, frame: false,
    webPreferences: { offscreen: true, sandbox: true, backgroundThrottling: false },
  });
  await win.loadFile(path.join(REPO_ROOT, "renderer", "export.html"));
  const c = win.webContents;
  if (!c.isPainting()) c.startPainting();
  c.debugger.attach("1.3");
  c.on("console-message", (_e, _l, msg) => console.log("[page]", msg));
  await c.executeJavaScript(`__setCompose(${JSON.stringify(compose)})`);
  await c.executeJavaScript(`__renderAt(${T}, ${JSON.stringify(layout)})`);
  const dump = await c.executeJavaScript(`({
    state: document.getElementById('stage').dataset.state,
    html: document.getElementById('stage').innerHTML.slice(0, 1200),
  })`);
  console.log("state:", dump.state);
  console.log("html:", dump.html);
  const shot = await c.debugger.sendCommand("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(REPO_ROOT, "probe-frame.png"), Buffer.from(shot.data, "base64"));
  console.log("wrote probe-frame.png");
  app.quit();
}

app.whenReady().then(() => main().catch((e) => { console.error(e); app.exit(1); }));
