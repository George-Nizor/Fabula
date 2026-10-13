// The thumbnail kit: the best real material from a finished film, for whoever designs its
// thumbnail and its vertical cover.
//
// A thumbnail is won or lost on the face, and the face the person uploads to a designer is
// usually a webcam grab looking away. The film already holds better ones: the moment the speaker
// laughed, the raised eyebrows before the number, the look straight down the lens. This finds
// them, from material the film actually shows and never from footage the cut removed (a
// thumbnail must not show what the video does not), and hands them over with the screen frames,
// the pictures the scenes show, the speaker's own hook lines, the chapters and the look, as one
// folder in a format both sides agree on (Instrumenta/docs/suite/thumbnail-uplift.md, schema v1).
//
// Everything here is pure: the two timelines, the pixel measures, the reading of a face from the
// analyser's numbers, the scores, the tags, the choice of frames, the hooks, and the kit's own
// validation. scripts/thumbnail-kit.mjs does the decoding, the model and the writing.

import { readStory, numberIn } from "./story-engine.mjs";
import { sentences } from "./clip-engine.mjs";

export const KIT_KIND = "instrumenta.thumbnail-kit";
export const KIT_SCHEMA_VERSION = 1;
export const KIT_DIR = "thumbnail-kit";
export const KIT_LIMITS = { faces: 12, screens: 6, pictures: 12, hooks: 6, colours: 8 };
// Picked face frames that look alike are this far apart on the film's clock: twelve takes of one
// smile are one frame. One that is clearly different (another reading of the face, or a gesture
// the other lacks) may sit as close as MIN_DISTINCT_GAP_SECONDS: the finger guns two seconds after
// the hello are a second thumbnail, not a second take.
export const MIN_FACE_GAP_SECONDS = 8;
export const MIN_DISTINCT_GAP_SECONDS = 2;
export const MIN_SCREEN_GAP_SECONDS = 4;
export const FACE_TAGS = ["smile", "laugh", "surprise", "intense", "speaking", "pointing", "neutral"];
export const HOOK_KINDS = ["promise", "claim", "number", "question", "quote"];
export const SIGNAL_NAMES = ["eyesOpen", "smile", "mouthOpen", "browRaise", "yaw", "pitch", "sharpness", "exposure", "faceHeight"];
const SAFE_LEAF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const PICTURE_FILE = /\.(png|jpe?g|webp)$/i;
const FORMATS = new Set(["landscape", "vertical", "square"]);

const clamp01 = (v) => Math.min(Math.max(v, 0), 1);
const round = (v, places = 2) => Number(v.toFixed(places));
const mean = (...values) => values.reduce((sum, v) => sum + (v ?? 0), 0) / values.length;

// ---- The two timelines ----
//
// Frames are found in the recording; the kit speaks the film's time. out/clean-map.json's pieces
// are the dictionary: each kept stretch of the recording [start, end] and where it lands on the
// clean timeline [cleanStart, cleanEnd], with the head and screen rectangles it was framed with.
// A frame within EDGE of a piece's edge is treated as outside: the first frame after a cut and
// the last before it are the ones most likely to be the cut-out moment's neighbour.
export const EDGE_SECONDS = 0.05;

export function pieceAt(pieces, raw, margin = EDGE_SECONDS) {
  for (const piece of pieces ?? []) {
    if (raw >= piece.start + margin && raw <= piece.end - margin) return piece;
  }
  return null;
}

// Where a moment of the recording lands in the film, or null when the film does not show it.
export function cleanTimeOf(pieces, raw, margin = EDGE_SECONDS) {
  const piece = pieceAt(pieces, raw, margin);
  return piece ? piece.cleanStart + (raw - piece.start) : null;
}

const rectKey = (rect) => (rect ? `${rect.x},${rect.y},${rect.w},${rect.h}` : null);

// The kept stretches of the recording grouped by the rectangle that frames them (`head` or
// `screen`), merged where two pieces touch: each group is one crop to decode.
export function keptRegions(pieces, which = "head", margin = EDGE_SECONDS) {
  const groups = new Map();
  for (const piece of pieces ?? []) {
    const rect = piece[which];
    if (!rect || piece.end - piece.start <= margin * 2) continue;
    const key = rectKey(rect);
    if (!groups.has(key)) groups.set(key, { rect, intervals: [] });
    const list = groups.get(key).intervals;
    const start = piece.start + margin;
    const end = piece.end - margin;
    const last = list.at(-1);
    if (last && start <= last.end + 2 * margin + 1e-6) last.end = Math.max(last.end, end);
    else list.push({ start, end });
  }
  return [...groups.values()];
}

// The window a fine look takes around a promising moment, kept inside the piece that holds it.
export function fineWindow(pieces, raw, half = 0.6, margin = EDGE_SECONDS) {
  const piece = pieceAt(pieces, raw, margin);
  if (!piece) return null;
  const start = Math.max(raw - half, piece.start + margin);
  const end = Math.min(raw + half, piece.end - margin);
  return end > start ? { start, end, piece } : null;
}

// ---- Pixels ----

// Luma from packed RGB, the way a JPEG would weigh it.
export function lumaOf(rgb, width, height) {
  const gray = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < gray.length; i += 1, j += 3) gray[i] = (rgb[j] * 77 + rgb[j + 1] * 150 + rgb[j + 2] * 29) >> 8;
  return gray;
}

