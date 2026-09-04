"use strict";

// Driven by scripts/export-compose.cjs over executeJavaScript: data lands
// once, then one renderAt per captured state. Returns synchronously — the
// driver waits a paint before each screenshot.

let compose = null;

window.__setCompose = (data) => {
  compose = data;
  return true;
};

window.__renderAt = (t) => {
  if (!compose) throw new Error("compose data not set");
  window.FabulaOverlays.update(document.getElementById("stage"), compose, t);
  return true;
};
