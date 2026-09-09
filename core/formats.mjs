// What shape the film is delivered in.
//
// A format is three decisions that have to agree: the canvas the composition
// is painted on, the ceiling the clean cut is encoded at, and whether the
// piece is short-form (which changes what a good plan looks like, not just
// how many pixels it has). Chosen when the project is created, because the
// framing and the layouts both depend on it, and recorded in project.json
// beside the title — it is a property of the project, not of the look.
//
// Portrait is not landscape rotated. The head fills the frame instead of
// sitting in it, there are no free columns beside it, and the visual has to
// live above or below rather than to one side. core/stage-engine.mjs reads
// the stage's own shape and answers accordingly, so a scene plan written for
// one format is legible in the other: the layout names mean the same thing,
// the rectangles do not.

export const FORMATS = {
  landscape: {
    id: "landscape",
    label: "Landscape",
    about: "16:9, 1920×1080. YouTube, a talk, a walkthrough — anything watched on a screen wider than it is tall.",
    stage: { width: 1920, height: 1080 },
    ceiling: { width: 1920, height: 1080 },
    shortForm: false,
    // What the format expects of a piece's length, in seconds. Advisory: the
    // clip engine scores candidates against it and the window says so.
    duration: null,
  },
  vertical: {
    id: "vertical",
    label: "Vertical",
    about: "9:16, 1080×1920. Shorts, Reels, TikTok — held in one hand, watched to the end or not at all.",
    stage: { width: 1080, height: 1920 },
    // The head track is cropped to fill a tall frame at compose time, not
    // when the clean cut is rendered, so the band layout can still show the
    // whole recording. The ceiling therefore has to leave room for a crop
    // that is not an upscale: from 16:9 footage a full-bleed 9:16 window
    // needs a head 1920 tall, which is 3414 wide. headOutputSize never grows
    // past the source rect, so a 1080p recording still encodes at 1920×1080
    // and only a recording that has the pixels pays for them.
    ceiling: { width: 3840, height: 1920 },
    shortForm: true,
    duration: { min: 12, max: 90, ideal: 38 },
  },
};

export const DEFAULT_FORMAT = "landscape";
export const FORMAT_IDS = Object.keys(FORMATS);

export const isPortrait = (stage) => Boolean(stage) && stage.height > stage.width;

// A format id from anything: an id, a project.json, a compose config. Unknown
// or absent is landscape, because that is what every project made before
// formats existed actually is.
export function resolveFormat(value) {
  const id = typeof value === "string" ? value : value?.format;
  return Object.hasOwn(FORMATS, id) ? FORMATS[id] : FORMATS[DEFAULT_FORMAT];
}

export function validateFormat(id) {
  if (id === undefined || id === null) return DEFAULT_FORMAT;
  if (!Object.hasOwn(FORMATS, id)) throw new Error(`format must be one of ${FORMAT_IDS.join(", ")}`);
  return id;
}

// The stage a format paints on. Kept separate from resolveFormat so callers
// that only want the canvas do not have to know the shape of a format.
export const stageOf = (value) => resolveFormat(value).stage;
export const ceilingOf = (value) => resolveFormat(value).ceiling;

export function describeFormats() {
  return FORMAT_IDS.map((id) => {
    const { label, about, stage, shortForm, duration } = FORMATS[id];
    return { id, label, about, stage, aspect: Number((stage.width / stage.height).toFixed(4)), shortForm, duration };
  });
}
