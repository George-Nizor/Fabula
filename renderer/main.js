"use strict";

// Two stages over one player. Cut: the raw video against the raw transcript,
// struck cuts, pause chips, skip-preview, punch-in framing. Compose: the
// clean render against the clean transcript, with the scene overlays painted
// by the same runtime the export captures. The transcript is the timeline
// and the scrub bar in both.

const EPSILON = 0.02;

const els = {
  stages: document.getElementById("stages"),
  tabCut: document.getElementById("tab-cut"),
  tabCompose: document.getElementById("tab-compose"),
  session: document.getElementById("session"),
  raw: document.getElementById("stat-raw"),
  clean: document.getElementById("stat-clean"),
  empty: document.getElementById("empty"),
  emptyLine: document.getElementById("empty-line"),
  emptyHint: document.getElementById("empty-hint"),
  player: document.getElementById("player"),
  dock: document.getElementById("dock"),
  toggleRail: document.getElementById("toggle-rail"),
  toggleInsp: document.getElementById("toggle-insp"),
  video: document.getElementById("video"),
  overlay: document.getElementById("overlay"),
  playpause: document.getElementById("playpause"),
  skipwrap: document.getElementById("skipwrap"),
  skipcuts: document.getElementById("skipcuts"),
  timeNow: document.getElementById("time-now"),
  timeEdited: document.getElementById("time-edited"),
  hint: document.getElementById("controls-hint"),
  transcript: document.getElementById("transcript"),
  themewrap: document.getElementById("themewrap"),
  themeAccent: document.getElementById("theme-accent"),
  timeline: document.getElementById("timeline"),
  laneLayout: document.getElementById("lane-layout"),
  laneScenes: document.getElementById("lane-scenes"),
  playhead: document.getElementById("tl-playhead"),
  inspector: document.getElementById("inspector"),
  inspEmpty: document.getElementById("insp-empty"),
  inspBody: document.getElementById("insp-body"),
  inspTitle: document.getElementById("insp-title"),
  inspClose: document.getElementById("insp-close"),
  inspText: document.getElementById("insp-text"),
  inspTextWrap: document.getElementById("insp-text-wrap"),
  inspAccent: document.getElementById("insp-accent"),
  inspAccentWrap: document.getElementById("insp-accent-wrap"),
  inspAccentClear: document.getElementById("insp-accent-clear"),
  inspLayout: document.getElementById("insp-layout"),
  inspLayoutWrap: document.getElementById("insp-layout-wrap"),
  inspCorner: document.getElementById("insp-corner"),
  inspCornerWrap: document.getElementById("insp-corner-wrap"),
  inspFlair: document.getElementById("insp-flair"),
  inspFlairWrap: document.getElementById("insp-flair-wrap"),
  inspSave: document.getElementById("insp-save"),
  inspStatus: document.getElementById("insp-status"),
};

let state = null; // { review, compose }
let mode = "cut";
let wordSpans = [];
let highlighted = null;
let selectedScene = null; // index into compose.scenes
let accentCleared = false;

const seconds = (value) => `${value.toFixed(1)}s`;
const review = () => state?.review ?? null;
const compose = () => state?.compose ?? null;
const enabledCuts = () => (review()?.cuts ?? []).filter((cut) => cut.enabled);

function cutTitle(cut) {
  const reasons = [...new Set(cut.sources.map((s) => s.reason + (s.detail ? ` "${s.detail}"` : "")))].join(", ");
  return `${reasons} · ${cut.start.toFixed(2)}–${cut.end.toFixed(2)}s${cut.enabled ? "" : " · disabled"}`;
}

function setSource(url) {
  if (url && els.video.src !== url) {
    els.video.src = url;
    els.video.currentTime = 0;
  }
}

