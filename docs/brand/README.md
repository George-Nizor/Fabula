# Brand v2 in Fabula

Aligned 2026-10-06/07 against Instrumenta `brand/` at commit `54268fc` (`brand/ALIGNMENT.md`).
Instrumenta is the source; nothing copied here is edited by hand. To refresh, regenerate in
Instrumenta (`uv run brand/scripts/build-brand.py`) and copy again; `test/brand.test.mjs` fails
when a copied file no longer matches the Instrumenta checkout beside this one.

## What is chrome and what is content

Fabula has two kinds of type and colour, and the brand only touches one of them.

- **Chrome** is the window a person operates: the masthead, the four steps, the transcript rail,
  the inspector and its Making panel, the timeline dock, the Look and Export pages around their
  cards, the sheets, the assistant pane's head, the Windows setup window. All of it is brand v2.
- **Content** is what ends up in a film, or stands in for it: the look system (presets, brands,
  colours, the faces a film is set in, title, callout and caption styles, transitions, punch-ins:
  `core/themes.mjs`, `renderer/fonts.css`, `renderer/assets/fonts/`), the painter
  (`renderer/overlays.css`, `overlays.js`, the export page, motion scenes), the stage field and
  the footage, the draft player, the Look cards' previews and their footage stand-in, waveforms
  and media. None of it changed. The stage is an object in the chrome (outlined, extruded) but
  what is inside it is the film's.

## Copied

| From Instrumenta `brand/` | To | Used for |
| --- | --- | --- |
| `fonts/*.woff2`, `fonts/fonts.css`, `fonts/OFL-*.txt` | `renderer/brand/fonts/` | The window's type. `fonts.css` is kept as copied but not loaded: see "Type". The release bundle carries the woff2 and licences for the setup window (`scripts/package-release.mjs`). |
| `icons/instrumenta-icons.js`, `icons/instrumenta-icons.css` | `renderer/brand/` | `InstrumentaIcons.render('fabula')`: the slate in the masthead, the empty states and the Making panel, with its clap. |
| `icons/svg/fabula{,-24,-16}.svg` | `renderer/brand/` | the page's favicon and reference |
| `icons/svg/fabula{,-24,-16,-animated}.svg`, `icons/png/fabula-{16..512}.png`, `icons/ico/fabula.ico` | `brand/` | the window icon (`fabula.ico` on Windows, `fabula-256.png` elsewhere), the release bundle's setup window and taskbar icon |
| `artwork/fabula-app-art.png` | `brand/fabula-app-art.png` | launcher art; `instrumenta/product.json` `assets.mark` points at it |
| `icons/svg/fabula-animated.svg` | `docs/brand/` | the README |
| `tokens.json` | `brand/tokens.json` | the record; the `fabula` and `family` blocks are written into `renderer/styles.css` `:root` |

The v1 mark (the magenta blades carried over from Motus, `brand/fabula-mark-*.png`,
`renderer/assets/fabula-mark.png`) and its renderer (`scripts/render-brand-mark.py`) are gone.

`docs/images/fabula-banner.png` (1600×500) was made with Instrumenta's own
`brand/scripts/build-readme-banner.mjs`, so it matches the other seven.

## Colour and themes

Every colour is a token on `:root` in `renderer/styles.css`, written once with `light-dark()`;
`test/chrome-style.test.mjs` fails on a colour literal anywhere else in that file.

