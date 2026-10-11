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
  assert.deepEqual(args.slice(0, 5), ["-d", "Ubuntu", "-e", "bash", "-lc"]);
  assert.equal(args[5], "bash '/mnt/c/x/setup-engine.sh' --version '0.2.0' --tarball '/mnt/c/it'\\''s/f.tar.gz'");
});

test("a first setup can name the projects folder, quoted like the rest", () => {
  const { args } = engine.setupCommand({ distro: "Ubuntu", script: "/s.sh", tarball: "/t.tar.gz", version: "0.2.0", projectsRoot: "/mnt/c/Users/Jo's/Videos/Fabula" });
  assert.equal(args[5], "bash '/s.sh' --version '0.2.0' --tarball '/t.tar.gz' --projects-root '/mnt/c/Users/Jo'\\''s/Videos/Fabula'");
  assert.doesNotMatch(engine.setupCommand({ distro: "Ubuntu", script: "/s.sh", tarball: "/t.tar.gz", version: "0.2.0" }).args[5], /projects-root/);
});

test("the projects choice becomes a folder as WSL sees it, or the engine's own", () => {
  assert.equal(engine.projectsRootFor({ kind: "windows", folder: "C:\\Users\\George\\Videos\\Fabula\\" }), "/mnt/c/Users/George/Videos/Fabula");
  assert.equal(engine.projectsRootFor({ kind: "wsl" }), null);
  assert.equal(engine.projectsRootFor(null), null);
  assert.throws(() => engine.projectsRootFor({ kind: "windows", folder: "D:\\" }), /top of a drive/);
  assert.throws(() => engine.projectsRootFor({ kind: "windows", folder: "\\\\nas\\videos" }), /not on a drive/);
  assert.throws(() => engine.projectsRootFor({ kind: "windows", folder: "" }), /Choose a folder/);
  assert.throws(() => engine.projectsRootFor({ kind: "windows", folder: "C:\\a\nb" }), /characters/);
});
