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

const { app, BrowserWindow, protocol } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");

const REPO_ROOT = path.join(__dirname, "..");
// Motion scenes draw in sandboxed frames that load only over this scheme.
const motionProtocol = require(path.join(REPO_ROOT, "electron", "motion-protocol.cjs"));
motionProtocol.registerMotionScheme(protocol);
// Every page here may host a motion frame: sealed off the network (motion-protocol.cjs).
app.on("web-contents-created", (_event, contents) => motionProtocol.sealMotionFrames(contents));
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

// One motion document on its own: --motion=motion/<name>.html draws it over
// the film's field at --frames instants across --seconds, under --layout
// (cutaway by default; pip, full or side put a hatched block where the head
// would be, so the scene can be judged against the room it leaves), tiled
// into one sheet. No clean cut needed — this is how the assistant sees a
// scene it has just written, before it places one.
async function motionSheet() {
  const stageEngine = await import(pathToFileURL(path.join(REPO_ROOT, "core", "stage-engine.mjs")).href);
  const themes = await import(pathToFileURL(path.join(REPO_ROOT, "core", "themes.mjs")).href);
  const formats = await import(pathToFileURL(path.join(REPO_ROOT, "core", "formats.mjs")).href);
  const projectState = await import(pathToFileURL(path.join(REPO_ROOT, "scripts", "project-state.mjs")).href);
  const { FFMPEG, probeDimensions } = await import(pathToFileURL(path.join(REPO_ROOT, "scripts", "pipeline.mjs")).href);
  const { execFileSync } = require("node:child_process");
  const src = flag("motion");
  if (!/^motion\/[a-z0-9][a-z0-9-]*\.html$/.test(src) || !fs.existsSync(path.join(projectDir, src))) throw new Error(`no motion document ${src} in the project`);
  const meta = (() => { try { return JSON.parse(fs.readFileSync(path.join(projectDir, "project.json"), "utf8")); } catch { return {}; } })();
  const config = (() => { try { return JSON.parse(fs.readFileSync(path.join(projectDir, "compose.json"), "utf8")); } catch { return {}; } })();
  const stage = formats.stageOf(meta);
  const theme = themes.resolveTheme(config.theme ?? null);
  const clean = path.join(projectDir, "out", "clean.mp4");
  const aspect = (() => { try { const d = probeDimensions(clean); return d.width / d.height; } catch { return 16 / 9; } })();
  const seconds = Math.min(Math.max(Number(flag("seconds") ?? 6), 0.5), 120);
  const count = Math.min(Math.max(Number(flag("frames") ?? 6), 1), 24);
  const layoutName = flag("layout") ?? "cutaway";
  if (!stageEngine.LAYOUTS.has(layoutName)) throw new Error(`layout is one of ${[...stageEngine.LAYOUTS].join(", ")}`);
  const params = flag("params") ? JSON.parse(flag("params")) : {};
  const full = flag("full") !== "false";
  // Drawn the way the film plays it: the placement's seed, fade and over.
  const seed = Number(flag("seed"));
  const graphic = {
    kind: "motion", src, params, full,
    ...(flag("libs") ? { libs: flag("libs").split(",").filter(Boolean) } : {}),
    ...(Number.isInteger(seed) ? { seed } : {}),
    ...(flag("fade") === "false" ? { fade: false } : {}),
    ...(flag("over") === "true" ? { over: true } : {}),
    // The check pass: the frame measures its own text after every draw.
    ...(flag("check") === "false" ? {} : { check: true }),
  };
  const scenes = [{ type: "graphic", start: 0, end: seconds, graphic }];
  projectState.attachSceneMedia(projectDir, scenes, (rel) => pathToFileURL(path.join(projectDir, rel)).href);
  const timeline = stageEngine.resolveLayoutTimeline([{ type: "stage", layout: layoutName, corner: flag("corner"), start: 0, end: seconds }], seconds, { transition: "cut" });
  // Placed in the film (--start, its first second there): the words spoken
  // over it, moved onto the sheet's own clock, so fabula.word() lands where
  // it will in the film.
  let wordSpans = [];
  const start = Number(flag("start"));
  if (Number.isFinite(start) && fs.existsSync(path.join(projectDir, "clean.json"))) {
    const { flattenWords } = await import(pathToFileURL(path.join(REPO_ROOT, "core", "cut-engine.mjs")).href);
    const engine = await import(pathToFileURL(path.join(REPO_ROOT, "core", "compose-engine.mjs")).href);
    const words = flattenWords(JSON.parse(fs.readFileSync(path.join(projectDir, "clean.json"), "utf8")));
    wordSpans = engine.resolveCaptions(words)
      .map((span) => ({ ...span, start: span.start - start, end: span.end - start }))
      .filter((span) => span.start >= -0.05 && span.start < seconds);
  }
  const compose = { duration: seconds, scenes, captions: null, wordSpans, stage, logicalStage: stage, theme, punchSpans: [] };
  motionProtocol.handleMotionProtocol(protocol, { projectDir: () => projectDir });
  const width = Math.max(Math.min(Number(flag("width") ?? (count > 1 ? 640 : 1280)), 1920), 320);
  const height = Math.round(width * stage.height / stage.width);
  const win = new BrowserWindow({ show: false, width, height, frame: false, webPreferences: { offscreen: true, sandbox: true, backgroundThrottling: false } });
  await win.loadFile(path.join(REPO_ROOT, "renderer", "export.html"));
  const contents = win.webContents;
  if (!contents.isPainting()) contents.startPainting();
  contents.debugger.attach("1.3");
  await contents.executeJavaScript(`__setCompose(${JSON.stringify(compose)}, { media: false })`);
  const framesDir = path.join(projectDir, "out", "frames");
  fs.mkdirSync(framesDir, { recursive: true });
  // Each call draws in a folder of its own. The assistant runs previews in
  // parallel, and tiles under fixed names handed one call's frames to
  // another — the orbit's sheet came back holding thrust.
  const work = fs.mkdtempSync(path.join(framesDir, ".motion-"));
  const instants = count === 1 ? [Number(flag("at") ?? seconds / 2)] : Array.from({ length: count }, (_, i) => Number(((seconds - 0.1) * (i + 0.5) / count).toFixed(2)));
  const tiles = [];
  let out = null;
  // The check pass samples the scene far more densely than the sheet shows
  // it — every fifth of a second, drawn but not photographed — because the
  // faults it looks for (type crossing the edge mid-move, two lines passing
  // through each other) live between the tiles.
  const CHECK_STEP = 0.2;
  if (graphic.check) {
    const samples = Math.min(Math.ceil(seconds / CHECK_STEP), 300);
    for (let i = 0; i < samples; i += 1) {
      const t = Number(Math.min(i * CHECK_STEP + 0.05, seconds - 0.05).toFixed(3));
      const layout = stageEngine.layoutAt(timeline, t, aspect, stage);
      await contents.executeJavaScript(`__renderScene(${t}, ${JSON.stringify(layout)}, { headBlock: true })`);
    }
  }
  try {
    for (const [i, t] of instants.entries()) {
      const layout = stageEngine.layoutAt(timeline, t, aspect, stage);
      await contents.executeJavaScript(`__renderScene(${t}, ${JSON.stringify(layout)}, { headBlock: true })`);
      const shot = await contents.debugger.sendCommand("Page.captureScreenshot", { format: "png" });
      const file = path.join(work, `tile-${String(i).padStart(2, "0")}.png`);
      fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
      tiles.push({ index: i, file, at: t });
    }
    // The sheet is named for what was asked: two placements of one document
    // drawn at once do not overwrite each other, and the same request asked
    // twice lands on the same file. Written beside the tiles, then moved.
    const name = path.basename(src, ".html");
    const request = crypto.createHash("sha1").update(JSON.stringify({ stamp: scenes[0].graphic.stamp ?? "", graphic, layoutName, corner: flag("corner") ?? null, seconds, instants, start: flag("start") ?? null, width, stage })).digest("hex").slice(0, 10);
    out = path.resolve(flag("out") ?? path.join(framesDir, `motion-${name}-${request}.png`));
    const sheet = path.join(work, "sheet.png");
    if (tiles.length === 1) fs.renameSync(tiles[0].file, sheet);
    else {
      const columns = Math.min(Number(flag("columns") ?? (stage.width > stage.height ? 3 : 6)), tiles.length);
      const rows = Math.ceil(tiles.length / columns);
      const list = path.join(work, "sheet.txt");
      fs.writeFileSync(list, ["ffconcat version 1.0", ...tiles.map((tile) => `file '${tile.file}'\nduration 1`)].join("\n") + "\n");
      execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list,
        "-vf", `tile=${columns}x${rows}:padding=4:color=0x0b0e12`, "-frames:v", "1", sheet], { stdio: ["ignore", "ignore", "inherit"] });
    }
    fs.renameSync(sheet, out);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  // Sheets pile up over a session of looking; the newest forty stay.
  const sheets = fs.readdirSync(framesDir).filter((entry) => /^motion-.+\.png$/.test(entry)).map((entry) => ({ entry, at: fs.statSync(path.join(framesDir, entry)).mtimeMs })).sort((a, b) => b.at - a.at);
  for (const { entry } of sheets.slice(40)) fs.rmSync(path.join(framesDir, entry), { force: true });
  const errors = await contents.executeJavaScript("__motionErrors()");
  const checks = graphic.check ? summariseChecks((await contents.executeJavaScript("__motionChecks()"))?.[src] ?? [], CHECK_STEP, seconds) : undefined;
  console.log(JSON.stringify({ file: out, src, layout: layoutName, seconds, tiles: tiles.map(({ file, ...rest }) => rest), errors: errors?.[src] ?? [], ...(checks ? { checks } : {}) }));
  app.quit();
}

