// The look of the film: a preset gives every token a value, the project's
// theme overrides what it cares about (an accent, a logo, a caption style),
// and everything downstream — the window's stage, the export's plates, the
// chunk cache key — reads the resolved result. No I/O. Consistent branding
// is one object, set once, by hand in the inspector or by an agent over
// set_theme.

export const PRESETS = {
  studio: {
    label: "Studio",
    about: "Charcoal field, terracotta accent, serif titles, pill captions. The suite's own look.",
    accent: "#d97757", accent2: "#f28a32",
    field: ["#1a2129", "#12171e", "#0b0e12"], fieldStyle: "radial",
    text: "#f0ede6", muted: "#9aa3ad", ink: "#0b0e12",
    card: "rgba(11, 14, 18, 0.88)", cardBorderAlpha: 0.45, cardBlur: 0,
    radius: 1, glow: 0.07,
    fonts: { display: "Inter", body: "Inter", serif: "Source Serif 4" },
    titleStyle: "rise", calloutStyle: "pill", captionStyle: "pill", titleCase: "none", transition: "glide",
  },
  broadcast: {
    label: "Broadcast",
    about: "Near-black field, red accent, uppercase block titles, banded captions. Hard cuts, for news and YouTube.",
    accent: "#e63946", accent2: "#ffffff",
    field: ["#171717", "#0e0e0e", "#050505"], fieldStyle: "radial",
    text: "#ffffff", muted: "#a8a8a8", ink: "#0a0a0a",
    card: "rgba(10, 10, 10, 0.92)", cardBorderAlpha: 0, cardBlur: 0,
    radius: 0.5, glow: 0.05,
    fonts: { display: "Inter", body: "Inter", serif: "Inter" },
    titleStyle: "block", calloutStyle: "tag", captionStyle: "band", titleCase: "upper", transition: "cut",
  },
  paper: {
    label: "Paper",
    about: "Light paper field, dark type, serif titles, note callouts. The editorial look; layouts dissolve.",
    accent: "#d97757", accent2: "#3e83f8",
    field: ["#fffdf8", "#faf9f5", "#ebe7dc"], fieldStyle: "radial",
    text: "#1f1e1d", muted: "#6e6b63", ink: "#faf9f5",
    card: "rgba(255, 255, 255, 0.92)", cardBorderAlpha: 0.35, cardBlur: 0,
    radius: 1, glow: 0.12,
    fonts: { display: "Fraunces", body: "Source Serif 4", serif: "Fraunces" },
    titleStyle: "rise", calloutStyle: "note", captionStyle: "pill", titleCase: "none", transition: "dissolve",
  },
  neon: {
    label: "Neon",
    about: "Violet field, cyan second accent, gradient type, karaoke captions.",
    accent: "#9a72ea", accent2: "#59d9f2",
    field: ["#1c1030", "#100a1e", "#07050f"], fieldStyle: "radial",
    text: "#f4f1ff", muted: "#a79ec4", ink: "#07050f",
    card: "rgba(255, 255, 255, 0.07)", cardBorderAlpha: 0.5, cardBlur: 18,
    radius: 1.4, glow: 0.18,
    fonts: { display: "Space Grotesk", body: "Space Grotesk", serif: "Fraunces" },
    titleStyle: "slam", calloutStyle: "tag", captionStyle: "karaoke", titleCase: "none", transition: "glide",
  },
  mono: {
    label: "Mono",
    about: "White field, black type, square corners, typewriter titles. The quiet one.",
    accent: "#111111", accent2: "#d97757",
    field: ["#ffffff", "#ffffff", "#f2f2f2"], fieldStyle: "flat",
    text: "#111111", muted: "#6b6b6b", ink: "#ffffff",
    card: "rgba(255, 255, 255, 0.96)", cardBorderAlpha: 0.9, cardBlur: 0,
    radius: 0, glow: 0,
    fonts: { display: "Inter", body: "Inter", serif: "Fraunces" },
    titleStyle: "typewriter", calloutStyle: "stamp", captionStyle: "band", titleCase: "none", transition: "cut",
  },
  ink: {
    label: "Ink",
    about: "Newsprint white, black Playfair headlines, a single red rule. Print, moving.",
    accent: "#c02026", accent2: "#1a1a1a",
    field: ["#ffffff", "#fbfaf7", "#efece4"], fieldStyle: "flat",
    text: "#141414", muted: "#6d6a63", ink: "#fbfaf7",
    card: "rgba(255, 255, 255, 0.97)", cardBorderAlpha: 0.8, cardBlur: 0,
    radius: 0, glow: 0,
    fonts: { display: "Playfair Display", body: "Source Serif 4", serif: "Playfair Display" },
    titleStyle: "underline", calloutStyle: "bar", captionStyle: "plain", titleCase: "none", transition: "dissolve",
  },
  slate: {
    label: "Slate",
    about: "Cool graphite, a confident blue, Archivo throughout. The default for anything explaining work.",
    accent: "#3e83f8", accent2: "#8ab4ff",
    field: ["#232b36", "#171d26", "#0d1218"], fieldStyle: "radial",
    text: "#eef2f7", muted: "#93a1b3", ink: "#0d1218",
    card: "rgba(13, 18, 24, 0.9)", cardBorderAlpha: 0.4, cardBlur: 0,
    radius: 0.8, glow: 0.08,
    fonts: { display: "Archivo", body: "Inter", serif: "Source Serif 4" },
    titleStyle: "boxed", calloutStyle: "bar", captionStyle: "pill", titleCase: "none", transition: "glide",
  },
  signal: {
    label: "Signal",
    about: "Deep navy, a hazard yellow, everything upper case. Loud, for short and punchy.",
    accent: "#ffd21e", accent2: "#ff6b35",
    field: ["#16243f", "#0d1729", "#060b15"], fieldStyle: "radial",
    text: "#ffffff", muted: "#9fb0c9", ink: "#060b15",
    card: "rgba(6, 11, 21, 0.9)", cardBorderAlpha: 0.6, cardBlur: 0,
    radius: 0.3, glow: 0.14,
    fonts: { display: "Archivo", body: "Archivo", serif: "Archivo" },
    titleStyle: "slam", calloutStyle: "stamp", captionStyle: "band", titleCase: "upper", transition: "cut",
  },
  dawn: {
    label: "Dawn",
    about: "Warm cream and clay, DM Sans, soft edges. Friendly; good for teaching.",
    accent: "#e07a3f", accent2: "#5b8266",
    field: ["#fdf6ec", "#f8efe2", "#eadfcd"], fieldStyle: "radial",
    text: "#2a2119", muted: "#7d6f5e", ink: "#f8efe2",
    card: "rgba(255, 252, 246, 0.94)", cardBorderAlpha: 0.3, cardBlur: 0,
    radius: 1.6, glow: 0.13,
    fonts: { display: "DM Sans", body: "DM Sans", serif: "Fraunces" },
    titleStyle: "kicker", calloutStyle: "bubble", captionStyle: "pill", titleCase: "none", transition: "glide",
  },
  terminal: {
    label: "Terminal",
    about: "Black, phosphor green, JetBrains Mono, square everything. For anything technical.",
    accent: "#3ddc84", accent2: "#7ee787",
    field: ["#0d1117", "#080b10", "#000000"], fieldStyle: "flat",
    text: "#d7e3d7", muted: "#6e8271", ink: "#000000",
    card: "rgba(0, 0, 0, 0.85)", cardBorderAlpha: 0.7, cardBlur: 0,
    radius: 0, glow: 0.05,
    fonts: { display: "JetBrains Mono", body: "JetBrains Mono", serif: "JetBrains Mono" },
    titleStyle: "typewriter", calloutStyle: "bar", captionStyle: "plain", titleCase: "none", transition: "cut",
  },
  bloom: {
    label: "Bloom",
    about: "Plum to rose, glassy cards, DM Sans. Soft and modern; lifestyle and product.",
    accent: "#ef5da8", accent2: "#8b5cf6",
    field: ["#2c1435", "#1c0d24", "#0d0612"], fieldStyle: "radial",
    text: "#fbeef7", muted: "#b79ec0", ink: "#0d0612",
    card: "rgba(255, 255, 255, 0.08)", cardBorderAlpha: 0.45, cardBlur: 22,
    radius: 1.8, glow: 0.2,
    fonts: { display: "DM Sans", body: "DM Sans", serif: "Playfair Display" },
    titleStyle: "rise", calloutStyle: "bubble", captionStyle: "pill", titleCase: "none", transition: "glide",
  },
  pastel: {
    label: "Pastel",
    about: "Mint field, deep teal type, boxed titles. Light without being a document.",
    accent: "#0f8f7f", accent2: "#f2994a",
    field: ["#f2fbf7", "#e8f6f0", "#d5ece2"], fieldStyle: "radial",
    text: "#123b35", muted: "#5f8079", ink: "#e8f6f0",
    card: "rgba(255, 255, 255, 0.9)", cardBorderAlpha: 0.3, cardBlur: 0,
    radius: 1.5, glow: 0.1,
    fonts: { display: "DM Sans", body: "DM Sans", serif: "Source Serif 4" },
    titleStyle: "boxed", calloutStyle: "pill", captionStyle: "pill", titleCase: "none", transition: "glide",
  },
};

