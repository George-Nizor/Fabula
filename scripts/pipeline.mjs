// I/O around the core engines, shared by the CLI driver, the MCP server and
// the background jobs: probing, transcription, cut computation, source
// framing, the clean render, encoder selection, and the progress file the
// window watches. Everything here takes and returns plain data; process exit
// codes and protocol framing belong to the callers.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  flattenWords,
  detectFillerCuts,
  detectGapCuts,
  normalizeCuts,
  keepSegments,
  totalCutSeconds,
} from "../core/cut-engine.mjs";
import {
  fullFrameFraming,
  splitKeepsByFraming,
  headOutputSize,
  screenOutputSize,
  screenSpans,
} from "../core/framing-engine.mjs";
import { cutIdentity, cleanIdentity, CLEAN_VERSION } from "../core/clean-identity.mjs";
import { frameSpans, cleanGraph } from "../core/clean-graph.mjs";

export const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FFMPEG = path.join(REPO_ROOT, "tools", "ffmpeg", "ffmpeg");
export const FFPROBE = path.join(REPO_ROOT, "tools", "ffmpeg", "ffprobe");
const WHISPERX = path.join(REPO_ROOT, ".venv-whisperx", "bin", "whisperx");

// The clean cut is delivered at stage resolution and a review-friendly frame
// rate: a 3440x1440 60fps master would otherwise cost four times the encode
// for pixels the 1080p stage never shows. A one-second GOP keeps the window's
// scrubbing and the final render's per-chunk seeks quick; nothing seeks it
// per frame any more.
export const CLEAN_FPS = 30;
export const CLEAN_CEILING = { width: 1920, height: 1080 };
export const CLEAN_GOP = 30;

export const sha = (text) => crypto.createHash("sha1").update(text).digest("hex").slice(0, 16);

// Integrated loudness of a file's first audio stream, in LUFS (EBU R128),
// or null when it has no audio. A whole film takes a few seconds.
export function measureLoudness(file) {
  const result = spawnSync(FFMPEG, ["-hide_banner", "-nostats", "-i", file, "-map", "0:a:0", "-af", "ebur128=framelog=quiet", "-f", "null", "-"], { encoding: "utf8" });
  const match = String(result.stderr ?? "").match(/\bI:\s+(-?\d+(?:\.\d+)?)\s+LUFS/);
  return match ? Number(match[1]) : null;
}

export function probeDuration(file) {
  const result = spawnSync(FFPROBE, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    file,
  ], { encoding: "utf8" });
  const duration = Number.parseFloat(result.stdout);
  if (!Number.isFinite(duration)) throw new Error(`ffprobe could not read duration of ${file}`);
  return duration;
}

// Whether a file carries a sound track at all: a clip without one has no
// natural sound to play, and the assistant should know before planning it.
export function probeHasAudio(file) {
  const result = spawnSync(FFPROBE, ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0", file], { encoding: "utf8" });
  return /audio/.test(String(result.stdout ?? ""));
}

export function probeDimensions(file) {
  const result = spawnSync(FFPROBE, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "csv=p=0",
    file,
  ], { encoding: "utf8" });
  const [width, height] = result.stdout.trim().split(",").map(Number);
  if (!width || !height) throw new Error(`ffprobe could not read dimensions of ${file}`);
  return { width, height };
}

// ---- Encoders ----
//
// The 4080's NVENC is reachable from WSL (libnvidia-encode is exposed under
// /usr/lib/wsl/lib) once the ffmpeg build knows how to ask; the John Van
// Sickle static build does not, the BtbN GPL build does. Probed with a real
// encode of a few frames (NVENC refuses tiny ones), never inferred from the
// encoder list, and cached
// beside the binary so every job does not pay for the probe. NVDEC is
// deliberately not used: it decodes this footage no faster than sixteen
// cores do and would tie the clean render to h264/hevc sources.

let capabilities = null;

