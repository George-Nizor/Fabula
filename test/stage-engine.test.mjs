import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveLayoutTimeline,
  layoutRects,
  layoutAt,
  transitionAt,
  DEFAULT_STAGE,
  TRANSITION_SECONDS,
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

test("a glide flies the head between layouts and settles", () => {
  const timeline = resolveLayoutTimeline(stageScenes, 30, { transition: "glide" });
  const before = layoutAt(timeline, 4.9, 1);
  const mid = layoutAt(timeline, 5.3, 1);
  const after = layoutAt(timeline, 5.9, 1);
  assert.equal(before.settled, true);
  assert.equal(mid.settled, false);
  assert.equal(after.settled, true);
  const focus = layoutRects("focus", null, 1).video;
  const pip = layoutRects("pip", "br", 1).video;
  assert.ok(mid.video.w < focus.w && mid.video.w > pip.w, "mid-flight size between the two");
  assert.deepEqual(after.video, pip);
  // A glide is a move, not a fade: the head is fully present throughout.
  for (const t of [4.9, 5.0, 5.3, 5.9]) assert.equal(layoutAt(timeline, t, 1).alpha, 1);
});

// The default. Nothing slides: the head fades out over the last quarter
// second of the shot it is leaving, the arrangement changes on the anchored
// word, and it fades back over the first quarter second of the new one.
test("a dissolve dips the head through nothing and never moves it", () => {
  const timeline = resolveLayoutTimeline(stageScenes, 30, { transition: "dissolve" });
  const half = TRANSITION_SECONDS.dissolve / 2;
  const focus = layoutRects("focus", null, 1).video;
  const pip = layoutRects("pip", "br", 1).video;
  assert.deepEqual(layoutAt(timeline, 5 - half - 0.01, 1).video, focus);
  assert.deepEqual(layoutAt(timeline, 4.99, 1).video, focus, "the rectangle holds while the head fades out");
  assert.deepEqual(layoutAt(timeline, 5.01, 1).video, pip, "and steps on the boundary, unseen");
  assert.equal(layoutAt(timeline, 5 - half - 0.01, 1).alpha, 1);
  assert.ok(layoutAt(timeline, 5 - half / 2, 1).alpha < 0.7);
  assert.ok(layoutAt(timeline, 4.999, 1).alpha < 0.02, "gone at the cut");
  assert.ok(layoutAt(timeline, 5.001, 1).alpha < 0.02, "and still gone just after it");
  assert.ok(layoutAt(timeline, 5 + half / 2, 1).alpha > 0.3);
  assert.equal(layoutAt(timeline, 5 + half + 0.01, 1).alpha, 1);
});

test("a cut changes everything on one frame", () => {
  const timeline = resolveLayoutTimeline(stageScenes, 30, { transition: "cut" });
  assert.deepEqual(layoutAt(timeline, 4.999, 1).video, layoutRects("focus", null, 1).video);
  assert.deepEqual(layoutAt(timeline, 5, 1).video, layoutRects("pip", "br", 1).video);
  for (const t of [4.9, 5, 5.2]) {
    assert.equal(layoutAt(timeline, t, 1).alpha, 1);
    assert.equal(layoutAt(timeline, t, 1).settled, true);
  }
});

