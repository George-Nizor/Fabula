// What the transcript is doing, moment by moment.
//
// An editor reads a script before cutting it and marks it up: here is the
// hook, here the subject changes, here is a number, here a list, here a
// comparison, here the speaker asks a question and then answers it. The
// marks are what the visuals hang from. Eight thousand words is too many to
// hold in one head while also composing, so this does the marking-up: it
// finds the paragraphs, the section changes, the opening, and every moment
// whose shape the kit already has a graphic for, and says which graphic.
//
// It is a reading, not a plan. Every moment carries the sentence it was found
// in, so the assistant can disagree from the words. Pure functions, no I/O,
// deterministic: the same transcript always reads the same way.

import { sentences } from "./clip-engine.mjs";

const clean = (text) => String(text ?? "").toLowerCase().replace(/[^a-z0-9'%$.-]/g, "");
const lower = (text) => String(text ?? "").toLowerCase();

// ---- Paragraphs and sections ----

// A pause this long is a new thought, whatever the punctuation says.
export const PARAGRAPH_PAUSE = 1.0;
const PARAGRAPH_MAX_SECONDS = 45;

// A sentence that opens with one of these is announcing a turn. The
// paragraph it starts is a candidate section boundary, and the sentence
// itself is a decent first draft of the section's heading.
const SIGNPOSTS = [
  /^(so|now|okay|ok|right|alright),? (the|let'?s|here'?s|there'?s|another|one more|next|moving|first|second|third|last)/,
  /^(next|secondly|thirdly|finally|lastly|first of all|first thing|second thing|third thing|one more thing|last thing)\b/,
  /^(let'?s (talk|move|look|go|start|get)|moving on|which brings|that brings|this brings|on to|onto)\b/,
  /^(the (first|second|third|fourth|last|next|other|final) (thing|part|point|reason|step|one|problem|mistake))\b/,
  /^(another (thing|point|reason|problem|mistake|example))\b/,
  /^(now|so) (let'?s|here'?s|the question|what about|onto|on to)\b/,
  /^(chapter|part|section|step|number|lesson|rule|tip|mistake|reason) (one|two|three|four|five|six|\d+)\b/,
];

const CONCLUSION = /^(so|anyway|in the end|to sum up|to wrap up|the point is|the takeaway|that'?s why|which is why|bottom line|in summary|all of that to say|that'?s (it|everything|all))\b/;

export function paragraphs(words, { pauseSeconds = PARAGRAPH_PAUSE } = {}) {
  const said = sentences(words);
  const out = [];
  let current = [];
  const flush = () => {
    if (!current.length) return;
    const first = current[0];
    const last = current.at(-1);
    out.push({
      index: out.length,
      fromWordId: first.fromWordId,
      toWordId: last.toWordId,
      start: first.start,
      end: last.end,
      seconds: Number((last.end - first.start).toFixed(1)),
      sentences: current.length,
      opening: first.text,
      signpost: SIGNPOSTS.some((re) => re.test(openingOf(first.text))),
      conclusion: CONCLUSION.test(openingOf(first.text)),
    });
    current = [];
  };
  for (const sentence of said) {
    const opens = current.length > 0 && SIGNPOSTS.some((re) => re.test(openingOf(sentence.text)));
    const long = current.length > 0 && sentence.end - current[0].start > PARAGRAPH_MAX_SECONDS;
    if (opens || long) flush();
    current.push(sentence);
    if (sentence.gapAfter >= pauseSeconds) flush();
  }
  flush();
  return out;
}

const openingOf = (text) => lower(text).replace(/^[^a-z0-9]+/, "").replace(/^(um|uh|erm|yeah|well|and|but)\s+/, "");

// Where the film turns. A paragraph that opens on a signpost is a boundary;
// so is a paragraph that starts a long enough stretch on visibly new words.
// Each carries a heading drafted from its first sentence, trimmed of the
// signpost itself, because "So the second thing is rendering" wants to be
// read as "Rendering".
export function sections(words, { minSeconds = 40 } = {}) {
  const paras = paragraphs(words);
  if (paras.length === 0) return [];
  const bounds = [paras[0]];
  for (let i = 1; i < paras.length; i += 1) {
    const para = paras[i];
    const sinceLast = para.start - bounds.at(-1).start;
    if (para.signpost && sinceLast >= minSeconds * 0.5) { bounds.push(para); continue; }
    if (sinceLast < minSeconds) continue;
    // Vocabulary shift: how much of this paragraph's substance appeared in
    // the previous two. Little overlap on a long stretch reads as a new topic.
    const before = new Set(vocabulary(words, paras[Math.max(i - 2, 0)].fromWordId, paras[i - 1].toWordId));
    const here = vocabulary(words, para.fromWordId, para.toWordId);
    if (here.length >= 8) {
      const shared = here.filter((word) => before.has(word)).length / here.length;
      if (shared < 0.12) bounds.push(para);
    }
  }
  return bounds.map((para, index) => {
    const next = bounds[index + 1];
    const end = next ? paras[next.index - 1].end : paras.at(-1).end;
    const toWordId = next ? paras[next.index - 1].toWordId : paras.at(-1).toWordId;
    return {
      index,
      fromWordId: para.fromWordId,
      toWordId,
      start: para.start,
      end,
      seconds: Number((end - para.start).toFixed(1)),
      heading: headingFrom(para.opening),
      opening: para.opening,
      signposted: para.signpost,
    };
  });
}

const STOP = new Set(["the", "and", "that", "this", "with", "have", "from", "they", "what", "there", "which", "about", "would", "your", "their", "just", "like", "then", "than", "into", "because", "really", "thing", "things", "going", "actually", "something", "people", "when", "where", "were", "been", "them", "these", "those", "some", "more", "very", "also", "here", "kind", "sort", "know", "want", "make", "okay", "right", "yeah", "gonna", "it's", "that's", "don't", "doesn't", "didn't", "i'm", "you're", "we're"]);

function vocabulary(words, fromId, toId) {
  return words.filter((word) => word.id >= fromId && word.id <= toId)
    .map((word) => clean(word.text)).filter((word) => word.length > 3 && !STOP.has(word));
}

function headingFrom(sentence) {
  let text = String(sentence).trim().replace(/[.!?…]+$/, "");
  for (let pass = 0; pass < 3; pass += 1) {
    const before = text;
    text = text.replace(/^(um|uh|so|now|okay|ok|right|alright|and|but|anyway|then|well|yeah)[,\s]+/i, "");
    text = text.replace(/^(the (first|second|third|fourth|last|next|other|final) (thing|part|point|reason|step|one|problem|mistake)( i want to (talk|mention)( about)?)?( is| was)?)[,:\s]+/i, "");
    text = text.replace(/^(let'?s (talk|move|look|go) (about|on|onto|at|to))[,:\s]+/i, "");
    text = text.replace(/^(one more thing|another thing|next thing|last thing|next up|moving on)( about| is|:)?[,:\s]*/i, "");
    text = text.replace(/^(i (want|wanted|also want) to (talk|mention|say|cover|show|explain)( about| you)?)[,:\s]+/i, "");
    if (before === text) break;
  }
  const trimmed = text.split(" ").slice(0, 7).join(" ");
  return trimmed.length ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : sentence;
}

// ---- Moments ----
//
// Each detector reads one sentence and says what shape it has. The
// suggestions name kit kinds and template ids; the first is the one to try.

const NUMBER_WORDS = /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|half|quarter|double|triple)\b/;
const UNITS = /\b(percent|per cent|%|dollars?|bucks|pounds?|euros?|minutes?|mins?|seconds?|secs?|hours?|hrs?|days?|weeks?|months?|years?|times|x|fold|k|gb|mb|tb|kb|fps|ms|km|miles?|meters?|metres?|kilos?|pounds?|grams?|users?|people|subscribers?|views?|customers?|watts?|degrees?|calories|steps|frames?|words?|lines?|pages?|episodes?)\b/;

const DETECTORS = [
  {
    kind: "question",
    test: (text) => /\?\s*$/.test(text.trim()) && text.split(" ").length >= 3,
    suggest: ["question", "kinetic", "focus"],
    why: "the speaker asks before answering — a beat to return to the head on, or to hang the question in the air",
  },
  {
    kind: "number",
    test: (text) => /\d/.test(text) || (NUMBER_WORDS.test(lower(text)) && UNITS.test(lower(text))),
    suggest: ["stat", "big-number", "trio", "chart"],
    why: "a figure said aloud is remembered when it is also seen",
  },
  {
    kind: "list",
    // An ordinal counts only when it is counting: "the third law" is a name,
    // "third, the encoder" is a list.
    test: (text) => /\b(three|four|five|3|4|5|two|2) (things|reasons|ways|steps|rules|mistakes|tips|parts|points|options|kinds|types|problems|lessons|questions|ideas|principles|habits|tools)\b/.test(lower(text)) || /\b(first(ly)?|second(ly)?|third(ly)?)(?=,|\s+(thing|reason|step|point|one|part|way|rule|mistake|tip|of all|is|was|up|and|there|you|we|i)\b)|\bnumber (one|two|three|1|2|3)\b/.test(lower(text)),
    suggest: ["list", "steps", "teaser", "ranking"],
    why: "an enumeration the viewer will want to keep count of",
  },
  {
    kind: "comparison",
    test: (text) => /\b(versus|vs\.?|compared (to|with)|instead of|rather than|(better|worse|faster|slower|cheaper|bigger|smaller|more|less) than|the difference between|on the other hand|whereas|as opposed to)\b/.test(lower(text)),
    suggest: ["compare", "before-after", "scale", "split"],
    why: "two things set against each other want to be seen side by side",
  },
  {
    kind: "change",
    test: (text) => /\b(used to|before .* (now|after)|went from|dropped from|rose from|from .* to|no longer|turned into|became|ended up)\b/.test(lower(text)),
    suggest: ["before-after", "progress", "timeline"],
    why: "a before and an after",
  },
  {
    kind: "definition",
    test: (text) => /\b(is called|it'?s called|which is called|what i call|the term|means that|which means|is when|is basically|is essentially|is just|is simply|by definition|in other words)\b/.test(lower(text)),
    suggest: ["definition", "callout", "word"],
    why: "a term is being introduced or redefined",
  },
  {
    kind: "process",
    test: (text) => /\b(step (one|two|three|1|2|3)|then you|and then|after that|once you|next you|the next step|the first step|start by|finally you|end up with|leads to|which leads|turns into)\b/.test(lower(text)),
    suggest: ["flow", "steps", "screen"],
    why: "one thing leads to the next",
  },
  {
    kind: "quote",
    test: (text) => /\b(said|says|told me|asked me|wrote|writes|the comment|comments? (said|were|was)|someone (said|asked|wrote|messaged)|texted|emailed|replied|quote|in the words of|according to)\b/.test(lower(text)),
    suggest: ["quote", "post", "phone"],
    why: "someone else's words, read out",
  },
  {
    kind: "claim",
    test: (text) => /\b(never|always|nobody|no one|everyone|everybody|the only|the biggest|the best|the worst|the most important|the single|the truth is|the reality is|here'?s the thing|the secret|the real reason|what nobody tells you|most people (think|believe|get wrong))\b/.test(lower(text)),
    suggest: ["word", "myth-fact", "hook", "kinetic"],
    why: "an absolute — the kind of line a short is cut around",
  },
  {
    kind: "warning",
    test: (text) => /\b(mistake|mistakes|don'?t (do|ever|try|make)|never (do|use|try)|be careful|careful|the problem is|the catch|the trap|gotcha|watch out|warning|dangerous|will break|breaks|bit me|cost me)\b/.test(lower(text)),
    suggest: ["alert", "callout", "myth-fact"],
    why: "a caution the viewer should not miss",
  },
  {
    kind: "time",
    test: (text) => /\b((19|20)\d\d|last (year|month|week)|next (year|month|week)|years? ago|months? ago|weeks? ago|days? ago|(mon|tues|wednes|thurs|fri|satur|sun)day|january|february|march|april|june|july|august|september|october|november|december|back in|at the time|since then|these days|nowadays|the first time|the last time)\b/.test(lower(text)),
    suggest: ["timeline", "headline", "section"],
    why: "a moment placed in time",
  },
  {
    kind: "name",
    test: (text) => properNouns(text).length > 0,
    suggest: ["image", "logos", "search_images"],
    why: "a named product, tool, place or person — a picture or a logo beside the words is usually worth two calls",
    evidence: (text) => properNouns(text),
  },
  {
    kind: "code",
    test: (text) => /\b(command|terminal|flag|function|variable|config|the line|one line|a line of code|script|npm|git|ffmpeg|json|css|html|api|sql|regex|shortcut|keyboard|ctrl|cmd|alt|shift)\b/.test(lower(text)),
    suggest: ["code", "keys", "screen"],
    why: "something typed or pressed; show it as it is written",
  },
  {
    kind: "cta",
    test: (text) => /\b(subscribe|like and|the description|link (below|in)|full video|the full|watch the|check out|let me know in the comments|comment below|follow (me|for)|next video|the channel|the playlist)\b/.test(lower(text)),
    suggest: ["cta", "callout"],
    why: "an ask of the viewer — the funnel's mouth",
  },
];

// Capitalised words that are not at a sentence start and are not "I".
// Cheap, and wrong in the ways one expects (a capitalised "Monday" is a
// time, not a name); the time detector runs as well, so both get said.
function properNouns(text) {
  const tokens = String(text).split(/\s+/);
  const out = [];
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i].replace(/[^\p{L}\p{N}'.+-]/gu, "").replace(/['’]s$/, "");
    if (!token || token === "I" || token === "I'm" || token === "I've") continue;
    const prev = tokens[i - 1];
    if (/[.!?]$/.test(prev)) continue;
    if (/^[A-Z][a-z]+$/.test(token) && !/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December|The|And|But|So|Then|Now|Okay|Yes|No|Right|Well|Because|When|What|Where|Why|How|Who|Which|If|Also|Just|Like|Actually|Basically|Literally|Anyway)$/.test(token)) out.push(token);
    else if (/^[A-Z][A-Za-z0-9]*[A-Z0-9][A-Za-z0-9]*$/.test(token) && token.length >= 2 && token.length <= 20) out.push(token); // GPT-4, WhisperX, NVENC, iPhone
  }
  return [...new Set(out)];
}

export function moments(words, { limit = 80 } = {}) {
  const said = sentences(words);
  const found = [];
  for (const sentence of said) {
    if (sentence.words.length < 3) continue;
    for (const detector of DETECTORS) {
      if (!detector.test(sentence.text)) continue;
      found.push({
        kind: detector.kind,
        fromWordId: sentence.fromWordId,
        toWordId: sentence.toWordId,
        start: sentence.start,
        end: sentence.end,
        text: sentence.text,
        suggest: detector.suggest,
        why: detector.why,
        ...(detector.evidence ? { evidence: detector.evidence(sentence.text) } : {}),
      });
    }
  }
  // Most useful first when there are too many: the shapes the kit draws best
  // outrank the ones that only name a tone. Then back into time order.
  const rank = { number: 0, comparison: 1, list: 2, question: 3, definition: 4, process: 5, quote: 6, change: 7, time: 8, code: 9, warning: 10, name: 11, claim: 12, cta: 13 };
  return found
    .sort((a, b) => rank[a.kind] - rank[b.kind] || a.start - b.start)
    .slice(0, limit)
    .sort((a, b) => a.start - b.start || rank[a.kind] - rank[b.kind]);
}

// ---- The opening and the ending ----

const HOOKS = [
  /^(here'?s|this is)\b/, /^(the|my|one) (thing|trick|problem|mistake|reason|rule|way|question|difference|point|secret)\b/,
  /^(if|when|why|how|what|the moment)\b/, /^(most|everyone|nobody|people|you)\b/,
  /^(i (used to|spent|learned|found|realis|realiz|discovered|built|made|lost|wasted))/, /^(never|always|stop|don'?t|forget|imagine)\b/,
  /^(there('| i)s (a|an|one|no)\b)/, /^(let me|picture|say)\b/,
];
const THROAT_CLEARING = /^(hi|hello|hey|welcome|what'?s up|good (morning|evening|afternoon)|so today|today (i|we)|in this video|my name is|i'?m [a-z]+ and|before we (start|begin)|quick(ly)? (before|note)|don'?t forget)\b/;

export function opening(words, { seconds = 20 } = {}) {
  const said = sentences(words).filter((sentence) => sentence.start < seconds);
  if (said.length === 0) return null;
  const notes = [];
  const first = said[0];
  const firstOpen = openingOf(first.text);
  const clearing = said.filter((sentence) => THROAT_CLEARING.test(openingOf(sentence.text)));
  if (clearing.length) notes.push(`${clearing.length} sentence(s) of preamble before anything is promised — the cut can lose them, or a hook template can run over them`);
  const hookIndex = said.findIndex((sentence) => HOOKS.some((re) => re.test(openingOf(sentence.text))));
  if (hookIndex === -1) notes.push("nothing in the opening promises the viewer anything; consider a hook line drawn from later in the film, or a cold-open cut");
  else if (hookIndex > 0) notes.push(`the promise arrives at ${said[hookIndex].start.toFixed(1)}s, sentence ${hookIndex + 1}: “${said[hookIndex].text}”`);
  else notes.push("opens on a promise");
  return {
    fromWordId: first.fromWordId,
    toWordId: said.at(-1).toWordId,
    firstLine: first.text,
    hook: hookIndex >= 0 ? { fromWordId: said[hookIndex].fromWordId, toWordId: said[hookIndex].toWordId, text: said[hookIndex].text, at: said[hookIndex].start } : null,
    preamble: clearing.map((sentence) => ({ fromWordId: sentence.fromWordId, toWordId: sentence.toWordId, text: sentence.text })),
    notes,
    firstOpening: firstOpen,
  };
}

export function ending(words, { seconds = 25 } = {}) {
  const said = sentences(words);
  if (said.length === 0) return null;
  const end = said.at(-1).end;
  const tail = said.filter((sentence) => sentence.end > end - seconds);
  const conclusion = tail.find((sentence) => CONCLUSION.test(openingOf(sentence.text)));
  const cta = tail.find((sentence) => DETECTORS.find((d) => d.kind === "cta").test(sentence.text));
  const notes = [];
  if (!conclusion) notes.push("no sentence in the last stretch reads as a conclusion; the film stops rather than ends");
  if (cta) notes.push(`the ask is at ${cta.start.toFixed(1)}s: “${cta.text}”`);
  return {
    fromWordId: tail[0].fromWordId,
    toWordId: said.at(-1).toWordId,
    lastLine: said.at(-1).text,
    conclusion: conclusion ? { fromWordId: conclusion.fromWordId, toWordId: conclusion.toWordId, text: conclusion.text } : null,
    cta: cta ? { fromWordId: cta.fromWordId, toWordId: cta.toWordId, text: cta.text } : null,
    notes,
  };
}

// ---- The whole reading ----

export function readStory(words, { limit = 80 } = {}) {
  if (!words?.length) return { seconds: 0, sentences: 0, paragraphs: [], sections: [], moments: [], opening: null, ending: null, counts: {} };
  const paras = paragraphs(words);
  const found = moments(words, { limit });
  const counts = {};
  for (const moment of found) counts[moment.kind] = (counts[moment.kind] ?? 0) + 1;
  return {
    seconds: Number(words.at(-1).end.toFixed(1)),
    sentences: sentences(words).length,
    paragraphs: paras.map((para) => ({ ...para, opening: para.opening.split(" ").slice(0, 12).join(" ") })),
    sections: sections(words),
    opening: opening(words),
    ending: ending(words),
    moments: found,
    counts,
  };
}

// ---- Cuts an editor makes from the words ----
//
// The deterministic pass strikes pauses and fillers. These are the cuts a
// person makes from reading: the preamble before the film promises anything,
// a false start (a fragment the speaker abandons and then says properly), and
// a stutter (a word said twice running). Proposals, on the RAW transcript's
// word ids, for review.json — the person toggles them like any other.

// A run of two to six words said twice running — "I think the, I think the
// best way" — is a false start: the speaker abandoned the first and said it
// again properly. The first run goes. Found on the words themselves, because
// an abandoned fragment rarely earns a full stop or a pause of its own.
const FALSE_START_MAX_WORDS = 6;

export function falseStarts(words) {
  const bare = words.map((w) => clean(w.text));
  const out = [];
  let i = 0;
  while (i < words.length) {
    let hit = null;
    for (let k = FALSE_START_MAX_WORDS; k >= 2; k -= 1) {
      if (i + 2 * k > words.length) continue;
      let same = true;
      for (let j = 0; j < k; j += 1) if (!bare[i + j] || bare[i + j] !== bare[i + k + j]) { same = false; break; }
      if (!same) continue;
      // Two tiny words twice ("so so", "and and") are a stutter, not a start.
      if (bare.slice(i, i + k).join("").length < 6) continue;
      // Across a real pause it is emphasis or a list; a false start is close.
      if (words[i + k].start - words[i + k - 1].end > 0.6) continue;
      hit = k;
      break;
    }
    if (hit) {
      out.push({ fromWordId: words[i].id, toWordId: words[i + hit - 1].id, reason: "false-start", detail: `“${words.slice(i, i + hit).map((w) => w.text).join(" ")}” — said again at once` });
      i += hit;
    } else i += 1;
  }
  return out;
}

export function stutters(words) {
  const out = [];
  for (let i = 1; i < words.length; i += 1) {
    const a = clean(words[i - 1].text);
    const b = clean(words[i].text);
    if (!a || a !== b || a.length < 2) continue;
    // Only the first of the pair goes, and only when they are close: "that
    // that" across a pause is emphasis, not a stutter.
    if (words[i].start - words[i - 1].end > 0.35) continue;
    if (/^(very|really|no|yes|so|go|ha|ah)$/.test(a)) continue;
    out.push({ fromWordId: words[i - 1].id, toWordId: words[i - 1].id, reason: "stutter", detail: `“${words[i - 1].text} ${words[i].text}”` });
  }
  return out;
}

export function preambleCuts(words) {
  const open = opening(words);
  if (!open?.preamble?.length) return [];
  return open.preamble.map((sentence) => ({ fromWordId: sentence.fromWordId, toWordId: sentence.toWordId, reason: "preamble", detail: `“${sentence.text}” — before the film promises anything` }));
}

export function editorialCuts(words, { kinds = ["preamble", "false-start", "stutter"] } = {}) {
  const wanted = new Set(kinds);
  return [
    ...(wanted.has("preamble") ? preambleCuts(words) : []),
    ...(wanted.has("false-start") ? falseStarts(words) : []),
    ...(wanted.has("stutter") ? stutters(words) : []),
  ].sort((a, b) => a.fromWordId - b.fromWordId);
}
