// Fabula's MCP server: the cut pipeline as tools an agent can drive while a
// person watches the review UI. State lives in files under media/<project>/ —
// review.json is the single artifact both this server and the Electron app
// read, so every tool call the agent makes is visible in the window within a
// poll tick. Stdio transport; `npm run assistant` connects either Codex or
// Claude Code. Direct Claude Code sessions can also use the checked-in .mcp.json.
//
// The long steps — the two transcriptions and the two renders — run as
// detached jobs (scripts/job.mjs, scripts/export-compose.cjs). A tool that
// starts one waits a bounded time and then reports either the result or
// "still running"; wait_render picks it up from there. Nothing long dies
// with the session that started it.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
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
  cleanCurrent,
  cleanTranscriptCurrent,
  waitForJob,
  runningJob,
  readProgress,
  encoderCapabilities,
} from "../scripts/pipeline.mjs";
import {
  stagedVideo,
  projectPaths,
  readCleanMap,
  readComposeConfig,
  cleanTranscriptStamp,
  currentCleanPlan,
  cleanSummary,
  logTail,
  lastJobStage,
  staleness,
  jobSpec,
  launchJob,
  listProjects, describeProject, PROJECT_NAME_RE, readProjectMeta, writeProjectTitle, writeProjectFormat, projectFormat, slugify, cleanTitle,
} from "../scripts/project-state.mjs";
import { FORMAT_IDS, DEFAULT_FORMAT, resolveFormat, describeFormats, stageOf } from "../core/formats.mjs";
import { suggestClips, createShort } from "../scripts/shorts.mjs";
import { describeTemplates, expandTemplates, TEMPLATE_IDS } from "../core/templates.mjs";
import { readStory } from "../core/story-engine.mjs";
import { describePacing } from "../core/pacing.mjs";
import { PERSONAS, PERSONA_IDS, CRAFT_DOCS, validatePersona, describePersonas } from "../core/personas.mjs";
import { validateAudio, describeAudio, AUDIO_EXTENSIONS, MUSIC_DEFAULTS } from "../core/audio-engine.mjs";
import { normalizeCuts, flattenWords } from "../core/cut-engine.mjs";
import { punchPlan, DEFAULT_PUNCH_ZOOM } from "../core/shot-engine.mjs";
import { validateScenes, resolveScenes, describeVariety, uncoveredCutaways, hiddenFullStage, validateInserts, applyInsertChoice, captionMode, CAPTION_MODES, SCENE_TYPES, GRAPHIC_KINDS, IMAGE_MOTIONS } from "../core/compose-engine.mjs";
import { takeInbox, pendingInbox } from "../scripts/inbox.mjs";
import { validateFraming } from "../core/framing-engine.mjs";
import { LAYOUTS, TRANSITIONS, TRANSITION_SECONDS } from "../core/stage-engine.mjs";
import { reanchorScenes } from "../core/reanchor.mjs";
import { PRESETS, TITLE_STYLES, CALLOUT_STYLES, CAPTION_STYLES, CORNERS, VENDORED_FONTS, validateTheme, resolveTheme, describeLook, describePresets } from "../core/themes.mjs";
import { fetchImage, searchCommons, listAssets } from "../scripts/images.mjs";
import { listSavedThemes, saveTheme, loadTheme } from "../scripts/theme-store.mjs";
import { configuredProjectsRoot } from "../scripts/settings.cjs";
import { INVARIANTS } from "../core/assistant-brief.mjs";

// media/ beside the checkout, or the folder fabula.settings.json names; read
// per call so a change made in the window applies to the next tool call.
const mediaRoot = () => configuredProjectsRoot() ?? path.join(REPO_ROOT, "media");
const pointerFile = () => path.join(mediaRoot(), "current-project.json");
// Jobs are launched from the shared specs (scripts/project-state.mjs), the
// same ones the window uses, so the two never drift in arguments.
const RUNNER = { node: process.execPath };
const DEFAULT_WAIT_SECONDS = 25;
const MAX_WAIT_SECONDS = 1500;

// One frame, through the export page, in its own short-lived Electron.
// Electron is the only thing that can paint the overlay, and the render job
// already runs the same way; this is that path with a frame count of one.
function runFrame(dir, args) {
  return new Promise((resolve, reject) => {
    const spec = jobSpec("final", dir, {});
    const child = spawn(spec.program === "electron" ? electronBinary() : spec.program,
      // ozone-platform has to be a real argument: by the time the script can
      // appendSwitch it, Chromium has already chosen a platform and died.
      ["--no-sandbox", "--no-zygote", "--ozone-platform=headless", path.join(REPO_ROOT, "scripts", "frame.cjs"), dir, ...args],
      { env: frameEnv(spec), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      const line = out.trim().split("\n").filter((l) => l.startsWith("{")).at(-1);
      if (code !== 0 || !line) return reject(new Error(`could not draw the frame: ${(err.trim().split("\n").at(-1) || `exit ${code}`)}`));
      try { resolve(JSON.parse(line)); } catch (error) { reject(new Error(`unreadable frame result: ${error.message}`)); }
    });
  });
}

