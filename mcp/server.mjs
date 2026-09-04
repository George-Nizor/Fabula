// Fabula's MCP server: the cut pipeline as tools an agent can drive while a
// person watches the review UI. State lives in files under media/<project>/ —
// review.json is the single artifact both this server and the Electron app
// read, so every tool call the agent makes is visible in the window within a
// poll tick. Stdio transport; register with `claude mcp add fabula -- node
// mcp/server.mjs` or the checked-in .mcp.json.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  REPO_ROOT,
  probeDuration,
  transcribe,
  computeReview,
  reviewStats,
  renderClean,
} from "../scripts/pipeline.mjs";
import { normalizeCuts } from "../core/cut-engine.mjs";
import { punchPlan, DEFAULT_PUNCH_ZOOM } from "../core/shot-engine.mjs";

const MEDIA_ROOT = path.join(REPO_ROOT, "media");
const POINTER = path.join(MEDIA_ROOT, "current-project.json");

function currentProjectDir() {
  if (!fs.existsSync(POINTER)) throw new Error("no open project; call open_project first");
  const pointer = JSON.parse(fs.readFileSync(POINTER, "utf8"));
  return path.join(MEDIA_ROOT, pointer.dir);
}

function projectPaths(dir) {
  const raw = fs.readdirSync(dir).find((name) => /^raw\.(mp4|mov|mkv|webm|m4v)$/i.test(name));
  return {
    video: raw ? path.join(dir, raw) : null,
    transcript: path.join(dir, "raw.json"),
    review: path.join(dir, "review.json"),
    clean: path.join(dir, "out", "clean.mp4"),
  };
}

function readReview(dir) {
  const { review } = projectPaths(dir);
  if (!fs.existsSync(review)) throw new Error("no review.json yet; call cut_pass first");
  return JSON.parse(fs.readFileSync(review, "utf8"));
}

function writeReview(dir, review) {
  fs.writeFileSync(projectPaths(dir).review, JSON.stringify(review, null, 2));
}

