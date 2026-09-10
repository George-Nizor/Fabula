// A first draft of the plan, from the reading.
//
// The blank plan is the expensive moment: eight thousand words, forty
// moments, two shapes, and the first version has to place every card by
// word id with the dwell rule in mind. Most of that is mechanical. This turns
// read_story's marks into a skeleton — the promise as a hook over the
// opening, a section mark at every turn, a card at the moments that carry
// their own text (a question, a quote, a warning, a claim, a name, a number
// said aloud), the conclusion as the spoken word, the ask as a call to
// action — spaced so nothing crowds, in the shape the film is in, at the
// density the persona wants.
//
// It is a draft, not an edit. Every card it writes quotes the speaker or
// names the moment; it invents no numbers and no lines. Where a moment wants
// judgment — a chart's values, a definition's meaning, a picture — it says
// so in `todo` rather than guessing. Pure.

import { readStory } from "./story-engine.mjs";

// How often a card may land, and how long one holds, by who is cutting.
export const DENSITY = {
  editor: { minGap: 18, cardSeconds: 7, maxCards: 40 },
  farmer: { minGap: 4, cardSeconds: 4, maxCards: 14 },
};

const trimTo = (text, max) => {
  const words = String(text).replace(/[.!?…]+$/, "").split(/\s+/).filter(Boolean);
  return words.length <= max ? words.join(" ") : `${words.slice(0, max).join(" ")}…`;
};
// A callout is a phrase, not a sentence cut off. When the sentence is longer
// than a callout holds, the moment goes to the to-do list with the words
// left for the assistant to write, rather than to the stage as a fragment.
const calloutOrNote = (sentence, span, max, style, todo) => {
  const words = String(sentence).replace(/[.!?…]+$/, "").split(/\s+/).filter(Boolean);
  if (words.length <= max) return { type: "callout", ...span, text: words.join(" "), style, ...(todo ? { todo } : {}) };
  return { type: "note", ...span, todo: `${todo ? `${todo}; ` : ""}the sentence is ${words.length} words, more than a callout holds — write the phrase yourself, or leave the head to say it` };
};
// A hook line is twelve words at most: the first clause when the sentence
// runs on, cut at a pause rather than mid-phrase, never with an ellipsis.
const hookLine = (text) => {
  const clean = String(text).replace(/[.!?]+$/, "").trim();
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length <= 12) return charsTo(clean, 90);
  const pause = clean.search(/[,;:—–-]\s/);
  const clause = pause > 0 ? clean.slice(0, pause) : clean;
  const kept = clause.split(/\s+/).filter(Boolean).slice(0, 12).join(" ");
  return charsTo(kept, 90);
};
// Six words of the promise's first clause, for the face at frame one.
const thumbLine = (text) => {
  const clean = String(text).replace(/[.!?]+$/, "").trim();
  const pause = clean.search(/[,;:—–-]\s/);
  const clause = pause > 0 ? clean.slice(0, pause) : clean;
  return charsTo(clause.split(/\s+/).filter(Boolean).slice(0, 6).join(" "), 40);
};
const charsTo = (text, max) => (String(text).length <= max ? String(text) : `${String(text).slice(0, max - 1).trim()}…`);

// The word ids a card covers: from the moment's first word, for about
// `seconds`, never past the moment's last word and never under two words.
function spanFor(words, moment, seconds) {
  const byId = new Map(words.map((w) => [w.id, w]));
  const first = byId.get(moment.fromWordId);
  let last = first;
  for (let id = moment.fromWordId; id <= moment.toWordId; id += 1) {
    const w = byId.get(id);
    if (!w) break;
    if (w.end - first.start > seconds && id > moment.fromWordId + 1) break;
    last = w;
  }
  return { fromWordId: first.id, toWordId: last.id, start: first.start, end: last.end };
}