// The environment the frame's Electron gets. A session started from inside
// another Electron (an editor's terminal, the window's own pane) carries
// ELECTRON_RUN_AS_NODE, which would turn the child into a bare node and make
// every Chromium flag a "bad option"; it is dropped here.
function frameEnv(spec) {
  const env = { ...process.env, ...(spec.env ?? {}) };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

// The Electron the pipeline runs. The real binary under dist/, not the
// .bin shim: the shim re-enters node to find it, and a Chromium started
// that way from a stdio server dies on this host.
function electronBinary() {
  const dist = path.join(REPO_ROOT, "node_modules", "electron", "dist", "electron");
  return fs.existsSync(dist) ? dist : "electron";
}

function currentProjectDir() {
  if (!fs.existsSync(pointerFile())) throw new Error("no open project; switch_project one from list_projects, or open_project a recording");
  const pointer = JSON.parse(fs.readFileSync(pointerFile(), "utf8"));
  return path.join(mediaRoot(), pointer.dir);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readFraming(dir) {
  const { framing } = projectPaths(dir);
  return fs.existsSync(framing) ? readJson(framing) : null;
}

function readReview(dir) {
  const { review } = projectPaths(dir);
  if (!fs.existsSync(review)) throw new Error("no review.json yet; call cut_pass first");
  return readJson(review);
}

function writeReview(dir, review) {
  fs.writeFileSync(projectPaths(dir).review, JSON.stringify(review, null, 2));
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

const server = new McpServer({ name: "fabula", version: "0.2.0" }, {
  instructions: `${INVARIANTS}

The first pass (transcript, framing scan, cut proposals) runs by itself when the window creates a project, and the person reviews the cuts there; your work is the composition. docs/assistant-workflow.md is the whole workflow. adopt_persona (editor for a film, farmer for shorts) hands you the craft for the job; read_story marks the transcript up before you compose; describe_templates lists the named graphics; every plan write returns variety and pacing reads, and preview_sheet shows the whole film in one picture. Long jobs continue in the background: pass wait_seconds: 25 and call wait_render until done. Only one assistant controls a checkout at a time. Window messages arrive through wait_for_input: listen after setting insert points or when asked, keep listening until told to stop, and do not poll unprompted.`,
});

server.registerTool("open_project", {
  description:
    "Start a project from a recording and make it the open one. The footage is referenced where it lives (never copied); the project folder <root>/<slug>/ holds only derived files, and the review UI is pointed at it. The title is the person's name for it (ask them; the folder is a slug of it). A recording that already has a project reopens that project. Returns whether a transcript already exists.",
  inputSchema: {
    video_path: z.string().describe("Path to the raw recording (mp4/mov/mkv/webm)"),
    title: z.string().optional().describe("The project's name as the person wants it shown; defaults to the recording's file name"),
    format: z.enum([...FORMAT_IDS]).optional().describe("The shape it is delivered in: landscape (16:9, the default) or vertical (9:16, for Shorts/Reels/TikTok). Ask if the person has not said — it decides the stage and the clean cut's ceiling, and changing it later makes the clean cut stale."),
    name: z.string().optional().describe("Folder name override; normally derived from the title"),
  },
}, async ({ video_path, title, format, name }) => {
  if (!fs.existsSync(video_path)) throw new Error(`no such file: ${video_path}`);
  const ext = path.extname(video_path).toLowerCase();
  if (!/^\.(mp4|mov|mkv|webm|m4v)$/.test(ext)) throw new Error(`unsupported container: ${ext}`);
  const shown = cleanTitle(title ?? path.basename(video_path, ext));
  const projectName = name ? name.replace(/[^a-z0-9-_]/gi, "_").toLowerCase() : slugify(shown);
  const dir = path.join(mediaRoot(), projectName);
  const existing = stagedVideo(dir);
  if (existing && path.resolve(existing) !== path.resolve(video_path)) {
    throw new Error(`a project called ${shown} (${projectName}) already exists with a different recording; choose another title`);
  }
  fs.mkdirSync(dir, { recursive: true });
  if (!existing) {
    const source = { path: path.resolve(video_path), container: ext, bytes: fs.statSync(video_path).size };
    fs.writeFileSync(path.join(dir, "source.json"), JSON.stringify(source, null, 2));
  }
  if (!existing || title !== undefined) writeProjectTitle(dir, shown);
  if (!existing) writeProjectFormat(dir, format ?? DEFAULT_FORMAT);
  else if (format !== undefined && format !== projectFormat(dir)) {
    throw new Error(`${projectName} is already a ${projectFormat(dir)} project; set_format changes the shape of an existing one, and says what it costs`);
  }
  fs.writeFileSync(pointerFile(), JSON.stringify({ dir: projectName }, null, 2));
  const paths = projectPaths(dir);
  return ok({
    project: projectName,
    title: readProjectMeta(dir).title ?? projectName,
    format: projectFormat(dir),
    reopened: Boolean(existing),
    video: paths.video,
    durationSeconds: Number(probeDuration(paths.video).toFixed(2)),
    transcribed: fs.existsSync(paths.transcript),
    reviewed: fs.existsSync(paths.review),
  });
});

server.registerTool("list_projects", {
  description:
    "Every Fabula project: each folder under media/ that stages a recording, most recently touched first, with the stage it has reached (staged, transcribed, cut, clean, composed, final), whether its recording is still where it was, and which one is open. The same list the window's Projects dialog shows.",
  inputSchema: {},
}, async () => {
  const current = fs.existsSync(pointerFile()) ? readJson(pointerFile()).dir : null;
  return ok({ root: mediaRoot(), current, projects: listProjects(mediaRoot()).map((project) => ({ ...project, current: project.name === current })) });
});

server.registerTool("switch_project", {
  description:
    "Make an existing project the open one, by name from list_projects. The window follows within a poll tick. Nothing is rendered or changed; open_project is for a recording that has no project yet.",
  inputSchema: { name: z.string().describe("Project folder name under media/") },
}, async ({ name }) => {
  if (!PROJECT_NAME_RE.test(name)) throw new Error("that is not a project name");
  const project = describeProject(path.join(mediaRoot(), name));
  if (!project) throw new Error(`no project called ${name}; list_projects shows what exists`);
  fs.writeFileSync(pointerFile(), JSON.stringify({ dir: name }, null, 2));
  return ok({ project: name, stage: project.stage, video: project.video, videoPresent: project.videoPresent });
});

server.registerTool("rename_project", {
  description: "Give a project a new title. The folder name stays, so nothing moves and nothing goes stale; the window shows the new title within a poll tick.",
  inputSchema: { name: z.string().describe("Project folder name from list_projects"), title: z.string().describe("The new title") },
}, async ({ name, title }) => {
  if (!PROJECT_NAME_RE.test(name)) throw new Error("that is not a project name");
  const dir = path.join(mediaRoot(), name);
  if (!describeProject(dir)) throw new Error(`no project called ${name}`);
  return ok({ project: name, title: writeProjectTitle(dir, title) });
});

// ---- Shorts out of a long film ----

server.registerTool("suggest_clips", {
  description:
    "Read the finished film's transcript and propose the moments that could stand alone as short films, most promising first. Each candidate is a run of whole sentences with its word ids, its length, the words themselves, and plain notes on what is good and bad about it — an opening that promises something, an opening that starts on “it”, an ending that does not land, no claim in it anywhere. These are candidates, not decisions: read the text, disagree where you disagree, and widen or narrow a span with your own word ids. Needs the clean transcript, so it comes after the film is cut.",
  inputSchema: {
    format: z.enum([...FORMAT_IDS]).optional().describe("The shape the shorts are for; vertical by default, which is what decides how long is too long"),
    limit: z.number().int().min(1).max(20).optional().describe("How many candidates, 8 by default"),
  },
}, async ({ format, limit }) => {
  const dir = currentProjectDir();
  const found = suggestClips(dir, { format: format ?? "vertical", limit: limit ?? 8 });
  return ok({
    ...found,
    hint: "create_short cuts one into its own project. Say what each one is about and why you would or would not make it, then let the person choose — do not make eight shorts because eight were found.",
  });
});

server.registerTool("create_short", {
  description:
    "Cut a span of the open film into a NEW project of its own, in short-form shape. It references the same recording and inherits this film's cut list with everything outside the span removed, so the short's clean cut is rendered from the original footage and can be framed for a tall frame rather than cropped out of a wide composition. The look travels; the scene plan does not — a composition written for a wide frame is the wrong one for a tall one, so the short starts with the theme, burned-in captions and no visuals, and you compose it after switching to it. Word ids are the OPEN film's clean transcript (suggest_clips reports them). Nothing is rendered here: switch_project to it, then render_clean and retranscribe_clean before composing.",
  inputSchema: {
    from_word_id: z.number().int().min(0).describe("First word of the short, on this film's clean transcript"),
    to_word_id: z.number().int().min(0).describe("Last word of the short"),
    title: z.string().optional().describe("What to call it; the first words of the clip if you do not say"),
    format: z.enum([...FORMAT_IDS]).optional().describe("vertical by default"),
  },
}, async ({ from_word_id, to_word_id, title, format }) => {
  const dir = currentProjectDir();
  const short = createShort(dir, {
    fromWordId: from_word_id, toWordId: to_word_id, title,
    format: format ?? "vertical", root: mediaRoot(),
  });
  return ok({
    ...short,
    next: `switch_project ${short.project}, then render_clean and retranscribe_clean (fast — it is ${short.seconds}s of footage), set_theme if this one wants its own, and compose it for the tall frame: focus crops the head to fill, band keeps the whole recording, and a title has room for three words rather than nine.`,
  });
});

server.registerTool("set_format", {
  description:
    "Change the shape an existing project is delivered in: landscape (16:9) or vertical (9:16). The scene plan is kept and means the same thing in either shape — the layouts resolve to different rectangles, so `side` puts the visual under the head rather than beside it and `focus` fills a tall frame by cropping the sides. It makes the clean cut stale, because the head track's ceiling moves with the shape: render_clean and retranscribe_clean after it, then look at a preview_frame before rendering the film. For a short cut out of a longer piece, create_short makes a new vertical project instead of reshaping this one.",
  inputSchema: { format: z.enum([...FORMAT_IDS]) },
}, async ({ format }) => {
  const dir = currentProjectDir();
  const was = projectFormat(dir);
  writeProjectFormat(dir, format);
  return ok({
    format, was,
    stage: stageOf(format),
    stale: was === format ? [] : ["clean"],
    hint: was === format ? "already that shape; nothing changed" : "the clean cut's ceiling moved: render_clean, retranscribe_clean, then preview_frame before render_final",
  });
});

server.registerTool("close_project", {
  description: "Close the open project: the window returns to its start screen with the project list. Files are not touched; switch_project or open_project opens one again.",
  inputSchema: {},
}, async () => {
  fs.rmSync(pointerFile(), { force: true });
  return ok({ closed: true });
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
  launchJob(dir, jobSpec("transcribe", dir), RUNNER);
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
  launchJob(dir, jobSpec("clean", dir), RUNNER);
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
  launchJob(dir, jobSpec("retranscribe", dir), RUNNER);
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
    captions: captionMode(config.captions),
    theme: config.theme ?? null,
    punch: readPunch(dir),
    audio: config.audio ?? null,
    inserts: (config.inserts ?? []).map((insert) => ({ id: insert.id, chosen: insert.chosen ?? null, note: insert.note ?? null })),
  });
});

// ---- Sound ----

server.registerTool("import_audio", {
  description:
    "Copy a music file from the pipeline host into the project's assets/ so set_audio can use it as the bed: mp3, wav, m4a, aac, ogg, flac or opus. Music is the person's own or licensed; Fabula fetches none. Returns the project-relative src.",
  inputSchema: {
    path: z.string().describe("Absolute path to the file, as the pipeline host sees it (a WSL path on Windows)"),
    name: z.string().optional().describe("File name under assets/; the source's own name by default"),
  },
}, async ({ path: source, name }) => {
  const dir = currentProjectDir();
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`no such file: ${source}`);
  if (!AUDIO_EXTENSIONS.test(source)) throw new Error("import_audio takes mp3, wav, m4a, aac, ogg, flac or opus");
  const leaf = (name ?? path.basename(source)).replace(/[^a-z0-9._-]/gi, "_");
  if (!AUDIO_EXTENSIONS.test(leaf)) throw new Error("the name must keep the audio extension");
  const assets = path.join(dir, "assets");
  fs.mkdirSync(assets, { recursive: true });
  fs.copyFileSync(source, path.join(assets, leaf));
  const seconds = Number(probeDuration(path.join(assets, leaf)).toFixed(1));
  return ok({ src: `assets/${leaf}`, seconds, bytes: fs.statSync(path.join(assets, leaf)).size, next: `set_audio with music: { src: "assets/${leaf}" }` });
});

