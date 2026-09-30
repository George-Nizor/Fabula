"use strict";

// The setup screen's whole reach: check WSL, start the setup, hear how it goes, and open the page
// on installing WSL. Nothing else of Electron or Node.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fabulaSetup", {
  check: () => ipcRenderer.invoke("fabula-setup:check"),
  start: (target) => ipcRenderer.invoke("fabula-setup:start", target),
  learn: () => ipcRenderer.invoke("fabula-setup:learn"),
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("fabula-setup:event", listener);
    return () => ipcRenderer.removeListener("fabula-setup:event", listener);
  },
});
