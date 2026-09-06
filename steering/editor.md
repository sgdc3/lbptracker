# The editor — the sequencer as a thing you compose in

Read before touching `packages/lbp-tracker-web/editor.html`, `src/editor.ts`, `src/editor/*`,
`src/player.ts` or `packages/lbp-tracker-lib/src/song.ts`. This is how the editor is built and why;
what the game's data means is in [sequencer-data-model.md](sequencer-data-model.md) and the
architecture it sits in is [tracker-architecture.md](tracker-architecture.md). Started 2026-09-06;
what is not there yet is at the end.

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
- The chip's colour and glyph are **ours**, by instrument family (`src/editor/instruments.ts`).
  The game's icon is a texture this project cannot ship ([game-assets.md](game-assets.md)).
- A point sits at the **centre of its cell** (`rollX`), as the game draws it: the step, when the
  grid is whole steps and the point is on one; the third, when the grid is set to triplets or the
  point sits on a third. A click anywhere inside a cell means that cell; the "triplet grid" switch
  only decides whether the cells are steps or thirds, both being the record's own resolution.
  A note that belongs to the other grid is drawn through at 30% -- on the triplet grid one whose
  points are all on whole steps, on the whole-step grid one that uses a third -- still there and
  editable, just not what that grid is for.
  ⚠️ Every point sat at the centre of its *third* for a day — a sixth into the step on a whole-step
  grid, "all shifted left" — and then, briefly, on the grid lines; the owner settled it here.
- The volume is the dot's radius (`pointRadius`, 0..127 → 0.18..0.5 of a row) and the timbre
  nibble its colour (`timbreColour`, a straight RGB blend from blue at 0 to orange at 15).
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
nobody on this side wrote.

## The pages' player — `packages/lbp-tracker-web/src/player.ts`

The live page's scheduler moved into a class on 2026-09-06 so that the editor could play what it
edits without a second copy of it: every invariant in that file was paid for by a listener hearing
it broken, and the reasons travel with the code. `live.ts` is the page around it. The editor
calls it three ways:

| change | what happens | rebuilds the plan |
|---|---|---|
| a note, a placement, an instrument, a key, a scale, a send | `Player.load(sequencerFromSong(song), restart = false)` — the plan is rebuilt through `renderSequencer`'s voice pass and swapped in under the running transport, debounced 180 ms | yes |
| tempo, swing, channel count, a fader, the board's rows | `Player.setSettings` — the plan holds musical positions and a gain with the channel factor divided out | no |
| echo, reverb | `Player.setEffects` — one message to the worklet | no |

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

## Checking it

`?open=fixtures/levels/ascetic.lvl` on any page fetches a file the site serves and opens it
(`widgets/open-panel.ts`): a file input cannot be filled from a script, and every automated check
was stuck at the drop zone until this existed. The dev server serves `fixtures/`; the deployed site
serves only `fixtures/rinst` and `fixtures/smp`, so anything else 404s into the page's error line.

`window.__lbpEditor` exposes `state`, `player`, `board` and `roll`. Verified in Chrome 2026-09-06:
Ascetic's 1,150 clips open and plan; a chip click selects; a drag on empty space draws a two-point
glide and the plan rebuilds to 14,500 notes; play advances 32 steps in two seconds at 240 BPM;
Ctrl+Z restores the count; "add an instrument" places a chip at the cursor, the inspector's key select
writes `Key`, Ctrl+D duplicates into the next free cell, Delete on the board removes the chip.

**The row is the unit the roll follows.** `selection.row` — on opening, the row of the chip nearest the start of the song, with that chip selected — is lit across the
board; clicking a chip, a cell or a row number selects its row. As the song plays, the roll moves
to the chip the playhead *enters* on that row (`chipUnder` in `editor.ts`): by transition, not
by position, so a chip clicked while the playhead sits inside another holds until the playhead
crosses into a third. The owner asked for this on 2026-09-06: the game's grid is the row being
watched, and a composer follows one part at a time.

⚠️ **There is no instrument palette, and no "add" button.** Both existed for a day and the owner
had them removed. A chip is **drawn**: a drag across empty cells of a row makes one as long as the
drag — four bars at least, then two at a time (`snapClipSteps`) — and on release a modal asks
which instrument, with a text search (`InstrumentPicker.vue` inside a `<dialog>`,
`instrument-picker.ts`); dismissing it adds nothing. A double-click draws a four-bar chip the
same way. The inspector's sound select changes an existing chip's instrument. The
roll always shows the selected chip, and opening a song selects the chip nearest its start
(`EditorState.replace`) rather than the first in file order, which on `Ascetic` was a chip at
bar 175 that nothing on screen showed as selected.

## Not there yet

- **Writing back to a level.** The song leaves as JSON, as MIDI (`sequencerToMidi`), or by handoff
  to the live player; `sequencerFromSong` produces exactly the records a `PInstrument` holds, so
  the resource writer is what is missing, not the data.
- **`Loop` and `StartPoint`** are carried and edited but not played: the player runs a song from
  the top to the end plus the tail, as the live page does.
- Marquee selection is by points inside the box; there is no lasso across clips, no copy between
  clips through the system clipboard, and no MIDI input.
- The board is scrolled by hand while it plays only when the playhead leaves the view; there is no
  zoom on either grid.
