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
      return { type: "callout", ...span, text: trimTo(sentence, shortForm ? 5 : 8), style: "stamp" };
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
      return { type: "callout", ...span, text: trimTo(sentence, shortForm ? 5 : 8), style: "bar", todo: "a number said aloud: replace this callout with a stat or big-number once you have read the value and what it counts" };
    }
    case "name":
      return { type: "callout", ...span, text: moment.evidence.slice(0, 2).join(" · "), style: "tag", todo: `${moment.evidence.join(", ")}: a picture or a logo beside the words is usually worth two calls (search_images, fetch_image, import_image)` };
    case "definition":
      return { type: "callout", ...span, text: trimTo(sentence, shortForm ? 5 : 8), style: "note", todo: "a term is being defined: a definition template wants the term and its meaning in your words" };
    case "comparison":
      return { type: "callout", ...span, text: trimTo(sentence, shortForm ? 5 : 8), style: "pill", todo: "two things set against each other: compare, before-after or scale, with the sides named" };
    case "list":
      return { type: "callout", ...span, text: trimTo(sentence, shortForm ? 5 : 8), style: "pill", todo: "an enumeration: list, steps or ranking with the items written out" };
    case "process":
      return { type: "callout", ...span, text: trimTo(sentence, shortForm ? 5 : 8), style: "pill", todo: "one thing leads to the next: a flow with the steps named" };
    case "change":
      return { type: "callout", ...span, text: trimTo(sentence, shortForm ? 5 : 8), style: "pill", todo: "a before and an after: the before-after template with both states written out" };
    case "code":
      return { type: "callout", ...span, text: trimTo(sentence, shortForm ? 5 : 8), style: "tag", todo: "something typed or pressed: a code or keys template with the lines, or the screen track" };
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
  if (hook) {
    const span = spanFor(words, { fromWordId: hook.fromWordId, toWordId: hook.toWordId }, 6);
    scenes.push({ type: "stage", fromWordId: span.fromWordId, toWordId: span.toWordId, layout: "cutaway" });
    scenes.push({ type: "graphic", fromWordId: span.fromWordId, toWordId: span.toWordId, graphic: { kind: "custom", template: "hook", params: { line: charsTo(hook.text.replace(/[.!?]+$/, ""), 90), ...(title ? { kicker: charsTo(title, 32) } : {}) } } });
    if (opening.preamble.length) todo.push(`the promise arrives at ${hook.at.toFixed(1)}s after ${opening.preamble.length} sentence(s) of preamble; consider striking the preamble as a cut (read_story transcript: raw, add_cut) so the film opens on it`);
  } else if (title) {
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
    if (busy) continue;
    const span = spanFor(words, moment, density.cardSeconds);
    if (span.end - span.start < 1.5) continue;
    const card = cardFor(moment, span, { shortForm });
    if (!card) continue;
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
  } else if (shortForm) todo.push("no ask in the last stretch: a funnel short ends on a cta template; a standalone one on the line that lands");

  // Word order, stage scenes first at a shared start so the readback reads
  // like a plan.
  const startOf = (s) => words.find((w) => w.id === s.fromWordId)?.start ?? 0;
  scenes.sort((a, b) => startOf(a) - startOf(b) || (a.type === "stage" ? -1 : b.type === "stage" ? 1 : 0));
  notes.push(`${cards} card(s) at the ${persona}'s density (one every ${density.minGap}s at most); ${todo.length} moment(s) left to judgment`);
  return { scenes, todo, notes, story: { sections: story.sections.length, moments: story.moments.length, seconds: duration } };
}