function renderHeader() {
  const r = review();
  const removed = enabledCuts().reduce((sum, cut) => sum + (cut.end - cut.start), 0);
  els.raw.textContent = seconds(r.duration);
  els.clean.textContent = seconds(r.duration - removed);
}

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
      span.title = `${word.start.toFixed(2)}–${word.end.toFixed(2)}s`;
    }
    span.textContent = word.text;
    span.dataset.start = String(word.start);
    wordSpans.push({ word, span });
    els.transcript.append(span, " ");
  }
  emitChipsBefore(Infinity);
}

function composeDuration() {
  const c = compose();
  return (Number.isFinite(els.video.duration) && els.video.duration) || c.words.at(-1)?.end || 1;
}

function sceneBlockLabel(scene) {
  if (scene.type === "graphic") return `${scene.graphic.kind}${scene.graphic.title ? ` · ${scene.graphic.title}` : ""}`;
  if (scene.type === "kinetic") return "kinetic type";
  return `${scene.type} · ${scene.text ?? ""}`;
}

// The composition timeline: one lane for where the head sits, one for the
// scenes. Blocks are clickable — seek, select, inspect.
function renderTimeline() {
  const c = compose();
  const total = composeDuration();
  const place = (el, start, end) => {
    el.style.left = `${(start / total) * 100}%`;
    el.style.width = `${Math.max(((end - start) / total) * 100, 0.8)}%`;
  };

  els.laneLayout.replaceChildren();
  for (const segment of c.layoutTimeline ?? []) {
    const block = document.createElement("div");
    const isFocus = segment.layout === "focus";
    block.className = `tl-block${isFocus ? " is-dim" : ""}`;
    block.textContent = isFocus ? "focus" : `${segment.layout}${segment.corner ? ` ${segment.corner}` : ""}`;
    block.title = `${segment.layout} · ${segment.start.toFixed(1)}–${segment.end.toFixed(1)}s`;
    place(block, segment.start, segment.end);
    const sceneIndex = c.scenes.findIndex(
      (scene) => scene.type === "stage" && Math.abs(scene.start - segment.start) < 0.01
    );
    block.dataset.seek = String(segment.start);
    if (sceneIndex >= 0) block.dataset.scene = String(sceneIndex);
    els.laneLayout.append(block);
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
    block.title = `${sceneBlockLabel(scene)} · ${scene.start.toFixed(1)}–${scene.end.toFixed(1)}s`;
    place(block, scene.start, scene.end);
    block.dataset.seek = String(scene.start);
    block.dataset.scene = String(index);
    if (index === selectedScene) block.classList.add("is-selected");
    els.laneScenes.append(block);
  });
}

function openInspector(index) {
  const scene = compose()?.scenes[index];
  if (!scene) return;
  selectedScene = index;
  accentCleared = false;
  els.inspEmpty.hidden = true;
  els.inspBody.hidden = false;
  els.inspTitle.textContent = `${scene.type} · ${scene.start.toFixed(1)}–${scene.end.toFixed(1)}s`;
  const hasText = scene.type === "title" || scene.type === "callout";
  els.inspTextWrap.hidden = !hasText;
  els.inspText.value = hasText ? (scene.text ?? "") : "";
  const isStage = scene.type === "stage";
  els.inspAccentWrap.hidden = isStage;
  els.inspAccent.value = scene.accent ?? compose()?.theme?.accent ?? "#d97757";
  els.inspLayoutWrap.hidden = !isStage;
  els.inspCornerWrap.hidden = !isStage;
  if (isStage) {
    els.inspLayout.value = scene.layout;
    els.inspCorner.value = scene.corner ?? "br";
  }
  els.inspFlairWrap.hidden = scene.type !== "title";
  els.inspFlair.checked = Boolean(scene.flair);
  els.inspStatus.textContent = "";
  els.inspStatus.classList.remove("is-error");
  els.inspector.hidden = false;
  renderTimeline();
}

function closeInspector() {
  selectedScene = null;
  els.inspEmpty.hidden = false;
  els.inspBody.hidden = true;
  els.inspTitle.textContent = "";
  if (mode === "compose" && compose()) renderTimeline();
}

