// Where music and sound effects come from when the person has neither.
//
// Openverse indexes CC-licensed audio from Freesound, Jamendo and others and
// needs no key, which is the whole reason it is here: nothing in Fabula may
// require an account or a card. The search returns direct media URLs, so the
// same two-step the pictures use applies — read the list, fetch the one you
// want into assets/, and the credit travels beside the file.
//
// Only cc0 and by come back by default. A person may monetise the film they
// make here, and NC forbids that; ND forbids the derivative work a soundtrack
// arguably is. Widening that is the caller's explicit choice, not a default.

import fs from "node:fs";
import path from "node:path";

const API = "https://api.openverse.org/v1/audio/";
export const SAFE_LICENSES = "cc0,by";
export const MAX_AUDIO_BYTES = 30_000_000;
// What separates a bed from a hit, when the index's own category is empty
// more often than not.
export const EFFECT_MAX_SECONDS = 12;
export const MUSIC_MIN_SECONDS = 30;
// All the index gives a request with no key; asking for more is a 401.
export const ANONYMOUS_PAGE_SIZE = 20;

const EXT_BY_TYPE = {
  "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav",
  "audio/ogg": "ogg", "audio/flac": "flac", "audio/x-flac": "flac",
  "audio/mp4": "m4a", "audio/aac": "aac", "audio/opus": "opus", "audio/webm": "opus",
};

const slug = (text) => String(text ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "audio";

function freePath(dir, base, ext) {
  let file = path.join(dir, `${base}.${ext}`);
  let n = 2;
  while (fs.existsSync(file)) file = path.join(dir, `${base}-${n++}.${ext}`);
  return file;
}

async function get(url, accept) {
  const response = await fetch(url, { headers: { accept, "user-agent": "Fabula/0.1 (local video editor)" }, redirect: "follow" });
  if (response.status === 429) throw new Error("the free audio index is rate-limiting this machine; wait a minute and search again");
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response;
}

// A search of the free audio index. `kind` is a duration rule rather than the
// index's category, which is empty on most Freesound rows: a bed runs for
// half a minute or more, a hit is over in a few seconds.
export async function searchAudio({ query, count = 8, kind = "any", minSeconds, maxSeconds, license = SAFE_LICENSES } = {}) {
  if (!query || typeof query !== "string") throw new Error("search_audio needs something to look for");
  const floor = minSeconds ?? (kind === "music" ? MUSIC_MIN_SECONDS : null);
  const ceiling = maxSeconds ?? (kind === "effect" ? EFFECT_MAX_SECONDS : null);
  const params = new URLSearchParams({
    q: query,
    // Ask for more than is wanted, because the duration rule below throws
    // some away — but no more than 20, which is all an anonymous request may
    // have. Asking for 21 is a 401, not a smaller page.
    page_size: String(Math.min(Math.max(count * 4, 10), ANONYMOUS_PAGE_SIZE)),
    license,
    mature: "false",
  });
  const response = await get(`${API}?${params}`, "application/json");
  const data = await response.json();
  return (data.results ?? [])
    .map((row) => ({
      title: row.title ?? "untitled",
      url: row.url,
      pageUrl: row.foreign_landing_url ?? null,
      author: row.creator ?? null,
      license: [row.license, row.license_version].filter(Boolean).join(" ").toUpperCase() || null,
      seconds: typeof row.duration === "number" ? Number((row.duration / 1000).toFixed(2)) : null,
      filetype: row.filetype ?? null,
      provider: row.provider ?? null,
      tags: (row.tags ?? []).map((t) => t.name).filter(Boolean).slice(0, 8),
    }))
    .filter((row) => row.url && (!floor || (row.seconds ?? 0) >= floor) && (!ceiling || (row.seconds ?? 1e9) <= ceiling))
    .slice(0, count);
}

// Into the project's assets/, with the credit beside it. The licence and the
// page are written whether or not the licence demands them: export_description
// reads the same file for every asset, and a credit nobody needed costs a line.
export async function fetchAudio({ url, name, attribution, assetsDir } = {}) {
  if (!url || !/^https?:\/\//i.test(url)) throw new Error("fetch an audio file by http(s) URL");
  fs.mkdirSync(assetsDir, { recursive: true });
  const response = await get(url, "audio/*;q=0.9,*/*;q=0.5");
  const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const ext = EXT_BY_TYPE[type] ?? (/\.(mp3|wav|ogg|flac|m4a|aac|opus)(\?|$)/i.exec(url)?.[1] ?? "").toLowerCase();
  if (!ext) throw new Error(`${url} is ${type || "unknown"}; mp3, wav, ogg, flac, m4a, aac and opus are accepted`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_AUDIO_BYTES) throw new Error(`${url} is ${(declared / 1e6).toFixed(0)} MB; the limit is 30 MB`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_AUDIO_BYTES) throw new Error("the file exceeds 30 MB");
  const base = slug(name ?? path.basename(new URL(url).pathname).replace(/\.[a-z0-9]+$/i, ""));
  const file = freePath(assetsDir, base, ext);
  fs.writeFileSync(file, bytes);
  const metadata = { source: url, requestedUrl: url, ...(attribution ?? {}) };
  fs.writeFileSync(`${file}.source.json`, JSON.stringify(metadata, null, 2) + "\n");
  return { attribution: metadata, file, src: `assets/${path.basename(file)}`, bytes: bytes.length, type: type || `audio/${ext}` };
}
