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
//   node scripts/job.mjs motion_film   media/<project>   (a motion film's stand-in recording, its words and its clean cut)
//
// Exit 0 on success with progress.json cleared, 1 on failure with the note
// left in progress.json and the error on stderr (captured to out/<stage>.log).

import fs from "node:fs";
import path from "node:path";
import { validateFraming } from "../core/framing-engine.mjs";
import { editorialCuts } from "../core/story-engine.mjs";
import { normalizeCuts } from "../core/cut-engine.mjs";
import { ceilingOf } from "../core/formats.mjs";
import { spawnSync } from "node:child_process";
import { readProjectMeta } from "./project-state.mjs";
import {
  REPO_ROOT,
  FFMPEG,
  probeDimensions,
  probeDuration,
  measureLoudness,
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
  console.error("usage: node scripts/job.mjs <render_clean|transcribe|retranscribe|refresh_clean|first_pass|motion_film> <project-dir>");
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
      words: review.words,
      framing,
      source: video.source,
      ceiling: ceilingOf(readProjectMeta(dir)),
      onProgress: (detail) => { report(detail); },
    });
    say(`wrote ${result.path} (${(result.bytes / 1e6).toFixed(1)} MB, ${result.pieces} pieces from ${result.keeps} keeps) in ${result.seconds}s; identity ${result.map.identity}`);
    // The voice's loudness, once, beside the map: status carries it, and a
    // voice thirty units under where platforms play is worth knowing before
    // anyone composes a frame.
    try {
      const loudness = measureLoudness(result.path);
      if (typeof loudness === "number") {
        fs.writeFileSync(path.join(dir, "out", "clean-audio.json"), JSON.stringify({ identity: result.map.identity, voiceLoudness: loudness }, null, 2));
        say(`voice measures ${loudness} LUFS`);
      }
    } catch (error) { say(`voice not measured: ${error.message}`); }
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
    // A motion film is never cut, so its clean cut says exactly what its
    // stand-in said: the narration's words, or none. Whisper over a silent
    // film only invents a "Thank you." at the end.
    if (readProjectMeta(dir).kind === "motion") {
      const current = path.join(dir, "clean.json");
      const transcript = readJson(path.join(dir, "raw.json"));
      transcript.fabula = { cutIdentity: map.cutIdentity, cleanIdentity: map.identity };
      fs.writeFileSync(current, JSON.stringify(transcript));
      say(`a motion film: clean.json is its narration's transcript as it stands (${transcript.segments.length} segments), stamped ${map.cutIdentity}`);
      return;
    }
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
      // The cuts an editor makes from reading, as proposals beside the
      // pauses and fillers: the preamble, a false start, a stutter, a retake.
      // The person toggles them in the Cut step like the rest.
      const byId = new Map(review.words.map((word) => [word.id, word]));
      const pad = 0.04;
      const editorial = editorialCuts(review.words).map((cut) => {
        const first = byId.get(cut.fromWordId);
        const last = byId.get(cut.toWordId);
        return {
          start: Math.max(first.start - pad, 0), end: last.end + pad, reason: cut.reason, detail: cut.detail, enabled: true,
          wordIds: review.words.filter((word) => word.start >= first.start && word.end <= last.end).map((word) => word.id),
        };
      });
      review.cuts = normalizeCuts([...review.cuts, ...editorial]);
      fs.writeFileSync(reviewFile, JSON.stringify(review, null, 2));
      say(`proposed ${review.cuts.length} cuts at a 0.8 s minimum pause${editorial.length ? `, ${editorial.length} of them from the words (${[...new Set(editorial.map((c) => c.reason))].join(", ")})` : ""}`);
    }
  },

  // A motion film has no recording. Its stand-in is made here — raw.mp4, a
  // still picture as long as the film with the narration (or silence) as its
  // sound — and then it takes the path every recording takes: transcript,
  // review (with nothing to cut), clean cut, clean transcript. Everything
  // downstream, from the sound mix to the chunk cache, then works unchanged.
  // The picture is never seen: a motion film's stage is a cutaway throughout.
  async motion_film(report) {
    const meta = readProjectMeta(dir);
    if (meta.kind !== "motion") throw new Error("not a motion film (project.json kind)");
    const motion = meta.motion ?? {};
    const raw = path.join(dir, "raw.mp4");
    const narration = motion.narration ? path.join(dir, motion.narration) : null;
    if (narration && !fs.existsSync(narration)) throw new Error(`the narration ${motion.narration} is not in the project`);
    if (!fs.existsSync(raw)) {
      const seconds = narration ? probeDuration(narration) + (motion.tail ?? 1) : motion.seconds;
      if (!(seconds > 0)) throw new Error("a motion film needs a length or a narration");
      const tall = meta.format === "vertical";
      const size = tall ? "360x640" : "640x360";
      report("Making the film's stand-in");
      const args = ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=black:s=${size}:r=30:d=${seconds.toFixed(3)}`];
      if (narration) args.push("-i", narration, "-filter_complex", "[1:a]aresample=48000,apad[a]", "-map", "0:v", "-map", "[a]");
      else args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-map", "0:v", "-map", "1:a");
      args.push("-t", seconds.toFixed(3), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "35", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ac", "2", raw);
      const made = spawnSync(FFMPEG, args, { encoding: "utf8" });
      if (made.status !== 0) throw new Error(`the stand-in could not be made: ${(made.stderr || "").slice(-600)}`);
      say(`stand-in: ${seconds.toFixed(2)} s, ${narration ? `narration ${motion.narration}` : "silent"}`);
    }
    const transcriptFile = path.join(dir, "raw.json");
    if (!fs.existsSync(transcriptFile)) {
      if (narration) {
        report("Transcribing the narration on the GPU (WhisperX large-v3)");
        const transcript = transcribe(raw, transcriptFile);
        say(`narration transcribed: ${transcript.segments.length} segments`);
      } else {
        fs.writeFileSync(transcriptFile, JSON.stringify({ segments: [], language: "en" }));
        say("no narration: an empty transcript");
      }
    }
    const reviewFile = path.join(dir, "review.json");
    if (!fs.existsSync(reviewFile)) {
      const review = computeReview(readJson(transcriptFile), raw, probeDuration(raw));
      review.cuts = [];
      fs.writeFileSync(reviewFile, JSON.stringify(review, null, 2));
    }
    await steps.refresh_clean(report);
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
  motion_film: "Making the motion film's clock",
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
