import test from "node:test";
import assert from "node:assert/strict";
import { identityPath, cutIdentity, cleanIdentity, CLEAN_VERSION } from "../core/clean-identity.mjs";

const source = { path: "/mnt/e/take.mkv", bytes: 123 };
const keeps = [{ start: 0, end: 4.12345 }, { start: 6.5, end: 10 }];
const framing = { segments: [{ start: 0, end: 10, head: { x: 0, y: 0, w: 1920, h: 1080 }, screen: null }] };
const base = { source, keeps, framing, fps: 30, ceiling: { width: 1920, height: 1080 } };

test("the cut identity follows the keeps and the source, to the millisecond", () => {
  const a = cutIdentity({ source, keeps });
  assert.equal(cutIdentity({ source, keeps: [{ start: 0, end: 4.1234 }, keeps[1]] }), a); // sub-ms noise
  assert.notEqual(cutIdentity({ source, keeps: [{ start: 0, end: 4.2 }, keeps[1]] }), a);
  assert.notEqual(cutIdentity({ source: { ...source, bytes: 124 }, keeps }), a);
});

test("the clean identity adds framing and delivery, and carries the version", () => {
  const a = cleanIdentity(base);
  assert.ok(a.includes(CLEAN_VERSION));
  assert.equal(cleanIdentity({ ...base }), a);
  const reframed = { segments: [{ ...framing.segments[0], head: { x: 10, y: 0, w: 1900, h: 1080 } }] };
  assert.notEqual(cleanIdentity({ ...base, framing: reframed }), a);
  assert.notEqual(cleanIdentity({ ...base, fps: 25 }), a);
  assert.notEqual(cleanIdentity({ ...base, ceiling: { width: 1280, height: 720 } }), a);
});

test("a recording keeps its identity when its path moves from WSL's spelling to Windows'", () => {
  assert.equal(identityPath("E:\\Video Storage\\take.mkv"), "/mnt/e/Video Storage/take.mkv");
  assert.equal(identityPath("/mnt/e/Video Storage/take.mkv"), "/mnt/e/Video Storage/take.mkv");
  const keeps = [{ start: 1, end: 2 }];
  assert.equal(
    cutIdentity({ source: { path: "E:\\Video Storage\\take.mkv", bytes: 9 }, keeps }),
    cutIdentity({ source: { path: "/mnt/e/Video Storage/take.mkv", bytes: 9 }, keeps }),
  );
});
