// The thumbnail kit, made: decoding the recording where the film shows it, the face analyser,
// and the folder written beside the film. core/thumbnail-kit.mjs holds every decision and its
// tests; this is the I/O around it, run as a background job (scripts/job.mjs thumbnail_kit) by
// the Export step's Make kit and by the assistant's thumbnail_kit tool.
//
// The work, in the order it runs:
//
//   1. a coarse look: one ffmpeg over the recording's span decodes only the keyframes (two
//      seconds apart in an OBS recording), keeps the ones inside the film's kept pieces, and
//      crops the head region (and the screen region, where the framing has one) out of each at a
//      size the face analyser reads well;
//   2. a fine look: around the two dozen most promising moments, eight frames a second for
//      ±0.6 s, by exact seek, never past the edge of the piece that holds the moment;
//   3. the picks (core/thumbnail-kit.mjs), then each extracted again from the recording at its
//      own resolution and written as a quality-95 JPEG;
//   4. the pictures the scenes show, the hooks, the chapters and the look, and kit.json, all in
//      a sibling folder that then replaces out/thumbnail-kit/ by rename.
//
// The face analyser is optional. Without it (no .venv-face, or MediaPipe will not load), the kit
// is still made, its frames chosen by sharpness, light and time, with no face signals claimed,
// and the report says why and how to set it up.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { REPO_ROOT, FFMPEG, probeDuration } from "./pipeline.mjs";
import { projectPaths, readCleanMap, readProjectMeta, readComposeConfig, stagedVideo, isMotionFilm } from "./project-state.mjs";
import { flattenWords } from "../core/cut-engine.mjs";
import { resolveScenes } from "../core/compose-engine.mjs";
import { resolveTheme } from "../core/themes.mjs";
import { resolveFormat } from "../core/formats.mjs";
import { chapterList, openingTitle } from "../core/chapters.mjs";
import { motionLibsOf } from "../core/motion.mjs";
import {
  KIT_KIND, KIT_SCHEMA_VERSION, KIT_DIR, KIT_LIMITS, FACE_REFUSE,
  cleanTimeOf, keptRegions, fineWindow,
  lumaOf, laplacianVariance, sharpnessOf, exposureOf, dhash, histogramOf, detailOf, centreRegion,
  faceSignals, faceExtras, faceTags, handFeatures, scoreFace, scorePlain, selectFaces, fineCentres, selectScreens, scoreScreen,
  picturesShown, pictureCredit, imageSize, wordsAround, speakingAt, kitHooks, kitStyle, validateKit, safeLeaf,
} from "../core/thumbnail-kit.mjs";

const VERSION = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version;
export const REPORT_FILE = "thumbnail-kit.report.json";
// The size the head region is read at: tall enough for the landmarks, small enough to be quick.
const ANALYSIS_HEIGHT = 540;
const SCREEN_WIDTH = 192;
const FINE_HALF = 0.6;
const FINE_STEP = 0.12;
const CONCURRENCY = 4;

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const even = (n) => Math.max(2, n - (n % 2));
const round = (v, places = 2) => Number(v.toFixed(places));

// ---- The face analyser ----

// `root` is where this process reads the checkout or version from; `posixRoot` is the same folder
// as WSL sees it, for the command the hint names (the window on Windows reads through \\wsl.localhost).
export function faceAnalyser(root = REPO_ROOT, { posixRoot = root } = {}) {
  const venv = path.join(root, ".venv-face");
  const python = path.join(venv, "bin", "python");
  const model = path.join(venv, "models", "face_landmarker.task");
  const hands = path.join(venv, "models", "hand_landmarker.task");
  const ready = fs.existsSync(path.join(venv, ".face-ready")) && fs.existsSync(python) && fs.existsSync(model);
  // An installed engine (setup-engine.sh) keeps the analyser in its home, shared by every version.
  let home = null;
  try { home = fs.readFileSync(path.join(root, ".engine-home"), "utf8").trim() || null; } catch { home = null; }
  const hint = home
    ? `The engine's setup installs the face analyser; to install it now, run in WSL: bash '${path.posix.join(posixRoot, "scripts", "setup-face.sh")}' '${path.posix.join(home, "venv-face")}', then make the kit again.`
    : "Run npm run setup:tools in the Fabula checkout (it installs the face analyser into .venv-face, about 470 MB), then make the kit again.";
  return { ready, python, model, hands: fs.existsSync(hands) ? hands : null, libPath: path.join(venv, "syslibs", "usr", "lib", "x86_64-linux-gnu"), hint };
}

