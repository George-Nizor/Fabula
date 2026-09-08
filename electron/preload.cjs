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
  assistantOptions: () => ipcRenderer.invoke("fabula:assistant-options"),
  assistantStatus: () => ipcRenderer.invoke("fabula:assistant-status"),
  assistantStart: (choice, size) => ipcRenderer.invoke("fabula:assistant-start", choice, size),
  assistantInput: (data) => ipcRenderer.invoke("fabula:assistant-input", data),
  assistantResize: (cols, rows) => ipcRenderer.invoke("fabula:assistant-resize", cols, rows),
  assistantStop: () => ipcRenderer.invoke("fabula:assistant-stop"),
  onAssistantData: (callback) => { ipcRenderer.on("fabula:assistant-data", (_event, data) => callback(data)); },
  onAssistantExit: (callback) => { ipcRenderer.on("fabula:assistant-exit", (_event, code) => callback(code)); },
  pathForFile: (file) => webUtils.getPathForFile(file),
  pickRecording: () => ipcRenderer.invoke("fabula:pick-recording"),
  createProject: (sourcePath, title, format) => ipcRenderer.invoke("fabula:create-project", sourcePath, title, format),
  renameProject: (name, title) => ipcRenderer.invoke("fabula:rename-project", name, title),
  suggestClips: (format) => ipcRenderer.invoke("fabula:suggest-clips", format),
  createShort: (clip) => ipcRenderer.invoke("fabula:create-short", clip),
  setCut: (index, enabled) => ipcRenderer.invoke("fabula:set-cut", index, enabled),
  addCut: (wordIds) => ipcRenderer.invoke("fabula:add-cut", wordIds),
  updateScene: (index, patch) => ipcRenderer.invoke("fabula:update-scene", index, patch),
  duplicateScene: (index) => ipcRenderer.invoke("fabula:duplicate-scene", index),
  removeScene: (index) => ipcRenderer.invoke("fabula:remove-scene", index),
  setProject: (patch) => ipcRenderer.invoke("fabula:set-project", patch),
  pickAsset: () => ipcRenderer.invoke("fabula:pick-asset"),
  chooseInsert: (insertId, optionId) => ipcRenderer.invoke("fabula:choose-insert", insertId, optionId),
  insertNote: (insertId, text) => ipcRenderer.invoke("fabula:insert-note", insertId, text),
  render: (kind, options) => ipcRenderer.invoke("fabula:render", kind, options ?? {}),
  reveal: (file) => ipcRenderer.invoke("fabula:reveal", file),
  openOutput: (file) => ipcRenderer.invoke("fabula:open-output", file),
  reanchor: () => ipcRenderer.invoke("fabula:reanchor"),
  ingestFile: (file) => ipcRenderer.invoke("fabula:ingest", webUtils.getPathForFile(file)),
  pickFile: () => ipcRenderer.invoke("fabula:pick"),
  listProjects: () => ipcRenderer.invoke("fabula:list-projects"),
  switchProject: (name) => ipcRenderer.invoke("fabula:switch-project", name),
  closeProject: () => ipcRenderer.invoke("fabula:close-project"),
  removeProject: (name) => ipcRenderer.invoke("fabula:remove-project", name),
  revealProject: (name) => ipcRenderer.invoke("fabula:reveal-project", name),
  chooseProjectsRoot: (useDefault) => ipcRenderer.invoke("fabula:choose-projects-root", Boolean(useDefault)),
  revealProjectsRoot: () => ipcRenderer.invoke("fabula:reveal-projects-root"),
  onProjectsRootProgress: (callback) => {
    ipcRenderer.on("fabula:projects-root-progress", (_event, text) => callback(text));
  },
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
      resolveLayoutTimeline: (scenes, duration, options) => engine.resolveLayoutTimeline(scenes, duration, options),
    });
  })
  .catch((error) => console.error("stage engine bridge failed:", error));
