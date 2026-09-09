// Named, parameterised graphics the kit has no fixed shape for.
//
// A `custom` graphic is the assistant's own html and css for one moment. That
// is the right escape hatch and the wrong everyday tool: writing a timeline or
// a before/after from scratch costs a thousand tokens and a round trip to
// look at it, and the third one written in a session is never as good as the
// first. A template is that work done once, well, with the moving parts
// exposed as fields. The assistant names the template and fills the fields;
// what is written into compose.json is an ordinary custom graphic — html, css
// and `full` — so the painter, the export and the window need nothing new,
// and the template id and params travel beside it so the source stays legible.
//
// Every template is a pure function of its params and the delivery shape, and
// animates only from the variables the painter sets: --q (0→1 over the first
// 1.8 s), --p (0→1 over the span) and --alpha. No counters, no CSS animations,
// nothing that would draw differently in the preview and the export.
//
// Text is escaped, lengths are capped by the field, and the result still goes
// through the same forbidden-content check as a hand-written custom graphic.

const esc = (value) => String(value ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// A 0→1 window on the entrance variable: item i wakes at `from + i * each`
// and arrives over `dur`. Written as CSS so the painter sets one number and
// the browser does the rest, exactly the same in the window and the export.
// The painter clamps --q at 1, so a window has to close by then: an item
// scheduled later than that is pulled back to land on the last beat rather
// than never arriving.
const wake = (i, { from = 0.05, each = 0.12, dur = 0.35 } = {}) => {
  const start = Math.max(0, Math.min(from + i * each, 1 - dur));
  return `clamp(0, calc((var(--q) - ${start.toFixed(2)}) / ${dur.toFixed(2)}), 1)`;
};

// The same window on the SPAN variable: item i of n arrives at an even share
// of the card's whole time, so a diagram develops as the explanation does
// instead of landing complete in the first two seconds and then sitting
// still. `--p` runs 0→1 over the scene; the last item lands by 80% of it.
const spread = (i, n, { from = 0.04, until = 0.8, dur = 0.12 } = {}) =>
  `clamp(0, calc((var(--p) - ${(from + (n > 1 ? (i * (until - from)) / (n - 1) : 0)).toFixed(3)}) / ${dur.toFixed(2)}), 1)`;

// Item i's arrival under the template's pace: on the entrance (default) or
// spread over the span.
const arrive = (p, i, n, entrance) => (p.pace === "span" ? spread(i, n) : wake(i, entrance));

// Where the arrival times of a span-paced card fall, as shares of its span.
// The pacing read counts each as a change in the picture, which it is.
export function revealShares(n, { from = 0.04, until = 0.8 } = {}) {
  return Array.from({ length: n }, (_, i) => Number((from + (n > 1 ? (i * (until - from)) / (n - 1) : 0)).toFixed(3)));
}


// Type sizes that hold in either shape: cqi is the inline (width) container
// unit, cqh the height. A vertical stage is narrow, so width leads.
const FONT_DISPLAY = `var(--ov-font-display, "Inter", system-ui, sans-serif)`;
const FONT_BODY = `var(--ov-font-body, "Inter", system-ui, sans-serif)`;
const FONT_SERIF = `var(--ov-font-serif, "Source Serif 4", Georgia, serif)`;
const FONT_MONO = `"JetBrains Mono", ui-monospace, monospace`;
const ACCENT = `var(--ov-accent, #d97757)`;
const ACCENT2 = `var(--ov-accent2, #f28a32)`;
const TEXT = `var(--ov-text, #f0ede6)`;
const MUTED = `var(--ov-muted, #9aa3ad)`;
const INK = `var(--ov-ink, #0b0e12)`;
const CARD = `var(--ov-card, rgba(11, 14, 18, 0.88))`;

// The stage's own padding. A tall frame keeps its bottom clear for captions
// and platform chrome; a wide one only needs margins.
const frame = (portrait, strip = false) => strip
  ? `padding: 5cqh 5cqw;`
  : portrait
    ? `padding: 10cqh 7cqw 21cqh 7cqw;`
    : `padding: 9cqh 7cqw 12cqh 7cqw;`;

// A field description does two jobs: it validates the params, and it is what
// describe_templates prints so the assistant knows what to send.
const field = (type, about, extra = {}) => ({ type, about, ...extra });
const text = (about, max = 80, extra = {}) => field("text", about, { max, ...extra });
const items = (about, { min = 1, max = 5, value = false, required = true, keepSpace = false } = {}) => field("items", about, { min, max, value, required, keepSpace });
const PACE = field("choice", "entrance: everything arrives in the first two seconds; span: the items arrive one by one across the card's whole time, so the picture keeps developing while the speaker talks — for a card that holds longer than five seconds", { options: ["entrance", "span"], default: "entrance", required: false });

function checkText(value, spec, name, id) {
  if (value === undefined || value === null || value === "") {
    if (spec.required !== false) throw new Error(`template ${id}: ${name} is required`);
    return "";
  }
  // A line of code keeps its indentation; everything else is one line of prose.
  const s = spec.keepSpace ? String(value).replace(/[\r\n]+/g, " ").replace(/\s+$/, "") : String(value).replace(/\s+/g, " ").trim();
  if (s.length > spec.max) throw new Error(`template ${id}: ${name} is at most ${spec.max} characters`);
  if (/:\/\//.test(s)) throw new Error(`template ${id}: ${name} cannot hold a link; write the name of the site instead`);
  return s;
}

function checkNumber(value, spec, name, id) {
  if (value === undefined || value === null) {
    if (spec.required !== false) throw new Error(`template ${id}: ${name} is required`);
    return spec.default ?? 0;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`template ${id}: ${name} must be a number`);
  if (spec.min !== undefined && value < spec.min) throw new Error(`template ${id}: ${name} is at least ${spec.min}`);
  if (spec.max !== undefined && value > spec.max) throw new Error(`template ${id}: ${name} is at most ${spec.max}`);
  return value;
}

function checkItems(value, spec, name, id) {
  if (!Array.isArray(value) || value.length === 0) {
    if (spec.required !== false) throw new Error(`template ${id}: ${name} needs ${spec.min}–${spec.max} items`);
    return [];
  }
  if (value.length < spec.min || value.length > spec.max) throw new Error(`template ${id}: ${name} takes ${spec.min}–${spec.max} items, got ${value.length}`);
  return value.map((item, i) => {
    if (!item || typeof item !== "object") throw new Error(`template ${id}: ${name}[${i}] must be an object`);
    const label = checkText(item.label, { max: 60, required: true, keepSpace: spec.keepSpace }, `${name}[${i}].label`, id);
    const out = { label };
    if (spec.value) {
      if (spec.value === "number") out.value = checkNumber(item.value, { required: true }, `${name}[${i}].value`, id);
      else out.value = checkText(item.value, { max: 24, required: spec.value === "required" }, `${name}[${i}].value`, id);
    }
    return out;
  });
}

function checkChoice(value, spec, name, id) {
  if (value === undefined || value === null || value === "") return spec.default;
  if (!spec.options.includes(value)) throw new Error(`template ${id}: ${name} must be one of ${spec.options.join(", ")}`);
  return value;
}

function checkParams(template, params, id) {
  const out = {};
  for (const [name, spec] of Object.entries(template.fields)) {
    const value = params?.[name];
    if (spec.type === "text") out[name] = checkText(value, spec, name, id);
    else if (spec.type === "number") out[name] = checkNumber(value, spec, name, id);
    else if (spec.type === "items") out[name] = checkItems(value, spec, name, id);
    else if (spec.type === "choice") out[name] = checkChoice(value, spec, name, id);
  }
  return out;
}

// Shared css: the root fills its container and reads the theme's tokens.
// `strip`: a column card in a tall film, which sits in a wide, short strip
// under the head (about 950×430 at 1080×1920). Its height is a quarter of
// its width, so sizes keyed on cqh land tiny; a strip sizes on cqi.
const base = (portrait, strip = false) => `
.t { position: absolute; inset: 0; box-sizing: border-box; ${frame(portrait, strip)} display: flex; flex-direction: column; justify-content: center; color: ${TEXT}; font-family: ${FONT_BODY}; }
.t * { box-sizing: border-box; }
.t-kicker { font-family: ${FONT_DISPLAY}; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; font-size: ${strip ? "2.6cqi" : "min(3.2cqh, 3.6cqi)"}; color: ${ACCENT}; }
.t-muted { color: ${MUTED}; }
`;

// ---- The templates ----

export const TEMPLATES = {
  hook: {
    label: "Hook line",
    about: "One big line that promises the viewer something, landing word by word, with a small kicker above it. The first second of a short, or the cold open of a film.",
    when: "The opening. The line says what the next thirty seconds are for; the kicker names the subject.",
    persona: ["farmer", "editor"],
    full: true,
    fields: { kicker: text("A few words above the line", 32, { required: false }), line: text("The hook itself — up to twelve words", 90), sub: text("A quieter second line", 80, { required: false }) },
    example: { kicker: "Rendering", line: "The first render took sixteen minutes. The second took six.", sub: "One line moved." },
    render: (p, { portrait }) => {
      const words = p.line.split(" ");
      const html = `<div class="t t-hook">${p.kicker ? `<div class="t-kicker">${esc(p.kicker)}</div>` : ""}<div class="t-line">${words.map((w, i) => `<span class="t-w" style="--k:${wake(i, { from: 0.08, each: Math.min(0.09, 0.7 / words.length), dur: 0.3 })}">${esc(w)}</span>`).join(" ")}</div>${p.sub ? `<div class="t-sub">${esc(p.sub)}</div>` : ""}</div>`;
      const css = `${base(portrait)}
.t-hook { gap: 2.4cqh; }
.t-line { font-family: ${FONT_DISPLAY}; font-weight: 800; font-size: min(${portrait ? "8.4cqh, 11cqi" : "11cqh, 8cqi"}); line-height: 1.02; letter-spacing: -0.02em; text-wrap: balance; }
.t-w { display: inline-block; opacity: var(--k); transform: translateY(calc((1 - var(--k)) * 0.5em)); }
.t-sub { font-family: ${FONT_SERIF}; font-style: italic; font-size: min(3.4cqh, 4.6cqi); color: ${MUTED}; opacity: ${wake(0, { from: 0.7, dur: 0.3 })}; }`;
      return { html, css };
    },
  },

  word: {
    label: "The big word",
    about: "One to three words, enormous, each arriving on its own beat, an accent rule sweeping under the last. Emphasis without a card.",
    when: "A word the speaker leans on. Pair with a cutaway or a full layout; over the head it covers the face.",
    persona: ["editor", "farmer"],
    full: true,
    fields: { words: text("One to three words", 30), note: text("A small line beneath", 60, { required: false }) },
    example: { words: "Never. Again.", note: "the rule after the sixteen-minute render" },
    render: (p, { portrait }) => {
      const parts = p.words.split(" ").slice(0, 3);
      const html = `<div class="t t-word"><div class="t-stack">${parts.map((w, i) => `<div class="t-big" style="--k:${wake(i, { from: 0.05, each: 0.22, dur: 0.3 })}">${esc(w)}</div>`).join("")}<div class="t-rule"></div></div>${p.note ? `<div class="t-note">${esc(p.note)}</div>` : ""}</div>`;
      const css = `${base(portrait)}
.t-word { align-items: flex-start; gap: 3cqh; }
.t-big { font-family: ${FONT_DISPLAY}; font-weight: 900; font-size: min(${portrait ? "11cqh, 19cqi" : "22cqh, 15cqi"}); line-height: 0.95; letter-spacing: -0.03em; opacity: var(--k); transform: translateX(calc((1 - var(--k)) * -0.15em)); }
.t-rule { height: min(1.2cqh, 1.6cqi); width: min(30cqw, 40cqi); margin-top: 2cqh; background: ${ACCENT}; transform-origin: left center; transform: scaleX(${wake(parts.length, { from: 0.05, each: 0.22, dur: 0.4 })}); }
.t-note { font-family: ${FONT_SERIF}; font-style: italic; font-size: min(3cqh, 4.2cqi); color: ${MUTED}; opacity: ${wake(0, { from: 0.85, dur: 0.3 })}; }`;
      return { html, css };
    },
  },

  "big-number": {
    label: "Big number",
    about: "A figure as typed — “$4.2M”, “73%”, “16 min” — with the thing it counts and one line of context. The number rises into place; nothing counts up, so what is shown is what was said.",
    when: "A number the argument turns on. Use stat when a plain count-up will do; this one carries the sentence around it.",
    persona: ["editor", "farmer"],
    full: false,
    fields: { value: text("The figure, as it should read", 14), label: text("What it counts", 40), context: text("The line that makes it matter", 90, { required: false }), kicker: text("A few words above", 32, { required: false }) },
    example: { kicker: "Watch time", value: "80%", label: "watched with the sound off", context: "A short without captions is a short most people never hear." },
    render: (p, { portrait, strip }) => {
      const html = `<div class="t t-num">${p.kicker ? `<div class="t-kicker">${esc(p.kicker)}</div>` : ""}<div class="t-value">${esc(p.value)}</div><div class="t-label">${esc(p.label)}</div>${p.context ? `<div class="t-ctx">${esc(p.context)}</div>` : ""}</div>`;
      const css = `${base(portrait, strip)}
.t-num { gap: 1.6cqh; }
.t-value { font-family: ${FONT_DISPLAY}; font-weight: 900; font-size: ${strip ? "12.5cqi" : `min(${portrait ? "20.8cqh, 26cqi" : "26cqh, 22cqi"})`}; line-height: 0.95; letter-spacing: -0.04em; font-variant-numeric: tabular-nums; color: ${ACCENT}; clip-path: inset(calc((1 - ${wake(0, { from: 0.05, dur: 0.45 })}) * 100%) 0 0 0); transform: translateY(calc((1 - ${wake(0, { from: 0.05, dur: 0.45 })}) * 0.2em)); }
.t-label { font-family: ${FONT_DISPLAY}; font-weight: 700; font-size: ${strip ? "4.6cqi" : `min(${portrait ? "9.0" : "5.6"}cqh, 5.8cqi)`}; opacity: ${wake(0, { from: 0.4, dur: 0.3 })}; }
.t-ctx { font-family: ${FONT_SERIF}; font-size: ${strip ? "3.9cqi" : `min(${portrait ? "7.0" : "4.4"}cqh, 4.4cqi)`}; color: ${MUTED}; max-width: ${strip ? "60ch" : "34ch"}; text-wrap: pretty; opacity: ${wake(0, { from: 0.65, dur: 0.3 })}; }`;
      return { html, css };
    },
  },

  trio: {
    label: "Three numbers",
    about: "Two to four figures side by side (stacked in a tall frame), each with its label, arriving left to right. The shape of “here is the whole picture in three numbers”.",
    when: "A set of figures that belong together: before/during/after, three products, three years.",
    persona: ["editor"],
    full: true,
    fields: { title: text("A heading", 48, { required: false }), items: items("Figures with labels: value is the figure as typed", { min: 2, max: 4, value: "required" }), pace: PACE },
    example: { title: "One render, three passes", items: [{ value: "16 min", label: "first render" }, { value: "6 min", label: "after the fix" }, { value: "10 min", label: "saved, every export" }] },
    render: (p, { portrait }) => {
      const html = `<div class="t t-trio">${p.title ? `<div class="t-kicker">${esc(p.title)}</div>` : ""}<div class="t-row">${p.items.map((it, i) => `<div class="t-cell" style="--k:${arrive(p, i, p.items.length, { from: 0.1, each: 0.18, dur: 0.35 })}"><div class="t-v">${esc(it.value)}</div><div class="t-l">${esc(it.label)}</div></div>`).join("")}</div></div>`;
      const css = `${base(portrait)}
.t-trio { gap: 4cqh; }
.t-row { display: flex; flex-direction: ${portrait ? "column" : "row"}; gap: ${portrait ? "3cqh" : "3cqw"}; }
.t-cell { flex: 1; padding: ${portrait ? "2.4cqh 5cqw" : "3cqh 2.4cqw"}; border-left: min(0.6cqw, 0.9cqi) solid ${ACCENT}; background: ${CARD}; opacity: var(--k); transform: translateY(calc((1 - var(--k)) * 2cqh)); }
.t-v { font-family: ${FONT_DISPLAY}; font-weight: 900; font-size: min(${portrait ? "7cqh, 13cqi" : "12cqh, 8cqi"}); line-height: 1; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
.t-l { margin-top: 1.2cqh; font-size: min(2.8cqh, 4cqi); color: ${MUTED}; }`;
      return { html, css };
    },
  },

  timeline: {
    label: "Timeline",
    about: "Three to six moments along a line, each a date or a mark and a label, lit in order as the line draws past them. In a tall frame the line runs down the page.",
    when: "A sequence in time: what happened, then what, then what. History, a project, a career, a day.",
    persona: ["editor"],
    full: true,
    fields: { title: text("A heading", 48, { required: false }), items: items("Moments: value is the date or mark, label what happened", { min: 3, max: 6, value: "required" }), pace: PACE },
    example: { title: "How it went", items: [{ value: "Mon", label: "recorded the talk" }, { value: "Tue", label: "the sixteen-minute render" }, { value: "Wed", label: "found the filter graph" }, { value: "Thu", label: "six minutes" }] },
    render: (p, { portrait }) => {
      const n = p.items.length;
      const html = `<div class="t t-tl">${p.title ? `<div class="t-kicker">${esc(p.title)}</div>` : ""}<div class="t-track"><div class="t-line"></div>${p.items.map((it, i) => `<div class="t-ev" style="--k:${arrive(p, i, n, { from: 0.1, each: 0.7 / n, dur: 0.3 })}"><div class="t-dot"></div><div class="t-when">${esc(it.value)}</div><div class="t-what">${esc(it.label)}</div></div>`).join("")}</div></div>`;
      const css = `${base(portrait)}
.t-tl { gap: 4cqh; }
.t-track { position: relative; display: flex; flex-direction: ${portrait ? "column" : "row"}; gap: ${portrait ? "3cqh" : "2cqw"}; ${portrait ? "padding-left: 6cqw;" : "padding-top: 5cqh;"} }
.t-line { position: absolute; ${portrait ? "left: 6cqw; top: 0; bottom: 0; width: min(0.5cqw, 0.7cqi); transform-origin: top;" : "top: 5cqh; left: 0; right: 0; height: min(0.6cqh, 0.8cqi); transform-origin: left;"} background: ${ACCENT}; transform: scale${portrait ? "Y" : "X"}(${p.pace === "span" ? "clamp(0, calc(var(--p) / 0.8), 1)" : wake(0, { from: 0.05, dur: 0.75 })}); }
.t-ev { position: relative; flex: 1; ${portrait ? "padding-left: 5cqw;" : "padding-top: 6.5cqh; padding-right: 1cqw;"} opacity: var(--k); transform: translate${portrait ? "X" : "Y"}(calc((1 - var(--k)) * 1.5cqi)); }
.t-dot { position: absolute; ${portrait ? "left: calc(-1 * min(1.1cqw, 1.5cqi)); top: 0.6cqh;" : "left: 0; top: calc(-1 * min(1.3cqw, 1.7cqi) + min(0.3cqh, 0.4cqi));"} width: min(2.6cqw, 3.4cqi); height: min(2.6cqw, 3.4cqi); border-radius: 50%; background: ${ACCENT}; box-shadow: 0 0 0 min(0.8cqw, 1cqi) ${INK}; }
.t-when { font-family: ${FONT_DISPLAY}; font-weight: 800; font-size: min(${portrait ? "3.4cqh" : "4.6cqh"}, 4.8cqi); color: ${ACCENT}; }
.t-what { margin-top: 0.6cqh; font-size: min(${portrait ? "2.8cqh" : "3.8cqh"}, 3.9cqi); text-wrap: pretty; }`;
      return { html, css };
    },
  },

  flow: {
    label: "Flow",
    about: "Two to five steps joined by arrows: this leads to this leads to this. Across the frame in landscape, down it in vertical. Each step lands after the arrow reaches it.",
    when: "A mechanism or a pipeline: input to output, cause to effect. Use steps when the order is a list to follow rather than a thing that happens.",
    persona: ["editor"],
    full: true,
    fields: { title: text("A heading", 48, { required: false }), items: items("The steps, in order", { min: 2, max: 5 }), pace: PACE },
    example: { title: "The clean cut", items: [{ label: "transcribe" }, { label: "propose cuts" }, { label: "review" }, { label: "render once" }] },
    render: (p, { portrait }) => {
      const html = `<div class="t t-flow">${p.title ? `<div class="t-kicker">${esc(p.title)}</div>` : ""}<div class="t-chain">${p.items.map((it, i) => `${i ? `<div class="t-arrow" style="--k:${arrive(p, i, p.items.length, { from: 0.0, each: 0.18, dur: 0.25 })}"></div>` : ""}<div class="t-step" style="--k:${arrive(p, i, p.items.length, { from: 0.08, each: 0.18, dur: 0.3 })}">${esc(it.label)}</div>`).join("")}</div></div>`;
      const css = `${base(portrait)}
.t-flow { gap: 4cqh; }
.t-chain { display: flex; flex-direction: ${portrait ? "column" : "row"}; align-items: center; gap: ${portrait ? "1.6cqh" : "1.2cqw"}; }
.t-step { flex: 1; width: ${portrait ? "100%" : "auto"}; padding: ${portrait ? "2.6cqh 5cqw" : "3.4cqh 2cqw"}; text-align: center; font-family: ${FONT_DISPLAY}; font-weight: 700; font-size: min(${portrait ? "3.6cqh" : "5.2cqh"}, 5cqi); background: ${CARD}; border: 1px solid color-mix(in srgb, ${ACCENT} 45%, transparent); border-radius: calc(1.2cqi * var(--ov-radius, 1)); opacity: var(--k); transform: scale(calc(0.9 + var(--k) * 0.1)); }
.t-arrow { flex: none; width: ${portrait ? "0" : "min(3cqw, 4cqi)"}; height: ${portrait ? "min(3cqh, 4cqi)" : "0"}; border-${portrait ? "left" : "top"}: min(0.5cqw, 0.7cqi) solid ${ACCENT}; position: relative; opacity: var(--k); }
.t-arrow::after { content: ""; position: absolute; ${portrait ? "left: calc(-1 * min(1cqw, 1.4cqi) - min(0.25cqw, 0.35cqi)); bottom: -1px; border-left: min(1cqw, 1.4cqi) solid transparent; border-right: min(1cqw, 1.4cqi) solid transparent; border-top: min(1.6cqh, 2cqi) solid " + ACCENT : "right: -1px; top: calc(-1 * min(1cqh, 1.4cqi) - min(0.3cqh, 0.4cqi)); border-top: min(1cqh, 1.4cqi) solid transparent; border-bottom: min(1cqh, 1.4cqi) solid transparent; border-left: min(1.6cqw, 2cqi) solid " + ACCENT}; }`;
      return { html, css };
    },
  },

  "before-after": {
    label: "Before and after",
    about: "Two panels with a divider that sweeps across, revealing the second: what it was, what it became. Side by side in landscape, top and bottom in vertical.",
    when: "A change with a clear before and after. Use compare for two lists; this is for two states.",
    persona: ["editor", "farmer"],
    full: true,
    fields: { before: text("The old state", 60), after: text("The new state", 60), beforeLabel: text("Label for the first panel", 16, { required: false }), afterLabel: text("Label for the second", 16, { required: false }), pace: PACE },
    example: { beforeLabel: "Before", before: "16 minutes a render", afterLabel: "After", after: "6 minutes a render" },
    render: (p, { portrait }) => {
      const html = `<div class="t t-ba"><div class="t-pane t-before"><div class="t-tag">${esc(p.beforeLabel || "Before")}</div><div class="t-body">${esc(p.before)}</div></div><div class="t-pane t-after"><div class="t-tag">${esc(p.afterLabel || "After")}</div><div class="t-body">${esc(p.after)}</div></div><div class="t-divider"></div></div>`;
      // Span-paced, the sweep waits for the speaker: the after state arrives
      // around the middle of the card's time rather than in its first second.
      const sweep = p.pace === "span" ? "clamp(0, calc((var(--p) - 0.4) / 0.25), 1)" : wake(0, { from: 0.3, dur: 0.55 });
      const css = `${base(portrait)}
.t-ba { padding: 0; flex-direction: ${portrait ? "column" : "row"}; position: absolute; inset: 0; }
.t-pane { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 2cqh; ${frame(portrait)} }
.t-before { background: color-mix(in srgb, ${INK} 70%, transparent); }
.t-after { background: color-mix(in srgb, ${ACCENT} 18%, ${INK}); clip-path: inset(${portrait ? `calc((1 - ${sweep}) * 100%) 0 0 0` : `0 0 0 calc((1 - ${sweep}) * 100%)`}); }
.t-divider { position: absolute; ${portrait ? `left: 0; right: 0; height: min(0.6cqh, 0.8cqi); top: calc(50% + (1 - ${sweep}) * 50%);` : `top: 0; bottom: 0; width: min(0.5cqw, 0.7cqi); left: calc(50% + (1 - ${sweep}) * 50%);`} background: ${ACCENT}; }
.t-tag { font-family: ${FONT_DISPLAY}; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; font-size: min(2.2cqh, 3.2cqi); color: ${MUTED}; }
.t-after .t-tag { color: ${ACCENT}; }
.t-body { font-family: ${FONT_DISPLAY}; font-weight: 800; font-size: min(${portrait ? "6cqh, 9cqi" : "8cqh, 6cqi"}); line-height: 1.05; letter-spacing: -0.02em; text-wrap: balance; }
.t-before .t-body { opacity: ${wake(0, { from: 0.05, dur: 0.3 })}; }`;
      return { html, css };
    },
  },

  "myth-fact": {
    label: "Myth and fact",
    about: "The thing people believe, struck through as it is said, and the truth landing under it. The oldest correction there is.",
    when: "The speaker says “most people think…” or “that is not true”.",
    persona: ["farmer", "editor"],
    full: true,
    fields: { myth: text("What people believe", 80), fact: text("What is true", 90), mythLabel: text("Label", 12, { required: false }), factLabel: text("Label", 12, { required: false }) },
    example: { myth: "A vertical video is a cropped horizontal one", fact: "The head fills the frame and the words have to be rewritten" },
    render: (p, { portrait }) => {
      const strike = wake(0, { from: 0.35, dur: 0.35 });
      const html = `<div class="t t-mf"><div class="t-block t-myth"><div class="t-kicker t-mk">${esc(p.mythLabel || "Myth")}</div><div class="t-text"><span class="t-strike">${esc(p.myth)}</span></div></div><div class="t-block t-fact"><div class="t-kicker">${esc(p.factLabel || "Fact")}</div><div class="t-text">${esc(p.fact)}</div></div></div>`;
      const css = `${base(portrait)}
.t-mf { gap: 5cqh; }
.t-block { display: flex; flex-direction: column; gap: 1.4cqh; }
.t-mk { color: ${MUTED}; }
.t-text { font-family: ${FONT_DISPLAY}; font-weight: 800; font-size: min(${portrait ? "5.6cqh, 8.4cqi" : "7.5cqh, 5.6cqi"}); line-height: 1.08; letter-spacing: -0.02em; text-wrap: balance; }
.t-myth { opacity: ${wake(0, { from: 0.05, dur: 0.3 })}; }
.t-strike { background-image: linear-gradient(${ACCENT}, ${ACCENT}); background-repeat: no-repeat; background-size: calc(${strike} * 100%) 0.09em; background-position: 0 58%; color: color-mix(in srgb, ${TEXT} calc(100% - ${strike} * 55%), transparent); }
.t-fact { opacity: ${wake(0, { from: 0.75, dur: 0.35 })}; transform: translateY(calc((1 - ${wake(0, { from: 0.75, dur: 0.35 })}) * 2cqh)); }
.t-fact .t-text { color: ${TEXT}; }`;
      return { html, css };
    },
  },

  definition: {
    label: "Definition",
    about: "A term, what kind of thing it is, and what it means — the dictionary entry, set large. Fits a side column or the whole stage.",
    when: "The speaker introduces a word the viewer may not know, or redefines one they do.",
    persona: ["editor"],
    full: false,
    fields: { term: text("The word or phrase", 32), kind: text("noun, verb, jargon, slang…", 24, { required: false }), meaning: text("What it means, in one sentence", 140) },
    example: { term: "dwell rule", kind: "noun · Fabula", meaning: "The floor under how long the head stays where it was put, so a plan cannot make it dart." },
    render: (p, { portrait, strip }) => {
      const html = `<div class="t t-def"><div class="t-term">${esc(p.term)}</div>${p.kind ? `<div class="t-kind">${esc(p.kind)}</div>` : ""}<div class="t-rule"></div><div class="t-meaning">${esc(p.meaning)}</div></div>`;
      const css = `${base(portrait, strip)}
.t-def { gap: 1.2cqh; }
.t-term { font-family: ${FONT_SERIF}; font-weight: 700; font-size: ${strip ? "8.6cqi" : `min(${portrait ? "11.2cqh, 11cqi" : "10cqh, 9cqi"})`}; line-height: 1; letter-spacing: -0.02em; opacity: ${wake(0, { from: 0.05, dur: 0.3 })}; }
.t-kind { font-family: ${FONT_SERIF}; font-style: italic; font-size: ${strip ? "3.8cqi" : `min(${portrait ? "6.7" : "4.2"}cqh, 4.4cqi)`}; color: ${MUTED}; opacity: ${wake(0, { from: 0.25, dur: 0.3 })}; }
.t-rule { height: ${strip ? "0.5cqi" : `min(${portrait ? "0.8" : "0.5"}cqh, 0.7cqi)`}; width: min(14cqw, 20cqi); margin: ${strip ? "0.8cqh 0" : "1.6cqh 0"}; background: ${ACCENT}; transform-origin: left; transform: scaleX(${wake(0, { from: 0.3, dur: 0.4 })}); }
.t-meaning { font-family: ${FONT_SERIF}; font-size: ${strip ? "4.3cqi" : `min(${portrait ? "8.0" : "5"}cqh, 5.4cqi)`}; line-height: 1.3; max-width: ${strip ? "56ch" : "38ch"}; text-wrap: pretty; opacity: ${wake(0, { from: 0.55, dur: 0.35 })}; }`;
      return { html, css };
    },
  },

  code: {
    label: "Code",
    about: "A window with a filename and up to eight lines of code in the mono face, revealed line by line. Any language; nothing is highlighted, so what is typed is what is shown.",
    when: "A line of code, a command, a config value the speaker is reading out. Keep it to the lines that matter.",
    persona: ["editor"],
    full: true,
    fields: { title: text("The filename or a label", 40, { required: false }), items: items("The lines, in order; label is the line, indentation kept", { min: 1, max: 8, keepSpace: true }), mark: field("number", "1-based line to highlight", { required: false, min: 1, max: 8 }), pace: PACE },
    example: { title: "clean-graph.mjs", items: [{ label: "// convert once, before any scale" }, { label: "format=yuv420p," }, { label: "scale=w=1920:h=1080" }], mark: 2 },
    render: (p, { portrait }) => {
      const html = `<div class="t t-code"><div class="t-win"><div class="t-bar"><span class="t-d"></span><span class="t-d"></span><span class="t-d"></span>${p.title ? `<span class="t-file">${esc(p.title)}</span>` : ""}</div><pre class="t-pre">${p.items.map((it, i) => `<div class="t-ln${p.mark === i + 1 ? " t-mark" : ""}" style="--k:${arrive(p, i, p.items.length, { from: 0.15, each: 0.1, dur: 0.2 })}"><span class="t-n">${i + 1}</span>${esc(it.label)}</div>`).join("")}</pre></div></div>`;
      const css = `${base(portrait)}
.t-win { background: ${CARD}; border: 1px solid color-mix(in srgb, ${ACCENT} 35%, transparent); border-radius: calc(1.4cqi * var(--ov-radius, 1)); overflow: hidden; opacity: ${wake(0, { from: 0.02, dur: 0.25 })}; transform: translateY(calc((1 - ${wake(0, { from: 0.02, dur: 0.25 })}) * 2cqh)); }
.t-bar { display: flex; align-items: center; gap: 0.8cqi; padding: 1.4cqi 1.8cqi; border-bottom: 1px solid color-mix(in srgb, ${TEXT} 12%, transparent); }
.t-d { width: 1.2cqi; height: 1.2cqi; border-radius: 50%; background: ${MUTED}; opacity: 0.6; }
.t-d:first-child { background: ${ACCENT}; opacity: 1; }
.t-file { margin-left: 1cqi; font-family: ${FONT_MONO}; font-size: min(2.2cqh, 3cqi); color: ${MUTED}; }
.t-pre { margin: 0; padding: 1.6cqi 1.8cqi; font-family: ${FONT_MONO}; font-size: min(${portrait ? "2.6cqh, 3.6cqi" : "3.4cqh, 2.6cqi"}); line-height: 1.55; white-space: pre; overflow: hidden; }
.t-ln { opacity: var(--k); transform: translateX(calc((1 - var(--k)) * -1cqi)); padding: 0 0.6cqi; border-radius: 0.4cqi; }
.t-n { display: inline-block; width: 2.4em; color: ${MUTED}; opacity: 0.7; user-select: none; }
.t-mark { background: color-mix(in srgb, ${ACCENT} 22%, transparent); }`;
      return { html, css };
    },
  },

  keys: {
    label: "Keyboard shortcut",
    about: "Keycaps joined by plus signs — Ctrl + Shift + P — pressed in order, with what the shortcut does under them.",
    when: "The speaker names a shortcut or a key. Fits a column beside the head.",
    persona: ["editor"],
    full: false,
    fields: { items: items("The keys, in order", { min: 1, max: 4 }), does: text("What it does", 60, { required: false }) },
    example: { items: [{ label: "Ctrl" }, { label: "Shift" }, { label: "P" }], does: "Command palette" },
    render: (p, { portrait, strip }) => {
      const html = `<div class="t t-keys"><div class="t-row">${p.items.map((it, i) => `${i ? `<span class="t-plus">+</span>` : ""}<span class="t-cap" style="--k:${wake(i, { from: 0.1, each: 0.16, dur: 0.25 })}">${esc(it.label)}</span>`).join("")}</div>${p.does ? `<div class="t-does">${esc(p.does)}</div>` : ""}</div>`;
      const css = `${base(portrait, strip)}
.t-keys { gap: 3cqh; align-items: flex-start; }
.t-row { display: flex; flex-wrap: wrap; align-items: center; gap: 1.2cqi; }
.t-cap { display: inline-block; padding: 1.2cqi 2cqi; min-width: 6cqi; text-align: center; font-family: ${FONT_MONO}; font-weight: 700; font-size: ${strip ? "4.8cqi" : `min(${portrait ? "7.0" : "4.4"}cqh, 5.6cqi)`}; color: ${INK}; background: ${TEXT}; border-radius: calc(1cqi * var(--ov-radius, 1)); box-shadow: 0 0.6cqi 0 color-mix(in srgb, ${TEXT} 45%, ${INK}); opacity: var(--k); transform: translateY(calc((1 - var(--k)) * -0.6cqi)); }
.t-plus { font-family: ${FONT_DISPLAY}; font-weight: 700; font-size: ${strip ? "4cqi" : `min(${portrait ? "6.4" : "4"}cqh, 5cqi)`}; color: ${MUTED}; }
.t-does { font-size: ${strip ? "4.1cqi" : `min(${portrait ? "7.4" : "4.6"}cqh, 4.6cqi)`}; color: ${MUTED}; opacity: ${wake(0, { from: 0.7, dur: 0.3 })}; }`;
      return { html, css };
    },
  },

  progress: {
    label: "Progress bar",
    about: "A bar filling to a percentage with a label and the figure beside it. The ring does the same as a circle; this reads better in a narrow column and for “how far along”.",
    when: "A share, a completion, a fraction of the way there.",
    persona: ["editor", "farmer"],
    full: false,
    fields: { value: field("number", "0–100", { min: 0, max: 100 }), label: text("What is being measured", 48), note: text("A line beneath", 70, { required: false }) },
    example: { value: 80, label: "watched with the sound off", note: "so the captions are the audio" },
    render: (p, { portrait, strip }) => {
      const fill = `calc(${wake(0, { from: 0.1, dur: 0.7 })} * ${p.value}%)`;
      const html = `<div class="t t-prog"><div class="t-head"><span class="t-label">${esc(p.label)}</span><span class="t-pct">${Math.round(p.value)}%</span></div><div class="t-track"><div class="t-fill"></div></div>${p.note ? `<div class="t-note">${esc(p.note)}</div>` : ""}</div>`;
      const css = `${base(portrait, strip)}
.t-prog { gap: 1.8cqh; }
.t-head { display: flex; justify-content: space-between; align-items: baseline; gap: 2cqi; font-family: ${FONT_DISPLAY}; font-weight: 700; font-size: ${strip ? "5cqi" : `min(${portrait ? "9.6" : "6"}cqh, 6cqi)`}; }
.t-pct { font-weight: 900; font-size: ${strip ? "9cqi" : `min(${portrait ? "19.2" : "12"}cqh, 12cqi)`}; color: ${ACCENT}; font-variant-numeric: tabular-nums; }
.t-track { height: ${strip ? "3.4cqi" : `min(${portrait ? "8.0" : "5"}cqh, 5cqi)`}; background: color-mix(in srgb, ${TEXT} 12%, transparent); border-radius: 999px; overflow: hidden; }
.t-fill { height: 100%; width: ${fill}; background: linear-gradient(90deg, ${ACCENT}, ${ACCENT2}); border-radius: 999px; }
.t-note { font-size: ${strip ? "3.9cqi" : `min(${portrait ? "7.2" : "4.5"}cqh, 4.5cqi)`}; color: ${MUTED}; opacity: ${wake(0, { from: 0.7, dur: 0.3 })}; }`;
      return { html, css };
    },
  },

  ladder: {
    label: "Ladder",
    about: "Three to five tiers stacked from the base up, each wider than the one above, built bottom first. A hierarchy, a priority order, a pyramid.",
    when: "Levels: what comes first, what rests on what. Use steps for a sequence; this is for a stack.",
    persona: ["editor"],
    full: true,
    fields: { title: text("A heading", 48, { required: false }), items: items("Tiers from the TOP down", { min: 3, max: 5 }), pace: PACE },
    example: { title: "What a short needs", items: [{ label: "a hook" }, { label: "one idea" }, { label: "captions" }, { label: "an ending that lands" }] },
    render: (p, { portrait }) => {
      const n = p.items.length;
      const html = `<div class="t t-ladder">${p.title ? `<div class="t-kicker">${esc(p.title)}</div>` : ""}<div class="t-tiers">${p.items.map((it, i) => `<div class="t-tier" style="--k:${arrive(p, n - 1 - i, n, { from: 0.08, each: 0.16, dur: 0.3 })}; --w:${(55 + (45 * i) / Math.max(n - 1, 1)).toFixed(1)}%">${esc(it.label)}</div>`).join("")}</div></div>`;
      const css = `${base(portrait)}
.t-ladder { gap: 3cqh; align-items: center; }
.t-tiers { display: flex; flex-direction: column; align-items: center; gap: 0.8cqh; width: 100%; }
.t-tier { width: var(--w); padding: ${portrait ? "2cqh 3cqw" : "2.6cqh 2cqw"}; text-align: center; font-family: ${FONT_DISPLAY}; font-weight: 700; font-size: min(${portrait ? "3.4cqh" : "5cqh"}, 4.8cqi); background: color-mix(in srgb, ${ACCENT} calc(30% + var(--w) * 0.4), ${INK}); border-radius: calc(0.8cqi * var(--ov-radius, 1)); opacity: var(--k); transform: translateY(calc((1 - var(--k)) * 1.5cqh)) scaleX(calc(0.85 + var(--k) * 0.15)); }`;
      return { html, css };
    },
  },

  scale: {
    label: "The scales",
    about: "Two options on a beam that tips towards the heavier one. Which way it tips is the argument.",
    when: "A trade-off the speaker resolves: this outweighs that.",
    persona: ["editor"],
    full: true,
    fields: { left: text("The left option", 36), right: text("The right option", 36), tilt: field("number", "-100 (left wins) to 100 (right wins)", { min: -100, max: 100, default: 0, required: false }), title: text("A heading", 48, { required: false }) },
    example: { title: "Where to spend an hour", left: "a better thumbnail", right: "a better first sentence", tilt: 60 },
    render: (p, { portrait }) => {
      const deg = (p.tilt / 100) * 9;
      const html = `<div class="t t-scale">${p.title ? `<div class="t-kicker">${esc(p.title)}</div>` : ""}<div class="t-rig"><div class="t-beam"><div class="t-pan t-left">${esc(p.left)}</div><div class="t-pan t-right">${esc(p.right)}</div></div><div class="t-post"></div></div></div>`;
      const css = `${base(portrait)}
.t-scale { gap: 3cqh; align-items: center; }
.t-rig { position: relative; width: 100%; height: ${portrait ? "34cqh" : "50cqh"}; }
.t-beam { position: absolute; left: 6%; right: 6%; top: 40%; height: min(1cqh, 1.4cqi); background: ${TEXT}; border-radius: 999px; transform-origin: center; transform: rotate(calc(${wake(0, { from: 0.35, dur: 0.6 })} * ${deg.toFixed(2)}deg)); }
.t-pan { position: absolute; top: 2cqh; width: 36%; padding: 1.8cqh 1.6cqi; text-align: center; font-family: ${FONT_DISPLAY}; font-weight: 700; font-size: min(3.2cqh, 4.4cqi); background: ${CARD}; border: 1px solid color-mix(in srgb, ${ACCENT} 45%, transparent); border-radius: calc(1cqi * var(--ov-radius, 1)); transform: rotate(calc(${wake(0, { from: 0.35, dur: 0.6 })} * ${(-deg).toFixed(2)}deg)); opacity: ${wake(0, { from: 0.08, dur: 0.3 })}; }
.t-left { left: 0; }
.t-right { right: 0; }
.t-post { position: absolute; left: 50%; top: 40%; width: min(1.6cqw, 2.2cqi); height: 60%; transform: translateX(-50%); background: ${ACCENT}; border-radius: 999px 999px 0 0; }`;
      return { html, css };
    },
  },

  alert: {
    label: "Alert",
    about: "A banner with a mark and a short line: note, warning, or stop. The colour says how seriously to take it.",
    when: "A caveat, a gotcha, a thing that will bite. Fits a column.",
    persona: ["editor", "farmer"],
    full: false,
    fields: { text: text("The line", 90), level: field("choice", "note, warning or stop", { options: ["note", "warning", "stop"], default: "warning" }), title: text("A short heading", 24, { required: false }) },
    example: { level: "warning", title: "Careful", text: "A false positive here sends someone into a multi-gigabyte download." },
    render: (p, { portrait, strip }) => {
      const colour = { note: MUTED, warning: ACCENT2, stop: "#e05a4f" }[p.level];
      const mark = { note: "i", warning: "!", stop: "×" }[p.level];
      const html = `<div class="t t-alert"><div class="t-box"><div class="t-mark">${mark}</div><div class="t-body">${p.title ? `<div class="t-title">${esc(p.title)}</div>` : ""}<div class="t-text">${esc(p.text)}</div></div></div></div>`;
      const css = `${base(portrait, strip)}
.t-box { display: flex; gap: 2cqi; align-items: flex-start; padding: 2.4cqh 2.4cqi; background: ${CARD}; border-left: min(1cqw, 1.4cqi) solid ${colour}; border-radius: calc(1cqi * var(--ov-radius, 1)); opacity: ${wake(0, { from: 0.05, dur: 0.3 })}; transform: translateX(calc((1 - ${wake(0, { from: 0.05, dur: 0.3 })}) * -2cqi)); }
.t-mark { flex: none; width: ${strip ? "9cqi" : `min(${portrait ? "14.4" : "9"}cqh, 10cqi)`}; height: ${strip ? "9cqi" : `min(${portrait ? "14.4" : "9"}cqh, 10cqi)`}; display: grid; place-items: center; border-radius: 50%; font-family: ${FONT_DISPLAY}; font-weight: 900; font-size: ${strip ? "5cqi" : `min(${portrait ? "8.8" : "5.5"}cqh, 6.5cqi)`}; color: ${INK}; background: ${colour}; transform: scale(${wake(0, { from: 0.25, dur: 0.3 })}); }
.t-title { font-family: ${FONT_DISPLAY}; font-weight: 800; font-size: ${strip ? "5cqi" : `min(${portrait ? "8.8" : "5.5"}cqh, 6cqi)`}; color: ${colour}; margin-bottom: 0.6cqh; }
.t-text { font-size: ${strip ? "4.3cqi" : `min(${portrait ? "8.0" : "5"}cqh, 5.2cqi)`}; line-height: 1.3; text-wrap: pretty; }`;
      return { html, css };
    },
  },

  headline: {
    label: "Headline",
    about: "A kicker, a headline and a dateline, set like a front page. The cover without a photograph: it marks a moment or a claim with weight.",
    when: "A turning point, a claim the film makes, a chapter that deserves a full stop. Needs no picture.",
    persona: ["editor"],
    full: true,
    fields: { kicker: text("A few words above", 32, { required: false }), headline: text("The headline", 70), dateline: text("Where or when", 40, { required: false }) },
    example: { kicker: "Rendering", headline: "The bottleneck was never the encoder", dateline: "Fabula · September" },
    render: (p, { portrait }) => {
      const html = `<div class="t t-hl"><div class="t-top"></div>${p.kicker ? `<div class="t-kicker">${esc(p.kicker)}</div>` : ""}<div class="t-head">${esc(p.headline)}</div>${p.dateline ? `<div class="t-date">${esc(p.dateline)}</div>` : ""}</div>`;
      const css = `${base(portrait)}
.t-hl { gap: 2cqh; justify-content: flex-end; }
.t-top { height: min(0.8cqh, 1cqi); width: 100%; background: ${TEXT}; transform-origin: left; transform: scaleX(${wake(0, { from: 0.02, dur: 0.5 })}); margin-bottom: 2cqh; }
.t-head { font-family: ${FONT_SERIF}; font-weight: 700; font-size: min(${portrait ? "7.4cqh, 11.5cqi" : "11cqh, 8.4cqi"}); line-height: 1.02; letter-spacing: -0.02em; text-wrap: balance; clip-path: inset(0 calc((1 - ${wake(0, { from: 0.2, dur: 0.55 })}) * 100%) 0 0); }
.t-date { font-family: ${FONT_DISPLAY}; font-size: min(2.6cqh, 3.6cqi); letter-spacing: 0.08em; text-transform: uppercase; color: ${MUTED}; opacity: ${wake(0, { from: 0.7, dur: 0.3 })}; }`;
      return { html, css };
    },
  },

  cta: {
    label: "Call to action",
    about: "The end card of a short: what to do next and where. A big line, a smaller one saying where the rest is, and a pill that reads like a button. The arrow points where the platform puts the thing.",
    when: "The last two seconds of a short that exists to send people to the long film. Never in the long film itself.",
    persona: ["farmer"],
    full: true,
    fields: { line: text("The ask", 48), where: text("Where the rest is", 60, { required: false }), button: text("The pill's text", 24, { required: false }), arrow: field("choice", "Where the arrow points", { options: ["none", "down", "up", "right", "left"], default: "down" }), shade: field("number", "A shade behind the words, 0 to 1, for when the card sits over the face (over: true)", { min: 0, max: 1, default: 0, required: false }) },
    example: { line: "The whole story is 12 minutes", where: "Full video on the channel", button: "Watch it", arrow: "down" },
    render: (p, { portrait }) => {
      const arrows = { none: "", down: "↓", up: "↑", right: "→", left: "←" };
      const html = `<div class="t t-cta">${p.shade > 0 ? `<div class="t-shade"></div>` : ""}<div class="t-line">${esc(p.line)}</div>${p.where ? `<div class="t-where">${esc(p.where)}</div>` : ""}<div class="t-row">${p.button ? `<div class="t-pill">${esc(p.button)}</div>` : ""}${p.arrow !== "none" ? `<div class="t-arrow">${arrows[p.arrow]}</div>` : ""}</div></div>`;
      const css = `${base(portrait)}
.t-cta { gap: 2.2cqh; align-items: ${portrait ? "center" : "flex-start"}; text-align: ${portrait ? "center" : "left"}; ${portrait ? "justify-content: flex-end;" : ""} }
.t-cta > :not(.t-shade) { position: relative; }
.t-shade { position: absolute; inset: 0; background: linear-gradient(0deg, rgba(0,0,0,${p.shade.toFixed(2)}) 0%, rgba(0,0,0,${(p.shade * 0.75).toFixed(2)}) 40%, rgba(0,0,0,0) 75%); opacity: ${wake(0, { from: 0, dur: 0.3 })}; }
.t-line { font-family: ${FONT_DISPLAY}; font-weight: 900; font-size: min(${portrait ? "6.4cqh, 10cqi" : "9cqh, 7cqi"}); line-height: 1.02; letter-spacing: -0.02em; text-wrap: balance; opacity: ${wake(0, { from: 0.02, dur: 0.3 })}; transform: translateY(calc((1 - ${wake(0, { from: 0.02, dur: 0.3 })}) * 2cqh)); }
.t-where { font-size: min(3.2cqh, 4.6cqi); color: ${MUTED}; opacity: ${wake(0, { from: 0.3, dur: 0.3 })}; }
.t-row { display: flex; align-items: center; gap: 2cqi; margin-top: 1cqh; }
.t-pill { padding: 1.6cqh 4cqi; font-family: ${FONT_DISPLAY}; font-weight: 800; font-size: min(3.6cqh, 5cqi); color: ${INK}; background: ${ACCENT}; border-radius: 999px; transform: scale(calc(0.8 + ${wake(0, { from: 0.45, dur: 0.35 })} * 0.2)); opacity: ${wake(0, { from: 0.45, dur: 0.35 })}; }
.t-arrow { font-family: ${FONT_DISPLAY}; font-weight: 900; font-size: min(8cqh, 11cqi); color: ${ACCENT}; line-height: 1; opacity: ${wake(0, { from: 0.6, dur: 0.3 })}; transform: translateY(calc(sin(var(--p) * 12.566) * 0.4cqh)); }
${p.shade > 0 ? `.t-line, .t-where { color: #ffffff; text-shadow: 0 0.3cqh 1.5cqh rgba(0,0,0,0.55); }` : ""}`;
      return { html, css };
    },
  },

  teaser: {
    label: "Coming up",
    about: "“Coming up” and two to four lines of what the film will get to, each appearing on its beat. The open loop that keeps a viewer past the first minute.",
    when: "Right after the hook of a long film, or at a section change: what the rest holds.",
    persona: ["farmer", "editor"],
    full: true,
    fields: { title: text("The heading", 30, { required: false }), items: items("What is coming", { min: 2, max: 4 }), pace: PACE },
    example: { title: "Coming up", items: [{ label: "why the second render was ten minutes faster" }, { label: "the one line that did it" }, { label: "what it cost" }] },
    render: (p, { portrait }) => {
      const html = `<div class="t t-teaser"><div class="t-kicker">${esc(p.title || "Coming up")}</div><ol class="t-list">${p.items.map((it, i) => `<li class="t-item" style="--k:${arrive(p, i, p.items.length, { from: 0.15, each: 0.2, dur: 0.3 })}"><span class="t-num">${String(i + 1).padStart(2, "0")}</span><span>${esc(it.label)}</span></li>`).join("")}</ol></div>`;
      const css = `${base(portrait)}
.t-teaser { gap: 3cqh; }
.t-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2cqh; }
.t-item { display: flex; align-items: baseline; gap: 2cqi; font-family: ${FONT_DISPLAY}; font-weight: 700; font-size: min(${portrait ? "4.2cqh, 6.4cqi" : "6cqh, 4.6cqi"}); line-height: 1.15; opacity: var(--k); transform: translateX(calc((1 - var(--k)) * -2cqi)); }
.t-num { flex: none; font-family: ${FONT_MONO}; font-size: 0.6em; color: ${ACCENT}; }`;
      return { html, css };
    },
  },

  receipt: {
    label: "Receipt",
    about: "Lines of label and amount adding up to a total, printed one after another. What something costs, in the parts it costs.",
    when: "A price, a budget, a breakdown of time or money the speaker itemises.",
    persona: ["editor", "farmer"],
    full: false,
    fields: { title: text("A heading", 40, { required: false }), items: items("Lines: label and value as typed", { min: 2, max: 6, value: "required" }), total: text("The total, as typed", 20, { required: false }), totalLabel: text("Label for the total", 20, { required: false }), pace: PACE },
    example: { title: "One export", items: [{ label: "capture", value: "1:40" }, { label: "encode", value: "3:10" }, { label: "stitch", value: "0:20" }], total: "5:10", totalLabel: "Total" },
    render: (p, { portrait, strip }) => {
      const n = p.items.length;
      const html = `<div class="t t-rc"><div class="t-paper">${p.title ? `<div class="t-title">${esc(p.title)}</div>` : ""}${p.items.map((it, i) => `<div class="t-line" style="--k:${arrive(p, i, n + (p.total ? 1 : 0), { from: 0.1, each: 0.12, dur: 0.2 })}"><span class="t-l">${esc(it.label)}</span><span class="t-dots"></span><span class="t-v">${esc(it.value)}</span></div>`).join("")}${p.total ? `<div class="t-line t-total" style="--k:${arrive(p, n, n + 1, { from: 0.2, each: 0.12, dur: 0.3 })}"><span class="t-l">${esc(p.totalLabel || "Total")}</span><span class="t-dots"></span><span class="t-v">${esc(p.total)}</span></div>` : ""}</div></div>`;
      const css = `${base(portrait, strip)}
.t-paper { padding: 2.4cqh 2.6cqi; background: ${CARD}; border-radius: calc(1cqi * var(--ov-radius, 1)); font-family: ${FONT_MONO}; font-size: ${strip ? "3.8cqi" : `min(${portrait ? "7.0cqh, 4.6cqi" : "5.5cqh, 4.6cqi"})`}; opacity: ${wake(0, { from: 0.02, dur: 0.25 })}; }
.t-title { font-family: ${FONT_DISPLAY}; font-weight: 800; font-size: 1.2em; margin-bottom: 1.4cqh; }
.t-line { display: flex; align-items: baseline; gap: 1cqi; padding: 0.7cqh 0; opacity: var(--k); }
.t-dots { flex: 1; border-bottom: 1px dotted ${MUTED}; opacity: 0.6; transform: translateY(-0.3em); }
.t-v { font-variant-numeric: tabular-nums; }
.t-total { margin-top: 0.8cqh; padding-top: 1.2cqh; border-top: 2px solid ${ACCENT}; font-weight: 700; color: ${ACCENT}; }`;
      return { html, css };
    },
  },

  ranking: {
    label: "Ranking",
    about: "A top three to six, big numbers down the side, revealed from the bottom of the list to the top so the first place lands last.",
    when: "The speaker counts down or ranks: the best, the worst, the most.",
    persona: ["farmer", "editor"],
    full: true,
    fields: { title: text("A heading", 48, { required: false }), items: items("From first place down; value is an optional note", { min: 3, max: 6, value: "optional" }), countdown: field("choice", "Reveal order", { options: ["up", "down"], default: "up" }), pace: PACE },
    example: { title: "Where the render time went", items: [{ label: "the filter graph", value: "10 min" }, { label: "capture", value: "2 min" }, { label: "the encoder", value: "40 s" }] },
    render: (p, { portrait }) => {
      const n = p.items.length;
      const order = (i) => (p.countdown === "up" ? n - 1 - i : i);
      const html = `<div class="t t-rank">${p.title ? `<div class="t-kicker">${esc(p.title)}</div>` : ""}<div class="t-rows">${p.items.map((it, i) => `<div class="t-row" style="--k:${arrive(p, order(i), n, { from: 0.1, each: 0.16, dur: 0.3 })}"><div class="t-pos">${i + 1}</div><div class="t-what">${esc(it.label)}</div>${it.value ? `<div class="t-note">${esc(it.value)}</div>` : ""}</div>`).join("")}</div></div>`;
      const css = `${base(portrait)}
.t-rank { gap: 3cqh; }
.t-rows { display: flex; flex-direction: column; gap: 1.2cqh; }
.t-row { display: flex; align-items: center; gap: 2cqi; padding: 1.2cqh 2cqi; background: ${CARD}; border-radius: calc(0.8cqi * var(--ov-radius, 1)); opacity: var(--k); transform: translateX(calc((1 - var(--k)) * -2cqi)); }
.t-row:first-child { border: 1px solid color-mix(in srgb, ${ACCENT} 55%, transparent); }
.t-pos { flex: none; width: 2.2em; font-family: ${FONT_DISPLAY}; font-weight: 900; font-size: min(${portrait ? "5cqh, 7cqi" : "6.5cqh, 5cqi"}); line-height: 1; color: ${ACCENT}; font-variant-numeric: tabular-nums; }
.t-what { flex: 1; font-family: ${FONT_DISPLAY}; font-weight: 700; font-size: min(${portrait ? "3.6cqh, 5cqi" : "4.4cqh, 3.4cqi"}); line-height: 1.15; }
.t-note { flex: none; font-family: ${FONT_MONO}; font-size: min(2.6cqh, 3.6cqi); color: ${MUTED}; }`;
      return { html, css };
    },
  },

  post: {
    label: "Post",
    about: "A social-style card: a name, a handle, the text, a time. For quoting a comment, a message or a post in the shape people already read it in. No picture, so nobody is impersonated by accident.",
    when: "The speaker reads out something someone wrote. Say whose it is honestly.",
    persona: ["farmer", "editor"],
    full: false,
    fields: { name: text("Who wrote it", 40), handle: text("Their handle", 30, { required: false }), text: text("What they wrote", 240), meta: text("When, or where", 30, { required: false }) },
    example: { name: "A viewer", handle: "@someone", text: "I watched the whole thing with the sound off and still got it. Captions carried it.", meta: "2h" },
    render: (p, { portrait, strip }) => {
      const initial = esc(p.name.trim().slice(0, 1).toUpperCase());
      const html = `<div class="t t-post"><div class="t-card"><div class="t-who"><div class="t-avatar">${initial}</div><div><div class="t-name">${esc(p.name)}</div>${p.handle ? `<div class="t-handle">${esc(p.handle)}${p.meta ? ` · ${esc(p.meta)}` : ""}</div>` : ""}</div></div><div class="t-text">${esc(p.text)}</div></div></div>`;
      const css = `${base(portrait, strip)}
.t-card { padding: 2.2cqh 2.4cqi; background: ${CARD}; border: 1px solid color-mix(in srgb, ${TEXT} 14%, transparent); border-radius: calc(1.4cqi * var(--ov-radius, 1)); opacity: ${wake(0, { from: 0.02, dur: 0.3 })}; transform: translateY(calc((1 - ${wake(0, { from: 0.02, dur: 0.3 })}) * 2cqh)); }
.t-who { display: flex; align-items: center; gap: 1.6cqi; margin-bottom: 1.6cqh; }
.t-avatar { width: ${strip ? "8cqi" : `min(${portrait ? "14.4" : "9"}cqh, 10cqi)`}; height: ${strip ? "8cqi" : `min(${portrait ? "14.4" : "9"}cqh, 10cqi)`}; display: grid; place-items: center; border-radius: 50%; background: ${ACCENT}; color: ${INK}; font-family: ${FONT_DISPLAY}; font-weight: 800; font-size: ${strip ? "4cqi" : `min(${portrait ? "7.2" : "4.5"}cqh, 5cqi)`}; }
.t-name { font-family: ${FONT_DISPLAY}; font-weight: 800; font-size: ${strip ? "4.6cqi" : `min(${portrait ? "8.0" : "5"}cqh, 5.4cqi)`}; }
.t-handle { font-size: ${strip ? "3.6cqi" : `min(${portrait ? "6.4" : "4"}cqh, 4.2cqi)`}; color: ${MUTED}; }
.t-text { font-size: ${strip ? "4.3cqi" : `min(${portrait ? "7.4cqh, 4.8cqi" : "5.5cqh, 5cqi"})`}; line-height: 1.35; text-wrap: pretty; clip-path: inset(0 0 calc((1 - ${wake(0, { from: 0.3, dur: 0.5 })}) * 100%) 0); }`;
      return { html, css };
    },
  },

  split: {
    label: "Share bar",
    about: "One bar divided into two to five parts by their share, with a legend. Where the whole goes: time, money, attention.",
    when: "Parts of a whole. A chart compares amounts; this shows a division.",
    persona: ["editor"],
    full: false,
    fields: { title: text("A heading", 48, { required: false }), items: items("Parts: value is the share as a number; they are normalised", { min: 2, max: 5, value: "number" }), pace: PACE },
    example: { title: "Where the render time went", items: [{ label: "filter graph", value: 62 }, { label: "capture", value: 25 }, { label: "encode", value: 13 }] },
    render: (p, { portrait, strip }) => {
      const total = p.items.reduce((sum, it) => sum + Math.max(it.value, 0), 0) || 1;
      const shares = p.items.map((it) => Math.max(it.value, 0) / total);
      const tones = [ACCENT, ACCENT2, `color-mix(in srgb, ${ACCENT} 55%, ${TEXT})`, MUTED, `color-mix(in srgb, ${TEXT} 35%, ${INK})`];
      const html = `<div class="t t-split">${p.title ? `<div class="t-kicker">${esc(p.title)}</div>` : ""}<div class="t-bar">${p.items.map((it, i) => `<div class="t-seg" style="--s:${shares[i].toFixed(4)}; --c:${tones[i]}; --k:${arrive(p, i, p.items.length, { from: 0.05, each: 0.12, dur: 0.35 })}"></div>`).join("")}</div><div class="t-legend">${p.items.map((it, i) => `<div class="t-key" style="--c:${tones[i]}; --k:${arrive(p, i, p.items.length, { from: 0.25, each: 0.12, dur: 0.3 })}"><span class="t-swatch"></span><span>${esc(it.label)}</span><span class="t-pct">${Math.round(shares[i] * 100)}%</span></div>`).join("")}</div></div>`;
      const css = `${base(portrait, strip)}
.t-split { gap: 2.4cqh; }
.t-bar { display: flex; height: ${strip ? "8cqi" : `min(${portrait ? "14.4" : "9"}cqh, 10cqi)`}; border-radius: 999px; overflow: hidden; background: color-mix(in srgb, ${TEXT} 10%, transparent); }
.t-seg { flex: calc(var(--s) * var(--k)) 0 0; background: var(--c); }
.t-legend { display: flex; flex-wrap: wrap; gap: 1cqh 2.4cqi; }
.t-key { display: flex; align-items: center; gap: 0.8cqi; font-size: ${strip ? "4.3cqi" : `min(${portrait ? "7.7" : "4.8"}cqh, 5cqi)`}; opacity: var(--k); }
.t-swatch { width: 2cqi; height: 2cqi; border-radius: 0.3cqi; background: var(--c); }
.t-pct { color: ${MUTED}; font-variant-numeric: tabular-nums; }`;
      return { html, css };
    },
  },

  phone: {
    label: "Phone",
    about: "A phone with a title bar and up to four message bubbles arriving one by one, theirs on the left, yours on the right. A conversation, a notification, a text.",
    when: "The speaker recounts an exchange: what was said and what came back.",
    persona: ["farmer", "editor"],
    full: true,
    fields: { title: text("The name at the top", 30, { required: false }), items: items("Messages in order; value is 'me' for the right-hand side, anything else for the left", { min: 1, max: 4, value: "optional" }), pace: PACE },
    example: { title: "Editor", items: [{ label: "did you see the render time?" }, { label: "six minutes", value: "me" }, { label: "what did you change??" }, { label: "one line", value: "me" }] },
    render: (p, { portrait }) => {
      const html = `<div class="t t-phone"><div class="t-device"><div class="t-notch"></div>${p.title ? `<div class="t-bar">${esc(p.title)}</div>` : ""}<div class="t-msgs">${p.items.map((it, i) => `<div class="t-msg ${it.value === "me" ? "t-me" : "t-them"}" style="--k:${arrive(p, i, p.items.length, { from: 0.15, each: 0.22, dur: 0.3 })}">${esc(it.label)}</div>`).join("")}</div></div></div>`;
      const css = `${base(portrait)}
.t-phone { align-items: center; }
.t-device { position: relative; width: ${portrait ? "78cqw" : "34cqw"}; aspect-ratio: 9 / 17; max-height: 84cqh; padding: 5cqi 2.2cqi 3cqi; background: ${INK}; border: min(0.7cqw, 1cqi) solid color-mix(in srgb, ${TEXT} 30%, ${INK}); border-radius: 5cqi; box-shadow: 0 2cqh 5cqh rgba(0,0,0,0.45); opacity: ${wake(0, { from: 0.02, dur: 0.3 })}; transform: translateY(calc((1 - ${wake(0, { from: 0.02, dur: 0.3 })}) * 3cqh)); overflow: hidden; }
.t-notch { position: absolute; top: 1.4cqi; left: 50%; transform: translateX(-50%); width: 34%; height: 2.2cqi; border-radius: 999px; background: color-mix(in srgb, ${TEXT} 20%, ${INK}); }
.t-bar { text-align: center; font-family: ${FONT_DISPLAY}; font-weight: 700; font-size: min(2.6cqh, 3.6cqi); color: ${MUTED}; padding-bottom: 1.2cqh; border-bottom: 1px solid color-mix(in srgb, ${TEXT} 12%, transparent); margin-bottom: 1.4cqh; }
.t-msgs { display: flex; flex-direction: column; gap: 1cqh; }
.t-msg { max-width: 82%; padding: 1.1cqh 1.6cqi; font-size: min(${portrait ? "2.8cqh, 4cqi" : "3.2cqh, 2.4cqi"}); line-height: 1.3; border-radius: 1.6cqi; opacity: var(--k); transform: translateY(calc((1 - var(--k)) * 1cqh)) scale(calc(0.9 + var(--k) * 0.1)); }
.t-them { align-self: flex-start; background: color-mix(in srgb, ${TEXT} 16%, ${INK}); border-bottom-left-radius: 0.4cqi; }
.t-me { align-self: flex-end; background: ${ACCENT}; color: ${INK}; border-bottom-right-radius: 0.4cqi; }`;
      return { html, css };
    },
  },

  question: {
    label: "The question",
    about: "A large question mark and the question, set to hang in the air. The moment a film asks something before it answers it.",
    when: "A question the speaker poses and then works through — a beat to return to the presenter on.",
    persona: ["editor", "farmer"],
    full: false,
    fields: { text: text("The question", 100), kicker: text("A few words above", 32, { required: false }) },
    example: { text: "Why was the second render ten minutes faster?" },
    render: (p, { portrait, strip }) => {
      const html = `<div class="t t-q"><div class="t-mark">?</div>${p.kicker ? `<div class="t-kicker">${esc(p.kicker)}</div>` : ""}<div class="t-text">${esc(p.text)}</div></div>`;
      const css = `${base(portrait, strip)}
.t-q { gap: 1.6cqh; }
.t-mark { font-family: ${FONT_SERIF}; font-weight: 700; font-size: ${strip ? "18cqi" : `min(${portrait ? "25.6cqh, 26cqi" : "26cqh, 18cqi"})`}; line-height: 0.8; color: ${ACCENT}; opacity: ${wake(0, { from: 0.02, dur: 0.35 })}; transform: rotate(calc((1 - ${wake(0, { from: 0.02, dur: 0.35 })}) * -12deg)) scale(calc(0.8 + ${wake(0, { from: 0.02, dur: 0.35 })} * 0.2)); transform-origin: bottom left; }
.t-text { font-family: ${FONT_DISPLAY}; font-weight: 800; font-size: ${strip ? "6.2cqi" : `min(${portrait ? "10.2cqh, 7.6cqi" : "8cqh, 6.4cqi"})`}; line-height: 1.08; letter-spacing: -0.02em; text-wrap: balance; opacity: ${wake(0, { from: 0.35, dur: 0.35 })}; transform: translateY(calc((1 - ${wake(0, { from: 0.35, dur: 0.35 })}) * 1.5cqh)); }`;
      return { html, css };
    },
  },
};

TEMPLATES.thumbnail = {
  label: "Thumbnail line",
  about: "A few big words over the picture, with a shade behind them so they read on any frame, and a small kicker. Made for render_thumbnail — the still a platform shows before anyone presses play — and usable as a title card over a cutaway.",
  when: "The thumbnail, or a cold-open title over a still. Up to six words; fewer read better. On a short's first words, `over: true` and `arrive: instant`, so the words are on the face at frame one.",
  persona: ["farmer", "editor"],
  full: true,
  fields: {
    line: text("The words — six at most", 40),
    kicker: text("A few small words above", 24, { required: false }),
    side: field("choice", "Where the words sit", { options: ["left", "right", "bottom"], default: "left" }),
    shade: field("number", "How dark the shade behind the words is, 0 to 1", { min: 0, max: 1, default: 0.55, required: false }),
    arrive: field("choice", "build: the words land one by one; instant: all there at the first frame, for the film's opening frame", { options: ["build", "instant"], default: "build" }),
  },
  example: { kicker: "Rendering", line: "16 minutes → 6", side: "left" },
  render: (p, { portrait }) => {
    const words = p.line.split(" ");
    const instant = p.arrive === "instant";
    const html = `<div class="t t-thumb t-${p.side}"><div class="t-shade"></div><div class="t-text">${p.kicker ? `<div class="t-kicker">${esc(p.kicker)}</div>` : ""}<div class="t-line">${words.map((w, i) => `<span class="t-w" style="--k:${instant ? "1" : wake(i, { from: 0.05, each: 0.08, dur: 0.25 })}">${esc(w)}</span>`).join(" ")}</div></div></div>`;
    const dir = { left: "90deg", right: "270deg", bottom: "0deg" }[p.side];
    const css = `${base(portrait)}
.t-thumb { padding: 0; justify-content: ${p.side === "bottom" ? "flex-end" : "center"}; }
.t-shade { position: absolute; inset: 0; background: linear-gradient(${dir}, rgba(0,0,0,${p.shade.toFixed(2)}) 0%, rgba(0,0,0,${(p.shade * 0.7).toFixed(2)}) ${p.side === "bottom" ? "35%" : "45%"}, rgba(0,0,0,0) ${p.side === "bottom" ? "70%" : "80%"}); opacity: ${instant ? "1" : wake(0, { from: 0, dur: 0.3 })}; }
.t-text { position: relative; ${frame(portrait)} ${p.side === "right" ? "align-self: flex-end; text-align: right;" : ""} ${portrait ? "padding-bottom: 22cqh;" : ""} max-width: ${portrait ? "100%" : "46%"}; display: flex; flex-direction: column; gap: 1.6cqh; }
.t-kicker { color: ${ACCENT}; text-shadow: 0 0.2cqh 1cqh rgba(0,0,0,0.6); }
.t-line { font-family: ${FONT_DISPLAY}; font-weight: 900; font-size: min(${portrait ? "10cqh, 15cqi" : "16cqh, 11cqi"}); line-height: 0.98; letter-spacing: -0.03em; color: #ffffff; text-shadow: 0 0.4cqh 2cqh rgba(0,0,0,0.55); text-wrap: balance; }
.t-w { display: inline-block; opacity: var(--k); transform: translateY(calc((1 - var(--k)) * 0.3em)); }`;
    return { html, css };
  },
};

export const TEMPLATE_IDS = Object.keys(TEMPLATES);
// The templates whose items can be spread over the span (`pace: "span"`).
export const PACED_TEMPLATES = TEMPLATE_IDS.filter((id) => TEMPLATES[id].fields.pace);
// How many things a rendered template reveals, for the pacing read.
export function revealCount(graphic) {
  if (!graphic?.template || graphic.params?.pace !== "span") return 0;
  // A before-after's one arrival is its sweep, near the middle of the card.
  if (graphic.template === "before-after") return 1;
  const n = graphic.params?.items?.length ?? 0;
  return graphic.template === "receipt" && graphic.params?.total ? n + 1 : n;
}

// What describe_templates prints: everything the assistant needs to fill one
// in, and nothing about how it is drawn.
export function describeTemplates({ persona } = {}) {
  return TEMPLATE_IDS
    .filter((id) => !persona || TEMPLATES[id].persona.includes(persona))
    .map((id) => {
      const { label, about, when, full, fields, example, persona: personas } = TEMPLATES[id];
      return {
        id, label, about, when, full, personas,
        fields: Object.fromEntries(Object.entries(fields).map(([name, spec]) => [name, describeField(spec)])),
        example,
      };
    });
}

function describeField(spec) {
  // A choice always has its default, so it is never required.
  const out = { type: spec.type, about: spec.about, required: spec.type !== "choice" && spec.required !== false };
  if (spec.type === "text") out.max = spec.max;
  if (spec.type === "number") { if (spec.min !== undefined) out.min = spec.min; if (spec.max !== undefined) out.max = spec.max; }
  if (spec.type === "items") { out.min = spec.min; out.max = spec.max; if (spec.value) out.value = spec.value === "number" ? "a number" : spec.value === "required" ? "text, required" : "text, optional"; if (spec.keepSpace) out.keepSpace = true; }
  if (spec.type === "choice") { out.options = spec.options; out.default = spec.default; }
  return out;
}

// The custom graphic a template becomes. `format` is the project's delivery
// shape; a template lays itself out differently in a tall frame.
export function renderTemplate(id, params = {}, { format = "landscape", full } = {}) {
  const template = TEMPLATES[id];
  if (!template) throw new Error(`unknown template "${id}"; describe_templates lists ${TEMPLATE_IDS.join(", ")}`);
  const checked = checkParams(template, params ?? {}, id);
  const portrait = format === "vertical";
  // A column card in a tall film is a strip under the head, not a column.
  const strip = portrait && !(full ?? template.full);
  const { html, css } = template.render(checked, { portrait, format, strip });
  return {
    kind: "custom",
    template: id,
    params: checked,
    full: full ?? template.full,
    html,
    css,
  };
}

// A graphic as the assistant wrote it, with any template expanded. A custom
// graphic naming a template is replaced by what the template renders; every
// other graphic passes through untouched. `full` given beside the template
// wins over the template's own default.
export function expandTemplate(graphic, context) {
  if (!graphic || graphic.kind !== "custom" || !graphic.template) return graphic;
  const rendered = renderTemplate(graphic.template, graphic.params ?? {}, { ...context, full: graphic.full });
  return graphic.over === undefined ? rendered : { ...rendered, over: graphic.over };
}

export function expandTemplates(scenes, context) {
  return scenes.map((scene) => (scene?.graphic?.template ? { ...scene, graphic: expandTemplate(scene.graphic, context) } : scene));
}

// A plan as a reader takes it up. The html and css stored beside a template's
// params are what the template rendered when the plan was written; the
// template may have been improved since, and the picture should be the
// template as it is now, not as it was. Everything else on the graphic
// (`over`, a label) stays. A template that no longer accepts its stored
// params keeps the stored rendering rather than losing the scene.
export function refreshTemplates(scenes, context) {
  return scenes.map((scene) => {
    const graphic = scene?.graphic;
    if (!graphic || graphic.kind !== "custom" || !graphic.template) return scene;
    try {
      return { ...scene, graphic: { ...graphic, ...renderTemplate(graphic.template, graphic.params ?? {}, { ...context, full: graphic.full }) } };
    } catch {
      return scene;
    }
  });
}