function ok(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function describeCut(cut, index, wordText) {
  const reasons = [...new Set(cut.sources.map((s) => s.reason + (s.detail ? `:${s.detail}` : "")))].join("+");
  const anchor = cut.sources.flatMap((s) => s.wordIds).map((id) => wordText.get(id)).join(" … ");
  return {
    index,
    start: Number(cut.start.toFixed(2)),
    end: Number(cut.end.toFixed(2)),
    seconds: Number((cut.end - cut.start).toFixed(2)),
    enabled: cut.enabled,
    reasons,
    near: anchor,
  };
}

const server = new McpServer({ name: "fabula", version: "0.1.0" });

server.registerTool("open_project", {
  description:
    "Open a video as the current Fabula project. Stages the file under media/<name>/ (copy is skipped when already staged) and points the review UI at it. Returns whether a transcript already exists.",
  inputSchema: {
    video_path: z.string().describe("Path to the raw recording (mp4/mov/mkv/webm)"),
    name: z.string().optional().describe("Project folder name; defaults to the video basename"),
  },
}, async ({ video_path, name }) => {
  if (!fs.existsSync(video_path)) throw new Error(`no such file: ${video_path}`);
  const ext = path.extname(video_path).toLowerCase();
  if (!/^\.(mp4|mov|mkv|webm|m4v)$/.test(ext)) throw new Error(`unsupported container: ${ext}`);
  const projectName = (name ?? path.basename(video_path, ext)).replace(/[^a-z0-9-_]/gi, "_");
  const dir = path.join(MEDIA_ROOT, projectName);
  fs.mkdirSync(dir, { recursive: true });
  const staged = path.join(dir, `raw${ext}`);
  if (!fs.existsSync(staged)) fs.copyFileSync(video_path, staged);
  fs.writeFileSync(POINTER, JSON.stringify({ dir: projectName }, null, 2));
  const paths = projectPaths(dir);
  return ok({
    project: projectName,
    video: staged,
    durationSeconds: Number(probeDuration(staged).toFixed(2)),
    transcribed: fs.existsSync(paths.transcript),
    reviewed: fs.existsSync(paths.review),
  });
});

server.registerTool("transcribe", {
  description:
    "Transcribe the current project's raw video with WhisperX large-v3 on the local GPU (word timestamps). Takes a minute or more; call once, not repeatedly. Skips work if a transcript exists unless force is set.",
  inputSchema: { force: z.boolean().optional().describe("Re-transcribe even if raw.json exists") },
}, async ({ force }) => {
  const dir = currentProjectDir();
  const paths = projectPaths(dir);
  if (!paths.video) throw new Error("project has no staged raw video");
  if (fs.existsSync(paths.transcript) && !force) {
    return ok({ skipped: true, transcript: paths.transcript });
  }
  const transcript = transcribe(paths.video, paths.transcript);
  const words = transcript.segments.reduce((n, s) => n + (s.words?.length ?? 0), 0);
  return ok({ transcript: paths.transcript, segments: transcript.segments.length, words });
});

server.registerTool("cut_pass", {
  description:
    "Run the deterministic cut pass over the current project's transcript: silence gaps and filler words become cut proposals, all enabled. Writes review.json, which the Fabula window renders live. Re-running resets any toggles.",
  inputSchema: {},
}, async () => {
  const dir = currentProjectDir();
  const paths = projectPaths(dir);
  if (!fs.existsSync(paths.transcript)) throw new Error("no transcript; call transcribe first");
  const transcript = JSON.parse(fs.readFileSync(paths.transcript, "utf8"));
  const review = computeReview(transcript, paths.video, probeDuration(paths.video));
  writeReview(dir, review);
  return ok(reviewStats(review));
});

server.registerTool("list_cuts", {
  description: "List the current cut proposals with indices, timings, reasons, and the words they sit beside.",
  inputSchema: {},
}, async () => {
  const review = readReview(currentProjectDir());
  const wordText = new Map(review.words.map((word) => [word.id, word.text]));
  return ok(review.cuts.map((cut, index) => describeCut(cut, index, wordText)));
});

server.registerTool("set_cut_enabled", {
  description:
    "Enable or disable one cut proposal by index (from list_cuts). The review UI updates live; a disabled cut's footage survives into the next render.",
  inputSchema: {
    index: z.number().int().min(0).describe("Cut index from list_cuts"),
    enabled: z.boolean().describe("true keeps the cut, false keeps the footage"),
  },
}, async ({ index, enabled }) => {
  const dir = currentProjectDir();
  const review = readReview(dir);
  if (index >= review.cuts.length) throw new Error(`no cut ${index}; there are ${review.cuts.length}`);
  review.cuts[index].enabled = enabled;
  writeReview(dir, review);
  const wordText = new Map(review.words.map((word) => [word.id, word.text]));
  return ok({ changed: describeCut(review.cuts[index], index, wordText), stats: reviewStats(review) });
});

server.registerTool("add_cut", {
  description:
    "Add a semantic cut spanning a word range (inclusive ids from the transcript): false starts, repetitions, profanity, rambling — editorial judgment the deterministic pass cannot make. Overlapping proposals merge; the review UI updates live.",
  inputSchema: {
    from_word_id: z.number().int().min(0).describe("First word id to cut"),
    to_word_id: z.number().int().min(0).describe("Last word id to cut (inclusive)"),
    reason: z.string().default("semantic").describe("Why this range goes, e.g. repetition, profanity, false-start"),
    detail: z.string().optional().describe("Short note shown in the review UI tooltip"),
  },
}, async ({ from_word_id, to_word_id, reason, detail }) => {
  const dir = currentProjectDir();
  const review = readReview(dir);
  const byId = new Map(review.words.map((word) => [word.id, word]));
  const first = byId.get(from_word_id);
  const last = byId.get(to_word_id);
  if (!first || !last) throw new Error(`word ids must be 0–${review.words.length - 1}`);
  if (last.start < first.start) throw new Error("to_word_id precedes from_word_id");
  const pad = 0.04;
  const wordIds = review.words
    .filter((word) => word.start >= first.start && word.end <= last.end)
    .map((word) => word.id);
  review.cuts = normalizeCuts([
    ...review.cuts,
    { start: Math.max(first.start - pad, 0), end: last.end + pad, reason, detail, wordIds, enabled: true },
  ]);
  writeReview(dir, review);
  const wordText = new Map(review.words.map((word) => [word.id, word.text]));
  const added = review.cuts.findIndex((cut) =>
    cut.sources.some((s) => s.reason === reason && s.wordIds[0] === wordIds[0]));
  return ok({ added: describeCut(review.cuts[added], added, wordText), stats: reviewStats(review) });
});

server.registerTool("plan_shots", {
  description:
    "Turn the alternating punch-in shot plan on or off for the current project: framing alternates wide/tight across the keep segments so every cut boundary reads as a shot change, not a skip. The plan recomputes from the live cut list, previews in the window, and applies on the next render_clean.",
  inputSchema: {
    enabled: z.boolean().default(true).describe("false removes the plan"),
    zoom: z.number().min(1.02).max(1.5).optional()
      .describe(`Tight-framing scale, default ${DEFAULT_PUNCH_ZOOM}`),
  },
}, async ({ enabled, zoom }) => {
  const dir = currentProjectDir();
  const review = readReview(dir);
  if (!enabled) {
    delete review.shotPlan;
    writeReview(dir, review);
    return ok({ shotPlan: null });
  }
  review.shotPlan = { type: "punch-alternate", zoom: zoom ?? DEFAULT_PUNCH_ZOOM };
  writeReview(dir, review);
  const shots = punchPlan(review.words, review.cuts, review.duration, review.shotPlan);
  return ok({
    shotPlan: review.shotPlan,
    shots: shots.map((shot, index) => ({
      index,
      start: Number(shot.start.toFixed(2)),
      end: Number(shot.end.toFixed(2)),
      scale: shot.scale,
      words: shot.fromWordId === null ? "(no words)" : `${shot.fromWordId}–${shot.toWordId}`,
    })),
  });
});

server.registerTool("render_clean", {
  description:
    "Apply the enabled cuts (and the shot plan, when one is set) in one re-encode and write out/clean.mp4 for the current project. This is the render behind the review gate — call it after the cuts look right.",
  inputSchema: {},
}, async () => {
  const dir = currentProjectDir();
  const paths = projectPaths(dir);
  const review = readReview(dir);
  const shots = review.shotPlan
    ? punchPlan(review.words, review.cuts, review.duration, review.shotPlan)
    : null;
  const result = renderClean(paths.video, review.cuts, review.duration, paths.clean, { shots });
  return ok({ ...result, shotPlan: review.shotPlan ?? null, ...reviewStats(review) });
});

server.registerTool("status", {
  description: "Current project state: what is staged, transcribed, reviewed, and rendered, with cut statistics.",
  inputSchema: {},
}, async () => {
  if (!fs.existsSync(POINTER)) return ok({ project: null, hint: "call open_project" });
  const pointer = JSON.parse(fs.readFileSync(POINTER, "utf8"));
  const dir = path.join(MEDIA_ROOT, pointer.dir);
  const paths = projectPaths(dir);
  const state = {
    project: pointer.dir,
    video: paths.video,
    transcribed: fs.existsSync(paths.transcript),
    reviewed: fs.existsSync(paths.review),
    rendered: fs.existsSync(paths.clean),
  };
  if (state.reviewed) Object.assign(state, reviewStats(readReview(dir)));
  return ok(state);
});

await server.connect(new StdioServerTransport());
