// The stage: a fixed canvas the footage lives ON as a layer, not under.
// Layouts say where the talking head sits and how much room the visuals
// get; boundaries are word-anchored like everything else, and the head
// eases between layouts. Pure functions of time throughout — the preview
// and the export ask the same questions and get the same rectangles.

export const DEFAULT_STAGE = { width: 1920, height: 1080 };
export const LAYOUTS = new Set(["focus", "pip", "side"]);
export const PIP_CORNERS = new Set(["br", "bl", "tr", "tl"]);
const TRANSITION_SECONDS = 0.6;

const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

// The head must not dart about. A return to focus shorter than this
// between two placed segments is bridged (the head stays where it was), and
// a placed segment shorter than this between two other layouts is absorbed
// into the one before it rather than flown to and back.
export const MIN_DWELL_SECONDS = 3;

const sameLayout = (a, b) => a.layout === b.layout && (a.corner ?? null) === (b.corner ?? null);

// Stage scenes -> a gapless timeline over [0, duration]; anywhere no layout
// is declared, the head holds focus. Then the dwell rule, so the timeline
// never asks for two flights within a breath of each other.
export function resolveLayoutTimeline(resolvedScenes, durationSeconds) {
  const stageScenes = resolvedScenes
    .filter((scene) => scene.type === "stage")
    .sort((a, b) => a.start - b.start);
  const segments = [];
  let cursor = 0;
  for (const scene of stageScenes) {
    if (scene.start > cursor) segments.push({ start: cursor, end: scene.start, layout: "focus" });
    segments.push({
      start: Math.max(scene.start, cursor),
      end: Math.min(scene.end, durationSeconds),
      layout: scene.layout,
      corner: scene.corner,
    });
    cursor = Math.max(cursor, scene.end);
  }
  if (cursor < durationSeconds) segments.push({ start: cursor, end: durationSeconds, layout: "focus" });
  return settleTimeline(segments.filter((segment) => segment.end > segment.start), durationSeconds);
}

// Bridges short returns to focus between placed segments, absorbs placed
// segments too short to dwell in, and merges neighbours that ended up the
// same. The first and last segments are never absorbed: a film may open or
// close on a short shot.
export function settleTimeline(segments, durationSeconds) {
  let out = segments.map((s) => ({ ...s }));
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    // Short focus gaps between two placed layouts: extend the earlier one.
    for (let i = 1; i + 1 < out.length; i += 1) {
      const gap = out[i];
      if (gap.layout !== "focus" || gap.end - gap.start >= MIN_DWELL_SECONDS) continue;
      if (out[i - 1].layout === "focus" || out[i + 1].layout === "focus") continue;
      out[i - 1] = { ...out[i - 1], end: gap.end };
      out.splice(i, 1);
      changed = true;
      i -= 1;
    }
    // Short placed segments between two other layouts: the earlier one holds.
    for (let i = 1; i + 1 < out.length; i += 1) {
      const seg = out[i];
      if (seg.layout === "focus" || seg.end - seg.start >= MIN_DWELL_SECONDS) continue;
      out[i - 1] = { ...out[i - 1], end: seg.end };
      out.splice(i, 1);
      changed = true;
      i -= 1;
    }
    // Same layout twice in a row is one segment.
    for (let i = 0; i + 1 < out.length; i += 1) {
      if (!sameLayout(out[i], out[i + 1])) continue;
      out[i] = { ...out[i], end: out[i + 1].end };
      out.splice(i + 1, 1);
      changed = true;
      i -= 1;
    }
    if (!changed) break;
  }
  return out.filter((segment) => segment.end > segment.start && segment.start < durationSeconds);
}

// The rectangles a layout gives to the head and to the visuals, in stage
// pixels. The head keeps its aspect; the content rect is where graphic
// cards belong while that layout holds.
export function layoutRects(layout, corner, videoAspect, stage = DEFAULT_STAGE) {
  const { width: W, height: H } = stage;
  const margin = H * 0.045;
  if (layout === "pip") {
    const h = H * 0.28;
    const w = h * videoAspect;
    const at = {
      br: { x: W - w - margin, y: H - h - margin },
      bl: { x: margin, y: H - h - margin },
      tr: { x: W - w - margin, y: margin },
      tl: { x: margin, y: margin },
    }[corner ?? "br"];
    return {
      video: { ...at, w, h },
      content: { x: W * 0.06, y: H * 0.08, w: W * 0.62, h: H * 0.8 },
    };
  }
  if (layout === "side") {
    // The head takes at most 46% of the width, so wide footage (16:9 or
    // wider) still leaves the visuals a column worth reading; square or
    // portrait footage keeps its taller 62% frame.
    const h = Math.min(H * 0.62, (W * 0.46) / videoAspect);
    const w = h * videoAspect;
    const x = W * 0.055;
    const contentX = x + w + W * 0.045;
    return {
      video: { x, y: (H - h) / 2, w, h },
      content: { x: contentX, y: H * 0.14, w: W - contentX - W * 0.055, h: H * 0.72 },
    };
  }
  // focus: as large as the stage allows, centered.
  const h = H * 0.92;
  const w = h * videoAspect;
  return {
    video: { x: (W - w) / 2, y: (H - h) / 2, w, h },
    content: { x: W * 0.08, y: H * 0.1, w: W * 0.84, h: H * 0.8 },
  };
}

const lerp = (a, b, k) => a + (b - a) * k;
const lerpRect = (a, b, k) => ({
  x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), w: lerp(a.w, b.w, k), h: lerp(a.h, b.h, k),
});

// Where everything sits at time t. Entering a new segment, the head eases
// from the previous layout over the transition; the content rect snaps
// (graphic cards carry their own entrances).
export function layoutAt(timeline, t, videoAspect, stage = DEFAULT_STAGE) {
  if (timeline.length === 0) return layoutRects("focus", null, videoAspect, stage);
  let index = timeline.findIndex((segment) => t >= segment.start && t < segment.end);
  if (index < 0) index = t < timeline[0].start ? 0 : timeline.length - 1;
  const segment = timeline[index];
  const current = layoutRects(segment.layout, segment.corner, videoAspect, stage);
  const since = t - segment.start;
  if (index > 0 && since >= 0 && since < TRANSITION_SECONDS) {
    const previous = timeline[index - 1];
    const from = layoutRects(previous.layout, previous.corner, videoAspect, stage);
    const k = easeInOut(since / TRANSITION_SECONDS);
    return { video: lerpRect(from.video, current.video, k), content: current.content, settled: false };
  }
  return { video: current.video, content: current.content, settled: true };
}
