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
  openAssistant: $("open-assistant"),
  stages: $("stages"), tabCut: $("tab-cut"), tabLook: $("tab-look"), tabScenes: $("tab-scenes"), tabExport: $("tab-export"),
  progress: $("progress"), progressLabel: $("progress-label"), progressDetail: $("progress-detail"), progressClock: $("progress-clock"),
  session: $("session"), raw: $("stat-raw"), clean: $("stat-clean"),
  empty: $("empty"), emptyLine: $("empty-line"), emptyHint: $("empty-hint"), emptyClose: $("empty-close"), emptyFirstPass: $("empty-firstpass"),
  sumClean: $("sum-clean"),
  inspApprove: $("insp-approve"), approveCut: $("approve-cut"), approveStatus: $("approve-status"),
  assistantSheetTitle: $("assistant-sheet-title"), assistantSheetNote: $("assistant-sheet-note"),
  inspSelection: $("insp-selection"), selSummary: $("sel-summary"), selText: $("sel-text"), selCut: $("sel-cut"), selClear: $("sel-clear"),
  home: $("home"), homeNew: $("home-new"), homeProjectsTitle: $("home-projects-title"), homeProjectsList: $("home-projects-list"),
  homeProjectsEmpty: $("home-projects-empty"), homeStatus: $("home-status"), homeRoot: $("home-root"), homeRootChange: $("home-root-change"), homeRootDefault: $("home-root-default"),
  projectMenu: $("project-menu"), projectName: $("project-name"), projectMenuPop: $("project-menu-pop"),
  menuRename: $("menu-rename"), menuReveal: $("menu-reveal"), menuClose: $("menu-close"), menuAll: $("menu-all"),
  newProject: $("new-project"), newProjectForm: $("new-project-form"), newPath: $("new-path"), newChoose: $("new-choose"), newTitle: $("new-title"), newFormat: $("new-format"), newFormatNote: $("new-format-note"), newNote: $("new-note"), newStatus: $("new-status"), newCancel: $("new-cancel"), newCreate: $("new-create"),
  rename: $("rename"), renameForm: $("rename-form"), renameTitle: $("rename-title"), renameStatus: $("rename-status"), renameCancel: $("rename-cancel"),
  assistant: $("assistant"), assistantForm: $("assistant-form"), assistantModel: $("assistant-model"), assistantCustomWrap: $("assistant-custom-wrap"), assistantCustom: $("assistant-custom"),
  assistantEffort: $("assistant-effort"), assistantPersonas: $("assistant-personas"), assistantStatus: $("assistant-status"), assistantCancel: $("assistant-cancel"), assistantStart: $("assistant-start"),
  assistantPane: $("assistant-pane"), assistantTitle: $("assistant-title"), assistantSub: $("assistant-sub"), assistantStopBtn: $("assistant-stop"),
  assistantAgain: $("assistant-again"), assistantHide: $("assistant-hide"), assistantTerm: $("assistant-term"),
  projects: $("projects"), projectsList: $("projects-list"), projectsNew: $("projects-new"),
  projectsCloseProject: $("projects-close-project"), projectsStatus: $("projects-status"), projectsDismiss: $("projects-dismiss"),
  projectsRoot: $("projects-root"), projectsRootChange: $("projects-root-change"), projectsRootDefault: $("projects-root-default"),
  player: $("player"), dock: $("dock"), dropzone: $("dropzone"),
  look: $("look"), lookPresets: $("look-presets"), lookBrands: $("look-brands"), lookSave: $("look-save"), lookReset: $("look-reset"), lookStatus: $("look-status"),
  exportPage: $("export"), exportMain: $("export-main"),
  toggleRail: $("toggle-rail"), toggleInsp: $("toggle-insp"),
  video: $("video"), head: $("head"), screen: $("screen"), overlay: $("overlay"), guides: $("guides"),
  playpause: $("playpause"), skipwrap: $("skipwrap"), skipcuts: $("skipcuts"),
  scriptToggle: $("script-toggle"), captionsWrap: $("captions-wrap"), stageCaptions: $("stage-captions"),
  timeNow: $("time-now"), timeSep: $("time-sep"), timeTotal: $("time-total"), transportNote: $("transport-note"),
  hint: $("controls-hint"), transcript: $("transcript"),
  timeline: $("timeline"), laneRuler: $("lane-ruler"), dockGrip: $("dock-grip"), assistantDot: $("assistant-dot"),
  trackCuts: $("track-cuts"), laneCuts: $("lane-cuts"),
  trackLayout: $("track-layout"), laneLayout: $("lane-layout"),
  trackScreen: $("track-screen"), laneScreen: $("lane-screen"),
  trackScenes: $("track-scenes"), laneScenes: $("lane-scenes"),
  trackInserts: $("track-inserts"), laneInserts: $("lane-inserts"),
  inspInsert: $("insp-insert"), insertWhy: $("insert-why"), insertOptions: $("insert-options"), insertNone: $("insert-none"),
  insertNote: $("insert-note"), insertNoteSend: $("insert-note-send"), insertClose: $("insert-close"), insertStatus: $("insert-status"),
  playhead: $("tl-playhead"),
  zoomOut: $("zoom-out"), zoomIn: $("zoom-in"), zoomFit: $("zoom-fit"), zoomLevel: $("zoom-level"),
  minimap: $("tl-minimap"), mapInner: $("map-inner"), mapView: $("map-view"), mapHead: $("map-head"),
  inspector: $("inspector"), inspTitle: $("insp-title"), inspProject: $("insp-project"), inspBody: $("insp-body"),
  inspCutSummary: $("insp-cut-summary"), sumCuts: $("sum-cuts"), sumRemoved: $("sum-removed"), sumShots: $("sum-shots"), sumFraming: $("sum-framing"),
  themeAccent: $("theme-accent"), themeAccentValue: $("theme-accent-value"), themeAccent2: $("theme-accent2"), themeAccent2Value: $("theme-accent2-value"),
  lookTitles: $("look-titles"), lookCallouts: $("look-callouts"), lookCaptions: $("look-captions"),
  lookTransitions: $("look-transitions"), lookPunch: $("look-punch"),
  themeFontDisplay: $("theme-font-display"), themeFontBody: $("theme-font-body"), themeFontSerif: $("theme-font-serif"),
  themeTitleCase: $("theme-title-case"), themeRadius: $("theme-radius"), themeRadiusValue: $("theme-radius-value"),
  themeGlow: $("theme-glow"), themeGlowValue: $("theme-glow-value"),
  themeTransitionSeconds: $("theme-transition-seconds"), themeTransitionSecondsValue: $("theme-transition-seconds-value"),
  themeCaptions: $("theme-captions"), captionsNote: $("captions-note"),
  themeLogoPick: $("theme-logo-pick"), themeLogoName: $("theme-logo-name"), themeLogoClear: $("theme-logo-clear"),
  themeLogoCornerWrap: $("theme-logo-corner-wrap"), themeLogoCorner: $("theme-logo-corner"), themeWatermark: $("theme-watermark"),
  inspEmpty: $("insp-empty"), inspKeysCut: $("insp-keys-cut"),
  inspClose: $("insp-close"), inspStatus: $("insp-status"),
  inspText: $("insp-text"), inspTextWrap: $("insp-text-wrap"),
  inspLabel: $("insp-label"), inspLabelWrap: $("insp-label-wrap"),
  inspAccent: $("insp-accent"), inspAccentWrap: $("insp-accent-wrap"), inspAccentClear: $("insp-accent-clear"),
  inspLayout: $("insp-layout"), inspLayoutWrap: $("insp-layout-wrap"),
  inspSubtitle: $("insp-subtitle"), inspSubtitleWrap: $("insp-subtitle-wrap"),
  inspStyle: $("insp-style"), inspStyleWrap: $("insp-style-wrap"),
  inspValue: $("insp-value"), inspValueWrap: $("insp-value-wrap"), inspPrefix: $("insp-prefix"), inspSuffix: $("insp-suffix"),
  inspBy: $("insp-by"), inspByWrap: $("insp-by-wrap"), inspNumber: $("insp-number"), inspNumberWrap: $("insp-number-wrap"),
  inspMotion: $("insp-motion"), inspMotionWrap: $("insp-motion-wrap"),
  inspPicturePick: $("insp-picture-pick"), inspPictureName: $("insp-picture-name"), inspPictureWrap: $("insp-picture-wrap"),
  inspItems: $("insp-items"), inspItemsWrap: $("insp-items-wrap"), inspSpanWords: $("insp-span-words"),
  inspDuplicate: $("insp-duplicate"), inspRemove: $("insp-remove"),
  inspStartBack: $("insp-start-back"), inspStartFwd: $("insp-start-fwd"), inspEndBack: $("insp-end-back"), inspEndFwd: $("insp-end-fwd"),
  inspTransition: $("insp-transition"), inspTransitionWrap: $("insp-transition-wrap"),
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
let shuttle = 0; // J/K/L: negative rates run the picture backwards from the frame loop
let lastTick = 0;

// The timeline window: zoom 1 is the whole film; the lanes show
// [start, start + total / zoom]. One window per stage, reset per project.
const views = { cut: { start: 0, zoom: 1 }, scenes: { start: 0, zoom: 1 } };
let viewProject = null;
const view = () => views[mode === "cut" ? "cut" : "scenes"];
const MIN_VISIBLE_SECONDS = 4;