function renderComposeTranscript() {
  const c = compose();
  els.transcript.replaceChildren();
  wordSpans = [];
  for (const word of c.words) {
    const span = document.createElement("span");
    span.className = "word";
    span.title = `${word.start.toFixed(2)}–${word.end.toFixed(2)}s`;
    span.textContent = word.text;
    span.dataset.start = String(word.start);
    wordSpans.push({ word, span });
    els.transcript.append(span, " ");
  }
}

function render() {
  if (!review()) {
    els.session.hidden = true;
    els.stages.hidden = true;
    els.player.hidden = true;
    els.dock.hidden = true;
    els.empty.hidden = false;
    if (state?.pending) {
      els.emptyLine.textContent = `“${state.pending.project}” is staged and waiting.`;
      els.emptyHint.textContent = "Tell Claude: “do a first pass on the staged clip” — it transcribes, cuts, and designs; you review here.";
    } else {
      els.emptyLine.textContent = "Drop a recording here to begin.";
      els.emptyHint.textContent = "Then ask Claude for a first pass — it transcribes, cuts, and designs; you review here.";
    }
    return;
  }
  if (mode === "compose" && !compose()) mode = "cut";

  renderHeader();
  els.session.hidden = false;
  els.empty.hidden = true;
  els.stages.hidden = false;
  els.tabCompose.disabled = !compose();
  els.tabCut.classList.toggle("is-active", mode === "cut");
  els.tabCompose.classList.toggle("is-active", mode === "compose");

  const frame = els.video.parentElement;
  if (mode === "cut") {
    setSource(review().videoUrl);
    els.skipwrap.hidden = false;
    els.hint.textContent = "click a word to jump · click anything struck to keep it";
    els.overlay.replaceChildren();
    delete els.overlay.dataset.state;
    frame.classList.remove("is-stage", "stage-field");
    els.video.classList.remove("stage-video");
    els.video.style.left = els.video.style.top = "";
    els.video.style.width = els.video.style.height = "";
    els.video.style.zIndex = "";
    els.timeline.hidden = true;
    els.themewrap.hidden = true;
    els.inspector.hidden = true;
    renderCutTranscript();
  } else {
    setSource(compose().videoUrl);
    els.skipwrap.hidden = true;
    els.hint.textContent = "the 1080p stage previews exactly as render_final bakes it";
    els.video.style.transform = "";
    frame.classList.add("is-stage", "stage-field");
    els.video.classList.add("stage-video");
    els.timeline.hidden = false;
    els.themewrap.hidden = false;
    els.themeAccent.value = compose().theme?.accent ?? "#d97757";
    els.inspector.hidden = false;
    if (selectedScene !== null && !compose().scenes[selectedScene]) closeInspector();
    else if (selectedScene === null) closeInspector();
    renderTimeline();
    renderComposeTranscript();
  }
  els.player.hidden = !els.video.src;
  els.dock.hidden = els.player.hidden;
  highlighted = null;
}

els.toggleRail.addEventListener("click", () => {
  const collapsed = document.body.classList.toggle("rail-collapsed");
  els.toggleRail.classList.toggle("is-on", !collapsed);
});
els.toggleInsp.addEventListener("click", () => {
  const collapsed = document.body.classList.toggle("insp-collapsed");
  els.toggleInsp.classList.toggle("is-on", !collapsed);
});

let userChoseTab = false;
els.tabCut.addEventListener("click", () => { userChoseTab = true; mode = "cut"; render(); });
els.tabCompose.addEventListener("click", () => { userChoseTab = true; mode = "compose"; render(); });

els.transcript.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (mode === "cut" && target.dataset.cutIndex !== undefined) {
    const index = Number(target.dataset.cutIndex);
    window.fabula.setCut(index, !review().cuts[index].enabled);
    return;
  }
  if (target.dataset.start !== undefined) {
    els.video.currentTime = Number(target.dataset.start);
    els.video.play();
  }
});

