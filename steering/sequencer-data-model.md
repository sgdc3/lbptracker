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

The **internal layout of that 4-byte record** is described under "The note record" below, and is
confirmed against 1.6 million real notes.

## RInstrument — serialiser at `v0xc68a70`

The serialiser builds field names with `sprintf("%s_%d", base, i)`, so the save format has flat
numbered fields rather than nested arrays.

| base name | count | member stride | what it is |
|---|---|---|---|
| `Samples_0..7` | 8 | `0x10` from `+0x48` | the sample-slot structs below |
| `SampleGuids_0..7` | 8 | `4` from `+0xc8` | GUIDs → RIFF/WAV in the FARCs (see game-assets.md) |
| `Splitnotes_*` | 9 | from `+0xe8` | key-split boundaries between the 8 slots |
| `Numstack` | 1 | | ⚠️ **not** the used-slot count — see below |
| `Params[i]_*` | n | two f32 at `+0x1e8`/`+0x1ec` per index | per-slot parameters, meaning TBD |
| `Arpeggio_*` | n | | arpeggiator pattern |
| `Arpeggiate` | 1 | bool | arpeggiator on/off |

`Splitnotes` having **9** entries for **8** slots is the classic fencepost of a key-split sampler:
8 zones need 9 boundaries.

**Measured across the game's 68 `.rinst` files** (`tools/ExtractGuid.java` pulls them out):

- `Splitnotes` is **descending**, and `splitNotes[0]` is **87 in every single instrument**. Unused
  trailing entries are 0.
- ⚠️ **`Numstack` is NOT the number of slots in use.** It matches the used-slot count in only 14 of
  68. `electric_piano` uses one sample with `Numstack` 2, `ghost` one with 3, and most 8-slot drum
  kits carry 1. It is a voice-stacking count — how many voices to layer per note. To find the slots
  that exist, test `SampleGuids[i] != 0`.
- **The zone→slot rule is settled**: slot `i` covers `splitNotes[i+1] <= note < splitNotes[i]` —
  each bound belongs to the zone **above** it. `splitNotes[0]` is never consulted. Evidence: 62 of
  68 instruments have exactly one non-zero split per used slot, 63 of 68 leave every slot
  reachable, and 73.5% of slots resolve their own base note to themselves against 56.8% for the
  `<=` variant. `baiyon_city_guildford` fits eight for eight.
  ⚠️ **Do not score this rule on "does a zone contain its own base note".** That ranks voicing
  styles, not rules: `guildford` centres its samples, `piano` sets every bound ~6 semitones below
  its slot's base so that it always transposes downward. Both are the same rule.
- `basenote` **is a MIDI note number**, settled: the piano's five slots read 84, 72, 60, 48, 36 and
  its `SampleGuids` resolve to `piano_c6` … `piano_c2`. 84 = C6.
- 68 instruments, 47 of them multisampled, 274 pitched slots against 4 unpitched, and **not one**
  with `fitbpm` set.

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

**2b. Integers are VARINTS, not fixed-width.** Measured by hand-decoding the real
`piano.rinst`: array counts, `i32` and `s32` fields are LEB128-style 7-bit-per-byte varints, and
signed ones are **zigzag** encoded. Floats stay fixed 4-byte big-endian. Worked example, the first
bytes of the piano patch's payload:

```
08            count = 8 slots
a8 01         s32 baseNote : varint 168 → zigzag → 84   (C6)
43 15 80 00   f32 baseBpm  : 149.5
01 00 00      pitched, fitbpm, fitbpm
00 00 00 00   f32 fineTune : 0.0
90 01         next slot's baseNote: 144 → zigzag → 72   (C5)
…
08            count = 8 SampleGuids
c9 be 07      varint → 122697   = piano_c6.smp
c8 be 07      varint → 122696   = piano_c5.smp
…
```

⚠️ `src/core/stream.ts` has **no varint support yet** — it was written for the level container,
whose header is fixed-width. Reading `.rinst` or any Thing data in TypeScript needs it first.

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

**Confirmed against real levels** — field roles against 18, then the chain-and-duration model
against 1.6 million notes from 22. See "How the note record was confirmed" and "Duration" below.

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

### Duration: the records are control points, not a filled span

⚠️ **This is the thing to get right, and it is easy to get wrong.** A note's duration is **not** its
number of records. It is the span between its first and last record:

```
duration_in_steps = x_of_last_record - x_of_first_record + 1
```

A one-record note lasts one step. A two-record note has a start point and an end point and can last
*any* length — 2, 4, 8, 16, 32 steps — with nothing in between. Counting records instead of
measuring the span makes every note look 1 or 2 steps long and the format look broken.

**Measured** over **1,626,983 notes** from 105,785 instruments in 22 levels, walked structurally
(see below), the duration distribution is:

| steps | 1 | 2 | 3 | 4 | 6 | 8 | 16 | 32 |
|---|---|---|---|---|---|---|---|---|
| share | 44.4% | 38.0% | 2.3% | 6.0% | 1.1% | 2.6% | 1.4% | 1.3% |

