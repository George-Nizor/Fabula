import test from "node:test";
import assert from "node:assert/strict";
import {
  critiqueFilm, shotRuns, pictureFill,
  SHOT_FLOOR_SECONDS, KEEP_FLOOR_SECONDS, PICTURE_FILL, QUIET_VOICE_LUFS,
} from "../core/critic-engine.mjs";

const LANDSCAPE = { id: "landscape", shortForm: false, stage: { width: 1920, height: 1080 } };
const VERTICAL = { id: "vertical", shortForm: true, stage: { width: 1080, height: 1920 } };

// A film with nothing wrong with it, to subtract from.
const clean = () => ({
  format: LANDSCAPE,
  seconds: 30,
  words: [{ id: 0, start: 0.2, end: 4 }, { id: 1, start: 4.4, end: 29.4 }],
  keeps: [{ start: 0, end: 12 }, { start: 12, end: 30 }],
  punchSpans: [{ start: 0, end: 12, scale: 1 }, { start: 12, end: 30, scale: 1.12 }],
  cuts: [{ start: 40, end: 43 }],
  scenes: [],
  plan: { warnings: [], variety: [], pacing: [] },
  audio: { target: -16, measured: -44.6, rendered: -16.1, truePeak: -1.6 },
  output: { exists: true, width: 1920, height: 1080, seconds: 30, stale: [] },
  assets: {},
});

const kinds = (result) => result.findings.map((f) => f.kind);

test("a film with nothing measurably wrong yields no faults and says so", () => {
  const result = critiqueFilm(clean());
  assert.deepEqual(result.counts, { fault: 0, risk: 0, note: 0 });
  assert.match(result.verdict, /needs eyes/);
});

test("the showcase film's own jump cuts: a sliver shot between two longer ones is a fault", () => {
  // The keeps that made "Rockets, explained", and the framing the punch
  // engine gave them BEFORE it had a dwell floor: strict index parity. Keep 2
  // (1.80s) and keep 7 (2.52s) were the two the eye caught.
  const lengths = [15.13, 3.74, 1.80, 4.17, 6.33, 4.39, 11.93, 2.52, 5.78, 12.69, 20.52, 5.20, 8.28, 5.85];
  let at = 0;
  const keeps = lengths.map((seconds) => { const keep = { start: at, end: at + seconds }; at += seconds; return keep; });
  const parity = keeps.map((keep, i) => ({ ...keep, scale: i % 2 === 0 ? 1 : 1.12 }));

  const before = critiqueFilm({ ...clean(), seconds: at, keeps, punchSpans: parity, words: [{ id: 0, start: 0.2, end: at - 0.3 }] });
  const slivers = before.findings.filter((f) => f.kind === "shot-sliver");
  assert.equal(slivers.length, 2, "both short shots are found");
  assert.deepEqual(slivers.map((f) => f.seconds), [1.8, 2.52]);
  assert.ok(slivers.every((f) => f.severity === "fault"));
  assert.ok(slivers[0].fix.includes("plan_shots"), "the finding says what to do");

  // With the dwell floor the same keeps produce no sliver: the shots merge.
  const held = [1, 1.12, 1.12, 1, 1.12, 1, 1.12, 1.12, 1, 1.12, 1, 1.12, 1, 1.12];
  const after = critiqueFilm({
    ...clean(), seconds: at, words: [{ id: 0, start: 0.2, end: at - 0.3 }],
    keeps, punchSpans: keeps.map((keep, i) => ({ ...keep, scale: held[i] })),
  });
  assert.equal(after.findings.filter((f) => f.kind === "shot-sliver").length, 0);
});

test("shotRuns merges neighbouring spans that share a framing", () => {
  const runs = shotRuns([
    { start: 0, end: 4, scale: 1 },
    { start: 4, end: 6, scale: 1.12 },
    { start: 6, end: 9, scale: 1.12 },
    { start: 9, end: 12, scale: 1 },
  ]);
  assert.deepEqual(runs.map((r) => [r.start, r.end, r.scale, r.seconds]), [
    [0, 4, 1, 4], [4, 9, 1.12, 5], [9, 12, 1, 3],
  ]);
});

test("a silent scrap between two cuts is a fault; the same scrap carrying a word is not", () => {
  const film = clean();
  // Nothing is spoken between 11 and 14, so the scrap at 12 is silence two
  // cuts failed to join across.
  film.words = [{ id: 0, start: 0.2, end: 11 }, { id: 1, start: 14, end: 29.4 }];
  film.keeps = [{ start: 0, end: 12 }, { start: 12, end: 12.3 }, { start: 12.3, end: 30 }];
  const sliver = critiqueFilm(film).findings.find((f) => f.kind === "keep-sliver");
  assert.ok(sliver && sliver.severity === "fault");
  assert.equal(sliver.seconds, 0.3);
  assert.ok(sliver.seconds < KEEP_FLOOR_SECONDS);
  assert.equal(sliver.keepIndex, 1);
  assert.match(sliver.what, /silence/);

  // The same scrap with a word in it is the speaker talking, however briefly.
  const speaking = { ...film, words: [{ id: 0, start: 0.2, end: 11 }, { id: 1, start: 12.05, end: 12.25 }, { id: 2, start: 14, end: 29.4 }] };
  assert.equal(critiqueFilm(speaking).findings.filter((f) => f.kind === "keep-sliver").length, 0,
    "a cut tightened around a word is what a cut is for");
});

