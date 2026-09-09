import test from "node:test";
import assert from "node:assert/strict";
import {
  validateScenes,
  resolveScenes,
  resolveCaptions,
  resolvePhraseCaptions,
  renderSchedule,
  activeAt,
} from "../core/compose-engine.mjs";
import { describeVariety, uncoveredCutaways, hiddenFullStage, overFullStage, absorbedStages, emphasisFor, captionEmphasis } from "../core/compose-engine.mjs";

const words = [
  { id: 0, text: "one", start: 0.0, end: 0.4 },
  { id: 1, text: "two", start: 0.5, end: 0.9 },
  { id: 2, text: "three", start: 3.0, end: 3.5 },
];

test("scenes resolve to their word span", () => {
  const [scene] = resolveScenes([{ type: "title", fromWordId: 0, toWordId: 1, text: "Hi" }], words);
  assert.equal(scene.start, 0.0);
  assert.equal(scene.end, 0.9);
});

test("validation refuses unknown types, bad ids, reversed ranges, empty text", () => {
  assert.throws(() => validateScenes([{ type: "wipe", fromWordId: 0, toWordId: 1, text: "x" }], words));
  assert.throws(() => validateScenes([{ type: "title", fromWordId: 0, toWordId: 9, text: "x" }], words));
  assert.throws(() => validateScenes([{ type: "title", fromWordId: 2, toWordId: 0, text: "x" }], words));
  assert.throws(() => validateScenes([{ type: "title", fromWordId: 0, toWordId: 1, text: "" }], words));
});

test("captions hang through short gaps but yield to the next word", () => {
  const spans = resolveCaptions(words);
  assert.equal(spans[0].end, 0.5); // next word arrives before the hang runs out
  assert.equal(spans[1].end, 1.3); // 0.9 + 0.4 hang, next word is far
  assert.equal(spans[2].end, 3.9); // last word hangs a beat
});

test("the schedule covers every overlay change and holds to the duration", () => {
  const scenes = resolveScenes([{ type: "title", fromWordId: 0, toWordId: 1, text: "Hi" }], words);
  const states = renderSchedule(scenes, resolveCaptions(words), 5);
  assert.equal(states[0].t, 0);
  const total = states.reduce((sum, state) => sum + state.duration, 0);
  assert.ok(Math.abs(total - 5) < 0.01);
  assert.ok(states.every((state) => state.duration > 0));
  assert.ok(states.some((state) => state.t === 3.0)); // "three" starts a state
});

test("animated graphics densify their window to frame rate; static spans stay sparse", () => {
  const scenes = resolveScenes([{
    type: "graphic", fromWordId: 0, toWordId: 1,
    graphic: { kind: "stat", value: 2, label: "snails" },
  }], words);
  const states = renderSchedule(scenes, null, 5, { fps: 30 });
  const inside = states.filter((s) => s.t >= 0 && s.t < 0.9);
  const outside = states.filter((s) => s.t >= 0.9);
  assert.ok(inside.length >= 25); // ~0.9s at 30fps
  assert.ok(outside.length <= 2); // nothing changes after the scene ends
});

test("graphic specs are validated by kind", () => {
  const good = { type: "graphic", fromWordId: 0, toWordId: 1 };
  validateScenes([{ ...good, graphic: { kind: "chart", items: [{ label: "a", value: 1 }] } }], words);
  validateScenes([{ ...good, graphic: { kind: "list", items: [{ label: "a" }] } }], words);
  validateScenes([{ ...good, graphic: { kind: "stat", value: 3, label: "x" } }], words);
  assert.throws(() => validateScenes([{ ...good, graphic: { kind: "pie", items: [] } }], words));
  assert.throws(() => validateScenes([{ ...good, graphic: { kind: "chart", items: [{ label: "a" }] } }], words));
  assert.throws(() => validateScenes([{ ...good, graphic: { kind: "stat", label: "x" } }], words));
  assert.throws(() => validateScenes([{ ...good }], words));
});

test("activeAt is start-inclusive, end-exclusive", () => {
  const scenes = resolveScenes([{ type: "callout", fromWordId: 1, toWordId: 1, text: "!" }], words);
  assert.equal(activeAt(scenes, 0.5).length, 1);
  assert.equal(activeAt(scenes, 0.9).length, 0);
});

