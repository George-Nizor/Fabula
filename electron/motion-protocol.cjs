"use strict";

// fabula-motion: — the only door a motion scene's sandboxed frame has.
//
// A motion scene runs in <iframe sandbox="allow-scripts">: an opaque origin
// that cannot touch the window, its bridge or the disk, and that Chromium
// will not let load a single file:// resource ("Not allowed to load local
// resource"). So everything the frame needs comes over this scheme, and the
// scheme serves an allowlist and nothing else:
//
//   fabula-motion://runtime/<file>   the host page and runtime, the vendored
//                                    fonts and their stylesheet (renderer/)
//   fabula-motion://lib/<name>.js    an optional animation library, when it
//                                    is installed (core/motion.mjs MOTION_LIBS)
//   fabula-motion://project/<file>   the open project's motion/ documents and
//                                    assets/ — read-only, never above them
//
// Registered by every Electron that paints a stage: the window
// (electron/main.cjs), the film's render (scripts/export-compose.cjs) and
// the single frame (scripts/frame.cjs). The scheme must be declared before
// the app is ready; the handler is installed after.

const fs = require("node:fs");
const path = require("node:path");

const SCHEME = "fabula-motion";
const REPO_ROOT = path.join(__dirname, "..");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".m4v": "video/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
};

// What each host may serve, as patterns over the path under it.
const RUNTIME_FILES = /^(motion\/(host\.html|runtime\.js)|fonts\.css|assets\/fonts\/[a-z0-9-]+\.woff2)$/;
const PROJECT_FILES = /^(motion\/[a-z0-9][a-z0-9-]*\.(html|js|css|json|svg)|assets\/[^/\\]+\.(png|jpe?g|webp|gif|svg|woff2?|ttf|otf|mp4|webm|m4v|mp3|wav|ogg))$/i;
const LIBS = {
  gsap: "node_modules/gsap/dist/gsap.min.js",
};

// Which libraries are actually installed, for validation and describe_motion.
function installedMotionLibs(root = REPO_ROOT) {
  return Object.entries(LIBS).filter(([, file]) => fs.existsSync(path.join(root, file))).map(([name]) => name);
}

// The file a request names, or null when it names nothing it may have.
// Pure given the two roots, so it can be tested without Electron.
function resolveMotionRequest(url, { repoRoot = REPO_ROOT, projectDir = null } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== `${SCHEME}:`) return null;
  let rel;
  try { rel = decodeURIComponent(parsed.pathname).replace(/^\/+/, ""); } catch { return null; }
  if (rel.includes("\0") || rel.includes("\\") || rel.split("/").some((part) => part === ".." || part === ".")) return null;
  const within = (base, file) => {
    const target = path.resolve(base, file);
    return target.startsWith(path.resolve(base) + path.sep) ? target : null;
  };
  if (parsed.host === "runtime") {
    return RUNTIME_FILES.test(rel) ? within(path.join(repoRoot, "renderer"), rel) : null;
  }
  if (parsed.host === "lib") {
    const match = /^([a-z0-9-]+)\.js$/.exec(rel);
    return match && Object.hasOwn(LIBS, match[1]) ? within(repoRoot, LIBS[match[1]]) : null;
  }
  if (parsed.host === "project") {
    return projectDir && PROJECT_FILES.test(rel) ? within(projectDir, rel) : null;
  }
  return null;
}

// Before app.ready. Standard + secure so relative URLs, fetch() and fonts
// work inside the frame; CORS so an opaque origin may read what it is given.
function registerMotionScheme(protocol) {
  protocol.registerSchemesAsPrivileged([{
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  }]);
}

// After app.ready. projectDir is a function: the window's open project can
// change under it, and every request asks again.
function handleMotionProtocol(protocol, { projectDir = () => null, repoRoot = REPO_ROOT } = {}) {
  protocol.handle(SCHEME, async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("", { status: 405 });
    const file = resolveMotionRequest(request.url, { repoRoot, projectDir: projectDir() });
    if (!file) return new Response("", { status: 404, headers: { "access-control-allow-origin": "*" } });
    try {
      const body = await fs.promises.readFile(file);
      return new Response(request.method === "HEAD" ? null : body, {
        status: 200,
        headers: {
          "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    } catch {
      return new Response("", { status: 404, headers: { "access-control-allow-origin": "*" } });
    }
  });
}

// The frame is sealed in: its CSP stops every request it could make, the
// sandbox its popups and its reach into the window. Two ways out are not a
// CSP's to close — the frame navigating itself (location.href = "http://…"
// carries whatever it puts in the address) and WebRTC, which no CSP governs —
// so every page that hosts a motion frame closes them here. A subframe may
// only ever go to this scheme or about:, and WebRTC gets no UDP and no route
// off the machine that is not a proxy's. Called for each web contents, by
// every Electron that paints a stage.
function sealMotionFrames(contents) {
  contents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame) return;
    const url = String(event.url ?? "");
    if (url.startsWith(`${SCHEME}:`) || url.startsWith("about:")) return;
    event.preventDefault();
  });
  try { contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp"); } catch { /* the runtime's own guard still holds */ }
}

module.exports = { SCHEME, registerMotionScheme, handleMotionProtocol, resolveMotionRequest, installedMotionLibs, sealMotionFrames, MOTION_HOST_URL: `${SCHEME}://runtime/motion/host.html` };
