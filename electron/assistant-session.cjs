"use strict";
// One assistant session at a time, running in a real terminal inside the
// pipeline host and shown in the window's own pane. From Windows the host is
// the WSL distribution the checkout lives in; on Linux it is this machine.
// Everything crosses as argv, never as a shell string.

const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");

const EFFORTS = {
  codex: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  claude: ["low", "medium", "high", "xhigh", "max"],
};

const TASKS = ["compose", "make"];
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

// The command that runs the bridge on the pipeline host.
function sessionCommand({ platform = process.platform, repo, distro, cols, rows, args, extra = [] }) {
  const size = [String(Math.max(20, Math.min(1000, cols | 0)) || 120), String(Math.max(5, Math.min(1000, rows | 0)) || 40)];
  const bridge = ["python3", "scripts/pty-bridge.py", ...size, "bash", "-l", "scripts/assistant-run.sh", ...args, ...extra];
  if (platform === "win32") {
    if (!distro) throw new Error("This window cannot reach the WSL distribution that holds the checkout.");
    return { command: "wsl.exe", args: ["--distribution", distro, "--cd", repo, "--", ...bridge], cwd: undefined };
  }
  if (platform !== "linux") throw new Error("The assistant runs on Windows with WSL, or on Linux.");
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
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
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
    try { this.child.stdin.end(); } catch { /* already gone */ }
    const child = this.child;
    setTimeout(() => { if (child.exitCode === null) child.kill(); }, 1500);
  }
}

module.exports = { AssistantSession, sessionCommand, choiceArgs, EFFORTS };
