"use strict";

const dropzone = document.getElementById("dropzone");

dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("is-hot");
});

dropzone.addEventListener("dragleave", () => dropzone.classList.remove("is-hot"));

dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("is-hot");
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  dropzone.querySelector("p").textContent = `${file.name} — ingest lands in slice 1.`;
});
