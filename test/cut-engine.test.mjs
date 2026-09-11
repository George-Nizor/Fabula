import { test } from "node:test";
import assert from "node:assert/strict";
import {
  flattenWords,
  detectFillerCuts,
  detectGapCuts,
  normalizeCuts,
  keepSegments,
  totalCutSeconds,
} from "../core/cut-engine.mjs";
import { addWordCut, keepWords } from "../core/cut-engine.mjs";

function word(id, text, start, end) {
  return { id, text, start, end };
}

test("flattenWords flattens segments and interpolates untimed words", () => {
  const words = flattenWords({
    segments: [
      {
        start: 0,
        end: 3,
        words: [
          { word: "We", start: 0.1, end: 0.3 },
          { word: "raised", start: 0.35, end: 0.7 },
          { word: "3", start: undefined, end: undefined },
          { word: "million", start: 1.3, end: 1.8 },
        ],
      },
    ],
  });
  assert.equal(words.length, 4);
  assert.equal(words[2].text, "3");
  assert.ok(words[2].start >= 0.7 && words[2].end <= 1.3, "untimed word sits between its neighbours");
  assert.ok(words[2].end > words[2].start);
});

test("detectFillerCuts matches fillers case-insensitively through punctuation", () => {
  const words = [word(0, "So", 0, 0.2), word(1, "Um,", 0.5, 0.8), word(2, "right", 1.0, 1.3)];
  const cuts = detectFillerCuts(words);
  assert.equal(cuts.length, 1);
  assert.equal(cuts[0].detail, "um");
  assert.ok(cuts[0].start < 0.5 && cuts[0].end > 0.8, "cut pads around the filler");
  assert.deepEqual(cuts[0].wordIds, [1]);
});

test("detectGapCuts keeps breath padding and finds head and tail silence", () => {
  const words = [word(0, "Hello", 2.0, 2.4), word(1, "world", 5.0, 5.4)];
  const cuts = detectGapCuts(words, { mediaDurationSeconds: 9.0 });
  assert.equal(cuts.length, 3);
  // Head silence: 0 .. first word minus breath.
  assert.equal(cuts[0].start, 0);
  assert.ok(Math.abs(cuts[0].end - 1.85) < 1e-9);
  // Inter-word gap: 150ms of breath survives on both sides.
  assert.ok(Math.abs(cuts[1].start - 2.55) < 1e-9);
  assert.ok(Math.abs(cuts[1].end - 4.85) < 1e-9);
  // Tail silence runs to the media duration.
  assert.ok(Math.abs(cuts[2].start - 5.55) < 1e-9);
  assert.equal(cuts[2].end, 9.0);
});

test("detectGapCuts ignores gaps below the threshold", () => {
  const words = [word(0, "quick", 0.0, 0.4), word(1, "pause", 0.8, 1.2)];
  assert.deepEqual(detectGapCuts(words), []);
});

test("normalizeCuts merges overlapping proposals and keeps their sources", () => {
  const merged = normalizeCuts([
    { start: 1.0, end: 2.0, reason: "silence", enabled: true },
    { start: 1.9, end: 2.4, reason: "filler", detail: "um", enabled: true },
    { start: 5.0, end: 5.5, reason: "silence", enabled: true },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].start, 1.0);
  assert.equal(merged[0].end, 2.4);
  assert.equal(merged[0].sources.length, 2);
  assert.equal(merged[0].sources[1].detail, "um");
});

test("keepSegments is the complement of enabled cuts only", () => {
  const cuts = [
    { start: 1.0, end: 2.0, enabled: true },
    { start: 3.0, end: 4.0, enabled: false },
    { start: 8.0, end: 10.0, enabled: true },
  ];
  assert.deepEqual(keepSegments(cuts, 10.0), [
    { start: 0, end: 1.0 },
    { start: 2.0, end: 8.0 },
  ]);
  assert.ok(Math.abs(totalCutSeconds(cuts) - 3.0) < 1e-9);
});

test("keepSegments drops slivers shorter than 50ms", () => {
  const cuts = [
    { start: 0.02, end: 5.0, enabled: true },
    { start: 5.01, end: 9.99, enabled: true },
  ];
  assert.deepEqual(keepSegments(cuts, 10.0), []);
});

test("a cut drawn over words spans them exactly, merges with neighbours, and stays enabled", () => {
  const words = [
    { id: 0, text: "so", start: 0.0, end: 0.3 }, { id: 1, text: "anyway", start: 0.35, end: 0.9 },
    { id: 2, text: "the", start: 1.0, end: 1.2 }, { id: 3, text: "point", start: 1.25, end: 1.7 },
  ];
  const kept = [{ start: 0.3, end: 0.35, enabled: false, sources: [{ start: 0.3, end: 0.35, reason: "silence", wordIds: [], enabled: false }] }];
  const cuts = addWordCut(kept, words, [1, 0]);
  assert.equal(cuts.length, 1, "the manual cut and the adjacent kept pause merged");
  assert.equal(cuts[0].start, 0.0);
  assert.equal(cuts[0].end, 0.9);
  assert.equal(cuts[0].enabled, true, "what was asked for is cut, even merged with a kept pause");
  assert.ok(cuts[0].sources.some((source) => source.reason === "manual" && source.wordIds.join() === "0,1"));
  assert.throws(() => addWordCut([], words, [99]), /no words/);
});

test("keepSegments never emits a keep that ends before it starts", () => {
  const keeps = keepSegments(normalizeCuts([
    { start: 9.98, end: 10.5, enabled: true, sources: [{ start: 9.98, end: 10.5, reason: "pause", enabled: true }] },
    { start: 10.6, end: 11, enabled: true, sources: [{ start: 10.6, end: 11, reason: "pause", enabled: true }] },
  ]), 10);
  for (const keep of keeps) assert.ok(keep.end >= keep.start, JSON.stringify(keeps));
});

test("keepWords splits an enabled cut around the chosen words and leaves disabled cuts alone", () => {
  const words = [
    { id: 0, start: 1.0, end: 1.4, text: "one" }, { id: 1, start: 1.5, end: 1.9, text: "two" },
    { id: 2, start: 2.0, end: 2.4, text: "three" }, { id: 3, start: 2.5, end: 2.9, text: "four" },
  ];
  const cuts = [
    { start: 0.2, end: 3.7, enabled: true, sources: [{ start: 0.2, end: 3.7, reason: "filler", wordIds: [0, 1, 2, 3], enabled: true }] },
    { start: 5, end: 6, enabled: false, sources: [{ start: 5, end: 6, reason: "silence", wordIds: [], enabled: true }] },
  ];
  const kept = keepWords(cuts, words, [1, 2]);
  assert.deepEqual(kept.map((c) => [c.start, c.end, c.enabled]), [[0.2, 1.5, true], [2.4, 3.7, true], [5, 6, false]]);
  assert.equal(kept[0].sources[0].reason, "filler");
  // Keeping every word leaves the 0.8 s of silence at either end as cuts of
  // their own, since the engine would have proposed a pause that long...
  assert.deepEqual(keepWords(cuts, words, [0, 1, 2, 3]).map((c) => [c.start, c.end]), [[0.2, 1.0], [2.9, 3.7], [5, 6]]);
  // ...but a breath shorter than that goes with the words.
  const tight = [{ start: 0.8, end: 3.1, enabled: true, sources: [{ start: 0.8, end: 3.1, reason: "filler", wordIds: [0, 1, 2, 3], enabled: true }] }];
  assert.deepEqual(keepWords(tight, words, [0, 1, 2, 3]), []);
  assert.throws(() => keepWords(cuts, words, [99]), /no words/);
});
