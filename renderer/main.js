"use strict";

// Four steps over one project. Cut: the raw video against the raw
// transcript, struck cuts, pause chips, skip-preview, framing guides. Look:
// the theme — presets, a brand saved for every film, colours, type, motion,
// captions. Scenes: the clean render on the 1080p stage with the scene
// overlays painted by the same runtime the export captures, the script a
// drawer beside it. Export: the renders and what they wrote. The dock
// timeline is the map in Cut and Scenes.

const EPSILON = 0.02;

const $ = (id) => document.getElementById(id);
const els = {
  stages: $("stages"), tabCut: $("tab-cut"), tabLook: $("tab-look"), tabScenes: $("tab-scenes"), tabExport: $("tab-export"),
  progress: $("progress"), progressLabel: $("progress-label"), progressDetail: $("progress-detail"), progressClock: $("progress-clock"),
  session: $("session"), raw: $("stat-raw"), clean: $("stat-clean"),
  empty: $("empty"), emptyLine: $("empty-line"), emptyHint: $("empty-hint"), openFile: $("open-file"),
  player: $("player"), dock: $("dock"), dropzone: $("dropzone"),
  look: $("look"), lookPresets: $("look-presets"), lookBrands: $("look-brands"), lookSave: $("look-save"), lookReset: $("look-reset"), lookStatus: $("look-status"),
  exportPage: $("export"), exportMain: $("export-main"),
  toggleRail: $("toggle-rail"), toggleInsp: $("toggle-insp"),
  video: $("video"), head: $("head"), screen: $("screen"), overlay: $("overlay"), guides: $("guides"),
  playpause: $("playpause"), skipwrap: $("skipwrap"), skipcuts: $("skipcuts"),
  scriptToggle: $("script-toggle"), captionsWrap: $("captions-wrap"), stageCaptions: $("stage-captions"),
  timeNow: $("time-now"), timeSep: $("time-sep"), timeTotal: $("time-total"), transportNote: $("transport-note"),
  hint: $("controls-hint"), transcript: $("transcript"),
  timeline: $("timeline"), laneRuler: $("lane-ruler"),
  trackCuts: $("track-cuts"), laneCuts: $("lane-cuts"),
  trackLayout: $("track-layout"), laneLayout: $("lane-layout"),
  trackScreen: $("track-screen"), laneScreen: $("lane-screen"),
  trackScenes: $("track-scenes"), laneScenes: $("lane-scenes"),
  trackInserts: $("track-inserts"), laneInserts: $("lane-inserts"),
  inspInsert: $("insp-insert"), insertWhy: $("insert-why"), insertOptions: $("insert-options"), insertNone: $("insert-none"),
  insertNote: $("insert-note"), insertNoteSend: $("insert-note-send"), insertClose: $("insert-close"), insertStatus: $("insert-status"),
  askText: $("ask-text"), askSend: $("ask-send"), askStatus: $("ask-status"),
  playhead: $("tl-playhead"),
  inspector: $("inspector"), inspTitle: $("insp-title"), inspProject: $("insp-project"), inspBody: $("insp-body"),
  inspCutSummary: $("insp-cut-summary"), sumCuts: $("sum-cuts"), sumRemoved: $("sum-removed"), sumShots: $("sum-shots"), sumFraming: $("sum-framing"),
  themeAccent: $("theme-accent"), themeAccentValue: $("theme-accent-value"), themeAccent2: $("theme-accent2"), themeAccent2Value: $("theme-accent2-value"),
  themeTitleStyle: $("theme-title-style"), themeCalloutStyle: $("theme-callout-style"), themeCaptionStyle: $("theme-caption-style"), themePunch: $("theme-punch"),
  themeCaptions: $("theme-captions"), captionsNote: $("captions-note"),
  themeLogoPick: $("theme-logo-pick"), themeLogoName: $("theme-logo-name"), themeLogoClear: $("theme-logo-clear"),
  themeLogoCornerWrap: $("theme-logo-corner-wrap"), themeLogoCorner: $("theme-logo-corner"), themeWatermark: $("theme-watermark"),
  inspEmpty: $("insp-empty"), inspKeysCut: $("insp-keys-cut"),
  inspClose: $("insp-close"), inspStatus: $("insp-status"),
  inspText: $("insp-text"), inspTextWrap: $("insp-text-wrap"),
  inspLabel: $("insp-label"), inspLabelWrap: $("insp-label-wrap"),
  inspAccent: $("insp-accent"), inspAccentWrap: $("insp-accent-wrap"), inspAccentClear: $("insp-accent-clear"),
  inspLayout: $("insp-layout"), inspLayoutWrap: $("insp-layout-wrap"),
  inspCorner: $("insp-corner"), inspCornerWrap: $("insp-corner-wrap"),
  inspFlair: $("insp-flair"), inspFlairWrap: $("insp-flair-wrap"),
};

let state = null; // { project, review, compose, look, progress, pending }
let mode = "cut"; // cut | look | scenes | export
let wordSpans = [];
let highlighted = null;
let selectedScene = null; // index into compose.scenes
let selectedInsert = null; // insert id
let previewOption = null; // option id being hovered in the picker
let paintCache = null; // { key, compose } the merged compose a preview paints
let userChoseTab = false;
let statusTimer = null;
let railWanted = true; // the transcript rail in Cut, as the person left it
let scriptOpen = false; // the script drawer in Scenes

const CAPTION_NOTES = {
  none: "No captions anywhere.",
  open: "Painted into the picture in the caption style below.",
  closed: "Nothing in the picture. An .srt and a .vtt land beside every render for the player to offer as CC.",
  both: "Painted in, and the .srt and .vtt written too.",
};

const review = () => state?.review ?? null;
const compose = () => state?.compose ?? null;
const look = () => state?.look ?? null;
const inserts = () => compose()?.inserts ?? [];
const insertById = (id) => inserts().find((insert) => insert.id === id) ?? null;
const insertState = (insert) => (insert.chosen === "other" ? "other" : insert.chosen ? "chosen" : "open");
const enabledCuts = () => (review()?.cuts ?? []).filter((cut) => cut.enabled);
const removedSeconds = () => enabledCuts().reduce((sum, cut) => sum + (cut.end - cut.start), 0);
const onStage = () => mode === "cut" || mode === "scenes";

