// What the person asked for when they pressed Make it into a video.
//
// The composition is the assistant's; the direction is the person's. It says
// what the film is for, how closely to hold to the house style, which look to
// wear, what the assistant may bring in from outside, and anything else they
// want said. It lives in <project>/direction.json, written by the window's
// Make it into a video sheet (or by set_direction), and every tool that could
// break it reads it: get_direction hands it over whole, status summarises it,
// and the plan writes refuse what a strict direction rules out.
//
// Latitude is the one real dial. The kit — layouts, cards, templates, looks —
// is what Fabula knows about talking-head films, and following it is how a
// film comes out solid. It is also a ceiling: a film built only from named
// templates looks like every other film built from them. So the person
// chooses:
//
//   free     Free hand. The kit is a vocabulary, not a boundary. The
//            assistant designs the film: its own motion scenes written as
//            code, the layouts the story wants, a look it sets rather than
//            picks. The reads (variety, pacing, the critic) are advice.
//   guided   The default. Templates and the chosen look first, the
//            assistant's own motion where no template carries the idea; the
//            reads are prompts for judgment.
//   strict   By the book. Only the kit, the named templates and the look the
//            person chose; nothing hand-written; every warning and every
//            fault the critic finds is dealt with before a render.
//
// No I/O here: the server and the window read and write the file.

export const LATITUDES = {
  free: {
    id: "free",
    label: "Free hand",
    summary: "The assistant designs the film: its own motion graphics, the layouts the story wants, a look it sets rather than picks. The kit is a starting point.",
    motion: "encouraged",
    handCustom: true,
    reads: "advice",
    brief: `Free hand. The kit is a vocabulary, not a boundary: design this film. Write your own motion scenes (describe_motion, write_motion) wherever a moment deserves more than a card — the signature moment at the least, and more where the story is visual. Move the head the way the story moves: focus when the speaker is the point, a corner card or a split when something must be seen beside them, gone entirely (cutaway) when the picture carries the narration, and let a motion scene frame or point at the head (ctx.head) when that says it better. Set the look rather than pick it: a preset is a starting point, and palette, type and grade are yours to tune. Where the film is serious — a documentary, an argument, an explanation — give the moment its turn depends on a whole motion SEQUENCE over the film's own sound: the speaker gone, the stage yours for as long as the idea needs, one reel with its storyboard in the treatment first. The craft guides, the variety, pacing and critic reads, and the "earn your motion" restraint are advice, not rules — break any of them on purpose when the film is better for it, and say which and why. Two things are never advice: the check pass write_motion runs (text off the frame, overlapping, unreadable is a fault, not a style), and the invariants: read before you write, never discard the person's edits, and compose for the shape the film is in.`,
  },
  guided: {
    id: "guided",
    label: "Guided",
    summary: "Templates and the chosen look first; the assistant's own motion graphics where no template carries the idea. The reads are prompts for judgment.",
    motion: "allowed",
    handCustom: true,
    reads: "prompts",
    brief: `Guided. Reach for the kit first — the layouts, the graphic kinds, the named templates (describe_templates) and the look the person chose or you picked from the presets and saved brands. Where no template carries an idea, write your own: a custom card, or a motion scene (describe_motion) for a moment that has to move to make sense — one or two in a film, spent on the moments that earn them. A serious film may earn one motion sequence (a reel over its own sound, the speaker gone); write its storyboard into the treatment first, so the person sees it before the reel is made. Move the head through the layouts as the workflow describes: focus, a corner card, the side column, the full stage, a cutaway. Treat the variety, pacing and critic reads as prompts for judgment: act on what you agree with and say what you changed.`,
  },
  strict: {
    id: "strict",
    label: "By the book",
    summary: "Only the kit, the named templates and your chosen look. Every warning and every fault the critic finds is dealt with before a render.",
    motion: "refused",
    handCustom: false,
    reads: "requirements",
    brief: `By the book. Compose only from the kit: the layouts, the graphic kinds and the named templates (describe_templates), in the look the person chose — or, if they left it to you, one preset or saved brand used as it is. No hand-written custom graphics and no motion scenes: the plan writes refuse them. Follow the craft guides as rules, not suggestions. Every warning a plan write returns and every note in its variety and pacing reads is a requirement: resolve it, or say plainly why it cannot be resolved. Run critique_film before any render and fix every fault it reports; render_final refuses the real render while faults remain.`,
  },
};

