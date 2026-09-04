import test from "node:test";
import assert from "node:assert/strict";
import {
  validateScenes,
  resolveScenes,
  resolveCaptions,
  renderSchedule,
  activeAt,
} from "../core/compose-engine.mjs";

const words = [
  { id: 0, text: "one", start: 0.0, end: 0.4 },
  { id: 1, text: "two", start: 0.5, end: 0.9 },
  { id: 2, text: "three", start: 3.0, end: 3.5 },
];

test("scenes resolve to their word span", () => {
  const [scene] = resolveScenes([{ type: "title", fromWordId: 0, toWordId: 1, text: "Hi" }], words);
  assert.equal(scene.start, 0.0);
  assert.equal(scene.end, 0.9);
});

test("validation refuses unknown types, bad ids, reversed ranges, empty text", () => {
  assert.throws(() => validateScenes([{ type: "wipe", fromWordId: 0, toWordId: 1, text: "x" }], words));
  assert.throws(() => validateScenes([{ type: "title", fromWordId: 0, toWordId: 9, text: "x" }], words));
  assert.throws(() => validateScenes([{ type: "title", fromWordId: 2, toWordId: 0, text: "x" }], words));
  assert.throws(() => validateScenes([{ type: "title", fromWordId: 0, toWordId: 1, text: "" }], words));
});

test("captions hang through short gaps but yield to the next word", () => {
  const spans = resolveCaptions(words);
  assert.equal(spans[0].end, 0.5); // next word arrives before the hang runs out
  assert.equal(spans[1].end, 1.3); // 0.9 + 0.4 hang, next word is far
  assert.equal(spans[2].end, 3.9); // last word hangs a beat
});

test("the schedule covers every overlay change and holds to the duration", () => {
  const scenes = resolveScenes([{ type: "title", fromWordId: 0, toWordId: 1, text: "Hi" }], words);
  const states = renderSchedule(scenes, resolveCaptions(words), 5);
  assert.equal(states[0].t, 0);
  const total = states.reduce((sum, state) => sum + state.duration, 0);
  assert.ok(Math.abs(total - 5) < 0.01);
  assert.ok(states.every((state) => state.duration > 0));
  assert.ok(states.some((state) => state.t === 3.0)); // "three" starts a state
});

test("animated graphics densify their window to frame rate; static spans stay sparse", () => {
  const scenes = resolveScenes([{
    type: "graphic", fromWordId: 0, toWordId: 1,
    graphic: { kind: "stat", value: 2, label: "snails" },
  }], words);
  const states = renderSchedule(scenes, null, 5, { fps: 30 });
  const inside = states.filter((s) => s.t >= 0 && s.t < 0.9);
  const outside = states.filter((s) => s.t >= 0.9);
  assert.ok(inside.length >= 25); // ~0.9s at 30fps
  assert.ok(outside.length <= 2); // nothing changes after the scene ends
});

test("graphic specs are validated by kind", () => {
  const good = { type: "graphic", fromWordId: 0, toWordId: 1 };
  validateScenes([{ ...good, graphic: { kind: "chart", items: [{ label: "a", value: 1 }] } }], words);
  validateScenes([{ ...good, graphic: { kind: "list", items: [{ label: "a" }] } }], words);
  validateScenes([{ ...good, graphic: { kind: "stat", value: 3, label: "x" } }], words);
  assert.throws(() => validateScenes([{ ...good, graphic: { kind: "pie", items: [] } }], words));
  assert.throws(() => validateScenes([{ ...good, graphic: { kind: "chart", items: [{ label: "a" }] } }], words));
  assert.throws(() => validateScenes([{ ...good, graphic: { kind: "stat", label: "x" } }], words));
  assert.throws(() => validateScenes([{ ...good }], words));
});

test("activeAt is start-inclusive, end-exclusive", () => {
  const scenes = resolveScenes([{ type: "callout", fromWordId: 1, toWordId: 1, text: "!" }], words);
  assert.equal(activeAt(scenes, 0.5).length, 1);
  assert.equal(activeAt(scenes, 0.9).length, 0);
});
