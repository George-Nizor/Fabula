import test from "node:test";
import assert from "node:assert/strict";
import {
  headExpressions,
  glowExpressions,
  punchExpression,
  punchPlacements,
  evaluateExpression,
  chunkPlan,
  chunkIdentity,
  screenPlacements,
  chunkGraph,
  headRectAt,
  punchScaleAtTime,
} from "../core/render-plan.mjs";
import { DEFAULT_STAGE, resolveLayoutTimeline, layoutAt, headDrawRect } from "../core/stage-engine.mjs";

const stage = DEFAULT_STAGE;
const aspect = 16 / 9;
const scenes = [
  { type: "stage", start: 5, end: 12, layout: "pip", corner: "br" },
  { type: "stage", start: 20, end: 30, layout: "side" },
];
const timeline = resolveLayoutTimeline(scenes, 40);
const punch = [
  { start: 0, end: 3.2, scale: 1 },
  { start: 3.2, end: 9.75, scale: 1.15 },
  { start: 9.75, end: 15, scale: 1 },
  { start: 15, end: 22.5, scale: 1.15 },
  { start: 22.5, end: 40, scale: 1 },
];

test("the head expressions agree with layoutAt at every instant, transitions included", () => {
  for (const offset of [0, 20.5]) {
    const expr = headExpressions(timeline, aspect, stage, offset);
    for (let t = 0; t < 40; t += 0.05) {
      const local = t - offset;
      if (local < 0) continue;
      const expected = headRectAt(timeline, t, aspect, stage);
      for (const key of ["x", "y", "w", "h"]) {
        const got = evaluateExpression(expr[key], { t: local });
        assert.ok(Math.abs(got - expected[key]) < 0.01, `${key} at t=${t.toFixed(2)} (offset ${offset}): ${got} vs ${expected[key]}`);
      }
    }
  }
});

test("the punch expression agrees with punchScaleAt at every frame, boundaries half-open", () => {
  for (const offset of [0, 10]) {
    const chunk = { start: offset, end: offset + 20 };
    const expr = punchExpression(punchPlacements(punch, chunk), offset);
    for (let f = 0; f < 600; f += 1) {
      const t = offset + f / 30;
      assert.equal(evaluateExpression(expr, { t: f / 30 }), punchScaleAtTime(punch, t), `scale at t=${t.toFixed(3)} (offset ${offset})`);
    }
  }
  assert.equal(punchExpression([], 0), "1");
});

test("the glow expressions follow the window's drift", () => {
  const expr = glowExpressions(stage, 1728, 10);
  const t = 3.3;
  const x = 50 + Math.sin((t + 10) * 0.21) * 26 + Math.sin((t + 10) * 0.047) * 10;
  const y = 42 + Math.cos((t + 10) * 0.16) * 20;
  assert.ok(Math.abs(evaluateExpression(expr.x, { t }) - (stage.width * x / 100 - 864)) < 0.01);
  assert.ok(Math.abs(evaluateExpression(expr.y, { t }) - (stage.height * y / 100 - 864)) < 0.01);
});

test("chunks tile the span on frame boundaries", () => {
  const chunks = chunkPlan(0, 300.5, 30, 120);
  assert.deepEqual(chunks.map((c) => [c.start, c.end]), [[0, 120], [120, 240], [240, 300.5]]);
  assert.equal(chunks.reduce((n, c) => n + c.frames, 0), Math.round(300.5 * 30));
  const partial = chunkPlan(6.5, 20, 30, 120);
  assert.equal(partial.length, 1);
  assert.equal(partial[0].frames, Math.round(13.5 * 30));
});