export const LATITUDE_IDS = Object.keys(LATITUDES);
export const DEFAULT_LATITUDE = "guided";

// What the assistant may do with the look.
//   auto          choose it: a preset or one of the saved brands, said why
//   keep          keep whatever the project's look already is
//   brand:<id>    wear that saved brand
//   preset:<id>   wear that preset
const LOOK_RE = /^(auto|keep|brand:[a-z0-9][a-z0-9-]{0,63}|preset:[a-z0-9][a-z0-9-]{0,31})$/;

export const DIRECTION_LIMITS = { purpose: 300, notes: 2000 };

const text = (value, max, field) => {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error(`direction ${field} must be text`);
  const trimmed = value.replace(/\s+/g, (space) => (space.includes("\n") ? "\n" : " ")).trim();
  if (trimmed.length > max) throw new Error(`direction ${field} is at most ${max} characters`);
  return trimmed;
};

const flag = (value, fallback, field) => {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`direction ${field} must be true or false`);
  return value;
};

// A direction as written by the window or the belt, checked and filled in.
export function validateDirection(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("direction must be an object");
  const latitude = input.latitude ?? DEFAULT_LATITUDE;
  if (!Object.hasOwn(LATITUDES, latitude)) throw new Error(`direction latitude must be one of ${LATITUDE_IDS.join(", ")}`);
  const look = input.look ?? "auto";
  if (typeof look !== "string" || !LOOK_RE.test(look)) throw new Error("direction look is auto, keep, brand:<id> or preset:<id>");
  const persona = input.persona ?? null;
  if (persona !== null && (typeof persona !== "string" || !/^[a-z]+$/.test(persona))) throw new Error("direction persona must be a persona id");
  const render = input.render ?? "draft";
  if (!["draft", "none"].includes(render)) throw new Error("direction render is draft or none");
  return {
    latitude,
    purpose: text(input.purpose, DIRECTION_LIMITS.purpose, "purpose"),
    look,
    persona,
    music: flag(input.music, false, "music"),
    effects: flag(input.effects, false, "effects"),
    web: flag(input.web, true, "web"),
    notes: text(input.notes, DIRECTION_LIMITS.notes, "notes"),
    render,
    ...(typeof input.startedAt === "string" ? { startedAt: input.startedAt } : {}),
  };
}

export const latitudeOf = (direction) => (direction && Object.hasOwn(LATITUDES, direction.latitude) ? direction.latitude : DEFAULT_LATITUDE);
export const rulesFor = (direction) => LATITUDES[latitudeOf(direction)];

function lookLine(look) {
  if (look === "keep") return "Keep the look the project already wears (get_theme); do not change the preset or brand.";
  if (look.startsWith("brand:")) return `Wear the person's saved brand "${look.slice(6)}" — set_theme with use: "${look.slice(6)}" before any scene.`;
  if (look.startsWith("preset:")) return `Wear the preset "${look.slice(7)}" — set_theme with preset "${look.slice(7)}" before any scene.`;
  return "The look is yours to choose. Read list_themes (the person's saved brands come first when they fit) and the presets, choose, and say why in a line. Do not stop to ask.";
}

