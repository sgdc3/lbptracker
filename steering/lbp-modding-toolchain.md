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

⚠️ **What a round trip preserves is the music, not the bytes.** `Key` and `Scale` are folded into
the note numbers on the way out, because a MIDI file has to play in something that has never heard
of an LBP scale, so an import comes back chromatic in C — sounding the same, written differently.
Clip boundaries move too: a step field is seven bits, so an imported part is re-cut into 128-step
clips wherever they fall. **Do not write a byte-equality test against a round trip**; it will fail
for reasons that are correct.

The measurement, from `dev/verify-midi.ts` over the corpus on 2026-09-03 — run it after touching
either file:

- 149 sequencers, **953,791 notes**, none lost, none moved, no pitch, duration or modulation
  changed; an intact note's curve stays inside the half unit its integer fields round by.
- 88,893 notes (9.32%) carry a glide. **1,537 of them (0.16%) lose it to a channel they had to
  share** — an MPE zone has fifteen member channels and this engine has thirty-two voices, so a
  dense passage runs out. A note that has to share writes no bend and no pressure at all, because
  both belong to the channel and a newcomer setting them drags whatever is already sounding there.
  The count is reported by `sequencerToMidi`, never swallowed.
- 27,036 notes share a channel, but **only 1,245 of them (0.13%) are ever reached by the
  neighbour's bend** — the rest sit on a channel that stays centred for their whole life and lose
  nothing. ⚠️ **Report `dragged`, not `sharedChannel`.** The raw sharing count is five times larger
  and implies a damage that is not there: on `Ascetic` 124 notes share and 6 are touched.
- 22.7 MB of MIDI; 0 pitches clamped, 0 bends clamped, 0 lengthened, **1 note that MPE cannot
  carry** — seventeen copies of one pitch at once, in `Avian`, with nowhere left where a note-off
  could tell them apart.
- **7 notes in 953,791 (0.0007%) change without being declared** and are not explained. Every
  category found so far is fixed and carries a note in the code saying what it was; this residue
  is below the level worth more session time and is printed by the script rather than hidden.

⚠️ **A MIDI file's tracks do NOT get sixteen channels each, but a DAW gives them sixteen
anyway.** The header can declare 65,535 tracks and they are still one shared channel space — the
channel is in the status byte, not the track — which is why a dense song runs out. *But* a DAW that
imports a format 1 file as one project track per MIDI track hands each track its own instrument,
and that instrument only ever sees its own track's events. Reaper does this. So
`channelsPerPart` gives every part all fifteen member channels in a **single file**, and measured
over the corpus that is **dragged 0 and 825 notes short of a glide (0.086%)** against 1,245 and
1,535 when they are shared — identical to writing one file per part, without the 4,909 files. It is
off by default because a single-stream player (hardware, a plain player, Reaper told to import as
one track) would hear the parts collide. `splitSequencerToMidi` is the option that needs no promise
about the reader: separate files, packed by polyphony, 249 for the corpus where 149 sufficed.

⚠️ **The order notes are allocated in is most of the shared-channel problem, and it is not
obvious.** Allocating in plain time order let a flat note take the last free channel a moment
before a gliding one needed it: 3,593 notes lost a glide where, measured, only **1,172 ever arrive
while more than fifteen glides are already sounding**. `sequencerToMidi` therefore allocates in two
passes, the notes that need a channel to themselves first, and falls back through a channel nobody
is bending, then the master channel — which MPE allows to carry notes and where nothing is ever
bent — then a channel whose glides all began earlier, and only then gives a glide up. ⚠️ **The
master goes before the earlier-glide case, not after**: our own importer knows whose a bend is, a
synth does not, and parking a note on the master is the one placement that cannot be dragged.
Ascetic's dragged notes went from 18 to 6 on that ordering alone. That last case is real and is counted:
`flattened`. Deciding is a separate step from writing for exactly that reason, since displacing a
glide has to be able to reach a note that was placed earlier.

⚠️ **The bend range is picked from the music, not fixed at MPE's 48.** 582 of the corpus's
1,448,224 control points glide further than 48 semitones and the widest is 62; nothing reaches 96,
which is MIDI's own ceiling. A fixed 48 clamped 1,026 of them, and a clamped bend is a note that
arrives at the wrong pitch.

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
