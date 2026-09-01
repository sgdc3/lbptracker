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
- fills the state block at `+0x1ad0`, `+0x1ad8`, `+0x1ae0`, `+0x1af0`, `+0x1af8` — ⚠️ steering used
  to call these "audio handles"; they are the **note-block arrays and their count**, see the PRX
  section below,
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

## The sequencer mixes itself — it is not a set of FMOD voices

Searched the CWLib audio layer for the voice start. Did not find the synthesis
function, but found something that changes the shape of the search and validates
the architecture we chose.

The sequencer's audio state is a slice, `+0x1a28`–`+0x1b38`, of a global audio-manager block at
**`v0x132bb10`**, reached through the accessor `v0x3fbf20` (`lea rax, [rip+…]; ret`). Eighteen call
sites use it. The ones that matter:

| function | what it does |
|---|---|
| `v0x3e6c10` | **init**: allocates **`0xbb800` = 768,000 bytes**, 0x80-aligned, stores it at `[state+0x1b18]`, zeroes it, and sets `+0x1a44`=0, `+0x1a48`=1, `+0x1a58`=−1 |
| `v0x3e6e00` | enable/pause, writing its bool argument to `+0x1a44`, under a mutex with a 2-second timeout |
| `v0x3e7060` | **teardown**: releases a **DSP** (`fmod_dspi` `v0xa23680`, `v0xa234d0`), locks the system, pauses a channel group |
| `v0x160930`–`v0x1610c0` | nine near-identical accessors over `+0x1ac8`/`+0x1ad0`/`+0x1ad8` |

**So the sequencer owns a 768 KB audio buffer and a custom FMOD DSP.** It renders its own audio and
feeds FMOD through that DSP rather than allocating an FMOD voice per note — which is why
`tools/fmodapi.py` shows the game barely touching the Channel and Sound APIs, and it is the same
decision [tracker-architecture.md](tracker-architecture.md) argues for on fidelity grounds. 768,000
bytes is 96,000 stereo float frames, two seconds at 48 kHz, or twice that mono; which it is has not
been checked.

⚠️ **This explains why six attempts to find the voice start all dead-ended.** The synthesis lives in
the **DSP read callback**, and a callback is *registered* as a function pointer in an
`FMOD_DSP_DESCRIPTION`, never called directly. No call-graph walk can reach it — not from the
preload path, not from `BeginPlayback`, not backwards from FMOD's pitch conversion. All three
failures now have one explanation.

### The DSP is created at `v0x3e65a0`, and it is called "Sequencer"

Found. The descriptor is **built on the stack**, not stored statically, which is why scanning the
data for one found nothing. At `v0x3e664b`:

```
movabs rax, 0x65636e6575716553      ; "Sequence", little-endian ASCII
mov    [rsp+0x28], 0x72             ; + 'r'      -> name = "Sequencer"
mov    dword [rsp+0x44], 4          ; channels = 4
lea    rax, [rip - 0x101]           ; -> v0x3e6580
mov    [rsp+0x48], rax              ; create   = v0x3e6580
mov    rax, [rip + 0xce5d53]        ; from the global v0x10cc3f8
mov    [rsp+0x60], rax              ; read     = whatever that global holds
mov    [rsp+0x70], 0                ; numparameters = 0
mov    [rsp+0x78], 0                ; paramdesc     = null
call   v0xa48b90                    ; FMOD System::createDSP
```

The field offsets check out against `FMOD_DSP_DESCRIPTION` independently: the struct sits at
`rsp+0x20`, so `create` lands at struct `+0x28`, `read` at `+0x40`, `numparameters` at `+0x50` —
and the two the code sets to zero are exactly the two that should be zero for a DSP with no
parameters. The handle is stored at **`v0x132aac8`**.

⚠️ **`read` is an imported symbol, not eboot code.** The global at `v0x10cc3f8` is zero in the file
and carries a relocation of type **`R_X86_64_GLOB_DAT`** (`info = 0x200000006`) naming dynamic
symbol 2, **`wycAbBCjLI4#C#D`** — a PS4 NID imported from library id 2. So the read callback is
provided by a shared module, while `create` is ours.

**What that implies, and it is good news.** A library-provided read callback cannot know anything
about notes or instruments. It can only be a generic "drain this buffer" reader — which fits the
768 KB buffer at `[state+0x1b18]` exactly. **The synthesis is still game code**: it is whatever
*fills* that buffer, and the DSP merely hands the result to FMOD.

### The writers of the buffer: there are none

