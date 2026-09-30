"use strict";

// What the Windows bootstrap knows about the engine in WSL, as pure functions: where things are
// from either side, what the setup script's lines mean, and what a remembered engine may say.
// No Electron and no I/O here, so the tests run it as it is.

const DISTRO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;

// A path in the distribution as Windows reaches it, through the \\wsl.localhost share.
function uncPath(distro, posixPath) {
  if (!DISTRO_RE.test(String(distro))) throw new Error("That is not a WSL distribution name.");
  if (typeof posixPath !== "string" || !posixPath.startsWith("/")) throw new Error("A WSL path is absolute.");
  return `\\\\wsl.localhost\\${distro}${posixPath.replace(/\//g, "\\")}`;
}

// A Windows path as the distribution reaches it, through its /mnt/<drive> mounts.
function toWslPath(windowsPath) {
  const match = /^([a-zA-Z]):[\\/](.*)$/.exec(String(windowsPath));
  if (!match) throw new Error(`${windowsPath} is not on a drive WSL mounts.`);
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}

// wsl.exe answers in UTF-16LE when it speaks for itself (an error, the distribution list) and
// passes a Linux program's UTF-8 through untouched. NUL bytes are the tell.
function decodeWslOutput(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer ?? ""));
  const text = bytes.includes(0) ? bytes.toString("utf16le") : bytes.toString("utf8");
  return text.replace(/^﻿/, "").replace(/\0/g, "");
}

// The probe the bootstrap runs in the default distribution prints its name and the home folder.
function parseProbe(text) {
  const [distro, home] = String(text).split(/\r?\n/).map((line) => line.trim());
  if (!DISTRO_RE.test(distro || "")) throw new Error("WSL answered, but not with a distribution name. Is a Linux distribution installed?");
  if (!home || !home.startsWith("/")) throw new Error("WSL answered without a home folder.");
  return { distro, home };
}

// One line of scripts/setup-engine.sh's output: a step starting, the engine ready, or a line for
// the log.
function parseLine(line) {
  const text = String(line).replace(/\r$/, "");
  let match = /^STEP (\d+) (\d+) (.+)$/.exec(text);
  if (match) return { type: "step", n: Number(match[1]), total: Number(match[2]), label: match[3] };
  match = /^READY (\/.+)$/.exec(text);
  if (match) return { type: "ready", root: match[1] };
  return { type: "log", text };
}

// What engine.json may hold: where the engine was set up. Anything else is treated as no engine.
function validState(state) {
  if (!state || typeof state !== "object") return null;
  const { distro, home, root } = state;
  if (!DISTRO_RE.test(String(distro || ""))) return null;
  if (typeof home !== "string" || !home.startsWith("/")) return null;
  if (typeof root !== "string" || !root.startsWith("/") || root.includes("..")) return null;
  return { distro, home, root };
}

// A version's folder in the engine, from Windows.
function versionDir(state, version) {
  if (!VERSION_RE.test(String(version))) throw new Error("That is not a version.");
  return uncPath(state.distro, `${state.root}/versions/${version}`);
}

// The command that runs the setup inside the distribution. A login shell, so whatever Node or
// tools the person's profile puts on PATH are there to be found.
function setupCommand({ distro, script, tarball, version }) {
  const quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
  return {
    command: "wsl.exe",
    args: ["-d", distro, "--", "bash", "-lc", `bash ${quote(script)} --version ${quote(version)} --tarball ${quote(tarball)}`],
  };
}

module.exports = { decodeWslOutput, parseLine, parseProbe, setupCommand, toWslPath, uncPath, validState, versionDir };