// One Python process for the whole job: frames go in on stdin, one JSON line comes back for each,
// in order (scripts/face-analyse.py has the protocol).
class FaceSession {
  static async open(analyser) {
    if (!analyser.ready) return { session: null, reason: "the face analyser is not set up" };
    const env = { ...process.env, LD_LIBRARY_PATH: [analyser.libPath, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"), PYTHONUNBUFFERED: "1" };
    const args = [path.join(REPO_ROOT, "scripts", "face-analyse.py"), "--model", analyser.model, ...(analyser.hands ? ["--hands", analyser.hands] : [])];
    const child = spawn(analyser.python, args, { stdio: ["pipe", "pipe", "pipe"], env });
    const session = new FaceSession(child);
    const first = await session.next();
    if (!first?.ready) {
      child.kill();
      const said = first?.error || session.stderr.trim().split("\n").filter((line) => !/^(W|I)\d{4}|^WARNING|^INFO/.test(line)).at(-1) || "it stopped without answering";
      return { session: null, reason: `the face analyser would not start: ${said}` };
    }
    session.version = first.mediapipe;
    session.hands = Boolean(first.hands);
    return { session };
  }

  constructor(child) {
    this.child = child;
    this.stderr = "";
    this.lines = [];
    this.waiting = [];
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        const resolve = message.id !== undefined ? this.pending.get(message.id) : null;
        if (resolve) { this.pending.delete(message.id); resolve(message); continue; }
        const waiter = this.waiting.shift();
        if (waiter) waiter(message); else this.lines.push(message);
      }
    });
    child.stderr.on("data", (chunk) => { this.stderr = (this.stderr + chunk).slice(-4000); });
    child.on("close", () => {
      this.closed = true;
      for (const resolve of this.pending.values()) resolve({ face: null, error: "the face analyser stopped" });
      this.pending.clear();
      for (const waiter of this.waiting) waiter(null);
      this.waiting = [];
    });
    child.stdin.on("error", () => { /* a closed analyser answers every pending frame with no face */ });
  }

  next() {
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  // Sends a frame; resolves `sent` once the pipe has room, `result` once it is analysed.
  send(rgb, width, height, options = {}) {
    if (this.closed) return { sent: Promise.resolve(), result: Promise.resolve({ face: null, error: "the face analyser stopped" }) };
    const id = this.nextId++;
    const result = new Promise((resolve) => this.pending.set(id, resolve));
    const header = JSON.stringify({ id, w: width, h: height, ...options }) + "\n";
    this.child.stdin.write(header);
    const room = this.child.stdin.write(rgb);
    const sent = room ? Promise.resolve() : new Promise((resolve) => this.child.stdin.once("drain", resolve));
    return { sent, result };
  }

  async close() {
    if (this.closed) return;
    const done = new Promise((resolve) => this.child.once("close", resolve));
    this.child.stdin.end();
    await done;
  }
}

// ---- Decoding ----

const selectBetween = (intervals, offset) => intervals.map((i) => `between(t,${(i.start - offset).toFixed(3)},${(i.end - offset).toFixed(3)})`).join("+");

