import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
const { AssistantSession, sessionCommand, choiceArgs } = createRequire(import.meta.url)("../electron/assistant-session.cjs");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

test("the window's choice becomes plain argv, never a shell string", () => {
  assert.deepEqual(choiceArgs({ provider: "claude", model: "fable", effort: "high" }), ["--provider", "claude", "--model", "fable", "--effort", "high"]);
  assert.deepEqual(choiceArgs({ provider: "codex", model: "", effort: "" }), ["--provider", "codex", "--model", "default", "--effort", "default"]);
  assert.deepEqual(choiceArgs({ provider: "claude", model: "fable", effort: "high", task: "compose" }).slice(-2), ["--task", "compose"]);
  assert.throws(() => choiceArgs({ provider: "claude", task: "delete-everything" }), /task/);
  assert.deepEqual(choiceArgs({ provider: "claude", model: "", effort: "", persona: "farmer" }).slice(-2), ["--persona", "farmer"]);
  assert.throws(() => choiceArgs({ provider: "claude", persona: "influencer" }), /persona/);
  assert.throws(() => choiceArgs({ provider: "gemini" }), /Claude Code or Codex/);
  assert.throws(() => choiceArgs({ provider: "claude", model: "x; rm -rf ~" }), /model ID/);
  assert.throws(() => choiceArgs({ provider: "claude", effort: "ultra" }), /reasoning effort/);
  const win = sessionCommand({ platform: "win32", repo: "/w/Fabula", distro: "Ubuntu", cols: 132, rows: 43, args: ["--provider", "claude"] });
  assert.equal(win.command, "wsl.exe");
  assert.deepEqual(win.args, ["--distribution", "Ubuntu", "--cd", "/w/Fabula", "-e", "python3", "scripts/pty-bridge.py", "132", "43", "bash", "-l", "scripts/assistant-run.sh", "--provider", "claude"]);
  // Native Windows: Fabula.exe runs assistant.mjs as Node over pipes, with the pane's size;
  // assistant.mjs runs the CLI inside the ConPTY bridge (a GUI exe cannot attach to a console).
  const native = sessionCommand({ platform: "win32", repo: "C:\\Fabula\\resources\\app", cols: 132, rows: 43, args: ["--provider", "codex"], extra: ["--dry-run"],
    python: "C:\\E\\venv-whisperx\\Scripts\\python.exe", execPath: "C:\\Fabula\\Fabula.exe", env: { PATH: "C:\\x", ELECTRON_RUN_AS_NODE: "0" } });
  assert.equal(native.command, "C:\\Fabula\\Fabula.exe");
  assert.deepEqual(native.args, ["C:\\Fabula\\resources\\app\\scripts\\assistant.mjs", "--provider", "codex", "--dry-run"]);
  assert.equal(native.cwd, "C:\\Fabula\\resources\\app");
  assert.deepEqual(native.env, { PATH: "C:\\x", ELECTRON_RUN_AS_NODE: "1", FABULA_PTY_COLS: "132", FABULA_PTY_ROWS: "43" }, "Fabula.exe runs as Node and knows the pane's size");
  const tiny = sessionCommand({ platform: "win32", repo: "C:\\F", cols: 1, rows: 1, args: [], python: "p", execPath: "e", env: {} });
  assert.equal(`${tiny.env.FABULA_PTY_COLS}x${tiny.env.FABULA_PTY_ROWS}`, "20x5");
  assert.equal(win.env, undefined, "the WSL route keeps the window's environment");
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

test("the Windows bridge strips the resize sequence even when it arrives in pieces", () => {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("bridge", sys.argv[1])
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
cases = [b"plain", b"a\\x1b]7777;80;24\\x07b", b"tail\\x1b]77", b"x\\x1b]7777;90", b"\\x1b]7777;bad\\x07ok", b"esc\\x1b[A"]
out = []
for case in cases:
    text, sizes, pending = bridge.split_controls(case)
    out.append([text.decode(), sizes, pending.decode()])
print(json.dumps(out))`;
  const result = spawnSync("python3", ["-c", script, path.join(ROOT, "scripts", "pty-bridge-win.py")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    ["plain", [], ""],
    ["ab", [[80, 24]], ""],
    ["tail", [], "\x1b]77"],
    ["x", [], "\x1b]7777;90"],
    ["ok", [], ""],
    ["esc\x1b[A", [], ""],
  ]);
});