// A region resampled (box average) to `size` pixels tall, so a measure of detail means the same
// thing for a face that fills the frame and one in a corner inset.
function resample(gray, width, height, rect, size, outWidth = null) {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.h));
  const rw = Math.max(1, x1 - x0);
  const rh = Math.max(1, y1 - y0);
  const oh = Math.max(2, Math.min(size, rh));
  const ow = outWidth ?? Math.max(2, Math.round((rw / rh) * oh));
  const out = new Float32Array(ow * oh);
  for (let oy = 0; oy < oh; oy += 1) {
    const sy0 = y0 + Math.floor((oy * rh) / oh);
    const sy1 = Math.max(sy0 + 1, y0 + Math.floor(((oy + 1) * rh) / oh));
    for (let ox = 0; ox < ow; ox += 1) {
      const sx0 = x0 + Math.floor((ox * rw) / ow);
      const sx1 = Math.max(sx0 + 1, x0 + Math.floor(((ox + 1) * rw) / ow));
      let sum = 0;
      for (let y = sy0; y < sy1; y += 1) for (let x = sx0; x < sx1; x += 1) sum += gray[y * width + x];
      out[oy * ow + ox] = sum / ((sy1 - sy0) * (sx1 - sx0));
    }
  }
  return { data: out, width: ow, height: oh };
}

// Variance of the Laplacian over a region at 128 pixels tall: the usual focus measure. Motion
// blur and a soft focus flatten it; a sharp eye and eyelash raise it.
export function laplacianVariance(gray, width, height, rect, size = 128) {
  const r = resample(gray, width, height, rect, size);
  let sum = 0; let sq = 0; let n = 0;
  for (let y = 1; y < r.height - 1; y += 1) {
    for (let x = 1; x < r.width - 1; x += 1) {
      const i = y * r.width + x;
      const v = r.data[i - 1] + r.data[i + 1] + r.data[i - r.width] + r.data[i + r.width] - 4 * r.data[i];
      sum += v; sq += v * v; n += 1;
    }
  }
  if (n === 0) return 0;
  const m = sum / n;
  return Math.max(sq / n - m * m, 0);
}

// Sharpness 0..1 from the variance: half way at SHARP_HALF, about where a face at 128 px starts
// to look soft once it is enlarged for a thumbnail.
export const SHARP_HALF = 250;
export const sharpnessOf = (variance) => round(variance / (variance + SHARP_HALF));

// How bright a region is, 0..1, and how much of it is clipped to black or white.
export function exposureOf(gray, width, height, rect) {
  const x0 = Math.max(0, Math.floor(rect.x)); const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.w)); const y1 = Math.min(height, Math.ceil(rect.y + rect.h));
  let sum = 0; let clipped = 0; let n = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const v = gray[y * width + x];
      sum += v; n += 1;
      if (v <= 8 || v >= 247) clipped += 1;
    }
  }
  return n ? { exposure: round(sum / n / 255), clipped: round(clipped / n) } : { exposure: 0, clipped: 1 };
}

// A difference hash of a whole picture (9×8 samples, 64 bits as hex): two screen frames a few
// bits apart are the same screen.
export function dhash(gray, width, height) {
  const r = resample(gray, width, height, { x: 0, y: 0, w: width, h: height }, 8, 9);
  let bits = "";
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) bits += r.data[y * 9 + x] < r.data[y * 9 + x + 1] ? "1" : "0";
  }
  return BigInt(`0b${bits}`).toString(16).padStart(16, "0");
}

export function hamming(a, b) {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

// A picture's light as 16 bins summing to 1. Scrolling a page moves every row and so every bit of
// its hash, but leaves its histogram nearly where it was: the hash says "the same picture", the
// histogram "the same page".
export function histogramOf(gray) {
  const bins = new Array(16).fill(0);
  for (let i = 0; i < gray.length; i += 1) bins[gray[i] >> 4] += 1;
  return bins.map((n) => round(n / Math.max(gray.length, 1), 4));
}

export const histogramSimilarity = (a, b) => a.reduce((sum, v, i) => sum + Math.min(v, b[i] ?? 0), 0);

// How much is drawn on a screen frame: mean gradient. A blank desktop is low, a page of code high.
export function detailOf(gray, width, height) {
  let sum = 0; let n = 0;
  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const i = y * width + x;
      sum += Math.abs(gray[i + 1] - gray[i]) + Math.abs(gray[i + width] - gray[i]);
      n += 1;
    }
  }
  return n ? sum / n / 255 : 0;
}

// Where to measure a head crop when nothing says where the face is: the middle of the frame,
// upper part, where a talking head's face sits.
export const centreRegion = (width, height) => ({ x: width * 0.3, y: height * 0.12, w: width * 0.4, h: height * 0.6 });

