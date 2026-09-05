#!/usr/bin/env bash
# Installs Fabula's local tools without sudo:
#   tools/ffmpeg/          ffmpeg + ffprobe, BtbN GPL build (libx264 and, on an
#                          NVIDIA machine, h264_nvenc — WSL exposes the encoder
#                          library, so the 4080 encodes both renders)
#   .venv-whisperx/        WhisperX on CUDA (several GB of torch wheels)
# Idempotent: existing installs are left alone, except an older ffmpeg without
# NVENC support, which is replaced. Re-run after deleting a folder to reinstall.
set -euo pipefail
cd "$(dirname "$0")/.."

FFMPEG_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-linux64-gpl-8.1.tar.xz"

echo "== ffmpeg =="
if [ -x tools/ffmpeg/ffmpeg ] && tools/ffmpeg/ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_nvenc; then
  echo "already installed: $(tools/ffmpeg/ffmpeg -version | head -1)"
else
  if [ -x tools/ffmpeg/ffmpeg ]; then
    echo "replacing $(tools/ffmpeg/ffmpeg -version | head -1) (no NVENC support)"
    rm -rf tools/ffmpeg
  fi
  mkdir -p tools
  echo "downloading ffmpeg (~120 MB)..."
  curl -fL --progress-bar -o tools/ffmpeg-btbn.tar.xz "$FFMPEG_URL"
  rm -rf tools/ffmpeg-unpack && mkdir -p tools/ffmpeg-unpack tools/ffmpeg
  tar -xf tools/ffmpeg-btbn.tar.xz -C tools/ffmpeg-unpack
  mv tools/ffmpeg-unpack/*/bin/ffmpeg tools/ffmpeg-unpack/*/bin/ffprobe tools/ffmpeg/
  cp tools/ffmpeg-unpack/*/LICENSE.txt tools/ffmpeg/ 2>/dev/null || true
  rm -rf tools/ffmpeg-unpack tools/ffmpeg-btbn.tar.xz
  tools/ffmpeg/ffmpeg -version | head -1
fi
if tools/ffmpeg/ffmpeg -v error -f lavfi -i color=c=black:s=256x144:r=30:d=0.2 -c:v h264_nvenc -f null - 2>/dev/null; then
  echo "NVENC: available (the GPU encodes the clean cut and the film)"
else
  echo "NVENC: not available here; renders use libx264"
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
