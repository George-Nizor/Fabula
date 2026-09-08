import test from "node:test";
import assert from "node:assert/strict";
import { flattenWords } from "../core/cut-engine.mjs";
import { paragraphs, sections, moments, opening, ending, readStory, falseStarts, stutters, preambleCuts, editorialCuts, retakes, numberIn } from "../core/story-engine.mjs";

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

test("paragraphs break at long pauses and at signposts, and know a signpost when they see one", () => {
  const paras = paragraphs(words);
  assert.ok(paras.length >= 6, `${paras.length} paragraphs`);
  const vertical = paras.find((p) => p.opening.startsWith("So the second thing"));
  assert.ok(vertical, "the signposted paragraph exists");
  assert.equal(vertical.signpost, true);
  const captions = paras.find((p) => p.opening.startsWith("Let's talk about captions"));
  assert.equal(captions.signpost, true);
  const last = paras.at(-1);
  assert.ok(paras.some((p) => p.conclusion), "the wrap-up is recognised as a conclusion");
  assert.equal(last.toWordId, words.at(-1).id);
});

test("sections start at signposts and draft a heading without the signpost in it", () => {
  const secs = sections(words, { minSeconds: 10 });
  assert.ok(secs.length >= 3, `${secs.length} sections`);
  const headings = secs.map((s) => s.heading);
  assert.ok(headings.some((h) => /^Vertical video/i.test(h)), headings.join(" / "));
  assert.ok(headings.some((h) => /^Captions/i.test(h)), headings.join(" / "));
  // Sections tile the film.
  for (let i = 1; i < secs.length; i += 1) assert.ok(secs[i].fromWordId === secs[i - 1].toWordId + 1);
  assert.equal(secs.at(-1).toWordId, words.at(-1).id);
});

test("moments are found by shape, with the sentence and a first suggestion", () => {
  const found = moments(words);
  const kinds = (kind) => found.filter((m) => m.kind === kind);
  assert.ok(kinds("number").some((m) => m.text.includes("sixteen minutes")), "a spoken number");
  assert.ok(kinds("number").some((m) => m.text.includes("eighty percent")), "a number word with a unit");
  assert.ok(kinds("question").some((m) => m.text.includes("ten minutes faster?")), "a question");
  assert.ok(kinds("comparison").some((m) => m.text.includes("rather than nine")), "a comparison");
  assert.ok(kinds("list").some((m) => m.text.includes("three things")), "an enumeration");
  assert.ok(kinds("quote").some((m) => m.text.includes("wrote")), "someone else's words");
  assert.ok(kinds("claim").some((m) => m.text.includes("Most people think")), "an absolute");
  assert.ok(kinds("warning").some((m) => m.text.includes("mistake")), "a caution");
  assert.ok(kinds("time").some((m) => m.text.includes("2019")), "a year");
  assert.ok(kinds("cta").some((m) => m.text.includes("description")), "the ask");
  const names = kinds("name");
  assert.ok(names.some((m) => m.evidence.includes("WhisperX") && m.evidence.includes("NVENC")), JSON.stringify(names.map((m) => m.evidence)));
  assert.ok(names.some((m) => m.evidence.includes("Premiere")));
  for (const moment of found) {
    assert.ok(Array.isArray(moment.suggest) && moment.suggest.length > 0);
    assert.ok(typeof moment.why === "string");
    assert.ok(moment.fromWordId <= moment.toWordId);
  }
  // Time order, so it reads like the film.
  for (let i = 1; i < found.length; i += 1) assert.ok(found[i].start >= found[i - 1].start);
});

test("the opening finds the preamble and the promise, the ending the conclusion and the ask", () => {
  const open = opening(words);
  assert.equal(open.preamble.length, 1, "the hello is preamble");
  assert.ok(open.hook && open.hook.text.startsWith("Here's the thing"));
  assert.ok(open.notes.some((n) => n.includes("sentence 2")));
  const end = ending(words);
  assert.ok(end.conclusion && end.conclusion.text.startsWith("So that's why"));
  assert.ok(end.cta && end.cta.text.includes("description"));
});

