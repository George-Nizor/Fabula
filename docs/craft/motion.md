# Motion scenes: the craft

`describe_motion` is the contract — what a motion document may contain, the `fabula.*` helpers,
the rules the runtime enforces. This is the judgment: when a moment deserves motion, how to make
it land on the words, and what goes wrong. It comes from making films with it; the examples are
from the first one.

## When a moment earns motion

A motion scene costs more than a card — to write, to check, and to render (it is captured at every
frame). Spend it where movement IS the explanation:

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

## Move like a camera, not like a slideshow

- **One camera move per scene**, eased at both ends (`fabula.ease.inOut`, `fabula.spring` for an
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

1. `write_motion` returns a contact sheet across the scene. Look at every tile: is the subject in
   frame, does the type fit, does anything collide at the extremes of its movement?
2. Once the scene is placed, `preview_motion` draws it with the placement's own span and words
   (name the placement with `scene` when one document is placed twice). The timings are now real;
   look again.
3. `review_film` shows it in the rhythm of the whole film, and `film_sheet` shows what the render
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
