// The layered render, planned. No I/O. The head and screen tracks are placed
// on the stage by ffmpeg from expressions generated here — the same numbers
// the stage engine gives the window — and the film is built in chunks whose
// identity is everything that can change their pixels, so a tweak re-renders
// the chunk it touched and nothing else.

import { layoutRects, layoutAt, transitionAt, headDrawRect, MAX_TRANSITION_SECONDS } from "./stage-engine.mjs";
import { punchScaleAt } from "./shot-engine.mjs";

export const RENDERER_VERSION = "layered-3"; // 2: punch-ins placed here; 3: themed, time-driven painter
export const DEFAULT_CHUNK_SECONDS = 120;

const num = (v) => {
  const s = Number(v.toFixed(3)).toString();
  return s.startsWith("-") ? `(${s})` : s;
};

// A ratio, not a pixel: three decimals is a fifth of a pixel on a rectangle
// and a visible error once it multiplies a stage-sized number.
const ratio = (v) => Number(v.toFixed(6)).toString();

// The stage engine's two eases, in ffmpeg's expression language, over a
// window that starts at `from` and lasts `span` seconds. K is clipped, so
// the caller's guard and the curve agree at both edges to the last bit.
const window01 = (T, from, span) => `clip((${T}-${num(from)})/${num(span)},0,1)`;
const smoothstep = (K) => `(${K})*(${K})*(3-2*(${K}))`;
const smootherstep = (K) => `(${K})*(${K})*(${K})*((${K})*((${K})*6-15)+10)`;

// Whether the camera is on the stage during a layout — layoutAlpha, which
// core/stage-engine.mjs keeps private because nothing else needed it.
const alphaOf = (layout) => (layout === "cutaway" ? 0 : 1);

// Where the head sits and how present it is, as five ffmpeg expressions in
// t (with `offset` added, so a chunk that starts at 120 s asks about the
// film's 120 s at its own t=0). Mirrors layoutAt exactly, transition style
// by transition style: a glide eases the rectangle over its window, a
// dissolve steps the rectangle and moves `alpha` instead, a cut steps both.
//
// `alpha` is the string "1" when nothing in the timeline ever fades, which
// is how chunkGraph knows to leave the mask alone.
export function headExpressions(timeline, videoAspect, stage, offset = 0) {
  const T = `(t+${num(offset)})`;
  const layouts = timeline.map((segment) => layoutRects(segment.layout, segment.corner, videoAspect, stage));
  const rects = layouts.map((layout) => layout.video);
  const crossings = timeline.map((_, i) => (i > 0 ? transitionAt(timeline, i) : null));
  const component = (key) => {
    let expr = num(rects[0][key]);
    for (let i = 1; i < timeline.length; i += 1) {
      const start = timeline[i].start;
      const to = rects[i][key];
      const { glide } = crossings[i];
      let segment = num(to);
      if (glide > 0) {
        const from = rects[i - 1][key];
        const during = `${num(from)}+${num(to - from)}*${smootherstep(window01(T, start, glide))}`;
        segment = `if(lt(${T},${num(start + glide)}),${during},${num(to)})`;
      }
      expr = `if(gte(${T},${num(start)}),${segment},${expr})`;
    }
    return expr;
  };
  const fades = crossings.some((c, i) => i > 0 && (c.enter > 0 || c.leave > 0));
  const varies = fades || timeline.some((segment) => alphaOf(segment.layout) !== 1);
  const alpha = () => {
    if (!varies) return "1";
    let expr = num(alphaOf(timeline[0].layout));
    for (let i = 1; i < timeline.length; i += 1) {
      const start = timeline[i].start;
      const { enter, leave } = crossings[i];
      const to = alphaOf(timeline[i].layout);
      // From the boundary on, this segment's own presence, faded up if it
      // has one to fade up to.
      const entering = enter > 0
        ? `if(lt(${T},${num(start + enter)}),${num(to)}*${smoothstep(window01(T, start, enter))},${num(to)})`
        : num(to);
      expr = `if(gte(${T},${num(start)}),${entering},${expr})`;
      // Before it, the outgoing head falls away. Wrapped after the entering
      // clause so it wins inside its own window, exactly as layoutAt tests
      // the next boundary's `leave` before this one's `enter`.
      if (leave > 0) {
        const from = alphaOf(timeline[i - 1].layout);
        expr = `if(gte(${T},${num(start - leave)})*lt(${T},${num(start)}),${num(from)}*(1-${smoothstep(window01(T, start - leave, leave))}),${expr})`;
      }
    }
    return expr;
  };
  // The window the head is seen through, and the head as actually drawn.
  //
  // headDrawRect's max() is done HERE, in the expression, rather than per
  // segment in JavaScript: the max is not linear, so a glide that lerped two
  // pre-computed draw rects would not be the crop the preview shows, which
  // covers the lerped window. One rule, evaluated the same way on both sides.
  const win = { x: component("x"), y: component("y"), w: component("w"), h: component("h") };
  const a = ratio(videoAspect);
  const drawH = `max(${win.h},(${win.w})/${a})`;
  const drawW = `(${drawH})*${a}`;
  const draw = {
    w: drawW,
    h: drawH,
    x: `(${win.x})+((${win.w})-(${drawW}))/2`,
    y: `(${win.y})+((${win.h})-(${drawH}))/2`,
  };
  // Which layouts crop, as a step in t: a cropped head is a picture rather
  // than a card, so it takes the square corners a picture has. Absent from
  // any landscape film, where nothing ever crops.
  const fits = layouts.map((layout) => layout.fit === "cover");
  const cropped = fits.some(Boolean);
  const contained = fits.some((covers) => !covers);
  return {
    // x/y/w/h stay the window — the rectangle layoutAt reports, the one the
    // card occupies and the mask clips to. `draw` is where the footage goes
    // inside it, which for everything that does not crop is the same rect.
    ...win,
    draw,
    alpha: alpha(),
    cropped,
    // "1" while a cropped layout holds. Only ever consulted by a film that
    // has both kinds, which is the only film whose mask has to change shape.
    croppedAt: cropped && contained ? step(T, timeline, (_, i) => (fits[i] ? 1 : 0)) : null,
  };
}

