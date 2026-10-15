"use strict";
// Where Fabula's engine is on this machine, and how to run its parts. One
// answer for every caller (the window, the pipeline, the MCP server, the
// assistant), so a Windows install and a Linux checkout differ in one file.
//
// - A Windows install runs everything natively. Its engine home is
//   %LOCALAPPDATA%\Fabula\engine (ffmpeg, the WhisperX venv, the models, the
//   settings), shared by every version; the code is the installed bundle.
// - A Linux checkout keeps its tools beside the code (tools/, .venv-whisperx/),
//   or in an installed engine's home when .engine-home says so.
// - FABULA_ENGINE_HOME overrides either: the Windows dev staging and the tests
//   point it at a folder of their own.
//
// The checkout opened from a \\wsl.localhost share (the old WSL route) is the
// only case that is not "this machine": electron/main.cjs keeps that bridge.
// CJS so the Electron main reads it synchronously and ESM imports it.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CODE_ROOT = path.join(__dirname, "..");
const IS_WINDOWS = process.platform === "win32";
const exe = (name) => (IS_WINDOWS ? `${name}.exe` : name);

// The engine home: shared tools, venvs, models and settings.
function engineHome(env = process.env) {
  if (env.FABULA_ENGINE_HOME) return path.resolve(env.FABULA_ENGINE_HOME);
  if (IS_WINDOWS) return path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Fabula", "engine");
  try {
    const home = fs.readFileSync(path.join(CODE_ROOT, ".engine-home"), "utf8").trim();
    if (home.startsWith("/")) return home;
  } catch { /* a checkout */ }
  return null;
}

// Where the tools and venvs are: the engine home on Windows (and when a Linux
// engine is installed, through the links setup-engine.sh makes beside the
// code, so both answers agree), beside the code in a checkout.
function toolsRoot(env = process.env) {
  const home = engineHome(env);
  return IS_WINDOWS && home ? home : CODE_ROOT;
}

const venvDir = (env) => {
  const root = toolsRoot(env);
  return path.join(root, IS_WINDOWS ? "venv-whisperx" : ".venv-whisperx");
};

function ffmpeg(env = process.env) {
  return IS_WINDOWS ? path.join(toolsRoot(env), "tools", "ffmpeg", "bin", "ffmpeg.exe") : path.join(toolsRoot(env), "tools", "ffmpeg", "ffmpeg");
}

function ffprobe(env = process.env) {
  return IS_WINDOWS ? path.join(toolsRoot(env), "tools", "ffmpeg", "bin", "ffprobe.exe") : path.join(toolsRoot(env), "tools", "ffmpeg", "ffprobe");
}

// The venv's own programs: Scripts\x.exe on Windows, bin/x elsewhere.
function venvProgram(name, env = process.env) {
  return path.join(venvDir(env), IS_WINDOWS ? "Scripts" : "bin", exe(name));
}

const whisperx = (env = process.env) => venvProgram("whisperx", env);
const python = (env = process.env) => venvProgram("python", env);

// The environment WhisperX (and anything else in the venv) needs: the CUDA
// libraries the wheels carry, the engine's ffmpeg first on PATH, and the
// models kept in the engine home rather than the user's profile.
function venvEnv(env = process.env) {
  const out = { ...env };
  const venv = venvDir(env);
  const ffmpegDir = path.dirname(ffmpeg(env));
  if (IS_WINDOWS) {
    // ctranslate2 loads cuBLAS and cuDNN from PATH; torch ships them.
    const torchLib = path.join(venv, "Lib", "site-packages", "torch", "lib");
    out.PATH = [torchLib, ffmpegDir, env.PATH ?? env.Path ?? ""].filter(Boolean).join(path.delimiter);
    delete out.Path;
  } else {
    // faster-whisper loads CUDA from the nvidia wheels inside the venv.
    const lib = path.join(venv, "lib");
    let site = null;
    try { site = fs.readdirSync(lib).find((name) => /^python3\.\d+$/.test(name)) ?? null; } catch { site = null; }
    if (site) {
      const nv = path.join(lib, site, "site-packages", "nvidia");
      const libs = ["cublas", "cudnn", "cuda_runtime", "cufft", "nvjitlink"].map((name) => path.join(nv, name, "lib"));
      out.LD_LIBRARY_PATH = [libs.join(path.delimiter), env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter);
    }
    out.PATH = [ffmpegDir, env.PATH].filter(Boolean).join(path.delimiter);
  }
  const home = engineHome(env);
  if (IS_WINDOWS && home) {
    out.HF_HOME = out.HF_HOME || path.join(home, "models", "huggingface");
    out.TORCH_HOME = out.TORCH_HOME || path.join(home, "models", "torch");
  }
  return out;
}

// How to run a Node script from wherever this code runs. Under Electron
// (Fabula.exe, or the checkout's electron) the runtime is Node only with
// ELECTRON_RUN_AS_NODE; under node it is node.
function nodeRunner() {
  const electron = Boolean(process.versions.electron);
  return { command: process.execPath, env: electron ? { ELECTRON_RUN_AS_NODE: "1" } : {} };
}

// How to run an Electron main script headless (a render, a frame). The
// installed window runs from a packaged Fabula.exe, which ignores a script
// argument and starts its bootstrap; at startup it sets FABULA_ELECTRON to
// itself and FABULA_ELECTRON_SCRIPT_FLAG to the bootstrap's switch, and every
// job and server it starts inherits them. A checkout runs its own electron
// with the script as the app.
function electronRunner(env = process.env) {
  if (env.FABULA_ELECTRON) return { command: env.FABULA_ELECTRON, scriptFlag: env.FABULA_ELECTRON_SCRIPT_FLAG || null };
  return { command: path.join(CODE_ROOT, "node_modules", "electron", "dist", exe("electron")), scriptFlag: null };
}

function electronArgs(script, args = [], env = process.env) {
  const runner = electronRunner(env);
  const flags = IS_WINDOWS ? [] : ["--no-sandbox", "--no-zygote", "--ozone-platform=headless"];
  return { command: runner.command, args: [...flags, ...(runner.scriptFlag ? [runner.scriptFlag, script] : [script]), ...args] };
}

module.exports = {
  CODE_ROOT, IS_WINDOWS, exe, engineHome, toolsRoot, ffmpeg, ffprobe, whisperx, python, venvProgram, venvEnv, nodeRunner, electronRunner, electronArgs,
};
