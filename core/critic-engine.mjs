// The critic: everything wrong with a film that can be found without taste.
//
// The editor personas make the film; this one tries to break it. The split is
// deliberate. An editor reading its own plan back sees what it meant; a reader
// that only measures sees what is there. Most of what goes wrong in a cut is
// measurable — a shot too short to read, a card under the dwell floor, a voice
// thirty decibels under what platforms play at, a film older than the plan it
// was made from — and none of it needs judgment, only someone to look.
//
// Pure: every input is passed in, nothing is read from disk and nothing is
// probed. The tool that calls this does the measuring (ffprobe, the asset
// sizes, the rendered loudness) so the rules stay testable on fixtures.
//
// What is NOT here is the half that needs eyes: whether the picture earns its
// place, whether the hook is a promise the film keeps, whether a card says
// what the moment needed. That is docs/craft/critic.md and a session looking
// at frames. A finding here is a fact; a note there is an opinion.

import { PUNCH_DWELL_SECONDS } from "./shot-engine.mjs";

// A shot shorter than this reads as a flinch rather than a cut.
export const SHOT_FLOOR_SECONDS = PUNCH_DWELL_SECONDS;
// A kept scrap of footage this short is a flash whatever framing it wears.
export const KEEP_FLOOR_SECONDS = 1.2;
// A cut that removes less than this removes nothing and leaves a hiccup.
export const POINTLESS_CUT_SECONDS = 0.12;
// Silence before the first word and after the last, past which it drags.
export const HEAD_AIR_SECONDS = 0.6;
export const TAIL_AIR_SECONDS = 1.8;
// A gap between words the cut left in, past which the film stalls.
export const LONG_PAUSE_SECONDS = 2.5;
// A picture filling less than this share of the space it was given is a
// stamp floating in an empty frame.
export const PICTURE_FILL = 0.5;
// What platforms play at, and how far off is worth saying.
export const LOUDNESS_TARGETS = { film: -16, short: -14 };
export const LOUDNESS_SLACK_LU = 1.5;
export const QUIET_VOICE_LUFS = -22;
export const TRUE_PEAK_CEILING = -1;

const round = (n, places = 2) => Number(n.toFixed(places));

// The runs of one framing across the film: consecutive punch spans sharing a
// scale are one shot, however many cuts they cross.
export function shotRuns(spans = []) {
  const runs = [];
  for (const span of spans) {
    const last = runs.at(-1);
    if (last && last.scale === span.scale) { last.end = span.end; continue; }
    runs.push({ start: span.start, end: span.end, scale: span.scale });
  }
  return runs.map((run) => ({ ...run, seconds: round(run.end - run.start) }));
}

// The fill of a picture in the box it was given, as a share of that box: 1 is
// edge to edge, 0.45 is a portrait photograph in a wide rectangle.
export function pictureFill(picture, box) {
  if (!picture?.width || !picture?.height || !box?.width || !box?.height) return null;
  const pictureAspect = picture.width / picture.height;
  const boxAspect = box.width / box.height;
  return round(Math.min(pictureAspect / boxAspect, boxAspect / pictureAspect));
}

const finding = (severity, kind, what, why, fix, extra = {}) =>
  ({ severity, kind, what, why, fix, ...extra });

// ---- The cut ----

