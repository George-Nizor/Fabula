// One MCP tool call from the shell — the bridge for driving Fabula before a
// session has the server registered:
//
//   node scripts/mcp-call.mjs list_cuts
//   node scripts/mcp-call.mjs set_cut_enabled '{"index":3,"enabled":false}'

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [tool, rawArgs, argsFile] = process.argv.slice(2);
const toolArgs = rawArgs === "--args-file" ? JSON.parse(fs.readFileSync(argsFile, "utf8")) : rawArgs ? JSON.parse(rawArgs) : {};
if (!tool) {
  console.error("usage: node scripts/mcp-call.mjs <tool> [json-args]");
  process.exit(2);
}

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const client = new Client({ name: "fabula-cli", version: "0.1.0" });
// The caller's environment, whole: the SDK's default passes only a handful
// of variables, and FABULA_PROJECTS_ROOT (a root that is not the person's)
// must reach the server or a test run lands in their projects.
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(repoRoot, "mcp", "server.mjs")],
  env: { ...process.env },
}));

try {
  // Renders and transcriptions run for minutes; the SDK's default 60s
  // request timeout is for conversations, not exports.
  const result = await client.callTool(
    { name: tool, arguments: toolArgs },
    undefined,
    { timeout: 3 * 60 * 60 * 1000 }
  );
  console.log(result.content?.[0]?.text ?? JSON.stringify(result));
  if (result.isError) process.exitCode = 1;
} finally {
  await client.close();
}
