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

// Stage scenes -> a gapless timeline over [0, duration]; anywhere no layout
// is declared, the head holds focus.
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
  return segments.filter((segment) => segment.end > segment.start);
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