// A per-segment constant as an expression in T: the value of the segment
// that holds at that instant, with no easing — the picture's shape changes
// on the boundary frame even when the rectangle takes a moment to arrive.
function step(T, timeline, valueOf) {
  let expr = num(valueOf(timeline[0], 0));
  for (let i = 1; i < timeline.length; i += 1) {
    expr = `if(gte(${T},${num(timeline[i].start)}),${num(valueOf(timeline[i], i))},${expr})`;
  }
  return expr;
}

// The punch-in scale at t: a step function over the clean-timeline spans,
// wide (1) everywhere no span punches. Half-open like punchScaleAt, so the
// two agree at every frame. Pass only the spans that touch the chunk.
export function punchExpression(spans, offset = 0) {
  const T = `(t+${num(offset)})`;
  let expr = "1";
  for (const span of spans) {
    if (!(span.scale > 1)) continue;
    expr = `if(gte(${T},${num(span.start)})*lt(${T},${num(span.end)}),${num(span.scale)},${expr})`;
  }
  return expr;
}

// The glow's centre drifts with the same sines the window uses; the
// rendered glow is a square of `size` pixels overlaid by its top-left.
export function glowExpressions(stage, size, offset = 0) {
  const T = `(t+${num(offset)})`;
  return {
    x: `${stage.width}*(50+sin(${T}*0.21)*26+sin(${T}*0.047)*10)/100-${size / 2}`,
    y: `${stage.height}*(42+cos(${T}*0.16)*20)/100-${size / 2}`,
  };
}

