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

⚠️ **The internal layout of that 4-byte record is NOT yet decoded.** It is the single blocking
unknown for importing real levels; see [open-questions.md](open-questions.md) for the attack plan.

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

This is the heart of the synthesis model. Each of the 8 slots is:

| offset | type | field | meaning |
|---|---|---|---|
| `+0x00` | i32 | `basenote` | the note the sample was recorded at |
| `+0x04` | f32 | `basebpm` | the sample's own tempo, for loops |
| `+0x08` | f32 | `finetune` | fine pitch offset |
| `+0x0c` | bool | `pitched` | pitch-shift with the note, or play at fixed rate |
| `+0x0d` | bool | `fitbpm` | rate-match the sample to the sequencer tempo |
| `+0x0e` | bool | (unnamed third bool) | ⚠️ the serialiser emits three bools; only two names were resolved |

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
