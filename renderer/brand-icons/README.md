# Fabula interface icons (brand v2)

`fabula-icons.js` draws them, `fabula-icons.css` moves them; the renderer's `icon()` in `main.js` is
the one door to them. Contact sheet: `docs/brand/icon-contact-sheet.png`
(`node test-tools/brand/icon-sheet.mjs` regenerates it).

```js
FabulaIcons.render("scissors", { size: 20 });                 // SVG string, aria-hidden
FabulaIcons.render("reel", { size: 20, hue: "stone" });       // a step at rest
FabulaIcons.render("done", { size: 16, label: "Done" });      // standalone, with an accessible name
```

Options: `size` (default 24; 16 and below draws the small tier, up to 24 medium, above full), `hue`
(coral, green, gold, teal, brick, stone; overrides the glyph's meaning hue), `label`, `tier`, and
`state: "playing"` for a one-shot motion moment. Output is presentation attributes and classes only
(no `style=`, no script), so it is safe under a strict Content-Security-Policy.

The renderer is the suite's algorithm (Discere's, as Forge3D has it): a flat drawing on a 48 grid,
a 2.3-unit ink outline, a stepped extrusion down and to the right in the hue's deep shade, no tile.

## Meaning hues

| Hue | Means | Used by |
| --- | --- | --- |
| coral (`#ED7088`, the fabula block of `brand/tokens.json`) | Fabula doing something | the four steps, the assistant, Make it into a video, play, render, rename, duplicate, send, save as brand |
| green | done, kept | finished phases, a kept selection |
| gold | waiting on you | alerts |
| teal | hands off to the system | open in the system player, show in the folder |
| brick (hue 45) | destructive or failed | remove, move to the bin, stop, a failed job. The suite's rose sits on Fabula's own coral, so danger turns toward orange here. |
| stone | at rest, not started | a step that is not the open one, phases still to come, skipped phases |

## The set

| Name | Replaces | Hue | Motion (`is-playing`) |
| --- | --- | --- | --- |
| `scissors` | step number 1, Cut selection | coral | the blades snip |
| `palette` | step number 2 | coral | |
| `scenes` | step number 3 | coral | |
| `reel` | step number 4, render buttons | coral | the reel turns once, when a render starts |
| `spark` | the Assistant button's line sparkle | coral | twinkles when a session starts |
| `wand` | (new) Make it into a video | coral | the star twinkles when the brief is sent |
| `play` | Play, Watch the draft, Watch it | coral | |
| `camera` | (new) New project, the drop zone | coral | |
| `phone` | (new) shorts | coral | |
| `badge` | (new) Save as brand | coral | the star pops |
| `pencil` | the rename line icon | coral | |
| `undo` | (new) Undo, Reset to preset | coral | |
| `hourglass` | the pulsing dot of an active phase or job | coral | none: the clock beside it is what moves |
| `clock` | the hollow circle of a waiting phase | stone | |
| `skipped` | the dash of a skipped phase | stone | |
| `folder` | the reveal line icon, Show in folder | teal | |
| `open` | Open | teal | |
| `copy` | Duplicate | coral | |
| `send` | Send | coral | |
| `page` | Show log | coral | |
| `refresh` | Refresh the clean cut, Render from scratch | coral | |
| `done` | the tick of a finished phase, Keep selection | green | the tick pops when the draft lands |
| `alert` | (new) the stalled-run note | gold | |
| `failed` | (new) a failed job | brick | shakes |
| `stop` | Stop the assistant | brick | |
| `trash` | the remove line icon, Remove | brick | the lid lifts |

Line utilities, `currentColor` on a 24 grid: `add minus close chevronDown search panelLeft panelRight
playSolid pauseSolid sun moon monitor`. The transport's play and pause stay solid glyphs on the
accent button, as a transport's should; the panel and theme toggles stay lines.

Kept as text on purpose: the insert marks in the transcript (`+`, `✓`, `…`) and the timeline's
kind glyphs on blocks too narrow for words, which are type set inside a line of words.
