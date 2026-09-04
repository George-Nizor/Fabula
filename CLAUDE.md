# Fabula — agent notes

`docs/product-brief.md` is the authority on pipeline, architecture, and decisions. Do not
re-litigate what it records as decided or disproven (notably: there is no official Claude Design
MCP; Design is the manual-assisted compositor, the in-app animatic is the automated path).

Invariants that shape every change:

- The transcript is the input for all decisions; the video is edited, never read.
- Cut first, re-transcribe the clean output, never re-time a transcript.
- Cut lists and shot plans anchor to word IDs; seconds are always derived.
- Renders happen only behind an approved review gate. Preview must never require a render.

Code layout: `core/` is pure logic (no I/O, tested with `npm test`), `electron/` is the main
process and preload, `renderer/` is the review UI. Tools install to `tools/` and `.venv-whisperx/`
via `npm run setup:tools`, both gitignored, no sudo.

Cost constraint: the owner's Claude Max subscription and local hardware only. Nothing in this repo
may depend on an API key or a paid service.