Searched. **Exactly three functions in the whole eboot touch `[state+0x1b18]`**: `v0x3e6c10`
(allocate and zero), `v0x3e7060` (free), and `v0x2681e0`, which reads a *dword* at that offset from
an unrelated struct and is a false positive. Nothing writes audio into it. There is also no
rip-relative access to the slot's global address `v0x132d628` anywhere.

**What the buffer is, from three numbers that agree.** The init passes `esi = 0xbb80 = 48000` to the
DSP creation, the descriptor declares `channels = 4`, and the allocation is `0xbb800 = 768,000`
bytes. `48000 × 4 × 4 = 768,000`: the buffer is **exactly one second of 4-channel 32-bit float at
48 kHz**. None of those three was assumed; they are separately encoded and they agree.

**Where the buffer goes.** `v0x3e6c10` creates the DSP with `rdx = rbx` = **the state block itself**
as `userdata`, and the `create` callback `v0x3e6580` does nothing but ask FMOD for that userdata and
cache it at `[dspstate+8]`. The `read` callback is the imported symbol — referenced exactly once,
as the callback, and never called directly.

### CONFIRMED: the synthesis is `fmodextinput.prx`

The module that exports the read callback is
**`D:\PS4Games\CUSA00063\gamedata_orbis\spumodextinput.prx`** — 23 KB, and it exports
**exactly one symbol**, `wycAbBCjLI4`, which is the FMOD read callback.

Getting inside it: it is an fSELF, so the ELF program headers' offsets are not file offsets. Parse
the SELF segment table at `0x20` (32-byte records of `{flags, offset, filesz, memsz}`, with the ELF
segment index in `flags >> 20`); that gives **`file = vaddr + 0x7a0`** for the code segment. The
export's `Elf64_Sym` puts it at module vaddr **`0x170`**, 117 bytes.

The callback itself is trivial:

```
if (inchannels != 4 || outchannels != 4) trap;      // matches channels = 4
memset(out, 0, frames * 16);                        // 16 B/frame = 4ch x f32
for (blocks of 256 frames)
    sub_0xab0(out, 256, [dsp_state + 8]);           // +8 is where OUR create
                                                    // callback cached userdata
    out += 0x1000;                                  // 256 * 16 ✓
```

**`sub_0xab0` is the synthesiser**, and its first act settles everything:

```
memcpy(module_static, ctx, 0x1b50);        // 6992 bytes of the GAME's state block
...
vmovss xmm2, [local + 0x1a28]              // Tempo -- the offset the game writes
vmovss xmm0, [local + 0x1a4c]
mov    dword [local + 0x1a48], 1
```

It copies the game's whole sequencer state and renders from it. The offsets it reads are the ones
`v0x1c6250` and `v0x1c5640` write, which is the cross-check that this is the same structure and not
a coincidence.

**So the note decoding, the envelope and the `Params` consumption are all in a 23 KB module** — not
in the 18 MB eboot, where eight searches looked for them. And the state block is not just settings:
if the PRX renders notes, the note data must reach it inside those 6992 bytes, which is why nothing
in the eboot ever "writes the audio buffer" — the game writes *parameters*, and the PRX writes the
audio.

⚠️ This makes the envelope **recoverable after all**, and cheaply: a 23 KB module with one entry
point, whose input structure we already have partly mapped. That is now the place to work.

---

⚠️ **The reading below was the working hypothesis before the PRX was found. Kept because its
reasoning was sound and its conclusion was right.** The library that
provides `read` (`#C#D`) imports **exactly one symbol**, the buffer pointer never leaves
`[state+0x1b18]`, no eboot code fills it, and the DSP is handed the state block as its context. The
consistent explanation is that the imported module owns the synthesis and treats part of that block
as its own context. That would put the note decoding, the envelope and the `Params` consumption in
a PRX, not here.

The alternative — that the buffer is filled through a pointer copy that this search missed — is not
excluded, but nothing supports it: the allocation's result is stored in exactly one place and read
in exactly two.

**Consequence, and it is the useful part.** If the envelope lives in a separate module, recovering
it statically means finding and analysing that PRX, which is a different and much larger job than
anything attempted so far. **Measuring the game instead is now the cheaper path, not the fallback**
— see the recording proposal in [game-assets.md](game-assets.md). Seven searches have failed for
the same reason, and this is the first explanation that accounts for all seven.

## The synthesiser's runtime structures — mapped from `fmodextinput.prx`

Everything in this section was read out of the PRX's instructions. **How to re-measure it**, since
none of it is guessable:

- `file = vaddr + 0x7a0` (the SELF segment table at `0x20`; see the section above).
- The module's LOAD segments are `vaddr 0x0000 filesz/memsz 0x4ab0` (code + rodata) and
  `vaddr 0x8000 filesz 0x210 memsz 0x53a0` — so everything from `0x8210` to `0xd3a0` is BSS.
- `sub_0xab0` copies the game's block into BSS at **module vaddr `0xb850`** (`lea r14, [rip+0xad6e]`
  at `0x0adb`) and keeps its base in **`r14`** for the rest of the function.
- The base register changes per function: **`r13`** in `sub_0x1c40`, **`r15`** in `sub_0x38e0`,
  **`r9`** (pointing at `+0x1a28`, not at the block start) in `sub_0x290`.
- A whole-module scan for rip-relative accesses into the copy finds only `lea`s of its base: the
  fields are always reached through a register, so a plain disassembly grep does **not** find them.
  Follow branches from an entry point, then collect `[base + disp]`.

### The block is three regions, and the arithmetic proves it

Two independent loops in `sub_0xab0` walk the same array with the same stride:

```
0x0c69   r15 = 0x28 ;  lea rdi, [r14 + r15]        ; add r15, 0xd0 ; cmp r15d, 0x1a28 ; jne
0x0eb0   rbx = 0    ;  lea rdi, [r14 + rbx + 0x28] ; add rbx, 0xd0 ; cmp ebx,  0x1a00 ; jne
```

`0x1a00 / 0xd0 = 32` exactly, and `0x28 + 32 × 0xd0 = 0x1a28` — the array ends precisely where the
settings begin. So the 6992 bytes are:

| range | size | what |
|---|---|---|
| `+0x0000` … `+0x0027` | 40 | header; `+0x10` is a **pointer to the instrument table** |
| `+0x0028` … `+0x1a27` | 6656 | **32 voice records of `0xd0` = 208 bytes** |
| `+0x1a28` … `+0x1b4f` | 296 | settings and playback runtime |

### Settings — corrections to what the eboot side suggested

The eboot writes these; the PRX reads them, which is how the roles below are pinned down.

| offset | type | what |
|---|---|---|
| `+0x1a28` | f32 | **Tempo**. Also passed to the renderer as its third float argument. |
| `+0x1a2c` | f32 | Swing |
| `+0x1a30` | f32 | EchoTime × 0.5 |
| `+0x1a34`, `+0x1a38` | f32 | EchoFeedback, EchoMix |
| `+0x1a44` | i32 | **disabled/paused** — `sub_0x38e0` returns early unless this is 0 |
| `+0x1a48` | i32 | **restart pending**; set to 1 at the top of a block, cleared after the step runs |
| `+0x1a4c` | f32 | the **previous** playhead in steps. A step boundary is `floor(now) != floor(prev)` |
| `+0x1a58` | i32 | −1 sentinel |
| `+0x1a68 + 12·i` | f32 | **Volume[i] × 0.75**, `i = 0..7` — 8 × 12 = 96, ending exactly at `+0x1ac8` |
| `+0x1ad0`, `+0x1ad8` | ptr | **note-block arrays A and B** |
| `+0x1af0` | i32 | **how many note blocks** |
| `+0x1af8`, `+0x1b00` | ptr | **block-header arrays A and B**, 16 bytes per entry |
| `+0x1b18` | ptr | the 768,000-byte output buffer |

⚠️ **`+0x1ad0`/`+0x1ad8`/`+0x1af0`/`+0x1af8` are not "audio handles"** — the note data reaches the
synthesiser through them. The earlier note under *Playback start* is wrong on this point. A/B is
chosen by a module-global byte (`0x8210` in `sub_0x38e0` and `sub_0x3740`, `0xa210` in `sub_0x290`),
which is double buffering: the game can rebuild the notes while the audio thread reads the other copy.

### The 208-byte voice record