server.registerTool("set_audio", {
  description:
    `The sound under the voice. music: a bed from assets/ (import_audio) at level dB while nobody speaks (${MUSIC_DEFAULTS.level} by default), duck dB lower under the voice (${MUSIC_DEFAULTS.duck}), ramping over ramp seconds (${MUSIC_DEFAULTS.ramp}) either side of every pause the transcript shows — the duck is computed from the words, not guessed from a compressor — faded in and out over fade seconds (${MUSIC_DEFAULTS.fade}), looped to the film's length unless loop is false. voice_loudness normalises the voice to an integrated LUFS target (-16 for a film, -14 for a short; null leaves it as recorded). Sound lives only in the stitch, so changing it re-renders no chunk: render_final after it is seconds, not minutes. music: null removes the bed. Returns what the bed will do and how many pauses it comes up in.`,
  inputSchema: {
    music: z.object({
      src: z.string().describe("assets/…, from import_audio"),
      level: z.number().min(-40).max(0).optional(),
      duck: z.number().min(-40).max(0).optional(),
      ramp: z.number().min(0.1).max(3).optional(),
      fade: z.number().min(0).max(10).optional(),
      loop: z.boolean().optional(),
    }).nullable().optional().describe("The bed; null removes it; omit to keep the current one"),
    voice_loudness: z.number().min(-30).max(-8).nullable().optional().describe("Integrated LUFS target for the voice; null leaves it as recorded; omit to keep"),
  },
}, async ({ music, voice_loudness }) => {
  const dir = currentProjectDir();
  const config = readComposeConfig(dir);
  const audio = { ...(config.audio ?? {}) };
  if (music !== undefined) {
    if (music === null) delete audio.music;
    else {
      if (!fs.existsSync(path.join(dir, music.src))) throw new Error(`no such asset ${music.src}; import_audio first`);
      audio.music = { ...(audio.music?.src === music.src ? audio.music : {}), ...music };
    }
  }
  if (voice_loudness !== undefined) {
    if (voice_loudness === null) delete audio.voice;
    else audio.voice = { loudness: voice_loudness };
  }
  validateAudio(audio);
  if (Object.keys(audio).length) config.audio = audio; else delete config.audio;
  writeComposeConfig(dir, config);
  const words = fs.existsSync(projectPaths(dir).cleanTranscript) ? cleanWords(dir) : [];
  const duration = words.at(-1)?.end ?? 0;
  return ok({ audio: config.audio ?? null, ...describeAudio(config.audio, words, duration), stale: ["final"], hint: "render_final to hear it; the chunks are cached, so only the stitch runs" });
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
    options: insert.options.map((option) => ({ id: option.id, label: option.label, scenes: expandTemplates(option.scenes.map(shapeScene), { format: projectFormat(dir) }) })),
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
    `Replace the project's scene plan (declarative, whole-plan-at-once). Scene types: ${[...SCENE_TYPES].join(", ")}. title carries text, an optional subtitle and a style (${[...TITLE_STYLES].join("/")}; block is the broadcast lower third); callout carries text and a style (${[...CALLOUT_STYLES].join("/")}); styles default to the theme's. graphic carries an animated insert card — kind ${[...GRAPHIC_KINDS].join("/")}: chart (items with numeric values, bars grow in), stat (one big count-up number with prefix/suffix), list (items reveal with checks), image (a still from assets/ with motion ${[...IMAGE_MOTIONS].join("/")}), screen (the recording's own screen track in sync beside the head — only inside get_framing's screenSpans, with a stage pip or side layout), quote (text + by), compare (left/right columns with title and items, a VS badge), steps (numbered items joined by a line), ring (value 0–100 with label, drawn as an arc), logos (items with src pictures from assets/ — fetch_image gets them), and three that take the WHOLE stage: cover (a still edge to edge with a big title and subtitle, optional tint), section (a chapter heading: number, title, subtitle), custom (your own html + css for this one moment: scoped, no scripts or external loads, animate with the CSS variables --q (0→1 over the first 1.8 s), --p (0→1 over the span) and --alpha; cqw/cqh units measure the stage; pictures as assets/name.png). All motion is a pure function of scene progress. stage scenes place the talking head on the canvas for their span — layout focus (the head is the picture: large and centred in a wide frame, edge to edge and cropped in a tall one), pip (small corner card; optional corner br/bl/tr/tl), side (the visual beside the head: a right-hand column in a wide frame, the bottom half in a tall one), band (the head WHOLE in the recording's own shape across the width, the visual under it — the shot for a wide moment a vertical crop would ruin), cutaway (camera completely hidden, narration continues; use for B-roll and explanatory diagrams — it gets full's content rect), or full (the visuals own the stage, the head a small corner card; pair it with cover/section/custom) — anywhere undeclared, the head holds focus. describe_kit says which shape this project is and what each layout means in it. How each boundary is crossed is the look's transition (set_theme): dissolve fades the head out and back without moving it, glide flies it between rectangles, cut changes everything on one frame; a stage scene may name its own to override the film's for that one boundary. The engine bridges returns to focus shorter than 3 s and absorbs placed segments shorter than that, so do not plan flights closer together than a breath. Scenes anchor to clean-transcript word ids; captions turns phrase captions on (their look is the theme's captionStyle). Theme and punch-ins are kept unless given; set_theme owns the look. The Compose tab previews everything live; render_final bakes it, re-rendering only the chunks that changed.`,
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
    transition: z.enum([...TRANSITIONS]).optional().describe("stage scenes only: how this one boundary is crossed, overriding the theme's transition for it"),
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
        template: z.enum([...TEMPLATE_IDS]).optional().describe("custom only: a named graphic from describe_templates, filled in from params; html and css are generated"),
        params: z.record(z.any()).optional().describe("custom only: the template's fields"),
        left: z.object({ title: z.string().min(1), items: z.array(z.object({ label: z.string().min(1) })).min(1).max(5) }).optional().describe("compare only"),
        right: z.object({ title: z.string().min(1), items: z.array(z.object({ label: z.string().min(1) })).min(1).max(5) }).optional().describe("compare only"),
        items: z.array(z.object({
          label: z.string().min(1).optional().describe("chart/list/steps rows; a caption under a logo"),
          value: z.number().optional().describe("chart only"),
          src: z.string().optional().describe("logos only: project-relative picture"),
        })).max(6).optional().describe("chart/list/steps/logos rows"),
      }).optional().describe("graphic scenes only"),
    })).describe("The full scene list; an empty array clears it. kinetic scenes render the spoken words as giant center-stage type over their span."),
    captions: z.union([z.boolean(), z.enum([...CAPTION_MODES])]).optional().describe("open (burned in), closed (an SRT/VTT beside the film for the player's CC), both, or none; omit to keep the current setting"),
    theme: z.object({
      accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    }).optional().describe("A quick accent override merged into the theme; set_theme is the full instrument"),
    punch_zoom: z.number().min(1.02).max(1.5).nullable().optional()
      .describe("Punch-in zoom for the alternating shot plan; null turns punch-ins off; omit to keep the current setting"),
  },
}, async ({ scenes, captions, theme, punch_zoom }) => {
  const dir = currentProjectDir();
  const words = cleanWords(dir);
  const shaped = expandTemplates(scenes.map((scene) => ({
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
    transition: scene.transition,
    graphic: scene.graphic,
    ...(scene.insert_id ? { insertId: scene.insert_id } : {}),
  })), { format: projectFormat(dir) });
  validateScenes(shaped, words);
  const previous = readComposeConfig(dir);
  const mergedTheme = theme ? { ...(previous.theme ?? {}), ...theme } : previous.theme;
  validateTheme(mergedTheme);
  const config = {
    scenes: shaped,
    captions: captions === undefined ? captionMode(previous.captions) : captionMode(captions),
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
  // What the plan looks like as a sequence, read from the plan itself. The
  // rule against a repetitive film is worth nothing if it only lives in a
  // document read at the start of the session.
  const { warnings, variety, pacing } = readBackPlan(dir, shaped, words, config.theme, config.captions);
  const look = describeLook(config.theme, listSavedThemes(mediaRoot()));
  if (!look.chosen && shaped.length > 0) warnings.push(look.hint);
  return ok({
    scenes: shaped.length, captions: config.captions, theme: config.theme ?? null, punch: config.punch ?? null,
    warnings, variety, pacing,
    ...(variety.length || pacing.notes.length ? { varietyHint: "variety and pacing are observations about the plan you just wrote, not errors. Fix the ones you agree with with update_scenes — it changes the scenes you name and leaves the rest alone — then tell the person what you changed." } : {}),
  });
});

