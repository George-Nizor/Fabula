import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PERSONAS, PERSONA_IDS, DEFAULT_PERSONA, CRAFT_DOCS, validatePersona, describePersonas } from "../core/personas.mjs";
import { describeTemplates } from "../core/templates.mjs";
import { INVARIANTS } from "../core/assistant-brief.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

test("every persona has a brief, reads guides that exist, and narrows the templates", () => {
  assert.ok(PERSONA_IDS.includes("editor") && PERSONA_IDS.includes("farmer"));
  for (const id of PERSONA_IDS) {
    const persona = PERSONAS[id];
    assert.ok(persona.brief.length > 200, `${id} brief is thin`);
    assert.ok(!persona.brief.includes(INVARIANTS), "the invariants are not repeated inside a persona");
    for (const doc of persona.reads) assert.ok(fs.existsSync(path.join(ROOT, doc)), `${id} reads ${doc}, which does not exist`);
    assert.ok(describeTemplates({ persona: persona.templates }).length >= 5, `${id} has too few templates`);
  }
  for (const doc of Object.values(CRAFT_DOCS)) {
    const text = fs.readFileSync(path.join(ROOT, doc), "utf8");
    assert.ok(text.length > 1500, `${doc} is thin`);
  }
});

test("the default persona is the editor and an unknown one is refused", () => {
  assert.equal(validatePersona(undefined), DEFAULT_PERSONA);
  assert.equal(validatePersona(""), "editor");
  assert.equal(validatePersona("farmer"), "farmer");
  assert.throws(() => validatePersona("influencer"), /persona must be one of/);
  const described = describePersonas();
  assert.equal(described.length, PERSONA_IDS.length);
  assert.ok(described.every((p) => p.label && p.about && Array.isArray(p.reads)));
});

// The guides name tools and templates; every name they use has to exist, or
// the assistant is being taught to call something that is not there.
test("the craft guides only name templates and tools that exist", () => {
  const templates = new Set(describeTemplates().map((t) => t.id));
  const server = fs.readFileSync(path.join(ROOT, "mcp/server.mjs"), "utf8");
  const tools = new Set([...server.matchAll(/registerTool\("([a-z_]+)"/g)].map((m) => m[1]));
  const kit = new Set(["stat", "chart", "list", "steps", "ring", "quote", "compare", "image", "clip", "logos", "screen", "cover", "section", "custom", "kinetic", "callout", "title",
    "focus", "side", "pip", "band", "full", "cutaway", "glide", "dissolve", "cut", "karaoke", "block", "bar", "pop", "tilt", "kenburns", "open",
    "studio", "broadcast", "paper", "neon", "mono", "ink", "slate", "signal", "dawn", "terminal", "bloom", "pastel"]);
  for (const doc of Object.values(CRAFT_DOCS)) {
    const text = fs.readFileSync(path.join(ROOT, doc), "utf8");
    for (const [, name] of text.matchAll(/`([a-z][a-z0-9_-]+)`/g)) {
      // Tool parameters the guides name beside the tool.
      if (tools.has(name) || ["from_word_id", "voice_loudness", "level", "duck", "ramp", "fade", "music", "pace", "params", "auto", "none", "shade", "over", "variants", "voice_clean", "grade"].includes(name)) continue;
      if (name.includes("_")) assert.fail(`${doc} names a tool that does not exist: ${name}`);
      else if (!name.includes(".") && !["true", "false", "full", "shorts", "md", "custom", "band", "editor"].includes(name)) {
        assert.ok(templates.has(name) || kit.has(name), `${doc} names something the kit does not have: ${name}`);
      }
    }
  }
});
