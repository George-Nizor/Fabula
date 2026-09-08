// Interactive companion launcher. No shell interpolation, API keys or global config writes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { INVARIANTS } from "../core/assistant-brief.mjs";
import { PERSONAS, PERSONA_IDS, DEFAULT_PERSONA, validatePersona } from "../core/personas.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PREFS = path.join(ROOT, ".assistant-preferences.json");
export const EFFORTS = {
  codex: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  claude: ["low", "medium", "high", "xhigh", "max"],
};
const PROMPT = "Read docs/assistant-workflow.md completely. You are the Fabula editing assistant; your work is the composition. " +
  "The mechanical first pass (transcript, framing scan, cut proposals) runs by itself when a project is created, and the person " +
  "reviews and adjusts the cuts in the window. Call the fabula status tool now; if a project is open, also read its cuts, scenes and theme, " +
  "and preserve them. Tell me in a few lines where the project stands and what you would do next, then wait for my instruction here. " +
  "Call describe_kit before you plan anything: it says whether this film is landscape or vertical and what each layout means in that shape. " +
  "When I ask you to compose: if framing.json is missing but framing-scan.json exists, look at the saved frames and set_framing; " +
  "render_clean and retranscribe_clean if status says they are stale; plan_shots; ask what the film is for and set_theme; set_scenes with " +
  "your editorial judgment; render_final over a minute first, the whole film once I approve. Do not render until I ask. " +
  "Listen to the window with wait_for_input only when I ask you to listen or after you have set insert points, and keep listening until I say stop.";

// What the window asked the session to begin with, appended to the brief.
export const TASKS = {
  compose: "The person has just approved the cut in the window and pressed Approve the cut and compose. Work through these in order, " +
    "and do not skip a step because the previous one looked fine:\n" +
    "1. status. While a job runs, wait_render. If it says the clean transcript is stale, retranscribe_clean.\n" +
    "2. If framing.json is missing but a framing scan exists, look at the frames under framing/ and set_framing. A camera inset over a " +
    "screen recording is never applied automatically, so this is on you.\n" +
    "3. The look, before any scene. status and get_theme report whether anyone actually chose it — an unset theme resolves to the studio " +
    "preset and reads like a decision. If it is unchosen, stop and ask me one short question: what the film is for, and whether it uses " +
    "one of my saved brands (list_themes shows them). Then set_theme, with use: \"<id>\" for a brand.\n" +
    "4. describe_kit, then plan_shots, then set_scenes with your editorial judgment. Compose for the shape the film is in — a tall frame has no column beside the head and a title has room for three words rather than nine. Act on the variety notes set_scenes returns.\n" +
    "5. render_final over the first minute only, and ask me to look at it in the window before the whole film.",
};

export function selection(provider, model = "", effort = "") {
  if (!Object.hasOwn(EFFORTS, provider)) throw new Error("Provider must be codex or claude.");
  if (typeof model !== "string" || typeof effort !== "string") throw new Error("Model and effort must be text.");
  model = model.trim();
  effort = effort.trim();
  if (model === "default") model = "";
  if (effort === "default") effort = "";
  if (model.startsWith("-") || /[\x00-\x1f\x7f]/.test(model)) throw new Error("Enter a model ID, not CLI options.");
  if (effort && !EFFORTS[provider].includes(effort)) {
    throw new Error(`Effort for ${provider}: default, ${EFFORTS[provider].join(", ")}. Support also depends on the model.`);
  }
  return { provider, model, effort };
}

// Who the session works as. The persona's brief leads the first message
// (both CLIs read it; it is judgment, not a system rule) and tells the session
// to adopt_persona so the craft guides arrive in full.
export function personaPrompt(persona) {
  const id = validatePersona(persona);
  return `${PERSONAS[id].brief}\n\nCall adopt_persona with persona "${id}" first, before status, and read what it returns.`;
}

export function buildLaunch(options, root = ROOT, node = process.execPath) {
  const { provider, model, effort } = selection(options.provider, options.model, options.effort);
  if (options.task !== undefined && options.task !== "" && !Object.hasOwn(TASKS, options.task)) throw new Error(`Unknown task ${options.task}.`);
  const persona = validatePersona(options.persona);
  const prompt = `${personaPrompt(persona)}\n\n${options.task && TASKS[options.task] ? `${PROMPT} ${TASKS[options.task]}` : PROMPT}`;
  const server = path.join(root, "mcp", "server.mjs");
  const args = [];
  if (provider === "codex") {
    // Session-only overrides work without installing/editing user-level MCP configuration.
    args.push("--cd", root,
      "-c", `mcp_servers.fabula.command=${JSON.stringify(node)}`,
      "-c", `mcp_servers.fabula.args=${JSON.stringify([server])}`,
      "-c", `mcp_servers.fabula.cwd=${JSON.stringify(root)}`,
      "-c", "mcp_servers.fabula.enabled=true",
      "-c", "mcp_servers.fabula.tool_timeout_sec=60");
    if (effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
  } else {
    // Only the fabula server: the checked-in .mcp.json would register it a second
    // time, and the user's other MCP servers would spend the editing session's
    // context on tool schemas the film never needs.
    args.push("--mcp-config", JSON.stringify({ mcpServers: { fabula: { command: node, args: [server] } } }),
      "--strict-mcp-config", "--append-system-prompt", INVARIANTS);
    if (effort) args.push("--effort", effort);
  }
  if (model) args.push("--model", model);
  // Codex has no system-prompt flag; the invariants lead its first message
  // instead, and AGENTS.md carries them for the rest of the session.
  args.push(provider === "codex" ? `${INVARIANTS}\n\n${prompt}` : prompt);
  return { command: provider, args, cwd: root, persona };
}

export function readPreferences(file = PREFS) {
  let data;
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return { provider: "codex", persona: DEFAULT_PERSONA, profiles: {} };
    throw new Error(`Cannot read assistant preferences at ${file}: ${error.message}`);
  }
  if (!data || !Object.hasOwn(EFFORTS, data.provider) || !data.profiles || typeof data.profiles !== "object") {
    throw new Error(`Invalid assistant preferences at ${file}.`);
  }
  for (const [provider, profile] of Object.entries(data.profiles)) {
    selection(provider, profile?.model, profile?.effort);
  }
  data.persona = PERSONA_IDS.includes(data.persona) ? data.persona : DEFAULT_PERSONA;
  return data;
}