function critiqueCut({ words = [], keeps = [], punchSpans = [], cuts = [], seconds = 0 }) {
  const out = [];

  for (const run of shotRuns(punchSpans)) {
    if (run.seconds >= SHOT_FLOOR_SECONDS) continue;
    out.push(finding("fault", "shot-sliver",
      `A ${run.seconds}s shot at ${round(run.start, 1)}s`,
      `Under the ${SHOT_FLOOR_SECONDS}s a shot needs to read, the framing pops out and back and looks like a fault rather than a cut.`,
      "Widen the keeps either side, or turn punch-ins off for this film (plan_shots).",
      { at: round(run.start, 2), seconds: run.seconds }));
  }

  keeps.forEach((keep, index) => {
    const length = round(keep.end - keep.start);
    if (length >= KEEP_FLOOR_SECONDS) return;
    out.push(finding("fault", "keep-sliver",
      `A ${length}s scrap of footage at ${round(keep.start, 1)}s`,
      "Two cuts landed almost on top of each other; what survives between them is a flash nobody can read.",
      "Keep one of the two cuts either side (set_cut_enabled), so the scrap joins its neighbour.",
      { at: round(keep.start, 2), seconds: length, keepIndex: index }));
  });

  for (const cut of cuts) {
    const length = round(cut.end - cut.start);
    if (length >= POINTLESS_CUT_SECONDS) continue;
    out.push(finding("risk", "pointless-cut",
      `A cut of ${length}s in the cut list, at ${round(cut.start, 1)}s of the raw recording`,
      "It removes nothing a listener would notice and still puts a join in the picture.",
      "Turn it off (set_cut_enabled) and keep the frame whole.",
      { at: round(cut.start, 2), seconds: length }));
  }

  const first = words[0];
  const last = words.at(-1);
  if (first && first.start > HEAD_AIR_SECONDS) {
    out.push(finding("risk", "head-air",
      `${round(first.start, 1)}s of silence before the first word`,
      "A film that opens on a held breath has lost people before it starts.",
      "Cut to the first word (add_cut over the silence).",
      { at: 0, seconds: round(first.start) }));
  }
  if (last && seconds - last.end > TAIL_AIR_SECONDS) {
    out.push(finding("note", "tail-air",
      `${round(seconds - last.end, 1)}s after the last word`,
      "Longer than a closing beat; the film has ended and is still running.",
      "Cut the tail back to about a second, unless a card is playing over it.",
      { at: round(last.end, 2), seconds: round(seconds - last.end) }));
  }

  for (let i = 1; i < words.length; i += 1) {
    const gap = words[i].start - words[i - 1].end;
    if (gap <= LONG_PAUSE_SECONDS) continue;
    out.push(finding("note", "long-pause",
      `A ${round(gap, 1)}s pause at ${round(words[i - 1].end, 1)}s`,
      "The cut left it in. That is a choice worth making on purpose, not by accident.",
      "Cut it (add_cut over the gap), or let a card play across it so the pause is doing something.",
      { at: round(words[i - 1].end, 2), seconds: round(gap) }));
  }

  return out;
}

// ---- The pictures ----

function critiquePictures({ scenes = [], assets = {}, stage = null }) {
  const out = [];
  if (!stage) return out;
  for (const scene of scenes) {
    const graphic = scene.graphic;
    if (!graphic || graphic.kind !== "image" || !graphic.src) continue;
    const picture = assets[graphic.src];
    const fill = pictureFill(picture, stage);
    if (fill === null || fill >= PICTURE_FILL) continue;
    const owns = scene.layout === "cutaway" || scene.layout === "full";
    out.push(finding(owns ? "risk" : "note", "picture-small",
      `${graphic.src} fills ${Math.round(fill * 100)}% of the frame it was given, at ${round(scene.start ?? 0, 1)}s`,
      owns
        ? "The picture owns the stage and most of the stage is empty around it, which reads as a slide rather than a shot."
        : "A portrait picture in a wide column leaves air above and below it.",
      "Use a cover graphic to take it edge to edge, or find a picture shaped like the frame.",
      { at: round(scene.start ?? 0, 2), src: graphic.src, fill }));
  }
  return out;
}

// ---- The sound ----

function critiqueSound({ audio = {}, shortForm = false }) {
  const out = [];
  const target = audio.target ?? null;
  const wanted = shortForm ? LOUDNESS_TARGETS.short : LOUDNESS_TARGETS.film;
  const measured = audio.measured ?? null;   // the clean cut, as recorded
  const rendered = audio.rendered ?? null;   // the film as written

  if (target === null && typeof measured === "number" && measured < QUIET_VOICE_LUFS) {
    out.push(finding("fault", "voice-not-levelled",
      `The voice measures ${measured} LUFS and nothing is levelling it`,
      `Platforms play at about ${wanted}; this film is roughly ${Math.round(wanted - measured)} dB too quiet to hear.`,
      `set_audio voice_loudness ${wanted}, then render again — the sound is only the stitch, so it takes seconds.`,
      { at: null }));
  }
  if (typeof rendered === "number" && target !== null && Math.abs(rendered - target) > LOUDNESS_SLACK_LU) {
    out.push(finding("fault", "voice-off-target",
      `The film came out at ${rendered} LUFS against a ${target} target`,
      "Further off than the levelling should leave it; something in the stitch is not doing what it was asked.",
      "Render again and read the log's loudness lines; if it repeats, the limiter is taking more than the gain puts back.",
      { at: null }));
  }
  if (typeof audio.truePeak === "number" && audio.truePeak > TRUE_PEAK_CEILING) {
    out.push(finding("risk", "peak-hot",
      `True peak ${audio.truePeak} dBFS`,
      "Above the ceiling platforms encode against; lossy encoding will clip it.",
      "Lower the loudness target a decibel, or let the limiter do more.",
      { at: null }));
  }
  return out;
}

