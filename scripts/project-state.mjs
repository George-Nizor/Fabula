// What a project folder holds and what in it is out of date: the reading
// shared by the MCP server (status, the render tools) and the window's
// Export page, so both describe the same files the same way and start the
// same jobs with the same arguments. Nothing here writes except starting a
// job.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { flattenWords } from "../core/cut-engine.mjs";
import { resolveFormat, ceilingOf, validateFormat } from "../core/formats.mjs";
import {
  REPO_ROOT,
  measureLoudness,
  cleanPlan,
  cleanCurrent,
  cleanTranscriptCurrent,
  probeDimensions,
  startJob,
} from "./pipeline.mjs";

export const JOB_STAGES = ["first_pass", "render_clean", "render_final", "transcribe", "retranscribe", "refresh_clean"];

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

// A motion document's identity is its content: a rewritten scene is a new
// picture, so the window reloads its frame and the render's chunk identity
// changes, while touching the file without changing it changes nothing.
// Hashed once per size and mtime; the window asks every half second.
const motionStamps = new Map();
export function motionStamp(dir, src) {
  const file = path.join(dir, src);
  try {
    const stat = fs.statSync(file);
    const key = `${stat.size}:${stat.mtimeMs}`;
    const hit = motionStamps.get(file);
    if (hit?.key === key) return hit.stamp;
    const stamp = crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex").slice(0, 16);
    motionStamps.set(file, { key, stamp });
    return stamp;
  } catch {
    return "missing";
  }
}

// Every reader of a plan — the window, the film's render, the single frame —
// turns the plan's project-relative sources into what its page can load, and
// does it here so the three cannot drift: a URL for every picture and clip,
// assets/ rewritten inside a custom card's markup, and a content stamp on
// every motion scene. assetUrl maps a project-relative path to a URL.
export function attachSceneMedia(dir, scenes, assetUrl) {
  for (const scene of scenes ?? []) {
    const graphic = scene?.graphic;
    if (!graphic) continue;
    if (graphic.kind === "motion") {
      scene.graphic = { ...graphic, stamp: motionStamp(dir, graphic.src) };
      continue;
    }
    if (graphic.src) graphic.url = assetUrl(graphic.src);
    for (const item of graphic.items ?? []) if (item?.src) item.url = assetUrl(item.src);
    if (graphic.kind === "custom" && typeof graphic.html === "string") {
      const base = assetUrl("assets/");
      scene.graphic = { ...graphic, html: graphic.html.replaceAll("assets/", base), css: (graphic.css ?? "").replaceAll("assets/", base) };
    }
  }
  return scenes;
}

// Footage is referenced where it lives (source.json); a raw.<ext> copy is the
// older staging and still honoured.
export function stagedVideo(dir) {
  if (!fs.existsSync(dir)) return null; // a project not yet made has no footage
  const raw = fs.readdirSync(dir).find((name) => /^raw\.(mp4|mov|mkv|webm|m4v)$/i.test(name));
  if (raw) return path.join(dir, raw);
  try {
    return readJson(path.join(dir, "source.json")).path ?? null;
  } catch {
    return null;
  }
}

// The footage as an identity: where it is and how big. Enough to notice a
// swapped recording without hashing nineteen gigabytes.
export function sourceRecord(dir) {
  const video = stagedVideo(dir);
  if (!video) return null;
  try {
    const source = readJson(path.join(dir, "source.json"));
    if (source.path === video && source.bytes) return { path: source.path, bytes: source.bytes };
  } catch { /* staged copy */ }
  try {
    return { path: video, bytes: fs.statSync(video).size };
  } catch {
    return { path: video, bytes: null }; // the footage is on another host's disk
  }
}

export function projectPaths(dir) {
  return {
    video: stagedVideo(dir),
    transcript: path.join(dir, "raw.json"),
    review: path.join(dir, "review.json"),
    clean: path.join(dir, "out", "clean.mp4"),
    cleanTranscript: path.join(dir, "clean.json"),
    compose: path.join(dir, "compose.json"),
    previousCleanTranscript: path.join(dir, "clean.previous.json"),
    final: path.join(dir, "out", "final.mp4"),
    framing: path.join(dir, "framing.json"),
    cleanMap: path.join(dir, "out", "clean-map.json"),
    screen: path.join(dir, "out", "screen.mp4"),
  };
}

