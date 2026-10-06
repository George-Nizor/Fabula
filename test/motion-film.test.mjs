import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { validateScenes, resolveScenes, filmStage, anchoredInSeconds } from "../core/compose-engine.mjs";
import { resolveLayoutTimeline } from "../core/stage-engine.mjs";
import { reanchorScenes } from "../core/reanchor.mjs";
import { motionLibsOf } from "../core/motion.mjs";
import { motionStamp, isMotionFilm, writeProjectKind } from "../scripts/project-state.mjs";

const require = createRequire(import.meta.url);
const { resolveMotionRequest } = require("../electron/motion-protocol.cjs");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

const words = [
  { id: 0, text: "an", start: 1, end: 1.2 },
  { id: 1, text: "orbit", start: 1.3, end: 1.8 },
];
const reel = (extra = {}) => ({ type: "graphic", fromSeconds: 0, toSeconds: 12, graphic: { kind: "motion", src: "motion/orbit.html", fade: false }, ...extra });

test("a motion film's scenes sit on its clock in seconds, and a recorded film's stay on its words", () => {
  validateScenes([reel()], []);
  const [resolved] = resolveScenes([reel()], [], { durationSeconds: 10 });
  assert.equal(resolved.start, 0);
  assert.equal(resolved.end, 10, "clamped to the film");
  assert.ok(anchoredInSeconds(reel()));
  assert.throws(() => validateScenes([reel({ toSeconds: 0 })], []), /must come after/);
  assert.throws(() => validateScenes([reel({ fromWordId: 0 })], words), /not both/);
  assert.throws(() => validateScenes([reel()], words, { secondsAnchors: false }), /anchor to its words/);
  // Words still work in a motion film with a narration.
  validateScenes([{ type: "title", text: "Orbit", fromWordId: 1, toWordId: 1 }, reel()], words, { secondsAnchors: true });
});

test("a motion film's stage is one cutaway from the first frame to the last, whatever the plan says", () => {
  const plan = filmStage([{ type: "stage", layout: "side", fromWordId: 0, toWordId: 1 }, reel()], 12);
  assert.equal(plan.filter((scene) => scene.type === "stage").length, 1);
  assert.deepEqual(plan[0], { type: "stage", layout: "cutaway", fromSeconds: 0, toSeconds: 12, transition: "cut" });
  const timeline = resolveLayoutTimeline(resolveScenes(plan, words, { durationSeconds: 12 }), 12);
  assert.deepEqual(timeline.map((segment) => segment.layout), ["cutaway"]);
});

test("re-anchoring leaves scenes in seconds where they are", () => {
  const report = reanchorScenes([reel(), { type: "title", text: "x", fromWordId: 1, toWordId: 1 }], words, words);
  assert.deepEqual(report.map((entry) => entry.index), [1]);
});

test("a motion document says which libraries it needs", () => {
  assert.deepEqual(motionLibsOf("<div>THREE. is text</div><script>const r = new THREE.WebGLRenderer();</script>"), ["three"]);
  assert.deepEqual(motionLibsOf("<script>// fabula-libs: project:shapes, gsap\ngsap.to(x, {})</script>").sort(), ["gsap", "project:shapes"]);
  assert.deepEqual(motionLibsOf("<p>gsap.to and THREE.Mesh in prose</p>"), []);
});

test("three ships, and a project's own motion/lib/ is served to the frame and nothing beside it", () => {
  const projectDir = "/projects/film";
  assert.equal(resolveMotionRequest("fabula-motion://lib/three.js", { repoRoot: ROOT }), path.join(ROOT, "renderer/motion/vendor/three.min.js"));
  assert.ok(fs.existsSync(path.join(ROOT, "renderer/motion/vendor/three.min.js")));
  assert.equal(resolveMotionRequest("fabula-motion://project/motion/lib/shapes.js", { repoRoot: ROOT, projectDir }), path.join(projectDir, "motion/lib/shapes.js"));
  assert.equal(resolveMotionRequest("fabula-motion://project/motion/lib/shapes.css", { repoRoot: ROOT, projectDir }), path.join(projectDir, "motion/lib/shapes.css"));
  assert.equal(resolveMotionRequest("fabula-motion://project/motion/lib/deep/x.js", { repoRoot: ROOT, projectDir }), null);
  assert.equal(resolveMotionRequest("fabula-motion://project/motion/lib/../../x.js", { repoRoot: ROOT, projectDir }), null);
});

test("a scene's identity changes with the project library it loads", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabula-motion-film-"));
  try {
    fs.mkdirSync(path.join(dir, "motion", "lib"), { recursive: true });
    fs.writeFileSync(path.join(dir, "motion", "a.html"), "<script>// fabula-libs: project:shapes\nfabula.scene({})</script>");
    fs.writeFileSync(path.join(dir, "motion", "lib", "shapes.js"), "window.shapes = 1;");
    const before = motionStamp(dir, "motion/a.html");
    fs.writeFileSync(path.join(dir, "motion", "lib", "shapes.js"), "window.shapes = 22;");
    assert.notEqual(motionStamp(dir, "motion/a.html"), before);
    assert.equal(isMotionFilm(dir), false);
    writeProjectKind(dir, "motion", { motion: { seconds: 12 } });
    assert.equal(isMotionFilm(dir), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
