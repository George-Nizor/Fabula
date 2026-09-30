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
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  REPO_ROOT,
  FFMPEG,
  probeDuration,
  measureLoudness,
  probeDimensions,
  probeHasAudio,
  measureSound,
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
  outputs,
  jobSpec,
  launchJob,
  listProjects, describeProject, PROJECT_NAME_RE, readProjectMeta, writeProjectTitle, writeProjectFormat, projectFormat, slugify, cleanTitle,
} from "../scripts/project-state.mjs";
import { FORMAT_IDS, DEFAULT_FORMAT, resolveFormat, describeFormats, stageOf } from "../core/formats.mjs";
import { suggestClips, createShort } from "../scripts/shorts.mjs";
import { describeTemplates, expandTemplates, TEMPLATE_IDS, TEMPLATE_NAMES } from "../core/templates.mjs";
import { readStory, editorialCuts } from "../core/story-engine.mjs";
import { describePacing } from "../core/pacing.mjs";
import { PERSONAS, PERSONA_IDS, CRAFT_DOCS, validatePersona, describePersonas } from "../core/personas.mjs";
import { validateAudio, describeAudio, bedSpans, assetAudioPath, effectSounds, swellWindows, AUDIO_EXTENSIONS, MUSIC_DEFAULTS } from "../core/audio-engine.mjs";
import { chapterList } from "../core/chapters.mjs";
import { hostPath } from "../scripts/host-path.mjs";
import { draftScenes } from "../core/draft-engine.mjs";
import { normalizeCuts, flattenWords, keepWords, totalCutSeconds } from "../core/cut-engine.mjs";
import { punchPlan, punchSpans, DEFAULT_PUNCH_ZOOM } from "../core/shot-engine.mjs";
import { critiqueFilm } from "../core/critic-engine.mjs";
import { searchAudio, fetchAudio, SAFE_LICENSES } from "../scripts/audio-library.mjs";
import { validateScenes, resolveScenes, describeVariety, uncoveredCutaways, emptyPlacedLayouts, hiddenFullStage, overFullStage, absorbedStages, bridgedReturns, captionEmphasis, validateInserts, applyInsertChoice, captionMode, CAPTION_MODES, SCENE_TYPES, GRAPHIC_KINDS, IMAGE_MOTIONS, resolvePhraseCaptions, subtitleFile } from "../core/compose-engine.mjs";
import { takeInbox, pendingInbox } from "../scripts/inbox.mjs";
import { validateFraming } from "../core/framing-engine.mjs";
import { LAYOUTS, TRANSITIONS, TRANSITION_SECONDS, MIN_DWELL_SECONDS as MIN_DWELL_FLOOR, resolveLayoutTimeline } from "../core/stage-engine.mjs";
import { reanchorScenes } from "../core/reanchor.mjs";
import { PRESETS, TITLE_STYLES, CALLOUT_STYLES, CAPTION_STYLES, CORNERS, VENDORED_FONTS, validateTheme, resolveTheme, describeLook, describePresets } from "../core/themes.mjs";
import { fetchImage, searchCommons, listAssets } from "../scripts/images.mjs";
import { listSavedThemes, saveTheme, loadTheme } from "../scripts/theme-store.mjs";
import { configuredProjectsRoot, configuredMusicRoot, engineProjectsRoot, writeMusicRoot } from "../scripts/settings.cjs";
import { INVARIANTS } from "../core/assistant-brief.mjs";
import { validateDirection, directionBrief, describeDirection, directionRefusal, rulesFor, LATITUDE_IDS, LATITUDES } from "../core/direction.mjs";
import { validateMotionDoc, describeMotion, MOTION_LIBS, MOTION_NAME_RE } from "../core/motion.mjs";
import { validateTreatment, describeTreatment } from "../core/treatment.mjs";

// media/ beside the checkout, or the folder fabula.settings.json names; read
// per call so a change made in the window applies to the next tool call.
// FABULA_PROJECTS_ROOT is the test hook: a media root that is not the person's.
const mediaRoot = () => process.env.FABULA_PROJECTS_ROOT || configuredProjectsRoot() || engineProjectsRoot() || path.join(REPO_ROOT, "media");
const pointerFile = () => path.join(mediaRoot(), "current-project.json");

// A write must be atomic with the check of which project is open. The
// person switches projects in the window between the assistant's turns, and
// a `status` a few seconds ago proves nothing about now; a plan written to
// the wrong project is the person's afternoon. So every tool remembers the
// project it last answered for, and a write tool refuses when the pointer
// names a different one: the refusal names both, a read (status) takes the
// new one up, and the write goes through on the next call if it is still
// meant. The tools that move the pointer take it up themselves.
let answeredProject = null;
// Each tool call carries its own record — its name, and the note its line in
// the activity log gets — so calls that run at once (an assistant makes them
// in parallel) never read or write each other's.
const callScope = new AsyncLocalStorage();
const activeToolName = () => callScope.getStore()?.tool ?? null;
function noteActivity(note) {
  const scope = callScope.getStore();
  if (scope) scope.note = note;
}
const READ_TOOLS = new Set([
  "status", "list_projects", "get_scenes", "get_theme", "list_cuts", "get_framing", "get_inserts", "describe_kit", "describe_templates",
  "adopt_persona", "read_craft", "read_story", "review_plan", "review_film", "check_scenes", "preview_frame", "preview_sheet", "film_sheet",
  "list_clean_words", "list_themes", "list_assets", "list_music", "search_images", "suggest_clips", "wait_render", "wait_for_input",
  "get_direction", "get_treatment", "describe_motion", "read_motion", "list_motion", "preview_motion",
]);
const POINTER_TOOLS = new Set(["open_project", "switch_project", "close_project"]);
// Polls that say nothing about the work; the window's log leaves them out.
const QUIET_TOOLS = new Set(["status", "wait_for_input", "list_projects"]);
// Tools that leave the pointer somewhere else than they found it; the
// project they answered for is read back off the file when they finish.
const MOVES_POINTER = new Set([...POINTER_TOOLS, "create_short"]);
let adoptedPersona = null; // adopt_persona in this session; status reports it
// Jobs are launched from the shared specs (scripts/project-state.mjs), the
// same ones the window uses, so the two never drift in arguments.
const RUNNER = { node: process.execPath };
const DEFAULT_WAIT_SECONDS = 25;
// Under the minute most MCP clients allow one request; a longer job is
// waited for by calling again.
const MAX_WAIT_SECONDS = 50;

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
  const activeTool = activeToolName();
  const writing = activeTool !== null && !READ_TOOLS.has(activeTool) && !POINTER_TOOLS.has(activeTool);
  if (writing && answeredProject !== null && answeredProject !== pointer.dir) {
    throw new Error(`the open project changed from "${answeredProject}" to "${pointer.dir}" since the last call — the person switched in the window. Nothing was written. status reads the new project; call ${activeTool} again if it is still meant for "${pointer.dir}", or switch_project back.`);
  }
  answeredProject = pointer.dir;
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

// The window reads both files every half second: write beside and rename,
// so a read never lands on a truncated file.
function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

function writeReview(dir, review) {
  writeJsonAtomic(projectPaths(dir).review, review);
}

function writeComposeConfig(dir, config) {
  writeJsonAtomic(projectPaths(dir).compose, config);
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

// The person's direction for this film (the window's Make it into a video
// sheet writes it), or null when nobody gave one.
// A direction that no longer validates (edited by hand, say) still says how
// closely to hold to the kit: its latitude is kept when it is one, the rest
// falls back to the defaults, and `problem` says what is wrong — status and
// get_direction show it. Reading it as no direction at all let a strict
// film's edits through as if it were guided.
function readDirection(dir) {
  const file = path.join(dir, "direction.json");
  if (!fs.existsSync(file)) return null;
  let raw = null;
  try { raw = readJson(file); } catch (error) {
    return { ...validateDirection({}), problem: `direction.json is not readable JSON (${error.message}); the defaults apply until it is written again` };
  }
  try { return validateDirection(raw); } catch (error) {
    const latitude = typeof raw?.latitude === "string" && LATITUDE_IDS.includes(raw.latitude) ? raw.latitude : undefined;
    return { ...validateDirection({ latitude, startedAt: raw?.startedAt }), problem: `direction.json does not validate (${error.message}); its latitude still applies and the rest are defaults until it is written again` };
  }
}

function readTreatment(dir) {
  const file = path.join(dir, "treatment.json");
  if (!fs.existsSync(file)) return null;
  try { return readJson(file); } catch { return null; }
}

// The optional animation libraries actually installed in this checkout.
const installedMotionLibs = () => Object.entries(MOTION_LIBS).filter(([, lib]) => fs.existsSync(path.join(REPO_ROOT, lib.file))).map(([name]) => name);

// What the plan writes validate against beyond the words: the libraries a
// motion scene may name, and what the person's direction rules out.
function checkPlan(dir, scenes, words) {
  validateScenes(scenes, words, { motionLibs: installedMotionLibs() });
  const refusal = directionRefusal(scenes, readDirection(dir), { existing: onDiskScenes(dir) });
  if (refusal) throw new Error(refusal);
}

function onDiskScenes(dir) {
  try { return readComposeConfig(dir).scenes ?? []; } catch { return []; }
}

// What the window shows while the assistant works: one line per tool call,
// appended to <project>/activity.jsonl. The window reads the tail and turns
// it into the Making panel's phases; nothing else depends on it.
const ACTIVITY_KEEP_LINES = 400;
function recordActivity(dir, entry) {
  if (!dir) return;
  const file = path.join(dir, "activity.jsonl");
  try {
    fs.appendFileSync(file, JSON.stringify(entry) + "\n");
    if (fs.statSync(file).size > 192 * 1024) {
      const all = fs.readFileSync(file, "utf8").trim().split("\n");
      // The window's start mark for the run stays, however long ago: the
      // Making panel reads the run from it.
      const mark = all.slice(0, -ACTIVITY_KEEP_LINES).findLast((line) => line.includes('"mark":"start"'));
      writeTextAtomic(file, [...(mark ? [mark] : []), ...all.slice(-ACTIVITY_KEEP_LINES)].join("\n") + "\n");
    }
  } catch { /* the log is a courtesy to the window; a failed append costs nothing */ }
}

function writeTextAtomic(file, text) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text);
  fs.renameSync(temp, file);
}

const rectSchema = z.object({
  x: z.number().min(0), y: z.number().min(0), w: z.number().positive(), h: z.number().positive(),
}).describe("Pixels in the raw frame");

const waitSchema = z.number().min(0).max(MAX_WAIT_SECONDS).optional()
  .describe(`How long to wait for the job before reporting it as still running (default ${DEFAULT_WAIT_SECONDS}s, at most ${MAX_WAIT_SECONDS}s — a client's request timeout is usually a minute; call again until done)`);

function cleanWords(dir) {
  const paths = projectPaths(dir);
  if (!fs.existsSync(paths.cleanTranscript)) {
    throw new Error("no clean transcript; render_clean then retranscribe_clean first");
  }
  return flattenWords(readJson(paths.cleanTranscript));
}

