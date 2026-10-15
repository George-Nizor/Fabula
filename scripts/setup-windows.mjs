#!/usr/bin/env node
// Sets up, or finishes setting up, Fabula's engine on Windows, with no WSL.
//
//   Fabula.exe (ELECTRON_RUN_AS_NODE=1) scripts/setup-windows.mjs [--version <v>]
//       [--projects-root <folder>] [--cpu]
//
// The installed bootstrap (release/windows/bootstrap.cjs) runs this the first time Fabula starts.
// Node built-ins only: it runs under Fabula.exe, which has no node_modules of its own to lean on.
// Everything goes into the engine home (scripts/host.cjs: %LOCALAPPDATA%\Fabula\engine, or
// FABULA_ENGINE_HOME), which every version shares and an update reuses:
//
//   tools\ffmpeg\bin\   ffmpeg.exe and ffprobe.exe, a pinned BtbN win64-gpl 8.1 build
//   tools\uv\           a pinned uv, used to make the venv and nothing else
//   tools\python\       the Python 3.12 uv downloads for the venv
//   venv-whisperx\      WhisperX, with torch built for CUDA 12.8 on an NVIDIA GPU, else for the CPU
//   models\huggingface  HF_HOME: the faster-whisper model (large-v3 on CUDA, small on the CPU)
//   models\torch        TORCH_HOME: the English alignment model
//   settings.json       where the projects go (projectsRoot)
//   engine.json         written last: what was set up. The bootstrap opens the editor once it is here
//
// It prints "STEP <n> <total> <what>" as each step starts, "PROGRESS <percent> <text>" during a
// download, "FAIL <text>" when it stops and "READY <home>" at the end; any other line is for the
// log. Every step is skipped when its result is already there, so running it again finishes an
// interrupted setup. Exit code 0 only after READY.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const host = require("./host.cjs");

// The engine.json format. The bootstrap opens the editor only when engine.json's setupVersion
// equals its own (release/windows/engine.cjs); raising it makes every install run this again.
export const SETUP_VERSION = 1;

// Pinned downloads. Each is checked against its SHA-256 before it is unpacked.
export const PINS = {
  // A month-end autobuild: BtbN keeps those, while the dailies are pruned after a few weeks.
  ffmpeg: {
    url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08/ffmpeg-n8.1.3-9-g29e619e767-win64-gpl-8.1.zip",
    asset: "ffmpeg-n8.1.3-9-g29e619e767-win64-gpl-8.1.zip",
    build: "n8.1.3-9-g29e619e767",
    size: 193109593,
    sha256: "7b801cdd3a1a0bb54ae6f572187e68b4ed54f52086cfee133fab2180bfb429fa",
  },
  uv: {
    url: "https://github.com/astral-sh/uv/releases/download/0.12.24/uv-x86_64-pc-windows-msvc.zip",
    version: "0.12.24",
    size: 15685515,
    sha256: "7c38608c8a18ee137d748a1773053b07ec8f3a30fab49aebaa6f4e4efeceb019",
  },
  python: "3.12",
  packages: { whisperx: "3.8.6", pywinpty: "3.0.5", torch: "2.8.0", torchaudio: "2.8.0", torchvision: "0.23.0" },
};

// What each kind of machine gets. whisperx pulls torch from PyPI, which on Windows is the CPU
// build, so the CUDA build comes from PyTorch's own index.
export const PLANS = {
  cuda: { torchIndex: "https://download.pytorch.org/whl/cu128", torchBackend: "cu128", torchTag: "+cu128", model: "large-v3", repo: "Systran/faster-whisper-large-v3", computeType: "float16", modelBytes: 3.1e9, venvBytes: 7.8e9 },
  cpu: { torchIndex: null, torchBackend: "cpu", torchTag: "", model: "small", repo: "Systran/faster-whisper-small", computeType: "int8", modelBytes: 0.49e9, venvBytes: 2.5e9 },
};

// CUDA 12.x runs on Windows drivers from 528.33 (minor version compatibility).
const MIN_DRIVER = [528, 33];
const TOTAL = 8;
const GB = 1e9;
const MB = 1e6;

