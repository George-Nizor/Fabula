// What the window shows while the assistant makes a video: the run as nine
// phases, each waiting, active, done or skipped, with a line saying what is
// happening in it.
//
// Nothing reports a phase by hand. The MCP server appends one line per tool
// call to <project>/activity.jsonl (all but the polls: status,
// wait_for_input, list_projects), the jobs write progress.json, and the
// files say what exists; this reads all three back. So the panel is right
// for either assistant (Claude Code or Codex), whether or not it remembered
// to say what it was doing, and it cannot drift from what actually happened.
// No I/O: the window's main process gathers the inputs.

export const PHASES = [
  { id: "clean", label: "Clean cut" },
  { id: "read", label: "Reading the story" },
  { id: "treatment", label: "Treatment" },
  { id: "look", label: "Look" },
  { id: "scenes", label: "Scenes" },
  { id: "motion", label: "Motion graphics" },
  { id: "sound", label: "Sound" },
  { id: "review", label: "Review" },
  { id: "draft", label: "Draft" },
];

// Which phase a tool call belongs to. Tools not named here (status,
// get_scenes, list_cuts…) are reading the state, not doing a phase's work.
export const TOOL_PHASE = {
  render_clean: "clean", retranscribe_clean: "clean", reanchor_scenes: "clean", set_framing: "clean", detect_framing: "clean", get_framing: "clean",
  get_direction: "read", adopt_persona: "read", describe_kit: "read", read_story: "read", draft_scenes: "read", list_clean_words: "read", read_craft: "read", describe_templates: "read",
  set_treatment: "treatment", get_treatment: "treatment",
  set_theme: "look", list_themes: "look", get_theme: "look",
  set_scenes: "scenes", update_scenes: "scenes", add_scenes: "scenes", remove_scenes: "scenes", check_scenes: "scenes", plan_shots: "scenes",
  set_inserts: "scenes", apply_insert: "scenes", set_captions: "scenes", search_images: "scenes", fetch_image: "scenes", import_image: "scenes", import_clip: "scenes", list_assets: "scenes",
  describe_motion: "motion", write_motion: "motion", preview_motion: "motion", read_motion: "motion", list_motion: "motion",
  set_audio: "sound", search_audio: "sound", import_audio: "sound", list_music: "sound", set_music_root: "sound",
  review_film: "review", review_plan: "review", critique_film: "review", preview_frame: "review", preview_sheet: "review", film_sheet: "review",
  render_final: "draft",
};

// Tools that look without changing anything. They say where the assistant
// is — the active phase's line — but never finish a phase: reading the theme
// is not choosing the look, and listing the assets is not writing scenes.
// (Reading the story and reviewing the film are all looking; their tools are
// the work of those phases and are not here.)
export const GLANCES = new Set([
  "get_framing", "detect_framing", "get_treatment", "list_themes", "get_theme", "check_scenes", "search_images", "list_assets",
  "describe_motion", "read_motion", "list_motion", "search_audio", "list_music",
]);

// Tools that bring material in. They are work in their phase, but a picture
// fetched is not a scene written, and a track imported is not the sound set:
// an assistant gathers early, before it composes.
export const GATHERS = new Set(["fetch_image", "import_image", "import_clip", "import_audio"]);

// A tool call in words, for the line under an active phase.
const TOOL_WORDS = {
  render_clean: "rendering the clean cut", retranscribe_clean: "transcribing the clean cut", reanchor_scenes: "moving the scenes onto the new transcript", set_framing: "setting the framing", detect_framing: "scanning the framing",
  get_direction: "reading your brief", adopt_persona: "taking up the craft", describe_kit: "reading the kit", read_story: "reading the story", draft_scenes: "drafting a skeleton", list_clean_words: "reading the words", read_craft: "reading the craft", describe_templates: "choosing from the templates",
  set_treatment: "writing the treatment",
  set_theme: "setting the look", list_themes: "looking at your brands",
  set_scenes: "writing the scenes", update_scenes: "changing scenes", add_scenes: "adding scenes", remove_scenes: "removing scenes", check_scenes: "trying a plan", plan_shots: "planning the punch-ins",
  set_captions: "setting the captions", search_images: "looking for pictures", fetch_image: "bringing in a picture", import_image: "bringing in a picture", import_clip: "bringing in a clip",
  describe_motion: "reading the motion contract", write_motion: "writing a motion scene", preview_motion: "looking at a motion scene",
  set_audio: "setting the sound", search_audio: "looking for music", import_audio: "bringing in music",
  review_film: "looking at the whole film", review_plan: "reading the plan back", critique_film: "checking for faults", preview_frame: "looking at a frame", preview_sheet: "looking at the rhythm", film_sheet: "looking at the render",
  render_final: "rendering",
};

const CLEAN_JOBS = new Set(["refresh_clean", "render_clean", "retranscribe", "first_pass", "transcribe"]);

const time = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };

