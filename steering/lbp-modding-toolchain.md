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
| 4 | Triplet timing | `group*96 + pos*32`, overruns the quarter on the 4th slot | not yet decided | their own arithmetic is internally inconsistent |
| 5 | Mixer | ignored entirely; tracks grouped by row + instrument | must model `NumChannels` and `Volume[0..5]` | the fields exist and are audible |

The general shape of the difference: their tool converts *to MIDI*, so anything MIDI cannot express
gets flattened or dropped. We are reproducing the instrument, so the things they flatten — per-step
automation, the mixer, the sends, the sampler's key splits — are exactly the things we must keep.

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
