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
// Every session starts here. A session started for a task (the window's
// Approve and compose, or Make it into a video) gets the task's steps next;
// one started bare gets IDLE, which waits to be asked. The two never meet:
// "wait for my instruction" beside a task that says "without stopping to
// ask" left the session to pick one.
const PROMPT = "Read docs/assistant-workflow.md completely. You are the Fabula editing assistant; your work is the composition. " +
  "The mechanical first pass (transcript, framing scan, cut proposals) runs by itself when a project is created, and the person " +
  "reviews and adjusts the cuts in the window. Call describe_kit before you plan anything: it says whether this film is landscape or " +
  "vertical and what each layout means in that shape. Listen to the window with wait_for_input only when I ask you to listen or after " +
  "you have set insert points, and keep listening until I say stop.";
const IDLE = "Call the fabula status tool now; if a project is open, also read its cuts, scenes and theme, " +
  "and preserve them. Tell me in a few lines where the project stands and what you would do next, then wait for my instruction here. " +
  "When I ask you to compose: if framing.json is missing but framing-scan.json exists, look at the saved frames and set_framing; " +
  "render_clean and retranscribe_clean if status says they are stale; plan_shots; ask what the film is for and set_theme; read_story, then " +
  "draft_scenes for a skeleton and rework it with your editorial judgment (describe_templates has the named graphics); review_film and look at " +
  "the sheet; render_final over a minute first, or draft: true for the whole film at half size, the real render once I approve. Do not render until I ask.";

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
    "4. describe_kit, read_story, then plan_shots. draft_scenes gives you a skeleton from the reading; rework it with your editorial judgment — the todo list says what it left to you — and describe_templates has the named graphics. Compose for the shape the film is in — a tall frame has no column beside the head and a title has room for four words rather than nine. Act on the variety and pacing notes every plan write returns.\n" +
    "5. review_film and look at the sheet; preview_frame any card that carries text. Then render_final over the first minute only, or draft: true for the whole film at half size, and ask me to look at it in the window before the real render.\n" +
    "6. When the film is approved: export_chapters, render_thumbnail if I want one, and say what is in the Export step to hand over.",
  // Make it into a video: the person gave a brief in the window and left the
  // film to you. The brief replaces every question the compose task asks.
  make: "The person reviewed the cut and pressed Make it into a video. Their brief is get_direction: read it first, and follow it — it replaces asking them. " +
    "Make the whole film now, in this order, without stopping to ask; say what you chose in a line or two at each step, and do not skip a step because the last one looked fine:\n" +
    "1. get_direction, then status. While the clean cut renders, wait_render; retranscribe_clean if status says the clean transcript is stale. If framing.json is missing but a framing scan exists, look at the frames under framing/ and set_framing.\n" +
    "2. describe_kit, read_story. You took up a persona before status; if the brief names a different one, adopt_persona with the brief's. Under Guided or By the book, draft_scenes for a skeleton to rework.\n" +
    "3. The treatment, before any scene: set_treatment — the logline (what the film SAYS, one sentence), two or three shapes you considered and the one you chose, the signature moment (the one gesture only this film makes, where its turn lands), and the beats in order: what happens, what the viewer sees, where the head is. Move the head the way the story moves: on it when the speaker is the point, in a corner or beside a card when something must be seen with them, split screen when the thing and the speaker weigh the same, gone (cutaway) when the picture carries the narration.\n" +
    "4. The look, as the brief says: set_theme before any scene (a saved brand with use, a preset, or — under Free hand — a preset tuned to this film).\n" +
    "5. The scenes, to the treatment: set_scenes, then update_scenes for every change. Unless the brief is By the book, the signature moment and any moment that has to move to make sense is a motion scene — describe_motion and read_craft motion once, write_motion, fix every fault its check pass measures, look at the sheet it returns, fix and write again, then place it; under Free hand, design the film rather than fill a template. If the film is serious and its argument turns on something that has to be seen working, make that a motion SEQUENCE: a reel of twenty seconds to two minutes under a cutaway with fade: false, over the film's own sound, its storyboard in the treatment first. Bring in pictures, clips and sounds only as the brief allows. plan_shots for the punch-ins.\n" +
    "6. Sound, as the brief says: set_audio voice_loudness (-16 for a film, -14 for a short) in every case; a bed and effects only when allowed.\n" +
    "7. Review: review_film and look at the sheet; preview_frame every card that carries text; preview_motion any motion scene you have not looked at in place; critique_film and fix every fault — under Free hand a fault is advice: fix it, or keep it on purpose and say which and why. Under By the book, resolve every warning and note as well; the real render refuses while faults remain.\n" +
    "8. Render as the brief says: render_final draft: true, wait_render until it is done, film_sheet the draft and look at it. Fix what is clearly broken and render the draft once more at most.\n" +
    "9. Then stop and tell the person, in a few lines: the logline, the signature moment and when it plays, what you are least sure of, and that the draft is ready to watch in the window. Their notes arrive here in the terminal; the real render waits for them.",
  // A motion film: no recording, nothing but motion graphics, made from a
  // brief. new_motion has made the project (or makes it now).
  motion: "The person wants a MOTION FILM: nothing but motion graphics, no recording. Make it now, in this order; say what you chose in a line or two at each step:\n" +
    "1. status. If the open project is not a motion film (kind: motion), ask me in one short message what the film is about, who it is for, roughly how long, landscape or vertical, and whether there is a narration file; then new_motion. get_direction if a brief exists — it replaces asking.\n" +
    "2. read_craft motion and describe_motion, in full. They are the craft; the vocabulary in describe_motion lists the defaults that make generated motion look generated.\n" +
    "3. The storyboard, before any code: set_treatment with the logline as a claim, the spine (the ONE continuity device the whole film keeps), the held frame, two or more bans, and the beats in order — each 1.5 to 3.5 seconds of picture, in seconds or on the narration's words, with the words on screen verbatim (onScreen) and how it moves and hands over (motion). Name a reference style as a method (docs/craft/references.md), never as adjectives.\n" +
    "4. The look: set_theme — palette, type and field — before any reel. One accent colour.\n" +
    "5. The shared world: write_motion_lib with what every reel draws with — the shape system, the type scale, the camera rig, helpers — so the reels are one film.\n" +
    "6. The reels: one write_motion per 20 to 60 seconds of film, each a reel of shots (fabula.shot) in one world with one camera (fabula.camera). After every write: fix every fault the check pass measured, then look at every tile of the sheet. Then judge each shot against the storyboard and the vocabulary, out of ten, honestly; rewrite every shot at seven or below. At least two rounds per reel, at most four.\n" +
    "7. Place them: set_scenes with each reel over its span (from_seconds/to_seconds, or the narration's words), fade: false; the last frame of one reel is the first of the next, so the film never blinks through an empty stage.\n" +
    "8. Sound, as the brief allows: set_audio — the narration at -16 LUFS if there is one, a bed (search_audio) whose swells land on the beats, effects on the hits.\n" +
    "9. render_final draft: true, wait_render, film_sheet the draft and look at it as a viewer would; adopt_persona critic and critique_film; fix what is wrong and render the draft once more at most.\n" +
    "10. Then stop and tell me in a few lines: the logline, the spine, the shot you are proudest of and when it plays, what you are least sure of, and that the draft is ready in the window. The real render waits for me unless the brief (get_direction) asks for it; then render_final once the draft is right, and say so.",
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
  const prompt = `${personaPrompt(persona)}\n\n${PROMPT} ${options.task && TASKS[options.task] ? TASKS[options.task] : IDLE}`;
  const server = path.join(root, "mcp", "server.mjs");
  const args = [];
  if (provider === "codex") {
    // Session-only overrides work without installing/editing user-level MCP configuration.
    args.push("--cd", root,
      "-c", `mcp_servers.fabula.command=${JSON.stringify(node)}`,
      "-c", `mcp_servers.fabula.args=${JSON.stringify([server])}`,
      "-c", `mcp_servers.fabula.cwd=${JSON.stringify(root)}`,
      "-c", "mcp_servers.fabula.enabled=true",
      "-c", `mcp_servers.fabula.env={FABULA_PERSONA=${JSON.stringify(persona)}}`,
      "-c", "mcp_servers.fabula.tool_timeout_sec=60");
    if (effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
  } else {
    // Only the fabula server: the checked-in .mcp.json would register it a second
    // time, and the user's other MCP servers would spend the editing session's
    // context on tool schemas the film never needs.
    // The fabula tools are the session's whole job: allowed up front, so a
    // film made while the person watches the Making panel never stalls on a
    // permission prompt in a pane they are not looking at. --allowedTools
    // takes a list, so an option must follow it before the prompt does.
    args.push("--mcp-config", JSON.stringify({ mcpServers: { fabula: { command: node, args: [server], env: { FABULA_PERSONA: persona } } } }),
      "--allowedTools", "mcp__fabula",
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
    if (error.code === "ENOENT") return { provider: "claude", persona: DEFAULT_PERSONA, profiles: {} };
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
npm run assistant -- --provider claude --task compose   Begin composing at once, step by step with you
npm run assistant -- --provider claude --task make      Make the whole film from the brief in direction.json (what the window's Make it into a video does)
npm run assistant -- --provider claude --model claude-opus-5-5 --task motion   Make a motion film: nothing but motion graphics, no recording
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
