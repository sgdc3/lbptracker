# LBP3's audio engine — everything downstream of the synthesiser

Read when you need to know what surrounds the sequencer's plugin: which engine the game runs, how
little of it the sequencer uses, the two DSPs the game chains after the synthesiser, the 7.1 output
stage, and what a stereo listener hears of it. The plugin itself is in
[synth-engine.md](synth-engine.md). Measured from the 1.28 eboot and the plugins in
`gamedata_orbis/spu/`; addresses per [eboot-re.md](eboot-re.md).

## One engine: FMOD Ex 4.44.10, statically linked

FMOD's memory tracker passes `__FILE__` at every allocation, so the build paths survive in the
binary. Of 117 source paths left in the eboot, **94 are `Z:\LBP\sdk\fmod\4.44.10_2_000_131\...`**,
16 are `Z:\bluray3day1\code\CWLib\` (the game), 5 are Bink. Both halves of FMOD are compiled in:

- `src\` — the low-level API: `fmod_systemi`, `fmod_channelgroupi`, `fmod_dspi`, `fmod_soundi`,
  `fmod_soundgroupi`, the resampler, and codecs for ogg/vorbis/mpeg/celt/vag/wav/xm/it/s3m/midi.
- `tools\fmod_event\src\` — **FMOD Designer**: `EventSystem`, `SoundBank`, `EventInstancePool`,
  `EventParameter`, and the Music System.

Output goes through `orbis\src\fmod_output_audioout.cpp` → `libSceAudioOut`. **There is no second
audio engine** — no Wwise, no NGS2, no AJM, no Scream. `libSceAudioOut` is imported with exactly
**5 functions**, and their only callers are FMOD's own Orbis backend (`v0xa3xxx`–`v0xa5xxx`), Bink
(`v0xde1xxx`, FMV audio on its own port), and CWLib opening 4 ports of type 2 (VOICE) for VoIP
(`v0x3f5650`, logging `+++++ OPENING AUDIO OUT PORT: %d`).

The dynamic section declares four import libraries — `FMODExtInput`, `FMODSmsReverb`,
`FMODSmsWaveHammer`, `FMODVoIPMixer` — each with **0 imported functions**. ⚠️ **That zero was once
read as "these plugins do not exist", and it was wrong.** All four `.prx` files are on disk, they
are loaded at runtime through FMOD's own plugin loader rather than the dynamic linker, and three of
them are the sequencer's whole chain. The statically linked Sony `aSfxDsp` (`v0xab51b0`) is a
different effect and is not what `ReverbSetting` selects.

## How much of FMOD the game drives

**190 distinct FMOD entry points, 593 call sites** (`tools/fmodapi.py`):

| FMOD source file | entry points | call sites |
|---|---|---|
| `fmod_channelgroupi.cpp` | 25 | 87 |
| `fmod_dspi.cpp` | 17 | 60 |
| `fmod_codec_oggvorbis.cpp` | 4 | 59 |
| `fmod_dsp_codecpool.cpp` | 5 | 47 |
| `fmod_soundgroupi.cpp` | 12 | 40 |
| `fmod_eventsystemi.cpp` | 18 | 37 |
| `fmod_eventinstancepool.cpp` | 12 | 27 |
| `fmod_systemi.cpp` | 9 | 23 |

Designer events serve ordinary SFX: at boot the game loads the `.fev` projects and fetches the
event groups `main/sfx`, `main/music` and `lbp3/sfx` (`EventSystem::getGroup` at `v0x9d3190`,
called from `v0x3e7960`), and event paths like `gameplay/items/collect_egg_music` are scattered
through the code.

⚠️ **FMOD's own Music System is linked but never called.** No game→FMOD edge lands inside
`fmod_musicsystemi` (`v0x9daf18`–`v0x9dbc73`), `fmod_musicengine` (`v0xa0141e`–`v0xa02ab4`),
`fmod_segmentplayer` or `fmod_compositionentities`. Both of LBP3's musical features are Media
Molecule's, on top of FMOD's channel and DSP layer: the **Music Sequencer** (this project), and
**Interactive Music** (`SetInteractiveMusic__ggffiQ5Thing` and friends), which reaches only
`channelgroupi` and `soundgroupi` — the game synchronises the stems itself. A separate system with
separate data (one `.fsb` per track under `lbp3\music\`); do not conflate it with the sequencer.

## The sequencer's chain

The sequencer's own audio never touches FMOD's voices: it is one 4-channel DSP whose read callback
is `fmodextinput.prx`, and the sequencer module (`v0x1c3000`–`v0x1c7000`) makes no direct FMOD
calls at all. The chain is built in the CWLib audio layer (`v0x3dd000`–`v0x3fe000`), and
`Channel::addDSP` inserts at the head, so the last one added sits closest to the output:

```
System::createDSP("Sequencer", channels = 4)        v0x3e66cb    handle v0x132aac8
DSP::setDefaults(freq, vol, pan = 0.0, prio = 0)    v0x3e66f4
System::playDSP(FREE, dsp, paused, &channel)        v0x3e6718    <- the DSP IS the channel head
Channel::setMode(FMOD_2D = 8)                       v0x3e67cb
Channel::addDSP(reverb)      "SMS Reverb",     channels = 0    v0x3e67f9
Channel::addDSP(wavehammer)  "SMS WaveHammer", channels = 0    v0x3e6976    handle v0x132aac0
```

**Sequencer → SMS Reverb → SMS WaveHammer → the mixer → 7.1 → the listener's fold.** Both added
DSPs declare `channels = 0`, so they inherit the sequencer's **4**: the two DSPs after it share one
interleaved 4-channel buffer, of which lanes 0-1 are the dry stereo pair and lanes 2-3 the reverb
send. `ReverbSetting` is the only sequencer field that goes through `DSP::setParameter`
(`v0x3e7470` tail-jumps into the `v0x3fd4c0`–`v0x3fd5d0` block); the echo is inside the synthesiser
plugin and the WaveHammer is configured by a template, below. ⚠️ There is no `setParameterData` in
this engine — FMOD Ex 4's DSP parameters are floats; anything that needs a pointer goes through an
argument, which is how the synthesiser receives the game's state block.

## SMS Reverb — `fmodsmsreverb.prx`, the whole DSP

| what | where |
|---|---|
| the preset table, 12 rows × 11 `int32`, and the `ReverbSetting` → preset remap, 8 entries | eboot `v0x1062620`, `v0x1062830` (adjacent — the presets end exactly where the remap begins, which fixes both counts) |
| `applyReverbPreset` — pushes slots 1-10 into DSP parameters 1-10 as floats | eboot `v0x3fd4c0` |
| the configure — parameter block → the plugin's own | eboot `v0x3fcd50` |
| the plugin's configure — parameter block → filter states | PRX `0x0b40` |
| the read callback (the one export, `iO5jJEuFaSo`), the block processor | PRX `0x23a0`, `0x20e0` (de-interleave), `0x14e0` (256 frames) |
| the four kernels, out of line | PRX `0x0910` (one-pole), `0x0960` (notch), `0x09d0` (comb), `0x0a30` (2-in mix) |

`index = remap[ReverbSetting]` with `remap = 3 6 8 5 11 2 0 0`, then the record `presets + index·0x2c`:

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

### The six the sequencer offers, in the game's own words

**Read out of the game's own script.** `AddReverbs__` in `gamedata/scripts/tweaksequencer.ff`
builds the field `TranslatedReverbNames` with exactly six `ARRAY_APPEND`s, each over a `Translate`
of one LAMS key id; the ids resolve through `gamedata/languages/english.trans`. So the list is
settings **0 to 5**, in this order, and the remap's last two entries — both preset 0 — are padding
no menu offers:

| setting | name | preset | RT60 | before the late field | damping | late | early |
|---|---|---|---|---|---|---|---|
| 0 | **Small Room** | 3 | 0.6 s | 1 ms | 5 kHz | -20 dB | -50 dB |
| 1 | **Room** | 6 | 1.2 s | 5 ms | 5 kHz | -10 dB | -110 dB (none to speak of) |
| 2 | **Bright Plate** | 8 | 2.0 s | 15 ms | **off** | -25 dB | -50 dB |
| 3 | **Hall** | 5 | 1.2 s | 5 ms | 5 kHz | -15 dB | -55 dB |
| 4 | **Big Hall** | 11 | 5.0 s | 45 ms | 10 kHz | -28 dB | -46 dB |
| 5 | **Cathedral** | 2 | 3.0 s | 70 ms | 7 kHz | -16 dB | -52 dB |

✔ **Two checks from the other side.** `Bright Plate` is the one preset with the damping filter
switched off, which is what makes a plate bright, and `Small Room` is the shortest. Neither is a
name-shaped argument. ⚠️ **The names are not in decay order**: preset 11 rings longest at 5.0 s
and is the *Big Hall*, not the Cathedral — the trap question 41 existed to stop, see
[answered-questions.md](answered-questions.md).

⚠️ **A composer can choose 0 and none of the 338 corpus sequencers did**: the histogram is 5 on
59.2%, 3 on 35.5%, 4 on 2.4%, 2 on 1.8%, 1 on 1.2%, 0 never. 5 is the mode and what a new song in
this tracker starts at (`NEW_SONG_DEFAULTS`).

The game names more rooms than the sequencer offers — the level-wide reverb is a longer list, and
`REVERB_SETTING_<NAME>` in `english.trans` also answers to Bathroom, Cave, Concert Hall, Forest,
Hallway, Hangar, Padded Cell and Underwater. Which of those the *level's* list holds, and in what
order, has not been read: `GetReverbStrings__` is not defined in
`trigger_global_settings.ff` itself.

`REVERB_NAMES`, `REVERB_SETTINGS` and `reverbSummary` in
`packages/lbp-tracker-lib/src/audio/effects.ts` are this table, and the editor's reverb menu is
drawn from them; `tools/ReverbOrder.java` re-reads it from the game.

Slots 7 and 9 are set from bytes tested against zero — booleans — which is what ruled FMOD's
`SFXREVERB` out (its indices 7 and 9 are `REVERBLEVEL` and `DIFFUSION`, both floats). `v0x3fcd50`
is the whole mapping into the plugin's parameter block:

| slot | → block | meaning |
|---|---|---|
| 0 | `+0x4c` | **dry** level, `10^(v/200)`. Pinned at **−800** by the constructor and never written from the table, and the conversion floors on `v·10 > −8000`, so it is a hard **zero**: the DSP is 100% wet |
| 1 | `+0x48` | **late** level, `10^(v/200)` |
| 2 | `+0x50` | **early** level, `10^(v/200)` **divided by 100** (`v0x3fce41`) |
| 3 | `+0x30` | tap-set index |
| 4 | `+0x34` | early-set index |
| 5 | `+0x38` | decay; RT60 = `v × 0.1` s |
| 6 | `+0x3c` | **output delay in milliseconds** — a delay line after the comb bank |
| 7 | `+0x20` | notch enable |
| 8 | `+0x28` | notch frequency: `f = v/48000`, then `/2.2` if `f < 1/96` else `/3.3`, clamped to `[0.0004, 0.49]` |
| 9 | `+0x24` | damping enable |
| 10 | `+0x2c` | damping: stores `−2π·v/48000`, and the PRX takes `expf` of it |

`[param+0x10]` is a literal **48000.0** (`v0x3fce4f`) and `[param+0x40]` a literal **2**
(`v0x3fce57`): the sample rate and the channel count are hard-coded, not queried.

### The signal flow — the block processor at `0x14e0`

```
 in L,R ──┬────────────────────────────────── * dry (= 0) ─────────────────┐
          │                                                               │
          ├─► earlyLine ─┬─ tap A ─ *(gL,gR) ─┐                            │
          │  (L and R    ├─ tap B ─ *(gL,gR) ─┼─ * earlyLevel ─────────────┤
          │   each)      └─ tap C ─ *(gL,gR) ─┘                            │
          │                                                               ▼
          └─►(L+R)*0.5 ─► damp ─► notch ─┬─► comb[2..n-1] ────► accL ──┐  out L,R
                                         ├─► comb(taps[0])  ────► accL │
                                         ├─► comb(0.93·t0)  ────► accL │
                                         │  accR is a COPY of accL here │
                                         ├─► comb(taps[1])  ────► accR │
                                         └─► comb(1.06·t1)  ────► accR │
                                                                       │
                              accL,accR ─► delay(slot6 ms) ─► * lateLevel