import { TRANSITIONS, TRANSITION_SECONDS, MIN_TRANSITION_SECONDS, MAX_TRANSITION_SECONDS } from "./stage-engine.mjs";

export { TRANSITIONS, MIN_TRANSITION_SECONDS, MAX_TRANSITION_SECONDS };
export const TITLE_STYLES = new Set(["rise", "slam", "typewriter", "wipe", "block", "underline", "boxed", "kicker"]);
export const CALLOUT_STYLES = new Set(["pill", "tag", "stamp", "note", "bar", "bubble"]);
export const CAPTION_STYLES = new Set(["pill", "band", "karaoke", "plain", "none"]);
export const CORNERS = new Set(["br", "bl", "tr", "tl"]);
export const VENDORED_FONTS = ["Inter", "Space Grotesk", "Archivo", "DM Sans", "JetBrains Mono", "Fraunces", "Playfair Display", "Source Serif 4"];

const COLOR = /^#[0-9a-fA-F]{6}$/;
const between = (v, lo, hi) => typeof v === "number" && v >= lo && v <= hi;

function assetPath(p) {
  return typeof p === "string" && /\.(png|jpe?g|webp)$/i.test(p) && !p.includes("..") && !p.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(p);
}

// The project's theme as written: a preset name plus overrides. Everything
// optional; an empty object is the studio preset.
export function validateTheme(theme) {
  if (theme === undefined || theme === null) return;
  if (typeof theme !== "object") throw new Error("theme must be an object");
  if (theme.preset !== undefined && !PRESETS[theme.preset]) throw new Error(`unknown theme preset "${theme.preset}"; one of ${Object.keys(PRESETS).join(", ")}`);
  for (const key of ["accent", "accent2", "text"]) {
    if (theme[key] !== undefined && !COLOR.test(theme[key])) throw new Error(`theme ${key} must be #rrggbb, got "${theme[key]}"`);
  }
  if (theme.fonts !== undefined) {
    if (typeof theme.fonts !== "object") throw new Error("theme fonts must be { display?, body? }");
    for (const key of ["display", "body", "serif"]) {
      if (theme.fonts[key] !== undefined && (typeof theme.fonts[key] !== "string" || theme.fonts[key].length === 0)) throw new Error(`theme fonts.${key} must be a font family name`);
    }
  }
  if (theme.titleStyle !== undefined && !TITLE_STYLES.has(theme.titleStyle)) throw new Error(`theme titleStyle must be one of ${[...TITLE_STYLES].join(", ")}`);
  if (theme.calloutStyle !== undefined && !CALLOUT_STYLES.has(theme.calloutStyle)) throw new Error(`theme calloutStyle must be one of ${[...CALLOUT_STYLES].join(", ")}`);
  if (theme.captionStyle !== undefined && !CAPTION_STYLES.has(theme.captionStyle)) throw new Error(`theme captionStyle must be one of ${[...CAPTION_STYLES].join(", ")}`);
  if (theme.titleCase !== undefined && !["none", "upper"].includes(theme.titleCase)) throw new Error("theme titleCase must be none or upper");
  if (theme.transition !== undefined && !TRANSITIONS.has(theme.transition)) throw new Error(`theme transition must be one of ${[...TRANSITIONS].join(", ")}`);
  if (theme.transitionSeconds !== undefined && theme.transitionSeconds !== null && !between(theme.transitionSeconds, MIN_TRANSITION_SECONDS, MAX_TRANSITION_SECONDS)) {
    throw new Error(`theme transitionSeconds must be ${MIN_TRANSITION_SECONDS}–${MAX_TRANSITION_SECONDS}`);
  }
  if (theme.glow !== undefined && !between(theme.glow, 0, 0.4)) throw new Error("theme glow must be 0–0.4");
  if (theme.radius !== undefined && !between(theme.radius, 0, 2)) throw new Error("theme radius must be 0–2");
  if (theme.logo !== undefined && theme.logo !== null) {
    const logo = theme.logo;
    if (typeof logo !== "object" || !assetPath(logo.src)) throw new Error("theme logo needs a project-relative png/jpg/webp src, e.g. assets/logo.png");
    if (logo.corner !== undefined && !CORNERS.has(logo.corner)) throw new Error("theme logo corner must be br, bl, tr or tl");
    if (logo.size !== undefined && !between(logo.size, 0.04, 0.3)) throw new Error("theme logo size is a share of the stage width, 0.04–0.3");
    if (logo.opacity !== undefined && !between(logo.opacity, 0.1, 1)) throw new Error("theme logo opacity must be 0.1–1");
  }
  if (theme.watermark !== undefined && theme.watermark !== null && (typeof theme.watermark !== "string" || theme.watermark.length > 40)) {
    throw new Error("theme watermark must be a short text (a handle, a site), up to 40 characters");
  }
}