test("phrase captions break at sentence ends, clause commas, pauses, and length", () => {
  const ws = [
    { id: 0, text: "Well,", start: 0.0, end: 0.2 },
    { id: 1, text: "guys,", start: 0.25, end: 0.5 },
    { id: 2, text: "we", start: 0.55, end: 0.7 },
    { id: 3, text: "did", start: 0.75, end: 0.9 },
    { id: 4, text: "it.", start: 0.95, end: 1.2 },
    { id: 5, text: "One", start: 3.0, end: 3.2 },
    { id: 6, text: "two", start: 3.25, end: 3.4 },
    { id: 7, text: "three", start: 3.45, end: 3.6 },
    { id: 8, text: "four", start: 3.65, end: 3.8 },
    { id: 9, text: "five", start: 3.85, end: 4.0 },
  ];
  const spans = resolvePhraseCaptions(ws);
  assert.deepEqual(spans.map((s) => s.text), ["Well, guys,", "we did it.", "One two three four", "five"]);
  assert.equal(spans[0].end, 0.55); // yields to the next phrase
  assert.equal(spans[1].end, 1.6); // hangs a beat through the long pause
  assert.equal(spans.at(-1).end, 4.4);
});

test("the wider kit validates: styles, subtitles, and the new graphic kinds", () => {
  const ok = (scene) => validateScenes([{ fromWordId: 0, toWordId: 1, ...scene }], words);
  const bad = (scene, re) => assert.throws(() => ok(scene), re);
  ok({ type: "title", text: "Hi", style: "slam", subtitle: "a sub" });
  bad({ type: "title", text: "Hi", style: "explode" }, /title style/);
  ok({ type: "callout", text: "Hi", style: "stamp" });
  bad({ type: "callout", text: "Hi", style: "pill-ish" }, /callout style/);
  ok({ type: "graphic", graphic: { kind: "quote", text: "Ship it.", by: "Someone" } });
  bad({ type: "graphic", graphic: { kind: "quote", text: "" } }, /quote needs text/);
  ok({ type: "graphic", graphic: { kind: "ring", value: 64, label: "done" } });
  bad({ type: "graphic", graphic: { kind: "ring", value: 640, label: "done" } }, /0 to 100/);
  ok({ type: "graphic", graphic: { kind: "compare", left: { title: "A", items: [{ label: "x" }] }, right: { title: "B", items: [{ label: "y" }] } } });
  bad({ type: "graphic", graphic: { kind: "compare", left: { title: "A", items: [] } } }, /compare/);
  ok({ type: "graphic", graphic: { kind: "steps", items: [{ label: "one" }, { label: "two" }] } });
  ok({ type: "graphic", graphic: { kind: "logos", items: [{ src: "assets/a.png", label: "A" }] } });
  bad({ type: "graphic", graphic: { kind: "logos", items: [{ src: "../a.png" }] } }, /project-relative/);
  ok({ type: "graphic", graphic: { kind: "image", src: "assets/a.png", motion: "kenburns" } });
  bad({ type: "graphic", graphic: { kind: "image", src: "assets/a.png", motion: "spin" } }, /motion/);
});

test("full-stage kinds validate, and a custom graphic may carry nothing that runs or loads", () => {
  const ok = (graphic) => validateScenes([{ type: "graphic", fromWordId: 0, toWordId: 1, graphic }], words);
  const bad = (graphic, re) => assert.throws(() => ok(graphic), re);
  ok({ kind: "cover", title: "APPLE MAN SAM", subtitle: "live", src: "assets/capsule.jpg", tint: "#101010" });
  bad({ kind: "cover", title: "" }, /cover needs a title/);
  ok({ kind: "section", title: "THE JOURNEY", number: "02" });
  bad({ kind: "section", title: "x", number: "1234567" }, /number/);
  ok({ kind: "custom", html: "<div class=\"a\">hi</div>", css: ".a { opacity: var(--q); }" });
  bad({ kind: "custom", html: "<script>alert(1)</script>" }, /may not contain/);
  bad({ kind: "custom", html: "<div onclick=\"x()\">hi</div>" }, /may not contain/);
  bad({ kind: "custom", html: "<img src=\"https://example.com/x.png\">" }, /may not contain/);
  bad({ kind: "custom", html: "<div>x</div>", css: "@import url(evil.css);" }, /may not contain/);
});

