"use strict";

// The window's theme, set before the first paint so nothing flashes. Loaded synchronously from
// <head>, ahead of the stylesheets' first use. System follows the operating system (the CSS is
// written with light-dark()); Light and Dark pin one with data-theme. The choice is the person's
// and persists here; the main process is told so the title-bar overlay, the window's own
// background and native dialogs follow it too.
(() => {
  const KEY = "fabula.theme";
  const CHOICES = ["system", "light", "dark"];
  const root = document.documentElement;
  const read = () => {
    try { const value = localStorage.getItem(KEY); return CHOICES.includes(value) ? value : "system"; }
    catch { return "system"; }
  };
  const apply = (choice) => {
    if (choice === "system") delete root.dataset.theme;
    else root.dataset.theme = choice;
  };
  let choice = read();
  apply(choice);
  // Whichever theme is showing now, for code that needs to know (the terminal, the harness).
  const showing = () => (choice === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : choice);
  window.FabulaChrome = {
    choices: CHOICES,
    get theme() { return choice; },
    showing,
    setTheme(next) {
      if (!CHOICES.includes(next)) return choice;
      choice = next;
      try { localStorage.setItem(KEY, next); } catch { /* a preference, not worth an error */ }
      apply(next);
      try { window.fabula?.setChromeTheme?.(next)?.catch?.(() => {}); } catch { /* no bridge in a plain browser */ }
      window.dispatchEvent(new CustomEvent("fabula-theme", { detail: { choice: next, showing: showing() } }));
      return next;
    },
  };
  // The main process may have started on a stale guess (a first run, a cleared profile): agree.
  try { window.fabula?.setChromeTheme?.(choice)?.catch?.(() => {}); } catch { /* as above */ }
})();
