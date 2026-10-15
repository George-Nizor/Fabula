"use strict";
// Finding Claude Code and Codex, and how to start them without a shell.
//
// On Linux (and in WSL) the session runs `claude` or `codex` from PATH, as a
// login shell sets it up. On Windows a .cmd shim cannot be started without
// cmd.exe, and cmd.exe re-reads a long JSON or prompt argument as a command
// line, so every npm shim is resolved to the program it wraps:
//
// - Claude Code: FABULA_CLAUDE_EXE, the native installer's
//   %USERPROFILE%\.local\bin\claude.exe, claude.exe on PATH, then npm's
//   claude.cmd (on PATH or in %APPDATA%\npm): the package's own bin\claude.exe,
//   else its cli.js run by this Node (Fabula.exe as Node in an install).
// - Codex: FABULA_CODEX_EXE, then npm's codex.cmd resolved to the codex.exe
//   inside @openai/codex (every layout it has shipped: the platform package
//   @openai/codex-win32-<arch>, vendor\<triple>\codex\codex.exe, and the
//   older bin\codex-<triple>.exe), then codex.exe on PATH. codex.js puts its
//   ripgrep first on PATH and sets CODEX_MANAGED_BY_NPM; so does this.
//
// Pure: fs and the environment are injectable so the Windows rules are
// tested on any machine.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const fileExists = (candidate) => { try { return fs.statSync(candidate).isFile(); } catch { return false; } };

function pathValue(env) {
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH");
  return key ? env[key] || "" : "";
}

// Every file called `name` in a PATH directory, in PATH order.
function searchPath(name, { env = process.env, platform = process.platform, exists = fileExists } = {}) {
  const p = platform === "win32" ? path.win32 : path.posix;
  return pathValue(env).split(platform === "win32" ? ";" : ":").map((dir) => dir.trim().replace(/^"|"$/g, ""))
    .filter(Boolean).map((dir) => p.join(dir, name)).filter((file) => exists(file));
}

const TRIPLES = { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" };

// npm shims that may wrap the CLI: on PATH first, then npm's global prefix.
function npmShims(name, { env, platform, exists }) {
  const list = searchPath(`${name}.cmd`, { env, platform, exists });
  if (env.APPDATA) {
    const shim = path.win32.join(env.APPDATA, "npm", `${name}.cmd`);
    if (exists(shim) && !list.some((found) => found.toLowerCase() === shim.toLowerCase())) list.push(shim);
  }
  return list;
}

function claudeWindows({ env, exists, homedir, node }) {
  const options = { env, platform: "win32", exists };
  const direct = [];
  if (env.FABULA_CLAUDE_EXE) direct.push({ path: env.FABULA_CLAUDE_EXE, source: "FABULA_CLAUDE_EXE" });
  direct.push({ path: path.win32.join(env.USERPROFILE || homedir, ".local", "bin", "claude.exe"), source: "native installer" });
  for (const found of searchPath("claude.exe", options)) direct.push({ path: found, source: "PATH" });
  const hit = direct.find((candidate) => exists(candidate.path));
  if (hit) return { command: hit.path, args: [], env: {}, source: hit.source };
  for (const shim of npmShims("claude", options)) {
    const pkg = path.win32.join(path.win32.dirname(shim), "node_modules", "@anthropic-ai", "claude-code");
    const nativeExe = path.win32.join(pkg, "bin", "claude.exe");
    if (exists(nativeExe)) return { command: nativeExe, args: [], env: {}, source: "npm" };
    const cli = path.win32.join(pkg, "cli.js");
    if (exists(cli) && node) return { command: node.command, args: [cli], env: { ...node.env }, source: "npm (cli.js)" };
  }
  return null;
}

function codexWindows({ env, exists, arch }) {
  const options = { env, platform: "win32", exists };
  if (env.FABULA_CODEX_EXE && exists(env.FABULA_CODEX_EXE)) return { command: env.FABULA_CODEX_EXE, args: [], env: {}, source: "FABULA_CODEX_EXE" };
  const triple = TRIPLES[arch] || TRIPLES.x64;
  const platformPackage = `codex-win32-${arch === "arm64" ? "arm64" : "x64"}`;
  for (const shim of npmShims("codex", options)) {
    const modules = path.win32.join(path.win32.dirname(shim), "node_modules");
    const pkg = path.win32.join(modules, "@openai", "codex");
    const vendors = [
      path.win32.join(pkg, "node_modules", "@openai", platformPackage, "vendor", triple),
      path.win32.join(modules, "@openai", platformPackage, "vendor", triple),
      path.win32.join(pkg, "vendor", triple),
    ];
    for (const vendor of vendors) {
      const exe = path.win32.join(vendor, "codex", "codex.exe");
      if (exists(exe)) {
        const rg = path.win32.join(vendor, "path");
        return { command: exe, args: [], env: npmEnv(env, exists(path.win32.join(rg, "rg.exe")) ? rg : null), source: "npm" };
      }
    }
    const old = path.win32.join(pkg, "bin", `codex-${triple}.exe`);
    if (exists(old)) {
      const rg = [path.win32.join(pkg, "node_modules", "@vscode", "ripgrep", "bin"), path.win32.join(modules, "@vscode", "ripgrep", "bin")]
        .find((dir) => exists(path.win32.join(dir, "rg.exe"))) ?? null;
      return { command: old, args: [], env: npmEnv(env, rg), source: "npm" };
    }
  }
  const onPath = searchPath("codex.exe", options)[0];
  return onPath ? { command: onPath, args: [], env: {}, source: "PATH" } : null;
}

// What codex.js would have added: its ripgrep first on PATH, and the marker
// that tells Codex npm manages its updates.
function npmEnv(env, rgDir) {
  const out = { CODEX_MANAGED_BY_NPM: "1" };
  if (rgDir) out.PATH = [rgDir, pathValue(env)].filter(Boolean).join(";");
  return out;
}

// { command, args, env, source } to start the provider's CLI, or null when it
// is not installed. `args` go before the session's own; `env` is merged over
// the caller's environment (a PATH in it replaces PATH whatever its case).
function findAgentCli(provider, {
  platform = process.platform, env = process.env, exists = fileExists, homedir = os.homedir(), arch = process.arch,
  node = { command: process.execPath, env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {} },
} = {}) {
  if (provider !== "claude" && provider !== "codex") throw new Error("Provider must be codex or claude.");
  if (platform !== "win32") return { command: provider, args: [], env: {}, source: "PATH" };
  return provider === "claude" ? claudeWindows({ env, exists, homedir, node }) : codexWindows({ env, exists, arch });
}

// The caller's environment with the CLI's additions, keeping one PATH key.
function mergeEnv(base, extra = {}) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (key.toUpperCase() === "PATH") for (const name of Object.keys(out)) if (name.toUpperCase() === "PATH") delete out[name];
    out[key] = value;
  }
  return out;
}

function installHint(provider, platform = process.platform) {
  if (provider === "claude") {
    return platform === "win32"
      ? "Claude Code is not installed. In PowerShell run `irm https://claude.ai/install.ps1 | iex`, then run `claude` once to sign in."
      : "Cannot run claude. Install Claude Code (`curl -fsSL https://claude.ai/install.sh | bash`) and check it is on PATH.";
  }
  return platform === "win32"
    ? "Codex is not installed. Install Node.js, run `npm install -g @openai/codex`, then run `codex` once to sign in."
    : "Cannot run codex. Install it (`npm install -g @openai/codex`) and check it is on PATH.";
}

module.exports = { findAgentCli, mergeEnv, searchPath, installHint };
