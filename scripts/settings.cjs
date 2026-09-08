"use strict";
// Where the projects live. media/ beside the checkout by default; a folder of
// the person's choosing otherwise, recorded as the pipeline sees it (a WSL
// path such as /mnt/c/Users/me/Videos/Fabula) in <repo>/fabula.settings.json,
// so the window on Windows and the pipeline in WSL agree on one place. CJS so
// the Electron main process reads it synchronously at startup and the ESM
// server imports it.

const fs = require("node:fs");
const path = require("node:path");

const SETTINGS_FILE = path.join(__dirname, "..", "fabula.settings.json");

function readSettings(file = SETTINGS_FILE) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

// A projects root as the pipeline sees it: absolute, POSIX, printable.
function validateProjectsRoot(value) {
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

module.exports = { SETTINGS_FILE, readSettings, validateProjectsRoot, configuredProjectsRoot, writeProjectsRoot };
