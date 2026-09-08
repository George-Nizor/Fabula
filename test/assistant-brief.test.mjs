import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { INVARIANTS, INVARIANTS_HEADING } from "../core/assistant-brief.mjs";
import { buildLaunch } from "../scripts/assistant.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// The invariants are worth nothing if a copy drifts. Every channel that carries
// them is checked against the one source.
test("every file a CLI loads by itself carries the invariants verbatim", () => {
  for (const name of ["CLAUDE.md", "AGENTS.md", "docs/assistant-workflow.md"]) {
    const text = fs.readFileSync(path.join(ROOT, name), "utf8");
    assert.ok(text.includes(INVARIANTS_HEADING), `${name} has no ${INVARIANTS_HEADING}`);
    assert.ok(text.includes(INVARIANTS), `${name} does not carry the invariants verbatim; update it from core/assistant-brief.mjs`);
  }
});

test("Claude gets them as a system prompt, Codex in its first message", () => {
  const claude = buildLaunch({ provider: "claude", model: "", effort: "" });
  const appended = claude.args[claude.args.indexOf("--append-system-prompt") + 1];
  assert.equal(appended, INVARIANTS);
  assert.ok(!claude.args.at(-1).startsWith(INVARIANTS), "Claude's user prompt does not repeat the system prompt");

  const codex = buildLaunch({ provider: "codex", model: "", effort: "" });
  assert.ok(!codex.args.includes("--append-system-prompt"), "codex has no such flag");
  assert.ok(codex.args.at(-1).startsWith(INVARIANTS), "Codex's first message leads with them");
});

test("the MCP server hands them to whichever client connects", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const client = new Client({ name: "fabula-brief-test", version: "1.0.0" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, "mcp/server.mjs")] }));
    assert.ok(client.getInstructions().includes(INVARIANTS));
  } finally { await client.close(); }
});
