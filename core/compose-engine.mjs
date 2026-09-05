// Scene planning over the clean transcript. No I/O. Scenes are declarative
// and word-anchored — an agent writes "title over words 3–9" and never a
// second; seconds are derived here, once, and the same resolved structures
// feed the live preview and the export capture so they cannot disagree.

const CAPTION_HANG_SECONDS = 0.4;

// No node:path here — core stays runtime-neutral. Absolute means a leading
// slash or a Windows drive.
function path_isAbsoluteLike(p) {
  return p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\");
}

import { LAYOUTS, PIP_CORNERS } from "./stage-engine.mjs";
import { validateTheme as validateThemeConfig, TITLE_STYLES, CALLOUT_STYLES } from "./themes.mjs";

export const SCENE_TYPES = new Set(["title", "callout", "graphic", "stage", "kinetic"]);
export const GRAPHIC_KINDS = new Set(["chart", "stat", "list", "image", "screen", "quote", "compare", "steps", "ring", "logos", "cover", "section", "custom"]);
// What a custom graphic may not carry: anything that runs, loads, or
// navigates. Motion comes from the --p and --t variables the painter sets.
const CUSTOM_FORBIDDEN = [/<\s*script/i, /<\s*iframe/i, /<\s*object/i, /<\s*embed/i, /<\s*link/i, /@import/i, /javascript:/i, /\bon[a-z]+\s*=/i, /https?:\/\//i, /expression\s*\(/i];
export const IMAGE_MOTIONS = new Set(["tilt", "kenburns", "pop"]);
const ACCENT_RE = /^#[0-9a-fA-F]{6}$/;

export function validateTheme(theme) {
  validateThemeConfig(theme);
}

function assertImageSrc(src, at) {
  if (typeof src !== "string" || !/\.(png|jpe?g|webp)$/i.test(src)) {
    throw new Error(`${at}: needs a png/jpg/webp src`);
  }
  if (src.includes("..") || path_isAbsoluteLike(src)) {
    throw new Error(`${at}: src must be a project-relative path`);
  }
}

function assertItems(items, at, kind, { min = 1, max = 6, needValue = false, needSrc = false } = {}) {
  if (!Array.isArray(items) || items.length < min || items.length > max) {
    throw new Error(`${at}: ${kind} needs ${min}–${max} items`);
  }
  for (const item of items) {
    if (needSrc) assertImageSrc(item.src, at);
    else if (!item.label) throw new Error(`${at}: every item needs a label`);
    if (needValue && typeof item.value !== "number") throw new Error(`${at}: ${kind} items need numeric values`);
  }
}

function validateGraphic(graphic, at) {
  if (!graphic || typeof graphic !== "object") throw new Error(`${at}: graphic spec is required`);
  if (!GRAPHIC_KINDS.has(graphic.kind)) throw new Error(`${at}: unknown graphic kind "${graphic.kind}"`);
  // screen: the recording's own screen track in the content rect; nothing
  // to declare beyond an optional label. Whether a screen exists at that
  // moment is the render map's business, reported as a warning upstream.
  if (graphic.kind === "screen") return;
  if (graphic.kind === "image") {
    assertImageSrc(graphic.src, `${at}: image`);
    if (graphic.motion !== undefined && !IMAGE_MOTIONS.has(graphic.motion)) {
      throw new Error(`${at}: image motion must be one of ${[...IMAGE_MOTIONS].join(", ")}`);
    }
    return;
  }
  if (graphic.kind === "stat") {
    if (typeof graphic.value !== "number") throw new Error(`${at}: stat needs a numeric value`);
    if (!graphic.label) throw new Error(`${at}: stat needs a label`);
    return;
  }
  if (graphic.kind === "ring") {
    if (typeof graphic.value !== "number" || graphic.value < 0 || graphic.value > 100) throw new Error(`${at}: ring needs a value from 0 to 100`);
    if (!graphic.label) throw new Error(`${at}: ring needs a label`);
    return;
  }
  if (graphic.kind === "cover") {
    if (typeof graphic.title !== "string" || graphic.title.length === 0 || graphic.title.length > 80) throw new Error(`${at}: cover needs a title up to 80 characters`);
    if (graphic.src !== undefined) assertImageSrc(graphic.src, `${at}: cover`);
    if (graphic.tint !== undefined && !ACCENT_RE.test(graphic.tint)) throw new Error(`${at}: cover tint must be #rrggbb`);
    return;
  }
  if (graphic.kind === "section") {
    if (typeof graphic.title !== "string" || graphic.title.length === 0 || graphic.title.length > 60) throw new Error(`${at}: section needs a title up to 60 characters`);
    if (graphic.number !== undefined && String(graphic.number).length > 6) throw new Error(`${at}: section number is at most 6 characters`);
    return;
  }
  if (graphic.kind === "custom") {
    if (typeof graphic.html !== "string" || graphic.html.length === 0 || graphic.html.length > 20000) throw new Error(`${at}: custom needs html up to 20000 characters`);
    if (graphic.css !== undefined && (typeof graphic.css !== "string" || graphic.css.length > 10000)) throw new Error(`${at}: custom css is at most 10000 characters`);
    for (const rule of CUSTOM_FORBIDDEN) {
      if (rule.test(graphic.html) || rule.test(graphic.css ?? "")) throw new Error(`${at}: custom graphics may not contain ${rule.source.replace(/\\/g, "")}; no scripts, frames, external loads or handlers`);
    }
    return;
  }
  if (graphic.kind === "quote") {
    if (typeof graphic.text !== "string" || graphic.text.length === 0 || graphic.text.length > 220) {
      throw new Error(`${at}: quote needs text up to 220 characters`);
    }
    return;
  }
  if (graphic.kind === "compare") {
    for (const side of ["left", "right"]) {
      const column = graphic[side];
      if (!column || typeof column !== "object" || !column.title) throw new Error(`${at}: compare needs ${side}.title`);
      assertItems(column.items, `${at}: compare ${side}`, "compare", { min: 1, max: 5 });
    }
    return;
  }
  if (graphic.kind === "logos") {
    assertItems(graphic.items, at, "logos", { min: 1, max: 6, needSrc: true });
    return;
  }
  // chart, list, steps: labelled rows.
  assertItems(graphic.items, at, graphic.kind, { min: 1, max: graphic.kind === "steps" ? 5 : 6, needValue: graphic.kind === "chart" });
}

export function validateScenes(scenes, words) {
  const byId = new Map(words.map((word) => [word.id, word]));
  scenes.forEach((scene, index) => {
    const at = `scene ${index}`;
    if (!SCENE_TYPES.has(scene.type)) throw new Error(`${at}: unknown type "${scene.type}"`);
    if (!byId.has(scene.fromWordId) || !byId.has(scene.toWordId)) {
      throw new Error(`${at}: word ids must be 0–${words.length - 1}`);
    }
    if (byId.get(scene.toWordId).start < byId.get(scene.fromWordId).start) {
      throw new Error(`${at}: toWordId precedes fromWordId`);
    }
    if (scene.accent !== undefined && !ACCENT_RE.test(scene.accent)) {
      throw new Error(`${at}: accent must be #rrggbb`);
    }
    if (scene.type === "graphic") validateGraphic(scene.graphic, at);
    else if (scene.type === "title") {
      if (!scene.text || typeof scene.text !== "string") throw new Error(`${at}: text is required`);
      if (scene.style !== undefined && !TITLE_STYLES.has(scene.style)) throw new Error(`${at}: title style must be one of ${[...TITLE_STYLES].join(", ")}`);
      if (scene.subtitle !== undefined && typeof scene.subtitle !== "string") throw new Error(`${at}: subtitle must be text`);
    } else if (scene.type === "callout") {
      if (!scene.text || typeof scene.text !== "string") throw new Error(`${at}: text is required`);
      if (scene.style !== undefined && !CALLOUT_STYLES.has(scene.style)) throw new Error(`${at}: callout style must be one of ${[...CALLOUT_STYLES].join(", ")}`);
    } else if (scene.type === "stage") {
      if (!LAYOUTS.has(scene.layout)) throw new Error(`${at}: unknown layout "${scene.layout}"`);
      if (scene.corner !== undefined && !PIP_CORNERS.has(scene.corner)) {
        throw new Error(`${at}: unknown corner "${scene.corner}"`);
      }
    } else if (scene.type === "kinetic") {
      // Kinetic rides the transcript's own words; it carries no text.
    }
  });
}

// Word anchors -> seconds. A scene holds from its first word's start to its
// last word's end; the anchors stay in the output so re-resolving after a
// new transcript needs nothing else.
export function resolveScenes(scenes, words) {
  validateScenes(scenes, words);
  const byId = new Map(words.map((word) => [word.id, word]));
  return scenes.map((scene) => ({
    ...scene,
    start: byId.get(scene.fromWordId).start,
    end: byId.get(scene.toWordId).end,
  }));
}

// Karaoke caption spans: each word holds the caption from its start until
// the next word arrives, hanging on through pauses up to a beat so the
// caption does not flicker across breaths. Kinetic type rides these.
export function resolveCaptions(words) {
  return words.map((word, index) => {
    const next = words[index + 1];
    const hang = word.end + CAPTION_HANG_SECONDS;
    return {
      start: word.start,
      end: next ? Math.min(Math.max(word.end, hang), next.start) : Math.max(word.end, hang),
      text: word.text,
    };
  });
}

const PHRASE_MAX_WORDS = 4;
const PHRASE_MAX_SECONDS = 2.2;
const PHRASE_BREAK_GAP = 0.5;

// Phrase captions for the whole film: a few words at a time, broken at
// sentence punctuation, at real pauses, and at a length the eye can take
// in — one word at a time three times a second is noise over thirteen
// minutes. Each phrase shows from its first word until its last word ends
// plus a hang, never past the next phrase.
export function resolvePhraseCaptions(words) {
  const phrases = [];
  let current = [];
  const flush = () => {
    if (current.length === 0) return;
    phrases.push({ start: current[0].start, end: current.at(-1).end, text: current.map((w) => w.text).join(" ") });
    current = [];
  };
  words.forEach((word, index) => {
    current.push(word);
    const next = words[index + 1];
    const endsSentence = /[.!?;:]["')]*$/.test(word.text);
    const endsClause = /,["')]*$/.test(word.text) && current.length >= 2;
    const tooLong = current.length >= PHRASE_MAX_WORDS || word.end - current[0].start >= PHRASE_MAX_SECONDS;
    const pause = next ? next.start - word.end >= PHRASE_BREAK_GAP : true;
    if (!next || endsSentence || endsClause || tooLong || pause) flush();
  });
  return phrases.map((phrase, index) => {
    const next = phrases[index + 1];
    const hang = phrase.end + CAPTION_HANG_SECONDS;
    return { ...phrase, end: next ? Math.min(Math.max(phrase.end, hang), next.start) : Math.max(phrase.end, hang) };
  });
}

// Every instant the overlay picture changes, with how long it holds. Static
// spans change at scene and caption boundaries — the export captures one
// frame per state. Animated graphics change continuously, so their windows
// are sampled at full frame rate. The preview just renders at the playhead
// and lands on the same pictures.
export function renderSchedule(resolvedScenes, captionSpans, durationSeconds, options = {}) {
  const fps = options.fps ?? 30;
  const times = new Set([0]);
  const add = (t) => {
    if (t > 0 && t < durationSeconds) times.add(Number(t.toFixed(4)));
  };
  for (const scene of resolvedScenes) {
    add(scene.start);
    add(scene.end);
    if (scene.type === "graphic") {
      for (let t = scene.start; t < Math.min(scene.end, durationSeconds); t += 1 / fps) add(t);
    }
  }
  for (const span of captionSpans ?? []) {
    add(span.start);
    add(span.end);
  }
  const sorted = [...times].sort((a, b) => a - b);
  return sorted
    .map((t, index) => ({
      t,
      duration: (index + 1 < sorted.length ? sorted[index + 1] : durationSeconds) - t,
    }))
    .filter((state) => state.duration > 0.001);
}

export function activeAt(resolved, t) {
  return resolved.filter((item) => item.start <= t && t < item.end);
}
