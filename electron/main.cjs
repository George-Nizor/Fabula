"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, session, ipcMain } = require("electron");

const MEDIA_ROOT = path.join(__dirname, "..", "media");
const POINTER = path.join(MEDIA_ROOT, "current-project.json");

// The review state is a file the MCP server rewrites; the window polls its
// mtime rather than using fs.watch because the app may run on Windows while
// the file lives on the WSL share, where change notifications do not travel.
function projectDir() {
  try {
    const pointer = JSON.parse(fs.readFileSync(POINTER, "utf8"));
    return path.join(MEDIA_ROOT, pointer.dir);
  } catch {
    return null;
  }
}

function reviewPath() {
  const dir = projectDir();
  return dir ? path.join(dir, "review.json") : null;
}

// The server records the video by its own (WSL) absolute path; resolve the
// staged file relative to this process instead, so the same review.json plays
// whether the app runs on Linux or from the Windows side of the share.
function stagedVideoUrl(dir) {
  try {
    const name = fs.readdirSync(dir).find((entry) => /^raw\.(mp4|mov|mkv|webm|m4v)$/i.test(entry));
    return name ? pathToFileURL(path.join(dir, name)).href : null;
  } catch {
    return null;
  }
}

function readReview() {
  const dir = projectDir();
  if (!dir) return null;
  try {
    const review = JSON.parse(fs.readFileSync(path.join(dir, "review.json"), "utf8"));
    review.videoUrl = stagedVideoUrl(dir);
    return review;
  } catch {
    return null; // absent, or mid-rewrite; the next tick settles it
  }
}

// The one write the window owns: flipping a cut. Everything else about the
// review file belongs to the MCP server; both sides reread before writing.
function setCutEnabled(index, enabled) {
  const file = reviewPath();
  if (!file) return null;
  const review = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!review.cuts[index]) return null;
  review.cuts[index].enabled = Boolean(enabled);
  fs.writeFileSync(file, JSON.stringify(review, null, 2));
  review.videoUrl = stagedVideoUrl(projectDir());
  return review;
}

function startReviewFeed(window) {
  let lastStamp = "";
  const tick = () => {
    if (window.isDestroyed()) return;
    const file = reviewPath();
    let stamp = "none";
    if (file) {
      try {
        const stat = fs.statSync(file);
        stamp = `${file}:${stat.mtimeMs}:${stat.size}`;
      } catch {
        stamp = `${file}:missing`;
      }
    }
    if (stamp !== lastStamp) {
      const review = readReview();
      if (review || stamp.endsWith(":missing") || stamp === "none") {
        lastStamp = stamp;
        window.webContents.send("fabula:review", review);
      }
    }
  };
  const timer = setInterval(tick, 500);
  window.on("closed", () => clearInterval(timer));
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#12171e",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.once("ready-to-show", () => window.show());
  window.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  startReviewFeed(window);
  return window;
}

app.whenReady().then(() => {
  // Local review tool: no permission has a reason to be granted, no external
  // navigation has a reason to happen.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
  });
  ipcMain.handle("fabula:get-review", () => readReview());
  ipcMain.handle("fabula:set-cut", (event, index, enabled) => {
    const review = setCutEnabled(index, enabled);
    if (review) event.sender.send("fabula:review", review);
    return review !== null;
  });
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