| offset | type | what |
|---|---|---|
| `+0x00` | u8 | instrument index; **`0xff` means the voice is free** (`cmp rax, 0xff` → return) |
| `+0x08` | f32 | pitch in **semitones** |
| `+0x0c` | f32 | volume at the start of the block |
| `+0x10` | i32 | **stop**: set to 1 wherever the voice must end |
| `+0x14` | i32 | the caller skips `sub_0x38e0` while this is `> 0` |
| `+0x1c`, `+0x24` | f32 | two output gains, always applied as a pair (12 sites, 3 groups of 4) — *inferred* to be the two output busses of the 4-in/4-out DSP |
| `+0x20` | f32 | broadcast to all SIMD lanes |
| `+0x28` | f32 | pan at the start of the block |
| `+0x2c`, `+0x30`, `+0x34` | f32 | **slide rates** per unit time for volume, pitch and pan |
| `+0x38` | i32 | which note block this voice reads |
| `+0x3c` | u16 | **note cursor** within that block (`inc word ptr` advances it) |
| `+0x3e` | u16 | start offset, scaled by **exactly `1/3`** (`v0x4504 = 0.333333`) |
| `+0x40` | **f64** | **playback position in frames** — a double, not a float |
| `+0xa4` … `+0xc8` | 10 × f32 | filter state: broadcast into SIMD registers at the top of a block (`0x2ea7`–`0x2f04`) and written back at the end (`0x3658`–`0x36b1`) |
| `+0xcc` | i32 | **sample-slot index**, 0..7 |

Three parameters are linear ramps stored as (value, rate) pairs — pitch `+0x08`/`+0x30`, volume
`+0x0c`/`+0x2c`, pan `+0x28`/`+0x34` — and the renderer evaluates each at both ends of the block.

⚠️ `+0x3e`'s scale being **one third** is a lead for open question 3: thirds of a step is exactly
the resolution triplets need. The interpretation is a guess; the constant is not.

### The instrument struct — an independent confirmation of `MAX_SLOTS = 8`

`imul rdx, rax, 0x5f0 ; add rdx, [state + 0x10]` indexes instruments of **1520 bytes**, and
`imul rbx, rax, 0x98` indexes sample slots of **152 bytes** from offset 0 of the instrument. So:

```
instrument (0x5f0)
  +0x000 … +0x4bf   8 slots x 152 bytes          <- 8 x 152 = 1216 = 0x4c0
  +0x4c0 … +0x5ef   304 bytes of instrument data
```

**Eight slots, derived here purely from struct arithmetic**, matching `MAX_SLOTS = 8` measured from
the serialised resource. Two unrelated sources agreeing is what makes this solid.

The renderer reads four (lo, hi) float pairs from the instrument tail — at `+0x540`/`+0x544`,
`+0x548`/`+0x54c`, `+0x550`/`+0x554`, `+0x558`/`+0x55c` — and lerps each by the voice's pan value.
Ranges lerped by a modulation source is the shape the 27 `Params` would take, but which params these
are is **not** established; see open-questions.

### The 152-byte sample slot — and three mip levels

| offset | type | what |
|---|---|---|
| `+0x00`, `+0x28`, `+0x50` | 40 B each | **mip 0 (full rate), mip 1 (÷2), mip 2 (÷4)**; each has data pointers at its own `+0x08` and `+0x10` |
| `+0x78` | i32 | **length in frames**. `<= 0` switches the slot to a saw oscillator (below) |
| `+0x7c` | i32 | **loop start** |
| `+0x80` | i32 | **loop length**; `<= 0` means no loop |
| `+0x84` | i32 | the slot's **root note** |
| `+0x88` | f32 | the slot's **native tempo** |
| `+0x8c` | f32 | **fine tune in semitones** |
| `+0x90` | u8 | **pitched**: when 0 the ratio is forced to exactly 1.0 |
| `+0x91` | u8 | **tempo-synced** |
| `+0x94` | u8 | **stereo** (selects a ×4 stride over ×2) |

Looping is a plain modulo (`0x3769`–`0x377a`): if `pos > loopStart + loopLength`, then
`pos = (pos − loopStart) mod loopLength + loopStart`. The region is
**`[loopStart, loopStart + loopLength)`**, half-open — the same join our `loopRegion()` reached by
measuring smoothness, from the other direction.

### The pitch formula — measured, no free constants

`0x1d71`–`0x1db3`, with `v0x4508 = 0.0833333 = 1/12` and an imported **`exp2f`** (NID
`wuAQt-j+p4o`, resolved against the PS4 NID hash):

```
if (!slot.pitched)  ratio = 1.0
else                ratio = exp2f((t·voice.pitchSlide + voice.pitch + slot.fineTune
                                   − (float)slot.rootNote) · (1/12))

if (slot.tempoSynced)  ratio *= Tempo / slot.nativeTempo
```

That replaces the three constants still marked UNMEASURED in `src/core/voice.ts`. The tempo-sync
branch is new: some slots stretch with the sequencer's tempo instead of being pitched.

### The sampler is LINEAR, and it mipmaps by octave

This answers open question 7, and it is not a preference — it is what `sub_0x3740` does.

