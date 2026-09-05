import test from "node:test";
import assert from "node:assert/strict";
import { PRESETS, resolveTheme, validateTheme, describePresets } from "../core/themes.mjs";

test("an empty theme is the studio preset with every token present", () => {
  const theme = resolveTheme(null);
  assert.equal(theme.preset, "studio");
  assert.equal(theme.accent, PRESETS.studio.accent);
  for (const key of ["accent2", "field", "text", "muted", "card", "radius", "glow", "fonts", "titleStyle", "calloutStyle", "captionStyle"]) {
    assert.ok(theme[key] !== undefined, `${key} resolved`);
  }
  assert.equal(theme.logo, null);
});

test("overrides win over the preset, per token", () => {
  const theme = resolveTheme({ preset: "broadcast", accent: "#ff0000", fonts: { display: "Fraunces" }, captionStyle: "karaoke", logo: { src: "assets/logo.png" } });
  assert.equal(theme.accent, "#ff0000");
  assert.equal(theme.accent2, PRESETS.broadcast.accent2);
  assert.equal(theme.fonts.display, "Fraunces");
  assert.equal(theme.fonts.body, PRESETS.broadcast.fonts.body);
  assert.equal(theme.captionStyle, "karaoke");
  assert.equal(theme.titleStyle, "block");
  assert.deepEqual(theme.logo, { src: "assets/logo.png", corner: "tr", size: 0.09, opacity: 0.9 });
});

test("validation refuses what the stage cannot honour", () => {
  assert.throws(() => validateTheme({ preset: "disco" }), /unknown theme preset/);
  assert.throws(() => validateTheme({ accent: "red" }), /#rrggbb/);
  assert.throws(() => validateTheme({ titleStyle: "explode" }), /titleStyle/);
  assert.throws(() => validateTheme({ logo: { src: "/etc/passwd.png" } }), /project-relative/);
  assert.throws(() => validateTheme({ logo: { src: "assets/l.png", size: 0.9 } }), /size/);
  assert.throws(() => validateTheme({ glow: 2 }), /glow/);
  assert.throws(() => validateTheme({ watermark: "x".repeat(41) }), /watermark/);
  validateTheme({ preset: "paper", accent: "#123456", watermark: "@channel", logo: null });
});

test("every preset resolves and the menu describes each", () => {
  const menu = describePresets();
  assert.equal(menu.length, Object.keys(PRESETS).length);
  for (const entry of menu) {
    const theme = resolveTheme({ preset: entry.id });
    assert.equal(theme.preset, entry.id);
    assert.ok(entry.about.length > 10);
  }
});
