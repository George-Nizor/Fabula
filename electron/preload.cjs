"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// The bridge grows named operations only, mirroring the suite's preload
// discipline: no generic invoke pass-through, no node objects across the line.
contextBridge.exposeInMainWorld("fabula", {
  version: "0.1.0",
  getReview: () => ipcRenderer.invoke("fabula:get-review"),
  setCut: (index, enabled) => ipcRenderer.invoke("fabula:set-cut", index, enabled),
  onReview: (callback) => {
    ipcRenderer.on("fabula:review", (_event, review) => callback(review));
  },
});