// What to draw for a moment, or null when the draft should leave it to
// judgment. Everything here quotes the sentence.
function cardFor(moment, span, { shortForm }) {
  const sentence = moment.text;
  switch (moment.kind) {
    case "question":
      return { type: "graphic", ...span, graphic: { kind: "custom", template: "question", params: { text: charsTo(sentence, 100) } }, layout: "side" };
    case "quote":
      return { type: "graphic", ...span, graphic: { kind: "quote", text: charsTo(sentence, 220) }, layout: "side" };
    case "warning":
      return { type: "graphic", ...span, graphic: { kind: "custom", template: "alert", params: { text: charsTo(sentence, 90), level: "warning" } }, layout: "side" };
    case "claim":
      return calloutOrNote(sentence, span, shortForm ? 5 : 8, "stamp", "");
    case "number": {
      const figure = moment.evidence;
      if (figure && figure.shown) {
        const label = figure.label && figure.label.split(" ").length <= 6 ? figure.label : (figure.unit ?? "");
        return {
          type: "graphic", ...span, layout: "side",
          graphic: { kind: "custom", template: "big-number", params: { value: charsTo(figure.shown, 14), label: charsTo(label || sentence, 40), context: charsTo(sentence, 90) } },
          todo: `the figure ${figure.shown} was read from “${sentence}”; check the value and the label say what the speaker meant`,
        };
      }
      return calloutOrNote(sentence, span, shortForm ? 5 : 8, "bar", "a number said aloud: replace this callout with a stat or big-number once you have read the value and what it counts");
    }
    case "name":
      // A name is a picture's cue, not a card of its own: nobody ships a tag
      // reading "Earth".
      return { type: "note", ...span, todo: `${moment.evidence.join(", ")} named: a picture or a logo beside the words is usually worth two calls (search_images, fetch_image, import_image), as an image card in a side layout` };
    case "definition":
      return calloutOrNote(sentence, span, shortForm ? 5 : 8, "note", "a term is being defined: a definition template wants the term and its meaning in your words");
    case "comparison":
      return calloutOrNote(sentence, span, shortForm ? 5 : 8, "pill", "two things set against each other: compare, before-after or scale, with the sides named");
    case "list":
      return calloutOrNote(sentence, span, shortForm ? 5 : 8, "pill", "an enumeration: list, steps or ranking with the items written out");
    case "process":
      return calloutOrNote(sentence, span, shortForm ? 5 : 8, "pill", "one thing leads to the next: a flow with the steps named");
    case "change":
      return calloutOrNote(sentence, span, shortForm ? 5 : 8, "pill", "a before and an after: the before-after template with both states written out");
    case "code":
      return calloutOrNote(sentence, span, shortForm ? 5 : 8, "tag", "something typed or pressed: a code or keys template with the lines, or the screen track");
    case "cta":
      return null; // the ending handles the ask
    default:
      return null;
  }
}

