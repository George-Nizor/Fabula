"use strict";

// The one overlay painter. The review window calls this every frame over the
// playing video; the export calls it per changed state, one layer at a time.
// Same DOM, same stylesheet, so the preview is the export. Inputs are already
// resolved to seconds (core/compose-engine.mjs) and the theme to tokens
// (core/themes.mjs); this file only draws.
//
// Three halves: plan() turns a moment into parts — plain data describing
// every visible piece, which layer it belongs to, and every moving number;
// build() makes a part's DOM once; animate() applies the moving numbers.
// Parts are keyed by identity, so a piece that stays keeps its element and
// only its inline styles change frame to frame. Nothing here uses a CSS
// animation: every entrance, count, wipe and drift is a function of time,
// which is what lets the export sample any instant and match the preview,
// and what stops a callout replaying its entrance every time a caption
// changes beside it.
//
// Layers, bottom to top: the stage field, the drifting glow, the screen
// track, "under" (cards, the screen frame, the head's shadow), the head
// itself, and "over" (titles, callouts, captions, kinetic type, the brand).

const clamp01 = (x) => Math.min(Math.max(x, 0), 1);
const easeOut = (x) => 1 - Math.pow(1 - clamp01(x), 3);
const easeIn = (x) => Math.pow(clamp01(x), 3);
const easeOutBack = (x) => { const c = 1.70158; const k = clamp01(x) - 1; return 1 + (c + 1) * k * k * k + c * k * k; };
const window01 = (p, from, span) => clamp01((p - from) / span);
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;

// A piece's presence over its span: in over `inDur` seconds, out over
// `outDur`, both clamped to fit short spans.
function presenceAt(t, start, end, inDur, outDur) {
  const span = Math.max(end - start, 0.05);
  const i = Math.min(inDur, span * 0.45);
  const o = Math.min(outDur, span * 0.35);
  const enter = easeOut((t - start) / i);
  const leave = 1 - easeIn((t - (end - o)) / o);
  return r2(Math.min(enter, leave));
}

// The head card's corner radius and the screen's, as a share of their own
// width, so the export's mask scales exactly with the picture.
const HEAD_RADIUS = 0.0086;
const SCREEN_RADIUS = 0.02;

const pct = (value, total) => `${(value / total) * 100}%`;

const FALLBACK_THEME = {
  preset: "studio", accent: "#d97757", accent2: "#f28a32", field: ["#1a2129", "#12171e", "#0b0e12"], fieldStyle: "radial",
  text: "#f0ede6", muted: "#9aa3ad", ink: "#0b0e12", card: "rgba(11, 14, 18, 0.88)", cardBorderAlpha: 0.45,
  radius: 1, glow: 0.07, fonts: { display: "Inter", body: "Inter", serif: "Source Serif 4" },
  titleStyle: "rise", calloutStyle: "pill", captionStyle: "pill", titleCase: "none", logo: null, watermark: null,
};

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const stack = (family, fallback) => `"${family}", ${fallback}`;

// The theme as CSS custom properties and classes on the frame — the
// container every cq unit and every colour below reads from.
function applyTheme(frameEl, theme) {
  const key = JSON.stringify(theme);
  if (frameEl.dataset.theme === key) return;
  frameEl.dataset.theme = key;
  const s = frameEl.style;
  s.setProperty("--ov-accent", theme.accent);
  s.setProperty("--ov-accent2", theme.accent2);
  s.setProperty("--ov-on-accent", luminance(theme.accent) > 0.5 ? "#111111" : "#ffffff");
  s.setProperty("--ov-text", theme.text);
  s.setProperty("--ov-muted", theme.muted);
  s.setProperty("--ov-ink", theme.ink);
  s.setProperty("--ov-card", theme.card);
  s.setProperty("--ov-card-border", `${Math.round(theme.cardBorderAlpha * 100)}%`);
  s.setProperty("--ov-field-a", theme.field[0]);
  s.setProperty("--ov-field-b", theme.field[1]);
  s.setProperty("--ov-field-c", theme.field[2]);
  s.setProperty("--ov-glow", `${Math.round(theme.glow * 100)}%`);
  s.setProperty("--ov-radius", String(theme.radius));
  s.setProperty("--ov-font-display", stack(theme.fonts.display, '"Segoe UI Variable", "Segoe UI", system-ui, sans-serif'));
  s.setProperty("--ov-font-body", stack(theme.fonts.body, '"Segoe UI Variable", "Segoe UI", system-ui, sans-serif'));
  s.setProperty("--ov-font-serif", stack(theme.fonts.serif, 'Georgia, "Times New Roman", serif'));
  for (const cls of [...frameEl.classList]) {
    if (/^(theme|field|caption|titlecase)-/.test(cls)) frameEl.classList.remove(cls);
  }
  frameEl.classList.add(`theme-${theme.preset}`, `field-${theme.fieldStyle}`, `caption-${theme.captionStyle}`, `titlecase-${theme.titleCase}`);
  // Dark type over footage needs a halo where light type needs a shadow.
  // Which one is a property of the field, not a list of preset names — the
  // rule has to hold for a brand nobody has invented yet.
  if (luminance(theme.field[1]) > 0.5) frameEl.classList.add("field-light");
}

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

// The punch-in scale at t over the clean-timeline spans the main process
// derived from the clean map; wide where nothing punches.
function punchAt(compose, t) {
  const span = (compose.punchSpans ?? []).find((s) => t >= s.start && t < s.end);
  return span?.scale ?? 1;
}

