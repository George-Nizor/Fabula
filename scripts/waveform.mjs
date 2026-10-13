#!/usr/bin/env node
// The Cut step's waveform for a project that has none yet: one made before
// the cut pass wrote it, or one whose file was removed. The window starts
// this in the background when it opens such a project.
//
//   node scripts/waveform.mjs <project-dir>
import { stagedVideo } from "./project-state.mjs";
import { loudnessEnvelope, probeDuration, writeWaveform } from "./pipeline.mjs";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/waveform.mjs <project-dir>");
  process.exit(2);
}
const video = stagedVideo(dir);
if (!video) {
  console.error(`no recording staged in ${dir}`);
  process.exit(1);
}
const envelope = loudnessEnvelope(video, probeDuration(video));
if (!envelope) {
  console.error("the recording has no audio ffmpeg could read");
  process.exit(1);
}
writeWaveform(dir, envelope);
console.log(`waveform: ${envelope.db.length} frames`);
