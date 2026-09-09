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
  const templates = await import(pathToFileURL(path.join(REPO_ROOT, "core", "templates.mjs")).href);
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
  const clampT = (t) => Math.min(Math.max(t, 0), Math.max(duration - 0.05, 0));
  const wordAt = (id) => {
    const word = words.find((w) => w.id === id);
    if (!word) throw new Error(`no word ${id}; the clean transcript has 0–${words.length - 1}`);
    return word;
  };
  // One instant, or several. --word and --at take a comma list; --every=N
  // walks the film at that interval. Several frames become one sheet
  // (--sheet, tiled --columns wide) so the rhythm of a whole film can be
  // looked at in one picture.
  const many = flag("every") !== undefined || String(flag("word") ?? flag("at") ?? "").includes(",");
  let instants;
  if (flag("every") !== undefined) {
    const every = Math.max(Number(flag("every")), 1);
    instants = [];
    // The walk stops short of the last half second: the final frames of a
    // clean cut decode black on some seeks, and a black tile says nothing.
    for (let t = Math.min(0.8, duration); t < duration - 0.5; t += every) instants.push({ t: clampT(t), wordId: null });
    if (instants.length === 0) instants.push({ t: clampT(Math.min(0.8, duration / 2)), wordId: null }); // a film shorter than a breath: one tile
    if (instants.length > 48) instants = instants.filter((_, i) => i % Math.ceil(instants.length / 48) === 0);
  } else if (flag("word") !== undefined) {
    instants = String(flag("word")).split(",").map((s) => wordAt(Number(s))).map((word) => ({ t: clampT(word.start + 0.35), wordId: word.id }));
  } else {
    instants = String(flag("at") ?? "0.8").split(",").map((s) => ({ t: clampT(Number(s)), wordId: null }));
  }
  const T = instants[0].t;
  const word = instants[0].wordId === null ? null : wordAt(instants[0].wordId);

  const meta = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(projectDir, "project.json"), "utf8")); } catch { return {}; }
  })();
  const scenes = engine.resolveScenes(templates.refreshTemplates(config.scenes ?? [], { format: formats.resolveFormat(meta).id }), words);
  for (const scene of scenes) {
    if (scene.graphic?.src) scene.graphic.url = pathToFileURL(path.join(projectDir, scene.graphic.src)).href;
    for (const item of scene.graphic?.items ?? []) if (item.src) item.url = pathToFileURL(path.join(projectDir, item.src)).href;
    if (scene.graphic?.kind === "custom") {
      const base = pathToFileURL(path.join(projectDir, "assets/")).href;
      scene.graphic = { ...scene.graphic, html: scene.graphic.html.replaceAll("assets/", base), css: (scene.graphic.css ?? "").replaceAll("assets/", base) };
    }
  }
  const stage = formats.stageOf(meta);
  const theme = themes.resolveTheme(config.theme ?? null);
  if (theme.logo) theme.logoUrl = pathToFileURL(path.join(projectDir, theme.logo.src)).href;
  const map = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(projectDir, "out", "clean-map.json"), "utf8")); } catch { return null; }
  })();
  const compose = {
    videoUrl: pathToFileURL(cleanVideo).href,
    screenUrl: fs.existsSync(screenVideo) ? pathToFileURL(screenVideo).href : null,
    duration,
    scenes,
    captions: engine.captionsBurnedIn(config.captions) ? engine.resolvePhraseCaptions(words, { emphasis: config.captionEmphasis }) : null,
    wordSpans: engine.resolveCaptions(words),
    stage,
    theme,
    punchSpans: config.punch && map?.pieces ? shotEngine.punchSpans(map.pieces, config.punch.zoom) : [],
  };
  const timeline = stageEngine.resolveLayoutTimeline(scenes, duration, { transition: theme.transition, transitionSeconds: theme.transitionSeconds });
  const layoutOf = (t) => stageEngine.layoutAt(timeline, t, dims.width / dims.height, stage);
  const layout = layoutOf(T);

  // The still keeps the film's shape: a vertical frame comes back vertical.
  // A sheet's tiles are smaller, because the point of a sheet is the rhythm
  // rather than the legibility of any one card.
  const defaultWidth = many ? 640 : Math.round(1280 * Math.min(stage.width / stage.height, 1));
  const width = Math.max(Math.min(Number(flag("width") ?? defaultWidth), 1920), 320);
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
  const describe = (t, wordId, lay) => {
    const segment = timeline.find((s) => t >= s.start && t < s.end) ?? timeline.at(-1);
    return {
      at: Number(t.toFixed(2)), wordId,
      layout: segment?.layout ?? "focus", headOpacity: Number((lay.alpha ?? 1).toFixed(3)),
      showing: scenes.filter((s) => s.type !== "stage" && s.start <= t && t < s.end)
        .map((s) => (s.type === "graphic" ? `${s.type}:${s.graphic.template ?? s.graphic.kind}` : s.type)),
    };
  };
  const framesDir = path.join(projectDir, "out", "frames");
  fs.mkdirSync(framesDir, { recursive: true });

  if (!many) {
    // A thumbnail is the face and the words: the head at focus whatever the
    // plan says for that instant, and no cards, titles or captions under the
    // line. The film's field and look stay.
    const thumbLayout = flag("thumb")
      ? stageEngine.layoutAt(stageEngine.resolveLayoutTimeline([], duration), T, dims.width / dims.height, stage)
      : layout;
    await contents.executeJavaScript(`__renderAt(${T}, ${JSON.stringify(thumbLayout)})`);
    // A thumbnail: the frame as composed, the captions taken off (a caption
    // in a thumbnail is noise), and a template's words laid over everything
    // — above the head, which is where a thumbnail's words go — with its
    // entrance already played.
    if (flag("thumb")) {
      const spec = JSON.parse(fs.readFileSync(flag("thumb"), "utf8"));
      const graphic = templates.renderTemplate(spec.template ?? "thumbnail", spec.params ?? {}, { format: formats.resolveFormat(meta).id });
      await contents.executeJavaScript(`(() => {
        for (const node of document.getElementById("stage").querySelectorAll(".ov-caption, .ov-graphic, .ov-title, .ov-callout, .ov-kinetic")) node.remove();
        const card = document.createElement("div");
        card.className = "ov-graphic kind-custom is-full";
        // The painter positions every part inline; a static card has no
        // stacking of its own and the head (z-index 3) paints over it.
        card.style.position = "absolute"; card.style.inset = "0"; card.style.zIndex = "6";
        const style = document.createElement("style");
        style.textContent = "@scope (.ov-custom-thumb) { " + ${JSON.stringify(graphic.css)} + " }";
        const root = document.createElement("div");
        root.className = "ov-custom-root ov-custom-thumb";
        root.innerHTML = ${JSON.stringify(graphic.html)};
        root.style.setProperty("--p", "1"); root.style.setProperty("--q", "1"); root.style.setProperty("--alpha", "1");
        card.append(style, root);
        document.getElementById("stage").append(card);
        return true;
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    const shot = await contents.debugger.sendCommand("Page.captureScreenshot", { format: "png" });
    const out = path.resolve(flag("out") ?? path.join(framesDir, `t-${T.toFixed(2)}.png`));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
    console.log(JSON.stringify({ file: out, ...describe(T, word?.id ?? null, thumbLayout), format: formats.resolveFormat(meta).id, width, height }));
    app.quit();
    return;
  }

  // The sheet: every instant captured in turn, then tiled left to right,
  // top to bottom, in time order. The JSON says what each tile holds.
  const { FFMPEG } = await import(pathToFileURL(path.join(REPO_ROOT, "scripts", "pipeline.mjs")).href);
  const { execFileSync } = require("node:child_process");
  const tiles = [];
  for (const [i, instant] of instants.entries()) {
    const lay = layoutOf(instant.t);
    await contents.executeJavaScript(`__renderAt(${instant.t}, ${JSON.stringify(lay)})`);
    const shot = await contents.debugger.sendCommand("Page.captureScreenshot", { format: "png" });
    const file = path.join(framesDir, `sheet-${String(i).padStart(2, "0")}-${instant.t.toFixed(2)}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
    tiles.push({ index: i, file, ...describe(instant.t, instant.wordId, lay) });
  }
  const columns = Math.max(1, Math.min(Number(flag("columns") ?? (stage.width > stage.height ? 4 : 6)), tiles.length));
  const rows = Math.ceil(tiles.length / columns);
  const list = path.join(framesDir, "sheet.txt");
  fs.writeFileSync(list, ["ffconcat version 1.0", ...tiles.map((tile) => `file '${tile.file}'\nduration 1`)].join("\n") + "\n");
  const out = path.resolve(flag("sheet") ?? flag("out") ?? path.join(framesDir, `sheet-${instants[0].t.toFixed(1)}-${instants.at(-1).t.toFixed(1)}.png`));
  execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list,
    "-vf", `tile=${columns}x${rows}:padding=4:color=0x0b0e12`, "-frames:v", "1", out], { stdio: ["ignore", "ignore", "inherit"] });
  for (const tile of tiles) fs.rmSync(tile.file, { force: true });
  fs.rmSync(list, { force: true });
  console.log(JSON.stringify({
    file: out, format: formats.resolveFormat(meta).id, columns, rows, tileWidth: width, tileHeight: height,
    tiles: tiles.map(({ file, ...rest }) => rest),
  }));
  app.quit();
}

app.whenReady().then(() => main().catch((error) => { console.error(error.message ?? error); app.exit(1); }));