```

- **`0x1695`–`0x173e`** — the input is downmixed to mono, `(L + R) × 0.5`.
- **`0x1780`** — a one-pole `y = a·y + b·x` on that mono signal, with `b = [state+0x14]`,
  `a = [state+0x18]`, built at `0x0b73`–`0x0ba5` as `a = expf([param+0x2c])`, `b = 1 − a`, or
  `b = 1, a = 0` when damping is disabled. The same coefficient pair every comb damps with.
- **`0x1810`** — the notch, `out = x − (a·y1 + b·x + c·y2)`, **in place on the input**, gated by
  `[param+0x20]`; the eboot builds the coefficients at `v0x3fcefb`–`v0x3fcf9f`: `r = exp(−10πf)`,
  `a = 2r·cos(2πf)`, `c = −r²`, `b = r² + 1 − a`.
- **`0x1960`** — `[state+0x510] = tapCount − 2` mono combs on `taps[2..count−1]`, all accumulating
  into one buffer. The kernel `0x09d0`: `x = delay.read(); acc += x; y = a·y + b·x;
  delay.write(gain · (y + send))` — **the raw delayed sample is what accumulates**, with nothing
  between the combs and the sum.
- **`0x1a41`** — the right accumulator is made as a **copy of the left**, after the mono combs and
  before the pairs. That copy is the entire stereo width of the late field.
- **`0x1b10` / `0x1c20`** — `[state+0x514] = 2` pairs of combs, the same kernel: pair 0 is `taps[0]`
  into the left and `taps[1]` into the right, pair 1 is `0.93·taps[0]` left and `1.06·taps[1]`
  right (the ratios at `v0x2bc8`).
- **`0x1d2a`–`0x1d90`, `0x1e0c`–`0x1e73`** — each accumulator goes into a delay line of `slot6`
  milliseconds and the **delayed** value gets `lateLevel`.
- **`0x1ef0`–`0x2051`** — the early reflections: two delay lines fed by the raw L and R input,
  three taps each, every tap panned into both outputs by a gain pair, scaled by `earlyLevel`. Both
  lines have identical lengths, offsets and gains, so one line fed `L + R` is exactly equivalent.

Every comb gain is `powf(10, −0.003 · ms / rt60)` (`0x0d30`, `0x0d90`, `0x0fba`, `0x10e9`) with
`ms` the stage's own length and `rt60 = slot5 × 0.1` s; every tap length is
`round(rate · ms / 1000)` (`0x0ec9`: multiply, add 0.5, `vcvttss2si`) — ⚠️ except the output
delay, which `0x11a9`–`0x11bd` **truncates** (`ms · 0.001 · rate`, `vcvttss2si`, no 0.5);
`effects.ts` does both, and this sentence generalised the taps to it until 2026-09-08.

**The early-reflection rows** are nine floats `[d0, d1, d2, g0, g1, g2, p0, p1, p2]` — three delays
in milliseconds, three gains, three pan positions in 0..1 (`0x1254`–`0x136b`). Fixed offsets
**+0.051, +0.151, +0.078 ms** are added before conversion, then `vcvttss2si` — truncation, unlike
every other length, which rounds. The pan law is linear, `L = (1 − p)·g`, `R = p·g`. ⚠️ **The
delay-to-gain pairing is not positional**: `0x1382`–`0x13ef` sorts the three delays and permutes
the gains as it goes, and the permutation is not the identity even when nothing needs swapping. All
seven rows are already sorted, so one branch is always taken, and it pairs `d0` with `g1`/`p1`,
`d1` with `g0`/`p0`, `d2` with `g2`/`p2`. Do not "fix" it by reading it as positional, and do not
trust it for a hypothetical unsorted row.

### How the wet gets back — there is no connection and no gain

The reverb's read callback asserts 4 in and 4 out and runs `0x20e0` over 256-frame blocks; that
function de-interleaves **channels 2 and 3 only** (`0x21f0`–`0x2216`), and its write-back at
`0x2335`–`0x235d` is `vmovq` and `vpalignr` against a zero register: **it writes `(dryL + wetL,
dryR + wetR, 0, 0)`**. The two DSPs share one buffer, the send lanes are read in place and then
cleared, and `packages/lbp-tracker-lib/src/audio/effects.ts`'s unity at both ends is right. The
cleared lanes are also what stops the send reaching the surrounds (below).

⚠️ **What is not modelled**: the engine works in 256-frame blocks and rounds every delay buffer up
to 1 KB, so a tap shorter than 256 samples cannot behave as a plain per-sample delay there. Tap set
10's shortest is 5.019 ms = 241 samples, so preset 3 (`ReverbSetting` 0) is the one place this
could show — *Residues* in [open-questions.md](open-questions.md). The wrong readings this DSP went
through are *6 / 14* in [answered-questions.md](answered-questions.md).

## SMS WaveHammer — `fmodsmswavehammer.prx`, a COMPRESSOR, read and then run

❗ **The opposite of what the name suggests, and the reason to read a DSP rather than recognise
it**: the compressor section runs; the limiter section is bypassed.

**The game configures it without `DSP::setParameter`.** `ebxref.py calls 0xa23970` finds fifteen
sites in the binary, nine of them `applyReverbPreset` and none this DSP, and `refs 0x132aac0` finds
the only four paths to the handle, all create/add/teardown. The create callback `v0x3fd6c0` ends
with a `rep movsd` at `v0x3fd8cb` of a **static 0x44-byte template at `v0x1062850`** into the
plugin's parameter block, overriding eight of the sixteen declared defaults:

| # | parameter | unit | default | **shipped** | |
|---|---|---|---|---|---|
| 0 | `CompBypass` | bool | 0 | **0** | compressor **ON** |
| 1 | `LimitBypass` | bool | 0 | **1** | limiter **BYPASSED** |
| 2 | `CompThresh` | 10th dB | −120 | **−180** | −18.0 dB |
| 3 | `CompOutGain` | 10th dB | 0 | **−180** | −18.0 dB |
| 4 | `CompRatio` | 10ths | 40 | **100** | 10.0 : 1 |
| 5 | `CompAttack` | ms | 20 | **10** | |
| 6 | `CompRel` | ms | 1000 | **250** | |
| 7 | `CompRelMod` | % | 0 | 0 | |
| 8–11 | `CompAutoGain`, `CompLongLook`, `CompCoeffSet`, `CompUsePeeks` | bool | 0 | 0, 0, **1**, 0 | |
| 12–15 | `LimitThresh`, `LimitOutLevel`, `LimitRel`, `LimitLongLook` | | −60, −60, 1000, 0 | **−120**, **−120**, 1000, 0 | set, but bypassed |

The parameter block is a plain C struct in declaration order — bools as bytes, numbers as
**int32** — at offsets `0x00, 0x01, 0x04, 0x08, 0x0c, 0x10, 0x14, 0x18, 0x1c, 0x1d, 0x1e, 0x1f,
0x20, 0x24, 0x28, 0x2c`, confirmed three ways: the offsets `setparameter` (`v0x3fda80`) marshals
from, the type sequence of the paramdescs at `v0x10783c0` (`numparameters` = 16), and the kernel's
own arithmetic. `setparameter` copies that block into a kernel-facing config laid out as
`[compressor, limiter]` pairs — ratio at `+0x10/+0x14`, threshold at `+0x18/+0x1c`, output gain at
`+0x20/+0x24` — inverts both bypasses into `enabled` flags at `+0x00` (limiter) and `+0x01`
(compressor), and bumps two 16-bit dirty counters at `+0x40/+0x42`, which the kernel compares
against its own copies at `+0x140..+0x146` to decide whether to recompute coefficients.

**The module**: 11,870 bytes, eight functions. `0x19f0` is the exported read callback: it traps
unless in- and out-channels are both 4 and the length is a multiple of 256, then calls `0x1770` per
256-frame block, stepping 0x1000 bytes each time. `0x1770` memcpys the instance, the 0x180-byte
state and the 0x80-byte config into static buffers and calls `0xa40`, the kernel — an SPU-DMA shape
kept intact on a console with no SPU, which is why the module lives in `gamedata_orbis/spu/`.

### The units, from the kernel rather than the labels

- `[cfg+0x18] × 0.1` → dB, so **"10th dB" is literal** (`0xb7c`); `[cfg+0x10] × 0.1` → ratio, so
  100 is **10.0 : 1** (`0xb92`).
- `10^(x × 0.005)` = `10^(dB/20)` for output gain — a linear amplitude, −180 gives **0.1259**
  (`0x851`–`0x881`), reaching the signal at `0x1194` as `[state+0x104]`.
- Thresholds carry a **6 dB soft knee**: `thresh + 3` and `thresh − 3`, interpolated between
  (`0xbc0`, `0xbfb`).
- Attack and release become one-pole coefficients `0.1^(1/x)` with
  `x = round(rate × ms × 1e-4)/8 − 3` (`0x6c8`–`0x733`) — note the **1e-4**, not 1e-3, and the /8.
- `_FLog(1, ·)` is `log10f`: 21 bytes at libc `0x383e0`, jumping to `0x37c20` for a positive first
  argument.

### The static curve — the table build at `0xc43`

`0xa40` fills **4000 float entries** at `scratch + 0x1000`, indexed by a **linear sweep of the
mean-square level**: entry `i` is the gain for `x = F + (1 − F)·i/3999`, where
`F = [state+0xc8] = 10^((T−3)/10)` is the knee bottom as a power ratio (set by `0x380`). With
`L = 10·log₁₀(x)` (ordinary dBFS, since `x` is a mean square), threshold `T` and ratio `R`:

```
K  = 3(1 + 1/R)        A  = 6/K        B  = A/R          (R ≥ 50: K = 3, B = 0)
c2 = 3 − 2A − B        c3 = A + B − 2
t  = (L − T + 3) / 6                      the ±3 dB knee, normalised
out = (T−3) + K·(A·t + c2·t² + c3·t³)     for L ≤ T+3
out = T + (L − T)/R                       for L > T+3   (R ≥ 50: out = T)
gain = 10^((out − L)/20)
```

The cubic is the unique Hermite matching value *and* slope at both ends of the knee — `P(1) = 1`,
`K·A/6 = 1` and `K·B/6 = 1/R` hold identically in `R` — which collapses to a closed form:

```
r = 0 if R ≥ 50 else 1/R
gain_dB = −3(1 − r)·t²                    t ≤ 1
gain_dB =  3(1 − 2t)(1 − r)               t ≥ 1
```

⚠️ **`R ≥ 50` is not the same curve with a small `1/R`**: `0xbc9` masks the reciprocal to zero and
`0xcb6` takes `out = T` outright, so from 50:1 up the DSP is a hard limiter. Writing `1 − 1/R` there
costs 0.74 dB at entry 1, which is exactly how `tools/wavehammer.py check` caught it. ✔ `wavehammer.py`
holds both the literal transcription of `0xbb4`–`0xd31` and the closed form; `check` agrees them
over five configurations × 3999 entries to **2.1e-14 dB**.

❗ **The table has no lower clamp and does not need one**: the axis starts at `F`, which is `t = 0`
exactly, so `t` is never negative and **entry 0 is unity**; the lookup clamps the other side
(`x ≤ F` short-circuits to 1.0 at `0x10fc`). The axis is linear in *power* over `[10^((T−3)/10), 1]`,
so it is lopsided on purpose: 4000 entries cover the 21 dB from the knee bottom to full scale, half
of them in the top 3 dB.

After the table loop, `0xd44` computes `0.995 / table[3999]` — an **automatic make-up**,
unconditional on this path — and `0xd5e`–`0xdad` multiplies it by the manual gain:
`[state+0x104] = 6.4243 · 0.12589 = 0.8088`. `CompAutoGain = 0` does not disable it; that flag
gates a *different* make-up in `0x620`, which this path overwrites.

### The detector, the lookup, the envelope

Four passes per 256-frame chunk on a de-interleaved copy of the input:

1. **`0x1000` — the detector.** Per channel, a sliding sum of squares kept incrementally against a
   ring at `scratch + ch·0x200 + 0xc00`: `sum += x[i]² − x[i−N]²`, index masked by `[state+0xc4]`,
   `max` across channels. (`0x180`, called first, is `memset` — eight instructions zeroing that
   scratch so the `max` has an identity.)
2. **`0x10f0` — the lookup.** `x = energy/N` with `N = [state+0xc0]`, then `(x − F)·3999/(1 − F)`
   into the table with linear interpolation; `x ≤ F` gives unity, `index ≥ 3999` clamps.
3. **`0x1190` — the envelope.** A one-pole on the *gain* — attack coefficient when it falls and
   release when it rises, the release scaled by how many samples it has been falling
   (`[state+0x114]`, clamped 30…1000) — then a second one-pole `s ← b₀·u + a₁·s`,
   `env ← s_prev + s_new`, with `(b₀, a₁)` from `CompCoeffSet`: `(0.014048381, 0.97189)` set,
   `(0.066605777, 0.8667884)` clear. Its DC gain is `2b₀/(1 − a₁)`, unity by design.
4. **`0x330`** — `out[i] = in[i] · env[i]`, four at a time, per channel.

The state it computes for itself, from the threshold in `0x380` (`powf(10, T/20)` squared, then
`× 10^-0.3` for the floor and `× 10^+0.3` for the top):

```
[state+0xc0] = 64        the detector's window, in samples  (128 if CompLongLook)
[state+0xc4] = 63        the ring mask, N-1
[state+0xc8] = 0.0079433 the axis floor F = 10^((T-3)/10)
[state+0xe8] = 0.0158489 the threshold as a power ratio, 10^(T/10)
[state+0x104]= 0.808766  the output constant, -1.844 dB
[state+0x12c]= 0.5       the second smoother's seed, (1 − b0)/(1 + a1) — its own fixed point for a gain of 1
```

### And it was run

`tools/runhammer.py` loads the module into a Windows process ([tools.md](tools.md)). The measured
transfer, DC input, settled:

| in dBFS | gain | gain dB |
|---|---|---|
| −0.92 | 0.1377 | **−17.2** |
| −6.02 | 0.2338 | −12.6 |
| −12.04 | 0.4362 | −7.2 |
| −17.99 | 0.7480 | −2.5 |
| ≤ −26 | 0.8088 | **−1.84** |

`wavehammer.py` reproduces every one to **1e-4 dB**: the DSP engages above the knee bottom at
−21 dBFS and settles to a constant −1.84 dB below it. ✔ **Implemented** in
`packages/lbp-tracker-lib/src/audio/compressor.ts`, after the reverb sum where `Channel::addDSP`
put it, and pinned by `test/compressor.test.ts` against **vectors taken from the running module**
— a deterministic LCG signal under a raised cosine, seventeen sampled gains reproduced to better
than 2e-5. Two things the vectors caught that reading had not: the second smoother's seed
(`[state+0x12c]` is 0.5 at reset, and starting it at zero makes the first sample read 0.0126 where
the module reads 0.998561 — an 18 dB hole lasting 50 ms at the top of every render), and `a1` for
`CompCoeffSet` clear being 0.8667884, not the 0.96715 that `prxdis` prints as the qword-as-double.

❗ **It costs a real render 6.94 dB of RMS and 6.93 dB of peak** (`level-seq723339`: 0.134/0.934 →
0.060/0.420; its closed-loop pole at the release coefficient is `2·b₀·c + a₁ = 0.99957`, about
48 ms). ⚠️ **It is switched off by default** — the one measured DSP the project deliberately does
not run, *38* in [open-questions.md](open-questions.md); the three wrong readings on the way are
*37* in [answered-questions.md](answered-questions.md).

## The output stage: the game is a 7.1 renderer, and a stereo listener hears a fold

`v0xa57770` — the `GetDriverCaps` callback of the output description named "FMOD Orbis AudioOut
Output" (`v0x13e3c78`) — reports `FMOD_CAPS_OUTPUT_MULTICHANNEL | FMOD_CAPS_OUTPUT_FORMAT_PCMFLOAT`
(`0x84`), **48000 Hz** (`v0xa577f7` rejects anything else) and **`FMOD_SPEAKERMODE_7POINT1`**
(`[r8] = 6`). The game never calls `setSpeakerMode`, so that is the mode it runs in; the plugin's
`Init` (`v0xa577a0`) accepts a speaker count of 2 or 8 and nothing else, passes
`param = 4 | (channels != 2)` to `sceAudioOutOpen` — 4 is `FLOAT_STEREO`, 5 `FLOAT_8CH` — and sets
all eight speaker volumes to 32768, 0 dB, applying no trim.

**How a 4-channel DSP reaches eight speakers.** `ChannelSoftware::setPan(0.0, 1.0)` (vtable
`+0x98` → `v0xabdf30`) gives `L = R = 1.0` and, for a source of more than 2 channels, calls
`setSpeakerMix(L, R, 1, 1, L, R, L, R)` (`+0xa8` → `v0xabe160`), which asks for the
channel→speaker matrix (`v0xa243a0`); the 7.1 × 4-channel case is **`v0xa2599f`**, which scales
every level except the two fronts by `k = 0.5` (`v0xefc008`):

| speaker | ch0 | ch1 | ch2 | ch3 |
|---|---|---|---|---|
| front L | `fl` | 0 | 0 | 0 |
| front R | 0 | `fr` | 0 | 0 |
| **centre** | **`c·0.5`** | **`c·0.5`** | 0 | 0 |
| LFE | `lfe·0.5` | `lfe·0.5` | 0 | 0 |
| back L / side L | 0 | 0 | `·0.5` | 0 |
| back R / side R | 0 | 0 | 0 | `·0.5` |

**The centre carries the mono average of the front pair, at 0.5, in FMOD's own code** (the
stereo→7.1 case at `v0xa2579c` does the same). Source channels 2-3 would go to the surrounds — but
they are the reverb send, and the reverb writes them back as zero, so the surrounds are silent and
the 7.1 bus carries only the front pair and the centre's average of it.

**The fold a stereo listener hears.** Every capture this project has was made under shadPS4, whose
downmix (`shared/src/core/libraries/audio/sdl_audio_out.cpp`, `DownmixF32_8CHToStereoPS4`) runs
when the game opens six or more channels and the host device is stereo:

```c
static constexpr float DOWNMIX_CENTER = 0.7071f;                 // FC = 2
d[i*2 + 0] = s[o + FL] + 0.7071f * s[o + FC] + 0.7071f * (s[o+4] + s[o+6]);
d[i*2 + 1] = s[o + FR] + 0.7071f * s[o + FC] + 0.7071f * (s[o+5] + s[o+7]);
```

`1/√2` is the ITU-R BS.775 coefficient that real hardware and a compliant emulator share, so a
stereo listener hears this narrowing either way. Three read constants and no free parameter:

```
plugin pan law   ch0 = (1-p)x, ch1 = px            PRX 0x2d21 / 0x2d40
FMOD upmix       FC = k(ch0 + ch1),   k = 0.5      eboot v0xa2599f, v0xefc008
BS.775 downmix   L = FL + d·FC,       d = 1/sqrt2  shadPS4, and real hardware

