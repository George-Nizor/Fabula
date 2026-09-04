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
  exact duration. What that actually proved is the **composition model**: footage as a layer,
  everything animated as a pure function of one time value, exported frame by frame. Fabula
  implements that model natively (see Compositor); Design itself is not in the loop.
- The development machine has an RTX 4080 SUPER (16 GB) visible from WSL2, Python 3.12, Node.
  ffmpeg and WhisperX are not yet installed; `scripts/setup-tools.sh` installs both without sudo.

## What is disproven (2026-09-04)

- **There is no official Claude Design MCP server.** The guessed endpoint
  (`api.anthropic.com/v1/design/mcp`) does not exist. The only bridge in circulation is a
  third-party project driving a real Chrome via CDP against claude.ai's internal endpoints — no
  video upload, no export trigger, fragile, and not something to point at the owner's account.
- Consequence, decided by the owner the same day: **Claude Design is out of the pipeline
  entirely.** The same models are available through Claude Code on the same subscription, and
  Design's value is those models plus a composition runtime and a renderer — both of which Fabula
  owns. One interface, no uploads, footage never leaves the machine.
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
6. **Chunk (optional).** With no upload ceiling to respect, chunking is purely render and
   iteration granularity: splitting at the topic breaks the transcript reveals means a shot-plan
   tweak re-renders one 2–4 minute segment, not the whole video. Worth keeping for that reason
   alone; no longer a compliance requirement.
7. **Shot plan.** Claude writes, per segment, what visual appears, when, and in what layout —
   anchored to *word IDs*, not seconds (see Invariants). Reviewed at the second gate.
8. **Compose.** Through Fabula's own runtime (below). The shot plan drives a composition where
   every frame is a pure function of a single time value; preview and export are the same code.
9. **Stitch.** Concatenate segments, then one final normalize pass — even our own renders are not
   trusted to `-c copy` concat; the final re-encode also applies −14 LUFS loudness normalization.
   A single unchunked render skips this stage entirely.
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
- **Compositor: Fabula's own runtime, and only that.** Three parts:
  1. *Scene kit* — layout primitives (full frame, corner pin, split, the video layer with border
     and radius), animation primitives (springs and easings over the one time value), content
     components (title, list, chart, diagram), and design tokens configured once so every segment
     matches. This is the "design system in Design" idea, owned locally.
  2. *Shot plans are declarative JSON against the kit*, word-anchored, so the second review gate
     can edit them directly without a Claude round trip. A Claude-authored custom component is the
     escape hatch when the kit cannot express a shot (later slice, sandboxed to the runtime's
     time-function contract).
  3. *Preview and export share the runtime.* Preview plays live over the `<video>` element.
     Export steps the same composition at a fixed timestep in an offscreen window: the video layer
     is fed frame-exact (WebCodecs decode of clean.mp4, sequential, no per-frame seeking), each
     composed frame is captured and piped to ffmpeg, and the audio is muxed straight from
     clean.mp4 — the video is never re-timed, so audio alignment is free. What you previewed is
     literally what renders.

## Build order

- **Slice 1 — the cut half, entirely local, no Design dependency.** Ingest → WhisperX transcribe →
  deterministic cut proposal → transcript editor with skip preview → approve → clean render with
  fades and punch-ins → re-transcribe. `core/cut-engine.mjs` (pure, tested) is the start.
- **Slice 2 — Claude in the loop.** Agent SDK embedding, in-process tools, the semantic cut pass.
- **Slice 3 — the compose half.** Scene kit, shot-plan schema and lanes, live preview, the
  offscreen frame-capture exporter, stitch and normalize. The render spike (offscreen Electron
  capture on this WSL machine) is the first task here because it is the only unproven mechanism.

## Open questions

- Export throughput: frames per second of offscreen capture at 1080p. Even 5–10 fps capture is
  acceptable — a 10-minute video renders in under an hour, unattended — but measure early.
  **Spike findings (2026-09-04, `scripts/spike-offscreen-capture.cjs`):** the mechanism works —
  two full runs produced correct stepped frames — with these hard-won specifics: `capturePage`
  stalls on offscreen windows (use the CDP `Page.captureScreenshot` through
  `webContents.debugger`, the Puppeteer path); paint events throttle to ~1 fps regardless of
  `backgroundThrottling`; and this WSL host developed a persistent Chromium shared-memory flake
  mid-session (ESRCH creating shm in both `/dev/shm` and `/tmp` while the same syscalls succeed
  from Python — likely cured by `wsl --shutdown`, and irrelevant on the Windows target). Re-run
  the spike after a WSL restart to get a clean CDP throughput number.
- WebCodecs demux: `VideoDecoder` needs the H.264 samples handed to it; use mp4box.js for demux or
  fall back to `<video>` seek-per-frame if it fights back.
- The John Van Sickle static ffmpeg has no NVENC. libx264 is fine to start; if encode becomes the
  bottleneck, swap the setup script to a BtbN GPL build for `h264_nvenc` on the 4080.
- WhisperX on this 4080/WSL2 (fallback: faster-whisper with `word_timestamps=True`).
- Whether `large-v3` hallucination on long silences needs VAD tightening before the gap detector
  runs (WhisperX applies VAD by default; verify on a real recording).