// Evaluates the subset of ffmpeg's expression language the generators emit,
// so a test can hold the expressions to the engine's own numbers.
export function evaluateExpression(source, vars) {
  let i = 0;
  const peek = () => source[i];
  const eat = (c) => { if (source[i] !== c) throw new Error(`expected ${c} at ${i} in ${source}`); i += 1; };
  const fns = {
    if: (c, a, b) => (c ? a : b), lt: (a, b) => (a < b ? 1 : 0), gte: (a, b) => (a >= b ? 1 : 0),
    pow: Math.pow, sin: Math.sin, cos: Math.cos, clip: (x, lo, hi) => Math.min(Math.max(x, lo), hi), hypot: Math.hypot,
    max: Math.max, min: Math.min,
    between: (x, a, b) => (x >= a && x <= b ? 1 : 0),
  };
  const parseExpr = () => {
    let value = parseTerm();
    while (peek() === "+" || peek() === "-") { const op = source[i]; i += 1; const rhs = parseTerm(); value = op === "+" ? value + rhs : value - rhs; }
    return value;
  };
  const parseTerm = () => {
    let value = parseUnary();
    while (peek() === "*" || peek() === "/") { const op = source[i]; i += 1; const rhs = parseUnary(); value = op === "*" ? value * rhs : value / rhs; }
    return value;
  };
  const parseUnary = () => {
    if (peek() === "-") { i += 1; return -parseUnary(); }
    return parseAtom();
  };
  const parseAtom = () => {
    if (peek() === "(") { eat("("); const v = parseExpr(); eat(")"); return v; }
    const m = /^[0-9]*\.?[0-9]+(e[+-]?[0-9]+)?/.exec(source.slice(i));
    if (m) { i += m[0].length; return Number(m[0]); }
    const id = /^[a-zA-Z_]+/.exec(source.slice(i));
    if (!id) throw new Error(`unexpected ${source[i]} at ${i}`);
    i += id[0].length;
    if (peek() === "(") {
      eat("(");
      const args = [parseExpr()];
      while (peek() === ",") { i += 1; args.push(parseExpr()); }
      eat(")");
      return fns[id[0]](...args);
    }
    if (!(id[0] in vars)) throw new Error(`unknown variable ${id[0]}`);
    return vars[id[0]];
  };
  const value = parseExpr();
  if (i !== source.length) throw new Error(`trailing input at ${i}`);
  return value;
}

// The film in chunks, each starting on a frame boundary. A chunk is the unit
// of caching and of parallel encoding.
export function chunkPlan(from, to, fps = 30, chunkSeconds = DEFAULT_CHUNK_SECONDS) {
  const frame = (t) => Math.round(t * fps);
  const first = frame(from);
  const last = frame(to);
  const chunks = [];
  for (let f = first, index = 0; f < last; index += 1) {
    const end = Math.min(f + Math.round(chunkSeconds * fps), last);
    chunks.push({ index, start: f / fps, end: end / fps, frames: end - f });
    f = end;
  }
  return chunks;
}

const overlaps = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;

// The punch spans a chunk sees: those that tighten and touch it.
export function punchPlacements(spans, chunk) {
  return (spans ?? []).filter((span) => span.scale > 1 && overlaps(span.start, span.end, chunk.start, chunk.end));
}

// Everything that can change a chunk's pixels, as one canonical string. Hash
// it and you have the cache key. Media identity and the encoder come from
// the caller (size and mtime of the tracks, the encoder's arguments), since
// core does no I/O.
export function chunkIdentity(chunk, context) {
  const { scenes, timeline, captions, wordSpans, theme, stage, videoAspect, media, fps, punch, encoder, painter } = context;
  const lead = MAX_TRANSITION_SECONDS + 0.1;
  const within = (item) => overlaps(item.start, item.end, chunk.start - lead, chunk.end);
  // The timeline reaches BOTH ways. A glide runs after its boundary, so a
  // segment starting before the chunk can still be moving inside it; a
  // dissolve begins before its boundary, so a segment that starts after the
  // chunk ends can still be fading the head out inside it. Miss the second
  // and a chunk keeps its cached pixels when the shot after it moved.
  const touching = (item) => overlaps(item.start, item.end, chunk.start - lead, chunk.end + lead);
  const kineticInside = scenes.some((scene) => scene.type === "kinetic" && within(scene));
  return JSON.stringify({
    renderer: RENDERER_VERSION,
    chunk: [chunk.start, chunk.end],
    fps, stage, videoAspect: Number(videoAspect.toFixed(5)),
    theme: theme ?? null, // the whole resolved theme: fonts, styles, logo, glow all change pixels
    timeline: timeline.filter(touching).map((s) => [s.start, s.end, s.layout, s.corner ?? null, s.transition ?? null, s.transitionSeconds ?? null]),
    scenes: scenes.filter(within),
    captions: captions ? captions.filter(within) : null,
    wordSpans: kineticInside ? wordSpans.filter(within) : null,
    punch: punchPlacements(punch, chunk).map((s) => [s.start, s.end, s.scale]),
    media,
    encoder: encoder ?? null, // chunks are stitched by copy; one encoder per film
    painter: painter ?? null, // a hash of the painter's own files: a CSS tweak is a new picture
  });
}

