# Packaging plan

Decided 2026-10-13, after the first real film was made in Fabula. This is the order of work that
takes Fabula from "runs on its author's machine" to "installs and works on another Windows
creator's machine".

## Decisions

- **Windows first.** Linux next, macOS later.
- **Delivered through Instrumenta.** Instrumenta installs Fabula and keeps it up to date, and
  Fabula still runs as an app of its own. No separate installer for now.
- **NVIDIA GPU is the full-quality path.** A machine without one still works: transcription runs
  on the CPU with a smaller model, and the window says how long it will take.
- **AI is bring-your-own Claude Code or Codex**, signed in with the person's own subscription.
  Cutting, the Look and Export work without either. Only Make it into a video and the assistant
  need one.

## Where it stands (2026-10-13)

The window runs on Windows. Everything else runs in WSL: transcription, ffmpeg, renders and the
assistant CLIs. The engine is built in WSL on first start by `scripts/setup-engine.sh`, about 7 GB.

These assumptions break on another machine:

- WSL must already be installed, the default distro is used, and the Chromium-library step only
  works on Debian or Ubuntu.
- WhisperX is forced to `float16` (`scripts/pipeline.mjs`), so there is no working path without
  NVIDIA. Transcription is English only.
- The Whisper model (large-v3, 2.9 GB) and the alignment model (360 MB) download on the first
  transcription into `~/.cache`. Neither is part of setup or of the size it states.
- ffmpeg is fetched as "latest" without a checksum. whisperx, torch, ctranslate2 and Node are not
  pinned. `whisperEnv` hard-codes a `python3.12` path.
- Claude Code and Codex must be installed and signed in inside WSL. Nothing checks this or guides
  the person through it.

## Order of work

1. **Release 0.3.2** and move the author onto the installed release, with projects carried over.
   This is the first real test of the release path.
2. **Harden the WSL engine**
   - Detect the GPU. Use large-v3 on CUDA float16, or a smaller model on the CPU with int8. Let
     the person choose the model, with sizes and a time estimate.
   - Add a language setting, with auto-detect.
   - Download the models during setup, into the engine's own folder, with progress.
   - Pin ffmpeg, Node, whisperx, torch and ctranslate2 with checksums. Fix the python path.
   - Add a Setup check screen: WSL, engine, GPU, disk, and each AI CLI installed and signed in,
     each with its fix.
3. **A native Windows engine.** No WSL: WhisperX, ffmpeg, headless renders and the CLIs all run
   on Windows. This removes the admin-and-reboot WSL install and a class of path and memory
   problems. It is a port of the job launching, path mapping and terminal bridge.
4. **A Linux release.** The engine is already Linux, so this is mostly packaging.
5. **macOS.** This needs a different transcription stack (MLX or whisper.cpp) and VideoToolbox.
