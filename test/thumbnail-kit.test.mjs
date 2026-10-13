import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  KIT_KIND, KIT_SCHEMA_VERSION, FACE_TAGS, MIN_FACE_GAP_SECONDS, MIN_DISTINCT_GAP_SECONDS, looksAlike,
  pieceAt, cleanTimeOf, keptRegions, fineWindow,
  laplacianVariance, exposureOf, dhash, hamming, histogramOf, histogramSimilarity, imageSize,
  faceSignals, faceExtras, faceTags, handFeatures, scoreFace, scorePlain, selectFaces, fineCentres, selectScreens, sameScreen,
  pictureRefs, picturesShown, pictureCredit, wordsAround, speakingAt, hookText, kitHooks, kitStyle, validateKit, safeLeaf,
} from "../core/thumbnail-kit.mjs";
import { makeThumbnailKit, readThumbnailKit, REPORT_FILE } from "../scripts/thumbnail-kit.mjs";
import { jobSpec, JOB_STAGES } from "../scripts/project-state.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// A cut film as out/clean-map.json describes it: three kept stretches of the recording, the first
// two in the full camera, the third with the camera in a corner beside a screen.
const FULL = { x: 448, y: 4, w: 2544, h: 1431 };
const CORNER = { x: 2356, y: 826, w: 1072, h: 603 };
const SCREEN = { x: 720, y: 146, w: 1620, h: 1236 };
const PIECES = [
  { start: 2, end: 10, cleanStart: 0, cleanEnd: 8, head: FULL, screen: null },
  { start: 12, end: 30, cleanStart: 8, cleanEnd: 26, head: FULL, screen: null },
  { start: 40, end: 70, cleanStart: 26, cleanEnd: 56, head: CORNER, screen: SCREEN },
];

const word = (id, text, start, end) => ({ id, text, start, end });

// ---- The two timelines ----

test("only what the film shows has a place on its clock: cut-out footage and the edges of a cut do not", () => {
  assert.equal(cleanTimeOf(PIECES, 5), 3);
  assert.equal(cleanTimeOf(PIECES, 45), 31);
  assert.equal(cleanTimeOf(PIECES, 11), null, "inside a cut");
  assert.equal(cleanTimeOf(PIECES, 35), null, "inside a cut");
  assert.equal(cleanTimeOf(PIECES, 1), null, "before the film");
  assert.equal(cleanTimeOf(PIECES, 80), null, "after the film");
  assert.equal(cleanTimeOf(PIECES, 10), null, "the last instant before a cut is not trusted");
  assert.equal(cleanTimeOf(PIECES, 12.01), null, "nor the first after it");
  assert.equal(pieceAt(PIECES, 50).head, CORNER);
});

test("kept regions group the kept stretches by the rectangle that frames them, never spanning a cut", () => {
  const heads = keptRegions(PIECES, "head");
  assert.equal(heads.length, 2);
  const full = heads.find((g) => g.rect === FULL);
  assert.deepEqual(full.intervals.map((i) => [i.start, i.end]), [[2.05, 9.95], [12.05, 29.95]]);
  const screens = keptRegions(PIECES, "screen");
  assert.equal(screens.length, 1);
  assert.deepEqual(screens[0].intervals.map((i) => [i.start, i.end]), [[40.05, 69.95]]);
  // Two pieces that touch are one stretch.
  const touching = keptRegions([{ start: 0, end: 5, head: FULL }, { start: 5, end: 9, head: FULL }], "head");
  assert.deepEqual(touching[0].intervals.map((i) => [i.start, i.end]), [[0.05, 8.95]]);
});

test("a fine look stays inside the piece that holds its moment", () => {
  const near = fineWindow(PIECES, 9.8);
  assert.ok(near.end <= 9.95 && near.start >= 9.2, JSON.stringify(near));
  const start = fineWindow(PIECES, 12.2);
  assert.ok(start.start >= 12.05 - 1e-9);
  assert.equal(fineWindow(PIECES, 11), null, "nothing to look at in a cut");
});

// ---- Pixels ----

test("the focus measure tells a sharp edge from a smear, and light and hashes behave", () => {
  const w = 64; const h = 64;
  const sharp = new Uint8Array(w * h).map((_, i) => ((i % w) >> 2) % 2 ? 230 : 20);
  const flat = new Uint8Array(w * h).fill(120);
  const rect = { x: 0, y: 0, w, h };
  assert.ok(laplacianVariance(sharp, w, h, rect) > 1000);
  assert.equal(laplacianVariance(flat, w, h, rect), 0);
  assert.equal(exposureOf(flat, w, h, rect).exposure, 0.47);
  const rising = new Uint8Array(w * h).map((_, i) => (i % w) * 4);
  const falling = new Uint8Array(w * h).map((_, i) => 255 - (i % w) * 4);
  assert.equal(hamming(dhash(rising, w, h), dhash(rising, w, h)), 0);
  assert.equal(hamming(dhash(rising, w, h), dhash(falling, w, h)), 64, "every comparison flips");
  assert.equal(histogramSimilarity(histogramOf(flat), histogramOf(flat)), 1);
  assert.ok(histogramSimilarity(histogramOf(sharp), histogramOf(flat)) < 0.1);
});