// Screen scenes as ffmpeg sees them: chunk-local start and end, the rect the
// page measured, and the presence fade the card uses, linearised.
export function screenPlacements(screenScenes, chunk) {
  return screenScenes
    .filter((scene) => overlaps(scene.start, scene.end, chunk.start, chunk.end))
    .map((scene) => {
      const span = scene.end - scene.start;
      const fade = Math.max(span * 0.07, 0.05);
      return { rect: scene.rect, start: scene.start - chunk.start, end: scene.end - chunk.start, fade };
    });
}

// One chunk's ffmpeg graph. Inputs, in order: 0 field, 1 glow, 2 head track,
// 3 head mask (at the track's own size), 4 under states, 5 over states, then
// a screen track and mask pair per screen placement. The caller only adds
// paths.
//
// The head takes one of two routes. Without a punch-in, mask and picture
// merge at the track's own size and scale together (two streams scaled by
// the same expressions can land a frame apart at a transition, and
// alphamerge refuses mismatched sizes). With a punch-in the picture must
// zoom inside a card that does not, so the zoomed head is laid on a
// transparent stage-sized canvas and the card's rounded mask on a black one;
// both canvases are always stage-sized, so alphamerge never sees a mismatch
// and a frame of drift shows as a sliver, not a failure. Pixel formats
// convert BEFORE any per-frame scale: a conversion placed after one is
// configured at the first size and quietly rescales every later frame back
// to it.
//
// The head's opacity rides the mask. eq's brightness is a per-frame offset
// on the luma, so on a mask that is white inside the card and black outside,
// brightness = alpha - 1 scales white to alpha*255 and leaves black at
// black — a fade, in one cheap filter, driven by the same expression in t
// the preview reads. Nothing is added when no boundary in the chunk fades.
// The card's shape, on a canvas, ready to be the head's alpha.
//
// A contained head is a rounded card and takes the rounded plate the render
// generated at the footage's own size. A cropped head is a picture — a
// vertical film's full-bleed shot, or the top half of a stacked one — and
// takes square corners, because scaling a rounded plate to a window of a
// different shape would give it elliptical ones, and because a picture that
// reaches the edge of the film should not be rounded off at the film's
// corners. A film that does both switches per segment, on the boundary
// frame, in both renderers.
function maskLines(head, canvas, fade) {
  const win = head; // x/y/w/h on the head object ARE the window
  const { croppedAt } = head;
  const place = (base, tag, enable) =>
    `[${base}][${tag}]overlay=x='${win.x}':y='${win.y}':eval=frame:format=auto${enable ? `:enable='${enable}'` : ""}`;
  const lines = [];
  if (!head.cropped || croppedAt !== null) lines.push(`[3:v]format=rgba,scale=w='${win.w}':h='${win.h}':eval=frame:flags=bicubic[msz]`);
  if (head.cropped) lines.push(`color=c=white:${canvas},format=rgba,scale=w='${win.w}':h='${win.h}':eval=frame[msq]`);
  lines.push(`color=c=black:${canvas},format=rgba[mbase]`);
  if (croppedAt === null) {
    // One shape for the whole film: the rounded plate when nothing crops, the
    // square when everything does.
    lines.push(`${place("mbase", head.cropped ? "msq" : "msz")},format=gray${fade}[cardmask]`);
  } else {
    // Both kinds in one film: the shape changes on the boundary frame, which
    // is what the window does too.
    lines.push(`${place("mbase", "msz", `lt(${croppedAt},0.5)`)}[m1]`);
    lines.push(`${place("m1", "msq", `gte(${croppedAt},0.5)`)},format=gray${fade}[cardmask]`);
  }
  return lines;
}

