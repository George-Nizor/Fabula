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
// For motion — a motion film, or a sequence inside a recorded one — the
// treatment is also the storyboard, written before a line of the reel:
//
//   spine      the one continuity device the motion keeps (a shape that
//              becomes each idea, a camera that never cuts, a line that
//              draws the whole film)
//   hold       the one frame held still on purpose, and where
//   bans       what this film will not do ("no particles", "no 3D flips")
//   and on each beat: onScreen, the words on screen verbatim, and motion,
//   how it moves and how it hands over to the next beat.
//
// A motion film has no words to anchor to unless it has a narration: its
// beats may anchor in seconds (fromSeconds/toSeconds) instead.
//
// Fabula cannot reorder a word of the recording, so beats follow the words:
// the story is found in the order given, or built on top of it. No I/O.

export const HEAD_STATES = new Set(["on", "corner", "side", "split", "band", "gone"]);
export const TREATMENT_LIMITS = { logline: 200, purpose: 300, shape: 240, signature: 240, beat: 120, picture: 200, sound: 240, look: 240, beats: 40, shapes: 4, spine: 240, hold: 200, ban: 80, bans: 8, onScreen: 120, motion: 200 };

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

// Word anchors, checked against the clean transcript when there is one —
// or, for motion, seconds on the film's clock.
function span(item, at, byId) {
  const fromSeconds = item.fromSeconds ?? item.from_seconds;
  const toSeconds = item.toSeconds ?? item.to_seconds;
  if (fromSeconds !== undefined || toSeconds !== undefined) {
    if (!Number.isFinite(fromSeconds) || !Number.isFinite(toSeconds) || fromSeconds < 0 || toSeconds <= fromSeconds) throw new Error(`${at}: fromSeconds and toSeconds are seconds on the film's clock, the second after the first`);
    return { fromSeconds, toSeconds };
  }
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
      ...(beat.onScreen ?? beat.on_screen ? { onScreen: text(beat.onScreen ?? beat.on_screen, L.onScreen, `beats[${i}].onScreen`) } : {}),
      ...(beat.motion ? { motion: text(beat.motion, L.motion, `beats[${i}].motion`) } : {}),
      ...(head ? { head } : {}),
    };
  });
  // In order: by word where both beats are on words, by second where both
  // are in seconds. (A motion film may mix them: seconds before the
  // narration starts, words while it speaks.)
  const startOf = (beat) => (beat.fromSeconds !== undefined ? { s: beat.fromSeconds } : { w: beat.fromWordId, s: byId?.get(beat.fromWordId)?.start });
  for (let i = 1; i < out.beats.length; i += 1) {
    const [a, b] = [startOf(out.beats[i - 1]), startOf(out.beats[i])];
    const before = a.w !== undefined && b.w !== undefined ? b.w < a.w : (a.s !== undefined && b.s !== undefined && b.s < a.s - 0.001);
    if (before) throw new Error(a.w !== undefined && b.w !== undefined
      ? `treatment beats[${i}] starts before beats[${i - 1}]: the recording cannot be reordered, so the beats run in its order`
      : `treatment beats[${i}] starts before beats[${i - 1}]: the beats run in the film's order`);
  }
  const spine = text(input.spine, L.spine, "spine");
  if (spine) out.spine = spine;
  const hold = text(input.hold, L.hold, "hold");
  if (hold) out.hold = hold;
  if (input.bans !== undefined) {
    if (!Array.isArray(input.bans) || input.bans.length > L.bans) throw new Error(`treatment bans is a list of up to ${L.bans}`);
    out.bans = input.bans.map((ban, i) => text(ban, L.ban, `bans[${i}]`, { required: true }));
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
    ...(treatment.spine ? { spine: treatment.spine } : {}),
    updatedAt: treatment.updatedAt ?? null,
  };
}
