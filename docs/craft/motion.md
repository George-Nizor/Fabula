# Motion scenes: the craft

`describe_motion` is the contract — what a motion document may contain, the `fabula.*` helpers,
the rules the runtime enforces. This is the judgment: when a moment deserves motion, how to make
it land on the words, how a long piece stays one piece, and what goes wrong. It comes from making
films with it, and from how the best motion graphics are being made with models like you in 2026
(the sources are in `docs/motion-graphics.md`).

## Three sizes

- **A moment** inside a recorded film: a few seconds where a card would not do. The rest of this
  section is about when one is earned.
- **A sequence** inside a recorded film: twenty seconds to two minutes where the speaker goes and
  the film becomes motion graphics over its own sound. It belongs in a serious film (a documentary,
  an argument, an explanation) at the point its turn depends on something being seen working:
  how an orbit is a fall, how a vaccine teaches a cell, where the money went. One to three in a
  film; none in a vlog. Place it under a cutaway, `fade: false`, written as one reel.
- **A motion film** (`new_motion`): nothing but motion from the first frame to the last, timed to
  a narration or to a length. Everything below applies, at full strength.

## When a moment earns motion

A motion scene costs more than a card — to write, to check, and to render (it is captured at every
frame). Under Free hand this section is advice; under Guided it is how to spend one or two. Spend
it where movement IS the explanation:

- **A mechanism.** Gas goes down and the rocket goes up; a gear turns another; data moves through a
  pipeline. A card can name the parts; only motion shows them working.
- **A process with a shape in time.** A path drawn as it is travelled, a curve that bends, a
  quantity that grows and then collapses.
- **Scale.** The camera pulling back from the thing to the world it sits in. Nothing else says
  "this is small, and this is everything around it" as quickly.
- **The signature moment.** The one gesture only this film makes, where its turn lands. The
  treatment names it; it usually wants the biggest move in the film, and usually the whole stage.
- **Type choreographed to the voice**, when the words themselves are the picture — sparingly; the
  spoken word (`kinetic`) and the templates already do most of this.

Not for a point that is only words: a title, a callout or the head saying it does that better, and
motion around a sentence is decoration. Ask what the viewer would lose if the scene were a still
card. If the answer is nothing, it is a card.

## Storyboard before code

Every sequence and every motion film starts as a storyboard in `set_treatment`, written before
a line of the reel. It is the cheapest place to be wrong. Every film made in public with these
methods drifted from its first idea; the ones that came out well drifted from a written one.

- **The message as a claim.** "An orbit is a fall that keeps missing", not "orbits explained".
- **The spine.** The one continuity device the whole piece keeps: a single ball that falls, is
  thrown and orbits; a line that draws the whole film; a camera that never cuts. Everything else
  hangs off it. A piece without a spine is a slideshow with transitions.
- **Beats of 1.5 to 3.5 seconds**, each with the words on screen verbatim (`onScreen`), what moves
  and how it hands over to the next (`motion`), and where it lands: on a narration word or a
  second. A beat longer than about four seconds is two beats or a hold.
- **One held frame**, still on purpose, where the idea lands (`hold`).
- **Bans**: what this piece will not do (`bans`), so a later reel cannot drift back to the
  defaults. "No particles", "no 3D flips", "nothing enters from below".
- **A reference style named as a method** (`docs/craft/references.md`), never as adjectives.
  "Clean and modern" describes every generated film.

## One world: reels, shots and the camera

The motion people share as "stunning" is almost never a sequence of separate scenes. It is one
composition in which things transform: the dot becomes the planet, the planet's shadow becomes the
chart's first bar, the camera pulls back and the chart turns out to be a coastline. Write it that
way.

- **A reel is one document holding several shots** (`fabula.shot`). The shots share one world,
  built once in `setup`: the shapes, the type, the camera. A shot is render code over its own
  `s.t` and `s.p`; what it hands to the next shot is the state of the world at its last frame.
- **Carry, do not cut.** The last frame of a shot is the first of the next. If an element leaves,
  it leaves by becoming something, by going out of frame on a camera move, or by being covered.
  A crossfade between two unrelated pictures is the move of last resort.
- **One camera**, keyed in time (`fabula.camera`), eased at both ends, zoom in log space. Move
  between ideas by moving the camera across a world that already holds them.