test("chunk identity changes with what touches the chunk and nothing else", () => {
  const base = {
    scenes: [{ type: "title", start: 1, end: 3, text: "Hi" }, { type: "title", start: 200, end: 203, text: "Later" }],
    timeline, captions: null, wordSpans: [], theme: { accent: "#d97757" }, stage, videoAspect: aspect,
    media: { clean: "a", screen: null }, fps: 30, punch, encoder: "libx264 -crf 18",
  };
  const chunk = { index: 0, start: 0, end: 120, frames: 3600 };
  const a = chunkIdentity(chunk, base);
  const later = { ...base, scenes: [base.scenes[0], { ...base.scenes[1], text: "Changed" }] };
  assert.equal(chunkIdentity(chunk, later), a); // a scene outside the chunk does not matter
  const early = { ...base, scenes: [{ ...base.scenes[0], text: "Changed" }, base.scenes[1]] };
  assert.notEqual(chunkIdentity(chunk, early), a);
  assert.notEqual(chunkIdentity(chunk, { ...base, theme: { accent: "#000000" } }), a);
  assert.notEqual(chunkIdentity(chunk, { ...base, media: { clean: "b", screen: null } }), a);
  assert.notEqual(chunkIdentity(chunk, { ...base, punch: [] }), a);
  assert.notEqual(chunkIdentity(chunk, { ...base, encoder: "h264_nvenc -cq 19" }), a);
  assert.notEqual(chunkIdentity(chunk, { ...base, painter: "deadbeef" }), a);
  const zoomed = punch.map((s) => (s.scale > 1 ? { ...s, scale: 1.25 } : s));
  assert.notEqual(chunkIdentity(chunk, { ...base, punch: zoomed }), a);
  const farPunch = [...punch, { start: 500, end: 510, scale: 1.15 }];
  assert.equal(chunkIdentity(chunk, { ...base, punch: farPunch }), a); // a punch outside the chunk does not matter
});

test("screen placements are chunk-local with a linearised presence fade", () => {
  const placed = screenPlacements([{ start: 100, end: 130, rect: { x: 1, y: 2, w: 3, h: 4 } }], { start: 90, end: 150 });
  assert.equal(placed.length, 1);
  assert.equal(placed[0].start, 10);
  assert.equal(placed[0].end, 40);
  assert.ok(Math.abs(placed[0].fade - 2.1) < 1e-9);
});

const inOrder = (graph, markers) => {
  let at = -1;
  for (const marker of markers) {
    const next = graph.indexOf(marker);
    assert.ok(next > at, `${marker} out of order (at ${next}, after ${at})`);
    at = next;
  }
};

test("the chunk graph wires field, glow, screens, under, head, over in order", () => {
  const graph = chunkGraph({
    chunk: { start: 0, end: 30, frames: 900 }, timeline, videoAspect: aspect, stage, glowSize: 1728,
    screens: [{ rect: { x: 100, y: 50, w: 800, h: 450 }, start: 2, end: 10, fade: 0.56 }],
  });
  inOrder(graph, ["[base0][glow]overlay", "[6:v]scale=800:450", "alphamerge,fade=t=in", "[4:v]format=rgba[under]", "[h0][hm]alphamerge,scale=", "[5:v]format=rgba[over]", "format=yuv420p[out]"]);
  assert.ok(!graph.includes("color=c=black@0"), "no canvas without a punch");
});

test("a chunk with a punch takes the canvas route: convert, zoom, mask at stage size, merge", () => {
  const chunk = { start: 0, end: 12, frames: 360 };
  const graph = chunkGraph({ chunk, timeline, videoAspect: aspect, stage, glowSize: 1728, screens: [], punch });
  inOrder(graph, [
    "[2:v]format=rgba,scale=w='(", "color=c=black@0:s=1920x1080:r=30:d=12", "[hbase][hz]overlay",
    "[3:v]format=rgba,scale=w='", "color=c=black:s=1920x1080", "[mbase][msz]overlay", ",format=gray[cardmask]",
    "[hc][cardmask]alphamerge[head]", "[bu][head]overlay=0:0", "format=yuv420p[out]",
  ]);
  // Only the spans that tighten inside the chunk are written into it.
  assert.ok(graph.includes("lt((t+0),9.75),1.15"));
  assert.ok(!graph.includes("22.5"), "a span past the chunk stays out of the expression");
  const wide = chunkGraph({ chunk: { start: 30, end: 40, frames: 300 }, timeline, videoAspect: aspect, stage, glowSize: 1728, screens: [], punch });
  assert.ok(!wide.includes("color=c=black@0"), "a chunk with nothing punched takes the plain route");
});

