import test from "node:test";
import assert from "node:assert/strict";
import { describePacing, WORD_BUDGET, PACE } from "../core/pacing.mjs";

const scene = (type, start, end, extra = {}) => ({ type, start, end, fromWordId: 0, toWordId: 1, ...extra });

test("a short with nothing on screen for its first seconds, no captions and a bare ending is told all three", () => {
  const scenes = [scene("callout", 6, 9, { text: "one idea" })];
  const { stats, notes } = describePacing(scenes, { duration: 30, format: "vertical", shortForm: true, captions: "none" });
  assert.equal(stats.firstVisualAt, 6);
  assert.ok(notes.some((n) => n.includes("first visual lands at 6.0s")), notes.join("\n"));
  assert.ok(notes.some((n) => n.includes("Captions are not burned in")));
  assert.ok(notes.some((n) => n.includes("last")), "the ending");
  assert.ok(notes.some((n) => n.includes("Nothing changes")), "the still stretch");
  assert.equal(stats.captions, "not burned in");
});

test("a short that opens on a hook, keeps moving, burns captions in and ends on a cta is left alone", () => {
  const scenes = [
    scene("stage", 0, 4, { layout: "cutaway" }),
    scene("graphic", 0, 4, { graphic: { kind: "custom", template: "hook", html: "x" } }),
    scene("callout", 5, 9, { text: "one idea" }),
    scene("kinetic", 10, 14),
    scene("callout", 15, 19, { text: "another" }),
    scene("graphic", 20, 24, { graphic: { kind: "stat", value: 3, label: "x" } }),
    scene("stage", 26, 30, { layout: "cutaway" }),
    scene("graphic", 26, 30, { graphic: { kind: "custom", template: "cta", html: "x" } }),
  ];
  const { stats, notes } = describePacing(scenes, { duration: 30, format: "vertical", shortForm: true, captions: "open" });
  assert.deepEqual(notes, [], notes.join("\n"));
  assert.equal(stats.firstVisualAt, 0);
  assert.ok(stats.changesPerMinute > 10);
});

test("a long film is judged on its own clock", () => {
  const scenes = [scene("title", 30, 36, { text: "Late" }), scene("callout", 200, 205, { text: "x" })];
  const { notes } = describePacing(scenes, { duration: 300, format: "landscape", shortForm: false, captions: "closed" });
  assert.ok(notes.some((n) => n.includes("first visual lands at 0:30")), notes.join("\n"));
  assert.ok(notes.some((n) => n.includes("Nothing changes from 0:36 to 3:20")), notes.join("\n"));
  assert.ok(!notes.some((n) => n.includes("Captions")), "captions are the film's business in landscape");
  // Inside the allowance, nothing is said.
  const fine = [scene("title", 5, 10, { text: "Early" }), scene("callout", 40, 45, { text: "x" }), scene("callout", 80, 85, { text: "y" })];
  assert.deepEqual(describePacing(fine, { duration: 100, format: "landscape", captions: "closed" }).notes, []);
});

test("word budgets are the frame's, named by scene index", () => {
  const nine = "one two three four five six seven eight nine";
  const scenes = [scene("title", 0, 3, { text: nine }), scene("callout", 4, 7, { text: "a b c d e f" }), scene("graphic", 8, 12, { graphic: { kind: "quote", text: nine + " " + nine + " " + nine } })];
  const wide = describePacing(scenes, { duration: 20, format: "landscape", captions: "open" });
  assert.ok(!wide.notes.some((n) => n.startsWith("scene 0")), "nine words fit a wide title");
  const tall = describePacing(scenes, { duration: 20, format: "vertical", shortForm: true, captions: "open" });
  assert.ok(tall.notes.some((n) => n.startsWith("scene 0: the title is 9 words; 4")), tall.notes.join("\n"));
  assert.ok(tall.notes.some((n) => n.startsWith("scene 1: the callout is 6 words")));
  assert.ok(tall.notes.some((n) => n.startsWith("scene 2: the quote is 27 words")));
  assert.equal(WORD_BUDGET.vertical.title, 4);
  assert.ok(PACE.vertical.firstVisual < PACE.landscape.firstVisual);
});

test("a tall frame refuses a six-bar chart and a wide compare", () => {
  const scenes = [
    scene("graphic", 0, 5, { graphic: { kind: "chart", items: Array.from({ length: 6 }, (_, i) => ({ label: `b${i}`, value: i })) } }),
    scene("graphic", 6, 10, { graphic: { kind: "compare", left: { title: "a", items: [{ label: "1" }, { label: "2" }, { label: "3" }, { label: "4" }] }, right: { title: "b", items: [{ label: "1" }] } } }),
  ];
  const { notes } = describePacing(scenes, { duration: 12, format: "vertical", shortForm: true, captions: "open" });
  assert.ok(notes.some((n) => n.includes("scene 0: a chart with 6 bars")));
  assert.ok(notes.some((n) => n.includes("scene 1: two columns")));
});

test("a span-paced template counts each arrival as a change", () => {
  const still = [scene("stage", 2, 14, { layout: "cutaway" }), scene("graphic", 2, 14, { graphic: { kind: "custom", template: "flow", params: { items: [{ label: "a" }, { label: "b" }, { label: "c" }, { label: "d" }] } } })];
  const before = describePacing(still, { duration: 16, format: "vertical", shortForm: true, captions: "open" });
  assert.ok(before.notes.some((n) => n.includes("Nothing changes from 2.0s to 14.0s")), before.notes.join("\n"));
  const paced = JSON.parse(JSON.stringify(still));
  paced[1].graphic.params.pace = "span";
  const after = describePacing(paced, { duration: 16, format: "vertical", shortForm: true, captions: "open" });
  assert.ok(!after.notes.some((n) => n.includes("Nothing changes from 2.0s")), after.notes.join("\n"));
  assert.ok(after.stats.longestStill.seconds < 6);
});

test("a span-paced before-after counts its sweep as a change", () => {
  const still = [scene("stage", 2, 14, { layout: "cutaway" }), scene("graphic", 2, 14, { graphic: { kind: "custom", template: "before-after", params: { before: "a", after: "b", pace: "span" } } })];
  const { stats } = describePacing(still, { duration: 16, format: "vertical", shortForm: true, captions: "open" });
  assert.ok(stats.longestStill.seconds < 8, JSON.stringify(stats.longestStill));
});

test("a visual ending on the film's last frame is not counted twice", () => {
  const toEnd = describePacing([scene("title", 10, 60, { text: "x" })], { duration: 60, format: "landscape", captions: "closed" });
  const before = describePacing([scene("title", 10, 50, { text: "x" })], { duration: 60, format: "landscape", captions: "closed" });
  assert.ok(toEnd.stats.changesPerMinute < before.stats.changesPerMinute, `${toEnd.stats.changesPerMinute} vs ${before.stats.changesPerMinute}`);
});

test("a motion scene is never the film's longest still, however long it holds", async () => {
  const { describePacing } = await import("../core/pacing.mjs");
  const scenes = [
    { type: "graphic", start: 10, end: 40, graphic: { kind: "motion", src: "motion/orbit.html" } },
    { type: "stage", start: 10, end: 40, layout: "cutaway" },
  ];
  const { stats } = describePacing(scenes, { duration: 60 });
  assert.ok(stats.longestStill.seconds <= 20, `longest still ${stats.longestStill.seconds}s`);
  assert.ok(!(stats.longestStill.start >= 10 && stats.longestStill.end <= 40 && stats.longestStill.seconds > 2.01));
});
