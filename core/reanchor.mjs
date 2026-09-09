// Scenes anchor to clean-transcript word ids, and a fresh transcript of a
// re-cut film numbers its words differently. Re-anchoring finds each scene's
// old span in the new transcript by what was said there: the three words at
// its start and the three at its end, matched near where they used to be
// in time. No I/O; the server feeds it both transcripts' words.

const CONTEXT = 3;
const TIME_PENALTY_PER_SECOND = 1 / 60; // a token's worth of doubt per minute of drift
const MIN_SCORE = 2; // at least two of three context tokens

const norm = (text) => (text ?? "").toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");

// The best index in `words` whose forward (or backward) context matches
// `tokens`, preferring candidates near `nearSeconds`. Returns null when
// nothing reaches MIN_SCORE.
function bestMatch(words, tokens, nearSeconds, direction) {
  let best = null;
  for (let i = 0; i < words.length; i += 1) {
    let score = 0;
    for (let k = 0; k < tokens.length; k += 1) {
      const word = words[direction > 0 ? i + k : i - k];
      if (word && norm(word.text) === tokens[k] && tokens[k] !== "") score += 1;
    }
    if (score === 0) continue;
    const drift = Math.abs((direction > 0 ? words[i].start : words[i].end) - nearSeconds);
    const total = score - drift * TIME_PENALTY_PER_SECOND;
    if (!best || total > best.total) best = { index: i, score, drift, total };
  }
  // A scene on the transcript's first or last word has fewer than three
  // context tokens; it still has to be findable.
  return best && best.score >= Math.min(MIN_SCORE, tokens.filter(Boolean).length) ? best : null;
}

// One scene's old anchors (word ids into `oldWords`) → new anchors into
// `newWords`, with what was matched and how far it moved. `ok` is false
// when either end could not be found; the old ids are returned unchanged
// then, for the caller to keep or flag.
export function reanchorScene(scene, oldWords, newWords) {
  const oldById = new Map(oldWords.map((word) => [word.id, word]));
  const from = oldById.get(scene.fromWordId);
  const to = oldById.get(scene.toWordId);
  if (!from || !to) return { ok: false, reason: "old word ids not in the previous transcript", fromWordId: scene.fromWordId, toWordId: scene.toWordId };
  const fromIndex = oldWords.indexOf(from);
  const toIndex = oldWords.indexOf(to);
  const fromTokens = oldWords.slice(fromIndex, fromIndex + CONTEXT).map((w) => norm(w.text));
  const toTokens = oldWords.slice(Math.max(toIndex - CONTEXT + 1, 0), toIndex + 1).reverse().map((w) => norm(w.text));
  const start = bestMatch(newWords, fromTokens, from.start, +1);
  const end = bestMatch(newWords, toTokens, to.end, -1);
  if (!start || !end || newWords[end.index].start < newWords[start.index].start) {
    return {
      ok: false,
      reason: !start ? `start "${fromTokens.join(" ")}" not found near ${from.start.toFixed(1)}s` : !end ? `end "${[...toTokens].reverse().join(" ")}" not found near ${to.end.toFixed(1)}s` : "end found before start",
      fromWordId: scene.fromWordId,
      toWordId: scene.toWordId,
    };
  }
  const newFrom = newWords[start.index];
  const newTo = newWords[end.index];
  return {
    ok: true,
    fromWordId: newFrom.id,
    toWordId: newTo.id,
    text: newWords.slice(start.index, end.index + 1).map((w) => w.text).join(" "),
    shiftSeconds: Number((newFrom.start - from.start).toFixed(2)),
    confidence: Number(((start.score + end.score) / (fromTokens.length + toTokens.length)).toFixed(2)),
  };
}

// Every scene, in order; `scenes` is the compose file's list (word ids).
export function reanchorScenes(scenes, oldWords, newWords) {
  return scenes.map((scene, index) => ({ index, type: scene.type, ...reanchorScene(scene, oldWords, newWords) }));
}