// ---- Pure helpers (tested in test/setup-windows.test.mjs) --------------------------------------

// nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader,nounits
export function parseNvidiaSmi(text) {
  const first = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!first) return null;
  const [name, driver, memory] = first.split(",").map((part) => part.trim());
  if (!name || !/^\d+(\.\d+)*$/.test(driver || "")) return null;
  const memoryMb = Number(memory);
  return { name, driver, memoryMb: Number.isFinite(memoryMb) ? memoryMb : null };
}

export function driverSupportsCuda(driver) {
  const [major, minor = 0] = String(driver).split(".").map(Number);
  if (!Number.isFinite(major)) return false;
  return major > MIN_DRIVER[0] || (major === MIN_DRIVER[0] && minor >= MIN_DRIVER[1]);
}

// CUDA when an NVIDIA GPU answers with a driver new enough, unless the CPU was asked for.
export function chooseGpu(gpu, { forceCpu = false } = {}) {
  if (forceCpu) return { kind: "cpu", reason: "the CPU was asked for (--cpu)" };
  if (!gpu) return { kind: "cpu", reason: "no NVIDIA graphics card answered" };
  if (!driverSupportsCuda(gpu.driver)) return { kind: "cpu", reason: `the NVIDIA driver ${gpu.driver} is older than ${MIN_DRIVER.join(".")}, which CUDA 12 needs` };
  return { kind: "cuda", reason: `${gpu.name}, driver ${gpu.driver}` };
}

export function parseArgs(argv) {
  const out = { version: null, projectsRoot: null, cpu: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--version") out.version = argv[++i] ?? null;
    else if (arg === "--projects-root") out.projectsRoot = argv[++i] ?? null;
    else if (arg === "--cpu") out.cpu = true;
    else throw new Error(`unknown option ${arg}`);
  }
  if (out.version !== null && !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(out.version)) throw new Error("--version must be a version like 0.4.0");
  return out;
}

