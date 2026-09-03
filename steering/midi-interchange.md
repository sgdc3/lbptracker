# What our MIDI file carries — every side channel, and what it costs

Read before changing `src/core/midi.ts`, and before adding a field to `Sequencer` or `Track`.

A MIDI file can say *notes*. A music sequencer is a board of placements with a mixer, two sends, a
key, a scale and per-record automation, and most of that has no MIDI message at all. So the file we
write is two things layered: **the music, in ordinary MIDI events that any DAW plays**, and
**everything else, in text meta events that any DAW ignores**. This file is the inventory of the
second layer.

Why measurements in this file can be trusted: they come from `dev/verify-midi.ts` and a budget pass
over the corpus (10 levels, 149 sequencers, 953,791 notes, 62,158 clips, 1,448,224 records),
2026-09-03. The round-trip results themselves live in
[lbp-modding-toolchain.md](lbp-modding-toolchain.md).

## The budget — where 24.49 MB of corpus goes

`channelsPerPart`, `exact` on, which is what the page writes:

| carrier | share | events |
|---|---|---|
| pitch bend — the glide | 23.99% | 1,468,357 |
| CC 74 — the modulation | 19.74% | 1,208,711 |
| channel pressure — the volume | 17.00% | 1,388,002 |
| note on | 15.58% | 953,791 |
| note off | 15.58% | 953,791 |
| **`LBP-TRK` meta** — placement and cells | **5.18%** | 4,911 |
| **`LBP-TRK` `fix`** — verbatim records | **0.72%** | 160 |
| track name meta | 0.33% | 5,060 |
| **`LBP-SEQ` meta** — the sequencer | **0.12%** | 149 |
| tempo, time signature, end of track | 0.09% | 5,358 |
| RPN / MPE configuration | 0.02% | 1,341 |

**The side channels are 6.07% of the file.** Three quarters of that is the cell list, which is what
gives a level its board back.

## 1. `LBP-SEQ ` — one text meta on the conductor track

Meta type `0x01`, the tag then JSON. **Only what MIDI has no message for**:

`v` · `uid` · `swing` · `swingBaked` · `echoFeedback` · `echoTime` · `echoMix` · `reverb` · `loop` ·
`startPoint` · `numChannels` · `volumes`

✅ **Five fields left in 2026-09-03 because MIDI already says them**, and the rule they taught is
worth more than the 12 kB: **a duplicated field is a field that can disagree with itself.**

| was in the header | says it instead | why it had to go |
|---|---|---|
| `name` | the conductor's track-name meta | ❗ write the REAL name, empty or not — 10 of the 149 corpus sequencers have none, and a friendly default would rename them on the way back |
| `tempo` | the tempo event | ⚠️ **it was an actual bug**: exported at 120, re-tempoed to 174 in a DAW, imported at 120, because the meta won. Measured, not suspected |
| `bendRange` | RPN 0 on a **member** channel | ❗ not the master's, which is a different and smaller range — ours writes 2, and reading that one would flatten every glide by 24× |
| `mpe` | the MCM, RPN 6 on the master | already the fallback; now the only source |
| `stepsPerQuarter` | nothing | written and never read |

⚠️ **The tempo message stores microseconds per quarter, so it is not a float you get back.** 174
BPM reads as 173.99979, and the field would drift on every trip. The import asks which whole BPM
encodes to exactly the microseconds in the file and takes that one — not a guess, and all 149 corpus
tempos are whole (70..240). A genuinely fractional tempo keeps its fraction to within 1e-4 BPM,
which is the one thing this cost.

⚠️ `test/midi.test.ts` pins the field list. Adding a field to `Sequencer` and forgetting it here
fails there, rather than silently in a DAW six months later.

## 2. `LBP-TRK ` — one text meta per part track

`guid` · `name` · `gridY` · `level` · `pan` · `echoSend` · `reverbSend` · `key` · `scale` ·
`clips` · `rest`? · `lane`? · `fix`?

The first nine are the placement — instrument, mixer row, level, pan, both sends, and the key and
scale that were folded into the note numbers. The last four are the interesting ones:

### `clips` — the board layout, `[gridX, steps]` per cell

⚠️ **MIDI has no controller for "this note belongs to that clip"**, and a CC would be the wrong
tool anyway: seven bits, and a synth would act on it. A text meta is ignored by everything that
does not know it and exact for everything that does.

⚠️ **The cell alone is not enough — the LENGTH is what makes it recoverable.** On cells alone
**86.50% of the corpus's notes fit more than one clip**, because clips of a part overlap heavily
(a cell is 16 steps, a clip may hold 128). Adding each clip's own extent takes that to **0.09%**,
for one number per clip.