// The free columns either side of the head, in stage pixels. Titles and
// callouts place themselves into real empty space instead of crossing the
// footage — the smarts that keep production titles readable and the speaker
// unobscured, in preview and export alike.
//
// The head's rectangle is clamped to the stage first. A cutaway parks it
// three canvases to the left (so ffmpeg's overlay clips it for nothing),
// and taking that literally put the wide column at x = -3840: every title
// and callout over a cutaway was drawn off the side of the film. When the
// head is hidden there is no column, only the whole stage.
function freeColumns(videoRect, stage, headHidden) {
  if (!videoRect || !stage) return null;
  const on = (x) => Math.min(Math.max(x, 0), stage.width);
  const from = headHidden ? 0 : on(videoRect.x);
  const to = headHidden ? 0 : on(videoRect.x + videoRect.w);
  const left = { x: 0, w: from, side: "left" };
  const right = { x: to, w: stage.width - to, side: "right" };
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

const roundRect = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });
const words = (text) => String(text).split(/\s+/).filter(Boolean);
const stagger = (count, from, each, span, cap = 0.6) => {
  const step = Math.min(each, Math.max((cap - from) / Math.max(count, 1), 0.01));
  return (i, p) => easeOut(window01(p, from + i * step, span));
};

// ---- Motion: every moving number of a graphic at progress p and time t ----

// A card's choreography runs over a fixed beat from its start, not over a
// share of its span: a thirty-second card builds in under two seconds, and
// the export captures those frames, not twelve seconds of them.
const BUILD_SECONDS = 1.8;
const FULL_STAGE_KINDS = new Set(["cover", "section", "custom"]);

function graphicSignature(graphic, p, t, scene) {
  const alpha = presenceAt(t, scene.start, scene.end, 0.45, 0.35);
  const span = scene.end - scene.start;
  const q = clamp01((t - scene.start) / Math.min(BUILD_SECONDS, span * 0.5));
  switch (graphic.kind) {
    case "stat": {
      const decimals = Number.isInteger(graphic.value) ? 0 : Math.min((String(graphic.value).split(".")[1] ?? "").length, 3);
      return { alpha, value: (graphic.value * easeOut(q / 0.7)).toFixed(decimals), slam: r3(1 + (1 - easeOut(q / 0.25)) * 0.25), rule: r3(easeOut(window01(q, 0.15, 0.5))) };
    }
    case "chart": {
      const at = stagger(graphic.items.length, 0.1, 0.12, 0.4, 0.75);
      return { alpha, base: r3(easeOut(window01(q, 0.02, 0.15))), grow: graphic.items.map((_, i) => r3(easeOutBack(at(i, q)))) };
    }
    case "list": {
      const at = stagger(graphic.items.length, 0.08, 0.16, 0.25, 0.75);
      return { alpha, appear: graphic.items.map((_, i) => r3(at(i, q))), check: graphic.items.map((_, i) => r3(easeOut(window01(q, 0.2 + i * Math.min(0.16, 0.55 / graphic.items.length), 0.18)))) };
    }
    case "cover": {
      const count = words(graphic.title).length;
      const at = stagger(count, 0.1, 0.08, 0.3, 0.8);
      return { alpha, zoom: r3(1 + 0.06 * easeOut(p)), shade: r3(easeOut(q / 0.5)), reveal: Array.from({ length: count }, (_, i) => r3(at(i, q))), sub: r3(easeOut(window01(q, 0.6, 0.3))) };
    }
    case "section":
      return { alpha, number: r3(easeOutBack(window01(q, 0, 0.35))), rule: r3(easeOut(window01(q, 0.2, 0.4))), title: r3(easeOut(window01(q, 0.3, 0.45))), sub: r3(easeOut(window01(q, 0.6, 0.35))) };
    case "custom":
      return { alpha, p: r2(p), q: r2(q) };
    case "image":
      return graphic.motion === "kenburns"
        ? { alpha, zoom: r3(1 + 0.09 * easeOut(p)), pan: r3(p) }
        : graphic.motion === "pop"
          ? { alpha, pop: r3(easeOutBack(window01(p, 0, 0.12))) }
          : { alpha, settle: r3(easeOut(p / 0.18)) };
    case "quote": {
      const count = words(graphic.text).length;
      const at = stagger(count, 0.08, 0.04, 0.2, 0.75);
      return { alpha, mark: r3(easeOutBack(window01(q, 0, 0.25))), reveal: Array.from({ length: count }, (_, i) => r3(at(i, q))), by: r3(easeOut(window01(q, 0.75, 0.25))) };
    }
    case "compare": {
      const left = stagger(graphic.left.items.length, 0.25, 0.12, 0.25, 0.7);
      const right = stagger(graphic.right.items.length, 0.4, 0.12, 0.25, 0.85);
      return {
        alpha, vs: r3(easeOutBack(window01(q, 0.1, 0.3))), heads: r3(easeOut(window01(q, 0.02, 0.25))),
        left: graphic.left.items.map((_, i) => r3(left(i, q))), right: graphic.right.items.map((_, i) => r3(right(i, q))),
      };
    }
    case "steps": {
      const at = stagger(graphic.items.length, 0.1, 0.18, 0.25, 0.85);
      return { alpha, line: r3(easeOut(window01(q, 0.1, 0.7))), pop: graphic.items.map((_, i) => r3(easeOutBack(at(i, q)))) };
    }
    case "ring": {
      const fill = easeOut(window01(q, 0.05, 0.85));
      return { alpha, fill: r3(fill), value: Math.round(graphic.value * fill) };
    }
    case "logos": {
      const at = stagger(graphic.items.length, 0.08, 0.14, 0.25, 0.8);
      return { alpha, pop: graphic.items.map((_, i) => r3(easeOutBack(at(i, q)))) };
    }
    default:
      return { alpha };
  }
}

// ---- Build: a part's DOM, once per identity ----

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function buildBurst() {
  const burst = el("div", "ov-burst");
  for (let i = 0; i < 26; i += 1) {
    const spark = el("span", "ov-spark");
    if (i % 3 === 0) spark.classList.add("is-pale");
    burst.append(spark);
  }
  return burst;
}