test("cutaway export agrees with preview at every boundary and chunk offset", () => {
  const timeline = resolveLayoutTimeline([{ type: "stage", layout: "cutaway", start: 5, end: 7 }], 12);
  for (const offset of [0, 5.2]) {
    const expr = headExpressions(timeline, aspect, stage, offset);
    for (const t of [4.4, 4.6, 4.999, 5, 5.1, 5.599, 6.999, 7, 7.2, 7.6, 8]) {
      if (t < offset) continue;
      const expected = headRectAt(timeline, t, aspect, stage);
      for (const key of ["x", "y", "w", "h"]) assert.ok(Math.abs(evaluateExpression(expr[key], { t: t - offset }) - expected[key]) < .01);
    }
  }
});

// The head's opacity is the second half of the same contract as its
// rectangle: the export drives the mask with this expression while the
// window sets the card's opacity from layoutAt, so a disagreement would
// show as a head that fades in the preview and pops in the film.
test("the alpha expression agrees with layoutAt for every transition style", () => {
  for (const style of ["dissolve", "glide", "cut"]) {
    const tl = resolveLayoutTimeline([
      { type: "stage", layout: "pip", corner: "br", start: 5, end: 12 },
      { type: "stage", layout: "cutaway", start: 16, end: 24 },
      { type: "stage", layout: "side", start: 24, end: 34 },
    ], 40, { transition: style });
    for (const offset of [0, 15.5]) {
      const expr = headExpressions(tl, aspect, stage, offset);
      for (let t = 0; t < 40; t += 0.02) {
        if (t < offset) continue;
        const expected = layoutAt(tl, t, aspect, stage).alpha;
        const got = evaluateExpression(expr.alpha, { t: t - offset });
        assert.ok(Math.abs(got - expected) < 0.002, `${style} alpha at t=${t.toFixed(2)} (offset ${offset}): ${got} vs ${expected}`);
      }
    }
  }
});

test("a film that never fades pays nothing for the fade", () => {
  // A glide moves the head; it never changes its opacity, so the mask is
  // left exactly as it was before any of this existed.
  for (const transition of ["glide", "cut"]) {
    const tl = resolveLayoutTimeline([{ type: "stage", layout: "pip", start: 5, end: 12 }], 40, { transition });
    assert.equal(headExpressions(tl, aspect, stage, 0).alpha, "1", transition);
    const graph = chunkGraph({ chunk: { start: 0, end: 30, frames: 900 }, timeline: tl, videoAspect: aspect, stage, glowSize: 1728, screens: [] });
    assert.ok(graph.includes("[3:v]format=gray[hm]"), `no eq filter for ${transition}`);
  }
  const dissolving = resolveLayoutTimeline([{ type: "stage", layout: "pip", start: 5, end: 12 }], 40, { transition: "dissolve" });
  const fading = chunkGraph({ chunk: { start: 0, end: 30, frames: 900 }, timeline: dissolving, videoAspect: aspect, stage, glowSize: 1728, screens: [] });
  assert.ok(fading.includes("[3:v]format=gray,eq=brightness='("), "the dissolve rides the mask");
  // A cutaway fades whatever the style, because the camera has to go.
  const cutaway = resolveLayoutTimeline([{ type: "stage", layout: "cutaway", start: 5, end: 12 }], 40, { transition: "glide" });
  assert.notEqual(headExpressions(cutaway, aspect, stage, 0).alpha, "1");
});

