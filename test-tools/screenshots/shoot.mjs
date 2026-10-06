#!/usr/bin/env node
// Photographs every main screen of the real Fabula window, headless, in dark and light.
//
//   node test-tools/screenshots/shoot.mjs [--out DIR] [--themes dark,light] [--media DIR] [--only a,b]
//
// It drives Fabula's own snapshot mode (FABULA_SNAPSHOT in electron/main.cjs): the real Electron
// window with the real IPC, the real projects and the real painter, nothing mocked. The projects
// come from a COPY: every small file of each named project is copied into a temporary projects
// root and every large one (renders, chunks, audio) is symlinked, so nothing the window does can
// touch the originals and the owner's open project never moves. See README.md beside this file.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
const OUT = path.resolve(arg("out", path.join(ROOT, "test-tools", "screenshots", "shots")));
const THEMES = arg("themes", "dark,light").split(",").filter(Boolean);
const MEDIA = path.resolve(arg("media", path.join(ROOT, "media")));
const ONLY = arg("only", "") ? new Set(arg("only", "").split(",")) : null;
const LIBS = process.env.FABULA_WSL_LIBS || path.join(ROOT, "tools", "wsl-libs", "usr", "lib", "x86_64-linux-gnu");
const ELECTRON = process.env.ELECTRON || path.join(ROOT, "node_modules", "electron", "dist", "electron");

// The projects photographed: a finished landscape film, one made with Make it into a video (the
// Making panel), and a vertical short. Absent ones are skipped with a note.
const FILM = "rockets-explained";
const MADE = "rockets-made-into-a-video";
const SHORT = "what-an-orbit-actually-is";
const BIG = 2 * 1024 * 1024;

function copyProject(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyProject(src, dst);
    else if (fs.statSync(src).size > BIG) fs.symlinkSync(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

function makeRoot(projects) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabula-shots-"));
  for (const name of projects) {
    if (fs.existsSync(path.join(MEDIA, name))) copyProject(path.join(MEDIA, name), path.join(root, name));
    else console.warn(`[shots] ${name} is not in ${MEDIA}; its screens are skipped`);
  }
  // A project with a recording and nothing else yet: the "run the first pass" empty state.
  const staged = path.join(root, "a-new-recording");
  fs.mkdirSync(staged);
  const source = fs.existsSync(path.join(MEDIA, FILM, "source.json"))
    ? JSON.parse(fs.readFileSync(path.join(MEDIA, FILM, "source.json"), "utf8"))
    : { path: "/tmp/a-new-recording.mp4", container: ".mp4", bytes: 1 };
  fs.writeFileSync(path.join(staged, "source.json"), JSON.stringify(source, null, 2));
  fs.writeFileSync(path.join(staged, "project.json"), JSON.stringify({ title: "A new recording", format: "landscape" }, null, 2));
  return root;
}

// One step list per run. Each step: { size, run, wait, shot, print } (electron/main.cjs).
const js = (code) => `(async () => { ${code} })().then(() => true, (e) => String(e))`;
const theme = (name) => ({ run: js(`window.FabulaChrome?.setTheme(${JSON.stringify(name)});`), wait: 300 });
const click = (id) => js(`document.getElementById(${JSON.stringify(id)})?.click();`);
const closeDialogs = { run: js(`document.querySelectorAll("dialog[open]").forEach((d) => d.close());`), wait: 300 };
const CONTRAST = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "contrast.js"), "utf8");
const contrast = (label) => ({ run: CONTRAST, print: `contrast ${label}` });
const open = (project) => ({ run: js(`await window.fabula.switchProject(${JSON.stringify(project)});`), wait: 3500 });