**93.6% of all notes land on a power-of-two duration**, with clear troughs between the peaks. That
is a sixteenth/eighth/quarter/half/whole distribution — exactly what real music looks like, and
conclusive that the span reading is the right one.

Control points beyond the first and last are automation breakpoints, and they need **not** be at
adjacent steps. Of 905,453 multi-point notes: 698,649 carry no automation (just start and end),
106,797 vary `y` (pitch glide), 92,216 vary `volume`, 62,153 vary `timbre`.

Two facts a parser needs:

- **`end` really does terminate.** Across all 105,785 instruments, **zero** arrays had records left
  over after the last `end`-flagged one.
- ⚠️ **Points are occasionally out of order.** About 81 notes in 1.6 million have a last record
  whose `x` is *smaller* than the first, giving a negative span. Sort a note's points by `x` before
  using them. (`sequencerdump`'s MIDI writer carries a "sometimes this isn't correct" comment at
  exactly this spot — it is a real property of the data, not a bug in the reader.)

### What the corpus says about the rest of the model

Same 105,785 instruments. These are distributions over real creator behaviour, not engine limits —
but several of them settle arguments.

| field | measured |
|---|---|
| clip length (highest `x` used) | **31 dominates** (60,318 clips), then 63. Never above 63 |
| `PInstrument.Loops` | **1 in every single instrument** — the field is unused in practice |
| `PInstrument.Scale` | 0 in 105,680 of 105,785 |
| `PInstrument.Key` | 0 in 101,536; the rest scattered (12, 15, 14, 16, 23…) |
| `PSequencer.Swing` | **0.0 in 103,538** — swing is barely used, so it is a poor thing to tune by ear |
| `PSequencer.Tempo` | 240 most common, then 125, 180, 130, 140, 120 |
| pitch (`y`) | spans 0–95 across the corpus |

A clip topping out at 31 steps, with 63 as the only other common ceiling, says the editor's grid is
**32 steps wide** and a clip may be doubled to 64 — consistent with a 52.5-unit cell holding 16
steps and instruments spanning one or two cells.

`Key` and `Scale` being zero in ~96% of instruments while pitches span 0–95 is evidence that `y` is
an **absolute** pitch and that `Key`/`Scale` only constrain what the editor lets you place. It is
not proof — `Key = 0` may simply mean C — but it is the way to bet until open question 5 is closed.

Most-used instrument GUIDs in the corpus, which is a reasonable priority order for building the
instrument palette: `129085` (Square Wave), `129081` (Ray Gun), `148321` (Baiyon Kit), `129031`
(Acustic Kit), `129084` (Sine Wave), `129089` (Triangle Wave), `129083` (Saw Wave), `186897` (Music
Box), `132205` (Electric Guitar), `129080` (Pulse Wave).

### How the arrays were obtained

`tools/RawDump.java` walks the real Thing graph — `RLevel` → `PWorld.things` → Things carrying both
`PMicrochip` and a `PSequencer` with `MusicSequencer` set → circuit-board components → `PInstrument`
— and emits the note records as raw bytes, one JSON line per instrument. It uses only the
extraction half of the toolkit and none of its musical interpretation, so the statistics above are
independent of any prior reading of the format. 22 levels, zero load or walk failures.

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

## Playback start — `v0x1c5640`

⚠️ **Steering used to label `v0x1c5670` as the "stop all other music sequencers" walk. That is
wrong**: `v0x1c5670` is *inside* `v0x1c5640`, which is the sequencer's **playback start**. It:

- fetches the audio-state block (`v0x3fbf20`, which is just `lea rax, [rip+…]` — a fixed global),
- calls the generic play-sound `v0x3de390` with a constant `1.5`,
- manages audio handles in the state block at `+0x1ad0`, `+0x1ad8`, `+0x1ae0`, `+0x1af0`, `+0x1af8`,
- calls the grid-placement helper `v0x1c49e0`,
- and finishes by pushing the same settings `v0x1c6250` does (below).

**Steps per grid unit — measured.** At `v0x1c5cda`:

```
xmm0 = [PSequencer + 0x4c]
xmm0 = (xmm0 + xmm0) * 16 / 105        i.e.  x * 32 / 105
rax  = (int)xmm0                       truncated to a step count
```

**32 steps per 105 world units**, so **16 steps per 52.5-unit cell** — the figure that until now
came only from `sequencerdump`'s constant, now confirmed against the engine.

⚠️ It also means `+0x4c` is being used here as a **world-space length**, not as a playhead. Our
`PSequencer` schema labels `+0x4c` `PlayHead`, and the volume loop in `v0x1c6250` reads eight floats
through `+0x50`. Both point at the same suspicion: the schema is wrong somewhere between `+0x48`
and `+0x50`. Do not trust `PlayHead`'s offset until this is checked.

## PSequencer → the audio engine — measured at `v0x1c6250`

One small function pushes the whole sequencer part into a global audio-state block, and it settles
several things that were guesses.

