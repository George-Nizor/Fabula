#!/usr/bin/env bash
# Sets up the face analyser the thumbnail kit ranks its face frames with (scripts/face-analyse.py):
# MediaPipe's Face and Hand Landmarkers in a venv of their own, the models pinned by SHA-256, and the system
# library MediaPipe's runtime links that a WSL distribution usually lacks (libGLESv2), unpacked from
# its .deb without root the way setup-engine.sh fetches Chromium's. About 470 MB, once. No sudo.
#
#   bash scripts/setup-face.sh <venv folder>
#
# setup-tools.sh runs it for a checkout (.venv-face, gitignored), setup-engine.sh for an installed
# engine (FABULA_HOME/venv-face, shared by every version). It never touches .venv-whisperx or
# tools/: a broken face analyser costs the kit its face ranking and nothing else, and the kit says
# so and falls back to sharpness and time.
#
# Idempotent: a finished setup (its .face-ready stamp matching the pins below) is left alone; a
# half-finished one is removed and made again. FABULA_UV names a uv to use when the distribution's
# python3 cannot make a venv of 3.11 or newer.
set -euo pipefail

VENV="${1:?usage: setup-face.sh <venv folder>}"
case "$(basename "$VENV")" in
  *face*) ;;
  *) echo "the face analyser's folder is named for it (.venv-face, venv-face), not $VENV" >&2; exit 2 ;;
esac
HERE="$(cd "$(dirname "$0")" && pwd)"
REQUIREMENTS="$HERE/face-requirements.txt"
MODEL_URL="https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
MODEL_SHA256="64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff"
MODEL="$VENV/models/face_landmarker.task"
HANDS_URL="https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
HANDS_SHA256="fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1"
HANDS="$VENV/models/hand_landmarker.task"
SYSLIBS="$VENV/syslibs"
LIB_PATH="$SYSLIBS/usr/lib/x86_64-linux-gnu"

stamp="$( { sha256sum "$REQUIREMENTS" | cut -d' ' -f1; echo "$MODEL_SHA256 $HANDS_SHA256"; } | sha256sum | cut -d' ' -f1)"
check() { LD_LIBRARY_PATH="$LIB_PATH${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" "$VENV/bin/python" "$HERE/face-analyse.py" --model "$MODEL" --hands "$HANDS" --check 2>/dev/null | grep -q '"ready":true'; }
if [ -f "$VENV/.face-ready" ] && [ "$(cat "$VENV/.face-ready")" = "$stamp" ] && [ -x "$VENV/bin/python" ] && [ -f "$MODEL" ] && [ -f "$HANDS" ] && check; then
  echo "face analyser already installed at $VENV"
  exit 0
fi

# ---- The venv ------------------------------------------------------------------------------
rm -rf "$VENV"
py_ok() { "$1" -c 'import sys, ensurepip, venv; sys.exit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1; }
if command -v python3 >/dev/null 2>&1 && py_ok python3; then
  python3 -m venv "$VENV"
  "$VENV/bin/python" -m pip install --quiet --upgrade pip
  echo "installing MediaPipe and its pinned dependencies (about 460 MB)"
  "$VENV/bin/python" -m pip install --quiet --no-deps -r "$REQUIREMENTS"
else
  UV="${FABULA_UV:-$(command -v uv || true)}"
  if [ -z "$UV" ]; then
    echo "installing uv (no python3 of 3.11 or newer with venv here)"
    curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="$VENV.uv" UV_NO_MODIFY_PATH=1 sh
    UV="$VENV.uv/uv"
  fi
  "$UV" venv --python 3.12 "$VENV"
  echo "installing MediaPipe and its pinned dependencies (about 460 MB)"
  "$UV" pip install --quiet --python "$VENV/bin/python" --no-deps -r "$REQUIREMENTS"
fi

# ---- The models, pinned --------------------------------------------------------------------
mkdir -p "$VENV/models"
fetch_model() {
  local url="$1" sha="$2" file="$3" what="$4"
  echo "downloading $what"
  curl -fsSL -o "$file.partial" "$url"
  echo "$sha  $file.partial" | sha256sum -c - >/dev/null || { echo "$what failed its SHA-256 check" >&2; rm -f "$file.partial"; exit 1; }
  mv "$file.partial" "$file"
}
fetch_model "$MODEL_URL" "$MODEL_SHA256" "$MODEL" "the Face Landmarker model (3.8 MB)"
fetch_model "$HANDS_URL" "$HANDS_SHA256" "$HANDS" "the Hand Landmarker model (7.8 MB)"

# ---- What MediaPipe's runtime links and the distribution lacks -----------------------------
# libmediapipe.so needs libGLESv2 at load time even though the analyser runs on the CPU. Each
# missing library is mapped to its package, downloaded (no root) and unpacked under syslibs/, and
# the check runs again, since a library can need others. The analyser is started with syslibs/ on
# its LD_LIBRARY_PATH.
package_for() {
  case "$1" in
    libGLESv2.so.2) echo "libgles2" ;;
    libGLdispatch.so.0) echo "libglvnd0" ;;
    libEGL.so.1) echo "libegl1" ;;
    libGL.so.1) echo "libgl1" ;;
    *) echo "" ;;
  esac
}
LIBMEDIAPIPE="$(ls -1 "$VENV"/lib/python3*/site-packages/mediapipe/tasks/c/libmediapipe.so 2>/dev/null | head -1 || true)"
missing_libs() { [ -n "$LIBMEDIAPIPE" ] && LD_LIBRARY_PATH="$LIB_PATH${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" ldd "$LIBMEDIAPIPE" 2>/dev/null | awk '/not found/ {print $1}' | sort -u; }
for round in 1 2 3; do
  missing="$(missing_libs)"
  [ -z "$missing" ] && break
  echo "missing: $(echo $missing)"
  work="$(mktemp -d)"
  for lib in $missing; do
    pkg="$(package_for "$lib")"
    if [ -n "$pkg" ] && (cd "$work" && apt-get download "$pkg" >/dev/null 2>&1); then echo "fetched $pkg"; fi
  done
  fetched=0
  for deb in "$work"/*.deb; do
    [ -e "$deb" ] || continue
    mkdir -p "$SYSLIBS"
    dpkg -x "$deb" "$SYSLIBS"
    fetched=1
  done
  rm -rf "$work"
  if [ "$fetched" = 0 ]; then
    echo "could not fetch packages for: $(echo $missing); install them (sudo apt-get install libgles2) and run this again" >&2
    exit 1
  fi
done
if [ -n "$(missing_libs)" ]; then
  echo "still missing: $(echo $(missing_libs))" >&2
  exit 1
fi

# ---- Check -------------------------------------------------------------------------------
LD_LIBRARY_PATH="$LIB_PATH${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" "$VENV/bin/python" "$HERE/face-analyse.py" --model "$MODEL" --hands "$HANDS" --check
printf '%s\n' "$stamp" > "$VENV/.face-ready"
echo "face analyser ready: $(du -sh "$VENV" | cut -f1) at $VENV"