export function readCleanMap(dir) {
  const { cleanMap } = projectPaths(dir);
  return fs.existsSync(cleanMap) ? readJson(cleanMap) : null;
}

export function readFraming(dir) {
  const { framing } = projectPaths(dir);
  return fs.existsSync(framing) ? readJson(framing) : null;
}

export function readReview(dir) {
  const { review } = projectPaths(dir);
  if (!fs.existsSync(review)) throw new Error("no review.json yet; call cut_pass first");
  return readJson(review);
}

export function readComposeConfig(dir) {
  const { compose } = projectPaths(dir);
  return fs.existsSync(compose) ? readJson(compose) : { scenes: [] };
}

export function cleanTranscriptStamp(dir) {
  try {
    return readJson(projectPaths(dir).cleanTranscript).fabula?.cutIdentity ?? null;
  } catch {
    return null;
  }
}

// The clean cut the review and framing describe right now, with its
// identities; compared against the map beside out/clean.mp4. The frame size
// is only needed when no framing was set (the whole frame is the head), and
// it is probed then — unless the caller cannot (the window on Windows, where
// ffprobe is a Linux binary), in which case it passes what it knows.
export function currentCleanPlan(dir, { dims = null } = {}) {
  const paths = projectPaths(dir);
  const review = readReview(dir);
  const framing = readFraming(dir);
  return cleanPlan({
    review,
    framing,
    dims: framing ? null : (dims ?? probeDimensions(paths.video)),
    source: sourceRecord(dir),
    // The delivery shape caps the head track. A vertical film crops its head
    // at compose time, so its ceiling has room for a crop that is not an
    // upscale — and headOutputSize never grows past the source, so a 1080p
    // recording gets exactly the track it always did.
    ceiling: ceilingOf(readProjectMeta(dir)),
  });
}

export function cleanSummary(dir, { measure = false } = {}) {
  const paths = projectPaths(dir);
  const map = readCleanMap(dir);
  if (!map || !fs.existsSync(paths.clean)) return null;
  return {
    identity: map.identity ?? null,
    renderedAt: map.renderedAt ?? null,
    encoder: map.encoder ?? null,
    bytes: fs.statSync(paths.clean).size,
    fps: map.fps,
    head: map.head,
    screen: map.screen,
    screenSpans: map.screenSpans,
    pieces: map.pieces?.length ?? null,
    // The voice's integrated loudness, measured by the clean render, when it
    // describes this clean cut. A voice far under where platforms play is
    // said here so it is known before anyone composes a frame.
    ...voiceLoudness(dir, map, measure),
  };
}

function voiceLoudness(dir, map, measure) {
  const file = path.join(dir, "out", "clean-audio.json");
  let audio = null;
  try { audio = readJson(file); } catch { audio = null; }
  const current = audio && audio.identity === map.identity;
  // Measuring is an ffmpeg pass over the whole clean cut: the server does it
  // once when asked (status), never the window on its poll. A failed
  // measurement is recorded as null so it is not tried on every call.
  if (!current && measure) {
    let loudness = null;
    try { loudness = measureLoudness(path.join(dir, "out", "clean.mp4")); } catch { loudness = null; }
    audio = { identity: map.identity, voiceLoudness: loudness };
    try { fs.writeFileSync(file, JSON.stringify(audio, null, 2)); } catch { /* the next status tries again */ }
  } else if (!current) return {};
  if (typeof audio.voiceLoudness !== "number") return {};
  const out = { voiceLoudness: audio.voiceLoudness };
  if (audio.voiceLoudness < -24) {
    const target = readComposeConfig(dir).audio?.voice?.loudness;
    out.voiceNote = typeof target === "number"
      ? `the voice measures ${audio.voiceLoudness} LUFS as recorded; the stitch brings it to the ${target} LUFS target already set`
      : `the voice measures ${audio.voiceLoudness} LUFS, well under the -14 to -16 platforms play at; set_audio voice_loudness -16 (a film) or -14 (a short) normalises it in the stitch`;
  }
  return out;
}