function animateBurst(burst, p) {
  const flight = easeOut(Math.min(p * 1.6, 1));
  [...burst.children].forEach((spark, i) => {
    const angle = (i / 26) * Math.PI * 2 + (i % 5) * 0.13;
    const reach = (26 + ((i * 37) % 34)) * flight;
    spark.style.left = `${Math.cos(angle) * reach}cqh`;
    spark.style.top = `${Math.sin(angle) * reach * 0.62}cqh`;
    spark.style.opacity = String(Math.max(0, 1 - flight * 0.85 - (i % 3) * 0.08));
  });
}

function buildTitle(part) {
  const node = el("div", `ov ov-title style-${part.style}`);
  if (part.flair !== null) node.append(buildBurst());
  node.append(el("div", "ov-title-bar"));
  const body = el("div", "ov-title-body");
  body.append(el("div", "ov-title-text", part.text));
  if (part.subtitle) body.append(el("div", "ov-title-sub", part.subtitle));
  node.append(body);
  return node;
}

function buildCallout(part) {
  return el("div", `ov ov-callout style-${part.style}`, part.text);
}

function buildCaption(part) {
  const node = el("div", `ov ov-caption style-${part.style}`);
  if (part.words) {
    for (const word of part.words) {
      const span = el("span", `ov-caption-word${word.emph ? " is-emph" : ""}`, word.text);
      node.append(span, " ");
    }
  } else node.textContent = part.text;
  return node;
}

function buildBrand(part) {
  const node = el("div", "ov ov-brand");
  if (part.logo) {
    const logo = el("div", `ov-logo corner-${part.logo.corner}`);
    logo.style.width = `${part.logo.size * 100}%`;
    logo.style.opacity = String(part.logo.opacity);
    const img = el("img", "ov-logo-img");
    img.src = part.logo.url;
    logo.append(img);
    node.append(logo);
  }
  if (part.watermark && part.watermarkCorner) node.append(el("div", `ov-watermark corner-${part.watermarkCorner}`, part.watermark));
  return node;
}

// The handle takes a bottom corner the logo does not; when the head's small
// card (full layout) sits there too, the other one; when both bottom
// corners are taken, no handle for that span.
function watermarkCorner(theme, layout, stage) {
  const taken = new Set();
  if (theme.logo) taken.add(theme.logo.corner);
  if (layout && stage && layout.video.h < stage.height * 0.3) {
    const v = layout.video;
    taken.add(`${v.y + v.h / 2 > stage.height / 2 ? "b" : "t"}${v.x + v.w / 2 > stage.width / 2 ? "r" : "l"}`);
  }
  return ["br", "bl"].find((corner) => !taken.has(corner)) ?? null;
}

function ringSvg() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.classList.add("ov-ring-svg");
  const track = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  track.setAttribute("cx", "50"); track.setAttribute("cy", "50"); track.setAttribute("r", "42");
  track.classList.add("ov-ring-track");
  const arc = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  arc.setAttribute("cx", "50"); arc.setAttribute("cy", "50"); arc.setAttribute("r", "42");
  arc.classList.add("ov-ring-arc");
  svg.append(track, arc);
  return svg;
}

function checkSvg() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.classList.add("ov-check");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M5 12.5l4.5 4.5L19 7");
  svg.append(path);
  return svg;
}

function buildGraphic(part) {
  const graphic = part.graphic;
  const card = el("div", `ov ov-graphic kind-${graphic.kind}`);
  // Cards carry a heading; the full-stage kinds ARE their title.
  if (graphic.title && !FULL_STAGE_KINDS.has(graphic.kind)) card.append(el("div", "ov-graphic-title", graphic.title));

  if (graphic.kind === "stat") {
    card.append(el("div", "ov-stat-value"), el("div", "ov-stat-rule"), el("div", "ov-stat-label", graphic.label));
  }
  if (graphic.kind === "chart") {
    const rows = el("div", "ov-chart");
    rows.append(el("div", "ov-chart-base"));
    for (const item of graphic.items) {
      const row = el("div", "ov-chart-row");
      const track = el("span", "ov-chart-track");
      track.append(el("span", "ov-chart-bar"));
      row.append(el("span", "ov-chart-label", item.label), track, el("span", "ov-chart-value"));
      rows.append(row);
    }
    card.append(rows);
  }
  if (graphic.kind === "list") {
    for (const item of graphic.items) {
      const row = el("div", "ov-list-item");
      const marker = el("span", "ov-list-marker");
      marker.append(checkSvg());
      row.append(marker, el("span", "ov-list-text", item.label));
      card.append(row);
    }
  }
  if (graphic.kind === "image") {
    card.classList.add("ov-image-card", `motion-${graphic.motion ?? "tilt"}`);
    const wrap = el("div", "ov-image-wrap");
    const clip = el("div", "ov-image-clip");
    const img = el("img", "ov-image");
    img.src = graphic.url ?? graphic.src;
    clip.append(img);
    wrap.append(clip);
    if (graphic.label) wrap.append(el("div", "ov-image-label", graphic.label));
    card.append(wrap);
  }
  if (graphic.kind === "screen") {
    card.classList.add("ov-screen-card");
    if (graphic.label) card.append(el("div", "ov-screen-label", graphic.label));
  }
  if (graphic.kind === "quote") {
    card.append(el("div", "ov-quote-mark", "“"));
    const text = el("div", "ov-quote-text");
    for (const word of words(graphic.text)) text.append(el("span", "ov-quote-word", word), " ");
    card.append(text);
    if (graphic.by) card.append(el("div", "ov-quote-by", `— ${graphic.by}`));
  }
  if (graphic.kind === "compare") {
    const grid = el("div", "ov-compare");
    for (const side of ["left", "right"]) {
      const column = el("div", `ov-compare-col side-${side}`);
      column.append(el("div", "ov-compare-head", graphic[side].title));
      for (const item of graphic[side].items) column.append(el("div", "ov-compare-item", item.label));
      grid.append(column);
    }
    const vs = el("div", "ov-compare-vs", "VS");
    grid.append(vs);
    card.append(grid);
  }
  if (graphic.kind === "steps") {
    const list = el("div", "ov-steps");
    list.append(el("div", "ov-steps-line"));
    graphic.items.forEach((item, i) => {
      const step = el("div", "ov-step");
      step.append(el("span", "ov-step-num", String(i + 1)), el("span", "ov-step-text", item.label));
      list.append(step);
    });
    card.append(list);
  }
  if (graphic.kind === "ring") {
    const wrap = el("div", "ov-ring");
    wrap.append(ringSvg(), el("div", "ov-ring-value"));
    card.append(wrap, el("div", "ov-stat-label", graphic.label));
  }
  if (graphic.kind === "cover") {
    card.classList.add("is-full");
    const media = el("div", "ov-cover-media");
    if (graphic.url ?? graphic.src) {
      const img = el("img", "ov-cover-img");
      img.src = graphic.url ?? graphic.src;
      media.append(img);
    }
    const shade = el("div", "ov-cover-shade");
    if (graphic.tint) shade.style.setProperty("--ov-cover-tint", graphic.tint);
    const text = el("div", "ov-cover-text");
    const title = el("div", "ov-cover-title");
    for (const word of words(graphic.title)) title.append(el("span", "ov-cover-word", word), " ");
    text.append(el("div", "ov-cover-rule"), title);
    if (graphic.subtitle) text.append(el("div", "ov-cover-sub", graphic.subtitle));
    card.append(media, shade, text);
  }
  if (graphic.kind === "section") {
    card.classList.add("is-full");
    const block = el("div", "ov-section");
    if (graphic.number !== undefined) block.append(el("div", "ov-section-number", String(graphic.number)));
    block.append(el("div", "ov-section-rule"), el("div", "ov-section-title", graphic.title));
    if (graphic.subtitle) block.append(el("div", "ov-section-sub", graphic.subtitle));
    card.append(block);
  }
  if (graphic.kind === "custom") {
    // Claude's own markup for this one moment: scoped CSS, no scripts (the
    // engine refuses them), motion from the --p / --q / --t variables the
    // painter sets every frame.
    if (graphic.full !== false) card.classList.add("is-full");
    const style = el("style");
    style.textContent = `@scope (.ov-custom-root) { ${graphic.css ?? ""} }`;
    const root = el("div", "ov-custom-root");
    root.innerHTML = graphic.html;
    card.append(style, root);
  }
  if (graphic.kind === "logos") {
    const row = el("div", "ov-logos");
    for (const item of graphic.items) {
      const tile = el("div", "ov-logo-tile");
      const img = el("img", "ov-logo-tile-img");
      img.src = item.url ?? item.src;
      tile.append(img);
      if (item.label) tile.append(el("div", "ov-logo-tile-label", item.label));
      row.append(tile);
    }
    card.append(row);
  }
  return card;
}

