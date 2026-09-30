import test from "node:test";
import assert from "node:assert/strict";
import { PRESETS, resolveTheme, validateTheme, describePresets } from "../core/themes.mjs";
import * as themes from "../core/themes.mjs";
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

test("an inherited object key is not a preset, null fonts are refused, and the pace is explicit or the style's own", () => {
  assert.throws(() => validateTheme({ preset: "constructor" }), /unknown theme preset/);
  assert.throws(() => validateTheme({ fonts: null }), /theme fonts must be/);
  assert.throws(() => validateTheme({ fonts: ["Inter"] }), /theme fonts must be/);
  assert.throws(() => resolveTheme({ preset: "toString" }), /unknown theme preset/, "an inherited key is refused, not resolved to Object's own");
  const plain = resolveTheme({ preset: "broadcast" });
  assert.equal(plain.transitionSeconds, null, "nothing explicit: every boundary takes its style's pace");
  assert.equal(plain.transitionSecondsDefault, 0, "cut has no pace to show");
  assert.equal(resolveTheme({ preset: "studio", transitionSeconds: 1.2 }).transitionSeconds, 1.2);
});

test("the grade is neutral by default, bounded, and speaks ffmpeg and CSS", () => {
  const { GRADE_DEFAULTS, gradeFilters, resolveTheme, validateTheme } = themes;
  assert.deepEqual(resolveTheme({}).grade, GRADE_DEFAULTS);
  assert.deepEqual(gradeFilters(null), { pre: "", post: "", css: "none", vignette: 0 });
  assert.throws(() => validateTheme({ grade: { contrast: 3 } }), /0\.7 to 1\.5/);
  assert.throws(() => validateTheme({ grade: { tint: 1 } }), /no "tint"/);
  const warm = gradeFilters({ contrast: 1.1, warmth: 0.5, vignette: 0.4 });
  assert.match(warm.pre, /^eq=contrast=1\.1:saturation=1:brightness=0,colortemperature=temperature=7400:mix=1,$/);
  assert.match(warm.post, /^vignette=angle=0\.2513:mode=forward:dither=0$/);
  assert.equal(warm.css, "contrast(1.1) sepia(0.175)");
  assert.equal(warm.vignette, 0.4);
  const cool = gradeFilters({ warmth: -1 });
  assert.match(cool.pre, /temperature=4700/);
  assert.equal(cool.css, "hue-rotate(-12deg)");
  assert.deepEqual(resolveTheme({ grade: { saturation: null, lift: 0.1 } }).grade, { ...GRADE_DEFAULTS, lift: 0.1 }, "null returns a field to neutral");
});
