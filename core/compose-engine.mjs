// Scene planning over the clean transcript. No I/O. Scenes are declarative
// and word-anchored — an agent writes "title over words 3–9" and never a
// second; seconds are derived here, once, and the same resolved structures
// feed the live preview and the export capture so they cannot disagree.

const CAPTION_HANG_SECONDS = 0.4;

import { LAYOUTS, PIP_CORNERS } from "./stage-engine.mjs";

export const SCENE_TYPES = new Set(["title", "callout", "graphic", "stage"]);
export const GRAPHIC_KINDS = new Set(["chart", "stat", "list"]);

function validateGraphic(graphic, at) {
  if (!graphic || typeof graphic !== "object") throw new Error(`${at}: graphic spec is required`);
  if (!GRAPHIC_KINDS.has(graphic.kind)) throw new Error(`${at}: unknown graphic kind "${graphic.kind}"`);
  if (graphic.kind === "stat") {
    if (typeof graphic.value !== "number") throw new Error(`${at}: stat needs a numeric value`);
    if (!graphic.label) throw new Error(`${at}: stat needs a label`);
    return;
  }
  if (!Array.isArray(graphic.items) || graphic.items.length === 0 || graphic.items.length > 6) {
    throw new Error(`${at}: ${graphic.kind} needs 1–6 items`);
  }
  for (const item of graphic.items) {
    if (!item.label) throw new Error(`${at}: every item needs a label`);
    if (graphic.kind === "chart" && typeof item.value !== "number") {
      throw new Error(`${at}: chart items need numeric values`);
    }
  }
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
    if (scene.type === "graphic") validateGraphic(scene.graphic, at);
    else if (scene.type === "stage") {
      if (!LAYOUTS.has(scene.layout)) throw new Error(`${at}: unknown layout "${scene.layout}"`);
      if (scene.corner !== undefined && !PIP_CORNERS.has(scene.corner)) {
        throw new Error(`${at}: unknown corner "${scene.corner}"`);
      }
    } else if (!scene.text || typeof scene.text !== "string") throw new Error(`${at}: text is required`);
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
// caption does not flicker across breaths.
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
