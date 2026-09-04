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
  probeDimensions,
  transcribe,
  computeReview,
  reviewStats,
  renderClean,
  scanFraming,
  withProgress,
} from "../scripts/pipeline.mjs";
import { normalizeCuts, flattenWords } from "../core/cut-engine.mjs";
import { punchPlan, DEFAULT_PUNCH_ZOOM } from "../core/shot-engine.mjs";
import { validateScenes, resolveScenes, SCENE_TYPES, GRAPHIC_KINDS } from "../core/compose-engine.mjs";
import { validateFraming, fullFrameFraming } from "../core/framing-engine.mjs";
import { spawn } from "node:child_process";

const MEDIA_ROOT = path.join(REPO_ROOT, "media");
const POINTER = path.join(MEDIA_ROOT, "current-project.json");

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

function projectPaths(dir) {
  return {
    video: stagedVideo(dir),
    transcript: path.join(dir, "raw.json"),
    review: path.join(dir, "review.json"),
    clean: path.join(dir, "out", "clean.mp4"),
    cleanTranscript: path.join(dir, "clean.json"),
    compose: path.join(dir, "compose.json"),
    final: path.join(dir, "out", "final.mp4"),
    framing: path.join(dir, "framing.json"),
    cleanMap: path.join(dir, "out", "clean-map.json"),
    screen: path.join(dir, "out", "screen.mp4"),
  };
}

function readFraming(dir) {
  const { framing } = projectPaths(dir);
  if (!fs.existsSync(framing)) return null;
  return JSON.parse(fs.readFileSync(framing, "utf8"));
}

function readCleanMap(dir) {
  const { cleanMap } = projectPaths(dir);
  if (!fs.existsSync(cleanMap)) return null;
  return JSON.parse(fs.readFileSync(cleanMap, "utf8"));
}

const rectSchema = z.object({
  x: z.number().min(0), y: z.number().min(0), w: z.number().positive(), h: z.number().positive(),
}).describe("Pixels in the raw frame");

function cleanWords(dir) {
  const paths = projectPaths(dir);
  if (!fs.existsSync(paths.cleanTranscript)) {
    throw new Error("no clean transcript; render_clean then retranscribe_clean first");
  }
  return flattenWords(JSON.parse(fs.readFileSync(paths.cleanTranscript, "utf8")));
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
    "Transcribe the current project's raw video with WhisperX large-v3 on the local GPU (word timestamps). Takes a minute or more; call once, not repeatedly. Skips work if a transcript exists unless force is set.",
  inputSchema: { force: z.boolean().optional().describe("Re-transcribe even if raw.json exists") },
}, async ({ force }) => {
  const dir = currentProjectDir();
  const paths = projectPaths(dir);
  if (!paths.video) throw new Error("project has no staged raw video");
  if (fs.existsSync(paths.transcript) && !force) {
    return ok({ skipped: true, transcript: paths.transcript });
  }
  const transcript = await withProgress(dir, "transcribe", "Transcribing on the GPU", () => transcribe(paths.video, paths.transcript));
  const words = transcript.segments.reduce((n, s) => n + (s.words?.length ?? 0), 0);
  return ok({ transcript: paths.transcript, segments: transcript.segments.length, words });
});

server.registerTool("cut_pass", {
  description:
    "Run the deterministic cut pass over the current project's transcript: silence gaps and filler words become cut proposals, all enabled. Writes review.json, which the Fabula window renders live. Re-running resets any toggles. Tune min_gap for the speaker: 0.6s is tight and reads fast-cut; conversational delivery usually wants 0.8–1.0s so natural beats survive.",
  inputSchema: {
    min_gap_seconds: z.number().min(0.2).max(5).optional().describe("Shortest pause proposed as a cut (default 0.6)"),
    keep_breath_seconds: z.number().min(0).max(1).optional().describe("Air left on each side of a cut (default 0.15)"),
  },
}, async ({ min_gap_seconds, keep_breath_seconds }) => {
  const dir = currentProjectDir();
  const paths = projectPaths(dir);
  if (!fs.existsSync(paths.transcript)) throw new Error("no transcript; call transcribe first");
  const transcript = JSON.parse(fs.readFileSync(paths.transcript, "utf8"));
  const review = computeReview(transcript, paths.video, probeDuration(paths.video), {
    minGapSeconds: min_gap_seconds,
    keepBreathSeconds: keep_breath_seconds,
  });
  // A retuned pass replaces the proposals, not the shot plan: punch-ins
  // re-derive from whatever cuts stand, so the plan survives the rerun.
  if (fs.existsSync(paths.review)) {
    const previous = JSON.parse(fs.readFileSync(paths.review, "utf8"));
    if (previous.shotPlan) review.shotPlan = previous.shotPlan;
  }
  writeReview(dir, review);
  return ok({ ...reviewStats(review), cutOptions: review.cutOptions, shotPlan: review.shotPlan ?? null });
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
    "Declare the source framing: ordered segments over the RAW timeline, each with the head rect (pixels) and, when the recording shows a screen, a screen rect. Segments must be gapless from 0 to the duration and every head must share one aspect. render_clean crops the head track to these rects (punch-ins apply on top) and writes a second, silent screen track from the screen rects; the Cut tab draws them over the footage. Omit segments to clear the framing (whole frame).",
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
    rendered: map ? { fps: map.fps, head: map.head, screen: map.screen, screenSpans: map.screenSpans } : null,
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
  const framing = readFraming(dir);
  const result = await withProgress(dir, "render_clean", "Rendering the clean cut", () =>
    renderClean(paths.video, review.cuts, review.duration, paths.clean, { shots, framing }));
  fs.writeFileSync(paths.cleanMap, JSON.stringify(result.map, null, 2));
  const { map, ...summary } = result;
  return ok({
    ...summary,
    head: map.head,
    screen: map.screen,
    screenSpans: map.screenSpans,
    shotPlan: review.shotPlan ?? null,
    framed: Boolean(framing),
    ...reviewStats(review),
  });
});

