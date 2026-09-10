# The app — one page, one song, and the sequencer as a thing you compose in

Read before touching `packages/lbp-tracker-web/index.html`, `src/daw.ts`, `src/daw/*`,
`src/editor/*`, `src/player.ts` or `packages/lbp-tracker-lib/src/song.ts`. This is how the app is
built and why; what the game's data means is in [sequencer-data-model.md](sequencer-data-model.md)
and the architecture it sits in is [tracker-architecture.md](tracker-architecture.md). The editor
started 2026-09-06 and the five pages became one app the same day; what is not there yet is at
the end.

## One page, one song

❗ **There is one song open and every view works on it.** Until 2026-09-06 the tracker was five
pages — a bench, a live player, a renderer, a MIDI bridge and the editor — each opening its own
level and handing a song to another through `sessionStorage`, and the owner asked for a DAW
instead of disjoint menus. `index.html` is now the one page (its own styles in `daw.css`, imported by
`src/daw.ts` after `ui.css`; ⚠️ never a `<style>` block under the `<link>`, which the build left inline
while bundling the link after it, so the shared sheet won on the deployed site and not on the dev
server -- measured 2026-09-07, 0.2.1): a sticky top bar with the views'
tabs, the song's name, the transport (play, stop, loop, clock, tempo, volume and a VU meter)
and the file actions (new, open, save); "open" is a modal dialog holding the shared drop zone
and the picker for a level holding several sequencers; a fixed footer carries the status line,
the credit and the audio thread's readout (idle, notes sounding, audio load, dropouts; ⚠️ the load is
a share of wall time and reads lower on the Arrange view because its per-frame redraw keeps the CPU
clocked up -- measured, see `canTime` in `packages/lbp-tracker-lib/src/audio/mixer-worklet.ts`); and six
views, one shown at a time, all reaching the same song through `src/daw/session.ts`. Every card
has a "?" opening the one help dialog on its topic (`src/help.ts`): the views carry as little
prose as they can, and what they do carry is for the person using the app, never a measurement;
no em dash anywhere in it, by the owner's rule. The version in the status bar opens the same
dialog on `CHANGELOG.md` (repository root, imported raw), which is written for the same reader.
The views are:

