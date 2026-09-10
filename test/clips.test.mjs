import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sentences, findClips, resolveClipSpan, clipWords, rawTimeOf, rawSpanOfClean, clipCutList } from "../core/clip-engine.mjs";
import { normalizeCuts, keepSegments } from "../core/cut-engine.mjs";
import { FORMATS } from "../core/formats.mjs";
import { createShort, suggestClips } from "../scripts/shorts.mjs";
import { readProjectMeta, projectFormat, describeProject } from "../scripts/project-state.mjs";

// A transcript is words with times. These are built from sentences at a
// conversational 2.6 words a second, with the pauses written in, so the
// engine is reading the same shape of data WhisperX gives it.
function transcriptOf(spec) {
  const segments = [];
  let t = 0;
  for (const { text, pauseAfter = 0.25 } of spec) {
    const words = [];
    for (const word of text.split(" ")) {
      const end = t + 0.38;
      words.push({ word, start: Number(t.toFixed(3)), end: Number(end.toFixed(3)) });
      t = end;
    }
    segments.push({ start: words[0].start, end: words.at(-1).end, words });
    t += pauseAfter;
  }
  return { segments };
}

const TALK = [
  { text: "Right so today I want to talk about a few things." },
  { text: "Here's the thing nobody tells you about rendering video on a laptop.", pauseAfter: 0.4 },
  { text: "The first render took sixteen minutes and the second took six." },
  { text: "That difference was one filter graph doing work nobody asked for." },
  { text: "Every frame was being converted twice because the scale came before the format." },
  { text: "Moving one line saved ten minutes on every single export.", pauseAfter: 1.2 },
  { text: "Anyway I also wanted to mention the thing about fonts.", pauseAfter: 0.3 },
  { text: "It was fine actually." },
  { text: "Most people think a vertical video is just a cropped horizontal one.", pauseAfter: 0.4 },
  { text: "It is not because the head has to fill the frame and the text has nowhere to go." },
  { text: "So you end up rewriting every title to be three words instead of nine." },
  { text: "That constraint makes the writing better which is the part nobody expects.", pauseAfter: 1.4 },
  { text: "Um and then we ran out of time.", pauseAfter: 0.9 },
  { text: "One more thing about captions before I forget it entirely.", pauseAfter: 0.4 },
  { text: "Something like eighty percent of these are watched with the sound off." },
  { text: "So a video without captions is a video most people never actually hear." },
  { text: "Burning them in costs nothing and doubles the number of people who finish.", pauseAfter: 1.3 },
  { text: "Right and the last thing is about how long any of this should be.", pauseAfter: 0.4 },
  { text: "Everyone says thirty seconds and everyone is wrong about why." },
  { text: "It is not that people cannot watch for longer than thirty seconds." },
  { text: "It is that almost nobody has ninety seconds of one idea to say.", pauseAfter: 1.1 },
  { text: "Okay that is genuinely everything thank you for sitting through it." },
];

const words = (await import("../core/cut-engine.mjs")).flattenWords(transcriptOf(TALK));

test("sentences end at a full stop or at a pause the speaker plainly took", () => {
  const said = sentences(words);
  assert.equal(said.length, TALK.length);
  assert.equal(said[0].text.startsWith("Right so today"), true);
  assert.ok(said.every((sentence) => sentence.terminal), "every line here ends in a full stop");
  assert.ok(said[5].gapAfter > 1, "the long pause after the render story is recorded");
  // Word ids are the anchor everywhere in Fabula; a sentence carries the pair.
  assert.equal(said[0].fromWordId, 0);
  assert.equal(said[1].fromWordId, said[0].toWordId + 1);
});

test("the clips it finds are whole thoughts, not slices of the talk", () => {
  const clips = findClips(words, { duration: FORMATS.vertical.duration, limit: 6 });
  assert.ok(clips.length >= 3, `expected a shortlist, got ${clips.length}`);
  for (const clip of clips) {
    assert.ok(clip.seconds >= FORMATS.vertical.duration.min && clip.seconds <= FORMATS.vertical.duration.max);
    assert.ok(clip.text.length > 0);
    assert.ok(Array.isArray(clip.notes));
    // It starts at a sentence and ends at one: never mid-clause.
    assert.ok(/[.!?]$/.test(clip.text.trim()), `“${clip.text.slice(-40)}” does not land`);
  }
  // The two real moments in that talk are the render story and the vertical
  // one. Both should be in a shortlist of six.
  const covered = (needle) => clips.some((clip) => clip.text.includes(needle));
  assert.ok(covered("sixteen minutes") || covered("filter graph"), "the render story is not on the shortlist");
  assert.ok(covered("vertical video") || covered("three words"), "the vertical story is not on the shortlist");
  assert.ok(covered("sound off") || covered("captions"), "the captions story is not on the shortlist");
});