test("the film's transition seconds override the style's own", () => {
  const scenes = [{ type: "stage", layout: "side", start: 10, end: 20 }];
  const quick = resolveLayoutTimeline(scenes, 40, { transition: "glide", transitionSeconds: 0.4 });
  const slow = resolveLayoutTimeline(scenes, 40, { transition: "glide", transitionSeconds: 1.6 });
  assert.equal(layoutAt(quick, 10.5, aspect, stage).settled, true, "0.4 s is over by 10.5");
  assert.equal(layoutAt(slow, 10.5, aspect, stage).settled, false, "1.6 s is not");
  // And the export follows the same numbers.
  for (const tl of [quick, slow]) {
    const expr = headExpressions(tl, aspect, stage, 0);
    for (let t = 9.5; t < 12; t += 0.02) {
      const expected = headRectAt(tl, t, aspect, stage);
      assert.ok(Math.abs(evaluateExpression(expr.x, { t }) - expected.x) < 0.01, `x at ${t.toFixed(2)}`);
    }
  }
});

// A dissolve begins before its boundary: the shot AFTER a chunk can change
// pixels inside it, so it has to be in the key.
test("a chunk's identity reaches past its own end for the shot that follows", () => {
  const chunk = { start: 0, end: 30 };
  // Only the shot after the chunk differs; everything before it is identical.
  const context = (start, corner) => ({
    scenes: [], timeline: resolveLayoutTimeline([{ type: "stage", layout: "pip", corner, start, end: start + 8 }], 60), captions: null,
    wordSpans: [], theme: null, stage, videoAspect: aspect, media: {}, fps: 30, punch: [], encoder: "x", painter: "y",
  });
  assert.notEqual(chunkIdentity(chunk, context(30.2, "br")), chunkIdentity(chunk, context(30.2, "tl")),
    "a boundary just past the chunk fades the head out inside it");
  assert.equal(chunkIdentity(chunk, context(45, "br")), chunkIdentity(chunk, context(45, "tl")),
    "one far enough past it changes nothing");
});

test("the transition is part of a chunk's identity", () => {
  const scenes = [{ type: "stage", layout: "side", start: 5, end: 20 }];
  const chunk = { start: 0, end: 30 };
  const context = (transition) => ({
    scenes, timeline: resolveLayoutTimeline(scenes, 40, { transition }), captions: null, wordSpans: [],
    theme: null, stage, videoAspect: aspect, media: {}, fps: 30, punch: [], encoder: "x", painter: "y",
  });
  assert.notEqual(chunkIdentity(chunk, context("dissolve")), chunkIdentity(chunk, context("glide")));
});

// ---- A tall frame ----
//
// The crop is the one thing in the composition that ffmpeg computes rather
// than copies: the window eases, and the head that covers it is derived from
// the eased window on both sides. If those two derivations ever disagree the
// preview shows one crop and the film another, which is exactly the class of
// bug the expression tests exist to catch.
test("the drawn head agrees with headDrawRect at every instant of a tall film", () => {
  const portrait = { width: 1080, height: 1920 };
  const tl = resolveLayoutTimeline([
    { type: "stage", layout: "band", start: 4, end: 12 },
    { type: "stage", layout: "side", start: 16, end: 24 },
    { type: "stage", layout: "pip", corner: "tr", start: 28, end: 36 },
  ], 40);
  for (const offset of [0, 13.5]) {
    const expr = headExpressions(tl, aspect, portrait, offset);
    for (let t = 0; t < 40; t += 0.05) {
      if (t < offset) continue;
      const expected = headDrawRect(headRectAt(tl, t, aspect, portrait), aspect);
      for (const key of ["x", "y", "w", "h"]) {
        const got = evaluateExpression(expr.draw[key], { t: t - offset });
        assert.ok(Math.abs(got - expected[key]) < 0.02, `draw ${key} at t=${t.toFixed(2)} (offset ${offset}): ${got} vs ${expected[key]}`);
      }
      // The window is still the window: the card, the mask and the shadow.
      const window = headRectAt(tl, t, aspect, portrait);
      for (const key of ["x", "y", "w", "h"]) {
        assert.ok(Math.abs(evaluateExpression(expr[key], { t: t - offset }) - window[key]) < 0.02, `window ${key} at t=${t.toFixed(2)}`);
      }
    }
  }
});

