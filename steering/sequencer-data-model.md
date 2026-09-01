# The sequencer's data model — recovered schemas

Everything below was read out of LBP3 1.28's own serialiser functions, which emit a `lea` to the
field's name string next to a `lea` to the member offset. Addresses are **vaddrs** in the eboot;
see [eboot-re.md](eboot-re.md) for how to turn those into file offsets (and for the delta trap).

## The object graph

```
Thing
 ├─ PSequencer     the grid: tempo, swing, channels, master FX, playhead
 └─ PInstrument    one instrument placed on the grid: its own note grid + per-instrument FX
      └─ RInstrument   (resource, type 48)  the sampler patch: 8 sample slots + key splits
           └─ SampleGuids[8] ──▶ audio data (see game-assets.md)
```

Both `PSequencer` and `PInstrument` are **Parts of a Thing**, listed in the part-name table at
file `0xe4e196+` alongside `PBody`, `PScript`, `PAudioWorld`, `PSwitch`, … They are not special
objects; they are components, which is why a sequencer can be wired to logic like anything else.

## Resource type ids

From the ordered `R*` name list at file `0xe4e405` (`RTexture` = 1, confirmed independently:
`PInstrument.Icon` serialises with type tag `1` and is a texture):

| id | type | id | type |
|---|---|---|---|
| 36 | `RAudioMaterials` | 40 | `RMusicSetting` |
| 41 | `RMixerSettings` | 46 | `RVoIPRecording` |
| **48** | **`RInstrument`** | **49** | **`RSample`** |

`PInstrument.Instrument` serialises with type tag `0x30` = 48 → it is a reference to an
`RInstrument` resource. That is the anchor that ties the whole chain together.

## PSequencer — serialiser at `v0xd37d10`

Offsets are from the part's base.

| offset | type | field | notes |
|---|---|---|---|
| `+0x10` | f32 | `Tempo` | |
| `+0x14` | f32 | `Swing` | |
| `+0x18` | f32 | `EchoFeedback` | |
| `+0x1c` | f32 | `EchoTime` | |
| `+0x20` | f32 | `EchoMix` | |
| `+0x24` | i32 | `ReverbSetting` | a preset index, not a raw parameter |
| `+0x28` | bool | `Loop` | |
| `+0x2c` | f32 | `StartPoint` | |
| `+0x30` | i32 | `NumChannels` | |
| `+0x34`…`+0x48` | f32 ×6 | `Volume[0]`…`Volume[5]` | the 6 mixer channels |
| `+0x4c` | f32 | `PlayHead` | runtime state, serialised anyway |
| `+0x54` | bool | `IsPlaying` | runtime state |
| `+0x56` | bool | `MusicSequencer` | ⚠️ see below |
| `+0x57` | bool | `AnimationSequencer` | ⚠️ see below |

⚠️ **`MusicSequencer` and `AnimationSequencer` are two modes of the same part.** The runtime checks
`[part+0x56]` to decide whether a sequencer participates in music playback (`v0x1c5670` walks every
Thing and skips the ones whose `+0x56` is 0). A tracker only cares about music sequencers, but a
level parser must not assume every `PSequencer` is one.

## PInstrument — serialiser at `v0xd36c60`

| offset | type | field | notes |
|---|---|---|---|
| `+0x10` | ref(48) | `Instrument` | → `RInstrument` |
| `+0x18` | string | `Name` | user-visible label |
| `+0x20` | i32 | `Colour` | UI only |
| `+0x24` | i32 | `Loops` | |
| `+0x28` | i32 | `Key` | musical key — quantises the grid |
| `+0x2c` | i32 | `Scale` | musical scale — quantises the grid |
| `+0x30` | f32 | `Level` | per-instrument gain |
| `+0x34` | f32 | `Pan` | |
| `+0x38` | f32 | `EchoSend` | into the sequencer's echo |
| `+0x3c` | f32 | `ReverbSend` | into the sequencer's reverb |
| `+0x40`…`+0x46` | u16 ×4 | `uiscrollx`, `uiscrolly`, `uicurx`, `uicury` | editor viewport, ignorable |
| `+0x48` | ref(1) | `Icon` | texture |
| `+0x68` | array | **`Notes`** | **4 bytes per element** — the note grid |

