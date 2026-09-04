// Scene planning over the clean transcript. No I/O. Scenes are declarative
// and word-anchored — an agent writes "title over words 3–9" and never a
// second; seconds are derived here, once, and the same resolved structures
// feed the live preview and the export capture so they cannot disagree.

const CAPTION_HANG_SECONDS = 0.4;

export const SCENE_TYPES = new Set(["title", "callout"]);

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
    if (!scene.text || typeof scene.text !== "string") throw new Error(`${at}: text is required`);
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

// Every instant the overlay picture changes, with how long it holds. The
// export captures exactly one frame per state; the preview just renders at
// the playhead and lands on the same picture.
export function stateTimes(resolvedScenes, captionSpans, durationSeconds) {
  const times = new Set([0]);
  const add = (t) => {
    if (t > 0 && t < durationSeconds) times.add(Number(t.toFixed(4)));
  };
  for (const scene of resolvedScenes) {
    add(scene.start);
    add(scene.end);
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