// What the stage paints: the plan as written, or, while an option is under
// the pointer in the picker, the plan with that option in the insert's place.
function composeForPaint() {
  const c = compose();
  const insert = selectedInsert ? insertById(selectedInsert) : null;
  const option = insert && previewOption ? insert.options.find((o) => o.id === previewOption) : null;
  if (!c || !insert || !option || option.id === insert.chosen) return c;
  const key = `${state?.project}:${insert.id}:${option.id}:${c.scenes.length}`;
  if (paintCache?.key === key) return paintCache.compose;
  const scenes = [...c.scenes.filter((scene) => scene.insertId !== insert.id), ...option.scenes].sort((a, b) => a.start - b.start);
  const layoutTimeline = window.FabulaStageEngine ? window.FabulaStageEngine.resolveLayoutTimeline(scenes, composeDuration()) : c.layoutTimeline;
  paintCache = { key, compose: { ...c, scenes, layoutTimeline } };
  return paintCache.compose;
}

document.body.classList.add(window.fabula.platform);

// ---- Time ----

// m:ss.d below an hour, h:mm:ss above; the film's own clock, never raw seconds.
function fmt(value, tenths = true) {
  const total = Math.max(value, 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(Math.floor(s)).padStart(2, "0")}`;
  return tenths ? `${m}:${s.toFixed(1).padStart(4, "0")}` : `${m}:${String(Math.floor(s)).padStart(2, "0")}`;
}

function cutTitle(cut) {
  const reasons = [...new Set(cut.sources.map((s) => s.reason + (s.detail ? ` "${s.detail}"` : "")))].join(", ");
  return `${reasons} · ${fmt(cut.start)}–${fmt(cut.end)}${cut.enabled ? "" : " · kept"}`;
}

function setSource(url) {
  if (url && els.video.src !== url) {
    els.video.src = url;
    els.video.currentTime = 0;
  }
}

function totalSeconds() {
  return mode === "cut" ? review().duration : composeDuration();
}

function seek(t) {
  const total = totalSeconds();
  els.video.currentTime = Math.min(Math.max(t, 0), Math.max(total - 0.05, 0));
}

function composeDuration() {
  const c = compose();
  return (Number.isFinite(els.video.duration) && els.video.duration) || c?.words.at(-1)?.end || 1;
}

// ---- Header ----

function renderHeader() {
  const r = review();
  els.raw.textContent = fmt(r.duration, false);
  els.clean.textContent = fmt(r.duration - removedSeconds(), false);
}

function renderProgress() {
  const p = state?.progress;
  els.progress.hidden = !p;
  if (!p) return;
  const failed = typeof p.detail === "string" && p.detail.startsWith("failed:");
  els.progress.classList.toggle("is-failed", failed);
  els.progressLabel.textContent = failed ? `${p.label} failed` : p.label;
  els.progressDetail.textContent = failed ? p.detail.slice(8) : (p.detail ?? "");
  els.progressDetail.hidden = !els.progressDetail.textContent;
  els.progressClock.hidden = failed;
}

// ---- Transcript ----

function renderCutTranscript() {
  const r = review();
  const wordCut = new Map();
  const chips = [];
  r.cuts.forEach((cut, index) => {
    const covered = r.words.filter(
      (word) => word.start >= cut.start - EPSILON && word.end <= cut.end + EPSILON
    );
    if (covered.length > 0) for (const word of covered) wordCut.set(word.id, index);
    else chips.push(index);
  });
  chips.sort((a, b) => r.cuts[a].start - r.cuts[b].start);

  els.transcript.replaceChildren();
  wordSpans = [];
  let chipAt = 0;
  const emitChipsBefore = (time) => {
    while (chipAt < chips.length && r.cuts[chips[chipAt]].start < time) {
      const index = chips[chipAt];
      const cut = r.cuts[index];
      const chip = document.createElement("span");
      chip.className = cut.enabled ? "gap is-cut" : "gap is-kept";
      chip.textContent = `${(cut.end - cut.start).toFixed(1)}s`;
      chip.title = cutTitle(cut);
      chip.dataset.cutIndex = String(index);
      els.transcript.append(chip, " ");
      chipAt += 1;
    }
  };

  for (const word of r.words) {
    emitChipsBefore(word.start);
    const span = document.createElement("span");
    const cutIndex = wordCut.get(word.id);
    if (cutIndex !== undefined) {
      const cut = r.cuts[cutIndex];
      span.className = cut.enabled ? "word is-cut" : "word is-kept";
      span.title = cutTitle(cut);
      span.dataset.cutIndex = String(cutIndex);
    } else {
      span.className = "word";
      span.title = `${fmt(word.start)}–${fmt(word.end)}`;
    }
    span.textContent = word.text;
    span.dataset.start = String(word.start);
    wordSpans.push({ word, span });
    els.transcript.append(span, " ");
  }
  emitChipsBefore(Infinity);
}

function renderSceneTranscript() {
  const c = compose();
  els.transcript.replaceChildren();
  wordSpans = [];
  const marksAt = new Map();
  for (const insert of c.inserts ?? []) {
    if (!marksAt.has(insert.fromWordId)) marksAt.set(insert.fromWordId, []);
    marksAt.get(insert.fromWordId).push(insert);
  }
  for (const word of c.words) {
    for (const insert of marksAt.get(word.id) ?? []) {
      const mark = document.createElement("span");
      mark.className = `insert-mark is-${insertState(insert)}${insert.id === selectedInsert ? " is-open" : ""}`;
      mark.textContent = insertState(insert) === "chosen" ? "✓" : insertState(insert) === "other" ? "…" : "+";
      mark.title = `${insert.why}${insert.chosen ? ` · ${insert.chosen === "other" ? "asked for something else" : insert.chosen}` : " · choose what goes here"}`;
      mark.dataset.insert = insert.id;
      els.transcript.append(mark, " ");
    }
    const span = document.createElement("span");
    span.className = "word";
    span.title = `${fmt(word.start)}–${fmt(word.end)}`;
    span.textContent = word.text;
    span.dataset.start = String(word.start);
    wordSpans.push({ word, span });
    els.transcript.append(span, " ");
  }
}

// ---- Timeline ----

function sceneBlockLabel(scene) {
  if (scene.type === "graphic") return `${scene.graphic.kind}${scene.graphic.title || scene.graphic.label ? ` · ${scene.graphic.title ?? scene.graphic.label}` : ""}`;
  if (scene.type === "kinetic") return "kinetic type";
  return `${scene.type} · ${scene.text ?? ""}`;
}

function rulerStep(total) {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
  return steps.find((step) => total / step <= 9) ?? 3600;
}

function renderRuler(total) {
  els.laneRuler.replaceChildren();
  const step = rulerStep(total);
  for (let t = 0; t < total - step * 0.3; t += step) {
    const tick = document.createElement("span");
    tick.className = "tl-tick";
    tick.style.left = `${(t / total) * 100}%`;
    tick.textContent = fmt(t, false);
    els.laneRuler.append(tick);
  }
}

function place(el, start, end, total, minPercent = 0.8) {
  el.style.left = `${(start / total) * 100}%`;
  el.style.width = `${Math.max(((end - start) / total) * 100, minPercent)}%`;
}

// Cut: the raw clip with every proposal on it. A struck span is solid
// cut-red, a kept one an outline; clicking either jumps there.
function renderCutTimeline() {
  const r = review();
  const total = r.duration;
  renderRuler(total);
  els.laneCuts.replaceChildren();
  r.cuts.forEach((cut, index) => {
    const block = document.createElement("div");
    block.className = `tl-block is-cutblock${cut.enabled ? "" : " is-kept"}`;
    block.title = cutTitle(cut);
    place(block, cut.start, cut.end, total, 0.15);
    block.dataset.seek = String(Math.max(cut.start - 0.6, 0));
    block.dataset.cutIndex = String(index);
    els.laneCuts.append(block);
  });
}

// Scenes: one lane for where the head sits, one for the screen track where
// it exists, one for the scenes, one for the insert points. Blocks are
// clickable — seek, select, inspect. A click lands just past the head's
// 0.6 s flight and a card's entrance, so what appears is the settled
// picture, not the first frame of a transition.
const settledAt = (start, end) => start + Math.min(0.75, Math.max((end - start) / 2, 0.05));

function renderSceneTimeline() {
  const c = compose();
  const total = composeDuration();
  renderRuler(total);

  els.laneLayout.replaceChildren();
  for (const segment of c.layoutTimeline ?? []) {
    const block = document.createElement("div");
    const isFocus = segment.layout === "focus";
    block.className = `tl-block${isFocus ? " is-dim" : ""}`;
    block.textContent = isFocus ? "focus" : `${segment.layout}${segment.corner ? ` ${segment.corner}` : ""}`;
    block.title = `${segment.layout} · ${fmt(segment.start)}–${fmt(segment.end)}`;
    place(block, segment.start, segment.end, total);
    const sceneIndex = c.scenes.findIndex(
      (scene) => scene.type === "stage" && Math.abs(scene.start - segment.start) < 0.01
    );
    block.dataset.seek = String(settledAt(segment.start, segment.end));
    if (sceneIndex >= 0) block.dataset.scene = String(sceneIndex);
    els.laneLayout.append(block);
  }

  const spans = c.screenSpans ?? [];
  els.trackScreen.hidden = spans.length === 0;
  els.laneScreen.replaceChildren();
  for (const span of spans) {
    const block = document.createElement("div");
    block.className = "tl-block is-screenblock";
    block.title = `screen recorded · ${fmt(span.start)}–${fmt(span.end)}`;
    place(block, span.start, span.end, total, 0.3);
    block.dataset.seek = String(span.start);
    els.laneScreen.append(block);
  }

  els.trackInserts.hidden = (c.inserts ?? []).length === 0;
  els.laneInserts.replaceChildren();
  for (const insert of c.inserts ?? []) {
    const mark = document.createElement("div");
    mark.className = `tl-insert is-${insertState(insert)}${insert.id === selectedInsert ? " is-open" : ""}`;
    mark.title = insert.why;
    mark.style.left = `${(insert.start / total) * 100}%`;
    mark.dataset.insert = insert.id;
    els.laneInserts.append(mark);
  }
  els.laneScenes.replaceChildren();
  c.scenes.forEach((scene, index) => {
    if (scene.type === "stage") return;
    const block = document.createElement("div");
    block.className = "tl-block";
    if (scene.accent) {
      block.style.background = `${scene.accent}38`;
      block.style.borderColor = `${scene.accent}66`;
    }
    block.textContent = sceneBlockLabel(scene);
    block.title = `${sceneBlockLabel(scene)} · ${fmt(scene.start)}–${fmt(scene.end)}`;
    place(block, scene.start, scene.end, total);
    block.dataset.seek = String(settledAt(scene.start, scene.end));
    block.dataset.scene = String(index);
    if (index === selectedScene) block.classList.add("is-selected");
    els.laneScenes.append(block);
  });
  hideTinyLabels();
}

// A thirteen-minute film packs the lanes; a label that would show two
// letters and an ellipsis says less than a plain block with its tooltip.
function hideTinyLabels() {
  requestAnimationFrame(() => {
    for (const block of els.timeline.querySelectorAll(".tl-block")) {
      block.classList.toggle("is-tiny", block.offsetWidth < 46 && !block.classList.contains("is-cutblock"));
    }
  });
}
window.addEventListener("resize", hideTinyLabels);

// ---- Inspector ----

function flashStatus(text, isError = false) {
  els.inspStatus.textContent = text;
  els.inspStatus.classList.toggle("is-error", isError);
  els.inspStatus.style.opacity = "1";
  clearTimeout(statusTimer);
  if (!isError) statusTimer = setTimeout(() => { els.inspStatus.style.opacity = "0"; }, 1800);
}

function describeFraming(framing) {
  if (!framing) return "whole frame";
  const withScreen = framing.segments.filter((s) => s.screen).length;
  const n = framing.segments.length;
  return `${n} segment${n === 1 ? "" : "s"}${withScreen ? ` · ${withScreen} with screen` : ""}`;
}

function renderProjectPanel() {
  const r = review();
  els.inspTitle.textContent = state?.project ?? "";
  if (mode === "cut") {
    els.inspCutSummary.hidden = false;
    els.inspKeysCut.hidden = false;
    const kept = r.cuts.length - enabledCuts().length;
    els.sumCuts.textContent = `${r.cuts.length}${kept ? ` · ${kept} kept` : ""}`;
    els.sumRemoved.textContent = fmt(removedSeconds(), false);
    els.sumShots.textContent = r.shotPlan ? `alternating ${Math.round(r.shotPlan.zoom * 100)}%` : "off";
    els.sumFraming.textContent = describeFraming(r.framing);
    els.inspEmpty.textContent = "Click a struck word or pause to keep it; click a word to jump there. Ask Claude to tighten, loosen, or cut a passage.";
  } else {
    els.inspCutSummary.hidden = true;
    els.inspKeysCut.hidden = true;
    const open = inserts().filter((insert) => !insert.chosen).length;
    els.inspEmpty.textContent = open > 0
      ? `${open} insert point${open === 1 ? "" : "s"} still open — click a + in the script or a diamond in the timeline to choose what goes there.`
      : "Click a block in the timeline to edit it. The look lives on the Look step. Ask Claude for anything larger: a new scene, a different layout, a punchier title.";
  }
}

// ---- The Look page ----

// A preset or a brand, drawn small with its own tokens: the field, the
// head's card, a title bar, a caption in its style. Enough to tell them apart.
function thumbnail(t) {
  const thumb = document.createElement("div");
  thumb.className = "thumb";
  thumb.style.background = t.fieldStyle === "flat"
    ? t.field[1]
    : `radial-gradient(120% 140% at 50% 0%, ${t.field[0]} 0%, ${t.field[1]} 52%, ${t.field[2]} 100%)`;
  const head = document.createElement("div");
  head.className = "thumb-head";
  head.style.background = t.card.startsWith("rgba(255") ? "rgba(255,255,255,0.18)" : "rgba(120,120,120,0.28)";
  const title = document.createElement("div");
  title.className = "thumb-title";
  const bar = document.createElement("span");
  bar.style.background = t.accent;
  const text = document.createElement("span");
  text.className = "thumb-title-text";
  text.textContent = t.titleCase === "upper" ? "TITLE" : "Title";
  text.style.color = t.titleStyle === "block" ? "#fff" : t.text;
  text.style.fontFamily = `"${t.fonts.display}", system-ui, sans-serif`;
  if (t.titleStyle === "block") { text.style.background = t.accent; text.style.padding = "0 4px"; }
  title.append(bar, text);
  const caption = document.createElement("div");
  caption.className = `thumb-caption is-${t.captionStyle}`;
  caption.textContent = "caption";
  caption.style.color = t.text;
  caption.style.background = t.captionStyle === "band" ? `color-mix(in srgb, ${t.field[2]} 85%, transparent)` : `color-mix(in srgb, ${t.field[2]} 60%, transparent)`;
  if (t.captionStyle === "karaoke") caption.style.color = t.accent;
  thumb.append(head, title, caption);
  return thumb;
}

function lookCard({ id, title, about, tokens, active, onPick, action }) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = `look-card${active ? " is-active" : ""}`;
  card.dataset.id = id;
  card.append(thumbnail(tokens));
  const name = document.createElement("div");
  name.className = "look-card-name";
  name.textContent = title;
  card.append(name);
  if (about) {
    const line = document.createElement("div");
    line.className = "look-card-about";
    line.textContent = about;
    card.append(line);
  }
  if (action) {
    const tag = document.createElement("div");
    tag.className = "look-card-action";
    tag.textContent = action;
    card.append(tag);
  }
  card.addEventListener("click", onPick);
  return card;
}

function renderLookPage() {
  const l = look();
  if (!l) return;
  const theme = l.theme;
  const config = l.themeConfig;
  els.lookPresets.replaceChildren(...l.presets.map((p) => lookCard({
    id: p.id, title: p.label, about: p.about, tokens: p, active: theme.preset === p.id,
    onPick: () => window.fabula.setProject({ theme: { preset: p.id } }),
  })));
  const brands = l.savedThemes.map((s) => lookCard({
    id: s.id, title: s.name, tokens: s.theme, active: false, action: "use this brand",
    about: `${s.theme.preset} · ${s.theme.accent} · ${s.theme.captionStyle} captions`,
    onPick: () => window.fabula.setProject({ themeUse: s.id }),
  }));
  if (brands.length === 0) {
    const none = document.createElement("p");
    none.className = "look-none";
    none.textContent = "No brand saved yet. Get the look right, then save it, and every next film starts from it.";
    els.lookBrands.replaceChildren(none);
  } else {
    els.lookBrands.replaceChildren(...brands);
  }
  els.themeAccent.value = theme.accent;
  els.themeAccentValue.textContent = theme.accent;
  els.themeAccent2.value = theme.accent2;
  els.themeAccent2Value.textContent = theme.accent2;
  els.themeTitleStyle.value = theme.titleStyle;
  els.themeCalloutStyle.value = theme.calloutStyle;
  els.themeCaptionStyle.value = theme.captionStyle === "none" ? "pill" : theme.captionStyle;
  const zoom = l.punch?.zoom;
  const option = zoom ? [...els.themePunch.options].find((o) => Number(o.value) === zoom) : null;
  if (zoom && !option) {
    const custom = document.createElement("option");
    custom.value = String(zoom);
    custom.textContent = `alternating ${Math.round(zoom * 100)}%`;
    els.themePunch.append(custom);
  }
  els.themePunch.value = zoom ? String(zoom) : "";
  for (const button of els.themeCaptions.querySelectorAll("button")) button.classList.toggle("is-on", button.dataset.value === l.captionMode);
  els.captionsNote.textContent = CAPTION_NOTES[l.captionMode] ?? "";
  els.themeLogoName.textContent = theme.logo ? theme.logo.src.replace(/^assets\//, "") : "none";
  els.themeLogoClear.hidden = !theme.logo;
  els.themeLogoCornerWrap.hidden = !theme.logo;
  els.themeLogoCorner.value = theme.logo?.corner ?? "tr";
  if (document.activeElement !== els.themeWatermark) els.themeWatermark.value = theme.watermark ?? "";
  els.lookReset.hidden = Object.keys(config).filter((key) => key !== "preset").length === 0;
}

// ---- The Export page (filled in by the render step) ----

function renderExportPage() {
  const l = look();
  els.exportMain.replaceChildren();
  const head = document.createElement("div");
  head.className = "page-head";
  head.innerHTML = "<h2>Export</h2><p class=\"page-lede\">The renders and what they wrote.</p>";
  const note = document.createElement("p");
  note.className = "field-note";
  note.textContent = `Captions: ${l ? CAPTION_NOTES[l.captionMode] : ""} Renders run from the Claude session for now (render_clean, render_final); they land in media/${state?.project ?? ""}/out/.`;
  els.exportMain.append(head, note);
}

// ---- Insert points ----

function openInsert(id) {
  const insert = insertById(id);
  if (!insert) return;
  selectedScene = null;
  selectedInsert = id;
  previewOption = null;
  els.inspProject.hidden = true;
  els.inspBody.hidden = true;
  els.inspInsert.hidden = false;
  renderInsertPanel();
  // Land where an option has settled: past the head's flight and a card's
  // build, so a paused frame shows the choice, not its first frame.
  seek(insert.start + Math.min(2.2, (insert.end - insert.start) * 0.5));
  renderSceneTimeline();
  renderSceneTranscript();
}

function renderInsertPanel() {
  const insert = selectedInsert ? insertById(selectedInsert) : null;
  if (!insert) { closeInspector(); return; }
  els.inspTitle.textContent = `insert · ${fmt(insert.start)}–${fmt(insert.end)}`;
  els.insertWhy.textContent = insert.why;
  els.insertOptions.replaceChildren();
  for (const option of insert.options) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `insert-option${option.id === insert.chosen ? " is-chosen" : ""}`;
    const label = document.createElement("span");
    label.className = "insert-option-label";
    label.textContent = option.label;
    const kinds = document.createElement("span");
    kinds.className = "insert-option-kinds";
    kinds.textContent = [...new Set(option.scenes.map((s) => (s.type === "graphic" ? s.graphic.kind : s.type === "stage" ? `${s.layout} layout` : s.type)))].join(" · ");
    button.append(label, kinds);
    button.dataset.option = option.id;
    button.addEventListener("mouseenter", () => { previewOption = option.id; });
    button.addEventListener("mouseleave", () => { if (previewOption === option.id) previewOption = null; });
    button.addEventListener("click", async () => {
      const result = await window.fabula.chooseInsert(insert.id, option.id);
      flashInsert(result.ok ? "chosen" : result.error, !result.ok);
    });
    els.insertOptions.append(button);
  }
  els.insertNone.classList.toggle("is-chosen", !insert.chosen);
  if (document.activeElement !== els.insertNote) els.insertNote.value = insert.chosen === "other" ? (insert.note ?? "") : "";
  els.insertStatus.textContent = insert.chosen === "other" ? "sent to Claude" : "";
  els.insertStatus.classList.remove("is-error");
}

function flashInsert(text, isError = false) {
  els.insertStatus.textContent = text;
  els.insertStatus.classList.toggle("is-error", isError);
}

function openInspector(index) {
  const scene = compose()?.scenes[index];
  if (!scene) return;
  selectedScene = index;
  selectedInsert = null;
  previewOption = null;
  els.inspInsert.hidden = true;
  els.inspProject.hidden = true;
  els.inspBody.hidden = false;
  els.inspTitle.textContent = `${scene.type} · ${fmt(scene.start)}–${fmt(scene.end)}`;
  const hasText = scene.type === "title" || scene.type === "callout";
  els.inspTextWrap.hidden = !hasText;
  els.inspText.value = hasText ? (scene.text ?? "") : "";
  const hasLabel = scene.type === "graphic" && ["image", "screen", "stat"].includes(scene.graphic?.kind);
  els.inspLabelWrap.hidden = !hasLabel;
  els.inspLabel.value = hasLabel ? (scene.graphic.label ?? "") : "";
  const isStage = scene.type === "stage";
  els.inspAccentWrap.hidden = isStage;
  els.inspAccent.value = scene.accent ?? compose()?.theme?.accent ?? "#d97757";
  els.inspAccentClear.hidden = !scene.accent;
  els.inspLayoutWrap.hidden = !isStage;
  els.inspCornerWrap.hidden = !isStage || (scene.layout !== "pip" && scene.layout !== "full");
  if (isStage) {
    els.inspLayout.value = scene.layout;
    els.inspCorner.value = scene.corner ?? "br";
  }
  els.inspFlairWrap.hidden = scene.type !== "title";
  els.inspFlair.checked = Boolean(scene.flair);
  els.inspStatus.textContent = "";
  els.inspStatus.classList.remove("is-error");
  renderSceneTimeline();
}

function closeInspector() {
  selectedScene = null;
  selectedInsert = null;
  previewOption = null;
  els.inspProject.hidden = false;
  els.inspBody.hidden = true;
  els.inspInsert.hidden = true;
  if (review()) renderProjectPanel();
  if (mode === "scenes" && compose()) renderSceneTimeline();
}

async function patchScene(patch) {
  if (selectedScene === null) return;
  const result = await window.fabula.updateScene(selectedScene, patch);
  flashStatus(result.ok ? "saved" : result.error, !result.ok);
}

// ---- Framing guides (cut) ----

function renderGuides(now) {
  const r = review();
  const framing = r?.framing;
  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;
  if (!framing || !vw || !vh) { els.guides.hidden = true; return; }
  const segment = framing.segments.find((s) => now >= s.start && now < s.end) ?? framing.segments.at(-1);
  let scale = 1;
  for (const shot of r.shots ?? []) if (now >= shot.start && now < shot.end) { scale = shot.scale; break; }
  const key = `${segment.start}:${scale}`;
  if (els.guides.dataset.key !== key) {
    els.guides.dataset.key = key;
    els.guides.replaceChildren();
    const box = (rect, className, label) => {
      const el = document.createElement("div");
      el.className = `guide ${className}`;
      el.style.left = `${(rect.x / vw) * 100}%`;
      el.style.top = `${(rect.y / vh) * 100}%`;
      el.style.width = `${(rect.w / vw) * 100}%`;
      el.style.height = `${(rect.h / vh) * 100}%`;
      if (label) {
        const tag = document.createElement("span");
        tag.className = "guide-label";
        tag.textContent = label;
        el.append(tag);
      }
      els.guides.append(el);
    };
    if (segment.screen) box(segment.screen, "is-screen", "screen");
    box(segment.head, "is-head", "head");
    if (scale > 1) {
      const h = segment.head;
      box({ x: h.x + (h.w - h.w / scale) / 2, y: h.y + (h.h - h.h / scale) / 2, w: h.w / scale, h: h.h / scale }, "is-punch");
    }
  }
  els.guides.hidden = false;
}

// ---- Render ----

function setMode(next) {
  if (next === "scenes" && !compose()) next = "cut";
  mode = next;
  render();
}

function render() {
  renderProgress();
  if (!review()) {
    els.session.hidden = true;
    els.stages.hidden = true;
    els.player.hidden = true;
    els.dock.hidden = true;
    els.look.hidden = true;
    els.exportPage.hidden = true;
    els.empty.hidden = false;
    els.empty.classList.remove("is-error");
    if (state?.pending) {
      els.emptyLine.textContent = `“${state.pending.project}” is open and waiting.`;
      els.emptyHint.textContent = state.progress
        ? "Claude is working on it. The transcript appears here as soon as it lands."
        : "Tell Claude: “do a first pass on the open clip”. It transcribes, cuts and designs; you review here.";
      els.openFile.textContent = "Open a different recording…";
    } else {
      els.emptyLine.textContent = "Drop a recording here to begin.";
      els.emptyHint.textContent = "Then ask Claude for a first pass. It transcribes, cuts and designs; you review here.";
      els.openFile.textContent = "Open a recording…";
    }
    return;
  }
  if (mode === "scenes" && !compose()) mode = "cut";

  renderHeader();
  els.session.hidden = false;
  els.empty.hidden = true;
  els.stages.hidden = false;
  els.tabScenes.disabled = !compose();
  els.tabLook.disabled = !look();
  for (const [name, button] of [["cut", els.tabCut], ["look", els.tabLook], ["scenes", els.tabScenes], ["export", els.tabExport]]) {
    button.classList.toggle("is-active", mode === name);
  }

  els.look.hidden = mode !== "look";
  els.exportPage.hidden = mode !== "export";
  if (mode === "look") { renderLookPage(); els.player.hidden = true; els.dock.hidden = true; return; }
  if (mode === "export") { renderExportPage(); els.player.hidden = true; els.dock.hidden = true; return; }

  const frame = els.video.closest(".videoframe"); // the head card wraps the video
  els.scriptToggle.hidden = mode !== "scenes";
  els.captionsWrap.hidden = mode !== "scenes";
  if (mode === "cut") {
    document.body.classList.toggle("rail-collapsed", !railWanted);
    setSource(review().videoUrl);
    els.skipwrap.hidden = false;
    els.hint.textContent = "Click a word to jump there. Click anything struck to keep it.";
    els.overlay.replaceChildren();
    delete els.overlay.dataset.state;
    frame.classList.remove("is-stage", "stage-field");
    // The frame is a size container (cq units); the raw footage's own aspect
    // gives it a size, since its contents cannot.
    frame.style.aspectRatio = els.video.videoWidth ? `${els.video.videoWidth} / ${els.video.videoHeight}` : "16 / 9";
    els.head.style.left = els.head.style.top = "";
    els.head.style.width = els.head.style.height = "";
    els.head.style.borderRadius = "";
    els.video.style.transform = "";
    els.screen.hidden = true;
    els.screen.pause();
    els.trackCuts.hidden = false;
    els.trackLayout.hidden = els.trackScreen.hidden = els.trackScenes.hidden = els.trackInserts.hidden = true;
    els.timeTotal.textContent = `${fmt(review().duration, false)} raw`;
    els.transportNote.textContent = review().shots ? "Punch-ins alternate across cuts; guides show the crop." : "";
    if (selectedScene !== null || selectedInsert !== null) closeInspector();
    renderCutTranscript();
    renderCutTimeline();
  } else {
    document.body.classList.toggle("rail-collapsed", !scriptOpen);
    els.scriptToggle.classList.toggle("is-on", scriptOpen);
    setSource(compose().videoUrl);
    els.skipwrap.hidden = true;
    els.hint.textContent = "Click a word to jump there.";
    els.video.style.transform = "";
    els.guides.hidden = true;
    frame.classList.add("is-stage", "stage-field");
    frame.style.aspectRatio = "";
    if (compose().screenUrl && els.screen.src !== compose().screenUrl) els.screen.src = compose().screenUrl;
    els.trackCuts.hidden = true;
    els.trackLayout.hidden = els.trackScenes.hidden = false;
    els.timeTotal.textContent = fmt(composeDuration(), false);
    els.transportNote.textContent = "";
    els.stageCaptions.value = compose().captionMode ?? "none";
    if (selectedScene !== null && !compose().scenes[selectedScene]) closeInspector();
    renderSceneTimeline();
    renderSceneTranscript();
  }
  els.timeSep.textContent = mode === "cut" ? " · " : " / ";
  if (selectedInsert !== null && mode === "scenes") {
    if (insertById(selectedInsert)) renderInsertPanel(); else closeInspector();
  } else if (selectedScene === null) { els.inspProject.hidden = false; els.inspBody.hidden = true; els.inspInsert.hidden = true; renderProjectPanel(); }
  els.player.hidden = !els.video.src;
  els.dock.hidden = els.player.hidden;
  highlighted = null;
}

// ---- Chrome events ----

els.toggleRail.addEventListener("click", () => {
  if (mode === "scenes") { scriptOpen = !scriptOpen; render(); return; }
  railWanted = !railWanted;
  document.body.classList.toggle("rail-collapsed", !railWanted);
  els.toggleRail.classList.toggle("is-on", railWanted);
});
els.toggleInsp.addEventListener("click", () => {
  const collapsed = document.body.classList.toggle("insp-collapsed");
  els.toggleInsp.classList.toggle("is-on", !collapsed);
});
els.scriptToggle.addEventListener("click", () => { scriptOpen = !scriptOpen; render(); });

els.tabCut.addEventListener("click", () => { userChoseTab = true; setMode("cut"); });
els.tabLook.addEventListener("click", () => { userChoseTab = true; setMode("look"); });
els.tabScenes.addEventListener("click", () => { userChoseTab = true; setMode("scenes"); });
els.tabExport.addEventListener("click", () => { userChoseTab = true; setMode("export"); });

els.transcript.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.dataset.insert !== undefined) { openInsert(target.dataset.insert); return; }
  if (mode === "cut" && target.dataset.cutIndex !== undefined) {
    const index = Number(target.dataset.cutIndex);
    window.fabula.setCut(index, !review().cuts[index].enabled);
    return;
  }
  if (target.dataset.start !== undefined) {
    seek(Number(target.dataset.start));
    els.video.play();
  }
});

els.timeline.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.dataset.insert !== undefined) { openInsert(target.dataset.insert); return; }
  if (target.dataset.seek !== undefined) {
    seek(Number(target.dataset.seek) + 0.01);
    if (target.dataset.scene !== undefined) openInspector(Number(target.dataset.scene));
    return;
  }
  const lane = target.closest(".tl-lane, .tl-ruler");
  if (lane) {
    const box = lane.getBoundingClientRect();
    seek(((event.clientX - box.left) / box.width) * totalSeconds());
  }
});

// Inspector: every control applies as it changes. Text applies on Enter or
// when focus leaves, so half a word never hits the plan.
els.inspClose.addEventListener("click", closeInspector);
const applyText = () => patchScene({ text: els.inspText.value });
els.inspText.addEventListener("change", applyText);
els.inspText.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); els.inspText.blur(); } });
els.inspLabel.addEventListener("change", () => patchScene({ label: els.inspLabel.value }));
els.inspLabel.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); els.inspLabel.blur(); } });
els.inspAccent.addEventListener("change", () => { els.inspAccentClear.hidden = false; patchScene({ accent: els.inspAccent.value }); });
els.inspAccentClear.addEventListener("click", () => {
  els.inspAccent.value = compose()?.theme?.accent ?? "#d97757";
  els.inspAccentClear.hidden = true;
  patchScene({ accent: null });
});
els.inspLayout.addEventListener("change", () => {
  const layout = els.inspLayout.value;
  els.inspCornerWrap.hidden = layout !== "pip" && layout !== "full";
  patchScene({ layout, corner: layout === "pip" || layout === "full" ? els.inspCorner.value : null });
});
els.inspCorner.addEventListener("change", () => patchScene({ corner: els.inspCorner.value }));
els.inspFlair.addEventListener("change", () => patchScene({ flair: els.inspFlair.checked ? true : null }));

// The Look page: every control applies as it changes.
const setTheme = (patch) => window.fabula.setProject({ theme: patch });
els.themeAccent.addEventListener("input", () => { els.themeAccentValue.textContent = els.themeAccent.value; });
els.themeAccent.addEventListener("change", () => setTheme({ accent: els.themeAccent.value }));
els.themeAccent2.addEventListener("input", () => { els.themeAccent2Value.textContent = els.themeAccent2.value; });
els.themeAccent2.addEventListener("change", () => setTheme({ accent2: els.themeAccent2.value }));
els.themeTitleStyle.addEventListener("change", () => setTheme({ titleStyle: els.themeTitleStyle.value }));
els.themeCalloutStyle.addEventListener("change", () => setTheme({ calloutStyle: els.themeCalloutStyle.value }));
els.themeCaptionStyle.addEventListener("change", () => setTheme({ captionStyle: els.themeCaptionStyle.value }));
els.themePunch.addEventListener("change", () => window.fabula.setProject({ punch: els.themePunch.value ? Number(els.themePunch.value) : null }));
els.themeCaptions.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-value]");
  if (button) window.fabula.setProject({ captions: button.dataset.value });
});
els.stageCaptions.addEventListener("change", () => window.fabula.setProject({ captions: els.stageCaptions.value }));
els.themeLogoCorner.addEventListener("change", () => setTheme({ logoCorner: els.themeLogoCorner.value }));
els.themeLogoClear.addEventListener("click", () => setTheme({ logo: null }));
els.themeLogoPick.addEventListener("click", async () => {
  const picked = await window.fabula.pickAsset();
  if (picked.ok) setTheme({ logo: { src: picked.src, corner: els.themeLogoCorner.value } });
  else if (!picked.cancelled) { els.lookStatus.textContent = picked.error; }
});
els.themeWatermark.addEventListener("change", () => setTheme({ watermark: els.themeWatermark.value.trim() || null }));
els.themeWatermark.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); els.themeWatermark.blur(); } });
els.lookReset.addEventListener("click", () => window.fabula.setProject({ themeReset: true }));
els.lookSave.addEventListener("click", async () => {
  const name = window.prompt("Save this look as a brand, for every next film:", look()?.savedThemes[0]?.name ?? "");
  if (!name) return;
  const result = await window.fabula.setProject({ themeSave: name });
  els.lookStatus.textContent = result.ok ? `saved as “${name}”` : result.error;
});

els.insertNone.addEventListener("click", async () => {
  if (!selectedInsert) return;
  const result = await window.fabula.chooseInsert(selectedInsert, null);
  flashInsert(result.ok ? "nothing placed" : result.error, !result.ok);
});
els.insertNoteSend.addEventListener("click", async () => {
  if (!selectedInsert) return;
  const result = await window.fabula.insertNote(selectedInsert, els.insertNote.value);
  flashInsert(result.ok ? "sent to Claude" : result.error, !result.ok);
});
els.insertClose.addEventListener("click", closeInspector);
els.askSend.addEventListener("click", async () => {
  const result = await window.fabula.ask(els.askText.value);
  els.askStatus.textContent = result.ok ? "sent to Claude" : result.error;
  els.askStatus.classList.toggle("is-error", !result.ok);
  if (result.ok) els.askText.value = "";
});

// ---- Transport ----

const PLAY_ICON = '<svg width="13" height="13" viewBox="0 0 12 12"><path d="M3 1.5v9l7-4.5z" fill="currentColor"></path></svg>';
const PAUSE_ICON = '<svg width="13" height="13" viewBox="0 0 12 12"><rect x="2.4" y="1.8" width="2.6" height="8.4" rx="0.8" fill="currentColor"></rect><rect x="7" y="1.8" width="2.6" height="8.4" rx="0.8" fill="currentColor"></rect></svg>';

els.playpause.addEventListener("click", () => {
  if (els.video.paused) els.video.play();
  else els.video.pause();
});
els.video.addEventListener("play", () => {
  els.playpause.innerHTML = PAUSE_ICON;
  els.playpause.setAttribute("aria-label", "Pause");
});
els.video.addEventListener("pause", () => {
  els.playpause.innerHTML = PLAY_ICON;
  els.playpause.setAttribute("aria-label", "Play");
});
els.video.addEventListener("loadedmetadata", () => {
  if (mode === "scenes" && compose()) { els.timeTotal.textContent = fmt(composeDuration(), false); renderSceneTimeline(); }
  else if (els.video.videoWidth) els.video.closest(".videoframe").style.aspectRatio = `${els.video.videoWidth} / ${els.video.videoHeight}`;
  delete els.guides.dataset.key;
});

function nearestCut(direction) {
  const now = els.video.currentTime;
  const cuts = [...(review()?.cuts ?? [])].sort((a, b) => a.start - b.start);
  if (direction > 0) return cuts.find((cut) => cut.start > now + 0.3);
  return [...cuts].reverse().find((cut) => cut.start < now - 0.3);
}

document.addEventListener("keydown", (event) => {
  const target = event.target;
  const typing = target instanceof HTMLElement && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName) && target.type !== "checkbox";
  if (typing || !state || els.player.hidden) return;
  if (event.code === "Space") {
    event.preventDefault();
    els.playpause.click();
  } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    const step = (event.shiftKey ? 10 : 2) * (event.key === "ArrowLeft" ? -1 : 1);
    seek(els.video.currentTime + step);
  } else if ((event.key === "[" || event.key === "]") && mode === "cut") {
    const cut = nearestCut(event.key === "]" ? 1 : -1);
    if (cut) seek(Math.max(cut.start - 0.6, 0));
  } else if (event.key === "Escape" && (selectedScene !== null || selectedInsert !== null)) {
    closeInspector();
  }
});

// ---- The frame loop ----
//
// Cut: skip enabled cuts, keep both clocks honest, draw the framing guides
// or preview the punch framing. Scenes: paint the overlays the export will
// capture and keep the screen track in step. Both: light the word being
// spoken and move the playhead.
function tick() {
  requestAnimationFrame(tick);
  if (state?.progress?.startedAt && !els.progress.hidden) {
    els.progressClock.textContent = fmt((Date.now() - Date.parse(state.progress.startedAt)) / 1000, false);
  }
  if (!state || els.player.hidden || !onStage()) return;
  const now = els.video.currentTime;
  let total;

  if (mode === "cut") {
    total = review().duration;
    if (els.skipcuts.checked && !els.video.paused) {
      for (const cut of enabledCuts()) {
        if (now >= cut.start && now < cut.end) {
          els.video.currentTime = cut.end + 0.001;
          return; // next frame reads the new position
        }
      }
    }
    let editedNow = now;
    for (const cut of enabledCuts()) {
      if (cut.end <= now) editedNow -= cut.end - cut.start;
      else if (cut.start < now) editedNow -= now - cut.start;
    }
    els.timeNow.textContent = fmt(now);
    els.timeTotal.textContent = `${fmt(Math.max(editedNow, 0))} edited · ${fmt(total, false)} raw`;

    if (review().framing) {
      if (els.video.style.transform) els.video.style.transform = "";
      renderGuides(now);
    } else {
      els.guides.hidden = true;
      let scale = 1;
      for (const shot of review().shots ?? []) {
        if (now >= shot.start && now < shot.end) { scale = shot.scale; break; }
      }
      const transform = scale > 1 ? `scale(${scale})` : "";
      if (els.video.style.transform !== transform) els.video.style.transform = transform;
    }
  } else {
    total = composeDuration();
    els.timeNow.textContent = fmt(now);
    const c = compose();
    if (c.screenUrl) {
      if (Math.abs(els.screen.currentTime - now) > 0.12) els.screen.currentTime = now;
      if (!els.video.paused && els.screen.paused) els.screen.play().catch(() => {});
      if (els.video.paused && !els.screen.paused) els.screen.pause();
    }
    window.FabulaStage.update(els.overlay, els.head, composeForPaint(), now, null, c.screenUrl ? els.screen : null);
  }

  const lane = (mode === "cut" ? els.laneCuts : els.laneScenes).getBoundingClientRect();
  const box = els.timeline.getBoundingClientRect();
  if (lane.width > 0) els.playhead.style.left = `${lane.left - box.left + (now / total) * lane.width}px`;

  let current = null;
  for (const entry of wordSpans) {
    if (entry.word.start <= now && now < entry.word.end + EPSILON) { current = entry.span; break; }
    if (entry.word.start > now) break;
  }
  if (current !== highlighted) {
    highlighted?.classList.remove("is-now");
    current?.classList.add("is-now");
    highlighted = current;
    // Long recordings: keep the spoken word in view while playing, without
    // fighting a reader who has scrolled away while paused.
    if (current && !els.video.paused && !document.body.classList.contains("rail-collapsed")) {
      const rail = els.transcript.getBoundingClientRect();
      const word = current.getBoundingClientRect();
      if (word.top < rail.top + 24 || word.bottom > rail.bottom - 24) current.scrollIntoView({ block: "center" });
    }
  }
}
requestAnimationFrame(tick);

// ---- Ingest: drop anywhere, or pick ----

let dragDepth = 0;
document.addEventListener("dragenter", (event) => {
  event.preventDefault();
  dragDepth += 1;
  els.dropzone.hidden = false;
});
document.addEventListener("dragleave", () => {
  dragDepth = Math.max(dragDepth - 1, 0);
  if (dragDepth === 0) els.dropzone.hidden = true;
});
document.addEventListener("dragover", (event) => event.preventDefault());

function showIngestError(error) {
  els.empty.classList.add("is-error");
  els.emptyLine.textContent = error;
  els.emptyHint.textContent = "Fabula opens mp4, mov, mkv, webm and m4v recordings.";
}

document.addEventListener("drop", async (event) => {
  event.preventDefault();
  dragDepth = 0;
  els.dropzone.hidden = true;
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  const result = await window.fabula.ingestFile(file);
  if (!result.ok) showIngestError(result.error);
});

els.openFile.addEventListener("click", async () => {
  const result = await window.fabula.pickFile();
  if (!result.ok && !result.cancelled) showIngestError(result.error);
});

// ---- State feed ----

window.fabula.getState().then((next) => {
  state = next;
  // Open on the furthest stage the project has reached.
  if (compose()) mode = "scenes";
  render();
});
window.fabula.onState((next) => {
  const projectChanged = state?.project !== next?.project;
  state = next;
  if (projectChanged) { selectedScene = null; selectedInsert = null; userChoseTab = false; scriptOpen = false; mode = compose() ? "scenes" : "cut"; }
  // The engines load async in the main process; when the compose stage
  // arrives late, follow it — unless the user already picked a tab.
  if (!userChoseTab && mode === "cut" && compose()) mode = "scenes";
  render();
});
