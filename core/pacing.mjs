// Does the film move at the pace its shape needs?
//
// The variety read (core/compose-engine.mjs) asks whether the picture keeps
// changing its kind. This asks whether it changes at the right moments and
// says the right amount when it does: how long the viewer waits for the first
// visual, how long the longest stretch with nothing happening is, whether a
// title fits the frame it is in, whether a short has the captions it will be
// watched with, and whether it ends with somewhere to go. Every note names a
// scene or a time so it can be acted on with update_scenes.
//
// Short-form and long-form are judged differently, because a thirty-second
// vertical piece and a twelve-minute landscape one fail in different ways:
// the first loses its viewer in the first two seconds, the second in the
// fifth minute. Pure and deterministic.

import { resolveLayoutTimeline } from "./stage-engine.mjs";
import { captionsBurnedIn } from "./compose-engine.mjs";
import { revealCount, revealShares } from "./templates.mjs";

const at = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const wordCount = (text) => String(text ?? "").trim().split(/\s+/).filter(Boolean).length;

// What a title or a callout can hold before it stops being read. A tall
// frame has the width of a phone: three words read where nine do not.
export const WORD_BUDGET = {
  landscape: { title: 9, subtitle: 12, callout: 8, quote: 30, graphicTitle: 8 },
  vertical: { title: 4, subtitle: 7, callout: 5, quote: 18, graphicTitle: 5 },
};

// How long the viewer may be left waiting.
export const PACE = {
  landscape: { firstVisual: 20, stillStretch: 45 },
  vertical: { firstVisual: 1.5, stillStretch: 6 },
};

