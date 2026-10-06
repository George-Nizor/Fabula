# Fabula as a motion-graphics tool

Design proposal, 2026-10-06. Nothing here is built yet. It answers the owner's question: can Fabula
make the kind of full motion graphics Claude produces on its own (the single-file reels people post
on Reddit and X), and what is in the way? It ends with a phased plan and the decisions; the
owner's answers of the same day are folded in.

## The verdict on the hunch

The hunch is half right. Fabula's motion is held back by the **recording**, which everything hangs
off. The **transcript** is not the problem: a timed narration as the clock is what the best motion
pipelines use, and Fabula already has it.

There is a second constraint, as big as the first, and it is not about the transcript at all.
Fabula treats motion as a **card**: a short, separate document that fades in over the head and fades
out again. The reels people admire are **one continuous composition** in which shapes transform
instead of cutting. Fabula's model cannot express that, even with a perfect voiceover in place of
the recording.

### Where the recording is load-bearing

Every one of these is in the code today:

- **No project without a video.** `open_project` takes `video_path` and refuses anything else
  (`mcp/server.mjs:440`).
- **The film's length is the clean cut's length.** The render reads it from `out/clean.mp4`
  (`scripts/export-compose.cjs:141-149`), and the sound comes from the same file.
- **Every scene anchors to a clean-transcript word id.** `validateScenes` throws without one
  (`core/compose-engine.mjs:149`). A film with no speech has no words, so it cannot hold a single
  scene, motion included.
- **Undeclared time is the head in focus.** The layout timeline exists to place the talking head.
  Its dwell rules are tuned for a face (a 3 s floor, 1.2 s for a cutaway, `absorbedStages`), and a
  motion scene must sit inside one of those layouts.
- **The craft discourages motion.** `docs/craft/motion.md` opens with "a motion scene costs more
  than a card" and asks what the viewer would lose if it were a still. That is right for a
  talking-head film. For a motion film it is backwards.

### Where the card model is load-bearing

- **Each scene is its own iframe with its own clock.** `t` restarts at zero in every scene
  (`renderer/motion/runtime.js`, `seek`), so nothing can carry from one moment to the next: no
  shared camera, no object that morphs into the next idea.
- **Cards fade by default** (0.45 s in, 0.35 s out, `core/motion.mjs:120`). Between two motion
  scenes, the film dissolves through the field, which reads as a slideshow.
- **Nothing is shared between documents.** Scenes cannot import a common module, so palette helpers,
  a type scale or a drawn character are copied into every file or drift apart. The 200,000-character
  limit per scene is not the constraint; the lack of sharing is.
- **The assistant sees six still tiles.** `write_motion` returns a contact sheet
  (`scripts/frame.cjs:53`). Nothing checks what happens between the tiles, where layout collisions
  and one-frame pops live. Research in "What the good results do" below finds those are where
  generated motion fails.

### What is already right and stays

- **The sandbox**: an opaque-origin iframe served over `fabula-motion://` with an allowlist, no
  network, WebRTC removed.
- **Determinism**: a runtime-owned clock, Math.random seeded per frame, timers refused, every CSS,
  Web Animations and GSAP animation seeked. This is the same contract Remotion, HyperFrames and the
  howseen playbook enforce, and Fabula's is stricter than most.
- **Timing to words** (`fabula.word("thrust")?.t0`). Every narrated pipeline found in the research
  lands visuals on word timestamps. Fabula did that first and should keep it.
- **The layered, chunk-cached render**: a motion scene is filmed frame by frame, everything else by
  state, and a change re-renders only its chunk.

## What the good results do

Sources are listed at the end of this document. The short version:

- **One HTML file, every pixel from `t`, seeked frame by frame.** This describes the viral one-shot
  reels of late September 2026, HyperFrames (HeyGen, Apache-2.0, a paused GSAP timeline per
  composition) and the [howseen claude-motion-design](https://github.com/howseen-ai/claude-motion-design)
  playbook. Fabula's runtime already does it.
- **Continuity is the look.** The howseen rules carry shared elements across every handoff, use one
  shape system that transforms rather than cuts, key the camera with zoom interpolated in log space,
  and let one thing move at a time. Its list of bans reads like a description of "AI motion":
  rainbow gradients, particle fields, glowing chrome, emoji, 3D flips.
- **The model's defaults are the enemy.** HyperFrames' `motion-principles.md` opens with "You know
  these rules but you violate them". Its rules: one ease used at most twice in a scene, the slowest
  scene three times slower than the fastest, entrances that do not all rise 30 px from below, and
  build, breathe, resolve in each beat.
- **The storyboard is locked before code.** It lists beats of 1.5–3.5 s, the on-screen words
  verbatim, the word each reveal lands on, and one deliberately held frame. HyperFrames renders it
  as a static contact sheet and gets approval first. Friction Research (29 Sep 2026) says the same
  of the Opus 5.5 demos: approve the message, the storyboard and the keyframes, then build.
- **Automated checks come before any judgment.** OmniManim (May 2026) puts it plainly: "executable
  correctness does not imply render quality".
  - Overlap, overflow and occlusion are invisible in source code. They are found by measuring
    bounding boxes on rendered frames, between keyframes as well as on them.
  - `hyperframes check` audits text overflow, overlap held across samples, contrast, caption
    keep-out zones, one-frame pops and frozen stretches.
  - MoVer (SIGGRAPH 2025) has the model write assertions alongside the animation. Feeding back the
    ones that failed took correctness from 58.8% to 93.6%.
- **A separate critic judges.** howseen's critics are read-only agents that reject by default. They
  score each shot out of ten, fix only shots scoring 7 or less, and stop after two to four rounds;
  one test is restating the film's message from its frames alone. Fabula's `critique_film` and the
  critic persona are the start of this.
- **Audio first when there is narration.** Pipelines go script, then speech, then word timings,
  then visuals that wait on words. Remotion sizes each scene to its measured audio; Motion Canvas
  and oncue name events rather than seconds. Fabula's word anchoring is this already.
- **Keep the API small and well known.** Hallucinated APIs are the main failure mode in the Manim
  work, and retrieval over docs did not reliably help (TheoremExplainAgent, 2025). Raw Lottie
  generation is not viable for a general model.

Two figures in the research could not be checked against a primary source: the Remotion Skills
install counts, and the Opus 5.5 release date and pricing. Neither affects the design.

## What Fabula should become

Three things, built in this order, sharing one runtime, one render, one look and one assistant:

- **Sequences inside a film.** In a serious film (a documentary-style piece, an explainer with a
  real argument) the editor can decide that a stretch of the recording deserves a full, dedicated
  motion sequence. The sequence takes the whole stage for that stretch while the clip's own audio
  carries on underneath, timed to the clip's own words. This is the owner's first ask, and it needs
  no new clock: the recording already is one.
- **A better way of making motion.** The storyboard, the automatic checks, the critic and the
  motion vocabulary below. Sequences need these first. Every motion scene benefits, and so does the
  dedicated product.
- **A dedicated motion product.** Motion films with no camera at all, timed to a Luna voiceover,
  a music bed or a plain length with named beats. It is a separate product in the suite, built on
  the same engine.

The talking-head editing that exists today keeps working throughout.

### 1. Sequences: a dedicated motion piece over the clip's audio

A **sequence** is a motion graphic placed over a span of the recording, typically 20 s to two
minutes. It differs from today's motion scene in five ways:

- **It owns the stage.** The span is a cutaway, so the head is gone and the field is the
  sequence's own. The recording's audio plays on, ducked under music if the brief allows music.
- **It is long and continuous.** It is a reel (section 3): one document with shots inside, one
  camera, shapes that carry across shots. It is not a string of cards.
- **Its clock is the film's.** Words are `fabula.word()` exactly as today, so a re-cut moves the
  beats with the speech.
- **It enters and leaves as a designed transition.** There is no card fade. The engine's dwell
  rules treat it as one placed segment however many shots it holds.
- **It has a purpose written down.** `set_treatment` already names the signature moment. A sequence
  adds a line saying what it argues and why motion is the way to argue it, and that line goes to
  the storyboard and the critic.

Almost all of this exists. A motion scene under a cutaway with `fade: false` is most of a sequence
today; what is missing is the reel model, the making loop and the craft to decide when a film earns
one. The craft guidance belongs in `docs/craft/editor.md` and the treatment: a documentary film has
perhaps one to three sequences, at the points where the argument turns or a mechanism has to be
seen working. A vlog has none.

### 2. The making loop

This is where most of the quality comes from. It applies to sequences, to motion scenes in any film,
and to the dedicated product.

1. **Brief and treatment** (exists): purpose, latitude, look, the signature moment.
2. **Storyboard.** `set_storyboard` writes `storyboard.json`:
   - the message, stated as a claim;
   - the spine, the one continuity device;
   - beats of 1.5–3.5 s, with the on-screen words verbatim and the word or cue each reveal lands on;
   - one held frame, and at least one "no …" ban.

   The window shows it as a page of key frames sketched as stills. After the build, the storyboard is
   regenerated from what was made, because every launch film in the HyperFrames notes drifted from
   its plan.
3. **Write a reel, then check it automatically.** `write_motion` gains a check pass before it
   returns, run in the same sandboxed frame:
   - text that overflows its box or the safe area;
   - two text boxes overlapping for more than a few frames (transients during entrances are
     allowed);
   - contrast of text against what is behind it;
   - frame-to-frame pops: a single-frame jump in the picture that no cue explains;
   - frozen stretches longer than 2 s inside a reel;
   - colours outside the theme and fonts outside the vendored set.

   It samples at every cue, 0.3 s after every cue, and at a steady rate between. Findings come back
   as a list with times, alongside the contact sheet.
4. **Assertions the assistant writes.** An optional sidecar, `motion/<name>.check.json`, in the
   MoVer and `*.motion.json` style: `appearsBy`, `before(a, b)`, `staysInFrame`, `keepsMoving`.
   They are checked against the DOM without a render. This is how the assistant states what it
   meant and hears when the frames disagree.
5. **A draft video, judged in strips.** A 540p draft of the reel, plus the howseen sheet set: an
   overview at 2 fps, a 12-frame strip around each fast move and handoff, and a phone-width sheet.
6. **A critic that did not build it.** The critic persona runs as a separate, read-only session. It
   scores each shot out of ten against a fixed rubric (readability, rhythm, continuity, brand) and
   sends back only shots at 7 or below. It also restates the message from the frames alone. The
   loop stops after three rounds or when nothing scores 7 or below.

### 3. Reels: continuity across a whole sequence

A **reel** is a long motion document running on the film's clock rather than a per-scene one.
Inside a reel, the assistant writes **shots** as functions of `t` with handoffs between them, so
one object can become the next idea:

```js
fabula.reel({
  setup(ctx) { /* build the shared world once: the shape system, the camera */ },
  shots: [
    { cue: "intro",   render(t, s) { /* s.p is this shot's progress */ } },
    { cue: "problem", render(t, s) { /* the circle from intro becomes the bar chart */ } },
  ],
  camera(t) { return { x, y, zoom }; }, // keyed, zoom eased in log space
});
```

`fabula.scene` keeps working, and a reel is a scene whose span holds many shots. What changes:

- **`t` can be the film's own time** (`clock: "film"` on the graphic), so two reels, or a reel and
  a title, agree on what instant it is.
- **A project-local motion library.** `motion/lib/*.js` and `motion/lib/*.css` are served by the
  protocol under the same allowlist and named in a graphic's `libs` as `project:<name>`. A shared
  type scale, palette helpers or a drawn character are written once. This stays inside the sandbox:
  the files are the project's own, read-only and offline.
- **One reel per sequence, several for a long piece.** One document for a 30–60 s sequence is what
  the reference reels are. A five-minute motion film is several reels joined by designed
  transitions, because a single document that long is where coherence breaks down
  (TheoremExplainAgent's runs managed about 20 s without an agent loop).

### 4. The motion vocabulary

`describe_motion` and `docs/craft/motion.md` gain a short section on what the model gets wrong by
default. It is written as advice the check pass partly backs up:

- named eases with direction (out for entrances, in for exits), spring presets with a damping
  ratio of at least 0.72, and three speed tiers;
- build, breathe, resolve in every beat, with exits faster than entrances;
- one thing moves at a time; stagger in order of importance and under 0.5 s in total;
- build the end state in static markup first, then animate from it (HyperFrames' layout rule,
  which stops most overflow before it happens);
- a ban list the brief can extend: rainbow gradients, particle fields as decoration, glow,
  3D flips, emoji.

The existing helpers (`range`, `spring`, `stagger`, `ease`, `split`) already cover the arithmetic.
Two additions: `fabula.fit(element, box)` for text that must fit, and `fabula.camera` for the keyed,
log-zoom camera.

### 5. Fewer rules, more liberty

The owner's answer: give the editor more liberty if it produces a better result. The proposal
separates two kinds of rule.

- **Taste rules move to advice under Free hand.** These include "a motion scene must earn its
  place", the variety and pacing reads, the template-first habit in `CLAUDE.md`'s invariants, and
  the one-camera-move-per-scene line in the craft. Under Free hand they are context the assistant
  may overrule, and the invariants say so in one sentence. Guided keeps them as the default way of
  working. By the book still enforces the kit.
- **Quality checks stay at every latitude.** Text off the frame, a one-frame flash and an unreadable
  contrast are faults, never style choices. The check pass reports them under Free hand too.

That split is the honest way to give liberty without giving up the floor. The research is clear that
the model's unconstrained defaults are the "AI look", so the vocabulary in section 4 stays in front
of it as knowledge, not as a cage.

### 6. Opus for the whole chain

The assistant launcher already passes any exact model ID through (`scripts/assistant.mjs`,
`selection`), so `npm run assistant -- --provider claude --model claude-opus-5-5` runs the maker on
Opus today. Two additions make it the whole chain:

- **The critic inherits the maker's model** unless the brief names another. Choosing Opus once means
  Opus everywhere.
- **The Make it into a video sheet gets a model choice** beside the provider, remembered per
  provider as the CLI launcher already does. "Opus" is offered by name; anything else stays an exact
  ID.

Nothing in Fabula should be tuned to a smaller model's limits: the contract, the checks and the
craft are model-neutral.

### 7. The dedicated motion product

Motion films with no recording. What they need beyond sequences:

- **A clock that is not a recording:**

  | Clock | What sets the length | Where the words come from |
  | --- | --- | --- |
  | `recording` | The clean cut (today) | WhisperX on the clean cut (today) |
  | `voice` | A narration: Luna, a recorded read, any WAV | WhisperX on that file (already installed) |
  | `score` | A duration, or a music bed's length | None; named cues only |

  The cheapest way in keeps the renderer's assumptions: for a `voice` or `score` film, Fabula
  synthesises `out/clean.mp4` with ffmpeg, a video of the right length carrying the narration or
  silence. The render, the sound mix, captions and the chunk cache work unchanged, and the layout is
  a cutaway throughout because there is no head.
- **Cues: anchors that are not words.** Scenes anchor to cues, of which words are one kind:
  - words, from the clock's transcript;
  - named marks in `cues.json` (`{ "id": "drop", "at": 12.4 }`), placed by the assistant, dragged
    by the person on the timeline, read with `fabula.cue("drop")`;
  - beats from a music bed, offered as suggestions to snap a mark to, never trusted as a grid.
- **Voice from Luna.** Luna is wanted here and not for the main editor, whose films carry their own
  audio. What Luna offers and lacks:
  - **It offers** Qwen3-TTS with nine built-in speakers under Apache-2.0, plus cloned profiles from
    a recording you own. `POST /api/generate` on its loopback port returns a 24 kHz mono WAV.
  - **It lacks word timings.** Fabula transcribes the WAV with WhisperX, as it does recordings.
  - **The friction:** Luna must already be running on Windows; its token changes every launch
    (`%APPDATA%\Luna\runtime\app.json`); it answers only on Windows' 127.0.0.1, so WSL needs
    mirrored networking or `curl.exe`; it takes one request at a time and 5,000 characters at most.
    A small CLI or MCP entry in Luna's own repository would remove most of it.
  - **Voices to avoid** in published films: the legacy XTTS and RVC voices. One imitates a real
    person, and neither has a licence in the repo.

  `make_voice { script, speaker }` lets the assistant write the script, hear it back as words with
  timings, and rewrite before any animation is made. That is the audio-first order the research
  recommends.

**How it becomes a product.** Suite products are independent repositories, each with its own
`instrumenta/product.json`, and there is no mechanism for sharing code between them. The engine
(runtime, protocol, render, checks) lives in Fabula and will change fast while sequences are built.
So the dedicated product starts as a project kind inside Fabula, a "motion film" chosen at New
project, and gets its own name, tile and catalog entry once the engine settles. The catalog code
does not visibly refuse two entries over one checkout (`scripts/product-registry.cjs:264`), but
whether a second manifest can live in one repository is unverified. If it cannot, the product
moves to its own repository and takes the engine as a dependency at that point.

### 8. Libraries

- **three.js, vendored** (MIT; the owner said yes). Depth, light and camera moves are a large part
  of the reels people share, and writing WebGL by hand is where a model invents APIs. It adds about
  700 KB.
- **GSAP stays optional, not bundled**, for the licence reason already recorded in the product brief.
- **No Lottie authoring.** Importing a Lottie someone else made, as an asset, can come later.

### 9. Rendering

Measured on this machine on 2026-10-06. This was WSL with Chromium on its software renderer, because
the GPU process does not start here, and three capture windows ran in parallel:

| Scene | Stage | Draw | Capture | Per window |
| --- | --- | --- | --- | --- |
| `thrust` (the rockets film's scene) | 1920×1080, PNG | 30 ms | 100 ms | 7.7 fps |
| `thrust` | 960×540, PNG | 25 ms | 42 ms | 14.8 fps |
| A heavy test scene: 3,000 canvas points, 120 SVG nodes, split type | 1920×1080, PNG | 42 ms | 110 ms | 6.6 fps |
| The heavy scene | 1920×1080, JPEG 92 | 32 ms | 74 ms | 9.4 fps |
| The heavy scene | 960×540, PNG | 20 ms | 48 ms | 14.8 fps |

With three windows, a two-minute all-motion film (3,600 frames) takes roughly three minutes for the
1080p master and about a minute and a half for a 540p draft, before encoding. A one-minute sequence
in a longer film is half of that. That is workable, so **the capture path does not need replacing.**
Two cheap gains: JPEG for opaque reels that own the stage (about 1.4× here; alpha layers stay PNG),
and more capture windows on a machine with cores to spare. Encoding to WebP was slower than PNG.

Motion blur is the expensive extra. Four to eight subframes per frame multiplies capture time by the
same factor, so it belongs on the master only, as an opt-in per reel, never blended across a cut
(the howseen method, `tmix` in ffmpeg). The Windows install's GPU may change all of these numbers;
they should be re-measured there before anything else is sized on them.

## Phased plan

Each phase ships on its own and leaves the talking-head film working.

**Phase 1: sequences in a film.**

- A `sequence` graphic: a motion graphic on a cutaway span, no card fade, on the film's clock, with
  its purpose line.
- `fabula.reel` with shots, handoffs and the keyed camera, plus `motion/lib/`.
- three.js vendored.
- Craft: when a documentary-style film earns a sequence, in `docs/craft/editor.md` and the
  treatment.
- Free hand loosened as in section 5.

This phase is done when a sequence of 45–90 s, made by the editor inside one of the existing real
projects over its own audio, renders through the existing export, and a re-cut of the words under
it moves its beats.

**Phase 2: the checks.**

- The check pass in `write_motion`, with findings by time.
- The assertion sidecar.
- Strips around fast moves and handoffs.
- The motion vocabulary in `describe_motion` and the craft doc.
- `fabula.fit` and `fabula.camera`.
- JPEG capture for opaque reels.

This phase is done when a deliberately broken reel (text off the frame, a one-frame flash, an
overlap held for a second) is caught by the check, with times, before anyone looks.

**Phase 3: storyboard, critic and the model choice.**

- `set_storyboard`, its page in the window, and the gate as decided below.
- The critic as a separate read-only session with the rubric and the round cap, on the maker's
  model.
- A model choice in the Make it into a video sheet.
- The storyboard regenerated from the build afterwards.

This phase is done when a sequence goes from storyboard to approved draft with the critic's scores
recorded per round, and the second round scores higher than the first.

**Phase 4: motion films.**

- Clock sources `voice` and `score`.
- `new_film`, which synthesises the clean video.
- `cues.json`, cue anchors in `validateScenes` and `resolveScenes`, and `fabula.cue()`.
- The window: the Cut step hidden for a film with no recording; cue marks on the timeline, draggable.
- A worked reference film in `docs/craft/`: 45 s, made only with the tools.

This phase is done when a 30–60 s piece made from a brief, with no recording, renders through the
existing export, and moving a mark in the window moves its beat.

**Phase 5: Luna, and the product of its own.**

- A Luna adapter in Fabula: read `app.json`, call `/api/generate`, fetch the WAV, transcribe it.
- A Luna-side CLI or MCP entry, agreed in Luna's own repository.
- `make_voice { script, speaker }`.
- The motion film gets its name, tile, artwork and catalog entry as a product of the suite.
- Motion blur on the master as an opt-in.

## Decisions

The owner's answers of 2026-10-06, and the calls made where the owner asked for one.

1. **One product or two: both.** Sequences live in Fabula's editor for documentary-style films. The
   dedicated product comes later, starting as a project kind in Fabula and becoming its own product
   once the engine settles (section 7).
2. **Continuity model: reels.** Decided here at the owner's request. One document per moment with
   joins between them would be less work, but it cannot carry a shape across a boundary, and that
   carry is what makes the admired reels look the way they do.
3. **The storyboard gate.** Decided here at the owner's request:
   - **Free hand:** the storyboard is shown, and the work goes on.
   - **Guided:** the person approves a sequence's storyboard before its reel is written. A short
     motion scene of under 15 s only shows its storyboard.
   - **By the book:** sequences are refused, as motion scenes are now.

   Approval is one click in the window, with a note box for changes. A sequence is the most
   expensive thing in a film to redo, which is why the gate sits there and nowhere else.
4. **Models: the whole chain on Opus as an option.** The maker runs on Opus today by model ID. The
   critic inherits the maker's model, and the brief sheet gets a model choice (section 6).
5. **three.js: yes, vendored.**
6. **Rules: more liberty under Free hand.** Taste rules become advice; the automatic quality checks
   stay at every latitude (section 5). Whether Free hand becomes the default for documentary-style
   films is left until phase 1 has made one.
7. **Luna: for motion films only.** The main editor never needs it, because its films carry their
   own audio.

Still open, none of it blocking phase 1:

- **The product's name**, when phase 5 comes. Motus is discontinued and its mark is Fabula's now, so
  the suite's naming would want a new Latin word.
- **A small CLI or MCP entry in Luna's repository**, or Fabula calling Luna's HTTP API as it is.
  The CLI is sturdier; it is also a change to another product.

## How the numbers were found

The capture timings above come from a probe that drives `renderer/export.html` the way
`scripts/export-compose.cjs` does: `__renderLayer` per frame, then CDP `Page.captureScreenshot`.
It ran on the rockets film's `thrust` scene, copied into a scratch project, and on a synthetic heavy
scene, 90 frames each after five warm-up frames. The probe was not added to the repository. The
claims about the code cite the files they come from; the research claims rest on the sources below,
and two of those are marked unverified above.

## Sources

Read between 2026-10-05 and 2026-10-06. Code2Video and MoVer figures come from their abstracts and
project pages, not the full papers.

- Remotion Agent Skills: https://github.com/remotion-dev/skills and
  https://www.remotion.dev/docs/ai/skills; system prompt: https://www.remotion.dev/docs/ai/system-prompt
- Video as code with Remotion, the verification gap (Digital Applied, 2026-08-11):
  https://www.digitalapplied.com/blog/video-as-code-remotion-agentic-generation-2026
- HyperFrames (HeyGen): https://github.com/heygen-com/hyperframes, its skills
  `determinism-rules.md`, `motion-principles.md`, `storyboard-recipe.md`, `design-adherence.md`
- howseen claude-motion-design (2026-09-27): https://github.com/howseen-ai/claude-motion-design
- Friction Research on the Opus 5.5 demos (2026-09-29):
  https://friction.com.my/insights/claude-opus-5-5-motion-design
- TheoremExplainAgent (2025): https://arxiv.org/html/2502.19400v1
- Code2Video (2025): https://showlab.github.io/Code2Video/
- OmniManim, "See Before You Code" (2026-05): https://arxiv.org/html/2605.15585
- MoVer (SIGGRAPH 2025): https://github.com/jama1017/MoVer
- Motion Canvas time events: https://motioncanvas.io/docs/time-events/
- oncue (Revideo with faster-whisper): https://github.com/Divit-aggarwal/oncue
- OmniLottie (CVPR 2026): https://github.com/OpenVGLab/OmniLottie
- Luna: `../Luna/README.md`, `../Luna/app/main.py`, `../Luna/app/voice_packs.json`,
  `../Luna/THIRD_PARTY_NOTICES.md`
