"use strict";

// The one overlay painter. The review window calls this every frame over the
// playing video; the export calls it per changed state, one layer at a time.
// Same DOM, same stylesheet, so the preview is the export. Inputs are already
// resolved to seconds (core/compose-engine.mjs); this file only draws.
//
// Two halves: plan() turns a moment into parts — plain data describing every
// visible piece and which layer it belongs to — and paint() draws parts into
// an element. The parts double as the change signature the export keys its
// captures on, so a part that looks the same must serialise the same.
//
// Layers, bottom to top: the stage field, the drifting glow, the screen
// track, "under" (cards, the screen frame, the head's shadow), the head
// itself, and "over" (titles, callouts, captions, kinetic type). The head
// therefore flies over cards and under text, in the window and in the film.

// Animation primitives. A graphic is a pure function of its progress p in
// [0,1]: same p, same pixels — that is what lets the export sample any
// instant and match the preview exactly. No CSS animations in graphics.
const clamp01 = (x) => Math.min(Math.max(x, 0), 1);
const easeOut = (x) => 1 - Math.pow(1 - clamp01(x), 3);
const window01 = (p, from, span) => clamp01((p - from) / span);
// Card presence: rise in over the first beats, sink out over the last.
const presence = (p) => Math.min(easeOut(p / 0.07), 1 - easeOut((p - 0.93) / 0.07));
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;

// The head card's corner radius and the screen's, as a share of their own
// width, so the export's mask scales exactly with the picture.
const HEAD_RADIUS = 0.0086;
const SCREEN_RADIUS = 0.02;

const pct = (value, total) => `${(value / total) * 100}%`;

// A slow pool of accent light drifting across the field — deterministic in
// t. Positions are a share of the stage; the export moves a rendered glow
// with the same numbers.
function glowAt(t) {
  return {
    x: 50 + Math.sin(t * 0.21) * 26 + Math.sin(t * 0.047) * 10,
    y: 42 + Math.cos(t * 0.16) * 20,
  };
}

