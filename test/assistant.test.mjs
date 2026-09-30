import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ROOT, buildLaunch, selection, readPreferences, savePreferences } from "../scripts/assistant.mjs";
import { INVARIANTS } from "../core/assistant-brief.mjs";

test("model IDs remain literal arguments; provider effort mappings and default inheritance", () => {
  const model = 'custom-model-$(touch unwanted)';
  const root = '/tmp/a project "with quotes"';
  const codex = buildLaunch({ provider: "codex", model, effort: "high" }, root);
  assert.equal(codex.args[codex.args.indexOf("--model") + 1], model);
  assert.ok(codex.args.includes('model_reasoning_effort="high"'));
  assert.ok(codex.args.includes(`mcp_servers.fabula.args=${JSON.stringify([path.join(root, "mcp/server.mjs")])}`));
  const claude = buildLaunch({ provider: "claude", model, effort: "max" }, root);
  assert.equal(claude.args[claude.args.indexOf("--effort") + 1], "max");
  assert.equal(claude.args[claude.args.indexOf("--model") + 1], model);
  for (const provider of ["codex", "claude"]) {
    const launch = buildLaunch(selection(provider, "default", "default"));
    assert.ok(!launch.args.includes("--model"));
    assert.ok(!launch.args.includes("--effort"));
    assert.ok(!launch.args.some(arg => arg.startsWith("model_reasoning_effort=")));
    assert.ok(!launch.args.some(arg => arg.includes("dangerously")));
  }
  const composing = buildLaunch({ provider: "claude", model: "", effort: "", task: "compose" });
  assert.match(composing.args.at(-1), /approved the cut/);
  // The persona leads the first message and names itself; the editor is the default.
  assert.equal(composing.persona, "editor");
  assert.match(composing.args.at(-1), /^Today you are working as a film editor/);
  assert.match(composing.args.at(-1), /adopt_persona with persona "editor"/);
  // A task's session is told to work, a bare one to wait; never both, or
  // Make it into a video stops to ask the question its brief answered.
  const making = buildLaunch({ provider: "claude", model: "", effort: "", task: "make" }).args.at(-1);
  assert.match(making, /pressed Make it into a video/);
  assert.doesNotMatch(making, /wait for my instruction|Do not render until I ask/);
  assert.doesNotMatch(composing.args.at(-1), /wait for my instruction/);
  const bare = buildLaunch({ provider: "claude", model: "", effort: "" }).args.at(-1);
  assert.match(bare, /wait for my instruction here/);
  assert.match(bare, /Do not render until I ask/);
  const farming = buildLaunch({ provider: "codex", model: "", effort: "", persona: "farmer" });
  assert.equal(farming.persona, "farmer");
  assert.ok(farming.args.includes('mcp_servers.fabula.env={FABULA_PERSONA="farmer"}'), "codex's server learns the persona");
  const claudeFarming = buildLaunch({ provider: "claude", model: "", effort: "", persona: "farmer" });
  assert.ok(JSON.parse(claudeFarming.args[claudeFarming.args.indexOf("--mcp-config") + 1]).mcpServers.fabula.env.FABULA_PERSONA === "farmer", "claude's server learns the persona");
  assert.match(farming.args.at(-1), /short-form editor cutting for a feed/);
  assert.ok(farming.args.at(-1).startsWith(INVARIANTS), "the invariants still lead Codex's first message");
  assert.throws(() => buildLaunch({ provider: "claude", model: "", effort: "", persona: "influencer" }), /persona must be one of/);
  assert.throws(() => buildLaunch({ provider: "claude", model: "", effort: "", task: "nope" }), /Unknown task/);
  assert.throws(() => selection("unknown"), /Provider/);
  assert.throws(() => selection("claude", "model", "ultra"), /Effort/);
  assert.throws(() => selection("codex", "--help"), /model ID/);
});

test("switching providers retains each model and reasoning preference independently", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabula-preferences-"));
  const file = path.join(dir, "prefs.json");
  try {
    let prefs = readPreferences(file);
    savePreferences(prefs, selection("codex", "chosen-codex-model", "high"), file);
    prefs = readPreferences(file);
    savePreferences(prefs, selection("claude", "chosen-claude-model", "max"), file);
    prefs = readPreferences(file);
    assert.equal(prefs.provider, "claude");
    assert.deepEqual(prefs.profiles.codex, { model: "chosen-codex-model", effort: "high" });
    assert.deepEqual(prefs.profiles.claude, { model: "chosen-claude-model", effort: "max" });
    assert.equal(prefs.persona, "editor", "the persona defaults to the editor");
    savePreferences(prefs, { ...selection("claude", "chosen-claude-model", "max"), persona: "farmer" }, file);
    assert.equal(readPreferences(file).persona, "farmer");
    savePreferences(readPreferences(file), selection("codex", "default", "default"), file);
    assert.equal(readPreferences(file).persona, "farmer", "a launch that does not name a persona keeps the saved one");
    savePreferences(prefs, selection("codex", "default", "default"), file);
    assert.deepEqual(readPreferences(file).profiles.claude, prefs.profiles.claude);
    fs.writeFileSync(file, "broken");
    assert.throws(() => readPreferences(file), /Cannot read/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("dry-run does not save settings or acquire a session lock", () => {
  const before = [".assistant-preferences.json", ".assistant-session.lock"].map(name => {
    const file = path.join(ROOT, name);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  });
  const result = spawnSync(process.execPath, [path.join(ROOT, "scripts/assistant.mjs"),
    "--provider", "codex", "--model", "exact-model-id", "--effort", "high", "--dry-run"], { encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).model, "exact-model-id");
  assert.deepEqual([".assistant-preferences.json", ".assistant-session.lock"].map(name => {
    const file = path.join(ROOT, name);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  }), before);
});

for (const provider of ["codex", "claude"]) {
  test(`${provider} launch configuration connects to the same live MCP tool server`, { timeout: 15000 }, async () => {
    const launch = buildLaunch({ provider, model: "", effort: "" });
    let config;
    if (provider === "claude") {
      config = JSON.parse(launch.args[launch.args.indexOf("--mcp-config") + 1]).mcpServers.fabula;
    } else {
      const value = key => JSON.parse(launch.args.find(arg => arg.startsWith(`mcp_servers.fabula.${key}=`)).split("=").slice(1).join("="));
      config = { command: value("command"), args: value("args"), cwd: value("cwd") };
    }
    const client = new Client({ name: `fabula-${provider}-test`, version: "1.0.0" });
    try {
      await client.connect(new StdioClientTransport(config));
      assert.ok(client.getInstructions().includes(INVARIANTS), "the server hands over the canonical brief");
      const { tools } = await client.listTools();
      for (const name of ["status", "set_scenes", "render_clean", "render_final", "wait_for_input", "get_theme"]) {
        assert.ok(tools.some(tool => tool.name === name), name);
      }
      const result = await client.callTool({ name: "list_themes", arguments: {} });
      assert.ok(!result.isError, JSON.stringify(result));
      assert.match(result.content[0].text, /broadcast/);
    } finally { await client.close(); }
  });
}