// ---- Animate: the moving numbers onto an existing element ----

const setOpacity = (node, value) => { node.style.opacity = String(value); };

function animateTitle(node, part) {
  const e = part.enter;
  const text = node.querySelector(".ov-title-text");
  const bar = node.querySelector(".ov-title-bar");
  const sub = node.querySelector(".ov-title-sub");
  const burst = node.querySelector(".ov-burst");
  if (burst) animateBurst(burst, part.flair);
  switch (part.style) {
    case "slam": {
      const b = easeOutBack(e);
      setOpacity(node, e);
      node.style.transform = `scale(${r3(1 + (1 - b) * 0.6)})`;
      bar.style.transform = `scaleY(${r3(b)})`;
      break;
    }
    case "typewriter":
      setOpacity(node, Math.min(e * 3, 1));
      text.textContent = part.typed + (part.caret ? "▍" : " ");
      bar.style.transform = "";
      node.style.transform = "";
      break;
    case "wipe":
      setOpacity(node, Math.min(e * 4, 1));
      text.style.clipPath = `inset(0 ${r3((1 - e) * 100)}% 0 0)`;
      bar.style.transform = `scaleY(${r3(e)})`;
      node.style.transform = "";
      break;
    case "underline":
      setOpacity(node, Math.min(e * 4, 1));
      bar.style.transform = `scaleX(${r3(e)})`;
      node.style.transform = `translateY(${r3((1 - e) * 1.2)}cqh)`;
      break;
    case "boxed": {
      const b = easeOutBack(e);
      setOpacity(node, Math.min(e * 3, 1));
      bar.style.transform = `scaleX(${r3(Math.max(b, 0))})`;
      text.style.opacity = String(r2(window01(e, 0.25, 0.5)));
      if (sub) sub.style.opacity = String(r2(window01(e, 0.35, 0.5)));
      node.style.transform = "";
      break;
    }
    case "kicker":
      setOpacity(node, e);
      bar.style.transform = `scaleX(${r3(easeOut(Math.min(e * 1.6, 1)))})`;
      text.style.transform = `translateY(${r3((1 - e) * 1.6)}cqh)`;
      if (sub) sub.style.opacity = String(r2(window01(e, 0.2, 0.6)));
      node.style.transform = "";
      break;
    case "block": {
      const b = easeOutBack(e);
      setOpacity(node, Math.min(e * 4, 1));
      bar.style.transform = `scaleX(${r3(Math.max(b, 0))})`;
      text.style.transform = `translateX(${r3((1 - e) * 3)}cqw)`;
      text.style.opacity = String(r3(easeOut(window01(e, 0.35, 0.65))));
      node.style.transform = "";
      break;
    }
    default:
      setOpacity(node, e);
      node.style.transform = `translateY(${r3((1 - e) * 1.5)}cqh)`;
      bar.style.transform = "";
  }
  if (sub) {
    const s = easeOut(window01(e, 0.45, 0.55));
    sub.style.opacity = String(r3(s));
    sub.style.transform = `translateY(${r3((1 - s) * 1)}cqh)`;
  }
}

