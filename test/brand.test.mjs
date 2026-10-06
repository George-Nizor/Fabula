// Brand v2 in the window: the interface icons and the copied tokens agree, and the icons stay safe
// to insert under a strict Content-Security-Policy.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const icons = require(path.join(ROOT, "renderer", "brand-icons", "fabula-icons.js"));
const tokens = JSON.parse(fs.readFileSync(path.join(ROOT, "brand", "tokens.json"), "utf8"));

test("coral is exactly the fabula block of the copied brand tokens", () => {
  const { accent, secondary, deep, ink } = tokens.fabula;
  assert.deepEqual(icons.HUES.coral, { accent, light: secondary, deep, ink });
});

test("every icon renders at every tier, with no inline style, script or link", () => {
  for (const name of icons.names) {
    for (const size of [16, 24, 48]) {
      const svg = icons.render(name, { size });
      assert.match(svg, /^<svg class="fi /);
      assert.doesNotMatch(svg, /style=|<script|href|<foreignObject|on\w+=/i, `${name} at ${size}`);
      assert.match(svg, /aria-hidden="true"/);
    }
  }
});

test("a label makes the icon an image with that name, escaped", () => {
  assert.match(icons.render("done", { label: 'Done "now"' }), /role="img" aria-label="Done &quot;now&quot;"/);
});

test("hues mean something: green is done, brick is destructive, teal hands off", () => {
  assert.equal(icons.glyphHue("done"), "green");
  for (const name of ["trash", "failed", "stop"]) assert.equal(icons.glyphHue(name), "brick");
  for (const name of ["folder", "open"]) assert.equal(icons.glyphHue(name), "teal");
  assert.equal(icons.glyphHue("add"), "currentColor");
  assert.throws(() => icons.render("nope"), /Unknown Fabula icon/);
  assert.throws(() => icons.render("done", { hue: "puce" }), /Unknown Fabula icon hue/);
});

test("the one-shot motion hooks survive the paint", () => {
  assert.match(icons.render("trash", { size: 32 }), /class="fm-lid"/);
  assert.match(icons.render("reel", { size: 32, state: "playing" }), /class="fi fi-reel is-playing"/);
});

test("the copied brand files are the Instrumenta ones, unedited", () => {
  const brand = path.join(ROOT, "..", "Instrumenta", "brand");
  if (!fs.existsSync(brand)) return; // a checkout without the workspace around it
  const same = (a, b) => assert.ok(fs.readFileSync(a).equals(fs.readFileSync(b)), `${path.relative(ROOT, a)} differs from ${b}`);
  same(path.join(ROOT, "renderer", "brand", "instrumenta-icons.js"), path.join(brand, "icons", "instrumenta-icons.js"));
  same(path.join(ROOT, "renderer", "brand", "instrumenta-icons.css"), path.join(brand, "icons", "instrumenta-icons.css"));
  same(path.join(ROOT, "renderer", "brand", "fonts", "fonts.css"), path.join(brand, "fonts", "fonts.css"));
  same(path.join(ROOT, "brand", "fabula.ico"), path.join(brand, "icons", "ico", "fabula.ico"));
  assert.deepEqual(tokens.fabula, JSON.parse(fs.readFileSync(path.join(brand, "tokens.json"), "utf8")).fabula);
});
