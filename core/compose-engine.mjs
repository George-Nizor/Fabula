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

import { LAYOUTS, PIP_CORNERS, TRANSITIONS, FULL_STAGE_KINDS, resolveLayoutTimeline } from "./stage-engine.mjs";
import { validateTheme as validateThemeConfig, TITLE_STYLES, CALLOUT_STYLES } from "./themes.mjs";

export const SCENE_TYPES = new Set(["title", "callout", "graphic", "stage", "kinetic"]);
export const GRAPHIC_KINDS = new Set(["chart", "stat", "list", "image", "clip", "screen", "quote", "compare", "steps", "ring", "logos", "cover", "section", "custom"]);
export const CLIP_FITS = new Set(["cover", "contain"]);
// What a custom graphic may not carry: anything that runs, loads, or
// navigates. Motion comes from the --p and --t variables the painter sets.
const CUSTOM_FORBIDDEN = [/<\s*script/i, /<\s*iframe/i, /<\s*object/i, /<\s*embed/i, /<\s*link/i, /@import/i, /javascript:/i, /\bon[a-z]+\s*=/i, /https?:\/\//i, /expression\s*\(/i];
// The same rules, in words, for the error text.
const CUSTOM_FORBIDDEN_NAMES = ["a <script> tag", "an <iframe>", "an <object>", "an <embed>", "a <link>", "an @import", "a javascript: URL", "an on* event handler", "an http(s) URL (assets go under assets/)", "a CSS expression()"];
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
  // clip: B-roll — a video the project holds under assets/, played muted in
  // the card from `in` seconds into it while the voice carries on.
  if (graphic.kind === "clip") {
    if (typeof graphic.src !== "string" || !/^assets\/[^/]+\.(mp4|webm|m4v|mov)$/i.test(graphic.src)) {
      throw new Error(`${at}: clip needs an assets/… mp4, webm, m4v or mov src (import_clip brings one in)`);
    }
    if (graphic.in !== undefined && !(typeof graphic.in === "number" && graphic.in >= 0)) throw new Error(`${at}: clip \`in\` is seconds into the clip, 0 or more`);
    if (graphic.fit !== undefined && !CLIP_FITS.has(graphic.fit)) throw new Error(`${at}: clip fit must be cover or contain`);
    if (graphic.label !== undefined && typeof graphic.label !== "string") throw new Error(`${at}: clip label must be text`);
    return;
  }
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
    if (graphic.over !== undefined && typeof graphic.over !== "boolean") throw new Error(`${at}: custom over is true or false`);
    if (typeof graphic.html !== "string" || graphic.html.length === 0 || graphic.html.length > 20000) throw new Error(`${at}: custom needs html up to 20000 characters`);
    if (graphic.css !== undefined && (typeof graphic.css !== "string" || graphic.css.length > 10000)) throw new Error(`${at}: custom css is at most 10000 characters`);
    for (const rule of CUSTOM_FORBIDDEN) {
      if (rule.test(graphic.html) || rule.test(graphic.css ?? "")) throw new Error(`${at}: custom graphics may not carry ${CUSTOM_FORBIDDEN_NAMES[CUSTOM_FORBIDDEN.indexOf(rule)]}; no scripts, frames, external loads or handlers`);
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
      throw new Error(`${at}: the last word (${scene.toWordId}) comes before the first (${scene.fromWordId})`);
    }
    if (scene.accent !== undefined && !ACCENT_RE.test(scene.accent)) {
      throw new Error(`${at}: accent must be #rrggbb`);
    }
    // Fields that belong to another kind of scene are a mistake, not a
    // no-op: a layout on a graphic scene or a card on a title would sit in
    // the file doing nothing and read as if it did.
    if (scene.type !== "graphic" && scene.graphic !== undefined) throw new Error(`${at}: a ${scene.type} scene does not carry a graphic; a card is a graphic scene`);
    if (scene.type !== "stage" && (scene.layout !== undefined || scene.corner !== undefined)) throw new Error(`${at}: layout belongs on a stage scene; a ${scene.type} scene takes none (add a stage scene over the same words)`);
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
      if (scene.transition !== undefined && !TRANSITIONS.has(scene.transition)) {
        throw new Error(`${at}: transition must be one of ${[...TRANSITIONS].join(", ")}`);
      }
    } else if (scene.type === "kinetic") {
      // Kinetic rides the transcript's own words; it carries no text.
    }
  });
}