// The last lines of a job's log, without Chromium's D-Bus grumbling (the
// headless export has no session bus and says so a few hundred times).
export const logTail = (file, lines = 6) => {
  try {
    return fs.readFileSync(file, "utf8").trim().split("\n")
      .filter((line) => !/^\[\d+:\d+\/\d+\.\d+:ERROR:dbus\//.test(line))
      .slice(-lines).join("\n");
  } catch {
    return null;
  }
};

// What the last job left behind, so wait_render can describe a finish it
// did not start: the most recently written out/<stage>.log names it.
export function lastJobStage(dir) {
  const outDir = path.join(dir, "out");
  if (!fs.existsSync(outDir)) return null;
  const logs = fs.readdirSync(outDir)
    .filter((name) => name.endsWith(".log") && JOB_STAGES.includes(name.slice(0, -4)))
    .map((name) => ({ stage: name.slice(0, -4), mtime: fs.statSync(path.join(outDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return logs[0]?.stage ?? null;
}

// What is out of date relative to what feeds it, and the tool that fixes
// it. This is the order of the pipeline read backwards: an agent that reads
// it never has to guess which step to repeat after a change. The clean cut
// and its transcript compare by identity, never by file time.
export function staleness(dir, { dims = null } = {}) {
  const paths = projectPaths(dir);
  const mtime = (file) => (fs.existsSync(file) ? fs.statSync(file).mtimeMs : null);
  const out = [];
  const map = readCleanMap(dir);
  const clean = mtime(paths.clean);
  if (clean !== null && fs.existsSync(paths.review)) {
    let plan = null;
    try {
      plan = currentCleanPlan(dir, { dims });
    } catch {
      plan = null; // cannot be told from here; the next reader that can will say
    }
    if (plan && !cleanCurrent(map, plan, paths.clean)) {
      out.push({
        artifact: "clean.mp4",
        because: map?.identity ? "the cut list or framing changed after it was rendered" : "it was rendered by an older Fabula that recorded no identity",
        next: "render_clean",
      });
    }
  }
  if (clean !== null && !cleanTranscriptCurrent(paths.cleanTranscript, paths.clean, map)) {
    out.push({ artifact: "clean.json", because: "it does not describe the clean cut on disk", next: "retranscribe_clean" });
  }
  if (fs.existsSync(paths.compose) && fs.existsSync(paths.cleanTranscript)) {
    const config = readComposeConfig(dir);
    const stamp = cleanTranscriptStamp(dir);
    const moved = (config.scenes?.length ?? 0) > 0 && config.cutIdentity && stamp
      ? config.cutIdentity !== stamp
      : mtime(paths.compose) < mtime(paths.cleanTranscript);
    if (moved) {
      out.push({ artifact: "compose.json", because: "the clean transcript changed after the scenes were written; word ids may have moved", next: "reanchor_scenes (then get_scenes to check what it could not place)" });
    }
  }
  const final = mtime(paths.final);
  const compose = mtime(paths.compose);
  if (final !== null && ((compose !== null && compose > final) || (clean !== null && clean > final))) {
    out.push({ artifact: "final.mp4", because: "the scenes or the clean cut changed after the film was rendered", next: "render_final (cached chunks make this cheap)" });
  }
  return out;
}

// The deliverables in out/: the film, preview spans, the caption files, and
// the clean cut. Intermediates (the screen track, chunks, maps, logs) are
// not deliverables and stay out of the list.
export function outputs(dir) {
  const outDir = path.join(dir, "out");
  if (!fs.existsSync(outDir)) return [];
  return fs.readdirSync(outDir)
    .filter((name) => /^(final|draft|clean|preview-\d+-\d+|captions-[a-z]{2,3}(-[A-Za-z0-9]{2,8})?)\.(mp4|srt|vtt)$/.test(name) || /^(thumb[a-z0-9._-]*\.png|chapters\.txt|credits\.md|description\.md)$/i.test(name))
    .map((name) => {
      const file = path.join(outDir, name);
      const stat = fs.statSync(file);
      return {
        name,
        path: file,
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        kind: name === "final.mp4" ? "film" : name === "draft.mp4" ? "draft" : name === "clean.mp4" ? "clean" : name.endsWith(".mp4") ? "preview"
          : name.endsWith(".png") ? "thumbnail" : name === "chapters.txt" ? "chapters" : name === "credits.md" ? "credits" : name === "description.md" ? "description" : "captions",
      };
    })
    .sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
}

// ---- Jobs ----
//
// One description of each job, in terms of the pipeline host's own paths:
// the program (node for the pipeline steps, the headless Electron for the
// film), its arguments, and the environment it needs. The server launches
// it directly; the window launches it directly on Linux and through a shell
// line on Windows, where the pipeline lives on the WSL side.

export function jobSpec(kind, dir, options = {}) {
  const root = options.root ?? REPO_ROOT;
  const join = root === REPO_ROOT ? path.join : path.posix.join;
  const job = join(root, "scripts", "job.mjs");
  if (kind === "clean") return { stage: "render_clean", label: "Rendering the clean cut", program: "node", args: [job, "render_clean", dir] };
  if (kind === "retranscribe") return { stage: "retranscribe", label: "Transcribing the clean cut", program: "node", args: [job, "retranscribe", dir] };
  if (kind === "transcribe") return { stage: "transcribe", label: "Transcribing on the GPU", program: "node", args: [job, "transcribe", dir] };
  if (kind === "refresh") return { stage: "refresh_clean", label: "Refreshing the clean cut", program: "node", args: [job, "refresh_clean", dir] };
  if (kind === "first") return { stage: "first_pass", label: "The first pass", program: "node", args: [job, "first_pass", dir] };
  if (kind === "final") {
    const args = ["--no-sandbox", "--no-zygote", "--ozone-platform=headless", join(root, "scripts", "export-compose.cjs")];
    if (options.from !== undefined || options.to !== undefined) {
      if (!options.out) throw new Error("a preview span needs an output path");
      args.push(`--from=${options.from ?? 0}`, `--to=${options.to}`, `--out=${options.out}`);
    }
    if (options.fresh) args.push("--fresh");
    if (options.draft) args.push(`--scale=${options.draft === true ? 0.5 : options.draft}`);
    args.push(dir);
    return {
      stage: "render_final",
      label: options.out ? "Rendering a preview span" : options.draft ? "Rendering a draft" : "Rendering the film",
      program: "electron",
      args,
      env: {
        LD_LIBRARY_PATH: [join(root, "tools", "wsl-libs", "usr", "lib", "x86_64-linux-gnu"), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
      },
    };
  }
  throw new Error(`unknown job kind ${kind}`);
}

// Starts a spec on this machine. `node` is whatever runs the pipeline here
// (the Electron binary as node inside the app, process.execPath in the
// server); `electron` is the headless renderer for the film.
export function launchJob(dir, spec, runner = {}) {
  const node = runner.node ?? process.execPath;
  const electron = runner.electron ?? path.join(REPO_ROOT, "node_modules", "electron", "dist", "electron");
  const command = spec.program === "electron" ? electron : node;
  const env = { ...(spec.env ?? {}), ...(spec.program === "node" ? runner.nodeEnv ?? {} : {}) };
  return startJob(dir, spec.stage, spec.label, command, spec.args, { env });
}

// The same spec as one line for a login shell on the pipeline host, for a
// window that reaches it through wsl.exe. Every argument is single-quoted.
// An installed engine (scripts/setup-engine.sh) keeps the Node it runs with in <root>/bin, so the
// job does not depend on what the login shell's PATH holds; a checkout has no bin/ and the PATH
// is as it was.
export function shellLine(spec, { root, node = "node" }) {
  const quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
  const command = spec.program === "electron" ? path.posix.join(root, "node_modules", "electron", "dist", "electron") : node;
  const env = Object.entries(spec.env ?? {}).map(([key, value]) => `${key}=${quote(value)}`).join(" ");
  return `cd ${quote(root)} && export PATH=${quote(path.posix.join(root, "bin"))}:"$PATH" && ${env ? `env ${env} ` : ""}${quote(command)} ${spec.args.map(quote).join(" ")}`;
}

// ---- Projects, plural ----
//
// A project is a folder under media/ that stages a recording. Its stage is
// read from what is on disk, the same files status reports, so the window's
// project list and the assistant's list_projects never disagree.
export const PROJECT_STAGES = [
  ["final", "film rendered", (paths) => fs.existsSync(paths.final)],
  // A compose.json holding only a look is not a composition. A short is made
  // with its parent's theme already in it and no scenes at all, and reporting
  // that as "composed" would tell the person the work was done.
  ["composed", "scenes planned", (paths) => hasScenes(paths.compose)],
  ["clean", "clean cut rendered", (paths) => fs.existsSync(paths.clean)],
  ["cut", "cuts proposed", (paths) => fs.existsSync(paths.review)],
  ["transcribed", "transcribed", (paths) => fs.existsSync(paths.transcript)],
  ["staged", "waiting for a first pass", () => true],
];

export const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-_]*$/i;

function hasScenes(file) {
  try { return (readJson(file).scenes ?? []).length > 0; } catch { return false; }
}

// The person's name for a project lives in <dir>/project.json; the folder is
// a slug of it that never has to change, so renaming moves nothing.
export function readProjectMeta(dir) {
  try {
    const meta = readJson(path.join(dir, "project.json"));
    return meta && typeof meta === "object" ? meta : {};
  } catch {
    return {};
  }
}

export function writeProjectTitle(dir, title) {
  const clean = cleanTitle(title);
  writeProjectMeta(dir, { title: clean });
  return clean;
}

function writeProjectMeta(dir, patch) {
  const meta = { ...readProjectMeta(dir), ...patch };
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify(meta, null, 2) + "\n");
  return meta;
}

// The shape the film is delivered in. It decides the stage the composition is
// painted on and the ceiling the clean cut is encoded at, so it is chosen when
// the project is created and lives beside the title rather than in the look.
// Changing it later is legitimate — the scene plan means the same thing in
// either shape — but it makes the clean cut stale, because the ceiling moved.
export function projectFormat(dir) {
  return resolveFormat(readProjectMeta(dir)).id;
}

export function writeProjectFormat(dir, format) {
  return writeProjectMeta(dir, { format: validateFormat(format) }).format;
}

export function cleanTitle(title) {
  const clean = String(title ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!clean) throw new Error("A project needs a name.");
  return clean;
}

// A folder name from a title: lowercase ASCII letters, digits and dashes.
export function slugify(title) {
  const slug = String(title ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return PROJECT_NAME_RE.test(slug) ? slug : `project-${Date.now().toString(36)}`;
}

// One project as the list shows it. `videoPresent` lets the caller check the
// footage where it runs: the window on Windows maps the WSL path first.
export function describeProject(dir, { videoPresent = (file) => fs.existsSync(file) } = {}) {
  try {
    if (!fs.statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  const video = stagedVideo(dir);
  if (!video) return null;
  const paths = projectPaths(dir);
  const [stage, stageLabel] = PROJECT_STAGES.find(([, , reached]) => reached(paths));
  const touched = [paths.review, paths.compose, paths.transcript, paths.cleanTranscript, paths.framing,
    paths.clean, paths.final, path.join(dir, "source.json"), path.join(dir, "progress.json")]
    .map((file) => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } });
  const latest = Math.max(...touched);
  let bytes = null;
  try { bytes = readJson(path.join(dir, "source.json")).bytes ?? null; } catch { /* staged copy */ }
  let present = false;
  try { present = Boolean(videoPresent(video)); } catch { present = false; }
  const meta = readProjectMeta(dir);
  const format = resolveFormat(meta);
  return {
    name: path.basename(dir),
    title: typeof meta.title === "string" && meta.title.trim() ? meta.title.trim() : path.basename(dir),
    format: format.id,
    formatLabel: format.label,
    shortForm: format.shortForm,
    // Where this one came from, when it was cut out of a longer film.
    derivedFrom: typeof meta.derivedFrom === "string" ? meta.derivedFrom : null,
    video,
    videoName: path.basename(video),
    videoPresent: present,
    bytes,
    stage,
    stageLabel,
    modifiedAt: latest > 0 ? new Date(latest).toISOString() : null,
  };
}

// Every project under media/, most recently touched first. Folders that stage
// nothing (themes, spikes) are not projects and are left out.
export function listProjects(mediaRoot, options = {}) {
  let names;
  try { names = fs.readdirSync(mediaRoot); } catch { return []; }
  return names
    .filter((name) => PROJECT_NAME_RE.test(name))
    .map((name) => describeProject(path.join(mediaRoot, name), options))
    .filter(Boolean)
    .sort((a, b) => (b.modifiedAt ?? "").localeCompare(a.modifiedAt ?? "") || a.title.localeCompare(b.title));
}

export { flattenWords };