test("picture sizes come from the file's own header: PNG, JPEG and WebP", () => {
  const png = Buffer.alloc(32); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png); png.writeUInt32BE(640, 16); png.writeUInt32BE(360, 20);
  assert.deepEqual(imageSize(png), { width: 640, height: 360 });
  // SOI, an APP0 segment, then a baseline frame header: height 480, width 720.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0xd0, 0x03, ...new Array(20).fill(0)]);
  assert.deepEqual(imageSize(jpeg), { width: 720, height: 480 });
  const webp = Buffer.alloc(32); webp.write("RIFF", 0, "ascii"); webp.write("WEBP", 8, "ascii"); webp.write("VP8X", 12, "ascii"); webp.writeUIntLE(1279, 24, 3); webp.writeUIntLE(719, 27, 3);
  assert.deepEqual(imageSize(webp), { width: 1280, height: 720 });
  assert.equal(imageSize(Buffer.from("GIF89a and then some more bytes to be long enough")), null);
});

// ---- Reading a face (stubbed analyser output) ----

const shapes = (over = {}) => ({
  eyeBlinkLeft: 0.1, eyeBlinkRight: 0.1, mouthSmileLeft: 0, mouthSmileRight: 0, jawOpen: 0.02, browInnerUp: 0.05, browOuterUpLeft: 0, browOuterUpRight: 0,
  browDownLeft: 0, browDownRight: 0, eyeWideLeft: 0, eyeWideRight: 0, eyeLookDownLeft: 0.1, eyeLookDownRight: 0.1, ...over,
});
const analysis = (over = {}, pose = { yaw: 0, pitch: -5 }, face = { x: 300, y: 80, w: 180, h: 220 }) => ({ face, blendshapes: shapes(over), pose });
const STATS = { sharpness: 0.65, exposure: 0.5 };

function candidate(at, over, pose, { hands = null, stats = STATS, speaking = false } = {}) {
  const a = analysis(over, pose);
  if (hands) a.hands = hands;
  const signals = faceSignals(a, stats, 540);
  const extras = faceExtras(a);
  const handInfo = handFeatures(a, 960, 540);
  return { atSeconds: at, signals, extras, hands: handInfo, tags: faceTags(signals, extras, { speaking, pointing: handInfo.pointing }), ...scoreFace({ signals, extras, facePixels: 420, hands: handInfo }) };
}

test("signals are the schema's names in the schema's ranges, and what is unknown is left out", () => {
  const s = faceSignals(analysis({ mouthSmileLeft: 0.8, mouthSmileRight: 0.6, jawOpen: 0.3, browInnerUp: 0.5 }, { yaw: -12.4, pitch: 3.6 }), STATS, 540);
  assert.deepEqual(s, { eyesOpen: 0.9, smile: 0.7, mouthOpen: 0.3, browRaise: 0.5, yaw: -12, pitch: 4, sharpness: 0.65, exposure: 0.5, faceHeight: 0.41 });
  assert.deepEqual(faceSignals(null, STATS, 540), { sharpness: 0.65, exposure: 0.5 }, "no face: no face signals, not zeros");
  assert.deepEqual(faceSignals({ face: null }, {}, 540), {});
});

test("tags come from the fixed vocabulary, the main reading first", () => {
  const tag = (over, opts) => faceTags(faceSignals(analysis(over), STATS, 540), faceExtras(analysis(over)), opts);
  assert.deepEqual(tag({ mouthSmileLeft: 0.7, mouthSmileRight: 0.7, jawOpen: 0.35 }), ["laugh"]);
  assert.deepEqual(tag({ mouthSmileLeft: 0.5, mouthSmileRight: 0.5 }, { speaking: true }), ["smile", "speaking"]);
  assert.deepEqual(tag({ browInnerUp: 0.6, jawOpen: 0.3 }), ["surprise"]);
  assert.deepEqual(tag({ browDownLeft: 0.5, browDownRight: 0.5 }), ["intense"]);
  assert.deepEqual(tag({ jawOpen: 0.2 }, { speaking: true }), ["speaking"]);
  assert.deepEqual(tag({}), ["neutral"]);
  assert.deepEqual(tag({ mouthSmileLeft: 0.5, mouthSmileRight: 0.5 }, { pointing: true }), ["pointing", "smile"]);
  assert.deepEqual(faceTags({ sharpness: 0.5 }), [], "no face reading, no tags");
  for (const over of [{}, { jawOpen: 0.5 }, { browInnerUp: 0.9 }]) for (const t of tag(over, { speaking: true, pointing: true })) assert.ok(FACE_TAGS.includes(t));
});

