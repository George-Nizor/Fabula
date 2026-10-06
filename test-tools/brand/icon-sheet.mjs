#!/usr/bin/env node
// The icon contact sheet: every interface icon at 16, 24 and 48 px on the dark and the light
// window surfaces, so the set is judged where it is used. Writes docs/brand/icon-contact-sheet.png.
//
//   node test-tools/brand/icon-sheet.mjs [out.png]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { shoot } from "./headless.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const icons = createRequire(import.meta.url)(path.join(ROOT, "renderer", "brand-icons", "fabula-icons.js"));
const out = path.resolve(process.argv[2] ?? path.join(ROOT, "docs", "brand", "icon-contact-sheet.png"));
const fonts = path.join(ROOT, "renderer", "brand", "chrome-fonts.css");

const cell = (name) => `<div class="cell"><div class="row">${[16, 24, 48].map((size) => icons.render(name, { size })).join("")}</div><span>${name}</span></div>`;
const half = (theme) => `<section class="${theme}"><h2>${theme === "dark" ? "Dark" : "Light"}</h2><div class="grid">${icons.names.map(cell).join("")}</div></section>`;
const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="file://${fonts}">
<style>
body { margin: 0; font: 13px "Instrumenta Commissioner", sans-serif; font-variation-settings: "FLAR" 40; }
section { padding: 22px 26px 26px; }
.dark { background: #141210; color: #F2EDE6; }
.light { background: #FAF7F2; color: #1C1916; }
h2 { margin: 0 0 14px; font: 650 22px "Instrumenta Fraunces", serif; font-variation-settings: "SOFT" 100, "WONK" 1; }
.grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 14px 10px; }
.cell { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
.row { display: flex; align-items: flex-end; gap: 10px; min-height: 52px; }
span { font: 12px "Instrumenta Spline Sans Mono", monospace; opacity: .8; }
svg { overflow: visible; }
</style>${half("dark")}${half("light")}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabula-icons-"));
const file = path.join(dir, "sheet.html");
fs.writeFileSync(file, html);
fs.mkdirSync(path.dirname(out), { recursive: true });
const rows = Math.ceil(icons.names.length / 8);
shoot(file, out, 1200, 2 * (70 + rows * 86));
fs.rmSync(dir, { recursive: true, force: true });
console.log(out);