test("a landscape film never crops, so its graph is the one-overlay route it always was", () => {
  const expr = headExpressions(timeline, aspect, stage, 0);
  assert.equal(expr.cropped, false);
  assert.equal(expr.croppedAt, null);
  const graph = chunkGraph({ chunk: { start: 0, end: 30, frames: 900 }, timeline, videoAspect: aspect, stage, glowSize: 1728, screens: [] });
  assert.ok(graph.includes("[h0][hm]alphamerge,scale="));
  assert.ok(!graph.includes("[msq]"), "no square mask where nothing is cropped");
});

test("a tall film composites through the canvas, and says which mask each moment wants", () => {
  const portrait = { width: 1080, height: 1920 };
  const chunk = { start: 0, end: 30, frames: 900 };
  const args = { chunk, videoAspect: aspect, stage: portrait, glowSize: 972, screens: [] };
  // Cropped throughout: one square mask, no plate, no switch.
  const cropped = resolveLayoutTimeline([{ type: "stage", layout: "side", start: 5, end: 20 }], 30);
  const all = chunkGraph({ ...args, timeline: cropped });
  assert.ok(all.includes("[msq]") && !all.includes("[msz]"), "nothing contains, so the rounded plate is never scaled");
  assert.ok(all.includes("[hc][cardmask]alphamerge[head]"));
  assert.equal(headExpressions(cropped, aspect, portrait, 0).croppedAt, null);
  // A band among them: both masks, switched on the boundary frame.
  const mixed = resolveLayoutTimeline([{ type: "stage", layout: "band", start: 5, end: 20 }], 30);
  const both = chunkGraph({ ...args, timeline: mixed });
  assert.ok(both.includes("[msq]") && both.includes("[msz]"));
  assert.ok(both.includes(":enable='lt(") && both.includes(":enable='gte("));
  const at = headExpressions(mixed, aspect, portrait, 0).croppedAt;
  assert.equal(evaluateExpression(at, { t: 1 }), 1, "focus crops");
  assert.equal(evaluateExpression(at, { t: 10 }), 0, "the band does not");
  assert.equal(evaluateExpression(at, { t: 25 }), 1);
});

test("a screen scene already in progress at a chunk's start does not fade in again", () => {
  const placed = screenPlacements([{ start: 100, end: 250, rect: { x: 0, y: 0, w: 960, h: 540 } }], { start: 120, end: 240, frames: 3600 });
  assert.equal(placed.length, 1);
  assert.ok(placed[0].start < 0, "chunk-local start is negative for a scene in progress");
  const graph = chunkGraph({ chunk: { start: 120, end: 240, frames: 3600 }, timeline: resolveLayoutTimeline([], 300), videoAspect: aspect, stage, glowSize: 1728, screens: placed });
  assert.ok(!graph.includes("fade=t=in"), "no fade-in at the boundary");
  assert.ok(graph.includes("fade=t=out"));
  const fresh = screenPlacements([{ start: 130, end: 200, rect: { x: 0, y: 0, w: 960, h: 540 } }], { start: 120, end: 240, frames: 3600 });
  const graph2 = chunkGraph({ chunk: { start: 120, end: 240, frames: 3600 }, timeline: resolveLayoutTimeline([], 300), videoAspect: aspect, stage, glowSize: 1728, screens: fresh });
  assert.ok(graph2.includes("fade=t=in:st=10"), "a scene starting inside the chunk fades in where it starts");
});
