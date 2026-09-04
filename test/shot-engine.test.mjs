import test from "node:test";
import assert from "node:assert/strict";
import { punchPlan, DEFAULT_PUNCH_ZOOM } from "../core/shot-engine.mjs";

const words = [
  { id: 0, text: "one", start: 0.0, end: 0.5 },
  { id: 1, text: "two", start: 0.6, end: 1.0 },
  { id: 2, text: "three", start: 3.0, end: 3.4 },
  { id: 3, text: "four", start: 6.0, end: 6.5 },
];

const cuts = [
  { start: 1.2, end: 2.8, enabled: true, sources: [] },
  { start: 3.6, end: 5.8, enabled: true, sources: [] },
];

test("alternates framing across keep segments, starting wide", () => {
  const plan = punchPlan(words, cuts, 7);
  assert.equal(plan.length, 3);
  assert.deepEqual(plan.map((shot) => shot.scale), [1, DEFAULT_PUNCH_ZOOM, 1]);
});

test("each shot spans one keep segment and anchors to its words", () => {
  const plan = punchPlan(words, cuts, 7);
  assert.equal(plan[0].fromWordId, 0);
  assert.equal(plan[0].toWordId, 1);
  assert.equal(plan[1].fromWordId, 2);
  assert.equal(plan[1].toWordId, 2);
  assert.equal(plan[2].fromWordId, 3);
  assert.equal(plan[2].toWordId, 3);
});

test("a wordless keep segment carries time anchors only", () => {
  const plan = punchPlan(words.slice(0, 2), [{ start: 1.2, end: 2.8, enabled: true, sources: [] }], 7);
  assert.equal(plan.length, 2);
  assert.equal(plan[1].fromWordId, null);
  assert.equal(plan[1].toWordId, null);
  assert.ok(plan[1].start > plan[0].end);
});

test("no cuts means one wide shot", () => {
  const plan = punchPlan(words, [], 7);
  assert.deepEqual(plan.map((shot) => shot.scale), [1]);
});

test("disabled cuts do not split shots", () => {
  const disabled = cuts.map((cut) => ({ ...cut, enabled: false }));
  assert.equal(punchPlan(words, disabled, 7).length, 1);
});

test("a custom zoom flows through; a non-zoom is refused", () => {
  const plan = punchPlan(words, cuts, 7, { zoom: 1.3 });
  assert.equal(plan[1].scale, 1.3);
  assert.throws(() => punchPlan(words, cuts, 7, { zoom: 1 }));
});