export function encoderCapabilities() {
  if (capabilities) return capabilities;
  let binary = null;
  try {
    const stat = fs.statSync(FFMPEG);
    binary = `${stat.size}:${Math.round(stat.mtimeMs)}`;
  } catch {
    return (capabilities = { binary: null, nvenc: false, version: null });
  }
  const cacheFile = path.join(path.dirname(FFMPEG), ".capabilities.json");
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (cached.binary === binary) return (capabilities = cached);
  } catch { /* first run with this binary */ }
  const probe = spawnSync(FFMPEG, [
    "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=256x144:r=30:d=0.2",
    "-c:v", "h264_nvenc", "-f", "null", "-",
  ], { encoding: "utf8" });
  const version = (spawnSync(FFMPEG, ["-version"], { encoding: "utf8" }).stdout ?? "").split("\n")[0] ?? null;
  capabilities = { binary, nvenc: probe.status === 0, version };
  try { fs.writeFileSync(cacheFile, JSON.stringify(capabilities, null, 2)); } catch { /* read-only tools dir is fine */ }
  return capabilities;
}

// The video encoder for a role: `head` and `screen` are the clean cut's two
// tracks (an intermediate that is decoded again and again, so smallish and
// quick), `film` is the delivered picture. One GOP length for all of them.
export function videoEncoderArgs(role, gop = CLEAN_GOP) {
  const common = ["-pix_fmt", "yuv420p", "-g", String(gop)];
  if (encoderCapabilities().nvenc) {
    const quality = {
      head: ["-preset", "p5", "-tune", "hq", "-cq", "21"],
      screen: ["-preset", "p4", "-tune", "hq", "-cq", "23"],
      film: ["-preset", "p6", "-tune", "hq", "-cq", "19", "-temporal-aq", "1"],
      // A draft is looked at once and thrown away: the fastest preset, a
      // coarse quantiser.
      draft: ["-preset", "p1", "-cq", "30"],
    }[role];
    return ["-c:v", "h264_nvenc", ...quality, "-rc", "vbr", "-b:v", "0", "-bf", "2", "-spatial-aq", "1", "-profile:v", "high", ...common];
  }
  const quality = {
    head: ["-preset", "medium", "-crf", "18"],
    screen: ["-preset", "veryfast", "-crf", "20"],
    film: ["-preset", "medium", "-crf", "18"],
    draft: ["-preset", "ultrafast", "-crf", "28"],
  }[role];
  return ["-c:v", "libx264", ...quality, "-keyint_min", String(gop), ...common];
}

// faster-whisper's ctranslate2 loads CUDA from the wheels inside the venv,
// not from a system install this machine does not have; whisperx also expects
// an ffmpeg on PATH. Both are supplied here so callers need no environment.
function whisperEnv() {
  const nv = path.join(REPO_ROOT, ".venv-whisperx", "lib", "python3.12", "site-packages", "nvidia");
  const libs = ["cublas", "cudnn", "cuda_runtime", "cufft", "nvjitlink"]
    .map((name) => path.join(nv, name, "lib"));
  return {
    ...process.env,
    LD_LIBRARY_PATH: [libs.join(":"), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
    PATH: [path.join(REPO_ROOT, "tools", "ffmpeg"), process.env.PATH].join(":"),
  };
}

// WhisperX large-v3 on CUDA, word timestamps, JSON out — the brief's
// transcribe step. Writes <video basename>.json next to outPath's directory
// and renames it to outPath. Minutes-long on first run (model download).
// `stamp` is recorded under a `fabula` key so the transcript can say which
// cut it describes (see cleanTranscriptCurrent).
export function transcribe(videoPath, outPath, options = {}) {
  const outDir = path.dirname(outPath);
  fs.mkdirSync(outDir, { recursive: true });
  const result = spawnSync(WHISPERX, [
    videoPath,
    "--model", "large-v3",
    "--compute_type", "float16",
    "--output_format", "json",
    "--output_dir", outDir,
    "--language", "en",
  ], { encoding: "utf8", env: whisperEnv() });
  if (result.status !== 0) {
    throw new Error(`whisperx failed (${result.status}): ${(result.stderr || "").slice(-800)}`);
  }
  const produced = path.join(outDir, path.basename(videoPath, path.extname(videoPath)) + ".json");
  const transcript = JSON.parse(fs.readFileSync(produced, "utf8"));
  if (options.stamp) transcript.fabula = options.stamp;
  fs.writeFileSync(outPath, JSON.stringify(transcript));
  if (produced !== outPath) fs.rmSync(produced, { force: true });
  return transcript;
}

// Transcript + duration -> the full review state the UI renders: every word,
// every cut proposal with its reasons and word anchors, enabled flags on.
export function computeReview(transcript, videoPath, duration, options = {}) {
  const words = flattenWords(transcript);
  const gapOptions = {
    mediaDurationSeconds: duration,
    minGapSeconds: options.minGapSeconds,
    keepBreathSeconds: options.keepBreathSeconds,
  };
  const cuts = normalizeCuts([
    ...detectFillerCuts(words),
    ...detectGapCuts(words, gapOptions),
  ]);
  return {
    video: path.resolve(videoPath),
    duration,
    generatedAt: new Date().toISOString(),
    cutOptions: { minGapSeconds: options.minGapSeconds ?? 0.6, keepBreathSeconds: options.keepBreathSeconds ?? 0.15 },
    words,
    cuts,
  };
}

export function reviewStats(review) {
  const removed = totalCutSeconds(review.cuts);
  const enabled = review.cuts.filter((cut) => cut.enabled).length;
  return {
    words: review.words.length,
    cuts: review.cuts.length,
    cutsEnabled: enabled,
    removedSeconds: Number(removed.toFixed(2)),
    cleanSeconds: Number((review.duration - removed).toFixed(2)),
  };
}

// ---- Progress: what the window shows while a long step runs ----
//
// progress.json is rewritten at every step boundary; the window reads the
// stage and the clock and keeps the person company. Cleared on completion
// so a finished project shows nothing. A background job records its pid
// here, which is how a later session can tell "still running" from "died".

const PROGRESS = "progress.json";

export function readProgress(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, PROGRESS), "utf8"));
  } catch {
    return null;
  }
}

