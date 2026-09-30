#!/usr/bin/env bash
# Sets up, or updates, Fabula's engine in this WSL distribution.
#
# Fabula on Windows is a window and a bootstrap (release/windows). The editor itself runs from its
# engine here: the pipeline (WhisperX, ffmpeg, a headless Electron for the renders) and the
# assistant's terminal sessions are Linux programs. The bootstrap runs this script the first time
# a version starts, and then runs the editor from versions/<version>, laid out exactly like a
# developer's checkout, so nothing in Fabula needs to know the difference.
#
# No sudo. Everything lives under FABULA_HOME (~/.local/share/fabula unless set):
#
#   versions/<v>/    Fabula at that version with its node_modules; tools and .venv-whisperx are
#                    links to the shared copies below, bin/node is the Node it runs with
#   tools/ffmpeg/    ffmpeg and ffprobe (BtbN GPL build, NVENC when the GPU has it)
#   tools/wsl-libs/  the Chromium libraries headless Electron needs and the distribution lacks,
#                    unpacked from their .debs (apt-get download needs no root)
#   venv-whisperx/   WhisperX on CUDA: several GB, installed once and shared by every version
#   node/            Node 22, only when the distribution has no Node 22 or newer
#   projects/        where the projects live, unless fabula.settings.json names another folder
#
# Usage: setup-engine.sh --version <v> --tarball <path to fabula-engine-<v>.tar.gz>
#
# Prints "STEP <n> <total> <what>" as each step starts and "READY <FABULA_HOME>" at the end: the
# window's setup screen reads those lines. Every step is skipped when its result is already there,
# so running it again finishes an interrupted setup, and a new version reuses the shared tools.
# FABULA_SKIP_WHISPERX=1 leaves WhisperX out (a test of everything else).
set -euo pipefail

VERSION=""
TARBALL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --tarball) TARBALL="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$'; then
  echo "--version must be a version like 0.2.0" >&2
  exit 2
fi
if [ ! -f "$TARBALL" ]; then
  echo "no engine tarball at $TARBALL" >&2
  exit 2
fi

HOME_DIR="${FABULA_HOME:-$HOME/.local/share/fabula}"
VERSION_DIR="$HOME_DIR/versions/$VERSION"
TOOLS="$HOME_DIR/tools"
VENV="$HOME_DIR/venv-whisperx"
TOTAL=8
step() { echo "STEP $1 $TOTAL $2"; }
mkdir -p "$HOME_DIR/versions" "$TOOLS" "$HOME_DIR/projects" "$HOME_DIR/downloads"

# ---- 1. This version's code --------------------------------------------------------------
step 1 "Unpacking Fabula $VERSION"
if [ ! -f "$VERSION_DIR/.unpacked" ]; then
  incoming="$HOME_DIR/versions/.incoming-$VERSION"
  rm -rf "$incoming"
  mkdir -p "$incoming"
  tar -xzf "$TARBALL" -C "$incoming"
  rm -rf "$VERSION_DIR"
  mv "$incoming" "$VERSION_DIR"
  touch "$VERSION_DIR/.unpacked"
fi

# ---- 2. Node -----------------------------------------------------------------------------
step 2 "Finding Node"
node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
NODE_BIN=""
if command -v node >/dev/null 2>&1 && [ "$(node_major "$(command -v node)")" -ge 22 ]; then
  NODE_BIN="$(command -v node)"
elif [ -x "$HOME_DIR/node/bin/node" ] && [ "$(node_major "$HOME_DIR/node/bin/node")" -ge 22 ]; then
  NODE_BIN="$HOME_DIR/node/bin/node"
else
  echo "downloading Node 22 (no Node 22 or newer on this distribution)"
  base="https://nodejs.org/dist/latest-v22.x"
  sums="$(curl -fsSL "$base/SHASUMS256.txt")"
  asset="$(printf '%s\n' "$sums" | awk '/linux-x64\.tar\.xz$/ {print $2; exit}')"
  expected="$(printf '%s\n' "$sums" | awk -v a="$asset" '$2 == a {print $1; exit}')"
  [ -n "$asset" ] && [ -n "$expected" ] || { echo "could not read the Node release list" >&2; exit 1; }
  curl -fL --progress-bar -o "$HOME_DIR/downloads/$asset" "$base/$asset"
  echo "$expected  $HOME_DIR/downloads/$asset" | sha256sum -c - >/dev/null
  rm -rf "$HOME_DIR/node" "$HOME_DIR/node.incoming"
  mkdir -p "$HOME_DIR/node.incoming"
  tar -xJf "$HOME_DIR/downloads/$asset" -C "$HOME_DIR/node.incoming" --strip-components=1
  mv "$HOME_DIR/node.incoming" "$HOME_DIR/node"
  rm -f "$HOME_DIR/downloads/$asset"
  NODE_BIN="$HOME_DIR/node/bin/node"
