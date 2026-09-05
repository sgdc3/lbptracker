# The LBP modding toolchain — what exists, what it covers, how to use it

Read before writing any parser for an LBP resource or archive, and before attacking an open
question that touches the **save format** (as opposed to the runtime engine). Someone has already
done a large part of this work in the open.

## The project — and who wrote which half

`https://github.com/ennuo/toolkit` — "Craftworld Toolkit". Java, **MIT licensed**, ~770 files.
Two parts matter to us, and **they have different authors, which changes how much weight each
carries**:

- `lib/cwlib/` — **ennuo's**. Hand-written serialisers for LBP resource types and Thing parts,
  each carrying field order, per-field revision gates and defaults. A decade of community use
  behind it. This is the part worth treating as a serious independent reading of the format.
- `tools/sequencerdump/` — **this project's own author wrote it** (fork at
  `https://github.com/sgdc3/toolkit`, local checkout at `C:\Users\sgdc3\Desktop\LBP\toolkit\`).
  It walks a level or `.plan`, finds every **music** sequencer, and exports to MIDI or Ableton ALS.

⚠️ **The author's own instruction: trust its level-extraction logic, ignore its sequencer parsing.**
The traversal — how you get from a file to a set of sequencers — is sound and is written up below.
The musical interpretation on top of it (note grouping, durations, triplet timing) is, in the
author's words, suboptimal and inconsistent, and is *not* to be treated as a reference. Where our
measurements disagree with it, our measurements win without further argument.

MIT means we may port logic from it into our TypeScript with attribution. Prefer porting the
*understanding* over the code.

## Provenance rule — this is a source of hypotheses, not of measurements

This workspace's rule is that steering facts are measured out of the game's own bytes. The toolkit
is a third party's reading of those bytes: excellent, load-bearing for a decade of community
tooling, but still a reading. So:

- Anything taken from the toolkit enters as a **hypothesis** and is marked as such until we
  confirm it against the eboot or against a file diff.
- Where we have confirmed it, say so and give the address, exactly as for anything else.
- Where the toolkit and our own disassembly disagree, the eboot wins — but treat the disagreement
  as a signal that one of the two readings is subtly wrong, and find out which before moving on.

Three of its claims were confirmed against `eboot-v128.bin` on 2026-09-01; they are recorded in
[sequencer-data-model.md](sequencer-data-model.md) with their addresses. One of its claims was
sharper than our own prior reading and corrected an error in this steering (the phantom third bool
in the sample slot).

## Provenance rule 2 — every recording of "the game" is a recording of shadPS4

Established 2026-09-05, when the listener who made them said so plainly of question 23: *"I
perceived it comparing against an emulator, so I do not consider it reliable."* Every capture this
project has been settled against was taken under **shadPS4**, not on a PS4. That is not a reason to
throw them away — the emulator runs the game's own `fmodextinput.prx` and `fmodsmsreverb.prx`, so
everything those compute is the game's arithmetic — but it splits the evidence in two, and the split
is sharp:

| a capture is | because |
|---|---|
| ✔ **trustworthy for structure** — how many voices sound, whether a note is gated, when something is cut, the *ratio* between two channels | the DSP is the game's own code, executed |
| ✘ **not trustworthy for absolute level or spectrum** | between the plugin's output and the .wav sit shadPS4's mixer, its 7.1→stereo downmix, SDL's resampler and the host device — none of which is the PS4's |

So question 10 (the one-shot gate, settled on **envelope correlation** — a shape) and question 22's
pan width (settled on the **leak ratio between channels**, and the downmixer's own source read to
explain it) survive the caveat by construction. A per-band decibel difference does not: see
question 23, which is now parked for exactly this reason.

✔ **And question 22 no longer needs the capture at all.** As of 2026-09-05 the width is *derived*
from three read constants — the plugin's pan law, FMOD's `k = 0.5` centre feed at `v0xa2599f`, and
BS.775's `1/sqrt2` — and the capture is now a confirmation of a prediction rather than its
foundation. That is the strongest position a capture-based finding can end in: **use the emulator to
find the number, then go and read the code that produces it.**

⚠️ **Say which it is when you record a capture-based finding.** "Measured against the game" now
means "measured against shadPS4 running the game", and the two are the same claim only for the top
row of that table.

## What it implements that we care about

| toolkit class | our topic |
|---|---|
| `structs/instrument/Note.java` | **the 4-byte note record** — open question 1 |
| `structs/instrument/Sample.java` | the sample slot; stream order and defaults |
| `resources/RInstrument.java` | the sampler patch; array lengths and defaults |
| `structs/things/parts/PInstrument.java` | the instrument part; revision gates, defaults |
| `structs/things/parts/PSequencer.java` | the sequencer part, **including three fields we had not recovered** |
| `structs/things/parts/PMicrochip.java` + `structs/things/components/CompactComponent.java` | how instruments are placed on the timeline |
| `tools/sequencerdump/MidiDumper.java` | the whole import pipeline, end to end |
| `enums/ResourceType.java` | `INSTRUMENT = 48`, `SAMPLE = 49` — independent confirmation of our own table |
| `io/streams/MemoryInputStream.java` | endianness: defaults to **big**, with a per-stream override |

## What it does *not* cover — where we are still on our own

- **`RSample` (type 49) is declared but not implemented.** It has no magic registered and no Java
  class. So the toolkit does not resolve `RInstrument.SampleGuids` to audio either, and open
  question 2 stands. What it does settle is the *kind* of reference: `serializer.guid()`, i.e. an
  ordinary LBP GUID into the game's file database — not an FSB bank index.
- **No audio at all.** No FSB reader, no decoder, no playback. `tools/fsb.py` remains ours.
### The `RawDump` duplication — found 2026-09-02, and it cost a rendered note

⚠️ **This is history now** — `tools/RawDump.java` was deleted the same day, once
`src/core/level.ts` replaced it — but it is kept for the rule at the end, and because
`fixtures/levels/sequencers.jsonl`, the golden fixture `dev/verify-levels.ts` still reads, **was
produced before the fix and still contains the duplicates**.

⚠️ **`RawDump`'s outer loop could emit the same sequencer twice.** It walked `world.things` and dumped
every Thing carrying a music `PSequencer`; a world's Thing list can carry the same sequencer twice,
and when it does, every component is written again with the same `seqUID` **and the same `instIdx`**,
byte for byte — `instIdx` 0..N, then 0..N again.

**60 of the corpus's 338 sequencers came out that way**, and the pattern is all-or-nothing: a
sequencer's cells are either all single or all doubled, never mixed. Corpus-wide it is 23,911
duplicate rows out of 129,696.

Why it matters more than a factor of two on the level:

- every note is rendered twice, so the sequencer is 6 dB loud — invisible under a normalising render;
- **every note costs two of the engine's 32 voices.** At step 2176 of `This Is Halloween` that is 42
  simultaneous notes against a real 21; the pool overflows, the allocator steals the quietest, and
  the four voices carrying the sustained lead are the quietest. A listener reported the lead
  vanishing for two bars, which is exactly what it was.

Both ends were fixed at the time: the tool deduped by Thing UID and identity, and `importLevel`
dropped any row repeating a `(file, seqUID, instIdx)` it had already seen. A board cell holds one
component, so two rows with the same `instIdx` cannot be authored content — that is what makes the
drop exact rather than a heuristic. `dev/verify-levels.ts` still applies it, because the fixture on
disk predates the fix.

The TypeScript walk cannot produce this at all: it reads `PWorld.things` once, in order, and visits
each Thing once. The number that says so is 62,158 placements over the ten-level corpus — exactly
`PartCensus.java`'s `INSTRUMENT` count for those files, pinned in `test/project.test.ts`.

**The general rule this earns:** a structural regularity in *our* extraction is a bug until proven
otherwise. This one was written into steering as a fact about the level ("the composer plays every
hit on two components") and stood for a session, because nobody asked whether the two components
were at the same board cell. They were.

- **No synthesis model.** Nothing about pitch ratios, key splits at playback time, echo, reverb,
  or the FMOD side. Everything in [lbp-audio-engine.md](lbp-audio-engine.md) is still ours to work
  out.
- **`StandardInstrument.java` is LBP2-era and self-admittedly incomplete** (`// TODO: LBP3
  instruments`). 59 stock instrument GUIDs with display names. Two entries have enum names that
  disagree with their strings (`CARILLON` → "Kalimba", `KALIMBA` → "Marimba"), so treat the table
  as a convenience for display, verify before relying on any single row.

## Known approximations in `sequencerdump`'s musical layer — do not inherit these

Its author has already ruled this layer out as a reference, so these are not criticisms to be
resolved with them; they are simply things our code must do differently. A MIDI converter is a
converter, not an emulator. Three concrete places:

1. **Grid snapping.** It rounds each component's board position to a fraction of 2 and then takes
   `floor(x / 52.5)`. The game's own code applies a `-0.5` bias (measured — see
   [sequencer-data-model.md](sequencer-data-model.md)), which the toolkit does not.
2. **Triplet timing.** `Point.toMidiTick()` maps a triplet step with
   `group = step/4, pos = step%4, tick = group*96 + pos*32`. Four positions at 32 ticks overruns
   the 96-tick quarter, so the fourth slot of a triplet group lands on the next beat. That is
   plausible but unverified, and it is their interpretation, not a measurement.
3. **Note volume and timbre are read as signed Java bytes** (`volume = struct[0x2]`) while the
   write path masks with `& 0xff`. Values above 0x7f would come back negative. Read them as u8.

## How to get from a file to a set of sequencers

The traversal below is the part of `sequencerdump` worth reusing. Three input shapes:

**A loose resource** (`LVLb`/`PLNb`, SHA1-named): read the container (`tools/lbpres.py`), then
deserialise as `RLevel` or `RPlan`.

❗ **All three shapes are implemented now**, in `src/core/backup.ts`, `src/core/savearchive.ts`
and `readPlan` in `src/core/level.ts`. The recipe below was written on 2026-09-01 and sat unread
until 2026-09-04, during which this project told its users a PS3 save "cannot be read" — see
[answered-questions.md](answered-questions.md).

**A PS3 level backup** — a folder named `…LEVEL…` holding numbered fragments `0`, `1`, `2`, …:

1. Sort the fragments **by name as strings** (naive filesystem order breaks this on Linux).
2. **XXTEA-decrypt each fragment.**
3. Strip the last 4 bytes of the *final* fragment.
4. Concatenate, then append the 4 bytes `46 41 52 34` = `"FAR4"`.
5. The result is a `FAR4` save archive; iterate its entries, each identified by SHA1, and keep the
   ones whose resource type is `LEVEL` or `PLAN`.

That recipe is why the shadPS4 save data (`bigfart1`, `createfart_*`, `playfart_*`) is reachable
too — same archive family. Note this is **FAR4, not the FARC** of the game's own `base_001.farc`;
do not conflate them.

**Then, in either case:**

- `RLevel` → `worldThing.getPart(WORLD).things`; `RPlan` → `getThings()`.
- ❗ **Nor the streaming chunks.** `RLevel` → `StreamingManager` →
  `LevelData.chunkFileList` names `CHKb` resources, each holding islands, each island holding a
  whole `PLNb`. Measured: 171 chunks, 2,553 islands, 10,837 Things, 9 sequencers. The layout is in
  [answered-questions.md](answered-questions.md).
- ⚠️ **A chunk is stored UNCOMPRESSED**, which is the only reason three byte-width bugs in this
  project's reader were ever visible: in a compressed stream a varint under 128 and a `u8` occupy
  the same single byte. Treat the first uncompressed resource of any new kind as a test of
  everything, not as one more file.
- ❗ **Do not skip the plans.** Measured over six real saves: 224 plans against 6 levels, and the
  plans hold **172 music sequencers** to the levels' 19. A creator's gallery level is a rack of
  speakers pointing at plans, and the songs are the plans. The `RPlan` layout is in
  [answered-questions.md](answered-questions.md) — four fields, and the Things are in a nested
  stream with its own reference table.
- A music sequencer is a Thing with **both** a `PMicrochip` and a `PSequencer` whose
  `MusicSequencer` is true. Check that flag: animation sequencers share the part.
- Instruments are normally `PMicrochip.Components`, each a `CompactComponent` carrying the child
  Thing and its `(x, y)` on the board.

⚠️ **The open-circuit-board case.** If the microchip's `CircuitBoardThing` has a `PPos` part — the
board was left open in the editor — `Components` cannot be relied on. Instead, scan every Thing in
the level for children whose `parent.UID` equals the circuit board's UID and which carry a
`PInstrument`, and derive each one's board position as the **relative** transform: the child's
translation minus the board's, rotated by the inverse of the child's normalised rotation. Miss this
and sequencers that happen to be open at save time come out empty.

## Where we deliberately differ — a running list

Neither half of the toolkit is perfect — ennuo's cwlib is a decade of community work, and the
sequencer layer is this project's author's own earlier attempt, already disowned as a reference.
Finding places where either diverges from the game is the **expected outcome** of this project, not
an anomaly: matching them is not the goal, being right is. This section is the mechanism that keeps
that from rotting — every known divergence lives here with its evidence, so a future session
reading that code does not "fix" our behaviour back toward it.

Add a row whenever we establish a difference. Never silently follow the toolkit against our own
measurement.

| # | Where | They do | We do | Evidence |
|---|---|---|---|---|
| 1 | Grid placement | `floor(x / 52.5)` | `floor(2x/105 − 0.5)` | measured at `v0x1c4ad0`; the game applies a half-cell bias |
| 2 | `Note.volume` / `.timbre` on read | signed Java byte | unsigned | their writer masks `& 0xff`, their reader does not |
| 3 | Note duration | duration follows from the record chain, with an extra point pushed at `step+1` | duration is `x_last − x_first + 1`; records are control points, not a filled span | measured: 93.6% of 1.6M real notes land on a power-of-two duration under this reading |
| 3b | Out-of-order points | sorts a note's points, with a "sometimes this isn't correct" comment | same — sort by `x` | confirmed real: ~81 notes in 1.6M have a last record whose `x` precedes the first |
| 4 | Triplet timing | `group*96 + pos*32`, overruns the quarter on the 4th slot | `step + subStep/3`; at 480 PPQ a step is 120 ticks and a third of one is exactly 40 | settled from the engine — `v0x4558 = 0.333333`, see open question 3 |
| 5 | Mixer | ignored entirely; tracks grouped by row + instrument | model `NumChannels` and `Volume[0..5]`; the MIDI export carries both in its header meta | the fields exist and are audible |

The general shape of the difference: their tool converts *to MIDI*, so anything MIDI cannot express
gets flattened or dropped. We are reproducing the instrument, so the things they flatten — per-step
automation, the mixer, the sends, the sampler's key splits — are exactly the things we must keep.

## Our own converter, and how far it is trusted

`src/core/midi.ts` is the export and the import, with every row of the table above acted on and the
sixth difference — **a note is a chain of control points, not a value** — handled by exporting MPE,
a MIDI channel per sounding note, so a bend belongs to the note instead of to the whole part.
`src/core/smf.ts` underneath it is the container only: chunks, variable-length quantities, running
status. `dev/midi.html` is the page.

⚠️ **What the MIDI EVENTS carry is the music; the bytes ride in the metas.** `Key` and `Scale`
are folded into the note numbers on the way out, because a MIDI file has to play in something that
has never heard of an LBP scale — so the events alone give a placement back sounding the same and
written differently. Everything above that is a text meta: the mixer and the board in `LBP-SEQ` and
`LBP-TRK`, and the records themselves in `fix` for the clips MIDI cannot spell.

⚠️ **This entry used to end "do not write a byte-equality test against a round trip; it will
fail for reasons that are correct".** That was true and it is not any more, and the way it stopped
being true is worth keeping: the reasons were enumerated one at a time until only two were left
that no MIDI event could express, and at that point carrying them as data was cheaper than
carrying the argument. `dev/verify-midi.ts` now gates on byte equality.

### The round trip is exact — 0 records different in 1,448,224

Measured 2026-09-03 over the corpus, both channel modes, `dev/verify-midi.ts`:

```
62.158 clips, 1.448.224 records: 0 came back different
54 clips carried verbatim, 0 unpatchable, 24.0 MB
```

and it is a **fixed point from the first trip**: three round trips give 1,448,224 records and the
same byte count every time, with all 149 sequencers identical between trip 1 and trip 2. The music
comparison that used to be the strongest statement here now reads **0 sequencers disagreeing, worst
deviation pitch 0.000, volume 0.000, modulation 0.000** — the deviations it used to report are
gone because the records themselves come back.

Three things got it there, in the order they were found:

1. **Byte 3's resting bit 30.** The engine reads it only when byte 0's bit 7 is set, and the editor
   writes it anyway — 971,954 of the 1,439,351 sub-step-0 records carry it, decided by the level's
   revision rather than by the note. Reconstructing byte 3 without it made **78% of clips** come
   back different. It travels per clip in `LBP-TRK`. Full measurement in
   [sequencer-data-model.md](sequencer-data-model.md).
2. **The order records are written in**, which is position ascending then pitch **descending** on
   27,124 of 27,124 tied clips. Sorting on position alone left 1,944 clips holding the right notes
   in the wrong order.
3. **A repeated value is a control point.** The resampler never sends one value twice, so a
   message carrying the value already in force can only be a control point where nothing moved.
   That recovered 509 notes and made the file *smaller*; see
   [midi-interchange.md](midi-interchange.md).
4. **A verbatim record patch for the remainder.** The exporter imports its own output, compares
   clip by clip, and writes the originals base64 in the `LBP-TRK` meta's `fix` for the ones that
   differ — **54 clips of 62,158**, 15 kB, 0.063% of the file. It was 177 when this was written and
   109 the day after; what closed the gap each time was a thing MIDI could say after all, and the
   remainder is now a single family. See question 24 in [open-questions.md](open-questions.md).

⚠️ **A patch is not the same kind of thing as the metas around it.** `LBP-SEQ` and `LBP-TRK`
describe the *placement* — the mixer, the board, the key — and stay true however the notes are
edited. A patch describes the *records*, so a DAW that edits the notes leaves it stale and the
import will hand back the original clip rather than the edit. That is why `exact: false` exists and
why the page says what it is for. **The importer trusts the patch over the note events**, which is
also why shared mode now comes back whole: a flattened note's glide is gone from the MIDI and
present in the patch.

⚠️ So `flattened`, `dropped` and `dragged` describe what a **foreign reader** loses, not what a
round trip loses — the honest reading of them, and always was. `LBP_MIDI_LOOSE=1` turns the patch
off and measures MIDI alone: worst deviation pitch 0.167, volume 0.500, and 54 clips that would
have needed a patch.

⚠️ **`Track.records` is the file's own bytes and `Track.notes` is not a re-encoding of them.**
`makeNote` sorts a chain into position order and real files do not always store it that way, so
re-encoding a note can move the end flag into the middle of the chain. Every byte-level comparison
here goes through `records`; the first version of the diff did not, and it invented 66% of notes
diverging and a 4 MB patch.

**Two fields cost nothing only because the corpus never uses them**, and the patch is what carries
them if a level ever does: `timbre` bits 4-5 — the per-block table select — are zero in all
1,448,224 records, and no record carries a volume above 127 where MIDI has seven bits.
`test/midi.test.ts` is the only place either is exercised.

**`Scale` is now restored too.** It used to be dropped outright, on the grounds that `quantise` is a
projection with no inverse. It still has none — `unquantise` in `src/core/scale.ts` is a *section*,
taking the lowest note that snaps to the one the file names — but that always sounds right, and
where the author wrote off the scale the patch carries the record. 0 placements in the corpus set
it, so this is measured on fixtures.

### How the last of it was closed, in order

Each of these was found by measuring, and each is worth knowing because none was where it looked:

1. **The pitch was rounded to a whole semitone before the simplifier saw it**, turning the ramp the
   file drew into a staircase — and the simplifier then kept the tread where the rounding crossed a
   half rather than the control point the file named. Keeping the fraction until a record is
   written took 2,432 notes to 592 and the worst pitch deviation to 0.
2. **Coincident points were collapsed everywhere**, which erased the segment *leading into* one: a
   dive in `Diode` that arrives and snaps back came out flat, because dropping the record the ramp
   aimed at left it nowhere to go. The collapse belongs only at the note's own start, where both
   samples would land on the note-on's tick.
3. **Shared mode's `needsChannel` did not count the modulation.** A note whose pitch and volume are
   flat but whose modulation moves was allocated as flat, and if it then had to share it lost the
   ramp with nothing counting it — 608 undeclared notes. CC 74 belongs to the channel exactly as
   bend and pressure do, so it earns a channel for the same reason.
4. **A newcomer's CC 74 was landing on the owner's ramp — and the first fix for it was one event
   too greedy.** The exporter writes every note's opening
   modulation immediately before its note-on, sharer or not, and the importer pushed any CC 74 to
   whichever note owned the channel — so a note starting mid-ramp bent the modulation of one it has
   nothing to do with. 89 undeclared notes down to 8.

   ⚠️ **Excluding the whole tick then threw away the owner's own final ramp sample**, whenever a
   note happened to start on the instant a ramp ended — three notes in `Orb` and `Blackfire` whose
   modulation stopped one step short of where it was going. It is the **last** CC 74 before the
   note-on that belongs to the newcomer, not every one at that tick; in the stream the two are
   adjacent and in order. 8 down to 0.
5. **The verifier was measuring the wrong things, repeatedly — the note pairing is the part of it
   that has been wrong most often.** It compared the first record's modulation rather than the one
   the note sounds; its pairing cost ignored the modulation entirely, so it paired notes that differ
   only in their filter at random and reported 458 casualties where a diagnostic costing all three
   found none; and its greedy walk crossed a flattened note with an intact sibling and reported two
   casualties for one.

   ⚠️ **Levels place the same hit on two components**, so a bucket routinely holds several notes
   at one step and one pitch. `Partykill` has the same note twice at step 4308, one exclusive with
   its glide and one shared and flat. The pairing therefore takes **exact matches first** and only
   then matches what is left by cost. And its key stays loose — step and pitch — because tightening
   it to include the opening volume lost every flattened note that opened at volume 0: MIDI has no
   velocity 0, so those come back at 1.

   The phantom counts this produced, in order: 142 sequencers, 458 notes, then 8. **None of them
   were real.**

Measured in the per-part mode, which is the good one. **Every row is now done**, and the last
four went the same way — not by finding more MIDI, but by carrying the records:

| left | how much | what it would take |
|---|---|---|
| ~~glides lost inside one part~~ | ~~825 notes~~ **0** | **done.** A part whose own polyphony passes 15 is written across several MIDI tracks — `laneOf` in the exporter, merged back on the `LBP-TRK` identity. It cost **2 extra tracks across the whole corpus**, 5,058 to 5,060, and took the clip count to exact |
| ~~control points not identical~~ | ~~2,432 notes~~ → ~~592~~ **0** | **done, in two steps.** Keeping the pitch fractional until a record is written took 2,432 to 592 — rounding it before the simplifier saw it turned the ramp into a staircase and kept the tread rather than the control point. The last 592 were a ramp re-cut onto the staircase the rounding really makes (tighter to the curve than the original, so it could not be loosened away) and a coincident record nothing can hear; both are now carried verbatim. ⚠️ The fear here — "carrying the true points duplicates the note data" — was right about the mechanism and wrong about the size: only the clips that need it are carried, which is **0.73%** |
| ~~per-point modulation~~ | ~~34,449 notes~~ **8** | **done.** It rides on CC 74, one event per change, resampled with the glides; 34,441 of the 34,449 ramps come back. The 4-bit nibble to 7-bit controller map is exact over all sixteen values and `test/midi.test.ts` checks every one. ⚠️ It stopped being safe to drop the moment the renderer started ramping it — see `answered-questions.md` 6d |
| ~~which clip a note sat in~~ | ~~1 clip of 62,158~~ **0** | **done**, as a side effect of the lanes: 62,158 clips out, 62,158 back |
| ~~coincident points mid-note~~ | ~~2 notes~~ **0** | **done.** The record patch, which needs no special case for a zero-length segment |
| ~~`timbre` bits 4-5, volume > 127~~ | ~~0 in the corpus~~ **carried** | **done**, for nothing: both ride in the patch that already exists for the clips that need one. `test/midi.test.ts` is the only place either is exercised |
| ~~`Scale`~~ | ~~0 placements~~ **restored** | **done.** `unquantise` picks the lowest note that snaps to the one written — a section of the projection, not an inverse — which always sounds right, and the patch carries the author's own field where they wrote off the scale |
| ~~unexplained~~ | ~~2 notes~~ **0** | gone with the rest |

✅ **The shape of an exact converter was not more MIDI, it was a bigger side channel** — and the
prediction written here before it was built held up exactly. What it did not predict is the *size*:
the fear was that carrying records "duplicates the note data", and the answer is that the exporter
reads its own output back and duplicates only what came back wrong. **686 clips of 62,158, 0.73% of
the bytes.** A self-verifying export is what makes the side channel cheap; without it the honest
version costs 22%, because you have to carry every clip you cannot prove.

⚠️ **And it is still two products, which the `exact` flag chooses between.** A MIDI file that
happens to round-trip is not the same thing as a MIDI file, and the difference shows the moment
somebody edits the notes: the patch then describes records the edits no longer match, and the
import hands back the original. Off is right when the file is going somewhere that will change it.

### What MIDI ALONE loses — `LBP_MIDI_LOOSE=1`, no record patch

Measured over the corpus's 1,448,224 records in 953,791 notes, 62,158 placements. **With the patch
on, none of this survives the trip: 0 records differ.** The table is what a reader that ignores our
metas hears, and what the file degrades to if a DAW edits it.

| lost | how much | why |
|---|---|---|
| `Scale`'s own pitch fields | 0 placements in the corpus set it | folded into the note numbers so the file plays anywhere. `unquantise` picks the lowest note that snaps to the one written, which always SOUNDS right; the author's own field survives only where they wrote on the scale. `Key` is exact — a transposition is invertible where a projection is not |
| which clip a note sat in | 1 clip of 62,158, and 42 more hold a different number of notes (0.07%) | the residue of a genuine ambiguity: clips of one part overlap, so a few notes fit two of them and either answer puts them at the same place on the timeline |
| per-point modulation | 8 notes of 34,449 that vary it | carried on CC 74 per change; the eight that do not survive move it by less than the quantiser can see |
| coincident control points | 302 notes (0.03%) | two records on one position collapse to the later, which is what the engine's `t = span > 0 ? … : 1` does |
| a glide, to a shared channel | **0** | fifteen member channels against thirty-two voices, and lanes hold the difference; always counted, never silent |
| pitch and volume resolution | within half a unit — measured worst 0.167 semitones and 0.500 | bend is rounded to whole semitones and positions to thirds of a step, which is the record grid |
| `timbre` bits 4-5, volume > 127 | 0 in the corpus | MIDI has seven bits for either |

⚠️ **The board layout is carried by the `LBP-TRK` meta, not by a CC.** MIDI has no controller for
"this note belongs to that clip" and a CC would be the wrong tool anyway — seven bits, and a synth
would act on it. There is no standard message for this and there does not need to be: a text meta
is ignored by everything that does not know it and exact for everything that does.

⚠️ **And the cell alone is not enough — the clip's LENGTH is what makes it recoverable.** `clips`
holds `[gridX, steps]` per clip. On the cells alone **86.50% of the corpus's notes fit more than
one clip**, because clips of a part overlap heavily: a cell is 16 steps and a clip may hold 128.
Adding each clip's own extent takes that to **0.09%**, for one number per clip. Measured end to
end, **62,158 clips come back as 62,158**, every one on the cell the author used and holding
exactly the notes it held.

⚠️ **Emit every declared cell, including the empty ones.** 52 placements in the corpus hold no
notes at all — an instrument dropped on the board and never written in — and nothing in a MIDI file
can bring one back except the cell list. Skipping them is what made the count 62,106 rather than
62,158, and it looked like an ambiguity rather than the omission it was.

The measurement, from `dev/verify-midi.ts` over the corpus on 2026-09-03 — run it after touching
either file. `LBP_MIDI_LOOSE=1` turns the record patch off so the MIDI-alone numbers stay visible:

| | |
|---|---|
| sequencers disagreeing | **0** of 149 |
| clips whose records differ | **0** of 62,158 |
| clips carried verbatim | 177 (0.28%) |
| notes sharing a channel | 30, all of them flat |
| … dragged by a neighbour's bend | 0 |
| … whose timbre a sharer moved | 0 |
| glides MIDI alone could not carry | 0 |
| notes MPE could not carry at all | 0 |
| size | 24.0 MB |

- 88,893 notes (9.32%) carry a glide and **none of them loses it, even in the MIDI events alone**.
- ⚠️ **Report `dragged`, not `sharedChannel`.** The raw sharing count was five times larger when
  parts shared, and implied a damage that was not there. It is 30 against 0 now, which makes the
  same point.
- **Two residues that used to sit here are gone.** One read "7 notes in 953,791 (0.0007%) change
  without being declared, and are not explained" — with the records carried, nothing changes at
  all. The other was `Avian`'s single note that MPE could not carry, seventeen copies of one pitch
  at once: lanes hold it. ⚠️ `dev/verify-midi.ts` still checks the note count against a RANGE
  rather than against `before - dropped`, because a dropped note comes back through the patch and
  the equality blamed `Avian` for a note that had already been restored.

✅ **Every part gets all fifteen member channels, and there is no longer a mode where it does
not.** Settled 2026-09-03. A MIDI file's tracks do NOT get sixteen channels each — the header can
declare 65,535 and the channel still lives in the status byte — but a DAW that imports a format 1
file as one project track per MIDI track gives each track its own instrument, and that instrument
only ever sees its own track's events. Reaper does this. The file is written for that reader and
says so; `splitSequencerToMidi` is the option for one that cannot promise it, since separate files
need no promise at all.

What the old shared mode cost, for the record: 1,742 glides (0.18%), 1,352 notes dragged by a
neighbour's bend, 4,522 whose timbre a sharer moved, and one note in `Avian` that MPE could not
carry at all. All four are now **0**.

⚠️ **Sharing has not gone, it has changed shape.** 30 notes of the corpus's 953,791 still share
a channel, and the polyphony count does not predict them: a part is split into lanes so that no
lane holds more than fifteen at once, but a channel is held for a note's whole life, so **one long
note can pairwise overlap fifteen short ones without three ever sounding together**. The gliding
pass parks each of those on a channel of its own, round-robin, and the long note arrives to find
every channel booked. Measured at the moment it happens: 1-2 concurrent, 14-17 booked ahead, and
every one of the 30 is a FLAT note — so `dragged`, `timbred` and `flattened` are all 0. That is the
two-pass allocator working as intended, not failing.

⚠️ **The order notes are allocated in is what makes that true, and it is not obvious.**
Allocating in plain time order let a flat note take the last free channel a moment before a gliding
one needed it: 3,593 notes lost a glide where, measured, only **1,172 ever arrive while more than
fifteen glides are already sounding**. `sequencerToMidi` therefore allocates in two passes, the
notes that need a channel to themselves first, and falls back through a channel nobody is bending,
then the master channel — which MPE allows to carry notes and where nothing is ever bent — then a
channel whose glides all began earlier, and only then gives a glide up. ⚠️ **The master goes
before the earlier-glide case, not after**: our own importer knows whose a bend is, a synth does
not, and parking a note on the master is the one placement that cannot be dragged. That last case
is real and is counted: `flattened`. Deciding is a separate step from writing for exactly that
reason, since displacing a glide has to be able to reach a note that was placed earlier.

⚠️ **The bend range is picked from the music, not fixed at MPE's 48.** 582 of the corpus's
1,448,224 control points glide further than 48 semitones and the widest is 62; nothing reaches 96,
which is MIDI's own ceiling. A fixed 48 clamped 1,026 of them, and a clamped bend is a note that
arrives at the wrong pitch.

## The public archive — where to get a level when you have no backup

Measured 2026-09-05, when the pages grew a third way to open a song.

The Mm servers closed in 2021 and their resource store survives as an Internet Archive dump
(`@tamiya99/uploads`), indexed by Zaprit's **LBP Search Facility**, <https://zaprit.fish>
(<https://github.com/Zaprit/LBPSearch>). A listener finds a level there and pastes its **root level
hash** into the tracker; `dev/lbparchive.ts` turns the hash into a URL and the page downloads it.

- **The download URL is a pure function of the hash**, from `SlotHandler` in `handlers.go`:
  `archive.org/download/dry23r<h[0]>/dry<h[0:2]>.zip/<h[0:2]>%2F<h[2:4]>%2F<h>`. That is what makes
  the whole thing possible without asking anyone anything.
- **`archive.org` answers any origin.** `view_archive.php` echoes whatever `Origin` is sent —
  verified from `https://example.github.io` — so the download works from a dev server, a static host
  or a `file://` page alike.
