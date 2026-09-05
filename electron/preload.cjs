"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { contextBridge, ipcRenderer, webUtils } = require("electron");

// The bridge grows named operations only, mirroring the suite's preload
// discipline: no generic invoke pass-through, no node objects across the line.
contextBridge.exposeInMainWorld("fabula", {
  version: "0.1.0",
  platform: process.platform,
  getState: () => ipcRenderer.invoke("fabula:get-state"),
  setCut: (index, enabled) => ipcRenderer.invoke("fabula:set-cut", index, enabled),
  updateScene: (index, patch) => ipcRenderer.invoke("fabula:update-scene", index, patch),
  setProject: (patch) => ipcRenderer.invoke("fabula:set-project", patch),
  pickAsset: () => ipcRenderer.invoke("fabula:pick-asset"),
  ingestFile: (file) => ipcRenderer.invoke("fabula:ingest", webUtils.getPathForFile(file)),
  pickFile: () => ipcRenderer.invoke("fabula:pick"),
  onState: (callback) => {
    ipcRenderer.on("fabula:state", (_event, state) => callback(state));
  },
});

// The stage engine crosses the bridge as plain functions over plain data, so
// the preview positions the head with the same math the export uses. Preload
// is CJS and core is ESM; the page guards on the global until this resolves.
import(pathToFileURL(path.join(__dirname, "..", "core", "stage-engine.mjs")).href)
  .then((engine) => {
    contextBridge.exposeInMainWorld("FabulaStageEngine", {
      layoutAt: (timeline, t, aspect, stage) => engine.layoutAt(timeline, t, aspect, stage),
    });
  })
  .catch((error) => console.error("stage engine bridge failed:", error));
