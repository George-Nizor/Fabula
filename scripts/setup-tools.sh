#!/usr/bin/env bash
# Installs Fabula's local tools without sudo:
#   tools/ffmpeg/          static ffmpeg + ffprobe (John Van Sickle build)
#   .venv-whisperx/        WhisperX on CUDA (several GB of torch wheels)
# Idempotent: existing installs are left alone. Re-run after deleting a folder
# to reinstall it.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== ffmpeg =="
if [ -x tools/ffmpeg/ffmpeg ]; then
  echo "already installed: $(tools/ffmpeg/ffmpeg -version | head -1)"
else
  mkdir -p tools
  echo "downloading static ffmpeg (~80 MB)..."
  curl -fL --progress-bar -o tools/ffmpeg-static.tar.xz \
    "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
  tar -xf tools/ffmpeg-static.tar.xz -C tools
  rm tools/ffmpeg-static.tar.xz
  mv tools/ffmpeg-*-amd64-static tools/ffmpeg
  tools/ffmpeg/ffmpeg -version | head -1
fi

echo "== WhisperX =="
if [ -x .venv-whisperx/bin/whisperx ]; then
  echo "already installed: $(.venv-whisperx/bin/whisperx --version 2>/dev/null || echo 'whisperx present')"
else
  echo "creating venv and installing whisperx + CUDA torch (several GB, one-time)..."
  python3 -m venv .venv-whisperx
  .venv-whisperx/bin/pip install --upgrade pip >/dev/null
  .venv-whisperx/bin/pip install whisperx
  echo "verifying CUDA visibility..."
  .venv-whisperx/bin/python - <<'PY'
import torch
print(f"torch {torch.__version__}, cuda available: {torch.cuda.is_available()}")
if torch.cuda.is_available():
    print(f"device: {torch.cuda.get_device_name(0)}")
PY
fi

echo "== done =="
