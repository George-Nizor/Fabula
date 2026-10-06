// Renders an HTML file to a PNG with Chromium's headless shell (Playwright's download), for the
// brand pictures: the icon contact sheet and the README banner. No browser library needed.
//
// The shell needs libnspr4, libnss3 and libasound2 (on WSL without sudo: apt-get download them,
// dpkg -x into a folder, and point FABULA_WSL_LIBS or LD_LIBRARY_PATH at its usr/lib/x86_64-linux-gnu;
// tools/wsl-libs is that folder when the checkout has one).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function findChromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const base = path.join(os.homedir(), ".cache", "ms-playwright");
  const dirs = fs.existsSync(base) ? fs.readdirSync(base).filter((n) => n.startsWith("chromium_headless_shell-")).sort().reverse() : [];
  for (const d of dirs) {
    const exe = path.join(base, d, "chrome-headless-shell-linux64", "chrome-headless-shell");
    if (fs.existsSync(exe)) return exe;
  }
  throw new Error("No chromium_headless_shell under ~/.cache/ms-playwright (npx playwright-core install chromium-headless-shell), or set CHROMIUM.");
}

export function shoot(htmlFile, pngFile, width, height) {
  const libs = process.env.FABULA_WSL_LIBS || path.join(ROOT, "tools", "wsl-libs", "usr", "lib", "x86_64-linux-gnu");
  const env = { ...process.env, LD_LIBRARY_PATH: [libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") };
  const result = spawnSync(findChromium(), [
    "--no-sandbox", "--hide-scrollbars", "--force-device-scale-factor=1", "--allow-file-access-from-files",
    "--virtual-time-budget=3000", `--window-size=${width},${height}`, `--screenshot=${path.resolve(pngFile)}`,
    `file://${path.resolve(htmlFile)}`,
  ], { env, encoding: "utf8" });
  if (result.status !== 0 || !fs.existsSync(pngFile)) throw new Error(`chromium failed (${result.status}): ${result.stderr}`);
  return pngFile;
}