server.registerTool("review_plan", {
  description:
    "Read the CURRENT plan the way set_scenes reads one back, without writing anything: the warnings worth stopping for (an uncovered cutaway, a screen graphic outside its span), the variety read (does the picture keep changing its kind), and the pacing read (how long the viewer waits for the first visual, the longest stretch where nothing changes, titles over the frame's word budget, a short without burned-in captions or without an ending). Use it after the person has edited scenes in the window, or before render_final, to see what the plan looks like now.",
  inputSchema: {},
}, async () => {
  const dir = currentProjectDir();
  const words = cleanWords(dir);
  const config = readComposeConfig(dir);
  const read = readBackPlan(dir, config.scenes ?? [], words, config.theme, config.captions);
  const look = describeLook(config.theme, listSavedThemes(mediaRoot()));
  return ok({
    scenes: (config.scenes ?? []).length,
    format: projectFormat(dir),
    look: look.chosen ? "chosen" : "unchosen",
    warnings: read.warnings,
    variety: read.variety,
    pacing: read.pacing,
  });
});

server.registerTool("read_story", {
  description:
    "Read the clean transcript the way an editor marks up a script before cutting: the paragraphs (by pause and by signpost), the sections with a drafted heading each, the opening (its preamble, and where the promise to the viewer actually arrives), the ending (the conclusion and the ask, if either exists), and every moment whose shape the kit already has a graphic for — a number, a list, a comparison, a question, a definition, a process, a quote, a claim, a warning, a date, a named product or tool, something typed, a call to action — each with its sentence, its word ids and the graphic to try first. It is a reading, not a plan: disagree from the words. Call it once before set_scenes, and before suggest_clips when looking for shorts, instead of holding eight thousand words in your head.",
  inputSchema: {
    limit: z.number().int().min(10).max(200).optional().describe("How many moments at most, 80 by default; the most drawable kinds are kept first"),
  },
}, async ({ limit }) => {
  const dir = currentProjectDir();
  const words = cleanWords(dir);
  const story = readStory(words, { limit: limit ?? 80 });
  return ok({
    ...story,
    format: projectFormat(dir),
    hint: "Sections are where a section heading or a cover belongs; moments are where a card belongs. A moment's first suggestion is a kit kind or a template id (describe_templates); search_images is a suggestion to fetch a picture. Pick the moments that carry the argument, not all of them.",
  });
});

