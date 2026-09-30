import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listProjects, describeProject, PROJECT_NAME_RE, writeProjectTitle, slugify, cleanTitle, wslJob } from "../scripts/project-state.mjs";

function mediaRoot(layout) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabula-projects-"));
  for (const [name, files] of Object.entries(layout)) {
    fs.mkdirSync(path.join(root, name, "out"), { recursive: true });
    for (const [file, body] of Object.entries(files)) fs.writeFileSync(path.join(root, name, file), body);
  }
  return root;
}

const source = (file) => JSON.stringify({ path: file, container: path.extname(file), bytes: 1234 });

test("projects are the staged folders, staged newest first, at the stage their files say", () => {
  const root = mediaRoot({
    fresh: { "source.json": source("/mnt/e/clips/fresh.mkv") },
    cut: { "source.json": source("/mnt/e/clips/talk.mp4"), "raw.json": "{}", "review.json": "{}" },
    done: { "source.json": source("/mnt/e/clips/done.mp4"), "raw.json": "{}", "review.json": "{}", "compose.json": "{}", "out/clean.mp4": "x", "out/final.mp4": "x" },
    themes: { "broadcast.json": "{}" },
  });
  fs.writeFileSync(path.join(root, "current-project.json"), "{}");
  try {
    const old = new Date("2026-01-01T00:00:00Z");
    for (const file of ["source.json", "raw.json", "review.json"]) fs.utimesSync(path.join(root, "cut", file), old, old);
    const projects = listProjects(root, { videoPresent: (file) => file.endsWith("talk.mp4") });
    assert.deepEqual(projects.map((p) => p.name), ["fresh", "done", "cut"].sort((a, b) => {
      const at = (n) => projects.find((p) => p.name === n).modifiedAt;
      return at(b).localeCompare(at(a)) || a.localeCompare(b);
    }));
    assert.equal(projects.at(-1).name, "cut", "the old project sorts last");
    const byName = Object.fromEntries(projects.map((p) => [p.name, p]));
    assert.equal(byName.fresh.stage, "staged");
    assert.equal(byName.cut.stage, "cut");
    assert.equal(byName.done.stage, "final");
    assert.equal(byName.done.stageLabel, "film rendered");
    assert.equal(byName.cut.videoPresent, true);
    assert.equal(byName.done.videoPresent, false);
    assert.equal(byName.fresh.videoName, "fresh.mkv");
    assert.equal(byName.fresh.bytes, 1234);
    assert.ok(!("themes" in byName), "a folder that stages nothing is not a project");
    assert.equal(describeProject(path.join(root, "current-project.json")), null, "a file is not a project");
    assert.equal(describeProject(path.join(root, "nowhere")), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a project's title lives beside it and renaming moves nothing", () => {
  const root = mediaRoot({ "apple-man-sam-3": { "source.json": source("/mnt/e/clips/2026-09-07_10-21-28.mkv") } });
  try {
    const dir = path.join(root, "apple-man-sam-3");
    assert.equal(describeProject(dir).title, "apple-man-sam-3", "no title yet: the folder name stands in");
    assert.equal(writeProjectTitle(dir, "  Apple Man Sam,   episode 3 "), "Apple Man Sam, episode 3");
    assert.equal(describeProject(dir).title, "Apple Man Sam, episode 3");
    assert.equal(describeProject(dir).name, "apple-man-sam-3", "the folder did not move");
    assert.throws(() => writeProjectTitle(dir, "   "), /needs a name/);
    assert.throws(() => cleanTitle(""), /needs a name/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a folder name is a slug of the title", () => {
  assert.equal(slugify("Apple Man Sam, episode 3"), "apple-man-sam-episode-3");
  assert.equal(slugify("2026-09-07_10-21-28"), "2026-09-07-10-21-28");
  assert.equal(slugify("Café à Paris"), "cafe-a-paris");
  assert.match(slugify("!!!"), /^project-[a-z0-9]+$/);
});

test("a window starts a job in WSL with its arguments as they are, logging from inside", () => {
  const spec = { stage: "first_pass", program: "node", args: ["scripts/job.mjs", "first", "/w/media/it's"] };
  const { command, args } = wslJob(spec, { root: "/w/Fabula", distro: "Ubuntu", dir: "/w/media/it's" });
  assert.equal(command, "wsl.exe");
  // -e, not --: through `--` the distribution's shell expanded "$PATH" before the login shell ran.
  assert.deepEqual(args.slice(0, 5), ["-d", "Ubuntu", "-e", "bash", "-lc"]);
  assert.equal(args.length, 6);
  assert.match(args[5], /^cd '\/w\/Fabula' && export PATH='\/w\/Fabula\/bin':"\$PATH" && 'node' 'scripts\/job.mjs' 'first' '\/w\/media\/it'\\''s'/);
  assert.ok(args[5].endsWith(` >> '/w/media/it'\\''s/out/first_pass.log' 2>&1`));
});

test("project names are leaf folder names, never paths", () => {
  for (const bad of ["../etc", "a/b", ".hidden", "", "with space"]) assert.ok(!PROJECT_NAME_RE.test(bad), bad);
  for (const good of ["applemansam-demo", "obs-2026-04-26", "Talk_2"]) assert.ok(PROJECT_NAME_RE.test(good), good);
});

import { waitForJob, runningJob, reportProgress, startJob, readProgress } from "../scripts/pipeline.mjs";
import { appendInbox, takeInbox, pendingInbox } from "../scripts/inbox.mjs";
import { spawnSync } from "node:child_process";

const until = async (check, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 25))) {
    const value = check();
    if (value) return value;
  }
  return check();
};

test("a job that dies before it can report is recorded as failed, in the last words of its log", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabula-job-"));
  try {
    // What the Windows bridge met: the login shell found no node, and nothing ever said so.
    startJob(dir, "first_pass", "The first pass", "sh", ["-c", "echo 'bash: line 1: node: command not found' >&2; exit 127"]);
    const failed = await until(() => readProgress(dir)?.detail?.startsWith("failed:") && readProgress(dir));
    assert.equal(failed.detail, "failed: bash: line 1: node: command not found");

    // A job that reports its own failure keeps its words.
    const own = `const fs = require("fs"); const p = JSON.parse(fs.readFileSync("progress.json", "utf8")); p.detail = "failed: ffmpeg said no"; fs.writeFileSync("progress.json", JSON.stringify(p)); process.exit(1);`;
    const { pid } = startJob(dir, "render_clean", "The clean cut", process.execPath, ["-e", own], { cwd: dir });
    await until(() => readProgress(dir)?.detail === "failed: ffmpeg said no");
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(readProgress(dir).detail, "failed: ffmpeg said no");

    // A job that finished cleared its record, and its exit leaves it cleared.
    startJob(dir, "render_clean", "The clean cut", "sh", ["-c", "sleep 0.2; rm -f progress.json; exit 0"], { cwd: dir });
    assert.equal(await until(() => readProgress(dir) === null), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a job found dead by its pid is reported with what its log said last", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabula-job-"));
  try {
    const gone = spawnSync(process.execPath, ["-e", ""]).pid;
    fs.mkdirSync(path.join(dir, "out"));
    fs.writeFileSync(path.join(dir, "out", "render_final.log"), "frame 120\nffmpeg: Conversion failed!\n\n");
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(dir, "progress.json"), JSON.stringify({ stage: "render_final", label: "The film", detail: "starting", startedAt: now, updatedAt: now, pid: gone, platform: process.platform }));
    assert.equal(runningJob(dir), null);
    assert.match(readProgress(dir).detail, /^failed: the render_final process \(pid \d+\) died before finishing \(ffmpeg: Conversion failed!\); see out\/render_final\.log$/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a job record nobody here can vouch for is reported as stale, not spun on", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabula-job-"));
  try {
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    fs.writeFileSync(path.join(dir, "progress.json"), JSON.stringify({ stage: "render_final", label: "Rendering", detail: "starting", startedAt: old, updatedAt: old, pid: 4242, platform: "some-other-platform" }));
    const started = Date.now();
    const result = await waitForJob(dir, 0);
    assert.equal(result.state, "stale", JSON.stringify(result));
    assert.ok(Date.now() - started < 2000, "returned at once");
    // A transcription seen from the other platform is trusted for longer: it reports once and runs silently.
    fs.writeFileSync(path.join(dir, "progress.json"), JSON.stringify({ stage: "retranscribe", label: "Transcribing", detail: "starting", startedAt: old, updatedAt: old, pid: 4242, platform: "some-other-platform" }));
    assert.ok(runningJob(dir), "a ten-minute-old transcription is still running");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the inbox is taken by moving it aside, so nothing appended meanwhile is lost", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabula-inbox-"));
  try {
    appendInbox(dir, { type: "message", text: "one" });
    appendInbox(dir, { type: "message", text: "two" });
    const taken = takeInbox(dir);
    assert.deepEqual(taken.map((e) => e.text), ["one", "two"]);
    assert.deepEqual(pendingInbox(dir), []);
    appendInbox(dir, { type: "message", text: "three" });
    assert.deepEqual(takeInbox(dir).map((e) => e.text), ["three"]);
    assert.deepEqual(takeInbox(dir), []);
    assert.ok(!fs.readdirSync(dir).some((name) => name.endsWith(".taking")), "no taking file is left behind");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the sound summary reads loudness, range, true peak and the floor out of ffmpeg's reports", async () => {
  const { parseSoundSummary } = await import("../scripts/pipeline.mjs");
  const ebur = "  Integrated loudness:\n    I:         -14.3 LUFS\n    Threshold: -24.6 LUFS\n\n  Loudness range:\n    LRA:         6.1 LU\n\n  True peak:\n    Peak:       -0.8 dBFS\n";
  const stats = "[Parsed_astats_0 @ 0x1] RMS level dB: -18.3\n[Parsed_astats_0 @ 0x1] Noise floor dB: -62.9\n";
  assert.deepEqual(parseSoundSummary(ebur, stats), { integrated: -14.3, range: 6.1, truePeak: -0.8, noiseFloor: -62.9 });
  assert.deepEqual(parseSoundSummary("", ""), { integrated: null, range: null, truePeak: null, noiseFloor: null });
});