export function savePreferences(previous, chosen, file = PREFS) {
  const { provider, model, effort } = selection(chosen.provider, chosen.model, chosen.effort);
  const persona = validatePersona(chosen.persona ?? previous.persona);
  const next = { provider, persona, profiles: { ...previous.profiles, [provider]: { model, effort } } };
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, file);
}

async function main() {
  const { values } = parseArgs({ options: {
    provider: { type: "string" }, model: { type: "string" }, effort: { type: "string" }, task: { type: "string" }, persona: { type: "string" },
    saved: { type: "boolean" }, "dry-run": { type: "boolean" }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log(`Fabula assistant — run in a WSL/Linux terminal\n
npm run assistant                            Choose provider, model and effort
npm run assistant -- --saved                  Use the last choices
npm run assistant -- --provider codex         Use that provider's saved choices
npm run assistant -- --provider claude --model MODEL_ID --effort high
npm run assistant -- --provider codex --dry-run
npm run assistant -- --provider claude --task compose   Begin composing at once (what the window's Approve button does)
npm run assistant -- --persona farmer         Work as the short-form farmer (editor by default; remembered)

Use --model default / --effort default to inherit the CLI setting.
Exact model IDs are passed unchanged; the provider checks account availability.
Use /model in the agent session to see its available models.
Exit the current assistant before switching provider, then run this command again.
The window's Ask assistant box queues messages for the session; tell it to listen first.
Preferences are local to this checkout; no account/global configuration is changed.`);
    return;
  }
  const prefs = readPreferences();
  let provider = values.provider ?? prefs.provider;
  let model, effort;
  if (!values.saved && !values.provider && !values["dry-run"]) {
    if (!process.stdin.isTTY) throw new Error("Run in a terminal, or specify --provider codex|claude (use --dry-run to inspect).");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      provider = (await rl.question(`Assistant (codex / claude) [${provider}]: `)).trim() || provider;
      selection(provider);
      const prior = prefs.profiles[provider] ?? {};
      console.log("Enter an exact model ID, or default to choose with /model in the session. No model is substituted.");
      model = values.model ?? ((await rl.question(`Model [${prior.model || "default"}]: `)).trim() || prior.model || "");
      console.log(`Effort options: default, ${EFFORTS[provider].join(", ")} (model-dependent).`);
      effort = values.effort ?? ((await rl.question(`Reasoning effort [${prior.effort || "default"}]: `)).trim() || prior.effort || "");
    } finally { rl.close(); }
  } else {
    const prior = prefs.profiles[provider] ?? {};
    model = values.model ?? prior.model ?? "";
    effort = values.effort ?? prior.effort ?? "";
  }
  const chosen = { ...selection(provider, model, effort), persona: validatePersona(values.persona ?? prefs.persona) };
  const launch = buildLaunch({ ...chosen, task: values.task ?? "" });
  if (values["dry-run"]) { console.log(JSON.stringify({ ...chosen, ...launch }, null, 2)); return; }
  if (process.platform !== "linux") throw new Error("Run npm run assistant in WSL/Linux, alongside Fabula's local media tools.");
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("The assistant needs an interactive terminal. Use --dry-run to inspect settings.");
  for (const executable of [provider, "flock"]) {
    const check = spawnSync(executable, ["--help"], { stdio: "ignore" });
    if (check.error || check.status !== 0) throw new Error(`Cannot run ${executable}. Install it in WSL/Linux and check it is on PATH.`);
  }
  savePreferences(prefs, chosen);
  console.log(`Starting ${provider} | model: ${chosen.model || "CLI default"} | effort: ${chosen.effort || "CLI default"} | persona: ${chosen.persona}`);
  console.log("Use your subscription login. Review the CLI's active model before editing. Exit this session before switching providers.");
  // flock is held by the child for the session lifetime and automatically released on exit/crash.
  // It protects cooperating launchers, not sessions launched manually outside this command.
  const result = spawnSync("flock", ["--nonblock", "--conflict-exit-code", "73",
    path.join(ROOT, ".assistant-session.lock"), launch.command, ...launch.args], {
    cwd: launch.cwd, stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status === 73) throw new Error("Another Fabula assistant is already running. Exit it before starting a new session.");
  process.exitCode = result.status ?? (result.signal === "SIGINT" ? 130 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`Fabula: ${error.message}`); process.exitCode = 1; });
}
