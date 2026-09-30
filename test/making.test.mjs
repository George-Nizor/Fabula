import test from "node:test";
import assert from "node:assert/strict";
import { makingPhases, PHASES, TOOL_PHASE } from "../core/making.mjs";

const S = "2026-09-30T10:00:00.000Z";
const at = (sec) => new Date(Date.parse(S) + sec * 1000).toISOString();
const states = (run) => Object.fromEntries(run.phases.map((p) => [p.id, p.state]));
const reading = [{ at: at(5), tool: "get_direction", ok: true }, { at: at(6), tool: "read_story", ok: true }];

test("nothing to show without a start", () => {
  assert.equal(makingPhases({}), null);
  assert.deepEqual(PHASES.map((p) => p.id), ["clean", "read", "treatment", "look", "scenes", "motion", "sound", "review", "draft"]);
  for (const phase of Object.values(TOOL_PHASE)) assert.ok(PHASES.some((p) => p.id === phase), phase);
});

test("the clean cut rendering is the first thing the person sees move", () => {
  const run = makingPhases({ startedAt: S, job: { stage: "refresh_clean", label: "The clean cut", detail: "42%" }, clean: "stale", now: Date.parse(S) + 60000 });
  assert.equal(run.current, "clean");
  assert.match(run.phases[0].detail, /42%/);
  assert.ok(run.phases.slice(1).every((p) => p.state === "waiting"));
  assert.equal(run.elapsedSeconds, 60);
});

test("the phase the assistant touched last is where it is, and the ones before are done", () => {
  const log = [...reading, { at: at(60), tool: "set_treatment", ok: true, note: "Rockets go sideways" },
    { at: at(70), tool: "set_theme", ok: true }, { at: at(90), tool: "set_scenes", ok: true, note: "30 scenes" },
    { at: at(120), tool: "write_motion", ok: true, note: "motion/orbit.html" }, { at: at(150), tool: "update_scenes", ok: true }];
  const run = makingPhases({ startedAt: S, activity: log, clean: "current", treatmentAt: at(60) });
  assert.deepEqual(states(run), { clean: "done", read: "done", treatment: "done", look: "done", scenes: "active", motion: "done", sound: "waiting", review: "waiting", draft: "waiting" });
  assert.equal(run.phases.find((p) => p.id === "scenes").detail, "changing scenes");
  assert.equal(run.phases.find((p) => p.id === "motion").detail, "writing a motion scene: motion/orbit.html");
});

test("a phase passed over on the way is skipped, and the draft ends the run", () => {
  const log = [...reading, { at: at(70), tool: "set_theme", ok: true }, { at: at(90), tool: "set_scenes", ok: true },
    { at: at(200), tool: "critique_film", ok: true }, { at: at(230), tool: "render_final", ok: true, note: "draft" }];
  const rendering = makingPhases({ startedAt: S, activity: log, clean: "current", treatmentAt: at(60), job: { stage: "render_final", label: "Rendering a draft", detail: "chunk 1/2" } });
  assert.equal(rendering.current, "draft");
  assert.deepEqual([states(rendering).motion, states(rendering).sound, states(rendering).review], ["skipped", "skipped", "done"]);
  const done = makingPhases({ startedAt: S, activity: log, clean: "current", treatmentAt: at(60), draftAt: at(400) });
  assert.equal(done.done, true);
  assert.equal(done.current, null);
  assert.equal(done.elapsedSeconds, 400);
  assert.equal(states(done).draft, "done");
});

test("a refused write says why, where it happened", () => {
  const run = makingPhases({ startedAt: S, activity: [...reading, { at: at(70), tool: "set_scenes", ok: false, error: "scene 3: a motion scene, and the direction is By the book" }], clean: "current" });
  assert.equal(run.current, "scenes");
  assert.equal(run.failedIn, "scenes");
  assert.match(run.phases.find((p) => p.id === "scenes").detail, /By the book/);
});

test("an earlier run's lines are not this run's", () => {
  const old = [{ at: "2026-09-29T10:00:00.000Z", tool: "set_scenes", ok: true }];
  const run = makingPhases({ startedAt: S, activity: old, clean: "current" });
  assert.equal(states(run).scenes, "waiting");
});

test("looking at a phase does not finish it", () => {
  // The reviewer's run: reads that touch the look and the scenes, then the
  // story. Nothing was written, so nothing but reading is done or skipped.
  const log = [{ at: at(5), tool: "get_direction", ok: true }, { at: at(6), tool: "get_theme", ok: true },
    { at: at(7), tool: "list_assets", ok: true }, { at: at(8), tool: "read_story", ok: true }];
  const run = makingPhases({ startedAt: S, activity: log, clean: "current" });
  assert.deepEqual(states(run), { clean: "done", read: "active", treatment: "waiting", look: "waiting", scenes: "waiting", motion: "waiting", sound: "waiting", review: "waiting", draft: "waiting" });
  // Looking is still where the assistant is when it is the latest call.
  const glancing = makingPhases({ startedAt: S, activity: [...log, { at: at(9), tool: "describe_motion", ok: true }], clean: "current" });
  assert.equal(glancing.current, "motion");
  assert.equal(states(glancing).read, "done");
});

test("the run is read from the window's start mark, whatever the clocks say", () => {
  // WSL minutes behind the window: every call and file looks older than the
  // start. The mark says where the run begins and what was there before.
  const behind = (sec) => new Date(Date.parse(S) - 600_000 + sec * 1000).toISOString();
  const log = [
    { at: behind(-50), tool: "set_scenes", ok: true }, // the last run's
    { at: S, tool: "make_video", mark: "start", startedAt: S, treatmentBefore: behind(-40), draftBefore: behind(-30) },
    { at: behind(5), tool: "get_direction", ok: true }, { at: behind(60), tool: "set_treatment", ok: true },
    { at: behind(90), tool: "set_scenes", ok: true }, { at: behind(200), tool: "render_final", ok: true, note: "draft" },
  ];
  const run = makingPhases({ startedAt: S, activity: log, clean: "current", treatmentAt: behind(60), draftAt: behind(400) });
  assert.equal(run.done, true, "a draft that changed since the mark is this run's");
  assert.deepEqual([states(run).read, states(run).treatment, states(run).scenes], ["done", "done", "done"]);
  // The draft from before the mark is not this run's.
  const before = makingPhases({ startedAt: S, activity: log.slice(0, 3), clean: "current", treatmentAt: behind(-40), draftAt: behind(-30) });
  assert.equal(before.done, false);
  assert.equal(states(before).treatment, "waiting");
  assert.equal(states(before).scenes, "waiting", "the call before the mark belongs to the last run");
});
