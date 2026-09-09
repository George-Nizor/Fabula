"use strict";

// Driven by scripts/export-compose.cjs over executeJavaScript. The driver
// computes each frame's layout with the same core engine the preview uses
// and passes it in. Two modes: the whole stage at one instant (the probe's
// path, head and screen seeked and painted) and single layers on a
// transparent frame (the render's path — no video, only the pieces that
// change). Every promise resolves after the DOM has painted.

let compose = null;
const frame = document.getElementById("frame");
const headCard = document.getElementById("head");
const head = document.getElementById("head-video");
const screen = document.getElementById("screen");
const clip = document.getElementById("clip");
const stage = document.getElementById("stage");

const painted = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

function loaded(video) {
  return new Promise((resolve, reject) => {
    video.addEventListener("loadeddata", resolve, { once: true });
    video.addEventListener("error", () => reject(new Error(`video failed to load: ${video.src}`)), { once: true });
  });
}

function seekTo(video, t) {
  if (Math.abs(video.currentTime - t) <= 0.001) return Promise.resolve();
  const seeked = new Promise((resolve) => video.addEventListener("seeked", resolve, { once: true }));
  video.currentTime = t;
  return seeked;
}

window.__setCompose = async (data, { media = true } = {}) => {
  compose = data;
  if (compose.theme) window.FabulaStage.applyTheme(frame, compose.theme);
  if (!media) return true;
  head.src = data.videoUrl;
  const waits = [loaded(head)];
  if (data.screenUrl) {
    screen.src = data.screenUrl;
    waits.push(loaded(screen));
  }
  await Promise.all(waits);
  return true;
};

function screenActiveAt(t) {
  return (compose.scenes ?? []).some(
    (scene) => scene.type === "graphic" && scene.graphic?.kind === "screen" && scene.start <= t && t < scene.end,
  );
}

// The whole composition at t: field, media, both layers.
window.__renderAt = async (t, layout) => {
  if (!compose) throw new Error("compose data not set");
  frame.classList.remove("is-layer");
  frame.classList.add("stage-field");
  headCard.hidden = false;
  const seeks = [seekTo(head, t)];
  const useScreen = Boolean(compose.screenUrl) && screenActiveAt(t);
  if (useScreen) seeks.push(seekTo(screen, t));
  // B-roll at t: the clip the plan places, loaded and seeked to its own time.
  const placed = window.FabulaStage.plan(compose, t, layout).clip;
  if (placed) {
    if (clip.dataset.src !== placed.url) { clip.dataset.src = placed.url; clip.src = placed.url; await loaded(clip); }
    seeks.push(seekTo(clip, Math.max(0, t - placed.start + placed.in)));
  }
  await Promise.all(seeks);
  window.FabulaStage.update(stage, headCard, compose, t, layout, compose.screenUrl ? screen : null, clip);
  await painted();
  return true;
};

// The empty stage: the field alone, for the render's base plate.
window.__fieldOnly = async () => {
  frame.classList.remove("is-layer");
  frame.classList.add("stage-field");
  headCard.hidden = true;
  screen.hidden = true;
  clip.hidden = true;
  stage.replaceChildren();
  delete stage.dataset.state;
  await painted();
  return true;
};

// Layer signatures for a run of frames: one round trip per chunk.
window.__keysRange = (ts, layouts) => ts.map((t, i) => {
  const plan = window.FabulaStage.plan(compose, t, layouts[i]);
  const keys = window.FabulaStage.keys(plan);
  return { under: keys.under, over: keys.over, screen: plan.screen, clip: plan.clip };
});

// One layer at t on a transparent frame, nothing else visible.
window.__renderLayer = async (t, layout, layer) => {
  frame.classList.add("is-layer");
  frame.classList.remove("stage-field");
  headCard.hidden = true;
  screen.hidden = true;
  clip.hidden = true;
  const plan = window.FabulaStage.plan(compose, t, layout);
  window.FabulaStage.paint(stage, plan, layer);
  await painted();
  return true;
};
