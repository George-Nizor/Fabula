// The stage: a fixed canvas the footage lives ON as a layer, not under.
// Layouts say where the talking head sits and how much room the visuals
// get; boundaries are word-anchored like everything else, and the picture
// changes at each boundary the way the film's transition says. Pure
// functions of time throughout — the preview and the export ask the same
// questions and get the same rectangles and the same opacity.

export const DEFAULT_STAGE = { width: 1920, height: 1080 };
export const LAYOUTS = new Set(["focus", "pip", "side", "band", "full", "cutaway"]);
export const FULL_STAGE_KINDS = new Set(["cover", "section", "custom"]);
export const PIP_CORNERS = new Set(["br", "bl", "tr", "tl"]);

// ---- How the picture changes at a layout boundary ----
//
// A talking head flying across the frame is the most conspicuous motion in
// the film and the first thing that reads as cheap, so how a boundary is
// crossed is a decision of the look, not a constant.
//
//   glide     the head travels from one rectangle to the other, on a curve
//             with no jolt at either end. The default: a moving camera is
//             a real technique, it only reads badly when it is rushed.
//   dissolve  the head fades away, the arrangement changes while it is
//             gone, and it fades back. Nothing slides.
//   cut       everything changes on one frame. Deliberately abrupt.
//
// The mix inside a film comes for free: a boundary that a cutaway touches
// has no rectangle to travel to, so glide fades there instead of flying the
// head in from off the canvas. A glide film moves its camera between
// layouts and fades the camera in and out of its camera-free moments.
//
// Duration is separate from style, because "too fast" and "wrong technique"
// are different complaints. TRANSITION_SECONDS is what a style takes when
// nobody has said; the theme's `transitionSeconds` overrides it.
export const TRANSITIONS = new Set(["glide", "dissolve", "cut"]);
export const DEFAULT_TRANSITION = "glide";
export const TRANSITION_SECONDS = { glide: 0.9, dissolve: 0.5, cut: 0 };
export const MIN_TRANSITION_SECONDS = 0.3;
export const MAX_TRANSITION_SECONDS = 1.8;

// A transition may not eat more than this share of either segment it joins,
// so a short opening or closing shot still reads as a shot.
const TRANSITION_SHARE = 0.45;

const clamp01 = (x) => Math.min(Math.max(x, 0), 1);
// Zero velocity at both ends: the fade has no visible start or stop.
const smoothstep = (x) => { const k = clamp01(x); return k * k * (3 - 2 * k); };
// Zero velocity AND zero acceleration at both ends — the difference the eye
// notices on a large moving rectangle, where cubic ease-in-out still jolts.
const smootherstep = (x) => { const k = clamp01(x); return k * k * k * (k * (k * 6 - 15) + 10); };

// The head must not dart about. A return to focus shorter than this
// between two placed segments is bridged (the head stays where it was), and
// a placed segment shorter than this between two other layouts is absorbed
// into the one before it rather than flown to and back.
export const MIN_DWELL_SECONDS = 3;
// A cutaway is a cut, not a flight — nothing travels, so a brief one is a
// legitimate edit rather than a dart. Below this it is a blink and goes.
export const MIN_CUT_SECONDS = 1.2;

// Whether the camera is on the stage at all during a layout.
const layoutAlpha = (layout) => (layout === "cutaway" ? 0 : 1);

// A duration someone asked for, clamped, or null when nobody did.
export function transitionSecondsOf(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(Math.max(value, MIN_TRANSITION_SECONDS), MAX_TRANSITION_SECONDS);
}

const sameLayout = (a, b) => a.layout === b.layout && (a.corner ?? null) === (b.corner ?? null);

// Stage scenes -> a gapless timeline over [0, duration]; anywhere no layout
// is declared, the head holds focus. Each segment carries the transition
// used to ENTER it: the scene's own, else the film's (the resolved theme's
// `transition`, passed in), else the default.
export function resolveLayoutTimeline(resolvedScenes, durationSeconds, options = {}) {
  const filmTransition = TRANSITIONS.has(options.transition) ? options.transition : DEFAULT_TRANSITION;
  const filmSeconds = transitionSecondsOf(options.transitionSeconds);
  const transitionOf = (scene) => (TRANSITIONS.has(scene?.transition) ? scene.transition : filmTransition);
  const secondsOf = (scene) => transitionSecondsOf(scene?.transitionSeconds) ?? filmSeconds;
  const stageScenes = resolvedScenes
    .filter((scene) => scene.type === "stage")
    .sort((a, b) => a.start - b.start);
  const segments = [];
  let cursor = 0;
  for (const scene of stageScenes) {
    if (scene.start > cursor) segments.push({ start: cursor, end: scene.start, layout: "focus", transition: filmTransition, transitionSeconds: filmSeconds });
    segments.push({
      start: Math.max(scene.start, cursor),
      end: Math.min(scene.end, durationSeconds),
      layout: scene.layout,
      corner: scene.corner,
      transition: transitionOf(scene),
      transitionSeconds: secondsOf(scene),
    });
    cursor = Math.max(cursor, scene.end);
  }
  if (cursor < durationSeconds) segments.push({ start: cursor, end: durationSeconds, layout: "focus", transition: filmTransition, transitionSeconds: filmSeconds });
  return settleTimeline(segments.filter((segment) => segment.end > segment.start), durationSeconds);
}

