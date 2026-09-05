// The clean cut as a filter graph a person could read and ffmpeg can run
// fast. No I/O.
//
// The obvious graph — one trim per piece, hundreds of branches, concat —
// runs on a single filter-graph thread that spends its time scheduling
// branches, not filtering: the old render pinned that thread while the
// decoder idled. This one has a branch per DISTINCT framing rect (two or
// three for an OBS session, one for a plain take), each cropping and scaling
// every frame, switched by an `enable` expression, and one `select` that
// keeps the frames of the pieces and compacts the timeline. Every decision
// is made on the 30 fps frame grid by frame NUMBER, never by a float in
// seconds, and the audio is trimmed to exactly the instants those frames
// were taken from — so the clean cut's audio and video are the same length
// to the sample, piece after piece, instead of drifting apart by up to a
// frame per cut.

const EPSILON = 1e-6;

// Pieces (raw time, in order, with their rects) placed on the frame grid:
// the raw frame numbers they keep, the exact raw instants the audio takes,
// and where they land on the clean timeline. Pieces too short for a frame
// disappear.
export function frameSpans(pieces, fps) {
  const spans = [];
  let cursor = 0;
  for (const piece of pieces) {
    const firstFrame = Math.ceil(piece.start * fps - EPSILON);
    const lastFrame = Math.ceil(piece.end * fps - EPSILON) - 1;
    const frames = lastFrame - firstFrame + 1;
    if (frames <= 0) continue;
    spans.push({
      ...piece,
      firstFrame,
      lastFrame,
      frames,
      audioStart: firstFrame / fps,
      audioEnd: (lastFrame + 1) / fps,
      cleanStart: cursor / fps,
      cleanEnd: (cursor + frames) / fps,
    });
    cursor += frames;
  }
  return spans;
}

const rectKey = (r) => `${r.x}:${r.y}:${r.w}:${r.h}`;
const crop = (rect) => `crop=${rect.w}:${rect.h}:${rect.x}:${rect.y}`;

// ffmpeg's expression parser gives up ("Cannot allocate memory") somewhere
// past a hundred operands in one flat chain; a tree of parenthesised groups
// parses at any size. Exported for the test that keeps it that way.
export const SUM_GROUP = 16;
export function sumExpression(terms) {
  if (terms.length <= SUM_GROUP) return terms.join("+");
  const groups = [];
  for (let i = 0; i < terms.length; i += SUM_GROUP) groups.push(`(${terms.slice(i, i + SUM_GROUP).join("+")})`);
  return sumExpression(groups);
}

const ranges = (spans) => sumExpression(spans.map((s) => `between(n,${s.firstFrame},${s.lastFrame})`));

// Distinct rects among the spans (by a key), each with the spans using it.
function groups(spans, pick) {
  const list = [];
  const byKey = new Map();
  for (const span of spans) {
    const rect = pick(span);
    if (!rect) continue;
    const key = rectKey(rect);
    let group = byKey.get(key);
    if (!group) {
      group = { rect, spans: [] };
      byKey.set(key, group);
      list.push(group);
    }
    group.spans.push(span);
  }
  return list;
}

// The graph text: [v] the head track, [a] its audio, [s] the screen track
// when screenSize is given. rawDuration bounds the dark plate the screen
// track shows where the framing has no screen.
export function cleanGraph({ spans, fps, headSize, screenSize, rawDuration }) {
  if (spans.length === 0) throw new Error("no frames to keep");
  const heads = groups(spans, (s) => s.head);
  const screens = screenSize ? groups(spans, (s) => s.screen) : [];
  const branches = heads.length + screens.length;
  const lines = [];
  const labels = Array.from({ length: branches }, (_, i) => `[f${i}]`).join("");
  lines.push(`[0:v]fps=${fps}${branches > 1 ? `,split=${branches}${labels}` : labels}`);

  heads.forEach((group, k) => {
    lines.push(`[f${k}]${crop(group.rect)},scale=${headSize.width}:${headSize.height}:flags=lanczos,setsar=1[h${k}]`);
  });
  let base = "h0";
  heads.slice(1).forEach((group, i) => {
    const k = i + 1;
    lines.push(`[${base}][h${k}]overlay=0:0:enable='${ranges(group.spans)}'[hb${k}]`);
    base = `hb${k}`;
  });
  const keep = ranges(spans);
  lines.push(`[${base}]select='${keep}',setpts=N/(${fps}*TB)[v]`);

  spans.forEach((span, i) => {
    lines.push(`[0:a]atrim=start=${span.audioStart.toFixed(6)}:end=${span.audioEnd.toFixed(6)},asetpts=PTS-STARTPTS[a${i}]`);
  });
  lines.push(`${spans.map((_, i) => `[a${i}]`).join("")}concat=n=${spans.length}:v=0:a=1[a]`);

  if (screenSize) {
    lines.push(`color=c=0x0b0e12:s=${screenSize.width}x${screenSize.height}:r=${fps}:d=${(rawDuration + 1).toFixed(3)},setsar=1[sbase]`);
    let sbase = "sbase";
    screens.forEach((group, i) => {
      const k = heads.length + i;
      lines.push(
        `[f${k}]${crop(group.rect)},scale=${screenSize.width}:${screenSize.height}:force_original_aspect_ratio=decrease:flags=bicubic,` +
        `pad=${screenSize.width}:${screenSize.height}:-1:-1:color=0x0b0e12,setsar=1[s${i}]`,
      );
      lines.push(`[${sbase}][s${i}]overlay=0:0:enable='${ranges(group.spans)}'[sb${i}]`);
      sbase = `sb${i}`;
    });
    lines.push(`[${sbase}]select='${keep}',setpts=N/(${fps}*TB)[s]`);
  }
  return { graph: lines.join(";\n") + "\n", heads: heads.length, screens: screens.length };
}
