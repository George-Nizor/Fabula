import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const { configuredProjectsRoot, writeProjectsRoot, validateProjectsRoot } = createRequire(import.meta.url)("../scripts/settings.cjs");

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
