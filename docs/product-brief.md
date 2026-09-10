# Fabula — product brief

## The viewer's eye (2026-09-09)

The owner asked for every element to be judged against the vision. Two reference films were
looked at as a viewer would see them and the belt was corrected where they fell short: a custom
graphic may sit over the head (`over: true`) so a short opens on the face with the words on it;
a tall frame keeps its captions and titles above the bottom eighth where Shorts and Reels draw
their own controls, and the layouts' floor moved to match; the before-after develops across its
span; the voice is measured and landed on its target by a stitch that checks itself; every custom
card scopes its CSS to itself (a collision found by putting all the templates on one page). The
checks that found these — the window photographing itself, the template probe, the film sheet —
are in the repo, because that is where the next such fault will be found.

The same day, five fresh readers were put over the code in turn — the new core modules, the
painter and scripts, the docs against the schemas, the older engines, the server and the app —
and found fifty-three real defects between them, every one fixed with a test where one could be
written. Two are worth naming as decisions: `set_scenes` now spreads the previous compose.json
under what it was given, so nothing a sibling tool wrote is ever dropped by a rewrite; and both
processes write review.json and compose.json beside and rename, so the other side's poll never
reads a truncated file. The lesson recorded for next time: after any large burst of authoring,
the readings come before the claim of done.

A sixth reader, over the painter and the window the belt was built on, found twelve more the
next morning. The one that changed an engine: the window built its layout timeline from the
last word's end and the export from the film's length, so a closing card on the last words
was the last segment in one and an absorbed middle segment in the other. Both now use the
film's length, and the timeline folds a sliver of the head under half a second at either end
into the placed segment beside it — a few frames of face before the first card or after the
last is a flash, not a shot. The rest were the window's: a callout placed in the band was
stretched between the stylesheet's top and the painter's bottom, the inspector addressed a
scene by index against a plan the assistant rewrites, the Look sliders snapped back under the
hand, duplicate scenes shared a paint key.

A seventh reader drove the belt over the MCP protocol itself, as the assistant does, and
found twenty-one more — and, by writing a probe plan into the reference short while a
snapshot run had moved the open project under it, proved its own top finding: a write could
not be atomic with the check of which project is open. Every tool now remembers the project it
last answered for, and a write that finds a different one open refuses and names both. The
rest were the tools' honesty: a params patch replaced a template's params whole, a new kind
left the old template's rendering behind, a missing picture passed validation, `wait_render`
reported the last job as if it were running, the adopted persona was forgotten by `status`,
a font nobody vendored was accepted, and the draft shipped tags reading "Earth" and pills cut
off with an ellipsis. The two worked plans are checked in under `docs/craft/plans` so the
reference films can be put back from the repository.

## B-roll (2026-09-10)

The belt's largest gap after the readings was the editor's most ordinary tool: footage that
is not the head. `import_clip` brings a video the person has — a phone clip, a screen
capture, stock they own — into `assets/` as a muted H.264 mp4 cut to the seconds wanted, and
a `clip` graphic plays it in the card from `in` seconds in, beside the head in a `side`
layout or as the whole picture in a `cutaway`. It rides the screen track's mechanism: the
painter draws the card's chrome and reports the rect, the window and the export page place
one `<video>` in it, and the export overlays the file through ffmpeg — read from its own
offset, held transparent until its scene begins, cover-cropped or letterboxed — so the
export never captures the clip's frames as plates. One clip at a time; the read-back says
when a scene outruns its clip or two clips overlap. Verified on a rendered span: the clip's
counter reads the offset asked for.

## The voice, cleaned (2026-09-10)

`set_audio` takes `voice_clean`: `light` (a high-pass at 80 Hz and an FFT denoiser taking the
floor down 8 dB, tracking the noise) or `strong` (100 Hz, 16 dB, and a de-esser), run before
the level is set so a loudness target is met on the cleaned voice. Measured on eight seconds
of the reference short: the noise floor from -63 dB to -81 dB with the voice's RMS within half
a decibel of where it was. Opt-in, because a floor taken too far down sounds like a booth.