function animateCallout(node, part) {
  const e = part.enter;
  switch (part.style) {
    case "stamp": {
      const b = easeOutBack(e);
      setOpacity(node, e);
      node.style.transform = `rotate(-6deg) scale(${r3(1 + (1 - b) * 0.8)})`;
      break;
    }
    case "note":
      setOpacity(node, e);
      node.style.transform = `rotate(2.5deg) translateY(${r3((1 - easeOutBack(e)) * 3)}cqh)`;
      break;
    case "tag":
      setOpacity(node, Math.min(e * 3, 1));
      node.style.transform = `translateX(${r3((1 - easeOutBack(e)) * 2)}cqw)`;
      break;
    case "bar":
      setOpacity(node, Math.min(e * 3, 1));
      node.style.transform = `translateX(${r3((1 - easeOut(e)) * 2.5)}cqw)`;
      break;
    case "bubble": {
      const b = easeOutBack(e);
      setOpacity(node, Math.min(e * 3, 1));
      node.style.transform = `scale(${r3(0.72 + b * 0.28)})`;
      break;
    }
    default:
      setOpacity(node, e);
      node.style.transform = `translateY(${r3((1 - e) * 1.5)}cqh)`;
  }
}

function animateCaption(node, part) {
  setOpacity(node, part.enter);
  const base = part.style === "band" ? "" : "translateX(-50%) ";
  node.style.transform = `${base}scale(${r3(0.92 + part.enter * 0.08)})`;
  if (part.words) {
    [...node.querySelectorAll(".ov-caption-word")].forEach((span, i) => span.classList.toggle("is-on", Boolean(part.words[i]?.on)));
  }
}

function animateKinetic(node, part) {
  node.style.transform = `translate(-50%, -50%) rotate(${part.tilt}deg) scale(${part.punch})`;
  setOpacity(node, part.alpha);
}

function animateGraphic(card, part) {
  const { graphic, sig } = part;
  setOpacity(card, sig.alpha);
  card.style.transform = `translateY(${r3((1 - sig.alpha) * 3)}cqh)`;
  switch (graphic.kind) {
    case "stat": {
      card.querySelector(".ov-stat-value").textContent = `${graphic.prefix ?? ""}${sig.value}${graphic.suffix ?? ""}`;
      card.querySelector(".ov-stat-value").style.transform = `scale(${sig.slam})`;
      card.querySelector(".ov-stat-rule").style.transform = `scaleX(${sig.rule})`;
      break;
    }
    case "chart": {
      const max = Math.max(...graphic.items.map((item) => Math.abs(item.value)), 1);
      card.querySelector(".ov-chart-base").style.transform = `scaleY(${sig.base})`;
      [...card.querySelectorAll(".ov-chart-row")].forEach((row, i) => {
        const grow = sig.grow[i];
        row.querySelector(".ov-chart-bar").style.width = `${(Math.abs(graphic.items[i].value) / max) * 100 * Math.max(grow, 0)}%`;
        const value = row.querySelector(".ov-chart-value");
        value.style.opacity = String(clamp01((grow - 0.6) / 0.4));
        value.textContent = String(Math.round(graphic.items[i].value * clamp01(grow)));
      });
      break;
    }
    case "list":
      [...card.querySelectorAll(".ov-list-item")].forEach((row, i) => {
        const appear = sig.appear[i];
        row.style.opacity = String(appear);
        row.style.transform = `translateX(${r3((1 - appear) * 4)}cqw)`;
        row.querySelector(".ov-check path").style.strokeDashoffset = String(r3(30 * (1 - sig.check[i])));
        row.querySelector(".ov-list-marker").style.transform = `scale(${r3(easeOutBack(appear))})`;
      });
      break;
    case "image": {
      const wrap = card.querySelector(".ov-image-wrap");
      const img = card.querySelector(".ov-image");
      if (sig.zoom !== undefined) {
        wrap.style.transform = "";
        img.style.transform = `scale(${sig.zoom}) translate(${r3(-2 * sig.pan)}%, ${r3(-1.5 * sig.pan)}%)`;
      } else if (sig.pop !== undefined) {
        wrap.style.transform = `scale(${r3(0.6 + 0.4 * sig.pop)})`;
        img.style.transform = "";
      } else {
        wrap.style.transform = `rotate(${r3(-6.5 + sig.settle * 4)}deg) scale(${r3(0.9 + sig.settle * 0.1)})`;
        img.style.transform = "";
      }
      break;
    }
    case "quote": {
      const mark = card.querySelector(".ov-quote-mark");
      mark.style.transform = `scale(${r3(Math.max(sig.mark, 0))})`;
      mark.style.opacity = String(clamp01(sig.mark));
      [...card.querySelectorAll(".ov-quote-word")].forEach((span, i) => {
        const v = sig.reveal[i];
        span.style.opacity = String(v);
        span.style.transform = `translateY(${r3((1 - v) * 0.6)}em)`;
      });
      const by = card.querySelector(".ov-quote-by");
      if (by) by.style.opacity = String(sig.by);
      break;
    }
    case "compare": {
      const vs = card.querySelector(".ov-compare-vs");
      vs.style.transform = `translate(-50%, -50%) scale(${r3(Math.max(sig.vs, 0))}) rotate(${r3((1 - clamp01(sig.vs)) * 40)}deg)`;
      vs.style.opacity = String(clamp01(sig.vs));
      card.querySelectorAll(".ov-compare-head").forEach((head) => { head.style.opacity = String(sig.heads); });
      ["left", "right"].forEach((side) => {
        [...card.querySelectorAll(`.side-${side} .ov-compare-item`)].forEach((item, i) => {
          const v = sig[side][i];
          item.style.opacity = String(v);
          item.style.transform = `translateX(${r3((side === "left" ? -1 : 1) * (1 - v) * 3)}cqw)`;
        });
      });
      break;
    }
    case "steps":
      card.querySelector(".ov-steps-line").style.transform = `scaleY(${sig.line})`;
      [...card.querySelectorAll(".ov-step")].forEach((step, i) => {
        const v = sig.pop[i];
        step.querySelector(".ov-step-num").style.transform = `scale(${r3(Math.max(v, 0))})`;
        step.querySelector(".ov-step-text").style.opacity = String(clamp01(v));
        step.querySelector(".ov-step-text").style.transform = `translateX(${r3((1 - clamp01(v)) * 2)}cqw)`;
      });
      break;
    case "ring": {
      const circumference = 2 * Math.PI * 42;
      card.querySelector(".ov-ring-arc").style.strokeDashoffset = String(r3(circumference * (1 - sig.fill)));
      card.querySelector(".ov-ring-value").textContent = `${sig.value}${graphic.suffix ?? "%"}`;
      break;
    }
    case "cover": {
      const img = card.querySelector(".ov-cover-img");
      if (img) img.style.transform = `scale(${sig.zoom})`;
      card.querySelector(".ov-cover-shade").style.opacity = String(sig.shade);
      card.querySelector(".ov-cover-rule").style.transform = `scaleX(${r3(Math.min(sig.shade * 1.4, 1))})`;
      [...card.querySelectorAll(".ov-cover-word")].forEach((span, i) => {
        const v = sig.reveal[i];
        span.style.opacity = String(v);
        span.style.transform = `translateY(${r3((1 - v) * 0.5)}em)`;
      });
      const sub = card.querySelector(".ov-cover-sub");
      if (sub) { sub.style.opacity = String(sig.sub); sub.style.transform = `translateY(${r3((1 - sig.sub) * 0.6)}em)`; }
      break;
    }
    case "section": {
      const number = card.querySelector(".ov-section-number");
      if (number) { number.style.transform = `scale(${r3(Math.max(sig.number, 0))})`; number.style.opacity = String(clamp01(sig.number)); }
      card.querySelector(".ov-section-rule").style.transform = `scaleX(${sig.rule})`;
      const title = card.querySelector(".ov-section-title");
      title.style.clipPath = `inset(0 ${r3((1 - sig.title) * 100)}% 0 0)`;
      title.style.opacity = String(Math.min(sig.title * 3, 1));
      const sub = card.querySelector(".ov-section-sub");
      if (sub) sub.style.opacity = String(sig.sub);
      break;
    }
    case "custom": {
      const root = card.querySelector(".ov-custom-root");
      root.style.setProperty("--p", String(sig.p));
      root.style.setProperty("--q", String(sig.q));
      root.style.setProperty("--alpha", String(sig.alpha));
      break;
    }
    case "logos":
      [...card.querySelectorAll(".ov-logo-tile")].forEach((tile, i) => {
        const v = sig.pop[i];
        tile.style.opacity = String(clamp01(v * 1.5));
        tile.style.transform = `scale(${r3(Math.max(0.4 + 0.6 * v, 0))})`;
      });
      break;
    default:
      break;
  }
}