const CAPTION_NOTES = {
  none: "No captions.",
  open: "Burned into the picture in the style below.",
  closed: "An .srt and a .vtt beside every render. Nothing in the picture.",
  both: "Burned in, and the .srt and .vtt written.",
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
  const layoutTimeline = window.FabulaStageEngine ? window.FabulaStageEngine.resolveLayoutTimeline(scenes, composeDuration(), { transition: c.theme?.transition, transitionSeconds: c.theme?.transitionSeconds }) : c.layoutTimeline;
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

function seek(t, { follow = true } = {}) {
  const total = totalSeconds();
  const at = Math.min(Math.max(t, 0), Math.max(total - 0.05, 0));
  els.video.currentTime = at;
  if (follow) followTime(at);
}

// ---- The timeline window ----

const visibleSeconds = () => totalSeconds() / view().zoom;
const laneBox = () => (mode === "cut" ? els.laneCuts : els.laneScenes).parentElement.getBoundingClientRect();
const timeAtPointer = (clientX) => {
  const box = laneBox();
  const frac = box.width > 0 ? Math.min(Math.max((clientX - box.left) / box.width, 0), 1) : 0;
  return view().start + frac * visibleSeconds();
};

// A moment outside the window pulls the window along: the playhead lands a
// tenth of the way in, so what comes next has room.
function followTime(t) {
  const v = view();
  if (v.zoom <= 1) return;
  const visible = visibleSeconds();
  if (t >= v.start && t <= v.start + visible * 0.97) return;
  v.start = t - visible * 0.1;
  applyView();
}

function setZoom(zoom, anchorTime = null) {
  const v = view();
  const total = totalSeconds();
  const next = Math.min(Math.max(zoom, 1), Math.max(total / MIN_VISIBLE_SECONDS, 1));
  const anchor = anchorTime ?? v.start + visibleSeconds() / 2;
  const frac = visibleSeconds() > 0 ? (anchor - v.start) / visibleSeconds() : 0.5;
  v.zoom = next;
  v.start = anchor - frac * (total / next);
  applyView();
}

let tinyPending = false;
function applyView() {
  const total = totalSeconds();
  if (!total) return;
  const v = view();
  const visible = total / v.zoom;
  v.start = Math.min(Math.max(v.start, 0), Math.max(total - visible, 0));
  const width = `${v.zoom * 100}%`;
  const left = `${-(v.start / total) * v.zoom * 100}%`;
  for (const inner of els.timeline.querySelectorAll(".tl-inner")) {
    if (inner.style.width !== width) inner.style.width = width;
    if (inner.style.left !== left) inner.style.left = left;
  }
  renderRuler(total, v.start, visible);
  els.zoomLevel.textContent = v.zoom <= 1.001 ? "all" : fmt(visible, false);
  els.zoomOut.disabled = v.zoom <= 1.001;
  els.zoomIn.disabled = v.zoom >= Math.max(total / MIN_VISIBLE_SECONDS, 1) - 0.001;
  els.mapView.style.left = `${(v.start / total) * 100}%`;
  els.mapView.style.width = `${(visible / total) * 100}%`;
  els.mapView.classList.toggle("is-all", v.zoom <= 1.001);
  els.playhead.style.top = `${els.laneRuler.parentElement.parentElement.offsetTop}px`;
  if (!tinyPending) {
    tinyPending = true;
    requestAnimationFrame(() => { tinyPending = false; hideTinyLabels(); });
  }
}

// The whole film in one strip: cuts in Cut, the placed layouts and the
// scenes in Scenes. It is the map the window moves over.
function renderMinimap() {
  const total = totalSeconds();
  els.mapInner.replaceChildren();
  const add = (start, end, cls) => {
    const block = document.createElement("div");
    block.className = `tl-map-block ${cls}`;
    block.style.left = `${(start / total) * 100}%`;
    block.style.width = `${Math.max(((end - start) / total) * 100, 0.1)}%`;
    els.mapInner.append(block);
  };
  if (mode === "cut") {
    for (const cut of enabledCuts()) add(cut.start, cut.end, "is-cut");
  } else {
    const c = compose();
    for (const segment of c.layoutTimeline ?? []) if (segment.layout !== "focus") add(segment.start, segment.end, "is-dim");
    for (const span of c.screenSpans ?? []) add(span.start, span.end, "is-screen");
    for (const scene of c.scenes) if (scene.type !== "stage") add(scene.start, scene.end, "");
  }
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
  if (selection && selection.to >= wordSpans.length) selection = null;
  paintSelection();
}

// ---- Cutting by hand ----
//
// Drag across words in the Cut step to select them; the inspector offers to
// cut exactly those words. A plain click still jumps the picture.

let selection = null; // { from, to } as indexes into wordSpans, ordered
let suppressClick = false;

function selectedWords() {
  if (!selection) return [];
  return wordSpans.slice(selection.from, selection.to + 1).map((entry) => entry.word);
}

function paintSelection() {
  wordSpans.forEach((entry, index) => entry.span.classList.toggle("is-selected", Boolean(selection) && index >= selection.from && index <= selection.to));
}

function renderSelection() {
  const words = mode === "cut" ? selectedWords() : [];
  els.inspSelection.hidden = words.length === 0;
  if (words.length === 0) return;
  const seconds = words.at(-1).end - words[0].start;
  els.selSummary.textContent = `${words.length} word${words.length === 1 ? "" : "s"} · ${seconds.toFixed(1)} s`;
  els.selText.textContent = `“${words.map((word) => word.text).join(" ")}”`;
}

function clearSelection() {
  selection = null;
  paintSelection();
  renderSelection();
}

function wordIndexAt(target) {
  const span = target instanceof HTMLElement ? target.closest(".word") : null;
  if (!span) return -1;
  return wordSpans.findIndex((entry) => entry.span === span);
}

els.transcript.addEventListener("pointerdown", (event) => {
  if (mode !== "cut" || event.button !== 0) return;
  const anchor = wordIndexAt(event.target);
  if (anchor < 0) return;
  const startX = event.clientX, startY = event.clientY;
  let dragging = false;
  const move = (e) => {
    if (!dragging && Math.hypot(e.clientX - startX, e.clientY - startY) < 4) return;
    dragging = true;
    els.transcript.classList.add("is-selecting");
    const at = wordIndexAt(document.elementFromPoint(e.clientX, e.clientY));
    if (at < 0) return;
    selection = { from: Math.min(anchor, at), to: Math.max(anchor, at) };
    paintSelection();
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    els.transcript.classList.remove("is-selecting");
    if (dragging) { suppressClick = true; renderSelection(); }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
});

els.selCut.addEventListener("click", async () => {
  const words = selectedWords();
  if (words.length === 0) return;
  const result = await window.fabula.addCut(words.map((word) => word.id));
  if (result.ok) clearSelection();
  else els.selSummary.textContent = result.error;
});
els.selClear.addEventListener("click", clearSelection);
els.emptyFirstPass.addEventListener("click", async () => {
  const result = await window.fabula.render("first", {});
  if (!result.ok) els.emptyHint.textContent = result.error;
});

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
  if (scene.type === "graphic") {
    const name = scene.graphic.template ?? scene.graphic.kind;
    const said = scene.graphic.title ?? scene.graphic.label ?? scene.graphic.params?.title ?? scene.graphic.params?.line ?? scene.graphic.params?.words ?? scene.graphic.params?.term ?? scene.graphic.params?.value;
    return `${name}${said ? ` · ${said}` : ""}`;
  }
  if (scene.type === "kinetic") return "kinetic type";
  return `${scene.type} · ${scene.text ?? ""}`;
}

function rulerStep(total) {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
  return steps.find((step) => total / step <= 9) ?? 3600;
}

let rulerKey = "";
function renderRuler(total, start = 0, visible = total) {
  const step = rulerStep(visible);
  const first = Math.max(Math.floor(start / step) * step, 0);
  const key = `${total}:${step}:${first}:${visible}`;
  if (key === rulerKey) return;
  rulerKey = key;
  els.laneRuler.replaceChildren();
  for (let t = first; t < Math.min(start + visible + step, total - step * 0.3); t += step) {
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
  renderMinimap();
  applyView();
}

// Scenes: one lane for where the head sits, one for the screen track where
// it exists, one for the scenes, one for the insert points. Blocks are
// clickable — seek, select, inspect. A click lands just past the boundary's
// transition (a glide, the longest, is 0.8 s) and a card's entrance, so what
// appears is the settled picture, not the first frame of a change.
const settledAt = (start, end) => start + Math.min(0.9, Math.max((end - start) / 2, 0.05));

function renderSceneTimeline() {
  const c = compose();
  const total = composeDuration();

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
  renderMinimap();
  applyView();
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
window.addEventListener("resize", () => { if (state && onStage()) applyView(); });

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
  els.inspTitle.textContent = state?.title ?? state?.project ?? "";
  els.inspApprove.hidden = mode !== "cut";
  if (mode === "cut") {
    els.inspCutSummary.hidden = false;
    els.inspKeysCut.hidden = false;
    els.approveCut.disabled = Boolean(state?.progress && !(typeof state.progress.detail === "string" && state.progress.detail.startsWith("failed:")));
    const kept = r.cuts.length - enabledCuts().length;
    els.sumCuts.textContent = `${r.cuts.length}${kept ? ` · ${kept} kept` : ""}`;
    els.sumRemoved.textContent = fmt(removedSeconds(), false);
    els.sumShots.textContent = r.shotPlan ? `alternating ${Math.round(r.shotPlan.zoom * 100)}%` : "off";
    els.sumFraming.textContent = describeFraming(r.framing);
    const e = state?.export;
    els.sumClean.textContent = !e?.have?.clean ? "not rendered"
      : e.stale?.["clean.mp4"] ? "out of date" : "up to date";
    els.inspEmpty.textContent = "Click a struck word or pause to keep it. Drag across words to cut them. Click a word to jump there.";
    renderSelection();
  } else {
    els.inspCutSummary.hidden = true;
    els.inspKeysCut.hidden = true;
    els.inspApprove.hidden = true;
    const open = inserts().filter((insert) => !insert.chosen).length;
    els.inspEmpty.textContent = open > 0
      ? `${open} insert point${open === 1 ? "" : "s"} open. Click a + in the transcript or a diamond in the timeline to choose what goes there.`
      : "Click a block in the timeline to edit it. For anything larger, ask the assistant in its pane.";
  }
}

// ---- The Look page ----

// A preset or a brand, drawn small with its own tokens: the field, the
// head's card, a title bar, a caption in its style. Enough to tell them apart.
// ---- Live previews: the film's own painter, at postage-stamp size ----
//
// A dropdown that reads "kicker" or "dissolve" tells nobody what they are
// choosing. Every option in the Look step draws itself instead, on a short
// loop, through exactly the code that draws the film — FabulaStage.plan and
// .paint over the real stylesheet — so a preview cannot drift from the
// render, and a style added to the kit gets a preview for free.

// The gallery's postage stamps are the film's own shape, so a transition or a
// title style is judged where it will actually be seen — a lower third reads
// very differently in a tall frame.
const LANDSCAPE_STAGE = { width: 1920, height: 1080 };
const previewStage = () => state?.format?.stage ?? compose()?.stage ?? LANDSCAPE_STAGE;
const stageAspect = () => { const s = previewStage(); return s.width / s.height; };
const PREVIEW_ASPECT = 16 / 9; // the footage inside the stamp, not the stamp
const PREVIEW_FPS = 24;
const previews = new Set();
let previewFrameHandle = null;
let previewClock = 0;

// A mini stage: the field, a stand-in for the footage, and the overlay.
function previewSurface() {
  const frame = document.createElement("div");
  frame.className = "preview-frame stage-field stage-frame";
  const head = document.createElement("div");
  head.className = "stage-head preview-head";
  const inner = document.createElement("div");
  inner.className = "preview-head-inner";
  inner.innerHTML = '<span class="preview-head-figure"></span>';
  head.append(inner);
  const overlay = document.createElement("div");
  overlay.className = "ov-layer";
  frame.append(head, overlay);
  return { frame, head, overlay };
}

// A timeline written by hand rather than through resolveLayoutTimeline: a
// preview loops in five seconds, and the dwell rule would (rightly) absorb
// shots that short out of a real film.
const previewTimeline = (segments, theme) =>
  segments.map((s) => ({ ...s, transition: theme.transition, transitionSeconds: theme.transitionSeconds }));

// script(t) -> { compose, layout, punch }. Registered previews are painted
// by one loop that only runs while the Look step is showing.
function addPreview(host, loopSeconds, script) {
  const { frame, head, overlay } = previewSurface();
  host.append(frame);
  const preview = { frame, head, overlay, loopSeconds, script };
  previews.add(preview);
  paintPreview(preview, 0);
  return frame;
}

function paintPreview(preview, clock) {
  const t = clock % preview.loopSeconds;
  const { compose, layout, punch } = preview.script(t);
  const plan = window.FabulaStage.plan(compose, t, layout);
  plan.punch = punch ?? 1;
  window.FabulaStage.applyTheme(preview.frame, plan.theme);
  window.FabulaStage.placeMedia(plan, preview.head, null);
  const inner = preview.head.querySelector(".preview-head-inner");
  if (inner) inner.style.transform = plan.punch > 1 ? `scale(${plan.punch})` : "";
  window.FabulaStage.paint(preview.overlay, plan);
}

function runPreviews(on) {
  if (!on) {
    if (previewFrameHandle) cancelAnimationFrame(previewFrameHandle);
    previewFrameHandle = null;
    return;
  }
  if (previewFrameHandle) return;
  let last = performance.now();
  let owed = 0;
  const step = (now) => {
    previewFrameHandle = requestAnimationFrame(step);
    owed += (now - last) / 1000;
    last = now;
    if (owed < 1 / PREVIEW_FPS) return;
    previewClock += owed;
    owed = 0;
    for (const preview of previews) paintPreview(preview, previewClock);
  };
  previewFrameHandle = requestAnimationFrame(step);
}

function clearPreviews(...hosts) {
  for (const preview of [...previews]) {
    if (hosts.some((host) => host.contains(preview.frame))) previews.delete(preview);
  }
}

// ---- The scripts each kind of card plays ----

const previewCompose = (theme, extra = {}) => ({
  stage: previewStage(), theme, scenes: [], captions: null, wordSpans: [], punchSpans: [], ...extra,
});

const layoutOf = (timeline, t) =>
  window.FabulaStageEngine.layoutAt(timeline, t, PREVIEW_ASPECT, previewStage());

// The whole look, one beat at a time: the head alone under a title, then
// the head beside a card. Overlapping them would show a composition no
// assistant would write and make both harder to read at thumbnail size.
function presetScript(theme) {
  const timeline = previewTimeline([
    { start: 0, end: 2.9, layout: "focus" },
    { start: 2.9, end: 6, layout: "side" },
  ], theme);
  const scenes = [
    { type: "title", start: 0.4, end: 2.6, text: "The look", subtitle: "and its second line" },
    { type: "graphic", start: 3.1, end: 6, graphic: { kind: "stat", value: 68, suffix: "%", label: "of the difference" } },
  ];
  const compose = previewCompose(theme, { scenes });
  return (t) => ({ compose, layout: layoutOf(timeline, t) });
}

function titleScript(theme, style) {
  const timeline = previewTimeline([{ start: 0, end: 99, layout: "focus" }], theme);
  const scenes = [{ type: "title", start: 0.35, end: 3.4, style, text: "Your title here", subtitle: "A second line" }];
  const compose = previewCompose(theme, { scenes });
  return (t) => ({ compose, layout: layoutOf(timeline, t) });
}

function calloutScript(theme, style) {
  const timeline = previewTimeline([{ start: 0, end: 99, layout: "side" }], theme);
  const scenes = [{ type: "callout", start: 0.35, end: 3.4, style, text: "Worth saying twice" }];
  const compose = previewCompose(theme, { scenes });
  return (t) => ({ compose, layout: layoutOf(timeline, t) });
}

function captionScript(theme, style) {
  const words = ["Captions", "look", "like", "this"];
  const wordSpans = words.map((text, i) => ({ start: 0.4 + i * 0.5, end: 0.9 + i * 0.5, text }));
  const captions = [{ start: 0.4, end: 3.6, text: words.join(" ") }];
  const timeline = previewTimeline([{ start: 0, end: 99, layout: "focus" }], theme);
  const compose = previewCompose({ ...theme, captionStyle: style }, { captions, wordSpans });
  return (t) => ({ compose, layout: layoutOf(timeline, t) });
}

// Out to a side layout and back, so both directions of the change show.
function transitionScript(theme, transition) {
  const shape = { ...theme, transition };
  const timeline = previewTimeline([
    { start: 0, end: 1.5, layout: "focus" },
    { start: 1.5, end: 3.4, layout: "side" },
    { start: 3.4, end: 5, layout: "focus" },
  ], shape);
  const scenes = [{ type: "graphic", start: 1.5, end: 3.4, graphic: { kind: "list", items: [{ label: "The card" }, { label: "arrives here" }] } }];
  const compose = previewCompose(shape, { scenes });
  return (t) => ({ compose, layout: layoutOf(timeline, t) });
}

// Punch-ins are a step, not a move: two shots, alternating.
function punchScript(theme, zoom) {
  const timeline = previewTimeline([{ start: 0, end: 99, layout: "focus" }], theme);
  const compose = previewCompose(theme);
  return (t) => ({ compose, layout: layoutOf(timeline, t), punch: t > 2 ? zoom : 1 });
}

function lookCard({ id, title, about, active, onPick, action, script, loop = 4 }) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = `look-card${active ? " is-active" : ""}`;
  card.dataset.id = id;
  const stage = document.createElement("div");
  stage.className = "look-card-stage";
  stage.style.aspectRatio = `${previewStage().width} / ${previewStage().height}`;
  card.append(stage);
  if (script) addPreview(stage, loop, script);
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

// What each option is for, in one line. The picture shows what it looks
// like; this says when to reach for it.
const TITLE_ABOUT = {
  rise: "Lifts into place. The safe one.",
  slam: "Lands from large. Emphasis.",
  typewriter: "Types itself out. Technical, dry.",
  wipe: "Revealed left to right off the accent bar.",
  block: "Broadcast lower third: type on an accent block.",
  underline: "A rule draws itself under the words. Editorial.",
  boxed: "Sits in a card, so it reads over any footage.",
  kicker: "A small label above a big line, like a magazine.",
};
const CALLOUT_ABOUT = {
  pill: "A quiet card. Reads as a note.",
  tag: "A solid accent tag. Assertive.",
  stamp: "Outlined, tilted, upper case. A verdict.",
  note: "A sticky note with tape. Informal.",
  bar: "A rule down the left, no card. Least furniture.",
  bubble: "A speech bubble. Friendly, conversational.",
};
const CAPTION_ABOUT = {
  pill: "A rounded plate under the words.",
  band: "A full-width strip. Broadcast.",
  karaoke: "The spoken word lights in the accent.",
  plain: "No plate at all, just weighted type.",
};
const TRANSITION_ABOUT = {
  glide: "The head travels between layouts. It still fades where there is nothing to fly to — into and out of a cutaway.",
  dissolve: "The head fades out, the arrangement changes, it fades back. Nothing slides.",
  cut: "Everything changes on one frame.",
};
const PUNCH_ABOUT = {
  "": "Every kept segment at the same size.",
  1.1: "Barely there. Hides a jump cut without being noticed.",
  1.15: "The usual amount.",
  1.25: "Obvious. Two cameras, effectively.",
};

const fillOptions = (select, values, current) => {
  select.replaceChildren(...values.map((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    return option;
  }));
  select.value = current;
};

function renderLookPage() {
  const l = look();
  if (!l) return;
  const theme = l.theme;
  const config = l.themeConfig;
  clearPreviews(els.lookPresets, els.lookBrands, els.lookTitles, els.lookCallouts, els.lookCaptions, els.lookTransitions, els.lookPunch);

  // Each preset card plays that preset, not the project's theme: the point
  // is to show what picking it would do.
  els.lookPresets.replaceChildren(...l.presets.map((p) => lookCard({
    id: p.id, title: p.label, about: p.about, active: theme.preset === p.id,
    script: presetScript(l.presetThemes?.[p.id] ?? theme), loop: 6,
    onPick: () => window.fabula.setProject({ theme: { preset: p.id } }),
  })));

  const brands = l.savedThemes.map((s) => lookCard({
    id: s.id, title: s.name, active: false, action: "Use this brand",
    about: `${s.theme.preset} · ${s.theme.transition} · ${s.theme.captionStyle} captions`,
    script: presetScript(s.theme), loop: 6,
    onPick: () => window.fabula.setProject({ themeUse: s.id }),
  }));
  if (brands.length === 0) {
    const none = document.createElement("p");
    none.className = "look-none";
    none.textContent = "No brands saved. Get the look right, then Save as brand — the next film starts from it in one click.";
    els.lookBrands.replaceChildren(none);
  } else {
    els.lookBrands.replaceChildren(...brands);
  }

  // The option galleries all play the PROJECT's theme with one token
  // swapped, so a choice is shown in the colours it will actually wear.
  els.lookTitles.replaceChildren(...l.titleStyles.map((style) => lookCard({
    id: style, title: style, about: TITLE_ABOUT[style], active: theme.titleStyle === style, loop: 4,
    script: titleScript({ ...theme, titleStyle: style }, style),
    onPick: () => window.fabula.setProject({ theme: { titleStyle: style } }),
  })));
  els.lookCallouts.replaceChildren(...l.calloutStyles.map((style) => lookCard({
    id: style, title: style, about: CALLOUT_ABOUT[style], active: theme.calloutStyle === style, loop: 4,
    script: calloutScript({ ...theme, calloutStyle: style }, style),
    onPick: () => window.fabula.setProject({ theme: { calloutStyle: style } }),
  })));
  els.lookCaptions.replaceChildren(...l.captionStyles.filter((style) => style !== "none").map((style) => lookCard({
    id: style, title: style, about: CAPTION_ABOUT[style], active: theme.captionStyle === style, loop: 4,
    script: captionScript(theme, style),
    onPick: () => window.fabula.setProject({ theme: { captionStyle: style } }),
  })));
  els.lookTransitions.replaceChildren(...l.transitions.map((value) => lookCard({
    id: value, title: value, about: TRANSITION_ABOUT[value], active: theme.transition === value, loop: 5,
    script: transitionScript(theme, value),
    onPick: () => window.fabula.setProject({ theme: { transition: value } }),
  })));
  const zoom = l.punch?.zoom ?? null;
  els.lookPunch.replaceChildren(...[null, 1.1, 1.15, 1.25].map((value) => lookCard({
    id: String(value ?? "off"), title: value ? `${Math.round(value * 100)}%` : "off",
    about: PUNCH_ABOUT[value ?? ""], active: (zoom ?? null) === value, loop: 4,
    script: punchScript(theme, value ?? 1),
    onPick: () => window.fabula.setProject({ punch: value }),
  })));

  els.themeAccent.value = theme.accent;
  els.themeAccentValue.textContent = theme.accent;
  els.themeAccent2.value = theme.accent2;
  els.themeAccent2Value.textContent = theme.accent2;
  for (const [el, key] of [[els.themeFontDisplay, "display"], [els.themeFontBody, "body"], [els.themeFontSerif, "serif"]]) {
    fillOptions(el, l.fonts, theme.fonts[key]);
  }
  els.themeTitleCase.value = theme.titleCase;
  els.themeRadius.value = String(theme.radius);
  els.themeRadiusValue.textContent = theme.radius === 0 ? "square" : `${theme.radius.toFixed(1)}×`;
  els.themeGlow.value = String(theme.glow);
  els.themeGlowValue.textContent = theme.glow === 0 ? "none" : `${Math.round(theme.glow * 100)}%`;
  els.themeTransitionSeconds.value = String(theme.transitionSeconds);
  els.themeTransitionSecondsValue.textContent = theme.transition === "cut" ? "n/a" : `${theme.transitionSeconds.toFixed(1)} s`;
  els.themeTransitionSeconds.disabled = theme.transition === "cut";
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

// ---- Export ----
//
// The renders start here with the same job specs the MCP tools use, the
// page says what is out of date and why, and every file the renders wrote
// is a click from the system player or its folder.

const esc = (text) => String(text ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// A path shortened from the front: the end is what identifies it.
const shortPath = (text, max = 46) => {
  const value = String(text ?? "");
  return value.length <= max ? value : `…${value.slice(-(max - 1))}`;
};
const fmtBytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.max(Math.round(n / 1e3), 1)} KB`);
const fmtWhen = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? `today ${time}` : `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
};
const STAGE_NAMES = { first_pass: "The first pass", render_clean: "The clean cut", render_final: "The film", transcribe: "The transcript", retranscribe: "The clean transcript", refresh_clean: "The clean cut", framing: "The framing scan" };
const KIND_LABELS = { film: "film", draft: "draft", clean: "clean cut", preview: "preview", captions: "captions", thumbnail: "thumbnail", chapters: "chapters", credits: "credits" };
const CAPTION_FILES = {
  none: "No captions.",
  open: "Captions burned into the picture. The Look step sets the style.",
  closed: "Captions written beside the film as final.srt and final.vtt.",
  both: "Captions burned in, and written as final.srt and final.vtt.",
};
let exportFlash = null; // { text, isError } from the last action on the page

function make(tag, className = "", html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

function actionButton(label, onClick, { primary = false, small = false, disabled = false, title = "" } = {}) {
  const b = make("button", `button${primary ? " is-primary" : ""}${small ? " is-small" : ""}`);
  b.type = "button";
  b.textContent = label;
  b.disabled = disabled;
  if (title) b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

async function startRender(kind, options = {}) {
  exportFlash = null;
  const result = await window.fabula.render(kind, options);
  if (!result.ok) { exportFlash = { text: result.error, isError: true }; renderExportPage(); }
}

async function reanchorScenes() {
  const r = await window.fabula.reanchor();
  exportFlash = r.ok
    ? { text: `Moved ${r.moved} scene${r.moved === 1 ? "" : "s"} onto the new transcript${r.unresolved.length ? `; ${r.unresolved.length} could not be placed — ask the assistant to place ${r.unresolved.length === 1 ? "it" : "them"}` : ""}.` }
    : { text: r.error, isError: true };
  renderExportPage();
}

function renderExportPage() {
  const e = state?.export;
  els.exportMain.replaceChildren();
  els.exportMain.append(make("div", "page-head", "<h2>Export</h2><p class=\"page-lede\">The film re-renders only the parts that changed.</p>"));
  if (!e) { els.exportMain.append(make("p", "field-note", "Nothing to export yet.")); return; }
  const stale = Object.fromEntries(e.stale.map((s) => [s.artifact, s]));
  const busy = Boolean(e.running);

  if (e.running) {
    const card = make("div", "export-card is-busy");
    card.append(make("div", "export-card-head", `<span class="export-spinner"></span><b>${esc(e.running.label)}</b><span class="export-clock" id="export-clock"></span>`));
    card.append(make("p", "export-detail", esc(e.running.detail ?? "")));
    card.append(make("p", "field-note", `Logging to out/${esc(e.running.stage)}.log. It keeps running if this window closes.`));
    els.exportMain.append(card);
  } else if (e.lastFailure) {
    const card = make("div", "export-card is-failed");
    card.append(make("div", "export-card-head", `<b>${esc(STAGE_NAMES[e.lastFailure.stage] ?? e.lastFailure.stage)} failed</b>`));
    card.append(make("p", "export-detail", esc(e.lastFailure.error)));
    const row = make("div", "export-actions");
    row.append(actionButton("Show log", () => window.fabula.reveal(e.lastFailure.log), { small: true }));
    card.append(row);
    els.exportMain.append(card);
  }
  if (exportFlash) els.exportMain.append(make("p", `export-flash${exportFlash.isError ? " is-error" : ""}`, esc(exportFlash.text)));

  // The film.
  const film = make("section", "export-card");
  film.append(make("h3", "", "Film"));
  const final = e.outputs.find((o) => o.kind === "film");
  let status;
  if (final && stale["final.mp4"]) status = `Rendered ${fmtWhen(final.modifiedAt)}, ${fmtBytes(final.bytes)}. Out of date: ${stale["final.mp4"].because}.`;
  else if (final) status = `Rendered ${fmtWhen(final.modifiedAt)}, ${fmtBytes(final.bytes)}. Up to date.`;
  else if (!e.have.clean) status = "Needs the clean cut first.";
  else if (!e.have.cleanTranscript) status = "Needs the clean cut's transcript; refresh the clean cut below.";
  else if (!e.have.scenes) status = "No scenes yet. The assistant plans them.";
  else status = "Not rendered yet.";
  film.append(make("p", `export-status${final && stale["final.mp4"] ? " is-stale" : ""}`, esc(status)));
  const filmRow = make("div", "export-actions");
  filmRow.append(actionButton(final ? "Render the film again" : "Render the film", () => startRender("final"), { primary: true, disabled: busy || !e.canRenderFinal }));
  if (final) {
    filmRow.append(actionButton("Render from scratch", () => startRender("final", { fresh: true }), { small: true, disabled: busy, title: "Ignore the cached chunks and render every one again" }));
    filmRow.append(actionButton("Play", () => window.fabula.openOutput(final.path), { small: true }));
    filmRow.append(actionButton("Show in folder", () => window.fabula.reveal(final.path), { small: true }));
  }
  film.append(filmRow);
  film.append(make("p", "field-note", esc(CAPTION_FILES[e.captionMode] ?? "")));
  els.exportMain.append(film);

  // The clean cut.
  const clean = make("section", "export-card");
  clean.append(make("h3", "", "Clean cut"));
  const problems = ["clean.mp4", "clean.json", "compose.json"].filter((k) => stale[k]).map((k) => stale[k]);
  let cleanStatus;
  if (!e.have.review) cleanStatus = "Nothing to cut yet.";
  else if (!e.clean) cleanStatus = "Not rendered yet.";
  else cleanStatus = `Rendered ${fmtWhen(e.clean.renderedAt)}, ${fmtBytes(e.clean.bytes)}, ${e.clean.encoder ?? ""}${e.clean.pieces ? `, ${e.clean.pieces} pieces` : ""}.${problems.length ? "" : " Up to date."}`;
  clean.append(make("p", `export-status${problems.length ? " is-stale" : ""}`, esc(cleanStatus)));
  if (problems.length) {
    const list = make("ul", "export-stale");
    for (const p of problems) list.append(make("li", "", `<b>${esc(p.artifact)}</b> — ${esc(p.because)}`));
    clean.append(list);
  }
  const cleanRow = make("div", "export-actions");
  const cleanStale = Boolean(stale["clean.mp4"] || stale["clean.json"]);
  cleanRow.append(actionButton(e.clean ? "Refresh the clean cut" : "Render the clean cut", () => startRender("refresh"), {
    primary: !e.clean || cleanStale, disabled: busy || !e.canRefreshClean,
    title: "Renders the cut and transcribes it; each part is skipped when it is already current",
  }));
  if (stale["compose.json"]) {
    cleanRow.append(actionButton("Re-anchor scenes", reanchorScenes, { small: true, disabled: busy || !e.have.previousTranscript, title: "Move every scene onto the new transcript's words" }));
  }
  clean.append(cleanRow);
  clean.append(make("p", "field-note", "Needed only after the cuts or the framing change."));
  els.exportMain.append(clean);

  // Shorts cut out of this film.
  els.exportMain.append(shortsCard(e, busy));

  // Files.
  const files = make("section", "export-card");
  files.append(make("h3", "", "Files"));
  if (e.outputs.length === 0) {
    files.append(make("p", "field-note", `Nothing written yet. Renders land in ${esc(state.projectsRoot?.local ?? "media")}${esc(state.projectsRoot?.local?.includes("\\") ? "\\" : "/")}${esc(state.project)}/out/.`));
  } else {
    const table = make("table", "export-files");
    for (const o of e.outputs) {
      const tr = make("tr");
      tr.append(make("td", "export-file-name", `<span class="export-kind is-${o.kind}">${KIND_LABELS[o.kind]}</span>${esc(o.name)}`));
      tr.append(make("td", "export-file-meta", `${fmtBytes(o.bytes)} · ${fmtWhen(o.modifiedAt)}`));
      const td = make("td", "export-file-actions");
      if (o.kind !== "captions") td.append(actionButton(["thumbnail", "chapters", "credits"].includes(o.kind) ? "Open" : "Play", () => window.fabula.openOutput(o.path), { small: true }));
      td.append(actionButton("Show in folder", () => window.fabula.reveal(o.path), { small: true }));
      tr.append(td);
      table.append(tr);
    }
    files.append(table);
  }
  els.exportMain.append(files);
}

// ---- Shorts ----
//
// A short is not a slice of the film: it is a piece that happens to have been
// said inside it. Fabula reads the transcript for moments that could stand
// alone and shows the WORDS — the shortlist is only useful if the person can
// read what they would be publishing before they make it.
let clipFinding = null;
let clipResult = null;
let clipError = null;
let clipBusy = null;

async function findShorts(format) {
  clipFinding = format;
  clipError = null;
  renderExportPage();
  const found = await window.fabula.suggestClips(format);
  clipFinding = null;
  if (found.ok) { clipResult = found; clipError = null; }
  else { clipResult = null; clipError = found.error; }
  renderExportPage();
}

async function makeShort(clip, format) {
  clipBusy = clip.index;
  renderExportPage();
  const made = await window.fabula.createShort({ fromWordId: clip.fromWordId, toWordId: clip.toWordId, format });
  clipBusy = null;
  if (made.ok) {
    // The film stays open. The short is a project of its own and it is the
    // person's to open when they are ready for it.
    clipResult = { ...clipResult, clips: clipResult.clips.filter((c) => c.index !== clip.index) };
    exportFlash = { text: `“${made.title}” created — ${made.seconds}s, ${made.format}. Open it from Projects, then refresh its clean cut.` };
  } else {
    exportFlash = { text: made.error, isError: true };
  }
  renderExportPage();
}

function shortsCard(e, busy) {
  const card = make("section", "export-card");
  card.append(make("h3", "", "Shorts"));
  const short = (state?.formats ?? []).filter((format) => format.shortForm);
  const target = short[0]?.id ?? "vertical";
  if (state?.format?.shortForm) {
    card.append(make("p", "field-note", "This is already a short. Shorts are cut out of a long film."));
    return card;
  }
  if (!e.have.cleanTranscript) {
    card.append(make("p", "field-note", "Needs the clean cut's transcript: a short is chosen on the words, so the film has to be cut first."));
    return card;
  }
  card.append(make("p", "export-status", "Moments in this film that could stand on their own, cut into projects of their own — same recording, same cut, framed and composed for a tall frame."));
  const row = make("div", "export-actions");
  row.append(actionButton(clipFinding ? "Reading the transcript…" : (clipResult ? "Look again" : "Find shorts"), () => findShorts(target), {
    primary: !clipResult, disabled: busy || Boolean(clipFinding),
  }));
  card.append(row);
  if (clipError) card.append(make("p", "export-flash is-error", esc(clipError)));
  if (!clipResult) return card;
  if (clipResult.clips.length === 0) {
    card.append(make("p", "field-note", "Nothing in this film holds together on its own at that length. That is a real answer about the film, not a failure to look."));
    return card;
  }
  const list = make("ul", "clips");
  for (const clip of clipResult.clips) {
    const item = make("li", "clip");
    item.append(make("div", "clip-head", `<b>${fmt(clip.start, false)}</b><span class="clip-len">${clip.seconds}s · ${clip.sentences} sentence${clip.sentences === 1 ? "" : "s"}</span>`));
    item.append(make("p", "clip-text", esc(clip.text)));
    if (clip.notes.length) {
      const notes = make("ul", "clip-notes");
      for (const note of clip.notes) notes.append(make("li", "", esc(note)));
      item.append(notes);
    }
    const actions = make("div", "export-actions");
    actions.append(actionButton(clipBusy === clip.index ? "Making…" : `Make a ${target} short`, () => makeShort(clip, target), {
      small: true, disabled: busy || clipBusy !== null,
    }));
    actions.append(actionButton("Watch it", () => {
      // The clean cut is what plays in Scenes, and the clip's times are on
      // that timeline: go there and start from its first word.
      setMode("scenes");
      seek(clip.start);
      els.video.play().catch(() => {});
    }, { small: true, title: "Play this span in the Scenes step" }));
    item.append(actions);
    list.append(item);
  }
  card.append(list);
  card.append(make("p", "field-note", "Each one becomes a project you compose separately. The assistant can do the same with suggest_clips and create_short, and will argue with the shortlist."));
  return card;
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
  els.insertStatus.textContent = insert.chosen === "other" ? "Sent" : "";
  els.insertStatus.classList.remove("is-error");
}

function flashInsert(text, isError = false) {
  els.insertStatus.textContent = text;
  els.insertStatus.classList.toggle("is-error", isError);
}

// Which card kinds carry which field. The inspector shows a control only
// where the engine would accept it, so nothing on screen is a dead end.
const KIND_FIELDS = {
  label: ["image", "screen", "stat", "ring"],
  value: ["stat", "ring"],
  by: ["quote"],
  number: ["section"],
  motion: ["image"],
  picture: ["image", "cover"],
  items: ["chart", "list", "steps"],
  text: ["quote"],
};
const kindHas = (scene, field) => scene.type === "graphic" && KIND_FIELDS[field].includes(scene.graphic?.kind);

// Rows as text, one per line, "Label = 42" where a value is wanted. The
// shortest editor that covers a chart, a list and a set of steps.
const itemsToText = (items = []) => items.map((i) => (typeof i.value === "number" ? `${i.label} = ${i.value}` : i.label)).join("\n");
const textToItems = (text, needValue) => text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
  const match = /^(.*?)\s*=\s*(-?[\d.]+)$/.exec(line);
  if (match) return { label: match[1].trim(), value: Number(match[2]) };
  return needValue ? { label: line, value: 0 } : { label: line };
});

const fillSelect = (select, values, current, blank) => {
  const options = (blank ? [["", blank]] : []).concat(values.map((v) => [v, v]));
  select.replaceChildren(...options.map(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    return option;
  }));
  select.value = current ?? "";
};

// A template's fields, as inputs. Text and numbers are inputs, a choice is a
// select, items are lines — "label" or "label | value" — and every change
// re-renders the template through the same function the server uses, so
// what the inspector writes is exactly what set_scenes would have written.
const templateEls = () => ({ wrap: $("insp-template-wrap"), head: $("insp-template-head"), fields: $("insp-template-fields"), note: $("insp-template-note") });
const itemsToLines = (items = []) => items.map((i) => (i.value !== undefined && i.value !== "" ? `${i.label} | ${i.value}` : i.label)).join("\n");
const linesToItems = (text, valueKind) => text.split("\n").map((l) => l.trim()).filter(Boolean).map((line) => {
  const at = line.lastIndexOf("|");
  if (at === -1) return { label: line };
  const label = line.slice(0, at).trim();
  const raw = line.slice(at + 1).trim();
  return { label, value: valueKind === "a number" ? Number(raw) : raw };
});

function renderTemplateEditor(scene) {
  const t = templateEls();
  const id = scene.graphic?.template;
  const spec = id && window.FabulaTemplates ? window.FabulaTemplates.describe(id) : null;
  t.wrap.hidden = !spec;
  if (!spec) return;
  t.head.textContent = `${spec.label} · ${spec.about}`;
  t.note.textContent = "";
  const params = scene.graphic.params ?? {};
  t.fields.replaceChildren();
  for (const [name, field] of Object.entries(spec.fields)) {
    const label = document.createElement("label");
    label.className = "insp-field";
    label.append(`${name}${field.required ? "" : " (optional)"}`);
    let input;
    if (field.type === "choice") {
      input = document.createElement("select");
      fillSelect(input, field.options, params[name] ?? field.default, null);
    } else if (field.type === "items") {
      input = document.createElement("textarea");
      input.rows = 4;
      input.spellcheck = false;
      input.placeholder = field.value ? `one per line: label | ${field.value === "a number" ? "42" : "value"}` : "one per line";
      input.value = itemsToLines(params[name]);
    } else if (field.type === "number") {
      input = document.createElement("input");
      input.type = "number";
      if (field.min !== undefined) input.min = field.min;
      if (field.max !== undefined) input.max = field.max;
      input.value = params[name] ?? "";
    } else {
      input = document.createElement(field.max > 60 ? "textarea" : "input");
      if (field.max > 60) { input.rows = 2; input.spellcheck = true; }
      input.maxLength = field.max;
      input.value = params[name] ?? "";
    }
    input.dataset.field = name;
    input.title = field.about;
    input.addEventListener("change", () => commitTemplate(scene.graphic.template, spec));
    label.append(input);
    t.fields.append(label);
  }
}

async function commitTemplate(id, spec) {
  const t = templateEls();
  const params = {};
  for (const input of t.fields.querySelectorAll("[data-field]")) {
    const field = spec.fields[input.dataset.field];
    const value = input.value;
    if (field.type === "items") params[input.dataset.field] = linesToItems(value, field.value);
    else if (field.type === "number") { if (value !== "") params[input.dataset.field] = Number(value); }
    else if (value !== "") params[input.dataset.field] = value;
  }
  const format = state?.format?.id ?? "landscape";
  const result = window.FabulaTemplates.render(id, params, { format });
  if (!result.ok) { t.note.textContent = result.error; return; }
  t.note.textContent = "";
  const { html, css, params: checked, full } = result.graphic;
  await patchScene({ graphic: { params: checked, html, css, full } });
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
  const kind = scene.type === "graphic" ? `${scene.type} · ${scene.graphic?.template ? `${scene.graphic.template} (template)` : scene.graphic?.kind}` : scene.type;
  els.inspTitle.textContent = `${kind} · ${fmt(scene.start)}–${fmt(scene.end)}`;
  renderTemplateEditor(scene);

  const hasText = scene.type === "title" || scene.type === "callout" || kindHas(scene, "text");
  els.inspTextWrap.hidden = !hasText;
  els.inspText.value = hasText ? (scene.text ?? scene.graphic?.text ?? "") : "";

  els.inspSubtitleWrap.hidden = !(scene.type === "title" || ["cover", "section"].includes(scene.graphic?.kind));
  els.inspSubtitle.value = scene.subtitle ?? scene.graphic?.subtitle ?? "";

  // A per-scene style override; blank means "whatever the film says".
  const styles = scene.type === "title" ? look()?.titleStyles : scene.type === "callout" ? look()?.calloutStyles : null;
  els.inspStyleWrap.hidden = !styles;
  if (styles) fillSelect(els.inspStyle, styles, scene.style, "the film's");

  const hasLabel = kindHas(scene, "label");
  els.inspLabelWrap.hidden = !hasLabel;
  els.inspLabel.value = hasLabel ? (scene.graphic.label ?? "") : "";

  els.inspValueWrap.hidden = !kindHas(scene, "value");
  if (kindHas(scene, "value")) {
    els.inspValue.value = String(scene.graphic.value ?? 0);
    els.inspPrefix.value = scene.graphic.prefix ?? "";
    els.inspSuffix.value = scene.graphic.suffix ?? "";
  }
  els.inspByWrap.hidden = !kindHas(scene, "by");
  els.inspBy.value = scene.graphic?.by ?? "";
  els.inspNumberWrap.hidden = !kindHas(scene, "number");
  els.inspNumber.value = scene.graphic?.number ?? "";
  els.inspMotionWrap.hidden = !kindHas(scene, "motion");
  if (kindHas(scene, "motion")) fillSelect(els.inspMotion, look()?.imageMotions ?? [], scene.graphic.motion, "tilt (default)");
  els.inspPictureWrap.hidden = !kindHas(scene, "picture");
  els.inspPictureName.textContent = scene.graphic?.src?.replace(/^assets\//, "") ?? "none";
  els.inspItemsWrap.hidden = !kindHas(scene, "items");
  if (kindHas(scene, "items") && document.activeElement !== els.inspItems) {
    els.inspItems.value = itemsToText(scene.graphic.items);
  }

  const isStage = scene.type === "stage";
  els.inspAccentWrap.hidden = isStage;
  els.inspAccent.value = scene.accent ?? compose()?.theme?.accent ?? "#d97757";
  els.inspAccentClear.hidden = !scene.accent;
  els.inspLayoutWrap.hidden = !isStage;
  els.inspTransitionWrap.hidden = !isStage;
  els.inspCornerWrap.hidden = !isStage || (scene.layout !== "pip" && scene.layout !== "full");
  if (isStage) {
    els.inspLayout.value = scene.layout;
    els.inspCorner.value = scene.corner ?? "br";
    els.inspTransition.value = scene.transition ?? "";
  }
  els.inspFlairWrap.hidden = scene.type !== "title";
  els.inspFlair.checked = Boolean(scene.flair);
  const words = compose()?.words ?? [];
  els.inspSpanWords.textContent = `words ${scene.fromWordId}–${scene.toWordId} of ${Math.max(words.length - 1, 0)} · ${(scene.end - scene.start).toFixed(1)} s`;
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

// The frame's aspect is one CSS variable the stylesheet sizes from (width
// or height, whichever the well constrains). Null means the 16:9 stage.
function setFrameAspect(frame, ratio) {
  if (ratio && Number.isFinite(ratio)) frame.style.setProperty("--ar", ratio.toFixed(5));
  else frame.style.removeProperty("--ar");
}

function setMode(next) {
  if (next === "scenes" && !compose()) next = "cut";
  if (next !== mode) exportFlash = null;
  mode = next;
  render();
}

function render() {
  renderProgress();
  if (state?.project !== viewProject) {
    viewProject = state?.project ?? null;
    views.cut = { start: 0, zoom: 1 };
    views.scenes = { start: 0, zoom: 1 };
    rulerKey = "";
  }
  els.projectMenu.hidden = !state?.project;
  els.projectName.textContent = state?.title ?? state?.project ?? "";
  const editing = Boolean(review());
  els.toggleRail.hidden = !editing;
  els.toggleInsp.hidden = !editing;
  if (!state?.project) els.projectMenuPop.hidden = true;
  if (els.projects.open) renderProjectsDialog();
  if (!review()) {
    els.session.hidden = true;
    els.stages.hidden = true;
    els.player.hidden = true;
    els.dock.hidden = true;
    els.look.hidden = true;
    els.exportPage.hidden = true;
    const pending = Boolean(state?.project && state?.pending);
    els.home.hidden = pending;
    els.empty.hidden = !pending;
    if (pending) {
      els.emptyLine.textContent = state.pending.title ?? state.pending.project;
      const p = state.progress;
      const failed = p && typeof p.detail === "string" && p.detail.startsWith("failed:");
      const running = p && !failed;
      els.emptyHint.textContent = running
        ? `${p.label}${p.detail ? `: ${p.detail}` : ""}. The transcript and the proposed cuts appear here as soon as they land.`
        : failed
          ? `The first pass failed: ${p.detail.slice(8)}`
          : `${state.pending.videoName}. The first pass transcribes the recording, finds the head in the frame and proposes cuts.`;
      els.emptyFirstPass.hidden = Boolean(running);
      els.emptyFirstPass.textContent = failed ? "Run the first pass again" : "Run the first pass";
    } else {
      renderHome();
    }
    return;
  }
  els.home.hidden = true;
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
  // The previews only run while they are on screen; three dozen animated
  // stages are not worth a frame of the player's time.
  runPreviews(mode === "look");
  if (mode === "look") { renderLookPage(); els.player.hidden = true; els.dock.hidden = true; return; }
  if (mode === "export") { renderExportPage(); els.player.hidden = true; els.dock.hidden = true; return; }

  const frame = els.video.closest(".videoframe"); // the head card wraps the video
  els.scriptToggle.hidden = mode !== "scenes";
  els.captionsWrap.hidden = mode !== "scenes";
  if (mode === "cut") {
    document.body.classList.toggle("rail-collapsed", !railWanted);
    setSource(review().videoUrl);
    els.skipwrap.hidden = false;
    els.hint.textContent = "Click a word to jump there. Click anything struck to keep it. Drag to select and cut.";
    els.overlay.replaceChildren();
    delete els.overlay.dataset.state;
    frame.classList.remove("is-stage", "stage-field");
    // The frame is a size container (cq units); the raw footage's own aspect
    // gives it a size, since its contents cannot.
    setFrameAspect(frame, els.video.videoWidth ? els.video.videoWidth / els.video.videoHeight : null);
    els.head.style.left = els.head.style.top = "";
    els.head.style.width = els.head.style.height = "";
    els.head.style.borderRadius = "";
    els.video.style.transform = "";
    els.screen.hidden = true;
    els.screen.pause();
    els.trackCuts.hidden = false;
    els.trackLayout.hidden = els.trackScreen.hidden = els.trackScenes.hidden = els.trackInserts.hidden = true;
    els.timeTotal.textContent = `${fmt(review().duration, false)} raw`;
    els.transportNote.textContent = review().shots ? "Guides show the crop." : "";
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
    setFrameAspect(frame, stageAspect());
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
  if (suppressClick) { suppressClick = false; return; }
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
});

// Drag on the ruler or a lane's background scrubs: the picture follows the
// pointer, paused while the finger is down, and resumes if it was playing.
let scrub = null;
els.timeline.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  const target = event.target;
  if (!(target instanceof HTMLElement) || target.dataset.seek !== undefined || target.dataset.insert !== undefined) return;
  if (!target.closest(".tl-lane, .tl-ruler")) return;
  scrub = { wasPlaying: !els.video.paused, pointerId: event.pointerId };
  stopShuttle();
  if (scrub.wasPlaying) els.video.pause();
  els.timeline.setPointerCapture(event.pointerId);
  document.body.classList.add("is-scrubbing");
  seek(timeAtPointer(event.clientX), { follow: false });
  event.preventDefault();
});
els.timeline.addEventListener("pointermove", (event) => {
  if (!scrub || event.pointerId !== scrub.pointerId) return;
  seek(timeAtPointer(event.clientX), { follow: false });
});
const endScrub = (event) => {
  if (!scrub || event.pointerId !== scrub.pointerId) return;
  document.body.classList.remove("is-scrubbing");
  if (scrub.wasPlaying) els.video.play().catch(() => {});
  scrub = null;
};
els.timeline.addEventListener("pointerup", endScrub);
els.timeline.addEventListener("pointercancel", endScrub);

// Wheel over the timeline: ctrl (or a pinch) zooms around the pointer; a
// plain wheel pans a zoomed window.
els.timeline.addEventListener("wheel", (event) => {
  if (!state || !onStage()) return;
  const v = view();
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault();
    const overLane = event.target instanceof HTMLElement && event.target.closest(".tl-lane, .tl-ruler");
    setZoom(v.zoom * Math.exp(-event.deltaY * 0.0025), overLane ? timeAtPointer(event.clientX) : null);
    return;
  }
  if (v.zoom <= 1) return;
  event.preventDefault();
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  const box = laneBox();
  if (box.width > 0) { v.start += (delta / box.width) * visibleSeconds(); applyView(); }
}, { passive: false });