// The check pass's frames, as findings with the seconds they hold for. A
// fault seen at one sample and gone at the next is an entrance passing
// through, worth knowing but not worth a rewrite: it is marked brief.
function summariseChecks(frames, step, seconds) {
  const ORDER = { "off-frame": 0, overlap: 1, unsafe: 2, small: 3 };
  const seen = new Map();
  for (const { t, findings } of [...frames].sort((a, b) => a.t - b.t)) {
    for (const finding of findings) {
      const key = `${finding.kind}|${finding.what}`;
      const spans = seen.get(key) ?? [];
      const last = spans.at(-1);
      if (last && t - last.to <= step * 1.6) last.to = t;
      else spans.push({ from: t, to: t });
      seen.set(key, spans);
    }
  }
  const out = [];
  for (const [key, spans] of seen) {
    const [kind, what] = key.split(/\|(.*)/s);
    for (const span of spans) {
      const seconds = span.to - span.from + step;
      out.push({ kind, what, at: `${span.from.toFixed(1)}–${Math.min(span.to + step, seconds).toFixed(1)} s`, ...(seconds < 0.45 ? { brief: true } : {}) });
    }
  }
  return out.sort((a, b) => (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9) || Boolean(a.brief) - Boolean(b.brief) || parseFloat(a.at) - parseFloat(b.at)).slice(0, 30);
}

