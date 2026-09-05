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
