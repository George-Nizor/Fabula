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

// A slow pool of accent light drifting across the field — deterministic in
// t, managed outside the keyed scene DOM so it moves every frame without
// forcing the cards to rebuild.
function driftGlow(overlayEl, t) {
  let glow = overlayEl.querySelector(":scope > .stage-glow");
  if (!glow) {
    glow = document.createElement("div");
    glow.className = "stage-glow";
    overlayEl.prepend(glow);
  }
  const x = 50 + Math.sin(t * 0.21) * 26 + Math.sin(t * 0.047) * 10;
  const y = 42 + Math.cos(t * 0.16) * 20;
  glow.style.transform = `translate(${x - 50}cqw, ${y - 50}cqh)`;
}

function buildGraphic(scene, p, contentRect, stage) {
  const graphic = scene.graphic;
  const card = document.createElement("div");
  card.className = "ov ov-graphic";
  if (scene.accent) card.style.setProperty("--ov-accent", scene.accent);
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

  if (graphic.kind === "image") {
    card.classList.add("ov-image-card");
    const wrap = document.createElement("div");
    wrap.className = "ov-image-wrap";
    const settle = easeOut(p / 0.18);
    wrap.style.transform = `rotate(${-6.5 + settle * 4}deg) scale(${0.9 + settle * 0.1})`;
    const img = document.createElement("img");
    img.className = "ov-image";
    img.src = graphic.url ?? graphic.src;
    wrap.append(img);
    if (graphic.label) {
      const label = document.createElement("div");
      label.className = "ov-image-label";
      label.textContent = graphic.label;
      wrap.append(label);
    }
    card.append(wrap);
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

// The free columns either side of the head, in stage pixels. Titles and
// callouts place themselves into real empty space instead of crossing the
// footage — the smarts that keep production titles readable and the speaker
// unobscured, in preview and export alike.
function freeColumns(videoRect, stage) {
  if (!videoRect || !stage) return null;
  const left = { x: 0, w: Math.max(videoRect.x, 0), side: "left" };
  const right = {
    x: videoRect.x + videoRect.w,
    w: Math.max(stage.width - videoRect.x - videoRect.w, 0),
    side: "right",
  };
  const wide = right.w > left.w ? right : left;
  const narrow = wide === right ? left : right;
  const usable = (col) => (col.w >= stage.width * 0.16 ? col : null);
  return { wide: usable(wide), narrow: usable(narrow) };
}

function placeInColumn(el, col, stage) {
  const pad = stage.width * 0.03;
  el.style.left = `${((col.x + pad) / stage.width) * 100}%`;
  el.style.right = "auto";
  el.style.width = `${((col.w - pad * 2) / stage.width) * 100}%`;
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
      // In flight the head rides above the scene cards — settled layouts
      // never overlap them, and a card edge sliding across the head reads
      // as clipping, not as motion.
      videoEl.style.zIndex = layout.settled ? "1" : "3";
      contentRect = layout.content;
      layoutKey = `${Math.round(contentRect.x)}:${Math.round(contentRect.w)}:${Math.round(layout.video.x)}:${Math.round(layout.video.w)}`;
    }
    const columns = layout && stage ? freeColumns(layout.video, stage) : null;
    overlayEl.style.setProperty("--ov-accent", compose.theme?.accent || "#d97757");
    if (compose.stage) driftGlow(overlayEl, t);

    const parts = [];
    const captionAt = (compose.captions ?? []).find((span) => span.start <= t && t < span.end);
    let captionEaten = false;
    for (const scene of compose.scenes ?? []) {
      if (scene.type === "stage" || scene.start > t || t >= scene.end) continue;
      const p = Number(((t - scene.start) / (scene.end - scene.start)).toFixed(4));
      if (scene.type === "graphic") {
        parts.push({ kind: "graphic", scene, p, layoutKey });
      } else if (scene.type === "kinetic") {
        // Giant word-by-word type, riding the caption timing; the caption
        // itself stands down while kinetic speaks for it. Between words it
        // HOLDS the last one — big type must never blink out mid-scene.
        const spans = compose.captions ?? [];
        let span = null;
        for (const s of spans) {
          if (s.start <= t) span = s;
          else break;
        }
        if (span) {
          const wp = Math.min((t - span.start) / (span.end - span.start), 1.5);
          parts.push({ kind: "kinetic", text: span.text, wp: Number(wp.toFixed(3)), accent: scene.accent });
          captionEaten = true;
        }
      } else if (scene.type === "title" && scene.flair) {
        parts.push({ kind: "title", text: scene.text, accent: scene.accent, flair: true, p, layoutKey });
      } else {
        parts.push({ kind: scene.type, text: scene.text, accent: scene.accent, layoutKey });
      }
    }
    if (captionAt && !captionEaten) parts.push({ kind: "caption", text: captionAt.text });

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
      if (part.accent) el.style.setProperty("--ov-accent", part.accent);
      if (part.kind === "kinetic") {
        // Each word lands with a snap: oversized for its first beats, then
        // settled — a pure function of the word's own progress.
        const punch = 1 + (1 - easeOut(Math.min(part.wp * 4, 1))) * 0.35;
        el.style.transform = `translate(-50%, -50%) scale(${punch.toFixed(4)})`;
        el.style.opacity = String(easeOut(Math.min(part.wp * 6, 1)));
        el.textContent = part.text;
      } else if (part.kind === "title") {
        if (part.flair) el.append(buildBurst(part.p));
        const bar = document.createElement("div");
        bar.className = "ov-title-bar";
        const text = document.createElement("div");
        text.className = "ov-title-text";
        text.textContent = part.text;
        el.append(bar, text);
        if (columns?.wide && stage) {
          placeInColumn(el, columns.wide, stage);
          text.style.maxWidth = "100%";
        }
      } else {
        el.textContent = part.text;
        if (part.kind === "callout" && stage) {
          // The callout takes the column the title is not using, when one
          // exists; otherwise its default corner. It keeps its compact width.
          const col = columns?.narrow ?? columns?.wide;
          if (col) {
            const pad = stage.width * 0.03;
            el.style.left = `${((col.x + pad) / stage.width) * 100}%`;
            el.style.right = "auto";
            el.style.maxWidth = `${(Math.min(col.w - pad * 2, stage.width * 0.36) / stage.width) * 100}%`;
          }
        }
      }
      overlayEl.append(el);
    }
    if (compose.stage) driftGlow(overlayEl, t);
  },
};

// A radial burst of sparks behind a flaired title — positions seeded by
// index, flight driven by the scene's progress. Celebration as a function.
function buildBurst(p) {
  const burst = document.createElement("div");
  burst.className = "ov-burst";
  const flight = easeOut(Math.min(p * 1.6, 1));
  for (let i = 0; i < 26; i += 1) {
    const spark = document.createElement("span");
    spark.className = "ov-spark";
    const angle = (i / 26) * Math.PI * 2 + (i % 5) * 0.13;
    const reach = (26 + ((i * 37) % 34)) * flight;
    spark.style.left = `${Math.cos(angle) * reach}cqh`;
    spark.style.top = `${Math.sin(angle) * reach * 0.62}cqh`;
    spark.style.opacity = String(Math.max(0, 1 - flight * 0.85 - (i % 3) * 0.08));
    if (i % 3 === 0) spark.style.background = "#f0ede6";
    burst.append(spark);
  }
  return burst;
}
