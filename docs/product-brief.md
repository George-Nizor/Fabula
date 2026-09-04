# Fabula — product brief

Fabula turns a raw talking-head recording into a finished, animated video: pauses and fillers cut,
visuals appearing beside the speaker that match what is being said, at Claude Design quality. It is
the successor to the ambition behind Motus — automated video editing — rebuilt around a transcript
instead of a timeline, and around Claude as the editor. It is a standalone Electron app in the
Instrumenta workspace; catalog registration comes once it is real.

The owner's cost constraint is absolute: nothing beyond the existing Claude Max subscription and
local hardware.

## What is proven (2026-09-04)

- A 10-second clip uploaded to Claude Design as a video layer survived a shrink-to-corner
  transition with a chart animating beside it, kept its audio, and exported to MP4 at the clip's
  exact duration. Claude Design can composite real footage.
- The development machine has an RTX 4080 SUPER (16 GB) visible from WSL2, Python 3.12, Node.
  ffmpeg and WhisperX are not yet installed; `scripts/setup-tools.sh` installs both without sudo.

## What is disproven (2026-09-04)

- **There is no official Claude Design MCP server.** The guessed endpoint
  (`api.anthropic.com/v1/design/mcp`) does not exist. The only bridge in circulation is a
  third-party project driving a real Chrome via CDP against claude.ai's internal endpoints — no
  video upload, no export trigger, fragile, and not something to point at the owner's account.
- Consequence: Design cannot be driven programmatically today. It remains the proven *manual*
  compositor — Fabula prepares a per-segment package (clean clip, transcript excerpt, shot-plan
  prompt) that the owner drags into Design in the browser. The app's own animatic renderer is the
  planned *automated* path (see Compositor below).
- The Claude Agent SDK, on this machine with the owner's own Claude Code login, bills against the
  Max subscription. That holds for a personal first-party tool; distributing Fabula to other users
  would require API keys and is out of scope.

## The product is the review loop

The pipeline below can run end to end, but Fabula is not a batch script — it is an editor with two
review gates. Nothing renders until a gate is approved.

1. **Cut review.** The transcript is the timeline. Every proposed cut shows as strikethrough text
   with a reason and a toggle; clicking a word seeks the player. Preview plays the *raw* file and
   skips cut spans live — a ~100 ms seek hiccup per cut, no render on the iteration path. A
   low-resolution proxy can render in the background for smooth scrubbing; it is never waited on.
2. **Shot-plan review.** Planned visuals appear as lanes against the transcript — what appears,
   when, in which layout (full frame / corner / split) — editable before anything is composited.

## Pipeline

1. **Record.** 4K, wider than delivery, consistent background. Delivery is 1080p; the spare
   resolution funds repositioning and punch-ins.
2. **Transcribe raw.** WhisperX `large-v3`, float16, word timestamps, JSON out.
3. **Propose cuts — two layers.**
   - *Deterministic, local:* dead air from inter-word gaps in the WhisperX timeline (one source of
     truth; no separate silence detector), plus a conservative filler lexicon (um, uh, erm…).
   - *Semantic, Claude:* the session reads the transcript and flags false starts, repeated takes,
     and redundancy — the cuts a word list cannot see. Every cut carries reason, source, and an
     enabled toggle.
   - Cuts keep ~150 ms of breath at each boundary and never cut to zero.
4. **Cut review gate.** Approve → render `clean.mp4`: frame-accurate ffmpeg re-encode, 20–40 ms
   audio fades at joins, and **alternating punch-ins** (100% ↔ ~115%, from the 4K master) at cuts
   to conceal jumps — the single biggest perceived-quality win in the pipeline.
5. **Re-transcribe clean.mp4.** Timestamps now match the footage the compositor receives. Never
   re-time the raw transcript.
6. **Chunk.** 1080p ~3 Mbps re-encode, split at topic breaks the transcript reveals, 2–4 minutes
   per segment.
7. **Shot plan.** Claude writes, per segment, what visual appears, when, and in what layout —
   anchored to *word IDs*, not seconds (see Invariants). Reviewed at the second gate.
8. **Compose.** Per segment, through the active compositor (below). The shot plan drives a
   composition where every frame is a pure function of a single time value.
9. **Stitch.** Concatenate segments, then one final normalize pass — independently rendered
   segments will not share bit-identical codec parameters, so `-c copy` concat is not trusted; the
   final re-encode also applies −14 LUFS loudness normalization.
10. **Free wins.** `.srt` captions from the word timestamps; chapter markers from the topic breaks.

## Invariants

- **The video is edited, never read; the transcript is the input for every decision.**
- **Cut first, then re-transcribe the clean output. Never re-time a transcript.**
- **Everything anchors to word IDs.** The cut list and shot plan reference words; seconds are
  derived. Changing a cut after shot-planning cannot break the plan — timestamps re-derive.
- **Renders happen only behind an approved gate.**

## Architecture

Electron app; Windows is the eventual target, WSL2 is the development host.

- **Main process embeds the Claude Agent SDK** — the "Claude Code session in the background". App
  state is exposed to the session as in-process MCP tools via `createSdkMcpServer()` / `tool()`
  (`get_transcript`, `propose_cuts`, `write_shot_plan`, `request_render`, …), auto-approved through
  `allowedTools`. Claude's edits arrive as structured tool calls the UI renders immediately — chat
  text is never parsed.
- **Renderer** is the review UI: transcript editor, skip-preview player, shot-plan lanes.
- **Sidecar:** WhisperX in a local venv on CUDA; static ffmpeg binary; both installed by
  `scripts/setup-tools.sh`, no sudo.
- **Compositor is a pluggable stage** with two implementations sharing the shot-plan schema:
  1. *Design (manual-assisted, proven):* Fabula writes a segment package — clean clip, transcript
     excerpt, prompt built from the shot plan and a once-configured design-system preamble — and
     the owner drags it into claude.ai/design and exports MP4.
  2. *Animatic (automated, planned):* the in-app preview — an HTML composition over the video
     driven by one time value — captured headlessly (Chromium frame capture + ffmpeg mux). The
     preview needed for the second gate is 80% of this compositor; export is the remaining 20%.

## Build order

- **Slice 1 — the cut half, entirely local, no Design dependency.** Ingest → WhisperX transcribe →
  deterministic cut proposal → transcript editor with skip preview → approve → clean render with
  fades and punch-ins → re-transcribe. `core/cut-engine.mjs` (pure, tested) is the start.
- **Slice 2 — Claude in the loop.** Agent SDK embedding, in-process tools, the semantic cut pass.
- **Slice 3 — the compose half.** Shot-plan schema and lanes, animatic preview, the Design segment
  package, stitch and normalize. Promote the animatic to exporter when preview quality earns it.

## Open questions

- Design upload ceiling and per-render cost on Max for a real 2–4 minute segment — measure with
  one real segment before depending on it. (Chat is 500 MB/file; Design's own limit is unpublished.
  A 3-minute 1080p segment at ~3 Mbps is ~70 MB, comfortably under any plausible ceiling.)
- WhisperX on this 4080/WSL2 (fallback: faster-whisper with `word_timestamps=True`).
- Whether `large-v3` hallucination on long silences needs VAD tightening before the gap detector
  runs (WhisperX applies VAD by default; verify on a real recording).