els.zoomIn.addEventListener("click", () => setZoom(view().zoom * 2, els.video.currentTime));
els.zoomOut.addEventListener("click", () => setZoom(view().zoom / 2, els.video.currentTime));
els.zoomFit.addEventListener("click", () => setZoom(1));

// Minimap: drag the window to pan; click anywhere else to go there.
let panning = null;
const mapTime = (clientX) => {
  const box = els.minimap.getBoundingClientRect();
  return Math.min(Math.max((clientX - box.left) / box.width, 0), 1) * totalSeconds();
};
els.minimap.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !state || !onStage()) return;
  const v = view();
  const at = mapTime(event.clientX);
  if (event.target === els.mapView && v.zoom > 1) {
    panning = { pointerId: event.pointerId, offset: at - v.start };
    els.minimap.setPointerCapture(event.pointerId);
    document.body.classList.add("is-panning");
  } else {
    if (v.zoom > 1) { v.start = at - visibleSeconds() / 2; applyView(); }
    seek(at, { follow: false });
  }
  event.preventDefault();
});
els.minimap.addEventListener("pointermove", (event) => {
  if (!panning || event.pointerId !== panning.pointerId) return;
  view().start = mapTime(event.clientX) - panning.offset;
  applyView();
});
const endPan = (event) => {
  if (!panning || event.pointerId !== panning.pointerId) return;
  document.body.classList.remove("is-panning");
  panning = null;
};
els.minimap.addEventListener("pointerup", endPan);
els.minimap.addEventListener("pointercancel", endPan);

