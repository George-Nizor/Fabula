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

test("a scene's own transition runs at its own style's pace inside a film that uses another", () => {
  const tl = resolveLayoutTimeline([{ type: "stage", layout: "side", start: 10, end: 20, transition: "dissolve" }], 40, { transition: "glide", transitionSeconds: null });
  const crossing = transitionAt(tl, 1);
  assert.equal(crossing.style, "dissolve");
  assert.ok(Math.abs(crossing.leave + crossing.enter - 0.5) < 0.01, `dissolve's own 0.5 s, got ${crossing.leave + crossing.enter}`);
});

test("a glide lands before the next boundary starts fading the segment out", () => {
  const tl = resolveLayoutTimeline([{ type: "stage", layout: "pip", start: 10, end: 13 }, { type: "stage", layout: "cutaway", start: 13, end: 20 }], 40, { transition: "glide", transitionSeconds: 1.8 });
  const glide = transitionAt(tl, 1).glide;
  const leave = transitionAt(tl, 2).leave;
  assert.ok(glide + leave <= 3.001, `glide ${glide} + leave ${leave} inside a 3 s segment`);
});

test("a portrait band keeps tall footage on the canvas", () => {
  const stage = { width: 1080, height: 1920 };
  const rects = layoutRects("band", null, 9 / 16, stage);
  assert.ok(rects.video.y + rects.video.h <= stage.height * 0.75, `head bottom at ${rects.video.y + rects.video.h}`);
  assert.ok(rects.content.y + rects.content.h <= stage.height, "the content rect is on the canvas");
  assert.ok(Math.abs(rects.video.w / rects.video.h - 9 / 16) < 0.01, "the footage keeps its shape");
});

test("a sliver of head at either end folds into the placed segment beside it", () => {
  // The word pad puts a few frames of focus before a card on the first word
  // and after one on the last; the window (transcript length) and the film
  // (clean.mp4 length) must settle the same closing scene the same way.
  const closing = { type: "stage", layout: "cutaway", start: 27.5, end: 29.96 };
  const fromWords = resolveLayoutTimeline([closing], 29.96);
  const fromFilm = resolveLayoutTimeline([closing], 30.04);
  assert.equal(fromWords.at(-1).layout, "cutaway");
  assert.equal(fromFilm.at(-1).layout, "cutaway", "the 0.08 s tail did not turn the closing card into a middle segment");
  assert.equal(fromFilm.at(-1).end, 30.04);
  const opening = resolveLayoutTimeline([{ type: "stage", layout: "cutaway", start: 0.04, end: 5 }], 30);
  assert.equal(opening[0].layout, "cutaway");
  assert.equal(opening[0].start, 0);
  // A real opening shot of the head is a shot, and stays.
  const shot = resolveLayoutTimeline([{ type: "stage", layout: "cutaway", start: 2, end: 8 }], 30);
  assert.equal(shot[0].layout, "focus");
});

test("a split screen gives the head one half edge to edge and the visual the other", () => {
  const W = DEFAULT_STAGE.width;
  const H = DEFAULT_STAGE.height;
  const left = layoutRects("split", null, 16 / 9, DEFAULT_STAGE);
  assert.equal(left.fit, "cover");
  assert.deepEqual(left.video, { x: 0, y: 0, w: W / 2, h: H });
  assert.ok(left.content.x >= W / 2 && left.content.x + left.content.w <= W, "the visual owns the right half");
  const right = layoutRects("split", "tr", 16 / 9, DEFAULT_STAGE);
  assert.deepEqual(right.video, { x: W / 2, y: 0, w: W / 2, h: H });
  assert.ok(right.content.x + right.content.w <= W / 2, "the visual owns the left half");
  // A tall frame splits top and bottom; a bottom corner puts the head under.
  const tall = { width: 1080, height: 1920 };
  const top = layoutRects("split", null, 16 / 9, tall);
  assert.deepEqual(top.video, { x: 0, y: 0, w: 1080, h: 960 });
  assert.ok(top.content.y >= 960 && top.content.y + top.content.h <= 1920 * 0.78 + 0.01, "the visual sits under it, above the caption floor");
  const bottom = layoutRects("split", "bl", 16 / 9, tall);
  assert.deepEqual(bottom.video, { x: 0, y: 960, w: 1080, h: 960 });
  assert.ok(bottom.content.y + bottom.content.h <= 960, "the visual sits above it");
});

test("a right-hand corner mirrors the side layout", () => {
  const W = DEFAULT_STAGE.width;
  const plain = layoutRects("side", null, 16 / 9, DEFAULT_STAGE);
  const mirrored = layoutRects("side", "br", 16 / 9, DEFAULT_STAGE);
  assert.equal(mirrored.fit, "contain");
  assert.ok(Math.abs(mirrored.video.x - (W - plain.video.x - plain.video.w)) < 0.001);
  assert.equal(mirrored.video.w, plain.video.w);
  assert.ok(mirrored.content.x + mirrored.content.w <= mirrored.video.x, "the column is left of the head");
  assert.equal(mirrored.content.w, plain.content.w);
  // Left is the default, and says so either way.
  assert.deepEqual(layoutRects("side", "tl", 16 / 9, DEFAULT_STAGE), plain);
});

test("two placements are one shot when the head does not move", () => {
  const wide = { width: 1920, height: 1080 };
  const tall = { width: 1080, height: 1920 };
  const pair = (layout, a, b) => [
    { type: "stage", layout, corner: a, start: 0, end: 10 },
    { type: "stage", layout, corner: b, start: 10, end: 20 },
  ];
  const count = (scenes, stage) => resolveLayoutTimeline(scenes, 20, { transition: "dissolve", stage }).length;
  // A wide split cares only for left or right; a tall one for top or bottom.
  assert.equal(count(pair("split", "br", "tr"), wide), 1);
  assert.equal(count(pair("split", "br", "bl"), wide), 2);
  assert.equal(count(pair("split", "tr", "tl"), tall), 1);
  assert.equal(count(pair("split", "br", "tr"), tall), 2);
  // A side with no corner and one with a left corner are the same; a tall
  // side ignores the corner entirely.
  assert.equal(count(pair("side", undefined, "bl"), wide), 1);
  assert.equal(count(pair("side", "bl", "br"), tall), 1);
  // pip and full take every corner, br when none is named.
  assert.equal(count(pair("pip", undefined, "br"), wide), 1);
  assert.equal(count(pair("pip", "br", "tr"), wide), 2);
  // Without the shape, both halves of the corner count: a boundary kept,
  // never one lost.
  assert.equal(count(pair("split", "br", "tr"), undefined), 2);
});