function steps(themeName, prefix, have) {
  const s = [{ size: [1440, 900] }, theme(themeName)];
  const shot = (name) => (!ONLY || ONLY.has(name) ? { shot: `${prefix}${name}` } : {});
  s.push({ wait: 800, ...shot("home") }, contrast("home"));
  s.push({ run: click("home-new"), wait: 600, ...shot("dialog-new-project") });
  s.push({ run: js(`const r = document.querySelector('#new-kind input[value=motion]'); r.checked = true; r.dispatchEvent(new Event("change"));`), wait: 400, ...shot("dialog-new-motion") }, contrast("new motion"), closeDialogs);
  if (have.has(FILM)) {
    s.push(open(FILM), { run: click("tab-cut"), wait: 1500, ...shot("cut") }, contrast("cut"));
    s.push({ run: js(`document.querySelector(".word")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); document.querySelectorAll(".word")[6]?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));`), wait: 500 });
    s.push({ run: click("tab-look"), wait: 2500, ...shot("look") }, contrast("look"));
    s.push({ run: js(`document.getElementById("look-titles")?.scrollIntoView({ block: "start" });`), wait: 1500, ...shot("look-galleries") });
    s.push({ run: click("tab-scenes"), wait: 2500, ...shot("scenes") });
    s.push({ run: js(`document.querySelector('[data-scene="2"]')?.click();`), wait: 1200, ...shot("scenes-inspector") }, contrast("scenes"));
    s.push({ run: click("tab-export"), wait: 1800, ...shot("export") }, contrast("export"));
    s.push({ run: click("open-assistant"), wait: 900, ...shot("dialog-assistant") }, closeDialogs);
    s.push({ run: js(`openProjects();`), wait: 600, ...shot("dialog-projects") }, closeDialogs);
    s.push({ run: js(`openRename({ name: ${JSON.stringify(FILM)}, title: "Rockets, explained" });`), wait: 500, ...shot("dialog-rename") }, closeDialogs);
    s.push({ run: click("tab-look"), wait: 1500 }, { run: click("look-save"), wait: 600, ...shot("dialog-brand") }, closeDialogs);
    s.push({ run: click("tab-cut"), wait: 1200 }, { run: js(`openDirection();`), wait: 900, ...shot("dialog-brief") }, contrast("brief"), closeDialogs);
    // Keyboard focus, as a person tabbing through the masthead sees it.
    s.push({ run: js(`document.getElementById("go-home").focus();`), wait: 100 }, { key: "Tab" }, { key: "Tab", wait: 400, ...shot("focus") });
  }
  if (have.has(MADE)) s.push(open(MADE), { run: click("tab-cut"), wait: 2000, ...shot("making") }, contrast("making"));
  if (have.has(SHORT)) s.push(open(SHORT), { run: click("tab-scenes"), wait: 2500, ...shot("short-scenes") });
  s.push(open("a-new-recording"), { wait: 800, ...shot("empty-project") });
  s.push({ run: js(`await window.fabula.closeProject();`), wait: 1200 });
  s.push({ run: js(`document.body.classList.add("is-dragging"); document.getElementById("dropzone").hidden = false;`), wait: 300, ...shot("dropzone") });
  // Motion: the slate claps, then the same with reduced motion asked for, where nothing may move.
  const motion = `(() => { clap(); const part = document.querySelector("#brand-mark .m-clap"); const name = part ? getComputedStyle(part).animationName : "missing"; return { reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches, theme: document.documentElement.dataset.theme ?? "system", slateAnimation: name }; })()`;
  s.push({ run: motion, print: "motion" });
  s.push({ media: [{ name: "prefers-reduced-motion", value: "reduce" }], run: motion, print: "motion, reduced" });
  s.push({ media: [] });
  return s;
}

function runElectron(root, stepList, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabula-shot-run-"));
  const script = path.join(dir, "steps.json");
  fs.writeFileSync(script, JSON.stringify(stepList, null, 1));
  const env = { ...process.env, FABULA_PROJECTS_ROOT: root, FABULA_SNAPSHOT: OUT, FABULA_SNAPSHOT_SCRIPT: script, LD_LIBRARY_PATH: [LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") };
  delete env.ELECTRON_RUN_AS_NODE; // a Claude Code shell carries it, and Electron then refuses its flags
  const result = spawnSync(ELECTRON, ["--no-sandbox", "--no-zygote", "--ozone-platform=headless", `--user-data-dir=${path.join(dir, "user")}`, ROOT], { env, encoding: "utf8", timeout: 600000 });
  const lines = `${result.stdout}`.split("\n").filter((line) => line.startsWith("{"));
  for (const line of lines) if (!line.includes('"snapshots"')) console.log(`[shots] ${label} ${line}`);
  if (result.status !== 0) console.error(`[shots] ${label} electron exited ${result.status}\n${result.stderr}`);
  for (const stray of ["1-home.png", "2-assistant.png"]) fs.rmSync(path.join(OUT, stray), { force: true }); // snapshot mode's own two
  fs.rmSync(dir, { recursive: true, force: true });
}

fs.mkdirSync(OUT, { recursive: true });
const root = makeRoot([FILM, MADE, SHORT]);
const have = new Set(fs.readdirSync(root));
const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fabula-shots-empty-"));
try {
  for (const name of THEMES) {
    runElectron(root, steps(name, `${name}-`, have), name);
    // No projects at all: the first thing a new person sees.
    runElectron(emptyRoot, [{ size: [1440, 900] }, theme(name), { wait: 800, shot: `${name}-home-empty` }], `${name} empty`);
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(emptyRoot, { recursive: true, force: true });
}
console.log(`[shots] ${OUT}`);
