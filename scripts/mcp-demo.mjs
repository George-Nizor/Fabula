// Drives the Fabula MCP server through a real MCP client — the same protocol
// a registered agent session speaks — so the review window can be watched
// reacting to each call. Paced deliberately: this is a demonstration.
//
//   node scripts/mcp-demo.mjs <video-path>

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const videoPath = process.argv[2];
if (!videoPath) {
  console.error("usage: node scripts/mcp-demo.mjs <video-path>");
  process.exit(2);
}

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const client = new Client({ name: "fabula-demo", version: "0.1.0" });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(repoRoot, "mcp", "server.mjs")],
}));

async function call(name, args = {}, note = "") {
  console.log(`\n== ${name} ${note}`);
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? "";
  console.log(text.length > 900 ? text.slice(0, 900) + " …" : text);
  return text ? JSON.parse(text) : null;
}

const tools = await client.listTools();
console.log("tools:", tools.tools.map((tool) => tool.name).join(", "));

await call("open_project", { video_path: videoPath, name: "sample" });
await call("transcribe", {}, "(skips if raw.json exists)");
await call("cut_pass", {}, "— the window fills with the transcript now");
const cuts = await call("list_cuts");
await pause(3000);

// Spare the two longest pauses, one after the other, watching the clean
// duration climb; then put the first back.
const byLength = cuts
  .filter((cut) => cut.reasons.includes("silence"))
  .sort((a, b) => b.seconds - a.seconds);
await call("set_cut_enabled", { index: byLength[0].index, enabled: false },
  `— keeping the ${byLength[0].seconds}s pause near "${byLength[0].near}"`);
await pause(3000);
await call("set_cut_enabled", { index: byLength[1].index, enabled: false },
  `— keeping the ${byLength[1].seconds}s pause near "${byLength[1].near}"`);
await pause(3000);
await call("set_cut_enabled", { index: byLength[0].index, enabled: true },
  "— changed my mind, cut it again");
await pause(2000);

await call("render_clean", {}, "— the render behind the gate");
await call("status");

await client.close();
