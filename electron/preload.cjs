"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// The bridge grows named operations only, mirroring the suite's preload
// discipline: no generic invoke pass-through, no node objects across the line.
contextBridge.exposeInMainWorld("fabula", {
  version: "0.1.0",
  getState: () => ipcRenderer.invoke("fabula:get-state"),
  setCut: (index, enabled) => ipcRenderer.invoke("fabula:set-cut", index, enabled),
  onState: (callback) => {
    ipcRenderer.on("fabula:state", (_event, state) => callback(state));
  },
});
