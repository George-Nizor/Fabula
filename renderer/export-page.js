"use strict";

// Driven by scripts/export-compose.cjs over executeJavaScript. The driver
// computes each frame's layout with the same core engine the preview uses
// and passes it in; this page only seeks the layers and paints. Every
// returned promise resolves after the seeks land and a paint has happened.

let compose = null;
const head = document.getElementById("head");
const screen = document.getElementById("screen");
const stage = document.getElementById("stage");

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

window.__setCompose = async (data) => {
  compose = data;
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

window.__renderAt = async (t, layout) => {
  if (!compose) throw new Error("compose data not set");
  const seeks = [seekTo(head, t)];
  const useScreen = Boolean(compose.screenUrl) && screenActiveAt(t);
  if (useScreen) seeks.push(seekTo(screen, t));
  await Promise.all(seeks);
  window.FabulaStage.update(stage, head, compose, t, layout, compose.screenUrl ? screen : null);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return true;
};
