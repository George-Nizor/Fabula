// Motion scenes: the assistant's own animation, written as code.
//
// Every other graphic in Fabula is drawn by the painter from a few fields.
// A motion scene is drawn by a small document the assistant writes — markup,
// styles and a script — kept under the project's motion/ folder and placed
// like any other graphic (`{ kind: "motion", src: "motion/orbit.html" }`).
// This is the way the new models make motion graphics well: code where every
// pixel is a pure function of time, sampled frame by frame.
//
// The document runs in a sandboxed frame with no network, no reach into the
// window and no clock of its own: renderer/motion/runtime.js gives it the
// scene's time, seeks every CSS and Web Animations animation to it, seeds
// its randomness per frame and calls its render(t). So the window's preview
// and the export's capture ask the same question and get the same picture.
//
// This file is the contract: what a document may contain, what a motion
// graphic may declare, and the description the assistant reads before
// writing one. No I/O.

export const MOTION_SRC_RE = /^motion\/[a-z0-9][a-z0-9-]{0,62}\.html$/;
export const MOTION_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const MOTION_MAX_CHARS = 200_000;
// Libraries the runtime can load into a scene. three.js ships with Fabula
// (renderer/motion/vendor/); GSAP is optional and loads only when installed,
// its licence barring it from a no-code builder's bundle. A scene is refused
// a library that is not present (the server checks). A project's own shared
// code lives under motion/lib/ and is named project:<name>.
export const MOTION_PROJECT_LIB_RE = /^project:[a-z0-9][a-z0-9-]{0,62}$/;
export const MOTION_LIB_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const MOTION_LIBS = {
  three: { file: "renderer/motion/vendor/three.min.js", about: "three.js 0.186 as the global THREE: WebGL scenes, cameras, lights, geometry. Make the renderer in setup with preserveDrawingBuffer: true, and call renderer.render(scene, camera) at the end of render(t)" },
  gsap: { file: "node_modules/gsap/dist/gsap.min.js", about: "GSAP timelines, seeked by the scene clock; register each with fabula.timeline(tl)" },
};

