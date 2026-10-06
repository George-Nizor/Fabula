# Window screenshot harness

A visual check of the real Fabula window, not a unit test. `shoot.mjs` runs Electron headless in
Fabula's own snapshot mode (`FABULA_SNAPSHOT`, `FABULA_SNAPSHOT_SCRIPT` in `electron/main.cjs`):
the real window, the real IPC and the real painter, over a **copy** of three projects from
`media/` (small files copied, renders and chunks symlinked; nothing is written back, and the
owner's open project never moves). Nothing is mocked.

```bash
node test-tools/screenshots/shoot.mjs                      # dark and light, into test-tools/screenshots/shots/
node test-tools/screenshots/shoot.mjs --themes light --only cut,export
```

Screens, each as `<theme>-<name>.png`: `home`, `home-empty` (no projects at all),
`dialog-new-project`, `dialog-projects`, `cut`, `look`, `look-galleries`, `scenes`,
`scenes-inspector`, `export`, `dialog-assistant`, `dialog-rename`, `dialog-brand`, `dialog-brief`,
`focus` (two Tab presses into the masthead, so the ring is the keyboard's), `making` (the Making
panel of a film made with Make it into a video), `short-scenes` (a vertical short),
`empty-project` (a recording waiting for its first pass) and `dropzone`.

It also prints, per theme:

- `contrast <screen>`: every visible text run in the chrome against the first opaque background
  behind it (`contrast.js`; the stage, previews, overlays and terminal are content and skipped),
  with any under WCAG AA listed;
- `motion` and `motion, reduced`: the slate's clap animation name, then the same with
  `prefers-reduced-motion: reduce` emulated, where it must be `none`.

The projects it expects are `rockets-explained`, `rockets-made-into-a-video` and
`what-an-orbit-actually-is` under `media/` (`--media DIR` for another root); a missing one has its
screens skipped. The video frames need the recordings they reference to be reachable.

## Electron on WSL without sudo

Electron's Chromium needs `libnspr4`, `libnss3` and `libasound2t64`. Without root, fetch the
packages and unpack them into a folder of your own; `tools/wsl-libs` is that folder in this
checkout, and `FABULA_WSL_LIBS` points elsewhere:

```bash
mkdir -p tools/wsl-libs && cd tools/wsl-libs
apt-get download libnspr4 libnss3 libasound2t64
for f in *.deb; do dpkg -x "$f" .; done
```

The harness unsets `ELECTRON_RUN_AS_NODE`, which a Claude Code shell carries and which makes
Electron refuse its own flags.

The brand pictures (the icon contact sheet, the README banner) use Chromium's headless shell from
`~/.cache/ms-playwright` instead (`test-tools/brand/`), with the same libraries.