- **Shared code across reels.** A film longer than one reel draws from one library
  (`write_motion_lib`): the palette helpers, the type scale, the shape system, the camera rig. Two
  reels that each define their own circle are two films.
- **Reel length**: 20 to 60 seconds. A single document much longer than a minute is where
  coherence breaks down; join reels where one hands over to the next, on a shared frame.

## The defaults you fall into

`describe_motion` lists them as `vocabulary`. They are worth knowing as habits, because each one
is the reason a generated film looks generated:

- everything entering by rising 30 px and fading in;
- one ease and one speed for everything, usually about half a second;
- everything moving at once, centred and floating;
- particle fields, glows, gradients and 3D flips standing in for an idea;
- text set at web sizes, in whatever face was nearest.

Doing the opposite on purpose is most of the distance between a demo and a film: entrances that
come from where the thing comes from, a slow beat three times the length of the fast one, one
thing moving at a time, the composition anchored to an edge, one accent colour on the one thing
that matters.

## three.js

Use it when depth, light or a camera moving through space IS the idea: a planet and its orbit, a
molecule, a city from above. Make the renderer in `setup` on your own canvas with
`preserveDrawingBuffer: true`, light it with a key and a fill, and set every position, rotation and
camera from `t`. Keep text in HTML over the canvas, where the check pass can measure it and the
film's fonts are. Keep geometry modest: every frame is drawn on the machine's CPU when it has no
GPU, and a film is thousands of frames.

## Land it on the words

The narration is the clock. `fabula.words` holds every word spoken over the scene, timed from its
start, and `fabula.word("thrust")?.t0` is the instant that word begins. Put every beat there, never
at a guessed second: a re-cut moves the words and the beats move with them; a guessed second stays
put and lands on the wrong word.

- **Arrive a hair early.** A thing that appears 0.1–0.3 s before its word is seen *as* it is said;
  one that appears on the word reads as late.
- **One beat per phrase, not per word.** A scene that reacts to every noun is a slideshow.
- **Hold what carries text.** After the last element lands, leave it still long enough to read —
  roughly its word count over three, in seconds — before the scene ends or moves on.
- Always give `fabula.word` a fallback second (`?.t0 ?? 2.4`), so the scene still plays in a
  preview that has no words, and say it in a comment.
- **A motion film without a narration** has no words: its clock is the storyboard's seconds and
  the music. Put beats on the bed's hits (listen to where it swells: `search_audio` describes
  tracks, and the sheet shows nothing of sound), and keep the beats in the storyboard and in the
  reel's `fabula.shot` list the same, so changing one tells you to change the other.

## Move like a camera, not like a slideshow

- **One camera move per shot**, eased at both ends (`fabula.ease.inOut`, `fabula.spring` for an
  arrival). A linear move reads as a machine, not a camera.
- **Solve the camera, do not blend it.** Blending two framings — close on the subject, wide on the
  world — passes through views where neither is in frame. In the first film the orbit's pull-back
  showed four seconds of nothing but planet. The fix was to hold the subject at a point on screen
  that glides from its close-up spot to where the final framing puts it, and solve for the camera
  that keeps it there as the scale falls away: the subject cannot leave the frame, and the move
  ends exactly on the wide shot.
- **Anticipation, action, follow-through** for anything that jumps or lands: a spring overshoots
  and settles; nothing arrives at full speed and stops dead.
- **Things that move need room.** An element that rises must not rise into the title above it; one
  that falls must not fall into the caption below. Check the extremes of every movement in the
  sheet, not just its resting place.

## Compose for the stage the scene is on

- **Under a cutaway** the scene owns the stage: paint its background, use the whole frame.
- **Under `full` or `pip`** the head sits in a corner above the scene. `ctx.head` says where, in
  the scene's own pixels: keep the composition on the far side of it, or frame it deliberately (an
  outline, an arrow, a speech bubble) — never half-cover it by accident.
