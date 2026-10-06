// The window's chrome in brand v2: colours only as tokens, the brand faces under their chrome-only
// names, nothing from a CDN, the theme set before first paint, and every icon the page asks for
// drawn by the set.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");
const css = read("renderer", "styles.css").replace(/\/\*[\s\S]*?\*\//g, "");
const html = read("renderer", "index.html");
const icons = createRequire(import.meta.url)(path.join(ROOT, "renderer", "brand-icons", "fabula-icons.js"));

test("every colour in the chrome is a token on :root", () => {
  const end = css.indexOf(':root[data-theme="light"]');
  assert.ok(end > 0);
  const rules = css.slice(end);
  const literals = rules.match(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(/gi) ?? [];
  assert.deepEqual(literals, [], "colour literals outside :root");
});

test("the chrome has dark and light from one set of tokens, following the system unless pinned", () => {
  assert.match(css, /color-scheme: light dark/);
  assert.match(css, /:root\[data-theme="dark"\] \{ color-scheme: dark; \}/);
  assert.match(css, /:root\[data-theme="light"\] \{ color-scheme: light; \}/);
  assert.match(css, /--coral: #ed7088;/i);
  assert.match(css, /--fam-surface: #141210;/i);
});

test("type: the brand faces under chrome-only names, with their axes", () => {
  assert.match(css, /--display: "Instrumenta Fraunces"/);
  assert.match(css, /--ui: "Instrumenta Commissioner"/);
  assert.match(css, /--mono: "Instrumenta Spline Sans Mono"/);
  assert.match(css, /"SOFT" 100, "WONK" 1/);
  assert.match(css, /"FLAR" 40/);
  assert.doesNotMatch(css, /var\(--serif\)|Source Serif/);
  // No tiny tracked capitals in the chrome.
  // (A capital first letter, for names that arrive lower-case, is sentence case, not capitals.)
  assert.doesNotMatch(css.replace(/::first-letter \{ text-transform: uppercase; \}/g, ""), /text-transform: uppercase/);
  assert.doesNotMatch(css, /letter-spacing: 0\.\d+em/);
  const faces = read("renderer", "brand", "chrome-fonts.css");
  for (const family of ["Instrumenta Fraunces", "Instrumenta Commissioner", "Instrumenta Spline Sans Mono"]) assert.ok(faces.includes(`font-family: "${family}"`));
  // The film's own faces keep their names: a film can never pick up the chrome's type.
  assert.doesNotMatch(faces, /font-family: "(Fraunces|Commissioner|Spline Sans Mono)"/);
});

test("nothing loads from the network", () => {
  for (const file of [html, read("renderer", "styles.css"), read("renderer", "brand", "chrome-fonts.css")]) {
    assert.doesNotMatch(file, /(src|href)=["']?(https?:)?\/\/|url\(["']?(https?:)?\/\//);
  }
});

test("the theme is set before the stylesheets paint, and the icon libraries load before main.js", () => {
  const at = (needle) => { const i = html.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  assert.ok(at('src="theme-boot.js"') < at('href="styles.css"'));
  assert.ok(at('src="brand/instrumenta-icons.js"') < at('src="main.js"'));
  assert.ok(at('src="brand-icons/fabula-icons.js"') < at('src="main.js"'));
});

test("every icon the page and the renderer ask for is in the set", () => {
  const main = read("renderer", "main.js");
  const asked = new Set([
    ...[...html.matchAll(/data-(?:step-)?icon="([^"]+)"/g)].map((m) => m[1]),
    ...[...main.matchAll(/\bicon\("([a-zA-Z]+)"/g)].map((m) => m[1]),
    ...[...main.matchAll(/icon: "([a-zA-Z]+)"/g)].map((m) => m[1]),
  ]);
  assert.ok(asked.size > 20);
  for (const name of asked) assert.ok(icons.names.includes(name), `${name} is not in the icon set`);
});