function ok(payload) {
  // Every answer names the project it is about, so a switch the person made
  // in the window is never taken up silently by a read.
  const named = payload && typeof payload === "object" && !Array.isArray(payload) && payload.project === undefined && answeredProject !== null
    ? { project: answeredProject, ...payload }
    : payload;
  return { content: [{ type: "text", text: JSON.stringify(named, null, 2) }] };
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

The first pass (transcript, framing scan, cut proposals) runs by itself when the window creates a project, and the person reviews the cuts there; your work is the composition. docs/assistant-workflow.md is the whole workflow. adopt_persona (editor for a film, farmer for shorts) hands you the craft for the job; read_story marks the transcript up before you compose and draft_scenes turns it into a skeleton; describe_templates lists the named graphics; every plan write returns variety and pacing reads; review_film is the whole film in one look, render_final draft: true the whole film at half size in a fraction of the time, and film_sheet what the encoder actually wrote.`,
});

// Every tool runs with its name on the record, so currentProjectDir can tell
// a write from a read (see answeredProject).
{
  const register = server.registerTool.bind(server);
  server.registerTool = (name, spec, handler) => register(name, spec, (...args) => callScope.run({ tool: name, note: null }, async () => {
    const scope = callScope.getStore();
    const started = Date.now();
    let failure = null;
    try {
      const answer = await handler(...args);
      // Only a tool that finished takes the pointer up: one that failed
      // moved nothing, and a switch it did not report stays unacknowledged.
      if (MOVES_POINTER.has(name)) {
        try { answeredProject = fs.existsSync(pointerFile()) ? JSON.parse(fs.readFileSync(pointerFile(), "utf8")).dir : null; } catch { /* the next read takes it up */ }
      }
      return answer;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      if (answeredProject !== null && !QUIET_TOOLS.has(name)) {
        recordActivity(path.join(mediaRoot(), answeredProject), {
          at: new Date().toISOString(), tool: name, ms: Date.now() - started, ok: failure === null,
          ...(scope.note ? { note: String(scope.note).slice(0, 160) } : {}),
          ...(failure ? { error: String(failure.message ?? failure).split("\n")[0].slice(0, 200) } : {}),
        });
      }
    }
  }));
}

// A template expanded with the scene's index on any refusal, so "items needs
// 2–5 items" says which scene.
function expandPlan(scenes, context) {
  return scenes.map((scene, index) => {
    try { return expandTemplates([scene], context)[0]; }
    catch (error) { throw new Error(`scene ${index}: ${error.message}`); }
  });
}

// The pictures a plan names must exist before the plan is written, as
// set_audio and set_theme already insist: finding out at the render is late.
function assertAssets(dir, scenes) {
  const missing = (src) => src && !fs.existsSync(path.join(dir, src));
  scenes.forEach((scene, index) => {
    const graphic = scene.graphic;
    if (!graphic) return;
    if (graphic.kind === "motion") {
      if (missing(graphic.src)) throw new Error(`scene ${index}: no motion document ${graphic.src}; write_motion writes one, list_motion shows what exists`);
      return;
    }
    if (missing(graphic.src)) throw new Error(`scene ${index}: no such asset ${graphic.src}; list_assets shows what exists, fetch_image / import_image / search_images bring one in`);
    if (graphic.kind === "clip" && graphic.sound && !probeHasAudio(path.join(dir, graphic.src))) throw new Error(`scene ${index}: ${graphic.src} has no sound track, so sound: true has nothing to play; drop sound, or import_clip the source again (imports before today were made without one)`);
    for (const item of graphic.items ?? []) {
      if (item && typeof item === "object" && missing(item.src)) throw new Error(`scene ${index}: no such asset ${item.src}; list_assets shows what exists`);
    }
  });
}

server.registerTool("open_project", {
  description:
    "Start a project from a recording and make it the open one. The footage is referenced where it lives (never copied); the project folder <root>/<slug>/ holds only derived files, and the review UI is pointed at it. The title is the person's name for it (ask them; the folder is a slug of it). A title that already has a project reopens that project, provided it is the same recording; the same recording under a new title is a new project (list_projects shows what exists). Returns whether a transcript already exists.",
  inputSchema: {
    video_path: z.string().describe("Path to the raw recording (mp4/mov/mkv/webm)"),
    title: z.string().optional().describe("The project's name as the person wants it shown; defaults to the recording's file name"),
    format: z.enum([...FORMAT_IDS]).optional().describe("The shape it is delivered in: landscape (16:9, the default) or vertical (9:16, for Shorts/Reels/TikTok). Ask if the person has not said — it decides the stage and the clean cut's ceiling, and changing it later makes the clean cut stale."),
    name: z.string().optional().describe("Folder name override; normally derived from the title"),
  },
}, async ({ video_path: given, title, format, name }) => {
  const video_path = hostPath(given);
  if (!fs.existsSync(video_path)) throw new Error(`no such file: ${video_path}`);
  const ext = path.extname(video_path).toLowerCase();
  if (!/^\.(mp4|mov|mkv|webm|m4v)$/.test(ext)) throw new Error(`unsupported container: ${ext}`);
  const shown = cleanTitle(title ?? path.basename(video_path, ext));
  const projectName = name ? (name.replace(/[^a-z0-9-_]/gi, "_").replace(/^[^a-z0-9]+/i, "").toLowerCase() || slugify(shown)) : slugify(shown);
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
  answeredProject = projectName;
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
    "Every Fabula project: each folder under the projects root (media/ beside the checkout, or the folder fabula.settings.json names) that stages a recording, most recently touched first, with the stage it has reached (staged, transcribed, cut, clean, composed, final), whether its recording is still where it was, and which one is open. The same list the window's Projects dialog shows.",
  inputSchema: {},
}, async () => {
  const current = fs.existsSync(pointerFile()) ? readJson(pointerFile()).dir : null;
  answeredProject = current;
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
  answeredProject = name;
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
    next: `switch_project ${short.project}, then render_clean and retranscribe_clean (fast — it is ${short.seconds}s of footage), set_theme if this one wants its own, and compose it for the tall frame: focus crops the head to fill, band keeps the whole recording, and a title has room for four words rather than nine.`,
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
  answeredProject = null;
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
    "Run the deterministic cut pass over the current project's transcript: silence gaps and filler words become cut proposals, all enabled. Writes review.json, which the Fabula window renders live. Re-running resets the toggles on its own proposals; cuts the person drew, add_cut and story_cuts survive. Tune min_gap for the speaker: 0.6s is tight and reads fast-cut; conversational delivery usually wants 0.8–1.0s so natural beats survive. The clean cut stays current as long as the resulting cut list is the same as the one it was rendered from — status says.",
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
  // The pass proposes pauses and fillers; everything else in the list — a
  // cut the person drew, add_cut's judgment, story_cuts' proposals — is theirs
  // and survives a retune. Toggles on the pass's own proposals reset.
  if (fs.existsSync(paths.review)) {
    const kept = (readJson(paths.review).cuts ?? []).filter((cut) => (cut.sources ?? [cut]).some((source) => !["silence", "filler", "pause"].includes(source.reason)));
    if (kept.length) review.cuts = normalizeCuts([...review.cuts, ...kept]);
  }
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
  // The scan writes progress.json too; while a job owns that file the scan
  // would take its pid and, finishing first, delete the job's record.
  const busy = runningJob(dir);
  if (busy) throw new Error(`${busy.stage} is running (pid ${busy.pid ?? "?"}); wait_render first, then scan`);
  const paths = projectPaths(dir);
  if (!paths.video) throw new Error("project has no staged video");
  const scan = await withProgress(dir, "framing", "Scanning for the head in the frame", () =>
    scanFraming(paths.video, path.join(dir, "framing")));
  fs.writeFileSync(path.join(dir, "framing-scan.json"), JSON.stringify(scan, null, 2));
  // The scan's proposals as a framing where no judgment is needed — the rule
  // the first pass applies (scripts/job.mjs autoFraming): a run the scan
  // calls "full" may be a camera inset or a plain head, and only a look at
  // the frames tells, so those are left; a plain pillarbox is applied.
  let applied = null;
  if (!fs.existsSync(paths.framing)) {
    if (!scan.runs.some((run) => run.kind === "full" || run.proposal?.screen)) {
      const segments = scan.runs.map((run) => ({ start: run.start, end: run.end, head: run.proposal.head, screen: null }));
      try {
        validateFraming({ segments }, scan.dims, scan.duration);
        fs.writeFileSync(paths.framing, JSON.stringify({ segments }, null, 2));
        applied = { segments: segments.length, stale: fs.existsSync(paths.clean) ? ["clean"] : [] };
      } catch (error) { applied = { refused: error.message }; }
    }
  }
  return ok({
    ...scan,
    applied,
    hint: applied?.segments ? `the proposals were applied as framing.json (${applied.segments} segment(s)); render_clean crops to it. set_framing changes it.`
      : fs.existsSync(paths.framing) ? "framing.json already exists and was kept; set_framing replaces it"
        : applied?.refused ? `the proposals did not validate (${applied.refused}); look at the frames under framing/ and set_framing what you see`
          : "nothing applied: a run the scan calls full may be a camera inset or a plain head — look at the frames under framing/ and set_framing what you see",
  });
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
    const had = fs.existsSync(paths.framing);
    fs.rmSync(paths.framing, { force: true });
    const rendered = had && fs.existsSync(paths.clean);
    return ok({ framing: null, ...(rendered ? { stale: ["clean"], hint: "the clean cut was framed by the segments just removed; render_clean re-renders it unframed" } : { hint: had ? "framing removed; nothing rendered depends on it yet" : "there was no framing to remove" }) });
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

server.registerTool("keep_words", {
  description:
    "Keep a word range (inclusive ids) that a cut proposal struck: every enabled cut over those words is split around them, so the words come back without keeping the whole pause or filler run they sat in. The opposite of add_cut, and finer than set_cut_enabled, which keeps a whole cut. A leftover piece shorter than the pause the engine itself would cut (0.6 s) goes with the words.",
  inputSchema: {
    from_word_id: z.number().int().min(0).describe("First word id to keep"),
    to_word_id: z.number().int().min(0).describe("Last word id to keep (inclusive)"),
  },
}, async ({ from_word_id, to_word_id }) => {
  const dir = currentProjectDir();
  const review = readReview(dir);
  const byId = new Map(review.words.map((word) => [word.id, word]));
  const first = byId.get(from_word_id);
  const last = byId.get(to_word_id);
  if (!first || !last) throw new Error(`word ids must be 0–${review.words.length - 1}`);
  if (last.start < first.start) throw new Error("to_word_id precedes from_word_id");
  const wordIds = review.words.filter((word) => word.start >= first.start && word.end <= last.end).map((word) => word.id);
  const before = review.cuts.filter((cut) => cut.enabled).length;
  review.cuts = keepWords(review.cuts, review.words, wordIds);
  writeReview(dir, review);
  const after = review.cuts.filter((cut) => cut.enabled).length;
  return ok({ kept: wordIds.length, cuts: review.cuts.length, enabledBefore: before, enabledAfter: after, removedSeconds: Number(totalCutSeconds(review.cuts).toFixed(2)) });
});

server.registerTool("story_cuts", {
  description:
    "The cuts an editor makes from reading rather than from the waveform, added to review.json as proposals the person toggles like any other: the preamble before the film promises anything (“hi everyone, welcome back”), a false start (a run of words abandoned and said again at once), a stutter (a word said twice running, close, not for emphasis), a retake (a sentence said and then said again within half a minute with mostly the same words — the earlier take goes). Run it after the first pass and before render_clean. Overlapping proposals merge; re-running adds nothing twice. Say what it struck.",
  inputSchema: {
    kinds: z.array(z.enum(["preamble", "false-start", "stutter", "retake"])).optional().describe("Which to propose; all four by default"),
  },
}, async ({ kinds }) => {
  const dir = currentProjectDir();
  const review = readReview(dir);
  if (!review?.words) throw new Error("no cut list yet: the first pass or cut_pass writes review.json");
  // Proposals already in the list are not added again: re-running adds nothing twice.
  const known = new Set(review.cuts.flatMap((cut) => (cut.sources ?? [cut]).map((source) => `${source.reason}:${source.wordIds?.[0]}`)));
  const found = editorialCuts(review.words, kinds ? { kinds } : {}).filter((cut) => !known.has(`${cut.reason}:${cut.fromWordId}`));
  const byId = new Map(review.words.map((word) => [word.id, word]));
  const pad = 0.04;
  const proposals = found.map((cut) => {
    const first = byId.get(cut.fromWordId);
    const last = byId.get(cut.toWordId);
    return {
      start: Math.max(first.start - pad, 0), end: last.end + pad, reason: cut.reason, detail: cut.detail, enabled: true,
      wordIds: review.words.filter((word) => word.start >= first.start && word.end <= last.end).map((word) => word.id),
    };
  });
  review.cuts = normalizeCuts([...review.cuts, ...proposals]);
  writeReview(dir, review);
  return ok({
    proposed: found.map((cut) => ({ reason: cut.reason, from_word_id: cut.fromWordId, to_word_id: cut.toWordId, detail: cut.detail })),
    stats: reviewStats(review),
    hint: found.length ? "proposals, enabled: the person sees them in the Cut step and can keep any of them; render_clean once the cut is approved" : "nothing to strike from the words",
  });
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
  return ok({ count: words.length, text: words.map((word) => `${word.id}:${word.text}`).join(" "), words: words.map((word) => ({ id: word.id, text: word.text, start: Number(word.start.toFixed(2)), end: Number(word.end.toFixed(2)) })) });
});

server.registerTool("get_scenes", {
  description:
    "Read the CURRENT scene plan — scenes with indices, captions, theme, punch-ins, and the audio block (the bed and the voice's treatment). The person may have tweaked text, accents, layouts, the theme or the punch-ins in the app since the plan was last written, so ALWAYS read this before set_scenes and carry their changes forward; replacing the plan from memory discards their edits.",
  inputSchema: {},
}, async () => {
  const dir = currentProjectDir();
  const config = readComposeConfig(dir);
  return ok({
    scenes: (config.scenes ?? []).map((scene, index) => ({ index, ...scene, ...(scene.insertId ? { insert_id: scene.insertId } : {}) })),
    captions: captionMode(config.captions),
    captionEmphasis: config.captionEmphasis ?? "none",
    theme: config.theme ?? null,
    punch: readPunch(dir),
    audio: config.audio ?? null,
    inserts: (config.inserts ?? []).map((insert) => ({ id: insert.id, chosen: insert.chosen ?? null, note: insert.note ?? null })),
  });
});

// ---- Sound ----

server.registerTool("search_audio", {
  description:
    `Free music and sound effects, from the Openverse index of CC-licensed audio — no account and no key, the same two-step the pictures use: read the list, then import_audio the url you want. Only ${SAFE_LICENSES.toUpperCase()} comes back by default, because the person may monetise what they make here and NC forbids that while ND forbids the derivative a soundtrack arguably is; widening that is a deliberate choice. kind is a duration rule, not the index's category (which is empty on most rows): music is half a minute or longer, effect is a few seconds. Keep the query SHORT — two or three words finds far more than a sentence. Every row carries its licence and author; import_audio saves them beside the file and export_description credits them.`,
  inputSchema: {
    query: z.string().min(2).describe("Two or three words: 'ambient', 'warm piano', 'whoosh', 'soft impact'"),
    kind: z.enum(["music", "effect", "any"]).optional().describe("music: a bed, 30s or longer. effect: a one-shot, 12s or shorter. any: no duration rule"),
    count: z.number().int().min(1).max(20).optional(),
    min_seconds: z.number().min(0).optional(),
    max_seconds: z.number().min(0).optional(),
    license: z.string().optional().describe(`Openverse licence codes, comma separated; ${SAFE_LICENSES} by default. Widen it only when the person has said the film is not monetised.`),
  },
}, async ({ query, kind, count, min_seconds, max_seconds, license }) => {
  const results = await searchAudio({ query, kind: kind ?? "any", count: count ?? 8, minSeconds: min_seconds, maxSeconds: max_seconds, license: license ?? SAFE_LICENSES });
  return ok({
    results,
    hint: results.length
      ? "import_audio with the url and the row's attribution, then set_audio music (a bed) or effects (a one-shot)."
      : "Nothing at that licence and length. Try a shorter query first — a sentence finds nothing where one word finds hundreds.",
  });
});

server.registerTool("import_audio", {
  description:
    "Bring audio into the project's assets/ so set_audio can use it as the bed or as a one-shot effect: mp3, wav, m4a, aac, ogg, flac or opus. Either a file the person already has (path, or library from list_music) or a url from search_audio, which is fetched with its credit written beside it. Returns the project-relative src.",
  inputSchema: {
    url: z.string().optional().describe("A direct audio URL, normally one search_audio returned; the licence and the source page are saved beside the file and export_description credits them"),
    attribution: z.object({ pageUrl: z.string().optional(), author: z.string().optional(), license: z.string().optional(), title: z.string().optional() }).optional().describe("Carry search_audio's row through so the credit is right"),
    path: z.string().optional().describe("Absolute path to the file; a Windows path (E:\\Music\\bed.mp3) or a WSL one, either is fine"),
    library: z.string().optional().describe("Or a name from list_music, relative to the music folder"),
    name: z.string().optional().describe("File name under assets/; the source's own name by default"),
  },
}, async ({ path: given, library, name, url, attribution }) => {
  const dir = currentProjectDir();
  if (url !== undefined) {
    const got = await fetchAudio({ url, name, attribution, assetsDir: path.join(dir, "assets") });
    return ok({ src: got.src, bytes: got.bytes, seconds: probeDuration(path.join(dir, got.src)) ?? null, attribution: got.attribution });
  }
  let source = given === undefined ? undefined : hostPath(given);
  if (library !== undefined) {
    const root = configuredMusicRoot();
    if (!root) throw new Error("no music folder is set; set_music_root first, or give a path");
    source = path.resolve(root, library);
    if (!source.startsWith(path.resolve(root) + path.sep)) throw new Error("a library name stays inside the music folder");
  }
  if (!source) throw new Error("give a path or a library name");
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

server.registerTool("list_music", {
  description:
    "The person's music library: every audio file under the folder fabula.settings.json names as musicRoot (set_music_root sets it), with its folder as a mood or a genre and its length. Nothing is fetched and nothing is chosen for them — Fabula lists what they own or have licensed. import_audio with library: <name> brings one into the project.",
  inputSchema: {
    query: z.string().max(60).optional().describe("A word to match in the file name or its folder"),
    limit: z.number().int().min(1).max(200).optional().describe("How many, 60 by default"),
  },
}, async ({ query, limit }) => {
  const root = configuredMusicRoot();
  if (!root) return ok({ root: null, files: [], hint: "no music folder is set: set_music_root with a folder as the pipeline host sees it (a WSL path on Windows), then list_music again" });
  if (!fs.existsSync(root)) throw new Error(`the music folder ${root} does not exist on the pipeline host`);
  const files = [];
  const walk = (folder, depth) => {
    if (depth > 4 || files.length >= 2000) return;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file, depth + 1);
      else if (AUDIO_EXTENSIONS.test(entry.name)) files.push(file);
    }
  };
  walk(root, 0);
  const needle = (query ?? "").toLowerCase();
  const matched = files
    .filter((file) => !needle || path.relative(root, file).toLowerCase().includes(needle))
    .slice(0, limit ?? 60)
    .map((file) => {
      let seconds = null;
      try { seconds = Number(probeDuration(file).toFixed(1)); } catch { /* unreadable: still listed */ }
      return { name: path.relative(root, file), mood: path.dirname(path.relative(root, file)) === "." ? null : path.dirname(path.relative(root, file)), seconds, bytes: fs.statSync(file).size };
    });
  return ok({ root, total: files.length, files: matched, hint: "import_audio with library: <name> copies one into assets/; then set_audio" });
});

server.registerTool("set_music_root", {
  description: "Where the person's music lives, for list_music: a folder as the pipeline host sees it (a WSL path on Windows, e.g. /mnt/c/Users/me/Music/beds). Recorded in fabula.settings.json beside the projects root; null clears it.",
  inputSchema: { path: z.string().nullable().describe("The folder, or null to clear") },
}, async ({ path: given }) => {
  const folder = given === null ? null : hostPath(given);
  if (folder !== null && !fs.existsSync(folder)) throw new Error(`no such folder on the pipeline host: ${folder}`);
  return ok({ musicRoot: writeMusicRoot(folder) });
});