## The grade (2026-09-10)

The theme carries a grade on the footage: contrast, saturation, lift, warmth and vignette,
neutral by default. The render applies it exactly — eq and a colour temperature on the source
before it is shaped, the vignette after the scale so it sits on the card — and the window
shows the nearest CSS can do through the Look page's Footage sliders. It is part of the theme
so a brand carries it, and part of every chunk's identity so a change re-renders the film.

## Three more for the belt (2026-09-10)

A `lower-third` template — the name plate over the face when the speaker is introduced,
made for `over: true` like the thumbnail and the cta; an `endscreen` template that leaves
YouTube's last twenty seconds with a heading and three empty frames where the platform draws
its elements; and `render_thumbnail` `variants`, two to four lines rendered side by side at
the size a feed shows them, which is the size to choose at.

An eighth reader went over the day's additions before any were called done and found seven.
The one worth remembering: ffmpeg's `vignette` takes only yuv or grey and silently drops an
alpha plane, so a vignette placed after the head's mask made the head an opaque rectangle in
every landscape film — over the cutaways too — while the window showed the right picture.
Splitting after the scale to take the alpha off and put it back was tried and tore under a
glide, the two branches landing a frame apart as the size changed; the vignette now goes on
the footage before its alpha exists, on both routes, which on the flat route is the card's
own space because the card shows the whole frame. The others: the window's Footage sliders replaced the whole
grade on each move, `set_scenes` alone skipped the asset check, a project switch could be
taken up by a read that never named the project (every answer now carries `project`), a clip
on the film's edge faded in the film but not the window, and hand-written html patched onto a
template card never landed.

A ninth reader took the natural-sound commits and found the duck on the wrong clock: the
gain expression sits before the clip's delay, so `t` in it is the clip's own time, and the
windows were read as if it were the span's — a clip never came up in the pause it sat in.
The windows are now read at `t` plus where the clip lands. With it: `sound: true` on a clip
without a sound track is refused before the render rather than failing the stitch minutes in;
a tool that failed no longer takes a project switch up; `review_film` says when the floor it
measured is the bed or a clip rather than the room, and measures the newer of the film and
its draft; a clip on the first words sounds from frame one, as it is drawn.

Then the whole journey was run once, over MCP, on a fresh project made from the owner's
recording — transcribe, cut, frame, clean, compose, grade, clean the voice, B-roll with sound,
draft, review, thumbnails, chapters, description, a short, a re-cut and reanchor — and every
step was true to disk in sixteen minutes. What the run caught was the tools' manners rather
than their work: `set_scenes` refused the spelling `get_scenes` hands back, `film_sheet`
sampled half an interval early and refused a draft, the `detect_framing` tool scanned without
applying what the first pass would have, and the draft dropped a moment that sat under an
earlier scene without a word. All fixed, each with a test where one could be written.

An eleventh reader took the commits after the journey and found the round trip I had just
promised was hollow for B-roll: `set_scenes`'s graphic schema predated the clip kind, and zod
strips what it does not name, so a clip's in-point, fit and sound vanished on the way back.
The schema names them and passes the rest to the engine's own validation. With it: the lowered
section floor let "so the…" a dozen seconds into a short count as a chapter, and a short has no
chapters at all now; `film_sheet` counts against the video's length, not the container's
longer audio; a short's spoken ask goes over the face like the draft's own; a hook line never
ends on a preposition.

Two more for the belt the same evening: `export_description` carries hashtags and holds its
chapter list back until a platform would show one, and `get_captions` / `export_captions` let
the assistant translate the film's caption phrases and write them back as a subtitle file with
the film's own timings.

And one for the person: a picture or a clip dropped on the Scenes step's stage is filed under
the project's assets the way the assistant's import tools file one, and placed beside the head
over the words at the playhead, with the inspector open on it — their own B-roll, without a
round trip. The assistant's next read sees it like any scene the window made.

