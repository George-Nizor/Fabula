# Fabula as a motion-graphics tool

Design and status, 2026-10-07. The owner's question: can Fabula make the kind of full motion
graphics Claude produces on its own (the single-file reels people post on Reddit and X), and what
is in the way? Below are the answer, what the best results do, what Fabula is becoming, what is
built and what is left.

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

## What Fabula is becoming

One Fabula, two ways to start, one engine:

- **New video**: a recording, cut and composed, as today. Motion goes in as moments, or as a
  **sequence**: twenty seconds to two minutes where a serious film (a documentary, an argument)
  stops showing the speaker and becomes motion graphics over its own sound.
- **New motion graphic**: a **motion film** with no recording at all, timed to a narration (a Luna
  voiceover or any audio file) or to a length. Motion graphics are the whole film.

Both are made the same way: a storyboard first, reels written as code in one shared world, a check
pass that measures every reel, and the assistant judging its own shots in rounds. Everything runs on
whichever model the session is started with; `--model claude-opus-5-5` runs the whole chain on Opus.

## What is built

Released in Fabula 0.3.0:

| Piece | Where |
| --- | --- |
| Motion films: `new_motion` and `set_narration`. A stand-in recording carries the narration or silence through the ordinary clean-cut path, so sound, captions, cache and render are unchanged. The stage is a cutaway throughout. | `mcp/server.mjs`, `scripts/job.mjs` (`motion_film`), `scripts/project-state.mjs` |
| Scenes and storyboard beats anchored in seconds, for films without words | `core/compose-engine.mjs`, `core/treatment.mjs` |
| The storyboard in `set_treatment`: spine, held frame, bans, words on screen and motion per beat | `core/treatment.mjs` |
| three.js 0.186, vendored, MIT | `renderer/motion/vendor/` |
| Shared project code: `write_motion_lib` writes `motion/lib/<name>.js`, which a scene loads with a `// fabula-libs:` line. A library change re-renders the scenes that use it. | `electron/motion-protocol.cjs`, `renderer/motion/runtime.js` |
| Scenes load what they use (`THREE.`, `gsap.`) without the placement naming it | `core/motion.mjs` `motionLibsOf` |
| The check pass. `write_motion` samples the scene every 0.2 s and reports text off the frame, outside the safe area, overlapping or too small, each with its seconds. Clip-path wipes are honoured. | `renderer/motion/runtime.js`, `scripts/frame.cjs` |
| Reel helpers: `fabula.shot` (shots in one document), `fabula.camera` (keyed, log zoom), `fabula.fit` | `renderer/motion/runtime.js` |
| The craft: three sizes of motion, storyboard before code, reels in one world, the defaults to break, three.js, scoring rounds | `docs/craft/motion.md`, `describe_motion` |
| More liberty under Free hand. Taste rules become advice; the check pass and the invariants do not. | `core/direction.mjs` |
| The assistant's `motion` task: storyboard, look, shared library, reels, checks, rounds, place, sound, draft | `scripts/assistant.mjs` |
| A worked film, *An orbit is a fall* (24 s, rendered at 1080p in 61 s) | `docs/craft/plans/an-orbit-is-a-fall/` |

## What is left

**Waiting on the window.** These touch `electron/main.cjs` and `renderer/main.js`, which the brand
session is editing:

- **New motion graphic** beside New video in the window. Its sheet takes a title, the shape, a
  length or a narration file, and a brief. It then starts the assistant on the `motion` task.
- **The storyboard gate.** The window shows the treatment's beats as a storyboard page. Under
  Guided, a sequence's storyboard waits for one click of approval before its reel is written.
- The window re-reads a scene when a project library it uses changes (today it watches only the
  scene documents).

**After that:**

- **Luna voiceover** for motion films: read Luna's `app.json`, call its `/api/generate`, hand the
  WAV to `set_narration`. Luna gives no word timings; WhisperX supplies them, as for recordings.
- **Named cues** dragged on the timeline (`cues.json`, `fabula.cue`). Seconds, the narration's words
  and `fabula.shot` cover the timing today; cues are the window's way to move a beat by hand.
- **The critic as a separate session** with the scoring rubric, on the maker's model.
- JPEG capture for opaque reels (about 1.4× faster), and motion blur on the master as an opt-in.

**Found by the showcase test** (the same brief made unattended by Sonnet 5.5 and Opus 5.5,
2026-10-07):

- A render can capture a chunk's first frame (0, 6, 12, 18 s) as the empty field, before the
  motion scene's draw reaches the capture. It is intermittent, and a fresh render clears it. The
  wait in `FabulaStage.settled()` needs to hold for the frame's own paint.
- The assistant cannot hear the music or find its beats. Both models assumed the beat grid from
  the tempo. Fabula needs a beat and onset tool that returns the hits in seconds.
- Both models tried to edit a scene in place before rewriting it whole. A `patch_motion`
  (find and replace in a document, then the check pass) would save turns on a long reel.
- `critique_film` reads the bed of a film with no voice as the voice and reports it off target.
- Fixed in 0.3.0: the bed in a film with no voice was levelled against silence and came out
  inaudible. It now plays at -16 LUFS.

## Rendering speed

A motion scene is captured at every frame, so a film that is all motion is the render's heaviest
case. Measured 2026-10-06 on this machine (WSL, Chromium on its software renderer because its GPU
process does not start here), per capture window. The render runs three in parallel.

| Scene | Stage | Draw | Capture | Per window |
| --- | --- | --- | --- | --- |
| `thrust` (the rockets film's scene) | 1920×1080, PNG | 30 ms | 100 ms | 7.7 fps |
| `thrust` | 960×540, PNG | 25 ms | 42 ms | 14.8 fps |
| A heavy test scene: 3,000 canvas points, 120 SVG nodes | 1920×1080, PNG | 42 ms | 110 ms | 6.6 fps |
| The heavy scene | 1920×1080, JPEG 92 | 32 ms | 74 ms | 9.4 fps |

In practice *An orbit is a fall* (24 s, SVG) rendered at 1080p in 61 s, and a 12 s three.js scene
drafted at half size in 25 s. The capture path does not need replacing. These numbers should be
measured again on the Windows install, whose GPU may change them.

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