// Inspector: every control applies as it changes. Text applies on Enter or
// when focus leaves, so half a word never hits the plan.
els.inspClose.addEventListener("click", closeInspector);
els.inspAccent.addEventListener("change", () => { els.inspAccentClear.hidden = false; patchScene({ accent: els.inspAccent.value }); });
els.inspAccentClear.addEventListener("click", () => {
  els.inspAccent.value = compose()?.theme?.accent ?? "#d97757";
  els.inspAccentClear.hidden = true;
  patchScene({ accent: null });
});
els.inspTransition.addEventListener("change", () => patchScene({ transition: els.inspTransition.value || null }));
els.inspLayout.addEventListener("change", () => {
  const layout = els.inspLayout.value;
  els.inspCornerWrap.hidden = layout !== "pip" && layout !== "full";
  patchScene({ layout, corner: layout === "pip" || layout === "full" ? els.inspCorner.value : null });
});
els.inspCorner.addEventListener("change", () => patchScene({ corner: els.inspCorner.value }));
els.inspFlair.addEventListener("change", () => patchScene({ flair: els.inspFlair.checked ? true : null }));

// ---- The rest of the inspector ----
//
// Every control writes straight through to compose.json and the stage
// repaints on the next poll, so a change is visible where it will appear in
// the film rather than in a form.