server.registerTool("set_audio", {
  description:
    `The sound under the voice, and the voice itself. music: a bed from assets/ (import_audio) at level LU under the voice while nobody speaks (${MUSIC_DEFAULTS.level} by default; the file's loudness and the clean cut's are measured so the number means the same for any file), duck LU lower still under the voice (${MUSIC_DEFAULTS.duck}), ramping over ramp seconds (${MUSIC_DEFAULTS.ramp}) either side of every pause the transcript shows — the duck is computed from the words, not guessed from a compressor — faded in and out over fade seconds (${MUSIC_DEFAULTS.fade}), looped to the film's length unless loop is false. voice_loudness normalises the voice to an integrated LUFS target (-16 for a film, -14 for a short; null leaves it as recorded). Sound lives only in the stitch, so changing it re-renders no chunk: render_final after it is seconds, not minutes. music: null removes the bed. Returns what the bed will do and how many pauses it comes up in.`,
  inputSchema: {
    music: z.object({
      src: z.string().describe("assets/…, from import_audio"),
      level: z.number().min(-40).max(0).optional(),
      duck: z.number().min(-40).max(0).optional(),
      ramp: z.number().min(0.1).max(3).optional(),
      fade: z.number().min(0).max(10).optional(),
      loop: z.boolean().optional(),
      spans: z.array(z.object({ from_word_id: z.number().int().min(0), to_word_id: z.number().int().min(0) })).max(40).optional()
        .describe("Confine the bed to these word spans on the clean transcript — the opening, the section marks, the ending — faded at each edge; omit for the whole film; an empty list lifts a confinement"),
    }).nullable().optional().describe("The bed; null removes it; omit to keep the current one"),
    voice_loudness: z.number().min(-30).max(-8).nullable().optional().describe("Integrated LUFS target for the voice; null leaves it as recorded; omit to keep"),
    voice_clean: z.enum(["off", "light", "strong"]).optional().describe("Clean the voice before it is levelled: light takes the room's hum and the desk's rumble down and keeps the voice's air (most recordings); strong is for a poor microphone in a live room and softens sibilance too; off leaves it as recorded. Omit to keep."),
    effects: z.array(z.object({
      src: z.string().describe("assets/…, from import_audio"),
      word_id: z.number().int().min(0).optional().describe("The word it lands on; it starts a breath (0.12s) before, which is where a hit belongs"),
      at_seconds: z.number().min(0).optional().describe("Or an exact second on the clean timeline; a word id survives a re-cut and this does not"),
      level: z.number().min(-40).max(0).optional().describe("dB on the file, -16 by default: under the voice, not beside it"),
      offset: z.number().min(0).optional().describe("Seconds into the file to start from"),
      seconds: z.number().min(0.05).max(8).optional().describe("How much of it to play"),
      lead: z.number().min(0).max(1).optional().describe("Start this many seconds early; 0.12 from a word id, 0 from a second"),
    })).max(40).nullable().optional().describe("The film's one-shot sounds — a whoosh into a section, a soft impact as a card lands. The whole list, replacing what is there; null clears them; omit to keep. They are NOT ducked under the voice (a ducked whoosh is one nobody hears), so keep the level low and land them where nobody is speaking — describeAudio's swell windows are exactly those gaps."),
  },
}, async ({ music, voice_loudness, voice_clean, effects }) => {
  const dir = currentProjectDir();
  const config = readComposeConfig(dir);
  const audio = { ...(config.audio ?? {}) };
  if (music !== undefined) {
    if (music === null) delete audio.music;
    else {
      if (!assetAudioPath(music.src)) throw new Error("music.src must be a project-relative audio file under assets/, e.g. assets/bed.mp3 (import_audio puts one there)");
      if (!fs.existsSync(path.join(dir, music.src))) throw new Error(`no such asset ${music.src}; import_audio first`);
      const { spans, ...rest } = music;
      audio.music = { ...(audio.music?.src === music.src ? audio.music : {}), ...rest };
      // Both loudnesses, measured, so `level` means LU under the voice for
      // any file: the music's once per file, the clean cut's every time
      // the bed is set (the cut may have changed since).
      if (typeof audio.music.loudness !== "number") audio.music.loudness = measureLoudness(path.join(dir, music.src)) ?? undefined;
      if (audio.music.loudness === undefined) delete audio.music.loudness;
      if (spans !== undefined) {
        if (spans.length === 0) delete audio.music.spans;
        else audio.music.spans = spans.map((span) => ({ fromWordId: span.from_word_id, toWordId: span.to_word_id }));
      }
    }
  }
  if (effects !== undefined) {
    if (effects === null || effects.length === 0) delete audio.effects;
    else {
      audio.effects = effects.map((effect) => {
        if (!assetAudioPath(effect.src)) throw new Error(`effect src must be a project-relative audio file under assets/, got ${effect.src}`);
        if (!fs.existsSync(path.join(dir, effect.src))) throw new Error(`no such asset ${effect.src}; import_audio first`);
        const out = { src: effect.src };
        if (Number.isInteger(effect.word_id)) out.wordId = effect.word_id;
        if (typeof effect.at_seconds === "number") out.at = effect.at_seconds;
        for (const key of ["level", "offset", "seconds", "lead"]) if (effect[key] !== undefined) out[key] = effect[key];
        return out;
      });
    }
  }
  if (voice_loudness !== undefined) {
    audio.voice = { ...(audio.voice ?? {}) };
    if (voice_loudness === null) { delete audio.voice.loudness; delete audio.voice.measured; }
    else audio.voice.loudness = voice_loudness;
  }
  if (voice_clean !== undefined) {
    audio.voice = { ...(audio.voice ?? {}) };
    if (voice_clean === "off") delete audio.voice.clean; else audio.voice.clean = voice_clean;
  }
  if (audio.voice && Object.keys(audio.voice).length === 0) delete audio.voice;
  if ((audio.music || audio.voice?.loudness != null) && fs.existsSync(projectPaths(dir).clean)) {
    const measured = measureLoudness(projectPaths(dir).clean);
    if (typeof measured === "number") audio.voice = { ...(audio.voice ?? {}), measured };
  }
  validateAudio(audio);
  const words = fs.existsSync(projectPaths(dir).cleanTranscript) ? cleanWords(dir) : [];
  const duration = words.at(-1)?.end ?? 0;
  if (audio.music?.spans) bedSpans(audio.music, words, duration); // refuses a word the transcript does not have
  if (Object.keys(audio).length) config.audio = audio; else delete config.audio;
  writeComposeConfig(dir, config);
  return ok({ audio: config.audio ?? null, ...describeAudio(config.audio, words, duration), stale: ["final"], hint: "render_final to hear it; the chunks are cached, so only the stitch runs" });
});

// ---- Insert points and the dialogue ----

const optionSceneShape = z.object({
  type: z.enum([...SCENE_TYPES]),
  from_word_id: z.number().int().min(0).optional(),
  to_word_id: z.number().int().min(0).optional(),
  fromWordId: z.number().int().min(0).optional().describe("the same, as get_scenes spells it"),
  toWordId: z.number().int().min(0).optional(),
  index: z.number().int().optional().describe("ignored: get_scenes' own numbering"),
  text: z.string().optional(), subtitle: z.string().optional(), style: z.string().optional(),
  accent: z.string().optional(), flair: z.boolean().optional(),
  layout: z.enum([...LAYOUTS]).optional(), corner: z.enum(["br", "bl", "tr", "tl"]).optional(),
  graphic: z.any().optional(),
});

const shapeScene = (scene) => {
  const { from_word_id, to_word_id, fromWordId, toWordId, index, ...rest } = scene;
  const out = { ...rest, fromWordId: from_word_id ?? fromWordId, toWordId: to_word_id ?? toWordId };
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
      })).min(2).max(4),
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
  // Every option answers to the direction, not only the one applied now: the
  // person can pick any of them in the window, and that path has no check.
  const direction = readDirection(dir);
  const existing = previous.scenes ?? [];
  for (const insert of shaped) {
    for (const option of insert.options) {
      const refusal = directionRefusal(option.scenes, direction, { existing });
      if (refusal) throw new Error(`insert ${insert.id}, option ${option.id}: ${refusal}`);
    }
  }
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
  checkPlan(dir, config.scenes, words);
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
  checkPlan(dir, config.scenes, words);
  writeComposeConfig(dir, config);
  return ok({ id, chosen: option_id, scenes: config.scenes.length });
});