function placeInColumn(node, column, stage, maxShare) {
  if (!column || !stage) return;
  if (column.bottom !== undefined) node.style.bottom = pct(column.bottom, stage.height);
  const pad = stage.width * 0.03;
  node.style.left = pct(column.x + pad, stage.width);
  node.style.right = "auto";
  node.style.maxWidth = pct(Math.min(column.w - pad * 2, stage.width * maxShare), stage.width);
}

const animators = { title: animateTitle, callout: animateCallout, caption: animateCaption, kinetic: animateKinetic, graphic: animateGraphic };

function build(part, stage) {
  switch (part.kind) {
    case "shadow": {
      const shadow = el("div", "stage-shadow");
      return shadow;
    }
    case "title": {
      const node = buildTitle(part);
      if (part.column && stage) {
        const pad = stage.width * 0.03;
        node.style.left = pct(part.column.x + pad, stage.width);
        node.style.right = "auto";
        node.style.width = pct(part.column.w - pad * 2, stage.width);
        // A band also says how high: it is the room ABOVE the card, and a
        // title that ignored that would sit on top of it.
        if (part.column.bottom !== undefined) node.style.bottom = pct(part.column.bottom, stage.height);
      }
      return node;
    }
    case "callout": {
      const node = buildCallout(part);
      placeInColumn(node, part.column, stage, 0.36);
      if (part.avoid) node.style.top = `${part.avoid}cqh`;
      return node;
    }
    case "caption": return buildCaption(part);
    case "kinetic": return el("div", `ov ov-kinetic tone-${part.tone}`, part.text);
    case "brand": return buildBrand(part);
    case "graphic": {
      const card = buildGraphic(part);
      if (part.rect && stage) {
        card.style.inset = "auto";
        card.style.left = pct(part.rect.x, stage.width);
        card.style.top = pct(part.rect.y, stage.height);
        card.style.width = pct(part.rect.w, stage.width);
        card.style.height = pct(part.rect.h, stage.height);
      }
      return card;
    }
    default:
      return el("div", "ov");
  }
}

function animate(node, part, stage, theme) {
  if (part.accent) node.style.setProperty("--ov-accent", part.accent);
  if (part.kind === "shadow") {
    node.style.opacity = String(part.alpha ?? 1);
    node.style.left = pct(part.rect.x, stage.width);
    node.style.top = pct(part.rect.y, stage.height);
    node.style.width = pct(part.rect.w, stage.width);
    node.style.height = pct(part.rect.h, stage.height);
    node.style.borderRadius = `${(part.rect.w * HEAD_RADIUS * theme.radius / stage.width) * 100}cqw`;
    return;
  }
  animators[part.kind]?.(node, part);
}

// What identifies a part across frames (its element is kept while this
// holds) and what would need a rebuild (its structure changed under it).
const structural = (part) => JSON.stringify({ kind: part.kind, style: part.style, text: part.text, subtitle: part.subtitle, flair: part.flair !== null && part.flair !== undefined, words: part.words?.map((w) => w.text), graphic: part.graphic, rect: part.rect, column: part.column, avoid: part.avoid, logo: part.logo, watermark: part.watermark, watermarkCorner: part.watermarkCorner, tone: part.tone });