export function draftScenes(words, { format = "landscape", shortForm = false, persona = "editor", title = "" } = {}) {
  const density = DENSITY[persona] ?? DENSITY.editor;
  const story = readStory(words, { limit: 200 });
  const duration = story.seconds;
  const scenes = [];
  const todo = [];
  const notes = [];
  if (!words?.length) return { scenes, todo, notes: ["no words to draft from"], story: null };

  // The opening: the promise as a hook over the sentence that makes it, or
  // the film's title over the first sentence when nothing promises.
  const opening = story.opening;
  const hook = opening?.hook;
  if (hook && shortForm) {
    // A short opens on the feed's own frame: the face with the words on it,
    // there at frame one. The line is the promise cut to six words, which
    // the assistant rewrites — a draft can cut, not compress.
    const span = spanFor(words, { fromWordId: 0, toWordId: hook.toWordId }, 4);
    scenes.push({ type: "graphic", fromWordId: 0, toWordId: span.toWordId, graphic: { kind: "custom", template: "thumbnail", params: { line: thumbLine(hook.text), side: "bottom", shade: 0.6, arrive: "instant", ...(title ? { kicker: charsTo(title, 24) } : {}) }, over: true } });
    todo.push(`the opening thumbnail's line is the promise cut to six words (“${thumbLine(hook.text)}”); write it as the promise in six, the way a title reads`);
  } else if (hook) {
    const span = spanFor(words, { fromWordId: hook.fromWordId, toWordId: hook.toWordId }, 6);
    scenes.push({ type: "stage", fromWordId: span.fromWordId, toWordId: span.toWordId, layout: "cutaway" });
    scenes.push({ type: "graphic", fromWordId: span.fromWordId, toWordId: span.toWordId, graphic: { kind: "custom", template: "hook", params: { line: hookLine(hook.text), ...(title ? { kicker: charsTo(title, 32) } : {}) } } });
    if (opening.preamble.length) todo.push(`the promise arrives at ${hook.at.toFixed(1)}s after ${opening.preamble.length} sentence(s) of preamble; consider striking the preamble as a cut (read_story transcript: raw, add_cut) so the film opens on it`);
  } else if (title) {
    todo.push(`the opening title carries the project's name (“${title}”); write the film's title, or put a hook line over the sentence that makes the promise`);
    const first = words.slice(0, Math.min(8, words.length));
    scenes.push({ type: "title", fromWordId: first[0].id, toWordId: first.at(-1).id, text: charsTo(title, 60) });
    notes.push("nothing in the opening promises the viewer anything, so the draft opens on the title; a hook line drawn from later in the film would be stronger");
  }

  // Sections: a mark at every turn after the first, with the head kept as a
  // corner card. Skipped when it would crowd what the opening already placed.
  const sections = story.sections.slice(1);
  for (const [i, section] of sections.entries()) {
    const span = spanFor(words, section, 4);
    if (scenes.some((s) => s.type === "graphic" && Math.abs(words.find((w) => w.id === s.fromWordId).start - span.start) < density.minGap * 0.5)) continue;
    scenes.push({ type: "stage", fromWordId: span.fromWordId, toWordId: span.toWordId, layout: "full", corner: "br" });
    scenes.push({ type: "graphic", fromWordId: span.fromWordId, toWordId: span.toWordId, graphic: { kind: "section", number: String(i + 2).padStart(2, "0"), title: charsTo(section.heading, 60) } });
  }
  if (sections.length === 0 && duration > 180) notes.push("no section turns were found in a film this long; a section mark where the subject changes would let it breathe");

  // Moments: the ones with their own text, spaced by the persona's gap,
  // never inside a span the opening or a section already holds.
  const taken = () => scenes.filter((s) => s.type !== "stage").map((s) => ({ start: words.find((w) => w.id === s.fromWordId).start, end: words.find((w) => w.id === s.toWordId).end }));
  let cards = 0;
  const wanted = story.moments.filter((m) => m.kind !== "cta" && m.kind !== "time");
  for (const moment of wanted) {
    if (cards >= density.maxCards) break;
    const busy = taken().some((t) => moment.start < t.end + density.minGap && moment.end > t.start - density.minGap);
    if (busy) {
      // A moment under a scene already placed is not forgotten: the plan
      // may want it once the earlier scene is trimmed.
      if (["definition", "number", "change", "quote", "question", "warning", "name", "sequence", "enumeration", "compare"].includes(moment.kind)) {
        todo.push(`at ${moment.start.toFixed(1)}s (${moment.kind}): under another scene, so nothing was placed — ${moment.evidence?.length ? `“${moment.evidence.slice(0, 3).join(", ")}”` : "the sentence"} may want its own card once the scene over it ends`);
      }
      continue;
    }
    const span = spanFor(words, moment, density.cardSeconds);
    if (span.end - span.start < 1.5) continue;
    const card = cardFor(moment, span, { shortForm });
    if (!card) continue;
    if (card.type === "note") { todo.push(`at ${span.start.toFixed(1)}s (${moment.kind}): ${card.todo}`); continue; }
    const { layout, todo: note, start: _s, end: _e, ...scene } = card; // seconds are derived; only word ids are written
    if (layout && layout !== "focus") scenes.push({ type: "stage", fromWordId: span.fromWordId, toWordId: span.toWordId, layout });
    scenes.push(scene);
    if (note) todo.push(`scene at ${span.start.toFixed(1)}s (${moment.kind}): ${note}`);
    cards += 1;
  }

  // The ending: the conclusion as the spoken word; the ask as a cta in a
  // short, a note in a film.
  const ending = story.ending;
  if (ending?.conclusion) {
    const span = spanFor(words, ending.conclusion, 6);
    const busy = taken().some((t) => span.start < t.end && span.end > t.start);
    if (!busy) scenes.push({ type: "kinetic", fromWordId: span.fromWordId, toWordId: span.toWordId });
  }
  if (ending?.cta) {
    if (shortForm) {
      const span = spanFor(words, ending.cta, 5);
      scenes.push({ type: "stage", fromWordId: span.fromWordId, toWordId: span.toWordId, layout: "cutaway" });
      scenes.push({ type: "graphic", fromWordId: span.fromWordId, toWordId: span.toWordId, graphic: { kind: "custom", template: "cta", params: { line: charsTo(ending.cta.text.replace(/[.!?]+$/, ""), 48), arrow: "down" } } });
    } else notes.push(`the ask is at ${words.find((w) => w.id === ending.cta.fromWordId).start.toFixed(1)}s: “${ending.cta.text}” — a callout or the head alone; the cta template is for shorts`);
  } else if (shortForm) {
    // A funnel short ends on the ask whether or not the speaker made one:
    // the cta goes over the face on the last words, with a placeholder line
    // the assistant has to write — it knows where the rest is.
    const lastId = words.at(-1).id;
    const fromId = words.slice().reverse().find((w) => words.at(-1).end - w.start >= 2.2)?.id ?? Math.max(lastId - 4, 0);
    const ctaStart = words.find((w) => w.id === fromId).start;
    const busy = taken().some((t) => t.end > ctaStart);
    if (!busy) {
      scenes.push({ type: "graphic", fromWordId: fromId, toWordId: lastId, graphic: { kind: "custom", template: "cta", params: { line: "The full story is on the channel", button: "Watch it", arrow: "down", shade: 0.55 }, over: true } });
      todo.push(`the ending cta's line is a placeholder — say where the rest is, in the speaker's words; over: true keeps the face under it`);
    } else todo.push("no ask in the last stretch and a card already there: a funnel short ends on a cta template over the face");
  }

  // Word order, stage scenes first at a shared start so the readback reads
  // like a plan.
  const startOf = (s) => words.find((w) => w.id === s.fromWordId)?.start ?? 0;
  scenes.sort((a, b) => startOf(a) - startOf(b) || (a.type === "stage" ? -1 : b.type === "stage" ? 1 : 0));
  notes.push(`${cards} card(s) at the ${persona}'s density (one every ${density.minGap}s at most); ${todo.length} moment(s) left to judgment`);
  return { scenes, todo, notes, story: { sections: story.sections.length, moments: story.moments.length, seconds: duration } };
}