const selectedSceneNow = () => (selectedScene === null ? null : compose()?.scenes[selectedScene] ?? null);
const commit = (el, run) => {
  el.addEventListener("change", run);
  if (el.tagName === "INPUT") {
    el.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); el.blur(); } });
  }
};

// A quote's text lives on the graphic, a title's on the scene.
commit(els.inspText, () => {
  const scene = selectedSceneNow();
  if (!scene) return;
  if (scene.graphic?.kind === "quote") patchScene({ graphic: { text: els.inspText.value } });
  else patchScene({ text: els.inspText.value });
});
commit(els.inspSubtitle, () => {
  const scene = selectedSceneNow();
  if (!scene) return;
  if (scene.type === "title") patchScene({ subtitle: els.inspSubtitle.value || null });
  else patchScene({ graphic: { subtitle: els.inspSubtitle.value || null } });
});
els.inspStyle.addEventListener("change", () => patchScene({ style: els.inspStyle.value || null }));
els.inspMotion.addEventListener("change", () => patchScene({ graphic: { motion: els.inspMotion.value || null } }));
commit(els.inspLabel, () => patchScene({ label: els.inspLabel.value }));
commit(els.inspBy, () => patchScene({ graphic: { by: els.inspBy.value || null } }));
commit(els.inspNumber, () => patchScene({ graphic: { number: els.inspNumber.value || null } }));
for (const el of [els.inspValue, els.inspPrefix, els.inspSuffix]) {
  commit(el, () => patchScene({ graphic: {
    value: Number(els.inspValue.value),
    prefix: els.inspPrefix.value || null,
    suffix: els.inspSuffix.value || null,
  } }));
}
commit(els.inspItems, () => {
  const scene = selectedSceneNow();
  if (!scene) return;
  patchScene({ graphic: { items: textToItems(els.inspItems.value, scene.graphic.kind === "chart") } });
});
els.inspPicturePick.addEventListener("click", async () => {
  const picked = await window.fabula.pickAsset();
  if (picked.ok) patchScene({ graphic: { src: picked.src } });
  else if (!picked.cancelled) flashStatus(picked.error, true);
});