test("insert points validate, materialise a choice, and replace it on a second choice", async () => {
  const { validateInserts, applyInsertChoice, resolveInserts } = await import("../core/compose-engine.mjs");
  const option = (id, label, scenes) => ({ id, label, scenes });
  const inserts = [{
    id: "features", fromWordId: 0, toWordId: 2, why: "the feature list",
    options: [
      option("side", "Side card", [{ type: "stage", fromWordId: 0, toWordId: 2, layout: "side" }, { type: "graphic", fromWordId: 0, toWordId: 2, graphic: { kind: "list", items: [{ label: "a" }] } }]),
      option("kinetic", "Spoken words", [{ type: "kinetic", fromWordId: 0, toWordId: 2 }]),
    ],
  }];
  validateInserts(inserts, words);
  assert.throws(() => validateInserts([{ ...inserts[0], id: "Bad Id" }], words), /slug/);
  assert.throws(() => validateInserts([{ ...inserts[0], chosen: "nope" }], words), /not one of its options/);
  assert.throws(() => validateInserts([{ ...inserts[0], options: [] }], words), /1–5 options/);
  const config = { scenes: [{ type: "title", fromWordId: 1, toWordId: 2, text: "keep me" }], inserts };
  const chosen = applyInsertChoice(config, "features", "side");
  assert.equal(chosen.scenes.length, 3);
  assert.equal(chosen.scenes.filter((s) => s.insertId === "features").length, 2);
  assert.equal(chosen.inserts[0].chosen, "side");
  const swapped = applyInsertChoice(chosen, "features", "kinetic");
  assert.equal(swapped.scenes.length, 2);
  assert.equal(swapped.scenes.find((s) => s.insertId)?.type, "kinetic");
  assert.equal(swapped.scenes.find((s) => s.text === "keep me")?.type, "title", "scenes outside the insert stay");
  const cleared = applyInsertChoice(swapped, "features", null);
  assert.equal(cleared.scenes.length, 1);
  assert.equal(cleared.inserts[0].chosen, null);
  const other = applyInsertChoice(cleared, "features", "other", "make it a chart of the three stages");
  assert.equal(other.inserts[0].note, "make it a chart of the three stages");
  const resolved = resolveInserts(inserts, words);
  assert.equal(resolved[0].start, 0);
  assert.equal(resolved[0].options[0].scenes[0].insertId, "features");
  assert.equal(typeof resolved[0].options[0].scenes[0].start, "number");
});

test("caption modes read the old booleans and write subtitle files re-timed to the span", async () => {
  const { captionMode, captionsBurnedIn, captionsAsFile, subtitleFile } = await import("../core/compose-engine.mjs");
  assert.equal(captionMode(true), "open");
  assert.equal(captionMode(false), "none");
  assert.equal(captionMode(undefined), "none");
  assert.equal(captionMode("closed"), "closed");
  assert.throws(() => captionMode("sideways"), /captions must be/);
  assert.equal(captionsBurnedIn("both"), true);
  assert.equal(captionsBurnedIn("closed"), false);
  assert.equal(captionsAsFile("closed"), true);
  assert.equal(captionsAsFile("open"), false);
  const cues = [{ start: 0.5, end: 2.0, text: "Well, guys," }, { start: 61.25, end: 63.9, text: "we did it." }];
  const srt = subtitleFile(cues, "srt");
  assert.ok(srt.startsWith("1\n00:00:00,500 --> 00:00:02,000\nWell, guys,\n"));
  assert.ok(srt.includes("2\n00:01:01,250 --> 00:01:03,900\nwe did it.\n"));
  const vtt = subtitleFile(cues, "vtt", 60, 70);
  assert.ok(vtt.startsWith("WEBVTT\n"));
  assert.ok(vtt.includes("00:00:01.250 --> 00:00:03.900\nwe did it."), "a span re-times from its own zero");
  assert.ok(!vtt.includes("Well, guys"), "cues outside the span are dropped");
});

