import test from "node:test";
import assert from "node:assert/strict";
import { hostPath } from "../scripts/host-path.mjs";

test("a Windows path becomes the path the pipeline host opens; a POSIX one passes through", () => {
  assert.equal(hostPath("E:\\Music\\beds\\calm.mp3"), "/mnt/e/Music/beds/calm.mp3");
  assert.equal(hostPath("C:/Users/me/Videos/talk.mkv"), "/mnt/c/Users/me/Videos/talk.mkv");
  assert.equal(hostPath("\\\\wsl.localhost\\Ubuntu\\home\\me\\bed.wav"), "/home/me/bed.wav");
  assert.equal(hostPath("\\\\wsl$\\Ubuntu\\tmp\\x.png"), "/tmp/x.png");
  assert.equal(hostPath("/mnt/e/Music/beds/calm.mp3"), "/mnt/e/Music/beds/calm.mp3");
  assert.equal(hostPath("  D:\\  "), "/mnt/d");
  assert.equal(hostPath(""), "");
});