// 21 hand points (normalised): the wrist low, the index finger straight up, the rest folded.
function pointingHand(tipX, tipY) {
  const p = Array.from({ length: 21 }, () => [0.5, 0.9]);
  p[0] = [0.5, 0.95];
  p[5] = [0.5, 0.85]; p[6] = [0.5, 0.8]; p[7] = [tipX, (0.8 + tipY) / 2]; p[8] = [tipX, tipY];
  for (const [mcp, pip, tip] of [[9, 10, 12], [13, 14, 16], [17, 18, 20]]) { p[mcp] = [0.52, 0.86]; p[pip] = [0.54, 0.84]; p[tip] = [0.52, 0.9]; }
  p[4] = [0.47, 0.9];
  return p;
}

test("a finger pointing clear of the face is pointing; a finger on the nose is a hand over the face", () => {
  const face = { x: 400, y: 100, w: 160, h: 200 };
  const clear = handFeatures({ face, hands: [pointingHand(0.2, 0.7)] }, 960, 540);
  assert.deepEqual(clear, { handOverFace: false, pointing: true, raised: false });
  // The same hand with its fingertip at the middle of the face.
  const onNose = handFeatures({ face, hands: [pointingHand(480 / 960, 230 / 540)] }, 960, 540);
  assert.equal(onNose.pointing, false);
  assert.equal(onNose.handOverFace, true);
  assert.deepEqual(handFeatures({ face, hands: [] }, 960, 540), { handOverFace: false, pointing: false, raised: false });
  // A hand up at the face's height, clear of it (hands on the head, a wave): raised.
  const up = handFeatures({ face, hands: [pointingHand(0.2, 0.25)] }, 960, 540);
  assert.equal(up.raised, true);
});

test("a frame that fails outright is refused with its reason", () => {
  assert.equal(candidate(1, { eyeBlinkLeft: 0.8, eyeBlinkRight: 0.7 }).refused, "eyes closing");
  assert.equal(candidate(1, {}, { yaw: 50, pitch: 0 }).refused, "face turned away");
  assert.equal(candidate(1, {}, { yaw: 0, pitch: -40 }).refused, "head tipped too far");
  assert.equal(candidate(1, {}, undefined, { stats: { sharpness: 0.1, exposure: 0.5 } }).refused, "blurred");
  assert.equal(scoreFace({ signals: { sharpness: 0.6 } }).refused, "no face");
});

test("eye contact multiplies: the film's best laugh looking away loses to a good smile down the lens", () => {
  const away = candidate(10, { mouthSmileLeft: 0.95, mouthSmileRight: 0.95, jawOpen: 0.4 }, { yaw: 33, pitch: -10 });
  const lens = candidate(20, { mouthSmileLeft: 0.6, mouthSmileRight: 0.6, jawOpen: 0.1 }, { yaw: 2, pitch: -4 });
  assert.ok(lens.score > away.score, `${lens.score} vs ${away.score}`);
  const plain = candidate(30, {}, { yaw: 0, pitch: -4 });
  assert.ok(lens.score > plain.score, "an expression beats a blank face at the same contact");
  // The stub face is x 300–480, y 80–300 in a 960×540 frame: a fingertip at its middle.
  const covered = candidate(40, { mouthSmileLeft: 0.6, mouthSmileRight: 0.6, jawOpen: 0.1 }, { yaw: 2, pitch: -4 }, { hands: [pointingHand(390 / 960, 200 / 540)] });
  assert.ok(covered.score < lens.score * 0.7, "a hand over the face costs a third");
  for (const c of [away, lens, plain, covered]) assert.ok(c.score >= 0 && c.score <= 1);
});

test("without the analyser frames are scored by sharpness, light and resolution, claiming nothing about a face", () => {
  const big = scorePlain({ signals: { sharpness: 0.8, exposure: 0.5 }, frameHeight: 1430 });
  const corner = scorePlain({ signals: { sharpness: 0.8, exposure: 0.5 }, frameHeight: 602 });
  const soft = scorePlain({ signals: { sharpness: 0.45, exposure: 0.5 }, frameHeight: 1430 });
  assert.ok(big.score > corner.score && big.score > soft.score);
  assert.ok(big.score <= 1);
});

// ---- Choosing ----