// ---- Reading a face ----
//
// The analyser (scripts/face-analyse.py) answers with MediaPipe's 52 blendshape scores and the
// head's pose. These are the few numbers a thumbnail turns on, in the kit's vocabulary. Every
// signal is 0..1 except yaw and pitch (degrees, 0 facing the lens); what the analyser could not
// say is left out, never filled in.
export function faceSignals(analysis, stats = {}, frameHeight = null) {
  const out = {};
  const b = analysis?.blendshapes ?? null;
  if (b && Object.keys(b).length) {
    out.eyesOpen = round(clamp01(1 - Math.max(b.eyeBlinkLeft ?? 0, b.eyeBlinkRight ?? 0)));
    out.smile = round(clamp01(mean(b.mouthSmileLeft, b.mouthSmileRight)));
    out.mouthOpen = round(clamp01(b.jawOpen ?? 0));
    out.browRaise = round(clamp01(Math.max(b.browInnerUp ?? 0, mean(b.browOuterUpLeft, b.browOuterUpRight))));
  }
  if (analysis?.pose && Number.isFinite(analysis.pose.yaw)) out.yaw = Math.round(analysis.pose.yaw);
  if (analysis?.pose && Number.isFinite(analysis.pose.pitch)) out.pitch = Math.round(analysis.pose.pitch);
  if (Number.isFinite(stats.sharpness)) out.sharpness = round(clamp01(stats.sharpness));
  if (Number.isFinite(stats.exposure)) out.exposure = round(clamp01(stats.exposure));
  if (analysis?.face && frameHeight) out.faceHeight = round(clamp01(analysis.face.h / frameHeight));
  return out;
}

// The few readings beyond the schema's signals that the score and the tags need: where the eyes
// look, a furrowed brow, wide eyes. Internal, never written into the kit.
export function faceExtras(analysis) {
  const b = analysis?.blendshapes ?? {};
  return {
    gazeAway: round(clamp01(Math.max(
      mean(b.eyeLookDownLeft, b.eyeLookDownRight),
      mean(b.eyeLookUpLeft, b.eyeLookUpRight),
      mean(b.eyeLookOutLeft, b.eyeLookInRight),
      mean(b.eyeLookInLeft, b.eyeLookOutRight),
    ))),
    browDown: round(clamp01(mean(b.browDownLeft, b.browDownRight))),
    eyeWide: round(clamp01(mean(b.eyeWideLeft, b.eyeWideRight))),
    squint: round(clamp01(mean(b.eyeSquintLeft, b.eyeSquintRight))),
  };
}

// What the hands are doing, from the Hand Landmarker's 21 points per hand (normalised to the
// frame): a hand over the middle of the face (a finger at the nose, a palm over the mouth) spoils
// a thumbnail, and an index finger pointing with the others curled is the `pointing` tag. A hand
// at the temple or on top of the head is neither: the face stays clear. A hand that reaches up
// to the face's height or above is `raised`: hands on the head, a wave, a shrug, finger guns.
const TIPS = [4, 8, 12, 16, 20];
export function handFeatures(analysis, width, height) {
  const out = { handOverFace: false, pointing: false, raised: false };
  const face = analysis?.face;
  for (const hand of analysis?.hands ?? []) {
    if (!Array.isArray(hand) || hand.length < 21) continue;
    const at = (i) => [hand[i][0] * width, hand[i][1] * height];
    const d = (a, b) => Math.hypot(at(a)[0] - at(b)[0], at(a)[1] - at(b)[1]);
    // A finger that is straight and as long as the palm, the others folded in toward the wrist,
    // and the tip clear of the face: a finger resting on the cheek or the nose is not pointing.
    const extended = d(0, 8) > d(0, 6) * 1.25 && d(5, 8) > d(0, 5) * 0.8;
    const folded = [[9, 12], [13, 16], [17, 20]].every(([mcp, tip]) => d(0, tip) < d(0, mcp) * 1.2);
    const clear = !face || (() => {
      const [x, y] = at(8);
      const m = face.w * 0.25;
      return x < face.x - m || x > face.x + face.w + m || y < face.y - m || y > face.y + face.h + m;
    })();
    if (extended && folded && clear) out.pointing = true;
    if (face && Math.min(...hand.map((point) => point[1] * height)) < face.y + face.h) out.raised = true;
    if (face) {
      const x0 = face.x + face.w * 0.2; const x1 = face.x + face.w * 0.8;
      const y0 = face.y + face.h * 0.3; const y1 = face.y + face.h;
      if ([...TIPS, 6, 10].some((i) => { const [x, y] = at(i); return x >= x0 && x <= x1 && y >= y0 && y <= y1; })) out.handOverFace = true;
    }
  }
  return out;
}

// Tags from the fixed vocabulary, the face's main reading first. `speaking` is the transcript's
// word at that instant with the mouth moving, not a guess at the face; `pointing` is the hands.
export const TAG_RULES = {
  laugh: { smile: 0.45, mouthOpen: 0.2 },
  smile: { smile: 0.3 },
  surprise: { browRaise: 0.4, mouthOpen: 0.15, eyeWide: 0.3, browsAlone: 0.55, smileUnder: 0.25 },
  intense: { browDown: 0.3 },
  speaking: { mouthOpen: 0.06 },
};

export function faceTags(signals, extras = {}, { speaking = false, pointing = false } = {}) {
  if (signals.smile === undefined) return [];
  const t = TAG_RULES;
  let reading = "neutral";
  if (signals.smile >= t.laugh.smile && signals.mouthOpen >= t.laugh.mouthOpen) reading = "laugh";
  else if (signals.smile >= t.smile.smile) reading = "smile";
  else if (signals.smile < t.surprise.smileUnder && signals.browRaise >= t.surprise.browRaise
    && (signals.mouthOpen >= t.surprise.mouthOpen || (extras.eyeWide ?? 0) >= t.surprise.eyeWide || signals.browRaise >= t.surprise.browsAlone)) reading = "surprise";
  else if ((extras.browDown ?? 0) >= t.intense.browDown) reading = "intense";
  else if (speaking && signals.mouthOpen >= t.speaking.mouthOpen) reading = "speaking";
  const tags = pointing ? ["pointing", reading] : [reading];
  if (speaking && reading !== "speaking" && reading !== "neutral") tags.push("speaking");
  return [...new Set(tags)];
}

