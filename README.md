# Fabula

Raw footage in. A told story out.

Fabula is a transcript-driven talking-head video editor: it transcribes a recording locally
(WhisperX on CUDA), proposes cuts for dead air, fillers, and false starts, lets you review every
cut as strikethrough text before anything renders, then plans and composites visuals around the
speaker — layouts that move the head around the frame, named graphics, and motion scenes the
assistant writes as code for the moments that have to move — with your choice of Claude Code or
Codex as the editor, using your existing subscription. One button, **Make it into a video**,
takes a reviewed cut to a draft film from a short brief.

## Projects

Fabula opens on its home screen: **New project…** and the list of projects you already have.
A project is a recording where it lives plus what Fabula makes from it (transcripts, cuts,
scenes, renders) in a folder of its own; nothing is copied, a 19 GB recording included.

**New project…** (Ctrl+N, or drop a recording anywhere on the window) asks for the recording, a
name, and the shape it is delivered in — **Landscape** (16:9, 1920×1080) or **Vertical**
(9:16, 1080×1920, for Shorts, Reels and TikTok). The shape is chosen here because the clean cut
and every layout follow from it; `set_format` changes it later and says what that costs. The name is yours: it shows in the masthead, the window title and the project list, and
you can change it at any time from the masthead menu or the pencil beside a project. The folder
on disk is a slug of the name and never has to move, so renaming costs nothing.

Click the project's name in the masthead for its menu: rename, show its folder, close it, or
open the full list (Ctrl+Shift+O). Ctrl+W closes the open project. From the list you can open
another project, show its folder, or move one to the recycle bin (the recording is never
touched). The assistant has the same view through `list_projects`, `open_project`,
`switch_project`, `rename_project` and `close_project`.

Projects live in `media/` beside the checkout unless you say otherwise. The home screen and the
list show where, and **Change…** lets you pick any folder, your Windows Videos folder included;
Fabula offers to move the existing projects and saved themes there. The choice is kept in
`fabula.settings.json` at the repository root as the path WSL sees (`/mnt/c/Users/…`), because
the pipeline runs there and the window may run on Windows; both read the same file. A folder on
the Windows side works, but renders are written to it through WSL, which is slower than the
checkout's own disk.

## Choose your assistant

Click **Assistant** in Fabula's top bar. A sheet asks which assistant (Claude Code on your
Claude subscription, or Codex on your ChatGPT subscription), which model, and which reasoning
effort. The model list is real: Claude Code's aliases (fable, opus, sonnet), and for Codex the
models your account can use, read from the CLI's own cache; either accepts a custom model ID.
Your last choices are remembered per assistant. The sheet also asks who the session works
as: the **Editor**, a film editor cutting for someone who chose to watch, or the **Short-form
farmer**, cutting for a feed — the first second and a half, a change every four seconds, an
ending that sends people to the long film. A short-form project suggests the farmer. Press
**Start** and the session opens in a terminal pane inside the window, its header naming
exactly what was started. The CLI runs on
the pipeline host (WSL from a Windows window) inside a real pseudo-terminal
(`scripts/pty-bridge.py`, standard library only), with the window's choice passed as plain
arguments to `scripts/assistant-run.sh`; nothing goes through a shell string. Hide the pane and
the session keeps running; Stop ends it. Nothing opens outside the window.

The same launcher also runs by hand from a WSL/Linux terminal in this folder:

```bash
npm run assistant                                         # asks provider, model and effort
npm run assistant -- --saved                              # repeat your last selection
npm run assistant -- --provider claude --model fable --effort high
npm run assistant -- --provider codex --dry-run           # inspect without starting or saving
npm run assistant -- --persona farmer                     # work as the short-form farmer (remembered)
```

It connects Fabula's MCP tools for that session only, without editing global configuration;
a Claude session gets only the `fabula` server. Install and sign into each CLI you want to use.
The media tools run locally in WSL/Linux; the window can remain on Windows.

