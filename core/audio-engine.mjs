// The sound under the voice.
//
// A talking-head film has one audio track that matters, the voice, and one
// that helps, a bed of music that fills the room without competing. What an
// editor does with the bed is simple to say and tedious to do by hand: keep
// it low while the person speaks, let it come up in the pauses and at the
// ends, and fade it in and out. Every other editor guesses at "while the
// person speaks" with a sidechain compressor listening to the voice. Fabula
// does not have to guess: the clean transcript says, to the word, when
// somebody is talking. The duck is written as a function of time from the
// words, the same way the head's rectangle is, and ffmpeg's volume filter
// evaluates it frame by frame. Pure functions; the stitch applies them.

export const AUDIO_EXTENSIONS = /\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i;

// The music at `level` dB while nobody speaks, `duck` dB lower while they
// do, ramping over `ramp` seconds either side of a pause; faded in and out
// over `fade` seconds; looped to the film's length when the file is short.
export const MUSIC_DEFAULTS = { level: -18, duck: -12, ramp: 0.5, fade: 2, loop: true };

// What still counts as a pause the music may fill. Shorter gaps are breath.
export const SWELL_MIN_GAP = 1.2;
export const SWELL_PAD = 0.3;

const between = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

export function assetAudioPath(src) {
  return typeof src === "string" && AUDIO_EXTENSIONS.test(src) && src.startsWith("assets/") && !src.includes("..") && !src.includes("\\");
}

// The audio block as written in compose.json: { music?: {...}, voice?: {...} }.
export function validateAudio(audio) {
  if (audio === undefined || audio === null) return;
  if (typeof audio !== "object") throw new Error("audio must be an object");
  const { music, voice } = audio;
  if (music !== undefined && music !== null) {
    if (typeof music !== "object") throw new Error("audio.music must be an object");
    if (!assetAudioPath(music.src)) throw new Error("audio.music.src must be a project-relative audio file under assets/, e.g. assets/bed.mp3 (import_audio puts one there)");
    if (music.level !== undefined && !between(music.level, -40, 0)) throw new Error("audio.music.level is dB from -40 to 0");
    if (music.duck !== undefined && !between(music.duck, -40, 0)) throw new Error("audio.music.duck is dB from -40 (silent under speech) to 0 (no duck)");
    if (music.ramp !== undefined && !between(music.ramp, 0.1, 3)) throw new Error("audio.music.ramp is seconds from 0.1 to 3");
    if (music.fade !== undefined && !between(music.fade, 0, 10)) throw new Error("audio.music.fade is seconds from 0 to 10");
    if (music.loop !== undefined && typeof music.loop !== "boolean") throw new Error("audio.music.loop is true or false");
  }
  if (voice !== undefined && voice !== null) {
    if (typeof voice !== "object") throw new Error("audio.voice must be an object");
    if (voice.loudness !== undefined && voice.loudness !== null && !between(voice.loudness, -30, -8)) throw new Error("audio.voice.loudness is integrated LUFS from -30 to -8 (-16 for a film, -14 for a short)");
  }
}

export function resolveAudio(audio) {
  validateAudio(audio);
  const music = audio?.music ? { ...MUSIC_DEFAULTS, ...audio.music } : null;
  const voice = { loudness: audio?.voice?.loudness ?? null };
  return { music, voice };
}

// ---- Where the music may come up ----
//
// The pauses nobody is speaking through, on the clean timeline: the gaps
// between words at least `minGap` long, the run-in before the first word and
// the tail after the last. Padded inward so the swell never touches a word.
export function swellWindows(words, duration, { minGap = SWELL_MIN_GAP, pad = SWELL_PAD } = {}) {
  const out = [];
  const push = (a, b) => { if (b - a >= 0.25) out.push({ start: Number(a.toFixed(3)), end: Number(b.toFixed(3)) }); };
  if (!words?.length) { if (duration > 0) push(0, duration); return out; }
  if (words[0].start - pad > 0) push(0, words[0].start - pad);
  for (let i = 1; i < words.length; i += 1) {
    const gap = words[i].start - words[i - 1].end;
    if (gap >= minGap) push(words[i - 1].end + pad, words[i].start - pad);
  }
  if (duration - (words.at(-1).end + pad) > 0) push(words.at(-1).end + pad, duration);
  return out;
}