test("a voice nothing is levelling is the loudest fault there is", () => {
  const film = clean();
  film.audio = { target: null, measured: -44.6, rendered: -44.7, truePeak: -21.3 };
  const result = critiqueFilm(film);
  const quiet = result.findings.find((f) => f.kind === "voice-not-levelled");
  assert.ok(quiet && quiet.severity === "fault");
  assert.match(quiet.what, /-44.6 LUFS/);
  assert.match(quiet.fix, /voice_loudness -16/);
  assert.ok(film.audio.measured < QUIET_VOICE_LUFS);
  // A short is levelled to -14, and says so.
  const short = critiqueFilm({ ...film, format: VERTICAL });
  assert.match(short.findings.find((f) => f.kind === "voice-not-levelled").fix, /voice_loudness -14/);
  // Once a target is set, the same quiet recording is no longer a fault.
  assert.equal(critiqueFilm({ ...film, audio: { ...film.audio, target: -16, rendered: -16.2 } })
    .findings.filter((f) => f.kind === "voice-not-levelled").length, 0);
});

test("a film that came out far off its target, or hot, is reported against what was asked", () => {
  const off = critiqueFilm({ ...clean(), audio: { target: -16, measured: -44.6, rendered: -11.2, truePeak: -0.2 } });
  assert.ok(off.findings.some((f) => f.kind === "voice-off-target" && f.severity === "fault"));
  assert.ok(off.findings.some((f) => f.kind === "peak-hot" && f.severity === "risk"));
  // Inside the slack, neither fires.
  const fine = critiqueFilm({ ...clean(), audio: { target: -16, measured: -44.6, rendered: -16.9, truePeak: -1.6 } });
  assert.equal(fine.findings.filter((f) => ["voice-off-target", "peak-hot"].includes(f.kind)).length, 0);
});

test("a picture is measured against the box it was given, and owning the stage raises the stakes", () => {
  assert.equal(pictureFill({ width: 2400, height: 3000 }, { width: 1920, height: 1080 }), 0.45);
  assert.equal(pictureFill({ width: 1920, height: 1080 }, { width: 1920, height: 1080 }), 1);
  assert.equal(pictureFill(null, { width: 1920, height: 1080 }), null);
  assert.ok(0.45 < PICTURE_FILL);

  const film = clean();
  film.scenes = [
    { start: 4, end: 9, layout: "cutaway", graphic: { kind: "image", src: "assets/tall.jpg" } },
    { start: 12, end: 17, layout: "side", graphic: { kind: "image", src: "assets/tall.jpg" } },
    { start: 20, end: 25, layout: "cutaway", graphic: { kind: "image", src: "assets/wide.jpg" } },
  ];
  film.assets = { "assets/tall.jpg": { width: 2400, height: 3000 }, "assets/wide.jpg": { width: 1920, height: 1080 } };
  const found = critiqueFilm(film).findings.filter((f) => f.kind === "picture-small");
  assert.equal(found.length, 2, "the wide picture fills its frame and is not reported");
  assert.equal(found.find((f) => f.at === 4).severity, "risk", "owning the stage and mostly empty");
  assert.equal(found.find((f) => f.at === 12).severity, "note", "beside the head it is only air in a column");
});

test("the render is checked against the shape and length it should have", () => {
  const wrong = critiqueFilm({ ...clean(), output: { exists: true, width: 960, height: 540, seconds: 30, stale: [] } });
  assert.ok(wrong.findings.some((f) => f.kind === "wrong-shape" && f.severity === "fault"));
  const shortRender = critiqueFilm({ ...clean(), output: { exists: true, width: 1920, height: 1080, seconds: 12, stale: [] } });
  assert.ok(shortRender.findings.some((f) => f.kind === "wrong-length"));
  const stale = critiqueFilm({ ...clean(), output: { exists: true, width: 1920, height: 1080, seconds: 30, stale: [{ artifact: "final.mp4", because: "the scenes changed", next: "render_final" }] } });
  const found = stale.findings.find((f) => f.kind === "stale");
  assert.equal(found.severity, "fault");
  assert.match(found.what, /final\.mp4/);
  assert.match(found.why, /the scenes changed/);
  const none = critiqueFilm({ ...clean(), output: { exists: false, stale: [] } });
  assert.ok(none.findings.some((f) => f.kind === "not-rendered" && f.severity === "note"));
});