// What a scene document may not carry. The sandbox, its content policy and
// the hosts' navigation guard (electron/motion-protocol.cjs) enforce the
// security either way; these refusals exist so the assistant hears at write
// time what would otherwise fail silently in the frame, and so nothing in a
// film depends on the network or on a wall clock.
//
// Each rule reads only the part of the document it is about. A rule about
// code reads the scripts and the inline handlers; a rule about addresses
// reads what can hold one — attributes, styles and scripts. The words on
// screen are read by none of them: "import duties rose", "JavaScript: the
// good parts" and "dogs fetch (and carry) sticks" are text, not code.
const FORBIDDEN = [
  [["tags", "script"], /<\s*(iframe|frame|frameset|object|embed|portal|base|link|meta|form)\b/i, "a frame, an object, an embed, a form, a <base>, a <link> or a <meta> — everything the scene needs is in the file"],
  [["attributes", "style", "script"], /\bhttps?:\/\/(?!www\.w3\.org\/)/i, "a web address — the film renders offline; pictures come in as project assets (fetch_image, import_image) and are named with fabula.asset(\"name.png\")"],
  [["script"], /(?<![.\w$])fetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b|\bimportScripts\b|\bnew\s+(Shared)?Worker\b|\b(webkit)?RTCPeerConnection\b|\bRTCDataChannel\b|\bWebTransport\b/, "a network request, a peer connection or a worker — nothing leaves the frame"],
  [["script"], /\b(window|document|self|globalThis)\s*\.\s*location\b|\blocation\s*\.\s*(href|assign|replace)\b|\bnavigation\s*\.\s*navigate\s*\(/, "a navigation — the scene stays where it is, and the frame refuses to go anywhere else"],
  [["script"], /\bimport\s*\(|^\s*import\s+[\w{*]/m, "an import — scripts are plain, and libraries are declared in the graphic's libs"],
  [["script"], /\bset(Timeout|Interval|Immediate)\s*\(/, "a timer — draw from t in render(t), or give a CSS animation a delay"],
  [["script"], /\brequestAnimationFrame\s*\(/, "an animation loop — Fabula calls render(t) once for every frame of the film"],
  [["script"], /\b(localStorage|sessionStorage|indexedDB)\b|document\.cookie/, "storage — a scene has no memory between frames"],
  [["script"], /\bwindow\.(parent|top|opener)\b|\bpostMessage\s*\(/, "a message to the page — the frame's messages are Fabula's"],
  [["attributes", "style"], /javascript:/i, "a javascript: URL"],
];

// The document in the parts the rules read: the scripts (and inline
// handlers), the styles (and style attributes), the other attribute values,
// and the tags themselves. What is left — the text on screen — is nobody's.
function documentParts(doc) {
  const scripts = [];
  const styles = [];
  const markup = doc
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/(<script\b[^>]*>)([\s\S]*?)(?:<\/script\s*>|$)/gi, (_m, open, body) => { scripts.push(body); return open; })
    .replace(/(<style\b[^>]*>)([\s\S]*?)(?:<\/style\s*>|$)/gi, (_m, open, body) => { styles.push(body); return open; });
  const tags = markup.match(/<\/?[a-zA-Z][^>]*>/g) ?? [];
  const attributes = [];
  for (const tag of tags) {
    for (const match of tag.matchAll(/\s([^\s=>\/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      const value = match[2] ?? match[3] ?? match[4] ?? "";
      if (/^on/i.test(match[1])) scripts.push(value);
      else if (/^style$/i.test(match[1])) styles.push(value);
      else attributes.push(value);
    }
  }
  return { script: scripts.join("\n"), style: styles.join("\n"), attributes: attributes.join("\n"), tags: tags.join("\n") };
}

// The libraries a document needs, read from its scripts: THREE means three,
// gsap means GSAP, and a line "// fabula-libs: project:shapes, three" names
// any explicitly. The runtime loads these itself (renderer/motion/runtime.js
// reads them the same way), so a scene works without its placement naming
// them; the server checks each exists.
export function motionLibsOf(doc) {
  const scripts = [...String(doc).matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map((m) => m[1]).join("\n");
  const out = new Set();
  if (/\bTHREE\s*\./.test(scripts)) out.add("three");
  if (/\bgsap\s*\./.test(scripts)) out.add("gsap");
  for (const m of scripts.matchAll(/\/\/\s*fabula-libs:\s*([^\n]+)/g)) {
    for (const name of m[1].split(/[\s,]+/)) if (/^(project:)?[a-z0-9][a-z0-9-]*$/.test(name)) out.add(name);
  }
  return [...out];
}

// Checks a motion document as written. Throws the first refusal; returns the
// notes worth hearing (nothing moves, a clock read) when it passes.
export function validateMotionDoc(doc) {
  if (typeof doc !== "string" || doc.trim().length === 0) throw new Error("a motion scene needs a document: markup, styles and an optional script");
  if (doc.length > MOTION_MAX_CHARS) throw new Error(`a motion scene is at most ${MOTION_MAX_CHARS} characters; move pictures into assets/ and draw repetition with code`);
  const parts = documentParts(doc);
  for (const [scopes, rule, what] of FORBIDDEN) {
    if (scopes.some((scope) => rule.test(parts[scope]))) throw new Error(`a motion scene may not carry ${what}`);
  }
  const notes = [];
  const moves = /fabula\.scene\s*\(/.test(doc) || /@keyframes|animation\s*:|animation-name\s*:|\.animate\s*\(/.test(doc) || /fabula\.timeline\s*\(/.test(doc);
  if (!moves) notes.push("nothing in this document moves: no fabula.scene render(t), no CSS animation, no element.animate(). A still belongs in a custom card or a template.");
  if (/\bDate\.now\s*\(|\bperformance\.now\s*\(|new\s+Date\s*\(\s*\)/.test(doc)) notes.push("Date.now(), performance.now() and new Date() read the scene clock here, not the wall clock; t in render(t) says the same thing more plainly.");
  if (/\btransition\s*:/.test(doc)) notes.push("CSS transitions are switched off in motion scenes (they would run on the wall clock); animate with @keyframes, element.animate() or render(t).");
  return { notes };
}

// The graphic as a plan carries it.
export function validateMotionGraphic(graphic, at, { libs = null } = {}) {
  if (typeof graphic.src !== "string" || !MOTION_SRC_RE.test(graphic.src)) {
    throw new Error(`${at}: motion needs src "motion/<name>.html" (write_motion writes one)`);
  }
  if (graphic.full !== undefined && typeof graphic.full !== "boolean") throw new Error(`${at}: motion full is true or false`);
  if (graphic.over !== undefined && typeof graphic.over !== "boolean") throw new Error(`${at}: motion over is true or false`);
  if (graphic.params !== undefined && (graphic.params === null || typeof graphic.params !== "object" || Array.isArray(graphic.params))) {
    throw new Error(`${at}: motion params is an object the scene reads as fabula.params`);
  }
  if (graphic.params !== undefined && JSON.stringify(graphic.params).length > 20000) throw new Error(`${at}: motion params are at most 20000 characters of JSON`);
  if (graphic.libs !== undefined) {
    // Without a list (the render, the window) every known library and any
    // project library passes; the server checks what exists.
    const known = (lib) => (libs ? libs.includes(lib) : Object.hasOwn(MOTION_LIBS, lib) || MOTION_PROJECT_LIB_RE.test(lib));
    if (!Array.isArray(graphic.libs) || graphic.libs.length > 6 || graphic.libs.some((lib) => typeof lib !== "string" || !known(lib))) {
      throw new Error(`${at}: motion libs are chosen from ${libs?.length ? libs.join(", ") : "the installed libraries and project:<name> for motion/lib/<name>.js"}`);
    }
  }
  if (graphic.seed !== undefined && !Number.isInteger(graphic.seed)) throw new Error(`${at}: motion seed is an integer`);
  if (graphic.fade !== undefined && typeof graphic.fade !== "boolean") throw new Error(`${at}: motion fade is true or false`);
}

// The document as the assistant should write it, and the rules, in one
// read. describe_motion returns this; docs/craft/motion.md is the craft.
export function describeMotion({ stage = { width: 1920, height: 1080 }, fonts = [], libs = [] } = {}) {
  const tall = stage.height > stage.width;
  return {
    what: "A motion scene is a document you write — <style>, markup, <script> — drawn by Fabula's runtime at every frame of the film. Everything a browser can draw is available: HTML and CSS, SVG, Canvas 2D, WebGL and three.js. It comes in three sizes. A MOMENT inside a recorded film: a mechanism assembling itself, a number that becomes a shape, type choreographed to the words. A SEQUENCE inside a recorded film: twenty seconds to two minutes where the film stops showing the speaker and becomes motion graphics over its own sound — a documentary's explanation, the argument's turn — placed under a cutaway with fade: false, written as one reel. A MOTION FILM (new_motion): nothing but motion from the first frame to the last, timed to a narration or a length. For a sequence or a film, write a REEL: one document holding several shots (fabula.shot) in one shared world, with one camera (fabula.camera) and shapes that carry from shot to shot — that continuity is what makes motion graphics look designed rather than assembled.",
    file: "write_motion { name, html } writes motion/<name>.html and returns a contact sheet of frames across it and the CHECK PASS: the scene's text measured every fifth of a second as drawn — off the frame, outside the safe area, two blocks overlapping, too small to read — each with the seconds it holds for. Fix every check that is not brief, then LOOK at the sheet, fix and write again. Place it with a graphic scene: { type: \"graphic\", from_word_id, to_word_id, graphic: { kind: \"motion\", src: \"motion/<name>.html\", params?, full?, over?, libs?, seed?, fade? } }. The card fades the whole scene in over 0.45 s and out over 0.35 s on top of whatever the scene does itself; fade: false when the scene makes its own entrance and exit. seed changes its noise (fabula.random and Math.random): one document placed twice with different seeds draws different noise.",
    canvas: `The scene draws at the film's own pixels: ${stage.width}×${stage.height} for a full-stage scene (full, the default), or the layout's content rect for full: false. 100vw × 100vh is the scene's box; fabula.width and fabula.height say it in pixels. The page is transparent: paint your own background when the scene owns the stage (under a cutaway), leave it transparent when it floats over the field or sits beside the head.${tall ? " This film is vertical: design for a tall frame — stack, do not spread." : ""}`,
    clock: "t is seconds since the scene began (not the film). CSS @keyframes animations and element.animate() run on the scene clock from the scene's start: to start one later give it an animation-delay. render(t, ctx) is called once for every frame (30 fps) — draw what the frame is from t alone; never accumulate state from the previous frame, because frames are rendered out of order and in parallel. setup(ctx) runs once before the first frame: build the DOM, precompute, lay out — ctx.head is already where the head is when the scene starts.",
    api: {
      "fabula.scene({ setup(ctx), render(t, ctx) })": "Register the scene. Both optional; CSS animation alone is a scene.",
      "ctx": "{ t, p (0→1 over the span), span (seconds), frame, film (the film's own time), width, height, head: { x, y, w, h, visible } — the talking head's rectangle in scene pixels while the camera is on the stage, params, theme }",
      "fabula.params": "The graphic's params, so one document can serve several scenes.",
      "fabula.words / fabula.word(text, { after })": "The words spoken over the scene, each { text, t0, t1 } in seconds from its start; word() finds the first match (case and punctuation ignored). Land a beat on the narration — fabula.word(\"thrust\")?.t0 — rather than on a guessed second: it follows the words when the cut changes.",
      "fabula.theme": "{ accent, accent2, text, muted, ink, card, field: [three stops], fonts: { display, body, serif } } — the film's look. The same as CSS variables --accent, --accent-2, --text, --muted, --ink, --card, --field-1/2/3, --font-display, --font-body, --font-serif on :root.",
      "fabula.random(seed)": "A seeded generator — call it for a stable random() per seed; the placement's seed is mixed in. Math.random() is reseeded every frame (noise that is the same each time that frame is drawn).",
      "fabula.ease": "{ linear, in, out, inOut, outBack, outElastic, outBounce } — each takes 0→1.",
      "fabula.range(t, from, to)": "0→1 as t crosses [from, to], clamped — the workhorse for choreography.",
      "fabula.spring(t, { stiffness, damping })": "A settling spring from 0 to 1, overshoot included.",
      "fabula.stagger(i, count, t, { from, each, span })": "Progress of item i in a staggered build.",
      "fabula.lerp, fabula.clamp, fabula.mix(colorA, colorB, k)": "The small arithmetic.",
      "fabula.shot(t, [{ name, at } | { name, word, at }])": "A reel's shots in one document: the current shot as { name, index, t (seconds into it), p (0→1 across it), start, end, next }. A shot starts at a second, or on a spoken word with at as the fallback. Write each shot's motion over s.t and s.p, and keep the world (camera, shapes) shared across shots so things carry over instead of cutting.",
      "fabula.camera(t, [{ t, x, y, zoom, ease? }]) / fabula.cameraCss(cam)": "A camera keyed in time, eased between keys, zoom interpolated in log space (a pull-back from 8× to 1× moves at one perceived speed). cameraCss gives the transform for a world element the size of the frame (transform-origin 0 0); a canvas can apply the same numbers with setTransform.",
      "fabula.fit(element, { min, max })": "Sets the largest font size (px) at which the element's text fits its own box, and returns it. Call it in setup; the fonts are loaded by then. The check pass will tell you when a line still escapes.",
      "fabula.split(element, 'word' | 'char')": "Wraps each word (class word) or letter (class char) in an inline-block span with --i (its index) and --n (the count), for staggered CSS animation: animation-delay: calc(var(--i) * 60ms). Returns the spans.",
      "fabula.asset(name)": "The URL of a picture, clip or font under the project's assets/ — for <img src>, CSS url(), or new Image(). The file name or the assets/… path list_assets and fetch_image give.",
      "fabula.timeline(tl)": "Register a GSAP timeline so the scene clock drives it (GSAP loads when installed and the script uses gsap.). Timelines built without it do not move.",
      "THREE": "three.js, loaded when the script uses THREE. Make the WebGLRenderer in setup on your own <canvas> with preserveDrawingBuffer: true and alpha: true, size it to fabula.width × fabula.height, and end render(t) with renderer.render(scene, camera). Light it (a key light and an ambient fill), keep geometry modest, never animate from a clock — position everything from t.",
      "// fabula-libs: project:<name>": "A line in a script that loads the project's shared code from motion/lib/<name>.js (write_motion_lib) before the scene's own: the film's shape system, type scale or camera rig, written once for every reel.",
      "CSS --t, --p, --head-x/-y/-w/-h": "The clock, progress and head rectangle as CSS variables on :root, for calc() in styles.",
    },
    fonts: fonts.length ? `Vendored and ready by name: ${fonts.join(", ")}. The film's own are var(--font-display) and var(--font-body).` : "Use var(--font-display) and var(--font-body).",
    libs: libs.length ? `Libraries here: ${libs.join(", ")} — a scene loads one by using it (THREE., gsap.) or naming it in a "// fabula-libs:" line; the project's own come from write_motion_lib.` : "No libraries are installed; CSS, the Web Animations API, SVG and Canvas are always there.",
    vocabulary: [
      "These are the defaults you fall into. Each one reads as generated motion; do the opposite on purpose.",
      "Not everything rising 30 px and fading in: enter from where the thing comes from — scale from its anchor, draw along its path, wipe from its edge, become it from the previous shape.",
      "Not one ease everywhere: out for entrances, in for exits, inOut for the camera, a spring (damping 18–26, no wobble) for an arrival. No more than two moves in a shot on the same curve.",
      "Not one speed: the slowest beat should take three times the fastest. A held beat is a choice; give the film one held frame, still on purpose.",
      "Build, breathe, resolve: the first third of a beat brings things in, the middle holds them, the last third hands over. Exits are faster than entrances.",
      "One thing moves at a time. Stagger in order of importance, a whole stagger under half a second.",
      "Build the end state in static markup first, then animate towards it — most text that leaves the frame was never laid out at rest.",
      "Carry, do not cut: in a reel, the shape that ends a shot is the shape that starts the next — a dot becomes a planet, a bar becomes a timeline. The camera moves between ideas instead of the scene being replaced.",
      "No decoration that says nothing: no particle fields, glows, lens flares, rainbow gradients, 3D card flips or emoji unless the idea is one of them. One accent colour, for the one thing the viewer must look at.",
      "Anchor compositions to an edge or a grid line, not floating in the middle; leave the safe area clear.",
    ],
    head: "Under a pip or full layout the head sits in a corner ABOVE the scene (over: true puts the scene above the head instead). ctx.head says where it is at this frame, so a scene can frame it, point at it, or keep its text clear of it. Under a cutaway there is no head and the scene owns the stage.",
    rules: [
      "Every pixel is a function of t. No timers, no requestAnimationFrame, no network, no storage — write_motion refuses them.",
      "No web addresses: bring pictures in first (fetch_image, import_image) and name them with fabula.asset().",
      "CSS transitions are switched off; use @keyframes, element.animate() or render(t).",
      "A scene is captured at every frame. Keep the DOM moderate, draw particle fields on a canvas, and avoid huge blurs over the whole stage.",
      "Type sized from the frame: font-size in vh/vmin or px against fabula.height, never from the page's default. Keep text inside the frame's safe area — 5% from every edge, and in a vertical film above 78% of the height: the burned-in captions sit below that line and the platform's controls below them.",
      "Hold the result long enough to read: a line of text wants its word count ÷ 3 seconds of stillness after it lands.",
      "The check pass measures text in the DOM and SVG. Text drawn on a canvas or in WebGL is pixels: check it yourself on the sheet.",
    ],
    example: `<style>
  body { background: radial-gradient(circle at 30% 40%, var(--field-1), var(--field-3)); }
  canvas { position: absolute; inset: 0; }
  .line { position: absolute; left: 8vw; right: 8vw; top: 38vh; font: 800 min(11vh, 13vw)/1.05 var(--font-display); color: var(--text); }
  .line .word { animation: rise .7s cubic-bezier(.2,.8,.2,1) both; animation-delay: calc(.2s + var(--i) * 90ms); }
  .line .word:nth-child(3) { color: var(--accent); transform-origin: 50% 80%; }
  @keyframes rise { from { transform: translateY(6vh); opacity: 0; } }
</style>
<canvas id="c"></canvas>
<div class="line">Orbit is falling sideways</div>
<script>
  let ctx, stars, accent;
  fabula.scene({
    setup({ width, height }) {
      const c = document.getElementById("c"); c.width = width; c.height = height; ctx = c.getContext("2d");
      const rnd = fabula.random(7);
      stars = Array.from({ length: 140 }, () => ({ x: rnd() * width, y: rnd() * height, r: 0.6 + rnd() * 1.8 }));
      accent = fabula.split(document.querySelector(".line"), "word")[2];
    },
    render(t, { width, height }) {
      // The accent word kicks as the narration says it, a hair early; 1.2 s
      // is the fallback for a preview with no words.
      const hit = (fabula.word("falling")?.t0 ?? 1.2) - 0.15;
      accent.style.scale = String(1 + 0.12 * fabula.spring(t - hit) * (1 - fabula.range(t, hit + 0.5, hit + 0.9)));
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = fabula.theme.muted;
      for (const s of stars) {
        ctx.globalAlpha = 0.35 + 0.35 * Math.sin(t * 2 + s.x);
        ctx.beginPath(); ctx.arc(((s.x - t * 20) % width + width) % width, s.y, s.r, 0, 7); ctx.fill();
      }
    },
  });
</script>`,
  };
}
