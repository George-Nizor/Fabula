import test from "node:test";
import assert from "node:assert/strict";
import { punchPlan, punchSpans, punchScaleAt, punchScales, PUNCH_DWELL_SECONDS, DEFAULT_PUNCH_ZOOM } from "../core/shot-engine.mjs";

// Every keep here is long enough to hold a shot (PUNCH_DWELL_SECONDS), so
// these cover the alternation itself; the floor has its own test below. A
// toy timeline of one-second keeps would assert the flicker the floor exists
// to prevent.
const words = [
  { id: 0, text: "one", start: 0.0, end: 2.0 },
  { id: 1, text: "two", start: 2.4, end: 4.0 },
  { id: 2, text: "three", start: 12.0, end: 13.6 },
  { id: 3, text: "four", start: 24.0, end: 26.0 },
];

const cuts = [
  { start: 4.8, end: 11.2, enabled: true, sources: [] },
  { start: 14.4, end: 23.2, enabled: true, sources: [] },
];

const DURATION = 28;

test("alternates framing across keep segments, starting wide", () => {
  const plan = punchPlan(words, cuts, DURATION);
  assert.equal(plan.length, 3);
  assert.deepEqual(plan.map((shot) => shot.scale), [1, DEFAULT_PUNCH_ZOOM, 1]);
});

test("each shot spans one keep segment and anchors to its words", () => {
  const plan = punchPlan(words, cuts, DURATION);
  assert.equal(plan[0].fromWordId, 0);
  assert.equal(plan[0].toWordId, 1);
  assert.equal(plan[1].fromWordId, 2);
  assert.equal(plan[1].toWordId, 2);
  assert.equal(plan[2].fromWordId, 3);
  assert.equal(plan[2].toWordId, 3);
});

test("a wordless keep segment carries time anchors only", () => {
  const plan = punchPlan(words.slice(0, 2), [{ start: 4.8, end: 11.2, enabled: true, sources: [] }], DURATION);
  assert.equal(plan.length, 2);
  assert.equal(plan[1].fromWordId, null);
  assert.equal(plan[1].toWordId, null);
  assert.ok(plan[1].start > plan[0].end);
});

test("no cuts means one wide shot", () => {
  const plan = punchPlan(words, [], DURATION);
  assert.deepEqual(plan.map((shot) => shot.scale), [1]);
});

test("disabled cuts do not split shots", () => {
  const disabled = cuts.map((cut) => ({ ...cut, enabled: false }));
  assert.equal(punchPlan(words, disabled, DURATION).length, 1);
});

test("a custom zoom flows through; a non-zoom is refused", () => {
  const plan = punchPlan(words, cuts, DURATION, { zoom: 1.3 });
  assert.equal(plan[1].scale, 1.3);
  assert.throws(() => punchPlan(words, cuts, DURATION, { zoom: 1 }));
});

// The clean-timeline plan: pieces are what the clean render wrote, one keep
// split at a framing boundary staying one shot.
const pieces = [
  { keepIndex: 0, cleanStart: 0, cleanEnd: 4.8 },
  { keepIndex: 1, cleanStart: 4.8, cleanEnd: 6.0 },
  { keepIndex: 1, cleanStart: 6.0, cleanEnd: 8.0 },
  { keepIndex: 2, cleanStart: 8.0, cleanEnd: 12.8 },
];

test("punch spans merge a keep's pieces and alternate by keep index", () => {
  const spans = punchSpans(pieces, 1.2);
  assert.deepEqual(spans.map((s) => [s.start, s.end, s.scale]), [[0, 4.8, 1], [4.8, 8.0, 1.2], [8.0, 12.8, 1]]);
});

test("the scale at t is the span's, wide outside every span, half-open at the boundary", () => {
  const spans = punchSpans(pieces, 1.2);
  assert.equal(punchScaleAt(spans, 2.0), 1);
  assert.equal(punchScaleAt(spans, 4.8), 1.2);
  assert.equal(punchScaleAt(spans, 7.99), 1.2);
  assert.equal(punchScaleAt(spans, 8.0), 1);
  assert.equal(punchScaleAt(spans, 99), 1);
  assert.equal(punchScaleAt([], 1), 1);
});

test("pieces from a render without keep indices yield no punches", () => {
  assert.deepEqual(punchSpans([{ cleanStart: 0, cleanEnd: 5, scale: 1.15 }]), []);
  assert.throws(() => punchSpans(pieces, 1));
});

test("a punch-in holds for the dwell floor: a sliver keeps its framing instead of popping out and back", () => {
  const zoom = 1.12;
  // Keeps that can all hold a shot alternate exactly as index parity did, so
  // a film without slivers renders the same as before the floor existed.
  const roomy = [8, 5, 6, 4, 7];
  assert.deepEqual(punchScales(roomy, zoom), [1, zoom, 1, zoom, 1]);
  // A keep under the floor carries the framing it already had; the next keep
  // long enough to hold a shot resumes the alternation.
  const withSliver = [8, 5, 1.8, 4, 7];
  assert.deepEqual(punchScales(withSliver, zoom), [1, zoom, zoom, 1, zoom]);
  // Whatever happens, no run of one framing is shorter than the floor.
  for (const durations of [roomy, withSliver, [2, 2, 2, 9], [0.4, 0.5, 12, 5]]) {
    const scales = punchScales(durations, zoom);
    let held = 0;
    durations.forEach((seconds, i) => {
      held += seconds;
      if (i === durations.length - 1 || scales[i + 1] !== scales[i]) {
        assert.ok(held >= PUNCH_DWELL_SECONDS || i === durations.length - 1,
          `a ${held.toFixed(2)}s shot is under the ${PUNCH_DWELL_SECONDS}s floor in ${JSON.stringify(durations)}`);
        held = 0;
      }
    });
  }
  // The film always opens wide.
  assert.equal(punchScales([1, 9], zoom)[0], 1);
  assert.equal(punchScales([12, 9], zoom)[0], 1);
});

test("punchSpans measures the dwell floor on the clean timeline, and pieces of one keep stay one shot", () => {
  const zoom = 1.12;
  // Two pieces of keep 1 (the framing changed mid-keep) are one span; keep 2
  // is a sliver on the clean timeline and inherits.
  const pieces = [
    { keepIndex: 0, cleanStart: 0, cleanEnd: 8 },
    { keepIndex: 1, cleanStart: 8, cleanEnd: 11 },
    { keepIndex: 1, cleanStart: 11, cleanEnd: 13 },
    { keepIndex: 2, cleanStart: 13, cleanEnd: 14.5 },
    { keepIndex: 3, cleanStart: 14.5, cleanEnd: 20 },
  ];
  const spans = punchSpans(pieces, zoom);
  assert.deepEqual(spans.map((s) => [s.keepIndex, s.start, s.end, s.scale]), [
    [0, 0, 8, 1], [1, 8, 13, zoom], [2, 13, 14.5, zoom], [3, 14.5, 20, 1],
  ]);
  assert.equal(punchScaleAt(spans, 13.5), zoom, "the sliver holds the shot it was already in");
});
