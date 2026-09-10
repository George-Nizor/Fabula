// Where the short films are inside the long one.
//
// A short is not a slice of a talk. It is a piece that happens to have been
// said inside one: it starts where a thought starts, ends where the thought
// lands, and does not need the twenty minutes around it to make sense. Nobody
// can read that off a waveform, and this engine does not pretend to — what it
// does is narrow a forty-minute transcript to a few dozen honest candidates
// and say what it noticed about each, so the judgment happens over a shortlist
// with the words in front of it rather than over eight thousand words.
//
// Pure functions over the clean transcript's words. No I/O, no model, no
// randomness: the same transcript always yields the same candidates in the
// same order, which is what makes them arguable.

// Where a sentence can end. WhisperX keeps punctuation attached to the word.
import { keepSegments } from "./cut-engine.mjs";

const SENTENCE_END = /[.!?…]["')\]]?$/;
const CLAUSE_END = /[,;:—–]$/;

// A short that opens on one of these is opening in the middle of something:
// the viewer has to supply what "it", "that" or "so" refers to, and they will
// not. Not fatal — a strong line can start with "And" — but it costs.
const DANGLING_START = new Set([
  "it", "its", "it's", "they", "them", "their", "he", "she", "his", "her", "this", "that", "these", "those",
  "so", "then", "but", "and", "because", "which", "who", "also", "however", "therefore", "anyway", "again",
  "there", "here", "such",
]);

// A first line that promises the viewer something. These are not magic words;
// they are the shapes of an opening that says what the next thirty seconds are
// for, which is the whole job of a short's first second.
const HOOK_OPENERS = [
  /^(here'?s|this is)\b/, /^(the|my|one) (thing|trick|problem|mistake|reason|rule|way|question|difference|point)\b/,
  /^(if|when|why|how|what|the moment)\b/, /^(most|everyone|nobody|people|you)\b/,
  /^(i (used to|spent|learned|found|realis|realiz|discovered|built|made))/, /^(never|always|stop|don'?t|forget)\b/,
  /^(there('| i)s (a|an|one|no)\b)/, /^(let me|imagine|picture|say)\b/,
];

// Words that carry a claim rather than a connective. A span thick with them is
// making a point; a span thin with them is usually throat-clearing.
const SUBSTANCE = [
  /\d/, /%$/, /^(never|always|every|nothing|nobody|everyone|only|first|best|worst|fastest|hardest|simplest)$/,
  /^(because|instead|rather|actually|literally|exactly|honestly)$/,
  /^(means?|matters?|works?|breaks?|fails?|wins?|costs?|saves?|proves?|shows?)$/,
];

const FILLER_START = /^(um|uh|erm|uhm|so|and|but|okay|ok|right|yeah|well|anyway|now)\b/i;

const clean = (text) => String(text ?? "").toLowerCase().replace(/[^a-z0-9'%]/g, "");
const sentenceText = (words) => words.map((word) => word.text).join(" ").replace(/\s+([,.;:!?])/g, "$1").trim();

// ---- Sentences ----
//
// The unit a clip is built from. A sentence ends at terminal punctuation, or
// at a pause long enough that the speaker plainly finished — WhisperX
// punctuates a talking head unevenly, and a clip that ends mid-breath is worse
// than one that ends a beat late.
export const SENTENCE_PAUSE = 0.55;

export function sentences(words, { pauseSeconds = SENTENCE_PAUSE } = {}) {
  const out = [];
  let current = [];
  for (let i = 0; i < words.length; i += 1) {
    current.push(words[i]);
    const next = words[i + 1];
    const gap = next ? next.start - words[i].end : Infinity;
    const ends = SENTENCE_END.test(words[i].text) || gap >= pauseSeconds || !next;
    if (!ends) continue;
    out.push({
      index: out.length,
      words: current,
      fromWordId: current[0].id,
      toWordId: current.at(-1).id,
      start: current[0].start,
      end: current.at(-1).end,
      text: sentenceText(current),
      // The silence after it. A clip that ends into a long pause ends cleanly.
      gapAfter: Number.isFinite(gap) ? gap : 0,
      terminal: SENTENCE_END.test(words[i].text),
    });
    current = [];
  }
  return out;
}

// ---- Scoring one candidate ----
//
// Every note is a sentence a person can disagree with, and the score is only
// the notes added up. Nothing here is tuned to a hidden target; if a candidate
// ranks badly the reason is printed next to it.
function scoreSpan(span, { duration }) {
  const notes = [];
  let score = 0;
  const seconds = span.end - span.start;
  const first = span.sentences[0];
  const last = span.sentences.at(-1);
  const firstWords = first.words.map((word) => clean(word.text)).filter(Boolean);
  const opening = first.text.toLowerCase().replace(/^[^a-z0-9]+/, "");

  // Length against what the format wants. A short that runs long is not
  // wrong, it is a different piece; one that runs short has nothing in it.
  const ideal = duration?.ideal ?? 38;
  const min = duration?.min ?? 12;
  const max = duration?.max ?? 90;
  if (seconds < min || seconds > max) return null;
  const fit = 1 - Math.min(Math.abs(seconds - ideal) / ideal, 1);
  score += fit * 22;
  if (seconds > max * 0.85) notes.push(`${Math.round(seconds)}s — near the top of what the format holds`);

  // The opening. This is the half of a short that decides whether the rest is
  // watched at all, so it is weighted like it.
  // The shape is named, not judged: "if" is a hook's shape and also a
  // conditional's, and only the reader can tell which this one is.
  const hookShape = HOOK_OPENERS.map((re) => opening.match(re)?.[0]).find(Boolean);
  if (hookShape) { score += 16; notes.push(`opens in a hook's shape (“${hookShape}…”) — a promise if the sentence keeps it`); }
  if (DANGLING_START.has(firstWords[0])) { score -= 14; notes.push(`opens on “${first.words[0].text}” — the viewer has to supply what it refers to`); }
  if (FILLER_START.test(first.text)) { score -= 6; notes.push("opens on a connective; trim the first word or two"); }
  if (/\?$/.test(first.text)) { score += 8; notes.push("opens on a question"); }

  // The ending. A short that stops mid-clause reads as a clip of something
  // else, which is exactly what it must not.
  if (last.terminal) score += 9;
  else { score -= 10; notes.push("does not end on a full stop — check it lands"); }
  if (CLAUSE_END.test(last.words.at(-1).text)) { score -= 8; notes.push("ends on a comma"); }
  if (last.gapAfter >= 0.8) { score += 5; notes.push("ends into a pause"); }

  // What is actually being said. Density of claim-bearing words, and whether
  // the piece stays on one thing rather than wandering across three.
  const all = span.sentences.flatMap((sentence) => sentence.words.map((word) => clean(word.text)));
  const substance = all.filter((word) => SUBSTANCE.some((re) => re.test(word))).length;
  const density = substance / Math.max(all.length, 1);
  score += Math.min(density * 90, 14);
  if (substance === 0) notes.push("no numbers, comparisons or claims in it");

  // Words per second: a short is watched, not studied. Far below conversational
  // pace usually means the span is mostly silence or a long demonstration.
  const pace = all.length / Math.max(seconds, 0.001);
  if (pace < 1.6) { score -= 8; notes.push(`${pace.toFixed(1)} words a second — mostly silence or screen time`); }

  // One subject. Repeated content words across the span are the cheapest
  // available signal that it is about one thing.
  const counts = new Map();
  for (const word of all) if (word.length > 4) counts.set(word, (counts.get(word) ?? 0) + 1);
  const repeated = [...counts.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);
  if (repeated.length) { score += Math.min(repeated.length * 2.5, 8); notes.push(`stays on ${repeated.slice(0, 3).map(([word]) => word).join(", ")}`); }

  return { score: Math.round(score * 10) / 10, notes, seconds };
}

// ---- Finding them ----
//
// Every run of consecutive sentences whose length the format could hold, scored,
// then thinned so the shortlist is a set of different moments rather than
// fifteen framings of the same one.
export function findClips(words, { duration, limit = 8, overlap = 0.35 } = {}) {
  const said = sentences(words);
  if (said.length === 0) return [];
  const min = duration?.min ?? 12;
  const max = duration?.max ?? 90;
  const candidates = [];
  for (let i = 0; i < said.length; i += 1) {
    for (let j = i; j < said.length; j += 1) {
      const seconds = said[j].end - said[i].start;
      if (seconds < min) continue;
      if (seconds > max) break;
      const span = { sentences: said.slice(i, j + 1), start: said[i].start, end: said[j].end };
      const scored = scoreSpan(span, { duration });
      if (!scored) continue;
      candidates.push({
        fromWordId: said[i].fromWordId,
        toWordId: said[j].toWordId,
        start: Number(span.start.toFixed(2)),
        end: Number(span.end.toFixed(2)),
        seconds: Number(scored.seconds.toFixed(1)),
        sentences: j - i + 1,
        score: scored.score,
        notes: scored.notes,
        text: span.sentences.map((sentence) => sentence.text).join(" "),
        opening: said[i].text,
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.start - b.start);
  // Thin: a candidate that mostly repeats one already taken is the same moment
  // argued differently, and a shortlist of those is not a shortlist.
  const kept = [];
  for (const candidate of candidates) {
    const clash = kept.some((taken) => {
      const shared = Math.min(taken.end, candidate.end) - Math.max(taken.start, candidate.start);
      return shared > 0 && shared / Math.min(taken.end - taken.start, candidate.end - candidate.start) > overlap;
    });
    if (!clash) kept.push(candidate);
    if (kept.length >= limit) break;
  }
  return kept.sort((a, b) => a.start - b.start).map((clip, index) => ({ ...clip, index }));
}

// ---- A span someone chose ----
//
// The window and the assistant both hand back word ids rather than seconds,
// because word ids are what everything in Fabula anchors to. This resolves a
// pair to the span it names and refuses the ones that cannot be a film.
export function resolveClipSpan(words, fromWordId, toWordId, { duration } = {}) {
  const byId = new Map(words.map((word) => [word.id, word]));
  const from = byId.get(fromWordId);
  const to = byId.get(toWordId);
  if (!from) throw new Error(`no word ${fromWordId} in the clean transcript`);
  if (!to) throw new Error(`no word ${toWordId} in the clean transcript`);
  if (to.id < from.id) throw new Error("the clip ends before it starts");
  const seconds = to.end - from.start;
  if (seconds < 2) throw new Error(`a ${seconds.toFixed(1)}s clip is not a film`);
  const span = { fromWordId: from.id, toWordId: to.id, start: from.start, end: to.end, seconds: Number(seconds.toFixed(2)) };
  const min = duration?.min;
  const max = duration?.max;
  span.warnings = [];
  if (min !== undefined && seconds < min) span.warnings.push(`${seconds.toFixed(1)}s is under the ${min}s this format expects`);
  if (max !== undefined && seconds > max) span.warnings.push(`${seconds.toFixed(1)}s is over the ${max}s this format expects`);
  return span;
}

// The words of the clip, renumbered from zero and re-timed to its own start.
// The short's transcript is the parent's, restricted — not a new transcription,
// because a new transcription of the same audio would drift and every scene
// anchored to it would have to be placed again.
export function clipWords(words, span, { pad = 0 } = {}) {
  const inside = words.filter((word) => word.id >= span.fromWordId && word.id <= span.toWordId);
  const offset = Math.max(span.start - pad, 0);
  return inside.map((word, index) => ({
    id: index,
    text: word.text,
    start: Number(Math.max(word.start - offset, 0).toFixed(3)),
    end: Number(Math.max(word.end - offset, 0).toFixed(3)),
    sourceId: word.id,
  }));
}

// ---- Back to the recording ----
//
// A clip is chosen on the clean timeline, where the words are. The short is
// cut from the RECORDING, with the same cut list that made the clean cut, so
// its own clean render is a fresh render of the original footage rather than a
// crop of a crop — which is what lets it be framed for a different shape.
// out/clean-map.json is the dictionary between the two timelines.
export function rawTimeOf(pieces, cleanTime) {
  if (!pieces?.length) throw new Error("no clean map: the clean cut has not been rendered");
  for (const piece of pieces) {
    if (cleanTime >= piece.cleanStart - 1e-6 && cleanTime <= piece.cleanEnd + 1e-6) {
      return piece.start + (cleanTime - piece.cleanStart);
    }
  }
  // Between pieces (inside a cut) or past the end: the nearest edge, which is
  // where the sound the viewer heard at that instant actually came from.
  const before = pieces.filter((piece) => piece.cleanEnd <= cleanTime).at(-1);
  if (before) return before.end;
  return pieces[0].start;
}

export function rawSpanOfClean(pieces, start, end) {
  return { start: rawTimeOf(pieces, start), end: rawTimeOf(pieces, end) };
}

// The cut list a short inherits.
//
// Built from what the long film actually SHOWS — its keeps — narrowed to the
// clip, and turned back into cuts. Doing it that way rather than merging two
// boundary cuts into the film's list matters: normalizeCuts disables a merged
// cut when any part of it was disabled, so a boundary that happened to touch
// one of the person's kept proposals would quietly restore the whole recording
// around the short. Everything outside the clip is cut, by construction.
//
// Each gap carries the reasons the film had for it, so the short's Cut step
// still says why a passage is struck. What does not travel is a proposal the
// person turned OFF: it removed nothing, so there is nothing to show, and the
// short can be cut by hand like any other project if they change their mind.
export function clipCutList(cuts, rawSpan, duration) {
  const shown = keepSegments(cuts, duration)
    .map((keep) => ({ start: Math.max(keep.start, rawSpan.start), end: Math.min(keep.end, rawSpan.end) }))
    .filter((keep) => keep.end - keep.start > 0.001);
  const gaps = [];
  let cursor = 0;
  for (const keep of shown) {
    if (keep.start > cursor + 0.001) gaps.push([cursor, keep.start]);
    cursor = keep.end;
  }
  if (cursor < duration - 0.001) gaps.push([cursor, duration]);
  return gaps.map(([start, end]) => ({
    start, end, enabled: true,
    sources: reasonsFor(cuts, start, end, rawSpan),
  }));
}

// Why this stretch is gone: the film's own reasons where they overlap it, and
// "outside-clip" for whatever is left, which is the part the clip excluded.
function reasonsFor(cuts, start, end, rawSpan) {
  const sources = [];
  for (const cut of cuts) {
    if (!cut.enabled || cut.end <= start + 0.001 || cut.start >= end - 0.001) continue;
    for (const source of cut.sources ?? [cut]) {
      if (source.enabled === false) continue;
      sources.push({ ...source, start: Math.max(source.start, start), end: Math.min(source.end, end) });
    }
  }
  const outside = start < rawSpan.start || end > rawSpan.end;
  if (outside || sources.length === 0) {
    sources.push({ start, end, reason: "outside-clip", enabled: true });
  }
  return sources.sort((a, b) => a.start - b.start);
}