**Mip selection**, on the pitch ratio, with the constants read from rodata:

| ratio | mip | position scale |
|---|---|---|
| `>= 4.0` (`v0x4530`) | `slot + 0x50` | `× 0.25` (`v0x4534`) |
| `>= 2.0` (`v0x4538`) | `slot + 0x28` | `× 0.5` (`v0x453c`) |
| otherwise | `slot + 0x00` | `× 1` |

The fraction is carried correctly into the mip: for the ÷4 level the index is `pos / 4` and the
fraction is `(frac + (pos mod 4)) / 4`. So **a note two octaves above its slot's root reads a
pre-decimated copy** rather than skipping frames in the full-rate one.

**How much of the keyboard this covers — measured**, by running every instrument's own splits and
pitch formula over the note range and asking which mip each note lands on:

| notes | instruments ever on a mip | note-slots on a mip | of single-slot instruments' notes |
|---|---|---|---|
| 0..87 | 55 / 68 | 17.3% | 27.9% |
| 0..127 | 68 / 68 | 41.7% | 50.4% |

So it is not a corner case — but it is concentrated in the **21 single-slot instruments**, which
stretch one recording across the whole keyboard (`woodpecker` reaches playback rate 383). A dense
multisample rarely needs it: the piano's five slots keep the rate near 1 across the middle.

⚠️ **It therefore does not explain the F5 click on the piano.** F5 is note 77 on the C6 slot, i.e.
rate 0.67 — below 1, no mip involved. That symptom stays where it was, with the loop contour and the
missing envelope.

**The interpolation** (`0x38ac`–`0x38d7`, mono path), with `v0x4540 = 3.05176e-05 = 1/32768`:

```
a = (float)d[i]   · 1/32768
b = (float)d[i+1] · 1/32768
out = a + (b − a) · frac
```

Two taps. Plain linear. The stereo path (`0x3847`–`0x38a2`) is bilinear: it lerps L and R by a
blend the caller passes, and lerps the two frames by `frac`.

⚠️ **So `sinc8` is the wrong default for a faithful tracker.** Linear is not a compromise here, it
is the target. The SNR table in `src/audio/interpolate.ts` still stands — the game simply lives with
19 dB at 4 kHz, and that roughness is part of the sound being reproduced. What keeps it from being
as bad as that table implies is the mipmapping, which is the half of the design we were missing.

When a slot has no data (`length <= 0`) the reader synthesises `frac(pos × 0.01) × 2 − 1` — a
**saw oscillator** fallback (`v0x4544 = 0.01`, `v0x4548 = −1`).

### Notes at runtime — 4 bytes each

`sub_0x38e0` walks them. Each of the `[state+0x1af0]` blocks is `0x470` = 1136 bytes:

| offset | what |
|---|---|
| `+0x00` | i32, **note count**; the voice ends when its cursor reaches it |
| `+0x1c` | i32, the block's **length in steps** |
| `+0x20 + 4·cursor` | the **note words**, 4 bytes each |

with a parallel 16-byte header per block (`[state+0x1af8]`/`+0x1b00`) whose `+0x00` is a **start, in
units of 16 steps** and whose `+0x0c` is a **lane index** — `sub_0x290` tests it with `bt` against a
mask argument, so lanes can be muted individually.

Of the note word, two fields are certain:

- **bits 0..6** — the step within the block, compared against `currentStep − header.start·16`
- **bit 15** — set means "stop the voice here"

The remaining bits carry pitch and velocity but were not decoded; this is the runtime form, built
from the on-disk record documented above, not the record itself.

## The envelope — found. `Params[11..14]` is an ADSR

This was the top open question for four sessions. It is `Params`, it is an ordinary ADSR, and three
independent lines of evidence agree on the assignment.

### Where `Params` lives, exactly

The eboot builds the runtime instrument at **`v0x1c3fb0`**, and the tail comes from `v0x2a1140`,
which settles the offsets with a single instruction:

```
v0x2a1192   lea  rdi, [r14 + 0x4e8]        ; runtime instrument + 0x4e8
v0x2a1199   lea  rsi, [rbx + 0x110]        ; the PInstrument's Params
v0x2a11a0   mov  edx, 0xd8                 ; 216 bytes = 27 x (f32, f32)
v0x2a11a5   call memcpy
```

So **`Params[i].x` is at `instrument + 0x4e8 + 8i` and `.y` at `+0x4ec + 8i`**, running to `+0x5bf`
— and the next field starts at exactly `+0x5c0`, which is the fit that makes this certain rather
than merely consistent. The rest of the tail falls out of the same function and **matches our
serialised reader's field order exactly**:

| runtime | size | field |
|---|---|---|
| `+0x4c0` | 9 × 4 | `Splitnotes[0..8]` |
| `+0x4e4` | 4 | `Numstack` — this is the `cmp` the renderer does at `+0x4e4` |
| `+0x4e8` | 27 × 8 | **`Params`** |
| `+0x5c0` | 32 | `Arpeggio` |
| `+0x5e0` | 1 | `Arpeggiate` |
| `+0x5e4` | 4 | the instrument id, used to dedupe the table |

The same function also copies the eight slots at stride `0x98`, and copies `+0x84`/`+0x88` as one
qword and `+0x90`/`+0x91` as one word — a third confirmation of the slot layout, and of `pitched`
and `fitBpm` being adjacent bytes.

### Each param is a **range**, not a value

Every use in the PRX has the same shape:

```
value = Params[i].x + mod * (Params[i].y - Params[i].x)
```

where `mod` is the voice's own `+0x28`, set at note-on from **bits 24..27 of the note word divided
by 15** (`v0x4550 = 0.0666667`). So `.x` and `.y` are the ends of a range and each note picks a
point inside it with a 4-bit value. Where `.x == .y` — most instruments, most params — the parameter
is simply fixed.

### Two ADSRs, `sub_0x1690`

`sub_0x1690(bool gate, float *level, float dt, float a, float d, float s, float r)` advances a
per-voice envelope level held at the pointer, and the renderer calls it four times — twice per
envelope, once with a near-zero `dt` and once with the block's, which is how it gets a start and an
end value to ramp between, exactly as it does for volume and pitch.

| envelope | level state | Attack | Decay | Sustain | Release | passed at |
|---|---|---|---|---|---|---|
| A | `voice + 0x90` | `Params[11]` | `Params[12]` | **`Params[13]`** | `Params[14]` | `0x1fa3`, `0x1fed` |
| B | `voice + 0x94` | `Params[7]` | `Params[8]` | `Params[9]` | `Params[10]` | `0x2193`, `0x21cd` |

The gate is `voice[+0x10] == 0` — the flag the sequencer sets when the note's chain ends. So the
envelope attacks and decays while the note is held and releases once it is not.

**The stages are linear in level, and the stage time is the parameter squared.** In the release
branch:

```
xmm2 = release * release
level = level - dt / xmm2          ; and level is clamped at 0, which ends the voice
```

with `dt = frames * 5.20833e-06` (`v0x4510`) — that is `frames / 192000`, i.e. **quarter-seconds at
48 kHz**, so a stage time of `param² × 4` seconds. The level is mirrored around 1 (values above 1
encode the rising phase), which is why the function starts by folding `2 - x`.

⚠️ **The `param² × 4 s` reading is a derivation, not a direct measurement**: it follows from the
constant and from the renderer's frame count, and it has not been checked against the game. The
other `dt` constant (`v0x450c = 2.08333e-08 = 1/48,000,000`) feeds the first call of each pair and
is 250× smaller; the reading above assumes that call is there to sample the current level rather
than to advance it. Settle both against a recording before trusting stage times to the millisecond.
The full state machine inside `sub_0x1690` — how decay hands over to sustain — was not traced.

### Why the assignment is certain

The disassembly gives the four params and their order. Two independent checks on the data give the
meaning:

**They separate instruments by how they behave.** Hand-labelling 18 struck/plucked instruments
against 15 sustained ones and scoring every param by Cohen's *d*:

| param | plucked | sustained | d |
|---|---|---|---|
| `Params[13].x` | 0.012 | 0.860 | **−3.54** |
| `Params[12].x` | 0.581 | 0.117 | +2.49 |

Nothing else in the 54 values comes close. A sustain level *should* be the single strongest
discriminator between a marimba and a choir, and it is.

**The values themselves are unmistakable.** `Params[13].x` is exactly `1.000` for
`strings_ensemble`, `choir`, `brass`, `clarinet`, `concertina`, `sine_wave` and `saw_wave`, and
exactly `0.000` for `glockenspiel`, `marimba`, `kalimba`, `harp`, `strings_pizz`, `musicbox`,
`vibraphone` and `tubular_bells`. The piano reads **0.070** — a real piano does hold a little under
the damper. `Params[11]` (attack) is `0.000` on everything struck and non-zero only where an
instrument swells: `strings_ensemble` `0.000/0.488`, `synth_strings` `0.070/0.120`, `choir` 0.013.
`Params[12]` (decay) is `0.000` on the sustained winds and strings — which is right, because with
sustain at 1.0 there is nothing to decay to — and largest on `vibraphone` 0.894, `tubular_bells`
0.850, `marimba` 0.756, `glockenspiel` 0.741, `piano` 0.527.