// One ffmpeg over [seek, seek + duration] of the recording, cropping each region out of the
// frames it keeps and handing them over as they arrive: onFrame(region, index, buffer) for each,
// with the frame's time in the recording known by the end (returned as times[region][index]). A
// region keeps the frames inside its intervals and, with `every`, one every that many seconds.
function decodeRegions(video, { seek, duration, keyframes = false, regions }, onFrame) {
  return new Promise((resolve, reject) => {
    const parts = [`[0:v]split=${regions.length}${regions.map((_, i) => `[i${i}]`).join("")}`];
    regions.forEach((region, i) => {
      const r = region.rect;
      const chain = [];
      if (region.intervals) chain.push(`select='${selectBetween(region.intervals, seek)}'`);
      if (region.every) chain.push(`select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,${region.every})'`);
      chain.push(`showinfo@r${i}`);
      chain.push(`crop=${even(r.w)}:${even(r.h)}:${Math.round(r.x)}:${Math.round(r.y)}:exact=1`);
      if (region.width !== even(r.w) || region.height !== even(r.h)) chain.push(`scale=${region.width}:${region.height}:flags=area`);
      chain.push(`format=${region.pix}`);
      parts.push(`[i${i}]${chain.join(",")}[o${i}]`);
    });
    const graphFile = path.join(regions[0].work, `graph-${process.pid}-${Math.random().toString(36).slice(2, 8)}.txt`);
    fs.writeFileSync(graphFile, parts.join(";\n"));
    const args = ["-hide_banner", "-nostats", "-v", "info", ...(keyframes ? ["-skip_frame", "nokey"] : []),
      "-ss", seek.toFixed(3), "-t", duration.toFixed(3), "-i", video, "-/filter_complex", graphFile];
    regions.forEach((region, i) => args.push("-map", `[o${i}]`, "-fps_mode", "passthrough", "-f", "rawvideo", `pipe:${3 + i}`));
    const child = spawn(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe", ...regions.map(() => "pipe")] });
    const times = regions.map(() => []);
    let err = "";
    let logBuffer = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      logBuffer += chunk;
      let at;
      while ((at = logBuffer.indexOf("\n")) >= 0) {
        const line = logBuffer.slice(0, at);
        logBuffer = logBuffer.slice(at + 1);
        const m = /^\[showinfo@r(\d+) @ [^\]]+\] n:\s*(\d+) .*?pts_time:(-?[\d.]+)/.exec(line);
        if (m) times[Number(m[1])][Number(m[2])] = seek + Number(m[3]);
        else err = (err + line + "\n").slice(-2000);
      }
    });
    const pending = [];
    const streams = regions.map((region, i) => new Promise((done) => {
      const size = region.width * region.height * (region.pix === "rgb24" ? 3 : 1);
      const stream = child.stdio[3 + i];
      let held = [];
      let heldBytes = 0;
      let index = 0;
      stream.on("data", (chunk) => {
        held.push(chunk);
        heldBytes += chunk.length;
        if (heldBytes < size) return;
        const all = Buffer.concat(held);
        const frames = [];
        let offset = 0;
        while (all.length - offset >= size) { frames.push(all.subarray(offset, offset + size)); offset += size; }
        held = offset < all.length ? [all.subarray(offset)] : [];
        heldBytes = all.length - offset;
        stream.pause();
        (async () => {
          for (const frame of frames) {
            const waited = onFrame(i, index++, frame);
            if (waited) pending.push(waited);
            if (waited?.sent) await waited.sent;
          }
        })().then(() => stream.resume(), (error) => { child.kill(); reject(error); });
      });
      stream.on("end", done);
      stream.on("error", done);
    }));
    child.once("error", reject);
    child.once("close", async (code) => {
      await Promise.all(streams);
      fs.rmSync(graphFile, { force: true });
      if (code !== 0) return reject(new Error(`ffmpeg could not decode the recording (${code}): ${err.trim().split("\n").slice(-3).join(" ")}`));
      await Promise.all(pending.map((p) => p.done ?? p));
      resolve({ times });
    });
  });
}

// One frame of the recording at `at`, a region of it at its own resolution, as packed RGB.
function grabFrame(video, at, rect) {
  return new Promise((resolve, reject) => {
    const w = even(rect.w); const h = even(rect.h);
    const child = spawn(FFMPEG, ["-hide_banner", "-v", "error", "-ss", Math.max(at - 0.002, 0).toFixed(3), "-i", video, "-frames:v", "1",
      "-vf", `crop=${w}:${h}:${Math.round(rect.x)}:${Math.round(rect.y)}:exact=1,format=rgb24`, "-f", "rawvideo", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let err = "";
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      const data = Buffer.concat(chunks);
      if (code !== 0 || data.length < w * h * 3) return reject(new Error(`could not take the frame at ${at.toFixed(2)}s: ${err.trim().split("\n").at(-1) ?? code}`));
      resolve({ data: data.subarray(0, w * h * 3), width: w, height: h });
    });
  });
}

// Without the analyser, ffmpeg writes the JPEG itself, at its nearest to quality 95.
function writeJpegWithFfmpeg(video, at, rect, file) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ["-hide_banner", "-v", "error", "-y", "-ss", Math.max(at - 0.002, 0).toFixed(3), "-i", video, "-frames:v", "1",
      "-vf", `crop=${even(rect.w)}:${even(rect.h)}:${Math.round(rect.x)}:${Math.round(rect.y)}:exact=1`, "-q:v", "2", "-huffman", "optimal", file], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.once("error", reject);
    child.once("close", (code) => (code === 0 && fs.existsSync(file) ? resolve() : reject(new Error(`could not write ${path.basename(file)}: ${err.trim().split("\n").at(-1) ?? code}`))));
  });
}

async function inParallel(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await work(items[i], i);
    }
  }));
  return results;
}

const analysisSize = (rect) => {
  const height = even(Math.min(ANALYSIS_HEIGHT, even(rect.h)));
  return { width: even(Math.round((even(rect.w) * height) / even(rect.h))), height };
};

// ---- Reading the frames ----