function driftGlow(overlayEl, t) {
  let glow = overlayEl.querySelector(":scope > .stage-glow");
  if (!glow) {
    glow = document.createElement("div");
    glow.className = "stage-glow";
    overlayEl.prepend(glow);
  }
  const g = glowAt(t);
  glow.style.transform = `translate(${g.x - 50}cqw, ${g.y - 50}cqh)`;
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

// The screen track sits inside the content rect, inset to the screen card's
// frame. Same numbers feed the window's video element and the export's
// placement of screen.mp4.
function screenRect(scene, contentRect, stage) {
  const padX = stage.width * 0.012;
  const padY = stage.height * 0.02;
  const labelH = scene.graphic.label ? stage.height * 0.055 : 0;
  return {
    x: contentRect.x + padX,
    y: contentRect.y + padY,
    w: contentRect.w - padX * 2,
    h: contentRect.h - padY * 2 - labelH,
  };
}

// The visual numbers a graphic shows at progress p, rounded to what the eye
// can tell apart. A card that has settled produces the same signature frame
// after frame, so the export stops capturing it.
function graphicSignature(graphic, p) {
  const alpha = r2(presence(p));
  switch (graphic.kind) {
    case "stat": {
      const decimals = Number.isInteger(graphic.value) ? 0 : Math.min((String(graphic.value).split(".")[1] ?? "").length, 3);
      return { alpha, value: (graphic.value * easeOut(p / 0.5)).toFixed(decimals) };
    }
    case "chart":
      return { alpha, grow: graphic.items.map((_, i) => r3(easeOut(window01(p, 0.1 + i * 0.09, 0.3)))) };
    case "list":
      return { alpha, appear: graphic.items.map((_, i) => r3(easeOut(window01(p, 0.08 + i * 0.14, 0.2)))) };
    case "image":
      return { alpha, settle: r3(easeOut(p / 0.18)) };
    default:
      return { alpha };
  }
}

function buildGraphic(part, stage) {
  const { scene, sig } = part;
  const graphic = scene.graphic;
  const card = document.createElement("div");
  card.className = "ov ov-graphic";
  if (scene.accent) card.style.setProperty("--ov-accent", scene.accent);
  card.style.opacity = String(sig.alpha);
  card.style.transform = `translateY(${(1 - sig.alpha) * 3}cqh)`;
  const rect = part.rect;
  if (rect && stage) {
    card.style.inset = "auto";
    card.style.left = pct(rect.x, stage.width);
    card.style.top = pct(rect.y, stage.height);
    card.style.width = pct(rect.w, stage.width);
    card.style.height = pct(rect.h, stage.height);
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
    value.textContent = `${graphic.prefix ?? ""}${sig.value}${graphic.suffix ?? ""}`;
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
      const grow = sig.grow[i];
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
    wrap.style.transform = `rotate(${-6.5 + sig.settle * 4}deg) scale(${0.9 + sig.settle * 0.1})`;
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

  if (graphic.kind === "screen") {
    // The picture itself is the screen track under this layer; the card
    // carries the frame and the caption.
    card.classList.add("ov-screen-card");
    if (graphic.label) {
      const label = document.createElement("div");
      label.className = "ov-screen-label";
      label.textContent = graphic.label;
      card.append(label);
    }
  }

  if (graphic.kind === "list") {
    for (const [i, item] of graphic.items.entries()) {
      const row = document.createElement("div");
      row.className = "ov-list-item";
      const appear = sig.appear[i];
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

const roundRect = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });
const sceneKey = (k, v) => (k === "scene" ? `${v.start}:${v.accent ?? ""}:${JSON.stringify(v.graphic)}` : v);

window.FabulaStage = {
  glowAt,
  screenRect,
  presence,
  HEAD_RADIUS,
  SCREEN_RADIUS,

  // Everything visible at t, as data. `layout` is the {video, content,
  // settled} pair from the stage engine (the export computes it node-side;
  // the window asks the engine bridged in by the preload).
  plan(compose, t, layout) {
    const stage = compose.stage ?? null;
    const columns = layout && stage ? freeColumns(layout.video, stage) : null;
    const contentRect = layout?.content ?? null;
    const parts = [];
    if (layout && stage) {
      parts.push({ kind: "shadow", layer: "under", rect: roundRect(layout.video) });
    }
    let screen = null;
    const captionAt = (compose.captions ?? []).find((span) => span.start <= t && t < span.end);
    let captionEaten = false;
    for (const scene of compose.scenes ?? []) {
      if (scene.type === "stage" || scene.start > t || t >= scene.end) continue;
      const p = clamp01((t - scene.start) / (scene.end - scene.start));
      if (scene.type === "graphic") {
        const sig = graphicSignature(scene.graphic, p);
        const rect = contentRect ? roundRect(contentRect) : null;
        parts.push({ kind: "graphic", layer: "under", scene, sig, rect });
        if (scene.graphic.kind === "screen" && rect && stage) {
          screen = { rect: roundRect(screenRect(scene, rect, stage)), alpha: sig.alpha, start: scene.start, end: scene.end };
        }
      } else if (scene.type === "kinetic") {
        // Giant word-by-word type, riding the per-word spans; the caption
        // itself stands down while kinetic speaks for it. Between words it
        // HOLDS the last one — big type must never blink out mid-scene.
        const spans = compose.wordSpans ?? compose.captions ?? [];
        let span = null;
        for (const s of spans) {
          if (s.start <= t) span = s;
          else break;
        }
        if (span) {
          const wp = Math.min((t - span.start) / (span.end - span.start), 1.5);
          const punch = r3(1 + (1 - easeOut(Math.min(wp * 4, 1))) * 0.35);
          const alpha = r2(easeOut(Math.min(wp * 6, 1)));
          parts.push({ kind: "kinetic", layer: "over", text: span.text, punch, alpha, accent: scene.accent });
          captionEaten = true;
        }
      } else if (scene.type === "title") {
        const flair = scene.flair ? r3(p) : null;
        parts.push({ kind: "title", layer: "over", text: scene.text, accent: scene.accent, flair, column: columns?.wide ?? null });
      } else {
        parts.push({ kind: scene.type, layer: "over", text: scene.text, accent: scene.accent, column: columns?.narrow ?? columns?.wide ?? null });
      }
    }
    if (captionAt && !captionEaten) parts.push({ kind: "caption", layer: "over", text: captionAt.text });
    return { t, stage, layout, parts, screen, accent: compose.theme?.accent };
  },

  // Signature of one layer at a moment: identical strings mean identical
  // pixels. The export captures a layer only when its key changes.
  keys(plan) {
    const serialise = (layer) => JSON.stringify(plan.parts.filter((part) => part.layer === layer), sceneKey);
    return { under: serialise("under"), over: serialise("over") };
  },

  // Draw parts into overlayEl. `only` restricts to one layer (the export's
  // separated captures); the window paints both into one element.
  paint(overlayEl, plan, only = null) {
    const { stage } = plan;
    overlayEl.style.setProperty("--ov-accent", plan.accent || "#d97757");
    const parts = only ? plan.parts.filter((part) => part.layer === only) : plan.parts;
    const key = `${only ?? "all"}|${plan.accent ?? ""}|${JSON.stringify(parts, sceneKey)}`;
    if (overlayEl.dataset.state === key) return;
    overlayEl.dataset.state = key;
    const glow = overlayEl.querySelector(":scope > .stage-glow");
    overlayEl.replaceChildren();
    if (glow) overlayEl.append(glow);
    for (const part of parts) {
      if (part.kind === "shadow") {
        const shadow = document.createElement("div");
        shadow.className = "stage-shadow";
        shadow.style.left = pct(part.rect.x, stage.width);
        shadow.style.top = pct(part.rect.y, stage.height);
        shadow.style.width = pct(part.rect.w, stage.width);
        shadow.style.height = pct(part.rect.h, stage.height);
        shadow.style.borderRadius = `${(part.rect.w * HEAD_RADIUS / stage.width) * 100}cqw`;
        overlayEl.append(shadow);
        continue;
      }
      if (part.kind === "graphic") {
        overlayEl.append(buildGraphic(part, stage));
        continue;
      }
      const el = document.createElement("div");
      el.className = `ov ov-${part.kind}`;
      if (part.accent) el.style.setProperty("--ov-accent", part.accent);
      if (part.kind === "kinetic") {
        el.style.transform = `translate(-50%, -50%) scale(${part.punch})`;
        el.style.opacity = String(part.alpha);
        el.textContent = part.text;
      } else if (part.kind === "title") {
        if (part.flair !== null) el.append(buildBurst(part.flair));
        const bar = document.createElement("div");
        bar.className = "ov-title-bar";
        const text = document.createElement("div");
        text.className = "ov-title-text";
        text.textContent = part.text;
        el.append(bar, text);
        if (part.column && stage) {
          const pad = stage.width * 0.03;
          el.style.left = pct(part.column.x + pad, stage.width);
          el.style.right = "auto";
          el.style.width = pct(part.column.w - pad * 2, stage.width);
          text.style.maxWidth = "100%";
        }
      } else {
        el.textContent = part.text;
        if (part.kind === "callout" && part.column && stage) {
          // The callout takes the column the title is not using, when one
          // exists; otherwise its default corner. It keeps its compact width.
          const pad = stage.width * 0.03;
          el.style.left = pct(part.column.x + pad, stage.width);
          el.style.right = "auto";
          el.style.maxWidth = pct(Math.min(part.column.w - pad * 2, stage.width * 0.36), stage.width);
        }
      }
      overlayEl.append(el);
    }
  },

  // Position the head (and the screen track, when the project has one) as
  // layers on the stage from a plan.
  placeMedia(plan, videoEl, screenEl) {
    const { stage, layout, screen } = plan;
    if (layout && stage && videoEl) {
      const rect = layout.video;
      videoEl.style.left = pct(rect.x, stage.width);
      videoEl.style.top = pct(rect.y, stage.height);
      videoEl.style.width = pct(rect.w, stage.width);
      videoEl.style.height = pct(rect.h, stage.height);
      videoEl.style.borderRadius = `${(rect.w * HEAD_RADIUS / stage.width) * 100}cqw`;
    }
    if (!screenEl) return;
    if (!screen || !stage) { screenEl.hidden = true; return; }
    screenEl.hidden = false;
    screenEl.style.left = pct(screen.rect.x, stage.width);
    screenEl.style.top = pct(screen.rect.y, stage.height);
    screenEl.style.width = pct(screen.rect.w, stage.width);
    screenEl.style.height = pct(screen.rect.h, stage.height);
    screenEl.style.borderRadius = `${(screen.rect.w * SCREEN_RADIUS / stage.width) * 100}cqw`;
    screenEl.style.opacity = String(screen.alpha);
  },

  // The window's per-frame call: plan, place the media, paint both layers.
  // layoutOverride: a {video, content} rect pair computed by the caller from
  // the same core engine — the export driver's path. Without it, the preview
  // asks the engine bridged in by the preload.
  update(overlayEl, videoEl, compose, t, layoutOverride, screenEl) {
    let layout = layoutOverride ?? null;
    const stage = compose.stage ?? null;
    if (!layout && compose.layoutTimeline && stage && videoEl && window.FabulaStageEngine) {
      const aspect = videoEl.videoWidth > 0 ? videoEl.videoWidth / videoEl.videoHeight : 1;
      layout = window.FabulaStageEngine.layoutAt(compose.layoutTimeline, t, aspect, stage);
    }
    const plan = this.plan(compose, t, layout);
    this.placeMedia(plan, videoEl, screenEl);
    this.paint(overlayEl, plan);
    if (stage) driftGlow(overlayEl, t);
  },
};