test("the plan's own reads are folded in at the severity they deserve", () => {
  const film = clean();
  film.plan = {
    warnings: ["scene 3: a full layout of 2.7s is under the 3s dwell floor"],
    variety: ["4 full layouts in a row, 0:23–0:59"],
    pacing: ["Nothing changes from 9.6s to 18.4s"],
  };
  const result = critiqueFilm(film);
  assert.equal(result.counts.fault, 1, "a plan warning is a fault: the engine refuses to promise it renders");
  assert.equal(result.counts.risk, 2);
  assert.deepEqual(kinds(result).slice(0, 1), ["plan-warning"]);
});

test("findings come back worst first, and the verdict counts only what is broken", () => {
  const film = clean();
  film.keeps = [{ start: 0, end: 0.2 }, { start: 0.2, end: 30 }];   // a silent scrap: a fault
  film.audio = { target: -16, measured: -44.6, rendered: -16.1, truePeak: -0.5 }; // a risk
  film.words = [{ id: 0, start: 0.4, end: 4 }, { id: 1, start: 9, end: 29.4 }];   // a long pause: a note
  const result = critiqueFilm(film);
  assert.deepEqual(result.findings.map((f) => f.severity), ["fault", "risk", "note"]);
  assert.match(result.verdict, /^1 fault to fix/);
  assert.equal(critiqueFilm({ ...clean(), audio: { ...clean().audio, truePeak: -0.5 } }).verdict,
    "nothing broken; 1 thing worth arguing about");
});

test("silence at either end, and a cut that removes nothing", () => {
  const film = clean();
  film.words = [{ id: 0, start: 3.2, end: 4 }, { id: 1, start: 4.4, end: 21 }];
  film.cuts = [{ start: 40, end: 40.05 }];
  const result = critiqueFilm(film);
  assert.ok(result.findings.some((f) => f.kind === "head-air" && f.seconds === 3.2));
  assert.ok(result.findings.some((f) => f.kind === "tail-air" && f.seconds === 9));
  const pointless = result.findings.find((f) => f.kind === "pointless-cut");
  assert.match(pointless.what, /raw recording/, "the cut list is on the raw timeline and says so");
});

test("every finding carries what it is, why it reads badly, and the call that fixes it", () => {
  const film = clean();
  film.keeps = [{ start: 0, end: 0.2 }, { start: 0.2, end: 30 }];
  film.words = [{ id: 0, start: 1, end: 4 }, { id: 1, start: 4.4, end: 29.4 }];
  film.audio = { target: null, measured: -44.6, rendered: -44.7, truePeak: -21.3 };
  film.output = { exists: false, stale: [] };
  const result = critiqueFilm(film);
  assert.ok(result.findings.length >= 3);
  for (const f of result.findings) {
    for (const field of ["severity", "kind", "what", "why", "fix"]) {
      assert.ok(typeof f[field] === "string" && f[field].length > 0, `${f.kind} has no ${field}`);
    }
    assert.ok(["fault", "risk", "note"].includes(f.severity));
  }
  // No score out of a hundred: the verdict is a count of what is broken.
  assert.equal(result.score, undefined);
  assert.ok(SHOT_FLOOR_SECONDS >= 3);
});

test("a sound effect landing on a word is a risk, because effects are not ducked", () => {
  const film = clean();
  film.words = [{ id: 0, text: "orbit", start: 4, end: 5 }, { id: 1, text: "sideways", start: 9, end: 10 }];
  film.audio = { ...film.audio, music: null, swells: 3, effectsAt: [
    { src: "assets/whoosh.mp3", at: 4.5, seconds: 1 },   // mid-word
    { src: "assets/whoosh.mp3", at: 8.6, seconds: 1 },   // in the gap, where it belongs
  ] };
  const found = critiqueFilm(film).findings.filter((f) => f.kind === "effect-on-speech");
  assert.equal(found.length, 1);
  assert.equal(found[0].at, 4.5);
  assert.match(found[0].what, /"orbit"/);
  assert.equal(found[0].severity, "risk");
});

test("a bed with no pause to come up in is a note: the cut took its room away", () => {
  const film = clean();
  film.audio = { ...film.audio, music: { src: "assets/bed.mp3" }, swells: 0, effectsAt: [] };
  const found = critiqueFilm(film).findings.find((f) => f.kind === "bed-no-swell");
  assert.ok(found && found.severity === "note");
  assert.match(found.fix, /set_cut_enabled|drop the bed/);
  // With somewhere to breathe it says nothing.
  assert.equal(critiqueFilm({ ...film, audio: { ...film.audio, swells: 2 } })
    .findings.filter((f) => f.kind === "bed-no-swell").length, 0);
  // And with no bed at all there is nothing to say either.
  assert.equal(critiqueFilm({ ...film, audio: { ...film.audio, music: null, swells: 0 } })
    .findings.filter((f) => f.kind === "bed-no-swell").length, 0);
});
