"use strict";

// The setup screen's whole reach: check this PC, choose where the projects go, start the setup and
// hear how it goes. Nothing else of Electron or Node.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fabulaSetup", {
  check: () => ipcRenderer.invoke("fabula-setup:check"),
  start: (choice) => ipcRenderer.invoke("fabula-setup:start", choice),
  chooseProjects: (current) => ipcRenderer.invoke("fabula-setup:choose-projects", current),
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("fabula-setup:event", listener);
    return () => ipcRenderer.removeListener("fabula-setup:event", listener);
  },
});