- ⚠️ **`zaprit.fish` sends no CORS headers at all**, on any route. A page cannot read its search or
  its level pages. This is the fact the whole design turns on.

✔ **A root level on its own is enough.** Downloaded straight from archive.org, "Music Gallery #3"
(`8febe1f9…`, LBP3 PS4/PS5, 339 KB) parses into **31 sequencers with zero problems** — and on
**branch 0x218**, which the corpus did not contain. The Things a level's music lives on are in the
level's own resource; the separate `.plan` resources matter for a creator's *backup*, not for this.

### ✔ And the archive's own index is downloadable, which makes coverage a measurement

⚠️ **`dry.db`, 2.6 GB of SQLite from <https://archive.org/download/dry23db>, 10,467,874 level
slots.** `lbp-download` uses it and it is on this machine. Its `slot` table carries the 20-byte
`rootLevel` SHA-1 the archive is keyed by, so **the index plus `rootLevelUrl` is a scriptable corpus
of every level that survives**. `dev/archive-sample.mjs` is that: pick an even spread of ids per
game, download, hand the directory to `dev/walk-levels.ts`.

❗ **This is what turned question 28 from an errand into a number.** The reader's coverage was
argued from ten levels of one creator on one console; it is now 103 levels across LBP1, LBP2 and
LBP3 slots, and the answer is 82 of 103 with **no failure anywhere in the range the reader claims**.
Every real bug found in `src/core/parts.ts` on 2026-09-05 came out of a file no PS3 save here
contains.