Last, a reader went over the documents the assistant reads — the workflow, the craft guides,
the tool descriptions — for coherence after thirty commits of accretion, and found
twenty-four places where two texts disagreed (the clip "muted" in one and its sound kept in
another, twenty-five templates against twenty-seven, a title of three words against four, the
loop the tool told the assistant to sit in and the workflow told it not to) and a reading
order that gave a fresh assistant `describe_kit` and `preview_frame` two hundred lines after
its first `set_scenes`. The workflow is rewritten in the reader's order — invariants, who you
are, the session, projects, the shape, the loop, what to read before composing, writing and
patching, the look, sound, captions and deliverables, the gates, shorts — with the notes for
whoever edits the code at the end, and every disagreement settled on the code's side.

Then a first reader — a fresh assistant given only what a session reads — worked the film
through the rewritten workflow and came back with thirteen notes. Three were the code's: a
card hanging through a seam could follow a cutaway's full-stage card under the head (the hang
now stops at the card's own layout), the lower third's plate took its colour from a light
preset (it is dark whatever the look), and `status` kept recommending a voice target already
set. The rest were the documents' silences — no tool named for the transcript's word ids, the
two spellings unexplained, a field guessed for want of a sentence — each now a sentence where
the reader needed it, and `describe_templates` says what a persona's list leaves out.

A last reading of those commits caught what the Linux window could not: a dropped clip ran
the WSL ffmpeg inside the Windows window, where every other job goes through `wsl.exe`. It
does now, with the paths spelled as WSL sees them. With it: a drop inside a placed layout
joins that layout instead of writing a stage scene the timeline would ignore, a clip's words
are never under the dwell floor, a file the plan refused is not left in the assets, a
translated caption line is one line, and an upper-case extension keeps its name.

## The assistant's toolbelt (2026-09-08)

The assistant is the editor; everything else is a tool it holds. The 09-08 round widened the
belt in four directions, all pure and tested, none needing a key or a service:

**Templates** (`core/templates.mjs`). Twenty-four named graphics written once and rendered
from fields, laid out per delivery shape, animated only from the painter's `--q`/`--p`. They
land in `compose.json` as ordinary `custom` graphics with the template id and params beside
them, so the painter, the export and the window needed nothing. The decision worth keeping: a
template is expanded server-side at write time, not at paint time — what is on disk is always
a complete graphic, and a project outlives a template's redesign unchanged.

**Reading** (`core/story-engine.mjs`, `core/pacing.mjs`). `read_story` marks the transcript up
before composing (sections, the opening and its promise, the ending and its ask, every moment
with a drawable shape). The pacing read rides every plan write beside the variety read and
judges a plan on its shape's clock; `review_plan` reads without writing. Both are
deliberately explainable — every note names a sentence, a scene index or a time — because the
assistant has to be able to disagree from the evidence.

**Looking** (`scripts/frame.cjs`). `preview_sheet` tiles many instants into one picture. The
first sheet of a real project showed one card holding for three tiles in a row, which no
number in the plan had said.

**Craft** (`docs/craft/`, `core/personas.mjs`). Two personas — the film editor and the
short-form farmer — each a short brief the launcher leads the first message with and two
guides `adopt_persona` hands over in full; a visual grammar mapping what is said to what goes
on the stage; and reference styles described as methods rather than looks. The invariants are
not part of a persona; they hold whoever is working. The persona is chosen in the launcher and
the window, remembered, and switched mid-session by calling `adopt_persona` again.

## Delivery shape and short-form (2026-09-07)

A project is created landscape (16:9) or vertical (9:16) and records it in `project.json` beside
its title. `core/formats.mjs` is the one place a shape is defined: the stage the composition is
painted on, the ceiling the clean cut is encoded at, and whether the piece is short-form.

Two decisions worth not re-litigating.

**The crop is compose-time, not render-time.** A vertical film's clean cut is still the head at
its own framing; `core/stage-engine.mjs` gives a portrait `focus` a window the head must cover,
and the head is cropped to fill it when the film is composed. Cropping at `render_clean` would
have been sharper from a 4K source and would have made the `band` layout — the whole recording,
in its own shape, for a moment a crop would ruin — impossible, and would have made changing your
mind about a shot re-render the cut. The ceiling for the vertical format is raised instead
(`3840×1920`), so a recording that has the pixels keeps them and a 1080p one encodes exactly as
it always did.