server.registerTool("retranscribe_clean", {
  description:
    "Transcribe out/clean.mp4 with WhisperX — the pipeline's second pass. Compose-stage scenes anchor to THIS transcript's word ids, never the raw one's. Run after the cut list settles; a minute or so on the GPU. Skips if clean.json is current unless force is set.",
  inputSchema: { force: z.boolean().optional().describe("Re-transcribe even if clean.json exists") },
}, async ({ force }) => {
  const dir = currentProjectDir();
  const paths = projectPaths(dir);
  if (!fs.existsSync(paths.clean)) throw new Error("no clean.mp4; render_clean first");
  if (fs.existsSync(paths.cleanTranscript) && !force &&
      fs.statSync(paths.cleanTranscript).mtimeMs > fs.statSync(paths.clean).mtimeMs) {
    return ok({ skipped: true, transcript: paths.cleanTranscript });
  }
  const transcript = await withProgress(dir, "retranscribe", "Transcribing the clean cut", () => transcribe(paths.clean, paths.cleanTranscript));
  return ok({
    transcript: paths.cleanTranscript,
    words: transcript.segments.reduce((n, s) => n + (s.words?.length ?? 0), 0),
  });
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
    "Read the CURRENT scene plan — scenes with indices, captions flag, theme. The person may have tweaked text, accents, layouts or the theme in the app since the plan was last written, so ALWAYS read this before set_scenes and carry their changes forward; replacing the plan from memory discards their edits.",
  inputSchema: {},
}, async () => {
  const dir = currentProjectDir();
  const paths = projectPaths(dir);
  if (!fs.existsSync(paths.compose)) return ok({ scenes: [], captions: false, theme: null });
  const config = JSON.parse(fs.readFileSync(paths.compose, "utf8"));
  return ok({
    scenes: (config.scenes ?? []).map((scene, index) => ({ index, ...scene })),
    captions: Boolean(config.captions),
    theme: config.theme ?? null,
  });
});

server.registerTool("set_scenes", {
  description:
    `Replace the project's scene plan (declarative, whole-plan-at-once). Scene types: ${[...SCENE_TYPES].join(", ")}. title and callout carry text; graphic carries an animated insert card — kind ${[...GRAPHIC_KINDS].join("/")} (chart: items with numeric values, bars grow in; stat: one big count-up number; list: items reveal in sequence; image: a still from assets/; screen: the recording's own screen track, playing in sync beside the head — only meaningful inside get_framing's screenSpans, pair it with a stage pip or side layout), all motion a pure function of scene progress. stage scenes place the talking head on the 1080p canvas for their span — layout focus (large, centered), pip (small corner card; optional corner br/bl/tr/tl), or side (head left, content right) — easing between layouts at each boundary; anywhere undeclared, the head holds focus. Scenes anchor to clean-transcript word ids; captions turns karaoke word captions on. The Compose tab previews everything live; render_final bakes it.`,
  inputSchema: {
    scenes: z.array(z.object({
      type: z.enum([...SCENE_TYPES]),
      from_word_id: z.number().int().min(0),
      to_word_id: z.number().int().min(0),
      text: z.string().min(1).optional().describe("title/callout text"),
      accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("per-scene accent override"),
      flair: z.boolean().optional().describe("title only: a particle burst behind the text"),
      layout: z.enum(["focus", "pip", "side"]).optional().describe("stage scenes only"),
      corner: z.enum(["br", "bl", "tr", "tl"]).optional().describe("stage+pip only"),
      graphic: z.object({
        kind: z.enum([...GRAPHIC_KINDS]),
        title: z.string().optional(),
        value: z.number().optional().describe("stat only; counts up in its own precision (3.99 keeps cents)"),
        prefix: z.string().max(4).optional().describe("stat only: text before the number, e.g. $"),
        suffix: z.string().max(6).optional().describe("stat only: text after the number, e.g. % or k"),
        label: z.string().optional().describe("stat label / image or screen caption"),
        src: z.string().optional().describe("image only: project-relative png/jpg/webp, e.g. assets/still.png"),
        items: z.array(z.object({
          label: z.string().min(1),
          value: z.number().optional().describe("chart only"),
        })).max(6).optional().describe("chart/list rows"),
      }).optional().describe("graphic scenes only"),
    })).describe("The full scene list; an empty array clears it. kinetic scenes render the spoken words as giant center-stage type over their span."),
    captions: z.boolean().default(false).describe("Karaoke captions over the whole video"),
    theme: z.object({
      accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    }).optional().describe("Project-wide accent; omit to keep the current theme"),
  },
}, async ({ scenes, captions, theme }) => {
  const dir = currentProjectDir();
  const words = cleanWords(dir);
  const shaped = scenes.map((scene) => ({
    type: scene.type,
    fromWordId: scene.from_word_id,
    toWordId: scene.to_word_id,
    text: scene.text,
    accent: scene.accent,
    flair: scene.flair,
    layout: scene.layout,
    corner: scene.corner,
    graphic: scene.graphic,
  }));
  validateScenes(shaped, words);
  const file = projectPaths(dir).compose;
  const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const config = { scenes: shaped, captions, theme: theme ?? previous.theme };
  if (!config.theme) delete config.theme;
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  // Screen scenes outside a screen span play a dark card: worth saying.
  const warnings = [];
  const spans = readCleanMap(dir)?.screenSpans ?? [];
  resolveScenes(shaped, words).forEach((scene, index) => {
    if (scene.graphic?.kind !== "screen") return;
    const covered = spans.some((span) => span.start <= scene.start + 0.05 && scene.end - 0.05 <= span.end);
    if (!covered) warnings.push(`scene ${index}: screen graphic over ${scene.start.toFixed(1)}–${scene.end.toFixed(1)}s is outside every screen span ${JSON.stringify(spans)}`);
  });
  return ok({ scenes: shaped.length, captions, theme: config.theme ?? null, warnings });
});