⚠️ **`slot.game` is which title the slot was PUBLISHED for, not the revision the file carries.** A
level published as LBP2 and last saved in LBP3 is stored as LBP3, so `game` 1 spans `0x3b7`–`0x3f9`
and only `game` 0 reaches LEERDAMMER. Sampling by `game` and expecting revisions to follow is the
mistake to avoid.

⚠️ **A 200 from the archive is not a level.** A missing entry comes back as a short body rather than
a 404, and the first sweep's two-byte file reached the walk as "too short to be a resource" — a
reader bug report for something that was never downloaded. The sampler rejects anything under a
header's length.

### The dependency table — the whole backup, from one hash

Measured 2026-09-05. The table sits **after** the compressed payload, at the offset the header
carries at byte 8, and is `u32 count` then per entry `u8 kind` — 1 for a 20-byte SHA-1, 2 for a
`u32` GUID — followed by a `u32` resource type. ✔ On "Music Gallery #3" the walk of 160
variable-length entries ended at exactly the last byte of the file (0x52d02 of 0x52d02), which is
the check that the reading is right. `src/core/resource.ts` `readDependencies` does this.

❗ **A hashed dependency is a USER resource and a GUID one is a GAME asset.** That is the whole
usefulness of the table to us: the hashed ones are in the public archive under the same URL as the
level itself, and the GUIDs are in the game's FileDB and are **not in the archive at all**. On that
level: **20 hashed, 140 GUIDs**.

