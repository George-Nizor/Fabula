import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
const { AssistantSession, sessionCommand, choiceArgs } = createRequire(import.meta.url)("../electron/assistant-session.cjs");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

test("the window's choice becomes plain argv, never a shell string", () => {
  assert.deepEqual(choiceArgs({ provider: "claude", model: "fable", effort: "high" }), ["--provider", "claude", "--model", "fable", "--effort", "high"]);
  assert.deepEqual(choiceArgs({ provider: "codex", model: "", effort: "" }), ["--provider", "codex", "--model", "default", "--effort", "default"]);
  assert.deepEqual(choiceArgs({ provider: "claude", model: "fable", effort: "high", task: "compose" }).slice(-2), ["--task", "compose"]);
  assert.throws(() => choiceArgs({ provider: "claude", task: "delete-everything" }), /task/);
  assert.throws(() => choiceArgs({ provider: "gemini" }), /Claude Code or Codex/);
  assert.throws(() => choiceArgs({ provider: "claude", model: "x; rm -rf ~" }), /model ID/);
  assert.throws(() => choiceArgs({ provider: "claude", effort: "ultra" }), /reasoning effort/);
  const win = sessionCommand({ platform: "win32", repo: "/w/Fabula", distro: "Ubuntu", cols: 132, rows: 43, args: ["--provider", "claude"] });
  assert.equal(win.command, "wsl.exe");
  assert.deepEqual(win.args, ["--distribution", "Ubuntu", "--cd", "/w/Fabula", "--", "python3", "scripts/pty-bridge.py", "132", "43", "bash", "-l", "scripts/assistant-run.sh", "--provider", "claude"]);
  const linux = sessionCommand({ platform: "linux", repo: "/w/Fabula", cols: 80, rows: 24, args: [] });
  assert.equal(linux.command, "python3");
  assert.equal(linux.cwd, "/w/Fabula");
});

test("the bridge gives the command a real terminal, relays both ways, and resizes on the control sequence", { timeout: 20000 }, async () => {
  const session = new AssistantSession();
  let output = "";
  session.on("data", (chunk) => { output += chunk.toString("utf8"); });
  const exited = new Promise((resolve) => session.once("exit", resolve));
  // A stand-in for the assistant: report the terminal, wait for a line, report again.
  const script = 'test -t 0 && echo TTY_OK; stty size; read -r line; echo "got:$line"; stty size';
  const launch = sessionCommand({ platform: "linux", repo: ROOT, cols: 100, rows: 30, args: [] });
  launch.args = ["scripts/pty-bridge.py", "100", "30", "bash", "-c", script];
  const { spawn } = await import("node:child_process");
  const child = spawn(launch.command, launch.args, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
  session.child = child;
  child.stdout.on("data", (d) => session.emit("data", d));
  child.on("exit", (code) => { session.child = null; session.emit("exit", code); });
  await new Promise((r) => setTimeout(r, 700));
  session.resize(72, 20);
  await new Promise((r) => setTimeout(r, 300));
  session.write("hello there\r");
  const code = await exited;
  assert.equal(code, 0, output);
  assert.match(output, /TTY_OK/, "the command saw a terminal");
  assert.match(output, /30 100/, "the initial size");
  assert.match(output, /got:hello there/, "input reached the command");
  assert.match(output, /20 72/, "the resize was applied");
  assert.ok(!output.includes("7777"), "the control sequence never reached the command");
});
