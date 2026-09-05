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

const EPSILON = 0.02;

function assertZoom(zoom) {
  if (!(zoom > 1)) throw new Error(`punch zoom must exceed 1, got ${zoom}`);
}

export function punchPlan(words, cuts, durationSeconds, options = {}) {
  const zoom = options.zoom ?? DEFAULT_PUNCH_ZOOM;
  assertZoom(zoom);
  const keeps = keepSegments(cuts, durationSeconds);
  return keeps.map((keep, index) => {
    const inside = words.filter(
      (word) => word.start >= keep.start - EPSILON && word.end <= keep.end + EPSILON
    );
    return {
      start: keep.start,
      end: keep.end,
      fromWordId: inside[0]?.id ?? null,
      toWordId: inside.at(-1)?.id ?? null,
      scale: index % 2 === 0 ? 1 : zoom,
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
    spans.push({
      keepIndex: piece.keepIndex,
      start: piece.cleanStart,
      end: piece.cleanEnd,
      scale: piece.keepIndex % 2 === 0 ? 1 : zoom,
    });
  }
  return spans;
}

export function punchScaleAt(spans, t) {
  const span = (spans ?? []).find((s) => t >= s.start && t < s.end);
  return span?.scale ?? 1;
}
