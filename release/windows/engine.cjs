"use strict";

// What the Windows bootstrap knows about the engine, as pure functions: where the engine home is,
// what the setup script's lines mean, what engine.json may say, where the projects go by default,
// and the script switch. No Electron and no I/O here, so the tests run it as it is.

const path = require("node:path");

// engine.json's format, as scripts/setup-windows.mjs writes it. The editor opens only on an
// engine set up by a setup of this version; a higher one makes every install run the setup again.
const SETUP_VERSION = 1;
const SCRIPT_FLAG = "--fabula-script";
const MODELS = new Set(["large-v3", "large-v3-turbo", "medium", "small", "base", "tiny"]);

// The engine home: FABULA_ENGINE_HOME, else %LOCALAPPDATA%\Fabula\engine (scripts/host.cjs agrees).
function engineHome(env, fallbackLocalAppData) {
  if (env.FABULA_ENGINE_HOME) return path.win32.resolve(env.FABULA_ENGINE_HOME);
  const local = env.LOCALAPPDATA || fallbackLocalAppData;
  if (!local) throw new Error("LOCALAPPDATA is not set.");
  return path.win32.join(local, "Fabula", "engine");
}

// `Fabula.exe --fabula-script <file> [args…]` runs <file> as the Electron main instead of the
// editor: the headless renders (scripts/export-compose.cjs, scripts/frame.cjs). The script sees
// process.argv as it would under `electron <file> args…`. Null when the switch is absent.
function parseScriptSwitch(argv, cwd = process.cwd()) {
  const at = argv.indexOf(SCRIPT_FLAG);
  if (at < 0) return null;
  const file = argv[at + 1];
  if (!file || file.startsWith("--")) throw new Error(`${SCRIPT_FLAG} needs a script file after it.`);
  const resolved = path.win32.isAbsolute(file) || path.posix.isAbsolute(file) ? file : path.resolve(cwd, file);
  return { file: resolved, argv: [argv[0], resolved, ...argv.slice(at + 2)] };
}

// One line of scripts/setup-windows.mjs's output: a step starting, download progress, the engine
// ready, the setup stopping, or a line for the log.
function parseLine(line) {
  const text = String(line).replace(/\r$/, "");
  let match = /^STEP (\d+) (\d+) (.+)$/.exec(text);
  if (match) return { type: "step", n: Number(match[1]), total: Number(match[2]), label: match[3] };
  match = /^PROGRESS (\d{1,3}) (.+)$/.exec(text);
  if (match) return { type: "progress", percent: Math.min(100, Number(match[1])), text: match[2] };
  match = /^READY (.+)$/.exec(text);
  if (match) return { type: "ready", root: match[1].trim() };
  match = /^FAIL (.+)$/.exec(text);
  if (match) return { type: "failed", text: match[1] };
  return { type: "log", text };
}

// engine.json as the bootstrap trusts it: a setup of this version that finished. Anything else
// (missing, malformed, an older setup) means the setup runs.
function validState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  if (state.setupVersion !== SETUP_VERSION) return null;
  if (state.gpu !== "cuda" && state.gpu !== "cpu") return null;
  if (!MODELS.has(state.model)) return null;
  if (typeof state.readyAt !== "string" || Number.isNaN(Date.parse(state.readyAt))) return null;
  return state;
}

// Whether an engine was set up before, by any setup version: then the setup is an update and
// starts by itself, leaving the projects where they are.
function wasSetUp(state) {
  return Boolean(state && typeof state === "object" && Number.isInteger(state.setupVersion));
}

const defaultProjectsRoot = (videos) => path.win32.join(videos, "Fabula");

// The projects folder chosen on the setup screen: a full path on a drive, not the top of one.
function projectsRootFor(folder) {
  if (typeof folder !== "string" || !folder) throw new Error("Choose a folder for the projects.");
  if (/[\x00-\x1f\x7f]/.test(folder)) throw new Error("The projects folder path has characters that cannot be used.");
  if (!/^[A-Za-z]:[\\/]/.test(folder)) throw new Error("Choose a folder on one of this PC's drives.");
  const normal = path.win32.normalize(folder).replace(/\\+$/, "");
  if (/^[A-Za-z]:$/.test(normal)) throw new Error("Choose a folder rather than the top of a drive.");
  return normal;
}

// The arguments for the setup, run by Fabula.exe as Node (ELECTRON_RUN_AS_NODE=1).
function setupArgs({ script, version, projectsRoot = null }) {
  return [script, "--version", version, ...(projectsRoot ? ["--projects-root", projectsRoot] : [])];
}

// nvidia-smi's one-line answer, for the setup screen.
function parseGpu(text) {
  const first = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!first) return null;
  const [name, driver] = first.split(",").map((part) => part.trim());
  return name && /^\d+(\.\d+)*$/.test(driver || "") ? { name, driver } : null;
}

module.exports = {
  SETUP_VERSION, SCRIPT_FLAG, defaultProjectsRoot, engineHome, parseGpu, parseLine, parseScriptSwitch, projectsRootFor, setupArgs, validState, wasSetUp,
};