⚠️ **Emit every declared cell, including the empty ones.** 52 corpus placements hold no notes at
all — an instrument dropped on the board and never written in — and nothing else in the file can
bring one back.

### `rest` — byte 3's inert bit 6, per part, with a per-clip override

A third element on a `clips` tuple overrides the part's value. Omitted entirely when it is 1, which
is what the game's current editor writes and therefore what a file from a DAW should become.

⚠️ Inert to the engine and still a fact about the file: dropping it made **78% of clips** come back
different. Measured in [sequencer-data-model.md](sequencer-data-model.md).

### `lane` — which MIDI track of a part this is

A part whose own polyphony passes fifteen is written across several MIDI tracks; they carry the
same identity so the import merges them. It cost **2 extra tracks across the whole corpus**.

### `fix` — the records MIDI could not say, base64, by `gridX`

**What is actually in it**, measured 2026-09-03 with the patch turned off, 649 clips of 62,158:

| | clips | could MIDI say it? |
|---|---|---|
| the same notes in a different **order** inside the clip | 325 | **no** — 317 of them are not in any order the music determines; it is the order the author placed them in. The three measured sort keys already recover the rest |
| a different **set** of notes in the cell | 42 | **no** — clips of a part overlap, so a note genuinely fits two cells and either answer puts it in the same place |
| a note whose own **records** differ | 282 | mostly **no**: a control point the author wrote that sits exactly on the line between its neighbours produces no MIDI event, so nothing distinguishes it from its own absence |

✅ **One category came out of it and into MIDI.** A coincident pair's FIRST modulation used to be
dropped as authoring debris; it is not, because `voice+0x28` is read once at voice start for
`Params[0..2]` (per-layer detune, spread, random start) before any ramp runs. It now travels as two
CC 74s — one before the note-on, one after — which is what the engine does and what a synth wants.

⚠️ **What is left is not "MIDI could have said it and we chose a meta".** It is authoring order,
a genuine placement ambiguity, and control points that are inaudible by construction. A converter
that wants them has to carry them; one that does not want them should turn `exact` off and lose
nothing a listener can hear.


⚠️ **This is the only side channel that describes the notes rather than the placement, and it is
the only one that can go stale.** The others stay true however the music is edited. A patch names
records; edit the notes in a DAW and the import hands back the original clip instead of the edit.
`MidiExportOptions.exact` is the switch, on by default, and the page says what off is for.

⚠️ **The importer trusts the patch over the note events.** That is why shared mode comes back whole
even though its MIDI genuinely lost 1,742 glides — and why `flattened`, `dropped` and `dragged`
describe what a **foreign reader** loses, not what a round trip loses.

The exporter earns it: it imports its own output and patches only what came back wrong. 686 clips
of 62,158. Carrying every clip we could not *prove* would cost 22%.

## 3. Track name — meta type `0x03`

`PInstrument` has no name field worth printing and `Track.name` is empty on every placement of all
22 corpus levels, so without the caller's `.rinst` manifest a DAW shows `guid 148321` and nobody
can tell it is the drum kit. `MidiExportOptions.instrumentName` is the hook; this module fetches
nothing.

## 4. The ordinary MIDI, for completeness

| what | carrier | note |
|---|---|---|
| pitch, and the glide | note number + pitch bend | one channel per sounding note, so the bend is the note's |
| volume, and its ramp | note-on velocity + channel pressure | ⚠️ the OPENING volume rides on the pressure at the note's own tick, because MIDI has no velocity 0 and `Northern Lights` opens 96 notes there |
| modulation, and its ramp | CC 74 | the 4-bit nibble ↔ 7-bit controller map is exact over all sixteen values |
| the zone | RPN 6 on the master, RPN 0 for the range | MPE lower zone, master channel 1, members 2..16 |
| the grid | 480 PPQ, 4 steps to the quarter | ⚠️ 480 is what makes a third of a step exactly 40 ticks — triplets land on a tick instead of between two |

## What is NOT carried, and would need a new channel

Nothing, over this corpus — both modes read 0 records different. The two fields that would need the
patch on a level unlike any of the 22 are `timbre` bits 4-5 (the per-block table select) and a
volume above 127; both are zero in all 1,448,224 records, both ride in `fix` for free, and
`test/midi.test.ts` is the only place either is exercised.

⚠️ **The general rule, learned the expensive way**: the shape of an exact converter is not more
MIDI, it is a bigger side channel — but a side channel is only affordable if the exporter *checks*
rather than assumes. Every attempt to carry a category wholesale priced itself out (22% for the
records, 0.5% just for a per-clip flag written unconditionally); every attempt that carried only
the measured residue cost under 1%.
