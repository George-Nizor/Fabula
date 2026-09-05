// The layered render, planned. No I/O. The head and screen tracks are placed
// on the stage by ffmpeg from expressions generated here — the same numbers
// the stage engine gives the window — and the film is built in chunks whose
// identity is everything that can change their pixels, so a tweak re-renders
// the chunk it touched and nothing else.

import { layoutRects, layoutAt } from "./stage-engine.mjs";
import { punchScaleAt } from "./shot-engine.mjs";

export const RENDERER_VERSION = "layered-3"; // 2: punch-ins placed here; 3: themed, time-driven painter
export const TRANSITION_SECONDS = 0.6;
export const DEFAULT_CHUNK_SECONDS = 120;

const num = (v) => {
  const s = Number(v.toFixed(3)).toString();
  return s.startsWith("-") ? `(${s})` : s;
};

// The stage engine's ease, in ffmpeg's expression language, over a
// sub-expression K in [0,1].
const ease = (K) => `if(lt(${K},0.5),4*${K}*${K}*${K},1-pow(-2*${K}+2,3)/2)`;

// Where the head sits, as four ffmpeg expressions in t (with `offset` added,
// so a chunk that starts at 120 s asks about the film's 120 s at its own
// t=0). Mirrors layoutAt: each segment holds its rect, easing from the
// previous rect over the first TRANSITION_SECONDS, first segment excepted.
export function headExpressions(timeline, videoAspect, stage, offset = 0) {
  const T = `(t+${num(offset)})`;
  const rects = timeline.map((segment) => layoutRects(segment.layout, segment.corner, videoAspect, stage).video);
  const component = (key) => {
    let expr = num(rects[0][key]);
    for (let i = 1; i < timeline.length; i += 1) {
      const start = timeline[i].start;
      const from = rects[i - 1][key];
      const to = rects[i][key];
      const K = `((${T}-${num(start)})/${TRANSITION_SECONDS})`;
      const during = `${num(from)}+${num(to - from)}*${ease(K)}`;
      const segment = `if(lt(${T},${num(start + TRANSITION_SECONDS)}),${during},${num(to)})`;
      expr = `if(gte(${T},${num(start)}),${segment},${expr})`;
    }
    return expr;
  };
  return { x: component("x"), y: component("y"), w: component("w"), h: component("h") };
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
  const lead = TRANSITION_SECONDS + 0.1;
  const within = (item) => overlaps(item.start, item.end, chunk.start - lead, chunk.end);
  const kineticInside = scenes.some((scene) => scene.type === "kinetic" && within(scene));
  return JSON.stringify({
    renderer: RENDERER_VERSION,
    chunk: [chunk.start, chunk.end],
    fps, stage, videoAspect: Number(videoAspect.toFixed(5)),
    theme: theme ?? null, // the whole resolved theme: fonts, styles, logo, glow all change pixels
    timeline: timeline.filter(within).map((s) => [s.start, s.end, s.layout, s.corner ?? null]),
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
export function chunkGraph({ chunk, timeline, videoAspect, stage, glowSize, screens, punch = [], fps = 30 }) {
  const head = headExpressions(timeline, videoAspect, stage, chunk.start);
  const glow = glowExpressions(stage, glowSize, chunk.start);
  const punched = punchPlacements(punch, chunk);
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
  if (punched.length === 0) {
    lines.push("[2:v]format=rgba[h0]");
    lines.push("[3:v]format=gray[hm]");
    lines.push(`[h0][hm]alphamerge,scale=w='${head.w}':h='${head.h}':eval=frame:flags=bicubic[head]`);
    lines.push(`[bu][head]overlay=x='${head.x}':y='${head.y}':eval=frame:format=auto[bh]`);
  } else {
    const S = punchExpression(punched, chunk.start);
    const canvas = `s=${stage.width}x${stage.height}:r=${fps}:d=${num(chunk.frames / fps)}`;
    lines.push(`[2:v]format=rgba,scale=w='(${head.w})*(${S})':h='(${head.h})*(${S})':eval=frame:flags=bicubic[hz]`);
    lines.push(`color=c=black@0:${canvas},format=rgba[hbase]`);
    lines.push(`[hbase][hz]overlay=x='(${head.x})-((${head.w})*(${S})-(${head.w}))/2':y='(${head.y})-((${head.h})*(${S})-(${head.h}))/2':eval=frame:format=auto[hc]`);
    lines.push(`[3:v]format=rgba,scale=w='${head.w}':h='${head.h}':eval=frame:flags=bicubic[msz]`);
    lines.push(`color=c=black:${canvas},format=rgba[mbase]`);
    lines.push(`[mbase][msz]overlay=x='${head.x}':y='${head.y}':eval=frame:format=auto,format=gray[cardmask]`);
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
