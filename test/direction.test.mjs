import test from "node:test";
import assert from "node:assert/strict";
import { validateDirection, directionBrief, describeDirection, directionRefusal, rulesFor, LATITUDE_IDS, DEFAULT_LATITUDE } from "../core/direction.mjs";

test("a direction fills in what the person did not say", () => {
  const d = validateDirection({});
  assert.equal(d.latitude, DEFAULT_LATITUDE);
  assert.equal(d.look, "auto");
  assert.equal(d.render, "draft");
  assert.equal(d.web, true);
  assert.equal(d.music, false);
  assert.deepEqual(LATITUDE_IDS, ["free", "guided", "strict"]);
});

test("a direction refuses what it cannot honour", () => {
  assert.throws(() => validateDirection({ latitude: "wild" }), /latitude/);
  assert.throws(() => validateDirection({ look: "brand:Has Spaces" }), /look/);
  assert.throws(() => validateDirection({ music: "yes" }), /music/);
  assert.throws(() => validateDirection({ purpose: "x".repeat(301) }), /purpose/);
  assert.throws(() => validateDirection({ render: "final" }), /render/);
  assert.equal(validateDirection({ look: "brand:apple-man-sam-channel" }).look, "brand:apple-man-sam-channel");
  assert.equal(validateDirection({ look: "preset:neon" }).look, "preset:neon");
});

test("the brief is written as instructions and carries every choice", () => {
  const brief = directionBrief({ latitude: "free", purpose: "A devlog for people who follow the game", look: "brand:apple-man-sam-channel", music: true, effects: true, web: false, notes: "Playful, lots of motion" });
  assert.match(brief, /Free hand/);
  assert.match(brief, /A devlog for people who follow the game/);
  assert.match(brief, /use: "apple-man-sam-channel"/);
  assert.match(brief, /search_audio/);
  assert.match(brief, /not allowed/);
  assert.match(brief, /"Playful, lots of motion"/);
  assert.match(brief, /draft: true/);
  assert.match(directionBrief({}), /The look is yours to choose/);
  assert.match(directionBrief({ render: "none" }), /do not render/);
});

test("By the book refuses motion scenes and hand-written cards, and keeps templates", () => {
  const strict = { latitude: "strict" };
  const template = { type: "graphic", graphic: { kind: "custom", template: "timeline", html: "<div></div>" } };
  const hand = { type: "graphic", graphic: { kind: "custom", html: "<div>mine</div>" } };
  const motion = { type: "graphic", graphic: { kind: "motion", src: "motion/orbit.html" } };
  assert.equal(directionRefusal([template], strict), null);
  assert.match(directionRefusal([template, hand], strict), /scene 1: a hand-written custom graphic/);
  assert.match(directionRefusal([motion], strict), /scene 0: a motion scene/);
  for (const latitude of ["free", "guided"]) assert.equal(directionRefusal([template, hand, motion], { latitude }), null);
  // What the plan on disk already holds is carried through, wherever it
  // moves: a strict direction stops more being added, not every other edit.
  const moved = { ...motion, from_word_id: 40, to_word_id: 60 };
  assert.equal(directionRefusal([template, moved], strict, { existing: [motion] }), null);
  assert.match(directionRefusal([template, moved, { type: "graphic", graphic: { kind: "motion", src: "motion/new.html" } }], strict, { existing: [motion] }), /scene 2: a motion scene/);
  assert.match(directionRefusal([{ ...motion, graphic: { ...motion.graphic, params: { act: "fall" } } }], strict, { existing: [motion] }), /a motion scene/, "new params are a new graphic");
  // No direction at all is guided.
  assert.equal(directionRefusal([motion], null), null);
  assert.equal(rulesFor(null).id, "guided");
});

test("status sees the rules without reading the brief", () => {
  const d = describeDirection({ latitude: "strict", notes: "" });
  assert.equal(d.motion, "refused");
  assert.equal(d.handWrittenGraphics, "refused");
  assert.equal(d.notes, null);
  assert.equal(describeDirection({ latitude: "free" }).motion, "encouraged");
  assert.equal(describeDirection(null), null);
});
