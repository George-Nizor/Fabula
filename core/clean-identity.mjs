// What the clean cut is made of, as canonical text. Two identities:
//
//   cutIdentity   which moments of the source survive — so the audio, the
//                 clean timeline, and every clean transcript word id
//   cleanIdentity the cut plus how the picture is framed and delivered
//
// Hash them and you know whether clean.mp4 and clean.json still describe
// the project, by content rather than by file times: toggling a cut and
// toggling it back, retuning to the same list, or changing anything the
// compose stage owns (punch-ins, scenes, theme) costs no render. No I/O
// here; the pipeline hashes the strings and records them beside the render.

export const CLEAN_VERSION = "clean-2"; // 2: punch-ins left the clean cut for the compose stage

const ms = (x) => Math.round(x * 1000) / 1000;
const rect = (r) => (r ? [r.x, r.y, r.w, r.h].map(ms) : null);

export function cutIdentity({ source, keeps }) {
  return JSON.stringify({
    source: { path: source?.path ?? null, bytes: source?.bytes ?? null },
    keeps: keeps.map((keep) => [ms(keep.start), ms(keep.end)]),
  });
}

export function cleanIdentity({ source, keeps, framing, fps, ceiling }) {
  return JSON.stringify({
    version: CLEAN_VERSION,
    cut: cutIdentity({ source, keeps }),
    framing: framing.segments.map((s) => [ms(s.start), ms(s.end), rect(s.head), rect(s.screen)]),
    fps,
    ceiling: [ceiling.width, ceiling.height],
  });
}
