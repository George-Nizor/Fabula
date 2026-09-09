import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// A media root of its own, with one project that has a clean transcript
// and no footage: enough for the plan tools, none of the renders.
function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabula-root-"));
  const words = "if a rocket simply flies straight upward and turns its engines off gravity will eventually pull it back down".split(" ");
  const segments = [{ start: 0, end: words.length * 0.4, text: words.join(" "), words: words.map((word, i) => ({ word, start: i * 0.4 + 0.02, end: i * 0.4 + 0.36, score: 0.9 })) }];
  for (const name of ["one", "two"]) {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ title: name, format: "landscape" }));
    fs.writeFileSync(path.join(dir, "clean.json"), JSON.stringify({ segments }));
    fs.writeFileSync(path.join(dir, "compose.json"), JSON.stringify({ scenes: [] }));
  }
  fs.writeFileSync(path.join(root, "one", "assets", "real.png"), Buffer.from([137, 80, 78, 71]));
  fs.writeFileSync(path.join(root, "current-project.json"), JSON.stringify({ dir: "one" }));
  return root;
}

async function withServer(root, run) {
  const client = new Client({ name: "fabula-project-test", version: "1.0.0" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, "mcp/server.mjs")], env: { ...process.env, FABULA_PROJECTS_ROOT: root } }));
    await run(client);
  } finally { await client.close(); }
}
const call = (client, name, args = {}) => client.callTool({ name, arguments: args });
const text = (result) => JSON.parse(result.content[0].text);
const errorOf = (result) => (result.isError ? result.content[0].text : null);