els.timeline.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || target.dataset.seek === undefined) return;
  els.video.currentTime = Number(target.dataset.seek) + 0.01;
  if (target.dataset.scene !== undefined) openInspector(Number(target.dataset.scene));
});

els.inspClose.addEventListener("click", closeInspector);
els.inspAccentClear.addEventListener("click", () => {
  accentCleared = true;
  els.inspAccent.value = compose()?.theme?.accent ?? "#d97757";
});

els.inspSave.addEventListener("click", async () => {
  if (selectedScene === null) return;
  const scene = compose()?.scenes[selectedScene];
  if (!scene) return;
  const patch = {};
  if (!els.inspTextWrap.hidden) patch.text = els.inspText.value;
  if (!els.inspAccentWrap.hidden) patch.accent = accentCleared ? null : els.inspAccent.value;
  if (!els.inspLayoutWrap.hidden) {
    patch.layout = els.inspLayout.value;
    patch.corner = patch.layout === "pip" ? els.inspCorner.value : null;
  }
  if (!els.inspFlairWrap.hidden) patch.flair = els.inspFlair.checked ? true : null;
  const result = await window.fabula.updateScene(selectedScene, patch);
  els.inspStatus.textContent = result.ok ? "applied" : result.error;
  els.inspStatus.classList.toggle("is-error", !result.ok);
});

els.themeAccent.addEventListener("change", async () => {
  await window.fabula.setTheme({ accent: els.themeAccent.value });
});

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
document.addEventListener("keydown", (event) => {
  if (event.code === "Space" && event.target === document.body) {
    event.preventDefault();
    els.playpause.click();
  }
});

// The playhead loop. Cut mode: skip enabled cuts, keep both clocks honest,
// preview the punch framing. Compose mode: paint the overlays the export
// will capture. Both: light the word being spoken.
function tick() {
  requestAnimationFrame(tick);
  if (!state || els.player.hidden) return;
  const now = els.video.currentTime;

  if (mode === "cut") {
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
    els.timeNow.textContent = seconds(now);
    els.timeEdited.textContent = seconds(Math.max(editedNow, 0));

    let scale = 1;
    for (const shot of review().shots ?? []) {
      if (now >= shot.start && now < shot.end) { scale = shot.scale; break; }
    }
    const transform = scale > 1 ? `scale(${scale})` : "";
    if (els.video.style.transform !== transform) els.video.style.transform = transform;
  } else {
    els.timeNow.textContent = seconds(now);
    els.timeEdited.textContent = seconds(now);
    window.FabulaStage.update(els.overlay, els.video, compose(), now);
    const lane = els.laneScenes.getBoundingClientRect();
    const box = els.timeline.getBoundingClientRect();
    if (lane.width > 0) {
      els.playhead.style.left = `${lane.left - box.left + (now / composeDuration()) * lane.width}px`;
    }
  }

  let current = null;
  for (const entry of wordSpans) {
    if (entry.word.start <= now && now < entry.word.end + EPSILON) { current = entry.span; break; }
    if (entry.word.start > now) break;
  }
  if (current !== highlighted) {
    highlighted?.classList.remove("is-now");
    current?.classList.add("is-now");
    highlighted = current;
  }
}
requestAnimationFrame(tick);

// Drag-drop ingest, anywhere on the window.
document.addEventListener("dragover", (event) => event.preventDefault());
document.addEventListener("drop", async (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  const result = await window.fabula.ingestFile(file);
  if (!result.ok) {
    els.emptyLine.textContent = result.error;
    els.emptyHint.textContent = "Drop an mp4, mov, mkv, webm or m4v recording.";
  }
});

window.fabula.getState().then((next) => {
  state = next;
  // Open on the furthest stage the project has reached.
  if (compose()) mode = "compose";
  render();
});
window.fabula.onState((next) => {
  state = next;
  // The engines load async in the main process; when the compose stage
  // arrives late, follow it — unless the user already picked a tab.
  if (!userChoseTab && mode === "cut" && compose()) mode = "compose";
  render();
});