test("the shortlist is different moments, not one moment framed six ways", () => {
  const clips = findClips(words, { duration: FORMATS.vertical.duration, limit: 8 });
  for (let i = 0; i < clips.length; i += 1) {
    for (let j = i + 1; j < clips.length; j += 1) {
      const shared = Math.min(clips[i].end, clips[j].end) - Math.max(clips[i].start, clips[j].start);
      const shorter = Math.min(clips[i].end - clips[i].start, clips[j].end - clips[j].start);
      assert.ok(shared <= 0 || shared / shorter <= 0.36, `clips ${i} and ${j} are the same moment`);
    }
  }
  assert.deepEqual(clips.map((clip) => clip.index), clips.map((_, i) => i), "returned in the order they are spoken");
});

test("a clip that opens on a dangling pronoun is marked down and says why", () => {
  const said = sentences(words);
  const dangling = said.findIndex((sentence) => sentence.text.startsWith("It is not because"));
  const clips = findClips(words, { duration: { min: 4, max: 40, ideal: 12 }, limit: 40 });
  const bad = clips.find((clip) => clip.fromWordId === said[dangling].fromWordId);
  if (bad) assert.ok(bad.notes.some((note) => note.includes("supply what it refers to")), bad.notes.join(" / "));
  // And the note is written for a person, not for a scoring function.
  const promising = clips.find((clip) => clip.notes.some((note) => note.startsWith("opens in a hook's shape")));
  assert.ok(promising, "the Here's-the-thing opening should be recognised");
});

test("a span someone chose is resolved by word id, and refuses what cannot be a film", () => {
  const span = resolveClipSpan(words, 10, 40, { duration: FORMATS.vertical.duration });
  assert.equal(span.fromWordId, 10);
  assert.equal(span.toWordId, 40);
  assert.ok(span.seconds > 0);
  assert.throws(() => resolveClipSpan(words, 40, 10), /ends before it starts/);
  assert.throws(() => resolveClipSpan(words, 0, 999999), /no word 999999/);
  assert.throws(() => resolveClipSpan(words, 0, 1), /not a film/);
  // Out of the format's range is a warning, not a refusal: the person may know.
  const long = resolveClipSpan(words, 0, words.length - 1, { duration: { min: 12, max: 20 } });
  assert.ok(long.warnings.some((note) => note.includes("over the 20s")));
});

test("a clip's words are renumbered from zero and re-timed to its own start", () => {
  const span = resolveClipSpan(words, 20, 45);
  const cut = clipWords(words, span);
  assert.equal(cut[0].id, 0);
  assert.equal(cut[0].start, 0);
  assert.equal(cut.at(-1).id, cut.length - 1);
  assert.equal(cut[0].sourceId, 20, "where it came from is kept");
  assert.equal(cut.length, 26);
});

// ---- Back to the recording ----

const pieces = [
  { start: 0, end: 10, cleanStart: 0, cleanEnd: 10 },
  { start: 15, end: 25, cleanStart: 10, cleanEnd: 20 },
];

test("a clean instant maps back to the recording, cuts and all", () => {
  assert.equal(rawTimeOf(pieces, 0), 0);
  assert.equal(rawTimeOf(pieces, 5), 5);
  assert.equal(rawTimeOf(pieces, 12), 17);
  assert.equal(rawTimeOf(pieces, 20), 25);
  assert.throws(() => rawTimeOf([], 1), /no clean map/);
  assert.deepEqual(rawSpanOfClean(pieces, 5, 12), { start: 5, end: 17 });
});

test("a short inherits the cut list and loses only what is outside it", () => {
  const cuts = normalizeCuts([{ start: 10, end: 15, enabled: true, sources: [{ start: 10, end: 15, reason: "pause", enabled: true }] }]);
  const raw = rawSpanOfClean(pieces, 5, 20);
  const list = clipCutList(cuts, raw, 30);
  assert.deepEqual(keepSegments(list, 30), [{ start: 5, end: 10 }, { start: 15, end: 25 }]);
  // The cut the person already made inside the clip is still made.
  assert.ok(list.some((cut) => cut.sources?.some((source) => source.reason === "pause")));
  assert.ok(list.some((cut) => cut.sources?.some((source) => source.reason === "outside-clip")));
  // A proposal the person turned OFF removed nothing from the film, so it
  // removes nothing from the short either — the short is cut from the cut they
  // approved, not from the raw pass.
  const kept = normalizeCuts([{ start: 10, end: 15, enabled: false, sources: [{ start: 10, end: 15, reason: "pause", enabled: false }] }]);
  const withKept = clipCutList(kept, raw, 30);
  assert.deepEqual(keepSegments(withKept, 30), [{ start: 5, end: 25 }]);
});

// ---- The whole thing, on disk ----