async function main() {
  if (flag("motion") !== undefined) return motionSheet();
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
  // The word being said at t (the last one begun), so a tile names its moment.
  const wordIdAt = (t) => { let id = null; for (const word of words) { if (word.start <= t) id = word.id; else break; } return id; };
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
    for (let t = Math.min(0.8, duration); t < duration - 0.5; t += every) instants.push({ t: clampT(t), wordId: wordIdAt(t) });
    if (instants.length === 0) instants.push({ t: clampT(Math.min(0.8, duration / 2)), wordId: wordIdAt(0.8) }); // a film shorter than a breath: one tile
    if (instants.length > 48) instants = instants.filter((_, i) => i % Math.ceil(instants.length / 48) === 0);
  } else if (flag("word") !== undefined) {
    instants = String(flag("word")).split(",").map((s) => wordAt(Number(s))).map((word) => ({ t: clampT(word.start + 0.35), wordId: word.id }));
  } else {
    instants = String(flag("at") ?? "0.8").split(",").map((s) => ({ t: clampT(Number(s)), wordId: wordIdAt(Number(s)) }));
  }
  const T = instants[0].t;
  const word = instants[0].wordId === null ? null : wordAt(instants[0].wordId);

  const meta = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(projectDir, "project.json"), "utf8")); } catch { return {}; }
  })();
  const scenes = engine.resolveScenes(templates.refreshTemplates(config.scenes ?? [], { format: formats.resolveFormat(meta).id }), words, { durationSeconds: duration });
  const projectState = await import(pathToFileURL(path.join(REPO_ROOT, "scripts", "project-state.mjs")).href);
  projectState.attachSceneMedia(projectDir, scenes, (src) => pathToFileURL(path.join(projectDir, src)).href);
  motionProtocol.handleMotionProtocol(protocol, { projectDir: () => projectDir });
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
    logicalStage: stage,
    theme,
    punchSpans: config.punch && map?.pieces ? shotEngine.punchSpans(map.pieces, config.punch.zoom) : [],
  };
  const timeline = stageEngine.resolveLayoutTimeline(scenes, duration, { transition: theme.transition, transitionSeconds: theme.transitionSeconds, stage });
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
    // What the picture is, not what the plan says: a thumbnail is the head
    // at focus with the line, whatever the plan had at that instant.
    const describeThumb = (t, wordId, lay) => (flag("thumb")
      ? { at: Number(t.toFixed(2)), wordId, layout: "focus", headOpacity: 1, showing: ["thumbnail line"], planned: describe(t, wordId, lay).showing }
      : describe(t, wordId, lay));
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
    console.log(JSON.stringify({ file: out, ...describeThumb(T, word?.id ?? null, thumbLayout), format: formats.resolveFormat(meta).id, width, height }));
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