- **In a `split` or `side` column** (`full: false`) the scene gets the content rectangle, not the
  stage: design for a column. The first draft of the three-ideas scene filled a third of its column
  and looked lost; fill the column, centre the block vertically, and size type from it (`vh` inside
  the frame is the frame's height).
- **Safe area:** 5% from every edge, and in a vertical film everything above 78% of the height —
  the burned-in captions sit below that line, and the platform's controls below them.
- **Type:** body text no smaller than 3vh of a full-stage scene, titles 6vh and up. Use the film's
  fonts (`var(--font-display)`, `var(--font-body)`).
- **Colour:** the theme's variables. `--accent` is for the one thing the viewer must look at;
  `--accent-2` is its partner (the other arrow, the flame); everything else is `--text` and
  `--muted` on the field.

## Every frame from t

The runtime enforces the rules (no timers, no clock, seeded noise), but the habit matters more:
draw each frame from `t` alone. A particle system is a function of each particle's index and
`t` — `age = ((t * speed + seed) % life) / life` — not a list updated frame to frame. A trail is
the path sampled from 0 to `t` each frame, not points pushed as you go. Frames are rendered out of
order, in parallel, and again after every edit; state kept between them is state that is wrong.

## Look, then look again

1. `write_motion` returns the check pass and a contact sheet. The check pass measures the scene's
   text every fifth of a second as it is drawn: off the frame, outside the safe area, two blocks
   overlapping, too small to read, each with the seconds it holds for. Fix every finding that is
   not marked brief before anything else; those are pixels, not taste. Then look at every tile:
   is the subject in frame, does anything collide at the extremes of its movement, is it
   beautiful?
2. **Judge it like a critic who did not make it.** For each shot, score it out of ten against the
   storyboard and the defaults above: does it read, does it move like one world, does it hold
   where it should. Rewrite every shot at seven or below; leave the nines alone. Two rounds at
   least, four at most: that is where the generated look goes away, and where returns stop.
3. Once the scene is placed, `preview_motion` draws it with the placement's own span and words
   (name the placement with `scene` when one document is placed twice). The timings are now real;
   look again.
4. `review_film` shows it in the rhythm of the whole film, and `film_sheet` shows what the render
   actually wrote. The first made film's render had a stretch where a cover vanished: only the
   film sheet showed it.

Rewrite the whole document with `write_motion` each time — it is small, and a partial edit you did
not look at is how a scene breaks.

## Worked: the rockets film

- **The orbit** (one document, two placements through `params.act`): "fall" — straight up, engines
  off on "off", gravity drawn on "gravity", back down with a landing ring on "down", head in a
  corner; "orbit" — the gravity turn on "sideways", the flattening on "horizontally", the solved
  pull-back from "falls" to "around", the ring closing and "That is an orbit." on "orbit", under a
  cutaway. The signature moment, and the note the person left ("make the orbit the moment people
  remember") answered by the one scene given the whole stage and the biggest move.
- **Thrust** (full, head bottom right): the rocket drawn large on the left, away from the head;
  exhaust particles seeded by index and aged from `t`, intensifying on "fires" and again on
  "speed"; the arrows on "down" and "up"; THRUST slamming in on the word.
- **Newton's third law** (split, the column): the rocket and a puff of gas; the action arrow on
  "action", the reaction on "reaction" — the same length, pointing apart. The first draft's rocket
  rose into its own title; the lift was halved and the rocket lowered.
- **Three ideas** (split with the head on the right): numbered rows, each arriving on its first
  word ("accelerate", "discard", "build"), the earlier ones dimming as the next arrives.

## Worked: An orbit is a fall

The first motion film made with the motion-film tools (2026-10-07): 24 seconds, no narration,
the Paper look, one reel. Its storyboard, shared library and reel are in
`docs/craft/plans/an-orbit-is-a-fall/`.

- **The spine** is one ball. It drops, is thrown, is thrown harder, and finally never lands; the
  horizon it lands on turns out to be the planet when the camera pulls back. Nothing in the film
  is not that ball, its paths or the ground.
- **The physics is real and computed once**, in the library: gravity towards the planet's centre,
  each throw integrated in `setup`, each frame reading a point along it. The orbit is the circular
  speed, not a drawn circle, which is why it closes exactly.
- **The camera is the argument.** Up to 8.3 s it holds still on a horizon that looks flat; the
  fourth throw leaves the frame and the camera follows it out in log zoom until the ground is a
  planet. The words say "the ground curves away" while the picture shows it.
- **Earlier throws step back** rather than vanish: each landed ball shrinks to a muted dot and its
  path turns dotted, so the frame keeps the evidence while the accent moves to the new throw.
- **What the loop caught.** The check pass flagged every caption as overlapping every other. That
  was a real fault in the check (lines waiting behind a clip-path wipe counted as visible), and it
  now honours `inset()` clips. The critique round caught widows ("further." alone on a line),
  fixed with `text-wrap: balance`. Rendered at 1080p in 61 s.
