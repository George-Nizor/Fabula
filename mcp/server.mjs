// Fabula's MCP server: the cut pipeline as tools an agent can drive while a
// person watches the review UI. State lives in files under media/<project>/ —
// review.json is the single artifact both this server and the Electron app
// read, so every tool call the agent makes is visible in the window within a
// poll tick. Stdio transport; register with `claude mcp add fabula -- node
// mcp/server.mjs` or the checked-in .mcp.json.
//
// The long steps — the two transcriptions and the two renders — run as
// detached jobs (scripts/job.mjs, scripts/export-compose.cjs). A tool that
// starts one waits a bounded time and then reports either the result or
// "still running"; wait_render picks it up from there. Nothing long dies
// with the session that started it.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  REPO_ROOT,
  FFMPEG,
  probeDuration,
  probeDimensions,
  computeReview,
  reviewStats,
  scanFraming,
  withProgress,
  cleanPlan,
  cleanCurrent,
  cleanTranscriptCurrent,
  startJob,
  waitForJob,
  runningJob,
  readProgress,
  encoderCapabilities,
} from "../scripts/pipeline.mjs";
import { normalizeCuts, flattenWords } from "../core/cut-engine.mjs";
import { punchPlan, DEFAULT_PUNCH_ZOOM } from "../core/shot-engine.mjs";
import { validateScenes, resolveScenes, validateInserts, applyInsertChoice, SCENE_TYPES, GRAPHIC_KINDS, IMAGE_MOTIONS } from "../core/compose-engine.mjs";
import { takeInbox, pendingInbox } from "../scripts/inbox.mjs";
import { validateFraming } from "../core/framing-engine.mjs";
import { LAYOUTS } from "../core/stage-engine.mjs";
import { reanchorScenes } from "../core/reanchor.mjs";
import { PRESETS, TITLE_STYLES, CALLOUT_STYLES, CAPTION_STYLES, CORNERS, VENDORED_FONTS, validateTheme, resolveTheme, describePresets } from "../core/themes.mjs";
import { fetchImage, searchCommons, listAssets } from "../scripts/images.mjs";

const MEDIA_ROOT = path.join(REPO_ROOT, "media");
const POINTER = path.join(MEDIA_ROOT, "current-project.json");
const JOB = path.join(REPO_ROOT, "scripts", "job.mjs");
const EXPORT = path.join(REPO_ROOT, "scripts", "export-compose.cjs");
const ELECTRON = path.join(REPO_ROOT, "node_modules", "electron", "dist", "electron");
const DEFAULT_WAIT_SECONDS = 300;
const MAX_WAIT_SECONDS = 1500;

function currentProjectDir() {
  if (!fs.existsSync(POINTER)) throw new Error("no open project; call open_project first");
  const pointer = JSON.parse(fs.readFileSync(POINTER, "utf8"));
  return path.join(MEDIA_ROOT, pointer.dir);
}

// Footage is referenced where it lives (source.json); a raw.<ext> copy is the
// older staging and still honoured.
function stagedVideo(dir) {
  const raw = fs.readdirSync(dir).find((name) => /^raw\.(mp4|mov|mkv|webm|m4v)$/i.test(name));
  if (raw) return path.join(dir, raw);
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "source.json"), "utf8")).path ?? null;
  } catch {
    return null;
  }
}

// The footage as an identity: where it is and how big. Enough to notice a
// swapped recording without hashing nineteen gigabytes.
function sourceRecord(dir) {
  const video = stagedVideo(dir);
  if (!video) return null;
  try {
    const source = JSON.parse(fs.readFileSync(path.join(dir, "source.json"), "utf8"));
    if (source.path === video && source.bytes) return { path: source.path, bytes: source.bytes };
  } catch { /* staged copy */ }
  return { path: video, bytes: fs.statSync(video).size };
}

