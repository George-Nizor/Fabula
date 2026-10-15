"use strict";
// One assistant session at a time, running in a real terminal inside the
// pipeline host and shown in the window's own pane. On Windows the host is
// this machine: a ConPTY (scripts/pty-bridge-win.py, from the WhisperX venv)
// runs Fabula.exe as Node on scripts/assistant.mjs. A checkout opened from a
// \\wsl.localhost share (the developer route) runs it in the WSL
// distribution that holds the checkout; on Linux it is this machine.
// Everything crosses as argv, never as a shell string.

const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const host = require("../scripts/host.cjs");

const EFFORTS = {
  codex: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  claude: ["low", "medium", "high", "xhigh", "max"],
};

const TASKS = ["compose", "make", "motion"];
const PERSONAS = ["editor", "farmer", "critic"];

function choiceArgs({ provider, model, effort, task, persona } = {}) {
  if (!Object.hasOwn(EFFORTS, provider)) throw new Error("Choose Claude Code or Codex.");
  model = typeof model === "string" ? model.trim() : "";
  effort = typeof effort === "string" ? effort.trim() : "";
  if (model && !/^[a-z0-9][a-z0-9._:-]*$/i.test(model)) throw new Error("That is not a model ID.");
  if (effort && !EFFORTS[provider].includes(effort)) throw new Error("That reasoning effort is not one the CLI offers.");
  const args = ["--provider", provider, "--model", model || "default", "--effort", effort || "default"];
  if (persona) {
    if (!PERSONAS.includes(persona)) throw new Error("That is not a persona the assistant knows.");
    args.push("--persona", persona);
  }
  if (task) {
    if (!TASKS.includes(task)) throw new Error("That is not a task the assistant knows.");
    args.push("--task", task);
  }
  return args;
}

// The command that runs the bridge on the pipeline host. `env`, when given,
// is the whole environment the bridge starts with.
//
// On Windows `distro` chooses: set, the checkout is in WSL and the session
// runs there; unset, the session is native, and `repo` is the Windows folder
// of the app code. `python`, `execPath` and `env` default to this machine's
// (the venv's python, Fabula.exe, host.venvEnv()); tests pass their own.
function sessionCommand({ platform = process.platform, repo, distro, cols, rows, args, extra = [], python, execPath = process.execPath, env }) {
  const size = [String(Math.max(20, Math.min(1000, cols | 0)) || 120), String(Math.max(5, Math.min(1000, rows | 0)) || 40)];
  if (platform === "win32" && !distro) {
    if (!repo) throw new Error("This window does not know where Fabula's code is.");
    const scripts = path.win32.join(repo, "scripts");
    return {
      command: python ?? host.python(),
      args: [path.win32.join(scripts, "pty-bridge-win.py"), ...size, execPath, path.win32.join(scripts, "assistant.mjs"), ...args, ...extra],
      cwd: repo,
      // Fabula.exe runs assistant.mjs as Node; the bridge hands its environment on.
      env: { ...(env ?? host.venvEnv()), ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  const bridge = ["python3", "scripts/pty-bridge.py", ...size, "bash", "-l", "scripts/assistant-run.sh", ...args, ...extra];
  if (platform === "win32") {
    // -e: argv straight to the command. `--` would hand the line to the distribution's shell to
    // read again first.
    return { command: "wsl.exe", args: ["--distribution", distro, "--cd", repo, "-e", ...bridge], cwd: undefined };
  }
  if (platform !== "linux") throw new Error("The assistant runs on Windows or on Linux.");
  return { command: bridge[0], args: bridge.slice(1), cwd: repo };
}

class AssistantSession extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.choice = null;
  }

  get running() { return Boolean(this.child) && this.child.exitCode === null && !this.child.killed; }

  start(options) {
    if (this.running) throw new Error("An assistant is already running. Stop it first.");
    const launch = sessionCommand(options);
    // The WSL and Linux bridges run their own node: the window's
    // ELECTRON_RUN_AS_NODE stays behind. The native one sets it on purpose.
    const env = launch.env ? { ...launch.env } : { ...process.env };
    if (!launch.env) delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(launch.command, launch.args, { cwd: launch.cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    this.choice = options.choice ?? null;
    child.stdout.on("data", (data) => this.emit("data", data));
    child.stderr.on("data", (data) => this.emit("data", data));
    child.on("error", (error) => { this.emit("data", Buffer.from(`\r\n${error.message}\r\n`)); });
    child.on("exit", (code, signal) => { this.child = null; this.emit("exit", code ?? (signal ? 1 : 0)); });
    return launch;
  }

  write(data) {
    if (this.running && typeof data === "string" && data.length <= 65536) this.child.stdin.write(data);
  }

  resize(cols, rows) {
    if (this.running && Number.isInteger(cols) && Number.isInteger(rows)) this.child.stdin.write(`\x1b]7777;${cols};${rows}\x07`);
  }

  stop() {
    if (!this.running) return;
    // Ending stdin is the stop: pty-bridge.py hangs the terminal up, and
    // pty-bridge-win.py ends the CLI's whole process tree.
    try { this.child.stdin.end(); } catch { /* already gone */ }
    const child = this.child;
    setTimeout(() => { if (child.exitCode === null) child.kill(); }, 1500);
  }
}

module.exports = { AssistantSession, sessionCommand, choiceArgs, EFFORTS };
