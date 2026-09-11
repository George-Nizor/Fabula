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
    if (music.loudness !== undefined && music.loudness !== null && !between(music.loudness, -70, 0)) throw new Error("audio.music.loudness is the file's integrated LUFS");
    if (music.spans !== undefined) {
      if (!Array.isArray(music.spans) || music.spans.length > 40) throw new Error("audio.music.spans is a list of up to 40 { fromWordId, toWordId }");
      for (const span of music.spans) {
        if (!span || !Number.isInteger(span.fromWordId) || !Number.isInteger(span.toWordId) || span.toWordId < span.fromWordId) throw new Error("each audio.music.span needs fromWordId <= toWordId");
      }
    }
  }
  const { effects } = audio;
  if (effects !== undefined && effects !== null) {
    if (!Array.isArray(effects) || effects.length > 40) throw new Error("audio.effects is a list of up to 40 one-shot sounds");
    effects.forEach((effect, index) => {
      const at = `audio.effects[${index}]`;
      if (!effect || typeof effect !== "object") throw new Error(`${at} must be an object`);
      if (!assetAudioPath(effect.src)) throw new Error(`${at}.src must be a project-relative audio file under assets/, e.g. assets/whoosh.mp3 (import_audio puts one there)`);
      const placed = Number.isInteger(effect.wordId) || typeof effect.at === "number";
      if (!placed) throw new Error(`${at} needs a wordId (the word it lands on) or an at in seconds`);
      if (Number.isInteger(effect.wordId) && typeof effect.at === "number") throw new Error(`${at} takes a wordId or an at, not both`);
      if (effect.at !== undefined && !(typeof effect.at === "number" && effect.at >= 0)) throw new Error(`${at}.at is seconds from the start of the film`);
      if (effect.level !== undefined && !between(effect.level, -40, 0)) throw new Error(`${at}.level is dB from -40 to 0`);
      if (effect.offset !== undefined && !(typeof effect.offset === "number" && effect.offset >= 0)) throw new Error(`${at}.offset is seconds into the file, 0 or more`);
      if (effect.seconds !== undefined && !between(effect.seconds, 0.05, EFFECT_MAX_SECONDS)) throw new Error(`${at}.seconds is 0.05 to ${EFFECT_MAX_SECONDS}`);
      if (effect.lead !== undefined && !between(effect.lead, 0, 1)) throw new Error(`${at}.lead is seconds to start early, 0 to 1`);
    });
  }
  if (voice !== undefined && voice !== null) {
    if (typeof voice !== "object") throw new Error("audio.voice must be an object");
    if (voice.loudness !== undefined && voice.loudness !== null && !between(voice.loudness, -30, -8)) throw new Error("audio.voice.loudness is integrated LUFS from -30 to -8 (-16 for a film, -14 for a short)");
    if (voice.measured !== undefined && voice.measured !== null && !between(voice.measured, -70, 0)) throw new Error("audio.voice.measured is the clean cut's integrated LUFS");
    if (voice.clean !== undefined && voice.clean !== null && !VOICE_CLEAN.has(voice.clean)) throw new Error(`audio.voice.clean is one of ${[...VOICE_CLEAN].join(", ")}`);
  }
}

// The clean-up a talking-head recording usually wants and rarely gets: the
// room's hum and hiss under the words, the desk's rumble below them. Light
// takes the floor down without touching the voice's air; strong is for a
// laptop microphone in a kitchen. Both run before the level is set, so the
// target is met on the cleaned voice.
export const VOICE_CLEAN = new Set(["off", "light", "strong"]);
const CLEAN_CHAINS = {
  light: "highpass=f=80:poles=2,afftdn=nf=-30:nr=8:tn=1",
  strong: "highpass=f=100:poles=2,afftdn=nf=-25:nr=16:tn=1,deesser=i=0.35:m=0.5",
};

// The bed's gain in dB. When both loudnesses are known — the music file's
// and the voice's, measured — `level` is LU below the voice, so -18 means
// the same thing for any file. When either is unknown, `level` is a plain
// gain on the file, which is what it was before anything was measured.
export function bedGainDb(music, voiceLoudness) {
  const level = music.level ?? MUSIC_DEFAULTS.level;
  if (typeof music.loudness === "number" && typeof voiceLoudness === "number") {
    return Math.min(0, voiceLoudness + level - music.loudness);
  }
  return level;
}

// The "I:  -16.2 LUFS" line of ffmpeg's ebur128 summary, as a number.
export function parseLoudness(text) {
  const match = String(text ?? "").match(/\bI:\s+(-?\d+(?:\.\d+)?)\s+LUFS/);
  return match ? Number(match[1]) : null;
}