Six dependency types are established, each checked against the magic of the resource actually
downloaded for it — not read off somebody's enum. The full table and how it was taken are in
answered question 35; the three that matter here are **9 = `LVLb`** (a level inside an adventure),
**38 = `PLNb`** and **61 = `CHKb`**, because those are exactly what `readBackup` can open.

❗ **An adventure (`ADCb`) has no world of its own**, and four of twelve "adventure map" hashes off
the index are one. Its levels are the type-9 dependencies, so the walk is not optional when the root
is not itself openable — otherwise a good hash would silently do nothing.

✔ **The walk works and it is worth knowing what it buys.** Fetching the level plus its 17 plans —
18 resources, six at a time — took **10 s** against 3 s for the level alone, and gave **46
sequencer rows instead of 31**. But *distinct* songs, by name and track count, were **16 either
way**: every plan was a copy of a song already placed in the level. The case the walk exists for is
a song that lives **only** as a plan (a prize bubble, an unplaced popit copy), and it cannot be
known to be absent without fetching.

So it is a **checkbox, ticked by default**: on, because the one thing it can find is music silently
missing from a music tracker; a checkbox, because on most levels it is seven seconds and fifteen
duplicate rows for nothing. It is read once when the open starts, so ticking it mid-fetch cannot
change what that open is doing.