test("frames that look alike are eight seconds apart, best first, and spread over the tags", () => {
  const smiles = [10, 12, 14, 30, 50, 70, 90].map((at, i) => ({ atSeconds: at, score: 0.9 - i * 0.01, tags: ["smile"] }));
  const surprise = { atSeconds: 110, score: 0.72, tags: ["surprise"] };
  const weak = { atSeconds: 130, score: 0.3, tags: ["intense"] };
  const picks = selectFaces([...smiles, surprise, weak], { limit: 4 });
  const times = picks.map((p) => p.atSeconds).sort((a, b) => a - b);
  for (let i = 1; i < times.length; i += 1) assert.ok(times[i] - times[i - 1] >= MIN_FACE_GAP_SECONDS, "every pick here is a smile: the full gap"); 
  assert.ok(picks.includes(surprise), "the one surprised look gets in over the fourth smile");
  assert.ok(!picks.includes(weak), "a frame under 60% of the best is not worth a slot");
  assert.deepEqual(picks.map((p) => p.score), [...picks.map((p) => p.score)].sort((a, b) => b - a), "best first");
  assert.equal(selectFaces([]).length, 0);
  assert.ok(selectFaces(Array.from({ length: 40 }, (_, i) => ({ atSeconds: i * 10, score: 0.8, tags: ["smile"] }))).length <= 12);
});

// Readings for look-alike tests: a smile at the lens, and the same smile a moment later.
const SMILE = { smile: 0.7, mouthOpen: 0.1, browRaise: 0.5, yaw: 4, pitch: -6 };
const face = (at, score, tags, signals = SMILE, hands = {}) => ({ atSeconds: at, score, tags, signals, hands: { pointing: false, raised: false, handOverFace: false, ...hands } });

test("a frame that is clearly different may sit two seconds from a pick; the best frame is not thrown away", () => {
  const hello = face(1.5, 0.81, ["smile"]);
  const fingerGuns = face(5.1, 0.76, ["pointing", "smile"], { ...SMILE, browRaise: 0.55, yaw: 13 }, { pointing: true, raised: true });
  const sameSmile = face(4.0, 0.78, ["smile"], { ...SMILE, smile: 0.75 });
  const flicker = face(6.0, 0.77, ["laugh"], { ...SMILE, smile: 0.72, mouthOpen: 0.22 });
  const tooClose = face(6.5, 0.75, ["surprise"], { smile: 0, mouthOpen: 0.4, browRaise: 0.8, yaw: 0, pitch: 0 });
  const picks = selectFaces([hello, fingerGuns, sameSmile, flicker, tooClose]);
  assert.ok(picks.includes(hello) && picks.includes(fingerGuns), "the finger guns 3.6 s after the hello both go in");
  assert.ok(!picks.includes(sameSmile), "the same smile 2.5 s later is a second take");
  assert.ok(!picks.includes(flicker), "a smile the tags call a laugh, reading the same, is still the same look");
  assert.ok(!picks.includes(tooClose), "nothing closer than two seconds, however different");
  const times = picks.map((p) => p.atSeconds).sort((a, b) => a - b);
  for (let i = 1; i < times.length; i += 1) assert.ok(times[i] - times[i - 1] >= MIN_DISTINCT_GAP_SECONDS);
});

test("looking alike: the same gesture and the same reading; another gesture never is", () => {
  assert.ok(looksAlike(face(0, 1, ["smile"]), face(0, 1, ["smile"], { ...SMILE, smile: 0.2 })), "the same main tag");
  assert.ok(looksAlike(face(0, 1, ["smile"]), face(0, 1, ["laugh"], { ...SMILE, mouthOpen: 0.3 })), "a flicker between neighbouring tags");
  assert.ok(!looksAlike(face(0, 1, ["smile"]), face(0, 1, ["surprise"], { smile: 0.05, mouthOpen: 0.4, browRaise: 0.9, yaw: 0, pitch: 0 })), "another tag that reads differently");
  assert.ok(!looksAlike(face(0, 1, ["smile"]), face(0, 1, ["smile"], SMILE, { raised: true })), "hands up beside hands down");
  assert.ok(looksAlike(face(0, 1, ["smile"]), face(0, 1, ["smile"], { ...SMILE, yaw: 30 })), "a tag match holds whatever the head does");
  // Without the analyser nothing can be told apart: the plain eight seconds.
  assert.ok(looksAlike({ atSeconds: 0, tags: [], signals: { sharpness: 0.7 } }, { atSeconds: 3, tags: [], signals: { sharpness: 0.6 } }));
  const plain = selectFaces([{ atSeconds: 1, score: 0.9, tags: [], signals: {} }, { atSeconds: 4, score: 0.88, tags: [], signals: {} }]);
  assert.equal(plain.length, 1);
});

