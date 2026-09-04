// I/O around the core engines, shared by the CLI driver and the MCP server:
// probing, transcription, cut computation, source framing, and the clean
// render. Everything here takes and returns plain data; process exit codes
// and protocol framing belong to the callers.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
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

export const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FFMPEG = path.join(REPO_ROOT, "tools", "ffmpeg", "ffmpeg");
const FFPROBE = path.join(REPO_ROOT, "tools", "ffmpeg", "ffprobe");
const WHISPERX = path.join(REPO_ROOT, ".venv-whisperx", "bin", "whisperx");

// The clean cut is delivered at stage resolution and a review-friendly frame
// rate: a 3440x1440 60fps master would otherwise cost four times the encode
// for pixels the 1080p stage never shows. Keyframes land every 12 frames:
// the export seeks this file once per frame, and a seek decodes from the
// previous keyframe, so an eight-second GOP made every capture decode most
// of a GOP (2.4 fps at 1080p); a 0.4 s GOP roughly doubles that for about
// a third more bytes on an intermediate nobody ships.
export const CLEAN_FPS = 30;
export const CLEAN_CEILING = { width: 1920, height: 1080 };
export const CLEAN_GOP = 12;

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
export function transcribe(videoPath, outPath) {
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
  if (produced !== outPath) fs.renameSync(produced, outPath);
  return JSON.parse(fs.readFileSync(outPath, "utf8"));
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
// so a finished project shows nothing.

export function reportProgress(dir, stage, label, detail = "") {
  const file = path.join(dir, "progress.json");
  let startedAt = new Date().toISOString();
  try {
    const previous = JSON.parse(fs.readFileSync(file, "utf8"));
    const failed = typeof previous.detail === "string" && previous.detail.startsWith("failed:");
    if (previous.stage === stage && previous.startedAt && !failed) startedAt = previous.startedAt;
  } catch { /* fresh */ }
  fs.writeFileSync(file, JSON.stringify({ stage, label, detail, startedAt, updatedAt: new Date().toISOString() }, null, 2));
}

export function clearProgress(dir) {
  fs.rmSync(path.join(dir, "progress.json"), { force: true });
}

// Runs a step with progress bookkeeping around it, clearing on success and
// leaving a failure note behind when it throws.
export async function withProgress(dir, stage, label, step) {
  reportProgress(dir, stage, label);
  try {
    const result = await step((detail) => reportProgress(dir, stage, label, detail));
    clearProgress(dir);
    return result;
  } catch (error) {
    reportProgress(dir, stage, label, `failed: ${String(error.message ?? error).slice(0, 200)}`);
    throw error;
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

// One decode, one pass: each keep segment (split at framing boundaries) is
// trimmed, cropped to its head rect — tighter still where the shot plan
// punches in — and scaled to one output size; the pieces concat with their
// audio cut at the same boundaries, so sync survives because video is never
// re-timed. A second, silent track carries the screen region wherever the
// framing has one, on exactly the same timeline, so the stage can show the
// screen beside the head without ever seeking two different edits.
export function renderClean(videoPath, cuts, duration, outPath, options = {}) {
  const keeps = keepSegments(cuts, duration);
  if (keeps.length === 0) throw new Error("every moment is cut; nothing to render");
  const shots = options.shots ?? null;
  if (shots && shots.length !== keeps.length) {
    throw new Error(`shot plan has ${shots.length} shots for ${keeps.length} segments; replan after cut changes`);
  }
  const dims = probeDimensions(videoPath);
  const framing = options.framing ?? fullFrameFraming(dims, duration);
  const headSize = headOutputSize(framing, CLEAN_CEILING);
  const screenSize = screenOutputSize(framing, CLEAN_CEILING);
  const fps = options.fps ?? CLEAN_FPS;

  // Keep index per piece so the shot plan's alternating scale follows the cut
  // boundaries, not the framing ones.
  const pieces = [];
  keeps.forEach((keep, keepIndex) => {
    for (const piece of splitKeepsByFraming([keep], framing)) pieces.push({ ...piece, keepIndex });
  });
  let cursor = 0;
  for (const piece of pieces) { piece.cleanStart = cursor; cursor += piece.end - piece.start; piece.cleanEnd = cursor; }

  const filters = [];
  const videoPads = [];
  const audioPads = [];
  const screenPads = [];
  const crop = (rect, scale) => {
    const w = rect.w / scale;
    const h = rect.h / scale;
    const x = rect.x + (rect.w - w) / 2;
    const y = rect.y + (rect.h - h) / 2;
    return `crop=${w.toFixed(2)}:${h.toFixed(2)}:${x.toFixed(2)}:${y.toFixed(2)}`;
  };
  pieces.forEach((piece, i) => {
    const scale = shots?.[piece.keepIndex]?.scale ?? 1;
    const span = piece.end - piece.start;
    filters.push(
      `[0:v]trim=start=${piece.start}:end=${piece.end},setpts=PTS-STARTPTS,fps=${fps},` +
      `${crop(piece.head, scale)},scale=${headSize.width}:${headSize.height}:flags=lanczos,setsar=1[v${i}]`,
    );
    filters.push(`[0:a]atrim=start=${piece.start}:end=${piece.end},asetpts=PTS-STARTPTS[a${i}]`);
    videoPads.push(`[v${i}]`);
    audioPads.push(`[a${i}]`);
    if (screenSize) {
      if (piece.screen) {
        filters.push(
          `[0:v]trim=start=${piece.start}:end=${piece.end},setpts=PTS-STARTPTS,fps=${fps},` +
          `${crop(piece.screen, 1)},scale=${screenSize.width}:${screenSize.height}:force_original_aspect_ratio=decrease:flags=bicubic,` +
          `pad=${screenSize.width}:${screenSize.height}:-1:-1:color=0x0b0e12,setsar=1[s${i}]`,
        );
      } else {
        filters.push(`color=c=0x0b0e12:s=${screenSize.width}x${screenSize.height}:r=${fps}:d=${span.toFixed(3)},setsar=1[s${i}]`);
      }
      screenPads.push(`[s${i}]`);
    }
  });
  filters.push(`${videoPads.join("")}concat=n=${pieces.length}:v=1:a=0[v]`);
  filters.push(`${audioPads.join("")}concat=n=${pieces.length}:v=0:a=1[a]`);
  if (screenSize) filters.push(`${screenPads.join("")}concat=n=${pieces.length}:v=1:a=0[s]`);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const screenPath = screenSize ? path.join(path.dirname(outPath), "screen.mp4") : null;
  if (!screenSize) fs.rmSync(path.join(path.dirname(outPath), "screen.mp4"), { force: true });
  // Hundreds of pieces make a graph far past any argument limit; it travels
  // as a file, which also leaves a readable record of the render beside it.
  const graphPath = path.join(path.dirname(outPath), "clean-graph.txt");
  fs.writeFileSync(graphPath, filters.join(";\n") + "\n");
  const args = [
    "-y", "-v", "error",
    "-i", videoPath,
    "-/filter_complex", graphPath,
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-g", String(CLEAN_GOP), "-keyint_min", String(CLEAN_GOP),
    "-c:a", "aac", "-b:a", "192k",
    outPath,
  ];
  if (screenSize) {
    args.push(
      "-map", "[s]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-g", String(CLEAN_GOP), "-keyint_min", String(CLEAN_GOP), "-an", screenPath,
    );
  }
  const started = Date.now();
  const render = spawnSync(FFMPEG, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (render.status !== 0) {
    throw new Error(`ffmpeg render failed (${render.status}): ${(render.stderr || "").slice(-800)}`);
  }
  const map = {
    source: path.resolve(videoPath),
    sourceDims: dims,
    fps,
    head: headSize,
    screen: screenSize,
    pieces: pieces.map((p) => ({
      start: Number(p.start.toFixed(3)), end: Number(p.end.toFixed(3)),
      cleanStart: Number(p.cleanStart.toFixed(3)), cleanEnd: Number(p.cleanEnd.toFixed(3)),
      head: p.head, screen: p.screen, scale: shots?.[p.keepIndex]?.scale ?? 1,
    })),
    screenSpans: screenSpans(pieces).map((s) => ({ start: Number(s.start.toFixed(2)), end: Number(s.end.toFixed(2)) })),
  };
  return {
    path: outPath,
    screen: screenPath,
    keeps: keeps.length,
    pieces: pieces.length,
    bytes: fs.statSync(outPath).size,
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    map,
  };
}
