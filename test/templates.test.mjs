import test from "node:test";
import assert from "node:assert/strict";
import { TEMPLATES, TEMPLATE_IDS, describeTemplates, renderTemplate, expandTemplate, expandTemplates } from "../core/templates.mjs";
import { validateScenes } from "../core/compose-engine.mjs";

const words = [
  { id: 0, text: "one", start: 0.0, end: 0.4 },
  { id: 1, text: "two", start: 0.5, end: 0.9 },
];

// A template is only worth having if its own example renders, in both shapes,
// into a custom graphic the engine would accept from a hand.
test("every template renders its example in both shapes and passes the custom-graphic rules", () => {
  assert.ok(TEMPLATE_IDS.length >= 20, `only ${TEMPLATE_IDS.length} templates`);
  for (const id of TEMPLATE_IDS) {
    const template = TEMPLATES[id];
    assert.ok(template.example, `${id} has no example`);
    assert.ok(template.about && template.when, `${id} says neither what it is nor when to use it`);
    for (const format of ["landscape", "vertical"]) {
      const graphic = renderTemplate(id, template.example, { format });
      assert.equal(graphic.kind, "custom");
      assert.equal(graphic.template, id);
      assert.ok(graphic.html.length > 0 && graphic.html.length <= 20000, `${id}/${format} html ${graphic.html.length}`);
      assert.ok(graphic.css.length <= 10000, `${id}/${format} css ${graphic.css.length}`);
      assert.equal(typeof graphic.full, "boolean");
      // The same rules a hand-written custom graphic faces.
      validateScenes([{ type: "graphic", fromWordId: 0, toWordId: 1, graphic }], words);
      // Motion rides the painter's variables and nothing else.
      assert.ok(/var\(--[qp]\)/.test(graphic.css + graphic.html), `${id} does not animate from --q or --p`);
      assert.ok(!/@keyframes|animation:|transition:/.test(graphic.css), `${id} uses a CSS animation, which the export cannot sample`);
    }
  }
});

test("a template lays itself out differently in a tall frame", () => {
  const wide = renderTemplate("trio", TEMPLATES.trio.example, { format: "landscape" });
  const tall = renderTemplate("trio", TEMPLATES.trio.example, { format: "vertical" });
  assert.notEqual(wide.css, tall.css);
  assert.ok(tall.css.includes("flex-direction: column"));
  assert.ok(wide.css.includes("flex-direction: row"));
});

test("text is escaped, capped, and may not carry a link", () => {
  const graphic = renderTemplate("hook", { line: "<b>bold</b> & \"quoted\"" });
  assert.ok(!graphic.html.includes("<b>"));
  assert.ok(graphic.html.includes("&lt;b&gt;") && graphic.html.includes("&amp;") && graphic.html.includes("&quot;"));
  assert.throws(() => renderTemplate("hook", { line: "x".repeat(91) }), /at most 90 characters/);
  assert.throws(() => renderTemplate("hook", { line: "see https://example.com" }), /cannot hold a link/);
  assert.throws(() => renderTemplate("hook", {}), /line is required/);
  assert.throws(() => renderTemplate("nothing-here", {}), /unknown template/);
});

test("items are counted, valued and typed per template", () => {
  assert.throws(() => renderTemplate("timeline", { items: [{ value: "a", label: "b" }] }), /takes 3–6 items/);
  assert.throws(() => renderTemplate("timeline", { items: [{ label: "no date" }, { label: "x", value: "y" }, { label: "z", value: "w" }] }), /value/);
  assert.throws(() => renderTemplate("split", { items: [{ label: "a", value: "text" }, { label: "b", value: 2 }] }), /must be a number/);
  const split = renderTemplate("split", { items: [{ label: "a", value: 3 }, { label: "b", value: 1 }] });
  assert.ok(split.html.includes("75%") && split.html.includes("25%"), "shares are normalised");
  assert.throws(() => renderTemplate("progress", { value: 120, label: "x" }), /at most 100/);
  assert.throws(() => renderTemplate("alert", { text: "x", level: "panic" }), /must be one of note, warning, stop/);
  const alert = renderTemplate("alert", { text: "x" });
  assert.equal(alert.params.level, "warning", "a choice falls back to its default");
});