Contain and cover are one rule, not two: `headDrawRect` covers the window, and a window that is
already the footage's shape crops nothing. That is what makes a glide between a `band` and a
`focus` continuous — the crop grows from nothing as the window's shape diverges — and it is why
the export needs the `max()` inside the ffmpeg expression rather than two pre-computed rects.

**A short is a project, not an output.** `create_short` writes a new project that references the
same recording and inherits the long film's cut list with everything outside the span removed
(`core/clip-engine.mjs`, `scripts/shorts.mjs`). Its clean cut is therefore rendered from the
original footage and can be framed for the new shape. The look travels; the scene plan does not.
The alternative — shorts as extra outputs of the parent project — would have needed a nested
editing UI and a second set of tools for something the existing four steps already do.

`suggest_clips` is a shortlist, not a decision: it scores runs of whole sentences on length,
opening, ending, claim density and subject cohesion, and prints the reason beside each. It is
deliberately explainable rather than clever, because the person has to be able to disagree with
it from the text.

## Current assistant integration (2026-09-07)

Fabula supports Claude Code and Codex through the same stdio MCP server and shared
`docs/assistant-workflow.md`. `npm run assistant` starts a companion CLI session with a
provider, exact model ID and reasoning effort; preferences are remembered per provider.
The UI is provider-neutral. Media, project formats and rendering are shared. The launcher
uses session-only MCP configuration and existing CLI authentication, with no API dependency.
Run it in WSL/Linux; the review window can run on Windows. Only one assistant controls the
checkout at a time. Model/effort availability is checked by the provider, not hardcoded here.

The older Claude-only cost and embedded-SDK descriptions below are historical. Current cost
scope is existing Claude/ChatGPT subscriptions plus local hardware. Embedded chat is still
not implemented; the window inbox is serviced by a listening companion session.

Fabula turns a raw talking-head recording into a finished, animated video: pauses and fillers cut,
visuals appearing beside the speaker that match what is being said, at Claude Design quality. It is
the successor to the ambition behind Motus — automated video editing — rebuilt around a transcript
instead of a timeline, and around Claude as the editor. It is a standalone Electron app in the
Instrumenta workspace; catalog registration comes once it is real.

The owner's cost constraint is absolute: nothing beyond the existing Claude Max subscription and
local hardware.

## What is proven (2026-09-04)

- A 10-second clip uploaded to Claude Design as a video layer survived a shrink-to-corner
  transition with a chart animating beside it, kept its audio, and exported to MP4 at the clip's
  exact duration. What that actually proved is the **composition model**: footage as a layer,
  everything animated as a pure function of one time value, exported frame by frame. Fabula
  implements that model natively (see Compositor); Design itself is not in the loop.
- The development machine has an RTX 4080 SUPER (16 GB) visible from WSL2, Python 3.12, Node.
  ffmpeg and WhisperX are not yet installed; `scripts/setup-tools.sh` installs both without sudo.

## What is disproven (2026-09-04)

- **There is no official Claude Design MCP server.** The guessed endpoint
  (`api.anthropic.com/v1/design/mcp`) does not exist. The only bridge in circulation is a
  third-party project driving a real Chrome via CDP against claude.ai's internal endpoints — no
  video upload, no export trigger, fragile, and not something to point at the owner's account.
- Consequence, decided by the owner the same day: **Claude Design is out of the pipeline
  entirely.** The same models are available through Claude Code on the same subscription, and
  Design's value is those models plus a composition runtime and a renderer — both of which Fabula
  owns. One interface, no uploads, footage never leaves the machine.
- The Claude Agent SDK, on this machine with the owner's own Claude Code login, bills against the
  Max subscription. That holds for a personal first-party tool; distributing Fabula to other users
  would require API keys and is out of scope.

## Where it stands (2026-09-05)