test("the fine look goes where the coarse look was promising, a blink in a good moment included", () => {
  const coarse = [
    { raw: 5, potential: 0.9 }, { raw: 6, potential: 0.85 }, { raw: 20, potential: 0.7 }, { raw: 40, potential: null }, { raw: 60, potential: 0.4 },
  ];
  assert.deepEqual(fineCentres(coarse, { count: 3, spacing: 3 }).map((c) => c.raw), [5, 20, 60]);
});

test("screens: the same page scrolled, or the same picture, is one screen; the ones the film shows rank first", () => {
  const page = histogramOf(new Uint8Array(400).fill(40));
  const other = histogramOf(new Uint8Array(400).fill(200));
  const a = { atSeconds: 10, score: 0.9, hash: "ffff0000ffff0000", histogram: page };
  const scrolled = { atSeconds: 60, score: 0.8, hash: "0000ffff0000ffff", histogram: page };
  const same = { atSeconds: 90, score: 0.85, hash: "ffff0000ffff0001", histogram: other };
  const b = { atSeconds: 120, score: 0.5, hash: "00ff00ff00ff00ff", histogram: other };
  assert.ok(sameScreen(a, scrolled) && sameScreen(a, same) && !sameScreen(a, b));
  assert.deepEqual(selectScreens([a, scrolled, same, b]).map((s) => s.atSeconds), [10, 120]);
});

// ---- Pictures ----

test("pictures are the ones the scenes show: cards first, then names, then names a template builds", () => {
  const names = ["poster.png", "logo.png", "sprite-knight.png", "sprite-wizard.png", "unused.png", "strip.png", "tiny.png", "trailer.mp4"];
  assert.deepEqual(pictureRefs("sam.sprite(el, `sprite-${id}.png`); img.src = 'logo.png'", names), [
    { name: "logo.png", how: "named" }, { name: "sprite-knight.png", how: "pattern" }, { name: "sprite-wizard.png", how: "pattern" },
  ]);
  const assets = [
    { name: "poster.png", width: 600, height: 800 }, { name: "logo.png", width: 1000, height: 560 },
    { name: "sprite-knight.png", width: 256, height: 256 }, { name: "sprite-wizard.png", width: 256, height: 256 },
    { name: "unused.png", width: 500, height: 500 }, { name: "strip.png", width: 896, height: 128 }, { name: "tiny.png", width: 32, height: 32 },
  ];
  const scenes = [
    { start: 40, graphic: { kind: "motion", src: "motion/a.html" } },
    { start: 12, graphic: { kind: "image", src: "assets/poster.png" } },
    { start: 5, graphic: { kind: "custom", html: "<img src='assets/strip.png'><img src='assets/tiny.png'>" } },
    { start: 2, graphic: { kind: "clip", src: "assets/trailer.mp4" } },
  ];
  const text = (scene) => (scene.graphic.kind === "motion" ? "sprite-${n}.png and logo.png" : scene.graphic.html ?? "");
  const shown = picturesShown(scenes, assets, text);
  assert.deepEqual(shown.map((p) => [p.name, p.how, p.atSeconds]), [
    ["poster.png", "card", 12], ["logo.png", "named", 40], ["sprite-knight.png", "pattern", 40], ["sprite-wizard.png", "pattern", 40],
  ], "a strip, a speck, a clip and a picture nothing shows are left out");
  assert.equal(picturesShown(scenes, assets, text, { limit: 2 }).length, 2);
});

test("a picture's credit and licence come from its .source.json, or are null", () => {
  assert.deepEqual(pictureCredit({ author: "Bonehead Labs", license: "CC BY 4.0", source: "file:/tmp/x.png" }), { credit: "Bonehead Labs", license: "CC BY 4.0" });
  assert.deepEqual(pictureCredit({ note: "a still" }), { credit: null, license: null });
  assert.deepEqual(pictureCredit(null), { credit: null, license: null });
});

// ---- Story ----

const WORDS = [
  "Hey,", "guys.", "It's", "$30.", "I", "sold", "nine", "units", "and", "most", "of", "those", "people", "I", "know.",
  "Why", "would", "anyone", "make", "a", "game", "alone?", "Nobody", "tells", "you", "the", "truth", "about", "launch", "week.",
  "We", "are", "talking", "next", "to", "11", "months", "of", "actual...",
].map((text, i) => word(i, text, i * 0.5, i * 0.5 + 0.4));