test("a scene naming a template is expanded and everything else passes through", () => {
  const scenes = [
    { type: "stage", fromWordId: 0, toWordId: 1, layout: "cutaway" },
    { type: "graphic", fromWordId: 0, toWordId: 1, graphic: { kind: "custom", template: "question", params: { text: "Why?" }, full: true } },
    { type: "graphic", fromWordId: 0, toWordId: 1, graphic: { kind: "stat", value: 3, label: "things" } },
  ];
  const expanded = expandTemplates(scenes, { format: "vertical" });
  assert.equal(expanded[0], scenes[0]);
  assert.equal(expanded[2], scenes[2]);
  assert.equal(expanded[1].graphic.template, "question");
  assert.ok(expanded[1].graphic.html.includes("Why?"));
  assert.equal(expanded[1].graphic.full, true, "full given beside the template wins over its default");
  assert.equal(expandTemplate({ kind: "custom", html: "<p>mine</p>" }).html, "<p>mine</p>");
  assert.equal(expandTemplate({ kind: "custom", template: "thumbnail", params: { line: "Hi" }, over: true }, { format: "vertical" }).over, true, "over travels with the template");
  validateScenes(expanded, words);
});

test("describe_templates says what each one is for and which fields it takes, and can be narrowed by persona", () => {
  const all = describeTemplates();
  assert.equal(all.length, TEMPLATE_IDS.length);
  const hook = all.find((t) => t.id === "hook");
  assert.equal(hook.fields.line.required, true);
  assert.equal(hook.fields.kicker.required, false);
  assert.equal(hook.fields.line.max, 90);
  const timeline = all.find((t) => t.id === "timeline");
  assert.equal(timeline.fields.items.type, "items");
  assert.equal(timeline.fields.items.value, "text, required");
  const farmer = describeTemplates({ persona: "farmer" });
  assert.ok(farmer.some((t) => t.id === "cta"));
  assert.ok(!farmer.some((t) => t.id === "timeline"));
  assert.ok(describeTemplates({ persona: "editor" }).some((t) => t.id === "timeline"));
});

test("every entrance completes by the time --q reaches 1, whatever the item count", () => {
  const worst = [
    ["receipt", { items: Array.from({ length: 6 }, (_, i) => ({ label: `l${i}`, value: "1" })), total: "9" }],
    ["ranking", { items: Array.from({ length: 6 }, (_, i) => ({ label: `r${i}` })), countdown: "up" }],
    ["code", { items: Array.from({ length: 8 }, (_, i) => ({ label: `line ${i}` })) }],
    ["word", { words: "one two three", note: "n" }],
    ["myth-fact", { myth: "m", fact: "f" }],
    ["phone", { items: Array.from({ length: 4 }, (_, i) => ({ label: `m${i}` })) }],
  ];
  for (const [id, params] of worst) {
    const { html, css } = renderTemplate(id, params);
    for (const m of (html + css).matchAll(/clamp\(0, calc\(\(var\(--q\) - ([\d.]+)\) \/ ([\d.]+)\), 1\)/g)) {
      assert.ok(Number(m[1]) + Number(m[2]) <= 1.001, `${id}: a window opens at ${m[1]} for ${m[2]} and never closes`);
    }
  }
  const code = renderTemplate("code", { items: [{ label: "function f() {" }, { label: "    return 1;" }, { label: "}" }] });
  assert.equal(code.params.items[1].label, "    return 1;", "code keeps its indentation");
  assert.equal(describeTemplates().find((t) => t.id === "alert").fields.level.required, false, "a choice is never required");
});