// ---- Changing part of a plan ----
//
// set_scenes replaces the whole thing, which is right when the plan is
// being written and wasteful for every change after that: a twelve-minute
// film's plan is thousands of tokens to resend because one title was dull.
// These three touch what they name and carry the rest through untouched,
// which is also what makes them safe against the person's own edits in the
// window between turns.

// What the plan looks like once it is written: the observations about its
// shape, and the faults that are worth stopping for. Shared by set_scenes
// and the three that edit part of a plan, so a patch is read as carefully
// as a rewrite.
function readBackPlan(dir, scenes, words, themeConfig, captions) {
  const resolved = resolveScenes(scenes, words);
  const duration = words.at(-1)?.end ?? 0;
  const theme = resolveTheme(themeConfig ?? {});
  const shape = resolveFormat(projectFormat(dir));
  const pacing = describePacing(resolved, {
    duration, format: shape.id, shortForm: shape.shortForm, captions: captionMode(captions),
    transition: theme.transition, transitionSeconds: theme.transitionSeconds,
  });
  const warnings = [];
  const spans = readCleanMap(dir)?.screenSpans ?? [];
  resolved.forEach((scene, index) => {
    if (scene.graphic?.kind !== "screen") return;
    const covered = spans.some((span) => span.start <= scene.start + 0.05 && scene.end - 0.05 <= span.end);
    if (!covered) warnings.push(`scene ${index}: screen graphic over ${scene.start.toFixed(1)}–${scene.end.toFixed(1)}s is outside every screen span ${JSON.stringify(spans)}`);
  });
  for (const hidden of hiddenFullStage(resolved, duration, { transition: theme.transition, transitionSeconds: theme.transitionSeconds })) {
    warnings.push(`scene ${hidden.index}: the full-stage ${hidden.kind} is drawn under the head, and the ${hidden.layouts.join("/")} layout puts the head in front of it for ${hidden.seconds}s. Give its span a stage scene with layout cutaway (no camera) or full (the head as a corner card).`);
  }
  const holes = uncoveredCutaways(resolved, duration, { transition: theme.transition, transitionSeconds: theme.transitionSeconds });
  for (const hole of holes) {
    warnings.push(`the camera is off from ${hole.start}s to ${hole.end}s and nothing is on the stage: a cutaway needs a visual over its whole span. Extend the card either side of it, or drop the cutaway there.`);
  }
  return { resolved, warnings, holes, variety: describeVariety(resolved, duration), pacing };
}

const sceneEdits = (dir, mutate) => {
  const words = cleanWords(dir);
  const config = readComposeConfig(dir);
  const edited = config.scenes ?? [];
  const result = mutate(edited);
  // A template named in a patch or an added scene is rendered here, so what
  // is written is always a complete custom graphic.
  const scenes = expandTemplates(edited, { format: projectFormat(dir) });
  validateScenes(scenes, words);
  config.scenes = scenes;
  config.cutIdentity = cleanTranscriptStamp(dir) ?? config.cutIdentity;
  if (!config.cutIdentity) delete config.cutIdentity;
  writeComposeConfig(dir, config);
  const read = readBackPlan(dir, scenes, words, config.theme, config.captions);
  return ok({
    ...result,
    scenes: scenes.length,
    warnings: read.warnings,
    variety: read.variety,
    pacing: read.pacing,
  });
};

// One patch's worth of fields. Everything optional; whatever is absent is
// left exactly as it was, and null clears an optional field.
const scenePatchShape = {
  index: z.number().int().min(0).describe("Which scene, by the index get_scenes reports"),
  from_word_id: z.number().int().min(0).optional().describe("Move the scene's first word"),
  to_word_id: z.number().int().min(0).optional().describe("Move the scene's last word"),
  text: z.string().nullable().optional(),
  subtitle: z.string().nullable().optional(),
  style: z.string().nullable().optional().describe("null returns it to the theme's style"),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  flair: z.boolean().nullable().optional(),
  layout: z.enum([...LAYOUTS]).nullable().optional(),
  corner: z.enum(["br", "bl", "tr", "tl"]).nullable().optional(),
  transition: z.enum([...TRANSITIONS]).nullable().optional(),
  graphic: z.record(z.any()).optional().describe("Fields to merge into the card — only the ones you name change; null on a field clears it. To change a card's kind, give the whole graphic including kind."),
};

const applyPatch = (scene, patch) => {
  const { index, from_word_id, to_word_id, graphic, ...fields } = patch;
  if (from_word_id !== undefined) scene.fromWordId = from_word_id;
  if (to_word_id !== undefined) scene.toWordId = to_word_id;
  for (const [key, value] of Object.entries(fields)) {
    if (value === null) delete scene[key];
    else if (value !== undefined) scene[key] = value;
  }
  if (graphic) {
    scene.graphic = { ...(scene.graphic ?? {}) };
    for (const [key, value] of Object.entries(graphic)) {
      if (value === null) delete scene.graphic[key];
      else scene.graphic[key] = value;
    }
  }
};

