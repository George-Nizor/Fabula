"use strict";

// The transcript is the timeline and the scrub bar: words in reading order,
// cut footage struck through, dead air as pause chips. Clicking a word seeks
// the raw video; clicking anything marked cut toggles that cut. Skip-preview
// plays the edit without rendering it: playback simply jumps every enabled
// cut, which is exactly what clean.mp4 will do for real.

const EPSILON = 0.02;

const els = {
  session: document.getElementById("session"),
  project: document.getElementById("project"),
  raw: document.getElementById("stat-raw"),
  clean: document.getElementById("stat-clean"),
  cuts: document.getElementById("stat-cuts"),
  removed: document.getElementById("stat-removed"),
  empty: document.getElementById("empty"),
  player: document.getElementById("player"),
  video: document.getElementById("video"),
  playpause: document.getElementById("playpause"),
  skipcuts: document.getElementById("skipcuts"),
  timeNow: document.getElementById("time-now"),
  timeEdited: document.getElementById("time-edited"),
  transcript: document.getElementById("transcript"),
};

let review = null;
let wordSpans = [];
let highlighted = null;

function seconds(value) {
  return `${value.toFixed(1)}s`;
}

function cutTitle(cut) {
  const reasons = [...new Set(cut.sources.map((s) => s.reason + (s.detail ? ` "${s.detail}"` : "")))].join(", ");
  return `${reasons} · ${cut.start.toFixed(2)}–${cut.end.toFixed(2)}s${cut.enabled ? "" : " · disabled"}`;
}

function enabledCuts() {
  return review ? review.cuts.filter((cut) => cut.enabled) : [];
}

function render(next) {
  review = next;
  if (!review) {
    els.session.hidden = true;
    els.player.hidden = true;
    els.transcript.hidden = true;
    els.empty.hidden = false;
    return;
  }

  const removed = enabledCuts().reduce((sum, cut) => sum + (cut.end - cut.start), 0);
  els.project.textContent = review.video.split(/[\\/]/).slice(-2, -1)[0] ?? "project";
  els.raw.textContent = seconds(review.duration);
  els.clean.textContent = seconds(review.duration - removed);
  els.cuts.textContent = `${enabledCuts().length}/${review.cuts.length}`;
  els.removed.textContent = seconds(removed);
  els.session.hidden = false;
  els.empty.hidden = true;

  if (review.videoUrl && els.video.src !== review.videoUrl) els.video.src = review.videoUrl;
  els.player.hidden = !review.videoUrl;

  // A cut either swallows words (fillers, semantic ranges) or sits between
  // them (silence); chips carry the cuts no word can carry.
  const wordCut = new Map();
  const chips = [];
  review.cuts.forEach((cut, index) => {
    const covered = review.words.filter(
      (word) => word.start >= cut.start - EPSILON && word.end <= cut.end + EPSILON
    );
    if (covered.length > 0) {
      for (const word of covered) wordCut.set(word.id, index);
    } else {
      chips.push(index);
    }
  });
  chips.sort((a, b) => review.cuts[a].start - review.cuts[b].start);

  els.transcript.replaceChildren();
  wordSpans = [];
  let chipAt = 0;
  const emitChipsBefore = (time) => {
    while (chipAt < chips.length && review.cuts[chips[chipAt]].start < time) {
      const index = chips[chipAt];
      const cut = review.cuts[index];
      const chip = document.createElement("span");
      chip.className = cut.enabled ? "gap is-cut" : "gap is-kept";
      chip.textContent = `${(cut.end - cut.start).toFixed(1)}s`;
      chip.title = cutTitle(cut);
      chip.dataset.cutIndex = String(index);
      els.transcript.append(chip, " ");
      chipAt += 1;
    }
  };

  for (const word of review.words) {
    emitChipsBefore(word.start);
    const span = document.createElement("span");
    const cutIndex = wordCut.get(word.id);
    if (cutIndex !== undefined) {
      const cut = review.cuts[cutIndex];
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
  els.transcript.hidden = false;
  highlighted = null;
}

els.transcript.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.dataset.cutIndex !== undefined) {
    const index = Number(target.dataset.cutIndex);
    window.fabula.setCut(index, !review.cuts[index].enabled);
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

// The playhead loop: skip enabled cuts, keep both clocks honest, and light
// the word being spoken so the transcript reads back in time.
function tick() {
  requestAnimationFrame(tick);
  if (!review || els.player.hidden) return;
  const now = els.video.currentTime;

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

window.fabula.getReview().then(render);
window.fabula.onReview(render);