// The export runs as a child Electron; its frame counter streams back as
// progress the window shows. Headless on the CLI: the server's own
// environment has no display (stdio transports strip it).
function runExport(dir, args, onProgress) {
  const electron = path.join(REPO_ROOT, "node_modules", "electron", "dist", "electron");
  return new Promise((resolve, reject) => {
    const child = spawn(electron, [
      "--no-sandbox", "--no-zygote", "--ozone-platform=headless",
      path.join(REPO_ROOT, "scripts", "export-compose.cjs"),
      ...args,
      dir,
    ], {
      env: {
        ...process.env,
        LD_LIBRARY_PATH: [
          path.join(REPO_ROOT, "tools", "wsl-libs", "usr", "lib", "x86_64-linux-gnu"),
          process.env.LD_LIBRARY_PATH,
        ].filter(Boolean).join(":"),
      },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("export exceeded 3 hours")); }, 3 * 60 * 60 * 1000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const lines = String(chunk).trim().split("\n");
      const last = lines.filter((line) => /frames|muxing|captured/.test(line)).pop();
      if (last) onProgress(last.trim());
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      const tail = (text) => text.trim().split("\n").slice(-6).join("\n");
      if (code !== 0) reject(new Error(`export failed (${code}): ${tail(stderr)}\n${tail(stdout)}`));
      else resolve(tail(stdout));
    });
  });
}

server.registerTool("render_final", {
  description:
    "The composited render: the 1080p stage — head layer, screen track, scene overlays — captured frame by frame through the same runtime the preview uses and muxed with the clean cut's untouched audio. Writes out/final.mp4, or out/preview-<from>-<to>.mp4 when a word range is given (render a span to check a scene in a minute instead of the whole film in an hour). Minutes to hours depending on length; the window shows the frame count. Call once.",
  inputSchema: {
    from_word_id: z.number().int().min(0).optional().describe("Render only from this clean word…"),
    to_word_id: z.number().int().min(0).optional().describe("…to this clean word (inclusive)"),
  },
}, async ({ from_word_id, to_word_id }) => {
  const dir = currentProjectDir();
  const paths = projectPaths(dir);
  if (!fs.existsSync(paths.compose)) throw new Error("no compose.json; set_scenes first");
  if (!fs.existsSync(paths.cleanTranscript)) throw new Error("no clean.json; retranscribe_clean first");
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
  const log = await withProgress(dir, "render_final", output === paths.final ? "Rendering the film" : "Rendering a preview span",
    (detail) => runExport(dir, args, detail));
  return ok({ output, bytes: fs.statSync(output).size, log });
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
    cleanTranscribed: fs.existsSync(paths.cleanTranscript),
    composed: fs.existsSync(paths.compose),
    finalRendered: fs.existsSync(paths.final),
    framed: fs.existsSync(paths.framing),
    screenTrack: fs.existsSync(paths.screen),
  };
  if (state.reviewed) Object.assign(state, reviewStats(readReview(dir)));
  const map = readCleanMap(dir);
  if (map) state.screenSpans = map.screenSpans;
  return ok(state);
});

await server.connect(new StdioServerTransport());