// Each head frame: measured here (sharpness and light where the face is, or the middle of the
// frame without the analyser) and, with the analyser, read for the face.
function headReader(session, out) {
  return (meta) => (region, index, rgb) => {
    const { width, height } = meta.regions[region];
    const record = { region: meta.regions[region], index, pass: meta.pass };
    out.push(record);
    const measure = (face) => {
      const gray = lumaOf(rgb, width, height);
      const rect = face ?? centreRegion(width, height);
      record.sharpness = sharpnessOf(laplacianVariance(gray, width, height, rect));
      record.exposure = exposureOf(gray, width, height, rect).exposure;
    };
    if (!session) { measure(null); return null; }
    const { sent, result } = session.send(rgb, width, height);
    const done = result.then((analysis) => { record.analysis = analysis; measure(analysis.face); });
    return { sent, done };
  };
}

function screenReader(out) {
  return (meta) => (region, index, gray) => {
    const { width, height } = meta.regions[region];
    out.push({ region: meta.regions[region], index, hash: dhash(gray, width, height), histogram: histogramOf(gray), detail: detailOf(gray, width, height) });
    return null;
  };
}

// ---- The kit ----

function filmDuration(dir, map, words) {
  const clean = projectPaths(dir).clean;
  try { if (fs.existsSync(clean)) return probeDuration(clean); } catch { /* the map knows */ }
  const last = map?.pieces?.at(-1)?.cleanEnd;
  return Number.isFinite(last) && last > 0 ? last : words.at(-1)?.end ?? 0;
}

function scenesOf(dir, words, duration) {
  try { return resolveScenes(readComposeConfig(dir).scenes ?? [], words, { durationSeconds: duration }); } catch { return []; }
}

// The text a scene loads pictures from: a custom card's markup, or a motion scene's document
// with the project libraries it names.
function sceneText(dir) {
  const cache = new Map();
  const read = (rel) => {
    if (!cache.has(rel)) { try { cache.set(rel, fs.readFileSync(path.join(dir, rel), "utf8")); } catch { cache.set(rel, ""); } }
    return cache.get(rel);
  };
  return (scene) => {
    const g = scene.graphic ?? {};
    if (g.kind === "custom") return `${g.html ?? ""}\n${g.css ?? ""}`;
    if (g.kind !== "motion" || typeof g.src !== "string") return "";
    const doc = read(g.src);
    const libs = [...new Set([...(g.libs ?? []), ...motionLibsOf(doc)])].filter((lib) => lib.startsWith("project:")).map((lib) => lib.slice(8));
    return [doc, ...libs.flatMap((lib) => [read(`motion/lib/${lib}.js`), read(`motion/lib/${lib}.css`)])].join("\n");
  };
}

function projectPictures(dir, scenes) {
  const assetsDir = path.join(dir, "assets");
  let names = [];
  try { names = fs.readdirSync(assetsDir).filter((name) => /\.(png|jpe?g|webp)$/i.test(name)); } catch { return []; }
  const assets = [];
  for (const name of names) {
    let size = null;
    try { size = imageSize(fs.readFileSync(path.join(assetsDir, name))); } catch { size = null; }
    if (size) assets.push({ name, ...size }); // unreadable: not offered
  }
  return picturesShown(scenes, assets, sceneText(dir));
}

