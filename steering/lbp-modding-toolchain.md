# The LBP modding toolchain — what exists, what it covers, how to use it

Read before writing any parser for an LBP resource or archive, and before attacking an open
question that touches the **save format** (as opposed to the runtime engine). Someone has already
done a large part of this work in the open.

## The project

`https://github.com/ennuo/toolkit` — "Craftworld Toolkit". Java, **MIT licensed**, ~770 files.
Two parts matter to us:

- `lib/cwlib/` — a library of hand-written serialisers for LBP resource types and Thing parts.
  Each class carries the field order, the per-field revision gates, and the defaults.
- `tools/sequencerdump/` — a standalone tool that walks a level or `.plan`, finds every **music**
  sequencer, and dumps each track to a MIDI file. It is, in effect, a working reference importer
  for exactly the data we need.

MIT means we may port logic from it into our TypeScript with attribution. Prefer porting the
*understanding* over the code: their converter makes deliberate approximations (below) that we do
not want to inherit silently.

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

## Known approximations in `sequencerdump` — do not inherit these

Their MIDI converter is a converter, not an emulator. Three places where it knowingly diverges:

1. **Grid snapping.** It rounds each component's board position to a fraction of 2 and then takes
   `floor(x / 52.5)`. The game's own code applies a `-0.5` bias (measured — see
   [sequencer-data-model.md](sequencer-data-model.md)), which the toolkit does not.
2. **Triplet timing.** `Point.toMidiTick()` maps a triplet step with
   `group = step/4, pos = step%4, tick = group*96 + pos*32`. Four positions at 32 ticks overruns
   the 96-tick quarter, so the fourth slot of a triplet group lands on the next beat. That is
   plausible but unverified, and it is their interpretation, not a measurement.
3. **Note volume and timbre are read as signed Java bytes** (`volume = struct[0x2]`) while the
   write path masks with `& 0xff`. Values above 0x7f would come back negative. Read them as u8.

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
