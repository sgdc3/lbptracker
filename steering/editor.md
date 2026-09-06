# The editor — the sequencer as a thing you compose in

Read before touching `packages/lbp-tracker-web/editor.html`, `src/editor.ts`, `src/editor/*`,
`src/player.ts` or `packages/lbp-tracker-lib/src/song.ts`. This is how the editor is built and why;
what the game's data means is in [sequencer-data-model.md](sequencer-data-model.md) and the
architecture it sits in is [tracker-architecture.md](tracker-architecture.md). Started 2026-09-06;
what is not there yet is at the end.

## What it shows, and what the game shows

The in-game Music Sequencer is two grids. The **board** is the circuit board: cells 52.5 world
units wide and 105 tall, one instrument chip per cell, sixteen steps per cell — one bar at four
steps to the beat — and rows banded into mixer channels ([sequencer-data-model.md](sequencer-data-model.md),
*The timeline*). The **note grid** inside a chip is a piano roll where a note is a chain of
control points joined by straight lines: the game draws the dots at a size that is the volume and
in a colour that runs from blue to orange with the timbre, and the engine glides pitch and volume
linearly between consecutive points, so the straight line is what sounds.

The editor draws both, as faithfully as the data allows and no further:

- A chip is **one cell wide whatever its grid's length**, because that is how the board is laid
  out — clips of one part overlap on the timeline every two cells in `Ascetic`, each holding 128
  steps — and the grid's extent is a faint bar to the chip's right so the overlap can be seen.
- The chip's colour and glyph are **ours**, by instrument family (`src/editor/instruments.ts`).
  The game's icon is a texture this project cannot ship ([game-assets.md](game-assets.md)).
- A point sits at the **centre of the third of a step it names** (`rollX`), so the three thirds
  of a triplet spread across the step; a click anywhere inside a cell means that cell, and the
  "triplet grid" switch only decides whether the cells are steps or thirds. Both are the record's
  own resolution; the switch does not change what can be stored.
- The volume is the dot's radius (`pointRadius`, 0..127 → 0.18..0.5 of a row) and the timbre
  nibble its colour (`timbreColour`, a straight RGB blend from blue at 0 to orange at 15).
- The gate closes one step after the last point (`duration = lastStep − firstStep + 1`), so a
  faint tail of one step is drawn past it.

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
game's editor gives a placed instrument **4 bars** (64 steps) and lets it grow by **2 bars** at a
time — 6, then 8, the ceiling `x`'s seven bits allow — reported by the project's owner from the
game, 2026-09-06, not read out of bytes; `clipStepsFor` derives the smallest of 64, 96 and 128
that holds the notes. Over the corpus the highest `x` used is 31 in 60,318 of 105,785 clips, 63 in
the rest and never above 63: 4-bar grids filled half or all of the way, and none extended. On the
board the extent bar therefore runs four cells past a chip, and chips of one part placed every two
cells overlap in time, which is what `Ascetic` does. `resizeClip` refuses to shrink under a note.

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
edges. The geometry is pure (`src/editor/geometry.ts`, held by `test/editor-geometry.test.ts`).

`EditorState` (`src/editor/state.ts`) holds the song as a **plain object** and ticks a `version`
ref on every change; the Vue panels (`Inspector.vue`, `Palette.vue`) read through the counter and
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
Ctrl+Z restores the count; the palette places a piano at the cursor, the inspector's key select
writes `Key`, Ctrl+D duplicates into the next free cell, Delete on the board removes the chip.

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