server.registerTool("wait_for_input", {
  description:
    "Wait for the person to do something in the window: choose an option on an insert point, ask for something else on one (type insert-other, with their words), or send a note from the inspector (type message, with their text; when it was written with a scene inspected, `scene` names its index, label and seconds — that scene is what the note is about). Returns the events as soon as there are any, or none after wait_seconds; call it again to keep listening. This is the dialogue: after set_inserts, or when asked to listen, sit in this loop (not unprompted — an idle poll spends the person's usage on nothing); answer an insert-other by adding an option to that insert (set_inserts keeps the rest) and apply_insert it, answer a message by doing what it asks, and say what you did.",
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
    `Replace the project's scene plan (declarative, whole-plan-at-once). Scene types: ${[...SCENE_TYPES].join(", ")}. title carries text, an optional subtitle and a style (${[...TITLE_STYLES].join("/")}; block is the broadcast lower third); callout carries text and a style (${[...CALLOUT_STYLES].join("/")}); styles default to the theme's. graphic carries an animated insert card — kind ${[...GRAPHIC_KINDS].join("/")}: chart (items with numeric values, bars grow in), stat (one big count-up number with prefix/suffix), list (items reveal with checks), image (a still from assets/ with motion ${[...IMAGE_MOTIONS].join("/")}), screen (the recording's own screen track in sync beside the head — only inside get_framing's screenSpans, with a stage pip or side layout), quote (text + by), compare (left/right columns with title and items, a VS badge), steps (numbered items joined by a line), ring (value 0–100 with label, drawn as an arc), logos (items with src pictures from assets/ — fetch_image gets them), and four that take the WHOLE stage: cover (a still edge to edge with a big title and subtitle, optional tint), section (a chapter heading: number, title, subtitle), custom (your own html + css for this one moment: scoped, no scripts or external loads, animate with the CSS variables --q (0→1 over the first 1.8 s), --p (0→1 over the span) and --alpha; cqw/cqh units measure the stage; pictures as assets/name.png), and motion (your own animation written as code — a document under motion/ written by write_motion, drawn at every frame; src "motion/<name>.html", optional params, libs, full, over, fade; describe_motion is the contract). All motion is a pure function of time. stage scenes place the talking head on the canvas for their span — layout focus (the head is the picture: large and centred in a wide frame, edge to edge and cropped in a tall one), pip (small corner card; optional corner br/bl/tr/tl), side (the visual beside the head: a right-hand column in a wide frame, the bottom half in a tall one; corner br/tr puts the head on the right instead), split (split screen: the head fills one half of the frame edge to edge, cropped like a picture, the visual owns the other half; corner br/tr puts the head on the right, and in a tall frame bl/br puts it in the bottom half), band (the head WHOLE in the recording's own shape across the width, the visual under it — the shot for a wide moment a vertical crop would ruin), cutaway (camera completely hidden, narration continues; use for B-roll and explanatory diagrams — it gets full's content rect), or full (the visuals own the stage, the head a small corner card; pair it with cover/section/custom) — anywhere undeclared, the head holds focus. describe_kit says which shape this project is and what each layout means in it. How each boundary is crossed is the look's transition (set_theme): dissolve fades the head out and back without moving it, glide flies it between rectangles, cut changes everything on one frame; a stage scene may name its own to override the film's for that one boundary. The engine bridges returns to focus shorter than 3 s and absorbs placed segments shorter than that, so do not plan flights closer together than a breath. Scenes anchor to clean-transcript word ids; captions turns phrase captions on (their look is the theme's captionStyle). Theme and punch-ins are kept unless given; set_theme owns the look. The Compose tab previews everything live; render_final bakes it, re-rendering only the chunks that changed.`,
  inputSchema: {
    scenes: z.array(z.object({
      type: z.enum([...SCENE_TYPES]),
      from_word_id: z.number().int().min(0).optional(),
      to_word_id: z.number().int().min(0).optional(),
      fromWordId: z.number().int().min(0).optional().describe("the same, as get_scenes spells it — a plan read back can be sent back as it is"),
      toWordId: z.number().int().min(0).optional(),
      insertId: z.string().optional(),
      index: z.number().int().optional().describe("ignored: get_scenes' own numbering"),
      text: z.string().min(1).optional().describe("title/callout text"),
      subtitle: z.string().max(80).optional().describe("title only: a second line (the block style shows it on an ink strip)"),
      style: z.string().optional().describe(`title: ${[...TITLE_STYLES].join("/")}; callout: ${[...CALLOUT_STYLES].join("/")}; omit for the theme's default`),
      accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("per-scene accent override"),
      flair: z.boolean().optional().describe("title only: a particle burst behind the text"),
      insert_id: z.string().optional().describe("the insert point this scene was chosen for (carried from get_scenes; do not invent)"),
      layout: z.enum([...LAYOUTS]).optional().describe("stage scenes only"),
      corner: z.enum(["br", "bl", "tr", "tl"]).optional().describe("stage scenes: the corner for pip/full; on side and split, r (br/tr) puts the head on the right, and on a tall split b (bl/br) puts it at the bottom"),
    transition: z.enum([...TRANSITIONS]).optional().describe("stage scenes only: how this one boundary is crossed, overriding the theme's transition for it"),
      graphic: z.object({
        kind: z.enum([...GRAPHIC_KINDS]),
        title: z.string().optional(),
        value: z.number().optional().describe("stat: counts up in its own precision (3.99 keeps cents); ring: 0–100"),
        prefix: z.string().max(4).optional().describe("stat only: text before the number, e.g. $"),
        suffix: z.string().max(6).optional().describe("stat/ring: text after the number, e.g. % or k (ring defaults to %)"),
        label: z.string().optional().describe("stat/ring label; image or screen caption"),
        src: z.string().optional().describe("image: project-relative png/jpg/webp, e.g. assets/still.png; clip: assets/….mp4 from import_clip"),
        motion: z.enum([...IMAGE_MOTIONS]).optional().describe("image only: tilt (default), kenburns, pop"),
        in: z.number().min(0).optional().describe("clip only: seconds into the clip to start from"),
        fit: z.enum(["cover", "contain"]).optional().describe("clip only: fill the card (default) or fit inside it"),
        sound: z.union([z.boolean(), z.object({ level: z.number().min(-40).max(0).optional() })]).optional().describe("clip only: the clip's own sound under the voice, true or { level } in dB on the file"),
        text: z.string().max(220).optional().describe("quote only: the quotation"),
        by: z.string().max(60).optional().describe("quote only: who said it"),
        subtitle: z.string().max(80).optional().describe("cover/section: the second line"),
        number: z.string().max(6).optional().describe("section: a chapter number or short mark"),
        tint: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("cover: colour of the shade over the still"),
        html: z.string().max(20000).optional().describe("custom only: the markup"),
        css: z.string().max(10000).optional().describe("custom only: styles, scoped to the card"),
        full: z.boolean().optional().describe("custom/motion: false keeps it inside the layout's content rect instead of the whole stage"),
        over: z.boolean().optional().describe("custom/motion: draw it OVER the head rather than under — words on the face, with the shade the thumbnail template draws; the first frame of a short, a line over a focus shot. Under a cutaway it makes no difference."),
        libs: z.array(z.string()).max(4).optional().describe("motion only: optional animation libraries the document uses (describe_motion lists the installed ones)"),
        seed: z.number().int().optional().describe("motion only: the seed for fabula.random and Math.random; the src by default"),
        fade: z.boolean().optional().describe("motion only: false turns off the card's own fade in and out — the scene makes its own entrance"),
        template: z.enum([...TEMPLATE_NAMES]).optional().describe("custom only: a named graphic from describe_templates, filled in from params; html and css are generated"),
        params: z.record(z.any()).optional().describe("custom: the template's fields; motion: the values the document reads as fabula.params"),
        left: z.object({ title: z.string().min(1), items: z.array(z.object({ label: z.string().min(1) })).min(1).max(5) }).optional().describe("compare only"),
        right: z.object({ title: z.string().min(1), items: z.array(z.object({ label: z.string().min(1) })).min(1).max(5) }).optional().describe("compare only"),
        items: z.array(z.object({
          label: z.string().min(1).optional().describe("chart/list/steps rows; a caption under a logo"),
          value: z.number().optional().describe("chart only"),
          src: z.string().optional().describe("logos only: project-relative picture"),
        })).max(6).optional().describe("chart/list/steps/logos rows"),
      // A field the schema does not name reaches the engine's own validation
      // rather than vanishing: a plan read back keeps everything it carried.
      }).passthrough().optional().describe("graphic scenes only"),
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
  const shaped = expandPlan(scenes.map((scene) => ({
    type: scene.type,
    fromWordId: scene.from_word_id ?? scene.fromWordId,
    toWordId: scene.to_word_id ?? scene.toWordId,
    text: scene.text,
    subtitle: scene.subtitle,
    style: scene.style,
    accent: scene.accent,
    flair: scene.flair,
    layout: scene.layout,
    corner: scene.corner,
    transition: scene.transition,
    graphic: scene.graphic,
    ...((scene.insert_id ?? scene.insertId) ? { insertId: scene.insert_id ?? scene.insertId } : {}),
  })), { format: projectFormat(dir) });
  checkPlan(dir, shaped, words);
  assertAssets(dir, shaped);
  const previous = readComposeConfig(dir);
  const mergedTheme = theme ? { ...(previous.theme ?? {}), ...theme } : previous.theme;
  validateTheme(mergedTheme);
  // Everything the plan was not given — the sound, the caption emphasis,
  // whatever set_audio and set_captions wrote — travels through untouched.
  const config = {
    ...previous,
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
  const look = describeLook(config.theme, listSavedThemes(mediaRoot()), { direction: readDirection(dir) });
  if (!look.chosen && shaped.length > 0 && look.hint) warnings.push(look.hint);
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
  const look = describeLook(config.theme, listSavedThemes(mediaRoot()), { direction: readDirection(dir) });
  return ok({
    scenes: (config.scenes ?? []).length,
    format: projectFormat(dir),
    look: look.chosen ? "chosen" : "unchosen",
    // Where each scene actually is in seconds, after the seams and the dwell
    // rule: a card's layout may hold past its last word.
    spans: read.resolved.map((scene, index) => ({ index, type: scene.type, layout: scene.layout, kind: scene.graphic?.template ?? scene.graphic?.kind, start: Number(scene.start.toFixed(2)), end: Number(scene.end.toFixed(2)) })),
    warnings: read.warnings,
    variety: read.variety,
    pacing: read.pacing,
  });
});

server.registerTool("draft_scenes", {
  description:
    "A first draft of the plan from the story reading, so composing starts from a skeleton rather than a blank: the promise as a hook over the opening (in a short, the thumbnail over the face at frame one), a section mark at every turn in a film, a card at the moments that carry their own text (a question, a quote, a warning, a claim, a name, a number said aloud), the conclusion as the spoken word, the ask as a cta in a short — spaced by the persona's density, in the film's shape, with every cutaway covered and nothing hidden behind the head. It quotes the speaker and invents nothing but two named placeholders — a short's thumbnail line and its cta's line — and where a moment wants judgment (a chart's values, a definition's meaning, a picture, a moment under another scene) it says so in todo. With apply: false (the default) it returns the scenes for you to edit and set_scenes; with apply: true it writes them as the plan and returns the read-back. Either way the draft is yours to rework; the person's existing plan is replaced only when you apply.",
  inputSchema: {
    persona: z.enum(["editor", "farmer"]).optional().describe("Density and shape of the draft; editor by default, farmer for a short"),
    apply: z.boolean().optional().describe("Write the draft as the plan (replacing the current scenes) and read it back"),
  },
}, async ({ persona, apply }) => {
  const dir = currentProjectDir();
  const words = cleanWords(dir);
  const shape = resolveFormat(projectFormat(dir));
  const who = persona ?? (shape.shortForm ? "farmer" : "editor");
  const draft = draftScenes(words, { format: shape.id, shortForm: shape.shortForm, persona: who, title: readProjectMeta(dir).title ?? "" });
  const expanded = expandTemplates(draft.scenes, { format: shape.id });
  validateScenes(expanded, words);
  if (!apply) {
    const read = readBackPlan(dir, expanded, words, readComposeConfig(dir).theme, readComposeConfig(dir).captions);
    return ok({
      persona: who, applied: false,
      scenes: draft.scenes.map((scene) => ({ ...scene, from_word_id: scene.fromWordId, to_word_id: scene.toWordId, fromWordId: undefined, toWordId: undefined })),
      todo: draft.todo, notes: draft.notes, story: draft.story,
      warnings: read.warnings, variety: read.variety, pacing: read.pacing,
      hint: "Edit what you disagree with and set_scenes the result, or call again with apply: true to write it as it is and refine with update_scenes.",
    });
  }
  const config = readComposeConfig(dir);
  config.scenes = expanded;
  config.cutIdentity = cleanTranscriptStamp(dir) ?? config.cutIdentity;
  if (!config.cutIdentity) delete config.cutIdentity;
  writeComposeConfig(dir, config);
  const read = readBackPlan(dir, expanded, words, config.theme, config.captions);
  return ok({ persona: who, applied: true, scenes: expanded.length, todo: draft.todo, notes: draft.notes, warnings: read.warnings, variety: read.variety, pacing: read.pacing });
});

server.registerTool("critique_film", {
  description:
    "Everything wrong with this film that can be measured, as a list of findings worst first: shots too short to read, scraps of footage between two cuts, cuts that remove nothing, silence at either end, pauses the cut left in, pictures floating in an empty frame, a voice nothing is levelling, a film out of date with its own plan or rendered in the wrong shape, plus the plan's own warnings and its variety and pacing reads. Every finding says what it is, why it reads badly, and the call that fixes it. It measures the rendered film's sound when one exists (a few seconds; sound: false skips it). This is the half of a review that needs no taste — run it before every render and after the person has been editing, and fix the faults before arguing about the notes. The half that DOES need taste is docs/craft/critic.md and your own eyes on preview_sheet and film_sheet: whether the picture earns its place, whether the hook is a promise the film keeps. There is deliberately no score out of a hundred; a count of faults cannot be gamed.",
  inputSchema: {
    sound: z.boolean().optional().describe("Measure the rendered film's loudness and true peak; true by default when a film exists"),
  },
}, async ({ sound }) => {
  const dir = currentProjectDir();
  return ok(critiqueNow(dir, { sound }));
});

// The measurable review of the film as it stands: critique_film's answer,
// and the gate a By the book direction puts in front of the real render.
function critiqueNow(dir, { sound } = {}) {
  const shape = resolveFormat(projectFormat(dir));
  const words = cleanWords(dir);
  const config = readComposeConfig(dir);
  const paths = projectPaths(dir);
  const duration = filmDuration(dir, words);
  const scenes = resolveScenes(config.scenes ?? [], words, { durationSeconds: duration });
  const read = readBackPlan(dir, config.scenes ?? [], words, config.theme, config.captions);
  // The engine takes three lists; readBackPlan carries pacing as stats plus
  // notes, and only the notes are findings.
  const plan = { warnings: read.warnings ?? [], variety: read.variety ?? [], pacing: read.pacing?.notes ?? [] };

  // The keeps and the shots as the clean render actually wrote them.
  const pieces = readCleanMap(dir)?.pieces ?? [];
  const keeps = [];
  for (const piece of pieces) {
    const last = keeps.at(-1);
    if (last && last.keepIndex === piece.keepIndex) { last.end = piece.cleanEnd; continue; }
    keeps.push({ keepIndex: piece.keepIndex, start: piece.cleanStart, end: piece.cleanEnd });
  }
  const spans = config.punch ? punchSpans(pieces, config.punch.zoom ?? DEFAULT_PUNCH_ZOOM) : [];
  const review = fs.existsSync(paths.review) ? readJson(paths.review) : null;
  const cuts = (review?.cuts ?? []).filter((cut) => cut.enabled);

  // Every picture the plan places, at the size it actually is.
  const assets = {};
  for (const scene of scenes) {
    const src = scene.graphic?.kind === "image" ? scene.graphic.src : null;
    if (!src || assets[src]) continue;
    try { assets[src] = probeDimensions(path.join(dir, src)); } catch { /* unreadable; no finding rather than a wrong one */ }
  }

  const exists = fs.existsSync(paths.final);
  const output = { exists, stale: staleness(dir) };
  if (exists) {
    try { Object.assign(output, probeDimensions(paths.final)); } catch { /* leave the shape unknown */ }
    try { output.seconds = probeDuration(paths.final); } catch { /* leave the length unknown */ }
  }

  const audio = {
    target: config.audio?.voice?.loudness ?? null,
    measured: (() => {
      // A clean render that could not measure the voice writes no file.
      const file = path.join(dir, "out", "clean-audio.json");
      try { return fs.existsSync(file) ? readJson(file)?.voiceLoudness ?? null : null; } catch { return null; }
    })(),
    music: config.audio?.music ?? null,
    effectsAt: effectSounds(config.audio?.effects, words, { from: 0, span: duration }),
    swells: swellWindows(words, duration).length,
  };
  if (exists && sound !== false) {
    const heard = measureSound(paths.final);
    Object.assign(audio, { rendered: heard.integrated, truePeak: heard.truePeak, range: heard.range, noiseFloor: heard.noiseFloor });
  }

  return {
    ...critiqueFilm({ format: shape, words, keeps, punchSpans: spans, cuts, scenes, plan, audio, output, assets, seconds: duration }),
    looked: { seconds: Number(duration.toFixed(2)), keeps: keeps.length, shots: spans.length, scenes: scenes.length, pictures: Object.keys(assets).length, rendered: exists, pacing: read.pacing?.stats ?? null },
    hint: "Fix every fault, then look at preview_sheet or film_sheet yourself for the half this cannot measure — docs/craft/critic.md is the judgment that goes with it.",
  };
}

server.registerTool("review_film", {
  description:
    "The whole film in one look: the current plan's warnings, variety and pacing reads (review_plan), the chapter list it would export, the sound under it, and a contact sheet across the film (preview_sheet, every N seconds, a dozen tiles by default) — one call before a render, or after the person has been editing in the window. Look at the sheet.",
  inputSchema: {
    every_seconds: z.number().min(1).max(120).optional().describe("Sheet interval; the film's length over twelve by default"),
    sheet: z.boolean().optional().describe("false skips the sheet when only the reads are wanted"),
  },
}, async ({ every_seconds, sheet }) => {
  const dir = currentProjectDir();
  const words = cleanWords(dir);
  const config = readComposeConfig(dir);
  const scenes = resolveScenes(config.scenes ?? [], words, { durationSeconds: filmDuration(dir, words) });
  const read = readBackPlan(dir, config.scenes ?? [], words, config.theme, config.captions);
  const duration = filmDuration(dir, words);
  const chapters = chapterList({ scenes, words, title: openingTitle(scenes) ?? readProjectMeta(dir).title ?? "Introduction", duration });
  const out = {
    format: projectFormat(dir), seconds: Number(duration.toFixed(1)), scenes: (config.scenes ?? []).length,
    warnings: read.warnings, variety: read.variety, pacing: read.pacing,
    chapters: chapters.text.trim().split("\n").filter(Boolean), chaptersEnough: chapters.enough,
    sound: describeAudio(config.audio, words, duration),
    captions: { mode: captionMode(config.captions), emphasis: config.captionEmphasis ?? "none" },
  };
  // The film as it sounds, measured — the one sense the sheet cannot give.
  // The newer of the film and its draft; and whether the plan moved since.
  const heard = ["final.mp4", "draft.mp4"].map((name) => path.join(dir, "out", name)).filter((file) => fs.existsSync(file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (heard) {
    const measured = measureSound(heard);
    const notes = [];
    const voice = config.audio?.voice ?? {};
    const target = voice.loudness ?? null;
    const planMoved = fs.existsSync(projectPaths(dir).compose) && fs.statSync(projectPaths(dir).compose).mtimeMs > fs.statSync(heard).mtimeMs;
    if (planMoved) notes.push(`${path.basename(heard)} predates the plan's last change; what follows measures the film as it was`);
    if (typeof measured.integrated === "number") {
      if (target !== null && Math.abs(measured.integrated - target) > 1) notes.push(typeof voice.measured === "number"
        ? `the film measures ${measured.integrated} LUFS against a ${target} target; render_final again (the stitch re-measures and trims)`
        : `the film measures ${measured.integrated} LUFS against a ${target} target; set_audio again so the clean cut is measured and the stitch can hit it exactly`);
      if (target === null && measured.integrated < -20) notes.push(`the film measures ${measured.integrated} LUFS with no target set; platforms sit near -14 to -16 — set_audio voice_loudness`);
    }
    if (typeof measured.truePeak === "number" && measured.truePeak > -1) notes.push(`true peak ${measured.truePeak} dBFS is over the -1 dBFS platforms want; a lower voice target or the limiter's ceiling`);
    // The floor is the room only when nothing else is under the voice.
    const underneath = Boolean(config.audio?.music) || scenes.some((scene) => scene.graphic?.kind === "clip" && scene.graphic.sound);
    if (typeof measured.noiseFloor === "number" && measured.noiseFloor > -55 && !underneath && (voice.clean ?? "off") === "off") notes.push(`the noise floor is ${measured.noiseFloor} dB — a room is audible under the words; set_audio voice_clean light`);
    if (underneath) notes.push(`the floor measured includes ${config.audio?.music ? "the music bed" : "a clip's own sound"}, not only the room`);
    out.sound.measured = { file: path.basename(heard), ...measured, notes };
  }
  if (sheet !== false && fs.existsSync(projectPaths(dir).clean) && duration > 0) {
    const every = every_seconds ?? Math.max(1, Math.round(duration / 12));
    out.sheet = await runFrame(dir, [`--every=${every}`, `--width=${projectFormat(dir) === "vertical" ? 360 : 480}`]);
  } else out.sheet = null;
  return ok(out);
});

server.registerTool("read_story", {
  description:
    "Read the clean transcript the way an editor marks up a script before cutting: the paragraphs (by pause and by signpost), the sections with a drafted heading each, the opening (its preamble, and where the promise to the viewer actually arrives), the ending (the conclusion and the ask, if either exists), and every moment whose shape the kit already has a graphic for — a number, a list, a comparison, a question, a definition, a process, a quote, a claim, a warning, a date, a named product or tool, something typed, a call to action — each with its sentence, its word ids and the graphic to try first. It is a reading, not a plan: disagree from the words. Call it once before set_scenes, and before suggest_clips when looking for shorts, instead of holding eight thousand words in your head.",
  inputSchema: {
    limit: z.number().int().min(10).max(200).optional().describe("How many moments at most, 80 by default; the most drawable kinds are kept first"),
    transcript: z.enum(["clean", "raw"]).optional().describe("clean (the default: word ids for scenes) or raw (the recording's own transcript, word ids for add_cut — read it before the clean render to strike the preamble, a false start, a tangent)"),
  },
}, async ({ limit, transcript }) => {
  const dir = currentProjectDir();
  const raw = transcript === "raw";
  let words;
  if (raw) {
    // The recording's own words: through review.json when a cut list exists
    // (the same ids add_cut takes), else straight from the transcript.
    const paths = projectPaths(dir);
    if (fs.existsSync(paths.review)) words = readJson(paths.review).words;
    else if (fs.existsSync(paths.transcript)) words = flattenWords(readJson(paths.transcript));
    else throw new Error("no transcript yet: transcribe first");
    if (!words?.length) throw new Error("the raw transcript has no words");
  } else words = cleanWords(dir);
  const story = readStory(words, { limit: limit ?? 80 });
  return ok({
    ...story,
    transcript: raw ? "raw" : "clean",
    wordIdsFor: raw ? "add_cut and list_cuts" : "set_scenes, suggest_clips and set_audio",
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

// The film's own title, when the plan opens on a title card: the 0:00 chapter
// is that, not the project's working name.
function openingTitle(scenes) {
  const first = scenes.find((scene) => scene.type === "title" && scene.start <= 1.0 && typeof scene.text === "string" && scene.text.trim());
  return first ? first.text.trim() : null;
}

// The film's length as the render measures it — the clean cut's, when it
// exists — so every read of a plan settles the layout timeline the way the
// export and the window will. The last word's end is the length before the
// clean cut is rendered.
const durationCache = new Map();
function filmDuration(dir, words) {
  const clean = projectPaths(dir).clean;
  try {
    const stat = fs.statSync(clean);
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    const hit = durationCache.get(clean);
    if (hit?.stamp === stamp) return hit.duration;
    const duration = probeDuration(clean);
    durationCache.set(clean, { stamp, duration });
    return duration;
  } catch {
    return words.at(-1)?.end ?? 0;
  }
}

// What the plan looks like once it is written: the observations about its
// shape, and the faults that are worth stopping for. Shared by set_scenes
// and the three that edit part of a plan, so a patch is read as carefully
// as a rewrite.
function readBackPlan(dir, scenes, words, themeConfig, captions) {
  const duration = filmDuration(dir, words);
  const resolved = resolveScenes(scenes, words, { durationSeconds: duration });
  const theme = resolveTheme(themeConfig ?? {});
  const shape = resolveFormat(projectFormat(dir));
  // The timeline as the painter settles it: the frame's shape decides
  // whether two corners are one placement.
  const timing = { transition: theme.transition, transitionSeconds: theme.transitionSeconds, stage: shape.stage };
  const pacing = describePacing(resolved, {
    duration, format: shape.id, shortForm: shape.shortForm, captions: captionMode(captions),
    ...timing,
  });
  const warnings = [];
  const spans = readCleanMap(dir)?.screenSpans ?? [];
  resolved.forEach((scene, index) => {
    if (scene.graphic?.kind !== "screen") return;
    const covered = spans.some((span) => span.start <= scene.start + 0.05 && scene.end - 0.05 <= span.end);
    if (!covered) warnings.push(spans.length
      ? `scene ${index}: screen graphic over ${scene.start.toFixed(1)}–${scene.end.toFixed(1)}s is outside every screen span (${spans.map((s) => `${s.start.toFixed(1)}–${s.end.toFixed(1)}s`).join(", ")})`
      : `scene ${index}: a screen graphic, but the recording has no screen track (detect_framing found no screen beside the head)`);
  });
  for (const hidden of hiddenFullStage(resolved, duration, timing)) {
    warnings.push(`scene ${hidden.index}: the full-stage ${hidden.kind} is drawn under the head, and the ${hidden.layouts.join("/")} layout puts the head in front of it for ${hidden.seconds}s. Give its span a stage scene with layout cutaway (no camera) or full (the head as a corner card).`);
  }
  for (const short of absorbedStages(resolved, duration)) {
    warnings.push(`scene ${short.index}: a ${short.layout} layout of ${short.seconds}s is under the ${short.floor}s dwell floor and will be absorbed into its neighbour; a card planned for it lands wherever the neighbour puts cards. Give it more words, or drop the stage scene.`);
  }
  for (const gap of bridgedReturns(resolved, duration)) {
    warnings.push(`the return to the head from ${gap.start}s to ${gap.end}s (${gap.seconds}s, between scenes ${gap.after} and ${gap.before}) is under the ${MIN_DWELL_FLOOR}s dwell floor, so the ${gap.layout} layout holds through it and the face never shows. If the face was meant there, end scene ${gap.after} earlier so the return lasts ${MIN_DWELL_FLOOR}s or more; if not, extend it to meet scene ${gap.before}.`);
  }
  for (const over of overFullStage(resolved)) {
    warnings.push(`scene ${over.index}: the ${over.type} sits over the full-stage ${over.card} for ${over.seconds}s and lands on its text. Put the words in the card, or move the ${over.type} to a moment the head holds.`);
  }
  const clips = resolved.map((scene, index) => ({ scene, index })).filter(({ scene }) => scene.graphic?.kind === "clip");
  for (const { scene, index } of clips) {
    let length = null;
    try { length = probeDuration(path.join(dir, scene.graphic.src)); } catch { length = null; }
    const needed = (scene.graphic.in ?? 0) + (scene.end - scene.start);
    if (length !== null && needed > length + 0.05) {
      warnings.push(`scene ${index}: the clip ${scene.graphic.src} is ${length.toFixed(1)}s and the card asks for ${needed.toFixed(1)}s from ${(scene.graphic.in ?? 0).toFixed(1)}s in; it holds its last frame for the rest${scene.graphic.sound ? ", and its sound stops dead where the file ends" : ""}. Shorten the scene, or start it earlier in the clip.`);
    }
    const other = clips.find((c) => c.index > index && c.scene.start < scene.end && scene.start < c.scene.end);
    if (other) warnings.push(`scene ${index} and scene ${other.index}: two clips at once; only the first is drawn. Give them different words.`);
  }
  resolved.forEach((scene, index) => {
    const graphic = scene.graphic;
    if (!graphic) return;
    // A motion scene over the head is a choice the scene can make good on:
    // it is told where the head is and can frame it or point at it.
    if (graphic.over && graphic.kind !== "motion" && !["thumbnail", "cta", "lower-third"].includes(graphic.template)) {
      warnings.push(`scene ${index}: over: true draws the ${graphic.template ?? graphic.kind} on top of the head; only thumbnail, cta (with a shade) and lower-third are made for the face. Drop over, and give it a cutaway or full stage scene.`);
    }
    if (graphic.template === "lower-third" && !graphic.over) {
      warnings.push(`scene ${index}: a lower-third under the head is hidden by it; give it over: true.`);
    }
    if (graphic.template === "cta" && !shape.shortForm) {
      warnings.push(`scene ${index}: a cta in the long film; the ask belongs in a short, and a film ends on the head or the spoken word (docs/craft/editor.md).`);
    }
  });
  const holes = uncoveredCutaways(resolved, duration, timing);
  for (const hole of holes) {
    warnings.push(`the camera is off from ${hole.start}s to ${hole.end}s and nothing is on the stage: a cutaway needs a visual over its whole span. Extend the card either side of it, or drop the cutaway there.`);
  }
  for (const empty of emptyPlacedLayouts(resolved, duration, timing)) {
    warnings.push(`the ${empty.layout} layout holds from ${empty.start}s to ${empty.end}s with nothing in the room it makes: the head is made small for nothing. Extend the card to the layout's end, or end the stage scene with the card (a short return to the head before the next layout is bridged away, so the layout stays).`);
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
  const scenes = expandPlan(edited, { format: projectFormat(dir) });
  checkPlan(dir, scenes, words);
  assertAssets(dir, scenes);
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
  corner: z.enum(["br", "bl", "tr", "tl"]).nullable().optional().describe("pip/full: the corner; side/split: br/tr puts the head on the right"),
  transition: z.enum([...TRANSITIONS]).nullable().optional(),
  fromWordId: z.number().int().min(0).optional().describe("The same as from_word_id, as get_scenes spells it"),
  toWordId: z.number().int().min(0).optional().describe("The same as to_word_id, as get_scenes spells it"),
  graphic: z.record(z.any()).optional().describe("Fields to merge into the card — only the ones you name change; null on a field clears it. `params` merges too, one param at a time. A different kind or template, or hand-written html in place of a template, is a new card: give the whole graphic, nothing of the old one carries over."),
};

const applyPatch = (scene, patch) => {
  const { index, from_word_id, to_word_id, fromWordId, toWordId, graphic, ...fields } = patch;
  const first = from_word_id ?? fromWordId;
  const last = to_word_id ?? toWordId;
  if (first !== undefined) scene.fromWordId = first;
  if (last !== undefined) scene.toWordId = last;
  for (const [key, value] of Object.entries(fields)) {
    if (value === null) delete scene[key];
    else if (value !== undefined) scene[key] = value;
  }
  if (graphic) {
    const current = scene.graphic ?? {};
    // A different kind or template is a different card: the old one's
    // fields — least of all a template's rendering — must not carry over.
    const newKind = graphic.kind !== undefined && graphic.kind !== current.kind;
    const newTemplate = graphic.template !== undefined && graphic.template !== current.template;
    // Hand-written html on a template card is a new card too: the template
    // would otherwise re-render over it and the html never land.
    const handWritten = graphic.html !== undefined && graphic.template === undefined && current.template !== undefined;
    const next = newKind || newTemplate || handWritten ? {} : { ...current };
    if (handWritten && graphic.kind === undefined) next.kind = "custom";
    if (newTemplate && graphic.kind === undefined) next.kind = "custom";
    for (const [key, value] of Object.entries(graphic)) {
      if (value === null) delete next[key];
      else if (key === "params" && value && typeof value === "object" && !Array.isArray(value) && next.params && !newTemplate) {
        // One param at a time: tightening a line keeps the kicker.
        next.params = { ...next.params };
        for (const [name, param] of Object.entries(value)) {
          if (param === null) delete next.params[name]; else next.params[name] = param;
        }
      } else next[key] = value;
    }
    scene.graphic = next;
  }
};

server.registerTool("check_scenes", {
  description:
    "set_scenes without the write: validates a whole plan (templates expanded), and returns the warnings, variety and pacing reads it would get — for a plan you want judged before it replaces the person's edits, or for trying two versions of a passage. Takes exactly what set_scenes takes.",
  inputSchema: {
    scenes: z.array(optionSceneShape).describe("The plan to judge, in set_scenes' shape"),
    captions: z.union([z.boolean(), z.enum([...CAPTION_MODES])]).optional(),
  },
}, async ({ scenes, captions }) => {
  const dir = currentProjectDir();
  const words = cleanWords(dir);
  const shaped = expandPlan(scenes.map(shapeScene), { format: projectFormat(dir) });
  checkPlan(dir, shaped, words);
  assertAssets(dir, shaped);
  const config = readComposeConfig(dir);
  const read = readBackPlan(dir, shaped, words, config.theme, captions ?? config.captions);
  return ok({ scenes: shaped.length, valid: true, warnings: read.warnings, variety: read.variety, pacing: read.pacing, hint: "nothing was written; set_scenes writes it" });
});

server.registerTool("update_scenes", {
  description:
    "Change named fields on named scenes and leave every other scene, and every other field, exactly as it is. This is how to act on a note about the film — a punchier title, a different layout for one passage, a chart's numbers — without resending the plan. Indices come from get_scenes; read it first, because the person edits scenes in the window between your turns. Returns the whole plan's fresh warnings, variety and pacing reads.",
  inputSchema: { patches: z.array(z.object(scenePatchShape).strict()).min(1).max(60) },
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
    side: "the visual beside the head. Landscape: head left, content column right (corner br/tr mirrors it: head right). Vertical: head across the top half, cropped, the visual owning the bottom.",
    split: "split screen — the speaker and the thing given the same weight. The head fills one half of the frame edge to edge, cropped like a picture; the visual owns the other half. Landscape: left/right halves (corner br/tr puts the head on the right). Vertical: top/bottom halves (corner bl/br puts the head at the bottom, the visual above it).",
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
    clip: "B-roll: src (assets/….mp4 from import_clip), optional in (seconds into the clip), fit (cover/contain), label, sound (true or { level } in dB, -14 by default: the clip's own sound under the voice, ducked from the words) — plays in the card while the voice carries on; one at a time",
    logos: "items[{src, label?}] — pictures in a row",
    screen: "the recording's own screen track, in sync; only inside get_framing's screenSpans",
    cover: "WHOLE STAGE: a still edge to edge with title, subtitle, optional tint",
    section: "WHOLE STAGE: a chapter heading — number, title, subtitle",
    custom: "WHOLE STAGE by default (full: false for the content rect; over: true to draw it over the head — the thumbnail and the shaded cta are made for that): a named template from describe_templates, or your own html + css for one moment; scoped, no scripts or external loads. Animate from --q (0→1 over 1.8 s), --p (0→1 over the span) and --alpha; cqw/cqh measure the stage; pictures as assets/name.png",
    motion: "WHOLE STAGE by default: your own animation written as code — HTML, CSS, SVG, Canvas or WebGL in a document under motion/ (write_motion writes it and shows you frames), drawn at every frame of the film on the scene's own clock. src \"motion/<name>.html\", optional params, libs, full, over, fade. For the moments that must MOVE to make sense — a mechanism assembling itself, a route drawing on a map, type choreographed to the words — and for the film's signature moment. describe_motion is the contract; the person's direction may encourage, allow or refuse it (get_direction).",
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
  direction: "get_direction is the person's brief when they pressed Make it into a video: what the film is for, and how closely to follow the kit — free (design it), guided (the kit first), strict (only the kit and templates; motion scenes and hand-written custom graphics are refused, and the real render waits until critique_film finds no fault). set_treatment writes the film's idea before its scenes.",
  sound: `set_audio puts a music bed under the voice (import_audio brings the file in), ducked from the transcript's own pauses, and can normalise the voice; audio lives only in the stitch so it costs seconds, not minutes.`,
  reading: "read_story marks the transcript up before you compose (sections, the opening, the ending, every drawable moment, the figures); draft_scenes turns it into a skeleton; review_plan and every plan write return the variety and pacing reads and the collision warnings; preview_sheet tiles the plan, film_sheet the rendered film, and render_final draft: true renders the whole film at half size to look at in motion.",
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
  adoptedPersona = id;
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
    "One of the craft guides under docs/craft/, in full: editor (the film editor's craft: structure, picture before card, rhythm, type), shorts (the short-form farmer's: the first second and a half, every four seconds, the ending, choosing clips), visual-grammar (what to put on the stage for what is being said, kit and templates, both frames), references (widely watched styles described as methods — the explainer, the tech reviewer, the educator, the essay, the broadcast package, the feed, the walkthrough — for when the person says “make it feel like…”), examples (two real films made with this belt, scene by scene, with the reasons and what the reads caught), plan-short and plan-film (those two plans as the compose.json the assistant wrote — template ids and params, the theme, captions and audio — to read beside examples, not to copy). adopt_persona already hands you the two a persona reads; this is for the rest.",
  inputSchema: { guide: z.enum([...Object.keys(CRAFT_DOCS)]) },
}, async ({ guide }) => {
  return ok({ guide, path: CRAFT_DOCS[guide], text: fs.readFileSync(path.join(REPO_ROOT, CRAFT_DOCS[guide]), "utf8") });
});

server.registerTool("export_chapters", {
  description:
    "The chapter list for the upload's description, as a platform reads it: one line per chapter, m:ss then the title, the first at 0:00, none shorter than ten seconds. Chapters come from the plan's section, cover and headline marks; where the plan has none, from read_story's sections. Written to out/chapters.txt and returned. Hand it to the person with the film; a film with two or fewer chapters usually wants section marks added rather than a list.",
  inputSchema: { title: z.string().max(80).optional().describe("The 0:00 line when nothing marks the opening; the project's title by default") },
}, async ({ title }) => {
  const dir = currentProjectDir();
  const words = cleanWords(dir);
  const config = readComposeConfig(dir);
  const scenes = resolveScenes(config.scenes ?? [], words, { durationSeconds: filmDuration(dir, words) });
  const list = chapterList({ scenes, words, title: title ?? openingTitle(scenes) ?? readProjectMeta(dir).title ?? "Introduction", duration: words.at(-1)?.end });
  const file = path.join(dir, "out", "chapters.txt");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, list.text);
  return ok({ file, ...list, hint: list.enough ? "paste the text into the upload's description" : "fewer than three chapters: add section or cover marks where the subject changes (read_story's sections say where), then export again" });
});

server.registerTool("get_captions", {
  description:
    "The film's caption phrases as timed lines — index, start, end, text on the clean timeline — the same phrases the captions burn in and the SRT/VTT carry. Read them to translate: export_captions takes one line per phrase in another language and writes a caption file with these timings.",
  inputSchema: {},
}, async () => {
  const dir = currentProjectDir();
  const words = cleanWords(dir);
  const phrases = resolvePhraseCaptions(words);
  return ok({ count: phrases.length, seconds: Number(filmDuration(dir, words).toFixed(1)), phrases: phrases.map((p, index) => ({ index, start: Number(p.start.toFixed(2)), end: Number(p.end.toFixed(2)), text: p.text })) });
});

server.registerTool("export_captions", {
  description:
    "A caption file in another language, with the film's own timings: give one line per phrase from get_captions (translated by you, in that order, the same count), and out/captions-<language>.srt and .vtt are written beside the film for the platform's subtitle upload. The English the film carries is already written beside every render; this is for the languages it does not speak.",
  inputSchema: {
    language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/).describe("A language tag, e.g. es, pt-BR, ja"),
    lines: z.array(z.string().max(200)).min(1).max(2000).describe("One translated line per phrase, in get_captions' order"),
  },
}, async ({ language, lines }) => {
  const dir = currentProjectDir();
  const words = cleanWords(dir);
  const phrases = resolvePhraseCaptions(words);
  if (lines.length !== phrases.length) throw new Error(`${lines.length} line(s) for ${phrases.length} phrase(s): get_captions lists them; give exactly one line per phrase, in order`);
  const empty = lines.findIndex((line) => !line.trim());
  if (empty >= 0) throw new Error(`line ${empty} is empty; every phrase needs its line (repeat a short one if two phrases share a sentence)`);
  // One line is one cue: a newline inside it would break the file's own grammar.
  const cues = phrases.map((p, i) => ({ start: p.start, end: p.end, text: lines[i].replace(/\s+/g, " ").trim() }));
  const files = [];
  for (const format of ["srt", "vtt"]) {
    const file = path.join(dir, "out", `captions-${language}.${format}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, subtitleFile(cues, format));
    files.push(file);
  }
  return ok({ language, files, count: cues.length, hint: "upload beside the film as its subtitles for that language; the timings are the film's own" });
});

server.registerTool("export_description", {
  description:
    "The upload's description as one paste-ready block, written to out/description.md and returned: the title, a summary you give (two or three sentences the platform shows before the fold — write it from the story, not from the plan), the links, the chapter list from export_chapters (only from three chapters, when a platform shows one), the image credits the film owes, and a last line of tags as hashtags. Hand it over with the film.",
  inputSchema: {
    summary: z.string().min(20).max(1200).describe("What the film is, in the person's voice, for the description's first lines"),
    title: z.string().max(100).optional().describe("The upload's title; the project's title by default"),
    links: z.array(z.object({ label: z.string().max(60), url: z.string().url() })).max(8).optional().describe("Links the description should carry, in order, each as { label, url }"),
    tags: z.array(z.string().min(2).max(30)).max(10).optional().describe("Hashtags for the last line, without the #: three that say what the film is about beat ten that say everything; a platform shows the first three above a short's title"),
  },
}, async ({ summary, title, links, tags }) => {
  const dir = currentProjectDir();
  const words = cleanWords(dir);
  const config = readComposeConfig(dir);
  const scenes = resolveScenes(config.scenes ?? [], words, { durationSeconds: filmDuration(dir, words) });
  const shown = title ?? readProjectMeta(dir).title ?? "Untitled";
  const chapters = chapterList({ scenes, words, title: title ?? openingTitle(scenes) ?? shown, duration: words.at(-1)?.end });
  const credits = listAssets(path.join(dir, "assets")).filter((asset) => asset.attribution?.author || asset.attribution?.license || asset.attribution?.pageUrl);
  const lines = [`# ${shown}`, "", summary.trim(), ""];
  if (links?.length) { for (const link of links) lines.push(`${link.label}: ${link.url}`); lines.push(""); }
  // A platform shows chapters only from three; fewer would be a list of two times.
  if (chapters.enough) { lines.push("Chapters", chapters.text.trim(), ""); }
  if (credits.length) {
    lines.push("Credits");
    for (const asset of credits) {
      const a = asset.attribution;
      lines.push(`${a.author ? `${a.author}: ` : ""}${asset.src.replace(/^assets\//, "")}${a.license ? ` — ${a.license}` : ""}${a.pageUrl ? ` (${a.pageUrl})` : ""}`);
    }
    lines.push("");
  }
  const hashtags = [...new Set((tags ?? []).map((tag) => `#${tag.replace(/^#+/, "").replace(/[^\p{L}\p{N}_]+/gu, "")}`).filter((tag) => tag.length > 1))];
  if (hashtags.length) lines.push(hashtags.join(" "), "");
  const text = lines.join("\n");
  const file = path.join(dir, "out", "description.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return ok({ file, text, chapters: chapters.chapters.length, chaptersShown: chapters.enough, hashtags, credits: credits.length, ...(chapters.enough ? {} : { note: `${chapters.chapters.length} chapter(s): a platform shows chapters from three, so none are in the description; export_chapters says where to add marks` }) });
});

server.registerTool("describe_templates", {
  description:
    "The named graphics: a timeline, a flow of arrows, before/after, myth and fact, a definition, a code window, keycaps, a progress bar, a ladder, the scales, an alert, a headline, a call to action, a teaser, a receipt, a ranking, a post, a share bar, a phone, the question, the hook line, the big word, the big number, three numbers. Each is a custom graphic already written and laid out for this film's shape, with its moving parts exposed as fields. Use one by writing graphic: { kind: \"custom\", template: \"<id>\", params: { … } } in set_scenes, add_scenes or update_scenes; the html and css are generated and the template id and params stay beside them in get_scenes. Read this before writing a custom graphic by hand — the hand-written one is for a moment none of these fit.",
  inputSchema: {
    persona: z.enum(["editor", "farmer"]).optional().describe("Narrow to the ones an editor or a short-form farmer reaches for; omit for all"),
  },
}, async ({ persona }) => {
  const format = projectFormatSafe();
  const who = persona ?? adoptedPersona ?? (PERSONA_IDS.includes(process.env.FABULA_PERSONA) ? process.env.FABULA_PERSONA : undefined);
  return ok({
    format,
    persona: who ?? "all",
    note: "full: true takes the whole stage (pair it with a cutaway or full layout; over focus it hides behind the face — unless over: true, which draws it on the face: the thumbnail template with its shade is made for that, the first frame of a short especially); full: false sits in the layout's content rect beside the head. A template's own default is the right one unless you have a reason. The example on each is a complete params object.",
    templates: describeTemplates({ persona: who }),
    // Narrowed lists say what they left out, so a template the examples use
    // is never taken for one that does not exist.
    omitted: who ? TEMPLATE_IDS.filter((id) => !describeTemplates({ persona: who }).some((t) => t.id === id)) : [],
  });
});

// describe_kit is legitimate with no project open — it is what to read before
// there is one — so the shape it describes falls back to the default.
// ---- Direction, treatment and motion: making a film on the person's brief ----

server.registerTool("get_direction", {
  description:
    "The person's direction for this film, written when they pressed Make it into a video in the window: what the film is for, how closely to hold to the house style (latitude: free — design it, the kit is a starting point; guided — the kit first, your own graphics where no template fits; strict — only the kit and the named templates, every fault fixed before the real render), which look to wear, whether you may bring in music, sound effects and pictures from the web, their notes, and whether to render a draft when the plan is done. Read it FIRST when making a video: it replaces asking them. The brief it returns is written as instructions — follow them. Null when they gave none: then you compose with them step by step.",
  inputSchema: {},
}, async () => {
  const dir = currentProjectDir();
  const direction = readDirection(dir);
  if (!direction) {
    return ok({ direction: null, hint: "No direction has been given; the person composes with you step by step. Ask what the film is for before choosing the look. set_direction records one when they tell you in words." });
  }
  return ok({
    direction: describeDirection(direction),
    brief: directionBrief(direction),
    latitudes: Object.fromEntries(LATITUDE_IDS.map((id) => [id, `${LATITUDES[id].label}: ${LATITUDES[id].summary}`])),
  });
});

server.registerTool("set_direction", {
  description:
    "Record a change to the person's direction when they tell you one in words — \"go wild with it\" is latitude free, \"keep it to our templates\" is strict, \"no music\" is music: false. Merges into what is there; the window's Make it into a video sheet writes the same file. Never change it on your own judgment: it is theirs.",
  inputSchema: {
    latitude: z.enum([...LATITUDE_IDS]).optional().describe("free (Free hand), guided (the default), strict (By the book)"),
    purpose: z.string().max(300).optional().describe("What the film is for and who it is for"),
    look: z.string().max(80).optional().describe("auto (you choose), keep, brand:<id> or preset:<id>"),
    music: z.boolean().optional(),
    effects: z.boolean().optional(),
    web: z.boolean().optional().describe("May pictures and sounds be brought in from the web"),
    notes: z.string().max(2000).optional(),
    render: z.enum(["draft", "none"]).optional().describe("draft: render a draft when the plan is reviewed, without asking"),
  },
}, async (args) => {
  const dir = currentProjectDir();
  const given = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
  const merged = validateDirection({ ...(readDirection(dir) ?? {}), ...given });
  writeJsonAtomic(path.join(dir, "direction.json"), merged);
  noteActivity(LATITUDES[merged.latitude].label);
  return ok({ direction: describeDirection(merged), brief: directionBrief(merged) });
});

const treatmentSpan = {
  fromWordId: z.number().int().min(0).optional(),
  toWordId: z.number().int().min(0).optional(),
  from_word_id: z.number().int().min(0).optional().describe("the same as fromWordId"),
  to_word_id: z.number().int().min(0).optional(),
};

server.registerTool("set_treatment", {
  description:
    "Write the film's treatment before placing a scene: the logline (one sentence — what the film SAYS), who it is for, two or three candidate shapes and the one you chose (the first idea is usually the cliché), the signature moment (the one gesture only this film makes, where its turn lands, anchored to its words), and the beats in order — each a word span, what happens in the story, what the viewer sees, and where the head is (on, corner, side, split, band, gone). Plus the sound plan and the look in a line each. The window shows it to the person while you work, so write it for them. The recording cannot be reordered: beats run in its order. Replaces the previous treatment; get_treatment reads it back.",
  inputSchema: {
    logline: z.string().max(200),
    purpose: z.string().max(300).optional(),
    shapes: z.array(z.object({ name: z.string().max(60), why: z.string().max(240).optional() })).max(4).optional().describe("The structures you considered"),
    shape: z.string().max(240).optional().describe("The one chosen, and why"),
    // Either spelling of the word ids, as every other write tool takes them;
    // validateTreatment says which is missing.
    signature: z.object({ what: z.string().max(240), ...treatmentSpan }).optional(),
    beats: z.array(z.object({
      ...treatmentSpan,
      beat: z.string().max(120).describe("What happens in the story here"),
      picture: z.string().max(200).optional().describe("What the viewer sees"),
      head: z.enum(["on", "corner", "side", "split", "band", "gone"]).optional().describe("Where the talking head is"),
    })).min(1).max(40),
    sound: z.string().max(240).optional(),
    look: z.string().max(240).optional(),
  },
}, async (args) => {
  const dir = currentProjectDir();
  let words = null;
  try { words = cleanWords(dir); } catch { words = null; }
  const treatment = { ...validateTreatment(args, words), updatedAt: new Date().toISOString() };
  writeJsonAtomic(path.join(dir, "treatment.json"), treatment);
  noteActivity(treatment.logline);
  return ok({
    treatment: describeTreatment(treatment),
    hint: "Now compose to it: every scene should serve a beat, and the signature moment gets the film's biggest gesture — often a motion scene (describe_motion) when the direction allows one.",
  });
});

server.registerTool("get_treatment", {
  description: "The film's treatment as written by set_treatment — the logline, the shape, the signature moment and the beats — or null. Read it before changing the plan, so a change serves the film's idea rather than just the moment.",
  inputSchema: {},
}, async () => {
  const dir = currentProjectDir();
  return ok({ treatment: readTreatment(dir) });
});

const motionPreviewShape = z.object({
  seconds: z.number().min(0.5).max(120).optional().describe("How long to sample; the placed scene's span by default, else 6"),
  frames: z.number().int().min(1).max(24).optional().describe("Tiles across it, 6 by default"),
  at: z.number().min(0).optional().describe("With frames: 1, the one instant to draw"),
  layout: z.enum([...LAYOUTS]).optional().describe("The stage under it: the placed scene's layout by default, else cutaway; pip, full, side or split put a hatched block where the head would be"),
  corner: z.enum(["br", "bl", "tr", "tl"]).optional(),
  params: z.record(z.any()).optional().describe("Params to draw it with; the placed scene's by default"),
  full: z.boolean().optional().describe("false draws it in the layout's content rect instead of the whole stage"),
  scene: z.number().int().min(0).optional().describe("Which placement to draw it as, by get_scenes index, when the document is placed more than once; otherwise the one whose params match"),
});

// The span and params a motion document is drawn with in the plan, when it
// is placed, so its preview samples the seconds it actually plays for. One
// document may be placed several times (params make it several scenes): the
// placement asked for by index, else the one whose params match, else the
// first.
function motionPlacement(dir, src, { index: wanted, params } = {}) {
  try {
    const words = cleanWords(dir);
    const config = readComposeConfig(dir);
    const duration = filmDuration(dir, words);
    const scenes = resolveScenes(config.scenes ?? [], words, { durationSeconds: duration });
    const placed = scenes.map((scene, i) => ({ scene, i })).filter(({ scene }) => scene.graphic?.kind === "motion" && scene.graphic.src === src);
    const same = (a, b) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
    const hit = (wanted !== undefined ? placed.find(({ i }) => i === wanted) : null)
      ?? (params ? placed.find(({ scene }) => same(scene.graphic.params, params)) : null)
      ?? placed[0];
    if (!hit) return null;
    const index = hit.i;
    const scene = scenes[index];
    // The layout it plays under, so the sheet draws it in the same box: a
    // full: false scene in a split is half the frame, not a cutaway's room.
    const mid = (scene.start + scene.end) / 2;
    const stage = resolveLayoutTimeline(scenes, duration).find((segment) => segment.start <= mid && mid < segment.end);
    return {
      index, start: Number(scene.start.toFixed(3)), seconds: Number((scene.end - scene.start).toFixed(2)),
      params: scene.graphic.params ?? {}, full: scene.graphic.full !== false, libs: scene.graphic.libs ?? [],
      seed: scene.graphic.seed ?? null, fade: scene.graphic.fade !== false, over: scene.graphic.over === true,
      layout: stage?.layout ?? null, corner: stage?.corner ?? null,
    };
  } catch {
    return null;
  }
}

async function motionPreview(dir, src, preview = {}) {
  const placed = motionPlacement(dir, src, { index: preview.scene, params: preview.params });
  const args = [`--motion=${src}`, `--seconds=${preview.seconds ?? placed?.seconds ?? 6}`, `--frames=${preview.frames ?? 6}`];
  if (preview.at !== undefined) args.push(`--at=${preview.at}`);
  const layout = preview.layout ?? placed?.layout;
  if (layout) args.push(`--layout=${layout}`);
  const corner = preview.corner ?? (layout === placed?.layout ? placed?.corner : null);
  if (corner) args.push(`--corner=${corner}`);
  const params = preview.params ?? placed?.params;
  if (params && Object.keys(params).length) args.push(`--params=${JSON.stringify(params)}`);
  if ((preview.full ?? placed?.full) === false) args.push("--full=false");
  if (placed?.libs?.length) args.push(`--libs=${placed.libs.join(",")}`);
  // Its noise, its fade and which side of the head it is drawn on, as placed.
  if (Number.isInteger(placed?.seed)) args.push(`--seed=${placed.seed}`);
  if (placed && !placed.fade) args.push("--fade=false");
  if (placed?.over) args.push("--over=true");
  // Where it plays in the film, so the sheet hands it the same words.
  if (placed) args.push(`--start=${placed.start}`);
  return runFrame(dir, args);
}

server.registerTool("describe_motion", {
  description:
    "How to write a motion scene: your own animation as a small HTML document — markup, CSS and a script — that Fabula draws at every frame of the film in a sandboxed frame (no network, no timers, a clock set by the film). The canvas and its size, the scene clock, the fabula.* helpers (scene, random, ease, range, spring, stagger, split, asset, timeline), the theme as CSS variables, the head's rectangle, the rules, and a worked example. Read it once before your first write_motion. docs/craft/motion.md (read_craft motion) is the craft: when a moment deserves motion, and what makes it read.",
  inputSchema: {},
}, async () => {
  const format = projectFormatSafe();
  let direction = null;
  try { direction = describeDirection(readDirection(currentProjectDir())); } catch { direction = null; }
  return ok({
    ...describeMotion({ stage: stageOf(format), fonts: VENDORED_FONTS, libs: installedMotionLibs() }),
    direction: direction ? `${direction.label}: motion scenes are ${direction.motion} under this direction.` : "No direction given: motion scenes are allowed where no template carries the idea.",
  });
});

server.registerTool("write_motion", {
  description:
    "Write a motion scene — motion/<name>.html in the project — and see it: returns a contact sheet of frames across it (the file path; LOOK at it) and any error the scene threw. Place it with a graphic scene { kind: \"motion\", src: \"motion/<name>.html\" } over the words it belongs to, usually under a cutaway (the scene owns the stage) or a full/pip layout (the head in a corner, ctx.head says where). Writing the same name again replaces it, and every scene placing it redraws. describe_motion is the contract; refused under a By the book direction.",
  inputSchema: {
    name: z.string().regex(MOTION_NAME_RE).describe("lowercase-with-dashes; the file is motion/<name>.html"),
    html: z.string().min(1).max(200000).describe("The document: <style>, markup, <script> with fabula.scene({ setup, render })"),
    preview: z.union([z.literal(false), motionPreviewShape]).optional().describe("How to draw the contact sheet; false skips it"),
  },
}, async ({ name, html, preview }) => {
  const dir = currentProjectDir();
  const rules = rulesFor(readDirection(dir));
  if (rules.motion === "refused") throw new Error(`the person's direction is ${rules.label}: only the kit and the named templates, no motion scenes. Nothing was written.`);
  const { notes } = validateMotionDoc(html);
  const src = `motion/${name}.html`;
  fs.mkdirSync(path.join(dir, "motion"), { recursive: true });
  const existed = fs.existsSync(path.join(dir, src));
  writeTextAtomic(path.join(dir, src), html);
  noteActivity(src);
  const placed = motionPlacement(dir, src, preview ? { index: preview.scene, params: preview.params } : {});
  const answer = { src, bytes: Buffer.byteLength(html), replaced: existed, notes, placedAt: placed ? `scene ${placed.index} (${placed.seconds}s)` : null };
  if (preview === false) return ok({ ...answer, hint: "preview_motion draws it when you want to look." });
  try {
    const sheet = await motionPreview(dir, src, preview ?? {});
    return ok({ ...answer, sheet: sheet.file, tiles: sheet.tiles, errors: sheet.errors, hint: sheet.errors?.length ? "The scene reported errors: fix them and write again." : "Look at the sheet: does each frame read, is the type inside the frame, does the motion arrive where the words do?" });
  } catch (error) {
    return ok({ ...answer, sheet: null, errors: [error.message], hint: "Written, but it could not be drawn; the error says why." });
  }
});

server.registerTool("preview_motion", {
  description: "Draw a motion scene again without rewriting it: a contact sheet across its span (or one instant with frames: 1 and at). Placed, it is drawn as it plays — the placement's span, words, params, layout and corner — unless you give others. Seconds, not minutes; no clean cut needed.",
  inputSchema: { name: z.string().regex(MOTION_NAME_RE), ...motionPreviewShape.shape },
}, async ({ name, ...preview }) => {
  const dir = currentProjectDir();
  const src = `motion/${name}.html`;
  if (!fs.existsSync(path.join(dir, src))) throw new Error(`no motion document ${src}; list_motion shows what exists`);
  const sheet = await motionPreview(dir, src, preview);
  return ok({ src, sheet: sheet.file, tiles: sheet.tiles, errors: sheet.errors });
});

server.registerTool("read_motion", {
  description: "A motion scene's document as written, to change part of it and write it back.",
  inputSchema: { name: z.string().regex(MOTION_NAME_RE) },
}, async ({ name }) => {
  const dir = currentProjectDir();
  const src = `motion/${name}.html`;
  if (!fs.existsSync(path.join(dir, src))) throw new Error(`no motion document ${src}; list_motion shows what exists`);
  return ok({ src, html: fs.readFileSync(path.join(dir, src), "utf8") });
});

server.registerTool("list_motion", {
  description: "The project's motion scenes: each document under motion/, its size, and which scenes place it.",
  inputSchema: {},
}, async () => {
  const dir = currentProjectDir();
  const folder = path.join(dir, "motion");
  const names = fs.existsSync(folder) ? fs.readdirSync(folder).filter((file) => /\.html$/.test(file)).sort() : [];
  const scenes = readComposeConfig(dir).scenes ?? [];
  return ok({
    motion: names.map((file) => {
      const src = `motion/${file}`;
      return { src, bytes: fs.statSync(path.join(folder, file)).size, usedBy: scenes.map((scene, index) => (scene.graphic?.kind === "motion" && scene.graphic.src === src ? index : null)).filter((index) => index !== null) };
    }),
  });
});

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

server.registerTool("film_sheet", {
  description:
    "A contact sheet tiled from the RENDERED film (the newer of out/final.mp4 and out/draft.mp4, or a preview span by name) rather than from the preview page: every N seconds of what the encoder actually wrote, in one picture. preview_sheet shows what the plan will look like; this shows what the render did. Look at it after render_final and before handing the film over — a card behind the head, a black tail, a stitch that lost its sound are all visible here and nowhere else. Seconds, not minutes; no Electron.",
  inputSchema: {
    every_seconds: z.number().min(1).max(120).optional().describe("Tile interval; the film's length over twelve by default"),
    file: z.string().optional().describe("A file under out/ to tile instead of final.mp4, e.g. preview-0-60.mp4"),
    columns: z.number().int().min(1).max(8).optional(),
  },
}, async ({ every_seconds, file, columns }) => {
  const dir = currentProjectDir();
  // Without a name: the newer of the film and its draft, which is the one
  // just rendered.
  const newest = ["final.mp4", "draft.mp4"].filter((name) => fs.existsSync(path.join(dir, "out", name)))
    .sort((a, b) => fs.statSync(path.join(dir, "out", b)).mtimeMs - fs.statSync(path.join(dir, "out", a)).mtimeMs)[0];
  const leaf = (file ?? newest ?? "final.mp4").replace(/[^a-z0-9._-]/gi, "_");
  const video = path.join(dir, "out", leaf);
  if (!fs.existsSync(video)) throw new Error(`no ${file ?? "final.mp4 or draft.mp4"} in out/; render_final first${file ? ", or film_sheet without file for the film" : ""}`);
  const duration = probeDuration(video);
  const every = every_seconds ?? Math.max(1, Math.round(duration / 12));
  // One frame at 0, N, 2N… picked by time (fps=1/N picks the frame nearest
  // each slot, half an interval early), so tile k IS the second it is
  // labelled with; the count is every start under the VIDEO's length —
  // the container runs a few frames longer on its audio, and a start in
  // that tail has no frame to show.
  const { execFileSync } = await import("node:child_process");
  const videoSeconds = (() => {
    try {
      const got = Number.parseFloat(execFileSync(FFMPEG.replace(/ffmpeg$/, "ffprobe"), ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=duration", "-of", "csv=p=0", video]).toString());
      return Number.isFinite(got) ? got : duration;
    } catch { return duration; }
  })();
  const tiles = Math.max(1, Math.min(48, Math.ceil((videoSeconds - 0.04) / every)));
  const dims = probeDimensions(video);
  const tall = dims.height > dims.width;
  const cols = Math.max(1, Math.min(columns ?? (tall ? 6 : 4), tiles));
  const rows = Math.ceil(tiles / cols);
  const width = tall ? 270 : 480;
  const out = path.join(dir, "out", "frames", `film-sheet-${leaf.replace(/\.mp4$/, "")}-${every}s.png`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", video,
    "-vf", `select='isnan(prev_selected_t)+gte(t-prev_selected_t\,${every - 0.02})',scale=${width}:-2,tile=${cols}x${rows}:padding=4:color=0x0b0e12`, "-fps_mode", "passthrough", "-frames:v", "1", out], { stdio: ["ignore", "ignore", "pipe"] });
  const audio = (() => {
    try {
      const probe = execFileSync(FFMPEG.replace(/ffmpeg$/, "ffprobe"), ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name,channels", "-of", "csv=p=0", video]).toString().trim();
      return probe || "none";
    } catch { return "unknown"; }
  })();
  return ok({ file: out, video: leaf, seconds: Number(duration.toFixed(1)), every, tiles, columns: cols, rows, audio, hint: "tiles run left to right, top to bottom, one every " + every + "s from 0" });
});

server.registerTool("render_thumbnail", {
  description:
    "The still a platform shows before anyone presses play: one frame of the composed film — captions taken off — with a few big words over it from the thumbnail template (a kicker, a line of up to six words, a shade behind them so they read on any frame), written to out/thumbnail.png at 1280×720 (a tall film keeps its shape). Pick a frame where the face is doing something: preview_sheet shows the candidates. The line is a promise, not a summary, and never one the film does not keep. Two to four variants render side by side into out/thumbnail-variants.png at the size a feed shows them, to choose between.",
  inputSchema: {
    line: z.string().min(1).max(40).optional().describe("The words, six at most (or give variants)"),
    kicker: z.string().max(24).optional(),
    variants: z.array(z.object({
      line: z.string().min(1).max(40),
      kicker: z.string().max(24).optional(),
      side: z.enum(["left", "right", "bottom"]).optional(),
      shade: z.number().min(0).max(1).optional(),
      word_id: z.number().int().min(0).optional(),
      at_seconds: z.number().min(0).optional(),
    })).min(2).max(4).optional().describe("Two to four lines (each with its own frame if wanted) rendered side by side into out/thumbnail-variants.png, to choose between; the fields above are the defaults each variant falls back to"),
    side: z.enum(["left", "right", "bottom"]).optional().describe("Where the words sit; leave the face on the other side"),
    shade: z.number().min(0).max(1).optional().describe("How dark the shade behind the words is, 0.55 by default"),
    word_id: z.number().int().min(0).optional().describe("The frame, a beat after this word"),
    at_seconds: z.number().min(0).optional().describe("Or an exact time on the clean timeline"),
    name: z.string().max(40).optional().describe("File name under out/, thumbnail.png by default"),
  },
}, async ({ line, kicker, side, shade, word_id, at_seconds, name, variants }) => {
  const dir = currentProjectDir();
  const one = async (fields, leaf) => {
    if (fields.word_id === undefined && fields.at_seconds === undefined) throw new Error("give a word_id or an at_seconds");
    if (!fields.line) throw new Error("give a line, or variants each with one");
    const spec = path.join(dir, "out", "frames", "thumbnail-spec.json");
    fs.mkdirSync(path.dirname(spec), { recursive: true });
    fs.writeFileSync(spec, JSON.stringify({ template: "thumbnail", params: { line: fields.line, kicker: fields.kicker, side: fields.side, shade: fields.shade } }));
    const args = [`--thumb=${spec}`, `--out=${path.join(dir, "out", leaf)}`, `--width=${projectFormatSafe() === "vertical" ? 1080 : 1280}`];
    if (fields.word_id !== undefined) args.push(`--word=${fields.word_id}`);
    else args.push(`--at=${fields.at_seconds}`);
    try { return await runFrame(dir, args); } finally { fs.rmSync(spec, { force: true }); }
  };
  const defaults = { line, kicker, side, shade, word_id, at_seconds };
  if (!variants) {
    const leaf = (name ?? "thumbnail.png").replace(/[^a-z0-9._-]/gi, "_").replace(/(\.png)?$/i, ".png");
    const result = await one(defaults, leaf);
    return ok({ ...result, hint: "look at it; a thumbnail is judged at a fifth of this size, so if the words are not the first thing you see, use fewer" });
  }
  // Variants: each rendered alone, then tiled into one picture, small, the
  // way a feed shows them — which is the size to judge them at.
  const tiles = [];
  for (const [i, variant] of variants.entries()) {
    const fields = { ...defaults, ...Object.fromEntries(Object.entries(variant).filter(([, v]) => v !== undefined)) };
    const result = await one(fields, `frames/thumb-variant-${i + 1}.png`);
    tiles.push({ index: i + 1, line: fields.line, kicker: fields.kicker ?? null, side: fields.side ?? "left", file: result.file, at: result.at });
  }
  const { execFileSync } = await import("node:child_process");
  const out = path.join(dir, "out", (name ?? "thumbnail-variants.png").replace(/[^a-z0-9._-]/gi, "_").replace(/(\.png)?$/i, ".png"));
  const inputs = tiles.flatMap((t) => ["-i", t.file]);
  const scaled = tiles.map((_, i) => `[${i}:v]scale=${projectFormatSafe() === "vertical" ? 270 : 480}:-2[t${i}]`).join(";");
  execFileSync(FFMPEG, ["-y", "-v", "error", ...inputs, "-filter_complex", `${scaled};${tiles.map((_, i) => `[t${i}]`).join("")}hstack=inputs=${tiles.length}:shortest=1`, out]);
  return ok({ file: out, variants: tiles, hint: "each is shown at the size a feed shows it; the one whose words you read first without trying is the one. render_thumbnail with that line alone writes out/thumbnail.png" });
});

server.registerTool("preview_sheet", {
  description:
    "Several frames of the composed film tiled into ONE picture, in time order, so the rhythm of a whole passage — or the whole film — can be looked at at once: where the head is, where the cards are, how often the picture changes, whether two cards in a row look like the same card. Give every_seconds to walk the film at that interval (a 106 s film every 8 s is 13 tiles: the walk starts a beat in and stops half a second short of the end), or a list of at_seconds or word_ids for chosen moments. Tiles are 640 wide by default, which shows arrangement and colour rather than small type; use preview_frame for one moment at full size. Costs a few seconds per tile. The result lists what each tile holds.",
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
  description: "How the film carries its captions: open (burned into the picture in the theme's caption style), closed (not in the picture; an SRT and a VTT are written beside every render for the player to offer as CC), both, or none. emphasis picks the one or two words each burned-in phrase leans on and sets them in the accent, heavier: auto (numbers, absolutes, negations, names), a list of words, or none. A short is read more than heard, so auto is the usual choice there; a film usually wants none. Previews at once; a change re-renders the chunks it touches.",
  inputSchema: {
    mode: z.enum([...CAPTION_MODES]).optional().describe("omit to keep the current mode"),
    emphasis: z.union([z.enum(["none", "auto"]), z.array(z.string().min(1).max(30)).max(60)]).optional().describe("none, auto, or the words to lean on; omit to keep"),
  },
}, async ({ mode, emphasis }) => {
  const dir = currentProjectDir();
  const config = readComposeConfig(dir);
  if (mode !== undefined) config.captions = captionMode(mode);
  if (emphasis !== undefined) {
    const value = captionEmphasis(emphasis);
    if (value === "none") delete config.captionEmphasis; else config.captionEmphasis = value;
  }
  writeComposeConfig(dir, config);
  return ok({ captions: captionMode(config.captions), emphasis: config.captionEmphasis ?? "none" });
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
  transitionSeconds: z.number().min(0.3).max(1.8).nullable().optional().describe("How long every layout boundary takes, 0.3–1.8 s, overriding the style's own pace (glide 0.9, dissolve 0.5); null restores the style's own"),
  glow: z.number().min(0).max(0.4).optional().describe("Strength of the accent light on the field, 0 off"),
  grade: z.object({
    contrast: z.number().min(0.7).max(1.5).nullable().optional(),
    saturation: z.number().min(0).max(2).nullable().optional(),
    lift: z.number().min(-0.2).max(0.2).nullable().optional().describe("Brightness offset"),
    warmth: z.number().min(-1).max(1).nullable().optional().describe("Cool (-1) to warm (1); a colour temperature in the film"),
    vignette: z.number().min(0).max(1).nullable().optional(),
  }).optional().describe("The grade on the footage itself, before anything is laid over it: multipliers of 1 and offsets of 0 are neutral; null returns a field to neutral. The film's grade is exact (eq, colour temperature, vignette); the window shows the nearest CSS has."),
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
  const dir = currentProjectDir();
  const config = readComposeConfig(dir).theme ?? {};
  return ok({
    config, resolved: resolveTheme(config), look: describeLook(config, listSavedThemes(mediaRoot()), { direction: readDirection(dir) }),
    assets: listAssets(path.join(currentProjectDir(), "assets")),
  });
});

server.registerTool("set_theme", {
  description:
    "Set the look of the film for consistent branding: a preset, the brand colours, fonts, title/callout/caption styles, a logo watermark and a handle, the transition between layouts (and its seconds), and the grade on the footage. Fields merge into the current theme (null removes a logo or watermark); reset drops every override and keeps the preset. `use` loads a theme saved earlier (the way a channel keeps every video the same); `save_as` saves the result under a name for the next video. Previews at once in the window; chunks the look touches re-render on the next render_final (the field and glow are part of every chunk, so a new preset or accent re-renders the film).",
  inputSchema: {
    ...themeShape,
    reset: z.boolean().optional().describe("Drop all overrides first"),
    use: z.string().optional().describe("Start from a saved theme (id from list_themes): it REPLACES the current look whole — fonts, radius, glow and all — and the other fields then apply on top"),
    save_as: z.string().max(40).optional().describe("Save the resulting theme under this name for other projects"),
  },
}, async ({ reset, use, save_as, ...args }) => {
  const dir = currentProjectDir();
  const config = readComposeConfig(dir);
  const patch = themeFromArgs(args);
  let theme = use ? { ...loadTheme(mediaRoot(), use) } : reset ? (config.theme?.preset ? { preset: config.theme.preset } : {}) : { ...(config.theme ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete theme[key];
    else if (key === "grade") {
      theme.grade = { ...(theme.grade ?? {}) };
      for (const [name, number] of Object.entries(value ?? {})) { if (number === null) delete theme.grade[name]; else theme.grade[name] = number; }
      if (Object.keys(theme.grade).length === 0) delete theme.grade;
    }
    else if (key === "fonts") {
      for (const face of Object.values(value ?? {})) {
        if (face != null && !VENDORED_FONTS.includes(face)) throw new Error(`"${face}" is not a vendored face; the film can only draw ${VENDORED_FONTS.join(", ")}`);
      }
      theme.fonts = { ...(theme.fonts ?? {}), ...value };
    }
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
    "Fetch a picture into the project's assets/ for image, logos or cover graphics or the theme logo: a direct image URL, a page URL (its share image is taken), or a site's icon at 256 px (kind icon, e.g. 'photopea.com'). Returns the project-relative src to use in set_scenes or set_theme.",
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

server.registerTool("import_image", {
  description:
    "Copy a picture from the pipeline host into the project's assets/ for image, logos, cover and the theme logo: the person's own screenshots, product shots, a still they exported. png, jpg or webp (a gif's first frame). Nothing is fetched; fetch_image is for the web. Returns the project-relative src.",
  inputSchema: {
    path: z.string().describe("Absolute path to the file; a Windows path (E:\\Music\\bed.mp3) or a WSL one, either is fine"),
    name: z.string().optional().describe("File name under assets/; the source's own name by default"),
    attribution: z.object({ author: z.string().optional(), license: z.string().optional(), note: z.string().optional() }).optional().describe("Who made it, if not the person; saved beside the asset"),
  },
}, async ({ path: given, name, attribution }) => {
  const dir = currentProjectDir();
  const source = hostPath(given);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`no such file: ${source}`);
  if (!/\.(png|jpe?g|webp|gif)$/i.test(source)) throw new Error("import_image takes png, jpg, webp or gif");
  const ext = path.extname(source).toLowerCase() === ".gif" ? ".png" : path.extname(source).toLowerCase().replace(".jpeg", ".jpg");
  const leaf = `${(name ?? path.basename(source, path.extname(source))).replace(/\.(png|jpe?g|webp|gif)$/i, "").replace(/[^a-z0-9._-]/gi, "_")}${ext}`;
  const assets = path.join(dir, "assets");
  fs.mkdirSync(assets, { recursive: true });
  const target = path.join(assets, leaf);
  if (path.extname(source).toLowerCase() === ".gif") {
    const { execFileSync } = await import("node:child_process");
    execFileSync(FFMPEG, ["-y", "-v", "error", "-i", source, "-frames:v", "1", target]);
  } else fs.copyFileSync(source, target);
  const metadata = { source: `file:${source}`, requestedUrl: null, ...(attribution ?? {}) };
  fs.writeFileSync(`${target}.source.json`, JSON.stringify(metadata, null, 2) + "\n");
  const dims = probeDimensions(target);
  return ok({ src: `assets/${leaf}`, width: dims.width, height: dims.height, bytes: fs.statSync(target).size, attribution: metadata });
});

server.registerTool("import_clip", {
  description:
    "B-roll: bring a video clip the person has — a phone clip, a screen capture, footage they own — into the project's assets/ as a browser-playable mp4 for a `clip` graphic, which plays it in the card while the voice carries on (a side layout beside the head, or a cutaway when the clip is the picture). Re-encoded to H.264 no wider than 1920, its sound kept; the card is silent unless the plan gives the graphic `sound: true` (or `{ level }` in dB), and then the clip's own sound plays under the voice, ducked from the words like the bed. A long file takes a while, so cut it to the part that is wanted with `from` and `seconds`. Returns the src and the clip's length; a scene longer than the clip holds its last frame, and the read-back says so.",
  inputSchema: {
    path: z.string().describe("Path to the video on the pipeline host (mp4/mov/mkv/webm/m4v)"),
    name: z.string().optional().describe("File name under assets/; the source's own name by default"),
    from: z.number().min(0).optional().describe("Seconds into the file to start keeping from (0)"),
    seconds: z.number().min(0.5).max(120).optional().describe("How many seconds to keep (the rest of the file, up to 120)"),
    attribution: z.object({ author: z.string().optional(), license: z.string().optional(), note: z.string().optional() }).optional().describe("Who shot it, if not the person; saved beside the asset and written into the credits"),
  },
}, async ({ path: given, name, from, seconds, attribution }) => {
  const dir = currentProjectDir();
  const source = hostPath(given);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`no such file: ${source}`);
  if (!/\.(mp4|mov|mkv|webm|m4v)$/i.test(source)) throw new Error("import_clip takes mp4, mov, mkv, webm or m4v");
  const leaf = `${(name ?? path.basename(source, path.extname(source))).replace(/\.(mp4|mov|mkv|webm|m4v)$/i, "").replace(/[^a-z0-9._-]/gi, "_")}.mp4`;
  const assets = path.join(dir, "assets");
  fs.mkdirSync(assets, { recursive: true });
  const target = path.join(assets, leaf);
  const { execFileSync } = await import("node:child_process");
  const cut = [...(from ? ["-ss", String(from)] : []), ...(seconds ? ["-t", String(seconds)] : [])];
  // The clip's own sound is kept (aac) so a plan may play it under the
  // voice; the card itself is silent unless the plan says sound: true.
  execFileSync(FFMPEG, ["-y", "-v", "error", ...cut, "-i", source, "-vf", "scale='min(1920,iw)':-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", target], { stdio: ["ignore", "ignore", "pipe"] });
  const metadata = { source: `file:${source}`, requestedUrl: null, from: from ?? 0, ...(attribution ?? {}) };
  fs.writeFileSync(`${target}.source.json`, JSON.stringify(metadata, null, 2) + "\n");
  const dims = probeDimensions(target);
  const length = probeDuration(target);
  const sound = probeHasAudio(target);
  return ok({ src: `assets/${leaf}`, seconds: Number(length.toFixed(2)), width: dims.width, height: dims.height, sound, bytes: fs.statSync(target).size, attribution: metadata, hint: `a clip graphic: { kind: "clip", src: "assets/${leaf}", in: 0, fit: "cover"${sound ? ", sound: true to hear it under the voice" : ""} } over up to ${length.toFixed(1)}s of words, with a side or cutaway stage scene${sound ? "" : "; the file has no sound track"}` });
});

server.registerTool("list_assets", {
  description: "Pictures and clips already in the project's assets/ (fetched, imported, or chosen in the inspector), as project-relative srcs; a clip carries its length in seconds.",
  inputSchema: {},
}, async () => {
  const dir = currentProjectDir();
  // A clip is listed with its length, which is what a scene over it needs.
  const assets = listAssets(path.join(dir, "assets")).map((asset) => {
    if (asset.kind !== "clip") return asset;
    try { return { ...asset, seconds: Number(probeDuration(path.join(dir, asset.src)).toFixed(2)), sound: probeHasAudio(path.join(dir, asset.src)) }; } catch { return asset; }
  });
  return ok({ assets });
});

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
    const stale = staleness(dir).map((s) => s.next);
    if (stale.includes("render_clean") || stale.includes("retranscribe_clean")) {
      throw new Error(`nothing to re-anchor to yet: the cut changed but the clean cut has not been re-rendered. render_clean, then retranscribe_clean (which keeps the previous transcript), then reanchor_scenes — the plan follows the words across.`);
    }
    throw new Error("no clean.previous.json: the previous transcript is kept by retranscribe_clean from now on; place the scenes with list_clean_words and set_scenes this once");
  }
  const oldWords = flattenWords(readJson(paths.previousCleanTranscript));
  const newWords = cleanWords(dir);
  const config = readComposeConfig(dir);
  const report = reanchorScenes(config.scenes ?? [], oldWords, newWords);
  const unresolved = report.filter((r) => !r.ok);
  // An unresolved scene keeps its old ids — clamped to the new transcript
  // when the old ones no longer exist, so the moved scenes can still be
  // written and the person sees the stranded one where the film now ends.
  const lastId = newWords.at(-1)?.id ?? 0;
  const clamp = (id) => Math.min(Math.max(id, 0), lastId);
  if (apply) {
    for (const entry of unresolved) {
      const scene = config.scenes[entry.index];
      if (scene) { scene.fromWordId = clamp(scene.fromWordId); scene.toWordId = clamp(Math.max(scene.toWordId, scene.fromWordId)); }
    }
    for (const entry of report) {
      if (!entry.ok) continue;
      config.scenes[entry.index].fromWordId = entry.fromWordId;
      config.scenes[entry.index].toWordId = entry.toWordId;
    }
    validateScenes(config.scenes ?? [], newWords, { motionLibs: installedMotionLibs() });
    config.cutIdentity = cleanTranscriptStamp(dir) ?? config.cutIdentity;
    if (!config.cutIdentity) delete config.cutIdentity;
    writeComposeConfig(dir, config);
  }
  return ok({
    applied: apply,
    moved: report.filter((r) => r.ok && r.shiftSeconds !== 0).length,
    unchanged: report.filter((r) => r.ok && r.shiftSeconds === 0).length,
    unresolved: unresolved.map((r) => ({ index: r.index, type: r.type, reason: r.reason, fromWordId: r.fromWordId, toWordId: r.toWordId })),
    scenes: report.map((r) => (r.ok
      ? { index: r.index, type: r.type, fromWordId: r.fromWordId, toWordId: r.toWordId, shiftSeconds: r.shiftSeconds, confidence: r.confidence, text: r.text.length > 90 ? `${r.text.slice(0, 87)}…` : r.text }
      : { index: r.index, type: r.type, unresolved: r.reason })),
  });
});

server.registerTool("render_final", {
  description:
    "The composited render, as a background job: the head and screen tracks are placed on the film's stage by ffmpeg from the stage engine's own numbers (punch-ins included), the overlays are captured from the same runtime the preview uses only where they change, and the film is built in cached chunks of six to thirty seconds — a tweak re-renders the chunks it touched and copies the rest, and the sound is made alongside the picture and copied in beside it. Writes out/final.mp4, or out/preview-<from>-<to>.mp4 for a word range, or out/draft.mp4 at half size with draft: true. A whole film is minutes, a draft a fraction of that; the window shows progress. Returns when done or, past wait_seconds, as still running (then wait_render). Never re-renders the clean cut.",
  inputSchema: {
    from_word_id: z.number().int().min(0).optional().describe("Render only from this clean word…"),
    to_word_id: z.number().int().min(0).optional().describe("…to this clean word (inclusive)"),
    fresh: z.boolean().optional().describe("Ignore cached chunks and render every one again"),
    draft: z.boolean().optional().describe("The whole film at half size to out/draft.mp4, in a fraction of the time, with its own chunk cache: for looking at the film in motion before the real render. Never the deliverable."),
    wait_seconds: waitSchema,
  },
}, async ({ from_word_id, to_word_id, fresh, draft, wait_seconds }) => {
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
  // By the book: the real render waits until nothing measurable is broken.
  // A draft and a preview span are how the faults get found, so they pass.
  const direction = readDirection(dir);
  if (!draft && from_word_id === undefined && to_word_id === undefined && rulesFor(direction).id === "strict") {
    const ruled = directionRefusal(readComposeConfig(dir).scenes ?? [], direction);
    if (ruled) throw new Error(`the person's direction is By the book, and the plan still holds what it rules out — ${ruled.replace(/;? ?nothing was written\.?$/, "")}. Replace it before the real render, or render a draft to look at.`);
    const review = critiqueNow(dir, { sound: false });
    // What this render replaces is no reason to refuse it: a final.mp4 that
    // is out of date, or of the wrong shape or length, is what it fixes.
    const replaced = (finding) => finding.kind === "wrong-shape" || finding.kind === "wrong-length" || (finding.kind === "stale" && /^final\.mp4\b/.test(finding.what ?? ""));
    const faults = review.findings.filter((finding) => finding.severity === "fault" && !replaced(finding));
    if (faults.length) {
      throw new Error(`the person's direction is By the book, and critique_film finds ${faults.length} fault${faults.length === 1 ? "" : "s"} to fix before the real render: ${faults.slice(0, 5).map((f) => f.what ?? f.title ?? JSON.stringify(f)).join("; ")}. Fix them (critique_film lists each with its fix), or render a draft to look at.`);
    }
  }
  noteActivity(draft ? "draft" : (from_word_id !== undefined || to_word_id !== undefined ? "preview span" : "film"));
  const options = { fresh, ...(draft ? { draft: true } : {}) };
  let output = draft ? path.join(dir, "out", "draft.mp4") : paths.final;
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
  const live = runningJob(dir);
  const stage = live?.stage ?? readProgress(dir)?.stage ?? lastJobStage(dir);
  if (!stage) return ok({ done: true, running: false, hint: "no job has run in this project" });
  if (!live) {
    // Nothing is running: what follows is how the LAST job ended, which is
    // not the same as its output being current.
    const stale = staleness(dir);
    return ok({ done: true, running: false, ...describeFinished(dir, stage), note: `no job is running now; this is how the last one (${stage}) ended.${stale.length ? ` status says ${stale.map((s) => `${s.artifact} is stale (${s.next})`).join(", ")}.` : " Nothing is stale."}` });
  }
  return settle(dir, wait_seconds, () => describeFinished(dir, stage));
});

server.registerTool("status", {
  description: "Current project state: what is staged, transcribed, reviewed, and rendered, with cut statistics, whether a look has been chosen (and the brands this person has saved), the person's direction (their brief from Make it into a video) and the film's treatment when they exist, the motion scenes written, the running background job if any, what is stale and which tool fixes it. Read it before repeating a step.",
  inputSchema: {},
}, async () => {
  if (!fs.existsSync(pointerFile())) return ok({ project: null, root: mediaRoot(), hint: "no project is open: list_projects shows what exists, switch_project opens one, open_project starts one from a recording" });
  const pointer = readJson(pointerFile());
  answeredProject = pointer.dir; // status is the read that takes a switch up
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
  state.look = describeLook(readComposeConfig(dir).theme, listSavedThemes(mediaRoot()), { direction: readDirection(dir) });
  state.clean = cleanSummary(dir, { measure: true });
  {
    const target = readComposeConfig(dir).audio?.voice?.loudness;
    if (state.clean?.voiceNote && typeof target === "number") state.clean.voiceNote = `the voice measures ${state.clean.voiceLoudness} LUFS as recorded; the stitch brings it to the ${target} LUFS target already set`;
  }
  state.stale = staleness(dir);
  // Who this session is working as: adopted in the session, else what the
  // launcher said.
  state.persona = adoptedPersona ?? (PERSONA_IDS.includes(process.env.FABULA_PERSONA) ? process.env.FABULA_PERSONA : null);
  // The person's brief, when they pressed Make it into a video, and the
  // film's idea as written down; get_direction and get_treatment in full.
  state.direction = describeDirection(readDirection(dir));
  state.treatment = describeTreatment(readTreatment(dir));
  {
    const folder = path.join(dir, "motion");
    state.motion = fs.existsSync(folder) ? fs.readdirSync(folder).filter((file) => /\.html$/.test(file)).map((file) => `motion/${file}`) : [];
  }
  // What is in out/ that a person would hand over: the film, previews, the
  // caption files, the thumbnail, the chapter list, the credits.
  state.deliverables = outputs(dir).map(({ name, kind, bytes }) => ({ name, kind, bytes }));
  return ok(state);
});

await server.connect(new StdioServerTransport());
