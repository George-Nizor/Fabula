# Fabula on Windows without WSL

Step 3 of `docs/packaging-plan.md`, begun 2026-10-15 on the `windows-native` branch. Fabula has run
its engine in WSL: transcription, ffmpeg, renders and the assistant. This moves all of it onto
Windows, so installing Fabula no longer needs WSL, and the WSL route is retired for Windows.
Linux keeps running everything locally, as a checkout does today.

## What was proved first (on an RTX 4080 SUPER, driver 617)

- The Windows ffmpeg build (BtbN `win64-gpl` 8.1) encodes with `h264_nvenc`.
- A Windows venv (Python 3.12 via uv, `torch==2.8.0` and `torchaudio==2.8.0` from the cu128 index,
  `whisperx==3.8.6`, `pywinpty`) sees CUDA in torch and in ctranslate2. whisperx pulls the CPU torch
  from PyPI on Windows, so the CUDA build is reinstalled after it. About 7.6 GB, 143 s.

## The design

**One host.** On Windows the engine is Fabula.exe itself, with no second runtime:

| Job | Runs as |
| --- | --- |
| Pipeline jobs (`scripts/job.mjs`), the MCP server, `scripts/assistant.mjs` | Fabula.exe with `ELECTRON_RUN_AS_NODE=1` |
| Headless renders (`scripts/export-compose.cjs`, `scripts/frame.cjs`) | Fabula.exe as an Electron main, through a script switch in the bootstrap (`--fabula-script <file>`) |
| ffmpeg, ffprobe | `tools\ffmpeg\bin\ffmpeg.exe` in the engine home |
| WhisperX | `venv-whisperx\Scripts\whisperx.exe`, with `torch\lib` on PATH for cuBLAS and cuDNN |
| The assistant's terminal | `scripts/pty-bridge-win.py` on pywinpty (ConPTY), from the same venv, with the same stdin and resize protocol as `pty-bridge.py` |
| Claude Code, Codex | `claude.exe` (`%USERPROFILE%\.local\bin`, PATH, then npm's) and Codex's own `codex.exe` from its npm package |

In a checkout on Linux, the same code runs with `node` and `node_modules/electron`.

**Where things live on Windows**

- **App code:** inside the installed bundle, `resources\app`. Each version is immutable and
  Instrumenta replaces it whole. There is no tarball to unpack and no copy.
- **Engine home:** `%LOCALAPPDATA%\Fabula\engine`. It holds `tools\ffmpeg`, `venv-whisperx`,
  `models` (`HF_HOME` and `TORCH_HOME`), `settings.json` and `assistant-preferences.json`. It is
  shared by every version, and an update reuses it.
- **Projects:** `%USERPROFILE%\Videos\Fabula` by default, in an ordinary folder with a Recycle Bin.

**Paths are native.** Settings, `source.json` and the MCP tools take Windows paths on Windows. A
project brought over from WSL has `/mnt/<d>/...` rewritten to `<D>:\...`. The clean cut's identity
compares the source path in one spelling (the WSL form), so a moved project's clean cut stays
current.

**No WSL branch on Windows.** `WSL_PREFIX`, `wslJob`, `wsl.exe` and the systemd memory cap stay only
for a checkout opened from a `\\wsl.localhost` share. That is the developer route, and it stays
while the WSL install exists. A native install never touches WSL.

## Phases

1. **Core.** The host module, binary names, `whisperEnv`, `ELECTRON_RUN_AS_NODE` carried to every
   node job, Windows paths in settings, local jobs on Windows, renders under Windows Electron, and
   clean identity across path spellings. It is tested by staging the app to a Windows folder and
   running the first pass, the clean cut and a render on a copied project.
2. **The assistant.** `pty-bridge-win.py`, finding claude.exe and codex.exe, and a lockfile in
   place of `flock`. Starting a session from the window.
3. **Setup and packaging.** `scripts/setup-windows.mjs`: pinned ffmpeg (sha256), uv, the venv with
   CUDA wheels or CPU torch without an NVIDIA GPU, and the models downloaded during setup with
   progress. The bundle carries the app code and its production `node_modules`. The bootstrap runs
   the setup and the script switch.
4. **Release and move.** Release 0.4.0. Copy the owner's projects from the WSL engine into the
   Windows projects folder, rewriting the paths, and retire the WSL engine.