fi
# The version runs with this Node whatever the login shell's PATH holds: job lines and the
# assistant put versions/<v>/bin first.
mkdir -p "$VERSION_DIR/bin"
for tool in node npm npx; do
  if [ -e "$(dirname "$NODE_BIN")/$tool" ]; then ln -sfn "$(dirname "$NODE_BIN")/$tool" "$VERSION_DIR/bin/$tool"; fi
done
export PATH="$VERSION_DIR/bin:$PATH"
echo "node $(node --version) at $NODE_BIN"

# ---- 3. Fabula's packages ----------------------------------------------------------------
step 3 "Installing Fabula's packages"
lock_hash="$(sha256sum "$VERSION_DIR/package-lock.json" | cut -d' ' -f1)"
if [ "$(cat "$VERSION_DIR/node_modules/.fabula-lock" 2>/dev/null || true)" != "$lock_hash" ]; then
  (cd "$VERSION_DIR" && npm ci --no-audit --no-fund)
  echo "$lock_hash" > "$VERSION_DIR/node_modules/.fabula-lock"
fi

# The shared tools, seen from this version as they are from a checkout.
link_shared() {
  local link="$1" target="$2"
  if [ -e "$link" ] && [ ! -L "$link" ]; then rm -rf "$link"; fi
  ln -sfn "$target" "$link"
}
mkdir -p "$VENV"
link_shared "$VERSION_DIR/tools" "$TOOLS"
link_shared "$VERSION_DIR/.venv-whisperx" "$VENV"

