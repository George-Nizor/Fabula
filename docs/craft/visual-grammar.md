# Visual grammar: what goes with what is said

The kit has fixed shapes (`describe_kit`) and named templates (`describe_templates`). This is
the lookup from *what the speaker is doing* to *what to put on the stage* — the mapping
`read_story` uses for its first suggestion, written out so the second and third choices are
visible too. Landscape and vertical differ in what fits, so both are given.

| The speaker… | First choice | Also | Layout (wide) | Layout (tall) | Notes |
| --- | --- | --- | --- | --- | --- |
| says a number | `stat` | `big-number`, `trio`, `progress` | side | side | One number, one label. The context line goes on `big-number`. |
| gives several numbers | `chart` | `trio`, `split` | side / full | band / cutaway | Four bars at most in a tall frame; three numbers read better than six bars anywhere. |
| lists things | `list` | `steps`, `ranking`, `teaser` | side | side | Five items in a wide frame, three in a tall one. `ranking` when the order is the point. |
| compares two things | `compare` | `before-after`, `scale`, `split` | side / full | cutaway | `compare` is two lists; `before-after` is two states; `scale` is a judgment. |
| describes a change | `before-after` | `progress`, `timeline` | full | cutaway | The sweep is the change. |
| explains how something works | `flow` | `steps`, `custom` diagram | cutaway | cutaway | Let it build with the explanation: split one flow into two scenes if the speaker takes their time. |
| places things in time | `timeline` | `headline`, `section` | cutaway | cutaway | Three to six moments. A single date is a `headline` or a callout, not a timeline. |
| asks a question | `question` | head alone, `kinetic` | side / focus | focus | Do not answer on screen before the speaker does. |
| defines a term | `definition` | `callout`, `word` | side | side | Term, kind, meaning. A term used once does not need a card. |
| reads out what someone said | `quote` | `post`, `phone` | side | side | `post` for a comment or message; `phone` for an exchange. Say whose it is. |
| makes an absolute claim | `word` | `myth-fact`, `kinetic`, `hook` | cutaway / full | cutaway | The big word is a beat, not a title. Once or twice a film. |
| warns | `alert` | `callout`, `myth-fact` | side | side | The level says how serious. |
| names a product, tool, person, place | `image` | `logos`, `cover`, `clip` | side / pip | side / band | Fetch the real thing (`search_images`, `fetch_image`) and credit it. Do not draw a logo. |
| describes something that happened, or that moves | `clip` | `image`, head alone | side / cutaway | side / cutaway | B-roll the person has (`import_clip`): the thing itself, muted, while they tell it. A cutaway when the footage is the picture; beside the head when they are the subject. |
| shows something typed | `code` | `keys`, `screen` | cutaway / side | cutaway | The screen track if the recording has one; otherwise the lines themselves. |
| changes subject | `section` | `cover`, `headline`, head alone | full / cutaway | cutaway | A mark the viewer can feel. |
| opens the film | `hook` | `title`, `cover`, `teaser` | focus + title | cutaway | The promise, then what is coming. |
| closes the film | head alone | `kinetic`, `word` | focus | focus | The last line is the viewer's. |
| asks the viewer to do something | `cta` | `callout` | — | cutaway | Shorts only. |
| tells a story | head alone | `image`, `clip`, `cover` | focus | focus | A story wants the face. Put the picture where the story names a thing. |
| says nothing visual for a while | head alone | punch-in, `callout` | focus | focus | The head is a choice. Mark the passage with a punch-in or one callout, not a card per sentence. |

## The layouts, as an editor uses them

- **focus** — the default and the most common frame in a good film. The head is the picture.
- **side** — a card next to the head (wide) or under it (tall). For a card the speaker is
  talking *about*. The head stays because the speaker is still the subject.
- **pip** — the head in a corner while the card is the picture. For something the viewer
  must study: a chart, a screen, a photograph.
- **band** — tall frames only, in practice: the whole recording, uncropped, with the card
  under it. For the moment a crop would ruin.
- **full** — the card owns the stage, a small camera keeps the person present. For a section
  mark or a big diagram where the head still belongs.
- **cutaway** — no camera. The visual carries the narration. For a diagram or a picture that
  needs the whole frame and the whole attention. Cover its entire span; the warnings say when
  you have not.

## The templates, by shape

Full-stage (pair with `cutaway` or `full`): `hook`, `word`, `trio`, `timeline`, `flow`,
`before-after`, `myth-fact`, `code`, `ladder`, `scale`, `headline`, `cta`, `teaser`,
`ranking`, `phone`.

Column (sit in `side`, `pip` or `full`'s content rect beside the head): `big-number`,
`definition`, `keys`, `progress`, `alert`, `receipt`, `post`, `split`, `question`. In a tall
film "beside the head" is the strip under it, about a quarter as tall as it is wide, and a
column template sizes itself for that strip; a `question` there is a line, not a poster.

Any template takes `full: true|false` to override its default, but a full-stage design
squeezed into a column or a column card blown up to the stage rarely reads well. `over: true`
draws a custom graphic over the head rather than under it; only `thumbnail` and `cta` (with a
`shade`) are made for that — a few words on the face, the opening or the ending of a short.

## Two frames, one plan

A tall frame is a phone. The head fills it; there is no column beside the head; text sits in
the lower third; the platform's own controls take the bottom eighth, and the captions sit just
above them. Every template lays
itself out for the shape it is rendered in, and the layouts resolve differently
(`describe_kit` says how). What does not change by itself is what you *write*: a title of nine
words in a wide frame is a title of four in a tall one, a chart of six bars is a stat of one
number, a compare of five items a side is a before-after. The pacing read says when a scene is
over its frame's budget.
