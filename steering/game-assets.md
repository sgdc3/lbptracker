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
