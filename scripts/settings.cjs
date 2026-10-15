"use strict";
// Where the projects live. media/ beside the checkout by default; a folder of
// the person's choosing otherwise, recorded as the pipeline sees it (a WSL
// path such as /mnt/c/Users/me/Videos/Fabula) in <repo>/fabula.settings.json,
// so the window on Windows and the pipeline in WSL agree on one place. CJS so
// the Electron main process reads it synchronously at startup and the ESM
// server imports it.

const fs = require("node:fs");
const path = require("node:path");

const host = require("./host.cjs");

// Natively on Windows the settings live in the engine home, which every
// version shares (the code is the installed bundle, replaced on update).
// Elsewhere beside the code, carried forward by setup-engine.sh.
const NATIVE_WINDOWS = host.IS_WINDOWS;
const SETTINGS_FILE = NATIVE_WINDOWS && host.engineHome()
  ? path.join(host.engineHome(), "settings.json")
  : path.join(__dirname, "..", "fabula.settings.json");
const ENGINE_HOME_FILE = path.join(__dirname, "..", ".engine-home");

// An installed engine (scripts/setup-engine.sh) runs Fabula from a folder per version, replaced
// on update and deleted the update after. Its projects cannot live beside that folder, so the
// setup writes the engine's home beside the code (.engine-home) and the default projects folder is
// <home>/projects. A checkout has no .engine-home and keeps media/ beside it. As the pipeline sees
// it (POSIX), or null.
function engineProjectsRoot(file = ENGINE_HOME_FILE) {
  // On Windows the default projects folder is the person's Videos\Fabula.
  if (NATIVE_WINDOWS && file === ENGINE_HOME_FILE) return path.join(require("node:os").homedir(), "Videos", "Fabula");
  try {
    const home = fs.readFileSync(file, "utf8").trim();
    if (!home.startsWith("/") || /[\x00-\x1f\\]/.test(home)) return null;
    return path.posix.join(home, "projects");
  } catch {
    return null;
  }
}

function readSettings(file = SETTINGS_FILE) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

// A projects root as the pipeline sees it: absolute and printable; a drive
// path on Windows (C:\Users\me\Videos\Fabula), POSIX elsewhere.
function validateProjectsRoot(value) {
  if (NATIVE_WINDOWS) {
    if (typeof value !== "string" || !/^[A-Za-z]:[\\/]/.test(value)) {
      throw new Error("The projects folder must be a full Windows path, such as C:\\Users\\me\\Videos\\Fabula.");
    }
    if (/[\x00-\x1f\x7f]/.test(value)) throw new Error("The projects folder path has characters that cannot be used.");
    return path.win32.normalize(value).replace(/[\\/]+$/, "") || value;
  }
  if (typeof value !== "string" || !value.startsWith("/") || value.length < 2) {
    throw new Error("The projects folder must be an absolute path as WSL sees it, such as /mnt/c/Users/me/Videos/Fabula.");
  }
  if (/[\x00-\x1f\x7f]/.test(value) || value.includes("\\")) throw new Error("The projects folder path has characters that cannot be used.");
  return path.posix.normalize(value).replace(/\/+$/, "") || "/";
}

// The configured root, or null when the default (media/ beside the checkout)
// applies. A malformed value is ignored rather than trusted.
function configuredProjectsRoot(file = SETTINGS_FILE) {
  const { projectsRoot } = readSettings(file);
  if (projectsRoot === undefined || projectsRoot === null || projectsRoot === "") return null;
  try {
    return validateProjectsRoot(projectsRoot);
  } catch {
    return null;
  }
}

// Writes the root (null restores the default). Other settings survive.
function writeProjectsRoot(value, file = SETTINGS_FILE) {
  const settings = readSettings(file);
  if (value === null) delete settings.projectsRoot;
  else settings.projectsRoot = validateProjectsRoot(value);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(settings, null, 2) + "\n");
  fs.renameSync(temp, file);
  return settings.projectsRoot ?? null;
}

// Where the person's music lives, for list_music: a folder as the pipeline
// sees it, or null when none is set. The same rules as the projects root.
function configuredMusicRoot(file = SETTINGS_FILE) {
  const { musicRoot } = readSettings(file);
  if (musicRoot === undefined || musicRoot === null || musicRoot === "") return null;
  try {
    return validateProjectsRoot(musicRoot);
  } catch {
    return null;
  }
}

function writeMusicRoot(value, file = SETTINGS_FILE) {
  const settings = readSettings(file);
  if (value === null) delete settings.musicRoot;
  else settings.musicRoot = validateProjectsRoot(value);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(settings, null, 2) + "\n");
  fs.renameSync(temp, file);
  return settings.musicRoot ?? null;
}

// The person's assistant choice (CLI, model, effort, persona). An installed
// engine keeps it in its home, beside the projects, so an update (a new
// versions/<v> folder) does not forget it; a checkout keeps it beside the
// code. As the pipeline sees it (POSIX for an engine).
const CHECKOUT_PREFERENCES = path.join(__dirname, "..", ".assistant-preferences.json");
function assistantPreferencesFile(file = ENGINE_HOME_FILE) {
  if (NATIVE_WINDOWS && file === ENGINE_HOME_FILE && host.engineHome()) return path.join(host.engineHome(), "assistant-preferences.json");
  const projects = engineProjectsRoot(file);
  return projects ? path.posix.join(path.posix.dirname(projects), "assistant-preferences.json") : CHECKOUT_PREFERENCES;
}

module.exports = { SETTINGS_FILE, CHECKOUT_PREFERENCES, assistantPreferencesFile, readSettings, validateProjectsRoot, configuredProjectsRoot, engineProjectsRoot, writeProjectsRoot, configuredMusicRoot, writeMusicRoot };
