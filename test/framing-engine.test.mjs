import test from "node:test";
import assert from "node:assert/strict";
import {
  validateFraming,
  fullFrameFraming,
  framingAt,
  splitKeepsByFraming,
  headOutputSize,
  screenOutputSize,
  screenSpans,
} from "../core/framing-engine.mjs";

const dims = { width: 3440, height: 1440 };
const cam = { x: 440, y: 0, w: 2560, h: 1440 };
const pip = { x: 2342, y: 822, w: 1098, h: 618 };
const screen = { x: 0, y: 0, w: 2342, h: 1440 };
const obs = {
  segments: [
    { start: 0, end: 14.8, head: cam },
    { start: 14.8, end: 191.9, head: pip, screen },
    { start: 191.9, end: 300, head: cam },
  ],
};

test("a full-frame framing validates against its own frame", () => {
  validateFraming(fullFrameFraming(dims, 100), dims, 100);
});

test("validation refuses gaps, rects outside the frame, and head aspect changes", () => {
  validateFraming(obs, dims, 300);
  assert.throws(() => validateFraming({ segments: [{ start: 1, end: 5, head: cam }] }, dims, 5), /expected 0/);
  assert.throws(() => validateFraming({ segments: [{ start: 0, end: 5, head: { x: 3000, y: 0, w: 1000, h: 500 } }] }, dims, 5), /leaves/);
  assert.throws(() => validateFraming({
    segments: [{ start: 0, end: 5, head: cam }, { start: 5, end: 10, head: { x: 0, y: 0, w: 1000, h: 1000 } }],
  }, dims, 10), /aspect/);
  assert.throws(() => validateFraming(obs, dims, 500), /covers/);
});

test("framingAt picks the segment holding t and holds the last one past the end", () => {
  assert.equal(framingAt(obs, 10).head, cam);
  assert.equal(framingAt(obs, 100).head, pip);
  assert.equal(framingAt(obs, 999).head, cam);
});

test("keeps split at framing boundaries and carry clean offsets", () => {
  const keeps = [{ start: 10, end: 20 }, { start: 100, end: 110 }, { start: 190, end: 200 }];
  const pieces = splitKeepsByFraming(keeps, obs);
  assert.deepEqual(pieces.map((p) => [p.start, p.end]), [[10, 14.8], [14.8, 20], [100, 110], [190, 191.9], [191.9, 200]]);
  assert.equal(pieces[0].head, cam);
  assert.equal(pieces[1].head, pip);
  assert.equal(pieces[1].screen, screen);
  assert.equal(pieces[4].screen, null);
  assert.ok(Math.abs(pieces[1].cleanStart - 4.8) < 1e-9);
  assert.ok(Math.abs(pieces.at(-1).cleanEnd - 30) < 1e-9);
});

test("output sizes fit the delivery ceiling and keep the source aspect", () => {
  assert.deepEqual(headOutputSize(obs), { width: 1920, height: 1080 });
  assert.deepEqual(headOutputSize({ segments: [{ start: 0, end: 1, head: pip }] }), { width: 1098, height: 618 });
  assert.deepEqual(screenOutputSize(obs), { width: 1756, height: 1080 });
  assert.equal(screenOutputSize({ segments: [{ start: 0, end: 1, head: cam }] }), null);
});

test("screen spans merge adjacent pieces on the clean timeline", () => {
  const pieces = splitKeepsByFraming([{ start: 10, end: 20 }, { start: 30, end: 40 }, { start: 195, end: 200 }], obs);
  const spans = screenSpans(pieces);
  assert.equal(spans.length, 1);
  assert.ok(Math.abs(spans[0].start - 4.8) < 1e-9);
  assert.ok(Math.abs(spans[0].end - 20) < 1e-9);
});
