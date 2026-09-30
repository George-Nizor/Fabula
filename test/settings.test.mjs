import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const { configuredProjectsRoot, engineProjectsRoot, writeProjectsRoot, validateProjectsRoot } = createRequire(import.meta.url)("../scripts/settings.cjs");

test("the projects root is the default until a folder is written, and a bad value is ignored", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabula-settings-"));
  const file = path.join(dir, "fabula.settings.json");
  try {
    assert.equal(configuredProjectsRoot(file), null, "no file: default");
    assert.equal(writeProjectsRoot("/mnt/c/Users/me/Videos/Fabula/", file), "/mnt/c/Users/me/Videos/Fabula");
    assert.equal(configuredProjectsRoot(file), "/mnt/c/Users/me/Videos/Fabula");
    fs.writeFileSync(file, JSON.stringify({ projectsRoot: "relative/folder", other: 1 }));
    assert.equal(configuredProjectsRoot(file), null, "a relative root is not trusted");
    assert.equal(writeProjectsRoot(null, file), null);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { other: 1 }, "other settings survive");
    fs.writeFileSync(file, "not json");
    assert.equal(configuredProjectsRoot(file), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a projects root is an absolute POSIX path", () => {
  for (const bad of ["", "media", "C:\\Users\\me\\Videos", "/tmp/\u0000x", 42, null]) assert.throws(() => validateProjectsRoot(bad), bad === null ? /absolute/ : undefined);
  assert.equal(validateProjectsRoot("/workspace//Fabula/media/"), "/workspace/Fabula/media");
});

test("a music root is kept beside the projects root and read back the same way", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { createRequire } = await import("node:module");
  const settings = createRequire(import.meta.url)("../scripts/settings.cjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabula-settings-"));
  const file = path.join(dir, "fabula.settings.json");
  try {
    assert.equal(settings.configuredMusicRoot(file), null);
    settings.writeProjectsRoot("/mnt/c/Fabula", file);
    assert.equal(settings.writeMusicRoot("/mnt/c/Music/beds/", file), "/mnt/c/Music/beds");
    assert.equal(settings.configuredMusicRoot(file), "/mnt/c/Music/beds");
    assert.equal(settings.configuredProjectsRoot(file), "/mnt/c/Fabula", "the projects root survives");
    assert.throws(() => settings.writeMusicRoot("C:\\Music", file), /absolute path/);
    settings.writeMusicRoot(null, file);
    assert.equal(settings.configuredMusicRoot(file), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("an installed engine keeps its projects outside any one version", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabula-engine-home-"));
  const file = path.join(dir, ".engine-home");
  try {
    assert.equal(engineProjectsRoot(file), null, "a checkout has no .engine-home and keeps media/");
    fs.writeFileSync(file, "/home/me/.local/share/fabula\n");
    assert.equal(engineProjectsRoot(file), "/home/me/.local/share/fabula/projects");
    fs.writeFileSync(file, "relative/home");
    assert.equal(engineProjectsRoot(file), null, "a relative home is not trusted");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