// The pid is recorded with the platform it belongs to: the window on Windows
// starts a job on the WSL side through wsl.exe, and a Linux pid means
// nothing to a Windows reader (nor the other way round). A job claims its
// own pid on its first report, so the record always names the process
// doing the work, not the launcher that started it.
export function reportProgress(dir, stage, label, detail = "", extra = {}) {
  const file = path.join(dir, PROGRESS);
  let startedAt = new Date().toISOString();
  let pid = extra.pid;
  let platform = extra.pid ? process.platform : undefined;
  const previous = readProgress(dir);
  if (previous) {
    const failed = typeof previous.detail === "string" && previous.detail.startsWith("failed:");
    if (previous.stage === stage && previous.startedAt && !failed) {
      startedAt = previous.startedAt;
      if (!pid) { pid = previous.pid; platform = previous.platform; }
    }
  }
  const record = { stage, label, detail, startedAt, updatedAt: new Date().toISOString() };
  if (pid) { record.pid = pid; record.platform = platform ?? process.platform; }
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
}

export function clearProgress(dir) {
  fs.rmSync(path.join(dir, PROGRESS), { force: true });
}

// Runs a step with progress bookkeeping around it, clearing on success and
// leaving a failure note behind when it throws.
export async function withProgress(dir, stage, label, step) {
  reportProgress(dir, stage, label, "", { pid: process.pid });
  try {
    const result = await step((detail) => reportProgress(dir, stage, label, detail));
    clearProgress(dir);
    return result;
  } catch (error) {
    reportProgress(dir, stage, label, `failed: ${String(error.message ?? error).slice(0, 200)}`);
    throw error;
  }
}

// ---- Background jobs ----
//
// Renders and transcriptions run as detached processes: the MCP tool that
// starts one returns as soon as it likes, the window keeps showing progress,
// and the job finishes whether or not the session that asked for it is
// still alive. A job is "running" while progress.json names a live pid.

export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

const STALE_PROGRESS_MS = 3 * 60 * 1000;
const QUIET_PROGRESS_MS = 60 * 60 * 1000;

// The job in flight, or null. A record whose process is gone is rewritten
// as a failure so nothing waits on it; a pid-less record (an in-process step
// from this or an older server), or one whose pid lives on another platform
// than this reader, counts as running only while it is fresh.
export function runningJob(dir) {
  const progress = readProgress(dir);
  if (!progress) return null;
  if (typeof progress.detail === "string" && progress.detail.startsWith("failed:")) return null;
  if (progress.pid && (progress.platform ?? process.platform) === process.platform) {
    if (pidAlive(progress.pid)) return progress;
    reportProgress(dir, progress.stage, progress.label, `failed: the ${progress.stage} process (pid ${progress.pid}) died before finishing; see out/${progress.stage}.log`);
    return null;
  }
  // Seen from the other platform (the Windows window over a WSL job) only
  // freshness can vouch for it. The transcriptions report once and then run
  // whisperx silently for as long as the footage needs, so they get an hour.
  const age = Date.now() - Date.parse(progress.updatedAt ?? progress.startedAt ?? 0);
  const quiet = ["transcribe", "retranscribe", "first_pass"].includes(progress.stage);
  return age < (quiet ? QUIET_PROGRESS_MS : STALE_PROGRESS_MS) ? progress : null;
}

