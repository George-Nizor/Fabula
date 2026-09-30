// The treatment: what the film is, written down before a scene is placed.
//
// A director writes one before drawing anything, and the films that come out
// of a treatment are better than the ones that come out of a scene list —
// the idea exists before the cards do, and every card can be asked what it
// is for. Here it is also how the person sees what the assistant intends
// while it works: the window shows the logline, the shape and the beats as
// they land.
//
//   logline    one sentence: what the film says
//   purpose    who it is for and what it should do for them
//   shapes     the structures considered (a journey, a before and after, a
//              countdown, a list that turns...) — the first idea for a film
//              is usually its cliché, so name two others and choose
//   shape      the one chosen, and why, in a line
//   signature  the moment only this film does — its biggest gesture, where
//              the turn lands — anchored to the words it sits on
//   beats      the film in order: what happens in the story, what the viewer
//              sees, and where the head is (on, corner, side, split, gone)
//   sound      the plan for the bed, the silences and the hits
//   look       the look and why it suits this film
//
// Fabula cannot reorder a word of the recording, so beats follow the words:
// the story is found in the order given, or built on top of it. No I/O.

export const HEAD_STATES = new Set(["on", "corner", "side", "split", "band", "gone"]);
export const TREATMENT_LIMITS = { logline: 200, purpose: 300, shape: 240, signature: 240, beat: 120, picture: 200, sound: 240, look: 240, beats: 40, shapes: 4 };

const text = (value, max, field, { required = false } = {}) => {
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`treatment needs a ${field}`);
    return undefined;
  }
  if (typeof value !== "string") throw new Error(`treatment ${field} must be text`);
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (required && !trimmed) throw new Error(`treatment needs a ${field}`);
  if (trimmed.length > max) throw new Error(`treatment ${field} is at most ${max} characters — say it shorter`);
  return trimmed || undefined;
};

// Word anchors, checked against the clean transcript when there is one.
function span(item, at, byId) {
  const from = item.fromWordId ?? item.from_word_id;
  const to = item.toWordId ?? item.to_word_id ?? from;
  if (!Number.isInteger(from) || !Number.isInteger(to)) throw new Error(`${at} needs fromWordId and toWordId`);
  if (to < from) throw new Error(`${at}: toWordId comes before fromWordId`);
  if (byId && (!byId.has(from) || !byId.has(to))) throw new Error(`${at}: word ids must be in the clean transcript (0–${byId.size - 1})`);
  return { fromWordId: from, toWordId: to };
}

export function validateTreatment(input, words = null) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("treatment must be an object");
  const byId = Array.isArray(words) && words.length ? new Map(words.map((word) => [word.id, word])) : null;
  const L = TREATMENT_LIMITS;
  const out = { logline: text(input.logline, L.logline, "logline", { required: true }) };
  const purpose = text(input.purpose, L.purpose, "purpose");
  if (purpose) out.purpose = purpose;
  if (input.shapes !== undefined) {
    if (!Array.isArray(input.shapes) || input.shapes.length > L.shapes) throw new Error(`treatment shapes is a list of up to ${L.shapes}`);
    out.shapes = input.shapes.map((shape, i) => {
      if (!shape || typeof shape !== "object") throw new Error(`treatment shapes[${i}] is { name, why }`);
      return { name: text(shape.name, 60, `shapes[${i}].name`, { required: true }), ...(shape.why ? { why: text(shape.why, 240, `shapes[${i}].why`) } : {}) };
    });
  }
  const shape = text(input.shape, L.shape, "shape");
  if (shape) out.shape = shape;
  if (input.signature !== undefined && input.signature !== null) {
    const sig = input.signature;
    if (typeof sig !== "object" || Array.isArray(sig)) throw new Error("treatment signature is { what, fromWordId, toWordId }");
    out.signature = { what: text(sig.what, L.signature, "signature.what", { required: true }), ...span(sig, "treatment signature", byId) };
  }
  if (!Array.isArray(input.beats) || input.beats.length === 0 || input.beats.length > L.beats) {
    throw new Error(`treatment beats is a list of 1–${L.beats}: the film in order, each anchored to its words`);
  }
  out.beats = input.beats.map((beat, i) => {
    const at = `treatment beats[${i}]`;
    if (!beat || typeof beat !== "object") throw new Error(`${at} is { fromWordId, toWordId, beat, picture, head }`);
    const head = beat.head ?? undefined;
    if (head !== undefined && !HEAD_STATES.has(head)) throw new Error(`${at}: head is one of ${[...HEAD_STATES].join(", ")}`);
    return {
      ...span(beat, at, byId),
      beat: text(beat.beat, L.beat, `beats[${i}].beat`, { required: true }),
      ...(beat.picture ? { picture: text(beat.picture, L.picture, `beats[${i}].picture`) } : {}),
      ...(head ? { head } : {}),
    };
  });
  for (let i = 1; i < out.beats.length; i += 1) {
    if (out.beats[i].fromWordId < out.beats[i - 1].fromWordId) throw new Error(`treatment beats[${i}] starts before beats[${i - 1}]: the recording cannot be reordered, so the beats run in its order`);
  }
  const sound = text(input.sound, L.sound, "sound");
  if (sound) out.sound = sound;
  const look = text(input.look, L.look, "look");
  if (look) out.look = look;
  return out;
}

// What status carries: enough to know a treatment exists and what it says.
export function describeTreatment(treatment) {
  if (!treatment?.logline) return null;
  return {
    logline: treatment.logline,
    shape: treatment.shape ?? null,
    signature: treatment.signature?.what ?? null,
    beats: treatment.beats?.length ?? 0,
    updatedAt: treatment.updatedAt ?? null,
  };
}
