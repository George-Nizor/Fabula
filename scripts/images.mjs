// Pictures for the film, from the open web into media/<project>/assets/:
// a page's own share image (og:image), a site's icon, a direct image URL,
// or a Wikimedia Commons search (logos and photos with licences, rasterised
// PNG thumbnails even for SVG). No keys, no paid services; the agent finds
// and chooses, these fetch and file.

import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawnSync } from "node:child_process";

// Node gives each address family a quarter second to connect before trying
// the next; Wikimedia's edge is further away than that from here. Give the
// fallback a real budget.
net.setDefaultAutoSelectFamilyAttemptTimeout(4000);

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36 Fabula/0.2";
const MAX_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 30000;

const EXT_BY_TYPE = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico", "image/svg+xml": "svg" };

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "image";
}

async function get(url, accept = "*/*") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: { "User-Agent": UA, Accept: accept }, redirect: "follow", signal: controller.signal });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

// The share image a page declares, or its largest declared icon.
export function pageImageUrl(html, baseUrl) {
  const meta = (name) => {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']+)["']`, "i");
    const alt = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${name}["']`, "i");
    return (re.exec(html) ?? alt.exec(html))?.[1] ?? null;
  };
  const candidate = meta("og:image") ?? meta("og:image:url") ?? meta("twitter:image") ?? meta("twitter:image:src");
  if (candidate) return new URL(candidate, baseUrl).href;
  let best = null;
  for (const match of html.matchAll(/<link[^>]+rel=["']([^"']+)["'][^>]*>/gi)) {
    const rel = match[1].toLowerCase();
    if (!/icon|image_src/.test(rel)) continue;
    const href = /href=["']([^"']+)["']/i.exec(match[0])?.[1];
    if (!href) continue;
    const sizes = /sizes=["'](\d+)x\d+["']/i.exec(match[0]);
    const size = sizes ? Number(sizes[1]) : (rel.includes("apple") ? 180 : rel.includes("image_src") ? 400 : 32);
    if (!best || size > best.size) best = { href: new URL(href, baseUrl).href, size };
  }
  return best?.href ?? null;
}

// A name the assets folder does not already hold: a second fetch of the
// same slug must not overwrite the first picture and its credit.
function freePath(dir, base, ext) {
  let file = path.join(dir, `${base}.${ext}`);
  for (let n = 2; fs.existsSync(file); n += 1) file = path.join(dir, `${base}-${n}.${ext}`);
  return file;
}

// ico and gif become png (the first frame) so the stage and the export
// treat every asset the same way; png, jpg and webp keep their container.
const RASTERISE = new Set(["ico", "gif"]);
function normalise(file, ext, ffmpeg) {
  if (!RASTERISE.has(ext)) return file;
  const png = freePath(path.dirname(file), path.basename(file, `.${ext}`), "png");
  const result = spawnSync(ffmpeg, ["-y", "-v", "error", "-i", file, "-frames:v", "1", png], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`could not convert the ${ext}: ${result.stderr.slice(-300)}`);
  fs.rmSync(file, { force: true });
  return png;
}

// Fetches one picture into assetsDir. `kind`: auto (an image URL is saved,
// a page's share image is found), page (always the share image), icon
// (the site's icon at 256 px through Google's favicon service). Returns
// the project-relative path and what was fetched.
export async function fetchImage({ url, name, kind = "auto", attribution, assetsDir, ffmpeg }) {
  fs.mkdirSync(assetsDir, { recursive: true });
  let target = url;
  let via = "direct";
  if (kind === "icon") {
    const host = new URL(url.startsWith("http") ? url : `https://${url}`).hostname;
    target = `https://www.google.com/s2/favicons?domain=${host}&sz=256`;
    via = `icon of ${host}`;
  }
  let response = await get(target, "image/*,text/html;q=0.9,*/*;q=0.5");
  let type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (kind !== "icon" && (kind === "page" || !type.startsWith("image/"))) {
    if (!type.includes("html")) throw new Error(`${url} is ${type || "unknown"}, not an image or a page`);
    const html = (await response.text()).slice(0, 2_000_000);
    const found = pageImageUrl(html, response.url ?? url);
    if (!found) throw new Error(`${url} declares no share image or icon`);
    via = `share image of ${url}`;
    response = await get(found, "image/*");
    type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    target = found;
  }
  const ext = EXT_BY_TYPE[type];
  if (!ext) throw new Error(`${target} is ${type || "unknown"}; png, jpg, webp, gif, ico and svg are accepted`);
  if (ext === "svg") throw new Error(`${target} is an SVG; search_images gives rasterised PNGs for Commons files, or ask for the site's icon`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) throw new Error(`${target} is ${(length / 1e6).toFixed(0)} MB; the limit is 25 MB`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new Error("image exceeds 25 MB");
  const base = slug(name ?? path.basename(new URL(target).pathname).replace(/\.[a-z0-9]+$/i, "") ?? "image");
  let file = freePath(assetsDir, base, ext);
  fs.writeFileSync(file, bytes);
  file = normalise(file, ext, ffmpeg);
  // A picture found through a page is credited to the page, unless the
  // caller named one.
  const metadata = { source: target, requestedUrl: url, ...(via ? { pageUrl: url } : {}), ...(attribution ?? {}) };
  fs.writeFileSync(`${file}.source.json`, JSON.stringify(metadata, null, 2) + "\n");
  return { attribution: metadata, file, src: `assets/${path.basename(file)}`, bytes: fs.statSync(file).size, via, source: target, type };
}

// Wikimedia Commons file search: titles, licences, and PNG thumbnails at
// `width` (SVGs come back rasterised). The agent reads the list, looks at a
// thumbnail if it must, and fetch_images the thumbUrl it wants.
export async function searchCommons({ query, count = 6, width = 1024 }) {
  const params = new URLSearchParams({
    action: "query", generator: "search", gsrsearch: query, gsrnamespace: "6", gsrlimit: String(Math.min(count, 20)),
    prop: "imageinfo", iiprop: "url|size|mime|extmetadata", iiurlwidth: String(width), format: "json",
  });
  const response = await get(`https://commons.wikimedia.org/w/api.php?${params}`, "application/json");
  const data = await response.json();
  const pages = Object.values(data.query?.pages ?? {});
  return pages
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((page) => {
      const info = page.imageinfo?.[0];
      if (!info || !/^image\/(png|jpeg|svg\+xml|webp|gif)$/.test(info.mime)) return null;
      const meta = info.extmetadata ?? {};
      const clean = (html) => (html ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      return {
        title: page.title.replace(/^File:/, ""),
        thumbUrl: (info.thumburl ?? info.url).replace(/\?utm_source=.*$/, ""),
        pageUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title)}`,
        width: info.width, height: info.height, mime: info.mime,
        license: clean(meta.LicenseShortName?.value) || null,
        author: clean(meta.Artist?.value).slice(0, 80) || null,
        description: clean(meta.ImageDescription?.value).slice(0, 140) || null,
      };
    })
    .filter(Boolean)
    .slice(0, count);
}

export function listAssets(assetsDir) {
  if (!fs.existsSync(assetsDir)) return [];
  return fs.readdirSync(assetsDir)
    .filter((name) => /\.(png|jpe?g|webp|gif)$/i.test(name))
    .map((name) => {
      const sourceFile = path.join(assetsDir, `${name}.source.json`);
      let attribution = null;
      try { attribution = JSON.parse(fs.readFileSync(sourceFile, "utf8")); } catch {}
      return { src: `assets/${name}`, bytes: fs.statSync(path.join(assetsDir, name)).size, attribution };
    });
}