// Nudge an end one word at a time: the anchors are word ids, so this is the
// unit the film is actually cut in.
const nudge = (field, by) => async () => {
  const scene = selectedSceneNow();
  const words = compose()?.words ?? [];
  if (!scene || words.length === 0) return;
  const next = Math.min(Math.max(scene[field] + by, 0), words.length - 1);
  const from = field === "fromWordId" ? next : scene.fromWordId;
  const to = field === "toWordId" ? next : scene.toWordId;
  if (to < from) return flashStatus("a scene needs at least one word", true);
  await patchScene({ [field]: next });
};
els.inspStartBack.addEventListener("click", nudge("fromWordId", -1));
els.inspStartFwd.addEventListener("click", nudge("fromWordId", 1));
els.inspEndBack.addEventListener("click", nudge("toWordId", -1));
els.inspEndFwd.addEventListener("click", nudge("toWordId", 1));

els.inspDuplicate.addEventListener("click", async () => {
  if (selectedScene === null) return;
  const result = await window.fabula.duplicateScene(selectedScene);
  flashStatus(result.ok ? "duplicated" : result.error, !result.ok);
});
els.inspRemove.addEventListener("click", async () => {
  if (selectedScene === null) return;
  const result = await window.fabula.removeScene(selectedScene);
  if (result.ok) closeInspector();
  else flashStatus(result.error, true);
});

// ---- The dock's height ----
//
// Drag the top edge of the transport to trade preview height for timeline
// height. The workspace above is the flexible one, so it gives up the
// pixels; the lanes scale together off one variable. The choice is
// remembered for the session, per window.

// Whichever timeline is on show; the blocks are positioned in percentages,
// so a redraw is only needed for the minimap's pixel geometry.
const redrawTimeline = () => {
  if (mode === "cut" && review()) renderCutTimeline();
  else if (compose()) renderSceneTimeline();
};

const LANE_SCALE_MIN = 1;
const LANE_SCALE_MAX = 4.5;
let laneScale = Number(localStorage.getItem("fabula.laneScale")) || 1;

function setLaneScale(value) {
  laneScale = Math.min(Math.max(value, LANE_SCALE_MIN), LANE_SCALE_MAX);
  document.body.style.setProperty("--lane-scale", String(laneScale.toFixed(3)));
  try { localStorage.setItem("fabula.laneScale", String(laneScale)); } catch { /* private window */ }
}
setLaneScale(laneScale);

els.dockGrip.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  els.dockGrip.setPointerCapture(event.pointerId);
  document.body.classList.add("dock-dragging");
  const startY = event.clientY;
  const startScale = laneScale;
  // One lane is 2rem tall at scale 1; dragging a lane's worth of pixels
  // should add a lane's worth of height, whatever the tracks on show.
  const lanes = Math.max(els.timeline.querySelectorAll(".tl-track:not([hidden])").length, 1);
  const perScale = 32 * lanes;
  const move = (e) => setLaneScale(startScale + (startY - e.clientY) / perScale);
  const up = () => {
    document.body.classList.remove("dock-dragging");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    redrawTimeline();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
});

// Double-click the grip to put it back.
els.dockGrip.addEventListener("dblclick", () => { setLaneScale(1); redrawTimeline(); });

// The Look page: every control applies as it changes.
const setTheme = (patch) => window.fabula.setProject({ theme: patch });
els.themeAccent.addEventListener("input", () => { els.themeAccentValue.textContent = els.themeAccent.value; });
els.themeAccent.addEventListener("change", () => setTheme({ accent: els.themeAccent.value }));
els.themeAccent2.addEventListener("input", () => { els.themeAccent2Value.textContent = els.themeAccent2.value; });
els.themeAccent2.addEventListener("change", () => setTheme({ accent2: els.themeAccent2.value }));
// A slider applies live; the number beside it follows without waiting for
// the round trip so dragging feels attached to something.
const themeNumber = (el, key, show) => el.addEventListener("input", () => {
  if (show) show(Number(el.value));
  setTheme({ [key]: Number(el.value) });
});
themeNumber(els.themeRadius, "radius", (v) => { els.themeRadiusValue.textContent = v === 0 ? "square" : `${v.toFixed(1)}×`; });
themeNumber(els.themeGlow, "glow", (v) => { els.themeGlowValue.textContent = v === 0 ? "none" : `${Math.round(v * 100)}%`; });
themeNumber(els.themeTransitionSeconds, "transitionSeconds", (v) => { els.themeTransitionSecondsValue.textContent = `${v.toFixed(1)} s`; });
els.themeTitleCase.addEventListener("change", () => setTheme({ titleCase: els.themeTitleCase.value }));
for (const [el, key] of [[els.themeFontDisplay, "display"], [els.themeFontBody, "body"], [els.themeFontSerif, "serif"]]) {
  el.addEventListener("change", () => setTheme({ fonts: { [key]: el.value } }));
}
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
  flashInsert(result.ok ? "Sent" : result.error, !result.ok);
});
els.insertClose.addEventListener("click", closeInspector);

// ---- Transport ----

const PLAY_ICON = '<svg width="13" height="13" viewBox="0 0 12 12"><path d="M3 1.5v9l7-4.5z" fill="currentColor"></path></svg>';
const PAUSE_ICON = '<svg width="13" height="13" viewBox="0 0 12 12"><rect x="2.4" y="1.8" width="2.6" height="8.4" rx="0.8" fill="currentColor"></rect><rect x="7" y="1.8" width="2.6" height="8.4" rx="0.8" fill="currentColor"></rect></svg>';

// J/K/L. L plays, and again doubles the rate up to 4×; J runs the picture
// backwards the same way from the frame loop, since a video element will
// not; K stops both. Space and the button are plain play/pause at 1×.
function stopShuttle() {
  shuttle = 0;
  if (els.video.playbackRate !== 1) els.video.playbackRate = 1;
}
function shuttleForward() {
  if (shuttle < 0 || els.video.paused) { stopShuttle(); els.video.play().catch(() => {}); return; }
  els.video.playbackRate = Math.min(els.video.playbackRate * 2, 4);
}
function shuttleBack() {
  if (!els.video.paused) els.video.pause();
  els.video.playbackRate = 1;
  shuttle = shuttle < 0 ? Math.max(shuttle * 2, -4) : -1;
  lastTick = performance.now();
  els.playpause.innerHTML = PAUSE_ICON;
}