⚠️ Two of the 17 plans yield no project, and that is `readBackup` working: they parse cleanly and
contain no sequencer, so they are dropped rather than listed. Checked directly before believing it.

### ❌ The search, built and then removed — 2026-09-05

For one commit the tracker had a real search box: `dev/serve.mjs` proxied `/zaprit/*`, scraped the
site's HTML (there is no API — every route is Go `html/template`) and returned JSON. **It worked**,
and it was removed the same day, deliberately.

The reason is not that it was hard. It is that it only worked on a dev machine: the search needed a
Node process running beside the page, so the tracker's most useful "I have no backup" path would
have been the one that broke the moment anyone hosted it. A file server should not also be a proxy,
and a listener's search should not travel through it. The hash needs nothing.

Kept here because they cost hours to learn and the history is where the code went:

- The result table has ten fixed columns; the level page carries the SHA-1 in a `<span class="code">`
  and warns, in a toast, about hashes the archive never received.
- ⚠️ **The site's own page number is not the page number.** `?page=` is zero-based (the offset is
  `page * 50`), and the template prints `page + 1` except on a full page, where the handler
  overwrites it with `page`. A full first page renders "Page 0" and a short one renders "Page 1".
- ⚠️ **A hash cannot be found in text with ``.** In `…eb%2F8febe1f9…` the character before it is
  the `F` of `%2F`, itself a hex digit, so the boundary fails and a backtracking match lands on a
  40-digit window two characters off. Take the last path segment instead — `readPaste` does, and the
  test pins it.

