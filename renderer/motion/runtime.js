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
    // A reel's shots: one document, many moments, one world. Each shot
    // starts at a second (at) or on a spoken word (word, with an optional
    // fallback second at); the current one comes back with its own clock,
    // so a shot is written as render code over s.t / s.p while the world
    // it draws in — the camera, the shapes that carry over — stays shared.
    //   const s = fabula.shot(t, [{ name: "fall", at: 0 }, { name: "throw", word: "harder", at: 4 }]);
    //   s.name, s.index, s.t (seconds into it), s.p (0→1 across it), s.start, s.end, s.next
    shot(t, shots) {
      const list = (shots ?? []).map((shot, index) => {
        const spoken = shot.word ? fabula.word(shot.word, { after: shot.after ?? 0 })?.t0 : undefined;
        return { ...shot, index, start: spoken ?? shot.at ?? 0 };
      }).sort((a, b) => a.start - b.start);
      if (!list.length) return null;
      let i = 0;
      while (i + 1 < list.length && t >= list[i + 1].start) i += 1;
      const current = list[i];
      const end = list[i + 1]?.start ?? context.span;
      const length = Math.max(end - current.start, 1e-6);
      return { ...current, t: t - current.start, p: clamp((t - current.start) / length), end, next: list[i + 1]?.name ?? null };
    },
    // A camera keyed in time: [{ t, x, y, zoom }], eased between keys, the
    // zoom interpolated in log space so a pull-back from 8× to 1× moves at
    // one perceived speed instead of rushing the first half. cameraCss
    // turns it into a transform for a world element the size of the frame.
    camera(t, keys, easeName = "inOut") {
      const list = [...(keys ?? [])].sort((a, b) => a.t - b.t);
      if (!list.length) return { x: 0, y: 0, zoom: 1 };
      if (t <= list[0].t) return { x: list[0].x ?? 0, y: list[0].y ?? 0, zoom: list[0].zoom ?? 1 };
      for (let i = 1; i < list.length; i += 1) {
        if (t > list[i].t) continue;
        const a = list[i - 1];
        const b = list[i];
        const k = (ease[b.ease ?? easeName] ?? ease.inOut)((t - a.t) / Math.max(b.t - a.t, 1e-6));
        const zoom = Math.exp(lerp(Math.log(a.zoom ?? 1), Math.log(b.zoom ?? 1), k));
        return { x: lerp(a.x ?? 0, b.x ?? 0, k), y: lerp(a.y ?? 0, b.y ?? 0, k), zoom };
      }
      const last = list.at(-1);
      return { x: last.x ?? 0, y: last.y ?? 0, zoom: last.zoom ?? 1 };
    },
    cameraCss({ x = 0, y = 0, zoom = 1 } = {}) {
      return `translate(${context.width / 2}px, ${context.height / 2}px) scale(${zoom}) translate(${-x}px, ${-y}px)`;
    },
    // The largest font size at which an element's text fits its own box
    // (its width, and its height when it has one), between min and max
    // pixels; sets it and returns it. Call it in setup, after the fonts.
    fit(element, { min = 12, max = 400 } = {}) {
      if (!element) return 0;
      const fits = () => element.scrollWidth <= element.clientWidth + 1 && (element.clientHeight === 0 || element.scrollHeight <= element.clientHeight + 1);
      let lo = min;
      let hi = max;
      for (let i = 0; i < 18 && hi - lo > 0.5; i += 1) {
        const mid = (lo + hi) / 2;
        element.style.fontSize = `${mid}px`;
        if (fits()) lo = mid; else hi = mid;
      }
      element.style.fontSize = `${lo}px`;
      return lo;
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

  // What a document needs loaded, read from its scripts: THREE means three,
  // gsap means GSAP, and "// fabula-libs: project:shapes" names the
  // project's own. The same reading as core/motion.mjs motionLibsOf.
  function libsOf(doc) {
    const scripts = [...String(doc).matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map((m) => m[1]).join("\n");
    const out = [];
    if (/\bTHREE\s*\./.test(scripts)) out.push("three");
    if (/\bgsap\s*\./.test(scripts)) out.push("gsap");
    for (const m of scripts.matchAll(/\/\/\s*fabula-libs:\s*([^\n]+)/g)) {
      for (const name of m[1].split(/[\s,]+/)) if (/^(project:)?[a-z0-9][a-z0-9-]*$/.test(name)) out.push(name);
    }
    return out;
  }

  // ---- The check pass ----
  // After a frame is drawn, the scene's own text is measured where it
  // actually landed: the faults that pass every code check and only show in
  // pixels — type off the frame or outside the safe area, two lines of text
  // on top of each other, type too small to read. Text drawn on a canvas or
  // in WebGL is pixels, not text, and is not measured.
  let checking = false;
  const TEXT_SKIP = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"]);
  function visibleOpacity(element) {
    let alpha = 1;
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return 0;
      alpha *= Number(style.opacity);
      if (alpha < 0.05) return alpha;
    }
    return alpha;
  }
  // What an inset() clip-path leaves visible of an element and its
  // ancestors, in the frame's pixels: a line wiped in by a clip is not on
  // screen until the wipe reaches it. Other clip shapes are not measured.
  function clipRect(element) {
    let box = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const clip = getComputedStyle(node).clipPath;
      const m = /^inset\(([^)]*)\)/.exec(clip ?? "");
      if (!m) continue;
      const r = node.getBoundingClientRect();
      const parts = m[1].split(/\s+round\s+/)[0].trim().split(/\s+/);
      const [a, b = a, c = a, d = b] = parts;
      const len = (value, size) => (String(value).endsWith("%") ? (parseFloat(value) / 100) * size : parseFloat(value) || 0);
      box = {
        left: Math.max(box.left, r.left + len(d, r.width)),
        top: Math.max(box.top, r.top + len(a, r.height)),
        right: Math.min(box.right, r.right - len(b, r.width)),
        bottom: Math.min(box.bottom, r.bottom - len(c, r.height)),
      };
    }
    return box;
  }
  function blockOf(element) {
    for (let node = element; node && node !== document.body; node = node.parentElement) {
      if (node instanceof SVGElement) { if (node.tagName.toLowerCase() === "text") return node; continue; }
      const display = getComputedStyle(node).display;
      if (!display.startsWith("inline") && display !== "contents") return node;
    }
    return element;
  }
  function checkFrame() {
    const W = innerWidth;
    const H = innerHeight;
    const tall = H > W;
    const safe = { left: W * 0.05, right: W * 0.95, top: H * 0.05, bottom: H * (tall ? 0.78 : 0.95) };
    const blocks = new Map();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const leaf = text.parentElement;
      if (!leaf || TEXT_SKIP.has(leaf.tagName) || !text.textContent.trim()) continue;
      if (visibleOpacity(leaf) < 0.15) continue;
      const range = document.createRange();
      range.selectNodeContents(text);
      const whole = range.getBoundingClientRect();
      const clip = clipRect(leaf);
      const rect = { left: Math.max(whole.left, clip.left), top: Math.max(whole.top, clip.top), right: Math.min(whole.right, clip.right), bottom: Math.min(whole.bottom, clip.bottom) };
      rect.width = rect.right - rect.left; rect.height = rect.bottom - rect.top;
      if (rect.width < 1 || rect.height < 1) continue;
      const block = blockOf(leaf);
      const size = parseFloat(getComputedStyle(leaf).fontSize) || 0;
      const box = blocks.get(block) ?? { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity, size: Infinity, text: "" };
      box.left = Math.min(box.left, rect.left); box.top = Math.min(box.top, rect.top);
      box.right = Math.max(box.right, rect.right); box.bottom = Math.max(box.bottom, rect.bottom);
      // An SVG's font size is in its own units; what reads is its height on screen.
      box.size = Math.min(box.size, leaf instanceof SVGElement ? whole.height : size);
      box.text += text.textContent;
      blocks.set(block, box);
    }
    const found = [];
    const name = (box) => `"${box.text.replace(/\s+/g, " ").trim().slice(0, 40)}"`;
    const list = [...blocks.entries()];
    for (const [, box] of list) {
      const offFrame = box.left < -1 || box.top < -1 || box.right > W + 1 || box.bottom > H + 1;
      if (offFrame) found.push({ kind: "off-frame", what: `${name(box)} runs off the frame` });
      else {
        const sides = [box.left < safe.left && "left", box.right > safe.right && "right", box.top < safe.top && "top", box.bottom > safe.bottom && (tall ? "bottom (below 78% the captions and the platform's controls cover it)" : "bottom")].filter(Boolean);
        if (sides.length) found.push({ kind: "unsafe", what: `${name(box)} is outside the safe area (${sides.join(", ")})` });
      }
      if (box.size < H * 0.022) found.push({ kind: "small", what: `${name(box)} is set at ${Math.round(box.size)} px, under 2.2% of the frame's height — too small to read on a phone` });
    }
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const [ea, a] = list[i];
        const [eb, b] = list[j];
        if (ea.contains(eb) || eb.contains(ea)) continue;
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w <= 0 || h <= 0) continue;
        const smaller = Math.min((a.right - a.left) * (a.bottom - a.top), (b.right - b.left) * (b.bottom - b.top));
        if (w * h > smaller * 0.15) found.push({ kind: "overlap", what: `${name(a)} and ${name(b)} overlap` });
      }
    }
    return found.slice(0, 40);
  }

  let token = null;
  let loaded = null;

  async function load(message) {
    token = message.token;
    checking = message.check === true;
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
    let doc = "";
    try {
      const response = await fetch(`fabula-motion://project/${message.src}?v=${encodeURIComponent(message.stamp ?? "")}`);
      if (!response.ok) throw new Error(`${message.src} is not in the project (write_motion writes it)`);
      doc = await response.text();
    } catch (error) {
      report(error.message);
    }
    // Libraries first: those the placement names and those the document
    // needs (core/motion.mjs motionLibsOf reads them the same way), Fabula's
    // before the project's own, which may lean on them. A project library
    // may bring a stylesheet beside it.
    const wanted = [...new Set([...(message.libs ?? []), ...libsOf(doc)])].sort((a, b) => a.startsWith("project:") - b.startsWith("project:"));
    for (const lib of wanted) {
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
    // A face used only on a canvas is not asked for until the first draw —
    // after ready — so the first frame drew in a fallback and the rest in the
    // real face, and the film and the window disagreed on it. Every face the
    // document names, and the film's own, are loaded before ready — and
    // before setup, so a layout measured there (fabula.fit) is measured in
    // the face it will be drawn in.
    const named = `${doc}\n${JSON.stringify(context.theme?.fonts ?? {})}`;
    const faces = [...document.fonts].filter((face) => named.includes(face.family.replace(/^["']|["']$/g, "")));
    await Promise.allSettled(faces.map((face) => face.load().catch(() => report(`the font ${face.family} did not load`))));
    try {
      scene?.setup?.(frameContext(0, 0, { head: message.head ?? null }));
    } catch (error) {
      report(`setup: ${error.message}`);
    }
    const pictures = [...document.images].map((img) => img.decode().catch(() => report(`could not load ${img.getAttribute("src")}`)));
    await Promise.allSettled([...pending, ...pictures]);
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
    let check;
    if (checking) { try { check = checkFrame(); } catch (error) { report(`check: ${error.message}`); } }
    post({ fabula: "drawn", token: message.token, n: message.n, t, errors: drain(), ...(check ? { check } : {}) });
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