test("the variety read names repetition, concentration, a flat stage and dead stretches", () => {
  const card = (kind, start, end) => ({ type: "graphic", graphic: { kind }, start, end });
  const stage = (layout, start, end) => ({ type: "stage", layout, start, end });

  const repetitive = describeVariety([card("chart", 10, 20), card("chart", 30, 40), card("chart", 50, 60), card("chart", 70, 80)], 600);
  assert.ok(repetitive.some((note) => /4 chart cards in a row/.test(note)), repetitive.join(" | "));
  assert.ok(repetitive.some((note) => /4 of 4 cards are chart/.test(note)));
  assert.ok(repetitive.some((note) => /owns the whole stage/.test(note)));
  assert.ok(repetitive.some((note) => /Nothing but the head/.test(note)));

  const varied = describeVariety([
    card("chart", 10, 20), card("quote", 30, 40), stage("full", 50, 60), card("cover", 50, 60),
    card("list", 70, 80), card("stat", 95, 110),
  ], 130);
  assert.equal(varied.length, 1);
  assert.match(varied[0], /camera never leaves/);

  // Two in a row is a pair, not a template; four identical layouts is.
  assert.deepEqual(describeVariety([card("stat", 0, 5), card("stat", 6, 10), card("list", 11, 15)], 60), []);
  const flat = describeVariety([stage("side", 0, 5), stage("side", 6, 10), stage("side", 11, 15), stage("side", 16, 20)], 60);
  assert.ok(flat.some((note) => /4 side layouts in a row/.test(note)), flat.join(" | "));
});


test("different cards do not disguise a presenter-side layout dominating the film", () => {
  const scenes = ["steps", "compare", "custom"].flatMap((kind, i) => [
    { type: "stage", layout: "side", start: i * 25, end: i * 25 + 22 },
    { type: "graphic", graphic: { kind }, start: i * 25, end: i * 25 + 22 },
  ]);
  const notes = describeVariety(scenes, 90);
  assert.ok(notes.some(n => /Presenter beside graphics/.test(n)));
  assert.ok(notes.some(n => /camera never leaves/.test(n)));
  const revised = describeVariety([{ type: "stage", layout: "cutaway", start: 0, end: 45 }], 90);
  assert.ok(!revised.some(n => /camera never leaves/.test(n)));
});

// The dwell rule bridges away a momentary return to camera between two
// cards. That is right — a third of a second of presenter is a flash — but
// it turns a papered-over gap into a hole, and a hole in a cutaway is an
// empty stage. So the hole is reported instead of being rendered quietly.
test("a cutaway with nothing over part of it is reported", () => {
  const card = (start, end) => ({ type: "graphic", start, end, graphic: { kind: "list", items: [{ label: "x" }] } });
  const cutaway = (start, end) => ({ type: "stage", layout: "cutaway", start, end });
  const holes = uncoveredCutaways([cutaway(10, 30), card(10, 19.8), card(20.2, 30)], 60);
  assert.deepEqual(holes, [{ start: 19.8, end: 20.2 }]);
  // Covered end to end: nothing to say.
  assert.deepEqual(uncoveredCutaways([cutaway(10, 30), card(10, 30)], 60), []);
  // A couple of frames is word timing, not a hole.
  assert.deepEqual(uncoveredCutaways([cutaway(10, 30), card(10, 19.95), card(20, 30)], 60), []);
  // The camera being on is never a hole, however bare the stage.
  assert.deepEqual(uncoveredCutaways([{ type: "stage", layout: "side", start: 10, end: 30 }], 60), []);
  // A cutaway the plan forgot entirely is one hole, end to end.
  assert.deepEqual(uncoveredCutaways([cutaway(10, 30)], 60), [{ start: 10, end: 30 }]);
});

test("a full-stage graphic under a head-first layout is reported, under a cutaway or full it is not", () => {
  const cta = { type: "graphic", start: 30, end: 36, fromWordId: 0, toWordId: 1, graphic: { kind: "custom", template: "cta", html: "x" } };
  const alone = hiddenFullStage([cta], 40);
  assert.equal(alone.length, 1);
  assert.equal(alone[0].index, 0);
  assert.equal(alone[0].kind, "cta");
  assert.deepEqual(alone[0].layouts, ["focus"]);
  const covered = hiddenFullStage([{ type: "stage", layout: "cutaway", start: 30, end: 36, fromWordId: 0, toWordId: 1 }, cta], 40);
  assert.deepEqual(covered, []);
  const corner = hiddenFullStage([{ type: "stage", layout: "full", start: 30, end: 36, fromWordId: 0, toWordId: 1 }, cta], 40);
  assert.deepEqual(corner, []);
  // A column card is never hidden: it sits beside the head by design.
  const column = hiddenFullStage([{ ...cta, graphic: { kind: "custom", template: "alert", html: "x", full: false } }], 40);
  assert.deepEqual(column, []);
});