// Word anchors -> seconds. A scene holds from its first word's start to its
// last word's end; the anchors stay in the output so re-resolving after a
// new transcript needs nothing else.
// A card hangs through the pause between its last word and the next card's
// first: cards anchor to words, words have breath between them, and a
// third of a second of empty stage between two cards is a blink, not a
// beat. Captions hang the same way.
export const GRAPHIC_HANG_SECONDS = 0.5;

export function resolveScenes(scenes, words) {
  validateScenes(scenes, words);
  const byId = new Map(words.map((word) => [word.id, word]));
  const resolved = scenes.map((scene) => ({
    ...scene,
    start: byId.get(scene.fromWordId).start,
    end: byId.get(scene.toWordId).end,
  }));
  const cards = resolved.filter((scene) => scene.type === "graphic").sort((a, b) => a.start - b.start);
  for (let i = 0; i + 1 < cards.length; i += 1) {
    const gap = cards[i + 1].start - cards[i].end;
    if (gap > 0 && gap <= GRAPHIC_HANG_SECONDS) cards[i].end = cards[i + 1].start;
  }
  return resolved;
}

// Stage scenes the dwell rule will not honour: a placed layout shorter than
// three seconds (1.2 for a cutaway) is absorbed into its neighbour, so a
// side card planned for a breath lands wherever the neighbour puts cards —
// in a cutaway, the whole stage. Reported by scene index, before the render
// shows it.
export function absorbedStages(scenes, durationSeconds = Infinity) {
  const out = [];
  scenes.forEach((scene, index) => {
    if (scene.type !== "stage" || !scene.layout) return;
    // The timeline's first and last segments are never absorbed: they have
    // only one neighbour and the dwell rule leaves them be.
    if (scene.start <= 0.01 || scene.end >= durationSeconds - 0.01) return;
    const floor = scene.layout === "cutaway" ? 1.2 : 3;
    const seconds = scene.end - scene.start;
    if (seconds < floor - 0.01) out.push({ index, layout: scene.layout, seconds: Number(seconds.toFixed(1)), floor });
  });
  return out;
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
// ---- Which words a caption leans on ----
//
// Burned-in captions on a phone are read, not heard, and a phrase in one
// weight is a wall. Emphasis picks the one or two words a phrase turns on —
// a number, an absolute, a negation, a name, or a word the person listed —
// and the painter sets them in the accent and a heavier weight. At most two
// per phrase, numbers first, so the emphasis still means something.
export const CAPTION_EMPHASIS_MODES = new Set(["none", "auto"]);
const EMPHASIS_ABSOLUTE = /^(never|always|nobody|everyone|everything|nothing|only|biggest|best|worst|fastest|slowest|cheapest|free|secret|impossible|wrong|right|stop|why|huge|massive|tiny|zero|double|triple|half)$/;
const EMPHASIS_NEGATION = /^(not|don'?t|doesn'?t|didn'?t|can'?t|won'?t|isn'?t|aren'?t|no)$/;
const EMPHASIS_NUMBER = /\d|^(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|percent)$/;

export function captionEmphasis(value) {
  if (value === undefined || value === null || value === "none" || value === false) return "none";
  if (value === "auto" || value === true) return "auto";
  if (Array.isArray(value)) {
    const list = [...new Set(value.map((w) => String(w).toLowerCase().replace(/[^\p{L}\p{N}'%$-]/gu, "")).filter(Boolean))];
    if (list.length > 60) throw new Error("caption emphasis takes at most 60 words");
    return list;
  }
  throw new Error("caption emphasis is none, auto, or a list of words");
}

export function emphasisFor(texts, emphasis, { max = 2 } = {}) {
  const mode = captionEmphasis(emphasis);
  const flags = texts.map(() => false);
  if (mode === "none") return flags;
  const bare = texts.map((t) => String(t).toLowerCase().replace(/[^\p{L}\p{N}'%$-]/gu, ""));
  const scored = [];
  texts.forEach((text, i) => {
    const w = bare[i];
    if (!w) return;
    let score = 0;
    if (Array.isArray(mode)) { if (mode.includes(w)) score = 4; }
    else {
      if (EMPHASIS_NUMBER.test(w)) score = 3;
      else if (EMPHASIS_ABSOLUTE.test(w)) score = 2;
      else if (EMPHASIS_NEGATION.test(w)) score = 1.5;
      else if (i > 0 && /^[A-Z][a-z]{2,}/.test(String(text)) && !/[.!?]$/.test(String(texts[i - 1]))) score = 1;
    }
    if (score > 0) scored.push({ i, score });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i).slice(0, max).forEach(({ i }) => { flags[i] = true; });
  return flags;
}

export function resolvePhraseCaptions(words, { emphasis = "none" } = {}) {
  const phrases = [];
  let current = [];
  const flush = () => {
    if (current.length === 0) return;
    const flags = emphasisFor(current.map((w) => w.text), emphasis);
    phrases.push({
      start: current[0].start, end: current.at(-1).end,
      text: current.map((w) => w.text).join(" "),
      words: current.map((w, i) => ({ text: w.text, start: w.start, end: w.end, ...(flags[i] ? { emph: true } : {}) })),
    });
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


// ---- Insert points: where a visual could go, and what could go there ----
//
// After the cut, the agent marks the moments it would dress and offers a
// few ready-made options for each; the person picks in the window (or asks
// for something else in words). An option is a complete list of scenes
// anchored inside the insert's span; choosing it materialises those scenes
// into the plan, tagged with the insert's id so choosing again replaces
// them.

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function validateInserts(inserts, words) {
  if (!Array.isArray(inserts)) throw new Error("inserts must be an array");
  const byId = new Map(words.map((word) => [word.id, word]));
  const seen = new Set();
  inserts.forEach((insert, index) => {
    const at = `insert ${index}`;
    if (typeof insert.id !== "string" || !ID_RE.test(insert.id)) throw new Error(`${at}: id must be a short slug (a-z, 0-9, dashes)`);
    if (seen.has(insert.id)) throw new Error(`${at}: duplicate id "${insert.id}"`);
    seen.add(insert.id);
    if (!byId.has(insert.fromWordId) || !byId.has(insert.toWordId)) throw new Error(`${at}: word ids must be 0–${words.length - 1}`);
    if (byId.get(insert.toWordId).start < byId.get(insert.fromWordId).start) throw new Error(`${at}: toWordId precedes fromWordId`);
    if (typeof insert.why !== "string" || insert.why.length === 0 || insert.why.length > 120) throw new Error(`${at}: why must say in a line what the moment is`);
    if (!Array.isArray(insert.options) || insert.options.length < 1 || insert.options.length > 5) throw new Error(`${at}: 1–5 options`);
    const optionIds = new Set();
    insert.options.forEach((option, k) => {
      const where = `${at} option ${k}`;
      if (typeof option.id !== "string" || !ID_RE.test(option.id)) throw new Error(`${where}: id must be a short slug`);
      if (optionIds.has(option.id)) throw new Error(`${where}: duplicate option id "${option.id}"`);
      optionIds.add(option.id);
      if (typeof option.label !== "string" || option.label.length === 0 || option.label.length > 60) throw new Error(`${where}: label up to 60 characters`);
      if (!Array.isArray(option.scenes) || option.scenes.length === 0) throw new Error(`${where}: needs at least one scene`);
      validateScenes(option.scenes, words);
    });
    if (insert.chosen !== undefined && insert.chosen !== null && insert.chosen !== "other" && !optionIds.has(insert.chosen)) {
      throw new Error(`${at}: chosen "${insert.chosen}" is not one of its options`);
    }
    if (insert.note !== undefined && insert.note !== null && (typeof insert.note !== "string" || insert.note.length > 500)) throw new Error(`${at}: note up to 500 characters`);
  });
}

// The plan with one insert's choice materialised: its earlier scenes go,
// the chosen option's scenes come in tagged with the insert's id. optionId
// null clears the choice; "other" records a request and places nothing.
export function applyInsertChoice(config, insertId, optionId, note) {
  const inserts = (config.inserts ?? []).map((insert) => ({ ...insert }));
  const insert = inserts.find((item) => item.id === insertId);
  if (!insert) throw new Error(`no insert "${insertId}"`);
  const scenes = (config.scenes ?? []).filter((scene) => scene.insertId !== insertId);
  if (optionId && optionId !== "other") {
    const option = insert.options.find((item) => item.id === optionId);
    if (!option) throw new Error(`insert "${insertId}" has no option "${optionId}"`);
    for (const scene of option.scenes) scenes.push({ ...scene, insertId });
    scenes.sort((a, b) => a.fromWordId - b.fromWordId);
  }
  insert.chosen = optionId ?? null;
  if (note !== undefined) insert.note = note;
  return { ...config, scenes, inserts };
}

// Inserts with seconds, and every option's scenes resolved, for the window
// to preview a choice without a round trip.
export function resolveInserts(inserts, words) {
  const byId = new Map(words.map((word) => [word.id, word]));
  return (inserts ?? []).map((insert) => ({
    ...insert,
    start: byId.get(insert.fromWordId)?.start ?? 0,
    end: byId.get(insert.toWordId)?.end ?? 0,
    options: insert.options.map((option) => ({ ...option, scenes: resolveScenes(option.scenes.map((scene) => ({ ...scene, insertId: insert.id })), words) })),
  }));
}


// ---- Captions: burned in, a file for the player to offer, both, or none ----
//
// "Open" captions are painted into the picture; "closed" ones travel as a
// subtitle file beside the film (YouTube shows them as CC and the viewer
// switches them). compose.json keeps `captions` as one of these; the older
// true/false still read as open/none.

export const CAPTION_MODES = new Set(["open", "closed", "both", "none"]);

export function captionMode(value) {
  if (value === true) return "open";
  if (value === false || value === undefined || value === null) return "none";
  if (!CAPTION_MODES.has(value)) throw new Error(`captions must be one of ${[...CAPTION_MODES].join(", ")}`);
  return value;
}

export const captionsBurnedIn = (value) => ["open", "both"].includes(captionMode(value));
export const captionsAsFile = (value) => ["closed", "both"].includes(captionMode(value));

const pad = (n, width) => String(n).padStart(width, "0");
function timecode(seconds, separator) {
  const total = Math.max(seconds, 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${separator}${pad(ms, 3)}`;
}

// The phrase captions as a subtitle file over [from, to], re-timed to start
// at zero — the film's own clock, or a preview span's.
export function subtitleFile(captions, format, from = 0, to = Infinity) {
  const cues = captions
    .filter((cue) => cue.end > from && cue.start < to)
    .map((cue) => ({ start: Math.max(cue.start, from) - from, end: Math.min(cue.end, to) - from, text: cue.text }))
    .filter((cue) => cue.end - cue.start > 0.05);
  if (format === "vtt") {
    return ["WEBVTT", "", ...cues.map((cue, i) => `${i + 1}\n${timecode(cue.start, ".")} --> ${timecode(cue.end, ".")}\n${cue.text}\n`)].join("\n");
  }
  return cues.map((cue, i) => `${i + 1}\n${timecode(cue.start, ",")} --> ${timecode(cue.end, ",")}\n${cue.text}\n`).join("\n");
}

// ---- Does the film change its picture? ----
//
// The rule "the same card kind twice running reads as a template" is written
// down in the workflow, but a document read at the start of a session is far
// from the moment a plan is written. This reads the plan itself and says what
// it sees, in the set_scenes result, where it can still be acted on. Pure and
// deterministic: the same plan always draws the same notes.

const at = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

// Runs of the same value in a row, as [{ value, from, to, length }].
function runsOfSame(items, valueOf) {
  const runs = [];
  for (const item of items) {
    const value = valueOf(item);
    const last = runs.at(-1);
    if (last && last.value === value) { last.to = item; last.length += 1; }
    else runs.push({ value, from: item, to: item, length: 1 });
  }
  return runs;
}

// Moments where the camera is off and nothing is on the stage.
//
// A cutaway is a promise that a visual carries the narration. When the plan
// does not keep it the film shows an empty field — and the dwell rule now
// bridges away the momentary return to camera that used to paper over a gap
// between two cards, which makes the hole visible instead of a flash. Either
// is a fault; this one is at least reported before it renders.
export function uncoveredCutaways(scenes, durationSeconds = 0, options = {}) {
  const timeline = resolveLayoutTimeline(scenes, durationSeconds, options);
  // A card on the film's first or last words reaches the film's edge (the
  // painter holds it there); the word pad and the tail are not holes.
  const EDGE = 0.5;
  const covering = scenes
    .filter((scene) => scene.type === "graphic" || scene.type === "kinetic")
    .map((scene) => ({ ...scene, start: scene.start <= EDGE ? 0 : scene.start, end: durationSeconds > 0 && scene.end >= durationSeconds - EDGE ? durationSeconds : scene.end }))
    .sort((a, b) => a.start - b.start);
  const holes = [];
  for (const span of timeline.filter((s) => s.layout === "cutaway")) {
    let cursor = span.start;
    for (const scene of covering) {
      if (scene.end <= cursor || scene.start >= span.end) continue;
      if (scene.start > cursor) holes.push([cursor, Math.min(scene.start, span.end)]);
      cursor = Math.max(cursor, scene.end);
      if (cursor >= span.end) break;
    }
    if (cursor < span.end) holes.push([cursor, span.end]);
  }
  // A couple of frames is a rounding artefact of word timings, not a hole.
  return holes.filter(([from, to]) => to - from > 0.12).map(([from, to]) => ({ start: Number(from.toFixed(2)), end: Number(to.toFixed(2)) }));
}

// Placed layouts with nothing in the place they make. A side, pip, band or
// full layout shrinks or moves the head to make room; room with nothing in
// it is the head made small for nothing. It happens the same way a cutaway
// hole does — a card ends and the dwell rule bridges the return to camera
// away, so the layout holds — and is reported the same way, by the second.
// Titles and callouts count: a free column is where they go.
export function emptyPlacedLayouts(scenes, durationSeconds = 0, options = {}) {
  const timeline = resolveLayoutTimeline(scenes, durationSeconds, options);
  const EDGE = 0.5;
  const covering = scenes
    .filter((scene) => scene.type !== "stage")
    .map((scene) => ({ ...scene, start: scene.start <= EDGE ? 0 : scene.start, end: durationSeconds > 0 && scene.end >= durationSeconds - EDGE ? durationSeconds : scene.end }))
    .sort((a, b) => a.start - b.start);
  const holes = [];
  for (const span of timeline.filter((s) => s.layout !== "focus" && s.layout !== "cutaway")) {
    let cursor = span.start;
    for (const scene of covering) {
      if (scene.end <= cursor || scene.start >= span.end) continue;
      if (scene.start > cursor) holes.push([span.layout, cursor, Math.min(scene.start, span.end)]);
      cursor = Math.max(cursor, scene.end);
      if (cursor >= span.end) break;
    }
    if (cursor < span.end) holes.push([span.layout, cursor, span.end]);
  }
  return holes.filter(([, from, to]) => to - from > 0.12).map(([layout, from, to]) => ({ layout, start: Number(from.toFixed(2)), end: Number(to.toFixed(2)) }));
}

// Full-stage graphics that the head is standing in front of.
//
// A cover, a section or a full-stage custom graphic is drawn under the head.
// In a full layout the head is a corner card and the graphic owns the stage;
// in a cutaway there is no head. Under focus, side or band the head covers
// most or all of it — in a tall frame, all of it — and the plan looks
// complete while the picture shows a face. Reported by scene index.
export function hiddenFullStage(scenes, durationSeconds = 0, options = {}) {
  const timeline = resolveLayoutTimeline(scenes, durationSeconds, options);
  const hidden = [];
  scenes.forEach((scene, index) => {
    if (scene.type !== "graphic" || !scene.graphic) return;
    const fullStage = FULL_STAGE_KINDS.has(scene.graphic.kind) && scene.graphic.full !== false;
    if (!fullStage || scene.graphic.over) return; // over the head, it is never behind it
    const covering = timeline.filter((segment) => segment.start < scene.end && segment.end > scene.start && !["full", "cutaway"].includes(segment.layout));
    if (!covering.length) return;
    const seconds = covering.reduce((sum, segment) => sum + Math.min(segment.end, scene.end) - Math.max(segment.start, scene.start), 0);
    if (seconds < 0.25) return;
    hidden.push({ index, kind: scene.graphic.template ?? scene.graphic.kind, seconds: Number(seconds.toFixed(1)), layouts: [...new Set(covering.map((s) => s.layout))] });
  });
  return hidden;
}

// Type over a full-stage card. A title or a callout falls to its default
// place on the stage; while a cover, a section or a full-stage custom
// graphic owns the stage, that place is on top of the card's own text. The
// card should carry the words instead. Reported by scene index.
export function overFullStage(scenes) {
  const cards = scenes.filter((scene) => scene.type === "graphic" && scene.graphic && FULL_STAGE_KINDS.has(scene.graphic.kind) && scene.graphic.full !== false);
  const out = [];
  scenes.forEach((scene, index) => {
    if (scene.type !== "title" && scene.type !== "callout") return;
    const under = cards.find((card) => card.start < scene.end - 0.1 && card.end > scene.start + 0.1);
    if (under) out.push({ index, type: scene.type, card: under.graphic.template ?? under.graphic.kind, seconds: Number((Math.min(scene.end, under.end) - Math.max(scene.start, under.start)).toFixed(1)) });
  });
  return out;
}

export function describeVariety(scenes, durationSeconds = 0) {
  const notes = [];
  const cards = scenes.filter((scene) => scene.type === "graphic" && scene.graphic?.kind);
  const staged = scenes.filter((scene) => scene.type === "stage" && scene.layout);

  // A template is its own kind of card: six different templates in a row
  // are six shapes, not six "custom" cards.
  const kindOf = (scene) => scene.graphic.template ?? scene.graphic.kind;
  for (const run of runsOfSame(cards, kindOf)) {
    if (run.length >= 3) {
      notes.push(`${run.length} ${run.value} cards in a row, ${at(run.from.start)}–${at(run.to.end)}. The same card kind twice running reads as a template; change the shape or let the head hold the frame between them.`);
    }
  }
  for (const run of runsOfSame(staged, (scene) => scene.layout)) {
    if (run.length >= 4) {
      notes.push(`${run.length} ${run.value} layouts in a row, ${at(run.from.start)}–${at(run.to.end)}. Move between the head alone, a side card, the screen and the full stage.`);
    }
  }
  if (cards.length >= 4) {
    const counts = new Map();
    for (const card of cards) counts.set(kindOf(card), (counts.get(kindOf(card)) ?? 0) + 1);
    const [kind, count] = [...counts].sort((a, b) => b[1] - a[1])[0];
    if (count / cards.length > 0.5) {
      notes.push(`${count} of ${cards.length} cards are ${kind}. The kit has chart, stat, list, image, quote, compare, steps, ring, logos, the named templates (describe_templates), and custom for what none of them fit.`);
    }
  }
  // Judge the actual screen arrangement, not just the names of cards.
  const timeline = resolveLayoutTimeline(scenes, durationSeconds);
  const durations = new Map();
  for (const span of timeline) durations.set(span.layout, (durations.get(span.layout) ?? 0) + span.end - span.start);
  const sideSeconds = (durations.get("side") ?? 0) + (durations.get("pip") ?? 0);
  if (durationSeconds >= 45 && sideSeconds / durationSeconds > 0.45) {
    notes.push(`Presenter beside graphics occupies ${Math.round(100 * sideSeconds / durationSeconds)}% of the film. Different card kinds can still repeat the same composition; consider camera-free cutaways and purposeful presenter returns.`);
  }
  if (durationSeconds >= 60 && staged.length && !(durations.get("cutaway") > 0)) {
    notes.push("The camera never leaves the stage. full still includes a corner camera; use cutaway when a visual should carry the narration alone.");
  }
  const wholeStage = scenes.some((scene) => ["full", "cutaway"].includes(scene.layout) || ["cover", "section"].includes(scene.graphic?.kind));
  if (durationSeconds >= 180 && !wholeStage) {
    notes.push(`No moment owns the whole stage in ${at(durationSeconds)}. A section heading or a cover marks a change of subject and lets the film breathe.`);
  }
  // A long silence between visuals is its own kind of sameness.
  let previousEnd = 0;
  const quiet = [];
  for (const scene of [...scenes].sort((a, b) => a.start - b.start)) {
    if (scene.start - previousEnd >= 90) quiet.push([previousEnd, scene.start]);
    previousEnd = Math.max(previousEnd, scene.end);
  }
  if (durationSeconds - previousEnd >= 90) quiet.push([previousEnd, durationSeconds]);
  for (const [from, to] of quiet) {
    notes.push(`Nothing but the head from ${at(from)} to ${at(to)} (${Math.round(to - from)}s).`);
  }
  return notes;
}
