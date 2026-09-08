import test from "node:test";
import assert from "node:assert/strict";
import { flattenWords } from "../core/cut-engine.mjs";
import { draftScenes, DENSITY } from "../core/draft-engine.mjs";
import { validateScenes, resolveScenes, uncoveredCutaways, hiddenFullStage } from "../core/compose-engine.mjs";
import { expandTemplates } from "../core/templates.mjs";

function transcriptOf(spec) {
  const segments = [];
  let t = 0;
  for (const { text, pauseAfter = 0.25 } of spec) {
    const words = [];
    for (const word of text.split(" ")) {
      const end = t + 0.38;
      words.push({ word, start: Number(t.toFixed(3)), end: Number(end.toFixed(3)) });
      t = end;
    }
    segments.push({ start: words[0].start, end: words.at(-1).end, words });
    t += pauseAfter;
  }
  return { segments };
}

const TALK = [
  { text: "Hi everyone, welcome back to the channel." },
  { text: "Here's the thing nobody tells you about rendering video on a laptop.", pauseAfter: 1.3 },
  { text: "The first render took sixteen minutes and the second took six." },
  { text: "That difference was one filter graph doing work nobody asked for." },
  { text: "Every frame was being converted twice because the scale came before the format." },
  { text: "So why was the second render ten minutes faster?" },
  { text: "Because the conversion moved one line, and ffmpeg stopped rescaling every frame back to the first size.", pauseAfter: 1.4 },
  { text: "So the second thing I want to talk about is vertical video." },
  { text: "Most people think a vertical video is just a cropped horizontal one." },
  { text: "It is not, because the head has to fill the frame and the text has nowhere to go." },
  { text: "Compared to a landscape title, a vertical one has room for three words rather than nine.", pauseAfter: 1.2 },
  { text: "Let's talk about captions." },
  { text: "Something like eighty percent of these are watched with the sound off." },
  { text: "One viewer wrote that they watched the whole thing silent and still got it." },
  { text: "There are three things a short needs: a hook, one idea, and an ending that lands." },
  { text: "Don't make the mistake of burning in nine-word titles.", pauseAfter: 1.4 },
  { text: "Back in 2019 I used to render everything with Premiere and it took all night." },
  { text: "Now it is WhisperX and NVENC and it takes six minutes.", pauseAfter: 1.1 },
  { text: "So that's why the filter graph matters more than the encoder." },
  { text: "The full video is on the channel, link in the description." },
];
const words = flattenWords(transcriptOf(TALK));

test("the editor's draft opens on the promise, marks the turns, places spaced cards, and ends on the spoken word", () => {
  const draft = draftScenes(words, { format: "landscape", persona: "editor", title: "The render" });
  const expanded = expandTemplates(draft.scenes, { format: "landscape" });
  validateScenes(expanded, words);
  const resolved = resolveScenes(expanded, words);
  const duration = words.at(-1).end;
  assert.deepEqual(uncoveredCutaways(resolved, duration), [], "every cutaway is covered");
  assert.deepEqual(hiddenFullStage(resolved, duration), [], "nothing full-stage hides behind the head");
  const hook = draft.scenes.find((s) => s.graphic?.template === "hook");
  assert.ok(hook && hook.graphic.params.line.startsWith("Here's the thing"), "the hook quotes the promise");
  assert.ok(draft.scenes.some((s) => s.graphic?.kind === "section" && /Vertical video/i.test(s.graphic.title)), JSON.stringify(draft.scenes.filter((s) => s.graphic?.kind === "section")));
  assert.ok(draft.scenes.some((s) => s.type === "kinetic"), "the conclusion is the spoken word");
  assert.ok(!draft.scenes.some((s) => s.graphic?.template === "cta"), "no cta in a film");
  assert.ok(draft.notes.some((n) => n.includes("the ask is at")));
  // Cards keep the editor's distance from each other.
  const cards = resolved.filter((s) => s.type !== "stage").sort((a, b) => a.start - b.start);
  for (let i = 1; i < cards.length; i += 1) assert.ok(cards[i].start >= cards[i - 1].end - 0.01, `cards ${i - 1} and ${i} overlap`);
  assert.ok(draft.todo.some((t) => t.includes("preamble")), "the preamble is flagged for the cut");
  assert.ok(draft.todo.some((t) => t.includes("stat or big-number")), "a number is left to judgment");
  assert.ok(draft.scenes.every((s) => !("todo" in s) && !("layout" in s && s.type !== "stage")), "scene objects are clean");
});

test("the farmer's draft is denser, and ends a short on the ask", () => {
  const draft = draftScenes(words, { format: "vertical", shortForm: true, persona: "farmer", title: "The render" });
  const editor = draftScenes(words, { format: "landscape", persona: "editor", title: "The render" });
  const count = (d) => d.scenes.filter((s) => s.type !== "stage").length;
  assert.ok(count(draft) > count(editor), `${count(draft)} vs ${count(editor)}`);
  assert.ok(draft.scenes.some((s) => s.graphic?.template === "cta"), "a short ends on the ask");
  const expanded = expandTemplates(draft.scenes, { format: "vertical" });
  validateScenes(expanded, words);
  assert.deepEqual(hiddenFullStage(resolveScenes(expanded, words), words.at(-1).end), []);
  assert.ok(DENSITY.farmer.minGap < DENSITY.editor.minGap);
});

test("an empty transcript drafts nothing and says so", () => {
  const draft = draftScenes([], { title: "x" });
  assert.deepEqual(draft.scenes, []);
  assert.ok(draft.notes[0].includes("no words"));
});