| PSequencer field | what the game does with it |
|---|---|
| `Tempo` `+0x10` | copied verbatim |
| **`Swing` `+0x14`** | **`vminss` against `0.99`** (`v0xe60fe4`) — so `Swing` is a **normalised 0..1 ratio**, clamped just below 1. Not a percentage, not a fraction of a step |
| `EchoFeedback` `+0x18` | copied verbatim |
| **`EchoTime` `+0x1c`** | **multiplied by `0.5`** (`v0xe60fe8`) before it reaches the DSP |
| `EchoMix` `+0x20` | copied verbatim |
| **`Volume[]`** | each **multiplied by `0.75`** (`v0xe60fec`) — a fixed headroom factor |
| `ReverbSetting` `+0x24` | passed as an int to `v0x3e7470`, which tail-calls the DSP block |

⚠️ **The volume loop reads EIGHT floats, from `+0x34` to `+0x50`, not six.** Our schema puts
`Volume[0..5]` at `+0x34`–`+0x48` and `PlayHead` at `+0x4c`, so either there are 8 mixer slots with
only 6 serialised, or one of those two offsets is wrong. Unresolved; do not build on either reading
until it is checked.

## The reverb preset table — located and dumped

`ReverbSetting` does **not** index the presets directly. `v0x3fd4c0`:

```
index  = remap[ReverbSetting]        remap table at v0x1062830, 8 entries: 3 6 8 5 11 2 0 0
record = presets + index * 0x2c      preset table at v0x1062620, 12 records of 44 bytes
DSP::setParameter(dsp, 1..10, ...)   from the record, ints converted to float
```

The two tables are adjacent — the presets end exactly where the remap begins, which is what fixes
the counts at 12 and 8.

| preset | p1 | p2 | p3 | p4 | p5 | p6 | p7 | p8 | p9 | p10 |
|---|---|---|---|---|---|---|---|---|---|---|
| 0, 1 | −350 | −200 | 0 | 3 | 25 | 30 | 1 | 20 | 1 | 12000 |
| 2 | −160 | −120 | 8 | 5 | 30 | 70 | 1 | 20 | 1 | 7000 |
| 3 | −200 | −100 | 10 | 1 | 6 | 1 | 1 | 20 | 1 | 5000 |
| 4 | −350 | −300 | 4 | 2 | 25 | 60 | 1 | 20 | 1 | 5000 |
| 5 | −150 | −150 | 2 | 1 | 12 | 5 | 1 | 20 | 1 | 5000 |
| 6 | −100 | −700 | 13 | 0 | 12 | 5 | 1 | 20 | 1 | 5000 |
| 7 | −160 | −200 | 18 | 5 | 25 | 10 | 1 | 400 | 1 | 3000 |
| 8 | −250 | −100 | 16 | 3 | 20 | 15 | 1 | 20 | **0** | 5000 |
| 9 | −130 | −170 | 18 | 3 | 20 | 15 | 1 | 20 | 1 | 10000 |
| 10 | −240 | −200 | 2 | 1 | 10 | 10 | 1 | 20 | 1 | 8000 |
| 11 | −280 | −60 | 4 | 5 | 50 | 45 | 1 | 100 | 1 | 10000 |

Parameters 7 and 9 are set from **bytes tested against zero** — booleans. 1 and 2 are negative in
the hundreds, which reads as **millibels**; 10 lands on 3000–12000, which reads as **Hz**.

⚠️ **The parameter meanings are still unconfirmed, and the boolean slots argue against FMOD.**
`FMOD_DSP_SFXREVERB`'s indices 7 and 9 are `REVERBLEVEL` and `DIFFUSION`, both floats — a boolean
there makes no sense. That is evidence the sequencer's reverb is Sony's `aSfxDsp` plugin rather
than FMOD's, which is the case [project-brief.md](project-brief.md) flags as "close, not
identical". The numbers above are enough to reproduce the *preset choice*; matching the algorithm
is a separate question.

## Runtime entry points (for further RE, not for the tracker)

| what | address |
|---|---|
| `BeginSequencerPlayback__Q5Thingibi` (script binding) | `v0x854b80` |
| → part lookup wrapper | `v0x9629d0` — reads `[thing+0x50] + 0x128` |
| → `PSequencer::BeginPlayback` | `v0x1c4f00` |
| the whole sequencer module | `v0x1c3000` … `v0x1c7000` |
| `RSample` load inside the worker | `v0x1c38aa` — `mov eax, 0x31` / `mov ecx, 0x80000031`, the only such site in the binary |
| **playback start** | `v0x1c5640` (⚠️ `v0x1c5670` is inside it, not a separate "stop others" walk) |
| sample-preload job spawner | `v0x1c3c80` |
| its worker | `v0x1c37f0` |
| `"StartSamplePreload"` string | `v0xe61158` (referenced at `v0x1c3ce5`) |

Other useful script bindings: `StopSequencerPlayback__Q5Thingi`, `TriggerSequencerMusic__Q5Thing`,
`GetElemPSequencer__Q5Thingi`, `GetSizePSequencer__Q5Thing`, `GetTimeLengthOnSequencer__Q5Thing`,
`GetSequencerReverbSetting__Q5Thing`, `TweakSequencer`.