To switch assistant, exit the old one and start again. Existing cuts, scenes and manual edits
stay in the project; conversation history is separate. A session lock prevents two of these
launchers controlling the checkout at once. Preferences live in gitignored
`.assistant-preferences.json`.

The assistant reads the open project, reports where it stands, and waits for you in its pane.
Type to it there. It watches the window for insert-point choices only while it is listening,
which it does after setting insert points or when you tell it to; say "stop listening" to get
the pane back. Both assistants follow [the same editing workflow](docs/assistant-workflow.md).

Whichever assistant you pick starts with the same brief. `core/assistant-brief.mjs` holds it,
and it reaches the session four ways: Claude Code takes it as an appended system prompt, Codex
leads its first message with it, `CLAUDE.md` and `AGENTS.md` carry it for the CLI that reads
them, and the MCP server hands it to whichever client connects. A test fails if the copies
drift. On top of that, `set_scenes` reads the plan back and reports what it sees — a run of one
card kind, one kind dominating, no full-stage moment, a long stretch of nothing but the head —
so the rule against a repetitive film arrives when the plan is written, not only at the start
of the session. The look is reported the same way: an unset theme resolves to the default preset
and looks decided, so `status`, `get_theme` and `set_scenes` all say plainly that nobody has
chosen it yet, and name the brands you have saved.

## Tall films, and shorts cut out of long ones

A vertical project is not a landscape one rotated. The same layout names answer in both shapes
and resolve to different rectangles: `focus` puts the head edge to edge, cropped to the tall
frame; `side` puts it across the top half with the visual owning the bottom; `band` keeps the
head **whole**, in the recording's own shape, for a wide moment a crop would ruin. Nothing is
baked — the clean cut is always the head at its own framing, the crop happens when the film is
composed, and changing your mind about a shot never re-renders anything.

Once a long film is cut, the **Shorts** card in the Export step reads its transcript for the
moments that could stand on their own: runs of whole sentences with the words in front of you and
plain notes on each — *opens on a promise*, *opens on "it" — the viewer has to supply what it
refers to*, *does not end on a full stop*, *no numbers, comparisons or claims in it*. Press
**Make a vertical short** and that moment becomes a project of its own.

The short references the same recording and inherits the long film's cut list with everything
outside the span removed, so its clean cut is rendered from the original footage rather than
cropped out of the finished composition — which is what lets it be framed for a tall frame. The
look travels; the scene plan does not, because a composition written for a wide frame is the
wrong composition for a tall one. Refresh its clean cut and compose it like any other project.
The assistant has the same two tools, `suggest_clips` and `create_short`, and will argue with
the shortlist rather than making all of it.

Read [`docs/product-brief.md`](docs/product-brief.md) first: it holds the pipeline, the
architecture, the decisions already made, and what has been proven or disproven.

## The working loop

Fabula is a two-hander: the window is where you watch and tweak, the assistant does the work.
What the assistant works with: `docs/craft/` (the editor's craft, the short-form farmer's, a
visual grammar of what goes with what is said, and reference styles described as methods), a
`read_story` tool that marks the transcript up before composing, twenty-seven named graphic
templates (a timeline, a flow, before/after, myth and fact, a code window, a phone, a lower
third, an end screen, a call to action…) filled in from fields, B-roll the person has
(`import_clip`, played in a card while they talk), a pacing read on every plan write beside the
variety read, and `preview_sheet`, which tiles the whole film into one picture so it can be
looked at before it is rendered. It also finishes the job: a grade on the footage and a
clean-up of the voice (`set_theme grade`, `set_audio voice_clean`), a music bed under the
voice, ducked from the transcript's own words (`set_audio`), captions that lean on the word a
phrase turns on, a thumbnail or several to choose between (`render_thumbnail`), the chapter
list for the description (`export_chapters`) and the image credits, all listed in the Export
step with the film.

1. **Open Fabula and start a project** (New project…, or drop a recording on the window) and
   give it a name. The clip is referenced where it lives — nothing is copied, a 19 GB recording
   included — and the window says what to ask for next.