// ---- Scoring ----
//
// A frame earns its place by reading at a glance in a feed. Three things, each 0..1:
//
//   expression  something on the face: a smile, a laugh, raised brows, a frown, a point;
//   contact     eyes open, the head toward the lens and the eyes on it;
//   quality     sharp, lit, and enough real pixels of face to survive being enlarged.
//
// Contact multiplies rather than adds: the best laugh in the film looking off to one side is a
// weaker thumbnail than a good smile straight down the lens. A hand over the middle of the face
// costs a third. A frame that fails outright (eyes shut, face turned away, no face, a smear) is
// refused with its reason rather than scored low.
export const FACE_REFUSE = { blink: 0.55, yaw: 38, pitch: 32, faceHeight: 0.12, sharpness: 0.25 };

export function expressionOf(signals, extras = {}, { pointing = false } = {}) {
  const smile = signals.smile ?? 0;
  const open = Math.min((signals.mouthOpen ?? 0) * 2, 1);
  const brows = signals.browRaise ?? 0;
  const laugh = Math.min(smile, open);
  const surprise = Math.min(brows, Math.max(extras.eyeWide ?? 0, open, brows >= 0.55 ? 0.55 : 0));
  const intense = extras.browDown ?? 0;
  // A mouth open in the middle of a word is the weakest reading: a phoneme frozen mid-shape
  // looks odd more often than it looks animated.
  const strongest = Math.max(smile, 0.9 * surprise + 0.1 * brows, 0.7 * intense, 0.35 * open);
  return clamp01(strongest + 0.25 * laugh + (pointing ? 0.2 : 0));
}

// A real smile narrows the eyes, and the model reads narrowed eyes as half closed and as looking
// away; so the more the face smiles, the more of both is forgiven before contact suffers.
export function contactOf(signals, extras = {}) {
  const blink = 1 - (signals.eyesOpen ?? 0);
  const smile = signals.smile ?? 0;
  const eyes = clamp01(1 - Math.max(blink - (0.2 + 0.15 * smile), 0) / 0.35);
  const pose = clamp01(1 - Math.max(Math.abs(signals.yaw ?? 0) - 10, 0) / 30) * clamp01(1 - Math.max(Math.abs(signals.pitch ?? 0) - 10, 0) / 25);
  const gaze = 1 - 0.45 * clamp01(((extras.gazeAway ?? 0) - (0.3 + 0.1 * smile)) / 0.4);
  return eyes * pose * gaze;
}

export function qualityOf(signals, facePixels = null) {
  const sharp = clamp01(((signals.sharpness ?? 0.55) - 0.3) / 0.4);
  const light = clamp01(1 - Math.abs((signals.exposure ?? 0.5) - 0.5) / 0.35);
  // Big in the frame, and enough real pixels: a 1280-wide thumbnail with the face at half its
  // height wants about 400 of them.
  const pixels = clamp01((signals.faceHeight ?? 0.3) / 0.3) * (facePixels ? clamp01(facePixels / 400) : 1);
  return 0.45 * sharp + 0.15 * light + 0.4 * pixels;
}

export function scoreFace({ signals, extras = {}, facePixels = null, hands = {} }) {
  if (signals.eyesOpen === undefined) return { refused: "no face" };
  if (1 - signals.eyesOpen >= FACE_REFUSE.blink) return { refused: "eyes closing" };
  if (Math.abs(signals.yaw ?? 0) > FACE_REFUSE.yaw) return { refused: "face turned away" };
  if (Math.abs(signals.pitch ?? 0) > FACE_REFUSE.pitch) return { refused: "head tipped too far" };
  if ((signals.faceHeight ?? 1) < FACE_REFUSE.faceHeight) return { refused: "face too small" };
  if ((signals.sharpness ?? 1) < FACE_REFUSE.sharpness) return { refused: "blurred" };
  const parts = {
    expression: expressionOf(signals, extras, { pointing: hands.pointing }),
    contact: contactOf(signals, extras),
    quality: qualityOf(signals, facePixels),
  };
  const score = (0.6 * parts.expression + 0.4 * parts.quality) * (0.2 + 0.8 * parts.contact) * (hands.handOverFace ? 0.65 : 1);
  return { score: round(score, 3), parts };
}

// Without the face analyser: sharpness and light in the middle of the head region, and the
// region's own resolution (a camera filling the recording beats a corner inset), and nothing
// claimed about the face.
export function scorePlain({ signals, frameHeight = null }) {
  const sharp = clamp01(((signals.sharpness ?? 0.6) - 0.4) / 0.5);
  const light = clamp01(1 - Math.abs((signals.exposure ?? 0.5) - 0.5) / 0.35);
  const pixels = frameHeight ? clamp01(frameHeight / 1080) : 0.5;
  return { score: round(0.55 * sharp + 0.2 * light + 0.25 * pixels, 3), parts: { sharpness: sharp, exposure: light, pixels } };
}