### Why a search cannot be served from a static page — measured

Not for want of trying. The index behind zaprit.fish is `dry.db`, a **2.65 GB SQLite** published as
`archive.org/details/dry23db` (2,651,348,992 bytes). Paging through it over HTTP — the
`sql.js-httpvfs` technique — needs `Range` **and** CORS on the same URL, and archive.org gives
exactly one of the two:

| URL | `Range` | CORS |
|---|---|---|
| `archive.org/download/dry23db/dry.db` | ✔ `206 Partial Content` | ✘ no header at all |
| `archive.org/cors/dry23db/dry.db` | ✘ ignored: `200 OK`, `Content-Length: 2651348992` | ✔ echoes the origin |

So a static page can have the whole 2.65 GB or none of it. If a real serverless search is ever
wanted, the way in is **our own index**: `dry.db` downloaded once, LBP2/LBP3 slots reduced to id,
name, author, hearts and root hash, sharded by search prefix so a page fetches `mu.json` and nothing
else. Or one header upstream — `Access-Control-Allow-Origin: *` on `/search` and `/slot/{id}` would
make the browser able to ask directly, with no proxy and no index of our own.

## The save archive — how a PS3 backup opens, and it does open

A PS3 level backup is a save-game folder: `PARAM.SFO`, `PARAM.PFD`, `ICON0.PNG` and numbered files
`0`, `1`, … The numbered files are **the game's own `FAR4` save archive, XXTEA-encrypted**, not
PS3 savedata encryption, and the key is a constant that every tool for these files carries:

