// A background job: one long pipeline step run as its own detached process,
// so it finishes whether or not the MCP session that asked for it is still
// alive. The MCP server starts these (see startJob in pipeline.mjs); the
// window follows progress.json; a later `status` or `wait_render` reads the
// result off disk. Run by hand for the same effect:
//
//   node scripts/job.mjs render_clean media/<project>
//   node scripts/job.mjs transcribe   media/<project>
//   node scripts/job.mjs retranscribe media/<project>
//
// Exit 0 on success with progress.json cleared, 1 on failure with the note
// left in progress.json and the error on stderr (captured to out/<stage>.log).

import fs from "node:fs";
import path from "node:path";
import {
  REPO_ROOT,
  probeDimensions,
  transcribe,
  renderClean,
  cleanPlan,
  withProgress,
  readProgress,
  encoderCapabilities,
} from "./pipeline.mjs";

const [stage, dirArg] = process.argv.slice(2);
if (!stage || !dirArg) {
  console.error("usage: node scripts/job.mjs <render_clean|transcribe|retranscribe> <project-dir>");
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
};

const labels = {
  render_clean: "Rendering the clean cut",
  transcribe: "Transcribing on the GPU",
  retranscribe: "Transcribing the clean cut",
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