Slices 1 and 3 of the build order are built and used on a real 18-minute OBS recording; slice 2
is done differently from the plan: Claude drives the pipeline from a Claude Code session through
the `fabula` MCP server rather than an embedded Agent SDK, and the two-way dialogue (insert
points, the Ask box) travels through `media/<project>/inbox.json`. What exists:

- **Two renders, two kinds of gate.** `render_clean` finalises the cut once per cut list and
  framing, compared by content identity (`out/clean-map.json`), and the compose stage only moves
  that file around. `render_final` is layered and cached in two-minute chunks keyed on everything
  that feeds them, the painter's own files included. Both are detached jobs with progress in the
  window; both encode with NVENC from WSL.
- **The window is four steps.** Cut (transcript rail, skip-preview, framing guides), Look (theme
  presets, saved brands, colours and type, captions mode), Scenes (the 1080p stage with the
  overlays painted by the export's own runtime, the script in a drawer), Export (render buttons,
  progress, what is stale and why, every file written). The timeline under Cut and Scenes is a
  zoomable window over the film with a minimap, drag-scrub and J/K/L. The frame keeps its aspect
  at every window size.
- **The look** is a theme (`core/themes.mjs`) applied as CSS variables by the same painter in the
  window and in the export; a brand saved under `media/themes/` carries it to the next video.
  Consistent branding means the animations and the backdrop, not a logo.
- **Renders start from either side.** The MCP tools and the Export page use the same job specs
  (`scripts/project-state.mjs`). On Windows the window hands a job to WSL through `wsl.exe`;
  that path is written but has not yet been exercised on the Windows machine.

Still open: cancelling a running job from the window, captions through libass instead of
captured frames, an emoji graphic once a colour emoji font is vendored, and the embedded chat
panel the original plan called for.

## The product is the review loop

The pipeline below can run end to end, but Fabula is not a batch script — it is an editor with two
review gates. Nothing renders until a gate is approved.

1. **Cut review.** The transcript is the timeline. Every proposed cut shows as strikethrough text
   with a reason and a toggle; clicking a word seeks the player. Preview plays the *raw* file and
   skips cut spans live — a ~100 ms seek hiccup per cut, no render on the iteration path. A
   low-resolution proxy can render in the background for smooth scrubbing; it is never waited on.
2. **Shot-plan review.** Planned visuals appear as lanes against the transcript — what appears,
   when, in which layout (full frame / corner / split) — editable before anything is composited.

## Pipeline

1. **Record.** 4K, wider than delivery, consistent background. Delivery is 1080p; the spare
   resolution funds repositioning and punch-ins.
2. **Transcribe raw.** WhisperX `large-v3`, float16, word timestamps, JSON out.
3. **Propose cuts — two layers.**
   - *Deterministic, local:* dead air from inter-word gaps in the WhisperX timeline (one source of
     truth; no separate silence detector), plus a conservative filler lexicon (um, uh, erm…).
   - *Semantic, Claude:* the session reads the transcript and flags false starts, repeated takes,
     and redundancy — the cuts a word list cannot see. Every cut carries reason, source, and an
     enabled toggle.
   - Cuts keep ~150 ms of breath at each boundary and never cut to zero.
4. **Cut review gate.** Approve → render `clean.mp4`: a frame-accurate ffmpeg re-encode of the
   kept footage, cropped to the source framing and delivered at stage resolution. This is the
   one render that finalises the cut. It happens once per cut list and framing, by content
   (`out/clean-map.json` records the identity of the cuts and framing it came from, and
   `render_clean` skips when the current ones match), and everything after it moves the file
   around without touching it. **Alternating punch-ins** (100% ↔ ~115%) at cuts to conceal jumps
   — the single biggest perceived-quality win in the pipeline — are placed by the compose stage
   and the final render, not baked here, so turning them on, off or tighter costs no render.
5. **Re-transcribe clean.mp4.** Timestamps now match the footage the compositor receives. Never
   re-time the raw transcript.
6. **Chunk (optional).** With no upload ceiling to respect, chunking is purely render and
   iteration granularity: splitting at the topic breaks the transcript reveals means a shot-plan
   tweak re-renders one 2–4 minute segment, not the whole video. Worth keeping for that reason
   alone; no longer a compliance requirement.
