"use strict";

// Driven by scripts/export-compose.cjs over executeJavaScript. The driver
// computes each frame's layout with the same core engine the preview uses
// and passes it in; this page only seeks the head and paints. Every returned
// promise resolves after the seek lands and a paint has happened.

let compose = null;
const head = document.getElementById("head");
const stage = document.getElementById("stage");

window.__setCompose = async (data) => {
  compose = data;
  head.src = data.videoUrl;
  await new Promise((resolve, reject) => {
    head.addEventListener("loadeddata", resolve, { once: true });
    head.addEventListener("error", () => reject(new Error("video failed to load")), { once: true });
  });
  return true;
};

window.__renderAt = async (t, layout) => {
  if (!compose) throw new Error("compose data not set");
  if (Math.abs(head.currentTime - t) > 0.001) {
    const seeked = new Promise((resolve) => head.addEventListener("seeked", resolve, { once: true }));
    head.currentTime = t;
    await seeked;
  }
  window.FabulaStage.update(stage, head, compose, t, layout);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return true;
};