// ---- Choosing ----
//
// Two frames look alike when they make the same gesture (none, pointing, hands raised) and either
// carry the same main tag or read nearly the same: smile, open mouth and brows within a quarter,
// head within twelve degrees. A tag that flickers between smile and laugh over one moment is still
// one look; a different gesture never is. Frames the analyser could not read look alike to
// everything, so without it the plain eight seconds hold.
const gestureOf = (c) => (c.hands?.pointing ? "pointing" : c.hands?.raised ? "raised" : "none");

export function looksAlike(a, b) {
  if (gestureOf(a) !== gestureOf(b)) return false;
  const tagA = a.tags?.[0] ?? null;
  const tagB = b.tags?.[0] ?? null;
  if (tagA === tagB) return true;
  const s = a.signals ?? {};
  const t = b.signals ?? {};
  if (s.smile === undefined || t.smile === undefined) return true;
  const near = (key, within) => Math.abs((s[key] ?? 0) - (t[key] ?? 0)) <= within;
  return near("smile", 0.25) && near("mouthOpen", 0.25) && near("browRaise", 0.25) && near("yaw", 12) && near("pitch", 12);
}

export const faceGap = (a, b, { minGap = MIN_FACE_GAP_SECONDS, distinctGap = MIN_DISTINCT_GAP_SECONDS } = {}) => (looksAlike(a, b) ? minGap : distinctGap);

// Best first, spread over the film's clock (MIN_FACE_GAP_SECONDS between frames that look alike,
// MIN_DISTINCT_GAP_SECONDS between ones that do not), and spread over the tags: each frame
// already picked with a tag costs the next one with it a fifth of its score, so a film full of
// smiles still yields its one surprised look if it has a decent one. A frame under 60% of the
// best score is not worth a slot however empty its tag is: fewer good frames beat twelve.
export function selectFaces(candidates, { limit = KIT_LIMITS.faces, minGap = MIN_FACE_GAP_SECONDS, distinctGap = MIN_DISTINCT_GAP_SECONDS, decay = 0.8, floor = 0.6 } = {}) {
  const pool = candidates.filter((c) => Number.isFinite(c.score) && Number.isFinite(c.atSeconds));
  if (!pool.length) return [];
  const best = Math.max(...pool.map((c) => c.score));
  const eligible = pool.filter((c) => c.score >= best * floor);
  const picks = [];
  const used = new Map();
  while (picks.length < limit) {
    let choice = null;
    let value = -Infinity;
    for (const candidate of eligible) {
      if (picks.includes(candidate)) continue;
      if (picks.some((p) => Math.abs(p.atSeconds - candidate.atSeconds) < faceGap(p, candidate, { minGap, distinctGap }))) continue;
      const tag = candidate.tags?.[0] ?? "untagged";
      const adjusted = candidate.score * decay ** (used.get(tag) ?? 0);
      if (adjusted > value || (adjusted === value && candidate.atSeconds < choice.atSeconds)) { value = adjusted; choice = candidate; }
    }
    if (!choice) break;
    picks.push(choice);
    const tag = choice.tags?.[0] ?? "untagged";
    used.set(tag, (used.get(tag) ?? 0) + 1);
  }
  return picks.sort((a, b) => b.score - a.score || a.atSeconds - b.atSeconds);
}

// Where to look closer: the most promising coarse moments, scored as if the eyes were open (the
// keyframe may have caught a blink in the middle of a good moment), a few seconds apart.
export function fineCentres(candidates, { count = 24, spacing = 3 } = {}) {
  const ranked = candidates
    .filter((c) => Number.isFinite(c.potential))
    .sort((a, b) => b.potential - a.potential || a.raw - b.raw);
  const out = [];
  for (const candidate of ranked) {
    if (out.length >= count) break;
    if (out.some((c) => Math.abs(c.raw - candidate.raw) < spacing)) continue;
    out.push(candidate);
  }
  return out;
}

// Screen frames: distinct pictures of the screen, the detailed ones first and the ones the film
// actually puts on the stage before the ones it leaves under the head. Two frames a few bits of
// hash apart, or with nearly the same histogram (the same page scrolled), are one screen; the
// better is kept.
export function sameScreen(a, b, { distinct = 10, alike = 0.9 } = {}) {
  if (a.hash && b.hash && hamming(a.hash, b.hash) <= distinct) return true;
  return Boolean(a.histogram && b.histogram && histogramSimilarity(a.histogram, b.histogram) >= alike);
}

export function selectScreens(candidates, { limit = KIT_LIMITS.screens, minGap = MIN_SCREEN_GAP_SECONDS, distinct = 10, alike = 0.9 } = {}) {
  const ranked = [...candidates].sort((a, b) => b.score - a.score || a.atSeconds - b.atSeconds);
  const picks = [];
  for (const candidate of ranked) {
    if (picks.length >= limit) break;
    if (picks.some((p) => Math.abs(p.atSeconds - candidate.atSeconds) < minGap)) continue;
    if (picks.some((p) => sameScreen(p, candidate, { distinct, alike }))) continue;
    picks.push(candidate);
  }
  return picks.sort((a, b) => a.atSeconds - b.atSeconds);
}

export const scoreScreen = ({ detail, shown }) => round(clamp01(detail / 0.12) * 0.7 + (shown ? 0.3 : 0), 3);