**`Notes` element size is 4 bytes**, measured: the array's growth helper (`v0xd68370`, passed as
the element callback) allocates `count * 4`. The same mechanism gives 1 for `Name`, which is a
string — so the multiplier is the element size, not a coincidence.

The **internal layout of that 4-byte record** is described under "The note record" below. It is
not ours: it comes from ennuo's toolkit and we have not yet confirmed it against the game. Treat it
as a strong hypothesis — see [open-questions.md](open-questions.md), question 1.

## RInstrument — serialiser at `v0xc68a70`

The serialiser builds field names with `sprintf("%s_%d", base, i)`, so the save format has flat
numbered fields rather than nested arrays.

| base name | count | member stride | what it is |
|---|---|---|---|
| `Samples_0..7` | 8 | `0x10` from `+0x48` | the sample-slot structs below |
| `SampleGuids_0..7` | 8 | `4` from `+0xc8` | u32 GUIDs → the actual audio |
| `Splitnotes_*` | 9 | from `+0xe8` | key-split boundaries between the 8 slots |
| `Numstack` | 1 | | how many slots are actually in use |
| `Params[i]_*` | n | two f32 at `+0x1e8`/`+0x1ec` per index | per-slot parameters, meaning TBD |
| `Arpeggio_*` | n | | arpeggiator pattern |
| `Arpeggiate` | 1 | bool | arpeggiator on/off |

`Splitnotes` having **9** entries for **8** slots is the classic fencepost of a key-split sampler:
8 zones need 9 boundaries. Treat it that way until something contradicts it.

## The sample slot — serialiser at `v0xcc0e90`

This is the heart of the synthesis model. Each of the 8 slots is 16 bytes:

| offset | type | field | stream position | meaning |
|---|---|---|---|---|
| `+0x00` | i32 | `basenote` | 1st | the note the sample was recorded at |
| `+0x04` | f32 | `basebpm` | 2nd | the sample's own tempo, for loops |
| `+0x08` | f32 | `finetune` | **6th (last)** | fine pitch offset |
| `+0x0c` | bool | `pitched` | 3rd | pitch-shift with the note, or play at fixed rate |
| `+0x0d` | bool | `fitbpm` | 4th **and 5th** | rate-match the sample to the sequencer tempo |

⚠️ **Member offset order and stream order are not the same here**, and confusing them
produces a parser that silently reads `finetune` where `pitched` lives. The serialiser emits
`basenote, basebpm, pitched, fitbpm, fitbpm, finetune` — `finetune` is written last even though it
sits at `+0x08`.

**There is no third bool.** The serialiser emits three `bool` calls, but the third passes the *same*
member pointer and the *same* name string as the second: at `v0xcc0ed6` the compiler hoists
`lea r15, [r14+0xd]` and `lea r12, ["fitbpm"]` into registers and then makes the identical call
twice, at `v0xcc0eea` and `v0xcc0ef8`. `fitbpm` is serialised twice into the same field — a
duplicate in the game's own code, not a hidden setting. (An earlier version of this file listed a
phantom bool at `+0x0e`; ennuo's toolkit independently reports the same double write, which is what
prompted the re-read.)

## The playback formula that follows

```
slot      = the slot whose Splitnotes zone contains `note`
ratio     = 2 ^ ((note - slot.basenote + slot.finetune/100) / 12)      # if finetune is in cents
if !slot.pitched:  ratio = 1                                          # percussion
if slot.fitbpm:    ratio *= sequencer.Tempo / slot.basebpm
playbackRate = ratio * (sample.freq / outputRate)
```

