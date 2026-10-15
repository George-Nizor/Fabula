"use strict";

// Fabula for Windows, as Instrumenta installs it: an Electron runtime (Fabula.exe) with the app
// in resources\app, and this bootstrap as its main.
//
// Everything runs on Windows. The editor's code is right here in resources\app; what it needs
// beside the code (ffmpeg, the WhisperX venv, the models, the settings) is the engine home,
// %LOCALAPPDATA%\Fabula\engine, shared by every version. The first start sets that up
// (scripts/setup-windows.mjs, run by Fabula.exe as Node) on a setup screen; every start after
// that opens the editor (electron/main.cjs) straight away.
//
// Fabula.exe is also the runtime for the editor's headless renders: `--fabula-script <file>`
// runs that file as the Electron main instead, and nothing else happens here.

const fs = require("node:fs");
const path = require("node:path");
const engine = require("./engine.cjs");

const APP = __dirname;

// The script switch comes before anything else, the launch check included: a render is not a
// start of Fabula.
let scriptSwitch = null;
try {
  scriptSwitch = engine.parseScriptSwitch(process.argv);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}

// What every job, server and render the editor starts inherits: Fabula.exe is the Electron and,
// with ELECTRON_RUN_AS_NODE, the Node (scripts/host.cjs).
function setHostEnv(home) {
  process.env.FABULA_ELECTRON = process.execPath;
  process.env.FABULA_ELECTRON_SCRIPT_FLAG = engine.SCRIPT_FLAG;
  if (home) process.env.FABULA_ENGINE_HOME = home;
}

if (scriptSwitch) {
  setHostEnv(process.env.FABULA_ENGINE_HOME || null);
  process.argv = scriptSwitch.argv;
  require(scriptSwitch.file);
} else {
  startFabula();
}

function startFabula() {
  const { app, BrowserWindow, dialog, ipcMain, nativeTheme } = require("electron");
  const { execFile, spawn } = require("node:child_process");
  const VERSION = app.getVersion();

  // Instrumenta's launch check asks whether the program starts, not whether the engine is set up.
  const checkAt = process.argv.indexOf("--instrumenta-launch-check");
  if (checkAt >= 0) {
    try {
      const marker = process.argv[checkAt + 1];
      if (!marker) throw new Error("no marker file");
      fs.writeFileSync(marker, `FABULA_LAUNCH_OK ${VERSION}\n`, "utf8");
      app.exit(0);
    } catch {
      app.exit(1);
    }
    return;
  }

  const home = engine.engineHome(process.env, app.getPath("appData").replace(/Roaming$/i, "Local"));
  const engineFile = path.join(home, "engine.json");
  const readRaw = () => {
    try { return JSON.parse(fs.readFileSync(engineFile, "utf8")); } catch { return null; }
  };

  setHostEnv(home);
  if (engine.validState(readRaw())) {
    require(path.join(APP, "electron", "main.cjs"));
    return;
  }

  // ---- The setup screen ----------------------------------------------------------------------

  const probeGpu = () => new Promise((resolve) => {
    execFile("nvidia-smi.exe", ["--query-gpu=name,driver_version", "--format=csv,noheader"], { encoding: "utf8", timeout: 20_000, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : engine.parseGpu(stdout));
    });
  });

  function freeBytes(dir) {
    let at = dir;
    while (!fs.existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
    try {
      const stats = fs.statfsSync(at);
      return stats.bavail * stats.bsize;
    } catch {
      return null;
    }
  }

  // What the setup screen shows first: the graphics card, the free space, and whether this is a
  // first setup or the rerun of one already there.
  async function check() {
    const gpu = await probeGpu();
    return {
      ok: true,
      version: VERSION,
      gpu,
      home,
      freeBytes: freeBytes(home),
      needBytes: gpu ? 15e9 : 6e9,
      update: engine.wasSetUp(readRaw()),
      suggestedProjects: engine.defaultProjectsRoot(app.getPath("videos")),
    };
  }

  let setup = null;

  function startSetup(window, projectsRoot) {
    if (setup) return;
    const send = (event) => { if (!window.isDestroyed()) window.webContents.send("fabula-setup:event", event); };
    const script = path.join(APP, "scripts", "setup-windows.mjs");
    setup = spawn(process.execPath, engine.setupArgs({ script, version: VERSION, projectsRoot }), {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", FABULA_ENGINE_HOME: home },
      windowsHide: true,
    });
    let ready = null;
    let failed = null;
    let buffered = "";
    const take = (chunk) => {
      buffered += chunk.toString("utf8");
      const lines = buffered.split(/\n/);
      buffered = lines.pop();
      for (const line of lines) {
        const parsed = engine.parseLine(line);
        if (parsed.type === "ready") ready = parsed.root;
        if (parsed.type === "failed") { failed = parsed.text; continue; }
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
      if (code === 0 && ready && engine.validState(readRaw())) {
        send({ type: "done" });
        // The editor starts in a fresh process: its main registers what must be registered
        // before Electron is ready, which this one is long past.
        setTimeout(() => { app.relaunch(); app.exit(0); }, 1200);
      } else {
        send({ type: "failed", text: failed || `The setup stopped (exit code ${code}). The log says where.` });
      }
    });
  }

  function openSetup() {
    const window = new BrowserWindow({
      width: 760,
      height: 760,
      minWidth: 620,
      minHeight: 600,
      title: "Fabula",
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#1d1a17" : "#ffffff",
      icon: path.join(APP, "fabula.ico"),
      autoHideMenuBar: true,
      webPreferences: { preload: path.join(APP, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    ipcMain.handle("fabula-setup:check", () => check());
    ipcMain.handle("fabula-setup:start", (_event, choice) => {
      // A rerun keeps the projects where they are: only a first setup passes a folder.
      const projectsRoot = engine.wasSetUp(readRaw()) ? null : engine.projectsRootFor(choice?.projects);
      startSetup(window, projectsRoot);
    });
    ipcMain.handle("fabula-setup:choose-projects", async (_event, current) => {
      const picked = await dialog.showOpenDialog(window, {
        title: "Choose where Fabula keeps its projects",
        defaultPath: typeof current === "string" && current ? current : app.getPath("videos"),
        properties: ["openDirectory", "createDirectory"],
      });
      if (picked.canceled || !picked.filePaths[0]) return null;
      return engine.projectsRootFor(picked.filePaths[0]); // a share or a drive's top is refused here
    });
    // --setup starts the setup without waiting for the button: for a test run, or someone setting
    // Fabula up from a script.
    window.loadFile(path.join(APP, "setup.html"), { query: process.argv.includes("--setup") ? { auto: "1" } : {} });
  }

  app.whenReady().then(openSetup);
  app.on("window-all-closed", () => {
    if (setup) setup.kill();
    app.quit();
  });
}
