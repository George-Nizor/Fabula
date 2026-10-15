#!/usr/bin/env node
// Builds Fabula's Windows release: the bundle Instrumenta installs (managed-bundle).
//
//   node scripts/package-release.mjs [--out dist/release] [--electron-zip <electron-v…-win32-x64.zip>]
//
// The bundle is Electron's Windows runtime, verified against Electron's own SHASUMS256.txt, with
// electron.exe renamed Fabula.exe. Its app (resources\app) is Fabula itself: this version's tracked
// files (no tests), its production node_modules (pure JavaScript, so they install the same on
// Linux), and the bootstrap from release/windows as the main. The first start sets up the engine
// on Windows (scripts/setup-windows.mjs); no WSL is involved. Built on Linux (the release
// workflow runs it on Ubuntu); python3 does the zipping, since Node has no zip of its own.
//
// Writes <out>/Fabula-<version>-windows-x64.zip. The release workflow then describes it in
// instrumenta-release.json with Instrumenta's scripts/instrumenta-release.cjs (entry Fabula.exe).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const flag = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
const VERSION = pkg.version;
const ELECTRON = lock.packages?.["node_modules/electron"]?.version;
if (!/^\d+\.\d+\.\d+/.test(VERSION) || !/^\d+\.\d+\.\d+/.test(ELECTRON ?? "")) throw new Error("Could not read Fabula's or Electron's version.");
const OUT = path.resolve(flag("out") ?? path.join(ROOT, "dist", "release"));
const NAME = `Fabula-${VERSION}-windows-x64`;
const ASSET = `electron-v${ELECTRON}-win32-x64.zip`;

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const say = (text) => console.log(`[package-release] ${text}`);

async function download(url, file) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
}

// The Windows runtime, checked against the SHASUMS256.txt Electron publishes with it.
async function electronZip(work) {
  const given = flag("electron-zip");
  const base = `https://github.com/electron/electron/releases/download/v${ELECTRON}`;
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const expected = sums.split(/\r?\n/).map((line) => line.trim().split(/\s+\*?/)).find(([, name]) => name === ASSET)?.[0]?.toLowerCase();
  if (!expected) throw new Error(`Electron ${ELECTRON}'s SHASUMS256.txt does not list ${ASSET}.`);
  const file = given ? path.resolve(given) : path.join(work, ASSET);
  if (!given) {
    say(`downloading ${ASSET}`);
    await download(`${base}/${ASSET}`, file);
  }
  const actual = sha256(file);
  if (actual !== expected) throw new Error(`${ASSET} failed its SHA-256 check (expected ${expected}, got ${actual}).`);
  return file;
}

// What a release leaves out of the tracked files: the tests, the screenshots tooling, the CI and
// the release sources (the bootstrap goes in at the app's top), and the README's pictures. The
// docs stay: the assistant reads docs/assistant-workflow.md and docs/craft/.
const LEFT_OUT = [/^test\//, /^test-tools\//, /^\.github\//, /^release\//, /^docs\/images\//, /^\.gitignore$/];
const shipped = (file) => !LEFT_OUT.some((pattern) => pattern.test(file));

function findFiles(root, wanted, dir = root, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findFiles(root, wanted, full, found);
    else if (wanted(entry.name)) found.push(path.relative(root, full));
  }
  return found;
}