7. **Shot plan.** Claude writes, per segment, what visual appears, when, and in what layout —
   anchored to *word IDs*, not seconds (see Invariants). Reviewed at the second gate.
8. **Compose.** Through Fabula's own runtime (below). The shot plan drives a composition where
   every frame is a pure function of a single time value; preview and export are the same code.
9. **Stitch.** Concatenate segments, then one final normalize pass — even our own renders are not
   trusted to `-c copy` concat; the final re-encode also applies −14 LUFS loudness normalization.
   A single unchunked render skips this stage entirely.
10. **Free wins.** `.srt` captions from the word timestamps; chapter markers from the topic breaks.

## Invariants

- **The video is edited, never read; the transcript is the input for every decision.**
- **Cut first, then re-transcribe the clean output. Never re-time a transcript.**
- **Everything anchors to word IDs.** The cut list and shot plan reference words; seconds are
  derived. Changing a cut after shot-planning cannot break the plan — timestamps re-derive.
- **Renders happen only behind an approved gate.**

## Architecture

Electron app; Windows is the eventual target, WSL2 is the development host.

- **Main process embeds the Claude Agent SDK** — the "Claude Code session in the background". App
  state is exposed to the session as in-process MCP tools via `createSdkMcpServer()` / `tool()`
  (`get_transcript`, `propose_cuts`, `write_shot_plan`, `request_render`, …), auto-approved through
  `allowedTools`. Claude's edits arrive as structured tool calls the UI renders immediately — chat
  text is never parsed.
- **Renderer** is the review UI: transcript editor, skip-preview player, shot-plan lanes.
- **Sidecar:** WhisperX in a local venv on CUDA; static ffmpeg binary; both installed by
  `scripts/setup-tools.sh`, no sudo.