function projectPaths(dir) {
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

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readFraming(dir) {
  const { framing } = projectPaths(dir);
  return fs.existsSync(framing) ? readJson(framing) : null;
}

function readCleanMap(dir) {
  const { cleanMap } = projectPaths(dir);
  return fs.existsSync(cleanMap) ? readJson(cleanMap) : null;
}

function readReview(dir) {
  const { review } = projectPaths(dir);
  if (!fs.existsSync(review)) throw new Error("no review.json yet; call cut_pass first");
  return readJson(review);
}

function writeReview(dir, review) {
  fs.writeFileSync(projectPaths(dir).review, JSON.stringify(review, null, 2));
}

function readComposeConfig(dir) {
  const { compose } = projectPaths(dir);
  return fs.existsSync(compose) ? readJson(compose) : { scenes: [] };
}

function writeComposeConfig(dir, config) {
  fs.writeFileSync(projectPaths(dir).compose, JSON.stringify(config, null, 2));
}

// Punch-ins live in compose.json (they are a compose-time decision); a
// project from before that carries them as review.shotPlan and is read as
// such until plan_shots rewrites it.
function readPunch(dir) {
  const config = readComposeConfig(dir);
  if ("punch" in config) return config.punch ?? null;
  try {
    const zoom = readReview(dir).shotPlan?.zoom;
    return zoom ? { zoom } : null;
  } catch {
    return null;
  }
}

const rectSchema = z.object({
  x: z.number().min(0), y: z.number().min(0), w: z.number().positive(), h: z.number().positive(),
}).describe("Pixels in the raw frame");

const waitSchema = z.number().min(0).max(MAX_WAIT_SECONDS).optional()
  .describe(`How long to wait for the job before reporting it as still running (default ${DEFAULT_WAIT_SECONDS}s)`);

function cleanWords(dir) {
  const paths = projectPaths(dir);
  if (!fs.existsSync(paths.cleanTranscript)) {
    throw new Error("no clean transcript; render_clean then retranscribe_clean first");
  }
  return flattenWords(readJson(paths.cleanTranscript));
}

function cleanTranscriptStamp(dir) {
  const paths = projectPaths(dir);
  try {
    return readJson(paths.cleanTranscript).fabula?.cutIdentity ?? null;
  } catch {
    return null;
  }
}

// The clean cut the review and framing describe right now, with its
// identities; compared against the map beside out/clean.mp4.
function currentCleanPlan(dir) {
  const paths = projectPaths(dir);
  const review = readReview(dir);
  return cleanPlan({
    review,
    framing: readFraming(dir),
    dims: probeDimensions(paths.video),
    source: sourceRecord(dir),
  });
}

function cleanSummary(dir) {
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

// The last lines of a job's log, without Chromium's D-Bus grumbling (the
// headless export has no session bus and says so a few hundred times).
const logTail = (file, lines = 6) => {
  try {
    return fs.readFileSync(file, "utf8").trim().split("\n")
      .filter((line) => !/^\[\d+:\d+\/\d+\.\d+:ERROR:dbus\//.test(line))
      .slice(-lines).join("\n");
  } catch {
    return null;
  }
};

// Waits on the running job and reports what came of it. A failure is an
// error with the job's own note and where its log is; "running" comes back
// as data so the agent can wait_render again without guessing.
async function settle(dir, seconds, describeDone) {
  const outcome = await waitForJob(dir, seconds ?? DEFAULT_WAIT_SECONDS);
  if (outcome.state === "failed") {
    throw new Error(`${outcome.stage} failed: ${outcome.error}\nlog: ${outcome.log}\n${logTail(outcome.log) ?? ""}`);
  }
  if (outcome.state === "running") {
    return ok({
      running: true,
      stage: outcome.stage,
      label: outcome.label,
      detail: outcome.detail,
      startedAt: outcome.startedAt,
      pid: outcome.pid,
      hint: "still running; call wait_render (it returns when the job finishes or after wait_seconds)",
    });
  }
  return ok({ done: true, ...describeDone() });
}

// What the last job left behind, so wait_render can describe a finish it
// did not start. The stage is read from the log's presence order: the most
// recently written out/<stage>.log wins.
function lastJobStage(dir) {
  const outDir = path.join(dir, "out");
  if (!fs.existsSync(outDir)) return null;
  const logs = fs.readdirSync(outDir)
    .filter((name) => /^(render_clean|render_final|transcribe|retranscribe)\.log$/.test(name))
    .map((name) => ({ stage: name.replace(/\.log$/, ""), mtime: fs.statSync(path.join(outDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return logs[0]?.stage ?? null;
}

function describeFinished(dir, stage) {
  const paths = projectPaths(dir);
  const log = path.join(dir, "out", `${stage}.log`);
  if (stage === "render_clean") {
    return { stage, clean: cleanSummary(dir), ...reviewStats(readReview(dir)), log: logTail(log) };
  }
  if (stage === "render_final") {
    // The output name is in the log's last line; final.mp4 when whole.
    const tail = logTail(log, 1) ?? "";
    const match = /wrote (\S+\.mp4)/.exec(tail);
    const output = match ? match[1] : paths.final;
    return { stage, output, bytes: fs.existsSync(output) ? fs.statSync(output).size : null, log: logTail(log) };
  }
  if (stage === "transcribe" || stage === "retranscribe") {
    const file = stage === "transcribe" ? paths.transcript : paths.cleanTranscript;
    const transcript = fs.existsSync(file) ? readJson(file) : null;
    return { stage, transcript: file, words: transcript ? flattenWords(transcript).length : null, log: logTail(log) };
  }
  return { stage, log: logTail(log) };
}

const server = new McpServer({ name: "fabula", version: "0.2.0" });

server.registerTool("open_project", {
  description:
    "Open a video as the current Fabula project. The footage is referenced where it lives (never copied); the project folder media/<name>/ holds only derived files, and the review UI is pointed at it. Returns whether a transcript already exists.",
  inputSchema: {
    video_path: z.string().describe("Path to the raw recording (mp4/mov/mkv/webm)"),
    name: z.string().optional().describe("Project folder name; defaults to the video basename"),
  },
}, async ({ video_path, name }) => {
  if (!fs.existsSync(video_path)) throw new Error(`no such file: ${video_path}`);
  const ext = path.extname(video_path).toLowerCase();
  if (!/^\.(mp4|mov|mkv|webm|m4v)$/.test(ext)) throw new Error(`unsupported container: ${ext}`);
  const projectName = (name ?? path.basename(video_path, ext)).replace(/[^a-z0-9-_]/gi, "_").toLowerCase();
  const dir = path.join(MEDIA_ROOT, projectName);
  fs.mkdirSync(dir, { recursive: true });
  if (!stagedVideo(dir)) {
    const source = { path: path.resolve(video_path), container: ext, bytes: fs.statSync(video_path).size };
    fs.writeFileSync(path.join(dir, "source.json"), JSON.stringify(source, null, 2));
  }
  fs.writeFileSync(POINTER, JSON.stringify({ dir: projectName }, null, 2));
  const paths = projectPaths(dir);
  return ok({
    project: projectName,
    video: paths.video,
    durationSeconds: Number(probeDuration(paths.video).toFixed(2)),
    transcribed: fs.existsSync(paths.transcript),
    reviewed: fs.existsSync(paths.review),
  });
});

server.registerTool("transcribe", {
  description:
    "Transcribe the current project's raw video with WhisperX large-v3 on the local GPU (word timestamps), as a background job. A couple of minutes for a twenty-minute recording; skips if raw.json exists unless force is set. Returns when done or, past wait_seconds, as still running.",
  inputSchema: {
    force: z.boolean().optional().describe("Re-transcribe even if raw.json exists"),
    wait_seconds: waitSchema,
  },
}, async ({ force, wait_seconds }) => {
  const dir = currentProjectDir();
  const paths = projectPaths(dir);
  if (!paths.video) throw new Error("project has no staged raw video");
  if (fs.existsSync(paths.transcript) && !force) {
    return ok({ skipped: true, transcript: paths.transcript, words: flattenWords(readJson(paths.transcript)).length });
  }
  startJob(dir, "transcribe", "Transcribing on the GPU", process.execPath, [JOB, "transcribe", dir]);
  return settle(dir, wait_seconds, () => describeFinished(dir, "transcribe"));
});

server.registerTool("cut_pass", {
  description:
    "Run the deterministic cut pass over the current project's transcript: silence gaps and filler words become cut proposals, all enabled. Writes review.json, which the Fabula window renders live. Re-running resets any toggles. Tune min_gap for the speaker: 0.6s is tight and reads fast-cut; conversational delivery usually wants 0.8–1.0s so natural beats survive. The clean cut stays current as long as the resulting cut list is the same as the one it was rendered from — status says.",
  inputSchema: {
    min_gap_seconds: z.number().min(0.2).max(5).optional().describe("Shortest pause proposed as a cut (default 0.6)"),
    keep_breath_seconds: z.number().min(0).max(1).optional().describe("Air left on each side of a cut (default 0.15)"),
  },
}, async ({ min_gap_seconds, keep_breath_seconds }) => {
  const dir = currentProjectDir();
  const paths = projectPaths(dir);
  if (!fs.existsSync(paths.transcript)) throw new Error("no transcript; call transcribe first");
  const transcript = readJson(paths.transcript);
  const review = computeReview(transcript, paths.video, probeDuration(paths.video), {
    minGapSeconds: min_gap_seconds,
    keepBreathSeconds: keep_breath_seconds,
  });
  // A project from before punch-ins moved to compose.json: carry the plan
  // over once, so a retuned pass never loses it.
  if (fs.existsSync(paths.review)) {
    const previous = readJson(paths.review);
    if (previous.shotPlan?.zoom && !("punch" in readComposeConfig(dir))) {
      writeComposeConfig(dir, { ...readComposeConfig(dir), punch: { zoom: previous.shotPlan.zoom } });
    }
  }
  writeReview(dir, review);
  return ok({ ...reviewStats(review), cutOptions: review.cutOptions, punch: readPunch(dir) });
});

// ---- Source framing ----

server.registerTool("detect_framing", {
  description:
    "Scan the raw recording for where the talking head sits: scene structure over time (camera-only vs screen-with-inset, pillarboxing), a proposed head rect and screen rect per run, and reference frames saved under media/<project>/framing/ — LOOK at those frames before trusting a proposal. A plain talking-head clip yields one full-frame run and needs no set_framing. Takes seconds to a minute; keyframes only.",
  inputSchema: {},
}, async () => {
  const dir = currentProjectDir();
  const paths = projectPaths(dir);
  if (!paths.video) throw new Error("project has no staged video");
  const scan = await withProgress(dir, "framing", "Scanning for the head in the frame", () =>
    scanFraming(paths.video, path.join(dir, "framing")));
  return ok(scan);
});

server.registerTool("set_framing", {
  description:
    "Declare the source framing: ordered segments over the RAW timeline, each with the head rect (pixels) and, when the recording shows a screen, a screen rect. Segments must be gapless from 0 to the duration and every head must share one aspect. render_clean crops the head track to these rects and writes a second, silent screen track from the screen rects; the Cut tab draws them over the footage. Framing is part of the clean cut's identity, so changing it is the one thing besides the cut list that sends the clean cut back to render. Omit segments to clear the framing (whole frame).",
  inputSchema: {
    segments: z.array(z.object({
      start: z.number().min(0),
      end: z.number().positive(),
      head: rectSchema,
      screen: rectSchema.nullable().optional(),
    })).optional(),
  },
}, async ({ segments }) => {
  const dir = currentProjectDir();
  const paths = projectPaths(dir);
  if (!segments || segments.length === 0) {
    fs.rmSync(paths.framing, { force: true });
    return ok({ framing: null });
  }
  const dims = probeDimensions(paths.video);
  const duration = probeDuration(paths.video);
  const framing = { segments: segments.map((s) => ({ ...s, screen: s.screen ?? null })) };
  validateFraming(framing, dims, duration);
  fs.writeFileSync(paths.framing, JSON.stringify(framing, null, 2));
  return ok({ segments: framing.segments.length, dims, withScreen: framing.segments.filter((s) => s.screen).length });
});

server.registerTool("get_framing", {
  description: "The current source framing (null means the whole frame is the head), plus the clean-timeline map from the last render_clean: where a screen exists to show, and the head/screen track sizes.",
  inputSchema: {},
}, async () => {
  const dir = currentProjectDir();
  const map = readCleanMap(dir);
  return ok({
    framing: readFraming(dir),
    rendered: map ? { fps: map.fps, head: map.head, screen: map.screen, screenSpans: map.screenSpans, identity: map.identity ?? null } : null,
  });
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
    "Enable or disable one cut proposal by index (from list_cuts). The review UI updates live; a disabled cut's footage survives into the next render. Toggling a cut and toggling it back leaves the clean cut current.",
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
    "Turn the alternating punch-in shot plan on or off: framing alternates wide/tight across the keep segments so every cut boundary reads as a shot change, not a skip. A compose-time decision — it previews in the window at once and the final render places it; the clean cut is NOT re-rendered for it. Chunks the punch-ins touch re-render on the next render_final.",
  inputSchema: {
    enabled: z.boolean().default(true).describe("false removes the plan"),
    zoom: z.number().min(1.02).max(1.5).optional()
      .describe(`Tight-framing scale, default ${DEFAULT_PUNCH_ZOOM}`),
  },
}, async ({ enabled, zoom }) => {
  const dir = currentProjectDir();
  const review = readReview(dir);
  const config = readComposeConfig(dir);
  config.punch = enabled ? { zoom: zoom ?? DEFAULT_PUNCH_ZOOM } : null;
  writeComposeConfig(dir, config);
  if (review.shotPlan) {
    delete review.shotPlan;
    writeReview(dir, review);
  }
  if (!enabled) return ok({ punch: null });
  const shots = punchPlan(review.words, review.cuts, review.duration, config.punch);
  return ok({
    punch: config.punch,
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
    "Apply the enabled cuts and the framing in one re-encode and write out/clean.mp4 (plus screen.mp4 when the framing has a screen), as a background job with live progress in the window. This is the one render that finalises the cut: the compose stage moves the result around and never re-renders it. Idempotent — if clean.mp4 already matches the current cut list and framing (by content, not by file time) it is left alone unless force is set. Minutes on the GPU; returns when done or, past wait_seconds, as still running (then wait_render).",
  inputSchema: {
    force: z.boolean().optional().describe("Render even if clean.mp4 already matches"),
    wait_seconds: waitSchema,
  },
}, async ({ force, wait_seconds }) => {
  const dir = currentProjectDir();
  const paths = projectPaths(dir);
  const plan = currentCleanPlan(dir);
  const map = readCleanMap(dir);
  if (!force && cleanCurrent(map, plan, paths.clean)) {
    return ok({
      skipped: true,
      reason: "clean.mp4 already matches the current cut list and framing",
      clean: cleanSummary(dir),
      ...reviewStats(readReview(dir)),
    });
  }
  if (plan.keeps.length === 0) throw new Error("every moment is cut; nothing to render");
  startJob(dir, "render_clean", "Rendering the clean cut", process.execPath, [JOB, "render_clean", dir]);
  return settle(dir, wait_seconds, () => describeFinished(dir, "render_clean"));
});

server.registerTool("retranscribe_clean", {
  description:
    "Transcribe out/clean.mp4 with WhisperX — the pipeline's second pass, as a background job. Compose-stage scenes anchor to THIS transcript's word ids, never the raw one's. Skips when clean.json already describes the clean cut on disk (same cut identity), which a re-render for framing alone does not change. Returns when done or, past wait_seconds, as still running.",
  inputSchema: {
    force: z.boolean().optional().describe("Re-transcribe even if clean.json is current"),
    wait_seconds: waitSchema,
  },
}, async ({ force, wait_seconds }) => {
  const dir = currentProjectDir();
  const paths = projectPaths(dir);
  if (!fs.existsSync(paths.clean)) throw new Error("no clean.mp4; render_clean first");
  if (!force && cleanTranscriptCurrent(paths.cleanTranscript, paths.clean, readCleanMap(dir))) {
    return ok({ skipped: true, transcript: paths.cleanTranscript, words: cleanWords(dir).length });
  }
  startJob(dir, "retranscribe", "Transcribing the clean cut", process.execPath, [JOB, "retranscribe", dir]);
  return settle(dir, wait_seconds, () => describeFinished(dir, "retranscribe"));
});

server.registerTool("list_clean_words", {
  description: "The clean transcript's words with the ids scenes anchor to. Read this before set_scenes.",
  inputSchema: {},
}, async () => {
  const words = cleanWords(currentProjectDir());
  return ok(words.map((word) => `${word.id}:${word.text}`).join(" "));
});

server.registerTool("get_scenes", {
  description:
    "Read the CURRENT scene plan — scenes with indices, captions flag, theme, punch-ins. The person may have tweaked text, accents, layouts, the theme or the punch-ins in the app since the plan was last written, so ALWAYS read this before set_scenes and carry their changes forward; replacing the plan from memory discards their edits.",
  inputSchema: {},
}, async () => {
  const dir = currentProjectDir();
  const config = readComposeConfig(dir);
  return ok({
    scenes: (config.scenes ?? []).map((scene, index) => ({ index, ...scene, ...(scene.insertId ? { insert_id: scene.insertId } : {}) })),
    captions: Boolean(config.captions),
    theme: config.theme ?? null,
    punch: readPunch(dir),
    inserts: (config.inserts ?? []).map((insert) => ({ id: insert.id, chosen: insert.chosen ?? null, note: insert.note ?? null })),
  });
});

// ---- Insert points and the dialogue ----

const optionSceneShape = z.object({
  type: z.enum([...SCENE_TYPES]),
  from_word_id: z.number().int().min(0),
  to_word_id: z.number().int().min(0),
  text: z.string().optional(), subtitle: z.string().optional(), style: z.string().optional(),
  accent: z.string().optional(), flair: z.boolean().optional(),
  layout: z.enum([...LAYOUTS]).optional(), corner: z.enum(["br", "bl", "tr", "tl"]).optional(),
  graphic: z.any().optional(),
});

const shapeScene = (scene) => {
  const { from_word_id, to_word_id, ...rest } = scene;
  const out = { ...rest, fromWordId: from_word_id, toWordId: to_word_id };
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out;
};

server.registerTool("set_inserts", {
  description:
    "Mark the moments a visual could go and offer ready-made options for each: an insert point is a word span, a line saying what the moment is, and 2–4 options, each a complete list of scenes inside the span (a side card, the spoken words, a full-stage cover, a callout…). The window shows the points in the transcript and the timeline; the person picks an option, or asks for something else in words. Put the option you would choose first. Replaces the list; choices and notes on inserts with the same id are kept. Read get_inserts first when the person has been choosing.",
  inputSchema: {
    inserts: z.array(z.object({
      id: z.string().describe("short slug, stable across edits"),
      from_word_id: z.number().int().min(0),
      to_word_id: z.number().int().min(0),
      why: z.string().max(120).describe("what the moment is, in a line"),
      options: z.array(z.object({
        id: z.string().describe("short slug"),
        label: z.string().max(60).describe("what the person sees on the button"),
        scenes: z.array(optionSceneShape).min(1),
      })).min(1).max(5),
    })).max(60),
    apply_first: z.boolean().optional().describe("Materialise each insert's first option now, so the film has a plan before anyone chooses (default true)"),
  },
}, async ({ inserts, apply_first }) => {
  const dir = currentProjectDir();
  const words = cleanWords(dir);
  const previous = readComposeConfig(dir);
  const earlier = new Map((previous.inserts ?? []).map((insert) => [insert.id, insert]));
  const shaped = inserts.map((insert) => ({
    id: insert.id, fromWordId: insert.from_word_id, toWordId: insert.to_word_id, why: insert.why,
    options: insert.options.map((option) => ({ id: option.id, label: option.label, scenes: option.scenes.map(shapeScene) })),
    chosen: earlier.get(insert.id)?.chosen ?? null,
    note: earlier.get(insert.id)?.note ?? null,
  }));
  validateInserts(shaped, words);
  // Scenes of inserts that no longer exist go with them.
  const keep = new Set(shaped.map((insert) => insert.id));
  let config = { ...previous, inserts: shaped, scenes: (previous.scenes ?? []).filter((scene) => !scene.insertId || keep.has(scene.insertId)) };
  for (const insert of shaped) {
    const stillValid = insert.chosen && insert.chosen !== "other" && insert.options.some((option) => option.id === insert.chosen);
    if (stillValid) config = applyInsertChoice(config, insert.id, insert.chosen);
    else if (insert.chosen === "other") { /* the person asked for something else; leave it to the dialogue */ }
    else if (apply_first !== false) config = applyInsertChoice(config, insert.id, insert.options[0].id);
    else config = applyInsertChoice(config, insert.id, null);
  }
  validateScenes(config.scenes, words);
  writeComposeConfig(dir, config);
  return ok({ inserts: config.inserts.map((insert) => ({ id: insert.id, chosen: insert.chosen, options: insert.options.map((o) => o.id) })), scenes: config.scenes.length });
});

server.registerTool("get_inserts", {
  description: "The insert points with what the person chose (an option id, \"other\" with their note, or nothing yet) and each insert's options. Read before set_inserts or answering a note.",
  inputSchema: {},
}, async () => {
  const config = readComposeConfig(currentProjectDir());
  return ok({
    inserts: (config.inserts ?? []).map((insert) => ({
      id: insert.id, from_word_id: insert.fromWordId, to_word_id: insert.toWordId, why: insert.why,
      chosen: insert.chosen ?? null, note: insert.note ?? null,
      options: insert.options.map((option) => ({ id: option.id, label: option.label, scenes: option.scenes.length })),
    })),
    pending: pendingInbox(currentProjectDir()).length,
  });
});

server.registerTool("apply_insert", {
  description: "Materialise one insert's option into the plan (or clear it with option_id null). Use after adding an option that answers the person's note.",
  inputSchema: {
    id: z.string(),
    option_id: z.string().nullable(),
  },
}, async ({ id, option_id }) => {
  const dir = currentProjectDir();
  const words = cleanWords(dir);
  const config = applyInsertChoice(readComposeConfig(dir), id, option_id);
  validateScenes(config.scenes, words);
  writeComposeConfig(dir, config);
  return ok({ id, chosen: option_id, scenes: config.scenes.length });
});

server.registerTool("wait_for_input", {
  description:
    "Wait for the person to do something in the window: choose an option on an insert point, ask for something else on one (type insert-other, with their words), or send a message (type message). Returns the events as soon as there are any, or none after wait_seconds; call it again to keep listening. This is the dialogue: after your pass, sit in this loop; answer an insert-other by adding an option to that insert (set_inserts keeps the rest) and apply_insert it, answer a message by doing what it asks, and say what you did.",
  inputSchema: { wait_seconds: waitSchema },
}, async ({ wait_seconds }) => {
  const dir = currentProjectDir();
  const deadline = Date.now() + (wait_seconds ?? DEFAULT_WAIT_SECONDS) * 1000;
  for (;;) {
    const events = takeInbox(dir);
    if (events.length > 0) {
      const config = readComposeConfig(dir);
      const byId = new Map((config.inserts ?? []).map((insert) => [insert.id, insert]));
      return ok({
        events: events.map((event) => ({ ...event, why: event.insertId ? byId.get(event.insertId)?.why ?? null : undefined })),
        pendingInserts: (config.inserts ?? []).filter((insert) => insert.chosen === "other").map((insert) => ({ id: insert.id, note: insert.note })),
      });
    }
    if (Date.now() >= deadline) return ok({ events: [], hint: "nothing from the window yet; call wait_for_input again to keep listening" });
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
});

server.registerTool("set_scenes", {
  description:
    `Replace the project's scene plan (declarative, whole-plan-at-once). Scene types: ${[...SCENE_TYPES].join(", ")}. title carries text, an optional subtitle and a style (${[...TITLE_STYLES].join("/")}; block is the broadcast lower third); callout carries text and a style (${[...CALLOUT_STYLES].join("/")}); styles default to the theme's. graphic carries an animated insert card — kind ${[...GRAPHIC_KINDS].join("/")}: chart (items with numeric values, bars grow in), stat (one big count-up number with prefix/suffix), list (items reveal with checks), image (a still from assets/ with motion ${[...IMAGE_MOTIONS].join("/")}), screen (the recording's own screen track in sync beside the head — only inside get_framing's screenSpans, with a stage pip or side layout), quote (text + by), compare (left/right columns with title and items, a VS badge), steps (numbered items joined by a line), ring (value 0–100 with label, drawn as an arc), logos (items with src pictures from assets/ — fetch_image gets them), and three that take the WHOLE stage: cover (a still edge to edge with a big title and subtitle, optional tint), section (a chapter heading: number, title, subtitle), custom (your own html + css for this one moment: scoped, no scripts or external loads, animate with the CSS variables --q (0→1 over the first 1.8 s), --p (0→1 over the span) and --alpha; cqw/cqh units measure the stage; pictures as assets/name.png). All motion is a pure function of scene progress. stage scenes place the talking head on the 1080p canvas for their span — layout focus (large, centered), pip (small corner card; optional corner br/bl/tr/tl), side (head left, content right), or full (the visuals own the stage, the head a small corner card; pair it with cover/section/custom) — easing between layouts at each boundary; anywhere undeclared, the head holds focus. The engine bridges returns to focus shorter than 3 s and absorbs placed segments shorter than that, so do not plan flights closer together than a breath. Scenes anchor to clean-transcript word ids; captions turns phrase captions on (their look is the theme's captionStyle). Theme and punch-ins are kept unless given; set_theme owns the look. The Compose tab previews everything live; render_final bakes it, re-rendering only the chunks that changed.`,
  inputSchema: {
    scenes: z.array(z.object({
      type: z.enum([...SCENE_TYPES]),
      from_word_id: z.number().int().min(0),
      to_word_id: z.number().int().min(0),
      text: z.string().min(1).optional().describe("title/callout text"),
      subtitle: z.string().max(80).optional().describe("title only: a second line (the block style shows it on an ink strip)"),
      style: z.string().optional().describe(`title: ${[...TITLE_STYLES].join("/")}; callout: ${[...CALLOUT_STYLES].join("/")}; omit for the theme's default`),
      accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("per-scene accent override"),
      flair: z.boolean().optional().describe("title only: a particle burst behind the text"),
      insert_id: z.string().optional().describe("the insert point this scene was chosen for (carried from get_scenes; do not invent)"),
      layout: z.enum([...LAYOUTS]).optional().describe("stage scenes only"),
      corner: z.enum(["br", "bl", "tr", "tl"]).optional().describe("stage pip/full only"),
      graphic: z.object({
        kind: z.enum([...GRAPHIC_KINDS]),
        title: z.string().optional(),
        value: z.number().optional().describe("stat: counts up in its own precision (3.99 keeps cents); ring: 0–100"),
        prefix: z.string().max(4).optional().describe("stat only: text before the number, e.g. $"),
        suffix: z.string().max(6).optional().describe("stat/ring: text after the number, e.g. % or k (ring defaults to %)"),
        label: z.string().optional().describe("stat/ring label; image or screen caption"),
        src: z.string().optional().describe("image only: project-relative png/jpg/webp, e.g. assets/still.png"),
        motion: z.enum([...IMAGE_MOTIONS]).optional().describe("image only: tilt (default), kenburns, pop"),
        text: z.string().max(220).optional().describe("quote only: the quotation"),
        by: z.string().max(60).optional().describe("quote only: who said it"),
        subtitle: z.string().max(80).optional().describe("cover/section: the second line"),
        number: z.string().max(6).optional().describe("section: a chapter number or short mark"),
        tint: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("cover: colour of the shade over the still"),
        html: z.string().max(20000).optional().describe("custom only: the markup"),
        css: z.string().max(10000).optional().describe("custom only: styles, scoped to the card"),
        full: z.boolean().optional().describe("custom only: false keeps it inside the layout's content rect instead of the whole stage"),
        left: z.object({ title: z.string().min(1), items: z.array(z.object({ label: z.string().min(1) })).min(1).max(5) }).optional().describe("compare only"),
        right: z.object({ title: z.string().min(1), items: z.array(z.object({ label: z.string().min(1) })).min(1).max(5) }).optional().describe("compare only"),
        items: z.array(z.object({
          label: z.string().min(1).optional().describe("chart/list/steps rows; a caption under a logo"),
          value: z.number().optional().describe("chart only"),
          src: z.string().optional().describe("logos only: project-relative picture"),
        })).max(6).optional().describe("chart/list/steps/logos rows"),
      }).optional().describe("graphic scenes only"),
    })).describe("The full scene list; an empty array clears it. kinetic scenes render the spoken words as giant center-stage type over their span."),
    captions: z.boolean().default(false).describe("Karaoke captions over the whole video"),
    theme: z.object({
      accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    }).optional().describe("A quick accent override merged into the theme; set_theme is the full instrument"),
    punch_zoom: z.number().min(1.02).max(1.5).nullable().optional()
      .describe("Punch-in zoom for the alternating shot plan; null turns punch-ins off; omit to keep the current setting"),
  },
}, async ({ scenes, captions, theme, punch_zoom }) => {
  const dir = currentProjectDir();
  const words = cleanWords(dir);
  const shaped = scenes.map((scene) => ({
    type: scene.type,
    fromWordId: scene.from_word_id,
    toWordId: scene.to_word_id,
    text: scene.text,
    subtitle: scene.subtitle,
    style: scene.style,
    accent: scene.accent,
    flair: scene.flair,
    layout: scene.layout,
    corner: scene.corner,
    graphic: scene.graphic,
    ...(scene.insert_id ? { insertId: scene.insert_id } : {}),
  }));
  validateScenes(shaped, words);
  const previous = readComposeConfig(dir);
  const mergedTheme = theme ? { ...(previous.theme ?? {}), ...theme } : previous.theme;
  validateTheme(mergedTheme);
  const config = {
    scenes: shaped,
    captions,
    theme: mergedTheme,
    inserts: previous.inserts,
    punch: punch_zoom === undefined ? readPunch(dir) : (punch_zoom === null ? null : { zoom: punch_zoom }),
    // The cut these word ids belong to; status compares it with the
    // transcript's own stamp to say when scenes need re-anchoring.
    cutIdentity: cleanTranscriptStamp(dir),
  };
  if (!config.theme) delete config.theme;
  if (!config.inserts) delete config.inserts;
  if (!config.cutIdentity) delete config.cutIdentity;
  writeComposeConfig(dir, config);
  // Screen scenes outside a screen span play a dark card: worth saying.
  const warnings = [];
  const spans = readCleanMap(dir)?.screenSpans ?? [];
  resolveScenes(shaped, words).forEach((scene, index) => {
    if (scene.graphic?.kind !== "screen") return;
    const covered = spans.some((span) => span.start <= scene.start + 0.05 && scene.end - 0.05 <= span.end);
    if (!covered) warnings.push(`scene ${index}: screen graphic over ${scene.start.toFixed(1)}–${scene.end.toFixed(1)}s is outside every screen span ${JSON.stringify(spans)}`);
  });
  return ok({ scenes: shaped.length, captions, theme: config.theme ?? null, punch: config.punch ?? null, warnings });
});

// ---- The look: themes and brand ----

const themeShape = {
  preset: z.enum(Object.keys(PRESETS)).optional().describe("The base look; list_themes describes each"),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("Brand colour: bars, tags, rings, the glow"),
  accent2: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("Second colour: gradients, the right side of a compare"),
  text: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("Type colour on the field"),
  fonts: z.object({
    display: z.string().optional(), body: z.string().optional(), serif: z.string().optional(),
  }).optional().describe(`Font families; vendored and identical everywhere: ${VENDORED_FONTS.join(", ")}`),
  title_style: z.enum([...TITLE_STYLES]).optional(),
  callout_style: z.enum([...CALLOUT_STYLES]).optional(),
  caption_style: z.enum([...CAPTION_STYLES]).optional().describe("pill, band (broadcast strip), karaoke (spoken word lit), none"),
  title_case: z.enum(["none", "upper"]).optional(),
  glow: z.number().min(0).max(0.4).optional().describe("Strength of the accent light on the field, 0 off"),
  radius: z.number().min(0).max(2).optional().describe("Corner rounding multiplier, 0 square"),
  logo: z.object({
    src: z.string().describe("project-relative png/jpg/webp, e.g. assets/logo.png (fetch_image or the inspector puts it there)"),
    corner: z.enum([...CORNERS]).optional(),
    size: z.number().min(0.04).max(0.3).optional().describe("share of the stage width, default 0.09"),
    opacity: z.number().min(0.1).max(1).optional(),
  }).nullable().optional().describe("A logo watermark; null removes it"),
  watermark: z.string().max(40).nullable().optional().describe("A handle or site in the opposite corner; null removes it"),
};

const themeFromArgs = (args) => {
  const map = { title_style: "titleStyle", callout_style: "calloutStyle", caption_style: "captionStyle", title_case: "titleCase" };
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    out[map[key] ?? key] = value;
  }
  return out;
};

server.registerTool("list_themes", {
  description: "The theme presets — each a complete look (field, type, title and callout styles, caption style, glow) — and the vendored fonts. Pick one with set_theme and override what the brand needs.",
  inputSchema: {},
}, async () => ok({ presets: describePresets(), fonts: VENDORED_FONTS, titleStyles: [...TITLE_STYLES], calloutStyles: [...CALLOUT_STYLES], captionStyles: [...CAPTION_STYLES] }));

server.registerTool("get_theme", {
  description: "The project's theme as written (preset plus overrides) and as resolved (every token the stage uses). Read before set_theme: the person may have changed it in the inspector.",
  inputSchema: {},
}, async () => {
  const config = readComposeConfig(currentProjectDir()).theme ?? {};
  return ok({ config, resolved: resolveTheme(config), assets: listAssets(path.join(currentProjectDir(), "assets")) });
});

server.registerTool("set_theme", {
  description:
    "Set the look of the film for consistent branding: a preset, the brand colours, fonts, title/callout/caption styles, a logo watermark and a handle. Fields merge into the current theme (null removes a logo or watermark); reset drops every override and keeps the preset. Previews at once in the window; chunks the look touches re-render on the next render_final (the field and glow are part of every chunk, so a new preset or accent re-renders the film).",
  inputSchema: { ...themeShape, reset: z.boolean().optional().describe("Drop all overrides first") },
}, async ({ reset, ...args }) => {
  const dir = currentProjectDir();
  const config = readComposeConfig(dir);
  const patch = themeFromArgs(args);
  let theme = reset ? (config.theme?.preset ? { preset: config.theme.preset } : {}) : { ...(config.theme ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete theme[key];
    else if (key === "fonts") theme.fonts = { ...(theme.fonts ?? {}), ...value };
    else theme[key] = value;
  }
  if (theme.logo?.src && !fs.existsSync(path.join(dir, theme.logo.src))) throw new Error(`no such asset ${theme.logo.src}; fetch_image or list_assets first`);
  validateTheme(theme);
  config.theme = theme;
  writeComposeConfig(dir, config);
  return ok({ theme, resolved: resolveTheme(theme) });
});

// ---- Pictures ----

server.registerTool("search_images", {
  description: "Search Wikimedia Commons for pictures and logos: returns titles, licences, sizes and PNG thumbnail URLs (SVG logos come rasterised). Pick one and fetch_image its thumbUrl. Say the licence in the film's description when it asks for attribution (CC BY).",
  inputSchema: {
    query: z.string().min(2).describe("e.g. 'Godot engine logo', 'Steam Deck photo'"),
    count: z.number().int().min(1).max(12).optional().describe("default 6"),
  },
}, async ({ query, count }) => ok({ results: await searchCommons({ query, count: count ?? 6 }) }));

server.registerTool("fetch_image", {
  description:
    "Fetch a picture into the project's assets/ for image, logos or the theme logo: a direct image URL, a page URL (its share image is taken), or a site's icon at 256 px (kind icon, e.g. 'photopea.com'). Returns the project-relative src to use in set_scenes or set_theme.",
  inputSchema: {
    url: z.string().min(3).describe("Image URL, page URL, or a domain for kind icon"),
    name: z.string().max(60).optional().describe("File name to give it (slugified)"),
    kind: z.enum(["auto", "page", "icon"]).optional().describe("auto: image or page; page: always the share image; icon: the site's icon"),
  },
}, async ({ url, name, kind }) => {
  const dir = currentProjectDir();
  const result = await fetchImage({ url, name, kind: kind ?? "auto", assetsDir: path.join(dir, "assets"), ffmpeg: FFMPEG });
  const { file, ...rest } = result;
  return ok(rest);
});

server.registerTool("list_assets", {
  description: "Pictures already in the project's assets/ (fetched, or chosen in the inspector), as project-relative srcs.",
  inputSchema: {},
}, async () => ok({ assets: listAssets(path.join(currentProjectDir(), "assets")) }));

server.registerTool("reanchor_scenes", {
  description:
    "After a re-cut and retranscribe_clean, move every scene's word anchors from the previous clean transcript to the new one by matching the words said at each end of the scene near where they used to be. Writes compose.json with the moved anchors (everything else kept) and returns a per-scene report; a scene whose words could not be found keeps its old ids and is listed under `unresolved` for you to place by hand with list_clean_words and set_scenes. Dry-run with apply=false to see the report first.",
  inputSchema: {
    apply: z.boolean().default(true).describe("Write the moved anchors to compose.json"),
  },
}, async ({ apply }) => {
  const dir = currentProjectDir();
  const paths = projectPaths(dir);
  if (!fs.existsSync(paths.compose)) throw new Error("no compose.json; nothing to re-anchor");
  if (!fs.existsSync(paths.previousCleanTranscript)) {
    throw new Error("no clean.previous.json: the previous transcript is kept by retranscribe_clean from now on; place the scenes with list_clean_words and set_scenes this once");
  }
  const oldWords = flattenWords(readJson(paths.previousCleanTranscript));
  const newWords = cleanWords(dir);
  const config = readComposeConfig(dir);
  const report = reanchorScenes(config.scenes ?? [], oldWords, newWords);
  const unresolved = report.filter((r) => !r.ok);
  if (apply) {
    for (const entry of report) {
      if (!entry.ok) continue;
      config.scenes[entry.index].fromWordId = entry.fromWordId;
      config.scenes[entry.index].toWordId = entry.toWordId;
    }
    validateScenes(config.scenes ?? [], newWords);
    config.cutIdentity = cleanTranscriptStamp(dir) ?? config.cutIdentity;
    if (!config.cutIdentity) delete config.cutIdentity;
    writeComposeConfig(dir, config);
  }
  return ok({
    applied: apply,
    moved: report.filter((r) => r.ok).length,
    unresolved: unresolved.map((r) => ({ index: r.index, type: r.type, reason: r.reason, fromWordId: r.fromWordId, toWordId: r.toWordId })),
    scenes: report.map((r) => (r.ok
      ? { index: r.index, type: r.type, fromWordId: r.fromWordId, toWordId: r.toWordId, shiftSeconds: r.shiftSeconds, confidence: r.confidence, text: r.text.length > 90 ? `${r.text.slice(0, 87)}…` : r.text }
      : { index: r.index, type: r.type, unresolved: r.reason })),
  });
});

server.registerTool("render_final", {
  description:
    "The composited render, as a background job: the head and screen tracks are placed on the 1080p stage by ffmpeg from the stage engine's own numbers (punch-ins included), the overlays are captured from the same runtime the preview uses only where they change, and the film is built in cached two-minute chunks — a tweak re-renders the chunks it touched, the rest is copied with the untouched audio. Writes out/final.mp4, or out/preview-<from>-<to>.mp4 for a word range. A whole film is minutes; the window shows progress. Returns when done or, past wait_seconds, as still running (then wait_render). Never re-renders the clean cut.",
  inputSchema: {
    from_word_id: z.number().int().min(0).optional().describe("Render only from this clean word…"),
    to_word_id: z.number().int().min(0).optional().describe("…to this clean word (inclusive)"),
    fresh: z.boolean().optional().describe("Ignore cached chunks and render every one again"),
    wait_seconds: waitSchema,
  },
}, async ({ from_word_id, to_word_id, fresh, wait_seconds }) => {
  const dir = currentProjectDir();
  const paths = projectPaths(dir);
  if (!fs.existsSync(paths.compose)) throw new Error("no compose.json; set_scenes first");
  if (!fs.existsSync(paths.clean)) throw new Error("no clean.mp4; render_clean first");
  const map = readCleanMap(dir);
  if (!cleanTranscriptCurrent(paths.cleanTranscript, paths.clean, map)) {
    throw new Error("clean.json does not describe the clean cut on disk: retranscribe_clean first, then re-anchor the scenes");
  }
  const warnings = [];
  const plan = currentCleanPlan(dir);
  if (!cleanCurrent(map, plan, paths.clean)) {
    warnings.push("clean.mp4 is stale: the cut list or framing changed after it was rendered. The film renders from the clean cut on disk; render_clean → retranscribe_clean → re-anchor if the change was meant.");
  }
  const args = [];
  let output = paths.final;
  if (from_word_id !== undefined || to_word_id !== undefined) {
    const words = cleanWords(dir);
    const byId = new Map(words.map((word) => [word.id, word]));
    const first = byId.get(from_word_id ?? 0);
    const last = byId.get(to_word_id ?? words.at(-1).id);
    if (!first || !last) throw new Error(`word ids must be 0–${words.length - 1}`);
    output = path.join(dir, "out", `preview-${first.id}-${last.id}.mp4`);
    args.push(`--from=${Math.max(first.start - 0.5, 0)}`, `--to=${last.end + 0.5}`, `--out=${output}`);
  }
  if (fresh) args.push("--fresh");
  startJob(dir, "render_final", output === paths.final ? "Rendering the film" : "Rendering a preview span", ELECTRON, [
    "--no-sandbox", "--no-zygote", "--ozone-platform=headless", EXPORT, ...args, dir,
  ], {
    env: {
      LD_LIBRARY_PATH: [
        path.join(REPO_ROOT, "tools", "wsl-libs", "usr", "lib", "x86_64-linux-gnu"),
        process.env.LD_LIBRARY_PATH,
      ].filter(Boolean).join(":"),
    },
  });
  return settle(dir, wait_seconds, () => ({ ...describeFinished(dir, "render_final"), output, bytes: fs.existsSync(output) ? fs.statSync(output).size : null, warnings }));
});

server.registerTool("wait_render", {
  description:
    "Wait for the running background job (a render or a transcription) and report how it ended: the artifact when done, the error and log when failed, or still-running with its latest progress line after wait_seconds. Call it again if still running; it costs nothing.",
  inputSchema: { wait_seconds: waitSchema },
}, async ({ wait_seconds }) => {
  const dir = currentProjectDir();
  const stage = runningJob(dir)?.stage ?? readProgress(dir)?.stage ?? lastJobStage(dir);
  if (!stage) return ok({ done: true, hint: "no job has run in this project" });
  return settle(dir, wait_seconds, () => describeFinished(dir, stage));
});

// What is out of date relative to what feeds it, and the tool that fixes
// it. This is the order of the pipeline read backwards: an agent that reads
// it never has to guess which step to repeat after a change. The clean cut
// and its transcript compare by identity, never by file time.
function staleness(dir, paths) {
  const mtime = (file) => (fs.existsSync(file) ? fs.statSync(file).mtimeMs : null);
  const out = [];
  const map = readCleanMap(dir);
  const clean = mtime(paths.clean);
  if (clean !== null && fs.existsSync(paths.review)) {
    const plan = currentCleanPlan(dir);
    if (!cleanCurrent(map, plan, paths.clean)) {
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

server.registerTool("status", {
  description: "Current project state: what is staged, transcribed, reviewed, and rendered, with cut statistics, the running background job if any, what is stale and which tool fixes it. Read it before repeating a step.",
  inputSchema: {},
}, async () => {
  if (!fs.existsSync(POINTER)) return ok({ project: null, hint: "call open_project" });
  const pointer = readJson(POINTER);
  const dir = path.join(MEDIA_ROOT, pointer.dir);
  const paths = projectPaths(dir);
  const running = runningJob(dir);
  const progress = readProgress(dir);
  const state = {
    project: pointer.dir,
    video: paths.video,
    transcribed: fs.existsSync(paths.transcript),
    reviewed: fs.existsSync(paths.review),
    rendered: fs.existsSync(paths.clean),
    cleanTranscribed: fs.existsSync(paths.cleanTranscript),
    composed: fs.existsSync(paths.compose),
    finalRendered: fs.existsSync(paths.final),
    framed: fs.existsSync(paths.framing),
    screenTrack: fs.existsSync(paths.screen),
    encoder: encoderCapabilities().nvenc ? "h264_nvenc" : "libx264",
    running: running ? { stage: running.stage, label: running.label, detail: running.detail, startedAt: running.startedAt, pid: running.pid } : null,
    lastFailure: !running && progress && typeof progress.detail === "string" && progress.detail.startsWith("failed:")
      ? { stage: progress.stage, error: progress.detail.slice(8), log: path.join(dir, "out", `${progress.stage}.log`) }
      : null,
  };
  if (state.reviewed) Object.assign(state, reviewStats(readReview(dir)));
  state.punch = readPunch(dir);
  state.clean = cleanSummary(dir);
  state.stale = staleness(dir, paths);
  return ok(state);
});

await server.connect(new StdioServerTransport());