const python = (script, ...args) => execFileSync("python3", ["-c", script, ...args], { stdio: "inherit" });

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "fabula-release-"));
  try {
    const zip = await electronZip(work);
    const bundle = path.join(work, NAME);
    say(`unpacking Electron ${ELECTRON}`);
    python("import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", zip, bundle);
    fs.renameSync(path.join(bundle, "electron.exe"), path.join(bundle, "Fabula.exe"));
    // The bootstrap is the app; Electron's welcome page has no business in it.
    fs.rmSync(path.join(bundle, "resources", "default_app.asar"), { force: true });

    const app = path.join(bundle, "resources", "app");
    fs.mkdirSync(app, { recursive: true });

    // Fabula's code: what git tracks at this version (a release is built from its tag, so that is
    // the release), less what only a checkout uses.
    say("copying the app");
    const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
    let copied = 0;
    for (const file of tracked.filter(shipped)) {
      const from = path.join(ROOT, file);
      if (!fs.existsSync(from)) continue; // deleted in the working tree, not yet committed
      fs.mkdirSync(path.dirname(path.join(app, file)), { recursive: true });
      fs.copyFileSync(from, path.join(app, file));
      copied += 1;
    }
    say(`${copied} files`);

    // The bootstrap is the app's main, beside the code it opens.
    for (const file of fs.readdirSync(path.join(ROOT, "release", "windows"))) {
      fs.copyFileSync(path.join(ROOT, "release", "windows", file), path.join(app, file));
    }
    // The brand v2 slate: the PNG for the setup window's masthead, the ICO for its taskbar icon.
    fs.copyFileSync(path.join(ROOT, "brand", "fabula-256.png"), path.join(app, "fabula-mark.png"));
    fs.copyFileSync(path.join(ROOT, "brand", "fabula.ico"), path.join(app, "fabula.ico"));
    // The brand faces for the setup window (setup.css), with their licences.
    fs.mkdirSync(path.join(app, "fonts"), { recursive: true });
    for (const file of fs.readdirSync(path.join(ROOT, "renderer", "brand", "fonts")).filter((name) => /\.(woff2|txt)$/.test(name))) {
      fs.copyFileSync(path.join(ROOT, "renderer", "brand", "fonts", file), path.join(app, "fonts", file));
    }
    // The editor's name, so the bootstrap and the editor it opens keep one settings folder, and
    // the bootstrap as the main.
    const manifest = {
      name: pkg.name, productName: "Fabula", version: VERSION, description: pkg.description, license: pkg.license,
      private: true, main: "bootstrap.cjs", dependencies: pkg.dependencies,
    };
    fs.writeFileSync(path.join(app, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    // The production node_modules, from the lockfile, with no install scripts: Electron is a
    // devDependency and stays out (Fabula.exe is the runtime).
    say("installing the production packages");
    const deps = path.join(work, "deps");
    fs.mkdirSync(deps);
    fs.copyFileSync(path.join(ROOT, "package.json"), path.join(deps, "package.json"));
    fs.copyFileSync(path.join(ROOT, "package-lock.json"), path.join(deps, "package-lock.json"));
    execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: deps, stdio: "inherit" });
    fs.renameSync(path.join(deps, "node_modules"), path.join(app, "node_modules"));
    fs.rmSync(path.join(app, "node_modules", ".bin"), { recursive: true, force: true }); // links, and nothing runs them
    if (fs.existsSync(path.join(app, "node_modules", "electron"))) throw new Error("node_modules/electron would ship in the bundle.");
    const native = findFiles(path.join(app, "node_modules"), (name) => name.endsWith(".node"));
    if (native.length) throw new Error(`Native modules would ship, built for Linux: ${native.join(", ")}`);

    fs.mkdirSync(OUT, { recursive: true });
    const target = path.join(OUT, `${NAME}.zip`);
    fs.rmSync(target, { force: true });
    say("zipping the bundle");
    python([
      "import os, sys, zipfile",
      "root, target = sys.argv[1], sys.argv[2]",
      "with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:",
      "    for base, dirs, files in os.walk(root):",
      "        dirs.sort()",
      "        for name in sorted(files):",
      "            full = os.path.join(base, name)",
      "            z.write(full, os.path.relpath(full, root))",
    ].join("\n"), bundle, target);
    const appBytes = findFiles(app, () => true).reduce((sum, file) => sum + fs.statSync(path.join(app, file)).size, 0);
    say(`resources\\app: ${(appBytes / 1e6).toFixed(1)} MB unpacked`);
    say(`${target} (${(fs.statSync(target).size / 1e6).toFixed(1)} MB)`);
    console.log(JSON.stringify({ file: target, version: VERSION, electron: ELECTRON, entry: "Fabula.exe" }));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[package-release] ${error.message}`);
  process.exit(1);
});