Envelope B's destination is **not** established. Its params sit next to the four the renderer loads
into the SIMD path alongside `Params[3..6]`, and its two results are broadcast into that same path,
so a filter envelope is the obvious guess — but it is a guess.

## Envelope B is a filter envelope, and the filter is a Moog ladder

The second ADSR drives the cutoff of a **4-pole Moog ladder low-pass**, one per voice, and the
filter is not a lookalike — it is the Stilson/Smith approximation published on musicdsp.org as "Moog
VCF, variation 1", reproduced constant for constant.

### The filter, identified

`0x3070`–`0x30d0` computes the coefficients, and the vector constants are exactly `1.0`, `0.8`,
`0.5`, `5.6` and `-1.0`:

```
q = 1 - freq
p = freq + 0.8 * freq * q
f = p + p - 1
q = res * (1 + 0.5 * q * (1 - q + 5.6 * q * q))
```

and `0x3181`–`0x3259` is the ladder itself — four stages of `(prev + t) * p - b * f`, then the
cubic saturation `b4 - b4³/6` with `v0x45?? = 0.166667`:

```
in -= q * b4
t1 = b1;  b1 = (in + b0) * p - b1 * f
t2 = b2;  b2 = (b1 + t1) * p - b2 * f
t1 = b3;  b3 = (b2 + t2) * p - b3 * f
          b4 = (b3 + t1) * p - b4 * f
b4 = b4 - b4 * b4 * b4 * (1/6)
b0 = in
```

**The `1/6` cube appears twice in that same block, and so does the whole recursion: two independent
ladders run interleaved.** Five states each — `b0..b4` — which is exactly the **ten floats at voice
`+0xa4` … `+0xc8`** that the renderer broadcasts at the top of a block and writes back at the end.
That is what those were.

### What drives it

`0x2a0e`–`0x2b1a`, all in SIMD, evaluated **twice per block** — at the block's start and end — so the
renderer can ramp the coefficients across it, exactly as it does for volume, pitch and pan. The
per-sample ramp is the slow path at `0x332b`; when start and end are equal (`vcmpeqps` at `0x304d`
and `0x3052`) it takes a constant-coefficient fast path.

```
keytrack  = 1 + (pitchRatio - 1) * Params[5]
envFactor = 1 + Params[6] * (envelopeB - 1)
freq = clamp(Params[3]² * keytrack * envFactor, 0, 1)
res  = clamp(Params[4]      * envFactor, 0, 1)
```

`pitchRatio` is the voice's own playback rate, cached at `[rbp-0xac0]` from the `exp2f` result — so
`Params[5]` is **key tracking**: the cutoff follows the note.

| param | role | how the corpus behaves |
|---|---|---|
| `Params[3]` | **cutoff**, squared | mean 0.813, wide open (1.0) in 38/68 — the acoustic multisamples. `choir` 0.34, `clarinet` 0.46, `strings_ensemble` 0.42. |
| `Params[4]` | **resonance** | **zero in 60/68**. Non-zero only on `ghost` 0.90, `saw_wave` 0.76, `space_piano` 0.65, `noise` 0.58 — the synth patches. |
| `Params[5]` | **key tracking** | 1.0 in 41/68, 0.0 in 17/68 — near-binary. The piano tracks fully; `choir` and `clarinet` not at all. |
| `Params[6]` | **envelope amount** | zero in 51/68, and ≈0.98 on `square_wave`, `pulse_wave`, `e_guitar_distorted`, `robot`, `electric_piano`, `noise`. |
| `Params[7..10]` | **the filter ADSR** | inert (A=0 D=0 S=1) in 33/68. |

### Why this is the right reading

Two checks beyond the disassembly:

**The instruments that use it are the right ones.** Of the 35 whose envelope B is not inert, almost
all are synthetic or electric — `pulse_wave`, `saw_wave`, `sine_wave`, `ray_gun`, `robot`,
`mosquito`, `e_guitar_distorted`, `e_guitar_power`, `electric_piano`, `space_piano`, the drum kits
and the `baiyon` patches. A sampled acoustic instrument already has its timbral evolution in the
recording; a static synth waveform is exactly what needs a cutoff sweep.

