// Cutting a short out of a long film.
//
// The short is its own project. It references the SAME recording — nothing is
// copied, as everywhere else in Fabula — and inherits the long film's cut list
// with everything outside the chosen span removed, so the person's editing
// decisions carry over and the short's own clean render comes from the original
// footage rather than from a crop of a crop. That is what lets it be framed,
// composed and rendered for a different shape: a vertical short of a landscape
// talk is a new film made of the same words, not a letterboxed excerpt.
//
// What it does NOT inherit is the scene plan. A composition written for a wide
// frame is the wrong composition for a tall one — different room, different
// reading order, different amount of text a viewer will take — so the short
// starts with the look and none of the visuals, and the assistant composes it.

import fs from "node:fs";
import path from "node:path";
import { flattenWords } from "../core/cut-engine.mjs";
import { resolveClipSpan, rawSpanOfClean, clipCutList, findClips, sentences } from "../core/clip-engine.mjs";
import { resolveFormat, DEFAULT_FORMAT } from "../core/formats.mjs";
import {
  projectPaths, readReview, readCleanMap, readProjectMeta, describeProject,
  writeProjectTitle, writeProjectFormat, slugify, cleanTitle,
} from "./project-state.mjs";

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

export function cleanWordsOf(dir) {
  return flattenWords(readJson(projectPaths(dir).cleanTranscript));
}

// The moments in a film that could be their own. `format` is the shape they
// are being cut FOR, because what counts as too long is a property of where
// the short is going, not of the film it came out of.
export function suggestClips(dir, { format = "vertical", limit = 8 } = {}) {
  const shape = resolveFormat(format);
  if (!fs.existsSync(projectPaths(dir).cleanTranscript)) {
    throw new Error("no clean transcript yet: a short is chosen on the words, so the film has to be cut first");
  }
  const words = cleanWordsOf(dir);
  const clips = findClips(words, { duration: shape.duration, limit });
  return {
    format: shape.id,
    filmSeconds: Number((words.at(-1)?.end ?? 0).toFixed(1)),
    sentences: sentences(words).length,
    clips,
  };
}

// A folder name nothing else is using. Two shorts from one film very often
// want the same name; the second becomes -2 rather than failing or, far worse,
// opening the first.
function freeName(root, base) {
  let name = base;
  for (let n = 2; fs.existsSync(path.join(root, name)); n += 1) name = `${base}-${n}`;
  return name;
}

// One short, staged and ready for its clean render. Everything is written
// before the pointer moves, so a half-made project is never the open one.
export function createShort(parentDir, { fromWordId, toWordId, title, format = "vertical", root }) {
  const parent = describeProject(parentDir);
  if (!parent) throw new Error("the film this short would come from is not a project");
  const paths = projectPaths(parentDir);
  if (!fs.existsSync(paths.cleanTranscript)) throw new Error("no clean transcript yet: the clip has to be chosen on words that exist");
  const map = readCleanMap(parentDir);
  if (!map?.pieces?.length) throw new Error("no clean map yet: render the clean cut before cutting shorts out of it");
  const shape = resolveFormat(format);
  const words = cleanWordsOf(parentDir);
  const span = resolveClipSpan(words, fromWordId, toWordId, { duration: shape.duration });
  const rawSpan = rawSpanOfClean(map.pieces, span.start, span.end);

  const review = readReview(parentDir);
  if (!review) throw new Error("the film has no cut list to inherit");
  const shown = cleanTitle(title ?? defaultTitle(words, span, parent.title));
  const mediaRoot = root ?? path.dirname(parentDir);
  const name = freeName(mediaRoot, slugify(shown));
  const dir = path.join(mediaRoot, name);
  fs.mkdirSync(dir, { recursive: true });

  // The same recording, referenced the same way.
  fs.copyFileSync(path.join(parentDir, "source.json"), path.join(dir, "source.json"));
  // The same head and screen rectangles: it is the same camera in the same room.
  if (fs.existsSync(paths.framing)) fs.copyFileSync(paths.framing, path.join(dir, "framing.json"));

  const cuts = clipCutList(review.cuts, rawSpan, review.duration);
  fs.writeFileSync(path.join(dir, "review.json"), JSON.stringify({ ...review, cuts }, null, 2));

  // The look travels; the visuals do not. A short is watched without sound
  // more often than not, so its captions start burned in and the person or the
  // assistant can turn them off.
  const parentCompose = readComposeOf(parentDir);
  const compose = { scenes: [] };
  if (parentCompose.theme) compose.theme = parentCompose.theme;
  if (parentCompose.punch) compose.punch = parentCompose.punch;
  compose.captions = shape.shortForm ? "open" : (parentCompose.captions ?? "none");
  // Read more than heard: a short's captions lean on their numbers and absolutes.
  if (shape.shortForm) compose.captionEmphasis = "auto";
  // And with the voice where a feed plays it; the recording is rarely there.
  if (shape.shortForm) compose.audio = { voice: { loudness: -14 } };
  fs.writeFileSync(path.join(dir, "compose.json"), JSON.stringify(compose, null, 2));

  writeProjectTitle(dir, shown);
  writeProjectFormat(dir, shape.id);
  const meta = { ...readProjectMeta(dir), derivedFrom: path.basename(parentDir), sourceSpan: { ...span, raw: rawSpan } };
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify(meta, null, 2) + "\n");

  return {
    project: name,
    dir,
    title: shown,
    format: shape.id,
    derivedFrom: path.basename(parentDir),
    span,
    rawSpan: { start: Number(rawSpan.start.toFixed(2)), end: Number(rawSpan.end.toFixed(2)) },
    seconds: span.seconds,
    warnings: span.warnings,
    text: words.filter((word) => word.id >= span.fromWordId && word.id <= span.toWordId).map((word) => word.text).join(" "),
  };
}

function readComposeOf(dir) {
  try { return readJson(projectPaths(dir).compose) ?? {}; } catch { return {}; }
}

// A name for a short nobody has named: the first handful of its own words,
// which is at least about the short rather than about the film it came from.
function defaultTitle(words, span, parentTitle) {
  const opening = words
    .filter((word) => word.id >= span.fromWordId && word.id <= span.toWordId)
    .slice(0, 7).map((word) => word.text).join(" ")
    .replace(/[^\p{L}\p{N} '’-]/gu, "").trim();
  return opening ? `${parentTitle} — ${opening}` : `${parentTitle} — short`;
}