// Bridges short returns to focus between placed segments, absorbs segments
// too short to hold, and merges neighbours that ended up the same. The
// first and last segments are never absorbed: a film may open or close on a
// short shot.
//
// A cutaway takes part in both rules. Exempting it was how the camera came
// back for a third of a second between two full-stage visuals — the exact
// dart the rule exists to prevent, and worse than a flight because it is a
// hard cut in and out. What a cutaway gets instead is a lower floor of its
// own: nothing travels, so a brief one is an edit rather than a dart.
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
      const floor = seg.layout === "cutaway" ? MIN_CUT_SECONDS : MIN_DWELL_SECONDS;
      if (seg.layout === "focus" || seg.end - seg.start >= floor) continue;
      out[i - 1] = { ...out[i - 1], end: seg.end };
      out.splice(i, 1);
      changed = true;
      i -= 1;
    }
    // Same layout twice in a row is one segment; the first one's entrance
    // is the one that was ever seen, so its transition is the one kept.
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

// How the boundary into timeline[index] is crossed, in seconds:
//
//   leave  before the boundary, the outgoing head fades from its own alpha
//          to nothing
//   enter  after it, the incoming head fades up to its own alpha
//   glide  after it, the head travels from the old rectangle to the new
//
// A dissolve between two visible layouts splits its time either side of the
// boundary — half out, half in — so the change lands on the anchored word.
// When one side has no camera there is only one thing to fade, and it takes
// the whole duration rather than half of it.
export function transitionAt(timeline, index) {
  const none = { style: "cut", enter: 0, leave: 0, glide: 0 };
  const segment = timeline[index];
  const previous = timeline[index - 1];
  if (!segment || !previous) return none;
  let style = TRANSITIONS.has(segment.transition) ? segment.transition : DEFAULT_TRANSITION;
  const hidden = previous.layout === "cutaway" || segment.layout === "cutaway";
  if (style === "glide" && hidden) style = "dissolve";
  const base = style === "cut" ? 0 : (transitionSecondsOf(segment.transitionSeconds) ?? TRANSITION_SECONDS[style] ?? 0);
  if (!(base > 0)) return none;
  const span = (s) => s.end - s.start;
  if (style === "glide") return { style, enter: 0, leave: 0, glide: Math.min(base, span(segment) * TRANSITION_SHARE * 2) };
  const from = layoutAlpha(previous.layout);
  const to = layoutAlpha(segment.layout);
  return {
    style,
    leave: from === 0 ? 0 : Math.min(to === 0 ? base : base / 2, span(previous) * TRANSITION_SHARE),
    enter: to === 0 ? 0 : Math.min(from === 0 ? base : base / 2, span(segment) * TRANSITION_SHARE),
    glide: 0,
  };
}

// ---- How the head meets its rectangle ----
//
//   contain  the whole head, scaled to fit, keeping its aspect. The
//            rectangle IS the head, so its width is its height times the
//            footage's aspect and nothing is lost.
//   cover    the rectangle is a window. The head is scaled until it covers
//            the window and the overflow is clipped away — the crop that
//            makes a landscape recording read as a native vertical film.
//            Costs the sides of the frame, which is the whole point.
//
// Every landscape layout contains; portrait crops where the head is meant to
// fill the frame and contains where its real framing matters (the band, and
// the small corner cards, where a crop would show a nose and nothing else).
export const FITS = new Set(["contain", "cover"]);

