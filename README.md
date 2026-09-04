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

1. **Open Fabula and drop a recording on it.** The clip is staged as a project and the window
   says what to ask for next.
2. **In a Claude Code session started in this folder** (`.mcp.json` registers the `fabula`
   tools), say what you want in plain words: *"do a first pass on the staged clip"*. Claude
   transcribes on the GPU, proposes cuts, renders the clean cut, re-transcribes it, plans
   layouts and scenes, and renders the composition. Everything lands in the window as it
   happens.
3. **Review in the window.** Play with skip-preview, click struck words to keep them, click
   timeline blocks and tweak text, accents, layouts in the inspector, change the project accent.
   Every change is saved to the project and previews immediately.
4. **Iterate by prompting.** *"Make the intro title punchier", "drop the chart, show the snail
   still longer", "warmer accent", "tighten the pauses"* — Claude reads the current plan first
   (your tweaks included), changes only what you asked, and re-renders behind the gate. Your
   manual edits and Claude's edits live in the same files, so neither side tramples the other.

The renders land in `media/<project>/out/` — `clean.mp4` is the cut, `final.mp4` the finished
composition.

## Development

```bash
npm install
npm test              # core cut-engine suite (pure node, no tools needed)
npm run setup:tools   # static ffmpeg + WhisperX venv, no sudo
npm start             # Electron shell
```

Part of the [Instrumenta workspace](../README.md); not yet registered in the launcher catalog.
