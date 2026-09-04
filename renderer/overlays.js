"use strict";

// The one overlay painter. The review window calls this every frame over the
// playing video; the export page calls it once per captured state. Same DOM,
// same stylesheet, so the preview is the export. Inputs are already resolved
// to seconds (core/compose-engine.mjs); this file only draws.

// Animation primitives. A graphic is a pure function of its progress p in
// [0,1]: same p, same pixels — that is what lets the export sample any
// instant and match the preview exactly. No CSS animations in graphics.
const clamp01 = (x) => Math.min(Math.max(x, 0), 1);
const easeOut = (x) => 1 - Math.pow(1 - clamp01(x), 3);
const window01 = (p, from, span) => clamp01((p - from) / span);
// Card presence: rise in over the first beats, sink out over the last.
const presence = (p) => Math.min(easeOut(p / 0.07), 1 - easeOut((p - 0.93) / 0.07));

function buildGraphic(scene, p, contentRect, stage) {
  const graphic = scene.graphic;
  const card = document.createElement("div");
  card.className = "ov ov-graphic";
  const alpha = presence(p);
  card.style.opacity = String(alpha);
  card.style.transform = `translateY(${(1 - alpha) * 3}cqh)`;
  if (contentRect && stage) {
    card.style.inset = "auto";
    card.style.left = `${(contentRect.x / stage.width) * 100}%`;
    card.style.top = `${(contentRect.y / stage.height) * 100}%`;
    card.style.width = `${(contentRect.w / stage.width) * 100}%`;
    card.style.height = `${(contentRect.h / stage.height) * 100}%`;
  }

  if (graphic.title) {
    const title = document.createElement("div");
    title.className = "ov-graphic-title";
    title.textContent = graphic.title;
    card.append(title);
  }

  if (graphic.kind === "stat") {
    const value = document.createElement("div");
    value.className = "ov-stat-value";
    value.textContent = String(Math.round(graphic.value * easeOut(p / 0.5)));
    const label = document.createElement("div");
    label.className = "ov-stat-label";
    label.textContent = graphic.label;
    card.append(value, label);
  }

  if (graphic.kind === "chart") {
    const max = Math.max(...graphic.items.map((item) => Math.abs(item.value)), 1);
    for (const [i, item] of graphic.items.entries()) {
      const row = document.createElement("div");
      row.className = "ov-chart-row";
      const grow = easeOut(window01(p, 0.1 + i * 0.09, 0.3));
      const label = document.createElement("span");
      label.className = "ov-chart-label";
      label.textContent = item.label;
      const track = document.createElement("span");
      track.className = "ov-chart-track";
      const bar = document.createElement("span");
      bar.className = "ov-chart-bar";
      bar.style.width = `${(Math.abs(item.value) / max) * 100 * grow}%`;
      const num = document.createElement("span");
      num.className = "ov-chart-value";
      num.style.opacity = String(clamp01((grow - 0.6) / 0.4));
      num.textContent = String(Math.round(item.value * grow));
      track.append(bar);
      row.append(label, track, num);
      card.append(row);
    }
  }

  if (graphic.kind === "list") {
    for (const [i, item] of graphic.items.entries()) {
      const row = document.createElement("div");
      row.className = "ov-list-item";
      const appear = easeOut(window01(p, 0.08 + i * 0.14, 0.2));
      row.style.opacity = String(appear);
      row.style.transform = `translateX(${(1 - appear) * 4}cqw)`;
      const marker = document.createElement("span");
      marker.className = "ov-list-marker";
      const text = document.createElement("span");
      text.textContent = item.label;
      row.append(marker, text);
      card.append(row);
    }
  }
  return card;
}

window.FabulaStage = {
  // overlayEl: the stage-covering layer the scenes paint into.
  // videoEl: the head — positioned as a layer when a layout timeline exists.
  // compose: { scenes, captions, layoutTimeline?, stage? {width,height} }
  // layoutOverride: a {video, content} rect pair computed by the caller from
  // the same core engine — the export driver's path. Without it, the preview
  // asks the engine bridged in by the preload.
  update(overlayEl, videoEl, compose, t, layoutOverride) {
    let contentRect = null;
    const stage = compose.stage ?? null;
    let layoutKey = "flat";
    let layout = layoutOverride ?? null;
    if (!layout && compose.layoutTimeline && stage && videoEl && window.FabulaStageEngine) {
      const aspect = videoEl.videoWidth > 0 ? videoEl.videoWidth / videoEl.videoHeight : 1;
      layout = window.FabulaStageEngine.layoutAt(compose.layoutTimeline, t, aspect, stage);
    }
    if (layout && stage && videoEl) {
      const rect = layout.video;
      videoEl.style.left = `${(rect.x / stage.width) * 100}%`;
      videoEl.style.top = `${(rect.y / stage.height) * 100}%`;
      videoEl.style.width = `${(rect.w / stage.width) * 100}%`;
      videoEl.style.height = `${(rect.h / stage.height) * 100}%`;
      contentRect = layout.content;
      layoutKey = `${Math.round(contentRect.x)}:${Math.round(contentRect.w)}`;
    }

    const parts = [];
    for (const scene of compose.scenes ?? []) {
      if (scene.type === "stage" || scene.start > t || t >= scene.end) continue;
      if (scene.type === "graphic") {
        const p = (t - scene.start) / (scene.end - scene.start);
        parts.push({ kind: "graphic", scene, p: Number(p.toFixed(4)), layoutKey });
      } else {
        parts.push({ kind: scene.type, text: scene.text });
      }
    }
    const caption = (compose.captions ?? []).find((span) => span.start <= t && t < span.end);
    if (caption) parts.push({ kind: "caption", text: caption.text });

    // Progress and layout are part of the key, so an animated graphic redraws
    // each frame while static pictures keep their DOM (and entry animations).
    const key = JSON.stringify(parts, (k, v) => (k === "scene" ? v.start : v));
    if (overlayEl.dataset.state === key) return;
    overlayEl.dataset.state = key;

    overlayEl.replaceChildren();
    for (const part of parts) {
      if (part.kind === "graphic") {
        overlayEl.append(buildGraphic(part.scene, part.p, contentRect, stage));
        continue;
      }
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
      overlayEl.append(el);
    }
  },
};
