// Shot planning over a reviewed cut list. No I/O. The first planner is the
// jump-cut disguise from the brief: alternate framing across the keep
// segments, so every cut boundary lands between two different framings and
// reads as a deliberate shot change instead of a skip.
//
// Shots are word-anchored like cuts are: word ids are the durable reference,
// seconds are derived (and carried for segments no word touches). One plan
// feeds both the live preview (CSS transform) and the export (per-segment
// crop), which must never disagree.

import { keepSegments } from "./cut-engine.mjs";

export const DEFAULT_PUNCH_ZOOM = 1.15;

const EPSILON = 0.02;

export function punchPlan(words, cuts, durationSeconds, options = {}) {
  const zoom = options.zoom ?? DEFAULT_PUNCH_ZOOM;
  if (!(zoom > 1)) throw new Error(`punch zoom must exceed 1, got ${zoom}`);
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