function stageFilm(root) {
  const dir = path.join(root, "the-talk");
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  fs.writeFileSync(path.join(dir, "source.json"), JSON.stringify({ path: "/mnt/c/rec/talk.mp4", container: ".mp4", bytes: 42 }));
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ title: "The Talk", format: "landscape" }));
  fs.writeFileSync(path.join(dir, "clean.json"), JSON.stringify(transcriptOf(TALK)));
  fs.writeFileSync(path.join(dir, "framing.json"), JSON.stringify({ segments: [{ start: 0, end: 60, head: { x: 0, y: 0, w: 1920, h: 1080 } }] }));
  fs.writeFileSync(path.join(dir, "compose.json"), JSON.stringify({
    theme: { preset: "broadcast", accent: "#e63946" },
    punch: { zoom: 1.12 },
    captions: "closed",
    scenes: [{ type: "title", fromWordId: 0, toWordId: 6, text: "A wide title" }],
  }));
  const duration = words.at(-1).end + 5;
  fs.writeFileSync(path.join(dir, "review.json"), JSON.stringify({
    duration,
    words: words.map((word) => ({ ...word })),
    cuts: normalizeCuts([{ start: 2, end: 2.4, enabled: false, sources: [{ start: 2, end: 2.4, reason: "filler", enabled: false }] }]),
  }));
  fs.writeFileSync(path.join(dir, "out", "clean-map.json"), JSON.stringify({
    identity: "x", cutIdentity: "y",
    pieces: [{ keepIndex: 0, start: 0, end: duration, cleanStart: 0, cleanEnd: duration }],
  }));
  return dir;
}

test("a short is its own project on the same recording, with the cut inherited and the visuals left to write", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabula-shorts-"));
  try {
    const film = stageFilm(root);
    const clips = findClips(words, { duration: FORMATS.vertical.duration, limit: 4 });
    const clip = clips[0];
    const short = createShort(film, { fromWordId: clip.fromWordId, toWordId: clip.toWordId, format: "vertical", root });

    assert.equal(short.format, "vertical");
    assert.equal(short.derivedFrom, "the-talk");
    assert.ok(short.title.startsWith("The Talk — "), short.title);
    const dir = path.join(root, short.project);

    // The same recording, referenced, never copied.
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "source.json"), "utf8")).path, "/mnt/c/rec/talk.mp4");
    assert.ok(fs.existsSync(path.join(dir, "framing.json")), "the camera is in the same place");

    // The cut list is the film's, with everything outside the clip removed.
    const review = JSON.parse(fs.readFileSync(path.join(dir, "review.json"), "utf8"));
    const keeps = keepSegments(review.cuts, review.duration);
    assert.equal(keeps.length, 1);
    assert.ok(Math.abs(keeps[0].start - short.rawSpan.start) < 0.01);
    assert.ok(Math.abs(keeps[0].end - short.rawSpan.end) < 0.01);
    assert.ok(review.cuts.every((cut) => cut.enabled), "everything the short does not show is actually cut");
    assert.ok(review.cuts.some((cut) => cut.sources?.some((s) => s.reason === "outside-clip")), "and it says which part is outside the clip");
    assert.ok(!review.cuts.some((cut) => cut.sources?.some((s) => s.reason === "filler" && s.start >= short.rawSpan.start && s.end <= short.rawSpan.end)),
      "a proposal the person kept in the film is still kept in the short");

    // The look travels; the composition does not.
    const compose = JSON.parse(fs.readFileSync(path.join(dir, "compose.json"), "utf8"));
    assert.deepEqual(compose.theme, { preset: "broadcast", accent: "#e63946" });
    assert.deepEqual(compose.scenes, [], "a wide film's scenes are the wrong scenes for a tall one");
    assert.equal(compose.captions, "open", "a short is watched without sound");
    assert.equal(compose.audio?.voice?.loudness, -14, "and its voice is set where a feed plays it");

    // And it is a project like any other, with where it came from recorded.
    assert.equal(projectFormat(dir), "vertical");
    const meta = readProjectMeta(dir);
    assert.equal(meta.derivedFrom, "the-talk");
    assert.equal(meta.sourceSpan.fromWordId, clip.fromWordId);
    const described = describeProject(dir, { videoPresent: () => false });
    assert.equal(described.format, "vertical");
    assert.equal(described.derivedFrom, "the-talk");
    assert.equal(described.stage, "cut", "staged with a cut list and nothing rendered yet");

    // A second short with the same name takes the next folder rather than
    // opening the first.
    const again = createShort(film, { fromWordId: clip.fromWordId, toWordId: clip.toWordId, title: short.title, format: "vertical", root });
    assert.notEqual(again.project, short.project);

    const suggested = suggestClips(film, { format: "vertical", limit: 3 });
    assert.equal(suggested.format, "vertical");
    assert.ok(suggested.clips.length <= 3 && suggested.clips.length > 0);
    assert.ok(suggested.filmSeconds > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a short cannot be cut from a film that has not been cut", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabula-shorts-"));
  try {
    const film = stageFilm(root);
    fs.rmSync(path.join(film, "out", "clean-map.json"));
    assert.throws(() => createShort(film, { fromWordId: 0, toWordId: 40, root }), /render the clean cut/);
    fs.rmSync(path.join(film, "clean.json"));
    assert.throws(() => createShort(film, { fromWordId: 0, toWordId: 40, root }), /no clean transcript/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
