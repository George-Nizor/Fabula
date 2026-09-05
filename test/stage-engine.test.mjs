import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveLayoutTimeline,
  layoutRects,
  layoutAt,
  DEFAULT_STAGE,
} from "../core/stage-engine.mjs";

const stageScenes = [
  { type: "stage", layout: "pip", corner: "br", start: 5, end: 10 },
  { type: "stage", layout: "side", start: 20, end: 25 },
];

test("the timeline is gapless and defaults to focus", () => {
  const timeline = resolveLayoutTimeline(stageScenes, 30);
  assert.deepEqual(timeline.map((s) => s.layout), ["focus", "pip", "focus", "side", "focus"]);
  assert.equal(timeline[0].start, 0);
  assert.equal(timeline.at(-1).end, 30);
  for (let i = 1; i < timeline.length; i += 1) {
    assert.equal(timeline[i].start, timeline[i - 1].end);
  }
});

test("every layout keeps the head's aspect and stays on stage", () => {
  for (const layout of ["focus", "pip", "side"]) {
    const { video, content } = layoutRects(layout, "br", 1, DEFAULT_STAGE);
    assert.ok(Math.abs(video.w / video.h - 1) < 0.001, `${layout} aspect`);
    for (const rect of [video, content]) {
      assert.ok(rect.x >= 0 && rect.y >= 0, `${layout} on stage`);
      assert.ok(rect.x + rect.w <= DEFAULT_STAGE.width + 0.001, `${layout} right edge`);
      assert.ok(rect.y + rect.h <= DEFAULT_STAGE.height + 0.001, `${layout} bottom edge`);
    }
  }
});

test("the head eases between layouts and settles", () => {
  const timeline = resolveLayoutTimeline(stageScenes, 30);
  const before = layoutAt(timeline, 4.9, 1);
  const mid = layoutAt(timeline, 5.3, 1);
  const after = layoutAt(timeline, 5.7, 1);
  assert.equal(before.settled, true);
  assert.equal(mid.settled, false);
  assert.equal(after.settled, true);
  const focus = layoutRects("focus", null, 1).video;
  const pip = layoutRects("pip", "br", 1).video;
  assert.ok(mid.video.w < focus.w && mid.video.w > pip.w, "mid-flight size between the two");
  assert.deepEqual(after.video, pip);
});

test("time before or past the timeline clamps to its ends", () => {
  const timeline = resolveLayoutTimeline(stageScenes, 30);
  assert.deepEqual(layoutAt(timeline, -1, 1).video, layoutRects("focus", null, 1).video);
  assert.deepEqual(layoutAt(timeline, 99, 1).video, layoutRects("focus", null, 1).video);
});

test("the dwell rule bridges short returns to focus and absorbs short flights", () => {
  const side = (start, end) => ({ type: "stage", start, end, layout: "side" });
  const pip = (start, end, corner = "br") => ({ type: "stage", start, end, layout: "pip", corner });
  // side, a 1.5 s focus gap, side again: one side segment.
  let tl = resolveLayoutTimeline([side(10, 20), side(21.5, 30)], 60);
  assert.deepEqual(tl.map((s) => [s.start, s.end, s.layout]), [[0, 10, "focus"], [10, 30, "side"], [30, 60, "focus"]]);
  // side, a 1 s pip, side: the pip is absorbed, the sides merge.
  tl = resolveLayoutTimeline([side(10, 20), pip(20, 21), side(21, 30)], 60);
  assert.deepEqual(tl.map((s) => [s.start, s.end, s.layout]), [[0, 10, "focus"], [10, 30, "side"], [30, 60, "focus"]]);
  // A 1 s pip alone in a long focus run: absorbed into the focus before it.
  tl = resolveLayoutTimeline([pip(10, 11)], 60);
  assert.deepEqual(tl.map((s) => [s.start, s.end, s.layout]), [[0, 60, "focus"]]);
  // Long gaps and long segments are untouched.
  tl = resolveLayoutTimeline([side(10, 20), side(25, 30)], 60);
  assert.deepEqual(tl.map((s) => s.layout), ["focus", "side", "focus", "side", "focus"]);
  // A short shot at the very end of the film stays.
  tl = resolveLayoutTimeline([side(58, 60)], 60);
  assert.deepEqual(tl.map((s) => [s.start, s.end, s.layout]), [[0, 58, "focus"], [58, 60, "side"]]);
});
