import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listProjects, describeProject, PROJECT_NAME_RE, writeProjectTitle, slugify, cleanTitle } from "../scripts/project-state.mjs";

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

test("project names are leaf folder names, never paths", () => {
  for (const bad of ["../etc", "a/b", ".hidden", "", "with space"]) assert.ok(!PROJECT_NAME_RE.test(bad), bad);
  for (const good of ["applemansam-demo", "obs-2026-04-26", "Talk_2"]) assert.ok(PROJECT_NAME_RE.test(good), good);
});
