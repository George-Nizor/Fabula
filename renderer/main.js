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
  project: document.getElementById("project"),
  raw: document.getElementById("stat-raw"),
  clean: document.getElementById("stat-clean"),
  cuts: document.getElementById("stat-cuts"),
  removed: document.getElementById("stat-removed"),
  shotsWrap: document.getElementById("stat-shots-wrap"),
  shots: document.getElementById("stat-shots"),
  scenesWrap: document.getElementById("stat-scenes-wrap"),
  scenes: document.getElementById("stat-scenes"),
  empty: document.getElementById("empty"),
  player: document.getElementById("player"),
  video: document.getElementById("video"),
  overlay: document.getElementById("overlay"),
  playpause: document.getElementById("playpause"),
  skipwrap: document.getElementById("skipwrap"),
  skipcuts: document.getElementById("skipcuts"),
  timeNow: document.getElementById("time-now"),
  timeEdited: document.getElementById("time-edited"),
  hint: document.getElementById("controls-hint"),
  transcript: document.getElementById("transcript"),
};

let state = null; // { review, compose }
let mode = "cut";
let wordSpans = [];
let highlighted = null;

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
  els.project.textContent = r.video.split(/[\\/]/).slice(-2, -1)[0] ?? "project";
  els.raw.textContent = seconds(r.duration);
  els.clean.textContent = seconds(r.duration - removed);
  els.cuts.textContent = `${enabledCuts().length}/${r.cuts.length}`;
  els.removed.textContent = seconds(removed);
  if (r.shots) {
    const tight = r.shots.filter((shot) => shot.scale > 1).length;
    els.shots.textContent = `${r.shots.length} (${tight} tight)`;
  }
  els.shotsWrap.hidden = !r.shots;
  const c = compose();
  if (c) els.scenes.textContent = `${c.scenes.length}${c.captions ? " + captions" : ""}`;
  els.scenesWrap.hidden = !c;
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
    els.transcript.hidden = true;
    els.empty.hidden = false;
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

  if (mode === "cut") {
    setSource(review().videoUrl);
    els.skipwrap.hidden = false;
    els.hint.textContent = "click a word to jump · click anything red to keep it";
    els.overlay.replaceChildren();
    delete els.overlay.dataset.state;
    renderCutTranscript();
  } else {
    setSource(compose().videoUrl);
    els.skipwrap.hidden = true;
    els.hint.textContent = "the scene plan previews here exactly as render_final bakes it";
    els.video.style.transform = "";
    renderComposeTranscript();
  }
  els.player.hidden = !els.video.src;
  els.transcript.hidden = false;
  highlighted = null;
}

els.tabCut.addEventListener("click", () => { mode = "cut"; render(); });
els.tabCompose.addEventListener("click", () => { mode = "compose"; render(); });

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

els.playpause.addEventListener("click", () => {
  if (els.video.paused) els.video.play();
  else els.video.pause();
});
els.video.addEventListener("play", () => { els.playpause.textContent = "Pause"; });
els.video.addEventListener("pause", () => { els.playpause.textContent = "Play"; });
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
    window.FabulaOverlays.update(els.overlay, compose(), now);
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

window.fabula.getState().then((next) => { state = next; render(); });
window.fabula.onState((next) => { state = next; render(); });