test("caption emphasis leans on numbers, absolutes and listed words, two per phrase at most", () => {
  assert.deepEqual(emphasisFor(["it", "took", "sixteen", "minutes"], "auto"), [false, false, true, false]);
  assert.deepEqual(emphasisFor(["never", "do", "this", "with", "80%", "of", "them"], "auto"), [true, false, false, false, true, false, false]);
  assert.deepEqual(emphasisFor(["the", "thing", "nobody", "tells", "you"], "none"), [false, false, false, false, false]);
  assert.deepEqual(emphasisFor(["we", "use", "WhisperX", "here"], "auto"), [false, false, true, false]);
  assert.deepEqual(emphasisFor(["turn", "sideways", "as", "it", "climbs"], ["sideways", "climbs"]), [false, true, false, false, true]);
  assert.equal(emphasisFor(["one", "two", "three"], "auto").filter(Boolean).length, 2, "at most two");
  assert.equal(captionEmphasis(undefined), "none");
  assert.equal(captionEmphasis(true), "auto");
  assert.deepEqual(captionEmphasis(["Orbit,", "gravity"]), ["orbit", "gravity"]);
  assert.throws(() => captionEmphasis("loud"), /none, auto, or a list/);
  const phrases = resolvePhraseCaptions([{ id: 0, text: "sixteen", start: 0, end: 0.4 }, { id: 1, text: "minutes.", start: 0.5, end: 0.9 }], { emphasis: "auto" });
  assert.equal(phrases[0].words[0].emph, true);
  assert.equal(phrases[0].words[1].emph, undefined);
  assert.equal(resolvePhraseCaptions([{ id: 0, text: "sixteen", start: 0, end: 0.4 }])[0].words[0].emph, undefined, "none by default");
});

test("a title or callout over a full-stage card is reported; over a column card it is not", () => {
  const cover = { type: "graphic", start: 10, end: 20, fromWordId: 0, toWordId: 1, graphic: { kind: "custom", template: "before-after", html: "x" } };
  const callout = { type: "callout", start: 14, end: 18, fromWordId: 0, toWordId: 1, text: "x" };
  const hits = overFullStage([cover, callout]);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0], { index: 1, type: "callout", card: "before-after", seconds: 4 });
  const column = { ...cover, graphic: { kind: "stat", value: 1, label: "x" } };
  assert.deepEqual(overFullStage([column, callout]), []);
  const apart = { ...callout, start: 21, end: 24 };
  assert.deepEqual(overFullStage([cover, apart]), []);
});

test("a card hangs through a short seam to the next card, and a stage span under the dwell floor is reported", () => {
  const ws = [
    { id: 0, text: "a", start: 0, end: 0.4 }, { id: 1, text: "b", start: 0.5, end: 0.9 },
    { id: 2, text: "c", start: 1.2, end: 1.6 }, { id: 3, text: "d", start: 1.7, end: 2.1 },
    { id: 4, text: "e", start: 4.0, end: 4.4 }, { id: 5, text: "f", start: 4.5, end: 4.9 },
  ];
  const resolved = resolveScenes([
    { type: "graphic", fromWordId: 0, toWordId: 1, graphic: { kind: "stat", value: 1, label: "x" } },
    { type: "graphic", fromWordId: 2, toWordId: 3, graphic: { kind: "stat", value: 2, label: "y" } },
    { type: "graphic", fromWordId: 4, toWordId: 5, graphic: { kind: "stat", value: 3, label: "z" } },
    { type: "stage", fromWordId: 2, toWordId: 3, layout: "side" },
    { type: "stage", fromWordId: 0, toWordId: 5, layout: "cutaway" },
  ], ws);
  assert.equal(resolved[0].end, 1.2, "the first card hangs to the second");
  assert.equal(resolved[1].end, 2.1, "a 1.9 s gap is a gap, not a seam");
  const short = absorbedStages(resolved);
  assert.equal(short.length, 1);
  assert.deepEqual(short[0], { index: 3, layout: "side", seconds: 0.9, floor: 3 });
});

test("a custom graphic over the head is valid and is never reported as hidden behind it", () => {
  const over = { type: "graphic", start: 0, end: 4, fromWordId: 0, toWordId: 1, graphic: { kind: "custom", template: "thumbnail", html: "x", over: true } };
  validateScenes([over], words);
  assert.deepEqual(hiddenFullStage([over], 10), []);
  assert.throws(() => validateScenes([{ ...over, graphic: { ...over.graphic, over: "yes" } }], words), /over is true or false/);
});
