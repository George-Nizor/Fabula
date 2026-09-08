import test from "node:test";
import assert from "node:assert/strict";
import { validateAudio, resolveAudio, swellWindows, bedGainExpression, audioGraph, describeAudio, bedSpans, spanPresenceExpression, bedGainDb, parseLoudness, MUSIC_DEFAULTS } from "../core/audio-engine.mjs";
import { evaluateExpression } from "../core/render-plan.mjs";

const words = [
  { id: 0, text: "one", start: 1.0, end: 1.4 },
  { id: 1, text: "two", start: 1.5, end: 1.9 },
  { id: 2, text: "three", start: 4.0, end: 4.5 }, // a 2.1 s pause before it
  { id: 3, text: "four", start: 4.6, end: 5.0 },
];

test("the audio block is validated: a bed under assets/, sane decibels, a loudness target", () => {
  validateAudio(undefined);
  validateAudio({ music: { src: "assets/bed.mp3" } });
  validateAudio({ music: { src: "assets/bed.wav", level: -20, duck: -14, ramp: 0.4, fade: 1, loop: false }, voice: { loudness: -14 } });
  assert.throws(() => validateAudio({ music: { src: "/tmp/bed.mp3" } }), /under assets/);
  assert.throws(() => validateAudio({ music: { src: "assets/bed.png" } }), /audio file/);
  assert.throws(() => validateAudio({ music: { src: "assets/bed.mp3", level: 3 } }), /level/);
  assert.throws(() => validateAudio({ music: { src: "assets/bed.mp3", duck: 1 } }), /duck/);
  assert.throws(() => validateAudio({ voice: { loudness: -3 } }), /loudness/);
  const resolved = resolveAudio({ music: { src: "assets/bed.mp3" } });
  assert.equal(resolved.music.level, MUSIC_DEFAULTS.level);
  assert.equal(resolved.music.loop, true);
  assert.equal(resolveAudio(null).music, null);
});

test("the swells are the run-in, the long pauses and the tail, padded away from the words", () => {
  const windows = swellWindows(words, 8);
  assert.deepEqual(windows, [
    { start: 0, end: 0.7 },
    { start: 2.2, end: 3.7 },
    { start: 5.3, end: 8 },
  ]);
  assert.deepEqual(swellWindows([], 5), [{ start: 0, end: 5 }]);
  // A breath is not a pause.
  assert.equal(swellWindows(words, 8, { minGap: 3 }).length, 2);
});

test("the bed's gain is the duck under the voice and full in the pauses, with ramps between", () => {
  const windows = swellWindows(words, 8);
  const expr = bedGainExpression(windows, { duck: -12, ramp: 0.5 });
  const gain = (t) => evaluateExpression(expr, { t });
  const duck = Math.pow(10, -12 / 20);
  assert.ok(Math.abs(gain(1.2) - duck) < 1e-3, `under a word: ${gain(1.2)}`);
  assert.ok(Math.abs(gain(4.3) - duck) < 1e-3, "under a word after the pause");
  assert.ok(Math.abs(gain(3.0) - 1) < 1e-3, `in the pause: ${gain(3.0)}`);
  assert.ok(Math.abs(gain(7.0) - 1) < 1e-3, "in the tail");
  assert.ok(Math.abs(gain(0.1) - 1) < 1e-3, "in the run-in");
  // Ramps: monotone across a window's edge, never above 1 or below the duck.
  let last = gain(1.9);
  for (let t = 1.9; t <= 3.0; t += 0.05) { const g = gain(t); assert.ok(g >= last - 1e-6 && g <= 1 + 1e-6 && g >= duck - 1e-3); last = g; }
  // No pauses at all: the duck, as a constant.
  assert.ok(Math.abs(evaluateExpression(bedGainExpression([], { duck: -6 }), { t: 3 }) - Math.pow(10, -6 / 20)) < 1e-3);
});

test("the stitch graph mixes the bed under the voice and maps the mix, or leaves the voice alone", () => {
  assert.equal(audioGraph({ audio: null, words, span: 8, musicPath: "x" }), null);
  const bed = audioGraph({ audio: { music: { src: "assets/bed.mp3" } }, words, span: 8, musicPath: "/p/assets/bed.mp3" });
  assert.deepEqual(bed.inputs, ["-stream_loop", "-1", "-i", "/p/assets/bed.mp3"]);
  assert.equal(bed.map, "[mix]");
  assert.ok(bed.filter.includes("[1:a]aformat"));
  assert.ok(bed.filter.includes("volume=volume='") && bed.filter.includes(":eval=frame"));
  assert.ok(bed.filter.includes("afade=t=in") && bed.filter.includes("afade=t=out:st=6"));
  assert.ok(bed.filter.includes("amix=inputs=2:duration=first"));
  assert.equal(bed.windows.length, 3);
  // A preview span starts the music where the span starts and shifts the pauses.
  const span = audioGraph({ audio: { music: { src: "assets/bed.mp3", loop: false, fade: 0 } }, words, from: 2, span: 4, musicPath: "m" });
  assert.deepEqual(span.inputs, ["-ss", "2", "-i", "m"]);
  assert.deepEqual(span.windows, [{ start: 0.2, end: 1.7 }, { start: 3.3, end: 4 }]);
  assert.ok(!span.filter.includes("afade"));
  // Loudness alone: no music input, the voice normalised and mapped.
  const loud = audioGraph({ audio: { voice: { loudness: -14 } }, words, span: 8, musicPath: null });
  assert.deepEqual(loud.inputs, []);
  assert.equal(loud.map, "[v1]");
  assert.ok(loud.filter.includes("loudnorm=I=-14"), "unmeasured: loudnorm");
  const exact = audioGraph({ audio: { voice: { loudness: -14, measured: -45 } }, words, span: 8, musicPath: null });
  assert.ok(exact.filter.includes("volume=31dB,alimiter=limit=0.8414"), exact.filter);
  assert.ok(!exact.filter.includes("loudnorm"), "measured: a plain gain and a ceiling");
  assert.equal(exact.voiceTarget, -14);
  const trimmed = audioGraph({ audio: { voice: { loudness: -14, measured: -45 } }, words, span: 8, musicPath: null, voiceTrimDb: 1.5 });
  assert.ok(trimmed.filter.includes("volume=32.5dB"), trimmed.filter);
  assert.equal(loud.voiceTarget, null, "unmeasured: nothing to check against");
});