```
TEA_KEY = 0x01B70CBD 0x149607D6 0x07F94DD5 0x10DB8CA0   (big-endian 32-bit words)
```

The layout, from the END of the archive backwards — the last four bytes are `FAR<rev>` **and are
never encrypted**, which is how a save is recognised without decrypting anything:

```
len-4    char[4]  "FAR4"        rev 2..5; 5 is the Vita and is little-endian in places
len-8    u32      entryCount
len-0x1c sha1     hashinate      HMAC-SHA1 over the archive, rev > 2 (Vita: len-0x20)
         Fat[]    entryCount x 0x1c: sha1[20], u32 offset, u32 size   — always big-endian
         byte[]   the save key, 0x84 bytes: revision, localUserID, root type, root hash
         byte[]   the resources, back to back from offset 0
```

`fatOffset = len - 8 - entryCount*0x1c - 0x14` (rev > 2), minus 4 more on rev 5. The save key is
skippable: nothing outside the game needs it, and the FAT alone gets every resource out.

The archive is cut into **0x240000-byte chunks**, one file each, and each chunk is XXTEA'd on its
own — so chunk boundaries matter and a wrong one decrypts file `0` correctly and turns the rest to
noise. ⚠️ **Only single-chunk saves are measured here**; `src/core/savearchive.ts` verifies every
resource against the SHA-1 in the table, which is what turns that unmeasured boundary into a loud
failure rather than a corrupt level.

