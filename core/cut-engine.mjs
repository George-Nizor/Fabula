// Pure cut-list detection over a WhisperX word timeline. No I/O, no ffmpeg.
// Times are seconds. Cuts are proposals: every one carries a reason, its source
// words, and an `enabled` toggle the review UI owns.

export const DEFAULT_FILLERS = new Set([
  "um", "uh", "erm", "uhm", "hmm", "mmm", "mhm", "ah", "er",
]);

const MIN_KEEP_SEGMENT_SECONDS = 0.05;

function isFiniteTime(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

// WhisperX JSON -> flat [{id, text, start, end}]. Words WhisperX could not
// align (numbers, symbols) carry no timestamps; they inherit an interpolated
// span between their timed neighbours so every word stays seekable.
export function flattenWords(transcript) {
  const raw = [];
  for (const segment of transcript?.segments ?? []) {
    for (const word of segment.words ?? []) {
      raw.push({
        text: String(word.word ?? "").trim(),
        start: isFiniteTime(word.start) ? word.start : null,
        end: isFiniteTime(word.end) ? word.end : null,
        segmentStart: segment.start,
        segmentEnd: segment.end,
      });
    }
  }
  const words = raw.map((word, index) => ({ id: index, text: word.text, start: word.start, end: word.end }));
  for (let i = 0; i < words.length; i += 1) {
    if (words[i].start !== null && words[i].end !== null) continue;
    const prevEnd = findPrevEnd(words, i) ?? raw[i].segmentStart ?? 0;
    const nextStart = findNextStart(words, i) ?? raw[i].segmentEnd ?? prevEnd;
    const span = Math.max(nextStart - prevEnd, 0);
    const untimed = countUntimedRun(words, i);
    const step = span / (untimed + 1);
    const offset = untimedIndexInRun(words, i);
    words[i].start = prevEnd + step * offset;
    words[i].end = prevEnd + step * (offset + 1);
  }
  return words;
}

function findPrevEnd(words, index) {
  for (let i = index - 1; i >= 0; i -= 1) if (words[i].end !== null) return words[i].end;
  return null;
}

function findNextStart(words, index) {
  for (let i = index + 1; i < words.length; i += 1) if (words[i].start !== null) return words[i].start;
  return null;
}

function countUntimedRun(words, index) {
  let first = index;
  while (first > 0 && words[first - 1].start === null) first -= 1;
  let last = index;
  while (last + 1 < words.length && words[last + 1].start === null) last += 1;
  return last - first + 1;
}

function untimedIndexInRun(words, index) {
  let first = index;
  while (first > 0 && words[first - 1].start === null) first -= 1;
  return index - first;
}

export function normalizeToken(text) {
  return String(text).toLowerCase().replace(/[^a-z'’-]/g, "");
}

export function detectFillerCuts(words, options = {}) {
  const fillers = options.fillers ?? DEFAULT_FILLERS;
  const pad = options.padSeconds ?? 0.04;
  const cuts = [];
  for (const word of words) {
    const token = normalizeToken(word.text);
    if (!fillers.has(token)) continue;
    cuts.push({
      start: Math.max(word.start - pad, 0),
      end: word.end + pad,
      reason: "filler",
      detail: token,
      wordIds: [word.id],
      enabled: true,
    });
  }
  return cuts;
}

// Dead air comes from gaps in the word timeline itself: one source of truth.
// Cuts keep `keepBreathSeconds` on each side; speech is never cut to zero.
export function detectGapCuts(words, options = {}) {
  const minGap = options.minGapSeconds ?? 0.6;
  const keep = options.keepBreathSeconds ?? 0.15;
  const duration = options.mediaDurationSeconds ?? null;
  const cuts = [];
  if (words.length === 0) return cuts;

  if (words[0].start >= minGap) {
    cuts.push(gapCut(0, words[0].start - keep, [words[0].id]));
  }
  for (let i = 0; i + 1 < words.length; i += 1) {
    const gap = words[i + 1].start - words[i].end;
    if (gap < minGap) continue;
    cuts.push(gapCut(words[i].end + keep, words[i + 1].start - keep, [words[i].id, words[i + 1].id]));
  }
  if (duration !== null && duration - words.at(-1).end >= minGap) {
    cuts.push(gapCut(words.at(-1).end + keep, duration, [words.at(-1).id]));
  }
  return cuts.filter((cut) => cut.end - cut.start > 0);
}

function gapCut(start, end, wordIds) {
  return { start: Math.max(start, 0), end, reason: "silence", wordIds, enabled: true };
}

// Sort and merge overlapping or near-adjacent cuts. Merged cuts keep every
// contributing source so the UI can still explain them.
export function normalizeCuts(cuts, options = {}) {
  const mergeWithin = options.mergeWithinSeconds ?? 0.05;
  const sorted = [...cuts].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const cut of sorted) {
    const previous = merged.at(-1);
    if (previous && cut.start <= previous.end + mergeWithin) {
      previous.end = Math.max(previous.end, cut.end);
      previous.sources.push(...(cut.sources ?? [cut]));
      previous.enabled = previous.enabled && cut.enabled;
      continue;
    }
    merged.push({
      start: cut.start,
      end: cut.end,
      enabled: cut.enabled,
      sources: [...(cut.sources ?? [cut])],
    });
  }
  return merged;
}

// A scrap of SILENCE this short between two cuts is not an edit, it is a
// stutter: two jump cuts a tenth of a second apart, which reads as a dropped
// frame. Two filler cuts side by side ("um, uh") leave exactly that. A scrap
// this short that carries a WORD is a different thing entirely — the speaker
// said it, and it stays however short it is.
export const SILENT_KEEP_FLOOR_SECONDS = 0.4;

const holdsAWord = (words, start, end) =>
  (words ?? []).some((word) => word.end > start + 0.01 && word.start < end - 0.01);

// The complement of the enabled cuts: what survives into clean.mp4. Given the
// words, a silent scrap under the floor is absorbed into the cuts either side
// rather than rendered as three frames nobody asked for.
export function keepSegments(cuts, durationSeconds, { words = null } = {}) {
  const active = normalizeCuts(cuts.filter((cut) => cut.enabled));
  const keeps = [];
  let cursor = 0;
  const worthKeeping = (start, end) => {
    const seconds = end - start;
    if (seconds < MIN_KEEP_SEGMENT_SECONDS) return false;
    if (!words || seconds >= SILENT_KEEP_FLOOR_SECONDS) return true;
    return holdsAWord(words, start, end);
  };
  for (const cut of active) {
    const end = Math.min(cut.start, durationSeconds);
    if (worthKeeping(cursor, end)) keeps.push({ start: cursor, end });
    cursor = Math.min(Math.max(cursor, cut.end), durationSeconds);
  }
  if (worthKeeping(cursor, durationSeconds)) keeps.push({ start: cursor, end: durationSeconds });
  return keeps;
}

export function totalCutSeconds(cuts) {
  return normalizeCuts(cuts.filter((cut) => cut.enabled)).reduce((sum, cut) => sum + (cut.end - cut.start), 0);
}

// A cut the person drew over words in the window: the first word's start to
// the last word's end, merged into the list like any other. A merge with a
// disabled proposal must not disable what was just asked for.
export function addWordCut(cuts, words, wordIds) {
  const chosen = words.filter((word) => wordIds.includes(word.id)).sort((a, b) => a.start - b.start);
  if (chosen.length === 0) throw new Error("no words to cut");
  const start = chosen[0].start;
  const end = chosen.at(-1).end;
  const manual = { start, end, enabled: true, sources: [{ start, end, reason: "manual", wordIds: chosen.map((word) => word.id), enabled: true }] };
  const merged = normalizeCuts([...cuts, manual]);
  for (const cut of merged) if (cut.start <= start + 0.001 && cut.end >= end - 0.001) cut.enabled = true;
  return merged;
}

// The opposite gesture: words the person drew across inside a struck span
// are kept, and every enabled cut over them is split around them. A cut's
// sources stay with the piece they fall in, so the window can still explain
// what was proposed. A leftover piece shorter than the pause the engine
// itself would cut (the breath before the first kept word) is dropped rather
// than left as a jump cut nobody asked for. Disabled cuts are the person's
// already and are left alone.
const MIN_SPLIT_PIECE_SECONDS = 0.6;
export function keepWords(cuts, words, wordIds) {
  const chosen = words.filter((word) => wordIds.includes(word.id)).sort((a, b) => a.start - b.start);
  if (chosen.length === 0) throw new Error("no words to keep");
  const start = chosen[0].start;
  const end = chosen.at(-1).end;
  const out = [];
  for (const cut of cuts) {
    if (!cut.enabled || cut.end <= start || cut.start >= end) { out.push(cut); continue; }
    for (const piece of [{ start: cut.start, end: Math.min(start, cut.end) }, { start: Math.max(end, cut.start), end: cut.end }]) {
      if (piece.end - piece.start < MIN_SPLIT_PIECE_SECONDS) continue;
      const sources = (cut.sources ?? [cut]).filter((s) => s.start < piece.end && s.end > piece.start);
      out.push({ ...piece, enabled: true, sources: sources.length ? sources : [{ ...(cut.sources?.[0] ?? {}), start: piece.start, end: piece.end }] });
    }
  }
  return normalizeCuts(out);
}
