"use strict";

// The setup screen: what WSL says, then the engine setup's own steps as they happen.
const $ = (id) => document.getElementById(id);
let target = null;
let started = false;
let projectsFolder = "";

function setCheck(id, tone, text) {
  const row = $(`check-${id}`);
  row.classList.remove("is-good", "is-bad", "is-busy");
  if (tone) row.classList.add(`is-${tone}`);
  $(`state-${id}`).textContent = text;
}

function say(text, tone) {
  const box = $("message");
  box.hidden = !text;
  box.textContent = text || "";
  box.className = `message${tone ? ` is-${tone}` : ""}`;
}

async function check() {
  say("");
  setCheck("wsl", "busy", "Checking…");
  setCheck("distro", "", "—");
  setCheck("engine", "", "—");
  $("start").disabled = true;
  $("learn").hidden = true;
  $("recheck").hidden = true;
  const answer = await window.fabulaSetup.check();
  if (!answer.ok) {
    setCheck("wsl", "bad", "Not ready");
    say(answer.reason, "bad");
    $("learn").hidden = false;
    $("recheck").hidden = false;
    return;
  }
  target = { distro: answer.distro, home: answer.home };
  setCheck("wsl", "good", "Installed");
  setCheck("distro", "good", answer.distro);
  if (answer.update) {
    // The big downloads happened the first time; an update is the new version's code and its
    // packages, a minute or two. It starts by itself.
    $("title").textContent = `Updating Fabula to ${answer.version}`;
    $("lede").textContent = "The engine in WSL is already set up. This version's code and packages go in beside it; your projects and settings carry over.";
    setCheck("engine", "busy", `Updating to ${answer.version}`);
    start();
  } else {
    setCheck("engine", "", "To set up");
    // A first setup asks where the projects go; an update leaves them where they are.
    projectsFolder = projectsFolder || answer.suggestedProjects || "";
    $("projects-folder").textContent = projectsFolder;
    $("projects").hidden = false;
    $("start").disabled = false;
    if (new URLSearchParams(location.search).get("auto") === "1") start();
  }
}

async function start() {
  if (started || !target) return;
  started = true;
  $("start").disabled = true;
  $("recheck").hidden = true;
  $("progress").hidden = false;
  setCheck("engine", "busy", "Setting up");
  say("");
  const kind = document.querySelector('input[name="projects"]:checked')?.value || "wsl";
  const projects = $("projects").hidden ? null : { kind, folder: kind === "windows" ? projectsFolder : "" };
  $("projects").disabled = true;
  try {
    await window.fabulaSetup.start({ ...target, projects });
  } catch (error) {
    started = false;
    $("projects").disabled = false;
    $("start").disabled = false;
    $("progress").hidden = true;
    setCheck("engine", "", "To set up");
    say(error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), "bad");
  }
}

$("projects-change").addEventListener("click", async (event) => {
  event.preventDefault();
  try {
    const folder = await window.fabulaSetup.chooseProjects(projectsFolder);
    if (!folder) return;
    projectsFolder = folder;
    $("projects-folder").textContent = folder;
    document.querySelector('input[name="projects"][value="windows"]').checked = true;
    say("");
  } catch (error) {
    say(error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), "bad");
  }
});

window.fabulaSetup.onEvent((event) => {
  const log = $("log");
  if (event.type === "step") {
    $("step").textContent = `${event.label} (${event.n} of ${event.total})`;
    $("fill").style.width = `${Math.round(((event.n - 1) / event.total) * 100)}%`;
  }
  if (event.type === "step" || event.type === "log") {
    log.textContent += `${event.type === "step" ? `\n== ${event.label}` : event.text}\n`;
    log.scrollTop = log.scrollHeight;
  }
  if (event.type === "done") {
    $("fill").style.width = "100%";
    setCheck("engine", "good", "Ready");
    $("step").textContent = "Fabula is ready. Opening it…";
    say("");
  }
  if (event.type === "failed") {
    started = false;
    $("projects").disabled = false;
    setCheck("engine", "bad", "Stopped");
    say(event.text, "bad");
    $("log-wrap").open = true;
    $("start").textContent = "Try again";
    $("start").disabled = false;
  }
});

$("start").addEventListener("click", start);
$("recheck").addEventListener("click", check);
$("learn").addEventListener("click", () => window.fabulaSetup.learn());
check();
