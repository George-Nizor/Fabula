// A background job: one long pipeline step run as its own detached process,
// so it finishes whether or not the MCP session that asked for it is still
// alive. The MCP server starts these (see startJob in pipeline.mjs); the
// window follows progress.json; a later `status` or `wait_render` reads the
// result off disk. Run by hand for the same effect:
//
//   node scripts/job.mjs render_clean  media/<project>
//   node scripts/job.mjs transcribe    media/<project>
//   node scripts/job.mjs retranscribe  media/<project>
//   node scripts/job.mjs refresh_clean media/<project>   (render_clean, then retranscribe; each skipped when current)
//   node scripts/job.mjs first_pass    media/<project>   (transcribe, scan the framing, propose cuts; each skipped when done)
//
// Exit 0 on success with progress.json cleared, 1 on failure with the note
// left in progress.json and the error on stderr (captured to out/<stage>.log).

import fs from "node:fs";
import path from "node:path";
import { validateFraming } from "../core/framing-engine.mjs";
import { ceilingOf } from "../core/formats.mjs";
import { readProjectMeta } from "./project-state.mjs";
import {
  REPO_ROOT,
  probeDimensions,
  probeDuration,
  scanFraming,
  computeReview,
  transcribe,
  renderClean,
  cleanPlan,
  cleanCurrent,
  cleanTranscriptCurrent,
  withProgress,
  readProgress,
  encoderCapabilities,
} from "./pipeline.mjs";

const [stage, dirArg] = process.argv.slice(2);
if (!stage || !dirArg) {
  console.error("usage: node scripts/job.mjs <render_clean|transcribe|retranscribe|refresh_clean> <project-dir>");
  process.exit(2);
}
const dir = path.resolve(REPO_ROOT, dirArg);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sourceVideo() {
  const raw = fs.readdirSync(dir).find((name) => /^raw\.(mp4|mov|mkv|webm|m4v)$/i.test(name));
  if (raw) {
    const file = path.join(dir, raw);
    return { path: file, source: { path: file, bytes: fs.statSync(file).size } };
  }
  const source = readJson(path.join(dir, "source.json"));
  return { path: source.path, source: { path: source.path, bytes: source.bytes ?? fs.statSync(source.path).size } };
}

const say = (text) => console.log(`[${new Date().toISOString()}] ${text}`);

// The scan's proposals as a framing, only where no judgment is needed. A run
// the scan calls "full" always carries a camera-inset guess, right for an OBS
// scene with a screen and wrong for a plain talking head; only a look at the
// frames tells them apart, so those are left for the assistant. null: nothing
// to declare. false: a person has to choose.
function autoFraming(scan) {
  if (scan.runs.some((run) => run.kind === "full" || run.proposal.screen)) {
    const whole = scan.runs.length === 1 && scan.runs[0].kind === "full";
    if (whole) say("one full-frame run; a camera inset cannot be told from a plain head by the scan alone, so the frame stays whole until someone looks");
    return whole ? null : false;
  }
  const segments = scan.runs.map((run) => ({ start: run.start, end: run.end, head: run.proposal.head, screen: null }));
  try {
    validateFraming({ segments }, scan.dims, scan.duration);
    return { segments };
  } catch (error) {
    say(`framing not applied: ${error.message}`);
    return false;
  }
}

