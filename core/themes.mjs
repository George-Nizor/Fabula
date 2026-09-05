// The look of the film: a preset gives every token a value, the project's
// theme overrides what it cares about (an accent, a logo, a caption style),
// and everything downstream — the window's stage, the export's plates, the
// chunk cache key — reads the resolved result. No I/O. Consistent branding
// is one object, set once, by hand in the inspector or by an agent over
// set_theme.

export const PRESETS = {
  studio: {
    label: "Studio",
    about: "Charcoal field, terracotta accent, a warm light drifting across it. The suite's own look.",
    accent: "#d97757", accent2: "#f28a32",
    field: ["#1a2129", "#12171e", "#0b0e12"], fieldStyle: "radial",
    text: "#f0ede6", muted: "#9aa3ad", ink: "#0b0e12",
    card: "rgba(11, 14, 18, 0.88)", cardBorderAlpha: 0.45, cardBlur: 0,
    radius: 1, glow: 0.07,
    fonts: { display: "Inter", body: "Inter", serif: "Source Serif 4" },
    titleStyle: "rise", calloutStyle: "pill", captionStyle: "pill", titleCase: "none",
  },
  broadcast: {
    label: "Broadcast",
    about: "Near-black field, solid accent blocks, heavy uppercase type, banded captions. Built for YouTube.",
    accent: "#e63946", accent2: "#ffffff",
    field: ["#171717", "#0e0e0e", "#050505"], fieldStyle: "radial",
    text: "#ffffff", muted: "#a8a8a8", ink: "#0a0a0a",
    card: "rgba(10, 10, 10, 0.92)", cardBorderAlpha: 0, cardBlur: 0,
    radius: 0.5, glow: 0.05,
    fonts: { display: "Inter", body: "Inter", serif: "Inter" },
    titleStyle: "block", calloutStyle: "tag", captionStyle: "band", titleCase: "upper",
  },
  paper: {
    label: "Paper",
    about: "Warm paper, ink type, serif titles, sticky-note callouts. The editorial look.",
    accent: "#d97757", accent2: "#3e83f8",
    field: ["#fffdf8", "#faf9f5", "#ebe7dc"], fieldStyle: "radial",
    text: "#1f1e1d", muted: "#6e6b63", ink: "#faf9f5",
    card: "rgba(255, 255, 255, 0.92)", cardBorderAlpha: 0.35, cardBlur: 0,
    radius: 1, glow: 0.12,
    fonts: { display: "Fraunces", body: "Source Serif 4", serif: "Fraunces" },
    titleStyle: "rise", calloutStyle: "note", captionStyle: "pill", titleCase: "none",
  },
  neon: {
    label: "Neon",
    about: "Deep violet field, a cyan second accent, gradient type, glass cards, karaoke captions.",
    accent: "#9a72ea", accent2: "#59d9f2",
    field: ["#1c1030", "#100a1e", "#07050f"], fieldStyle: "radial",
    text: "#f4f1ff", muted: "#a79ec4", ink: "#07050f",
    card: "rgba(255, 255, 255, 0.07)", cardBorderAlpha: 0.5, cardBlur: 18,
    radius: 1.4, glow: 0.18,
    fonts: { display: "Space Grotesk", body: "Space Grotesk", serif: "Fraunces" },
    titleStyle: "slam", calloutStyle: "tag", captionStyle: "karaoke", titleCase: "none",
  },
  mono: {
    label: "Mono",
    about: "White field, black type, no glow, square corners, typewriter titles. The quiet one.",
    accent: "#111111", accent2: "#d97757",
    field: ["#ffffff", "#ffffff", "#f2f2f2"], fieldStyle: "flat",
    text: "#111111", muted: "#6b6b6b", ink: "#ffffff",
    card: "rgba(255, 255, 255, 0.96)", cardBorderAlpha: 0.9, cardBlur: 0,
    radius: 0, glow: 0,
    fonts: { display: "Inter", body: "Inter", serif: "Fraunces" },
    titleStyle: "typewriter", calloutStyle: "stamp", captionStyle: "band", titleCase: "none",
  },
};

export const TITLE_STYLES = new Set(["rise", "slam", "typewriter", "wipe", "block"]);
export const CALLOUT_STYLES = new Set(["pill", "tag", "stamp", "note"]);
export const CAPTION_STYLES = new Set(["pill", "band", "karaoke", "none"]);
export const CORNERS = new Set(["br", "bl", "tr", "tl"]);
export const VENDORED_FONTS = ["Inter", "Space Grotesk", "Fraunces", "Source Serif 4"];

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
  }));
}
