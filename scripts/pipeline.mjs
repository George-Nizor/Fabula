// I/O around core/cut-engine.mjs, shared by the CLI driver and the MCP
// server: probing, transcription, cut computation, and the clean render.
// Everything here takes and returns plain data; process exit codes and
// protocol framing belong to the callers.

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

export const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FFMPEG = path.join(REPO_ROOT, "tools", "ffmpeg", "ffmpeg");
const FFPROBE = path.join(REPO_ROOT, "tools", "ffmpeg", "ffprobe");
const WHISPERX = path.join(REPO_ROOT, ".venv-whisperx", "bin", "whisperx");

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
export function computeReview(transcript, videoPath, duration) {
  const words = flattenWords(transcript);
  const cuts = normalizeCuts([
    ...detectFillerCuts(words),
    ...detectGapCuts(words, { mediaDurationSeconds: duration }),
  ]);
  return { video: path.resolve(videoPath), duration, generatedAt: new Date().toISOString(), words, cuts };
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

// One re-encode: trim each keep segment, reset timestamps, concat. Audio is
// cut at the same boundaries — sync survives because video is never re-timed.
// A shot plan (core/shot-engine.mjs) rides along as a per-segment framing:
// scale > 1 becomes a centered crop back to full frame — the punch-in.
export function renderClean(videoPath, cuts, duration, outPath, options = {}) {
  const keeps = keepSegments(cuts, duration);
  if (keeps.length === 0) throw new Error("every moment is cut; nothing to render");
  let shots = options.shots ?? null;
  if (shots && shots.length !== keeps.length) {
    throw new Error(`shot plan has ${shots.length} shots for ${keeps.length} segments; replan after cut changes`);
  }
  const dims = shots ? probeDimensions(videoPath) : null;
  const filters = [];
  const pads = [];
  keeps.forEach((keep, i) => {
    const scale = shots?.[i]?.scale ?? 1;
    const punch = scale > 1
      ? `,crop=iw/${scale}:ih/${scale},scale=${dims.width}:${dims.height}:flags=lanczos`
      : "";
    filters.push(`[0:v]trim=start=${keep.start}:end=${keep.end},setpts=PTS-STARTPTS${punch}[v${i}]`);
    filters.push(`[0:a]atrim=start=${keep.start}:end=${keep.end},asetpts=PTS-STARTPTS[a${i}]`);
    pads.push(`[v${i}][a${i}]`);
  });
  filters.push(`${pads.join("")}concat=n=${keeps.length}:v=1:a=1[v][a]`);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const render = spawnSync(FFMPEG, [
    "-y", "-v", "error",
    "-i", videoPath,
    "-filter_complex", filters.join(";"),
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18",
    "-c:a", "aac", "-b:a", "192k",
    outPath,
  ], { encoding: "utf8" });
  if (render.status !== 0) {
    throw new Error(`ffmpeg render failed (${render.status}): ${(render.stderr || "").slice(-800)}`);
  }
  return { path: outPath, keeps: keeps.length, bytes: fs.statSync(outPath).size };
}