| view | file | what it does with the song |
|---|---|---|
| Home | `index.html` only | a presentation of the app, reached by the brand in the top bar; a view like the others, so the song and the transport stay as they are |
| Arrange | `daw/arrange.ts` | the board filling the page (its scroller ending at the panel's top edge when the panel is open, so the horizontal scrollbar stays reachable) (a chip shows its sound's own line icon from `editor/icons.ts`, one per `.rinst` file, ours and not the game's art; the family glyph is the fallback), with a "+" strip under its last row for another and the selected row's number turning into an "×" under the pointer to remove it (no wider gutter for it), chips and row numbers lit for 260 ms as their notes start (found by scanning the song between two playhead positions, drawn every frame while playing), between the bar and the footer; the roll and the chip and point inspector in a panel that rises over the board's lower part when a chip is clicked or drawn (not when the playhead merely moves the selection), resizable by its top edge, closed by its button or Esc |
| Song/Mixer | `daw/mixer.ts`, `daw/MixerPanel.vue` | the song's name, tempo, swing, channels and faders, board rows, echo, reverb, loop — the song's own fields — in one card, and an "Engine" card with the switches that are not in the file (`controls/engine.ts`) and the meters, including the **master bus**, which is the one piece of DSP here that is not the game's at all (off by default, question 42 in [open-questions.md](open-questions.md)); the name in the top bar is read-only |
| Render | `daw/render-view.ts` | hands `sequencerFromSong(song)` to the render worker and plays the WAV back |
| Import/Export | `daw/convert-view.ts` | exports it as MIDI, re-run while the view is shown; a MIDI file in *replaces* it, through `openSong` |
| Keyboard | `daw/keyboard-view.ts` | the instrument bench, following the chip selected on the board |

`session.ts` owns the `EditorState`, the one `Player`, the instruments and their loader, the
plan (rebuilt through the renderer's voice pass on every note edit and swapped in under the
running transport), the status line and the audition path; the shell in `daw.ts` owns the tabs,
the transport and the files. ⚠️ **The Keyboard view keeps its own `AudioContext` and worklet**:
it A/Bs the engine against the browser's resampler and loads samples under its own ids, which
the song's player must not see. Each view's keys answer only while it is the one shown (Space
plays from anywhere but a field). The transport's keys are in the shell (`daw.ts`): Space plays and **pauses where it is**

(`player.stop` keeps the position; only the stop button rewinds), Home and Enter seek to the start

without stopping, End to `songEndSteps`, Ctrl+S saves. ⚠️ **No letters there**: the Keyboard view

plays notes on `Z S X D C V G B H N J M , L .`, so L for loop and M and S for the selected row's

mute and solo live in the arrange view's own handler, which answers only while it is shown.



❗ **The media keys go through `daw/media-keys.ts`, and they need a media element to arrive.** The

Media Session API hands the session to whatever the page is *playing*, and this tracker's sound

comes out of an `AudioWorklet`, which is not one: with Web Audio alone the browser gives the page

no session and a keyboard's play key goes somewhere else entirely. So a silent WAV -- written by

our own `writeWav`, no base64 in the source -- loops in an `<audio>` element for exactly as long

as the transport runs. ⚠️ It must not be muted and its volume must stay at 1: a browser gives the

session to *audible* media, and silence at volume 0 is not that. ⚠️ And `el.play()` needs a real

gesture, so it is only ever called from the transport starting; a synthetic click does not count,

which is why checking this in a driven browser needs a real pointer click rather than

`element.click()`.



The actions map to this transport: play, pause where it is, stop and rewind, and the two track

keys to the start and the end -- one song is open, so that is what a track is. `setPositionState`

gives the system's scrubber the song's real length; ⚠️ it throws on a duration of zero, which is

every song before its plan exists, so it is guarded and wrapped. The render worker no longer reads files or keeps a pile: the


❗ **Both playheads move every frame, from one continuous number.** The player ticks ten times a

second, which is fine for the clock and far too slow for a line: at 240 BPM a step is 62 ms, so a

playhead moved on the tick lurches a step and a half at a time. `player.stepAt` is continuous (it

divides the frames inside a step by that step's own swung length), and `arrange.ts`'s `smooth`

loop feeds it to the board and the roll on every `requestAnimationFrame`; the rest of `paint` --

which chip is under it, what to select, where to scroll -- stays on the tick. ⚠️ For a day the

roll was left out of that loop and only the board was smoothed. Measured on `Ascetic`: 211

updates each over 183 frames in three seconds, against the tick's ~30.



The **G** beside the volume is `optMaster` from the bar, reading and writing the same switch as

the Song/Mixer card, so the two cannot disagree; ⚠️ it is deliberately **not** given the accent

colour the loop button takes, because the accent in that bar means the song's own state and this

is the tracker's own doing (question 42).

song travels with the render request.

## What it shows, and what the game shows

The in-game Music Sequencer is two grids. The **board** is the circuit board: 105-unit square
tiles, a chip four of the game's 8-step bars long sitting on one, positions at half-tile
resolution (52.5 units, 16 steps — a "cell" here), and rows banded into mixer channels
([sequencer-data-model.md](sequencer-data-model.md), *The timeline* and *The tile*). The **note grid** inside a chip is a piano roll where a note is a chain of
control points joined by straight lines: the game draws the dots at a size that is the volume and
in a colour that runs from blue to orange with the timbre, and the engine glides pitch and volume
linearly between consecutive points, so the straight line is what sounds.

The editor draws both, as faithfully as the data allows and no further:

- A chip is **a rectangle as long as its grid** — one tile for four bars, half a tile more per
  two — with a translucent body for the rare chip that overlaps another (55 of 72,726 corpus
  neighbours); the selected chip is drawn last. The corpus's boards, chips two cells apart, come
  out edge to edge, which is what a composer sees in the game. A chip is grabbed by
  any cell it covers and keeps that offset while dragged; a double-click adds a chip wherever none
  is *anchored*, under another's tail included.
- **The board's selection is a set of chips, and the keys act on it as one.** `Selection.clips`
  holds the block; `clipId` stays the chip the roll shows and is normally in it. Shift+drag draws
  a rectangle and catches every chip it *touches* (`boardChipRect` and `rectsMeet` in
  `geometry.ts`, held by `test/editor-geometry.test.ts`), Ctrl with it adds, Ctrl+click or
  Shift+click puts one chip in or out, and a click on a chip of the block leads it without
  breaking the block. Dragging any chip of the block moves the whole of it by one shift, clamped
  so that no chip leaves the board (`clampClipShift` and `moveClips` in `song.ts`); Delete,
  Ctrl+C, X, V, D and A act on the block (`daw/arrange.ts`), one undo entry each, the board taking
  them when it has the focus or the note panel is closed and the roll otherwise. The chip
  clipboard is the board's own -- deep copies anchored at the block's top-left -- and a paste lands
  at the cursor, else right after the selection edge to edge, else where it was lifted from,
  moved right until no chip of it sits on a taken cell (`freeClipShift`), the board grown to hold
  rows below its last; a duplicate goes the same way, so a chip now duplicates to the cell after
  its end rather than one cell on. `test/song.test.ts` holds the block arithmetic. ⚠️ **The
  playhead's follow must not go through `selectClip`**: that collapses the block to one chip, and
  the playhead crosses a chip every few seconds. `followClip` moves the roll's chip and takes a
  *single* selection with it, as the selection always followed, while a block stays.
- **Whether the roll follows the playhead is a state, and the person owns it** —
  `EditorState.followPlayhead`, the switch in the panel head, and `test/editor-follow.test.ts`.
  Clicking a chip means "show me this one" and switches it off; choosing a row means "watch this
  row" and switches it on, as do opening a song, the button, and moving the roll back onto the
  chip the playhead is in. That last one is a **transition, not a position**: read as a position,
  the button could not be switched off at all while the roll sat on the playing chip, because the
  next frame put it back. It is the same decision `editor/follow.ts` records for the scroll, and
  it was made for the same reason. ⚠️ **Before this the follow was neither on nor off**, and both
  failures were reported from use: a chip clicked on the playhead's own row was shown until the
  playhead crossed into the next chip and then yanked away mid-edit, and a chip clicked on
  another row was overridden on the very next frame when a chip happened to be under the playhead
  there — and held forever when none was.
- **The chip's icon is the game's own, traced** (`src/editor/icons.ts`: 68 silhouettes of the

  textures the palette plans carry, regenerated by `tools/IconDump.java` and

  `tools/trace-icons.py`). **The colour behind it is the chip's own** — `PInstrument.Colour` out
  of the file, drawn as a translucent body with the border and the glyph in full
  ([sequencer-data-model.md](sequencer-data-model.md)) — and a sound with no icon falls back to a
  family glyph. A placement nobody has tinted shows the colour its instrument ships with, which
  is a colour per family, so a board reads by family without being told to; `drawnColour` is
  where white, the game's own neutral, turns into that.

  ⚠️ **`FAMILY_COLOURS` in `src/editor/instruments.ts` is a different palette and still ours**:
  eleven families where the game has seven, and softer. It is what the instrument **picker** and
  the inspector's glyph use, where there is no chip yet to have a colour. Landing on nearly the
  game's own assignment by eye — green percussion, red guitars, yellow keys — is how close the
  two are; whether the picker should simply adopt the measured colours is *50* in
  [open-questions.md](open-questions.md).

  ⚠️ **A set drawn from scratch was tried on 2026-09-07 and rejected** as worse to use; what the

  traced set costs is in the licensing note in [game-assets.md](game-assets.md), and the decision

  is the owner's. Keep the simplification light: the measurements are in the tool's header.

- A point sits at the **centre of its cell** (`rollX`), as the game draws it. A click anywhere
  inside a cell means that cell. **The "triplet grid" switch makes the cells thirds of a beat, not
  of a step**: a beat is four steps, twelve thirds, so the triplet grid has three four-third cells
  to the beat and is *sparser* than the whole-step grid (`TRIPLET_THIRDS` in `geometry.ts`) — the
  triplet positions 1⅓ and 2⅔ are the sub-steps 1 and 2 the corpus holds in equal measure. A
  note with a point off the current grid's cells is drawn through at 30% (`onGrid`), still
  there and editable. ⚠️ For a day the triplet grid was thirds of a step, three cells per step;
  the owner called it far too dense, and it was.
  ⚠️ Every point sat at the centre of its *third* for a day — a sixth into the step on a whole-step
  grid, "all shifted left" — and then, briefly, on the grid lines; the owner settled it here.
- The volume is the dot's radius (`pointRadius`, 0..127 → 0.18..0.5 of a row) and the timbre
  nibble its colour (`timbreColour`, a straight RGB blend from blue at 0 to orange at 15).
- **The line between two points carries both, so the eye reads the glide and not just its ends.**
  It is filled as a quadrilateral rather than stroked: its half-width at each end is that point's
  volume (`pointLineHalf`, 0.42 of the dot's radius, so the dots stay what a volume is read off and
  they cover the joints), and its fill is a gradient between the two points' timbre colours.
  That is not decoration: the engine ramps the modulation exactly as it ramps volume and pitch
  (the slide rates at `+0x2c` in [synth-engine.md](synth-engine.md)), so the ribbon's thickness and
  hue at any x are the volume and modulation that will sound there. A segment whose ends share a
  timbre — 96.1% of notes automate nothing — skips the gradient and fills flat.
- **What the row plays around the clip is drawn, through and untouchable** (`ghostWindow` in
  `geometry.ts`, held by `test/editor-geometry.test.ts`). A chip's grid is not the whole of its
  row's music: chips of one row overlap heavily — a cell is 16 steps and a clip may hold 128, and
  `Ascetic` places one every two cells — so the notes on either side of the one being edited
  belong to chips this grid does not show, and both joins were invisible. The roll draws every
  note of the row's other chips that reaches the window, shifted onto this grid, at `GHOST_ALPHA`.
  - **The two sides are deliberately not symmetric.** Before is one bar (`HEAD_STEPS`): enough to
    see what you are answering, and no more, or the grid would open somewhere in the middle of the
    row's history. After is *everything*, to the last note the row holds, rounded up to a bar —
    what comes next is what an author is writing towards. On `Ascetic`'s busiest row that is a
    4,992-step tail and 1,459 ghosts, drawn in 0.26–0.58 ms a frame because the list is computed
    once per song version and each note is culled against the visible thirds.
  - ⚠️ **The head is scrolled to, not scrolled past.** `scrollToNotes` deliberately does not add
    the head back to the scroll it computes: the clip's step 0 sits a bar into the content, so
    adding it would park the lead-in off the left edge, which is the whole thing it exists to
    save. The owner asked for it visible on open, and this is where that is decided.
  - ⚠️ **Measured rather than eyeballed**: at 0.45 a ghost's bluest pixel came back (54,116,210)
    against a real note's (66,140,255), which reads as a note; 0.28 gives (42,91,166), which reads
    as not yours.
  - ❗ **`RollLayout.head` and `tail` are drawn width and never grid length.** Positions stay the
    clip's own — negative across the lead-in — and only `rollX`, `rollStepX` and `rollThirdsAt`
    know the grid no longer starts at x = `keys`. Everything that asks how long the clip is (where
    a click may land, what `find the notes` may scroll to through `stepCount`) reads `steps`,
    unchanged. The ghosts are not in `clip.notes`, so no selection, drag or key can reach them,
    and the drawing is clipped to the two regions outside the clip so nothing untouchable is ever
    drawn over the notes being edited.
  - ⚠️ A click outside the clip's own grid now does nothing. `snapped` clamps, so it used to draw
    a note at the end (or the start) of the clip several bars from the pointer — already possible
    in the empty canvas right of a short grid, and the window would have made it easy.
- **The selection is a set of POINTS, not of notes** (`Selection.points`, a note id to the indices

  of its chosen points). Shift+drag draws a rectangle and it catches the points inside it;

  clicking a line takes every point of that note, which is how a whole note is still moved; Ctrl

  puts one point in or out, and Ctrl with the rectangle adds. ⚠️ **It was a set of note ids until

  2026-09-07**, and the rectangle took whole notes, so the tail of a glide could not be grabbed

  without its head -- which is most of what a chain of control points is for. The old rectangle

  also caught a note whose *line* crossed it (`segmentMeetsRect`, now gone): that rule was

  note-shaped and a rectangle over the middle of a held note now catches nothing, which is the

  honest answer, because there is no point there.

- **Moving a set of points needs its own primitive.** `pointShiftLimits` and `movePoints`

  (`song.ts`) shift chosen points together; ⚠️ clamping each against its immediate neighbour, the

  way `movePoint` does, **pins a group**, because the neighbour has not moved yet. The bound for a

  selected point is the nearest *unselected* point on either side, and the roll intersects the

  limits across every note in the selection before applying, so a chord keeps its shape against

  the clip's edge instead of sliding apart. `test/song.test.ts` holds both.

- The commands at the end of `RollView` are what the page's keys reach: `deleteSelection`,

  `nudge`, `adjust`, `selectAll`, `copy`, `cut`, `paste`, `duplicateSelection`, all of them one

  entry in the undo stack, and all of them over the selected points. Delete takes the points and a

  note whose last point goes with them goes too. `lift` and `insert` are the single copy path, so

  a duplicate and a paste cannot drift apart, and **a note contributes only its selected points**,

  so half a glide copies as half a glide. A duplicate lands one step past the selection and

  selects the copy; a paste with nothing selected goes back where the clipboard was lifted from.

  ⚠️ Ctrl+D is shared with the board, which duplicates the chip: the roll takes it only when the

  pointer is not over the board and something is selected, the same rule Delete uses.

- A note's end is its last point and nothing more: a one-record note is one point, a held note
  two joined by a line, as the game draws them. ⚠️ A faint one-step tail past the last point --
  where the gate does close (`duration = lastStep − firstStep + 1`) -- was drawn for a day and
  read as a second point that was not in the data; the owner had it removed.

## The model — `packages/lbp-tracker-lib/src/song.ts`

`Sequencer` and `Track` are what a level yields: immutable, with the file's record bytes beside the
decoded notes, and everything downstream reads that shape. The editor needs the opposite, so it
holds a `Song` of `Clip`s of `SongNote`s of `SongPoint`s — mutable, with stable ids for undo and
selection, positions in **thirds of a step**, the timbre as the 0..15 nibble.

❗ **The boundary goes through the game's own record encoding.** `sequencerFromSong` writes each
clip's records with `encodeNotes` (`packages/cwlib-ts/src/notes.ts`: the measured order — position
ascending, pitch descending, end ascending — and the resting bit) and then **decodes them again**
for `Track.notes`, so what the player schedules is what a level saved from this song would hold.
Measured 2026-09-06 over the ten-level corpus in `test/song.test.ts`: **62,158 clips through
`songFromSequencer` → `trackFromClip`, 61,774 byte-identical, 62,158 note-identical.** The 384 that
differ in bytes are the author-ordered ties and the clips with mixed resting bits that
[midi-interchange.md](midi-interchange.md) covers with a bitmap; none differs in a note.

⚠️ **A clip's grid length is not in the file.** `PInstrument + 0x60` is copied into the engine's
clip as its length in steps and nothing serialises it ([open-questions.md](open-questions.md)). The
game's editor gives a placed instrument **four bars** and lets it grow by **two** at a time
(reported by the project's owner from the game, 2026-09-06), and the corpus fixes the bar at
**8 steps** — the chip spacing and note extents in *The tile* of
[sequencer-data-model.md](sequencer-data-model.md) — so `clipStepsFor` derives the smallest of
32, 48, 64 … 128 that holds the notes, 128 being the ceiling `x`'s seven bits allow. ⚠️ **The
first reading of "four bars" was 64 steps**, a bar taken as a 16-step cell: on that rule 64,483 of
72,726 corpus chips overlap their neighbour, against 82 with the 8-step bar and 55 in the data.
`resizeClip` refuses to shrink under a note.

The project file is JSON — `{ format: "lbptracker-song", version: 1, song }` — as decided at the
start; `songFromJson` checks the shape rather than trusting it, because a file is the one input
nobody on this side wrote. ❗ **Every page reads and writes it, not only the editor**: the drop
zone of all four goes through `readOpened` in `open-level.ts`, where a single `.json` comes
back as a level of one sequencer, and the song picker on each carries a "save .json" button
(`saveSongFile` in `song-file.ts`) — so a sequencer found in a level on the renderer can be saved
and opened in the editor, and a song from the editor plays on the live page. The editor alone
opens the file as the song it holds, ids and grid lengths intact, rather than through the
sequencer.

## The pages' player — `packages/lbp-tracker-web/src/player.ts`

The live page's scheduler moved into a class on 2026-09-06 so that the editor could play what it
edits without a second copy of it: every invariant in that file was paid for by a listener hearing
it broken, and the reasons travel with the code. `daw/session.ts` holds the one instance and
calls it three ways:

| change | what happens | rebuilds the plan |
|---|---|---|
| a note, a placement, an instrument, a key, a scale, a send, inside chips the plan already has | `Player.retrack(index, trackFromClip(clip), …)` — the changed chips are found by a print of each audible chip kept since the last plan (`session.ts`), each is planned alone as a one-track sequencer and every voice of it swapped into the plan — the ones before the look-ahead frontier too, which the scheduler is kept past (`repoint`) so nothing posted is posted twice — debounced 60 ms; measured 2026-09-07 on Ascetic: 5 ms and no voice posted twice, against 50–100 ms and the window's voices doubled for the whole plan. More than six chips at once, or an audible chip added or removed, is the whole plan again | one track |
| a chip added, drawn, duplicated, removed, muted or soloed | the plan's voices carry the chip's id (`Planned.track`, the keys `load` is given), so `session.ts` sorts a change into chips gone (`Player.dropTracks`, one pass over the plan, any number) and chips to put in or swap (`Player.retrack`, one each); measured 2026-09-07 on Ascetic: a chip added while playing is one 3.5 ms retrack and no whole-plan pass, a row of 97 chips muted is one drop. More than eight chips to plan at once (a row of many unmuted, an undo across the board) is the whole plan again. ⚠️ **Every voice of a chip gone goes, handed over or not.** Keeping its voices up to the frontier, so that the plan "still held what the worklet had been given", kept them for good and the plan was no longer the audible song: a solo pressed while the song played held from the frontier on, and a seek back played the muted rows again up to it — measured 2026-09-09 on Ascetic, solo at step 32, 70 stale voices kept and 53 of them posted after a seek to 0; a looped section did the same every time round. Not posting twice is `repoint`'s job, by the frontier, not the filters'; the voices already in the worklet finish as they were going to, and the pool's replay forgets them with the plan | one track each |
| the whole plan, when it comes to that | `Player.load(sequencerFromSong(song), restart = false)` — the plan is rebuilt through `renderSequencer`'s voice pass and swapped in under the running transport, debounced 180 ms; `nextIndex` lands after the furthest step already handed over (`handedUntilStep`), never at the playhead, so nothing in the look-ahead window is posted twice | yes |
| tempo, swing, channel count, a fader, the board's rows | `Player.setSettings` — the plan holds musical positions and a gain with the channel factor divided out | no |
| echo, reverb | `Player.setEffects` — one message to the worklet | no |
| a loop: the song's own, or a chip's section from the note panel | neither is a seek at the end (the pump ticks every 100 ms and posts 350 ms ahead, so that restarted late and spilt the next bars at every turn): the clock runs on unwrapped, `position()` folds it into the section, and each pass posts its voices at frame + pass × length, pool step + pass × steps, tag + pass × 2²⁴. Measured 2026-09-07 on Ascetic: every voice at its expected frame to the sample, passes exactly 96,000 frames apart, none outside the section. A section is whole cells, so its step count is even and the swing lines up between passes | no |

❗ **`boardRows` travels with the mixer settings.** `channelVolume` bands rows into channels only
when it is given the board's height and falls back to a modulo without it; the plan's gain was
divided out under the bands, so putting a modulo factor back re-routes the rows of a
multi-channel song. The live page did that until the player moved (`Player.mixerNow`).

**Auditioning** goes the same way: a placed or clicked note becomes a one-track `Sequencer` with the
song's own settings and the clip's own row, key, scale and sends, planned through
`renderSequencer` and posted at once with a tag below zero (`Player.audition`). A note heard in the
editor is the note the song will play — same slot, same envelope, same stack.

## The two canvases

`src/editor/board.ts` and `src/editor/roll.ts` are canvases and not Vue, per
[tracker-architecture.md](tracker-architecture.md): a board of 1,150 chips and a grid of 128 rows
by 128 steps with a playhead thirty times a second is not a `v-for`. ⚠️ **The roll's canvas is the
size of its viewport, not of the grid** — 3,000 by 1,700 pixels, twice that on a dense screen —
`position: sticky` in a scroller whose spacer sets the scroll size, painting the visible window
offset by the scroll, with the keyboard and the ruler painted over the content at the canvas's own
edges. **The board works the same way** since the owner asked for its bar and row numbers to stay
put while it scrolls (`Ascetic` is 15,000 pixels wide); its scroller is resizable in height by
its corner handle (`resize: vertical`) and fixed in width. The geometry is pure (`src/editor/geometry.ts`, held by `test/editor-geometry.test.ts`).

`EditorState` (`src/editor/state.ts`) holds the song as a **plain object** and ticks a `version`
ref on every change; the Vue panel (`Inspector.vue`) reads through the counter and
write through `state.edit`. Undo is a structured clone per edit, coalesced by key so a slider drag
is one step; a drag is one entry taken at `beginDrag`.

The pointer's vocabulary is in the hint under the grid and in `roll.ts`'s header. ⚠️ Pointer
capture goes through `src/editor/pointer.ts` because `setPointerCapture` throws for a pointer the
browser is not tracking — a synthetic event, which is what a scripted check dispatches.

⚠️ **The focus ring goes on the canvas, never on the scroller around it**, and both halves of the
reason are easy to re-introduce. The canvas is `position: sticky` with `z-index: 1`, so it paints
over its parent's outline — measured: an 8-pixel outline on the scroller is invisible, the same
outline on the canvas draws all four edges. And the canvas is sized from `clientWidth`, an
**integer**, so on a display at 125% it falls a fraction of a pixel short of the box it covers, and
the parent shows through on exactly two edges. Together they turned the ring into a green sliver
down the right and along the bottom. ⚠️ And it appeared on a *mouse* gesture at all because
**Chrome counts holding Shift as keyboard use**: shift+drag, the board's marquee, matches
`:focus-visible`. `data-pointer` on the root element (set in `daw.ts` on `pointerdown`, cleared on
`keydown`, both in the capture phase) is what tells the four grids' rings apart from a Tab.

⚠️ **A `window` keydown handler must ask `focusOwnsKeys` first** (`src/keys.ts`). Three of them
answer at once — the shell's transport keys, the arranger's editing keys, the Keyboard view's notes
— and each used to test `INPUT|SELECT|TEXTAREA` and nothing else, which left every modal dialog
exposed: the song picker sits in one, so selecting a song's name and pressing Ctrl+C copied the
board's chips. Every dialog here is `showModal()`, so `dialog[open]` is the whole test. The
arranger additionally hands Ctrl+C and Ctrl+X back to the browser when text is selected — a canvas
cannot be part of a document selection, so a selection that is not collapsed is always real text.

## Checking it

`?open=fixtures/levels/ascetic.lvl` on any page fetches a file the site serves and opens it
(`widgets/open-panel.ts`): a file input cannot be filled from a script, and every automated check
was stuck at the drop zone until this existed. The dev server serves `fixtures/`; the deployed site
serves only `fixtures/rinst` and `fixtures/smp`, so anything else 404s into the page's error line.

`?level=<40 hex digits>&seq=<uid>` is **the site's shareable link to a song**, and the whole of
what a URL may say is in `src/link.ts`. `level` opens a published level out of the Internet Archive
by its root hash, exactly as pasting that hash into the archive box does; `seq` picks one sequencer
out of the level by its uid (`file#uid` when a backup repeats a uid across levels, which
`sequencersOf` warns about); `deep=1` turns the dependency walk on -- off by default, box and link
alike, since on most levels it buys duplicate rows and seconds, and the measurement is on `open_`
in `archive-panel.ts`. The address bar is written back to as the reader opens a level and picks a
song, so the URL is always the link to what is on screen (`replaceState`, never `pushState`).

⚠️ Two traps, both paid for once: `rememberLevel` runs *before* the level is read, so it must keep
`seq` when the hash is unchanged and drop it when it is not — wipe it unconditionally and a link
can never reach the song it names; and `seq` is written only when `level` is in the URL, since a
level opened off this machine has no shareable name. Both values are validated before use — the
hash reaches a fetch URL, the uid a map key.

The picker carries **copy the link**, beside the search box and only for songs that have one:
`state.linkable` follows each open, and only a level fetched from the archive can be linked to, so
a level off this machine shows no button rather than a dead one. ⚠️ Two traps: the copy goes
through `navigator.clipboard` and falls back to `execCommand('copy')` — the first is denied
outright in some embedders (measured in the in-app browser, where the second one works) — and a
refused copy is not an error but a URL shown in a field for the reader to take by hand. The URL
also stops claiming a level as soon as one is opened from anywhere else: `Opened.archive` says
where a pile came from and `forgetLevel` clears the three parameters otherwise, or the button
would offer a link to a song nobody is looking at.

A `?level=` link with no `seq` puts the picker up when the level holds more than one song
(`openLevel` in `daw.ts`), rather than opening the biggest and hiding the rest behind a button the
reader has no reason to press; the rows carry the uid beside the name and the search box matches it
from the start of the number (`matches` in `widgets/picker-state.ts`), so the number in a link
leads back to its row.

A level takes seconds to arrive and none of it used to be visible: the archive panel and the drop
zone both say what they are doing *inside* `#fileDialog`, which a `?level=` link never opens. Every
route now runs a job on the one loader (`src/widgets/loading.ts`), and it is a modal `<dialog>`
because the picker is one too: an ordinary overlay renders under the top layer whatever its
`z-index`. Jobs nest — the archive fetch holds one while the read of what it brought back starts
another — and the newest is the one shown.

`window.__lbpEditor` exposes `state`, `player`, `board`, `roll` and `showView`. Verified in Chrome 2026-09-06:
Ascetic's 1,150 clips open and plan; a chip click selects; a drag on empty space draws a two-point
glide and the plan rebuilds to 14,500 notes; play advances 32 steps in two seconds at 240 BPM;
Ctrl+Z restores the count; "add an instrument" places a chip at the cursor, the inspector's key select
writes `Key`, Ctrl+D duplicates into the next free cell, Delete on the board removes the chip.

❗ **Every path that touches the plan ends on `showPlanSummary`** (`daw/session.ts`). The

one-track sync posts the same progress events as a full rebuild, and one track never reaches the

second report, so the status line was left reading `preparing: voices 0%` after every note edit

until something else wrote to it. The summary is rebuilt from the song rather than restored, so

the note count follows an edit; the two numbers a sync cannot know -- notes dropped for want of

an instrument, and the song's length -- are kept from the last full build, which is the last time

either could have changed.



**The song ends where its last chip's grid ends, or where the end was dragged to**
(`songEndSteps`; `Song.endSteps` holds a dragged end, in whole cells, 0 meaning "the last
chip"), marked on the board with a grip and the area beyond shaded; the marker drags to make room
past the last chip and snaps back to "the last chip" when dragged onto it. **A new song starts
with an end of its own**, two tiles out (`NEW_SONG_END_STEPS`): with no chip to take an end from
it had none, and a board with no marker on it gave the composer nothing to lay a song out against
and nothing to drag. The transport stops
there — without the render's six-second effects tail,
which the transport does not need: it stops the clock and not the audio, so the echo and the
reverb ring on. The notes' own end, `songLengthSteps`, is what the sequencer's `lengthSteps`
carries.

**Mute and solo are per row and are the listener's, not the song's.** The game has neither, so
they are kept on `EditorState` and never written to the song file or the MIDI; they decide which
rows reach the player's plan and the render (`audibleSequencer` in `daw/session.ts`), a solo
anywhere outranking every mute. The boxes sit in the board's gutter beside the row number.

**The row is the unit the roll follows.** `selection.row` — on opening, the row of the chip nearest the start of the song, with that chip selected — is lit across the
board; clicking a chip, a cell or a row number selects its row. As the song plays, the roll moves
to the chip the playhead *enters* on that row (`chipUnder` in `daw/arrange.ts`): by transition, not
by position, so a chip clicked while the playhead sits inside another holds until the playhead
crosses into a third. The owner asked for this on 2026-09-06: the game's grid is the row being
watched, and a composer follows one part at a time.

⚠️ **There is no instrument palette, and no "add" button.** Both existed for a day and the owner
had them removed. A chip is **drawn**: a drag across empty cells of a row makes one as long as the
drag — four bars at least, then two at a time (`snapClipSteps`) — and on release a modal asks
which instrument, with a text search (`InstrumentPicker.vue` inside a `<dialog>`,
`instrument-picker.ts`); dismissing it adds nothing. A double-click draws a four-bar chip the
same way. The inspector's sound select changes an existing chip's instrument, and a chip
that was still wearing its old instrument's own colour takes the new one's. **The tint itself is
the swatch under the two sends** (`<input type="color">`, with a button back to the instrument's
own colour); it writes the `look` change kind, which marks the song dirty and redraws but tells
`daw/session.ts` to leave the plan alone — rebuilding one for a colour would cut the voices the
chip is sounding. The
roll always shows the selected chip, and opening a song selects the chip nearest its start
(`EditorState.replace`) rather than the first in file order, which on `Ascetic` was a chip at
bar 175 that nothing on screen showed as selected.

## Not there yet

- **Writing back to a *level*.** The song leaves as a song file, as MIDI, as a WAV and — since
  2026-09-09 — as a **`.plan`**, which is the popit object a creator drops into their own level
  ([export-to-game.md](export-to-game.md), the Import/Export view's second section). Writing a
  whole `LVLb` back is a different job: `readLevel` is deliberately a prefix, and a level writer
  needs all of `RLevel`.
- **`Loop` and `StartPoint`** are carried and edited but not played: the player runs a song from
  the top to the end plus the tail, as the live page does.
- The roll's marquee is by points inside the box and the board's by the chips it touches; neither
  clipboard goes through the system's, so nothing copies between two open songs, and there is no
  MIDI input.
- The board zooms in time only (`ZOOM_LEVELS` in `editor/board.ts`, the corner cell's "-", glass and
  "+", the step at the view's left edge kept where it is, the level in localStorage); the roll has no
  zoom, and neither grid zooms vertically.