test("a write refuses when the open project moved under it, and a read takes the new one up", async () => {
  const root = makeRoot();
  try {
    await withServer(root, async (client) => {
      assert.equal(text(await call(client, "status")).project, "one");
      // The person switches in the window.
      fs.writeFileSync(path.join(root, "current-project.json"), JSON.stringify({ dir: "two" }));
      const refused = errorOf(await call(client, "set_scenes", { scenes: [{ type: "title", text: "Hello", from_word_id: 0, to_word_id: 3 }] }));
      assert.match(refused, /changed from "one" to "two"/);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "two", "compose.json"), "utf8")).scenes, [], "nothing was written");
      assert.equal(text(await call(client, "status")).project, "two");
      const written = text(await call(client, "set_scenes", { scenes: [{ type: "title", text: "Hello", from_word_id: 0, to_word_id: 3 }] }));
      assert.equal(written.scenes, 1);
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, "two", "compose.json"), "utf8")).scenes.length, 1);
      // A read never refuses; the refusal itself is not an acknowledgement.
      fs.writeFileSync(path.join(root, "current-project.json"), JSON.stringify({ dir: "one" }));
      assert.match(errorOf(await call(client, "set_captions", { mode: "open" })) ?? "", /changed from "two" to "one"/);
      assert.match(errorOf(await call(client, "set_captions", { mode: "open" })) ?? "", /changed from "two" to "one"/, "still refused until a read or a switch");
      const read = text(await call(client, "get_scenes"));
      assert.equal(read.scenes.length, 0);
      assert.equal(read.project, "one", "every answer names the project it is about");
      assert.equal(errorOf(await call(client, "set_captions", { mode: "open" })), null);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("update_scenes merges params, replaces a card whose kind changes, takes get_scenes' spelling and refuses what it cannot apply", async () => {
  const root = makeRoot();
  try {
    await withServer(root, async (client) => {
      const first = await call(client, "set_scenes", { scenes: [
        { type: "stage", from_word_id: 0, to_word_id: 8, layout: "cutaway" },
        { type: "graphic", from_word_id: 0, to_word_id: 8, graphic: { kind: "custom", template: "hook", params: { kicker: "Rockets", line: "Throw stuff down", sub: "and up you go" } } },
      ] });
      assert.equal(errorOf(first), null, errorOf(first));
      const tightened = await call(client, "update_scenes", { patches: [{ index: 1, graphic: { params: { line: "Throw it down, hard" } } }] });
      assert.equal(errorOf(tightened), null, errorOf(tightened));
      let scenes = text(await call(client, "get_scenes")).scenes;
      assert.deepEqual(scenes[1].graphic.params, { kicker: "Rockets", line: "Throw it down, hard", sub: "and up you go" }, "one param changed, the rest kept");
      assert.ok(scenes[1].graphic.html.includes("hard") && !scenes[1].graphic.html.includes("stuff"), "re-rendered from the merged params");
      // get_scenes spells the ids in camel case; a patch may too.
      assert.equal(errorOf(await call(client, "update_scenes", { patches: [{ index: 1, toWordId: 6 }] })), null);
      scenes = text(await call(client, "get_scenes")).scenes;
      assert.equal(scenes[1].toWordId, 6);
      // A new kind is a new card: nothing of the template survives.
      assert.equal(errorOf(await call(client, "update_scenes", { patches: [{ index: 1, graphic: { kind: "stat", value: 16, label: "minutes" } }] })), null);
      scenes = text(await call(client, "get_scenes")).scenes;
      assert.equal(scenes[1].graphic.kind, "stat");
      assert.equal(scenes[1].graphic.template, undefined);
      assert.equal(scenes[1].graphic.html, undefined);
      // Fields a scene cannot carry are refused, not stored.
      assert.match(errorOf(await call(client, "update_scenes", { patches: [{ index: 1, layout: "side" }] })) ?? "", /layout belongs on a stage scene/);
      assert.match(errorOf(await call(client, "update_scenes", { patches: [{ index: 1, colour: "red" }] })) ?? "", /Unrecognized key/);
      // A missing picture is refused before it is written, with the scene named.
      assert.match(errorOf(await call(client, "check_scenes", { scenes: [{ type: "graphic", from_word_id: 0, to_word_id: 4, graphic: { kind: "image", src: "assets/nope.png" } }] })) ?? "", /scene 0: no such asset assets\/nope.png/);
      assert.match(errorOf(await call(client, "set_scenes", { scenes: [{ type: "graphic", from_word_id: 0, to_word_id: 4, graphic: { kind: "image", src: "assets/nope.png" } }] })) ?? "", /scene 0: no such asset/, "the write refuses it too");
      // Hand-written html in place of a template is a new card.
      assert.equal(errorOf(await call(client, "update_scenes", { patches: [{ index: 1, graphic: { kind: "custom", html: "<div class=\"hand\">by hand</div>", css: ".hand{color:red}" } }] })), null);
      const hand = text(await call(client, "get_scenes")).scenes[1].graphic;
      assert.equal(hand.template, undefined);
      assert.ok(hand.html.includes("by hand"));
      assert.equal(errorOf(await call(client, "check_scenes", { scenes: [{ type: "graphic", from_word_id: 0, to_word_id: 4, graphic: { kind: "image", src: "assets/real.png" } }] })), null);
      // A template refusal names the scene.
      assert.match(errorOf(await call(client, "check_scenes", { scenes: [{ type: "title", text: "x", from_word_id: 0, to_word_id: 1 }, { type: "graphic", from_word_id: 2, to_word_id: 6, graphic: { kind: "custom", template: "flow", params: { items: [{ label: "one" }] } } }] })) ?? "", /^scene 1: /);
      // over on a card not made for the face, and a cta in a film, are said.
      const read = text(await call(client, "check_scenes", { scenes: [
        { type: "graphic", from_word_id: 0, to_word_id: 6, graphic: { kind: "custom", template: "flow", params: { items: [{ label: "one" }, { label: "two" }] }, over: true } },
        { type: "graphic", from_word_id: 7, to_word_id: 9, graphic: { kind: "custom", template: "cta", params: { line: "Watch it", sub: "on the channel" } } },
      ] }));
      assert.ok(read.warnings.some((w) => /over: true draws the flow on top of the head/.test(w)), JSON.stringify(read.warnings));
      assert.ok(read.warnings.some((w) => /a cta in the long film/.test(w)), JSON.stringify(read.warnings));
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("status remembers the adopted persona and wait_render says when nothing is running", async () => {
  const root = makeRoot();
  try {
    await withServer(root, async (client) => {
      assert.equal(text(await call(client, "status")).persona, null);
      await call(client, "adopt_persona", { persona: "farmer" });
      assert.equal(text(await call(client, "status")).persona, "farmer");
      const waited = text(await call(client, "wait_render", { wait_seconds: 1 }));
      assert.equal(waited.done, true);
      assert.equal(waited.running, false);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("import_clip files B-roll as a muted mp4, list_assets says how long it is, and a plan is held to it", async () => {
  const root = makeRoot();
  const { execFileSync } = await import("node:child_process");
  const { FFMPEG } = await import("../scripts/pipeline.mjs");
  const source = path.join(root, "phone.mov");
  execFileSync(FFMPEG, ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source]);
  try {
    await withServer(root, async (client) => {
      const imported = await call(client, "import_clip", { path: source, name: "launch", from: 1 });
      assert.equal(errorOf(imported), null, errorOf(imported));
      const clip = text(imported);
      assert.equal(clip.src, "assets/launch.mp4");
      assert.ok(Math.abs(clip.seconds - 2) < 0.3, `two seconds kept, got ${clip.seconds}`);
      const listed = text(await call(client, "list_assets")).assets.find((a) => a.src === "assets/launch.mp4");
      assert.equal(listed.kind, "clip");
      assert.ok(listed.seconds > 1.5);
      // Five words at 0.4 s is two seconds of card: within the clip.
      const fits = text(await call(client, "check_scenes", { scenes: [
        { type: "stage", from_word_id: 0, to_word_id: 4, layout: "side" },
        { type: "graphic", from_word_id: 0, to_word_id: 4, graphic: { kind: "clip", src: "assets/launch.mp4", label: "the launch" } },
      ] }));
      assert.ok(!fits.warnings.some((w) => /holds its last frame/.test(w)), JSON.stringify(fits.warnings));
      // Ten words is four seconds: the clip runs out and the read-back says so.
      const long = text(await call(client, "check_scenes", { scenes: [
        { type: "stage", from_word_id: 0, to_word_id: 9, layout: "side" },
        { type: "graphic", from_word_id: 0, to_word_id: 9, graphic: { kind: "clip", src: "assets/launch.mp4" } },
      ] }));
      assert.ok(long.warnings.some((w) => /holds its last frame/.test(w)), JSON.stringify(long.warnings));
      assert.match(errorOf(await call(client, "check_scenes", { scenes: [{ type: "graphic", from_word_id: 0, to_word_id: 4, graphic: { kind: "clip", src: "assets/nope.mp4" } }] })) ?? "", /no such asset assets\/nope.mp4/);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