server.registerTool("update_scenes", {
  description:
    "Change named fields on named scenes and leave every other scene, and every other field, exactly as it is. This is how to act on a note about the film — a punchier title, a different layout for one passage, a chart's numbers — without resending the plan. Indices come from get_scenes; read it first, because the person edits scenes in the window between your turns. Returns the fresh variety read of the whole plan.",
  inputSchema: { patches: z.array(z.object(scenePatchShape)).min(1).max(60) },
}, async ({ patches }) => {
  const dir = currentProjectDir();
  return sceneEdits(dir, (scenes) => {
    const touched = [];
    for (const patch of patches) {
      const scene = scenes[patch.index];
      if (!scene) throw new Error(`no scene ${patch.index}; get_scenes lists ${scenes.length}`);
      applyPatch(scene, patch);
      touched.push(patch.index);
    }
    return { updated: touched };
  });
});

server.registerTool("add_scenes", {
  description:
    "Add scenes to the plan without touching what is already there. They are inserted in word order, so the plan stays readable. Use it for a beat the film is missing; update_scenes changes one that exists, remove_scenes drops one.",
  inputSchema: { scenes: z.array(optionSceneShape).min(1).max(40) },
}, async ({ scenes: added }) => {
  const dir = currentProjectDir();
  const words = cleanWords(dir);
  const byId = new Map(words.map((word) => [word.id, word]));
  return sceneEdits(dir, (scenes) => {
    const shaped = added.map(shapeScene);
    scenes.push(...shaped);
    scenes.sort((a, b) => (byId.get(a.fromWordId)?.start ?? 0) - (byId.get(b.fromWordId)?.start ?? 0));
    return { added: shaped.length };
  });
});

server.registerTool("remove_scenes", {
  description:
    "Drop scenes by index, leaving the rest of the plan alone. Indices are from get_scenes and are resolved together, so they do not shift under each other.",
  inputSchema: { indices: z.array(z.number().int().min(0)).min(1).max(60) },
}, async ({ indices }) => {
  const dir = currentProjectDir();
  return sceneEdits(dir, (scenes) => {
    const drop = new Set(indices);
    for (const index of drop) if (!scenes[index]) throw new Error(`no scene ${index}; get_scenes lists ${scenes.length}`);
    const kept = scenes.filter((_, index) => !drop.has(index));
    scenes.length = 0;
    scenes.push(...kept);
    return { removed: drop.size };
  });
});

server.registerTool("describe_kit", {
  description:
    "Everything the composition can be made of, in one call: the project's delivery shape and what each layout means in it, transitions, graphic kinds and the fields each one needs, title/callout/caption styles, image motions, caption modes, the theme presets and the vendored fonts. Read it once at the start of a composing session instead of guessing at a name — a wrong `kind` or `style` is a rejected set_scenes and a wasted round trip.",
  inputSchema: {},
}, async () => {
  const format = projectFormatSafe();
  return ok({
  // A layout name means one thing and resolves to two geometries. Read the
  // second half of each line only when the project is vertical.
  format: describeFormats().find((f) => f.id === format),
  formats: describeFormats(),
  layouts: {
    focus: "the head is the picture; the default anywhere no layout is declared. Landscape: large and centred. Vertical: edge to edge, cropped to the tall frame, with anything shown over it in the lower third.",
    pip: "a small corner card; takes a corner (br/bl/tr/tl). Uncropped in both shapes.",
    side: "the visual beside the head. Landscape: head left, content column right. Vertical: head across the top half, cropped, the visual owning the bottom.",
    band: "the head WHOLE, in the recording's own shape, across the width, with the visual under it. In a tall frame this is the shot for a moment a crop would ruin — a wide gesture, a screen, two people. In a landscape film it is close to focus and rarely worth naming.",
    full: "the visuals own the stage, the head a small corner card; takes a corner",
    cutaway: "no camera at all — the visual carries the narration. Cover its whole span with a graphic.",
  },
  cropping: "A vertical film is cut from a landscape recording, so focus and side crop the sides away at compose time. Nothing is baked: band shows the whole frame again, and changing your mind never re-renders the clean cut. preview_frame is how you see what the crop actually took.",
  transitions: Object.fromEntries([...TRANSITIONS].map((name) => [name, {
    glide: "the head travels between layouts; it fades instead where a cutaway leaves nothing to fly to",
    dissolve: "the head fades out, the arrangement changes, it fades back; nothing slides",
    cut: "everything changes on one frame",
  }[name]])),
  transitionSeconds: { default: TRANSITION_SECONDS, range: [0.3, 1.8], note: "set_theme transitionSeconds; the style's own pace unless given" },
  dwell: { minSeconds: 3, minCutawaySeconds: 1.2, note: "a placed segment shorter than this is absorbed into the one before it, so do not plan two boundaries closer than a breath" },
  graphics: {
    chart: "items[{label, value}] — bars grow in",
    stat: "value, label, optional prefix/suffix — one big count-up number",
    list: "items[{label}] — revealed with checks",
    steps: "items[{label}], up to 5 — numbered, joined by a line",
    ring: "value 0–100, label — an arc",
    quote: "text, optional by",
    compare: "left{title, items[]}, right{title, items[]} — two columns and a VS badge",
    image: `src (assets/…), optional label and motion (${[...IMAGE_MOTIONS].join("/")})`,
    logos: "items[{src, label?}] — pictures in a row",
    screen: "the recording's own screen track, in sync; only inside get_framing's screenSpans",
    cover: "WHOLE STAGE: a still edge to edge with title, subtitle, optional tint",
    section: "WHOLE STAGE: a chapter heading — number, title, subtitle",
    custom: "WHOLE STAGE: your own html + css for one moment; scoped, no scripts or external loads. Animate from --q (0→1 over 1.8 s), --p (0→1 over the span) and --alpha; cqw/cqh measure the stage; pictures as assets/name.png",
  },
  sceneTypes: [...SCENE_TYPES],
  titleStyles: [...TITLE_STYLES],
  calloutStyles: [...CALLOUT_STYLES],
  captionStyles: [...CAPTION_STYLES],
  captionModes: [...CAPTION_MODES],
  imageMotions: [...IMAGE_MOTIONS],
  corners: [...CORNERS],
  presets: describePresets(),
  fonts: VENDORED_FONTS,
  templates: `${TEMPLATE_IDS.length} named graphics the kit has no fixed shape for — ${TEMPLATE_IDS.join(", ")} — each filled in from a few fields and laid out for this shape. describe_templates lists the fields; write one as graphic: { kind: "custom", template: "<id>", params: { … } }. Reach for a template before writing html by hand.`,
  editing: "set_scenes writes a whole plan; update_scenes / add_scenes / remove_scenes change part of one and leave the rest alone — use those for every change after the first pass.",
  sound: `set_audio puts a music bed under the voice (import_audio brings the file in), ducked from the transcript's own pauses, and can normalise the voice; audio lives only in the stitch so it costs seconds, not minutes.`,
  reading: "read_story marks the transcript up before you compose (sections, the opening, the ending, every drawable moment); review_plan and every plan write return the variety and pacing reads; preview_sheet tiles the whole film into one picture.",
  craft: `adopt_persona (${PERSONA_IDS.join(" or ")}) hands you the brief and the craft guides for the job at hand; read_craft has the rest, including a visual grammar of what goes with what is said and a set of reference styles.`,
  });
});