// The direction as the assistant reads it: every line an instruction.
export function directionBrief(direction) {
  const d = validateDirection(direction ?? {});
  const rules = LATITUDES[d.latitude];
  const lines = [
    `The person pressed Make it into a video. This is their brief; it replaces asking them.`,
    `- What the film is for: ${d.purpose || "not said — infer it from read_story and say what you inferred in one line."}`,
    `- Direction: ${rules.brief}`,
    `- Look: ${lookLine(d.look)}`,
    `- Music: ${d.music ? "yes — find a bed with search_audio (CC0/CC-BY only) or list_music, fit to the film's tone, set_audio it under the voice." : "no music unless the person asks later."}`,
    `- Sound effects: ${d.effects ? "yes, sparingly — two or three in a two-minute film, landed in the gaps between sentences." : "none."}`,
    `- Material from the web: ${d.web ? "allowed — pictures (search_images, fetch_image) and sounds, credited, where a real thing explains better than a drawing." : "not allowed; use what is in the project and what you can draw."}`,
    d.notes ? `- Their notes, in their words: "${d.notes}"` : "- Their notes: none.",
    d.render === "draft"
      ? "- Rendering: when the plan has been reviewed, render the whole film as a draft (render_final draft: true) without asking — that is what they pressed the button for. The real render (render_final without draft) still waits for them."
      : "- Rendering: do not render; stop when the plan is reviewed and say it is ready to look at.",
  ];
  return lines.join("\n");
}

// The fields a status read carries: enough to know which rules apply.
export function describeDirection(direction) {
  if (!direction) return null;
  const d = validateDirection(direction);
  const rules = LATITUDES[d.latitude];
  return {
    latitude: d.latitude,
    label: rules.label,
    summary: rules.summary,
    motion: rules.motion,
    handWrittenGraphics: rules.handCustom ? "allowed" : "refused",
    reads: rules.reads,
    look: d.look,
    purpose: d.purpose || null,
    music: d.music,
    effects: d.effects,
    web: d.web,
    render: d.render,
    notes: d.notes || null,
    startedAt: d.startedAt ?? null,
    // The file on disk did not validate: what is wrong, and that only its
    // latitude is still being read (the server's readDirection).
    ...(typeof direction.problem === "string" ? { problem: direction.problem } : {}),
  };
}

// A graphic as a refusal sees it: the same motion document with the same
// params, or the same hand-written card, is the same graphic wherever it is
// placed and however its span moved.
const graphicKey = (graphic) => JSON.stringify(graphic.kind === "motion"
  ? ["motion", graphic.src ?? "", graphic.params ?? null]
  : [graphic.kind, graphic.html ?? "", graphic.css ?? ""]);

// What a plan may not carry under this direction, as the refusal a write
// returns. Null when the plan is fine. Scenes are the plan as it will be
// written: templates already expanded (a template card keeps its `template`).
//
// `existing` is the plan on disk. What it already holds is carried through:
// the person put it there, or it was there before the direction was set. A
// strict direction stops the assistant adding more; it does not make every
// unrelated edit fail on a scene nobody touched. The real render's gate
// passes no `existing`, so there the whole plan answers to the direction.
export function directionRefusal(scenes, direction, { existing = [] } = {}) {
  const rules = rulesFor(direction);
  const kept = new Set((existing ?? []).filter((scene) => scene?.graphic).map((scene) => graphicKey(scene.graphic)));
  for (const [index, scene] of (scenes ?? []).entries()) {
    const graphic = scene?.graphic;
    if (!graphic || kept.has(graphicKey(graphic))) continue;
    if (graphic.kind === "motion" && rules.motion === "refused") {
      return `scene ${index}: a motion scene, and the person's direction is ${rules.label} — only the kit and the named templates. Use a template (describe_templates) or a graphic kind; nothing was written.`;
    }
    if (graphic.kind === "custom" && !graphic.template && !rules.handCustom) {
      return `scene ${index}: a hand-written custom graphic, and the person's direction is ${rules.label} — only the named templates. Use one (describe_templates); nothing was written.`;
    }
  }
  return null;
}
