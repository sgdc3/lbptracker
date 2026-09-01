# Game assets — where the audio lives and how to read it

All measurements below are from the retail LBP3 PS4 build `CUSA00063` (patch 1.28) installed at
`D:\PS4Games\CUSA00063\`. Nothing here is encrypted or obfuscated: the audio ships as plain FMOD
banks in a normal directory.

## Layout

```
D:\PS4Games\CUSA00063\
  gamedata\audio\
    ps3_main.fev  ps3_lbp3.fev  ps3_lbp2_dlc.fev  ps3_move.fev …   FMOD Designer projects
    sfxbank_compressed.fsb        1048 samples  — SFX *and* sequencer instruments
    musicbank.fsb                   28 samples  — ambiences/loops, MP3
    voiceover.fsb  gibberish.fsb  lbp3_vo_eng.fsb  …               dialogue
    lbp3\music\*.fsb   lbp2\music\*.fsb   move\music\*.fsb         one bank per licensed track
    <language>\*.fsb                                               localised dialogue
  base_001.farc  chunk1_001.farc  craftworld_001.farc  intro_001.farc   game resources
```

⚠️ The `.fev` projects are still named `ps3_*` in the PS4 build — the audio assets were carried
over from the PS3 version untouched. Do not read anything into the prefix.

**Totals across all 236 banks: 4488 samples**, of which 3601 IMA ADPCM and 887 MPEG. Sample rates
in use: 4000, 8000, 11025, 16000, 22050, 32000 (1309 samples), 44100 (2526), 48000.

## FSB4 format, as LBP3 uses it

File header, 0x30 bytes, little-endian:

| offset | type | field |
|---|---|---|
| `0x00` | char[4] | `"FSB4"` |
| `0x04` | u32 | `numsamples` |
| `0x08` | u32 | `shdrsize` — total bytes of sample headers |
| `0x0c` | u32 | `datasize` |
| `0x10` | u32 | `version` — `0x00040000` in every LBP3 bank |
| `0x14` | u32 | `mode` — `0x20` (MPEG-padded) in every LBP3 bank |
| `0x18` | u8[8] | zero |
| `0x20` | u8[16] | hash |

Then `shdrsize` bytes of **variable-length sample headers**, then the sample data laid out back to
back in header order. Each header starts with `u16 size` covering the whole header, so you **walk**
the headers, you never index them:

| offset | type | field |
|---|---|---|
| `+0x00` | u16 | `size` |
| `+0x02` | char[30] | name, NUL-padded (truncated to 30 chars — long names are cut) |
| `+0x20` | u32 | `length_samples` (per channel) |
| `+0x24` | u32 | `length_bytes` (compressed) |
| `+0x28` | u32 | `loop_start` |
| `+0x2c` | u32 | `loop_end` |
| `+0x30` | u32 | `mode` — FSOUND_* bits |
| `+0x34` | i32 | `freq` |
| `+0x38` | u16 | `volume` (0-255) |
| `+0x3a` | i16 | `pan` (128 = centre) |
| `+0x3c` | u16 | `priority` |
| `+0x3e` | u16 | `channels` |

Mode bits observed in LBP3: `0x02` LOOP_NORMAL, `0x20` MONO, `0x40` STEREO, `0x200` MPEG,
`0x2000` 2D, `0x80000` HW2D, `0x100000` 3D, `0x400000` IMAADPCM. Bits we have never seen set are
deliberately left unnamed in `tools/fsb.py` — guessing at unseen flags is how you get a decoder
that is quietly wrong.

## The codecs — measured, not remembered

**IMA ADPCM (3601 samples, all the SFX and the instruments).** FMOD's variant: **36 bytes per
channel per block, 64 samples per channel per block.** A block is a 4-byte preamble
(`i16 predictor, u8 step index, u8 pad`) then 32 bytes of 4-bit nibbles, low nibble first. For
stereo the channels' 36-byte blocks are stored back to back, **not** nibble-interleaved.

How that was pinned down, so you can re-check it: the compressed size divided by the sample count
lands on 36/64 = 0.5625 for every mono sample, with the tail padded up to a 32-byte boundary.

| sample | `length_samples` | `length_bytes` | blocks × 36 |
|---|---|---|---|
| `triangle_synth_C4_01.wav` | 9536 | 5376 | 149 × 36 = 5364 → padded 5376 |
| `physx_tinfoil_impact_02.wav` | 14528 | 8192 | 227 × 36 = 8172 → padded 8192 |
| `pod_search_ping_02.wav` (stereo) | 95808 | 107808 | 1.125 B/sample = 2 × 0.5625 ✓ |

**MPEG (887 samples: `musicbank.fsb`, all the `*/music/*.fsb`, dialogue).** Plain MP3 frames.
`amb_mexican_graveyard_LOOP.wav` is 3572352 frames at 44100 Hz = 81.0 s in 1621536 bytes = 160 kbps
stereo. In the browser these go straight into `decodeAudioData`; no custom decoder needed.

## Verified: the decoder works

`tools/fsb.py` implements all of the above and has been checked end-to-end against the game's own
data. Decoding `piano_C3.wav` gives 66112 frames at 22050 Hz, RMS 2770, peak 28588, **zero clipped
samples**, and autocorrelation of the decoded PCM puts the fundamental at **132.8 Hz against C3 =
130.81 Hz** — inside one autocorrelation bin. A wrong ADPCM decoder produces noise, not a clean
tone at the expected pitch, so this is a real check and not a smoke test.

```bash
python tools/fsb.py list "D:/PS4Games/CUSA00063/gamedata/audio/sfxbank_compressed.fsb" piano
```

## ⚠️ The sequencer does NOT use the FSB banks

**Read this before touching the FSB banks for instrument audio.** It was established on
2026-09-01 and it invalidates the assumption the rest of this file was written under.

The music sequencer's samples are **plain RIFF/WAV files stored in the FARC archives**, addressed
by GUID through the game's own file database. The chain, verified end to end:

```
RInstrument.SampleGuids[i]                       e.g. 122694
  → output/orbisguids.map (FileDB, 107,673 rows)  → gamedata/audio/music/samples/keys/piano/piano_c3.smp
                                                    + SHA1 48a8ca84…
  → base_001.farc (19,545 entries, by SHA1)       → 73,440 bytes beginning "RIFF"
```

`tools/GuidLookup.java` does the lookup, `tools/ExtractGuid.java` does the extraction.

**The real piano, measured:**

| file | format |
|---|---|
| `piano_c2.smp` … `piano_c6.smp` | **48000 Hz, 16-bit PCM, mono, uncompressed** |

Against `piano_C2..C6.wav` in `sfxbank_compressed.fsb`: **22050 Hz, 4-bit IMA ADPCM**. They are
different recordings of the same instrument at wildly different quality, and the FSB copies are
audibly gritty — that grit is what the first listening test heard and mistook for a bug in our
resampler. It was neither our resampler nor our decoder: it was the wrong source material.

**How we know the sequencer uses the `.smp` side, not the FSB side.** `piano.rinst`
(GUID 122737 = the "Piano" entry in the stock instrument table) decompresses to an `INSb` resource
whose `SampleGuids` are `122697, 122696, 122695, 122694, 122693` — exactly `piano_c6` down to
`piano_c2` — paired with `baseNote` values `84, 72, 60, 48, 36`. Nothing points at an FSB index.

### The samples carry their own loop points — and you must honour them

Every `.smp` is a RIFF with the sound designer's DAW metadata still attached.
Most of it is debris (`CDif` from Cool Edit, `bext`, `acid`, `JUNK`), but two chunks matter:

- **`smpl` — the sustain loop.** 79 of the 215 samples have one, including every pitched
  multisample. The piano's, measured:

  | sample | frames | loop |
  |---|---|---|
  | `piano_c2` | 50367 | 24168 → 50365 |
  | `piano_c3` | 36546 | 17558 → 36544 |
  | `piano_c4` | 36563 | 20251 → 36561 |
  | `piano_c5` | 30933 | 22361 → 30931 |
  | `piano_c6` | 9966 | 7793 → 9953 |

  All type 0 (forward), count 0 (infinite).

  ⚠️ **Do not use `start` and `end` verbatim — loop `[start-1, end+1)`.** Measured, not reasoned:
  the join has to be phase-continuous, so the question is which frame follows which at the wrap.
  Across the 60 loops with room on both sides, the jump at the join in units of the sample's own
  average adjacent step:

  | join | mean | median | worst |
  |---|---|---|---|
  | `d[end] → d[start-1]` | **0.59×** | **0.37×** | 3× |
  | `d[end+1] → d[start]` | 0.98× | 0.33× | 16× |
  | `d[end] → d[start]` (the literal reading) | 3.28× | 1.86× | 69× |

  A mean below 1 means the join is smoother than an average pair of adjacent frames, i.e.
  continuous. The literal reading is 5× worse, and that is what a listener heard as a transient on
  high notes — `piano_c6`'s loop is 45 ms and wraps 22 times a second, so a 2× step becomes a
  22 Hz buzz. `loopRegion()` in `src/core/wav.ts` does the shift; `test/fsb.test.ts` guards the
  0.59× figure.

  ⚠️ The metric is meaningless for synthesised waveforms. `kenny_saw_a4` measures 108× because a
  sawtooth's vertical edge *is* its shape. Judge it on the acoustic multisamples.

  ⚠️ **And after the join is perfect, a periodic artefact remains — it is the loop's own contour.**
  Reported as a click on high notes like F5. Traced with the metric that matches the ear, which is
  not "is there a big transient" but "is something repeating at the wrap rate":

  | note | wrap rate | envelope modulation at that rate | background | ratio |
  |---|---|---|---|---|
  | **F5** (77) | 14.8 Hz | **5.75%** | 0.29% | **20×** |
  | C6 (84) | 22.2 Hz | 5.29% | 0.19% | **28×** |
  | C4 (60) | 5.6 Hz | 5.36% | 2.41% | 2.2× |

  The cause is not the join. `piano_c6`'s loop region has a **1.70 dB peak-to-trough amplitude
  contour of its own** (17.7%), so repeating it modulates the output at the wrap rate however
  cleanly it is spliced. Applying an exponential decay drops the ratio from **43.7× to 1.4×** — the
  artefact stops standing above the background — which is presumably how the game hides it.

  ⚠️ Three metrics missed this before the right one was used: the adjacent-sample step at the wrap
  is only 1.5× the median, high-frequency energy at the wrap is 0.98× the background, and
  single-block rendering is bit-identical to 128-frame blocks. A 5% modulation is not a transient;
  it is a flutter, and only a modulation measurement finds it.

  `VoiceSpec.decayDbPerSecond` exists for this, defaults to **0**, and is labelled in the code as
  ours rather than the game's. It is the visible cost of not having recovered the real envelope.

  Level continuity was never the problem — the loops sit within ±0.7 dB, so they do not pump. It
  was always phase, and then contour.

- **`inst`** — key range and unity note. Present on a handful of samples.

⚠️ **`smpl`'s `unityNote` is not authoritative.** It reads **60 on every piano sample**, C2 through
C6, which is simply the DAW's default. `RInstrument`'s `baseNote` (84/72/60/48/36) is the real
pitch reference.

**Scale of the library.** 216 entries under `gamedata/audio/music/samples/`, organised by family:
`keys/`, `guitar/`, `orchestra/`, `percussion/`, `synths/`, `sfx/`. Instrument definitions sit
under `gamedata/audio/music/instruments/` as `.rinst` files, one per stock instrument.

**Why the FSB banks looked convincing.** A scan of **all 514 banks, 4846 samples** finds
instrument-shaped names in essentially one place — 25 of them in `sfxbank_compressed.fsb` — and
nothing at all for Glockenspiel, Marimba, Vibraphone, Music Box, Clarinet or the rest of the 59
stock instruments. The handful that do exist there are SFX-bank copies. If the whole instrument
palette had been in the FSBs, they would all be there.

The FSB reader (`tools/fsb.py`, `src/core/fsb.ts`, `src/core/ima.ts`) is still correct and still
needed — it is how the game's SFX and ambience are read, and it is verified byte-exact. It is just
not the sequencer's audio path. Everything below about codecs and bank layout stands; it simply
describes a different part of the game.

## The instrument samples

`sfxbank_compressed.fsb` contains recognisable sequencer instrument material, multisampled one
sample per octave — exactly the shape `RInstrument.Splitnotes` + `basenote` describes:

| family | notes present |
|---|---|
| `piano` | C2 C3 C4 C5 C6 |
| `epiano` | C1 C2 C3 C4 C5 |
| `triangle_synth` | C2 C3 C4 C5 C6 |
| `bass_guitar` | E1 C2 C3 |
| `analogue`, `digital` (in `cross_control_sfx.fsb`) | c2 c3 |

plus unpitched percussion named plainly: `eDrums_kick_01`, `eDrums_HHHO_01`,
`acoustic_hihat_open_01`, `acoustic_ride_cymbal_01`, `physx_african_drum_medium_02`.

⚠️ **Two things not to over-read here.**

1. **Filenames are a hint, not the source of truth.** Only ~6 families across all 236 banks use the
   `stem_NOTE.wav` convention; the rest are named plainly. The authoritative pitch reference is
   `RInstrument`'s `basenote` field, never the filename. Build the mapping from the resource, and
   use names only for display.

   ⚠️ **And never look one up by substring.** Bank names carry their `.wav` suffix, so a search for
   `piano_C4` misses the exact match and falls through — where **`epiano_C4.wav` contains
   `piano_C4`** and comes first in bank order. That silently loaded the electric piano into the
   acoustic piano's key zone in the first listening test, and nothing about it looks wrong until
   you hear it. `findSample` in `src/core/fsb.ts` tries exact, then exact + `.wav`, then prefix,
   and only then substring; a prefix match separates `piano` from `epiano`, a substring cannot.

   The real acoustic piano multisample, for reference — note that C6 is recorded at a different
   rate, which is why the playback rate has to fold in `sample.freq / outputRate` per slot:

   | sample | rate | frames |
   |---|---|---|
   | `piano_C2.wav` | 22050 | 66112 |
   | `piano_C3.wav` | 22050 | 66112 |
   | `piano_C4.wav` | 22050 | 66112 |
   | `piano_C5.wav` | 22050 | 65984 |
   | `piano_C6.wav` | **32000** | 95808 |
2. **We have not yet proved these are the samples the sequencer loads.** We have proved they exist
   and are the right shape. The link `RInstrument.SampleGuids[i]` → actual audio is still
   unresolved — see [open-questions.md](open-questions.md), question 2. The alternative is that
   sequencer audio lives in `RSample` resources (type 49) inside the FARC archives.

## FARC archives — partially understood

`base_001.farc` (1.7 GB), `chunk1_001.farc` (3.3 GB), `craftworld_001.farc` (139 MB),
`intro_001.farc` (90 MB). Resources start at offset 0 with a 4-character magic (`ANMb`, `PLNb`,
`MSHb`, `GTF `, `GMTb`, `BEVb`, …) followed by a version word and then zlib (`78 da`) payload.
The index is at the end: the last 12 bytes are `[u32 BE 20825][u32 BE 1770]["FARC"]`.

⚠️ **The index layout is NOT solved.** Neither 20825 nor 1770 entries, at 24/28/32/36-byte strides
with a trailing big-endian (offset, size) pair, produces a plausible table — most likely the hash
table itself is compressed. **Do not burn a session re-deriving this**: the LBP modding community
has a mature toolchain that already reads FARC archives and LBP resource types. Evaluate that
first and only write our own reader if it turns out not to cover `RInstrument`/`RSample`.

## Asset licensing — a design constraint, not a footnote

Every sample in these banks is copyrighted Sony / Media Molecule material. The tracker **must not
redistribute them**. The loading flow is: the user points the app at their own
`sfxbank_compressed.fsb` (file picker or drag-and-drop), it is parsed entirely client-side, nothing
is uploaded. Build it that way from the first commit — retrofitting a "bring your own assets" flow
onto a design that assumed bundled samples is painful, and shipping a build with the samples baked
in even once is not something you can take back.
