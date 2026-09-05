import test from "node:test";
import assert from "node:assert/strict";
import { reanchorScene, reanchorScenes } from "../core/reanchor.mjs";

const speak = (texts, startAt = 0, gap = 0.4) => texts.map((text, id) => ({ id, text, start: startAt + id * gap, end: startAt + id * gap + 0.3 }));
const oldWords = speak(["So", "today", "we", "ship", "the", "demo.", "It", "took", "six", "months", "and", "hundreds", "of", "hours."]);
// The new transcript lost a word near the front and everything moved 1.7 s earlier.
const newWords = speak(["today", "we", "ship", "the", "demo.", "It", "took", "six", "months,", "and", "hundreds", "of", "hours."], -1.7);

test("a scene finds its words again by context, ids and times moved", () => {
  const scene = { type: "title", fromWordId: 3, toWordId: 5, text: "SHIP" }; // "ship the demo."
  const result = reanchorScene(scene, oldWords, newWords);
  assert.equal(result.ok, true);
  assert.equal(newWords[result.fromWordId].text, "ship");
  assert.equal(newWords[result.toWordId].text, "demo.");
  assert.equal(result.shiftSeconds, -2.1); // the word before it vanished too
  assert.ok(result.confidence >= 0.9);
});

test("punctuation and case do not matter, and a span survives a changed token inside it", () => {
  const scene = { type: "callout", fromWordId: 7, toWordId: 13 }; // "took six months and hundreds of hours."
  const result = reanchorScene(scene, oldWords, newWords);
  assert.equal(result.ok, true);
  assert.equal(newWords[result.fromWordId].text, "took");
  assert.equal(newWords[result.toWordId].text, "hours.");
});

test("a span whose words are gone is reported, not guessed", () => {
  const gone = speak(["completely", "different", "words", "here", "now", "friends"]);
  const result = reanchorScene({ type: "title", fromWordId: 3, toWordId: 5 }, oldWords, gone);
  assert.equal(result.ok, false);
  assert.match(result.reason, /not found/);
  assert.equal(result.fromWordId, 3);
});

test("the nearest repeat wins when the same words are said twice", () => {
  const twice = speak(["we", "ship", "the", "demo.", "pause.", "we", "ship", "the", "demo."], 0);
  const old = speak(["we", "ship", "the", "demo.", "pause.", "we", "ship", "the", "demo."], 0);
  const late = reanchorScene({ type: "title", fromWordId: 5, toWordId: 8 }, old, twice);
  assert.equal(late.fromWordId, 5);
  const early = reanchorScene({ type: "title", fromWordId: 0, toWordId: 3 }, old, twice);
  assert.equal(early.fromWordId, 0);
});

test("reanchorScenes keeps order and indices", () => {
  const report = reanchorScenes([{ type: "title", fromWordId: 3, toWordId: 5 }, { type: "kinetic", fromWordId: 0, toWordId: 1 }], oldWords, newWords);
  assert.deepEqual(report.map((r) => r.index), [0, 1]);
  assert.equal(report[0].ok, true);
  assert.equal(report[1].ok, false); // "So today we" lost "So"; only two tokens exist and one is gone... 
});
