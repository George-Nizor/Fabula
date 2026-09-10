import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// The belt as the assistant sees it. Every tool the docs and the personas
// name has to be there, and the ones that need no project have to answer.
const EXPECTED = [
  "open_project", "list_projects", "switch_project", "rename_project", "close_project", "set_format",
  "suggest_clips", "create_short",
  "transcribe", "cut_pass", "story_cuts", "detect_framing", "set_framing", "get_framing", "list_cuts", "set_cut_enabled", "add_cut",
  "plan_shots", "render_clean", "retranscribe_clean", "list_clean_words",
  "get_scenes", "set_scenes", "check_scenes", "update_scenes", "add_scenes", "remove_scenes", "set_inserts", "get_inserts", "apply_insert", "wait_for_input",
  "describe_kit", "describe_templates", "adopt_persona", "read_craft", "read_story", "draft_scenes", "review_plan", "review_film",
  "preview_frame", "preview_sheet", "film_sheet", "render_thumbnail",
  "set_captions", "list_themes", "get_theme", "set_theme",
  "search_images", "fetch_image", "import_image", "import_clip", "list_assets",
  "import_audio", "list_music", "set_music_root", "set_audio", "export_chapters", "export_description", "get_captions", "export_captions",
  "reanchor_scenes", "render_final", "wait_render", "status",
];

async function withServer(run) {
  const client = new Client({ name: "fabula-tools-test", version: "1.0.0" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, "mcp/server.mjs")] }));
    await run(client);
  } finally { await client.close(); }
}

const text = (result) => JSON.parse(result.content[0].text);

test("every tool the docs name is registered", async () => {
  await withServer(async (client) => {
    const { tools } = await client.listTools();
    const names = new Set(tools.map((tool) => tool.name));
    for (const name of EXPECTED) assert.ok(names.has(name), `${name} is not registered`);
    for (const tool of tools) assert.ok(tool.description && tool.description.length > 40, `${tool.name} has no real description`);
    // Parameters the docs promise.
    const params = (name) => Object.keys(tools.find((tool) => tool.name === name).inputSchema.properties ?? {});
    assert.ok(params("set_theme").includes("transitionSeconds"), "set_theme takes transitionSeconds");
    assert.ok(params("set_audio").includes("voice_loudness") && params("set_captions").includes("emphasis"));
    assert.ok(params("render_final").includes("draft"));
  });
});

test("the tools that need no project answer with what the assistant reads first", async () => {
  await withServer(async (client) => {
    const kit = text(await client.callTool({ name: "describe_kit", arguments: {} }));
    assert.ok(kit.layouts.cutaway && kit.graphics.custom && kit.templates.includes("describe_templates") && kit.craft.includes("adopt_persona"));
    const templates = text(await client.callTool({ name: "describe_templates", arguments: { persona: "farmer" } }));
    assert.ok(templates.templates.some((t) => t.id === "cta") && templates.templates.every((t) => t.example));
    const persona = text(await client.callTool({ name: "adopt_persona", arguments: { persona: "farmer" } }));
    assert.equal(persona.persona, "farmer");
    assert.ok(Object.keys(persona.guides).length === 2 && Object.values(persona.guides).every((g) => g.length > 1500));
    const craft = text(await client.callTool({ name: "read_craft", arguments: { guide: "references" } }));
    assert.ok(craft.text.includes("Borrowing well"));
    // A tool that needs a project says so rather than crashing.
    const noProject = await client.callTool({ name: "review_plan", arguments: {} });
    if (noProject.isError) assert.match(noProject.content[0].text, /project|open/i);
  });
});
