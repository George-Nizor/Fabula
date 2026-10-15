import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// The Windows bootstrap's pure half (release/windows/engine.cjs): the script switch, the setup's
// lines, what engine.json may say, and where the projects go.
const engine = createRequire(import.meta.url)("../release/windows/engine.cjs");

test("--fabula-script runs a file as the Electron main, with its arguments after it", () => {
  const argv = ["C:\\Fabula\\Fabula.exe", "--fabula-script", "C:\\Fabula\\resources\\app\\scripts\\export-compose.cjs", "--from=2", "--fresh", "C:\\Videos\\Fabula\\talk"];
  const parsed = engine.parseScriptSwitch(argv);
  assert.equal(parsed.file, "C:\\Fabula\\resources\\app\\scripts\\export-compose.cjs");
  // As under `electron <file> args…`: export-compose reads argv.slice(2), frame.cjs argv.slice(1).
  assert.deepEqual(parsed.argv, ["C:\\Fabula\\Fabula.exe", "C:\\Fabula\\resources\\app\\scripts\\export-compose.cjs", "--from=2", "--fresh", "C:\\Videos\\Fabula\\talk"]);
  assert.equal(engine.parseScriptSwitch(["Fabula.exe"]), null);
  assert.equal(engine.parseScriptSwitch(["Fabula.exe", "--instrumenta-launch-check", "x"]), null);
  assert.throws(() => engine.parseScriptSwitch(["Fabula.exe", "--fabula-script"]), /needs a script/);
  assert.throws(() => engine.parseScriptSwitch(["Fabula.exe", "--fabula-script", "--fresh"]), /needs a script/);
  assert.equal(engine.parseScriptSwitch(["Fabula.exe", "--fabula-script", "/abs/frame.cjs"]).file, "/abs/frame.cjs");
  assert.equal(engine.parseScriptSwitch(["Fabula.exe", "--fabula-script", "frame.cjs"], "/work").file, "/work/frame.cjs");
  assert.equal(engine.SCRIPT_FLAG, "--fabula-script");
});

test("the setup's lines are steps, progress, the end, a failure, or the log", () => {
  assert.deepEqual(engine.parseLine("STEP 4 8 Installing Python and WhisperX (several GB, once)"), { type: "step", n: 4, total: 8, label: "Installing Python and WhisperX (several GB, once)" });
  assert.deepEqual(engine.parseLine("PROGRESS 42 Downloading ffmpeg: 81 of 193 MB"), { type: "progress", percent: 42, text: "Downloading ffmpeg: 81 of 193 MB" });
  assert.deepEqual(engine.parseLine("READY C:\\Users\\Jo\\AppData\\Local\\Fabula\\engine\r"), { type: "ready", root: "C:\\Users\\Jo\\AppData\\Local\\Fabula\\engine" });
  assert.deepEqual(engine.parseLine("FAIL There is not enough free space."), { type: "failed", text: "There is not enough free space." });
  assert.deepEqual(engine.parseLine("NVENC: available"), { type: "log", text: "NVENC: available" });
  assert.deepEqual(engine.parseLine("PROGRESS soon"), { type: "log", text: "PROGRESS soon" });
});

test("engine.json opens the editor only when this setup version finished it", () => {
  const state = { setupVersion: engine.SETUP_VERSION, version: "0.4.0", gpu: "cuda", model: "large-v3", readyAt: "2026-10-15T12:00:00.000Z" };
  assert.deepEqual(engine.validState(state), state);
  assert.deepEqual(engine.validState({ ...state, gpu: "cpu", model: "small" }), { ...state, gpu: "cpu", model: "small" });
  assert.equal(engine.validState({ ...state, setupVersion: engine.SETUP_VERSION + 1 }), null);
  assert.equal(engine.validState({ ...state, setupVersion: 0 }), null);
  assert.equal(engine.validState({ ...state, gpu: "rocm" }), null);
  assert.equal(engine.validState({ ...state, model: "../x" }), null);
  assert.equal(engine.validState({ ...state, readyAt: "soon" }), null);
  assert.equal(engine.validState(null), null);
  assert.equal(engine.validState([]), null);
  // An older setup is a rerun, which keeps the projects where they are.
  assert.equal(engine.wasSetUp({ ...state, setupVersion: 0 }), true);
  assert.equal(engine.wasSetUp(null), false);
  assert.equal(engine.wasSetUp({}), false);
});

test("the engine home is %LOCALAPPDATA%\\Fabula\\engine unless FABULA_ENGINE_HOME says otherwise", () => {
  assert.equal(engine.engineHome({ LOCALAPPDATA: "C:\\Users\\Jo\\AppData\\Local" }), "C:\\Users\\Jo\\AppData\\Local\\Fabula\\engine");
  assert.equal(engine.engineHome({}, "C:\\Users\\Jo\\AppData\\Local"), "C:\\Users\\Jo\\AppData\\Local\\Fabula\\engine");
  assert.equal(engine.engineHome({ FABULA_ENGINE_HOME: "D:\\dev\\engine-test\\", LOCALAPPDATA: "C:\\x" }), "D:\\dev\\engine-test");
  assert.throws(() => engine.engineHome({}), /LOCALAPPDATA/);
});

test("the projects go to a Fabula folder in Videos by default, or a folder on a drive", () => {
  assert.equal(engine.defaultProjectsRoot("C:\\Users\\Jo\\Videos"), "C:\\Users\\Jo\\Videos\\Fabula");
  assert.equal(engine.projectsRootFor("C:\\Users\\Jo\\Videos\\Fabula\\"), "C:\\Users\\Jo\\Videos\\Fabula");
  assert.equal(engine.projectsRootFor("E:/Video Storage/Fabula"), "E:\\Video Storage\\Fabula");
  assert.throws(() => engine.projectsRootFor("D:\\"), /top of a drive/);
  assert.throws(() => engine.projectsRootFor("\\\\nas\\videos"), /drives/);
  assert.throws(() => engine.projectsRootFor("/mnt/c/Users"), /drives/);
  assert.throws(() => engine.projectsRootFor(""), /Choose a folder/);
  assert.throws(() => engine.projectsRootFor(null), /Choose a folder/);
  assert.throws(() => engine.projectsRootFor("C:\\a\nb"), /characters/);
});

test("the setup runs the script with the version, and a folder only on a first setup", () => {
  assert.deepEqual(engine.setupArgs({ script: "C:\\app\\scripts\\setup-windows.mjs", version: "0.4.0" }), ["C:\\app\\scripts\\setup-windows.mjs", "--version", "0.4.0"]);
  assert.deepEqual(engine.setupArgs({ script: "s.mjs", version: "0.4.0", projectsRoot: "C:\\Users\\Jo's\\Videos\\Fabula" }), ["s.mjs", "--version", "0.4.0", "--projects-root", "C:\\Users\\Jo's\\Videos\\Fabula"]);
});

test("nvidia-smi's answer names the card, or there is none", () => {
  assert.deepEqual(engine.parseGpu("NVIDIA GeForce RTX 4080 SUPER, 617.14\r\n"), { name: "NVIDIA GeForce RTX 4080 SUPER", driver: "617.14" });
  assert.equal(engine.parseGpu(""), null);
  assert.equal(engine.parseGpu("No devices were found"), null);
});