⚠️ **`finetune`'s unit is assumed to be cents.** It is a float, which is consistent with cents or
with semitones. Verify before trusting it (open question 4). Everything else in this formula is
directly supported by the field names and by the way the shipped samples are laid out — `piano_C2`
through `piano_C6`, `epiano_C1` through `epiano_C5`, `triangle_synth_C2` through `C6`: one sample
per octave, exactly the shape `basenote` + `Splitnotes` describes.

## The on-disk save format

Everything above is the **in-memory** layout, read out of the serialiser functions. What a level
file actually contains is a different thing, and three properties of it will bite a parser that
assumes otherwise.

### The container — measured, and implemented in `tools/lbpres.py`

Derived from the bytes of real level resources, not from any third-party source. All integers are
big-endian:

```
0x00  char[4]  magic        "LVLb" level, "PLNb" plan, ...
0x04  u32      revision     0x3ee etc. A non-zero high half is a branch id:
                            0x021303f9 = branch 0x0213, revision 0x03f9 (LBP3)
0x08  u32      depsOffset   start of the dependency table = end of chunk data
0x0c  u32      (zero in every file seen)
0x10  u32      (0x07010001 in every file seen — flags, not yet split out)
0x14  u16      numChunks
0x16           chunk table: numChunks x (u16 compressedSize, u16 rawSize)
...            chunk payloads back to back, each a complete zlib stream
```

Chunks are `0x8000` bytes raw except the last, which is short.

⚠️ **The zlib header is `0x68 0xNN`, not `0x78 0xNN`** — CINFO 6, a 16 KiB window. Grepping a
resource for the familiar `78 9c` / `78 da` finds nothing and looks like proof the payload is not
zlib. It is.

**How this was checked:** on 18 real levels spanning revisions `0x3b8`–`0x3f9`, every chunk
inflates, every inflated length matches its declared `rawSize`, and the offset just past the last
chunk lands **exactly** on `depsOffset` in all 18. That offset is never used by the parser, so 18
independent hits on it is not a coincidence.

**1. The stream is big-endian**, including in the PS4 build. Measured: the array serialiser at
`v0xcc0f20` reads four bytes out of the stream and byte-swaps them with `movbe` before storing
(`v0xcc0f9d`, `v0xcc1025`). ennuo's toolkit agrees — its `MemoryInputStream` defaults
`isLittleEndian = false` and only flips for specific platform variants. LBP's formats are PS3-era
and stayed that way.

**2. Stream order is not member order.** The sample slot is the worked example (above): `finetune`
lives at `+0x08` but is written sixth. Always take the order from the serialiser's call sequence,
never from the offsets.

**3. Fields are gated on the file's revision.** A level written by an older build simply does not
contain the later fields, and reading them unconditionally desynchronises everything after. The
gates below are from the toolkit; the version is the resource's own revision word.

| part | field | present when |
|---|---|---|
| `PSequencer` | `ReverbSetting` | version > `0x370` |
| | `Loop` | version > `0x36e` |
| | `PlayHead`, `IsPlaying` | version > `0x369` |
| | `MusicSequencer` | version > `0x36c` |
| | `AnimationSequencer` | **sub**version > `0x28` (LBP3 branch) |
| | `Behavior` (i32) | version > `0x371` |
| | `TriggerPlayer` (i32), `PreviewThing` (Thing ref) | version > `0x3a0` |
| `PInstrument` | `Name` | version ≥ `0x35b` |
| | `Icon` | version ≥ `0x379` |
| | `uiscroll*` / `uicur*` | version ≥ `0x389` |
| `PMicrochip` | `Name`, `Components`, `CircuitBoardSizeX/Y` | version ≥ `0x34d` |

⚠️ `Behavior`, `TriggerPlayer` and `PreviewThing` are **three `PSequencer` fields our own serialiser
walk missed** — the disassembly window stopped at `AnimationSequencer`. The part's allocation size
is `0x60`, which leaves room for them past `+0x57`. Widen the window at `v0xd37d10` when their
offsets matter.

## The note record — 4 bytes

**Field roles confirmed against 18 real levels** (see "How the note record was confirmed" below).
The `end` bit's exact meaning is the one part that is not settled.

