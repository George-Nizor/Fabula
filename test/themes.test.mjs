import test from "node:test";
import assert from "node:assert/strict";
import { PRESETS, resolveTheme, validateTheme, describePresets } from "../core/themes.mjs";
import { describeLook } from "../core/themes.mjs";

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

test("an unset look is reported as unchosen, and names the brands this person saved", () => {
  const brands = [{ id: "apple-man-sam-channel", name: "Apple Man Sam channel" }, { id: "youtube-channel", name: "youtube-channel" }];

  const fresh = describeLook({}, brands);
  assert.equal(fresh.chosen, false, "nothing set is not a decision");
  assert.equal(fresh.preset, "studio", "but the film would still render in the default");
  assert.match(fresh.hint, /No look has been chosen/);
  assert.match(fresh.hint, /Apple Man Sam channel \(apple-man-sam-channel\)/);
  assert.match(fresh.hint, /before planning scenes/);
  assert.deepEqual(describeLook(undefined, brands).chosen, false, "a missing theme key reads the same as an empty one");

  const noBrands = describeLook({}, []);
  assert.match(noBrands.hint, /Ask what the film is for/);
  assert.ok(!/saved/.test(noBrands.hint), "no brands, no brand talk");

  const picked = describeLook({ preset: "broadcast", accent: "#e63946" }, brands);
  assert.equal(picked.chosen, true);
  assert.equal(picked.preset, "broadcast");
  assert.equal(picked.accent, "#e63946");
  assert.equal(picked.hint, undefined, "a chosen look needs no nagging");
  assert.deepEqual(picked.savedBrands, brands);

  // An accent alone is a choice, even without a preset.
  assert.equal(describeLook({ accent: "#123456" }, []).chosen, true);
});