els.playpause.addEventListener("click", () => {
  if (shuttle < 0) { stopShuttle(); els.playpause.innerHTML = PLAY_ICON; return; }
  stopShuttle();
  if (els.video.paused) els.video.play();
  else els.video.pause();
});
els.video.addEventListener("play", () => {
  shuttle = 0;
  els.playpause.innerHTML = PAUSE_ICON;
  els.playpause.setAttribute("aria-label", "Pause");
});
els.video.addEventListener("pause", () => {
  els.playpause.innerHTML = PLAY_ICON;
  els.playpause.setAttribute("aria-label", "Play");
});
els.video.addEventListener("loadedmetadata", () => {
  if (mode === "scenes" && compose()) { els.timeTotal.textContent = fmt(composeDuration(), false); renderSceneTimeline(); }
  else if (els.video.videoWidth) setFrameAspect(els.video.closest(".videoframe"), els.video.videoWidth / els.video.videoHeight);
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
  const sheetOpen = [els.projects, els.newProject, els.rename, els.assistant].some((dialog) => dialog.open);
  if (!typing && !sheetOpen && (event.ctrlKey || event.metaKey)) {
    if (event.key === "n" || event.key === "N") { event.preventDefault(); openNewProject(); return; }
    if ((event.key === "o" || event.key === "O") && event.shiftKey) { event.preventDefault(); openProjects(); return; }
    if ((event.key === "w" || event.key === "W") && state?.project) { event.preventDefault(); window.fabula.closeProject(); return; }
  }
  if (typing || !state || els.player.hidden || sheetOpen) return;
  if (event.code === "Space") {
    event.preventDefault();
    els.playpause.click();
  } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    const step = (event.shiftKey ? 10 : 2) * (event.key === "ArrowLeft" ? -1 : 1);
    seek(els.video.currentTime + step);
  } else if (event.key === "," || event.key === ".") {
    event.preventDefault();
    stopShuttle();
    els.video.pause();
    seek(els.video.currentTime + (event.key === "." ? 1 : -1) / 30);
  } else if (event.key === "j" || event.key === "J") {
    event.preventDefault();
    shuttleBack();
  } else if (event.key === "k" || event.key === "K") {
    event.preventDefault();
    stopShuttle();
    els.video.pause();
    els.playpause.innerHTML = PLAY_ICON;
  } else if (event.key === "l" || event.key === "L") {
    event.preventDefault();
    shuttleForward();
  } else if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    seek(event.key === "Home" ? 0 : totalSeconds());
  } else if ((event.key === "=" || event.key === "+" || event.key === "-") && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    setZoom(view().zoom * (event.key === "-" ? 0.5 : 2), els.video.currentTime);
  } else if ((event.key === "[" || event.key === "]") && mode === "cut") {
    const cut = nearestCut(event.key === "]" ? 1 : -1);
    if (cut) seek(Math.max(cut.start - 0.6, 0));
  } else if (event.key === "Escape" && selection) {
    clearSelection();
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
  if (mode === "export" && state?.export?.running?.startedAt) {
    const clock = $("export-clock");
    if (clock) clock.textContent = fmt((Date.now() - Date.parse(state.export.running.startedAt)) / 1000, false);
  }
  if (!state || els.player.hidden || !onStage()) return;
  const stamp = performance.now();
  if (shuttle < 0 && els.video.paused && !scrub) {
    const dt = Math.min((stamp - lastTick) / 1000, 0.25);
    const back = Math.max(els.video.currentTime + shuttle * dt, 0);
    els.video.currentTime = back;
    if (back <= 0) { stopShuttle(); els.playpause.innerHTML = PLAY_ICON; }
  }
  lastTick = stamp;
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

  if ((!els.video.paused || shuttle < 0) && !scrub && !panning) followTime(now);
  const lane = laneBox();
  const box = els.timeline.getBoundingClientRect();
  const visible = total / view().zoom;
  const x = (now - view().start) / visible;
  els.playhead.hidden = x < 0 || x > 1;
  if (lane.width > 0) els.playhead.style.left = `${lane.left - box.left + x * lane.width}px`;
  els.mapHead.style.left = `${(now / total) * 100}%`;

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

document.addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  els.dropzone.hidden = true;
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  const filePath = window.fabula.pathForFile(file);
  if (!/\.(mp4|mov|mkv|webm|m4v)$/i.test(filePath)) { setStatus("Fabula opens mp4, mov, mkv, webm and m4v recordings."); return; }
  openNewProject(filePath, filePath.split(/[\\/]/).pop().replace(/\.[^.]+$/, ""));
});

// ---- Projects ----
//
// Every staged folder under the projects root is a project; the main process
// lists them with the state, so the list is as live as everything else.

function projectRow(project, { actions }) {
  const row = make("li", `project-row${project.current ? " is-current" : ""}${project.videoPresent ? "" : " is-missing"}`);
  const open = make("button", "project-open");
  open.type = "button";
  open.title = project.current ? "This project is open" : `Open ${project.title}`;
  const meta = [
    `<span class="stage">${esc(project.stageLabel)}</span>`,
    // The shape earns a place in the list: a vertical project and the film it
    // came out of sit next to each other and are otherwise hard to tell apart.
    project.shortForm ? `<span class="stage is-short">${esc(project.formatLabel)}</span>` : "",
    project.derivedFrom ? `from ${esc(project.derivedFrom)}` : "",
    esc(project.videoName) + (project.videoPresent ? "" : " (recording not found)"),
    project.modifiedAt ? esc(fmtWhen(project.modifiedAt)) : "",
  ].filter(Boolean).join(" · ");
  open.innerHTML = `<b>${esc(project.title)}</b><span class="project-meta">${meta}</span>`;
  open.addEventListener("click", async () => {
    if (project.current) { els.projects.close(); return; }
    const result = await window.fabula.switchProject(project.name);
    if (result.ok) els.projects.close();
    else setStatus(result.error);
  });
  row.append(open);
  if (actions) {
    const box = make("div", "project-actions");
    const rename = make("button", "", '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M11.5 2.5l2 2L6 12H4v-2z"></path><path d="M3 14h10"></path></svg>');
    rename.type = "button"; rename.title = "Rename";
    rename.addEventListener("click", () => openRename(project));
    const reveal = make("button", "", '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1.5 4.5h5l1.5 1.5h6.5v7h-13z"></path></svg>');
    reveal.type = "button"; reveal.title = "Show the project folder";
    reveal.addEventListener("click", () => window.fabula.revealProject(project.name));
    const remove = make("button", "", '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 4h10M6 4V2.5h4V4M4.5 4l.7 9.5h5.6l.7-9.5"></path></svg>');
    remove.type = "button"; remove.title = "Move this project to the recycle bin (the recording stays)";
    remove.addEventListener("click", async () => {
      const result = await window.fabula.removeProject(project.name);
      if (!result.ok && !result.cancelled) setStatus(result.error);
    });
    box.append(rename, reveal, remove);
    row.append(box);
  }
  return row;
}

// Status lines go wherever the person is looking: the dialog when it is open, else Home.
function setStatus(text, note = false) {
  const target = els.projects.open ? els.projectsStatus : els.homeStatus;
  target.textContent = text ?? "";
  target.classList.toggle("is-note", note);
}

function renderWhere(pathEl, defaultEl) {
  const where = state?.projectsRoot;
  pathEl.textContent = shortPath(where?.local ?? "");
  pathEl.title = where ? `${where.local}\nShow this folder` : "";
  defaultEl.hidden = !where || where.isDefault;
}

function renderProjectsDialog() {
  const projects = state?.projects ?? [];
  els.projectsList.replaceChildren(...projects.map((project) => projectRow(project, { actions: true })));
  if (projects.length === 0) els.projectsList.append(make("li", "projects-empty", "No projects yet."));
  els.projectsCloseProject.hidden = !state?.project;
  renderWhere(els.projectsRoot, els.projectsRootDefault);
}

function renderHome() {
  const projects = state?.projects ?? [];
  els.homeProjectsTitle.textContent = projects.length ? `Projects (${projects.length})` : "Projects";
  els.homeProjectsList.replaceChildren(...projects.map((project) => projectRow(project, { actions: true })));
  els.homeProjectsEmpty.hidden = projects.length > 0;
  renderWhere(els.homeRoot, els.homeRootDefault);
}

function openProjects() {
  // Home already is the list; a dialog over it would say the same thing twice.
  if (els.projects.open || !state?.project) return;
  els.projectsStatus.textContent = "";
  renderProjectsDialog();
  els.projects.showModal();
}

// The masthead menu.
els.projectMenu.addEventListener("click", (event) => {
  event.stopPropagation();
  const pop = els.projectMenuPop;
  if (!pop.hidden) { pop.hidden = true; return; }
  const box = els.projectMenu.getBoundingClientRect();
  pop.style.left = `${Math.round(box.left)}px`;
  pop.style.top = `${Math.round(box.bottom + 6)}px`;
  pop.hidden = false;
});
document.addEventListener("click", (event) => { if (!els.projectMenuPop.hidden && !els.projectMenuPop.contains(event.target)) els.projectMenuPop.hidden = true; });
els.menuRename.addEventListener("click", () => { els.projectMenuPop.hidden = true; openRename({ name: state.project, title: state.title ?? state.project }); });
els.menuReveal.addEventListener("click", () => { els.projectMenuPop.hidden = true; window.fabula.revealProject(state.project); });
els.menuClose.addEventListener("click", () => { els.projectMenuPop.hidden = true; window.fabula.closeProject(); });
els.menuAll.addEventListener("click", () => { els.projectMenuPop.hidden = true; openProjects(); });

els.homeNew.addEventListener("click", () => openNewProject());
els.projectsNew.addEventListener("click", () => { els.projects.close(); openNewProject(); });
els.projectsDismiss.addEventListener("click", () => els.projects.close());
els.projects.addEventListener("click", (event) => { if (event.target === els.projects) els.projects.close(); });
els.projectsCloseProject.addEventListener("click", async () => {
  await window.fabula.closeProject();
  els.projects.close();
});
els.emptyClose.addEventListener("click", () => window.fabula.closeProject());

// Where the projects live: the same control on Home and in the dialog.
let rootChanging = false;
async function changeProjectsRoot(useDefault) {
  setStatus("");
  rootChanging = true;
  let result;
  try { result = await window.fabula.chooseProjectsRoot(useDefault); } finally { rootChanging = false; }
  if (result.ok) {
    const skipped = result.skipped?.length ? ` ${result.skipped.length} already existed there and stayed behind.` : "";
    setStatus(result.moved ? `Moved ${result.moved} item${result.moved === 1 ? "" : "s"}.${skipped}` : `Projects now live in ${result.root.local}.${skipped}`, true);
  } else if (!result.cancelled) {
    setStatus(result.error);
  }
}
for (const [change, useDefault, reveal] of [[els.projectsRootChange, els.projectsRootDefault, els.projectsRoot], [els.homeRootChange, els.homeRootDefault, els.homeRoot]]) {
  change.addEventListener("click", () => changeProjectsRoot(false));
  useDefault.addEventListener("click", () => changeProjectsRoot(true));
  reveal.addEventListener("click", () => window.fabula.revealProjectsRoot());
}
// Progress lines arrive on their own channel and can trail the result; the
// result has the last word.
window.fabula.onProjectsRootProgress((text) => { if (rootChanging) setStatus(text, true); });

// ---- New project ----

let newProjectPath = null;

function setNewPath(file, suggestedTitle) {
  newProjectPath = file;
  els.newPath.textContent = file ? shortPath(file, 40) : els.newPath.dataset.empty;
  els.newPath.title = file ?? "";
  els.newPath.classList.toggle("is-empty", !file);
  if (file && !els.newTitle.value.trim() && suggestedTitle) els.newTitle.value = suggestedTitle;
  renderNewNote();
}

const slugPreview = (title) => title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "project";

function renderNewNote() {
  const title = els.newTitle.value.trim();
  els.newNote.textContent = title && newProjectPath ? `Folder “${slugPreview(title)}” in ${shortPath(state?.projectsRoot?.local ?? "media", 52)}` : "";
  const format = (state?.formats ?? []).find((f) => f.id === chosenFormat());
  els.newFormatNote.textContent = format?.shortForm
    ? "The head is cropped to fill the tall frame; a band layout shows the whole recording where a crop would lose the moment."
    : "";
  els.newCreate.disabled = !(title && newProjectPath);
}