const num = (v) => Number(v.toFixed(4)).toString();
const dbToLinear = (db) => Math.pow(10, db / 20);

// The bed's gain at t as an ffmpeg expression: `duck` (linear) while someone
// speaks, 1 across each swell window, ramping up over `ramp` seconds before
// the window and down over `ramp` after it — so the swell leads the pause
// slightly, the way a mixer's hand does. Sum of the windows' tents, clipped
// to one; windows never overlap, so the clip only matters where two ramps
// meet across a short word.
export function bedGainExpression(windows, { duck = MUSIC_DEFAULTS.duck, ramp = MUSIC_DEFAULTS.ramp } = {}, { offset = 0 } = {}) {
  const low = dbToLinear(duck);
  if (!windows.length) return num(low);
  const T = offset ? `(t+${num(offset)})` : "t";
  const r = Math.max(ramp, 0.05);
  const tents = windows.map(({ start, end }) =>
    `clip((${T}-${num(start - r)})/${num(r)},0,1)*clip((${num(end + r)}-${T})/${num(r)},0,1)`);
  return `${num(low)}+${num(1 - low)}*min(1,${tents.join("+")})`;
}

// ---- The stitch's audio ----
//
// Inputs are numbered as the stitch numbers them: 0 the video chunks, 1 the
// clean cut (its audio is the voice), 2 the music when there is one. What
// comes back is the extra input arguments, the filter graph and the label to
// map — or nothing, when the voice is used as it is.
export function audioGraph({ audio, words, from = 0, span, musicPath }) {
  const { music, voice } = resolveAudio(audio);
  if (!music && voice.loudness === null) return null;
  const lines = [];
  lines.push("[1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[v0]");
  let voiceLabel = "v0";
  if (voice.loudness !== null) {
    lines.push(`[v0]loudnorm=I=${num(voice.loudness)}:TP=-1.5:LRA=11[v1]`);
    voiceLabel = "v1";
  }
  if (!music) {
    return { inputs: [], filter: lines.join(";\n") + "\n", map: `[${voiceLabel}]` };
  }
  // The film's swell windows, shifted to the span's own clock.
  const windows = swellWindows(words, from + span)
    .map((w) => ({ start: w.start - from, end: w.end - from }))
    .filter((w) => w.end > 0 && w.start < span)
    .map((w) => ({ start: Number(Math.max(w.start, 0).toFixed(3)), end: Number(Math.min(w.end, span).toFixed(3)) }));
  const gain = bedGainExpression(windows, music);
  const fade = Math.min(music.fade, span / 2);
  const bed = [
    "[2:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo",
    `atrim=duration=${num(span)}`,
    "asetpts=PTS-STARTPTS",
    `volume=${num(dbToLinear(music.level))}`,
    `volume=volume='${gain}':eval=frame`,
    ...(fade > 0 ? [`afade=t=in:st=0:d=${num(fade)}`, `afade=t=out:st=${num(Math.max(span - fade, 0))}:d=${num(fade)}`] : []),
  ];
  lines.push(`${bed.join(",")}[bed]`);
  lines.push(`[${voiceLabel}][bed]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mix]`);
  const inputs = [...(music.loop ? ["-stream_loop", "-1"] : []), ...(from > 0 ? ["-ss", num(from)] : []), "-i", musicPath];
  return { inputs, filter: lines.join(";\n") + "\n", map: "[mix]", windows, gain };
}

// A one-line account of the bed, for the tool that sets it and for status.
export function describeAudio(audio, words, duration) {
  const { music, voice } = resolveAudio(audio);
  const out = { music: null, voice };
  if (music) {
    const windows = swellWindows(words ?? [], duration ?? 0);
    out.music = {
      ...music,
      swells: windows.length,
      swellSeconds: Number(windows.reduce((sum, w) => sum + w.end - w.start, 0).toFixed(1)),
      about: `${music.level} dB in the pauses, ${music.level + music.duck} dB under the voice, ${music.ramp}s ramps, ${music.fade}s fades${music.loop ? ", looped" : ""}; ${windows.length} pause(s) the bed comes up in`,
    };
  }
  return out;
}
