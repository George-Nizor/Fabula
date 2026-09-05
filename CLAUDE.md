# Fabula — agent notes

`docs/product-brief.md` is the authority on pipeline, architecture, and decisions. Do not
re-litigate what it records as decided or disproven (notably: there is no official Claude Design
MCP, and Claude Design is out of the pipeline entirely by owner decision — Fabula's own runtime
is the only compositor, driven from Claude Code on the same models).

Invariants that shape every change:

- The transcript is the input for all decisions; the video is edited, never read.
- Cut first, re-transcribe the clean output, never re-time a transcript.
- Cut lists and shot plans anchor to word IDs; seconds are always derived.
- Renders happen only behind an approved review gate. Preview must never require a render.

Code layout: `core/` is pure logic (no I/O, tested with `npm test`), `electron/` is the main
process and preload, `renderer/` is the review UI, `mcp/` is the stdio MCP server that drives the
pipeline (`scripts/mcp-call.mjs <tool> '<json>'` is the one-shot bridge; `.mcp.json` registers it
for sessions started here), `scripts/pipeline.mjs` is the I/O shared by the server, the batch
driver and the jobs. The long steps run as detached background jobs (`scripts/job.mjs` for the
two transcriptions and the clean render, `scripts/export-compose.cjs` for the film): they write
`media/<project>/progress.json` with their pid, log to `out/<stage>.log`, and outlive the session
that started them. Project state lives in `media/<project>/review.json` (cuts) and
`compose.json` (scenes, theme, punch-ins); the window polls both at 500ms, so whatever writes
those files is live in the UI. Tools install to `tools/` and `.venv-whisperx/`
via `npm run setup:tools`, both gitignored, no sudo. On Windows the app runs from an Electron
runtime at `%LOCALAPPDATA%\Fabula\electron-win` pointed at this repo's UNC path — Chromium cannot
spawn children from `\\wsl.localhost`; under WSLg it needs `--no-sandbox --no-zygote` on the CLI.

Cost constraint: the owner's Claude Max subscription and local hardware only. Nothing in this repo
may depend on an API key or a paid service.

## The agent loop (how to work a project)

The person drops a clip on the window (or names a path); you do the pipeline over the `fabula`
MCP tools and they watch it land live. Footage is referenced where it lives, never copied. First
pass: `open_project` (skip if the window staged it — `status` tells you) → `transcribe` →
`detect_framing` → look at the frames it saved, then `set_framing` when the head is not the whole
frame (screen recordings with a camera inset, OBS scene switches, pillarboxing) → `cut_pass` →
review talk if asked → `render_clean` → `retranscribe_clean` → `plan_shots` → `set_theme` (the
look: a preset, the brand colours, a logo, caption style — ask what the film is for; a YouTube
channel wants `broadcast` with its own accent and logo, consistent across every video) →
`set_scenes` (your editorial judgment: layouts, titles with styles and subtitles, callouts, the
graphic kit — chart, stat, list, image, quote, compare, steps, ring, logos — kinetic beats,
captions; a `screen` graphic plays the recording's own screen beside the head wherever
`get_framing` reports a screen span) → `render_final` over a word range first (a minute), the
whole film once the spans look right.

**The dialogue, when the person wants a say.** Instead of writing every scene yourself, mark the
moments with `set_inserts`: each insert point is a word span, a line saying what the moment is,
and two to four ready-made options (your recommendation first; it is placed at once so the film
always has a plan). The window shows the points in the transcript and the timeline; the person
previews and picks, or asks for something else in words. Then sit in `wait_for_input`: an
`insert-chosen` event needs nothing from you; an `insert-other` carries their words — add an
option that does what they asked (`set_inserts` with the same ids keeps everything else),
`apply_insert` it, and say so; a `message` is a request in plain words about anything — do it,
then keep listening. Leave the loop when they say they are done, then render.

Pictures come from the web through `search_images` (Wikimedia Commons: logos and photos with
licences, SVGs rasterised) and `fetch_image` (a direct image, a page's share image, or a site's
icon), which file them under `media/<project>/assets/` for `image` and `logos` graphics and the
theme logo. When someone names a product, a tool or a site, a logo beside the words is usually
worth the two calls; say the licence when Commons asks for attribution.

The two gates are different in kind. `render_clean` finalises the cut: once it has run, the
compose stage only moves that file around (layouts, punch-ins, scenes, captions, accents), and
nothing you do there renders it again. The only things that do are the cut list and the framing,
and even those by content: `render_clean` compares the current cuts and framing with what
`out/clean-map.json` records and skips when they match, so toggling a cut and toggling it back, or
a `cut_pass` that lands on the same list, costs nothing.

Long steps are background jobs. `transcribe`, `render_clean`, `retranscribe_clean` and
`render_final` start one, wait up to `wait_seconds` (default 300) and return either the result or
`running: true`; then call `wait_render` until it reports done. The job keeps going if the session
ends; `status` shows what is running, and a job that died says so with its log. The window shows
every step as it runs, with frame counts and time left. It plays the raw file over the framing
guides in Cut and the 1080p stage in Compose, so the person sees every decision as you make it.

Tuning that matters on real recordings: `cut_pass` at the default 0.6 s minimum pause reads
fast-cut on a conversational speaker — 0.8–1.0 s keeps the natural beats. Say which you chose.

Iteration rules, in order of importance:

1. **Read before you write.** The person tweaks scenes, the theme and cuts in the window between
   your turns. `get_scenes`, `get_theme` and `list_cuts` are the current truth — regenerate the
   plan FROM them, never from what you last wrote. A `set_scenes` or `set_theme` composed from
   memory silently discards their edits. `set_theme` merges; only `reset` drops overrides.
2. **Change what was asked, keep the rest.** "Punchier title" is one scene's text, not a new
   plan. Carry every other scene through byte-for-byte.
2b. **Vary the picture.** The same card kind twice in a row reads as a template; the film
   should move between the head alone, a side card, the screen track, the full stage and the
   spoken word. Use the `full` layout at section changes (a `section` heading, a `cover` with a
   fetched still) and for anything that deserves the whole frame. When the kit has no shape for
   a moment, write a `custom` graphic: your own html and css for that one beat, animated from
   `--q`. Keep flights apart: the engine will not fly the head twice within three seconds.
3. **Cuts moved ⇒ the clean cut is stale, and nothing else makes it so.** After a real cut
   change: `render_clean` → `retranscribe_clean` → `reanchor_scenes` (it matches the words at
   each scene's ends in the new transcript and moves the ids; place by hand only what it lists as
   unresolved) → `render_final`. Punch-ins, scenes, layouts, captions and accents are
   compose-time and never touch the clean cut; `plan_shots` is safe to change at any point.
4. `render_final` is layered and cached: the head and screen tracks are placed by ffmpeg
   (punch-ins included), only overlay changes are captured, and each two-minute chunk is reused
   while nothing inside it changed — scenes, theme, punch-ins, the clean cut, the encoder, and
   the painter's own files (`renderer/overlays.js`, the stylesheets, the export page) are all in
   the key, so editing the painter re-renders every chunk by itself; no version bump needed.
   A whole film is minutes; a tweaked title re-renders one chunk.
   Still, say you are rendering and don't call it twice: a second render while one runs is
   refused. `status` lists what is stale and the tool that fixes it — read it before repeating a
   step.
