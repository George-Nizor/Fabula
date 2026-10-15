import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as setup from "../scripts/setup-windows.mjs";

// scripts/setup-windows.mjs's pure half: what it pins, which machine gets what, and its arguments.
// The steps themselves download gigabytes on Windows and are proved there, not here.
const engine = createRequire(import.meta.url)("../release/windows/engine.cjs");

test("the setup and the bootstrap agree on engine.json's version", () => {
  assert.equal(setup.SETUP_VERSION, engine.SETUP_VERSION);
});

test("every download is pinned to one file with its size and SHA-256", () => {
  for (const pin of [setup.PINS.ffmpeg, setup.PINS.uv]) {
    assert.match(pin.url, /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+\.zip$/);
    assert.doesNotMatch(pin.url, /\/latest\//);
    assert.match(pin.sha256, /^[0-9a-f]{64}$/);
    assert.ok(pin.size > 1e6);
  }
  assert.ok(setup.PINS.ffmpeg.url.endsWith(setup.PINS.ffmpeg.asset));
  assert.match(setup.PINS.ffmpeg.asset, /win64-gpl-8\.1\.zip$/);
  for (const version of Object.values(setup.PINS.packages)) assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(setup.PINS.packages.whisperx, "3.8.6");
});

test("nvidia-smi's answer is read, and an old driver or none means the CPU", () => {
  const gpu = setup.parseNvidiaSmi("NVIDIA GeForce RTX 4080 SUPER, 617.14, 16376\r\n");
  assert.deepEqual(gpu, { name: "NVIDIA GeForce RTX 4080 SUPER", driver: "617.14", memoryMb: 16376 });
  assert.equal(setup.parseNvidiaSmi(""), null);
  assert.equal(setup.parseNvidiaSmi("NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver."), null);
  assert.equal(setup.chooseGpu(gpu).kind, "cuda");
  assert.equal(setup.chooseGpu(gpu, { forceCpu: true }).kind, "cpu");
  assert.equal(setup.chooseGpu(null).kind, "cpu");
  assert.equal(setup.chooseGpu({ name: "old", driver: "516.94" }).kind, "cpu");
  assert.equal(setup.driverSupportsCuda("528.33"), true);
  assert.equal(setup.driverSupportsCuda("528.24"), false);
  assert.equal(setup.driverSupportsCuda("x"), false);
});

test("CUDA gets large-v3 in float16 from the cu128 build; the CPU gets small in int8", () => {
  assert.deepEqual([setup.PLANS.cuda.model, setup.PLANS.cuda.computeType, setup.PLANS.cuda.torchTag], ["large-v3", "float16", "+cu128"]);
  assert.equal(setup.PLANS.cuda.torchIndex, "https://download.pytorch.org/whl/cu128");
  assert.deepEqual([setup.PLANS.cpu.model, setup.PLANS.cpu.computeType], ["small", "int8"]);
  assert.equal(setup.PLANS.cuda.repo, "Systran/faster-whisper-large-v3");
  assert.equal(setup.PLANS.cpu.repo, "Systran/faster-whisper-small");
  // Both models are ones the bootstrap accepts in engine.json.
  for (const plan of Object.values(setup.PLANS)) {
    assert.ok(engine.validState({ setupVersion: engine.SETUP_VERSION, gpu: "cpu", model: plan.model, readyAt: new Date().toISOString() }));
  }
  assert.equal(setup.sameSpec(setup.venvSpec("cuda"), setup.venvSpec("cuda")), true);
  assert.equal(setup.sameSpec(setup.venvSpec("cuda"), setup.venvSpec("cpu")), false);
});

test("arguments: a version, a projects folder, and --cpu", () => {
  assert.deepEqual(setup.parseArgs(["--version", "0.4.0", "--projects-root", "D:\\Fabula", "--cpu"]), { version: "0.4.0", projectsRoot: "D:\\Fabula", cpu: true });
  assert.deepEqual(setup.parseArgs([]), { version: null, projectsRoot: null, cpu: false });
  assert.throws(() => setup.parseArgs(["--version", "../x"]), /version/);
  assert.throws(() => setup.parseArgs(["--wsl"]), /unknown option/);
});

test("the projects folder is a full path on a drive, Videos\\Fabula by default", () => {
  assert.equal(setup.defaultProjectsRoot({ USERPROFILE: "C:\\Users\\Jo" }), "C:\\Users\\Jo\\Videos\\Fabula");
  assert.equal(setup.validProjectsRoot("C:\\Users\\Jo\\Videos\\Fabula\\"), "C:\\Users\\Jo\\Videos\\Fabula");
  assert.throws(() => setup.validProjectsRoot("C:\\"), /top of a drive/);
  assert.throws(() => setup.validProjectsRoot("relative\\x"), /full path/);
  assert.throws(() => setup.validProjectsRoot("C:\\a|b"), /characters/);
});

test("sizes read as MB under a gigabyte and GB above", () => {
  assert.equal(setup.formatBytes(193109593), "193 MB");
  assert.equal(setup.formatBytes(7.6e9), "7.6 GB");
});