// inputs:
//   startedAt   ISO string: when the person pressed Make it into a video
//   activity    parsed lines of activity.jsonl ({ at, tool, ok, note, error })
//   job         the running job ({ stage, label, detail }) or null
//   clean       "none" | "stale" | "current"
//   treatmentAt ISO of the treatment's last write, or null
//   draftAt     ISO of out/draft.mp4's mtime, or null
//   now         ms since the epoch
export function makingPhases({ startedAt, activity = [], job = null, clean = "none", treatmentAt = null, draftAt = null, now = Date.now() } = {}) {
  const start = time(startedAt);
  if (start === null) return null;
  // The run is what comes after the window's start mark, and the treatment
  // and the draft count when they differ from what they were at the mark.
  // No clock is compared: on Windows the window's and WSL's disagree after a
  // sleep, and a lagging WSL made every call look older than the run. The
  // clock is only the fallback for a log from before the mark existed.
  const markAt = activity.findLastIndex((entry) => entry.mark === "start" && entry.startedAt === startedAt);
  const mark = markAt >= 0 ? activity[markAt] : null;
  const since = (mark ? activity.slice(markAt + 1) : activity.filter((entry) => (time(entry.at) ?? 0) >= start - 1000)).filter((entry) => !entry.mark);
  const treatmentNew = mark ? treatmentAt !== null && treatmentAt !== mark.treatmentBefore : time(treatmentAt) !== null && time(treatmentAt) >= start - 1000;
  const draftNew = mark ? draftAt !== null && draftAt !== mark.draftBefore : time(draftAt) !== null && time(draftAt) >= start;
  const phases = Object.fromEntries(PHASES.map(({ id, label }) => [id, { id, label, state: "waiting", detail: null, startedAt: null, endedAt: null }]));
  let latest = null;
  let lastRender = null;
  let failure = null;
  for (const entry of since) {
    let phase = TOOL_PHASE[entry.tool];
    if (entry.tool === "wait_render") phase = lastRender ?? (job && CLEAN_JOBS.has(job.stage) ? "clean" : null);
    if (entry.tool === "render_final" || entry.tool === "render_clean" || entry.tool === "retranscribe_clean") lastRender = phase;
    if (!phase) continue;
    const p = phases[phase];
    p.startedAt ??= entry.at;
    p.endedAt = entry.at;
    if (!GLANCES.has(entry.tool) && !GATHERS.has(entry.tool)) p.worked = true;
    p.detail = entry.ok === false
      ? `${TOOL_WORDS[entry.tool] ?? entry.tool} — it did not go through: ${entry.error ?? "an error"}`
      : `${TOOL_WORDS[entry.tool] ?? entry.tool.replace(/_/g, " ")}${entry.note ? `: ${entry.note}` : ""}`;
    failure = entry.ok === false ? p.id : null;
    latest = phase;
  }

  // The rules, in order:
  //   1. The clean cut and the draft are what the jobs and the files say.
  //   2. Every other phase the assistant has touched is done, except the one
  //      it touched last, which is where it is — unless the draft is
  //      rendering or done, when nothing before it is still going on.
  //   3. A phase nobody touched, before one somebody did, was not needed: a
  //      By the book film has no motion, a film without music may never
  //      touch the sound. That is said once the draft is rendering: until
  //      then the assistant works in its own order (music found before a
  //      scene is written, motion drawn after the sound), and a phase it has
  //      not reached is waiting, not skipped.
  //   4. The rest are waiting.
  const order = PHASES.map((p) => p.id);
  const touched = (id) => Boolean(phases[id].worked);
  const draftDone = draftNew && !(job && job.stage === "render_final");
  const drafting = Boolean(job && job.stage === "render_final");
  const cleaning = Boolean(job && CLEAN_JOBS.has(job.stage));

  if (cleaning) {
    phases.clean.state = "active";
    phases.clean.detail = [job.label, job.detail].filter(Boolean).join(" · ") || "rendering the clean cut";
    phases.clean.startedAt ??= startedAt;
  } else if (clean === "current" || touched("clean")) {
    phases.clean.state = "done";
  }
  if (drafting) {
    phases.draft.state = "active";
    phases.draft.detail = [job.label, job.detail].filter(Boolean).join(" · ") || "rendering";
    phases.draft.startedAt ??= new Date(now).toISOString();
  } else if (draftDone) {
    phases.draft.state = "done";
    phases.draft.endedAt = draftAt;
    phases.draft.detail = "ready to watch";
  }
  const middle = order.slice(1, -1);
  for (const id of middle) {
    // Where the assistant is now is active even when it is only looking;
    // anything else is done only once something was changed in it.
    if (id === latest && !drafting && !draftDone) phases[id].state = "active";
    else if (touched(id)) phases[id].state = "done";
  }
  if (treatmentNew && phases.treatment.state === "waiting") phases.treatment.state = "done";
  if (drafting || draftDone) {
    const reached = Math.max(-1, ...order.map((id, i) => (phases[id].state !== "waiting" ? i : -1)));
    for (const [i, id] of order.entries()) {
      if (phases[id].state === "waiting" && i < reached && id !== "clean") phases[id].state = "skipped";
    }
  }
  const list = order.map((id) => { const { worked, ...phase } = phases[id]; return phase; });
  const current = list.find((p) => p.state === "active")?.id ?? null;
  return {
    phases: list,
    current,
    done: draftDone,
    failedIn: failure,
    elapsedSeconds: Math.max(0, Math.round(((draftDone ? time(draftAt) : now) - start) / 1000)),
  };
}