# ---- 4. ffmpeg ---------------------------------------------------------------------------
step 4 "Installing ffmpeg"
if [ ! -x "$TOOLS/ffmpeg/ffmpeg" ]; then
  url="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-linux64-gpl-8.1.tar.xz"
  echo "downloading ffmpeg (~120 MB)"
  curl -fL --progress-bar -o "$HOME_DIR/downloads/ffmpeg.tar.xz" "$url"
  rm -rf "$HOME_DIR/downloads/ffmpeg-unpack" "$TOOLS/ffmpeg.incoming"
  mkdir -p "$HOME_DIR/downloads/ffmpeg-unpack" "$TOOLS/ffmpeg.incoming"
  tar -xf "$HOME_DIR/downloads/ffmpeg.tar.xz" -C "$HOME_DIR/downloads/ffmpeg-unpack"
  mv "$HOME_DIR"/downloads/ffmpeg-unpack/*/bin/ffmpeg "$HOME_DIR"/downloads/ffmpeg-unpack/*/bin/ffprobe "$TOOLS/ffmpeg.incoming/"
  cp "$HOME_DIR"/downloads/ffmpeg-unpack/*/LICENSE.txt "$TOOLS/ffmpeg.incoming/" 2>/dev/null || true
  rm -rf "$TOOLS/ffmpeg"
  mv "$TOOLS/ffmpeg.incoming" "$TOOLS/ffmpeg"
  rm -rf "$HOME_DIR/downloads/ffmpeg-unpack" "$HOME_DIR/downloads/ffmpeg.tar.xz"
fi
"$TOOLS/ffmpeg/ffmpeg" -version | head -1
if "$TOOLS/ffmpeg/ffmpeg" -v error -f lavfi -i color=c=black:s=256x144:r=30:d=0.2 -c:v h264_nvenc -f null - 2>/dev/null; then
  echo "NVENC: available, the GPU encodes the renders"
else
  echo "NVENC: not available here, the renders use libx264"
fi

# ---- 5. What headless Electron needs -----------------------------------------------------
# A WSL distribution is a server image: the Chromium runtime libraries are often missing, and
# installing them needs root. Each missing library is mapped to its package, the package is
# downloaded (no root) and unpacked beside the tools, and the check runs again, since a library
# can need others.
step 5 "Checking the libraries the renders need"
LIBS="$TOOLS/wsl-libs"
LIB_PATH="$LIBS/usr/lib/x86_64-linux-gnu"
ELECTRON_BIN="$VERSION_DIR/node_modules/electron/dist/electron"
package_for() {
  case "$1" in
    libnspr4.so|libplc4.so|libplds4.so) echo "libnspr4" ;;
    libnss3.so|libnssutil3.so|libsmime3.so|libssl3.so) echo "libnss3" ;;
    libasound.so.2) echo "libasound2t64 libasound2" ;;
    libatk-1.0.so.0) echo "libatk1.0-0t64 libatk1.0-0" ;;
    libatk-bridge-2.0.so.0) echo "libatk-bridge2.0-0t64 libatk-bridge2.0-0" ;;
    libatspi.so.0) echo "libatspi2.0-0t64 libatspi2.0-0" ;;
    libcups.so.2) echo "libcups2t64 libcups2" ;;
    libdrm.so.2) echo "libdrm2" ;;
    libgbm.so.1) echo "libgbm1" ;;
    libgtk-3.so.0|libgdk-3.so.0) echo "libgtk-3-0t64 libgtk-3-0" ;;
    libpango-1.0.so.0|libpangocairo-1.0.so.0) echo "libpango-1.0-0 libpangocairo-1.0-0" ;;
    libcairo.so.2|libcairo-gobject.so.2) echo "libcairo2 libcairo-gobject2" ;;
    libxkbcommon.so.0) echo "libxkbcommon0" ;;
    libXcomposite.so.1) echo "libxcomposite1" ;;
    libXdamage.so.1) echo "libxdamage1" ;;
    libXfixes.so.3) echo "libxfixes3" ;;
    libXrandr.so.2) echo "libxrandr2" ;;
    libX11.so.6) echo "libx11-6" ;;
    libxcb.so.1) echo "libxcb1" ;;
    libXext.so.6) echo "libxext6" ;;
    libexpat.so.1) echo "libexpat1" ;;
    libdbus-1.so.3) echo "libdbus-1-3" ;;
    libglib-2.0.so.0|libgobject-2.0.so.0|libgio-2.0.so.0|libgmodule-2.0.so.0) echo "libglib2.0-0t64 libglib2.0-0" ;;
    libudev.so.1) echo "libudev1" ;;
    libxshmfence.so.1) echo "libxshmfence1" ;;
    libwayland-client.so.0|libwayland-server.so.0) echo "libwayland-client0 libwayland-server0" ;;
    libgdk_pixbuf-2.0.so.0) echo "libgdk-pixbuf-2.0-0 libgdk-pixbuf2.0-0" ;;
    libcairo-gobject.so.2) echo "libcairo-gobject2" ;;
    libepoxy.so.0) echo "libepoxy0" ;;
    libfontconfig.so.1) echo "libfontconfig1" ;;
    libfreetype.so.6) echo "libfreetype6" ;;
    libharfbuzz.so.0) echo "libharfbuzz0b" ;;
    libfribidi.so.0) echo "libfribidi0" ;;
    libthai.so.0) echo "libthai0" ;;
    libpixman-1.so.0) echo "libpixman-1-0" ;;
    libpng16.so.16) echo "libpng16-16t64 libpng16-16" ;;
    libXi.so.6) echo "libxi6" ;;
    libXrender.so.1) echo "libxrender1" ;;
    libXcursor.so.1) echo "libxcursor1" ;;
    libXinerama.so.1) echo "libxinerama1" ;;
    libxcb-render.so.0) echo "libxcb-render0" ;;
    libxcb-shm.so.0) echo "libxcb-shm0" ;;
    libXau.so.6) echo "libxau6" ;;
    libXdmcp.so.6) echo "libxdmcp6" ;;
    libavahi-client.so.3|libavahi-common.so.3) echo "libavahi-client3 libavahi-common3" ;;
    libgnutls.so.30) echo "libgnutls30t64 libgnutls30" ;;
    *) echo "" ;;
  esac
}
missing_libs() { LD_LIBRARY_PATH="$LIB_PATH${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" ldd "$ELECTRON_BIN" 2>/dev/null | awk '/not found/ {print $1}' | sort -u; }
for round in 1 2 3 4 5; do
  missing="$(missing_libs)"
  [ -z "$missing" ] && break
  echo "missing: $(echo $missing)"
  wanted=""
  for lib in $missing; do wanted="$wanted $(package_for "$lib")"; done
  wanted="$(printf "%s\n" $wanted | sort -u)"
  fetched=0
  (
    cd "$HOME_DIR/downloads"
    for pkg in $wanted; do
      # The first name the archive knows wins (24.04 renamed several to *t64).
      if apt-cache show "$pkg" >/dev/null 2>&1 && apt-get download "$pkg" >/dev/null 2>&1; then echo "fetched $pkg"; fi
    done
  )
  mkdir -p "$LIBS"
  for deb in "$HOME_DIR"/downloads/*.deb; do
    [ -e "$deb" ] || continue
    dpkg -x "$deb" "$LIBS"
    rm -f "$deb"
    fetched=1
  done
  if [ "$fetched" = 0 ]; then
    echo "could not fetch packages for: $(echo $missing)" >&2
    echo "install them yourself and run setup again (sudo apt-get install ...)" >&2
    exit 1
  fi
done
if [ -n "$(missing_libs)" ]; then
  echo "still missing after five rounds: $(echo $(missing_libs))" >&2
  exit 1
fi
echo "headless Electron has every library it needs"

# ---- 6. WhisperX -------------------------------------------------------------------------
step 6 "Installing WhisperX (several GB, once)"
if [ "${FABULA_SKIP_WHISPERX:-}" = "1" ]; then
  echo "skipped (FABULA_SKIP_WHISPERX=1)"
elif [ -x "$VENV/bin/whisperx" ]; then
  echo "already installed"
else
  # The distribution's python3 when it can make a virtual environment (python3-venv), else uv,
  # which brings its own Python and needs no root.
  if python3 -m venv --help >/dev/null 2>&1 && python3 -c 'import ensurepip' >/dev/null 2>&1; then
    python3 -m venv --clear "$VENV"
    "$VENV/bin/pip" install --upgrade pip >/dev/null
    "$VENV/bin/pip" install whisperx
  else
    UV="$(command -v uv || true)"
    if [ -z "$UV" ]; then
      echo "installing uv (no python3-venv here)"
      curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="$HOME_DIR/uv" UV_NO_MODIFY_PATH=1 sh
      UV="$HOME_DIR/uv/uv"
    fi
    "$UV" venv --clear --python 3.12 "$VENV"
    "$UV" pip install --python "$VENV/bin/python" whisperx
  fi
  "$VENV/bin/python" - <<'PY'
import torch
print(f"torch {torch.__version__}, cuda available: {torch.cuda.is_available()}")
if torch.cuda.is_available():
    print(f"device: {torch.cuda.get_device_name(0)}")
PY
fi

# ---- 7. Settings and projects ------------------------------------------------------------
step 7 "Carrying your settings forward"
settings="$VERSION_DIR/fabula.settings.json"
if [ ! -f "$settings" ]; then
  # The newest other version's settings, so a projects folder or music folder chosen in the
  # window survives an update; a first install puts the projects under FABULA_HOME.
  previous="$(ls -1dt "$HOME_DIR"/versions/*/fabula.settings.json 2>/dev/null | grep -v "/versions/$VERSION/" | head -1 || true)"
  if [ -n "$previous" ]; then
    cp "$previous" "$settings"
  else
    printf '{}\n' > "$settings"
  fi
fi
# Where this engine lives, beside the code: its default projects folder is $HOME_DIR/projects,
# never media/ inside a version that the next update replaces (scripts/settings.cjs).
printf '%s\n' "$HOME_DIR" > "$VERSION_DIR/.engine-home"

# ---- 8. Check and mark ready -------------------------------------------------------------
step 8 "Checking the engine"
LD_LIBRARY_PATH="$LIB_PATH" "$ELECTRON_BIN" --version >/dev/null 2>&1 || { echo "headless Electron does not start" >&2; exit 1; }
"$TOOLS/ffmpeg/ffprobe" -version >/dev/null
printf '%s\n' "$VERSION" > "$VERSION_DIR/.engine-ready"
# The current version and the one before it stay; older ones go. (A loop, not a pipeline: with
# pipefail a grep that matches nothing would end the script here.)
kept_previous=0
for old in $(ls -1dt "$HOME_DIR"/versions/*/ 2>/dev/null || true); do
  case "$old" in "$HOME_DIR/versions/$VERSION/") continue ;; esac
  if [ "$kept_previous" = 0 ]; then kept_previous=1; continue; fi
  rm -rf "$old"
done
echo "READY $HOME_DIR"
