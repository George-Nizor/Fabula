// Source framing: where the talking head — and, when the recording carries
// one, the screen — sit inside the raw frame, per span of the RAW timeline.
// A camera-only take has one segment covering everything. A screen recording
// with the camera in a corner, or an OBS session that switches scenes mid-take,
// has several. Pure functions over plain data; the pipeline turns the answers
// into ffmpeg crops and the window draws them over the footage.

const MIN_EDGE = 16;

function isRect(rect) {
  return rect && ["x", "y", "w", "h"].every((k) => Number.isFinite(rect[k]) && rect[k] >= 0)
    && rect.w >= MIN_EDGE && rect.h >= MIN_EDGE;
}

function inside(rect, dims) {
  return rect.x + rect.w <= dims.width + 0.5 && rect.y + rect.h <= dims.height + 0.5;
}

// { segments: [{ start, end, head: rect, screen?: rect }] }. Segments must
// be ordered, non-overlapping, and cover [0, duration]; every rect must lie
// within the frame. Heads must share an aspect (within 2%) so the clean cut
// is one steady picture — a scene switch that changed the head's shape would
// need letterboxing, which no take should be asking for.
export function validateFraming(framing, dims, durationSeconds) {
  if (!framing || !Array.isArray(framing.segments) || framing.segments.length === 0) {
    throw new Error("framing needs at least one segment");
  }
  let cursor = 0;
  let aspect = null;
  framing.segments.forEach((segment, index) => {
    const at = `framing segment ${index}`;
    if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.end <= segment.start) {
      throw new Error(`${at}: start/end must be a forward span`);
    }
    if (Math.abs(segment.start - cursor) > 0.05) throw new Error(`${at}: starts at ${segment.start}, expected ${cursor.toFixed(2)}`);
    if (!isRect(segment.head)) throw new Error(`${at}: head must be a rect {x,y,w,h} at least ${MIN_EDGE}px a side`);
    if (dims && !inside(segment.head, dims)) throw new Error(`${at}: head rect leaves the ${dims.width}x${dims.height} frame`);
    const a = segment.head.w / segment.head.h;
    if (aspect === null) aspect = a;
    else if (Math.abs(a - aspect) / aspect > 0.02) throw new Error(`${at}: head aspect ${a.toFixed(3)} differs from ${aspect.toFixed(3)}`);
    if (segment.screen !== undefined && segment.screen !== null) {
      if (!isRect(segment.screen)) throw new Error(`${at}: screen must be a rect {x,y,w,h}`);
      if (dims && !inside(segment.screen, dims)) throw new Error(`${at}: screen rect leaves the frame`);
    }
    cursor = segment.end;
  });
  if (durationSeconds !== undefined && Math.abs(cursor - durationSeconds) > 0.5) {
    throw new Error(`framing covers ${cursor.toFixed(1)}s of a ${durationSeconds.toFixed(1)}s recording`);
  }
}

// The whole frame as the head: what every recording gets until told better.
export function fullFrameFraming(dims, durationSeconds) {
  return { segments: [{ start: 0, end: durationSeconds, head: { x: 0, y: 0, w: dims.width, h: dims.height } }] };
}

export function framingAt(framing, t) {
  const segments = framing?.segments ?? [];
  return segments.find((s) => t >= s.start && t < s.end) ?? segments.at(-1) ?? null;
}

// Keep segments cut at every framing boundary they straddle, each piece
// carrying its rects and its position on the CLEAN timeline. Order is time
// order, so clean offsets accumulate.
export function splitKeepsByFraming(keeps, framing) {
  const pieces = [];
  let cleanCursor = 0;
  for (const keep of keeps) {
    const bounds = [keep.start];
    for (const segment of framing.segments) {
      if (segment.start > keep.start && segment.start < keep.end) bounds.push(segment.start);
    }
    bounds.push(keep.end);
    for (let i = 0; i + 1 < bounds.length; i += 1) {
      const start = bounds[i];
      const end = bounds[i + 1];
      if (end - start < 0.01) continue;
      const segment = framingAt(framing, start + (end - start) / 2);
      pieces.push({
        start, end,
        head: segment.head,
        screen: segment.screen ?? null,
        cleanStart: cleanCursor,
        cleanEnd: cleanCursor + (end - start),
      });
      cleanCursor += end - start;
    }
  }
  return pieces;
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

// The one output size for the head track: the head's own aspect, fitted
// inside the delivery ceiling, never upscaled past the largest source rect.
export function headOutputSize(framing, ceiling = { width: 1920, height: 1080 }) {
  const rects = framing.segments.map((s) => s.head);
  const aspect = rects[0].w / rects[0].h;
  const maxSourceW = Math.max(...rects.map((r) => r.w));
  let width = Math.min(ceiling.width, maxSourceW, ceiling.height * aspect);
  let height = width / aspect;
  if (height > ceiling.height) { height = ceiling.height; width = height * aspect; }
  return { width: even(width), height: even(height) };
}

// Screen rects may differ in shape between segments (a scene switch changes
// what is on screen); the track takes the aspect of the largest one and
// letterboxes the rest. Null when no segment carries a screen.
export function screenOutputSize(framing, ceiling = { width: 1920, height: 1080 }) {
  const rects = framing.segments.map((s) => s.screen).filter(Boolean);
  if (rects.length === 0) return null;
  const largest = rects.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
  const aspect = largest.w / largest.h;
  let width = Math.min(ceiling.width, largest.w, ceiling.height * aspect);
  let height = width / aspect;
  if (height > ceiling.height) { height = ceiling.height; width = height * aspect; }
  return { width: even(width), height: even(height) };
}

// Where, on the clean timeline, a screen exists to show. Adjacent pieces
// merge so the agent reads a handful of spans, not one per cut.
export function screenSpans(pieces) {
  const spans = [];
  for (const piece of pieces) {
    if (!piece.screen) continue;
    const last = spans.at(-1);
    if (last && Math.abs(last.end - piece.cleanStart) < 0.01) last.end = piece.cleanEnd;
    else spans.push({ start: piece.cleanStart, end: piece.cleanEnd });
  }
  return spans;
}