test("hooks are the speaker's own sentences, one per kind in turn, the short complete ones first", () => {
  const hooks = kitHooks(WORDS);
  assert.ok(hooks.length > 0 && hooks.length <= 6);
  for (const hook of hooks) {
    assert.ok(["promise", "claim", "number", "question", "quote"].includes(hook.kind));
    assert.ok(WORDS.map((w) => w.text).join(" ").includes(hook.text.replace(/[.!?]$/, "")), `${hook.text} is not the speaker's`);
  }
  // read_story reads the question in the first twenty seconds as the opening's promise.
  assert.deepEqual(hooks[0], { text: "Why would anyone make a game alone?", atSeconds: 7.5, kind: "promise" });
  assert.deepEqual(hooks.find((h) => h.kind === "number"), { text: "It's $30.", atSeconds: 1, kind: "number" }, "a two-word figure is a thumbnail's length");
  assert.equal(hooks.filter((h) => h.text === "Why would anyone make a game alone?").length, 1, "one sentence is one hook");
  assert.ok(hooks.some((h) => h.kind === "claim"));
  assert.ok(!hooks.some((h) => h.text.endsWith("...")), "a sentence trailing off is not a hook");
  assert.deepEqual(kitHooks([]), []);
});

test("a long sentence is cut to a clause, the figure's clause for a number, never rewritten", () => {
  assert.equal(hookText("There you go, Apple Man Sam for the low, low price of $5.75, which will probably reduce it a bit further, actually, but still a fairly good deal", { figure: "$5.75" }), "Apple Man Sam for the low, low price of $5.75");
  assert.equal(hookText("10 to 11 months of actual..."), null);
  assert.equal(hookText("Short and sweet."), "Short and sweet.");
});

test("words around a moment are the transcript's, and speaking is a word at that instant", () => {
  assert.equal(wordsAround(WORDS, 1.2, 0.6), "guys. It's $30.");
  assert.equal(speakingAt(WORDS, 1.2), true);
  assert.equal(speakingAt(WORDS, 1.45), false);
});

test("style is the theme's colours as upper-case hex and its two faces", () => {
  assert.deepEqual(kitStyle({ accent: "#e8413c", accent2: "#43D35B", text: "#F4F0E6", field: ["#1a2129", "#000000"], fonts: { display: "Archivo", body: "Inter", serif: "x" } }), {
    colours: [{ role: "accent", hex: "#E8413C" }, { role: "accent2", hex: "#43D35B" }, { role: "text", hex: "#F4F0E6" }, { role: "background", hex: "#1A2129" }],
    fonts: { display: "Archivo", body: "Inter" },
  });
  assert.deepEqual(kitStyle({ accent: "red" }), { colours: [], fonts: {} });
});

// ---- The kit's own check ----

function goodKit() {
  return {
    kind: KIT_KIND, schemaVersion: KIT_SCHEMA_VERSION, producer: { app: "fabula", version: "0.3.2" }, createdAt: "2026-10-13T12:00:00.000Z",
    source: { project: "p", title: "P", format: "landscape", durationSeconds: 120 },
    story: { hooks: [{ text: "It's $30.", atSeconds: 12, kind: "number" }], chapters: [{ title: "Intro", atSeconds: 0 }] },
    style: { colours: [{ role: "accent", hex: "#E8413C" }], fonts: { display: "Archivo" } },
    frames: [
      { file: "frames/f01.jpg", kind: "face", atSeconds: 10, width: 2544, height: 1430, face: { x: 900, y: 200, w: 400, h: 500 }, score: 0.8, signals: { eyesOpen: 0.9, yaw: -4 }, tags: ["smile"], words: "hi" },
      { file: "frames/f02.jpg", kind: "face", atSeconds: 18, width: 1072, height: 602, score: 0.7, signals: {}, tags: [], words: "" },
      { file: "frames/s01.jpg", kind: "screen", atSeconds: 40, width: 1620, height: 1236, words: "" },
    ],
    pictures: [{ file: "pictures/poster.png", width: 600, height: 800, credit: "Bonehead Labs", license: null, atSeconds: 12 }],
  };
}

