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
import { DEFAULT_STAGE, resolveLayoutTimeline } from "../core/stage-engine.mjs";

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