L = x[(1-p) + kd],  R = x[p + kd]  →  the normalised pan spans 1/(1 + 2kd) = 2 − √2 = 0.5857864
                                       and the sum grows by (1 + 2kd) = 1/(2 − √2), +4.645 dB
```

✔ Predicted before it was measured: two placements at written pans 0.40 and 0.60 fixed a
one-parameter affine family that predicted **0.261204** for the quiet channel of a hard-panned
voice, and captures at pan 0 and pan 1 measured **0.261202** on both (`tools/panmeasure.py`:
residual 0.0008 of the quiet channel's rms, correlation 1.000000, lag 0) — six significant figures
at an operating point the fit had never seen, where constant power predicts 0.198. At a hard pan
the game's stereo output is effectively mono.

**What the tracker does with it** (`PAN_WIDTH` and `FOLD_GAIN` in
`packages/lbp-tracker-lib/src/audio/effects.ts`): the **gain** is applied, once, after the whole
chain — after the plugin's clip, the reverb and the compressor, where FMOD's speaker matrix applies
it — and the **narrowing is not**, on a listening judgement (*39* in
[open-questions.md](open-questions.md)). ⚠️ The gain is a constant, not `1/panWidth`: `k` and `d`
are constants of FMOD and of BS.775, and coupling the gain to the width slider once turned a
diagnostic into a +20 dB volume control. ⚠️ It belongs *after* the clip: applied per voice it put
the plugin's hard clip 4.645 dB hotter than the game's ever is, engaging on material the game
passes untouched (0.05% of frames on `level-seq732985`; 0.00% after).

⚠️ Everything this project measures from a recording is measured through that downmix, and the
image it hears is narrower than the game's internal one. Point shadPS4 at a device with more than
two channels and no downmix happens at all, which is the cheapest way to capture the eight channels
directly.
