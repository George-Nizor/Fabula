import test from "node:test";
import assert from "node:assert/strict";
import { validateTreatment, describeTreatment } from "../core/treatment.mjs";

const words = Array.from({ length: 50 }, (_, id) => ({ id, text: `w${id}`, start: id, end: id + 0.5 }));
const beats = [
  { fromWordId: 0, toWordId: 9, beat: "The promise", picture: "A cover over a cutaway", head: "gone" },
  { fromWordId: 10, toWordId: 30, beat: "The mechanism", head: "split" },
  { fromWordId: 31, toWordId: 49, beat: "The turn", head: "on" },
];

test("a treatment keeps what it was given, trimmed and anchored", () => {
  const t = validateTreatment({
    logline: "  Rockets go sideways   because orbit is falling and missing ",
    shapes: [{ name: "Myth then fact", why: "the question most people have" }, { name: "A journey" }],
    shape: "Myth then fact: the question, the wrong answer, the turn, the orbit",
    signature: { what: "The orbit draws itself around the planet", fromWordId: 31, toWordId: 40 },
    beats,
    sound: "A bed under the opening and the ending; silence before the turn",
    look: "Studio, blue accent: space",
  }, words);
  assert.equal(t.logline, "Rockets go sideways because orbit is falling and missing");
  assert.equal(t.beats.length, 3);
  assert.equal(t.beats[1].head, "split");
  assert.equal(t.signature.toWordId, 40);
  assert.deepEqual(describeTreatment({ ...t, updatedAt: "x" }), { logline: t.logline, shape: t.shape, signature: t.signature.what, beats: 3, updatedAt: "x" });
});

test("a treatment says what is missing or wrong", () => {
  assert.throws(() => validateTreatment({ beats }, words), /logline/);
  assert.throws(() => validateTreatment({ logline: "x", beats: [] }, words), /beats/);
  assert.throws(() => validateTreatment({ logline: "x".repeat(201), beats }, words), /at most 200/);
  assert.throws(() => validateTreatment({ logline: "x", beats: [{ fromWordId: 0, toWordId: 60, beat: "b" }] }, words), /clean transcript/);
  assert.throws(() => validateTreatment({ logline: "x", beats: [{ fromWordId: 5, toWordId: 2, beat: "b" }] }, words), /before/);
  assert.throws(() => validateTreatment({ logline: "x", beats: [{ fromWordId: 0, toWordId: 2, beat: "b", head: "floating" }] }, words), /head/);
  assert.throws(() => validateTreatment({ logline: "x", beats: [beats[1], beats[0]] }, words), /cannot be reordered/);
  assert.throws(() => validateTreatment({ logline: "x", beats, shapes: [{}, {}, {}, {}, {}] }, words), /shapes/);
  // Without a clean transcript the anchors are taken on trust.
  assert.equal(validateTreatment({ logline: "x", beats: [{ fromWordId: 900, toWordId: 910, beat: "later" }] }).beats[0].fromWordId, 900);
  assert.equal(describeTreatment(null), null);
});
