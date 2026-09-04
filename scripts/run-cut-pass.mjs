// Slice-1 batch driver: WhisperX JSON + raw video in, review.json and a
// rendered clean video out. The cut decisions live in core/cut-engine.mjs and
// the I/O in scripts/pipeline.mjs; this is the no-UI, no-MCP way to run them.
//
//   node scripts/run-cut-pass.mjs <transcript.json> <raw-video> <out-dir>

import fs from "node:fs";
import path from "node:path";
import { probeDuration, computeReview, reviewStats, renderClean } from "./pipeline.mjs";

const [transcriptPath, videoPath, outDir] = process.argv.slice(2);
if (!transcriptPath || !videoPath || !outDir) {
  console.error("usage: node scripts/run-cut-pass.mjs <transcript.json> <raw-video> <out-dir>");
  process.exit(2);
}

const transcript = JSON.parse(fs.readFileSync(transcriptPath, "utf8"));
const review = computeReview(transcript, videoPath, probeDuration(videoPath));
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "review.json"), JSON.stringify(review, null, 2));

const wordText = new Map(review.words.map((word) => [word.id, word.text]));
console.log(`${review.words.length} words over ${review.duration.toFixed(1)}s`);
for (const cut of review.cuts) {
  const reasons = cut.sources.map((s) => s.reason + (s.detail ? `:${s.detail}` : "")).join("+");
  const anchor = cut.sources.flatMap((s) => s.wordIds).map((id) => wordText.get(id)).join(" … ");
  console.log(`  cut ${cut.start.toFixed(2)}–${cut.end.toFixed(2)}s  ${reasons}  near "${anchor}"`);
}
const stats = reviewStats(review);
console.log(`${stats.cuts} cuts, ${stats.removedSeconds}s removed -> clean ${stats.cleanSeconds}s`);

const result = renderClean(videoPath, review.cuts, review.duration, path.join(outDir, "clean.mp4"));
console.log(`wrote ${result.path} (${(result.bytes / 1e6).toFixed(1)} MB, ${result.keeps} segments)`);