export function describePacing(scenes, { duration = 0, format = "landscape", shortForm = false, captions = "none", transition, transitionSeconds, stage } = {}) {
  const notes = [];
  const shape = format === "vertical" ? "vertical" : "landscape";
  const budget = WORD_BUDGET[shape];
  const pace = shortForm ? PACE.vertical : PACE[shape];
  const visuals = scenes.filter((scene) => scene.type !== "stage").sort((a, b) => a.start - b.start);
  const timeline = resolveLayoutTimeline(scenes, duration, { transition, transitionSeconds, stage });

  // Every instant the picture changes: a visual arrives or leaves, or the
  // layout moves. What lies between two of them is a still.
  const changes = new Set([0]);
  for (const scene of visuals) {
    changes.add(scene.start); changes.add(scene.end);
    // A span-paced template keeps arriving across its time; each arrival is
    // a change the viewer sees.
    const reveals = revealCount(scene.graphic);
    if (reveals > 0) {
      // A before-after's one arrival is its sweep, near the middle of the card.
      const shares = scene.graphic.template === "before-after" ? [0.5] : revealShares(reveals);
      for (const share of shares) changes.add(scene.start + share * (scene.end - scene.start));
    }
  }
  // A motion scene moves the whole time it is on: it is never a still,
  // however long it holds. A tick every two seconds says so.
  for (const scene of visuals) {
    if (scene.graphic?.kind !== "motion") continue;
    for (let t = scene.start + 2; t < scene.end; t += 2) changes.add(t);
  }
  for (const segment of timeline) changes.add(segment.start);
  const ticks = [...changes].filter((t) => t >= 0 && t <= duration).sort((a, b) => a - b);
  if (duration > 0 && ticks.at(-1) !== duration) ticks.push(duration);
  let longest = { start: 0, end: 0 };
  for (let i = 1; i < ticks.length; i += 1) {
    if (ticks[i] - ticks[i - 1] > longest.end - longest.start) longest = { start: ticks[i - 1], end: ticks[i] };
  }

  const firstVisualAt = visuals.length ? visuals[0].start : null;
  const stats = {
    format: shape,
    shortForm,
    seconds: Number(duration.toFixed(1)),
    visuals: visuals.length,
    firstVisualAt: firstVisualAt === null ? null : Number(firstVisualAt.toFixed(2)),
    changesPerMinute: duration > 0 ? Number(((ticks.length - 2) / (duration / 60)).toFixed(1)) : 0,
    longestStill: { start: Number(longest.start.toFixed(1)), end: Number(longest.end.toFixed(1)), seconds: Number((longest.end - longest.start).toFixed(1)) },
    captions: captionsBurnedIn(captions) ? "burned in" : "not burned in",
  };

  if (duration <= 0) return { stats, notes };

  // The opening.
  if (firstVisualAt === null) notes.push(shortForm
    ? "Nothing but the head for the whole short. A short earns its first second with something on the screen: a hook line, the big word, or captions doing the work."
    : "No visuals at all. Even a title over the opening tells the viewer what they are watching.");
  else if (firstVisualAt > pace.firstVisual) notes.push(shortForm
    ? `The first visual lands at ${firstVisualAt.toFixed(1)}s. A short is decided in its first second and a half; put a hook line or the big word over the opening words, or open on a cutaway.`
    : `The first visual lands at ${at(firstVisualAt)}. A title or a section heading inside the first ${pace.firstVisual}s tells the viewer what they are watching.`);

  // The longest still.
  const stillSeconds = longest.end - longest.start;
  if (stillSeconds > pace.stillStretch && stillSeconds < duration) {
    notes.push(shortForm
      ? `Nothing changes from ${longest.start.toFixed(1)}s to ${longest.end.toFixed(1)}s (${stillSeconds.toFixed(1)}s). A short wants a change every few seconds — a caption style shift, a callout, a punch-in, the big word — or the thumb moves on.`
      : `Nothing changes from ${at(longest.start)} to ${at(longest.end)} (${Math.round(stillSeconds)}s). A callout, a punch-in, a card or a change of layout would mark the passage.`);
  }

  // Word budgets, per scene, by the index get_scenes reports.
  scenes.forEach((scene, index) => {
    const over = (label, n, max) => notes.push(`scene ${index}: ${label} is ${n} words; ${max} is what a ${shape} frame holds. Say less on the card and let the voice carry the rest.`);
    if (scene.type === "title") {
      const n = wordCount(scene.text);
      if (n > budget.title) over("the title", n, budget.title);
      const s = wordCount(scene.subtitle);
      if (s > budget.subtitle) over("the subtitle", s, budget.subtitle);
    } else if (scene.type === "callout") {
      const n = wordCount(scene.text);
      if (n > budget.callout) over("the callout", n, budget.callout);
    } else if (scene.type === "graphic" && scene.graphic) {
      if (scene.graphic.kind === "quote") {
        const n = wordCount(scene.graphic.text);
        if (n > budget.quote) over("the quote", n, budget.quote);
      }
      if (["cover", "section"].includes(scene.graphic.kind)) {
        const n = wordCount(scene.graphic.title);
        if (n > budget.graphicTitle) over(`the ${scene.graphic.kind} title`, n, budget.graphicTitle);
      }
      if (shape === "vertical" && scene.graphic.kind === "chart" && (scene.graphic.items?.length ?? 0) > 4) {
        notes.push(`scene ${index}: a chart with ${scene.graphic.items.length} bars in a tall frame is unreadable; keep it to four, or make it a stat.`);
      }
      if (shape === "vertical" && scene.graphic.kind === "compare" && ((scene.graphic.left?.items?.length ?? 0) > 3 || (scene.graphic.right?.items?.length ?? 0) > 3)) {
        notes.push(`scene ${index}: two columns of more than three items do not fit a tall frame side by side; trim each side, or use before-after.`);
      }
      if (shape === "vertical" && ["list", "steps"].includes(scene.graphic.kind) && (scene.graphic.items?.length ?? 0) > 3) {
        notes.push(`scene ${index}: a ${scene.graphic.kind} of ${scene.graphic.items.length} items in a tall frame; three is what the strip under the head reads. Cut it to three, or split it over two cards.`);
      }
      if (shape === "vertical" && ["ranking", "teaser"].includes(scene.graphic.template) && (scene.graphic.params?.items?.length ?? 0) > 3) {
        notes.push(`scene ${index}: a ${scene.graphic.template} of ${scene.graphic.params.items.length} items in a tall frame; three read, five do not. Cut it, or split it.`);
      }
    }
  });

  // Short-form specifics: the captions and the ending.
  if (shortForm) {
    if (!captionsBurnedIn(captions)) notes.push("Captions are not burned in. Most short-form viewing is silent; set_captions open so the words are on the picture.");
    const tail = duration - 2.5;
    const endsWithSomething = visuals.some((scene) => scene.end > tail && scene.start < duration);
    if (!endsWithSomething && duration > 8) notes.push(`Nothing is on the stage in the last ${(duration - tail).toFixed(1)}s. If the short exists to send people somewhere, end on a cta template; if it exists on its own, end on the line that lands, as kinetic type or the big word.`);
    const titles = scenes.filter((scene) => scene.type === "title");
    if (titles.length > 2) notes.push(`${titles.length} titles in a ${Math.round(duration)}s short. One says what it is about; the rest is captions and cards.`);
  }

  return { stats, notes };
}
