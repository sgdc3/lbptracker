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

`exact` on, which is what the page writes:

| carrier | share | events |
|---|---|---|
| pitch bend — the glide | 23.99% | 1,468,357 |
| CC 74 — the modulation | 19.74% | 1,208,711 |
| channel pressure — the volume | 17.00% | 1,388,002 |
| note on | 15.58% | 953,791 |
| note off | 15.58% | 953,791 |
| **`LBP-TRK` meta** — placement and cells | **5.18%** | 4,911 |
| **`LBP-TRK` `fix`** — verbatim records | **0.15%** | 47 |
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

`guid` · `instrument` · `gridY` · `level` · `pan` · `echoSend` · `reverbSend` · `key` · `scale` ·
`clips` · `name`? · `rest`? · `lane`? · `fix`?

The first nine are the placement — instrument, mixer row, level, pan, both sends, and the key and
scale that were folded into the note numbers. The last three are the interesting ones.

### What a DAW can edit, and what it cannot

Audited 2026-09-04 by making each edit to an exported file and re-importing it. **The rule that
came out of it: a value with a MIDI message of its own must not have a second copy in a meta that
wins.** Three fields failed that and were fixed; one cannot be fixed.

| edit | survives? | |
|---|---|---|
| rename the song | ✅ | the conductor's track name is the only source |
| **move a part to another row** | ✅ | it is in the track name; there is no MIDI message for a board row at all |
| **change a part's instrument** | ✅ | ⚠️ **could not be done** — a program change is 7 bits against a six-digit GUID. It is in the track name too, and `midiToSequencer`'s `instrumentGuid` resolver turns it back |
| change the tempo | ✅ | ⚠️ **was overwritten**; see §1 |
| transpose the notes | ✅ | `Key` is undone by subtraction, and a transposition composes |
| move the notes in time | ✅ | the cell list re-fits them; notes outside every declared cell open a new clip |
| **level, pan, both sends** | ✅ | ⚠️ **were ignored** — now CC 7, CC 10, CC 91 and CC 90 on the master channel, so a DAW plays the level's own mix instead of every part flat and centred, and a fader move comes back |
**All ten survive.** The one that took a scheme rather than a message is the last two rows:

### The track name is `row 4 - saw_wave`

Two of a placement's fields have no MIDI message at all — the board row, and the instrument, whose
GUID is six digits against a program change's seven bits (bank select could be abused into 21 bits,
but a DAW would then show "bank 1009, program 61", which is worse than honest). So both are in the
track name, which is the one thing about a track a DAW always lets you edit.

❗ **The label is cosmetic and a debugging aid; the meta is the carrier.** Everything the label
says is in the meta as well — `gridY` and, since 2026-09-04, the instrument's `instrument` name
beside its `guid` — and the label is read only to see whether it says something **different**.
Measured: every part-track name stripped from the corpus's exports, **62,158 clips of 62,158 still
correct**. A DAW that renames tracks to its own scheme changes nothing.

⚠️ **Carrying the name as well as the GUID is what makes that safe, and it closed a real hole.**
Before it, any resolver hit overrode the GUID — so a manifest that mapped `saw_wave` to a different
GUID silently changed the instrument on a file nobody had touched. Now the resolver is not even
asked unless the label disagrees.

Reading a *renamed* instrument back still needs the caller: only the `.rinst` manifest knows what
`piano` is, and `midiToSequencer`'s `instrumentGuid` is that map read backwards. Without one, or
with a name that resolves to nothing, the meta's GUID stands — because **a typo in a track name
must not silence a part**.

⚠️ **The label carries the INSTRUMENT, never `Track.name`.** The Thing's own label is empty on
every placement of all 22 corpus levels; putting it in the track name would hide the instrument on
the one placement that had one, and leave a rename with nothing to mean. It rides in the meta,
where nothing else claims it.

❗ **A label names two of a placement's eight fields, and half the corpus needed more.** `Ascetic`
has `row 0 - baiyon_drums_1` twice: the same kit on the same row at pan 0.60 with no reverb, and at
pan 0.30 with 0.20 of it — two placements to the game, one name to a track list. Measured
2026-09-04: **2,539 of 4,911 part tracks (51.7%) shared a label**, separated by level (466 groups),
pan (444), the reverb send (391), the echo send (195) and the key (10). A `#2`, `#3` index settles
it, and the index says nothing about *what* differs on purpose — the mixer is on CC 7, 10, 91 and
90 now, so a DAW already shows each track's fader and pan. The label only has to be something you
can point at. **51.7% → 0%.**

⚠️ A lane's track is `row 3 - saw_wave (2)`, and the suffix comes straight back off — the meta
says which lane it is, so what to strip is known exactly rather than guessed at with a pattern.

### One track per row — `mergeRows`

Off by default, and worth turning on for a DAW. **4,911 tracks become 3,222, a third fewer**: every
placement of one board row and one instrument goes on a single track, with one `LBP-TRK` meta each
and the mixer written as **CC automation at the tick each placement's own first clip begins** —
which is what a DAW does with a mixer that changes during a song.

❗ **It stays exact.** The import reads each controller *in force* at that tick and hands each note
to whichever placement declared the cell it falls in. Both are unambiguous because **no two
placements of a row group ever share a cell** — 0 of 62,158 across the corpus. Measured: 62,158
clips out, **0 came back wrong**, 181 patched against 177 unmerged.

⚠️ **Two of the 850 row groups have notes overlapping in time**, and there a player hears
whichever mixer setting came last. That is the whole cost, and it is why this is an option rather
than the default.

⚠️ **Two traps, both caught by the corpus rather than by reading the code:**

- **The mixer was read before `clips` was parsed**, so `part.cells` was still empty and every
  placement looked like it began at cell 0 — the second one on a merged track read the first one's
  pan and came back at 0.598 instead of 0.3. It reads `meta.clips` directly now.
