// Shot planning over a reviewed cut list. No I/O. The first planner is the
// jump-cut disguise from the brief: alternate framing across the keep
// segments, so every cut boundary lands between two different framings and
// reads as a deliberate shot change instead of a skip.
//
// Punch-ins are a compose-time decision: the clean cut carries the footage
// at its framed size and nothing else, so turning the plan on, off, or
// tighter never sends the cut back to render. The raw-timeline plan below
// previews over the raw file in the Cut tab; punchSpans maps the same
// alternation onto the clean timeline for the stage and the final render.

import { keepSegments } from "./cut-engine.mjs";

export const DEFAULT_PUNCH_ZOOM = 1.15;

// A punch-in has to hold long enough to read as a shot. Alternating on every
// keep, however short, pops the camera out and back inside two seconds where
// two cuts land close together — which reads as a fault, not a shot change.
// A keep shorter than this carries the framing it already had, so the
// alternation resumes at the next keep long enough to hold one. It is the
// same floor the stage engine puts under a layout, for the same reason.
export const PUNCH_DWELL_SECONDS = 3;

const EPSILON = 0.02;

// The scale for each keep, in order. The film opens wide and alternates only
// across keeps that can hold a shot; with no short keeps this is exactly the
// old index parity, so a film without slivers renders identically.
export function punchScales(durations, zoom) {
  assertZoom(zoom);
  let scale = 1;
  let held = 0; // seconds already spent in the framing we are in
  return durations.map((seconds, index) => {
    // Both sides of a change have to be able to hold a shot: the one being
    // left must have run for the floor, and the one being entered must have
    // the room. Either test alone leaves a sliver on the other side.
    if (index > 0 && held >= PUNCH_DWELL_SECONDS && seconds >= PUNCH_DWELL_SECONDS) {
      scale = scale === 1 ? zoom : 1;
      held = 0;
    }
    held += seconds;
    return scale;
  });
}

function assertZoom(zoom) {
  if (!(zoom > 1)) throw new Error(`punch zoom must exceed 1, got ${zoom}`);
}

export function punchPlan(words, cuts, durationSeconds, options = {}) {
  const zoom = options.zoom ?? DEFAULT_PUNCH_ZOOM;
  assertZoom(zoom);
  const keeps = keepSegments(cuts, durationSeconds);
  const scales = punchScales(keeps.map((keep) => keep.end - keep.start), zoom);
  return keeps.map((keep, index) => {
    const inside = words.filter(
      (word) => word.start >= keep.start - EPSILON && word.end <= keep.end + EPSILON
    );
    return {
      start: keep.start,
      end: keep.end,
      fromWordId: inside[0]?.id ?? null,
      toWordId: inside.at(-1)?.id ?? null,
      scale: scales[index],
    };
  });
}

// The plan on the CLEAN timeline, from the clean render's pieces: pieces of
// one keep segment (a keep splits where the framing changes) merge back into
// that keep's span, and the keep's index decides its scale. Pieces from a
// render that predates keep indices yield no punches at all, rather than a
// guess.
export function punchSpans(pieces, zoom = DEFAULT_PUNCH_ZOOM) {
  assertZoom(zoom);
  const spans = [];
  for (const piece of pieces ?? []) {
    if (!Number.isInteger(piece.keepIndex)) return [];
    const last = spans.at(-1);
    if (last && last.keepIndex === piece.keepIndex) { last.end = piece.cleanEnd; continue; }
    spans.push({ keepIndex: piece.keepIndex, start: piece.cleanStart, end: piece.cleanEnd, scale: 1 });
  }
  // The keeps are whole here, so the dwell floor is measured on the clean
  // timeline the viewer actually watches.
  const scales = punchScales(spans.map((span) => span.end - span.start), zoom);
  spans.forEach((span, index) => { span.scale = scales[index]; });
  return spans;
}

export function punchScaleAt(spans, t) {
  const span = (spans ?? []).find((s) => t >= s.start && t < s.end);
  return span?.scale ?? 1;
}