- **Dark** (the brand's first) sits on the `family` neutrals: `#141210` masthead and dock,
  `#1d1a17` panels, `#0d0c0a` the well behind the stage, `#352f29` lines, `#f2ede6` text and
  `#a39a90` secondary text. **Light** is derived from them: warm paper `#faf7f2` bars, white panels,
  `#ece6dc` well (Forge3D's values, so the two apps match).
- **System, Light, Dark**: the window follows the operating system until the person picks one with
  the masthead toggle (sun, moon, screen). `renderer/theme-boot.js` reads the choice and sets
  `data-theme` in `<head>`, before first paint, so nothing flashes. The main process keeps a copy
  (`userData/theme.json`) and sets `nativeTheme`, the window background and the Windows
  title-bar overlay from it, and repaints them when the system changes.
- **Coral** `#ED7088` (`fabula.accent`): primary buttons, the open step's edge, the playhead,
  selection, the play button, chips. As text, ring or icon it is `--accent-text`: the deep shade
  `#7D2E3F` on light (8.4:1), coral itself on dark (6.0:1). Coral fills carry coral ink `#230F12`
  (6.3:1), with a `#7D2E3F` extrusion. Tints (`#fbe1e5` light, `#3d232a` dark) carry ordinary ink.
- **Meaning colours**, per theme: brick for what is cut and for destructive actions (`#a14206` /
  `#f28c5c`; the suite's rose would sit on top of Fabula's coral), teal for the screen track,
  green for done, gold for a find match.
- The terminal pane stays dark in both themes: what the assistant prints assumes a dark ground.
  Its head follows the window; its own colours are the family surface and text, coral cursor.
- No body text under 4.5:1: the screenshot harness checks every visible text run in the chrome
  (`test-tools/screenshots/contrast.js`), and on the last run none failed in either theme.

## Depth

Opaque objects with a 2px ink outline (`--outline`) and a hard extrusion down and to the right
(`--obj-shadow`, 3px 4px). Buttons are Discere's: they sink into their own edge when pressed. The
stage frame, sheets, the projects list, the Export cards, the Making panel and the step tabs are
objects; panels are flat surfaces separated by 2px rules. There is no frosted glass (the Live/Draft
switch lost its blur), no glow (the playhead, the hero button), no gradient (the Assistant button,
Make it into a video, the setup progress bar) and no looping motion in the chrome (the pulsing job
dot, the pulsing assistant mark, the export spinner and the Making panel's pulsing phase are now
still icons; the ticking clock beside them is what shows a job is alive).

## Type

| Role | Face | Where |
| --- | --- | --- |
| Display | Fraunces 650, `"SOFT" 100, "WONK" 1` | the wordmark, page titles (Look, Export, Projects), sheet titles, the Making panel's title, Export card titles, the inspector's title, empty-state headlines, the drop zone |
| Interface | Commissioner, `"FLAR" 40` | everything operated, sentence case, the transcript included (it was Source Serif) |
| Code | Spline Sans Mono | timecodes, durations, the ruler, pause chips, sizes, swatch hex and slider values, key caps, the setup log, the terminal |

The chrome loads the brand faces under names of its own (`renderer/brand/chrome-fonts.css`:
"Instrumenta Fraunces", "Instrumenta Commissioner", "Instrumenta Spline Sans Mono"), not the
copied `fonts.css`. The look system has a "Fraunces" of its own (a different file, without the
SOFT and WONK axes) that the export page sets in films; two faces under one family name in one
page would be chosen between by order, and the stage preview would stop matching the render. With
separate names a film can never be set in the chrome's type, and the chrome always gets the brand
file. Tiny tracked capitals are gone (the guide labels, the file kinds, the option names).

## Interface icons

`renderer/brand-icons/` (`fabula-icons.js`, `fabula-icons.css`, `README.md`): 26 full-colour
objects on Forge3D's renderer (Discere's algorithm), with eleven of Forge3D's drawings reused, plus
twelve `currentColor` line utilities. Meaning hues: coral for Fabula acting, green done, gold
waiting on you, teal hand-offs to the system, brick destructive or failed, stone at rest. The
README there has the set, its hues and what each replaced; `docs/brand/icon-contact-sheet.png`
shows it at 16, 24 and 48 px in both themes (`node test-tools/brand/icon-sheet.mjs`).

Where they are: the four steps (scissors, palette, scenes, reel; the open step in coral, the rest
in stone), the Assistant button (spark), the masthead toggles and the theme toggle (lines), the
job pill (hourglass, failed), every Export button and card title, the projects list's rename,
folder and bin, the inspector's actions, the Making panel's phases (done, hourglass, clock,
skipped, failed) and buttons, New project and the drop zone (camera), Save as brand (badge),
Undo and Reset (undo), the transport (solid play and pause lines) and the zoom (lines).

Kept as text on purpose: the insert marks inside the transcript and the timeline's kind glyphs on
blocks too narrow for words, which are type in a line of words.

## Motion

Nothing moves on its own. The slate claps (one beat of its `ii-clap`) when the window opens, when
a brief is sent with Make it into a video, when a render starts and when one finishes well, and
in the masthead and the Making panel when the draft lands; it also claps on hover or focus of the
wordmark. The spark twinkles once when an assistant session starts, the Export step's reel turns
once when a render starts, the failed mark shakes once when a job fails, and icons in buttons hop
on hover or keyboard focus. Both icon stylesheets stop every animation under
`prefers-reduced-motion`; the harness checks the slate's animation is `none` with it emulated.

## Kept, and why

- The look system, the painter, the fonts films are set in, the stage field, the footage, the
  draft player, the Look cards' previews: content (above).
- The framing guides over the footage keep fixed colours (coral head, teal screen) in both themes,
  because they are drawn over the picture, not on the chrome.
- The terminal's dark ground in the light theme (above).
- The insert marks and timeline glyphs as type (above).
- `Fabula.exe` in the release is Electron's `electron.exe` renamed; its embedded icon is still
  Electron's. The windows it opens carry the slate (`fabula.ico`), but changing the executable's
  own resource needs rcedit on Windows, which the Linux release build does not have.

## Verification

- `npm test` (288 pass on the branch head), including `test/brand.test.mjs` (tokens, icon CSP
  safety, copied files unedited) and `test/chrome-style.test.mjs` (no colour literal outside
  `:root`, both themes, the faces and their axes, nothing from the network, the theme before first
  paint, every icon asked for exists). Fabula has no linter; `node --check` passes on every script
  touched.
- `node test-tools/screenshots/shoot.mjs`: every main screen in dark and light from the real
  window (README there), looked at by eye; contrast clean; keyboard focus ring in coral on both;
  the slate stops under reduced motion.
- `scripts/package-release.mjs` built the Windows bundle (fonts and ICO inside), and the bundle's
  `Fabula.exe --instrumenta-launch-check` answered `FABULA_LAUNCH_OK 0.1.0` on Windows; the
  checkout's Electron answers the same.
- The setup window was rendered in headless Chromium in both themes; it has not been seen on
  Windows running a real setup.