window.FabulaStage = {
  glowAt,
  screenRect,
  presence: presenceAt,
  applyTheme,
  HEAD_RADIUS,
  SCREEN_RADIUS,
  headRadius: (theme) => HEAD_RADIUS * (theme?.radius ?? 1),

  // Everything visible at t, as data. `layout` is the {video, content,
  // settled} pair from the stage engine (the export computes it node-side;
  // the window asks the engine bridged in by the preload).
  plan(compose, t, layout) {
    const theme = compose.theme?.preset ? compose.theme : { ...FALLBACK_THEME, ...(compose.theme ?? {}) };
    const stage = compose.stage ?? null;
    const columns = layout && stage ? freeColumns(layout.video, stage, layout.headHidden) : null;
    const contentRect = layout?.content ?? null;
    const alpha = layout?.alpha ?? 1;
    // In a tall frame the head spans the width, so there is no column beside
    // it and a title falling to its default place lands on top of whatever
    // card is showing. The free room there is the BAND above the content rect;
    // it is only needed while something actually occupies that rect.
    const cardShowing = (compose.scenes ?? []).some((scene) =>
      scene.type === "graphic" && scene.start <= t && t < scene.end
      && !(FULL_STAGE_KINDS.has(scene.graphic?.kind) && scene.graphic.full !== false));
    const band = !columns?.wide && cardShowing && contentRect && stage
      ? { x: contentRect.x, w: contentRect.w, side: "band", bottom: stage.height - contentRect.y + stage.height * 0.025 }
      : null;
    const parts = [];
    // The head's shadow belongs to the head: it fades with it, and while the
    // head is away there is nothing for it to be the shadow of. Its opacity
    // is quantised to twentieths — the export captures a new plate for this
    // layer every time the signature changes, and a soft drop shadow under a
    // fading head does not need thirty of them per boundary.
    if (layout && stage && alpha > 0.005) {
      parts.push({ key: "shadow", kind: "shadow", layer: "under", rect: roundRect(layout.video), alpha: Math.round(alpha * 20) / 20 });
    }
    let screen = null;
    const captionAt = (compose.captions ?? []).find((span) => span.start <= t && t < span.end);
    let captionEaten = false;
    for (const scene of compose.scenes ?? []) {
      if (scene.type === "stage" || scene.start > t || t >= scene.end) continue;
      const p = clamp01((t - scene.start) / (scene.end - scene.start));
      const key = `${scene.type}:${scene.start}:${scene.fromWordId ?? ""}`;
      if (scene.type === "graphic") {
        const sig = graphicSignature(scene.graphic, p, t, scene);
        const full = FULL_STAGE_KINDS.has(scene.graphic.kind) && scene.graphic.full !== false;
        const rect = full && stage ? { x: 0, y: 0, w: stage.width, h: stage.height } : (contentRect ? roundRect(contentRect) : null);
        parts.push({ key, kind: "graphic", layer: "under", graphic: scene.graphic, sig, rect, accent: scene.accent });
        if (scene.graphic.kind === "screen" && rect && stage) {
          screen = { rect: roundRect(screenRect(scene, rect, stage)), alpha: sig.alpha, start: scene.start, end: scene.end };
        }
      } else if (scene.type === "kinetic") {
        // Giant word-by-word type, riding the per-word spans; the caption
        // itself stands down while kinetic speaks for it. Between words it
        // HOLDS the last one — big type must never blink out mid-scene.
        const spans = compose.wordSpans ?? compose.captions ?? [];
        let span = null;
        let index = -1;
        for (let i = 0; i < spans.length; i += 1) {
          if (spans[i].start <= t) { span = spans[i]; index = i; } else break;
        }
        if (span) {
          const wp = Math.min((t - span.start) / (span.end - span.start), 1.5);
          const punch = r3(1 + (1 - easeOut(Math.min(wp * 4, 1))) * 0.35);
          const alpha = r2(easeOut(Math.min(wp * 6, 1)));
          parts.push({ key: `${key}:${span.start}`, kind: "kinetic", layer: "over", text: span.text, punch, alpha, tilt: ((index * 37) % 7 - 3) * 0.5, tone: index % 3 === 2 ? "accent" : "text", accent: scene.accent });
          captionEaten = true;
        }
      } else if (scene.type === "title") {
        const style = scene.style ?? theme.titleStyle;
        const enter = presenceAt(t, scene.start, scene.end, 0.36, 0.28);
        const part = { key, kind: "title", layer: "over", style, text: scene.text, subtitle: scene.subtitle ?? null, accent: scene.accent, enter, flair: scene.flair ? r3(p) : null, column: columns?.wide ?? band };
        if (style === "typewriter") {
          const typeSeconds = Math.min(1.4, (scene.end - scene.start) * 0.5);
          const typed = Math.floor(clamp01((t - scene.start) / typeSeconds) * scene.text.length);
          part.typed = scene.text.slice(0, typed);
          part.caret = typed < scene.text.length ? Math.floor(t * 3) % 2 === 0 : false;
        }
        parts.push(part);
      } else {
        const style = scene.style ?? theme.calloutStyle;
        // A callout's default corner is the top right; a brand mark there
        // pushes it down below the mark.
        const avoid = theme.logo?.corner === "tr" ? Math.round((theme.logo.size * stage.width * 0.35 + stage.height * 0.06) / stage.height * 100) : null;
        parts.push({ key, kind: "callout", layer: "over", style, text: scene.text, accent: scene.accent, enter: presenceAt(t, scene.start, scene.end, 0.3, 0.25), column: columns?.narrow ?? columns?.wide ?? band, avoid });
      }
    }
    if (captionAt && !captionEaten && theme.captionStyle !== "none") {
      // Captions cut hard: a phrase every couple of seconds with a fade on
      // each end is eight captures a phrase in the export for a flicker
      // nobody watches. On and off, one capture.
      const part = { key: `caption:${captionAt.start}`, kind: "caption", layer: "over", style: theme.captionStyle, text: captionAt.text, enter: 1 };
      // The phrase's own words, when the engine gave them: emphasis rides
      // them in every style, and karaoke lights them up to the playhead.
      const own = captionAt.words ?? (compose.wordSpans ?? []).filter((s) => s.start >= captionAt.start - 0.01 && s.start < captionAt.end);
      if (own.length === words(captionAt.text).length && (theme.captionStyle === "karaoke" || own.some((w) => w.emph))) {
        let active = -1;
        own.forEach((s, i) => { if (s.start <= t) active = i; });
        part.words = own.map((s, i) => ({ text: s.text, on: theme.captionStyle !== "karaoke" || i <= active, ...(s.emph ? { emph: true } : {}) }));
      }
      parts.push(part);
    }
    if (theme.logo || theme.watermark) {
      parts.push({ key: "brand", kind: "brand", layer: "over", logo: theme.logo ? { ...theme.logo, url: theme.logoUrl ?? theme.logo.src } : null, watermark: theme.watermark, watermarkCorner: watermarkCorner(theme, layout, stage) });
    }
    for (const part of parts) part.sigText = JSON.stringify(part);
    return { t, stage, layout, parts, screen, theme };
  },

  // Signature of one layer at a moment: identical strings mean identical
  // pixels. The export captures a layer only when its key changes.
  keys(plan) {
    const serialise = (layer) => JSON.stringify(plan.parts.filter((part) => part.layer === layer).map((part) => part.sigText));
    return { under: serialise("under"), over: serialise("over") };
  },

  // Draw parts into overlayEl. `only` restricts to one layer (the export's
  // separated captures); the window paints both into one element. Elements
  // are kept by key: a part that is still there keeps its node and gets its
  // new numbers; one whose structure changed is rebuilt; the rest go.
  paint(overlayEl, plan, only = null) {
    const { stage, theme } = plan;
    overlayEl.style.setProperty("--ov-accent", theme.accent);
    const parts = only ? plan.parts.filter((part) => part.layer === only) : plan.parts;
    const key = `${only ?? "all"}|${parts.map((part) => part.sigText).join("|")}`;
    if (overlayEl.dataset.state === key) return;
    overlayEl.dataset.state = key;
    const existing = new Map();
    for (const child of overlayEl.children) if (child.dataset.key) existing.set(child.dataset.key, child);
    const glow = overlayEl.querySelector(":scope > .stage-glow");
    const ordered = [];
    for (const part of parts) {
      const struct = structural(part);
      let node = existing.get(part.key);
      if (node && node.dataset.struct !== struct) { node.remove(); node = null; }
      if (node) existing.delete(part.key);
      else {
        node = build(part, stage);
        node.dataset.key = part.key;
        node.dataset.struct = struct;
      }
      if (node.dataset.sig !== part.sigText) {
        animate(node, part, stage, theme);
        node.dataset.sig = part.sigText;
      }
      ordered.push(node);
    }
    for (const leftover of existing.values()) leftover.remove();
    overlayEl.replaceChildren(...(glow ? [glow] : []), ...ordered);
  },

  // Position the head card (and the screen track, when the project has
  // one) as layers on the stage from a plan. The card takes the layout's
  // rect; the video inside it takes the punch-in, zooming within the card
  // exactly as the export zooms the track within its mask.
  placeMedia(plan, headEl, screenEl) {
    const { stage, layout, screen, theme } = plan;
    if (layout && stage && headEl) {
      const rect = layout.video;
      // The export drives the head's mask with the same number from the same
      // engine (headExpressions in core/render-plan.mjs), so a dissolve in
      // the window is the dissolve in the film.
      headEl.style.opacity = String(layout.alpha ?? 1);
      headEl.style.left = pct(rect.x, stage.width);
      headEl.style.top = pct(rect.y, stage.height);
      headEl.style.width = pct(rect.w, stage.width);
      headEl.style.height = pct(rect.h, stage.height);
      headEl.style.borderRadius = `${(rect.w * HEAD_RADIUS * theme.radius / stage.width) * 100}cqw`;
      const video = headEl.querySelector("video");
      if (video) {
        const transform = plan.punch > 1 ? `scale(${plan.punch})` : "";
        if (video.style.transform !== transform) video.style.transform = transform;
      }
    }
    if (!screenEl) return;
    if (!screen || !stage) { screenEl.hidden = true; return; }
    screenEl.hidden = false;
    screenEl.style.left = pct(screen.rect.x, stage.width);
    screenEl.style.top = pct(screen.rect.y, stage.height);
    screenEl.style.width = pct(screen.rect.w, stage.width);
    screenEl.style.height = pct(screen.rect.h, stage.height);
    screenEl.style.borderRadius = `${(screen.rect.w * SCREEN_RADIUS * theme.radius / stage.width) * 100}cqw`;
    screenEl.style.opacity = String(screen.alpha);
  },

  // The window's per-frame call: theme the frame, plan, place the media,
  // paint both layers. headEl is the head card (its video inside).
  // layoutOverride: a {video, content} rect pair computed by the caller from
  // the same core engine — the export driver's path. Without it, the preview
  // asks the engine bridged in by the preload.
  update(overlayEl, headEl, compose, t, layoutOverride, screenEl) {
    let layout = layoutOverride ?? null;
    const stage = compose.stage ?? null;
    const videoEl = headEl?.querySelector("video") ?? null;
    if (!layout && compose.layoutTimeline && stage && videoEl && window.FabulaStageEngine) {
      const aspect = videoEl.videoWidth > 0 ? videoEl.videoWidth / videoEl.videoHeight : 1;
      layout = window.FabulaStageEngine.layoutAt(compose.layoutTimeline, t, aspect, stage);
    }
    const plan = this.plan(compose, t, layout);
    plan.punch = punchAt(compose, t);
    if (overlayEl.parentElement) applyTheme(overlayEl.parentElement, plan.theme);
    this.placeMedia(plan, headEl, screenEl);
    this.paint(overlayEl, plan);
    if (stage) driftGlow(overlayEl, t);
  },
};