// A projects folder on Windows: absolute on a drive, not the top of one, printable.
export function validProjectsRoot(folder) {
  if (typeof folder !== "string" || !/^[A-Za-z]:[\\/]/.test(folder)) throw new Error("The projects folder must be a full path on a drive, such as C:\\Users\\me\\Videos\\Fabula.");
  if (/[\x00-\x1f\x7f"<>|?*]/.test(folder.slice(2))) throw new Error("The projects folder path has characters that cannot be used.");
  const normal = path.win32.normalize(folder).replace(/[\\]+$/, "");
  if (/^[A-Za-z]:$/.test(normal)) throw new Error("Choose a folder rather than the top of a drive.");
  return normal;
}

export function defaultProjectsRoot(env = process.env) {
  return path.win32.join(env.USERPROFILE || os.homedir(), "Videos", "Fabula");
}

// What the venv's marker says, so a finished venv is skipped and a changed plan reinstalls.
export function venvSpec(kind) {
  return { python: PINS.python, packages: PINS.packages, torch: PLANS[kind].torchBackend };
}

export function sameSpec(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export const formatBytes = (bytes) => (bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.round(bytes / MB)} MB`);

// ---- Output --------------------------------------------------------------------------------

const out = (line) => process.stdout.write(`${line}\n`);
const step = (n, label) => out(`STEP ${n} ${TOTAL} ${label}`);
const progress = (percent, text) => out(`PROGRESS ${Math.max(0, Math.min(100, Math.round(percent)))} ${text}`);
// eslint-disable-next-line no-control-regex
const clean = (line) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "").trimEnd();

class SetupError extends Error {}
const fail = (text) => { throw new SetupError(text); };

// ---- Files ---------------------------------------------------------------------------------

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
}

function folderBytes(dir) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += folderBytes(full);
    else if (entry.isFile()) { try { total += fs.statSync(full).size; } catch { /* gone */ } }
  }
  return total;
}

function freeBytes(dir) {
  let at = dir;
  while (!fs.existsSync(at)) {
    const up = path.dirname(at);
    if (up === at) break;
    at = up;
  }
  try {
    const stats = fs.statfsSync(at);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

function needSpace(dir, bytes, what) {
  const free = freeBytes(dir);
  if (free === null) { out(`free space: unknown; ${what} needs about ${formatBytes(bytes)}`); return; }
  out(`free space: ${formatBytes(free)}; ${what} needs about ${formatBytes(bytes)}`);
  if (free < bytes) fail(`There is not enough free space for ${what}: it needs about ${formatBytes(bytes)} and ${formatBytes(free)} is free on that drive.`);
}

const sha256File = (file) => new Promise((resolve, reject) => {
  const hash = crypto.createHash("sha256");
  fs.createReadStream(file).on("data", (chunk) => hash.update(chunk)).on("error", reject).on("end", () => resolve(hash.digest("hex")));
});

// Downloads url to file, resuming a .partial left by an interrupted run, and checks its SHA-256.
async function download({ url, size, sha256 }, file, label) {
  if (fs.existsSync(file) && (await sha256File(file)) === sha256) return file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const partial = `${file}.partial`;
  let have = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
  if (have >= size) { fs.rmSync(partial, { force: true }); have = 0; }
  const response = await fetch(url, { redirect: "follow", headers: have ? { Range: `bytes=${have}-` } : {} });
  if (!response.ok) fail(`${label}: ${url} answered ${response.status}.`);
  if (have && response.status !== 206) have = 0;
  out(`downloading ${label} (${formatBytes(size)})${have ? `, resuming at ${formatBytes(have)}` : ""}`);
  const stream = fs.createWriteStream(partial, { flags: have ? "a" : "w" });
  let done = have;
  let shown = -1;
  try {
    for await (const chunk of response.body) {
      if (!stream.write(chunk)) await new Promise((resolve) => stream.once("drain", resolve));
      done += chunk.length;
      const percent = Math.floor((done / size) * 100);
      if (percent !== shown) {
        shown = percent;
        progress(percent, `Downloading ${label}: ${Math.round(done / MB)} of ${Math.round(size / MB)} MB`);
      }
    }
  } finally {
    await new Promise((resolve) => stream.end(resolve));
  }
  const actual = await sha256File(partial);
  if (actual !== sha256) {
    fs.rmSync(partial, { force: true });
    fail(`${label} failed its SHA-256 check (expected ${sha256}, got ${actual}). Try again; if it happens again, the download is not the one Fabula was built with.`);
  }
  fs.renameSync(partial, file);
  return file;
}

// Windows' own tar (bsdtar) unpacks zip; a Git for Windows tar earlier on PATH would not.
function unzip(zip, dir) {
  const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const result = spawnSync(tar, ["-xf", zip, "-C", dir], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) fail(`Could not unpack ${path.basename(zip)}: ${(result.stderr || result.error?.message || "").trim()}`);
}

// Runs a program, passing its output to the log line by line. Resolves with its exit code.
function run(command, args, { env = process.env, quiet = false, heartbeat = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, windowsHide: true });
    let lines = [];
    const emit = (raw) => {
      const line = clean(raw);
      if (!line) return;
      lines.push(line);
      if (lines.length > 200) lines = lines.slice(-100);
      if (!quiet) out(line);
    };
    // Each stream keeps its unfinished last line until the rest of it arrives.
    const reader = () => {
      let pending = "";
      return {
        take: (chunk) => {
          const parts = (pending + chunk).split(/[\r\n]+/);
          pending = parts.pop();
          parts.forEach(emit);
        },
        flush: () => { emit(pending); pending = ""; },
      };
    };
    const stdout = reader();
    const stderr = reader();
    child.stdout.setEncoding("utf8").on("data", stdout.take);
    child.stderr.setEncoding("utf8").on("data", stderr.take);
    const started = Date.now();
    const timer = heartbeat ? setInterval(() => out(`${heartbeat} (${Math.round((Date.now() - started) / 60000)} min so far)`), 60_000) : null;
    child.once("error", (error) => { if (timer) clearInterval(timer); resolve({ code: -1, lines: [...lines, error.message] }); });
    child.once("close", (code) => {
      if (timer) clearInterval(timer);
      stdout.flush();
      stderr.flush();
      resolve({ code, lines });
    });
  });
}

// ---- The steps -----------------------------------------------------------------------------

function probeGpu() {
  const candidates = ["nvidia-smi.exe", path.join(process.env.SystemRoot || "C:\\Windows", "System32", "nvidia-smi.exe")];
  for (const command of candidates) {
    const result = spawnSync(command, ["--query-gpu=name,driver_version,memory.total", "--format=csv,noheader,nounits"], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
    if (result.status === 0) return parseNvidiaSmi(result.stdout);
  }
  return null;
}

async function ffmpegStep(home) {
  const dir = path.join(home, "tools", "ffmpeg");
  const exe = path.join(dir, "bin", "ffmpeg.exe");
  const marker = path.join(dir, ".fabula-pin");
  if (fs.existsSync(exe) && readText(marker) === PINS.ffmpeg.asset) {
    out("already installed");
  } else {
    needSpace(home, 700 * MB, "ffmpeg");
    const downloads = path.join(home, "downloads");
    const zip = await download(PINS.ffmpeg, path.join(downloads, PINS.ffmpeg.asset), "ffmpeg");
    const unpack = path.join(downloads, "ffmpeg-unpack");
    out("unpacking ffmpeg");
    unzip(zip, unpack);
    const top = fs.readdirSync(unpack).find((name) => fs.existsSync(path.join(unpack, name, "bin", "ffmpeg.exe")));
    if (!top) fail("The ffmpeg download has no bin\\ffmpeg.exe in it.");
    const incoming = `${dir}.incoming`;
    fs.rmSync(incoming, { recursive: true, force: true });
    fs.mkdirSync(incoming, { recursive: true });
    fs.renameSync(path.join(unpack, top, "bin"), path.join(incoming, "bin"));
    if (fs.existsSync(path.join(unpack, top, "LICENSE.txt"))) fs.copyFileSync(path.join(unpack, top, "LICENSE.txt"), path.join(incoming, "LICENSE.txt"));
    fs.writeFileSync(path.join(incoming, ".fabula-pin"), PINS.ffmpeg.asset);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(incoming, dir);
    fs.rmSync(unpack, { recursive: true, force: true });
    fs.rmSync(zip, { force: true });
  }
  // ffplay is a player Fabula never runs: 160 MB it does not need.
  fs.rmSync(path.join(dir, "bin", "ffplay.exe"), { force: true });
  const version = spawnSync(exe, ["-hide_banner", "-version"], { encoding: "utf8", windowsHide: true });
  if (version.status !== 0) fail(`ffmpeg does not start: ${(version.stderr || version.error?.message || "").trim()}`);
  const versionLine = version.stdout.split(/\r?\n/)[0];
  out(versionLine);
  // Which hardware encoders this PC has. The renders choose for themselves; this is the record.
  const encodes = (codec) => spawnSync(exe, ["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=256x144:r=30:d=0.2", "-c:v", codec, "-f", "null", "-"], { windowsHide: true, timeout: 60_000 }).status === 0;
  const nvenc = { h264: encodes("h264_nvenc"), hevc: encodes("hevc_nvenc") };
  out(nvenc.h264 ? "NVENC: available, the GPU encodes the renders" : "NVENC: not available here, the renders use libx264");
  return { build: PINS.ffmpeg.build, version: versionLine.replace(/^ffmpeg version /, "").split(" ")[0], nvenc, bytes: folderBytes(dir) };
}

function readText(file) {
  try { return fs.readFileSync(file, "utf8").trim(); } catch { return null; }
}

async function uvStep(home) {
  const dir = path.join(home, "tools", "uv");
  const exe = path.join(dir, "uv.exe");
  const marker = path.join(dir, ".fabula-pin");
  if (fs.existsSync(exe) && readText(marker) === PINS.uv.version) {
    out("already installed");
  } else {
    const zip = await download(PINS.uv, path.join(home, "downloads", `uv-${PINS.uv.version}.zip`), "uv");
    const incoming = `${dir}.incoming`;
    unzip(zip, incoming);
    if (!fs.existsSync(path.join(incoming, "uv.exe"))) fail("The uv download has no uv.exe in it.");
    fs.writeFileSync(path.join(incoming, ".fabula-pin"), PINS.uv.version);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(incoming, dir);
    fs.rmSync(zip, { force: true });
  }
  const version = spawnSync(exe, ["--version"], { encoding: "utf8", windowsHide: true });
  if (version.status !== 0) fail("uv does not start.");
  out(version.stdout.trim());
  return exe;
}

// uv keeps its Python inside the engine home, and its download cache too unless the person has a
// cache of their own (UV_CACHE_DIR), in which case that is used and left alone.
function uvEnv(home) {
  const env = { ...process.env, UV_PYTHON_INSTALL_DIR: path.join(home, "tools", "python"), UV_NO_PROGRESS: "1", NO_COLOR: "1" };
  const ownCache = !process.env.UV_CACHE_DIR;
  if (ownCache) env.UV_CACHE_DIR = path.join(home, "cache", "uv");
  return { env, ownCache };
}

const VERIFY_PY = String.raw`
import json, sys
info = {"python": sys.version.split()[0]}
import torch
info["torch"] = torch.__version__
info["cuda"] = bool(torch.cuda.is_available())
if info["cuda"]:
    try:
        info["gpu"] = torch.cuda.get_device_name(0)
        info["cudaWorks"] = float((torch.ones(4, device="cuda") * 2).sum().item()) == 8.0
    except Exception as error:
        info["cudaWorks"] = False
        info["cudaError"] = str(error)
import ctranslate2
info["ctranslate2"] = ctranslate2.__version__
info["ctranslate2CudaDevices"] = ctranslate2.get_cuda_device_count()
import whisperx
from importlib.metadata import version
info["whisperx"] = version("whisperx")
import winpty
info["pywinpty"] = version("pywinpty")
print("VERIFY " + json.dumps(info), flush=True)
`;

async function verifyVenv(home, env) {
  const script = path.join(home, "setup", "verify-venv.py");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, VERIFY_PY);
  const result = await run(host.python(env), ["-I", script], { env: host.venvEnv(env), quiet: true });
  const line = result.lines.find((text) => text.startsWith("VERIFY "));
  if (result.code !== 0 || !line) return { ok: false, lines: result.lines };
  return { ok: true, info: JSON.parse(line.slice(7)) };
}

async function venvStep(home, kind, uv) {
  const plan = PLANS[kind];
  const venv = path.dirname(path.dirname(host.python()));
  const marker = path.join(venv, ".fabula-venv.json");
  const spec = venvSpec(kind);
  const previous = readJson(marker);
  if (previous && sameSpec(previous.spec, spec) && fs.existsSync(host.python())) {
    const check = await verifyVenv(home, process.env);
    if (check.ok) {
      out(`already installed: torch ${check.info.torch}, whisperx ${check.info.whisperx}, CUDA ${check.info.cuda ? "available" : "not available"}`);
      return { ...check.info, bytes: folderBytes(venv) };
    }
    out("the venv is there but does not import; installing again");
  }
  needSpace(home, plan.venvBytes + 4 * GB, "Python and WhisperX");
  const { env, ownCache } = uvEnv(home);
  if (!fs.existsSync(host.python())) {
    out(`making a Python ${PINS.python} venv`);
    const made = await run(uv, ["venv", "--managed-python", "--python", PINS.python, venv], { env });
    if (made.code !== 0) fail("uv could not make the Python venv. The log above says why.");
  }
  const python = host.python();
  const p = PINS.packages;
  const pins = [`whisperx==${p.whisperx}`, `pywinpty==${p.pywinpty}`, `torch==${p.torch}`, `torchaudio==${p.torchaudio}`, `torchvision==${p.torchvision}`];
  out(`installing WhisperX ${p.whisperx} and torch ${p.torch} for ${kind === "cuda" ? "CUDA 12.8" : "the CPU"} (downloads ${kind === "cuda" ? "about 3.5 GB" : "about 1 GB"})`);
  // whisperx from PyPI, which brings torch from PyPI: the CPU build, on Windows. (uv's
  // --torch-backend would send torchcodec to PyTorch's index too, which has no Windows wheel.)
  const installed = await run(uv, ["pip", "install", "--python", python, ...pins], { env, heartbeat: "still installing Python packages" });
  if (installed.code !== 0) fail("Installing WhisperX stopped. The log above says why; running the setup again picks up where it stopped.");
  // On CUDA, torch, torchaudio and torchvision are then replaced by the builds from PyTorch's
  // index, as they were first proved. --no-deps: their dependencies are already there.
  if (kind === "cuda") {
    out(`replacing torch with the CUDA 12.8 build from ${plan.torchIndex}`);
    const cuda = await run(uv, ["pip", "install", "--python", python, "--index-url", plan.torchIndex, "--no-deps", "--reinstall-package", "torch", "--reinstall-package", "torchaudio", "--reinstall-package", "torchvision", `torch==${p.torch}`, `torchaudio==${p.torchaudio}`, `torchvision==${p.torchvision}`], { env, heartbeat: "still installing torch" });
    if (cuda.code !== 0) fail("Installing the CUDA build of torch stopped. The log above says why.");
  }
  const check = await verifyVenv(home, process.env);
  if (check.ok && !String(check.info.torch).endsWith(plan.torchTag)) fail(`torch ${check.info.torch} is installed, not the ${kind === "cuda" ? "CUDA" : "CPU"} build the setup asked for.`);
  if (!check.ok) {
    for (const line of check.lines.slice(-15)) out(line);
    fail("WhisperX installed but does not import. The log above says why.");
  }
  writeJson(marker, { spec, installedAt: new Date().toISOString() });
  if (ownCache) {
    out("removing uv's download cache");
    await run(uv, ["cache", "clean"], { env, quiet: true });
    fs.rmSync(path.join(home, "cache"), { recursive: true, force: true });
  }
  const info = check.info;
  out(`torch ${info.torch}, CUDA ${info.cuda ? `available (${info.gpu})` : "not available"}; ctranslate2 ${info.ctranslate2} sees ${info.ctranslate2CudaDevices} CUDA device(s); whisperx ${info.whisperx}; pywinpty ${info.pywinpty}`);
  return { ...info, bytes: folderBytes(venv) };
}

// Pre-downloads what WhisperX would otherwise fetch on the first transcription: the
// faster-whisper model into HF_HOME, the English alignment model into TORCH_HOME and NLTK's
// sentence splitter into the venv. The VAD model ships inside whisperx (assets/pytorch_model.bin).
const MODELS_PY = String.raw`
import fnmatch, json, os, sys, threading

def folder_bytes(path):
    total = 0
    for base, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(base, name))
            except OSError:
                pass
    return total

def watched(label, folder, total, work):
    done = threading.Event()
    start = folder_bytes(folder)
    def watch():
        shown = -1
        while not done.wait(1.5):
            have = max(0, folder_bytes(folder) - start)
            percent = min(99, int(have * 100 / total)) if total else 0
            if percent != shown:
                shown = percent
                print(f"PROGRESS {percent} Downloading {label}: {have // 1000000} of {total // 1000000} MB", flush=True)
    thread = threading.Thread(target=watch, daemon=True)
    thread.start()
    try:
        return work()
    finally:
        done.set()
        thread.join()

def speech(name, repo):
    from faster_whisper.utils import download_model
    try:
        path = download_model(name, local_files_only=True)
        print(f"the {name} speech model is already here", flush=True)
        return path
    except Exception:
        pass
    from huggingface_hub import HfApi
    patterns = ["config.json", "preprocessor_config.json", "model.bin", "tokenizer.json", "vocabulary.*"]
    siblings = HfApi().model_info(repo, files_metadata=True).siblings
    total = sum((s.size or 0) for s in siblings if any(fnmatch.fnmatch(s.rfilename, p) for p in patterns))
    print(f"downloading the {name} speech model ({total // 1000000} MB) from {repo}", flush=True)
    folder = os.path.join(os.environ["HF_HOME"], "hub", "models--" + repo.replace("/", "--"))
    return watched(f"the {name} speech model", folder, total, lambda: download_model(name))

def alignment():
    import torch, torchaudio
    bundle = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
    folder = os.path.join(torch.hub.get_dir(), "checkpoints")
    target = os.path.join(folder, os.path.basename(bundle._path))
    if os.path.exists(target):
        print("the English alignment model is already here", flush=True)
    else:
        print("downloading the English alignment model (about 360 MB)", flush=True)
        os.makedirs(folder, exist_ok=True)
    watched("the alignment model", folder, 377_664_473, lambda: bundle.get_model(dl_kwargs={"progress": False}))
    return target

def punkt():
    import nltk
    target = os.path.join(sys.prefix, "nltk_data")
    # In the venv (sys.prefix\\nltk_data is on NLTK's search path), whatever the profile holds.
    if os.path.isdir(os.path.join(target, "tokenizers", "punkt_tab", "english")):
        print("NLTK's sentence splitter is already here", flush=True)
    else:
        print("downloading NLTK's sentence splitter", flush=True)
        if not nltk.download("punkt_tab", download_dir=target, quiet=True):
            raise SystemExit("NLTK could not download punkt_tab")
    return target

what = sys.argv[1]
if what == "speech":
    path = speech(sys.argv[2], sys.argv[3])
elif what == "alignment":
    path = alignment()
    punkt()
else:
    raise SystemExit("unknown model step " + what)
print("MODEL " + json.dumps({"path": path}), flush=True)
`;

async function modelStep(home, which, args) {
  const script = path.join(home, "setup", "fetch-models.py");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, MODELS_PY);
  const env = { ...host.venvEnv(), HF_HUB_DISABLE_PROGRESS_BARS: "1", HF_HUB_DISABLE_SYMLINKS_WARNING: "1", PYTHONUNBUFFERED: "1", PYTHONUTF8: "1" };
  const result = await run(host.python(), ["-I", script, which, ...args], { env });
  if (result.code !== 0 || !result.lines.some((line) => line.startsWith("MODEL "))) fail(`Downloading the ${which === "speech" ? "speech model" : "alignment model"} stopped. The log above says why; running the setup again resumes it.`);
}

function settingsStep(home, requested) {
  const file = path.join(home, "settings.json");
  const settings = readJson(file);
  const current = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  if (typeof current.projectsRoot === "string" && current.projectsRoot) {
    // An update, or a second run: the projects stay where they are.
    out(`projects stay in ${current.projectsRoot}`);
    fs.mkdirSync(current.projectsRoot, { recursive: true });
    return current.projectsRoot;
  }
  const root = validProjectsRoot(requested || defaultProjectsRoot());
  fs.mkdirSync(root, { recursive: true });
  writeJson(file, { ...current, projectsRoot: root });
  out(`projects go to ${root}`);
  return root;
}

// The whole engine, once, on a second of tone: the speech model, the VAD and the alignment model
// all load from disk with the network refused, on the device the pipeline will use.
async function checkStep(home, kind) {
  const plan = PLANS[kind];
  const dir = path.join(home, "setup", "check");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const wav = path.join(dir, "check.wav");
  const made = spawnSync(host.ffmpeg(), ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-ac", "1", "-ar", "16000", wav], { windowsHide: true });
  if (made.status !== 0) fail("ffmpeg could not make the test sound.");
  const env = { ...host.venvEnv(), HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_SYMLINKS_WARNING: "1", PYTHONUTF8: "1" };
  const started = Date.now();
  const result = await run(host.whisperx(), [wav, "--model", plan.model, "--device", kind, "--compute_type", plan.computeType, "--language", "en", "--output_format", "json", "--output_dir", dir], { env, quiet: true });
  if (result.code !== 0 || !fs.existsSync(path.join(dir, "check.json"))) {
    for (const line of result.lines.slice(-15)) out(line);
    fail("WhisperX did not run. The log above says why.");
  }
  out(`WhisperX ran ${plan.model} on the ${kind === "cuda" ? "GPU" : "CPU"} from disk in ${Math.round((Date.now() - started) / 1000)} s`);
  fs.rmSync(dir, { recursive: true, force: true });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (process.platform !== "win32") fail("setup-windows.mjs sets up Fabula on Windows. A Linux checkout uses scripts/setup-tools.sh.");
  const home = host.engineHome();
  const version = args.version || readJson(path.join(host.CODE_ROOT, "package.json"))?.version || null;
  fs.mkdirSync(home, { recursive: true });
  out(`engine home: ${home}`);
  const started = Date.now();

  step(1, "Checking this PC");
  const gpu = probeGpu();
  const choice = chooseGpu(gpu, { forceCpu: args.cpu || process.env.FABULA_FORCE_CPU === "1" });
  let kind = choice.kind;
  out(kind === "cuda" ? `NVIDIA GPU: ${choice.reason}; transcription runs on CUDA with the large-v3 model` : `transcription runs on the CPU with the small model: ${choice.reason}`);
  const free = freeBytes(home);
  if (free !== null) out(`free space where the engine goes: ${formatBytes(free)}`);

  step(2, "Installing ffmpeg");
  const ffmpeg = await ffmpegStep(home);

  step(3, "Installing uv");
  const uv = await uvStep(home);

  step(4, "Installing Python and WhisperX (several GB, once)");
  const venv = await venvStep(home, kind, uv);
  if (kind === "cuda" && !(venv.cuda && venv.cudaWorks !== false && venv.ctranslate2CudaDevices > 0)) {
    // The CUDA wheels run on the CPU as well; only the model and its precision change.
    out(`CUDA did not work in the venv${venv.cudaError ? ` (${venv.cudaError})` : ""}; transcription will run on the CPU with the small model`);
    kind = "cpu";
  }
  const plan = PLANS[kind];

  step(5, `Downloading the speech model (${plan.model}, about ${formatBytes(plan.modelBytes)})`);
  needSpace(home, plan.modelBytes + 500 * MB, "the speech model");
  await modelStep(home, "speech", [plan.model, plan.repo]);

  step(6, "Downloading the alignment model");
  await modelStep(home, "alignment", []);

  step(7, "Choosing the projects folder");
  const projectsRoot = settingsStep(home, args.projectsRoot);

  step(8, "Checking the engine");
  await checkStep(home, kind);
  const sizes = {
    ffmpeg: ffmpeg.bytes,
    python: folderBytes(path.join(home, "tools", "python")),
    venv: venv.bytes,
    models: folderBytes(path.join(home, "models")),
  };
  for (const [what, bytes] of Object.entries(sizes)) out(`size of ${what}: ${formatBytes(bytes)}`);
  writeJson(path.join(home, "engine.json"), {
    setupVersion: SETUP_VERSION,
    version,
    gpu: kind,
    gpuName: gpu?.name ?? null,
    driver: gpu?.driver ?? null,
    model: plan.model,
    computeType: plan.computeType,
    ffmpeg: { build: ffmpeg.build, version: ffmpeg.version, nvenc: ffmpeg.nvenc },
    uv: PINS.uv.version,
    python: venv.python,
    torch: venv.torch,
    whisperx: venv.whisperx,
    projectsRoot,
    sizes,
    readyAt: new Date().toISOString(),
  });
  out(`set up in ${Math.round((Date.now() - started) / 1000)} s`);
  out(`READY ${home}`);
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  main().catch((error) => {
    const text = error instanceof SetupError ? error.message : `The setup stopped: ${error.stack || error.message}`;
    out(`FAIL ${text.split(/\r?\n/)[0]}`);
    if (!(error instanceof SetupError) && error.stack) for (const line of error.stack.split(/\r?\n/).slice(1)) out(line);
    process.exitCode = 1;
  });
}