// The rectangles a layout gives to the head and to the visuals, in stage
// pixels, and how the head meets its own. The content rect is where graphic
// cards belong while that layout holds.
//
// A layout name means the same thing in both shapes and resolves to
// different geometry, so a scene plan survives being re-formatted: `side`
// puts the visual beside the head, which in a tall frame means underneath
// it, and `focus` means the head owns the picture, which in a tall frame
// means all of it.
export function layoutRects(layout, corner, videoAspect, stage = DEFAULT_STAGE) {
  const rects = stage.height > stage.width
    ? portraitRects(layout, corner, videoAspect, stage)
    : landscapeRects(layout, corner, videoAspect, stage);
  return { fit: "contain", ...rects };
}

function landscapeRects(layout, corner, videoAspect, stage) {
  const { width: W, height: H } = stage;
  const margin = H * 0.045;
  if (layout === "cutaway") {
    // The camera is not on the stage. The rectangle is real but entirely
    // outside the canvas, so ffmpeg's overlay clips the head away for free
    // rather than blending a fully transparent layer every frame; layoutAt
    // reports alpha 0 and headHidden, which is what the painter reads.
    // The content rect matches `full` — the same room, without the card.
    return {
      video: { x: -W * 3, y: 0, w: H * videoAspect, h: H },
      content: { x: W * 0.05, y: H * 0.07, w: W * 0.9, h: H * 0.86 },
    };
  }
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
  if (layout === "full") {
    // The visuals own the stage; the head is a small card in a corner.
    const h = H * 0.2;
    const w = h * videoAspect;
    const m = H * 0.04;
    const at = {
      br: { x: W - w - m, y: H - h - m },
      bl: { x: m, y: H - h - m },
      tr: { x: W - w - m, y: m },
      tl: { x: m, y: m },
    }[corner ?? "br"];
    return {
      video: { ...at, w, h },
      content: { x: W * 0.05, y: H * 0.07, w: W * 0.9, h: H * 0.86 },
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
  if (layout === "band") {
    // The head across the full width in its own shape, the visuals in
    // whatever is left below it. In a 16:9 frame with 16:9 footage that is
    // the whole picture and band is the same shot as focus; it earns its
    // name in a tall frame, and reads correctly here either way.
    const w = Math.min(W * 0.9, H * 0.62 * videoAspect);
    const h = w / videoAspect;
    const top = H * 0.06;
    const below = top + h + H * 0.04;
    return {
      video: { x: (W - w) / 2, y: top, w, h },
      content: { x: W * 0.08, y: below, w: W * 0.84, h: Math.max(H - below - H * 0.06, H * 0.1) },
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

// A tall frame. The head is cropped to fill wherever it is the picture, and
// kept whole wherever its real framing is the point; there is no column
// beside it, so the visuals live above or below.
function portraitRects(layout, corner, videoAspect, stage) {
  const { width: W, height: H } = stage;
  const margin = W * 0.045;
  // A tall film is watched with captions on, above the bottom eighth where
  // the platform's own controls are, so every content rect stops at one
  // floor — the same floor renderer/overlays.css puts the captions above.
  const captionFloor = H * 0.80;
  // The window a cropped head fills, with the safe band the visuals get.
  if (layout === "cutaway") {
    return {
      video: { x: -W * 3, y: 0, w: H * videoAspect, h: H },
      content: { x: W * 0.06, y: H * 0.09, w: W * 0.88, h: captionFloor - H * 0.09 },
    };
  }
  if (layout === "pip") {
    // Sized by width in a tall frame: a corner card set by height would be
    // half the picture when the footage is wide.
    const w = W * 0.36;
    const h = w / videoAspect;
    const at = {
      br: { x: W - w - margin, y: H - h - margin },
      bl: { x: margin, y: H - h - margin },
      tr: { x: W - w - margin, y: margin },
      tl: { x: margin, y: margin },
    }[corner ?? "br"];
    return {
      video: { ...at, w, h },
      content: { x: W * 0.06, y: H * 0.1, w: W * 0.88, h: H * 0.62 },
    };
  }
  if (layout === "full") {
    const w = W * 0.26;
    const h = w / videoAspect;
    const m = W * 0.04;
    const at = {
      br: { x: W - w - m, y: H - h - m },
      bl: { x: m, y: H - h - m },
      tr: { x: W - w - m, y: m },
      tl: { x: m, y: m },
    }[corner ?? "br"];
    return {
      video: { ...at, w, h },
      // The same room as a cutaway, with the head in a corner.
      content: { x: W * 0.06, y: H * 0.09, w: W * 0.88, h: captionFloor - H * 0.09 },
    };
  }

  if (layout === "band") {
    // The head whole, in its own aspect, across the width — the shot for a
    // wide moment a crop would ruin, with the visual under it.
    const w = W * 0.94;
    const h = w / videoAspect;
    const top = H * 0.1;
    const below = top + h + H * 0.03;
    return {
      fit: "contain",
      video: { x: (W - w) / 2, y: top, w, h },
      content: { x: W * 0.06, y: below, w: W * 0.88, h: Math.max(captionFloor - below, H * 0.1) },
    };
  }
  if (layout === "side") {
    // "Beside the head" in a tall frame is under it: the head takes the top
    // half, cropped to fill it, and the visual owns the bottom.
    const h = H * 0.52;
    const below = h + H * 0.035;
    return {
      fit: "cover",
      video: { x: 0, y: 0, w: W, h },
      content: { x: W * 0.06, y: below, w: W * 0.88, h: captionFloor - below },
    };
  }
  // focus: the head is the picture, edge to edge, and anything shown over it
  // sits in the lower third where a thumb is not and a caption already is.
  return {
    fit: "cover",
    video: { x: 0, y: 0, w: W, h: H },
    content: { x: W * 0.06, y: H * 0.54, w: W * 0.88, h: captionFloor - H * 0.54 },
  };
}

// Where the head is actually drawn, given the window its layout gave it:
// scaled until it covers the window on both axes, hanging off it evenly at
// either end, with the card clipping the overflow.
//
// This is one rule, not two. A contained window is already the footage's own
// shape, so covering it crops nothing and the drawn rect IS the window —
// which is why `fit` never has to be consulted at draw time, and why a glide
// between a contained layout and a cropped one is continuous: the crop grows
// from nothing as the window's shape diverges from the footage's.
//
// The browser gets this from `object-fit: cover` inside a card that already
// clips; the export gets it from these numbers. Both from here, so they
// cannot disagree.
export function headDrawRect(window, videoAspect) {
  const h = Math.max(window.h, window.w / videoAspect);
  const w = h * videoAspect;
  return { x: window.x + (window.w - w) / 2, y: window.y + (window.h - h) / 2, w, h };
}

const lerp = (a, b, k) => a + (b - a) * k;
const lerpRect = (a, b, k) => ({
  x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), w: lerp(a.w, b.w, k), h: lerp(a.h, b.h, k),
});

// Where everything sits at time t, and how present the head is.
//
//   video/content  the rectangles, in stage pixels
//   alpha          the head's opacity, 0 while a cutaway holds and through
//                  a dissolve; the export drives the head's mask with the
//                  same number, so the two cannot disagree
//   headHidden     this layout has no camera at all — the painter reads it
//                  to give titles the whole stage instead of a column
//                  beside a head that is not there
//   settled        nothing is mid-transition at t
//
// The content rect snaps at the boundary; graphic cards carry their own
// entrances.
export function layoutAt(timeline, t, videoAspect, stage = DEFAULT_STAGE) {
  if (timeline.length === 0) {
    const only = layoutRects("focus", null, videoAspect, stage);
    return { video: only.video, content: only.content, fit: only.fit, alpha: 1, headHidden: false, settled: true };
  }
  let index = timeline.findIndex((segment) => t >= segment.start && t < segment.end);
  if (index < 0) index = t < timeline[0].start ? 0 : timeline.length - 1;
  const segment = timeline[index];
  const rects = layoutRects(segment.layout, segment.corner, videoAspect, stage);
  const here = {
    video: rects.video,
    content: rects.content,
    fit: rects.fit,
    alpha: layoutAlpha(segment.layout),
    headHidden: segment.layout === "cutaway",
    settled: true,
  };
  // Leaving: the first half of the next boundary's dissolve happens here,
  // while this segment's rectangles still hold.
  const next = timeline[index + 1];
  if (next) {
    const { leave } = transitionAt(timeline, index + 1);
    if (leave > 0 && t >= next.start - leave) {
      return { ...here, alpha: here.alpha * (1 - smoothstep((t - (next.start - leave)) / leave)), settled: false };
    }
  }
  // Entering.
  if (index > 0) {
    const since = t - segment.start;
    const { enter, glide } = transitionAt(timeline, index);
    if (enter > 0 && since < enter) {
      return { ...here, alpha: here.alpha * smoothstep(since / enter), settled: false };
    }
    if (glide > 0 && since < glide) {
      const previous = timeline[index - 1];
      const from = layoutRects(previous.layout, previous.corner, videoAspect, stage);
      return { ...here, video: lerpRect(from.video, rects.video, smootherstep(since / glide)), settled: false };
    }
  }
  return here;
}
