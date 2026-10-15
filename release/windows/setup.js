"use strict";

// The setup screen: what this PC has, where the projects go, then the setup's own steps as they
// happen (scripts/setup-windows.mjs, through the bootstrap).
const $ = (id) => document.getElementById(id);
let ready = false;
let started = false;
let update = false;
let projectsFolder = "";
let currentStep = { n: 0, total: 1 };

const gb = (bytes) => `${Math.round(bytes / 1e9)} GB`;

function setCheck(id, tone, text) {
  const row = $(`check-${id}`);
  row.classList.remove("is-good", "is-bad", "is-busy", "is-warn");
  if (tone) row.classList.add(`is-${tone}`);
  $(`state-${id}`).textContent = text;
}

function say(text, tone) {
  const box = $("message");
  box.hidden = !text;
  box.textContent = text || "";
  box.className = `message${tone ? ` is-${tone}` : ""}`;
}

const plain = (error) => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

async function check() {
  say("");
  setCheck("gpu", "busy", "Checking…");
  setCheck("space", "busy", "Checking…");
  $("start").disabled = true;
  $("recheck").hidden = true;
  const answer = await window.fabulaSetup.check();
  update = answer.update;
  if (answer.gpu) setCheck("gpu", "good", `${answer.gpu.name}. Transcription runs on it.`);
  else setCheck("gpu", "warn", "No NVIDIA card. Transcription runs on the processor, which is slower.");
  if (answer.freeBytes === null) {
    setCheck("space", "", "Unknown");
  } else if (answer.freeBytes < answer.needBytes) {
    setCheck("space", "bad", `${gb(answer.freeBytes)} free, about ${gb(answer.needBytes)} needed`);
    say(`The drive with ${answer.home} needs about ${gb(answer.needBytes)} free. Make some room, then check again.`, "bad");
    $("recheck").hidden = false;
    return;
  } else {
    setCheck("space", "good", `${gb(answer.freeBytes)} free, about ${gb(answer.needBytes)} needed`);
  }
  ready = true;
  if (update) {
    // The engine was set up by an earlier version and this one needs a change to it. Most of it
    // is already there, so it starts by itself.
    $("title").textContent = `Updating Fabula's engine for ${answer.version}`;
    $("lede").textContent = "This version of Fabula needs a change to its engine. Most of it is already on this PC. Your projects and settings stay where they are.";
    $("downloads").hidden = true;
    start();
    return;
  }
  projectsFolder = projectsFolder || answer.suggestedProjects || "";
  $("projects-folder").textContent = projectsFolder;
  $("projects").hidden = false;
  $("start").disabled = false;
  if (new URLSearchParams(location.search).get("auto") === "1") start();
}

async function start() {
  if (started || !ready) return;
  started = true;
  $("start").disabled = true;
  $("recheck").hidden = true;
  $("progress").hidden = false;
  setCheck("engine", "busy", "Setting up");
  say("");
  $("projects").disabled = true;
  try {
    await window.fabulaSetup.start({ projects: update ? null : projectsFolder });
  } catch (error) {
    started = false;
    $("projects").disabled = false;
    $("start").disabled = false;
    $("progress").hidden = true;
    setCheck("engine", "", "Not set up");
    say(plain(error), "bad");
  }
}

$("projects-change").addEventListener("click", async (event) => {
  event.preventDefault();
  try {
    const folder = await window.fabulaSetup.chooseProjects(projectsFolder);
    if (!folder) return;
    projectsFolder = folder;
    $("projects-folder").textContent = folder;
    say("");
  } catch (error) {
    say(plain(error), "bad");
  }
});

function setBar(fraction) {
  $("fill").style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
}

window.fabulaSetup.onEvent((event) => {
  const log = $("log");
  if (event.type === "step") {
    currentStep = event;
    $("step").textContent = `${event.label} (${event.n} of ${event.total})`;
    $("detail").textContent = "";
    setBar((event.n - 1) / event.total);
    log.textContent += `\n== ${event.label}\n`;
  }
  if (event.type === "progress") {
    $("detail").textContent = event.text;
    setBar((currentStep.n - 1 + event.percent / 100) / currentStep.total);
  }
  if (event.type === "log") log.textContent += `${event.text}\n`;
  if (event.type === "step" || event.type === "log") log.scrollTop = log.scrollHeight;
  if (event.type === "done") {
    setBar(1);
    setCheck("engine", "good", "Ready");
    $("step").textContent = "Fabula is ready. Opening it…";
    $("detail").textContent = "";
    say("");
  }
  if (event.type === "failed") {
    started = false;
    $("projects").disabled = false;
    setCheck("engine", "bad", "Stopped");
    say(`${event.text} Setting up again picks up where it stopped.`, "bad");
    $("log-wrap").open = true;
    $("start").textContent = "Try again";
    $("start").disabled = false;
  }
});

$("start").addEventListener("click", start);
$("recheck").addEventListener("click", check);
check();