✔ **Measured**, 2026-09-04, on `BCES00850LEVEL01EE7CEE/0` (472,960 bytes) out of a real backup zip:
28 resources, **28 of 28 SHA-1s matching their bytes**, one 275 KB `LVLb` holding **11 music
sequencers** — "The Asylum", "Ascetic - Festerd_Jester", "Levity - Festerd_Jester" and eight more.
A wrong key does not produce 28 matching SHA-1s. The other 27 are 16 textures and 11 plans.

Two independent implementations agree on the key and the table, and neither was taken on faith:

- ennuo's `cwlib/util/Crypto.java` — `TEA_KEY`, "used for encrypting/decrypting RLocalProfile and
  profile backups" — and `cwlib/types/archives/SaveArchive.java` for the revision gates above;
- Zaprit's [lbp_archive_dl](https://github.com/Zaprit/lbp_archive_dl),
  `src/serializers/lbp/save_archive.rs`, which **writes** one.

❗ **That second one answers a question worth writing down**: how a site can serve the same level
both as a PS3 backup zip and as loose resources. It does not decrypt anything. It holds the
plaintext resources in the archive.org server dump (`dry.db`, keyed by SHA-1), and *builds* the save
on the way out — the FAT, the save key, the hashinate HMAC and the XXTEA are all in that repo. The
encryption is something the download **acquires**, not something it has to shed.

## The level corpus — our regression suite

There is a local checkout at `C:\Users\sgdc3\Desktop\LBP\toolkit\`, and its
`tools\sequencerdump\data*\` directories hold **18 real LBP2/LBP3 level resources**, SHA1-named,
revisions `0x3b8`–`0x3f9`, one of them on the LBP3 branch `0x0213`. Two of the `data*` folders are
PS3 save-game directories (`BCES00850…`, `BCES01663…`) rather than loose resources.

This is the most valuable thing in the checkout. It is a corpus of real compositions by real
creators, and it is what turned the note record from a hypothesis into a measurement without anyone
having to open Create Mode. Use it as the regression suite for every parser we write:
`tools/lbpres.py` already reads all 18.

⚠️ **Never commit any of it.** These are other people's levels. `.gitignore` does not cover
SHA1-named extensionless files — keep them where they are and reference them by path.

⚠️ The sibling `out*\` directories hold that tool's MIDI output. **Ignore them.** They are one
converter's interpretation of the data, several steps removed from the game, and treating them as
ground truth would launder an assumption into a fact. Go to the `data*` resources.

## How to work with it from here

Do not clone it into this repo. Fetch the specific file you need over `raw.githubusercontent.com`
and read it; the classes are small and self-contained, and a full checkout is 5.5 MB of Java we
have no intention of building. Everything worth keeping belongs in this steering directory, in
English, with its provenance attached.
