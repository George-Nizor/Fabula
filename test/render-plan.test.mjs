import test from "node:test";
import assert from "node:assert/strict";
import {
  headExpressions,
  glowExpressions,
  evaluateExpression,
  chunkPlan,
  chunkIdentity,
  screenPlacements,
  chunkGraph,
  headRectAt,
} from "../core/render-plan.mjs";
import { DEFAULT_STAGE, resolveLayoutTimeline } from "../core/stage-engine.mjs";

const stage = DEFAULT_STAGE;
const aspect = 16 / 9;
const scenes = [
  { type: "stage", start: 5, end: 12, layout: "pip", corner: "br" },
  { type: "stage", start: 20, end: 30, layout: "side" },
];
const timeline = resolveLayoutTimeline(scenes, 40);

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
    media: { clean: "a", screen: null }, fps: 30,
  };
  const chunk = { index: 0, start: 0, end: 120, frames: 3600 };
  const a = chunkIdentity(chunk, base);
  const later = { ...base, scenes: [base.scenes[0], { ...base.scenes[1], text: "Changed" }] };
  assert.equal(chunkIdentity(chunk, later), a); // a scene outside the chunk does not matter
  const early = { ...base, scenes: [{ ...base.scenes[0], text: "Changed" }, base.scenes[1]] };
  assert.notEqual(chunkIdentity(chunk, early), a);
  assert.notEqual(chunkIdentity(chunk, { ...base, theme: { accent: "#000000" } }), a);
  assert.notEqual(chunkIdentity(chunk, { ...base, media: { clean: "b", screen: null } }), a);
});

test("screen placements are chunk-local with a linearised presence fade", () => {
  const placed = screenPlacements([{ start: 100, end: 130, rect: { x: 1, y: 2, w: 3, h: 4 } }], { start: 90, end: 150 });
  assert.equal(placed.length, 1);
  assert.equal(placed[0].start, 10);
  assert.equal(placed[0].end, 40);
  assert.ok(Math.abs(placed[0].fade - 2.1) < 1e-9);
});

test("the chunk graph wires field, glow, screens, under, head, over in order", () => {
  const graph = chunkGraph({
    chunk: { start: 0, end: 30, frames: 900 }, timeline, videoAspect: aspect, stage, glowSize: 1728,
    screens: [{ rect: { x: 100, y: 50, w: 800, h: 450 }, start: 2, end: 10, fade: 0.56 }],
  });
  const order = ["[base0][glow]overlay", "[6:v]scale=800:450", "alphamerge,fade=t=in", "[4:v]format=rgba[under]", "[h0][hm]alphamerge,scale=", "[5:v]format=rgba[over]", "format=yuv420p[out]"];
  let at = -1;
  for (const marker of order) {
    const next = graph.indexOf(marker);
    assert.ok(next > at, `${marker} out of order`);
    at = next;
  }
});
