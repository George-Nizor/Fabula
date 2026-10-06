// Fabula's interface icons in the Instrumenta brand v2 style (Instrumenta brand/ALIGNMENT.md): a
// flat, friendly drawing on a 48-unit grid with a dark ink outline and a stepped extrusion down and
// to the right, no container behind it. The renderer is the suite's own algorithm, as Forge3D has
// it in desktop/src/renderer/brand-icons/forge-icons.mjs (itself Discere's); folder, open, copy,
// send, done, alert, failed, trash, stop, page and refresh are Forge3D's drawings unchanged. The
// rest, and the meaning-hues, are Fabula's. README.md beside this file has the table.
//
// A classic script, like the rest of the renderer: in the page it is window.FabulaIcons, in Node
// (the tests) a CommonJS module. Output is presentation attributes and classes only: no style="",
// no <script>, no href. Motion lives in fabula-icons.css and keys off the fm-* classes left on
// the drawn parts.
(function expose(root, factory) {
  const icons = factory();
  if (typeof module === "object" && module.exports) module.exports = icons;
  else root.FabulaIcons = icons;
}(typeof self !== "undefined" ? self : this, () => {
  function oklchToHex(L, C, h) {
    const a = C * Math.cos((h * Math.PI) / 180);
    const b = C * Math.sin((h * Math.PI) / 180);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const lin = [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
    return `#${lin.map((x) => {
      const v = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.max(x, 0) ** (1 / 2.4) - 0.055;
      return Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
    }).join("").toUpperCase()}`;
  }

  // The suite formula: accent at OKLCH L .70 C .155; tint, deep shade and ink from the same hue.
  function colours(hue, chroma = 0.155) {
    return {
      accent: oklchToHex(0.7, chroma, hue),
      light: oklchToHex(0.86, Math.min(chroma, 0.09), hue),
      deep: oklchToHex(0.42, Math.min(chroma, 0.11), hue),
      ink: oklchToHex(0.2, 0.035, hue),
    };
  }

  // Meaning hues, never decoration. Coral is the exact fabula block of Instrumenta's
  // brand/tokens.json; stone is Forge3D's. Brick (hue 45) is the destructive and failed hue: the
  // suite's rose would sit on top of Fabula's own coral (hue 10), so danger moves toward orange.
  const HUES = {
    coral: { accent: "#ED7088", light: "#FFB9C3", deep: "#7D2E3F", ink: "#230F12" },
    green: colours(150),
    gold: colours(85),
    teal: colours(195),
    brick: colours(45),
    stone: { accent: "#A9A29A", light: "#D9D3CC", deep: "#4A443E", ink: "#171411" },
  };

  // Class tokens: f accent fill, f2 light fill, s ink stroke, thin lighter stroke, solid ink fill,
  // flat (not extruded), dt (detail dropped at 16 and 24 px), fm-* motion hooks.
  const RING = (cx, cy, r, hole) => `M${cx} ${cy - r}a${r} ${r} 0 1 0 .01 0ZM${cx} ${cy - hole}a${hole} ${hole} 0 1 0 .01 0Z`;
  const G = {
    // The four steps.
    scissors: { hue: "coral", d: `<path class="f2" d="M35 3C31 9 26 17 21.5 25.5L17 33 20 35 25.5 27C30.5 19.5 34 11 35 3Z"/><path class="s" d="M35 3C31 9 26 17 21.5 25.5L17 33 20 35 25.5 27C30.5 19.5 34 11 35 3Z"/><path class="f" fill-rule="evenodd" d="${RING(14.5, 38, 7, 3.4)}"/><path class="s" fill-rule="evenodd" d="${RING(14.5, 38, 7, 3.4)}"/><g class="fm-snip"><path class="f2" d="M13 3C17 9 22 17 26.5 25.5L31 33 28 35 22.5 27C17.5 19.5 14 11 13 3Z"/><path class="s" d="M13 3C17 9 22 17 26.5 25.5L31 33 28 35 22.5 27C17.5 19.5 14 11 13 3Z"/><path class="f" fill-rule="evenodd" d="${RING(33.5, 38, 7, 3.4)}"/><path class="s" fill-rule="evenodd" d="${RING(33.5, 38, 7, 3.4)}"/></g><circle class="solid" cx="24" cy="25.6" r="2"/>` },
    palette: { hue: "coral", d: '<path class="f" fill-rule="evenodd" d="M24 5C12 5 4 13 4 23C4 32 11 40 20 40C24 40 25.5 37 24 34 22.5 31 24.5 28 29 28H35C41 28 44 24 44 19 44 11 35 5 24 5ZM14.5 25.5A3.5 3.5 0 1 0 14.51 25.5Z"/><path class="s" fill-rule="evenodd" d="M24 5C12 5 4 13 4 23C4 32 11 40 20 40C24 40 25.5 37 24 34 22.5 31 24.5 28 29 28H35C41 28 44 24 44 19 44 11 35 5 24 5ZM14.5 25.5A3.5 3.5 0 1 0 14.51 25.5Z"/><circle class="f2" cx="13.5" cy="16" r="3.4"/><circle class="s thin" cx="13.5" cy="16" r="3.4"/><circle class="f2" cx="23" cy="11.5" r="3.4"/><circle class="s thin" cx="23" cy="11.5" r="3.4"/><circle class="solid" cx="33" cy="15" r="3.4"/>' },
    scenes: { hue: "coral", d: '<rect class="f2" x="14" y="4" width="30" height="21" rx="2.5"/><rect class="s" x="14" y="4" width="30" height="21" rx="2.5"/><rect class="f" x="9" y="11" width="30" height="21" rx="2.5"/><rect class="s" x="9" y="11" width="30" height="21" rx="2.5"/><rect class="f2" x="4" y="19" width="30" height="22" rx="2.5"/><rect class="s" x="4" y="19" width="30" height="22" rx="2.5"/><path class="s thin" d="M9.5 27H25M9.5 33H19"/>' },
    reel: { hue: "coral", d: '<rect class="f2" x="26" y="35" width="19" height="8" rx="1.5"/><rect class="s" x="26" y="35" width="19" height="8" rx="1.5"/><g class="fm-spin"><circle class="f" cx="21" cy="22" r="17"/><circle class="s" cx="21" cy="22" r="17"/><circle class="f2" cx="21" cy="12.2" r="4"/><circle class="s thin" cx="21" cy="12.2" r="4"/><circle class="f2" cx="30.3" cy="19" r="4"/><circle class="s thin" cx="30.3" cy="19" r="4"/><circle class="f2" cx="26.8" cy="30" r="4"/><circle class="s thin" cx="26.8" cy="30" r="4"/><circle class="f2" cx="15.2" cy="30" r="4"/><circle class="s thin" cx="15.2" cy="30" r="4"/><circle class="f2" cx="11.7" cy="19" r="4"/><circle class="s thin" cx="11.7" cy="19" r="4"/><circle class="solid" cx="21" cy="22" r="2.2"/></g>' },
    // The assistant and what it makes.
    spark: { hue: "coral", d: '<g class="fm-twinkle"><path class="f" d="M21 4C22.6 14 25 16.6 36 18.5 25 20.4 22.6 23 21 33 19.4 23 17 20.4 6 18.5 17 16.6 19.4 14 21 4Z"/><path class="s" d="M21 4C22.6 14 25 16.6 36 18.5 25 20.4 22.6 23 21 33 19.4 23 17 20.4 6 18.5 17 16.6 19.4 14 21 4Z"/></g><path class="f2" d="M36 26C36.8 31 37.9 32.2 43 33 37.9 33.8 36.8 35 36 40 35.2 35 34.1 33.8 29 33 34.1 32.2 35.2 31 36 26Z"/><path class="s" d="M36 26C36.8 31 37.9 32.2 43 33 37.9 33.8 36.8 35 36 40 35.2 35 34.1 33.8 29 33 34.1 32.2 35.2 31 36 26Z"/>' },
    wand: { hue: "coral", d: '<path class="f" d="M7 39 28 18 32 22 11 43Z"/><path class="s" d="M7 39 28 18 32 22 11 43Z"/><path class="f2 flat" d="M24 22 28 18 32 22 28 26Z"/><path class="s thin flat" d="M24 22 28 18 32 22 28 26Z"/><g class="fm-twinkle"><path class="f2" d="M37 3C37.9 8.6 39.4 10.1 45 11 39.4 11.9 37.9 13.4 37 19 36.1 13.4 34.6 11.9 29 11 34.6 10.1 36.1 8.6 37 3Z"/><path class="s" d="M37 3C37.9 8.6 39.4 10.1 45 11 39.4 11.9 37.9 13.4 37 19 36.1 13.4 34.6 11.9 29 11 34.6 10.1 36.1 8.6 37 3Z"/></g><circle class="solid flat dt" cx="21" cy="9" r="1.7"/><circle class="solid flat dt" cx="42" cy="28" r="1.7"/>' },
    play: { hue: "coral", d: '<path class="f" d="M12 7 41 24 12 41Z"/><path class="s" d="M12 7 41 24 12 41Z"/><path class="s thin flat dt" d="M17 16V21"/>' },
    camera: { hue: "coral", d: '<circle class="f2" cx="11" cy="9" r="5.5"/><circle class="s" cx="11" cy="9" r="5.5"/><circle class="f2" cx="24" cy="9" r="5.5"/><circle class="s" cx="24" cy="9" r="5.5"/><path class="f2" d="M31 22 44 15V37L31 30Z"/><path class="s" d="M31 22 44 15V37L31 30Z"/><rect class="f" x="4" y="15" width="29" height="23" rx="3"/><rect class="s" x="4" y="15" width="29" height="23" rx="3"/><circle class="solid" cx="11" cy="22" r="2.2"/><path class="s thin dt" d="M17 31H27"/>' },
    phone: { hue: "coral", d: '<rect class="f" x="12" y="3" width="24" height="42" rx="4"/><rect class="s" x="12" y="3" width="24" height="42" rx="4"/><rect class="f2" x="16" y="9" width="16" height="27" rx="1.5"/><rect class="s thin" x="16" y="9" width="16" height="27" rx="1.5"/><circle class="solid" cx="24" cy="40.5" r="1.9"/><path class="s thin flat dt" d="M21 18 28 22.5 21 27Z"/>' },
    badge: { hue: "coral", d: '<path class="f2" d="M16 26 11 44 17.5 40.5 21.5 46 25 30Z"/><path class="s" d="M16 26 11 44 17.5 40.5 21.5 46 25 30Z"/><path class="f2" d="M32 26 37 44 30.5 40.5 26.5 46 23 30Z"/><path class="s" d="M32 26 37 44 30.5 40.5 26.5 46 23 30Z"/><circle class="f" cx="24" cy="19" r="14"/><circle class="s" cx="24" cy="19" r="14"/><path class="f2 fm-tick" d="M24 11.5 26.2 16.3 31.4 16.8 27.5 20.3 28.6 25.4 24 22.8 19.4 25.4 20.5 20.3 16.6 16.8 21.8 16.3Z"/><path class="s thin" d="M24 11.5 26.2 16.3 31.4 16.8 27.5 20.3 28.6 25.4 24 22.8 19.4 25.4 20.5 20.3 16.6 16.8 21.8 16.3Z"/>' },
    pencil: { hue: "coral", d: '<path class="f2" d="M34 6 38 2 46 10 42 14Z"/><path class="s" d="M34 6 38 2 46 10 42 14Z"/><path class="f" d="M34 6 42 14 17 39 9 31Z"/><path class="s" d="M34 6 42 14 17 39 9 31Z"/><path class="f2" d="M9 31 17 39 5 43Z"/><path class="s" d="M9 31 17 39 5 43Z"/><path class="s thin dt" d="M13 35 38 10"/>' },
    undo: { hue: "coral", d: '<path class="f" d="M15 13H29C37.5 13 43 19 43 26.5S37.5 40 29 40H17V33H29C33.5 33 36 30 36 26.5S33.5 20 29 20H15Z"/><path class="s" d="M15 13H29C37.5 13 43 19 43 26.5S37.5 40 29 40H17V33H29C33.5 33 36 30 36 26.5S33.5 20 29 20H15Z"/><path class="f2" d="M4 16.5 16 6V27Z"/><path class="s" d="M4 16.5 16 6V27Z"/>' },
    hourglass: { hue: "coral", d: '<path class="f2" d="M13 10H35C35 17 29 21 26 24 29 27 35 31 35 38H13C13 31 19 27 22 24 19 21 13 17 13 10Z"/><path class="s" d="M13 10H35C35 17 29 21 26 24 29 27 35 31 35 38H13C13 31 19 27 22 24 19 21 13 17 13 10Z"/><path class="f flat" d="M17.5 14H30.5C29.5 18 26 20 24 22 22 20 18.5 18 17.5 14Z"/><path class="f flat" d="M15.5 35.5C16.5 31 21 29.5 24 29 27 29.5 31.5 31 32.5 35.5Z"/><rect class="f" x="8" y="4" width="32" height="6.5" rx="2"/><rect class="s" x="8" y="4" width="32" height="6.5" rx="2"/><rect class="f" x="8" y="37.5" width="32" height="6.5" rx="2"/><rect class="s" x="8" y="37.5" width="32" height="6.5" rx="2"/>' },
    clock: { hue: "stone", d: '<circle class="f2" cx="24" cy="24" r="18"/><circle class="s" cx="24" cy="24" r="18"/><path class="s" d="M24 13V24L31 28.5"/>' },
    skipped: { hue: "stone", d: '<circle class="f2" cx="24" cy="24" r="18"/><circle class="s" cx="24" cy="24" r="18"/><path class="s" d="M15 24H33"/>' },
    // Forge3D's, unchanged but for the hue table above and fm- motion names.
    folder: { hue: "teal", d: '<path class="f" d="M4 9H18L22 14H44V41H4Z"/><path class="s" d="M4 9H18L22 14H44V41H4Z"/><path class="f2" d="M4 19H44V41H4Z"/><path class="s" d="M4 19H44V41H4Z"/>' },
    open: { hue: "teal", d: '<path class="f" d="M24 6 36 19H29V30H19V19H12Z"/><path class="s" d="M24 6 36 19H29V30H19V19H12Z"/><path class="s" d="M8 31V39A2 2 0 0 0 10 41H38A2 2 0 0 0 40 39V31"/>' },
    copy: { hue: "coral", d: '<rect class="f2" x="8" y="6" width="22" height="28" rx="3"/><rect class="s" x="8" y="6" width="22" height="28" rx="3"/><rect class="f" x="18" y="14" width="22" height="28" rx="3"/><rect class="s" x="18" y="14" width="22" height="28" rx="3"/><path class="s thin" d="M24 24H34M24 30H34"/>' },
    send: { hue: "coral", d: '<path class="f" d="M6 9 42 24 6 39 12 24Z"/><path class="s" d="M6 9 42 24 6 39 12 24Z"/><path class="s thin" d="M12 24H27"/>' },
    page: { hue: "coral", d: '<path class="f2" d="M9 4H30L40 14V44H9Z"/><path class="s" d="M9 4H30L40 14V44H9Z"/><path class="f" d="M30 4V14H40Z"/><path class="s" d="M30 4V14H40Z"/><path class="s thin" d="M15 22H34M15 29H34M15 36H27"/>' },
    refresh: { hue: "coral", d: '<path class="f" d="M8 18A16 16 0 0 1 36 12L38 8 42 20 30 20 33 16A11 11 0 0 0 13 19Z"/><path class="s" d="M8 18A16 16 0 0 1 36 12L38 8 42 20 30 20 33 16A11 11 0 0 0 13 19Z"/><path class="f2" d="M40 30A16 16 0 0 1 12 36L10 40 6 28 18 28 15 32A11 11 0 0 0 35 29Z"/><path class="s" d="M40 30A16 16 0 0 1 12 36L10 40 6 28 18 28 15 32A11 11 0 0 0 35 29Z"/>' },
    done: { hue: "green", d: '<circle class="f" cx="24" cy="24" r="18"/><circle class="s" cx="24" cy="24" r="18"/><path class="s fm-tick" d="M15.5 24.5 21.5 30.5 33 18"/>' },
    alert: { hue: "gold", d: '<path class="f" d="M24 6 43 39H5Z"/><path class="s" d="M24 6 43 39H5Z"/><path class="s" d="M24 17V27"/><circle class="solid" cx="24" cy="32.5" r="1.8"/>' },
    failed: { hue: "brick", d: '<g class="fm-shake"><circle class="f" cx="24" cy="24" r="18"/><circle class="s" cx="24" cy="24" r="18"/><path class="s" d="M17.5 17.5 30.5 30.5M30.5 17.5 17.5 30.5"/></g>' },
    stop: { hue: "brick", d: '<rect class="f" x="9" y="9" width="30" height="30" rx="6"/><rect class="s" x="9" y="9" width="30" height="30" rx="6"/><rect class="f2" x="18" y="18" width="12" height="12" rx="2"/>' },
    trash: { hue: "brick", d: '<path class="f" d="M11 15H37L34 43H14Z"/><path class="s" d="M11 15H37L34 43H14Z"/><g class="fm-lid"><rect class="f2" x="7" y="9" width="34" height="6" rx="2"/><rect class="s" x="7" y="9" width="34" height="6" rx="2"/></g><path class="s thin" d="M19 9V5H29V9M20 21V37M28 21V37"/>' },
  };

  // Utilities that stay lines, on a 24 grid, in currentColor with round caps: the transport's play
  // and pause, the panel toggles, the theme toggle, and the small verbs.
  const LINES = {
    add: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.9-4.9"/>',
    panelLeft: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M9.5 4.5v15"/>',
    panelRight: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M14.5 4.5v15"/>',
    playSolid: '<path d="M7.5 5.2v13.6a.8.8 0 0 0 1.2.7l11-6.8a.8.8 0 0 0 0-1.4l-11-6.8a.8.8 0 0 0-1.2.7Z" fill="currentColor"/>',
    pauseSolid: '<rect x="6" y="5" width="4.2" height="14" rx="1.2" fill="currentColor"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.2" fill="currentColor"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>',
    moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>',
    monitor: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16.5V20"/>',
  };

  const TIERS = {
    full: { steps: 6, dx: 0.5, dy: 0.55, line: 2.3, thin: 1.7, depthLine: 3.2, details: true },
    medium: { steps: 3, dx: 0.85, dy: 0.95, line: 2.8, thin: 2.1, depthLine: 3.4, details: false },
    small: { steps: 2, dx: 1.1, dy: 1.25, line: 3.4, thin: 2.6, depthLine: 3.6, details: false },
  };
  const tierFor = (size) => (size && size <= 16 ? "small" : size && size <= 24 ? "medium" : "full");
  const TAG = /<(\/?)(g|rect|path|circle|ellipse)\b([^>]*?)(\/?)>/g;

  function paint(markup, look) {
    return markup.replace(TAG, (whole, closing, tag, attrs, selfClose) => {
      if (closing) return whole;
      const m = attrs.match(/\sclass="([^"]*)"/);
      const tokens = m && m[1] ? m[1].split(/\s+/) : [];
      const rest = attrs.replace(/\sclass="[^"]*"/, "");
      const motion = tokens.filter((t) => /^fm-/.test(t));
      const extra = look(tag, tokens);
      if (extra === null) return "";
      const cls = motion.length ? ` class="${motion.join(" ")}"` : "";
      return `<${tag}${cls}${rest}${extra}${selfClose ? "/" : ""}>`;
    });
  }
  const dropDetails = (s) => s.replace(/<(rect|path|circle|ellipse)\b[^>]*\bclass="[^"]*\bdt\b[^"]*"[^>]*\/>/g, "");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  /**
   * render(name, { size, hue, label, tier, state }) returns an SVG string.
   * size: pixels (default 24). hue: coral|green|gold|teal|brick|stone, overriding the glyph's own.
   * label: accessible name; without one the icon is aria-hidden. tier: force full|medium|small.
   * state: "playing" for a one-shot motion moment (fabula-icons.css).
   */
  function render(name, options = {}) {
    const size = options.size || 24;
    const label = options.label ? ` role="img" aria-label="${esc(options.label)}"` : ' aria-hidden="true"';
    const extra = options.state === "playing" ? " is-playing" : "";
    if (LINES[name]) {
      return `<svg class="fi fi-line fi-${name}${extra}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${label}>${LINES[name]}</svg>`;
    }
    const glyph = G[name];
    if (!glyph) throw new Error(`Unknown Fabula icon: ${name}`);
    const tier = TIERS[options.tier || tierFor(size)];
    if (!tier) throw new Error(`Unknown Fabula icon tier: ${options.tier}`);
    const col = HUES[options.hue || glyph.hue];
    if (!col) throw new Error(`Unknown Fabula icon hue: ${options.hue}`);
    let d = glyph.d;
    if (!tier.details) d = dropDetails(d);
    const round = ' stroke-linecap="round" stroke-linejoin="round"';
    const front = paint(d, (tag, t) => {
      if (tag === "g") return "";
      if (t.includes("f")) return ` fill="${col.accent}"`;
      if (t.includes("f2")) return ` fill="${col.light}"`;
      if (t.includes("solid")) return ` fill="${col.ink}"`;
      if (t.includes("s")) return ` fill="none" stroke="${col.ink}" stroke-width="${t.includes("thin") ? tier.thin : tier.line}"${round}`;
      return "";
    });
    const depthLayer = paint(d, (tag, t) => {
      if (tag === "g") return "";
      if (t.includes("flat")) return null;
      return ` fill="${col.deep}" stroke="${col.deep}" stroke-width="${tier.depthLine}" stroke-linejoin="round"`;
    });
    const depth = [...Array(tier.steps)].map((_, i) => {
      const n = tier.steps - i;
      return `<g transform="translate(${(n * tier.dx).toFixed(2)} ${(n * tier.dy).toFixed(2)})">${depthLayer}</g>`;
    }).join("");
    const shift = `translate(${(-tier.steps * tier.dx * 0.5).toFixed(2)} ${(-tier.steps * tier.dy * 0.5).toFixed(2)})`;
    return `<svg class="fi fi-${name}${extra}" viewBox="-2 -2 52 52" width="${size}" height="${size}"${label}><g transform="${shift}"><g class="fi-body"><g>${depth}</g><g>${front}</g></g></g></svg>`;
  }

  const names = [...Object.keys(G), ...Object.keys(LINES)];
  const glyphHue = (name) => (G[name] ? G[name].hue : "currentColor");
  return { HUES, colours, oklchToHex, render, names, glyphHue, lineNames: Object.keys(LINES), objectNames: Object.keys(G) };
}));
