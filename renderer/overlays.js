"use strict";

// The one overlay painter. The review window calls this every frame over the
// playing video; the export page calls it once per captured state. Same DOM,
// same stylesheet, so the preview is the export. Inputs are already resolved
// to seconds (core/compose-engine.mjs); this file only draws.

window.FabulaOverlays = {
  // container: positioned element covering the video frame.
  // compose: { scenes: [{type,text,start,end,...}], captions: [{start,end,text}] | null }
  update(container, compose, t) {
    const parts = [];
    for (const scene of compose.scenes ?? []) {
      if (scene.start <= t && t < scene.end) parts.push({ kind: scene.type, text: scene.text });
    }
    const caption = (compose.captions ?? []).find((span) => span.start <= t && t < span.end);
    if (caption) parts.push({ kind: "caption", text: caption.text });

    const key = JSON.stringify(parts);
    if (container.dataset.state === key) return;
    container.dataset.state = key;

    container.replaceChildren();
    for (const part of parts) {
      const el = document.createElement("div");
      el.className = `ov ov-${part.kind}`;
      if (part.kind === "title") {
        const bar = document.createElement("div");
        bar.className = "ov-title-bar";
        const text = document.createElement("div");
        text.className = "ov-title-text";
        text.textContent = part.text;
        el.append(bar, text);
      } else {
        el.textContent = part.text;
      }
      container.append(el);
    }
  },
};