export async function makeThumbnailKit(dir, { onProgress: progress = () => {}, log = () => {}, analyser = faceAnalyser() } = {}) {
  const started = Date.now();
  // The window polls the progress file; twice a second is plenty, whatever the frames do.
  let reported = 0;
  const onProgress = (detail, extra) => {
    if (Date.now() - reported < 500) return;
    reported = Date.now();
    progress(detail, extra);
  };
  const timings = {};
  const lap = (name, since) => { timings[name] = round((Date.now() - since) / 1000, 1); };
  const paths = projectPaths(dir);
  const map = readCleanMap(dir);
  if (!map?.pieces?.length) throw new Error("no clean cut yet: the kit is made from the film as cut, so render the clean cut first");
  if (!fs.existsSync(paths.cleanTranscript)) throw new Error("no clean transcript yet: refresh the clean cut first");
  const transcript = readJson(paths.cleanTranscript);
  const stamp = transcript.fabula?.cutIdentity;
  if (stamp && map.cutIdentity && stamp !== map.cutIdentity) throw new Error("the clean transcript does not describe the clean cut on disk; refresh the clean cut first");
  const words = flattenWords(transcript);
  const meta = readProjectMeta(dir);
  const format = resolveFormat(meta).id;
  const title = typeof meta.title === "string" && meta.title.trim() ? meta.title.trim() : path.basename(dir);
  const duration = filmDuration(dir, map, words);
  const motion = isMotionFilm(dir);
  const video = motion ? null : stagedVideo(dir);
  if (!motion && (!video || !fs.existsSync(video))) throw new Error(`the recording is not where source.json says (${video ?? "nothing named"}); the kit takes its frames from it`);

  const outDir = path.join(dir, "out");
  const work = path.join(outDir, `.${KIT_DIR}-${process.pid}`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(path.join(work, "frames"), { recursive: true });
  fs.mkdirSync(path.join(work, "pictures"), { recursive: true });
  const report = { createdAt: null, faceAnalysis: { used: false, reason: null, hint: null }, timings, candidates: {}, refused: {} };
  let session = null;
  try {
    // ---- 1. The coarse look ----
    const pieces = map.pieces;
    const faceCandidates = [];
    const screenCandidates = [];
    const framed = !motion && pieces.some((piece) => piece.head);
    if (!motion && !framed) {
      report.faceAnalysis = { used: false, reason: "the clean map names no head region to take frames from; render the clean cut again" };
      log(report.faceAnalysis.reason);
    }
    if (framed) {
      const opened = await FaceSession.open(analyser);
      session = opened.session;
      report.faceAnalysis = session
        ? { used: true, engine: `MediaPipe Face Landmarker${session.hands ? " and Hand Landmarker" : ""} (mediapipe ${session.version})` }
        : { used: false, reason: opened.reason, hint: analyser.hint };
      log(session ? `face analyser: mediapipe ${session.version}` : `face ranking unavailable: ${opened.reason}`);
      const heads = keptRegions(pieces, "head").map((g) => ({ ...g, ...analysisSize(g.rect), pix: "rgb24", work }));
      const screens = keptRegions(pieces, "screen").map((g) => ({ ...g, width: SCREEN_WIDTH, height: even(Math.round((SCREEN_WIDTH * g.rect.h) / g.rect.w)), pix: "gray", work }));
      const regions = [...heads, ...screens];
      const all = regions.flatMap((r) => r.intervals);
      const from = Math.max(0, Math.min(...all.map((i) => i.start)) - 0.05);
      const to = Math.max(...all.map((i) => i.end)) + 0.05;
      const coarse = Date.now();
      onProgress("Looking through the film's keyframes", { fraction: 0.02 });
      const headRecords = [];
      const screenRecords = [];
      const readHead = headReader(session, headRecords);
      const pass = { pass: "coarse", regions };
      const head = readHead(pass);
      const screen = screenReader(screenRecords)(pass);
      const { times } = await decodeRegions(video, { seek: from, duration: to - from, keyframes: true, regions }, (region, index, buffer) => {
        if (region >= heads.length) return screen(region, index, buffer);
        if (index % 20 === 0) onProgress(`Looking through the film's keyframes (${headRecords.length} so far)`, { fraction: 0.02 + 0.3 * Math.min(headRecords.length / Math.max((to - from) / 2, 1), 1) });
        return head(region, index, buffer);
      });
      for (const record of [...headRecords, ...screenRecords]) record.raw = times[regions.indexOf(record.region)][record.index];
      lap("coarse", coarse);
      log(`coarse: ${headRecords.length} head and ${screenRecords.length} screen keyframes in ${timings.coarse}s`);

      // A recording with long gaps between keyframes gets a sample every three seconds as well.
      const keptSeconds = heads.reduce((sum, r) => sum + r.intervals.reduce((s, i) => s + i.end - i.start, 0), 0);
      if (headRecords.length < keptSeconds / 6) {
        const extra = Date.now();
        const moments = heads.flatMap((r) => r.intervals.flatMap((i) => { const out = []; for (let t = i.start + 1; t < i.end; t += 3) out.push({ region: r, t }); return out; }));
        await inParallel(moments, CONCURRENCY, async ({ region, t }) => {
          const one = { ...region, intervals: null };
          const metaPass = { pass: "sample", regions: [one] };
          const { times: got } = await decodeRegions(video, { seek: t, duration: 0.2, regions: [{ ...one, every: 1 }] }, readHead(metaPass));
          for (const record of headRecords) if (record.region === one && record.raw === undefined) record.raw = got[0][record.index];
        });
        lap("samples", extra);
        log(`sparse keyframes: ${moments.length} extra samples in ${timings.samples}s`);
      }

      // ---- 2. The fine look ----
      const toCandidate = (record) => {
        const at = cleanTimeOf(pieces, record.raw);
        if (at === null) return null; // the film does not show it: never a candidate
        const speaking = speakingAt(words, at);
        const signals = faceSignals(record.analysis, record, record.region.height);
        const extras = faceExtras(record.analysis);
        const scale = even(record.region.rect.h) / record.region.height;
        const facePixels = record.analysis?.face ? record.analysis.face.h * scale : null;
        const hands = handFeatures(record.analysis, record.region.width, record.region.height);
        const scored = session ? scoreFace({ signals, extras, facePixels, hands }) : scorePlain({ signals, frameHeight: even(record.region.rect.h) });
        const potential = session && !scored.refused ? scored.score
          : session && scored.refused === "eyes closing" ? scoreFace({ signals: { ...signals, eyesOpen: 1 }, extras, facePixels, hands }).score ?? null
          : null;
        return { record, raw: record.raw, atSeconds: at, rect: record.region.rect, signals, extras, hands, speaking, facePixels, tags: session ? faceTags(signals, extras, { speaking, pointing: hands.pointing }) : [], ...scored, potential };
      };
      const coarseCandidates = headRecords.map(toCandidate).filter(Boolean);
      faceCandidates.push(...coarseCandidates);
      const fine = Date.now();
      const centres = fineCentres(session ? coarseCandidates : coarseCandidates.map((c) => ({ ...c, potential: c.score })), { count: 24, spacing: 3 });
      let done = 0;
      await inParallel(centres, CONCURRENCY, async (centre) => {
        const window = fineWindow(pieces, centre.raw, FINE_HALF);
        if (!window) return;
        const region = heads.find((h) => h.rect === centre.record.region.rect) ?? centre.record.region;
        const one = { ...region, intervals: null, every: FINE_STEP };
        const records = [];
        const { times: got } = await decodeRegions(video, { seek: window.start, duration: window.end - window.start, regions: [one] }, headReader(session, records)({ pass: "fine", regions: [one] }));
        for (const record of records) {
          record.raw = got[0][record.index];
          record.region = region;
          if (Math.abs(record.raw - centre.raw) < 0.02) continue; // the coarse frame itself
          const candidate = toCandidate(record);
          if (candidate) faceCandidates.push(candidate);
        }
        done += 1;
        onProgress(`Looking closer at the best moments (${done} of ${centres.length})`, { fraction: 0.34 + 0.36 * (done / Math.max(centres.length, 1)) });
      });
      lap("fine", fine);
      log(`fine: ${centres.length} windows, ${faceCandidates.length - coarseCandidates.length} more frames in ${timings.fine}s`);

      // Screens: the ones the film puts on the stage first.
      const shownSpans = scenesOf(dir, words, duration).filter((s) => s.graphic?.kind === "screen").map((s) => [s.start, s.end]);
      for (const record of screenRecords) {
        const at = cleanTimeOf(pieces, record.raw);
        if (at === null) continue;
        const shown = shownSpans.some(([a, b]) => a <= at && at <= b);
        screenCandidates.push({ raw: record.raw, atSeconds: at, rect: record.region.rect, hash: record.hash, histogram: record.histogram, detail: record.detail, shown, score: scoreScreen({ detail: record.detail, shown }) });
      }
    } else if (motion) {
      report.faceAnalysis = { used: false, reason: "a motion film has no recording to take faces or screens from" };
    }

    // ---- 3. The picks, at full resolution ----
    // FABULA_KIT_DEBUG=<file> writes every face candidate with its readings and score parts: how
    // the scores were tuned against a real film, and how to tune them again.
    if (process.env.FABULA_KIT_DEBUG) fs.writeFileSync(process.env.FABULA_KIT_DEBUG, JSON.stringify(faceCandidates.map((c) => ({ raw: c.raw, at: c.atSeconds, rect: c.rect.w, pass: c.record.pass, signals: c.signals, extras: c.extras, hands: c.hands, b: c.record.analysis?.blendshapes, refused: c.refused, score: c.score, parts: c.parts, tags: c.tags, facePixels: c.facePixels }))));
    const usable = faceCandidates.filter((c) => !c.refused);
    report.candidates = { faces: faceCandidates.length, usable: usable.length, screens: screenCandidates.length };
    for (const c of faceCandidates) if (c.refused) report.refused[c.refused] = (report.refused[c.refused] ?? 0) + 1;
    const finals = Date.now();
    const frames = [];
    const excluded = new Set();
    const made = new Map();
    let picks = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      picks = selectFaces(usable.filter((c) => !excluded.has(c)));
      const todo = picks.filter((c) => !made.has(c));
      let refusedNow = 0;
      await inParallel(todo, CONCURRENCY, async (c) => {
        const leaf = `face-${Math.round(c.raw * 1000)}-${Math.round(c.rect.x)}.jpg`;
        const file = path.join(work, "frames", leaf);
        if (session) {
          const frame = await grabFrame(video, c.raw, c.rect);
          const { result } = session.send(frame.data, frame.width, frame.height, { encode: file, quality: 95 });
          const analysis = await result;
          // The frame as delivered is read again at its own resolution; one that turns out to
          // be a blink or to have lost the face is not delivered, and the next best takes its place.
          const signals = faceSignals(analysis, c.signals, frame.height);
          if (!analysis.face || !analysis.encoded || (signals.eyesOpen ?? 0) <= 1 - FACE_REFUSE.blink) { excluded.add(c); refusedNow += 1; fs.rmSync(file, { force: true }); return; }
          const extras = faceExtras(analysis);
          const hands = handFeatures(analysis, frame.width, frame.height);
          const scored = scoreFace({ signals, extras, facePixels: analysis.face.h, hands });
          made.set(c, { leaf, width: frame.width, height: frame.height, face: analysis.face, signals, tags: faceTags(signals, extras, { speaking: c.speaking, pointing: hands.pointing }), score: scored.score ?? c.score });
        } else {
          await writeJpegWithFfmpeg(video, c.raw, c.rect, file);
          made.set(c, { leaf, width: even(c.rect.w), height: even(c.rect.h), signals: c.signals, tags: [], score: c.score });
        }
      });
      onProgress("Taking the chosen frames at full size", { fraction: 0.72 + 0.04 * attempt });
      if (refusedNow === 0) break;
    }
    // Files no pick uses any more (a refused frame's replacement moved a pick out) go.
    const kept = picks.filter((c) => made.has(c));
    const ranked = kept.map((c) => ({ c, m: made.get(c) })).sort((a, b) => b.m.score - a.m.score || a.c.atSeconds - b.c.atSeconds);
    ranked.forEach(({ c, m }, i) => {
      const leaf = `f${String(i + 1).padStart(2, "0")}.jpg`;
      fs.renameSync(path.join(work, "frames", m.leaf), path.join(work, "frames", leaf));
      frames.push({
        file: `frames/${leaf}`, kind: "face", atSeconds: round(c.atSeconds), width: m.width, height: m.height,
        ...(m.face ? { face: m.face } : {}),
        score: round(Math.min(Math.max(m.score, 0), 1)),
        signals: m.signals, tags: m.tags, words: wordsAround(words, c.atSeconds),
      });
    });
    for (const name of fs.readdirSync(path.join(work, "frames"))) if (name.startsWith("face-")) fs.rmSync(path.join(work, "frames", name), { force: true });

    const screenPicks = selectScreens(screenCandidates);
    await inParallel(screenPicks, CONCURRENCY, async (s, i) => {
      const leaf = `s${String(i + 1).padStart(2, "0")}.jpg`;
      const file = path.join(work, "frames", leaf);
      if (session) {
        const frame = await grabFrame(video, s.raw, s.rect);
        const { result } = session.send(frame.data, frame.width, frame.height, { encode: file, quality: 95, analyse: false });
        if (!(await result).encoded) throw new Error(`could not write ${leaf}`);
        s.size = { width: frame.width, height: frame.height };
      } else {
        await writeJpegWithFfmpeg(video, s.raw, s.rect, file);
        s.size = { width: even(s.rect.w), height: even(s.rect.h) };
      }
      s.leaf = leaf;
    });
    for (const s of screenPicks) frames.push({ file: `frames/${s.leaf}`, kind: "screen", atSeconds: round(s.atSeconds), width: s.size.width, height: s.size.height, words: wordsAround(words, s.atSeconds) });
    lap("finals", finals);
    log(`finals: ${kept.length} face and ${screenPicks.length} screen frames in ${timings.finals}s`);

    // ---- 4. Pictures, story, style ----
    onProgress("Gathering the pictures and the story", { fraction: 0.92 });
    const scenes = scenesOf(dir, words, duration);
    const pictures = [];
    const taken = new Set();
    for (const picture of projectPictures(dir, scenes)) {
      let leaf = picture.name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[^A-Za-z0-9]+/, "");
      for (let n = 2; taken.has(leaf.toLowerCase()) || !safeLeaf(leaf); n += 1) leaf = `picture-${n}${path.extname(picture.name).toLowerCase()}`;
      taken.add(leaf.toLowerCase());
      fs.copyFileSync(path.join(dir, "assets", picture.name), path.join(work, "pictures", leaf));
      let source = null;
      try { source = readJson(path.join(dir, "assets", `${picture.name}.source.json`)); } catch { source = null; }
      const { credit, license } = pictureCredit(source);
      if (credit || license) {
        // The credit as it travels: who, under what licence, and where from when that is a web
        // page. A path on this machine is nobody else's business.
        const web = (v) => (typeof v === "string" && /^https?:\/\//.test(v) ? v : undefined);
        fs.writeFileSync(path.join(work, "pictures", `${leaf}.source.json`), JSON.stringify({ author: credit ?? undefined, license: license ?? undefined, pageUrl: web(source.pageUrl), source: web(source.source), note: typeof source.note === "string" ? source.note : undefined }, null, 2) + "\n");
      }
      pictures.push({ file: `pictures/${leaf}`, width: picture.width, height: picture.height, credit, license, atSeconds: picture.atSeconds });
    }
    const treatment = (() => { try { return readJson(path.join(dir, "treatment.json")); } catch { return null; } })();
    const theme = resolveTheme(readComposeConfig(dir).theme ?? {});
    const chapters = chapterList({ scenes, words, title: openingTitle(scenes) ?? title, duration: words.at(-1)?.end });
    const story = {};
    for (const key of ["logline", "purpose", "look"]) if (typeof treatment?.[key] === "string" && treatment[key].trim()) story[key] = treatment[key].trim();
    story.hooks = kitHooks(words);
    story.chapters = chapters.chapters.map((c) => ({ title: c.title, atSeconds: round(c.at) }));

    const kit = {
      kind: KIT_KIND,
      schemaVersion: KIT_SCHEMA_VERSION,
      producer: { app: "fabula", version: VERSION },
      createdAt: new Date().toISOString(),
      source: { project: path.basename(dir), title, format, durationSeconds: round(duration, 1) },
      story,
      style: kitStyle(theme),
      frames,
      pictures,
    };
    validateKit(kit, { fileSize: (rel) => { try { return fs.statSync(path.join(work, rel)).size; } catch { return 0; } } });
    fs.writeFileSync(path.join(work, "kit.json"), JSON.stringify(kit, null, 2) + "\n");

    // ---- The swap ----
    const target = path.join(outDir, KIT_DIR);
    const old = path.join(outDir, `.${KIT_DIR}-old-${process.pid}`);
    fs.rmSync(old, { recursive: true, force: true });
    if (fs.existsSync(target)) fs.renameSync(target, old);
    fs.renameSync(work, target);
    fs.rmSync(old, { recursive: true, force: true });
    timings.total = round((Date.now() - started) / 1000, 1);
    report.createdAt = kit.createdAt;
    report.counts = { faces: kept.length, screens: screenPicks.length, pictures: pictures.length, hooks: story.hooks.length, chapters: story.chapters.length };
    fs.writeFileSync(path.join(outDir, REPORT_FILE), JSON.stringify(report, null, 2) + "\n");
    log(`kit written to ${target} in ${timings.total}s`);
    return { dir: target, kit, report };
  } finally {
    if (session) await session.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// ---- Reading it back ----

// The kit as the window and the assistant describe it: what is in it, where, and how it was
// made. `url(file)` maps a file to what the window can load; the assistant gets paths.
export function readThumbnailKit(dir, { url = null } = {}) {
  const folder = path.join(dir, "out", KIT_DIR);
  let kit;
  try { kit = readJson(path.join(folder, "kit.json")); } catch { return null; }
  let report = null;
  try { report = readJson(path.join(dir, "out", REPORT_FILE)); } catch { report = null; }
  if (report?.createdAt !== kit.createdAt) report = null;
  const link = (file) => (url ? url(path.join(folder, file), kit.createdAt) : path.join(folder, file));
  const frames = (kit.frames ?? []).map((f) => ({ file: f.file, kind: f.kind, atSeconds: f.atSeconds, tags: f.tags ?? [], score: f.score ?? null, words: f.words ?? "", ...(url ? { url: link(f.file) } : { path: link(f.file) }) }));
  const faceRanked = frames.some((f) => f.kind === "face") ? (kit.frames ?? []).some((f) => f.kind === "face" && f.face) : (report?.faceAnalysis?.used ?? null);
  return {
    folder,
    createdAt: kit.createdAt,
    faceRanked,
    faceAnalysis: report?.faceAnalysis ?? null,
    timings: report?.timings ?? null,
    counts: {
      faces: frames.filter((f) => f.kind === "face").length,
      screens: frames.filter((f) => f.kind === "screen").length,
      pictures: (kit.pictures ?? []).length,
      hooks: (kit.story?.hooks ?? []).length,
      chapters: (kit.story?.chapters ?? []).length,
    },
    frames,
    hooks: kit.story?.hooks ?? [],
    pictures: (kit.pictures ?? []).map((p) => ({ file: p.file, credit: p.credit ?? null, license: p.license ?? null })),
  };
}
