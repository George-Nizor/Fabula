"use strict";

// Every template, rendered through the export page in both shapes, tiled
// into two sheets to look at. No project, no media: the head is a block.
//
//   env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron \
//     --no-sandbox --no-zygote --ozone-platform=headless scripts/probe-templates.cjs [--out=dir] [--t=2.5] [--preset=studio]
//
// Writes <out>/<format>-<template>.png for each, and <out>/sheet-landscape.png
// and <out>/sheet-vertical.png. This is how the templates were looked at
// when they were written; run it after touching core/templates.mjs or the
// painter's stylesheet, and look.

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");

const REPO = path.join(__dirname, "..");
const argv = process.argv.slice(1);
const flag = (name, fallback) => { const hit = argv.find((a) => a.startsWith(`--${name}=`)); return hit ? hit.slice(name.length + 3) : fallback; };
const OUT = path.resolve(flag("out", path.join(REPO, "out", "template-probe")));
const T = Number(flag("t", 2.5));
const PRESET = flag("preset", "studio");

app.commandLine.appendSwitch("disable-gpu");
if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) app.commandLine.appendSwitch("ozone-platform", "headless");

async function main() {
  const templates = await import(pathToFileURL(path.join(REPO, "core", "templates.mjs")).href);
  const themes = await import(pathToFileURL(path.join(REPO, "core", "themes.mjs")).href);
  const stageEngine = await import(pathToFileURL(path.join(REPO, "core", "stage-engine.mjs")).href);
  const formats = await import(pathToFileURL(path.join(REPO, "core", "formats.mjs")).href);
  const { FFMPEG } = await import(pathToFileURL(path.join(REPO, "scripts", "pipeline.mjs")).href);
  const theme = themes.resolveTheme({ preset: PRESET });
  fs.mkdirSync(OUT, { recursive: true });
  const wins = {};
  for (const format of formats.FORMAT_IDS) {
    const stage = formats.FORMATS[format].stage;
    const win = new BrowserWindow({ show: false, width: stage.width / 2, height: stage.height / 2, frame: false, webPreferences: { offscreen: true, sandbox: true, backgroundThrottling: false } });
    await win.loadFile(path.join(REPO, "renderer", "export.html"));
    const c = win.webContents;
    if (!c.isPainting()) c.startPainting();
    c.debugger.attach("1.3");
    await c.executeJavaScript(`const v = document.getElementById("head-video"); v.style.background = "#5a6b7a"; v.style.display = "block"; true`);
    wins[format] = { win, stage };
  }
  const files = {};
  for (const format of formats.FORMAT_IDS) {
    files[format] = [];
    const { win, stage } = wins[format];
    for (const id of templates.TEMPLATE_IDS) {
      const graphic = templates.renderTemplate(id, templates.TEMPLATES[id].example, { format });
      const layoutName = graphic.full ? "cutaway" : "side";
      const scenes = [
        { type: "stage", layout: layoutName, start: 0, end: 10, fromWordId: 0, toWordId: 1 },
        { type: "graphic", graphic, start: 0, end: 10, fromWordId: 0, toWordId: 1 },
      ];
      const timeline = stageEngine.resolveLayoutTimeline(scenes, 10, { transition: theme.transition });
      const layout = stageEngine.layoutAt(timeline, T, 16 / 9, stage);
      const compose = { scenes, captions: null, wordSpans: [], stage, theme, punchSpans: [] };
      const c = win.webContents;
      await c.executeJavaScript(`__setCompose(${JSON.stringify(compose)}, { media: false })`);
      await c.executeJavaScript(`(() => { const frame = document.getElementById("frame"); frame.classList.remove("is-layer"); frame.classList.add("stage-field"); const head = document.getElementById("head"); head.hidden = false; window.FabulaStage.update(document.getElementById("stage"), head, ${JSON.stringify(compose)}, ${T}, ${JSON.stringify(layout)}, null); return true; })()`);
      await new Promise((r) => setTimeout(r, 120));
      const shot = await c.debugger.sendCommand("Page.captureScreenshot", { format: "png" });
      const file = path.join(OUT, `${format}-${id}.png`);
      fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
      files[format].push(file);
    }
    const list = path.join(OUT, `${format}.txt`);
    fs.writeFileSync(list, `ffconcat version 1.0\n${files[format].map((f) => `file '${f}'\nduration 1`).join("\n")}\n`);
    const tall = stage.height > stage.width;
    const cols = tall ? 8 : 4;
    const rows = Math.ceil(files[format].length / cols);
    execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list,
      "-vf", `scale=${tall ? 270 : 640}:-2,tile=${cols}x${rows}:padding=4:color=0x0b0e12`, "-frames:v", "1", path.join(OUT, `sheet-${format}.png`)]);
    fs.rmSync(list, { force: true });
  }
  for (const { win } of Object.values(wins)) win.destroy();
  console.log(JSON.stringify({ out: OUT, templates: templates.TEMPLATE_IDS.length, sheets: formats.FORMAT_IDS.map((f) => path.join(OUT, `sheet-${f}.png`)) }));
  app.exit(0);
}

app.on("window-all-closed", () => {});
app.whenReady().then(() => main().catch((error) => { console.error(error.stack ?? error); app.exit(1); }));