// ---- Pictures the film shows ----
//
// A picture is shown when a scene puts it on the stage: an image card, an item in a card, or a
// name a custom card or a motion scene loads. Motion scenes often build the name (`sprite-${id}.png`),
// so a template's fixed ends match the assets that fit them; those rank after the pictures named
// outright, which rank after the ones placed as cards.
export function pictureRefs(text, names) {
  const body = String(text ?? "");
  const found = new Map();
  for (const name of names) if (body.includes(name)) found.set(name, "named");
  for (const match of body.matchAll(/([A-Za-z0-9._-]*)\$\{[^}]{1,80}\}([A-Za-z0-9._-]*\.(?:png|jpe?g|webp))/gi)) {
    const [, prefix, suffix] = match;
    if (!prefix && suffix.length < 6) continue;
    for (const name of names) {
      if (found.has(name)) continue;
      if (name.length > prefix.length + suffix.length && name.startsWith(prefix) && name.endsWith(suffix)) found.set(name, "pattern");
    }
  }
  return [...found.entries()].map(([name, how]) => ({ name, how }));
}

const RANK = { card: 0, named: 1, pattern: 2 };

// `scenes` are resolved (start in seconds on the clean timeline); `assets` are the project's
// pictures [{ name, width, height }]; `textOf(scene)` is a custom card's markup or a motion
// scene's document with the libraries it loads. Strips (a sprite sheet is a row of frames) and
// specks are not pictures anyone can put on a thumbnail as they are.
export function picturesShown(scenes, assets, textOf = () => "", { limit = KIT_LIMITS.pictures } = {}) {
  const usable = new Map(assets.filter((a) => PICTURE_FILE.test(a.name) && a.width >= 64 && a.height >= 64 && a.width / a.height <= 3.5 && a.height / a.width <= 3.5).map((a) => [a.name, a]));
  const seen = new Map();
  const note = (name, how, at) => {
    if (!usable.has(name)) return;
    const prior = seen.get(name);
    if (!prior || RANK[how] < RANK[prior.how] || (RANK[how] === RANK[prior.how] && at < prior.atSeconds)) seen.set(name, { name, how, atSeconds: prior ? Math.min(prior.atSeconds, at) : at });
    else if (at < prior.atSeconds) prior.atSeconds = at;
  };
  const leaf = (src) => String(src ?? "").replace(/^assets\//, "");
  for (const scene of scenes ?? []) {
    const g = scene.graphic;
    if (!g) continue;
    const at = scene.start ?? 0;
    if (g.src && g.kind === "image") note(leaf(g.src), "card", at);
    for (const item of g.items ?? []) if (item?.src) note(leaf(item.src), "card", at);
    if (g.kind === "custom" || g.kind === "motion") {
      for (const ref of pictureRefs(textOf(scene), [...usable.keys()])) note(ref.name, ref.how, at);
    }
  }
  return [...seen.values()]
    .sort((a, b) => RANK[a.how] - RANK[b.how] || a.atSeconds - b.atSeconds || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((p) => ({ ...usable.get(p.name), how: p.how, atSeconds: round(p.atSeconds) }));
}

// A picture's size from its own header, so reading the project's pictures needs no ffprobe: PNG's
// IHDR, the first JPEG frame header, or WebP's VP8, VP8L or VP8X chunk. Null when it is none of
// those or is cut short.
export function imageSize(bytes) {
  const b = bytes;
  if (!b || b.length < 30) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let at = 2;
    while (at + 9 < b.length) {
      if (b[at] !== 0xff) { at += 1; continue; }
      const marker = b[at + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
      const length = b.readUInt16BE(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: b.readUInt16BE(at + 7), height: b.readUInt16BE(at + 5) };
      at += 2 + length;
    }
    return null;
  }
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const chunk = b.toString("ascii", 12, 16);
    if (chunk === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") return { width: 1 + (((b[22] & 0x3f) << 8) | b[21]), height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) };
    if (chunk === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  }
  return null;
}

// The credit a picture carries, from Fabula's <name>.source.json beside it.
export function pictureCredit(source) {
  if (!source || typeof source !== "object") return { credit: null, license: null };
  const text = (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null);
  return { credit: text(source.author) ?? text(source.credit), license: text(source.license) };
}

// ---- The story ----

// What is being said around a moment, as the speaker said it.
export function wordsAround(words, at, half = 1.5, max = 16) {
  const inside = (words ?? []).filter((w) => w.end >= at - half && w.start <= at + half);
  if (!inside.length) return "";
  let picked = inside;
  if (picked.length > max) {
    const centre = picked.reduce((best, w, i) => (Math.abs((w.start + w.end) / 2 - at) < Math.abs((picked[best].start + picked[best].end) / 2 - at) ? i : best), 0);
    const from = Math.max(0, Math.min(centre - Math.floor(max / 2), picked.length - max));
    picked = picked.slice(from, from + max);
  }
  return picked.map((w) => w.text).join(" ").replace(/\s+([,.;:!?])/g, "$1").trim();
}

export const speakingAt = (words, at) => (words ?? []).some((w) => w.start <= at && at <= w.end);

// A hook line is a sentence a thumbnail could carry: the speaker's own, short enough to read in a
// glance. The opening's promise first (read_story's reading of the first twenty seconds; a film
// that promises nothing there gets no promise rather than an invented one), then the sentences
// read_story marks as a number, a claim, a question or a quote. Its number detector also runs over
// the two-word sentences read_story leaves out as too short for a card, because "It's $30." is
// exactly the length of a thumbnail. Complete sentences that start like one rank first, then the
// shorter; the kinds take turns, so six hooks are not six numbers. A long sentence is cut to a
// clause (for a number, the clause that holds it, with the one before when it needs the
// context), never rewritten; a sentence trailing off ("months of actual...") is not a hook.
const HOOK_PRIORITY = ["number", "claim", "question", "quote"];
const HOOK_MAX_WORDS = 14;

const wordCount = (text) => String(text).split(/\s+/).filter(Boolean).length;

export function hookText(text, { figure = null, max = HOOK_MAX_WORDS } = {}) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!clean || /(\.\.\.|…)$/.test(clean)) return null;
  if (wordCount(clean) <= max) return clean;
  const clauses = clean.split(/(?<=[,;:—–])\s+/);
  let at = figure ? clauses.findIndex((clause) => clause.includes(figure)) : 0;
  if (at < 0) return null;
  let line = clauses[at];
  while (wordCount(line) < 6 && at > 0) { at -= 1; line = `${clauses[at]} ${line}`; }
  line = line.replace(/[,;:—–]$/, "").trim();
  const words = wordCount(line);
  return words >= 2 && words <= max ? line : null;
}

function hookRank(hook) {
  const complete = /[.!?]["')\]]?$/.test(hook.text) ? 2 : 0;
  const opens = /^[A-Z0-9$"']/.test(hook.text) ? 1 : 0;
  return complete + opens - wordCount(hook.text) / 10;
}

export function kitHooks(words, { limit = KIT_LIMITS.hooks } = {}) {
  if (!words?.length) return [];
  const story = readStory(words, { limit: 200 });
  const out = [];
  const seen = new Set();
  const promise = story.opening?.hook;
  if (promise) {
    const text = hookText(promise.text);
    if (text) { out.push({ text, atSeconds: round(promise.at), kind: "promise" }); seen.add(promise.fromWordId); }
  }
  const found = story.moments.filter((m) => HOOK_PRIORITY.includes(m.kind));
  for (const sentence of sentences(words)) {
    if (sentence.words.length >= 3 || sentence.words.length < 2) continue;
    const evidence = numberIn(sentence.text);
    if (evidence) found.push({ kind: "number", text: sentence.text, start: sentence.start, fromWordId: sentence.fromWordId, evidence });
  }
  const byKind = new Map(HOOK_PRIORITY.map((kind) => [kind, []]));
  // One sentence is one hook, under the first kind in HOOK_PRIORITY that claims it.
  for (const kind of HOOK_PRIORITY) {
    for (const moment of found.filter((m) => m.kind === kind)) {
      if (seen.has(moment.fromWordId)) continue;
      const figure = kind === "number" ? (String(moment.text).match(/\$?\d[\d,.]*%?/)?.[0] ?? null) : null;
      const text = hookText(moment.text, { figure });
      // A cut sentence must still hold its figure; an uncut one was read as a number already.
      if (!text || (kind === "number" && text !== String(moment.text).replace(/\s+/g, " ").trim() && !numberIn(text))) continue;
      seen.add(moment.fromWordId);
      byKind.get(kind).push({ text, atSeconds: round(moment.start), kind });
    }
    byKind.get(kind).sort((a, b) => hookRank(b) - hookRank(a) || a.atSeconds - b.atSeconds);
  }
  while (out.length < limit && [...byKind.values()].some((list) => list.length)) {
    for (const kind of HOOK_PRIORITY) {
      if (out.length >= limit) break;
      const next = byKind.get(kind).shift();
      if (next) out.push(next);
    }
  }
  return out.slice(0, limit);
}

// The film's colours and faces, from its resolved theme.
export function kitStyle(theme) {
  const colours = [];
  const hex = (v) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toUpperCase() : null);
  for (const [role, value] of [["accent", theme?.accent], ["accent2", theme?.accent2], ["text", theme?.text], ["background", Array.isArray(theme?.field) ? theme.field[0] : theme?.field]]) {
    if (hex(value)) colours.push({ role, hex: hex(value) });
  }
  const fonts = {};
  for (const role of ["display", "body"]) if (typeof theme?.fonts?.[role] === "string" && theme.fonts[role].trim()) fonts[role] = theme.fonts[role].trim();
  return { colours, fonts };
}

// ---- The kit's own check ----
//
// What Fabula writes it reads back by the rules a reader applies, before the folder replaces the
// last one: a kit that would be refused is never delivered. `fileSize(rel)` answers the size of a
// file in the new folder (0 or null when absent).
export function safeLeaf(name) {
  return typeof name === "string" && SAFE_LEAF.test(name) && !name.includes("..");
}

export function kitFilePath(file, folder) {
  if (typeof file !== "string") return false;
  const parts = file.split("/");
  return parts.length === 2 && parts[0] === folder && safeLeaf(parts[1]);
}

export function validateKit(kit, { fileSize = null } = {}) {
  const fail = (why) => { throw new Error(`thumbnail kit: ${why}`); };
  if (!kit || typeof kit !== "object") fail("not an object");
  if (kit.kind !== KIT_KIND) fail(`kind must be ${KIT_KIND}`);
  if (kit.schemaVersion !== KIT_SCHEMA_VERSION) fail(`schemaVersion must be ${KIT_SCHEMA_VERSION}`);
  if (kit.producer?.app !== "fabula" || typeof kit.producer?.version !== "string") fail("producer names fabula and its version");
  if (Number.isNaN(Date.parse(kit.createdAt))) fail("createdAt is not a date");
  const source = kit.source ?? {};
  if (!FORMATS.has(source.format)) fail(`source.format ${source.format} is not landscape, vertical or square`);
  if (!(source.durationSeconds > 0)) fail("source.durationSeconds must be positive");
  const within = (t, what) => { if (!Number.isFinite(t) || t < 0 || t > source.durationSeconds + 0.5) fail(`${what} at ${t}s is outside the film (0–${source.durationSeconds}s)`); };
  const story = kit.story ?? fail("no story");
  if (!Array.isArray(story.hooks) || story.hooks.length > KIT_LIMITS.hooks) fail(`at most ${KIT_LIMITS.hooks} hooks`);
  for (const hook of story.hooks) {
    if (!HOOK_KINDS.includes(hook.kind)) fail(`hook kind ${hook.kind}`);
    if (typeof hook.text !== "string" || !hook.text.trim()) fail("a hook without words");
    within(hook.atSeconds, "a hook");
  }
  if (!Array.isArray(story.chapters)) fail("chapters must be a list");
  for (const chapter of story.chapters) { if (typeof chapter.title !== "string") fail("a chapter without a title"); within(chapter.atSeconds, "a chapter"); }
  const style = kit.style ?? fail("no style");
  if (!Array.isArray(style.colours) || style.colours.length > KIT_LIMITS.colours) fail("style.colours");
  for (const colour of style.colours) if (!/^#[0-9A-F]{6}$/.test(colour.hex ?? "") || typeof colour.role !== "string") fail(`colour ${JSON.stringify(colour)}`);
  if (!Array.isArray(kit.frames) || !Array.isArray(kit.pictures)) fail("frames and pictures must be lists");
  const faces = kit.frames.filter((f) => f.kind === "face");
  const screens = kit.frames.filter((f) => f.kind === "screen");
  if (faces.length + screens.length !== kit.frames.length) fail("a frame is face or screen");
  if (faces.length > KIT_LIMITS.faces) fail(`at most ${KIT_LIMITS.faces} face frames`);
  if (screens.length > KIT_LIMITS.screens) fail(`at most ${KIT_LIMITS.screens} screen frames`);
  if (kit.pictures.length > KIT_LIMITS.pictures) fail(`at most ${KIT_LIMITS.pictures} pictures`);
  const files = new Set();
  const checkFile = (file, folder, minBytes = 1) => {
    if (!kitFilePath(file, folder)) fail(`${JSON.stringify(file)} is not one safe file under ${folder}/`);
    if (files.has(file)) fail(`${file} is listed twice`);
    files.add(file);
    if (fileSize) { const size = fileSize(file); if (!(size >= minBytes)) fail(`${file} is missing or empty`); }
  };
  for (const frame of kit.frames) {
    checkFile(frame.file, "frames");
    if (!/\.jpg$/.test(frame.file)) fail(`${frame.file}: frames are JPEG`);
    if (!Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width < 16 || frame.height < 16) fail(`${frame.file}: width and height`);
    within(frame.atSeconds, frame.file);
    if (frame.kind === "face") {
      if (frame.face) {
        const f = frame.face;
        if (![f.x, f.y, f.w, f.h].every(Number.isFinite) || f.x < 0 || f.y < 0 || f.w <= 0 || f.h <= 0 || f.x + f.w > frame.width + 1 || f.y + f.h > frame.height + 1) fail(`${frame.file}: face box outside the frame`);
      }
      if (!Number.isFinite(frame.score) || frame.score < 0 || frame.score > 1) fail(`${frame.file}: score is 0..1`);
      for (const [name, value] of Object.entries(frame.signals ?? {})) {
        if (!SIGNAL_NAMES.includes(name)) fail(`${frame.file}: unknown signal ${name}`);
        if (name === "yaw" || name === "pitch") { if (!Number.isFinite(value) || Math.abs(value) > 180) fail(`${frame.file}: ${name} in degrees`); }
        else if (!Number.isFinite(value) || value < 0 || value > 1) fail(`${frame.file}: ${name} is 0..1`);
      }
      if (!Array.isArray(frame.tags) || frame.tags.some((tag) => !FACE_TAGS.includes(tag))) fail(`${frame.file}: tags come from ${FACE_TAGS.join(", ")}`);
    }
  }
  const sortedFaces = [...faces].sort((a, b) => a.atSeconds - b.atSeconds);
  for (let i = 1; i < sortedFaces.length; i += 1) {
    // The kit cannot show a gesture (hands raised is not a tag), so the reader's check is the
    // floor; whether two close frames really differ is the choice's business (looksAlike).
    if (sortedFaces[i].atSeconds - sortedFaces[i - 1].atSeconds < MIN_DISTINCT_GAP_SECONDS - 0.01) fail(`${sortedFaces[i].file} is under ${MIN_DISTINCT_GAP_SECONDS}s from ${sortedFaces[i - 1].file}`);
  }
  for (const picture of kit.pictures) {
    checkFile(picture.file, "pictures");
    if (!PICTURE_FILE.test(picture.file)) fail(`${picture.file}: pictures are PNG, JPEG or WebP`);
    if (!Number.isInteger(picture.width) || !Number.isInteger(picture.height)) fail(`${picture.file}: width and height`);
    for (const key of ["credit", "license"]) if (picture[key] !== null && typeof picture[key] !== "string") fail(`${picture.file}: ${key} is text or null`);
    if (picture.atSeconds !== undefined) within(picture.atSeconds, picture.file);
  }
  return kit;
}
