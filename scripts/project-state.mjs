// What a project folder holds and what in it is out of date: the reading
// shared by the MCP server (status, the render tools) and the window's
// Export page, so both describe the same files the same way and start the
// same jobs with the same arguments. Nothing here writes except starting a
// job.

import fs from "node:fs";
import path from "node:path";
import { flattenWords } from "../core/cut-engine.mjs";
import {
  REPO_ROOT,
  cleanPlan,
  cleanCurrent,
  cleanTranscriptCurrent,
  probeDimensions,
  startJob,
} from "./pipeline.mjs";

export const JOB_STAGES = ["render_clean", "render_final", "transcribe", "retranscribe", "refresh_clean"];

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

// Footage is referenced where it lives (source.json); a raw.<ext> copy is the
// older staging and still honoured.
export function stagedVideo(dir) {
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
  });
}

export function cleanSummary(dir) {
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
  };
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
    const moved = config.cutIdentity && stamp
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
    .filter((name) => /^(final|clean|preview-\d+-\d+)\.(mp4|srt|vtt)$/.test(name))
    .map((name) => {
      const file = path.join(outDir, name);
      const stat = fs.statSync(file);
      return {
        name,
        path: file,
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        kind: name === "final.mp4" ? "film" : name === "clean.mp4" ? "clean" : name.endsWith(".mp4") ? "preview" : "captions",
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
  if (kind === "final") {
    const args = ["--no-sandbox", "--no-zygote", "--ozone-platform=headless", join(root, "scripts", "export-compose.cjs")];
    if (options.from !== undefined || options.to !== undefined) {
      if (!options.out) throw new Error("a preview span needs an output path");
      args.push(`--from=${options.from ?? 0}`, `--to=${options.to}`, `--out=${options.out}`);
    }
    if (options.fresh) args.push("--fresh");
    args.push(dir);
    return {
      stage: "render_final",
      label: options.out ? "Rendering a preview span" : "Rendering the film",
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
export function shellLine(spec, { root, node = "node" }) {
  const quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
  const command = spec.program === "electron" ? path.posix.join(root, "node_modules", "electron", "dist", "electron") : node;
  const env = Object.entries(spec.env ?? {}).map(([key, value]) => `${key}=${quote(value)}`).join(" ");
  return `cd ${quote(root)} && ${env ? `env ${env} ` : ""}${quote(command)} ${spec.args.map(quote).join(" ")}`;
}

export { flattenWords };
