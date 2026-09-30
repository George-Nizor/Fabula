import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { validateMotionDoc, validateMotionGraphic, describeMotion, MOTION_LIBS } from "../core/motion.mjs";
import { validateScenes } from "../core/compose-engine.mjs";

const require = createRequire(import.meta.url);
const { resolveMotionRequest } = require("../electron/motion-protocol.cjs");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

test("the example the assistant is shown passes the rules it is held to", () => {
  const { example } = describeMotion();
  const { notes } = validateMotionDoc(example);
  assert.deepEqual(notes, []);
  assert.match(describeMotion({ stage: { width: 1080, height: 1920 } }).canvas, /vertical/);
});

test("a motion document may not reach outside its frame or its clock", () => {
  const refusals = [
    ['<img src="https://example.com/x.png">', /web address/],
    ["<script>fetch('/x')</script>", /network/],
    ["<script>new XMLHttpRequest()</script>", /network/],
    ["<script>setTimeout(() => {}, 10)</script>", /timer/],
    ["<script>setInterval(tick, 10)</script>", /timer/],
    ["<script>requestAnimationFrame(loop)</script>", /animation loop/],
    ["<script>import('x')</script>", /import/],
    ['<iframe src="x.html"></iframe>', /frame/],
    ['<link rel="stylesheet" href="x.css">', /link/],
    ["<script>localStorage.x = 1</script>", /storage/],
    ["<script>window.parent.document</script>", /message to the page/],
    ["<script>postMessage('x', '*')</script>", /message to the page/],
    ['<a href="javascript:alert(1)">x</a>', /javascript/],
    // The ways out a content policy does not close: the frame navigating
    // itself, and WebRTC.
    ["<script>window.location = base + words</script>", /navigation/],
    ["<script>location.href = next</script>", /navigation/],
    ["<script>new RTCPeerConnection({})</script>", /peer connection/],
    ['<img onerror="fetch(1)" src="a.png">', /network/],
    ["<script>el.innerHTML = '<iframe>'</script>", /frame/],
    ['<form action="x"></form>', /form/],
  ];
  for (const [doc, why] of refusals) assert.throws(() => validateMotionDoc(doc), why, doc);
  assert.throws(() => validateMotionDoc(""), /needs a document/);
  assert.throws(() => validateMotionDoc("x".repeat(200_001)), /at most/);
});

test("what looks like a rule break but is not passes", () => {
  // An SVG's namespace is a URL and not a load; a variable called parent is
  // not the page; fetching is fine as a word.
  const doc = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle r="4"/></svg>
    <p>We fetch the ball.</p>
    <script>const parent = document.body; parent.append("x"); fabula.scene({ render(t) {} });</script>`;
  assert.deepEqual(validateMotionDoc(doc).notes, []);
  // Words on screen are not code: each of these was once refused as one.
  for (const text of ["import duties rose", "JavaScript: the good parts", "Dogs fetch (and carry) sticks", "see https://example.com", "setTimeout() is not allowed here"]) {
    assert.doesNotThrow(() => validateMotionDoc(`<p>${text}</p><style>@keyframes a {}</style>`), text);
  }
  // Nor is a variable a map scene might well call location.
  assert.doesNotThrow(() => validateMotionDoc("<script>const location = { x: 1 }; fabula.scene({ render(t) {} });</script>"));
});

test("a document that never moves, or reads a clock, is told so", () => {
  assert.match(validateMotionDoc("<div>still</div>").notes[0], /nothing in this document moves/);
  assert.ok(validateMotionDoc("<style>@keyframes a{}</style><script>Date.now()</script>").notes.some((n) => /scene clock/.test(n)));
  assert.ok(validateMotionDoc("<style>.a{transition: opacity 1s; animation: a 1s}</style>").notes.some((n) => /transitions are switched off/.test(n)));
});

test("a motion graphic names a document under motion/ and nothing it cannot load", () => {
  const ok = (graphic) => validateMotionGraphic({ kind: "motion", ...graphic }, "scene 0");
  ok({ src: "motion/orbit.html" });
  ok({ src: "motion/orbit-2.html", params: { title: "x" }, full: false, over: true, seed: 3, fade: false, libs: ["gsap"] });
  assert.throws(() => ok({ src: "assets/orbit.html" }), /motion\/<name>\.html/);
  assert.throws(() => ok({ src: "motion/../x.html" }), /motion\/<name>\.html/);
  assert.throws(() => ok({ src: "motion/Orbit.html" }), /motion\/<name>\.html/);
  assert.throws(() => ok({ src: "motion/a.html", params: [] }), /params/);
  assert.throws(() => ok({ src: "motion/a.html", libs: ["three"] }), /libs/);
  assert.throws(() => validateMotionGraphic({ kind: "motion", src: "motion/a.html", libs: ["gsap"] }, "scene 0", { libs: [] }), /none installed/);
  assert.ok(Object.keys(MOTION_LIBS).includes("gsap"));
});

test("the plan validator takes a motion scene like any graphic", () => {
  const words = [{ id: 0, text: "a", start: 0, end: 0.5 }, { id: 1, text: "b", start: 0.6, end: 1 }];
  validateScenes([{ type: "graphic", fromWordId: 0, toWordId: 1, graphic: { kind: "motion", src: "motion/a.html" } }], words);
  assert.throws(() => validateScenes([{ type: "graphic", fromWordId: 0, toWordId: 1, graphic: { kind: "motion", src: "motion/a.html", libs: ["gsap"] } }], words, { motionLibs: [] }), /libs/);
});

test("the motion scheme serves its allowlist and nothing else", () => {
  const project = "/tmp/fabula-project";
  const ask = (url, projectDir = project) => resolveMotionRequest(url, { repoRoot: ROOT, projectDir });
  assert.equal(ask("fabula-motion://runtime/motion/host.html"), path.join(ROOT, "renderer", "motion", "host.html"));
  assert.equal(ask("fabula-motion://runtime/motion/runtime.js"), path.join(ROOT, "renderer", "motion", "runtime.js"));
  assert.equal(ask("fabula-motion://runtime/fonts.css"), path.join(ROOT, "renderer", "fonts.css"));
  assert.equal(ask("fabula-motion://runtime/assets/fonts/inter-normal.woff2"), path.join(ROOT, "renderer", "assets", "fonts", "inter-normal.woff2"));
  assert.equal(ask("fabula-motion://runtime/overlays.js"), null, "the painter is not the scene's to read");
  assert.equal(ask("fabula-motion://runtime/../electron/main.cjs"), null);
  assert.equal(ask("fabula-motion://runtime/%2e%2e/electron/main.cjs"), null);
  assert.equal(ask("fabula-motion://project/motion/orbit.html"), path.join(project, "motion", "orbit.html"));
  assert.equal(ask("fabula-motion://project/assets/logo.png"), path.join(project, "assets", "logo.png"));
  assert.equal(ask("fabula-motion://project/compose.json"), null, "the plan is not the scene's to read");
  assert.equal(ask("fabula-motion://project/assets/..%2f..%2fetc%2fpasswd"), null);
  assert.equal(ask("fabula-motion://project/motion/orbit.html", null), null, "no project, nothing to serve");
  assert.equal(ask("fabula-motion://lib/gsap.js"), path.join(ROOT, "node_modules", "gsap", "dist", "gsap.min.js"));
  assert.equal(ask("fabula-motion://lib/lodash.js"), null);
  assert.equal(ask("fabula-motion://elsewhere/x"), null);
  assert.equal(ask("file:///etc/passwd"), null);
});
