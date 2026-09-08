"use strict";

// One frame of the composed film, as a PNG, without rendering anything.
//
//   electron --no-sandbox --no-zygote scripts/frame.cjs <projectDir> \
//     [--at=12.5 | --word=340] [--out=path.png] [--width=1920]
//
// The same export page the render drives, asked for a single instant: the
// clean cut seeked to t, the head and screen placed by the stage engine, and
// both overlay layers painted. So what comes out is what that frame of the
// film looks like — which is the point. The assistant calls it through the
// preview_frame tool to LOOK at its own composition; a person can call it by
// hand to check a moment before committing to minutes of render.

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const REPO_ROOT = path.join(__dirname, "..");
if (!app.commandLine.hasSwitch("no-zygote")) {
  console.error("run with --no-sandbox --no-zygote");
  app.exit(2);
}
// Nothing here is ever shown. Pass --ozone-platform=headless on the command
// line as well when there may be no reachable display: by the time this file
// runs, Chromium has already chosen its platform.
app.commandLine.appendSwitch("disable-gpu");
if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  app.commandLine.appendSwitch("ozone-platform", "headless");
}

const argv = process.argv.slice(1);
const flag = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const positional = argv.filter((a) => !a.startsWith("--") && !a.endsWith(".cjs"));
const projectDir = path.resolve(REPO_ROOT, positional[0] ?? "media/sample");

async function main() {
  const { flattenWords } = await import(pathToFileURL(path.join(REPO_ROOT, "core", "cut-engine.mjs")).href);
  const engine = await import(pathToFileURL(path.join(REPO_ROOT, "core", "compose-engine.mjs")).href);
  const stageEngine = await import(pathToFileURL(path.join(REPO_ROOT, "core", "stage-engine.mjs")).href);
  const themes = await import(pathToFileURL(path.join(REPO_ROOT, "core", "themes.mjs")).href);
  const formats = await import(pathToFileURL(path.join(REPO_ROOT, "core", "formats.mjs")).href);
  const shotEngine = await import(pathToFileURL(path.join(REPO_ROOT, "core", "shot-engine.mjs")).href);
  const { probeDuration, probeDimensions } = await import(pathToFileURL(path.join(REPO_ROOT, "scripts", "pipeline.mjs")).href);

  const cleanVideo = path.join(projectDir, "out", "clean.mp4");
  const screenVideo = path.join(projectDir, "out", "screen.mp4");
  if (!fs.existsSync(cleanVideo)) throw new Error("no clean cut yet: render_clean first");
  const words = flattenWords(JSON.parse(fs.readFileSync(path.join(projectDir, "clean.json"), "utf8")));
  const config = JSON.parse(fs.readFileSync(path.join(projectDir, "compose.json"), "utf8"));
  const duration = probeDuration(cleanVideo);
  const dims = probeDimensions(cleanVideo);

  // A word id is the anchor everything else in Fabula uses, so it is the
  // anchor here too: the frame lands where that word is spoken, a beat in so
  // an entrance has played rather than caught mid-flight.
  const wordId = flag("word") === undefined ? null : Number(flag("word"));
  const word = wordId === null ? null : words.find((w) => w.id === wordId);
  if (wordId !== null && !word) throw new Error(`no word ${wordId}; the clean transcript has 0–${words.length - 1}`);
  const T = Math.min(Math.max(word ? word.start + 0.35 : Number(flag("at") ?? 0.8), 0), Math.max(duration - 0.05, 0));

  const scenes = engine.resolveScenes(config.scenes ?? [], words);
  for (const scene of scenes) {
    if (scene.graphic?.src) scene.graphic.url = pathToFileURL(path.join(projectDir, scene.graphic.src)).href;
    for (const item of scene.graphic?.items ?? []) if (item.src) item.url = pathToFileURL(path.join(projectDir, item.src)).href;
    if (scene.graphic?.kind === "custom") {
      const base = pathToFileURL(path.join(projectDir, "assets/")).href;
      scene.graphic = { ...scene.graphic, html: scene.graphic.html.replaceAll("assets/", base), css: (scene.graphic.css ?? "").replaceAll("assets/", base) };
    }
  }
  const meta = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(projectDir, "project.json"), "utf8")); } catch { return {}; }
  })();
  const stage = formats.stageOf(meta);
  const theme = themes.resolveTheme(config.theme ?? null);
  if (theme.logo) theme.logoUrl = pathToFileURL(path.join(projectDir, theme.logo.src)).href;
  const map = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(projectDir, "out", "clean-map.json"), "utf8")); } catch { return null; }
  })();
  const compose = {
    videoUrl: pathToFileURL(cleanVideo).href,
    screenUrl: fs.existsSync(screenVideo) ? pathToFileURL(screenVideo).href : null,
    scenes,
    captions: engine.captionsBurnedIn(config.captions) ? engine.resolvePhraseCaptions(words) : null,
    wordSpans: engine.resolveCaptions(words),
    stage,
    theme,
    punchSpans: config.punch && map?.pieces ? shotEngine.punchSpans(map.pieces, config.punch.zoom) : [],
  };
  const timeline = stageEngine.resolveLayoutTimeline(scenes, duration, { transition: theme.transition, transitionSeconds: theme.transitionSeconds });
  const layout = stageEngine.layoutAt(timeline, T, dims.width / dims.height, stage);

  // The still keeps the film's shape: a vertical frame comes back vertical.
  const width = Math.max(Math.min(Number(flag("width") ?? Math.round(1280 * Math.min(stage.width / stage.height, 1))), 1920), 320);
  const height = Math.round(width * stage.height / stage.width);
  const win = new BrowserWindow({
    show: false, width, height, frame: false,
    webPreferences: { offscreen: true, sandbox: true, backgroundThrottling: false },
  });
  await win.loadFile(path.join(REPO_ROOT, "renderer", "export.html"));
  const contents = win.webContents;
  if (!contents.isPainting()) contents.startPainting();
  contents.debugger.attach("1.3");
  await contents.executeJavaScript(`__setCompose(${JSON.stringify(compose)})`);
  await contents.executeJavaScript(`__renderAt(${T}, ${JSON.stringify(layout)})`);
  const shot = await contents.debugger.sendCommand("Page.captureScreenshot", { format: "png" });
  const out = path.resolve(flag("out") ?? path.join(projectDir, "out", "frames", `t-${T.toFixed(2)}.png`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
  const segment = timeline.find((s) => T >= s.start && T < s.end) ?? timeline.at(-1);
  console.log(JSON.stringify({
    file: out, at: Number(T.toFixed(2)), wordId: word?.id ?? null,
    format: formats.resolveFormat(meta).id,
    layout: segment?.layout ?? "focus", headOpacity: Number((layout.alpha ?? 1).toFixed(3)),
    showing: scenes.filter((s) => s.type !== "stage" && s.start <= T && T < s.end)
      .map((s) => (s.type === "graphic" ? `${s.type}:${s.graphic.kind}` : s.type)),
    width, height,
  }));
  app.quit();
}

app.whenReady().then(() => main().catch((error) => { console.error(error.message ?? error); app.exit(1); }));