- **"The value at that tick" is the wrong question; "the value in force" is the right one.** The
  exporter skips a controller whose value has not changed, so a placement whose pan matches its
  neighbour's writes nothing of its own.

❗ **The tracks come out in board order**, row ascending then cell then GUID. `gridY` is the Thing's
own y negated — `boardToGrid` computes `floor(-y / 105)` — so row 0 is the top of the board and
ascending reads top to bottom, the way the sequencer draws it. The rows run 0..24 and are never
negative. ⚠️ **The level's own order is not board order**: of the corpus's 149 sequencers,
exactly **one** already had its tracks ascending, so before this a DAW's track list was in whatever
order the Thing graph happened to store.

⚠️ **CC 90 is undefined in the specification, and that is why it was chosen.** A delay send has
no controller of its own anywhere in MIDI: 91 is reverb, 92 tremolo, 93 chorus, 94 celeste/detune,
95 phaser. **94 was tried first** — some synths read it as a delay depth — and dropped, because
many more read it as detune, and a value landing on the wrong one of those is audibly wrong rather
than merely ignored. 90 sits in the undefined block (85-90): a reader that does not know it ignores
it, and one that does gets the send. **Inert everywhere beats right sometimes and wrong the rest.**
That is a judgement, made deliberately — not a measurement — and it is recorded here as one so
nobody later mistakes it for a fact out of the game.

❗ **The mixer needs BOTH the controller and the meta, and a rule for when they disagree.** Seven
bits cannot hold the editor's steps: over 62,158 corpus placements, `level` is exact at 7 bits on
70.2%, `echoSend` on 96.4%, `reverbSend` on 80.5% and **`pan` on 8.9%** — the values are round
decimals (0.25, 0.35, 0.46). So the meta keeps the exact number and the controller wins only once
it stops agreeing with it, which is the same rule the tempo uses. An untouched file keeps 0.35; an
edited one gets the fader.

⚠️ **CC 7 carries `level` alone, not level times the channel volume.** Folding the mixer stage
in would make it un-invertible, and 308 of the corpus's 338 sequencers run one channel at a uniform
0.75 — a constant, not a balance.

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
| ~~the same notes in a different **order** inside the clip~~ | ~~325~~ **not carried** | 317 of them are in no order the music determines — `Ascetic` has a cell holding steps 64, 0, 96, 32 in that order. `sameNotes` treats two clips holding the same chains as the same clip |
| ~~a control point where nothing moves~~ | ~~509 notes~~ **0** | **yes, and it is now said in MIDI** — see below |
| a note whose own **records** differ | 90 | a ramp re-cut onto the staircase its own rounding makes (93 notes), and the resting bit on the 31 clips that are not uniform |
| a different **set** of notes in the cell | 87 | **no** — clips of a part overlap, so a note genuinely fits two cells and either answer puts it in the same place |

### A repeated value is a control point

✅ **The largest category came out of the patch and into MIDI, 2026-09-04**, and it paid for
itself twice over: the patch fell from **352 clips to 177**, `fix` from 82 kB to **34 kB**, and the
whole file from 24.38 MB to **23.97 MB**.

The rule is one sentence: **the resampler never sends the same value twice, so a message carrying
the value already in force can only be a control point.** A rounded ramp is a staircase, so
resampling naturally produces runs of equal values; suppressing them costs a receiver nothing
(sending 57 twice is a no-op) and it is what makes the repeat readable. The exporter then emits one
deliberate repeat wherever a control point sits in a flat run of three, and `simplify` never drops
a point the file stated outright.

⚠️ **Two traps, both found by the numbers moving the wrong way:**

- **Marking every stationary point** rather than only those inside a flat run cost **half a
  megabyte** over the corpus to save forty kilobytes of patch — 281,000 markers where 8,600 were
  needed. A point where a flat run meets a moving one is a corner and the simplifier keeps it
  anyway.
- **De-duplicating the event that OPENS a moving segment** took the patch from 352 clips to
  **1,077**. That event is a deliberate repeat too: it states where the ramp begins, which is
  usually where the plateau before it ended. A note that sat at 96 for two steps and then faded
  came back fading from its very first frame. `k === 0` is exempt.

❗ **Order WITHIN a chain still counts.** `sameNotes` splits on the end flag and keeps each chain's
bytes verbatim rather than going through `groupNotes`, because `makeNote` sorts a chain into
position order and a chain stored out of it puts its end flag somewhere else — which is a real
difference, not an authoring one. Records after the last end flag stay where they are.

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

⚠️ **The importer trusts the patch over the note events**, which is why `flattened`, `dropped`
and `dragged` describe what a **foreign reader** loses, not what a round trip loses.

The exporter earns it: it imports its own output and patches only what came back wrong. **177 clips
of 62,158, 34 kB.** Carrying every clip we could not *prove* would cost 22%.

## 3. Track name — meta type `0x03`

`PInstrument` has no name field worth printing, so without the caller's `.rinst` manifest a DAW
shows `row 4 - guid 148321` and nobody can tell it is the drum kit.
`MidiExportOptions.instrumentName` is the hook; this module fetches nothing.

⚠️ **`Track.name` is NOT always empty, and this file used to say it was.** Measured 2026-09-04:
**4,353 of the 62,158 corpus placements (7.0%) carry one**, though only **23 distinct strings** —
they are the editor's own defaults, `Synth: Ray Gun`, `Percussion: Acoustic Kit 1`. It is the
Thing's label, not the instrument's, so it rides in the meta and never in the track name. **7 parts
of 4,909 hold clips whose names disagree**, and their 84 clips came back unnamed until the meta
gained a per-clip `names` map.

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