const steps = {
  async render_clean(report) {
    const review = readJson(path.join(dir, "review.json"));
    const framingFile = path.join(dir, "framing.json");
    const framing = fs.existsSync(framingFile) ? readJson(framingFile) : null;
    const video = sourceVideo();
    const caps = encoderCapabilities();
    say(`clean render: ${video.path} → out/clean.mp4 with ${caps.nvenc ? "h264_nvenc" : "libx264"} (${caps.version})`);
    const result = await renderClean(video.path, review.cuts, review.duration, path.join(dir, "out", "clean.mp4"), {
      framing,
      source: video.source,
      ceiling: ceilingOf(readProjectMeta(dir)),
      onProgress: (detail) => { report(detail); },
    });
    say(`wrote ${result.path} (${(result.bytes / 1e6).toFixed(1)} MB, ${result.pieces} pieces from ${result.keeps} keeps) in ${result.seconds}s; identity ${result.map.identity}`);
    return result;
  },

  async transcribe(report) {
    const video = sourceVideo();
    report("WhisperX large-v3 on the GPU");
    const transcript = transcribe(video.path, path.join(dir, "raw.json"));
    say(`transcribed: ${transcript.segments.length} segments`);
  },

  async retranscribe(report) {
    const clean = path.join(dir, "out", "clean.mp4");
    if (!fs.existsSync(clean)) throw new Error("no out/clean.mp4 to transcribe");
    const map = readJson(path.join(dir, "out", "clean-map.json"));
    // The transcript being replaced is what reanchor_scenes matches the
    // scenes' old word ids against; keep it beside the new one.
    const current = path.join(dir, "clean.json");
    if (fs.existsSync(current)) fs.copyFileSync(current, path.join(dir, "clean.previous.json"));
    report("WhisperX large-v3 over the clean cut");
    const transcript = transcribe(clean, current, { stamp: { cutIdentity: map.cutIdentity, cleanIdentity: map.identity } });
    say(`transcribed the clean cut: ${transcript.segments.length} segments, stamped ${map.cutIdentity}`);
  },

  // Everything mechanical between a recording and a reviewable cut, without a
  // word from anyone: the transcript, where the head sits in the frame, and
  // the cut proposals. Runs when a project is created; each part is skipped
  // when its result already exists, so it is safe to run again.
  async first_pass(report) {
    const video = sourceVideo();
    const transcriptFile = path.join(dir, "raw.json");
    if (fs.existsSync(transcriptFile)) say("raw.json exists; not transcribing again");
    else {
      report("Transcribing on the GPU (WhisperX large-v3)");
      const transcript = transcribe(video.path, transcriptFile);
      say(`transcribed: ${transcript.segments.length} segments`);
    }
    const framingFile = path.join(dir, "framing.json");
    const scanFile = path.join(dir, "framing-scan.json");
    if (fs.existsSync(framingFile)) say("framing.json exists; keeping it");
    else if (fs.existsSync(scanFile)) say("framing-scan.json exists; the framing was left for a person to decide");
    else {
      report("Scanning for the head in the frame");
      const scan = await scanFraming(video.path, path.join(dir, "framing"));
      fs.writeFileSync(scanFile, JSON.stringify(scan, null, 2));
      const framing = autoFraming(scan);
      if (framing === null) say("one run, the whole frame: no framing to declare");
      else if (framing) { fs.writeFileSync(framingFile, JSON.stringify(framing, null, 2)); say(`framing: ${framing.segments.length} segment(s), ${framing.segments.filter((s) => s.screen).length} with a screen`); }
      else say("framing left as the whole frame for now: framing-scan.json has the runs and framing/ the frames; the assistant sets the framing after looking at them when it composes");
    }
    const reviewFile = path.join(dir, "review.json");
    if (fs.existsSync(reviewFile)) say("review.json exists; keeping the person's cut toggles");
    else {
      report("Proposing cuts");
      const transcript = readJson(transcriptFile);
      const review = computeReview(transcript, video.path, probeDuration(video.path), { minGapSeconds: 0.8 });
      fs.writeFileSync(reviewFile, JSON.stringify(review, null, 2));
      say(`proposed ${review.cuts.length} cuts at a 0.8 s minimum pause`);
    }
  },

  // The window's one button for "the cuts moved": the clean render and its
  // transcript, each skipped when it already matches, so pressing it twice
  // costs nothing the second time.
  async refresh_clean(report) {
    const review = readJson(path.join(dir, "review.json"));
    const framingFile = path.join(dir, "framing.json");
    const framing = fs.existsSync(framingFile) ? readJson(framingFile) : null;
    const video = sourceVideo();
    const cleanFile = path.join(dir, "out", "clean.mp4");
    const mapFile = path.join(dir, "out", "clean-map.json");
    const map = fs.existsSync(mapFile) ? readJson(mapFile) : null;
    const plan = cleanPlan({ review, framing, dims: framing ? null : probeDimensions(video.path), source: video.source, ceiling: ceilingOf(readProjectMeta(dir)) });
    if (plan.keeps.length === 0) throw new Error("every moment is cut; nothing to render");
    if (cleanCurrent(map, plan, cleanFile)) say("clean.mp4 already matches the cut list and framing");
    else await steps.render_clean(report);
    const current = readJson(mapFile);
    if (cleanTranscriptCurrent(path.join(dir, "clean.json"), cleanFile, current)) say("clean.json already describes this clean cut");
    else await steps.retranscribe(report);
  },
};

const labels = {
  first_pass: "The first pass",
  render_clean: "Rendering the clean cut",
  transcribe: "Transcribing on the GPU",
  retranscribe: "Transcribing the clean cut",
  refresh_clean: "Refreshing the clean cut",
};

const step = steps[stage];
if (!step) {
  console.error(`unknown stage ${stage}`);
  process.exit(2);
}

// The server claimed progress.json with this pid before we started; the
// label it wrote is kept by withProgress because the stage matches.
const claimed = readProgress(dir);
try {
  await withProgress(dir, stage, claimed?.stage === stage ? claimed.label : labels[stage], step);
  say("done");
} catch (error) {
  console.error(error);
  process.exit(1);
}