export function chunkGraph({ chunk, timeline, videoAspect, stage, glowSize, screens, punch = [], fps = 30 }) {
  const head = headExpressions(timeline, videoAspect, stage, chunk.start);
  const glow = glowExpressions(stage, glowSize, chunk.start);
  const punched = punchPlacements(punch, chunk);
  const fade = head.alpha === "1" ? "" : `,eq=brightness='(${head.alpha})-1':eval=frame`;
  const lines = [];
  lines.push("[0:v]format=rgba[base0]");
  lines.push("[1:v]format=rgba[glow]");
  lines.push(`[base0][glow]overlay=x='${glow.x}':y='${glow.y}':eval=frame:format=auto[b1]`);
  let base = "b1";
  screens.forEach((screen, k) => {
    const video = 6 + k * 2;
    const mask = 7 + k * 2;
    const { rect } = screen;
    const fadeOutAt = Math.max(screen.end - screen.fade, screen.start);
    lines.push(
      `[${video}:v]scale=${rect.w}:${rect.h}:force_original_aspect_ratio=decrease:flags=bicubic,` +
      `pad=${rect.w}:${rect.h}:-1:-1:color=0x0b0e12,format=rgba[sc${k}]`,
    );
    lines.push(`[${mask}:v]format=gray[sm${k}]`);
    lines.push(
      `[sc${k}][sm${k}]alphamerge,fade=t=in:st=${num(Math.max(screen.start, 0))}:d=${num(screen.fade)}:alpha=1,` +
      `fade=t=out:st=${num(fadeOutAt)}:d=${num(screen.fade)}:alpha=1[scr${k}]`,
    );
    lines.push(`[${base}][scr${k}]overlay=x=${rect.x}:y=${rect.y}:enable='between(t,${num(screen.start)},${num(screen.end)})':format=auto[bs${k}]`);
    base = `bs${k}`;
  });
  lines.push("[4:v]format=rgba[under]");
  lines.push(`[${base}][under]overlay=0:0:format=auto[bu]`);
  if (punched.length === 0 && !head.cropped) {
    // Nothing crops and nothing zooms: the head and its mask are the same
    // rectangle, so they scale together in one filter and land in one
    // overlay. Every landscape film takes this path.
    lines.push("[2:v]format=rgba[h0]");
    lines.push(`[3:v]format=gray${fade}[hm]`);
    lines.push(`[h0][hm]alphamerge,scale=w='${head.w}':h='${head.h}':eval=frame:flags=bicubic[head]`);
    lines.push(`[bu][head]overlay=x='${head.x}':y='${head.y}':eval=frame:format=auto[bh]`);
  } else {
    // The head is drawn at one rectangle and seen through another. A punch-in
    // scales the drawn one about its centre; a cropped layout draws it larger
    // than the window on purpose. Both are the same composite: put the
    // footage on a full canvas, put the card's shape on another, alphamerge.
    const S = punchExpression(punched, chunk.start);
    const flat = S === "1"; // no punch-in in this chunk: the zoom drops out
    const canvas = `s=${stage.width}x${stage.height}:r=${fps}:d=${num(chunk.frames / fps)}`;
    const { draw } = head;
    const dw = flat ? draw.w : `(${draw.w})*(${S})`;
    const dh = flat ? draw.h : `(${draw.h})*(${S})`;
    const dx = flat ? draw.x : `(${draw.x})-((${draw.w})*(${S})-(${draw.w}))/2`;
    const dy = flat ? draw.y : `(${draw.y})-((${draw.h})*(${S})-(${draw.h}))/2`;
    lines.push(`[2:v]format=rgba,scale=w='${dw}':h='${dh}':eval=frame:flags=bicubic[hz]`);
    lines.push(`color=c=black@0:${canvas},format=rgba[hbase]`);
    lines.push(`[hbase][hz]overlay=x='${dx}':y='${dy}':eval=frame:format=auto[hc]`);
    lines.push(...maskLines(head, canvas, fade));
    lines.push("[hc][cardmask]alphamerge[head]");
    lines.push("[bu][head]overlay=0:0:format=auto[bh]");
  }
  lines.push("[5:v]format=rgba[over]");
  lines.push("[bh][over]overlay=0:0:format=auto,format=yuv420p[out]");
  return lines.join(";\n") + "\n";
}

// The rect ffmpeg will use at t, for tests and for the shadow's placement.
export function headRectAt(timeline, t, videoAspect, stage) {
  return layoutAt(timeline, t, videoAspect, stage).video;
}

// The punch scale ffmpeg will use at t, for tests.
export function punchScaleAtTime(spans, t) {
  return punchScaleAt(spans, t);
}