// Starts a detached job: stdout and stderr to out/<stage>.log, progress.json
// claimed with the pid before returning so the window and the next status
// call both see it at once. Refuses while another job runs — two renders in
// one project folder would race for the same files.
export function startJob(dir, stage, label, command, args, options = {}) {
  const running = runningJob(dir);
  if (running) {
    throw new Error(`${running.stage} is already running (pid ${running.pid ?? "?"}, since ${running.startedAt}); wait_render first`);
  }
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  const logFile = path.join(dir, "out", `${stage}.log`);
  const log = fs.openSync(logFile, "w");
  // A headless Electron started from inside another Electron would run as
  // bare node and die on its first Chromium flag; the frame tool strips the
  // same variable.
  const env = { ...process.env, ...(options.env ?? {}) };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(command, args, {
    detached: true,
    stdio: ["ignore", log, log],
    cwd: "cwd" in options ? options.cwd : REPO_ROOT,
    env,
  });
  fs.closeSync(log);
  // A spawn that fails (no such program) is an event, not a throw; without a
  // listener it takes the whole process down and leaves a pid-less record
  // that refuses the next start for three minutes.
  child.on("error", (error) => {
    try { fs.appendFileSync(logFile, `could not start ${command}: ${error.message}\n`); } catch { /* the record says it */ }
    reportProgress(dir, stage, label, `failed: could not start ${path.basename(command)}: ${error.message}`);
  });
  child.unref();
  clearProgress(dir);
  if (!child.pid) throw new Error(`could not start ${path.basename(command)}; see ${logFile}`);
  reportProgress(dir, stage, label, "starting", { pid: child.pid });
  return { pid: child.pid, log: logFile };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits up to `seconds` for the running job, polling the progress file.
// Resolves with what it found: done (the file cleared), failed (with the
// note), or still running (with the latest detail).
export async function waitForJob(dir, seconds) {
  const deadline = Date.now() + Math.max(seconds, 0) * 1000;
  for (;;) {
    const progress = readProgress(dir);
    if (!progress) return { state: "done" };
    if (typeof progress.detail === "string" && progress.detail.startsWith("failed:")) {
      return { state: "failed", stage: progress.stage, error: progress.detail.slice(8), log: path.join(dir, "out", `${progress.stage}.log`) };
    }
    if (!runningJob(dir)) {
      // Just marked as died — the next read reports it — or a record nothing
      // here can vouch for (another platform's pid, gone quiet): say so
      // rather than spin.
      const again = readProgress(dir);
      if (again && !(typeof again.detail === "string" && again.detail.startsWith("failed:"))) {
        return { state: "stale", stage: again.stage, label: again.label, detail: again.detail, startedAt: again.startedAt, pid: again.pid,
          note: `the ${again.stage} record has not been updated since ${again.updatedAt ?? again.startedAt} and its process cannot be seen from here; if it is not running, remove progress.json and start again` };
      }
      await sleep(250);
      continue;
    }
    if (Date.now() >= deadline) {
      return { state: "running", stage: progress.stage, label: progress.label, detail: progress.detail, startedAt: progress.startedAt, pid: progress.pid };
    }
    await sleep(1000);
  }
}

// ---- Source framing: finding the head in the frame ----

const SCAN_W = 86;
const SCAN_H = 36;

function grayFrames(args, width, height) {
  const result = spawnSync(FFMPEG, [
    "-v", "info", "-nostats", ...args,
    "-f", "rawvideo", "-pix_fmt", "gray", "-",
  ], { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`ffmpeg scan failed: ${result.stderr.toString().slice(-400)}`);
  const times = [...result.stderr.toString().matchAll(/pts_time:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  const frameBytes = width * height;
  const count = Math.floor(result.stdout.length / frameBytes);
  return { buffer: result.stdout, count, times, width, height };
}

function bandStats(frames, index, x0, x1, y0, y1) {
  const { buffer, width } = frames;
  const offset = index * frames.width * frames.height;
  let sum = 0; let sq = 0; let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const v = buffer[offset + y * width + x];
      sum += v; sq += v * v; n += 1;
    }
  }
  const mean = sum / n;
  return { mean, sd: Math.sqrt(Math.max(sq / n - mean * mean, 0)) };
}

// A frame whose side bands are flat and alike is pillarboxed: a 16:9 camera
// inside a wider canvas. Flat top and bottom bands mean letterboxing.
function classify(frames, index) {
  const { width: W, height: H } = frames;
  const l = bandStats(frames, index, 0, Math.round(W * 0.1), 0, H);
  const r = bandStats(frames, index, W - Math.round(W * 0.1), W, 0, H);
  const t = bandStats(frames, index, 0, W, 0, Math.round(H * 0.1));
  const b = bandStats(frames, index, 0, W, H - Math.round(H * 0.1), H);
  const flat = (a, c) => a.sd < 6 && c.sd < 6 && Math.abs(a.mean - c.mean) < 6;
  if (flat(l, r)) return "pillarbox";
  if (flat(t, b)) return "letterbox";
  return "full";
}

function runsOf(kinds, times, duration) {
  const runs = [];
  kinds.forEach((kind, i) => {
    const last = runs.at(-1);
    if (last && last.kind === kind) { last.samples += 1; return; }
    runs.push({ kind, start: times[i], samples: 1 });
  });
  runs.forEach((run, i) => { run.end = i + 1 < runs.length ? runs[i + 1].start : duration; });
  if (runs.length > 0) runs[0].start = 0;
  return runs;
}

// The columns and rows with picture in them: the content box of a boxed frame.
function contentExtent(frame, dims) {
  const { buffer, width: W, height: H } = frame;
  const colVar = (x) => { let s = 0; let q = 0; let n = 0; for (let y = 0; y < H; y += 4) { const v = buffer[y * W + x]; s += v; q += v * v; n += 1; } const m = s / n; return Math.sqrt(Math.max(q / n - m * m, 0)); };
  const rowVar = (y) => { let s = 0; let q = 0; let n = 0; for (let x = 0; x < W; x += 4) { const v = buffer[y * W + x]; s += v; q += v * v; n += 1; } const m = s / n; return Math.sqrt(Math.max(q / n - m * m, 0)); };
  let x0 = 0; while (x0 < W - 1 && colVar(x0) < 3) x0 += 1;
  let x1 = W - 1; while (x1 > x0 && colVar(x1) < 3) x1 -= 1;
  let y0 = 0; while (y0 < H - 1 && rowVar(y0) < 3) y0 += 1;
  let y1 = H - 1; while (y1 > y0 && rowVar(y1) < 3) y1 -= 1;
  const rect = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  return rect.w > dims.width * 0.2 && rect.h > dims.height * 0.2 ? rect : null;
}

// Persistent straight edges across several frames give away a picture-in-
// picture border: the strongest vertical and horizontal edge lines, each
// side of centre, become the candidate corners.
function persistentEdges(frames, dims) {
  const { width: W, height: H } = dims;
  const vertical = new Float64Array(W);
  const horizontal = new Float64Array(H);
  for (const frame of frames) {
    const b = frame.buffer;
    for (let x = 1; x < W - 1; x += 1) {
      let s = 0;
      for (let y = 0; y < H; y += 3) s += Math.abs(b[y * W + x + 1] - b[y * W + x]);
      vertical[x] += s;
    }
    for (let y = 1; y < H - 1; y += 1) {
      let s = 0;
      for (let x = 0; x < W; x += 3) s += Math.abs(b[(y + 1) * W + x] - b[y * W + x]);
      horizontal[y] += s;
    }
  }
  const peak = (arr, lo, hi) => { let best = lo; for (let i = lo; i < hi; i += 1) if (arr[i] > arr[best]) best = i; return { at: best, strength: arr[best] }; };
  const edgeMargin = 0.08;
  return {
    vLeft: peak(vertical, Math.round(W * edgeMargin), Math.round(W * 0.5)),
    vRight: peak(vertical, Math.round(W * 0.5), Math.round(W * (1 - edgeMargin))),
    hTop: peak(horizontal, Math.round(H * edgeMargin), Math.round(H * 0.5)),
    hBottom: peak(horizontal, Math.round(H * 0.5), Math.round(H * (1 - edgeMargin))),
  };
}

function pipProposal(edges, dims) {
  const { width: W, height: H } = dims;
  const corners = [
    { name: "br", x: edges.vRight.at + 1, y: edges.hBottom.at + 1, w: W - edges.vRight.at - 1, h: H - edges.hBottom.at - 1, strength: edges.vRight.strength + edges.hBottom.strength },
    { name: "bl", x: 0, y: edges.hBottom.at + 1, w: edges.vLeft.at + 1, h: H - edges.hBottom.at - 1, strength: edges.vLeft.strength + edges.hBottom.strength },
    { name: "tr", x: edges.vRight.at + 1, y: 0, w: W - edges.vRight.at - 1, h: edges.hTop.at + 1, strength: edges.vRight.strength + edges.hTop.strength },
    { name: "tl", x: 0, y: 0, w: edges.vLeft.at + 1, h: edges.hTop.at + 1, strength: edges.vLeft.strength + edges.hTop.strength },
  ];
  const best = corners.reduce((a, b) => (b.strength > a.strength ? b : a));
  const head = { x: best.x, y: best.y, w: best.w, h: best.h };
  // The screen is the larger PIP-free rectangle: beside the inset or above/below it.
  const beside = best.x === 0
    ? { x: best.w, y: 0, w: W - best.w, h: H }
    : { x: 0, y: 0, w: best.x, h: H };
  const stacked = best.y === 0
    ? { x: 0, y: best.h, w: W, h: H - best.h }
    : { x: 0, y: 0, w: W, h: best.y };
  const screen = beside.w * beside.h >= stacked.w * stacked.h ? beside : stacked;
  return { corner: best.name, head, screen, aspect: Number((head.w / head.h).toFixed(3)) };
}

function saveFrame(videoPath, t, outPath, width = 960) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  spawnSync(FFMPEG, ["-v", "error", "-y", "-ss", String(t), "-i", videoPath, "-frames:v", "1", "-vf", `scale=${width}:-2`, outPath]);
  return outPath;
}

// Scans the recording for scene structure and proposes a framing: keyframes
// only for the whole-file pass (seconds, not minutes), then a fine pass at
// each switch, then full-resolution measurements per run. Returns proposals
// plus reference frames for a person or an agent to check — the tool
// proposes, the reviewer decides.
export function scanFraming(videoPath, framesDir) {
  const dims = probeDimensions(videoPath);
  const duration = probeDuration(videoPath);
  const coarse = grayFrames([
    "-skip_frame", "nokey", "-i", videoPath, "-fps_mode", "passthrough",
    "-vf", `scale=${SCAN_W}:${SCAN_H},showinfo`,
  ], SCAN_W, SCAN_H);
  const kinds = [];
  for (let i = 0; i < coarse.count; i += 1) kinds.push(classify(coarse, i));
  const runs = runsOf(kinds, coarse.times, duration);
  const interval = coarse.count > 1 ? (coarse.times.at(-1) - coarse.times[0]) / (coarse.count - 1) : 2;

  // Fine pass: the switch lies within one keyframe interval of the coarse edge.
  for (let i = 1; i < runs.length; i += 1) {
    const guess = runs[i].start;
    const from = Math.max(guess - interval - 0.5, 0);
    const fine = grayFrames([
      "-ss", String(from), "-t", String(interval + 1), "-i", videoPath,
      "-vf", `fps=10,scale=${SCAN_W}:${SCAN_H},showinfo`,
    ], SCAN_W, SCAN_H);
    let previous = null;
    for (let f = 0; f < fine.count; f += 1) {
      const kind = classify(fine, f);
      if (previous && kind !== previous && kind === runs[i].kind) {
        const at = Number((from + f / 10).toFixed(2));
        runs[i - 1].end = at;
        runs[i].start = at;
        break;
      }
      previous = kind;
    }
  }

  const proposals = runs.map((run, index) => {
    const span = run.end - run.start;
    const samples = [0.2, 0.5, 0.8].map((k) => run.start + span * k);
    const fulls = samples.map((t) => {
      const frame = grayFrames(["-ss", String(t), "-i", videoPath, "-frames:v", "1"], dims.width, dims.height);
      return { buffer: frame.buffer, width: dims.width, height: dims.height };
    });
    const frames = samples.map((t, k) => saveFrame(videoPath, t, path.join(framesDir, `run-${index}-${k}.jpg`)));
    let proposal;
    if (run.kind === "full") {
      proposal = pipProposal(persistentEdges(fulls, dims), dims);
    } else {
      const extents = fulls.map((frame) => contentExtent(frame, dims)).filter(Boolean);
      const head = extents[0] ?? { x: 0, y: 0, w: dims.width, h: dims.height };
      proposal = { head, screen: null, aspect: Number((head.w / head.h).toFixed(3)) };
    }
    return { index, kind: run.kind, start: run.start, end: Number(run.end.toFixed(2)), samples: run.samples, proposal, frames };
  });
  return { dims, duration, keyframeInterval: Number(interval.toFixed(2)), runs: proposals };
}

// ---- The clean render ----

// What the clean cut would be made of right now: the keeps, the framing
// (the whole frame until told better), and the two identities that say
// whether the files on disk already are that. `source` is source.json's
// record of the footage.
export function cleanPlan({ review, framing, dims, source, fps = CLEAN_FPS, ceiling = CLEAN_CEILING }) {
  const keeps = keepSegments(review.cuts, review.duration);
  const effective = framing ?? fullFrameFraming(dims, review.duration);
  return {
    keeps,
    framing: effective,
    version: CLEAN_VERSION,
    cutIdentity: sha(cutIdentity({ source, keeps })),
    cleanIdentity: sha(cleanIdentity({ source, keeps, framing: effective, fps, ceiling })),
  };
}

// Whether out/clean.mp4, per the map written beside it, is the cut the
// review and framing describe. No map, no file, or another identity: no.
export function cleanCurrent(map, plan, cleanPath) {
  return Boolean(map?.identity && map.identity === plan.cleanIdentity && fs.existsSync(cleanPath));
}

// Whether clean.json describes the clean cut on disk: by the cut identity
// it was stamped with when both sides carry one, by file time for
// transcripts from before stamping.
export function cleanTranscriptCurrent(transcriptPath, cleanPath, map) {
  if (!fs.existsSync(transcriptPath) || !fs.existsSync(cleanPath)) return false;
  let stamp = null;
  try {
    stamp = JSON.parse(fs.readFileSync(transcriptPath, "utf8")).fabula?.cutIdentity ?? null;
  } catch {
    return false;
  }
  if (stamp && map?.cutIdentity) return stamp === map.cutIdentity;
  return fs.statSync(transcriptPath).mtimeMs >= fs.statSync(cleanPath).mtimeMs;
}

// ffmpeg with its machine-readable progress on stdout: frame count and
// speed reach `onProgress` about once a second; stderr is kept for the
// failure message.
function runFfmpeg(args, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ["-y", "-v", "error", "-nostats", "-progress", "pipe:1", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    let buffer = "";
    const current = {};
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const eq = line.indexOf("=");
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();
        current[key] = value;
        if (key === "progress" && onProgress) onProgress(Number(current.frame ?? 0), current.speed ?? "");
      }
    });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg render failed (${code}): ${err.slice(-800)}`))));
  });
}

const fmtClock = (seconds) => {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds - m * 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};

// One decode, one pass: the graph from core/clean-graph.mjs crops the head
// rect (one branch per distinct rect, switched where the framing changes),
// scales to one output size, and keeps exactly the frames of the keep
// segments; the audio is cut at the same frame instants, so the two tracks
// are the same length to the sample. A second, silent track carries the
// screen region wherever the framing has one, on exactly the same timeline,
// so the stage can show the screen beside the head without ever seeking two
// different edits. Punch-ins are not here: the compose stage places them,
// so the cut is rendered once per cut list and framing.
//
// Outputs land as .partial files and are renamed together at the end, with
// out/clean-map.json written last, so a clean.mp4 beside a map is always a
// finished one and the map's identity can be trusted.
export async function renderClean(videoPath, cuts, duration, outPath, options = {}) {
  const keeps = keepSegments(cuts, duration);
  if (keeps.length === 0) throw new Error("every moment is cut; nothing to render");
  const dims = probeDimensions(videoPath);
  const fps = options.fps ?? CLEAN_FPS;
  const ceiling = options.ceiling ?? CLEAN_CEILING;
  const source = options.source ?? { path: path.resolve(videoPath), bytes: fs.statSync(videoPath).size };
  const plan = cleanPlan({ review: { cuts, duration }, framing: options.framing ?? null, dims, source, fps, ceiling });
  const { framing } = plan;
  const headSize = headOutputSize(framing, ceiling);
  const screenSize = screenOutputSize(framing, ceiling);
  const onProgress = options.onProgress ?? (() => {});

  // Keep index per piece: the compose stage alternates its punch-ins by
  // keep, and a keep split at a framing boundary must stay one shot.
  const pieces = [];
  keeps.forEach((keep, keepIndex) => {
    for (const piece of splitKeepsByFraming([keep], framing)) pieces.push({ ...piece, keepIndex });
  });
  const spans = frameSpans(pieces, fps);
  if (spans.length === 0) throw new Error("every kept moment is shorter than a frame; nothing to render");
  const totalFrames = spans.reduce((n, span) => n + span.frames, 0);
  const { graph, heads, screens } = cleanGraph({ spans, fps, headSize, screenSize, rawDuration: duration });

  const outDir = path.dirname(outPath);
  fs.mkdirSync(outDir, { recursive: true });
  const screenPath = path.join(outDir, "screen.mp4");
  const mapPath = path.join(outDir, "clean-map.json");
  const partial = (file) => file.replace(/\.mp4$/, ".partial.mp4");
  // Hundreds of pieces make a graph far past any argument limit; it travels
  // as a file, which also leaves a readable record of the render beside it.
  const graphPath = path.join(outDir, "clean-graph.txt");
  fs.writeFileSync(graphPath, graph);
  const args = [
    "-i", videoPath,
    "-/filter_complex", graphPath,
    "-map", "[v]", "-map", "[a]",
    ...videoEncoderArgs("head", CLEAN_GOP),
    "-c:a", "aac", "-b:a", "192k",
    partial(outPath),
  ];
  if (screenSize) args.push("-map", "[s]", ...videoEncoderArgs("screen", CLEAN_GOP), "-an", partial(screenPath));

  const started = Date.now();
  let lastReport = 0;
  try {
    await runFfmpeg(args, (frame, speed) => {
      const now = Date.now();
      if (now - lastReport < 1500 && frame < totalFrames) return;
      lastReport = now;
      const rate = frame / Math.max((now - started) / 1000, 0.001);
      const left = rate > 0 ? fmtClock((totalFrames - frame) / rate) : "…";
      const pct = Math.min(Math.round((frame / Math.max(totalFrames, 1)) * 100), 100);
      onProgress(`${pct}% · ${frame.toLocaleString()} of ${totalFrames.toLocaleString()} frames · ${speed || "…"} · about ${left} left`);
    });
  } catch (error) {
    fs.rmSync(partial(outPath), { force: true });
    fs.rmSync(partial(screenPath), { force: true });
    throw error;
  }
  fs.renameSync(partial(outPath), outPath);
  if (screenSize) fs.renameSync(partial(screenPath), screenPath);
  else fs.rmSync(screenPath, { force: true });

  const map = {
    version: plan.version,
    identity: plan.cleanIdentity,
    cutIdentity: plan.cutIdentity,
    renderedAt: new Date().toISOString(),
    encoder: encoderCapabilities().nvenc ? "h264_nvenc" : "libx264",
    source: source.path,
    sourceDims: dims,
    fps,
    head: headSize,
    screen: screenSize,
    frames: totalFrames,
    branches: { heads, screens },
    pieces: spans.map((p) => ({
      keepIndex: p.keepIndex,
      start: Number(p.audioStart.toFixed(4)), end: Number(p.audioEnd.toFixed(4)),
      firstFrame: p.firstFrame, lastFrame: p.lastFrame,
      cleanStart: Number(p.cleanStart.toFixed(4)), cleanEnd: Number(p.cleanEnd.toFixed(4)),
      head: p.head, screen: p.screen,
    })),
    screenSpans: screenSpans(spans).map((s) => ({ start: Number(s.start.toFixed(2)), end: Number(s.end.toFixed(2)) })),
  };
  fs.writeFileSync(mapPath, JSON.stringify(map, null, 2));
  return {
    path: outPath,
    screen: screenSize ? screenPath : null,
    keeps: keeps.length,
    pieces: spans.length,
    frames: totalFrames,
    bytes: fs.statSync(outPath).size,
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    map,
  };
}