**The two ways of switching it off agree.** An inert envelope B sits at level 1.0 forever, so
`envFactor` is 1; an amount of zero gives `envFactor` = 1 too. They are redundant, and the corpus
shows the redundancy: **27 of the 28 instruments with `Params[6]` = 0 also have an inert envelope
B**. The seven that disagree disagree in the harmless direction — one control neutralised while the
other is left set.

⚠️ The resonance picking up `envFactor` as well as the cutoff is read off `0x2aee`, where the same
register carrying `envFactor` is multiplied by the evaluated `Params[4]`. It is the least certain
line in this section; the cutoff path is unambiguous.

## The note word — 4 bytes, decoded

`sub_0x38e0` pulls it apart with `bextr`, so the field boundaries are literal immediates rather than
inferred masks.

| bits | what |
|---|---|
| 0..6 | step within the block, compared against `currentStep − header.start × 16` |
| 7 | sub-step, **shifted left by bit 30** → 0, 1 or 2 |
| 8..14 | the note, as a **scale degree** (see below) |
| 15 | end of the note's chain |
| 16..23 | velocity → `voice.volume = v × 1/127` (`v0x454c`) |
| 24..27 | the modulation that picks a point in every `Params` range → `× 1/15` |
| 28..29 | selects one of four per-block tables at `+0x428 + 20k` |
| 30 | the sub-step shift, above |

**Note position is `step + subStep/3`** (`v0x4558 = 0.333333`), which is where triplets come from
and what the voice record's `+0x3e`/`+0x3f` pair counts — start and end of the note in thirds of a
step. That closes the lead recorded earlier against open question 3.

### The pitch goes through a scale quantiser — `sub_0x250`, decoded

The 7-bit note field is **snapped to a scale** before it becomes a pitch:

```
voice.pitch = quantise(note, scale) + blockRoot - 12          ; scale from the note block's +0x0c,
                                                              ; root from its +0x10
quantise(n, s):
    if (unsigned)(s - 1) > 4:  return n                       ; out of range -> chromatic
    octave = n / 12                                           ; signed division
    return octave * 12 + TABLE[s][n mod 12]
```

`TABLE` is at module vaddr **`0x8090`** — reached through a relocated pointer at `0x8020`, so it is
in the data segment, whose file mapping is `file = vaddr − 0x2d90` (SELF segment [3], `off=0x5270`,
`vaddr=0x8000`). Six rows of twelve `int32`; row 0 is not a scale, because scale 0 returns early.

| scale | table row | tones |
|---|---|---|
| 1 | `0 1 2 3 4 5 6 7 8 9 10 11` | **chromatic** — the identity |
| 2 | `0 0 2 2 4 5 5 7 7 9 9 11` | **major** — {0,2,4,5,7,9,11} |
| 3 | `0 0 2 3 3 5 5 7 8 8 10 10` | **natural minor** — {0,2,3,5,7,8,10} |
| 4 | `0 0 0 3 3 5 5 7 7 7 10 10` | **minor pentatonic** — {0,3,5,7,10} |
| 5 | `0 0 3 3 5 5 6 6 7 7 10 10` | **blues** — {0,3,5,6,7,10} |

The octave is preserved, and every entry lands on a tone of its own scale within two semitones. So
the note field is a semitone after all — but one the engine moves by up to two, which is not
something a tracker can skip: on the pentatonic row, seven of the twelve chromatic positions change.

⚠️ **It is not a downward snap**, which was the first reading and is wrong: the blues row sends
position 2 **up** to 3, because blues has no tone at 1 or 2. Ties do not break consistently either —
on that same row position 4 goes up to 5 while position 11 goes down to 10. **Use the tables; do not
replace them with a rule.**

### The three ramps are note-to-note, not an envelope

`sub_0x38e0` reads the **current and the next** note word (`[r12]` and `[r12+4]`), takes the span
between their positions, and sets all three slide rates to reach the next record's values:

```
span = pos(next) - pos(current)                  ; in steps, thirds allowed
voice.volumeSlide = (velocityNext/127 - voice.volume) / span
voice.pitchSlide  = (pitchNext        - voice.pitch ) / span
voice.panSlide    = (modNext/15       - voice.pan   ) / span
```

and when there is no next record it writes **zero** to all three. So a note glides linearly between
its control points and holds flat otherwise — which is exactly the "records are control points"
model we recovered from the corpus, seen from the engine's side. **The amplitude envelope is
separate from this and multiplies it**; the ramps carry the authored automation, `Params[11..14]`
carries the instrument's own shape.

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
