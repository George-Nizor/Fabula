// The chapter list a platform reads.
//
// YouTube and most players take chapters as lines of "m:ss Title" in the
// description, the first at 0:00, each at least ten seconds long. The film
// already knows where its chapters are: every section heading, cover and
// headline in the plan marks one, and where the plan has none the story
// reading's sections do. This turns either into the lines, so the assistant
// hands the person a description block along with the film instead of
// leaving them to scrub for timestamps. Pure.

import { sections as storySections } from "./story-engine.mjs";

const MIN_CHAPTER_SECONDS = 10;

const stamp = (seconds) => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${rest}` : `${m}:${rest}`;
};

const MARKS = new Set(["section", "cover", "headline"]);

// Chapters from the plan: the scenes that mark a change of subject, in time
// order, titled by what they say. A template's params carry the title.
export function chaptersFromScenes(resolvedScenes) {
  return resolvedScenes
    .filter((scene) => scene.type === "graphic" && scene.graphic)
    .map((scene) => {
      const g = scene.graphic;
      const kind = g.template ?? g.kind;
      if (!MARKS.has(kind)) return null;
      const title = g.template ? (g.params?.headline ?? g.params?.title) : g.title;
      if (!title) return null;
      return { at: scene.start, title: String(title).trim(), from: `scene ${kind}` };
    })
    .filter(Boolean)
    .sort((a, b) => a.at - b.at);
}

// The list as a platform wants it: starts at 0:00, no chapter shorter than
// ten seconds (a mark that follows another too closely is folded into it),
// titled from the plan where it has marks and from the story where it does
// not. `title` names the film for the 0:00 line when nothing else does.
export function chapterList({ scenes = [], words = [], title = "Introduction", duration } = {}) {
  let marks = chaptersFromScenes(scenes);
  let source = "plan";
  if (marks.length === 0) {
    // One section is no structure: the film's own title names it.
    const found = storySections(words);
    marks = found.length > 1 ? found.map((section) => ({ at: section.start, title: section.heading, from: "story" })) : [];
    source = "story";
  }
  const total = duration ?? words.at(-1)?.end ?? (marks.at(-1)?.at ?? 0);
  const chapters = [];
  for (const mark of marks) {
    const last = chapters.at(-1);
    if (last && mark.at - last.at < MIN_CHAPTER_SECONDS) continue;
    chapters.push({ at: Number(mark.at.toFixed(2)), title: mark.title });
  }
  if (chapters.length === 0 || chapters[0].at > 0.5) chapters.unshift({ at: 0, title: chapters.length && chapters[0].at < MIN_CHAPTER_SECONDS ? chapters.shift().title : title });
  chapters[0].at = 0;
  if (total && chapters.length && total - chapters.at(-1).at < MIN_CHAPTER_SECONDS && chapters.length > 1) chapters.pop();
  const lines = chapters.map((chapter) => `${stamp(chapter.at)} ${chapter.title}`);
  return { source, chapters, text: lines.join("\n") + (lines.length ? "\n" : ""), enough: chapters.length >= 3 };
}
