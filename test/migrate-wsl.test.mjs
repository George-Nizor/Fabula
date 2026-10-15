import test from "node:test";
import assert from "node:assert/strict";
import { windowsPath, rewritePaths, wslSpelling } from "../scripts/migrate-wsl.mjs";

test("a WSL drive path becomes a Windows drive path; anything else is left alone", () => {
  assert.equal(windowsPath("/mnt/e/Video Storage/take.mkv"), "E:\\Video Storage\\take.mkv");
  assert.equal(windowsPath("/mnt/c"), "C:\\");
  assert.equal(windowsPath("/home/me/x.png"), "/home/me/x.png");
  assert.equal(windowsPath("relative/clip.mp4"), "relative/clip.mp4");
});

test("a project's files have their recording and project-folder paths rewritten, and say how many", () => {
  const before = JSON.stringify({
    path: "/mnt/e/OBS/take.mkv",
    frames: ["/home/me/.local/share/fabula/projects/film/framing/a.png"],
    note: "kept as it is",
  });
  const { text, changed } = rewritePaths(before, { oldRoot: "/home/me/.local/share/fabula/projects", newRoot: "C:\\Users\\me\\Videos\\Fabula" });
  const after = JSON.parse(text);
  assert.equal(changed, 2);
  assert.equal(after.path, "E:\\OBS\\take.mkv");
  assert.equal(after.frames[0], "C:\\Users\\me\\Videos\\Fabula\\film\\framing\\a.png");
  assert.equal(after.note, "kept as it is");
});

test("the share path Windows reads the WSL engine through is turned back into WSL's spelling", () => {
  assert.equal(wslSpelling("\\\\wsl.localhost\\Ubuntu\\home\\me\\.local\\share\\fabula\\projects"), "/home/me/.local/share/fabula/projects");
  assert.equal(wslSpelling("C:\\x"), null);
});