// Preset plus overrides, every token present. What the stage, the export
// and the cache key consume.
export function resolveTheme(theme) {
  validateTheme(theme);
  const preset = PRESETS[theme?.preset ?? "studio"];
  const resolved = {
    preset: theme?.preset ?? "studio",
    accent: theme?.accent ?? preset.accent,
    accent2: theme?.accent2 ?? preset.accent2,
    field: preset.field,
    fieldStyle: preset.fieldStyle,
    text: theme?.text ?? preset.text,
    muted: preset.muted,
    ink: preset.ink,
    card: preset.card,
    cardBorderAlpha: preset.cardBorderAlpha,
    cardBlur: preset.cardBlur,
    radius: theme?.radius ?? preset.radius,
    glow: theme?.glow ?? preset.glow,
    fonts: { ...preset.fonts, ...(theme?.fonts ?? {}) },
    titleStyle: theme?.titleStyle ?? preset.titleStyle,
    calloutStyle: theme?.calloutStyle ?? preset.calloutStyle,
    captionStyle: theme?.captionStyle ?? preset.captionStyle,
    titleCase: theme?.titleCase ?? preset.titleCase,
    transition: theme?.transition ?? preset.transition,
    // Null is a real answer here — "the style's own pace" — so the token is
    // always present and the resolved theme never hides the difference.
    transitionSeconds: theme?.transitionSeconds ?? preset.transitionSeconds ?? TRANSITION_SECONDS[theme?.transition ?? preset.transition] ?? 0,
    logo: theme?.logo ? { src: theme.logo.src, corner: theme.logo.corner ?? "tr", size: theme.logo.size ?? 0.09, opacity: theme.logo.opacity ?? 0.9 } : null,
    watermark: theme?.watermark ?? null,
  };
  return resolved;
}