test("readStory is the whole reading in one object, and an empty transcript reads as nothing", () => {
  const story = readStory(words);
  assert.ok(story.seconds > 0);
  assert.equal(story.sentences, TALK.length);
  assert.ok(story.paragraphs.length && story.sections.length && story.moments.length);
  assert.ok(story.counts.number >= 2);
  assert.ok(story.paragraphs.every((p) => p.opening.split(" ").length <= 12), "paragraph openings are trimmed");
  const empty = readStory([]);
  assert.deepEqual(empty.moments, []);
  assert.equal(empty.opening, null);
});

test("the editorial cuts: the preamble, a false start said again properly, a stuttered word", () => {
  const spec = [
    { text: "Hey everyone, welcome to the channel." },
    { text: "So the first render, so the first render took sixteen minutes and the the second, that that was fine." },
    { text: "The second took six.", pauseAfter: 1.0 },
    { text: "No no, I mean it: very very fast." },
  ];
  const ws = flattenWords(transcriptOf(spec));
  const pre = preambleCuts(ws);
  assert.equal(pre.length, 1);
  assert.equal(pre[0].reason, "preamble");
  assert.equal(pre[0].fromWordId, 0);
  const starts = falseStarts(ws);
  assert.equal(starts.length, 1, JSON.stringify(starts));
  assert.equal(starts[0].reason, "false-start");
  assert.ok(ws[starts[0].fromWordId].text === "So" && /render/.test(ws[starts[0].toWordId].text), JSON.stringify(starts));
  const stut = stutters(ws);
  const pairs = stut.map((c) => ws[c.fromWordId].text.toLowerCase());
  assert.ok(pairs.includes("the") && pairs.includes("that"), JSON.stringify(pairs));
  assert.ok(!pairs.includes("no") && !pairs.includes("very"), "emphatic doubles are kept");
  const all = editorialCuts(ws);
  assert.equal(all.length, pre.length + starts.length + stut.length);
  for (let i = 1; i < all.length; i += 1) assert.ok(all[i].fromWordId >= all[i - 1].fromWordId);
  assert.deepEqual(editorialCuts(ws, { kinds: ["stutter"] }).map((c) => c.reason), stut.map(() => "stutter"));
});

test("the number in a sentence: value, how it reads, and its unit", () => {
  assert.deepEqual(numberIn("The first render took sixteen minutes and the second took six."), { value: 16, shown: "16 min", unit: "minutes", label: "and the second took six" });
  assert.equal(numberIn("Something like eighty percent of these are watched with the sound off.").shown, "80%");
  assert.equal(numberIn("It costs $4.2 million a year.").shown, "$4.2 million");
  assert.equal(numberIn("That is 3x faster than before.").shown, "3×");
  assert.equal(numberIn("two hundred and fifty thousand users signed up").value, 250000);
  assert.equal(numberIn("we shipped 12,000 units").value, 12000);
  assert.equal(numberIn("I have three things to say."), null, "a bare small count is not a figure");
  assert.equal(numberIn("Back in 2019 I used to render everything."), null, "a year is a date");
  assert.equal(numberIn("2019 users signed up").shown, "2019 users");
  assert.equal(numberIn("nothing numeric here"), null);
});

test("a retake is the earlier of two near-identical sentences within half a minute; an echo is not", () => {
  const spec = [
    { text: "The first render took sixteen minutes on this laptop and I nearly gave up.", pauseAfter: 0.8 },
    { text: "Sorry, again.", pauseAfter: 0.6 },
    { text: "The first render took sixteen minutes on this laptop and I nearly gave up on it.", pauseAfter: 0.5 },
    { text: "Sixteen minutes is a long time." },
    { text: "So I looked at the filter graph.", pauseAfter: 0.4 },
  ];
  const ws = flattenWords(transcriptOf(spec));
  const found = retakes(ws);
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.equal(found[0].reason, "retake");
  assert.equal(found[0].fromWordId, 0);
  assert.ok(ws[found[0].toWordId].text === "up.", "the whole first take goes");
  assert.ok(editorialCuts(ws).some((c) => c.reason === "retake"));
  assert.ok(!editorialCuts(ws, { kinds: ["stutter"] }).some((c) => c.reason === "retake"));
});