| byte | bits | field |
|---|---|---|
| `0` | `0..6` | `x` — step position within this instrument's clip (0–127) |
| `0` | `7` | `triplet` |
| `1` | `0..6` | `y` — pitch (0–127) |
| `1` | `7` | `end` |
| `2` | `0..7` | `volume` (default `0x60`) |
| `3` | `0..7` | `timbre` (default `0x40`) |

Read bytes 2 and 3 as **unsigned**. The toolkit reads them as signed Java bytes while its writer
masks with `& 0xff`; anything above `0x7f` would come back negative.

**A note is a chain of records, not a single record.** Consecutive entries in `Notes` belong to the
same held note until one has `end` set; that record is the last step of the note. Each record in the
chain carries its own `y`, `volume` and `timbre`, so a held note can **glide in pitch and change
volume and timbre step by step** — the format has per-step automation built in, and a tracker that
models a note as (pitch, start, length, velocity) cannot represent what the game can. Model the
chain.

### How the note record was confirmed

18 real LBP2/LBP3 levels (revisions `0x3b8`–`0x3f9`) were decompressed with `tools/lbpres.py` and
scanned for arrays shaped like `Notes`: a big-endian `u32` count followed by `count` 4-byte records.
Every predicate below is a *falsifiable consequence* of the layout above, and each was measured, not
assumed:

| prediction | measured |
|---|---|
| bytes 2 and 3 are 7-bit | **0** records out of ~20,000 with either byte > 127 |
| byte 2's default is `0x60` | the modal value in 578 of 737 arrays is exactly **96** |
| byte 3's default is `0x40` | the modal value in 625 of 737 arrays is exactly **64** |
| byte 0 low 7 is a step index | non-decreasing across every accepted array; **never exceeds 63** |
| byte 1 low 7 is a pitch | spans **12–95**, i.e. C0–B6: a musical range, not a full 0–127 spread |
| byte 0 bit 7 is a rare flag | set in only 12 of 737 arrays |

**The control.** The identical scan over a byte-shuffled copy of each level — same length, same byte
histogram, no structure — found **0 conforming arrays out of 80,810 candidates**, against 737 out of
111,050 in the real data. The predicates are strict enough that chance does not pass them.

Decoded arrays read as unmistakable music: an ostinato alternating A4 with G♯4 then F♯4 then C♯4 at
a constant volume of 59, a C♯1 bassline at volume 96 with `timbre` sweeping 64→79 across each note.

⚠️ **What is *not* confirmed: `end`, and how duration is encoded.** Two results argue against the
naive reading:

- Note lengths under the chain model come out as **14,774 one-step, 5,026 two-step, and only 74
  longer than that**. Real music does not have that distribution — quarter and half notes should be
  common and they are essentially absent.
- Requiring "every run has strictly consecutive `x`" was used as an acceptance filter, which made
  the earlier result circular. Re-measured without it: only **80%** of multi-record runs have
  consecutive `x`, and only 71% of otherwise-conforming arrays have all runs clean.

Some of that is contamination — the scanner pattern-matches at every 4-byte offset instead of
walking the Thing graph, so an unknown fraction of the 737 are coincidences. But it is not safe to
assume that explains all of it. **Resolve this by parsing the level structurally**, so note arrays
come from known offsets, before building anything on the chain model.

We searched the sequencer module (`v0x1c3000`–`v0x1c8000`) and the CWLib audio layer
(`v0x3dd000`–`v0x3fe000`) for the unpacking idiom — `and`/`test`/`shr` against `0x7f`, `0x80` and 7,
in both register and memory forms — and found **nothing**. So the runtime consumer of this bitfield
is somewhere else, or decodes it in a form that scan does not match. Recording the negative result
so the next session does not repeat the sweep.

⚠️ Linear disassembly from `v0x1c3000` desynchronises on the first instruction — that address is
data or mid-instruction. Sync from a known function start.

## The timeline: instruments are components on a circuit board

