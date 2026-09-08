import test from "node:test";
import assert from "node:assert/strict";
import { chapterList, chaptersFromScenes } from "../core/chapters.mjs";

const graphic = (start, end, g) => ({ type: "graphic", start, end, fromWordId: 0, toWordId: 1, graphic: g });

test("chapters come from the plan's section marks, start at 0:00, and fold marks that crowd each other", () => {
  const scenes = [
    graphic(0.2, 5, { kind: "cover", title: "How rockets work" }),
    graphic(48, 54, { kind: "section", number: "02", title: "Getting to orbit" }),
    graphic(52, 56, { kind: "section", title: "too close to count" }),
    graphic(90, 95, { kind: "custom", template: "headline", params: { headline: "The bottleneck was never the encoder" } }),
    graphic(100, 104, { kind: "stat", value: 3, label: "not a mark" }),
  ];
  const list = chapterList({ scenes, duration: 130 });
  assert.equal(list.source, "plan");
  assert.equal(list.text, "0:00 How rockets work\n0:48 Getting to orbit\n1:30 The bottleneck was never the encoder\n");
  assert.equal(list.enough, true);
  assert.equal(chaptersFromScenes(scenes).length, 4);
});

test("without marks the story's sections stand in, and a bare film gets one chapter with its title", () => {
  const words = [];
  let t = 0;
  const say = (text, pause = 0.2) => { for (const w of text.split(" ")) { words.push({ id: words.length, text: w, start: t, end: t + 0.35 }); t += 0.38; } t += pause; };
  for (let i = 0; i < 40; i += 1) say("this is the opening and it keeps going for a while.");
  say("So the second thing is the render.", 1.3);
  for (let i = 0; i < 40; i += 1) say("the render took sixteen minutes and then six.");
  const list = chapterList({ words, title: "The talk" });
  assert.equal(list.source, "story");
  assert.match(list.text, /^0:00 /);
  assert.ok(list.text.split("\n").filter(Boolean).length >= 2, list.text);
  assert.ok(list.text.includes("The render"), list.text);
  const bare = chapterList({ words: words.slice(0, 20), title: "The talk" });
  assert.equal(bare.text, "0:00 The talk\n");
  assert.equal(bare.enough, false);
});

test("a mark inside the first ten seconds names the opening chapter, and a mark in the last ten is dropped", () => {
  const scenes = [graphic(4, 8, { kind: "section", title: "Opening" }), graphic(60, 64, { kind: "section", title: "Middle" }), graphic(118, 121, { kind: "section", title: "Tail" })];
  const list = chapterList({ scenes, duration: 122, title: "Film" });
  assert.equal(list.text, "0:00 Opening\n1:00 Middle\n");
  // Over an hour reads with hours.
  const long = chapterList({ scenes: [graphic(0, 4, { kind: "section", title: "A" }), graphic(3725, 3730, { kind: "section", title: "B" })], duration: 4000 });
  assert.equal(long.text, "0:00 A\n1:02:05 B\n");
});