// ---- The render ----

function critiqueRender({ output = null, stage = null, seconds = 0 }) {
  const out = [];
  if (!output?.exists) {
    out.push(finding("note", "not-rendered", "No film written yet", "Nothing to look at but the plan.", "render_final when the plan is right.", { at: null }));
    return out;
  }
  for (const stale of output.stale ?? []) {
    out.push(finding("fault", "stale",
      `${stale.artifact} is out of date`,
      stale.because ?? "It was written before the thing it is made from changed.",
      stale.next ?? "Render it again.",
      { at: null }));
  }
  if (stage && output.width && output.height && (output.width !== stage.width || output.height !== stage.height)) {
    out.push(finding("fault", "wrong-shape",
      `The film is ${output.width}×${output.height}, the format's stage is ${stage.width}×${stage.height}`,
      "It was rendered for a different shape, or at a draft scale.",
      "render_final without a draft scale.",
      { at: null }));
  }
  if (output.seconds && seconds && Math.abs(output.seconds - seconds) > 0.5) {
    out.push(finding("risk", "wrong-length",
      `The film runs ${round(output.seconds, 1)}s, the cut is ${round(seconds, 1)}s`,
      "The render does not cover the film; it may be a preview span left where the film goes.",
      "render_final over the whole film.",
      { at: null }));
  }
  return out;
}

// ---- The plan's own reads, folded in ----

function critiquePlan({ plan = {} }) {
  const out = [];
  for (const warning of plan.warnings ?? []) {
    out.push(finding("fault", "plan-warning", warning,
      "The plan engine refuses to promise this renders as written.",
      "Fix what it names with update_scenes.", { at: null }));
  }
  for (const note of plan.variety ?? []) {
    out.push(finding("risk", "variety", note,
      "The picture is repeating itself; the eye stops reading a film that does.",
      "Move between the head alone, a side card, a cutaway and the full stage.", { at: null }));
  }
  for (const note of plan.pacing ?? []) {
    out.push(finding("risk", "pacing", note,
      "The rhythm is off for the shape this film is in.",
      "Change something where the note says nothing changes.", { at: null }));
  }
  return out;
}

const ORDER = { fault: 0, risk: 1, note: 2 };

export function critiqueFilm(film = {}) {
  const stage = film.format?.stage ?? null;
  const shortForm = Boolean(film.format?.shortForm);
  const findings = [
    ...critiqueCut(film),
    ...critiquePlan(film),
    ...critiquePictures({ scenes: film.scenes, assets: film.assets, stage }),
    ...critiqueSound({ audio: film.audio, shortForm }),
    ...critiqueRender({ output: film.output, stage, seconds: film.seconds }),
  ].sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || (a.at ?? -1) - (b.at ?? -1));

  const counts = { fault: 0, risk: 0, note: 0 };
  for (const f of findings) counts[f.severity] += 1;
  // No score out of a hundred: there is no honest way to weigh a hot peak
  // against a repeated layout, and a number invites chasing the number. What
  // a reader needs is whether anything is actually broken.
  const verdict = counts.fault > 0
    ? `${counts.fault} fault${counts.fault === 1 ? "" : "s"} to fix before this renders as a finished film`
    : counts.risk > 0
      ? `nothing broken; ${counts.risk} thing${counts.risk === 1 ? "" : "s"} worth arguing about`
      : counts.note > 0
        ? "nothing broken and nothing to argue about; the notes are taste"
        : "nothing found that can be measured — the rest needs eyes";
  return { verdict, counts, findings };
}