- **Compositor: Fabula's own runtime, and only that.** Three parts:
  1. *Scene kit* — layout primitives (full frame, corner pin, split, the video layer with border
     and radius), animation primitives (springs and easings over the one time value), content
     components, and design tokens configured once so every segment matches. This is the "design
     system in Design" idea, owned locally. As built (2026-09-05): five theme presets in
     `core/themes.mjs` (Studio, Broadcast, Paper, Neon, Mono), each a complete set of tokens —
     field, accents, type faces (vendored: Inter, Space Grotesk, Fraunces, Source Serif 4, so
     the Windows window and the WSL export set the same type), card, radius, glow, title,
     callout and caption styles — with per-project overrides, a logo watermark and a handle;
     titles in five styles (rise, slam, typewriter, wipe, block lower third) with subtitles,
     callouts in four (pill, tag, stamp, note), captions in three (pill, band, karaoke), and a
     graphic kit of chart, stat, list, image (tilt, pop, Ken Burns), quote, compare, steps, ring,
     logos and the screen track. Every entrance, count and wipe is a function of time computed
     in `renderer/overlays.js`; the painter keeps elements by identity between frames, so a
     callout never replays its entrance because a caption changed beside it (the "flashed twice"
     bug of 2026-09-04), and the export never catches an animation mid-flight because there are
     none. Pictures arrive through `scripts/images.mjs`: Wikimedia Commons search (rasterised
     PNGs even for SVG logos, licences reported), a page's share image, or a site's icon.
  2. *Shot plans are declarative JSON against the kit*, word-anchored, so the second review gate
     can edit them directly without a Claude round trip. A Claude-authored custom component is the
     escape hatch when the kit cannot express a shot (later slice, sandboxed to the runtime's
     time-function contract).
  3. *Preview and export share the runtime.* Preview plays live over the `<video>` element.
     The export is layered (decided and built 2026-09-05, after a whole-stage capture that seeked
     video for every frame made each title tweak cost the whole film again): the head and screen
     tracks — rendered once by the clean render — are placed on the stage by ffmpeg from
     expressions `core/render-plan.mjs` generates out of the stage engine's own numbers, tested
     against `layoutAt` at every instant; the browser paints only two transparent layers (cards
     and the head's shadow under the head, titles, captions and kinetic type over it) and is
     captured only when a layer's signature changes; ffmpeg composes field, glow, screen, layers
     and head in two-minute chunks, encoded in parallel and cached by a hash of everything that
     can change their pixels; the stitch copies the chunks with the audio straight from
     clean.mp4 — the video is never re-timed, so audio alignment is free. A whole film is
     minutes; a tweak re-renders one chunk. What you previewed is literally what renders.

## Build order

- **Slice 1 — the cut half, entirely local, no Design dependency.** Ingest → WhisperX transcribe →
  deterministic cut proposal → transcript editor with skip preview → approve → clean render with
  fades and punch-ins → re-transcribe. `core/cut-engine.mjs` (pure, tested) is the start.
  *Built (2026-09-05).*
- **Slice 2 — Claude in the loop.** Agent SDK embedding, in-process tools, the semantic cut pass.
  *Built as an MCP server driven from Claude Code instead of an embedded agent; see "Where it
  stands".*
- **Slice 3 — the compose half.** Scene kit, shot-plan schema and lanes, live preview, the
  offscreen frame-capture exporter, stitch and normalize. The render spike (offscreen Electron
  capture on this WSL machine) is the first task here because it is the only unproven mechanism.
  *Built (2026-09-05): the layered, chunk-cached export.*

## Open questions

- ~~Export throughput: frames per second of offscreen capture at 1080p.~~ Resolved: the render
  captures only the frames on which a layer's signature changes (states, not frames) and lets
  ffmpeg hold each plate, so a 105 s film's draft renders in 117 s and its clean cut in 48 s
  (2026-09-10, the journey run); chunks are cached by content identity, so a tweak re-renders
  one chunk. The spike's findings below still hold for the mechanism.
  **Spike findings (2026-09-04, `scripts/spike-offscreen-capture.cjs`):** the mechanism works —
  two full runs produced correct stepped frames — with these hard-won specifics: `capturePage`
  stalls on offscreen windows (use the CDP `Page.captureScreenshot` through
  `webContents.debugger`, the Puppeteer path); paint events throttle to ~1 fps regardless of
  `backgroundThrottling`; and this WSL host developed a persistent Chromium shared-memory flake
  mid-session (ESRCH creating shm in both `/dev/shm` and `/tmp` while the same syscalls succeed
  from Python — likely cured by `wsl --shutdown`, and irrelevant on the Windows target). Re-run
  the spike after a WSL restart to get a clean CDP throughput number.
- ~~WebCodecs demux.~~ Not needed: the head never goes through the browser in the render (ffmpeg
  places the footage; the page captures plates), and the window seeks a `<video>`.
- ~~The John Van Sickle static ffmpeg has no NVENC.~~ Resolved 2026-09-05: `setup-tools.sh`
  installs the BtbN GPL build, and `h264_nvenc` works from WSL (the encoder library is exposed
  under `/usr/lib/wsl/lib`). What the switch revealed is that the encoder was never the clean
  render's bottleneck: its graph had one `trim` branch per piece, hundreds of them, and ffmpeg's
  single filter-graph thread spent the whole render scheduling branches while the decoder idled.
  The graph is now one crop branch per distinct framing rect switched by `enable`, and one
  `select` that keeps the pieces' frames — by frame number on the 30 fps grid, with the audio
  trimmed to exactly those frames' instants, so the two tracks stay the same length to the sample
  instead of drifting by up to a frame per cut. NVDEC (`h264_cuvid`) also works but decodes this
  footage no faster than sixteen cores, and would tie the render to h264/hevc sources; not used.
- ~~WhisperX on this 4080/WSL2.~~ Runs: 63 s for a 105 s recording, word timings good enough to
  anchor every scene; the retranscribe of the clean cut is what the plan anchors to.
- Whether `large-v3` hallucination on long silences needs VAD tightening before the gap detector
  runs: not seen on the recordings cut so far; the silence cuts and the false-start, stutter and
  retake detectors have been enough. Open until a long, quiet recording says otherwise.