// The shape is chosen here and nowhere else in the life of a project: the
// clean cut's ceiling and every layout follow from it, so it is a decision
// with the recording rather than a setting to find later.
function renderFormatChoice(chosen = "landscape") {
  const formats = state?.formats ?? [];
  els.newFormat.hidden = formats.length < 2;
  els.newFormat.replaceChildren(make("legend", "", "Shape"));
  for (const format of formats) {
    const label = make("label", "radio");
    label.innerHTML = `<input type="radio" name="format" value="${esc(format.id)}"${format.id === chosen ? " checked" : ""} />` +
      `<span><b>${esc(format.label)} · ${format.stage.width}×${format.stage.height}</b><small>${esc(format.about)}</small></span>`;
    label.querySelector("input").addEventListener("change", renderNewNote);
    els.newFormat.append(label);
  }
}

const chosenFormat = () => els.newFormat.querySelector("input:checked")?.value ?? "landscape";

function openNewProject(file = null, suggestedTitle = null) {
  els.newStatus.textContent = "";
  els.newTitle.value = "";
  renderFormatChoice();
  setNewPath(file, suggestedTitle);
  if (!els.newProject.open) els.newProject.showModal();
  (file ? els.newTitle : els.newChoose).focus();
  if (file) els.newTitle.select();
}

els.newChoose.addEventListener("click", async () => {
  const picked = await window.fabula.pickRecording();
  if (picked.ok) { setNewPath(picked.path, picked.suggestedTitle); els.newTitle.focus(); els.newTitle.select(); }
});
els.newTitle.addEventListener("input", renderNewNote);
els.newCancel.addEventListener("click", () => els.newProject.close());
els.newProjectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!newProjectPath) { els.newStatus.textContent = "Choose a recording first."; return; }
  const result = await window.fabula.createProject(newProjectPath, els.newTitle.value, chosenFormat());
  if (result.ok) els.newProject.close();
  else els.newStatus.textContent = result.error;
});

// ---- Rename ----

let renaming = null;
function openRename(project) {
  renaming = project;
  els.renameStatus.textContent = "";
  els.renameTitle.value = project.title;
  els.rename.showModal();
  els.renameTitle.focus();
  els.renameTitle.select();
}
els.renameCancel.addEventListener("click", () => els.rename.close());
els.renameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await window.fabula.renameProject(renaming.name, els.renameTitle.value);
  if (result.ok) els.rename.close();
  else els.renameStatus.textContent = result.error;
});

// ---- The assistant ----
//
// Chosen in a sheet, run in a real terminal on the pipeline host, shown in a
// pane inside this window. The pane's header says exactly what was started.

let assistantOptions = null;
let assistantRunning = false;
let term = null;
let fit = null;

const PROVIDER_NAMES = { claude: "Claude Code", codex: "Codex" };

function ensureTerminal() {
  if (term) return term;
  term = new window.Terminal({
    cursorBlink: true,
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "JetBrains Mono", ui-monospace, monospace',
    fontSize: 13,
    lineHeight: 1.15,
    scrollback: 5000,
    theme: { background: "#1f1e1d", foreground: "#f0ede6", cursor: "#d97757", selectionBackground: "rgba(217, 119, 87, 0.35)", black: "#1f1e1d", brightBlack: "#6e6b63" },
  });
  fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(els.assistantTerm);
  term.onData((data) => { if (assistantRunning) window.fabula.assistantInput(data); });
  window.fabula.onAssistantData((data) => term.write(data));
  window.fabula.onAssistantExit((code) => {
    assistantRunning = false;
    term.write(`\r\n\x1b[2m— session ended${code ? ` (exit ${code})` : ""} —\x1b[0m\r\n`);
    renderAssistantHead();
    renderAssistantButton();
  });
  new ResizeObserver(() => fitTerminal()).observe(els.assistantTerm);
  return term;
}

function fitTerminal() {
  if (!term || els.assistantPane.hidden) return;
  try { fit.fit(); } catch { return; }
  if (assistantRunning) window.fabula.assistantResize(term.cols, term.rows);
}

// The masthead button carries the session's state: filled and inviting when
// nothing is running, outlined with a live dot once a session is up.
function renderAssistantButton() {
  els.openAssistant.classList.toggle("is-live", assistantRunning);
  els.assistantDot.hidden = !assistantRunning;
  els.openAssistant.title = assistantRunning
    ? "The assistant is running — show or hide its pane"
    : "Start Claude Code or Codex in a pane in this window";
}

function showAssistantPane(show) {
  els.assistantPane.hidden = !show;
  document.body.classList.toggle("assistant-open", show);
  els.openAssistant.classList.toggle("is-on", show);
  renderAssistantButton();
  if (show) { ensureTerminal(); requestAnimationFrame(() => { fitTerminal(); term.focus(); }); }
}

function renderAssistantHead(choice = null) {
  if (choice) {
    els.assistantTitle.textContent = PROVIDER_NAMES[choice.provider] ?? choice.provider;
    els.assistantSub.textContent = [choice.model ? `model ${choice.model}` : "the CLI's default model", choice.effort ? `${choice.effort} effort` : "default effort", choice.persona === "farmer" ? "short-form farmer" : "editor"].join(" · ");
  }
  els.assistantStopBtn.hidden = !assistantRunning;
  els.assistantAgain.hidden = assistantRunning;
}

function assistantProvider() {
  return els.assistantForm.querySelector('input[name="provider"]:checked')?.value ?? "claude";
}

function assistantPersona() {
  return els.assistantForm.querySelector('input[name="persona"]:checked')?.value ?? "editor";
}

// The persona radios: one per persona the core knows, the saved one checked.
// A short-form project suggests the farmer; the person can still say otherwise.
function renderAssistantPersonas() {
  const personas = assistantOptions.personas ?? [];
  const suggested = state?.format?.shortForm ? "farmer" : assistantOptions.persona;
  const chosen = personas.some((p) => p.id === suggested) ? suggested : (personas[0]?.id ?? "editor");
  els.assistantPersonas.replaceChildren(els.assistantPersonas.querySelector("legend"));
  for (const persona of personas) {
    const label = document.createElement("label");
    label.className = "radio";
    label.innerHTML = `<input type="radio" name="persona" value="${esc(persona.id)}"${persona.id === chosen ? " checked" : ""} />` +
      `<span><b>${esc(persona.label)}</b><small>${esc(persona.about)}</small></span>`;
    els.assistantPersonas.append(label);
  }
  els.assistantPersonas.hidden = personas.length < 2;
}

function renderAssistantChoices() {
  const provider = assistantProvider();
  const profile = assistantOptions.profiles[provider] ?? {};
  const models = assistantOptions.models[provider] ?? [];
  const known = models.some((model) => model.id === profile.model);
  els.assistantModel.replaceChildren(
    new Option("Default (the CLI's own setting)", ""),
    ...models.map((model) => new Option(model.label === model.id ? model.id : `${model.label} · ${model.id}`, model.id)),
    new Option("Custom model ID…", "__custom__"),
  );
  els.assistantModel.value = profile.model ? (known ? profile.model : "__custom__") : "";
  els.assistantCustom.value = profile.model && !known ? profile.model : "";
  els.assistantCustomWrap.hidden = els.assistantModel.value !== "__custom__";
  els.assistantEffort.replaceChildren(
    new Option("Default (the CLI's own setting)", ""),
    ...(assistantOptions.efforts[provider] ?? []).map((effort) => new Option(effort, effort)),
  );
  els.assistantEffort.value = (assistantOptions.efforts[provider] ?? []).includes(profile.effort) ? profile.effort : "";
}

let assistantTask = "";

// The masthead button: show the pane when a session runs, else offer to start one.
async function openAssistant(task = "") {
  if (assistantRunning) { showAssistantPane(els.assistantPane.hidden); return; }
  assistantTask = task;
  els.assistantSheetTitle.textContent = task === "compose" ? "Start the assistant to compose" : "Start the assistant";
  els.assistantSheetNote.textContent = task === "compose"
    ? "The clean cut is rendering. The assistant you start here picks it up and composes the film: framing, look, scenes, a one-minute preview for you to check."
    : "Runs on your own Claude or ChatGPT subscription, in a pane inside this window. One assistant at a time.";
  els.assistantStatus.textContent = "";
  assistantOptions = await window.fabula.assistantOptions();
  const radio = els.assistantForm.querySelector(`input[name="provider"][value="${assistantOptions.provider}"]`) ?? els.assistantForm.querySelector('input[name="provider"]');
  radio.checked = true;
  renderAssistantChoices();
  renderAssistantPersonas();
  if (!els.assistant.open) els.assistant.showModal();
}

async function startAssistant(choice) {
  showAssistantPane(true);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  fitTerminal();
  term.reset();
  const result = await window.fabula.assistantStart(choice, { cols: term.cols, rows: term.rows });
  if (!result.ok) { term.write(`\x1b[31m${result.error}\x1b[0m\r\n`); return result; }
  assistantRunning = true;
  renderAssistantHead(choice);
  renderAssistantButton();
  term.focus();
  return result;
}

for (const radio of els.assistantForm.querySelectorAll('input[name="provider"]')) radio.addEventListener("change", renderAssistantChoices);
els.assistantModel.addEventListener("change", () => {
  els.assistantCustomWrap.hidden = els.assistantModel.value !== "__custom__";
  if (!els.assistantCustomWrap.hidden) els.assistantCustom.focus();
});
els.assistantCancel.addEventListener("click", () => els.assistant.close());
els.assistantForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const model = els.assistantModel.value === "__custom__" ? els.assistantCustom.value.trim() : els.assistantModel.value;
  if (els.assistantModel.value === "__custom__" && !model) { els.assistantStatus.textContent = "Enter a model ID, or choose one from the list."; return; }
  const choice = { provider: assistantProvider(), model, effort: els.assistantEffort.value, task: assistantTask, persona: assistantPersona() };
  els.assistant.close();
  const result = await startAssistant(choice);
  if (!result.ok) { els.assistantStatus.textContent = result.error; els.assistant.showModal(); }
});
els.assistantStopBtn.addEventListener("click", () => window.fabula.assistantStop());

// Approving the cut: render the clean cut, then hand the film to the assistant.
// A running session is told in its own terminal; otherwise one is started
// with composing as its first task.
els.approveCut.addEventListener("click", async () => {
  els.approveStatus.classList.remove("is-error");
  els.approveStatus.textContent = "";
  const result = await window.fabula.render("refresh", {});
  if (!result.ok) { els.approveStatus.textContent = result.error; els.approveStatus.classList.add("is-error"); return; }
  if (assistantRunning) {
    showAssistantPane(true);
    window.fabula.assistantInput("I have approved the cut and pressed Approve the cut and compose. The clean cut is rendering or current: wait for it, then compose the film as the workflow says, starting with the framing if it still needs a look, and preview the first minute before the whole film.\r");
    els.approveStatus.textContent = "Told the assistant. Watch the pane.";
  } else {
    openAssistant("compose");
  }
});
els.assistantAgain.addEventListener("click", () => openAssistant());
els.assistantHide.addEventListener("click", () => showAssistantPane(false));

// ---- State feed ----

els.openAssistant.addEventListener("click", () => openAssistant());

window.fabula.getState().then((next) => {
  state = next;
  // Open on the furthest stage the project has reached.
  if (compose()) mode = "scenes";
  render();
});
window.fabula.onState((next) => {
  const projectChanged = state?.project !== next?.project;
  state = next;
  if (projectChanged) {
    selectedScene = null; selectedInsert = null; userChoseTab = false; scriptOpen = false;
    // A shortlist belongs to the film it was read from.
    clipResult = null; clipError = null; clipFinding = null; clipBusy = null;
    mode = compose() ? "scenes" : "cut";
  }
  // The engines load async in the main process; when the compose stage
  // arrives late, follow it — unless the user already picked a tab.
  if (!userChoseTab && mode === "cut" && compose()) mode = "scenes";
  render();
});