2. **The first pass runs by itself.** Creating the project starts it: the recording is
   transcribed on the GPU, the frame is scanned for where the head sits, and cuts are proposed —
   the pauses and fillers, and the cuts an editor makes from reading: the preamble before the
   film promises anything, a false start, a stutter, a retake.
   The window shows each step as it lands. Review the cuts in the Cut step: click a struck word
   or pause to keep it, drag across words and cut them by hand, or drag across struck words to
   keep just those (ctrl+F finds a phrase in a long transcript). When the cut is right, press
   **Make it into a video…** at the top of the inspector and write a short brief: what the film
   is for, how closely to hold to the house style — **Free hand** (the assistant designs the
   film: its own motion graphics, the layouts the story wants, a look it sets), **Guided** (the
   templates and the look first) or **By the book** (only the kit and your look; every fault
   fixed before the real render) — the look, whether music, sound effects and pictures from the
   web are allowed, and any notes. **Make the video** renders the clean cut and hands the film to
   the assistant, which works through it without stopping to ask: it writes a treatment (the
   film's one sentence, its shape, its signature moment, where the head goes beat by beat),
   sets the look, composes the scenes — moving the head between the full frame, a corner, a
   side column, a split screen and gone — writes motion scenes where a moment has to move, sets
   the sound, reviews its own work, and renders a draft. The inspector's Making panel follows
   it phase by phase with the treatment under it; when the draft lands, **Watch the draft** (or
   the Live / Draft switch over the stage) plays it in the window, and a note sent while it
   plays says where in the draft it is about. The real render waits for you. **Compose it with
   me instead** keeps the older, step-by-step path: the assistant composes with you in its pane.
   The long steps are background jobs: they keep going if the session that started them ends,
   and the window keeps showing where they are.
3. **Review in the window.** The top bar is four numbered steps. **Cut**: play with
   skip-preview, click struck words to keep them, watch the framing guides show what the render
   will pull. **Look**: the brand — a gallery of theme presets (Studio, Broadcast, Paper, Neon,
   Mono, Ink, Slate, Signal, Dawn, Terminal, Bloom, Pastel), the brands you have saved for the
   channel, and a gallery for every title, callout and caption style, every transition and every
   punch-in — each card a live stage playing that option, drawn by the painter that draws the
   film, so nothing is chosen from a name alone. **Scenes**: the film on the 1080p stage with the
   script tucked away in a drawer; click a timeline block and the inspector gives you its text,
   its heading, its style, a card's own fields, its word span (underlined in the script), and
   duplicate or remove — a removal can be undone for a few seconds. Drop a picture or a
   clip of your own onto the stage and it is filed with the project and placed beside the head
   over the words at the playhead, with the inspector open on it. The box at the foot of the
   inspector tells the assistant what should change, about the film or the scene under
   inspection. Drag the top edge of the transport to make the timeline taller.
   **Export**: render buttons, progress, what is out of date and why, and every file the renders
   wrote. Every change is saved to the project and previews immediately.

   The timeline under Cut and Scenes is a window over the film: ctrl + wheel zooms around the
   pointer, a plain wheel pans, the minimap above the ruler shows the whole film with the window
   drawn on it (drag it, or click to go there), dragging the ruler scrubs, and J/K/L, comma and
   period, Home and End do what they do in every editor.
4. **Iterate by prompting.** *"Make the intro title punchier", "drop the chart, show the snail
   still longer", "this is for my YouTube channel: red accent, my logo top right, banded
   captions", "put the Godot and Photopea logos next to where I mention them"* — the assistant reads
   the current plan and theme first (your tweaks included), changes only what you asked, fetches
   pictures from the web into the project when a logo or a still is wanted, and re-renders
   behind the gate. Your manual edits and the assistant's edits live in the same files, so neither side
   tramples the other.

Captions have four modes: burned into the picture in the look's caption style, closed (an SRT
and a VTT beside every render, for the player to offer and the viewer to toggle), both, or none.
The Look step and the `set_captions` tool set it.