test("the kit's own check accepts a good kit and refuses what a reader would refuse", () => {
  assert.doesNotThrow(() => validateKit(goodKit()));
  const broken = (mutate, why) => { const kit = goodKit(); mutate(kit); assert.throws(() => validateKit(kit), why); };
  broken((k) => { k.kind = "something.else"; }, /kind/);
  broken((k) => { k.schemaVersion = 2; }, /schemaVersion/);
  broken((k) => { k.frames[0].file = "frames/../kit.json"; }, /safe file/);
  broken((k) => { k.frames[0].file = "/etc/passwd"; }, /safe file/);
  broken((k) => { k.frames[0].file = "frames/sub/f01.jpg"; }, /safe file/);
  broken((k) => { k.pictures[0].file = "pictures/.hidden.png"; }, /safe file/);
  broken((k) => { k.pictures[0].file = "pictures/poster.gif"; }, /PNG, JPEG or WebP/);
  broken((k) => { k.frames[1].atSeconds = 11.5; }, /under 2s/);
  assert.doesNotThrow(() => { const k = goodKit(); k.frames[1].atSeconds = 13; validateKit(k); }, "two different frames three seconds apart are fine");
  broken((k) => { k.frames[0].tags = ["happy"]; }, /tags come from/);
  broken((k) => { k.frames[0].signals = { smile: 1.4 }; }, /0\.\.1/);
  broken((k) => { k.frames[0].signals = { mood: 0.5 }; }, /unknown signal/);
  broken((k) => { k.frames[0].face = { x: 2400, y: 0, w: 400, h: 100 }; }, /face box/);
  broken((k) => { k.frames[2].atSeconds = 500; }, /outside the film/);
  broken((k) => { k.story.hooks[0].kind = "joke"; }, /hook kind/);
  broken((k) => { k.story.hooks = Array.from({ length: 7 }, (_, i) => ({ text: "x", atSeconds: i, kind: "claim" })); }, /at most 6 hooks/);
  broken((k) => { k.frames = Array.from({ length: 13 }, (_, i) => ({ file: `frames/f${i}.jpg`, kind: "face", atSeconds: i * 9, width: 100, height: 100, score: 0.5, signals: {}, tags: [] })); k.source.durationSeconds = 200; }, /at most 12 face/);
  broken((k) => { k.source.format = "portrait"; }, /landscape, vertical or square/);
  assert.throws(() => validateKit(goodKit(), { fileSize: (file) => (file === "frames/f02.jpg" ? 0 : 100) }), /f02\.jpg is missing or empty/);
  assert.ok(safeLeaf("boss-billy.png") && !safeLeaf("..") && !safeLeaf("a/b.png") && !safeLeaf(".env"));
});

// ---- Writing it ----

// A motion film: no recording and no faces, so the kit is the story, the look and the pictures,
// and the whole write path runs without a video, ffmpeg or a model.
function motionProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabula-kit-"));
  const dir = path.join(root, "orbit");
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "motion"), { recursive: true });
  const words = WORDS;
  const segments = [{ start: 0, end: 20, words: words.map((w) => ({ word: w.text, start: w.start, end: w.end })) }];
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ title: "An Orbit", format: "vertical", kind: "motion" }));
  fs.writeFileSync(path.join(dir, "clean.json"), JSON.stringify({ segments, fabula: { cutIdentity: "abc" } }));
  fs.writeFileSync(path.join(dir, "out", "clean-map.json"), JSON.stringify({ cutIdentity: "abc", pieces: [{ start: 0, end: 20, cleanStart: 0, cleanEnd: 20, head: { x: 0, y: 0, w: 360, h: 640 }, screen: null }] }));
  fs.writeFileSync(path.join(dir, "treatment.json"), JSON.stringify({ logline: "An orbit is a fall that keeps missing.", purpose: "For the curious", look: "Ink on paper" }));
  fs.writeFileSync(path.join(dir, "compose.json"), JSON.stringify({
    theme: { preset: "studio", accent: "#E8413C" },
    scenes: [
      { type: "graphic", fromWordId: 2, toWordId: 6, graphic: { kind: "image", src: "assets/poster.png" } },
      { type: "graphic", fromWordId: 15, toWordId: 20, graphic: { kind: "motion", src: "motion/fall.html" } },
    ],
  }));
  fs.writeFileSync(path.join(dir, "motion", "fall.html"), "<script>draw('assets/moon.webp')</script>");
  const png = Buffer.alloc(64); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png); png.writeUInt32BE(600, 16); png.writeUInt32BE(800, 20);
  fs.writeFileSync(path.join(dir, "assets", "poster.png"), png);
  fs.writeFileSync(path.join(dir, "assets", "poster.png.source.json"), JSON.stringify({ author: "NASA", license: "Public domain", source: "file:/home/me/scratch/poster.png", pageUrl: "https://example.org/poster" }));
  const webp = Buffer.alloc(40); webp.write("RIFF", 0, "ascii"); webp.write("WEBP", 8, "ascii"); webp.write("VP8X", 12, "ascii"); webp.writeUIntLE(511, 24, 3); webp.writeUIntLE(511, 27, 3);
  fs.writeFileSync(path.join(dir, "assets", "moon.webp"), webp);
  fs.writeFileSync(path.join(dir, "assets", "unused.png"), png);
  return { root, dir };
}