test("describeAudio says what the bed does in a line", () => {
  const described = describeAudio({ music: { src: "assets/bed.mp3", level: -20, duck: -10 } }, words, 8);
  assert.equal(described.music.swells, 3);
  assert.ok(described.music.about.includes("-20 dB in the pauses, -30 dB under the voice"));
  assert.equal(describeAudio(null, words, 8).music, null);
});

test("a bed confined to spans plays only there, faded at each edge, with no whole-film fade", () => {
  const music = { src: "assets/bed.mp3", fade: 0.5, spans: [{ fromWordId: 2, toWordId: 3 }] };
  validateAudio({ music });
  assert.throws(() => validateAudio({ music: { ...music, spans: [{ fromWordId: 3, toWordId: 2 }] } }), /fromWordId <= toWordId/);
  const spans = bedSpans(music, words, 8);
  assert.deepEqual(spans, [{ start: 3.4, end: 5.6 }]);
  assert.deepEqual(bedSpans({ src: "assets/bed.mp3" }, words, 8), [{ start: 0, end: 8 }]);
  assert.throws(() => bedSpans({ spans: [{ fromWordId: 0, toWordId: 99 }] }, words, 8), /does not have/);
  const presence = spanPresenceExpression(spans, 0.5);
  const at = (t) => evaluateExpression(presence, { t });
  assert.equal(at(1.0), 0);
  assert.equal(at(4.5), 1);
  assert.equal(at(7.0), 0);
  assert.ok(at(3.65) > 0 && at(3.65) < 1, "fading in");
  const graph = audioGraph({ audio: { music }, words, span: 8, musicPath: "m" });
  assert.equal(graph.confined, true);
  assert.ok(!graph.filter.includes("afade"), "no whole-film fade when the bed is confined");
  assert.ok(graph.filter.includes(")*min(1,"), "the presence multiplies the gain");
  assert.ok(describeAudio({ music }, words, 8).music.about.includes("under 1 span(s) only"));
});

test("with both loudnesses known, level is LU below the voice; without, it is a gain on the file", () => {
  // A loud file (-8 LUFS) under a -16 LUFS voice at -18: gained -26 dB.
  assert.equal(bedGainDb({ level: -18, loudness: -8 }, -16), -26);
  // A quiet file (-24 LUFS) under the same voice: gained -10 dB.
  assert.equal(bedGainDb({ level: -18, loudness: -24 }, -16), -10);
  // Never a boost past unity.
  assert.equal(bedGainDb({ level: -2, loudness: -30 }, -14), 0);
  assert.equal(bedGainDb({ level: -18 }, -16), -18, "unmeasured: the level as a gain");
  assert.equal(bedGainDb({ level: -18, loudness: -8 }, undefined), -18);
  assert.equal(parseLoudness("  Integrated loudness:\n    I:         -16.2 LUFS\n    Threshold: -26.7 LUFS"), -16.2);
  assert.equal(parseLoudness("nothing"), null);
  const graph = audioGraph({ audio: { music: { src: "assets/bed.mp3", level: -18, loudness: -8, fade: 0 }, voice: { measured: -16 } }, words, span: 8, musicPath: "m" });
  assert.ok(graph.filter.includes("volume=0.0501"), graph.filter.split("\n")[1]);
  assert.ok(describeAudio({ music: { src: "assets/bed.mp3", loudness: -8 }, voice: { measured: -16 } }, words, 8).music.about.includes("LU under the voice"));
});

test("a quiet voice is pointed out when the bed is set, and not once a target is chosen", () => {
  const quiet = describeAudio({ music: { src: "assets/bed.mp3" }, voice: { measured: -45 } }, words, 8);
  assert.ok(quiet.voice.note && quiet.voice.note.includes("-45 LUFS"));
  const targeted = describeAudio({ music: { src: "assets/bed.mp3" }, voice: { measured: -45, loudness: -16 } }, words, 8);
  assert.equal(targeted.voice.note, undefined);
  assert.equal(describeAudio({ music: { src: "assets/bed.mp3" }, voice: { measured: -18 } }, words, 8).voice.note, undefined);
});
