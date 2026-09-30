"use strict";

// Fabula for Windows, as Instrumenta installs it: an Electron runtime and this bootstrap.
//
// The editor runs from its engine in the person's WSL. Its pipeline (WhisperX, ffmpeg, a headless
// Electron for the renders) and the assistant's terminal sessions are Linux programs, so the first
// time a version starts, this sets the engine up (scripts/setup-engine.sh, inside the
// distribution) and relaunches; every start after that loads the editor's own main from the
// engine through the \\wsl.localhost share. That is exactly how a developer's checkout runs, so
// the editor finds WSL from where it lives and bridges its jobs and its assistant into it,
// without knowing it was installed.

const { app, BrowserWindow, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const engine = require("./engine.cjs");

const VERSION = app.getVersion();
const ENGINE_FILES = path.join(__dirname, "engine");

// Instrumenta's launch check is answered here, before anything touches WSL: it asks whether the
// program starts, not whether the engine is set up.
function answerLaunchCheck() {
  const at = process.argv.indexOf("--instrumenta-launch-check");
  if (at < 0) return false;
  const marker = process.argv[at + 1];
  try {
    if (!marker) throw new Error("no marker file");
    fs.writeFileSync(marker, `FABULA_LAUNCH_OK ${VERSION}\n`, "utf8");
    app.exit(0);
  } catch {
    app.exit(1);
  }
  return true;
}

// Where the engine was set up, beside the window's own settings.
const stateFile = () => path.join(app.getPath("userData"), "engine.json");

function readState() {
  try {
    return engine.validState(JSON.parse(fs.readFileSync(stateFile(), "utf8")));
  } catch {
    return null;
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

// The editor's main for this version, when the engine has it ready.
function editorMain(state) {
  if (!state) return null;
  try {
    const dir = engine.versionDir(state, VERSION);
    return fs.existsSync(path.join(dir, ".engine-ready")) ? path.join(dir, "electron", "main.cjs") : null;
  } catch {
    return null;
  }
}

function run(command, args, { timeout = 60_000 } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "buffer", timeout, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code ?? 0, out: engine.decodeWslOutput(stdout), err: engine.decodeWslOutput(stderr) });
    });
  });
}

// What the setup screen shows first: whether WSL is here, which distribution the engine would go
// into, and whether this is a first setup or an update of one already there.
async function checkWsl() {
  const previous = readState();
  const probe = await run("wsl.exe", ["-e", "sh", "-c", 'printf "%s\\n%s\\n" "$WSL_DISTRO_NAME" "$HOME"'], { timeout: 120_000 });
  if (!probe.ok) {
    const said = `${probe.out}\n${probe.err}`.trim();
    return {
      ok: false,
      reason: probe.code === "ENOENT"
        ? "Windows Subsystem for Linux is not installed on this PC."
        : said || "WSL did not answer.",
    };
  }
  try {
    const { distro, home } = engine.parseProbe(probe.out);
    return { ok: true, distro: previous?.distro || distro, home: previous?.distro ? previous.home : home, update: Boolean(previous), version: VERSION };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

let setup = null;

function startSetup(window, { distro, home }) {
  if (setup) return;
  const script = engine.toWslPath(path.join(ENGINE_FILES, "setup-engine.sh"));
  const tarball = engine.toWslPath(path.join(ENGINE_FILES, `fabula-engine-${VERSION}.tar.gz`));
  const { command, args } = engine.setupCommand({ distro, script, tarball, version: VERSION });
  const send = (event) => { if (!window.isDestroyed()) window.webContents.send("fabula-setup:event", event); };
  setup = spawn(command, args, { windowsHide: true });
  let ready = null;
  let buffered = "";
  const take = (chunk) => {
    buffered += engine.decodeWslOutput(chunk);
    const lines = buffered.split(/\n/);
    buffered = lines.pop();
    for (const line of lines) {
      const parsed = engine.parseLine(line);
      if (parsed.type === "ready") ready = parsed.root;
      send(parsed);
    }
  };
  setup.stdout.on("data", take);
  setup.stderr.on("data", take);
  setup.once("error", (error) => {
    setup = null;
    send({ type: "failed", text: error.message });
  });
  setup.once("close", (code) => {
    setup = null;
    if (buffered) take("\n");
    if (code === 0 && ready) {
      writeState({ distro, home, root: ready });
      send({ type: "done" });
      // The editor starts in a fresh process: its main registers what must be registered before
      // Electron is ready, which this one is long past.
      setTimeout(() => { app.relaunch(); app.exit(0); }, 1200);
    } else {
      send({ type: "failed", text: `The setup stopped (exit code ${code}). The log above says where.` });
    }
  });
}

function openSetup() {
  const window = new BrowserWindow({
    width: 760,
    height: 600,
    minWidth: 620,
    minHeight: 520,
    title: "Fabula",
    backgroundColor: "#faf9f5",
    icon: path.join(__dirname, "fabula-mark.png"),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  ipcMain.handle("fabula-setup:check", () => checkWsl());
  ipcMain.handle("fabula-setup:start", (_event, target) => {
    const choice = engine.validState({ ...target, root: "/" });
    if (!choice) throw new Error("That is not a distribution to set up in.");
    startSetup(window, choice);
  });
  ipcMain.handle("fabula-setup:learn", () => shell.openExternal("https://learn.microsoft.com/windows/wsl/install"));
  // --setup starts the setup as soon as WSL checks out, without waiting for the button: for a
  // test run, or someone setting Fabula up from a script.
  window.loadFile(path.join(__dirname, "setup.html"), { query: process.argv.includes("--setup") ? { auto: "1" } : {} });
  return window;
}

if (!answerLaunchCheck()) {
  const main = editorMain(readState());
  if (main) {
    require(main);
  } else {
    app.whenReady().then(openSetup);
    app.on("window-all-closed", () => {
      if (setup) setup.kill();
      app.quit();
    });
  }
}
