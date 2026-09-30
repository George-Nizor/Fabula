#!/usr/bin/env node
// Builds Fabula's Windows release: the bundle Instrumenta installs (managed-bundle).
//
//   node scripts/package-release.mjs [--out dist/release] [--electron-zip <electron-v…-win32-x64.zip>]
//
// The bundle is Electron's Windows runtime, verified against Electron's own SHASUMS256.txt, with
// electron.exe renamed Fabula.exe and the bootstrap (release/windows) as its app. Beside the
// bootstrap go the engine the bootstrap sets up in WSL: this version's tracked files as a tarball,
// and scripts/setup-engine.sh to unpack and prepare it. Built on Linux (the release workflow runs
// it on Ubuntu); python3 does the zipping, since Node has no zip of its own.
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
    const engine = path.join(app, "engine");
    fs.mkdirSync(engine, { recursive: true });
    for (const file of fs.readdirSync(path.join(ROOT, "release", "windows"))) {
      fs.copyFileSync(path.join(ROOT, "release", "windows", file), path.join(app, file));
    }
    fs.copyFileSync(path.join(ROOT, "brand", "fabula-mark-256.png"), path.join(app, "fabula-mark.png"));
    fs.writeFileSync(path.join(app, "package.json"), `${JSON.stringify({
      // The editor's name, so the bootstrap and the editor it loads keep one settings folder.
      name: pkg.name, productName: "Fabula", version: VERSION, main: "bootstrap.cjs", private: true,
    }, null, 2)}\n`);

    // The engine: what git tracks at this version (a release is built from its tag, so that is
    // the release), and the script that sets it up.
    say("packing the engine");
    const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT });
    const list = path.join(work, "files");
    fs.writeFileSync(list, tracked);
    execFileSync("tar", ["--null", "-czf", path.join(engine, `fabula-engine-${VERSION}.tar.gz`), "-C", ROOT, "-T", list]);
    fs.copyFileSync(path.join(ROOT, "scripts", "setup-engine.sh"), path.join(engine, "setup-engine.sh"));

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
