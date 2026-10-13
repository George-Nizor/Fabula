// Saved brand themes: a theme config (preset plus overrides) kept under
// media/themes/<id>.json so every video of a channel can start from the
// same look. Shared by the MCP server and the app.

import fs from "node:fs";
import path from "node:path";

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const themesDir = (mediaRoot) => path.join(mediaRoot, "themes");

export function slugifyThemeId(name) {
  const id = String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  if (!ID_RE.test(id)) throw new Error("a theme name needs at least one letter or digit");
  return id;
}

export function listSavedThemes(mediaRoot) {
  const dir = themesDir(mediaRoot);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      try {
        const saved = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
        return { id: name.replace(/\.json$/, ""), name: saved.name ?? name.replace(/\.json$/, ""), theme: saved.theme ?? {}, savedAt: saved.savedAt ?? null };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function saveTheme(mediaRoot, name, theme) {
  const id = slugifyThemeId(name);
  fs.mkdirSync(themesDir(mediaRoot), { recursive: true });
  const record = { name: String(name).trim(), theme, savedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(themesDir(mediaRoot), `${id}.json`), JSON.stringify(record, null, 2));
  return { id, ...record };
}

export function loadTheme(mediaRoot, id) {
  const file = path.join(themesDir(mediaRoot), `${slugifyThemeId(id)}.json`);
  if (!fs.existsSync(file)) throw new Error(`no saved theme "${id}"; list_themes shows what exists`);
  return JSON.parse(fs.readFileSync(file, "utf8")).theme ?? {};
}

const themeFile = (mediaRoot, id) => path.join(themesDir(mediaRoot), `${slugifyThemeId(id)}.json`);

// A brand's look replaced by the project's, under the same id and name, so
// every project using it can pick the change up.
export function updateTheme(mediaRoot, id, theme) {
  const file = themeFile(mediaRoot, id);
  if (!fs.existsSync(file)) throw new Error(`no saved theme "${id}"`);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  const record = { ...saved, theme, savedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  return { id: slugifyThemeId(id), ...record };
}

// A new name for a brand. Its id (the file) stays, so projects that use it
// keep pointing at it.
export function renameTheme(mediaRoot, id, name) {
  const file = themeFile(mediaRoot, id);
  if (!fs.existsSync(file)) throw new Error(`no saved theme "${id}"`);
  const clean = String(name ?? "").trim().slice(0, 60);
  if (!clean) throw new Error("a brand needs a name");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...saved, name: clean }, null, 2));
  return { id: slugifyThemeId(id), name: clean };
}

export function deleteTheme(mediaRoot, id) {
  const file = themeFile(mediaRoot, id);
  if (!fs.existsSync(file)) throw new Error(`no saved theme "${id}"`);
  fs.rmSync(file);
}

// Whether a project's look is still exactly its brand's: the theme as
// written (preset and overrides), the project's own logo aside.
export function sameLook(a, b) {
  const plain = (theme) => {
    const { logo, ...rest } = theme ?? {};
    const sort = (value) => Array.isArray(value) ? value.map(sort)
      : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, sort(value[k])]))
      : value;
    return JSON.stringify(sort(rest));
  };
  return plain(a) === plain(b);
}