server.registerTool("adopt_persona", {
  description:
    "Who you are working as today, and the craft that goes with it. editor: a film editor and storyteller cutting for someone who chose to watch — structure the viewer can feel, the picture before the card, the head as a choice. farmer: a short-form editor cutting for a feed — stop the thumb in the first second and a half, change something every four seconds, end on somewhere to go, make shorts that are funnels to the long film. Returns the persona's brief and the craft guides it reads (docs/craft/), in full. Call it once at the start of a session, or when the work changes from a film to its shorts; the launcher's --persona names the default. The invariants hold whoever you are.",
  inputSchema: {
    persona: z.enum([...PERSONA_IDS]).optional().describe("editor by default; farmer for shorts and anything cut for a feed"),
  },
}, async ({ persona }) => {
  const id = validatePersona(persona);
  const chosen = PERSONAS[id];
  const guides = Object.fromEntries(chosen.reads.map((doc) => [doc, fs.readFileSync(path.join(REPO_ROOT, doc), "utf8")]));
  return ok({
    persona: id,
    label: chosen.label,
    brief: chosen.brief,
    templates: `describe_templates with persona: "${chosen.templates}" lists the graphics this persona reaches for first`,
    guides,
    others: describePersonas().filter((p) => p.id !== id),
    craft: `read_craft names the other guides: ${Object.keys(CRAFT_DOCS).join(", ")}`,
  });
});

server.registerTool("read_craft", {
  description:
    "One of the craft guides under docs/craft/, in full: editor (the film editor's craft: structure, picture before card, rhythm, type), shorts (the short-form farmer's: the first second and a half, every four seconds, the ending, choosing clips), visual-grammar (what to put on the stage for what is being said, kit and templates, both frames), references (widely watched styles described as methods — the explainer, the tech reviewer, the educator, the essay, the broadcast package, the feed, the walkthrough — for when the person says “make it feel like…”). adopt_persona already hands you the two a persona reads; this is for the rest.",
  inputSchema: { guide: z.enum([...Object.keys(CRAFT_DOCS)]) },
}, async ({ guide }) => {
  return ok({ guide, path: CRAFT_DOCS[guide], text: fs.readFileSync(path.join(REPO_ROOT, CRAFT_DOCS[guide]), "utf8") });
});

server.registerTool("describe_templates", {
  description:
    "The named graphics: a timeline, a flow of arrows, before/after, myth and fact, a definition, a code window, keycaps, a progress bar, a ladder, the scales, an alert, a headline, a call to action, a teaser, a receipt, a ranking, a post, a share bar, a phone, the question, the hook line, the big word, the big number, three numbers. Each is a custom graphic already written and laid out for this film's shape, with its moving parts exposed as fields. Use one by writing graphic: { kind: \"custom\", template: \"<id>\", params: { … } } in set_scenes, add_scenes or update_scenes; the html and css are generated and the template id and params stay beside them in get_scenes. Read this before writing a custom graphic by hand — the hand-written one is for a moment none of these fit.",
  inputSchema: {
    persona: z.enum(["editor", "farmer"]).optional().describe("Narrow to the ones an editor or a short-form farmer reaches for; omit for all"),
  },
}, async ({ persona }) => {
  const format = projectFormatSafe();
  return ok({
    format,
    note: "full: true takes the whole stage (pair it with a cutaway or full layout; over focus it covers the face); full: false sits in the layout's content rect beside the head. A template's own default is the right one unless you have a reason. The example on each is a complete params object.",
    templates: describeTemplates({ persona }),
  });
});

// describe_kit is legitimate with no project open — it is what to read before
// there is one — so the shape it describes falls back to the default.
function projectFormatSafe() {
  try { return projectFormat(currentProjectDir()); } catch { return DEFAULT_FORMAT; }
}

server.registerTool("preview_frame", {
  description:
    "Render ONE frame of the composed film to a PNG and return its path, in a couple of seconds and without a render gate. Look at it. This is the only way to see what a composition actually looks like — the numbers in a scene plan do not tell you that a title is unreadable over that footage, that a card is crowded, or that a picture is the wrong one. Give a word id (the frame lands a beat after that word, so entrances have played) or a time. Costs nothing but seconds; use it freely before asking anyone to render.",
  inputSchema: {
    word_id: z.number().int().min(0).optional().describe("Land on the word this id names, a beat in"),
    at_seconds: z.number().min(0).optional().describe("Or an exact time on the clean timeline"),
    width: z.number().int().min(320).max(1920).optional().describe("Picture width, 1280 by default"),
  },
}, async ({ word_id, at_seconds, width }) => {
  const dir = currentProjectDir();
  if (word_id === undefined && at_seconds === undefined) throw new Error("give a word_id or an at_seconds");
  const args = [`--width=${width ?? 1280}`];
  if (word_id !== undefined) args.push(`--word=${word_id}`);
  else args.push(`--at=${at_seconds}`);
  const result = await runFrame(dir, args);
  return ok(result);
});

server.registerTool("preview_sheet", {
  description:
    "Several frames of the composed film tiled into ONE picture, in time order, so the rhythm of a whole passage — or the whole film — can be looked at at once: where the head is, where the cards are, how often the picture changes, whether two cards in a row look like the same card. Give every_seconds to walk the film at that interval (a 106 s film every 8 s is 14 tiles), or a list of at_seconds or word_ids for chosen moments. Tiles are 640 wide by default, which shows arrangement and colour rather than small type; use preview_frame for one moment at full size. Costs a few seconds per tile. The result lists what each tile holds.",
  inputSchema: {
    every_seconds: z.number().min(1).max(120).optional().describe("Walk the film at this interval (at most 48 tiles; a longer film is thinned)"),
    at_seconds: z.array(z.number().min(0)).min(2).max(48).optional().describe("Or exact times on the clean timeline"),
    word_ids: z.array(z.number().int().min(0)).min(2).max(48).optional().describe("Or words, each a beat in"),
    columns: z.number().int().min(1).max(8).optional().describe("Tiles per row; 4 for a wide film, 6 for a tall one"),
    width: z.number().int().min(320).max(1280).optional().describe("Tile width, 640 by default"),
  },
}, async ({ every_seconds, at_seconds, word_ids, columns, width }) => {
  const dir = currentProjectDir();
  const args = [];
  if (every_seconds !== undefined) args.push(`--every=${every_seconds}`);
  else if (word_ids) args.push(`--word=${word_ids.join(",")}`);
  else if (at_seconds) args.push(`--at=${at_seconds.join(",")}`);
  else throw new Error("give every_seconds, at_seconds or word_ids");
  if (columns !== undefined) args.push(`--columns=${columns}`);
  if (width !== undefined) args.push(`--width=${width}`);
  return ok(await runFrame(dir, args));
});

