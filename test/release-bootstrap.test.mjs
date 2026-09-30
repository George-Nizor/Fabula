import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// The Windows bootstrap's pure half (release/windows/engine.cjs): where things are from either
// side of WSL, what the setup script's lines mean, what a remembered engine may say.
const engine = createRequire(import.meta.url)("../release/windows/engine.cjs");

test("paths cross between Windows and WSL both ways", () => {
  assert.equal(engine.uncPath("Ubuntu", "/home/me/.local/share/fabula"), "\\\\wsl.localhost\\Ubuntu\\home\\me\\.local\\share\\fabula");
  assert.equal(engine.toWslPath("C:\\Users\\George\\AppData\\Local\\Instrumenta\\setup-engine.sh"), "/mnt/c/Users/George/AppData/Local/Instrumenta/setup-engine.sh");
  assert.throws(() => engine.uncPath("bad name", "/x"), /distribution name/);
  assert.throws(() => engine.uncPath("Ubuntu", "relative"), /absolute/);
  assert.throws(() => engine.toWslPath("\\\\server\\share\\x"), /not on a drive/);
});

test("wsl.exe's own UTF-16 and a Linux program's UTF-8 both read as text", () => {
  assert.equal(engine.decodeWslOutput(Buffer.from("Ubuntu\n/home/me\n", "utf8")), "Ubuntu\n/home/me\n");
  assert.equal(engine.decodeWslOutput(Buffer.from("\uFEFFNo installed distributions", "utf16le")), "No installed distributions");
  assert.deepEqual(engine.parseProbe("Ubuntu\r\n/home/me\r\n"), { distro: "Ubuntu", home: "/home/me" });
  assert.throws(() => engine.parseProbe("\n\n"), /distribution name/);
});

test("the setup script's lines are steps, the end, or the log", () => {
  assert.deepEqual(engine.parseLine("STEP 3 8 Installing Fabula's packages"), { type: "step", n: 3, total: 8, label: "Installing Fabula's packages" });
  assert.deepEqual(engine.parseLine("READY /home/me/.local/share/fabula\r"), { type: "ready", root: "/home/me/.local/share/fabula" });
  assert.deepEqual(engine.parseLine("downloading ffmpeg (~120 MB)"), { type: "log", text: "downloading ffmpeg (~120 MB)" });
});

test("a remembered engine is trusted only when it is well formed", () => {
  const state = { distro: "Ubuntu", home: "/home/me", root: "/home/me/.local/share/fabula" };
  assert.deepEqual(engine.validState(state), state);
  assert.equal(engine.validState({ ...state, root: "/home/me/../../etc" }), null);
  assert.equal(engine.validState({ ...state, distro: "a b" }), null);
  assert.equal(engine.validState(null), null);
  assert.equal(engine.versionDir(state, "0.2.0"), "\\\\wsl.localhost\\Ubuntu\\home\\me\\.local\\share\\fabula\\versions\\0.2.0");
  assert.throws(() => engine.versionDir(state, "../x"), /not a version/);
});

test("the setup runs in a login shell of the chosen distribution, its arguments quoted", () => {
  const { command, args } = engine.setupCommand({ distro: "Ubuntu", script: "/mnt/c/x/setup-engine.sh", tarball: "/mnt/c/it's/f.tar.gz", version: "0.2.0" });
  assert.equal(command, "wsl.exe");
  assert.deepEqual(args.slice(0, 5), ["-d", "Ubuntu", "--", "bash", "-lc"]);
  assert.equal(args[5], "bash '/mnt/c/x/setup-engine.sh' --version '0.2.0' --tarball '/mnt/c/it'\\''s/f.tar.gz'");
});