This is the piece that ties `PInstrument` to the sequencer, and nothing in the part schemas hints
at it. A music sequencer is a Thing carrying **both** a `PSequencer` and a `PMicrochip`. The
instruments are separate Things, children of the microchip's `CircuitBoardThing`, each with a
`PInstrument` part; `PMicrochip.Components` is an array of `CompactComponent`
`{Thing, x, y, angle, scaleX, scaleY, flipped}` giving each one a **position on the board**. That
position is its position on the timeline.

The game converts board position to grid index like this — **measured** at `v0x1c4ad0`–`v0x1c4b23`,
which computes both indices and stores them at `[obj+0x58]` and `[obj+0x5c]`:

```
gridX = floor(2*x / 105.0 - 0.5)     # constants v0xe60f98 = 105.0f, v0xe60f9c = -0.5f
gridY = floor(-y / 105.0)            # note the sign flip: board Y grows upward, rows downward
```

So the cell is **52.5 world units wide and 105 tall**, and X carries a half-cell bias — component
positions are cell centres. A nearby constant `v0xe60fa8 = 0.03125` (1/32) sits in the same
routine.

A step index on the sequencer's own timeline is then:

```
step = gridX * 16 + note.x
```

⚠️ The **16** is the toolkit's `GRID_UNIT_STEPS`, not ours — hypothesis. Its 52.5 for the cell width
is confirmed by the measurement above; its `floor(x / 52.5)` **without the -0.5 bias** is not, and
is a real divergence, not a rounding preference.

`gridY` groups instruments into rows. The toolkit treats "same row + same instrument GUID" as one
track; with `PSequencer.NumChannels` capped at 6 and `Volume[0..5]`, a row is very likely a mixer
channel — but that mapping is not yet established.

## Defaults and ranges worth knowing

From the toolkit's field initialisers — useful for authoring, and as a sanity check when a parsed
value looks wrong.

| where | field | default / range |
|---|---|---|
| `PInstrument` | `Loops` | `1` |
| | `Level` | `1.0` |
| | `Pan` | **`0.5`** — pan is `0..1` centred at `0.5`, not `-1..+1` |
| `RInstrument` | `Numstack` | `1` |
| | `Splitnotes[0]` | `87` |
| | `Params` | **27** entries, each two f32, each preceded by an i32 count of 2 |
| | `Arpeggio` | **32** bytes, each defaulting to `0xf` |
| `Sample` | `basenote` | `48` (the toolkit annotates it as a **MIDI** note number) |
| | `basebpm` | `149.5` |
| `Note` | `volume` / `timbre` | `0x60` / `0x40` |

Each `RInstrument` array is preceded in the stream by an explicit i32 count.

⚠️ **`basenote` and `Splitnotes` may not be in the same numbering.** The toolkit annotates
`basenote` as MIDI note numbers and `Splitnotes` as piano key numbers, which differ by 20. Both
comments cannot be right if the two are compared directly at playback, and our key-split logic
compares them. See [open-questions.md](open-questions.md).

## Runtime entry points (for further RE, not for the tracker)

| what | address |
|---|---|
| `BeginSequencerPlayback__Q5Thingibi` (script binding) | `v0x854b80` |
| → part lookup wrapper | `v0x9629d0` — reads `[thing+0x50] + 0x128` |
| → `PSequencer::BeginPlayback` | `v0x1c4f00` |
| the whole sequencer module | `v0x1c3000` … `v0x1c7000` |
| "stop every other music sequencer" walk | `v0x1c5670` |
| sample preload job (`StartSamplePreload` string at `v0x1c3ce8`) | worker `v0x1c37f0` |

Other useful script bindings: `StopSequencerPlayback__Q5Thingi`, `TriggerSequencerMusic__Q5Thing`,
`GetElemPSequencer__Q5Thingi`, `GetSizePSequencer__Q5Thing`, `GetTimeLengthOnSequencer__Q5Thing`,
`GetSequencerReverbSetting__Q5Thing`, `TweakSequencer`.
