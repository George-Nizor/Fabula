# Fabula

Raw footage in. A told story out.

Fabula is a transcript-driven talking-head video editor: it transcribes a recording locally
(WhisperX on CUDA), proposes cuts for dead air, fillers, and false starts, lets you review every
cut as strikethrough text before anything renders, then plans and composites visuals around the
speaker — with Claude as the editor in the loop, on the Max subscription.

Read [`docs/product-brief.md`](docs/product-brief.md) first: it holds the pipeline, the
architecture, the decisions already made, and what has been proven or disproven.

## The working loop

Fabula is a two-hander: the window is where you watch and tweak, Claude is who does the work.

1. **Open Fabula and drop a recording on it** (or use *Open a recording…*). The clip is opened
   as a project where it lives — nothing is copied, a 19 GB recording included — and the window
   says what to ask for next.
2. **In a Claude Code session started in this folder** (`.mcp.json` registers the `fabula`
   tools), say what you want in plain words: *"do a first pass on the open clip"*. Claude
   transcribes on the GPU, finds where the head sits in the frame (a camera inset over a screen
   recording, scene switches, pillarboxing), proposes cuts, renders the clean cut, re-transcribes
   it, plans layouts and scenes, and renders the composition. The window shows each step as it
   runs and every result as it lands. The long steps are background jobs: they keep going if the
   session that started them ends, and the window keeps showing where they are.
3. **Review in the window.** Play with skip-preview, click struck words to keep them, watch the
   framing guides show what the render will pull, click timeline blocks and tweak text, accents,
   layouts in the inspector. The project panel holds the look: a theme preset (Studio, Broadcast,
   Paper, Neon, Mono), the brand colours, title, callout and caption styles, a logo watermark
   and a handle. Every change is saved to the project and previews immediately.
4. **Iterate by prompting.** *"Make the intro title punchier", "drop the chart, show the snail
   still longer", "this is for my YouTube channel: red accent, my logo top right, banded
   captions", "put the Godot and Photopea logos next to where I mention them"* — Claude reads
   the current plan and theme first (your tweaks included), changes only what you asked, fetches
   pictures from the web into the project when a logo or a still is wanted, and re-renders
   behind the gate. Your manual edits and Claude's edits live in the same files, so neither side
   tramples the other.

Captions are a mode, not a switch: burned into the picture in the theme's caption style,
closed (an SRT and a VTT are written beside every render for the player to offer as CC and the
viewer to toggle), both, or none. The inspector's Captions select and the `set_captions` tool
set it.

The loop can also be a conversation in the window. Ask Claude to mark the film with insert
points instead of writing every scene: each one shows in the transcript and the timeline with a
few ready-made options (a side card, the spoken words, a full-screen cover…). Hover to preview
one on the stage, click to choose, or type what you want there and send it to Claude, who adds
it as an option. The Ask Claude box in the inspector takes anything else in plain words.

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
two-minute chunk under `out/chunks/` is reused until something inside it changes — so a whole film
takes minutes and a tweaked title takes about one. Both encode on the GPU when the machine has an
NVIDIA card (NVENC works from WSL with the ffmpeg build `npm run setup:tools` installs), and both
run as background jobs with their progress in the window's masthead.

## In the Instrumenta launcher

Fabula is a `native-bundle` product: `scripts/bootstrap-windows.ps1` deploys the Windows Electron
runtime into `dist/windows/` beside a `fabula-bundle.json` that names this checkout as the app,
and the launcher's Prepare button runs exactly that. Open mirrors the runtime to local disk once
and launches it with the checkout as its argument, so edits here are live. The pipeline still runs
in WSL under Claude Code; the launcher only opens the window.

## Development

```bash
npm install
npm test              # core cut-engine suite (pure node, no tools needed)
npm run setup:tools   # static ffmpeg + WhisperX venv, no sudo
npm start             # Electron shell
```

Part of the [Instrumenta workspace](../README.md), registered in the launcher catalog as `fabula`.
