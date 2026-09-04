# Fabula — agent notes

`docs/product-brief.md` is the authority on pipeline, architecture, and decisions. Do not
re-litigate what it records as decided or disproven (notably: there is no official Claude Design
MCP, and Claude Design is out of the pipeline entirely by owner decision — Fabula's own runtime
is the only compositor, driven from Claude Code on the same models).

Invariants that shape every change:

- The transcript is the input for all decisions; the video is edited, never read.
- Cut first, re-transcribe the clean output, never re-time a transcript.
- Cut lists and shot plans anchor to word IDs; seconds are always derived.
- Renders happen only behind an approved review gate. Preview must never require a render.

Code layout: `core/` is pure logic (no I/O, tested with `npm test`), `electron/` is the main
process and preload, `renderer/` is the review UI, `mcp/` is the stdio MCP server that drives the
pipeline (`scripts/mcp-call.mjs <tool> '<json>'` is the one-shot bridge; `.mcp.json` registers it
for sessions started here), `scripts/pipeline.mjs` is the I/O shared by the server and the batch
driver. Project state lives in `media/<project>/review.json`; the window polls it at 500ms, so
whatever writes that file is live in the UI. Tools install to `tools/` and `.venv-whisperx/`
via `npm run setup:tools`, both gitignored, no sudo. On Windows the app runs from an Electron
runtime at `%LOCALAPPDATA%\Fabula\electron-win` pointed at this repo's UNC path — Chromium cannot
spawn children from `\\wsl.localhost`; under WSLg it needs `--no-sandbox --no-zygote` on the CLI.

Cost constraint: the owner's Claude Max subscription and local hardware only. Nothing in this repo
may depend on an API key or a paid service.