export function resolveAudio(audio) {
  validateAudio(audio);
  const music = audio?.music ? { ...MUSIC_DEFAULTS, ...audio.music } : null;
  const voice = { loudness: audio?.voice?.loudness ?? null, measured: audio?.voice?.measured ?? null, clean: audio?.voice?.clean ?? "off" };
  return { music, voice, effects: audio?.effects ?? [] };
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
// Where the bed plays at all, as [start, end] seconds on the clean timeline:
// the whole film when no spans are given, else the word spans named. A span
// is padded a little either side so the bed leads the first word in and
// follows the last one out.
export function bedSpans(music, words, duration, { pad = 0.6 } = {}) {
  if (!music?.spans?.length) return [{ start: 0, end: duration }];
  const byId = new Map(words.map((w) => [w.id, w]));
  return music.spans
    .map(({ fromWordId, toWordId }) => {
      const a = byId.get(fromWordId);
      const b = byId.get(toWordId);
      if (!a || !b) throw new Error(`audio.music.spans names a word the clean transcript does not have (${fromWordId}–${toWordId})`);
      return { start: Number(Math.max(a.start - pad, 0).toFixed(3)), end: Number(Math.min(b.end + pad, duration).toFixed(3)) };
    })
    .sort((x, y) => x.start - y.start);
}

// A presence expression for the spans: 1 inside, 0 outside, faded over
// `fade` seconds at each edge.
export function spanPresenceExpression(spans, fade, T = "t") {
  if (!spans.length) return "0"; // no span in this window: the bed is silent here
  const f = Math.max(fade, 0.05);
  const tents = spans.map(({ start, end }) => `clip((${T}-${num(start)})/${num(f)},0,1)*clip((${num(end)}-${T})/${num(f)},0,1)`);
  return `min(1,${tents.join("+")})`;
}

// A clip's own sound, as the stitch places it: the clip scenes that carry
// sound and touch the span, each with where its file is read from and where
// in the span it lands. Level is dB on the file, -14 unless the plan says.
// A one-shot sits under the voice rather than beside it, and is over quickly.
export const EFFECT_DEFAULT_DB = -16;
export const EFFECT_MAX_SECONDS = 8;
// A hit lands better a breath before the picture changes than exactly on it.
export const EFFECT_DEFAULT_LEAD = 0.12;

// The film's one-shot sounds, resolved onto the span's own clock. Anchored to
// a word like everything else here, so a re-cut moves them with the words
// rather than leaving them stranded at a second that now means something else.
export function effectSounds(effects, words, { from = 0, span } = {}) {
  const byId = new Map((words ?? []).map((word) => [word.id, word]));
  return (effects ?? [])
    .map((effect) => {
      const anchor = Number.isInteger(effect.wordId) ? byId.get(effect.wordId)?.start : effect.at;
      if (typeof anchor !== "number") return null;
      const lead = effect.lead ?? (Number.isInteger(effect.wordId) ? EFFECT_DEFAULT_LEAD : 0);
      const start = Math.max(anchor - lead, 0);
      if (span !== undefined && (start >= from + span || start < from - 0.001)) return null;
      const seconds = Math.min(effect.seconds ?? EFFECT_MAX_SECONDS, span === undefined ? EFFECT_MAX_SECONDS : from + span - start);
      if (!(seconds > 0.05)) return null;
      return {
        src: effect.src,
        offset: Number((effect.offset ?? 0).toFixed(3)),
        at: Number((start - from).toFixed(3)),
        seconds: Number(seconds.toFixed(3)),
        level: effect.level ?? EFFECT_DEFAULT_DB,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.at - b.at);
}

export const NAT_SOUND_DEFAULT_DB = -14;
export function clipSounds(scenes, { from = 0, span }) {
  return (scenes ?? [])
    .filter((scene) => scene.type === "graphic" && scene.graphic?.kind === "clip" && scene.graphic.sound && scene.graphic.src)
    .filter((scene) => scene.end > from && scene.start < from + span)
    .map((scene) => {
      // A card on the film's first words is drawn from frame one (the
      // painter's edge rule); its sound starts with its picture.
      const sceneStart = scene.start <= 0.5 ? 0 : scene.start;
      const start = Math.max(sceneStart, from);
      const end = Math.min(scene.end, from + span);
      const level = typeof scene.graphic.sound === "object" && typeof scene.graphic.sound.level === "number" ? scene.graphic.sound.level : NAT_SOUND_DEFAULT_DB;
      return {
        src: scene.graphic.src,
        offset: Number(((scene.graphic.in ?? 0) + (start - sceneStart)).toFixed(3)),
        at: Number((start - from).toFixed(3)),
        seconds: Number((end - start).toFixed(3)),
        level,
      };
    });
}

export function audioGraph({ audio, words, from = 0, span, musicPath, voiceLoudness, voiceTrimDb = 0, clips = [], clipPath = (src) => src, effectPath = (src) => src }) {
  const { music, voice, effects } = resolveAudio(audio);
  // Two kinds of one-shot, mixed the same way and ducked differently: a
  // clip's own sound sits under the words like the bed, and a placed effect
  // does not — a whoosh ducked to nothing is a whoosh nobody hears. Keeping
  // an effect quiet is the level's job, and where it lands is the editor's.
  const nats = clipSounds(clips, { from, span });
  const hits = effectSounds(effects, words, { from, span });
  const sounds = [
    ...nats.map((sound) => ({ ...sound, duck: true, file: clipPath(sound.src) })),
    ...hits.map((sound) => ({ ...sound, duck: false, file: effectPath(sound.src) })),
  ];
  if (!music && voice.loudness === null && voice.clean === "off" && sounds.length === 0) return null;
  const lines = [];
  // The clean-up comes first, so a loudness target is met on the voice as it
  // will be heard.
  lines.push(`[1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo${voice.clean !== "off" ? `,${CLEAN_CHAINS[voice.clean]}` : ""}[v0]`);
  let voiceLabel = "v0";
  if (voice.loudness !== null) {
    // With the voice measured, the target is a plain gain and a true-peak
    // ceiling: exact, and the voice keeps its own dynamics. One-pass
    // loudnorm undershoots a very quiet recording by a couple of units and
    // reshapes it; it is the fallback when nothing was measured.
    const measured = voiceLoudness ?? voice.measured;
    if (typeof measured === "number") {
      // `voiceTrimDb` is the stitch's second pass: what the ceiling took off
      // the first time, added back.
      const gain = voice.loudness - measured + voiceTrimDb;
      lines.push(`[v0]volume=${num(gain)}dB,alimiter=limit=0.7943:attack=5:release=50:level=false[v1]`);
    } else lines.push(`[v0]loudnorm=I=${num(voice.loudness)}:TP=-1.5:LRA=11[v1]`);
    voiceLabel = "v1";
  }
  const voiceTarget = voice.loudness !== null && typeof (voiceLoudness ?? voice.measured) === "number" ? voice.loudness : null;
  // The clips' own sound: each read from its offset, placed at its second in
  // the span, at its level, and ducked under the words the way the bed is.
  // Inputs follow the music's (or take its place when there is none).
  const natInputs = [];
  const natLabels = [];
  if (sounds.length) {
    const natWindows = swellWindows(words, from + span)
      .map((w) => ({ start: w.start - from, end: w.end - from }))
      .filter((w) => w.end > 0 && w.start < span)
      .map((w) => ({ start: Number(Math.max(w.start, 0).toFixed(3)), end: Number(Math.min(w.end, span).toFixed(3)) }));
    sounds.forEach((sound, k) => {
      const index = 2 + (music ? 1 : 0) + k;
      const delayMs = Math.round(sound.at * 1000);
      // The duck reads t on the sound's own clock (the filter sits before
      // adelay), so the windows are read at t plus where the sound lands.
      const duck = sound.duck
        ? `,volume=volume='${bedGainExpression(natWindows, music ?? MUSIC_DEFAULTS, { offset: sound.at })}':eval=frame`
        : "";
      // A short hit gets short fades; a long clip keeps the old ones.
      const fadeIn = Math.min(0.25, sound.seconds / 4);
      const fadeOut = Math.min(0.35, sound.seconds / 3);
      lines.push(`[${index}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=N/SR/TB,atrim=duration=${num(sound.seconds)},volume=${num(sound.level)}dB${duck},afade=t=in:st=0:d=${num(fadeIn)},afade=t=out:st=${num(Math.max(sound.seconds - fadeOut, 0))}:d=${num(fadeOut)}${delayMs > 0 ? `,adelay=${delayMs}|${delayMs}` : ""}[nat${k}]`);
      natInputs.push("-ss", num(sound.offset), "-t", num(sound.seconds), "-i", sound.file);
      natLabels.push(`[nat${k}]`);
    });
  }
  if (!music) {
    if (!sounds.length) return { inputs: [], filter: lines.join(";\n") + "\n", map: `[${voiceLabel}]`, voiceTarget };
    lines.push(`[${voiceLabel}]${natLabels.join("")}amix=inputs=${1 + natLabels.length}:duration=first:dropout_transition=0:normalize=0[mix]`);
    return { inputs: natInputs, filter: lines.join(";\n") + "\n", map: "[mix]", voiceTarget, nats, hits, sounds };
  }
  // The film's swell windows, shifted to the span's own clock.
  const windows = swellWindows(words, from + span)
    .map((w) => ({ start: w.start - from, end: w.end - from }))
    .filter((w) => w.end > 0 && w.start < span)
    .map((w) => ({ start: Number(Math.max(w.start, 0).toFixed(3)), end: Number(Math.min(w.end, span).toFixed(3)) }));
  const gain = bedGainExpression(windows, music);
  const fade = Math.min(music.fade, span / 2);
  // Confined to spans: the presence rides the same expression, faded at
  // each span's edges, and the whole-film fades are not needed.
  const confined = Boolean(music.spans?.length);
  const presence = confined
    ? spanPresenceExpression(
      bedSpans(music, words, from + span).map((s) => ({ start: s.start - from, end: s.end - from })).filter((s) => s.end > 0 && s.start < span),
      music.fade || 1,
    )
    : null;
  const bed = [
    "[2:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo",
    // Timestamps from the sample count: a looped file restarts its own each
    // pass, and the gain expression reads t, which has to keep advancing.
    "asetpts=N/SR/TB",
    `atrim=duration=${num(span)}`,
    // Relative to the voice as it will be heard: its target when one is set
    // (the stitch gains it there), else what was measured — the same
    // reference describeAudio reports.
    `volume=${num(dbToLinear(bedGainDb(music, voice.loudness ?? voiceLoudness ?? voice.measured ?? undefined)))}`,
    `volume=volume='${presence ? `(${gain})*${presence}` : gain}':eval=frame`,
    ...(fade > 0 && !confined ? [`afade=t=in:st=0:d=${num(fade)}`, `afade=t=out:st=${num(Math.max(span - fade, 0))}:d=${num(fade)}`] : []),
  ];
  lines.push(`${bed.join(",")}[bed]`);
  lines.push(`[${voiceLabel}][bed]${natLabels.join("")}amix=inputs=${2 + natLabels.length}:duration=first:dropout_transition=0:normalize=0[mix]`);
  const inputs = [...(music.loop ? ["-stream_loop", "-1"] : []), ...(from > 0 ? ["-ss", num(from)] : []), "-i", musicPath, ...natInputs];
  return { inputs, filter: lines.join(";\n") + "\n", map: "[mix]", windows, gain, confined, voiceTarget, nats, hits, sounds };
}

// A one-line account of the bed, for the tool that sets it and for status.
export function describeAudio(audio, words, duration) {
  const { music, voice } = resolveAudio(audio);
  const out = { music: null, voice: { ...voice } };
  // A voice far below where platforms sit is worth saying once, here, where
  // the level of everything else is being decided.
  if (voice.clean !== "off") out.voice.cleanAbout = voice.clean === "light" ? "rumble below 80 Hz and the room's floor taken down 8 dB, the voice's air kept" : "rumble below 100 Hz out, the floor taken down 16 dB, sibilance softened — for a poor microphone in a live room";
  if (typeof voice.measured === "number" && voice.loudness === null && voice.measured < -24) {
    out.voice.note = `the voice measures ${voice.measured} LUFS; platforms sit near -14 to -16, so viewers will turn it up and hear the room. voice_loudness -16 (a film) or -14 (a short) normalises it.`;
  }
  if (music) {
    const windows = swellWindows(words ?? [], duration ?? 0);
    out.music = {
      ...music,
      swells: windows.length,
      swellSeconds: Number(windows.reduce((sum, w) => sum + w.end - w.start, 0).toFixed(1)),
      spans: music.spans?.length ? bedSpans(music, words ?? [], duration ?? 0) : null,
      relative: typeof music.loudness === "number" && typeof (voice.loudness ?? voice.measured) === "number",
      gainDb: Number(bedGainDb(music, voice.loudness ?? voice.measured ?? undefined).toFixed(1)),
      about: `${typeof music.loudness === "number" && typeof (voice.loudness ?? voice.measured) === "number"
        ? `${music.level} LU under the voice in the pauses, ${music.level + music.duck} LU under it while they speak (the file measures ${music.loudness} LUFS, the voice ${voice.loudness ?? voice.measured} LUFS, so the bed is gained ${bedGainDb(music, voice.loudness ?? voice.measured).toFixed(1)} dB)`
        : `${music.level} dB in the pauses, ${music.level + music.duck} dB under the voice — as a gain on the file, because its loudness has not been measured`}, ${music.ramp}s ramps, ${music.fade}s fades${music.loop ? ", looped" : ""}; ${windows.length} pause(s) the bed comes up in${music.spans?.length ? `; under ${music.spans.length} span(s) only` : ""}`,
    };
  }
  return out;
}