// The presets as a menu: what an agent or the inspector lists.
export function describePresets() {
  return Object.entries(PRESETS).map(([id, p]) => ({
    id, label: p.label, about: p.about, accent: p.accent, accent2: p.accent2,
    fonts: p.fonts, titleStyle: p.titleStyle, calloutStyle: p.calloutStyle, captionStyle: p.captionStyle,
    transition: p.transition, transitionSeconds: p.transitionSeconds ?? TRANSITION_SECONDS[p.transition] ?? 0,
    field: p.field, fieldStyle: p.fieldStyle, text: p.text, radius: p.radius, glow: p.glow, titleCase: p.titleCase,
  }));
}

// Has anyone chosen the look, or is this just the default?
//
// resolveTheme fills every token from the studio preset when nothing is set,
// so a project with no look at all reads as a fully specified one. Every tool
// that reports the look says which of the two it is, because "the look is
// already decided" is exactly the wrong thing for an assistant to assume.
export function describeLook(themeConfig, savedBrands = []) {
  const config = themeConfig ?? {};
  const overrides = Object.keys(config).filter((key) => config[key] !== undefined && config[key] !== null);
  const chosen = overrides.length > 0;
  const resolved = resolveTheme(config);
  const brands = savedBrands.map((brand) => ({ id: brand.id, name: brand.name }));
  const look = {
    chosen,
    preset: resolved.preset,
    accent: resolved.accent,
    captionStyle: resolved.captionStyle,
    transition: resolved.transition,
    logo: Boolean(resolved.logo),
    savedBrands: brands,
  };
  if (!chosen) {
    look.hint = brands.length
      ? `No look has been chosen; the film would render in the default ${resolved.preset} preset. This person has saved ${brands.length === 1 ? "a brand" : "brands"}: ${brands.map((b) => `${b.name} (${b.id})`).join(", ")}. Ask whether the film uses one — set_theme with use: "<id>" — before planning scenes.`
      : `No look has been chosen; the film would render in the default ${resolved.preset} preset. Ask what the film is for and set_theme (list_themes shows the presets) before planning scenes.`;
  }
  return look;
}