Ask the assistant to mark the film with insert points instead of writing every scene: each one
shows in the transcript and the timeline with a few ready-made options (a side card, the spoken
words, a full-screen cover). Hover to preview one on the stage, click to choose, or type what you
want there and send it; the assistant adds it as an option. Anything larger, ask in its pane.

The renders land in `media/<project>/out/` — `clean.mp4` is the cut, `screen.mp4` the recording's
screen track when it has one, `final.mp4` the finished composition, and `preview-<from>-<to>.mp4`
a span rendered on its own.

There are two renders and they answer to different things. The clean cut is rendered once per cut
list and framing, and the compose stage only moves it around: layouts, punch-ins, scenes,
captions and accents never send it back to render. Changing the cuts afterwards is possible and
is meant to be rare: the cut renders again, its transcript is redone, and the scenes are moved to
the new word ids automatically by matching the words at their ends. It is compared by content, not by file time,
so toggling a cut and toggling it back costs nothing; only a cut list or framing that actually
differs from what `out/clean-map.json` records renders again. The final render is layered and
cached: the footage is placed by ffmpeg, only the overlays that change are captured, and each
chunk under `out/chunks/` (six to thirty seconds of film) is reused until something inside it
changes — so a whole film takes minutes and a tweaked title takes about one. Both encode on the
GPU when the machine has an NVIDIA card (NVENC works from WSL with the ffmpeg build
`npm run setup:tools` installs), and both run as background jobs with their progress in the
window's masthead. The Export step starts them
too — the film, or *Refresh the clean cut* after the cuts moved, which renders and re-transcribes
only what no longer matches — with the same arguments the tools use, so it does not matter which
side pressed the button. On Windows the window hands the job to WSL through `wsl.exe`.

## In the Instrumenta launcher

Fabula is a `native-bundle` product: `scripts/bootstrap-windows.ps1` deploys the Windows Electron
runtime into `dist/windows/` beside a `fabula-bundle.json` that names this checkout as the app,
and the launcher's Prepare button runs exactly that. Open mirrors the runtime to local disk once
and launches it with the checkout as its argument, so edits here are live. The pipeline still runs
in WSL under Claude Code or Codex; the Instrumenta launcher only opens the window.

## Development

To look at the window from a machine that cannot show it (a WSL shell, a CI box), run it headless
and let it photograph itself:

```bash
env -u ELECTRON_RUN_AS_NODE FABULA_PROJECTS_ROOT=/tmp/fabula-root \
  FABULA_SNAPSHOT=/tmp/snap FABULA_SNAPSHOT_PROJECT=<project> \
  node_modules/electron/dist/electron --no-sandbox --no-zygote --ozone-platform=headless --disable-gpu .
```

It writes the home screen, the Assistant sheet and, with a project named, the open project and its
Export step as PNGs, then quits (`FABULA_SNAPSHOT_LOOK=<gallery id>` adds a Look gallery,
`FABULA_SNAPSHOT_SCENE=<index>` a scene's inspector, `FABULA_SNAPSHOT_EVAL=<js>` an answer from the
page). For any other view, `FABULA_SNAPSHOT_SCRIPT=<file.json>` names a list of steps, each
`{ "size": [w, h], "run": "<js>", "wait": ms, "shot": "name", "print": "label" }` with every key
optional, applied in that order — click a tab, open an inspector, resize, photograph. Give the run
its own `FABULA_PROJECTS_ROOT` (a copy of the projects to look at): opening a project moves the
root's open-project pointer, and the person's own root should not move under them. An
`ELECTRON_RUN_AS_NODE` left in the shell by an assistant session makes Electron refuse its own
switches ("bad option"); unset it for the launch. `scripts/probe-templates.cjs`, run the same way, renders every template in both shapes
through the export page and tiles them into two sheets under `out/template-probe/` — run it after
touching `core/templates.mjs` or the painter, and look.

```bash
npm install
npm test              # core cut-engine suite (pure node, no tools needed)
npm run setup:tools   # static ffmpeg + WhisperX venv, no sudo
npm start             # Electron shell
```

Part of the [Instrumenta workspace](../README.md), registered in the launcher catalog as `fabula`.
