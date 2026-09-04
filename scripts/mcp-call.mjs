// One MCP tool call from the shell — the bridge for driving Fabula before a
// session has the server registered:
//
//   node scripts/mcp-call.mjs list_cuts
//   node scripts/mcp-call.mjs set_cut_enabled '{"index":3,"enabled":false}'

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [tool, rawArgs] = process.argv.slice(2);
if (!tool) {
  console.error("usage: node scripts/mcp-call.mjs <tool> [json-args]");
  process.exit(2);
}

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const client = new Client({ name: "fabula-cli", version: "0.1.0" });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(repoRoot, "mcp", "server.mjs")],
}));

try {
  const result = await client.callTool({ name: tool, arguments: rawArgs ? JSON.parse(rawArgs) : {} });
  console.log(result.content?.[0]?.text ?? JSON.stringify(result));
  if (result.isError) process.exitCode = 1;
} finally {
  await client.close();
}