test("a scene may cross its own boundary differently from the film", () => {
  const timeline = resolveLayoutTimeline([
    { type: "stage", layout: "pip", corner: "br", start: 5, end: 10, transition: "cut" },
    { type: "stage", layout: "side", start: 20, end: 25 },
  ], 30, { transition: "glide" });
  assert.equal(transitionAt(timeline, 1).style, "cut");
  assert.equal(transitionAt(timeline, 3).style, "glide");
  assert.deepEqual(layoutAt(timeline, 5, 1).video, layoutRects("pip", "br", 1).video);
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

test("the full layout gives the visuals the stage and keeps the head as a small corner card", () => {
  const rects = layoutRects("full", "tl", 16 / 9, DEFAULT_STAGE);
  assert.ok(rects.video.h < DEFAULT_STAGE.height * 0.25);
  assert.equal(Math.round(rects.video.x), Math.round(DEFAULT_STAGE.height * 0.04));
  assert.ok(rects.content.w > DEFAULT_STAGE.width * 0.85);
  const br = layoutRects("full", undefined, 16 / 9, DEFAULT_STAGE);
  assert.ok(br.video.x + br.video.w <= DEFAULT_STAGE.width);
});

test("a cutaway takes the camera off the stage and gives the visuals full's room", () => {
  const timeline = resolveLayoutTimeline([
    { type: "stage", layout: "cutaway", start: 5, end: 7 },
    { type: "stage", layout: "side", start: 11, end: 18 },
  ], 20);
  assert.ok(timeline.some((s) => s.layout === "cutaway" && s.start === 5 && s.end === 7));
  for (const t of [5, 5.1, 6.999]) {
    const r = layoutAt(timeline, t, 16 / 9);
    assert.ok(r.video.x + r.video.w < 0, "off the canvas, so ffmpeg's overlay clips it for free");
    assert.equal(r.alpha, 0, "and invisible, so nothing of it survives a rounding error");
    assert.equal(r.headHidden, true);
    assert.deepEqual(r.content, layoutRects("full", "br", 16 / 9).content, "the same room as full, without the card");
  }
  assert.equal(layoutAt(timeline, 4, 16 / 9).headHidden, false);
});

// The whole duration goes on the one thing there is to fade: there is no
// incoming head to bring up, so half a fade would just be a quicker one.
test("the camera fades away into a cutaway and back out of it", () => {
  const timeline = resolveLayoutTimeline([{ type: "stage", layout: "cutaway", start: 5, end: 9 }], 20);
  const full = TRANSITION_SECONDS.dissolve;
  assert.equal(layoutAt(timeline, 5 - full - 0.01, 16 / 9).alpha, 1);
  assert.ok(layoutAt(timeline, 5 - full / 2, 16 / 9).alpha < 0.8);
  assert.ok(layoutAt(timeline, 4.99, 16 / 9).alpha < 0.02);
  assert.equal(layoutAt(timeline, 6, 16 / 9).alpha, 0);
  assert.ok(layoutAt(timeline, 9.01, 16 / 9).alpha < 0.1, "and comes back up from nothing");
  assert.ok(layoutAt(timeline, 9 + full / 2, 16 / 9).alpha > 0.2);
  assert.equal(layoutAt(timeline, 9 + full + 0.01, 16 / 9).alpha, 1);
  // Glide has no rectangle to fly to or from, so it fades here too rather
  // than sweeping the head in from three canvases away.
  const glided = resolveLayoutTimeline([{ type: "stage", layout: "cutaway", start: 5, end: 9 }], 20, { transition: "glide" });
  assert.equal(transitionAt(glided, 1).style, "dissolve");
});

// The rule that stops the head darting about counts a cutaway too. Left
// out of it, a third of a second of camera survived between two full-stage
// visuals — a hard cut in and straight back out, the worst version of the
// dart the rule exists to prevent.
test("the dwell rule bridges a flash of camera between two cutaways", () => {
  const cutaway = (start, end) => ({ type: "stage", start, end, layout: "cutaway" });
  let tl = resolveLayoutTimeline([cutaway(5, 31), cutaway(31.3, 35)], 60);
  assert.deepEqual(tl.map((s) => [s.start, s.end, s.layout]), [[0, 5, "focus"], [5, 35, "cutaway"], [35, 60, "focus"]]);
  // A real return to camera between them is left alone.
  tl = resolveLayoutTimeline([cutaway(5, 20), cutaway(24, 35)], 60);
  assert.deepEqual(tl.map((s) => s.layout), ["focus", "cutaway", "focus", "cutaway", "focus"]);
  // A cutaway may be brief — nothing flies — but not a blink.
  tl = resolveLayoutTimeline([{ type: "stage", start: 10, end: 20, layout: "side" }, cutaway(20, 21.5), { type: "stage", start: 21.5, end: 30, layout: "side" }], 60);
  assert.deepEqual(tl.map((s) => s.layout), ["focus", "side", "cutaway", "side", "focus"]);
  tl = resolveLayoutTimeline([{ type: "stage", start: 10, end: 20, layout: "side" }, cutaway(20, 20.6), { type: "stage", start: 20.6, end: 30, layout: "side" }], 60);
  assert.deepEqual(tl.map((s) => [s.start, s.end, s.layout]), [[0, 10, "focus"], [10, 30, "side"], [30, 60, "focus"]]);
});