test("the kit is written whole beside the film, replacing the last one, and reads back", async () => {
  const { root, dir } = motionProject();
  try {
    const old = path.join(dir, "out", "thumbnail-kit");
    fs.mkdirSync(path.join(old, "frames"), { recursive: true });
    fs.writeFileSync(path.join(old, "frames", "f01.jpg"), "an old frame");
    const made = await makeThumbnailKit(dir, { analyser: { ready: false, hint: "set it up" } });
    const kit = JSON.parse(fs.readFileSync(path.join(old, "kit.json"), "utf8"));
    assert.equal(kit.kind, KIT_KIND);
    assert.equal(kit.schemaVersion, KIT_SCHEMA_VERSION);
    assert.deepEqual(kit.source, { project: "orbit", title: "An Orbit", format: "vertical", durationSeconds: 20 });
    assert.equal(kit.story.logline, "An orbit is a fall that keeps missing.");
    assert.ok(kit.story.hooks.length > 0 && kit.story.chapters[0].atSeconds === 0);
    assert.equal(kit.style.colours[0].hex, "#E8413C");
    assert.deepEqual(kit.frames, [], "a motion film has no faces or screens to take");
    assert.deepEqual(kit.pictures.map((p) => [p.file, p.width, p.height, p.credit, p.license, p.atSeconds]), [
      ["pictures/poster.png", 600, 800, "NASA", "Public domain", 1], ["pictures/moon.webp", 512, 512, null, null, 7.5],
    ]);
    // The credit travels; the path on this machine does not.
    const credit = JSON.parse(fs.readFileSync(path.join(old, "pictures", "poster.png.source.json"), "utf8"));
    assert.deepEqual(credit, { author: "NASA", license: "Public domain", pageUrl: "https://example.org/poster" });
    assert.ok(!fs.existsSync(path.join(old, "pictures", "moon.webp.source.json")), "no credit, no credit file");
    assert.ok(!fs.existsSync(path.join(old, "frames", "f01.jpg")), "the old kit is gone, not merged");
    assert.deepEqual(fs.readdirSync(path.join(dir, "out")).sort(), ["clean-map.json", REPORT_FILE, "thumbnail-kit"].sort(), "no temporary folders left behind");
    validateKit(kit, { fileSize: (rel) => fs.statSync(path.join(old, rel)).size });
    assert.equal(made.report.faceAnalysis.used, false);
    const read = readThumbnailKit(dir);
    assert.equal(read.createdAt, kit.createdAt);
    assert.deepEqual(read.counts, { faces: 0, screens: 0, pictures: 2, hooks: kit.story.hooks.length, chapters: kit.story.chapters.length });
    assert.match(read.faceAnalysis.reason, /motion film/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a kit is refused from a clean transcript that does not describe the clean cut", async () => {
  const { root, dir } = motionProject();
  try {
    fs.writeFileSync(path.join(dir, "out", "clean-map.json"), JSON.stringify({ cutIdentity: "other", pieces: [{ start: 0, end: 20, cleanStart: 0, cleanEnd: 20, head: { x: 0, y: 0, w: 360, h: 640 } }] }));
    await assert.rejects(makeThumbnailKit(dir, { analyser: { ready: false } }), /does not describe the clean cut/);
    fs.rmSync(path.join(dir, "out", "clean-map.json"));
    await assert.rejects(makeThumbnailKit(dir, { analyser: { ready: false } }), /no clean cut yet/);
    assert.ok(!fs.existsSync(path.join(dir, "out", "thumbnail-kit")), "nothing written");
    assert.equal(readThumbnailKit(dir), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the kit is a background job like the renders, and the assistant can read it back", async () => {
  const spec = jobSpec("kit", "/p/orbit");
  assert.equal(spec.stage, "thumbnail_kit");
  assert.deepEqual(spec.args.slice(1), ["thumbnail_kit", "/p/orbit"]);
  assert.ok(JOB_STAGES.includes("thumbnail_kit"));
  const { root, dir } = motionProject();
  fs.writeFileSync(path.join(root, "current-project.json"), JSON.stringify({ dir: "orbit" }));
  const client = new Client({ name: "fabula-kit-test", version: "1.0.0" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, "mcp/server.mjs")], env: { ...process.env, FABULA_PROJECTS_ROOT: root } }));
    const none = await client.callTool({ name: "thumbnail_kit", arguments: { read_only: true } });
    assert.ok(none.isError && /no thumbnail kit yet/.test(none.content[0].text));
    await makeThumbnailKit(dir, { analyser: { ready: false, hint: "set it up" } });
    const read = JSON.parse((await client.callTool({ name: "thumbnail_kit", arguments: { read_only: true } })).content[0].text);
    assert.equal(read.kit, path.join(dir, "out", "thumbnail-kit"));
    assert.equal(read.counts.pictures, 2);
    assert.ok(read.hooks.length > 0 && Array.isArray(read.frames));
  } finally {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