server.registerTool("set_captions", {
  description: "How the film carries its captions: open (burned into the picture in the theme's caption style), closed (not in the picture; an SRT and a VTT are written beside every render for the player to offer as CC), both, or none. Previews at once; a change between open and closed re-renders the chunks.",
  inputSchema: { mode: z.enum([...CAPTION_MODES]) },
}, async ({ mode }) => {
  const dir = currentProjectDir();
  const config = readComposeConfig(dir);
  config.captions = captionMode(mode);
  writeComposeConfig(dir, config);
  return ok({ captions: config.captions });
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
  transition: z.enum([...TRANSITIONS]).optional()
    .describe(`How the picture changes at every layout boundary: dissolve (${TRANSITION_SECONDS.dissolve}s — the head fades out, the arrangement changes, it fades back; nothing slides), glide (${TRANSITION_SECONDS.glide}s — the head travels between rectangles), cut (one frame). A boundary a cutaway touches always dissolves: there is nothing to fly to.`),
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
  description: "The theme presets — each a complete look (field, type, title and callout styles, caption style, glow) — the themes saved for reuse across videos (set_theme save_as / use), and the vendored fonts. Pick one with set_theme and override what the brand needs.",
  inputSchema: {},
}, async () => ok({ presets: describePresets(), saved: listSavedThemes(mediaRoot()).map((s) => ({ id: s.id, name: s.name, theme: s.theme, savedAt: s.savedAt })), fonts: VENDORED_FONTS, titleStyles: [...TITLE_STYLES], calloutStyles: [...CALLOUT_STYLES], captionStyles: [...CAPTION_STYLES], transitions: [...TRANSITIONS] }));

server.registerTool("get_theme", {
  description: "The project's theme as written (preset plus overrides), as resolved (every token the stage uses), and whether anyone actually chose it — an unset theme resolves to the studio preset and is easy to mistake for a decision. Also lists the brands this person has saved. Read before set_theme: the person may have changed it in the window.",
  inputSchema: {},
}, async () => {
  const config = readComposeConfig(currentProjectDir()).theme ?? {};
  return ok({
    config, resolved: resolveTheme(config), look: describeLook(config, listSavedThemes(mediaRoot())),
    assets: listAssets(path.join(currentProjectDir(), "assets")),
  });
});

server.registerTool("set_theme", {
  description:
    "Set the look of the film for consistent branding: a preset, the brand colours, fonts, title/callout/caption styles, a logo watermark and a handle. Fields merge into the current theme (null removes a logo or watermark); reset drops every override and keeps the preset. `use` loads a theme saved earlier (the way a channel keeps every video the same); `save_as` saves the result under a name for the next video. Previews at once in the window; chunks the look touches re-render on the next render_final (the field and glow are part of every chunk, so a new preset or accent re-renders the film).",
  inputSchema: {
    ...themeShape,
    reset: z.boolean().optional().describe("Drop all overrides first"),
    use: z.string().optional().describe("Start from a saved theme (id from list_themes); other fields then apply on top"),
    save_as: z.string().max(40).optional().describe("Save the resulting theme under this name for other projects"),
  },
}, async ({ reset, use, save_as, ...args }) => {
  const dir = currentProjectDir();
  const config = readComposeConfig(dir);
  const patch = themeFromArgs(args);
  let theme = use ? { ...loadTheme(mediaRoot(), use) } : reset ? (config.theme?.preset ? { preset: config.theme.preset } : {}) : { ...(config.theme ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete theme[key];
    else if (key === "fonts") theme.fonts = { ...(theme.fonts ?? {}), ...value };
    else theme[key] = value;
  }
  if (theme.logo?.src && !fs.existsSync(path.join(dir, theme.logo.src))) throw new Error(`no such asset ${theme.logo.src}; fetch_image or list_assets first`);
  validateTheme(theme);
  config.theme = theme;
  writeComposeConfig(dir, config);
  // A saved theme is the look without the project's pictures: a logo lives
  // in one project's assets and would not travel.
  const saved = save_as ? saveTheme(mediaRoot(), save_as, (({ logo, ...rest }) => rest)(theme)) : null;
  return ok({ theme, resolved: resolveTheme(theme), saved: saved ? { id: saved.id, name: saved.name } : undefined });
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
    attribution: z.object({ pageUrl: z.string().url().optional(), author: z.string().optional(), license: z.string().optional() }).optional().describe("Source credit; saved alongside the asset and returned by list_assets"),
  },
}, async ({ url, name, kind, attribution }) => {
  const dir = currentProjectDir();
  const result = await fetchImage({ url, name, attribution, kind: kind ?? "auto", assetsDir: path.join(dir, "assets"), ffmpeg: FFMPEG });
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
  const options = { fresh };
  let output = paths.final;
  if (from_word_id !== undefined || to_word_id !== undefined) {
    const words = cleanWords(dir);
    const byId = new Map(words.map((word) => [word.id, word]));
    const first = byId.get(from_word_id ?? 0);
    const last = byId.get(to_word_id ?? words.at(-1).id);
    if (!first || !last) throw new Error(`word ids must be 0–${words.length - 1}`);
    output = path.join(dir, "out", `preview-${first.id}-${last.id}.mp4`);
    Object.assign(options, { from: Math.max(first.start - 0.5, 0), to: last.end + 0.5, out: output });
  }
  launchJob(dir, jobSpec("final", dir, options), RUNNER);
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

server.registerTool("status", {
  description: "Current project state: what is staged, transcribed, reviewed, and rendered, with cut statistics, whether a look has been chosen (and the brands this person has saved), the running background job if any, what is stale and which tool fixes it. Read it before repeating a step.",
  inputSchema: {},
}, async () => {
  if (!fs.existsSync(pointerFile())) return ok({ project: null, root: mediaRoot(), hint: "no project is open: list_projects shows what exists, switch_project opens one, open_project starts one from a recording" });
  const pointer = readJson(pointerFile());
  const dir = path.join(mediaRoot(), pointer.dir);
  const paths = projectPaths(dir);
  const running = runningJob(dir);
  const progress = readProgress(dir);
  const state = {
    project: pointer.dir,
    title: readProjectMeta(dir).title ?? pointer.dir,
    format: describeFormats().find((f) => f.id === projectFormat(dir)),
    derivedFrom: readProjectMeta(dir).derivedFrom ?? null,
    root: mediaRoot(),
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
  state.look = describeLook(readComposeConfig(dir).theme, listSavedThemes(mediaRoot()));
  state.clean = cleanSummary(dir);
  state.stale = staleness(dir);
  return ok(state);
});

await server.connect(new StdioServerTransport());
