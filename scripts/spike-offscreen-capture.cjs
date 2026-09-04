"use strict";

// Proves Fabula's export mechanism on this machine: step a time-driven
// composition in an offscreen window, capture every frame, mux with the
// bundled ffmpeg. Prints capture throughput. Run with:
//
//   LD_LIBRARY_PATH=tools/wsl-libs/usr/lib/x86_64-linux-gnu \
//     npx electron scripts/spike-offscreen-capture.cjs
//
// Output: media/spike/out.mp4 — a 2s clip whose every frame must show its own
// timestamp and a bar that sweeps left to right. If frames repeat or the bar
// stutters, stepped capture is broken and the finding matters more than the mp4.

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-gpu");
if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  app.commandLine.appendSwitch("ozone-platform", "headless");
}

const FPS = 30;
const DURATION_SECONDS = 1;
const WIDTH = 1280;
const HEIGHT = 720;
const OUT_DIR = path.join(__dirname, "..", "media", "spike");
const FFMPEG = path.join(__dirname, "..", "tools", "ffmpeg", "ffmpeg");

const PAGE = `<!DOCTYPE html>
<html><head><style>
  body { margin: 0; background: #12171e; }
  canvas { display: block; }
</style></head><body>
<canvas id="c" width="${WIDTH}" height="${HEIGHT}"></canvas>
<script>
  const ctx = document.getElementById("c").getContext("2d");
  // The runtime contract in miniature: every frame is a pure function of t.
  window.renderFrame = (t) => {
    ctx.fillStyle = "#12171e";
    ctx.fillRect(0, 0, ${WIDTH}, ${HEIGHT});
    const x = (t / ${DURATION_SECONDS}) * (${WIDTH} - 160);
    ctx.fillStyle = "#e0b34c";
    ctx.beginPath();
    ctx.roundRect(x, ${HEIGHT} / 2 - 40, 160, 80, 16);
    ctx.fill();
    ctx.fillStyle = "#f0ede6";
    ctx.font = "48px sans-serif";
    ctx.fillText("t = " + t.toFixed(3) + "s", 40, 80);
    return true;
  };
</script></body></html>`;

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const pagePath = path.join(OUT_DIR, "page.html");
  fs.writeFileSync(pagePath, PAGE);

  const window = new BrowserWindow({
    show: false,
    width: WIDTH,
    height: HEIGHT,
    webPreferences: { offscreen: true, sandbox: true, backgroundThrottling: false },
  });
  window.webContents.setFrameRate(FPS);
  // Chromium bootstrap on this WSL2 host intermittently fails shared-memory
  // creation (ESRCH), which strands the load. Distinct exit code so a wrapper
  // can retry instead of hanging.
  const watchdog = setTimeout(() => {
    console.error("load watchdog fired: renderer never became ready");
    app.exit(2);
  }, 15000);
  try {
    await window.loadFile(pagePath);
  } catch (error) {
    console.error(`load failed fast: ${error.code || error}`);
    app.exit(3);
    return;
  }
  clearTimeout(watchdog);

  const contents = window.webContents;
  if (!contents.isPainting()) contents.startPainting();

  // Capture through CDP: Page.captureScreenshot composites on demand, which
  // sidesteps the offscreen paint-event throttling (~1 fps) and the stalls of
  // capturePage on offscreen windows.
  contents.debugger.attach("1.3");

  const frameCount = FPS * DURATION_SECONDS;
  const started = Date.now();
  for (let i = 0; i < frameCount; i += 1) {
    const t = i / FPS;
    await contents.executeJavaScript(`renderFrame(${t})`);
    const shot = await contents.debugger.sendCommand("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT_DIR, `frame-${String(i).padStart(4, "0")}.png`), Buffer.from(shot.data, "base64"));
  }
  const seconds = (Date.now() - started) / 1000;
  console.log(`captured ${frameCount} frames at ${WIDTH}x${HEIGHT} in ${seconds.toFixed(1)}s (${(frameCount / seconds).toFixed(1)} fps)`);

  const mux = spawnSync(FFMPEG, [
    "-y", "-framerate", String(FPS),
    "-i", path.join(OUT_DIR, "frame-%04d.png"),
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    path.join(OUT_DIR, "out.mp4"),
  ], { encoding: "utf8" });
  if (mux.status !== 0) {
    console.error(mux.stderr.slice(-800));
    throw new Error("ffmpeg mux failed");
  }
  console.log(`wrote ${path.join(OUT_DIR, "out.mp4")}`);
  app.quit();
}

app.whenReady().then(() =>
  main().catch((error) => {
    console.error(error);
    app.exit(1);
  }),
);
