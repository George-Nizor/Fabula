import test from "node:test";
import assert from "node:assert/strict";
import { FORMATS, FORMAT_IDS, DEFAULT_FORMAT, resolveFormat, validateFormat, stageOf, describeFormats, isPortrait } from "../core/formats.mjs";
import { LAYOUTS, layoutRects, headDrawRect, resolveLayoutTimeline, layoutAt } from "../core/stage-engine.mjs";

const SOURCE_ASPECT = 16 / 9;

test("a project with no format is landscape, and an unknown one does not become a broken stage", () => {
  assert.equal(resolveFormat(undefined).id, DEFAULT_FORMAT);
  assert.equal(resolveFormat(null).id, "landscape");
  assert.equal(resolveFormat({ title: "no format here" }).id, "landscape");
  assert.equal(resolveFormat("widescreen-3000").id, "landscape");
  assert.deepEqual(stageOf({ format: "vertical" }), { width: 1080, height: 1920 });
  assert.equal(validateFormat(undefined), "landscape");
  assert.equal(validateFormat("vertical"), "vertical");
  assert.throws(() => validateFormat("square"), /format must be one of/);
});

test("every format describes a stage the composition can actually be painted on", () => {
  for (const { id, stage, aspect } of describeFormats()) {
    assert.ok(FORMAT_IDS.includes(id));
    assert.ok(stage.width >= 720 && stage.height >= 720, `${id} stage`);
    assert.ok(stage.width % 2 === 0 && stage.height % 2 === 0, `${id} must encode: even dimensions`);
    assert.ok(Math.abs(aspect - stage.width / stage.height) < 0.001);
  }
  assert.equal(FORMATS.vertical.shortForm, true);
  assert.equal(FORMATS.landscape.shortForm, false);
});

// The point of one layout vocabulary across two shapes: a plan written for a
// landscape film is still a legible plan in a tall frame. Every layout has to
// answer in both, and the answer has to be on the canvas.
test("every layout resolves to rectangles on the canvas, in both formats", () => {
  for (const { id, stage } of describeFormats()) {
    for (const layout of LAYOUTS) {
      const rects = layoutRects(layout, "br", SOURCE_ASPECT, stage);
      assert.ok(["contain", "cover"].includes(rects.fit), `${id}/${layout} fit`);
      const { content } = rects;
      assert.ok(content.w > stage.width * 0.3 && content.h > stage.height * 0.1, `${id}/${layout} content is too small to put a card in`);
      assert.ok(content.x >= 0 && content.y >= 0 && content.x + content.w <= stage.width + 0.5 && content.y + content.h <= stage.height + 0.5,
        `${id}/${layout} content leaves the stage`);
      if (layout === "cutaway") continue; // deliberately parked off the canvas
      const { video } = rects;
      assert.ok(video.x >= -0.5 && video.y >= -0.5 && video.x + video.w <= stage.width + 0.5 && video.y + video.h <= stage.height + 0.5,
        `${id}/${layout} head leaves the stage`);
      if (rects.fit === "contain") {
        assert.ok(Math.abs(video.w / video.h - SOURCE_ASPECT) < 0.01, `${id}/${layout} contains, so its window is the footage's shape`);
      }
    }
  }
});

test("a tall frame crops the head where the head is the picture and keeps it whole where its framing is", () => {
  const stage = FORMATS.vertical.stage;
  const focus = layoutRects("focus", null, SOURCE_ASPECT, stage);
  assert.equal(focus.fit, "cover");
  assert.deepEqual(focus.video, { x: 0, y: 0, w: 1080, h: 1920 });
  assert.equal(layoutRects("side", null, SOURCE_ASPECT, stage).fit, "cover");
  const band = layoutRects("band", null, SOURCE_ASPECT, stage);
  assert.equal(band.fit, "contain");
  assert.ok(band.content.y > band.video.y + band.video.h, "the visual sits under the band, not over it");
  // Landscape crops nothing, whatever the layout.
  for (const layout of LAYOUTS) assert.equal(layoutRects(layout, "br", SOURCE_ASPECT, FORMATS.landscape.stage).fit, "contain");
});

test("covering a window that is already the footage's shape crops nothing", () => {
  const stage = FORMATS.vertical.stage;
  for (const layout of ["band", "pip", "full"]) {
    const { video } = layoutRects(layout, "br", SOURCE_ASPECT, stage);
    const draw = headDrawRect(video, SOURCE_ASPECT);
    for (const key of ["x", "y", "w", "h"]) assert.ok(Math.abs(draw[key] - video[key]) < 0.01, `${layout} ${key}`);
  }
  // Full bleed from 16:9 footage: the height is the constraint and the sides
  // hang off evenly, which is the crop and the whole reason for it.
  const draw = headDrawRect({ x: 0, y: 0, w: 1080, h: 1920 }, SOURCE_ASPECT);
  assert.ok(Math.abs(draw.h - 1920) < 0.01);
  assert.ok(Math.abs(draw.w - 1920 * SOURCE_ASPECT) < 0.01);
  assert.ok(Math.abs(draw.x + draw.w / 2 - 540) < 0.01, "centred on the window");
  assert.equal(draw.y, 0);
});

// A tall film is watched with captions on. If a card could be drawn to the
// bottom of the frame it would be drawn under two lines of type, and the
// person would only find out from a render.
test("a tall frame keeps the bottom of the picture clear for captions", () => {
  const stage = FORMATS.vertical.stage;
  for (const layout of ["focus", "side", "band"]) {
    const { content } = layoutRects(layout, null, SOURCE_ASPECT, stage);
    assert.ok(content.y + content.h <= stage.height * 0.87,
      `${layout} content reaches ${(100 * (content.y + content.h) / stage.height).toFixed(0)}% of the height`);
    assert.ok(content.h > stage.height * 0.1, `${layout} content is too short to hold a card`);
  }
  // A landscape film has no such band: its captions sit over the footage.
  const wide = layoutRects("side", null, SOURCE_ASPECT, FORMATS.landscape.stage);
  assert.ok(wide.content.y + wide.content.h > FORMATS.landscape.stage.height * 0.85);
});

test("isPortrait reads the stage, not the format's name", () => {
  assert.equal(isPortrait(FORMATS.vertical.stage), true);
  assert.equal(isPortrait(FORMATS.landscape.stage), false);
  assert.equal(isPortrait(null), false);
});

// A glide between a contained layout and a cropped one has to be continuous:
// at the moment it starts, the window is still the footage's own shape, so
// the crop is nothing and grows from there.
test("a glide into a cropped layout starts uncropped", () => {
  const stage = FORMATS.vertical.stage;
  const tl = resolveLayoutTimeline([{ type: "stage", layout: "band", start: 4, end: 12 }], 20, { transition: "glide" });
  // A fifth of a frame apart: a crop that opens over most of a second moves
  // fast, but it never steps.
  let previous = null;
  for (let t = 3.5; t < 13; t += 0.005) {
    const at = layoutAt(tl, t, SOURCE_ASPECT, stage);
    const draw = headDrawRect(at.video, SOURCE_ASPECT);
    if (previous) {
      for (const key of ["x", "y", "w", "h"]) {
        assert.ok(Math.abs(draw[key] - previous[key]) < 40, `${key} jumped at t=${t.toFixed(3)}`);
      }
    }
    previous = draw;
  }
});

test("an inherited object key is not a format", () => {
  assert.equal(resolveFormat("constructor").id, "landscape");
  assert.equal(resolveFormat({ format: "toString" }).id, "landscape");
});
