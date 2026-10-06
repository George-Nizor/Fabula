"use strict";

// Fabula's motion runtime. It runs inside the sandboxed frame the painter
// puts on the stage for a motion scene (renderer/overlays.js), draws that one
// scene, and draws it only when told which instant to draw.
//
// A scene is a document the assistant wrote (core/motion.mjs is the
// contract). The film is sampled frame by frame, out of order and in several
// processes at once, so every pixel has to be a function of the scene's time
// and nothing else. That is enforced here rather than hoped for: the scene
// has no clock but the one this file sets, Math.random is reseeded for every
// frame, timers do nothing, requestAnimationFrame callbacks run once per
// frame on the scene's time, and every CSS or Web Animations animation — and
// every registered GSAP timeline — is seeked to the instant before the frame
// is acknowledged. The window's preview and the export's capture send the
// same messages and get the same picture.
//
// Messages (window.postMessage, from the parent only):
//   { fabula: "load", token, src, stamp, params, theme, width, height, span, seed, libs }
//   { fabula: "seek", token, n, t, p, film, head }
// Replies: { fabula: "hello" }, { fabula: "ready", token, errors }, { fabula: "drawn", token, n, errors }.

(() => {
  const realRaf = window.requestAnimationFrame.bind(window);
  // The runtime's own waits keep the real timer; the scene's is refused below.
  const realTimeout = window.setTimeout.bind(window);
  const nextPaint = () => new Promise((resolve) => realRaf(() => realRaf(resolve)));
  const post = (message) => window.parent.postMessage({ ...message }, "*");

  // ---- Everything the scene says goes wrong, for the tool that wrote it ----
  const errors = [];
  const report = (message) => {
    const text = String(message ?? "an error").slice(0, 300);
    if (errors.length < 20 && !errors.includes(text)) errors.push(text);
  };
  const drain = () => errors.splice(0, errors.length);
  window.addEventListener("error", (event) => {
    report(event.message ? `${event.message}${event.lineno ? ` (script line ${event.lineno})` : ""}` : `could not load ${event.target?.src ?? event.target?.href ?? "a resource"}`);
  }, true);
  window.addEventListener("unhandledrejection", (event) => report(event.reason?.message ?? event.reason));
  window.addEventListener("securitypolicyviolation", (event) => report(`blocked by the frame's policy: ${event.blockedURI || event.violatedDirective}`));

  // ---- The scene's clock ----
  let clock = 0; // seconds since the scene began
  const EPOCH = Date.UTC(2026, 0, 1);
  const RealDate = Date;
  class SceneDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(EPOCH + clock * 1000);
      else super(...args);
    }
    static now() { return EPOCH + clock * 1000; }
  }
  window.Date = SceneDate;

  // No peer connections. WebRTC is the one way out that no content policy
  // governs; the hosts give it no UDP and no route (motion-protocol.cjs),
  // and the constructors go as well, so a scene that reaches for one fails
  // where it can be seen.
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "WebTransport"]) {
    try { Object.defineProperty(window, name, { value: undefined, writable: false, configurable: false }); } catch { /* not in this build */ }
  }
  Object.defineProperty(performance, "now", { value: () => clock * 1000, configurable: true });

  // Seeded noise: the same frame draws the same noise every time it is drawn.
  const mulberry = (seed) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const hash = (value) => {
    const text = String(value);
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return h >>> 0;
  };
  let baseSeed = 1;
  let noise = mulberry(baseSeed);
  Math.random = () => noise();

  // No wall-clock scheduling. A timer is refused once, out loud.
  const refused = new Set();
  const refuse = (name) => () => {
    if (!refused.has(name)) { refused.add(name); report(`${name} does nothing in a motion scene: draw from t in render(t), or give a CSS animation a delay`); }
    return 0;
  };
  window.setTimeout = refuse("setTimeout");
  window.setInterval = refuse("setInterval");
  // requestAnimationFrame callbacks run once per drawn frame, on the scene's
  // time. A library's ticker keeps working; a scene that keeps state across
  // frames this way is only right when frames arrive in order, which is why
  // the contract asks for render(t) instead.
  let rafQueue = [];
  window.requestAnimationFrame = (callback) => { rafQueue.push(callback); return rafQueue.length; };
  window.cancelAnimationFrame = () => {};

  // ---- The API a scene writes against ----
  let scene = null;
  let context = { params: {}, theme: {}, width: innerWidth, height: innerHeight, span: 1 };
  const timelines = [];
  const pending = [];
  const clamp = (x, lo = 0, hi = 1) => Math.min(Math.max(x, lo), hi);
  const lerp = (a, b, k) => a + (b - a) * k;
  const ease = {
    linear: (x) => clamp(x),
    in: (x) => clamp(x) ** 3,
    out: (x) => 1 - (1 - clamp(x)) ** 3,
    inOut: (x) => { const k = clamp(x); return k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2; },
    outBack: (x) => { const c = 1.70158; const k = clamp(x) - 1; return 1 + (c + 1) * k * k * k + c * k * k; },
    outElastic: (x) => { const k = clamp(x); return k === 0 || k === 1 ? k : 2 ** (-10 * k) * Math.sin((k * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1; },
    outBounce: (x) => {
      let k = clamp(x); const n = 7.5625; const d = 2.75;
      if (k < 1 / d) return n * k * k;
      if (k < 2 / d) { k -= 1.5 / d; return n * k * k + 0.75; }
      if (k < 2.5 / d) { k -= 2.25 / d; return n * k * k + 0.9375; }
      k -= 2.625 / d; return n * k * k + 0.984375;
    },
  };
  const normal = (text) => String(text ?? "").toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");
  const hex = (color) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(color).trim());
    if (!m) return [0, 0, 0];
    const v = parseInt(m[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  };
  const fabula = {
    scene(definition) { scene = definition && typeof definition === "object" ? definition : null; },
    timeline(tl) {
      if (tl && typeof tl.seek === "function") {
        timelines.push(tl);
        try { tl.pause(0); } catch (error) { report(error.message); }
      }
      return tl;
    },
    // The placement's seed is mixed in, so one document placed twice with
    // different seeds draws different noise, as the graphic's seed promises.
    random: (seed = 1) => mulberry((hash(seed) ^ baseSeed) >>> 0),
    clamp,
    lerp,
    ease,
    range: (t, from, to) => (to <= from ? (t >= to ? 1 : 0) : clamp((t - from) / (to - from))),
    // A damped spring from 0 to 1: overshoots and settles, closed form.
    spring: (t, { stiffness = 170, damping = 18, mass = 1 } = {}) => {
      if (t <= 0) return 0;
      const w0 = Math.sqrt(stiffness / mass);
      const zeta = damping / (2 * Math.sqrt(stiffness * mass));
      if (zeta < 1) {
        const wd = w0 * Math.sqrt(1 - zeta * zeta);
        return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + (zeta * w0 / wd) * Math.sin(wd * t));
      }
      return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
    },
    stagger: (i, count, t, { from = 0, each = 0.08, span = 0.5 } = {}) => clamp((t - from - i * each) / span),
    mix: (a, b, k) => {
      const [x, y] = [hex(a), hex(b)];
      const c = x.map((v, i) => Math.round(lerp(v, y[i], clamp(k))));
      return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
    },
    split(element, by = "word") {
      if (!element) return [];
      const text = element.textContent ?? "";
      const parts = by === "char" ? [...text] : text.split(/(\s+)/);
      const spans = [];
      element.replaceChildren();
      for (const part of parts) {
        if (by !== "char" && /^\s+$/.test(part)) { element.append(part); continue; }
        if (part === "") continue;
        const span = document.createElement("span");
        span.className = by === "char" ? "char" : "word";
        span.textContent = part;
        element.append(span);
        spans.push(span);
      }
      spans.forEach((span, i) => { span.style.setProperty("--i", String(i)); span.style.setProperty("--n", String(spans.length)); });
      return spans;
    },
    // list_assets and fetch_image name a file assets/<name>; either spelling works.
    asset: (name) => `fabula-motion://project/assets/${String(name).replace(/^(\.\/)?assets\//, "").split("/").map(encodeURIComponent).join("/")}`,
    // A picture the scene draws itself (canvas); the first frame waits for it.
    image(name) {
      const img = new Image();
      img.src = fabula.asset(name);
      pending.push(img.decode().catch(() => report(`could not load the picture ${name} (list_assets names what exists)`)));
      return img;
    },
    // The words spoken over the scene, each { text, t0, t1 } in seconds from
    // the scene's start: choreography that lands on the narration and moves
    // with it when the cut changes.
    get words() { return context.words ?? []; },
    word(match, { after = 0 } = {}) {
      const want = normal(match);
      return (context.words ?? []).find((w) => w.t0 >= after - 0.001 && normal(w.text) === want) ?? null;
    },
    get params() { return context.params ?? {}; },
    get theme() { return context.theme ?? {}; },
    get width() { return context.width; },
    get height() { return context.height; },
    get span() { return context.span; },
  };
  window.fabula = fabula;

  // ---- Loading the scene ----
  const root = document.documentElement;
  const setVar = (name, value) => root.style.setProperty(name, String(value));
  const family = (name) => (name ? `"${String(name).replace(/"/g, "")}", system-ui, sans-serif` : "system-ui, sans-serif");
  function applyTheme(theme = {}) {
    const vars = { "--accent": theme.accent, "--accent-2": theme.accent2, "--text": theme.text, "--muted": theme.muted, "--ink": theme.ink, "--card": theme.card };
    for (const [name, value] of Object.entries(vars)) if (value) setVar(name, value);
    (theme.field ?? []).forEach((stop, i) => setVar(`--field-${i + 1}`, stop));
    setVar("--font-display", family(theme.fonts?.display));
    setVar("--font-body", family(theme.fonts?.body));
    setVar("--font-serif", family(theme.fonts?.serif ?? theme.fonts?.display));
  }

  function loadScript(src) {
    return new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = src;
      script.onload = () => resolve(true);
      script.onerror = () => { report(`could not load ${src}`); resolve(false); };
      document.head.append(script);
    });
  }

  let token = null;
  let loaded = null;

  async function load(message) {
    token = message.token;
    context = {
      params: message.params ?? {},
      theme: message.theme ?? {},
      width: message.width,
      height: message.height,
      span: message.span ?? 1,
      words: Array.isArray(message.words) ? message.words : [],
    };
    baseSeed = hash(message.seed ?? message.src ?? 1);
    clock = 0;
    noise = mulberry(baseSeed);
    applyTheme(context.theme);
    setVar("--t", 0);
    setVar("--p", 0);
    // Libraries first, in the order named: Fabula's (three, gsap), then the
    // project's own shared code under motion/lib/ (project:<name>), which
    // may lean on them. A project library may bring a stylesheet beside it.
    for (const lib of message.libs ?? []) {
      const own = /^project:([a-z0-9][a-z0-9-]*)$/.exec(lib);
      if (own) {
        const css = await fetch(`fabula-motion://project/motion/lib/${own[1]}.css`).catch(() => null);
        if (css?.ok) { const style = document.createElement("style"); style.textContent = await css.text(); document.head.append(style); }
        await loadScript(`fabula-motion://project/motion/lib/${own[1]}.js`);
      } else if (/^[a-z0-9-]+$/.test(lib)) await loadScript(`fabula-motion://lib/${lib}.js`);
    }
    if (window.gsap) {
      try {
        window.gsap.config({ force3D: false });
        window.gsap.ticker.lagSmoothing(0);
        window.gsap.globalTimeline.pause();
      } catch (error) { report(error.message); }
    }
    let doc = "";
    try {
      const response = await fetch(`fabula-motion://project/${message.src}?v=${encodeURIComponent(message.stamp ?? "")}`);
      if (!response.ok) throw new Error(`${message.src} is not in the project (write_motion writes it)`);
      doc = await response.text();
    } catch (error) {
      report(error.message);
    }
    const parsed = new DOMParser().parseFromString(doc, "text/html");
    const scripts = [...parsed.querySelectorAll("script")];
    for (const script of scripts) script.remove();
    for (const style of parsed.querySelectorAll("style")) document.head.append(style);
    document.body.replaceChildren(...[...parsed.body.childNodes].map((node) => document.adoptNode(node)));
    // Inline scripts run as they are inserted, in order, with their own line
    // numbers in any error they throw.
    for (const source of scripts) {
      const script = document.createElement("script");
      script.textContent = source.textContent;
      document.body.append(script);
    }
    // The head as the stage had it when the scene was built, so setup can lay
    // out around it; every seek brings it again as it is at that frame.
    setHead(message.head);
    try {
      scene?.setup?.(frameContext(0, 0, { head: message.head ?? null }));
    } catch (error) {
      report(`setup: ${error.message}`);
    }
    const pictures = [...document.images].map((img) => img.decode().catch(() => report(`could not load ${img.getAttribute("src")}`)));
    // A face used only on a canvas is not asked for until the first draw —
    // after ready — so the first frame drew in a fallback and the rest in the
    // real face, and the film and the window disagreed on it. Every face the
    // document names, and the film's own, are loaded before ready.
    const named = `${doc}\n${JSON.stringify(context.theme?.fonts ?? {})}`;
    const faces = [...document.fonts].filter((face) => named.includes(face.family.replace(/^["']|["']$/g, "")));
    const fonts = faces.map((face) => face.load().catch(() => report(`the font ${face.family} did not load`)));
    await Promise.allSettled([...pending, ...pictures, ...fonts]);
    try { await document.fonts.ready; } catch { /* fonts are best effort */ }
    post({ fabula: "ready", token, errors: drain() });
  }

  function frameContext(t, p, message) {
    return {
      t,
      p,
      span: context.span,
      frame: message?.n ?? 0,
      film: message?.film ?? t,
      width: context.width,
      height: context.height,
      head: message?.head ?? { x: 0, y: 0, w: 0, h: 0, visible: false },
      params: context.params,
      theme: context.theme,
    };
  }

  function seekMedia(t) {
    const waits = [];
    for (const video of document.querySelectorAll("video")) {
      video.muted = true;
      video.pause();
      const target = Math.max(0, t + Number(video.dataset.offset ?? 0));
      if (Math.abs(video.currentTime - target) <= 0.001) continue;
      waits.push(new Promise((resolve) => {
        // A clip that cannot seek must not hold the render up forever.
        const timer = realTimeout(() => { report(`a video in the scene would not seek to ${target.toFixed(2)}s`); resolve(); }, 1500);
        video.addEventListener("seeked", () => { clearTimeout(timer); resolve(); }, { once: true });
        video.currentTime = target;
      }));
    }
    return Promise.all(waits);
  }

  function setHead(head) {
    if (!head) return;
    setVar("--head-x", `${head.x}px`);
    setVar("--head-y", `${head.y}px`);
    setVar("--head-w", `${head.w}px`);
    setVar("--head-h", `${head.h}px`);
    setVar("--head-visible", head.visible ? 1 : 0);
  }

  async function seek(message) {
    const t = Math.max(0, Number(message.t) || 0);
    const p = Math.min(Math.max(Number(message.p) || 0, 0), 1);
    clock = t;
    noise = mulberry((baseSeed ^ Math.imul((message.n ?? 0) + 1, 2654435761)) >>> 0);
    setVar("--t", t.toFixed(4));
    setVar("--p", p.toFixed(5));
    setHead(message.head);
    const ctx = frameContext(t, p, message);
    const queued = rafQueue;
    rafQueue = [];
    for (const callback of queued) {
      try { callback(t * 1000); } catch (error) { report(error.message); }
    }
    try {
      scene?.render?.(t, ctx);
    } catch (error) {
      report(`render at ${t.toFixed(2)}s: ${error.message}`);
    }
    // Every animation to the scene's instant, including any render() made.
    for (const animation of document.getAnimations()) {
      try { animation.pause(); animation.currentTime = t * 1000; } catch (error) { report(error.message); }
    }
    if (window.gsap) {
      try { window.gsap.globalTimeline.seek(t, false); } catch (error) { report(error.message); }
    }
    for (const tl of timelines) {
      try { tl.seek(t, false); } catch (error) { report(error.message); }
    }
    await seekMedia(t);
    await nextPaint();
    post({ fabula: "drawn", token: message.token, n: message.n, errors: drain() });
  }

  // One message at a time, in order: a seek that arrives while the scene is
  // loading waits for it, and each frame is drawn before the next begins.
  let queue = Promise.resolve();
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.fabula === "load") {
      if (loaded) return; // one scene per frame; the painter makes a new frame for a new scene
      loaded = queue = queue.then(() => load(message)).catch((error) => { report(error.message); post({ fabula: "ready", token, errors: drain() }); });
    } else if (message.fabula === "seek") {
      queue = queue.then(() => seek(message)).catch((error) => { report(error.message); post({ fabula: "drawn", token: message.token, n: message.n, errors: drain() }); });
    }
  });
  post({ fabula: "hello" });
})();
