#!/usr/bin/env node
// Bringing projects over from the WSL engine to a Windows projects folder.
//
// Fabula 0.3 kept its engine and projects inside WSL
// (~/.local/share/fabula/projects). From 0.4 the engine is native on Windows
// and projects are an ordinary Windows folder. This copies each project and
// the saved brands across, reading the WSL side through \\wsl.localhost and
// changing nothing there:
//
// - files keep their timestamps, so the clean cut, its transcript and the
//   delivered film stay current;
// - recording paths written as WSL saw them (/mnt/e/...) become drive paths
//   (E:\...); a clean cut's identity compares both spellings as one
//   (core/clean-identity.mjs identityPath), so nothing re-renders;
// - render caches (out/chunks*) are left behind: they are rebuilt as needed;
// - final/<title>.mp4 is linked to out/final.mp4 again rather than copied
//   twice (project-state.mjs deliverFilm);
// - a project already in the destination is never overwritten.
//
//   node scripts/migrate-wsl.mjs [--from <dir>] [--to <dir>] [--dry-run]
//
// Without --from, the first \\wsl.localhost\<distro>\home\<user>\.local\share\fabula\projects
// found is used. Lines on stdout: COPY <name>, SKIP <name> <why>, DONE <count>.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";

// Files a project keeps a recording's absolute path in.
const PATH_FILES = ["source.json", "review.json", path.join("out", "clean-map.json"), "framing-scan.json"];
const SKIP_DIRS = new Set(["chunks", "chunks-draft"]);

export function windowsPath(value) {
  const mounted = /^\/mnt\/([a-z])(?:\/(.*))?$/i.exec(value);
  return mounted ? `${mounted[1].toUpperCase()}:\\${(mounted[2] ?? "").replace(/\//g, "\\")}` : value;
}

// The WSL engine's projects folder as WSL spelled it, from the share path
// Windows reached it by: \\wsl.localhost\Ubuntu\home\me\... -> /home/me/...
export function wslSpelling(share) {
  const match = /^\\\\(?:wsl\.localhost|wsl\$)\\[^\\]+(\\.*)$/i.exec(share ?? "");
  return match ? match[1].replace(/\\/g, "/") : null;
}

// Every JSON string that is a /mnt path, or a path inside the old projects
// folder, rewritten for Windows; anything else as it was.
export function rewritePaths(text, { oldRoot = null, newRoot = null } = {}) {
  const data = JSON.parse(text);
  let changed = 0;
  const walk = (node) => {
    if (typeof node === "string") {
      let next = windowsPath(node);
      if (oldRoot && newRoot && (node === oldRoot || node.startsWith(`${oldRoot}/`))) {
        next = path.win32.join(newRoot, ...node.slice(oldRoot.length).split("/").filter(Boolean));
      }
      if (next !== node) changed += 1;
      return next;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    return node;
  };
  const out = walk(data);
  return { text: JSON.stringify(out, null, 2), changed };
}

// The WSL engine's projects folder, as Windows reaches it. The share's root
// cannot be listed, so the distributions come from wsl.exe itself (its list
// is UTF-16); none when WSL is not installed.
export function wslDistros(run = spawnSync) {
  const result = run("wsl.exe", ["--list", "--quiet"], { encoding: "buffer", windowsHide: true });
  if (result.status !== 0 || !result.stdout) return [];
  // UTF-16 as a rule; UTF-8 when WSL_UTF8 is set. A UTF-16 list of names has NULs.
  const text = result.stdout.includes(0) ? result.stdout.toString("utf16le") : result.stdout.toString("utf8");
  return text.replace(/\0/g, "").split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
}

export function findWslProjects() {
  for (const distro of wslDistros()) {
    for (const root of ["\\\\wsl.localhost", "\\\\wsl$"]) {
      let users = [];
      try { users = fs.readdirSync(path.join(root, distro, "home")); } catch { continue; }
      for (const user of users) {
        const dir = path.join(root, distro, "home", user, ".local", "share", "fabula", "projects");
        try { if (fs.statSync(dir).isDirectory()) return dir; } catch { /* not this one */ }
      }
    }
  }
  return null;
}

function copyTree(from, to, { top = true } = {}) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      if (!top && SKIP_DIRS.has(entry.name)) continue;
      copyTree(source, target, { top: false });
    } else if (entry.isFile()) {
      fs.copyFileSync(source, target);
      const stat = fs.statSync(source);
      fs.utimesSync(target, stat.atime, stat.mtime);
    }
  }
}

export async function migrate({ from, to, dryRun = false, say = console.log }) {
  if (!from || !fs.existsSync(from)) throw new Error(`no WSL projects folder at ${from}`);
  fs.mkdirSync(to, { recursive: true });
  const { deliverFilm } = await import("./project-state.mjs");
  let copied = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const target = path.join(to, name);
    if (fs.existsSync(target)) { say(`SKIP ${name} already in ${to}`); continue; }
    if (dryRun) { say(`COPY ${name} (dry run)`); continue; }
    copyTree(path.join(from, name), target);
    if (name !== "themes") {
      for (const file of PATH_FILES) {
        const full = path.join(target, file);
        if (!fs.existsSync(full)) continue;
        const stat = fs.statSync(full);
        const { text, changed } = rewritePaths(fs.readFileSync(full, "utf8"), { oldRoot: wslSpelling(from), newRoot: to });
        if (changed) {
          fs.writeFileSync(full, text);
          fs.utimesSync(full, stat.atime, stat.mtime);
        }
      }
      // The delivered film was a hard link in WSL; copied, it is a second
      // copy. Linked again, it takes its space once.
      if (fs.existsSync(path.join(target, "out", "final.mp4"))) {
        try { deliverFilm(target); } catch (error) { say(`SKIP ${name}/final ${error.message}`); }
      }
    }
    copied += 1;
    say(`COPY ${name}`);
  }
  say(`DONE ${copied}`);
  return copied;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (invoked) {
  const { values } = parseArgs({ options: { from: { type: "string" }, to: { type: "string" }, "dry-run": { type: "boolean" } } });
  const from = values.from ?? findWslProjects();
  const to = values.to ?? path.join(os.homedir(), "Videos", "Fabula");
  migrate({ from, to, dryRun: values["dry-run"] }).catch((error) => { console.error(`FAILED ${error.message}`); process.exit(1); });
}
