# LBP3's audio engine — what we are trying to sound like

Read this when you need to know what the game actually does, as opposed to what the save data
says. Measured from the 1.28 eboot on 2026-09-01.

## One engine: FMOD Ex 4.44.10, statically linked

FMOD's memory tracker passes `__FILE__` at every allocation, so the build paths survive in the
binary. Of 117 source paths left in the eboot, **94 are
`Z:\LBP\sdk\fmod\4.44.10_2_000_131\...`**, 16 are `Z:\bluray3day1\code\CWLib\` (the game), 5 are
Bink. There are 204 `N4FMOD...E` RTTI names. Both halves of FMOD are compiled in:

- `src\` — the low-level API: `fmod_systemi`, `fmod_channelgroupi`, `fmod_dspi`, `fmod_soundi`,
  `fmod_soundgroupi`, the resampler, and codecs for ogg/vorbis/mpeg/celt/vag/wav/xm/it/s3m/midi.
- `tools\fmod_event\src\` — **FMOD Designer**: `EventSystem`, `SoundBank`, `EventInstancePool`,
  `EventParameter`, and the Music System.

Output goes through `orbis\src\fmod_output_audioout.cpp` → `libSceAudioOut`.

**There is no second audio engine.** No Wwise, no NGS2, no AJM, no Scream, no custom mixer.
`libSceAudioOut` is imported with exactly **5 functions**, and their only callers are:

| caller | what it is |
|---|---|
| `v0xa3xxx`–`v0xa5xxx` | FMOD's own Orbis backend |
| `v0xde1xxx` | **Bink** — FMV audio, via RAD Sound System, on its own port |
| `v0x3f5650` | CWLib opening **4 ports of type 2 (VOICE), one per player** — VoIP. Logs `+++++ OPENING AUDIO OUT PORT: %d` |

So the only genuinely separate audio path in the whole game is the movie player.

The dynamic section declares four import libraries — `FMODExtInput`, `FMODSmsReverb`,
`FMODSmsWaveHammer`, `FMODVoIPMixer` — each with **0 imported functions** in the import table.

⚠️ **That zero was once read as "these plugins do not exist", and it is wrong.** All four `.prx`
files are on disk in `gamedata_orbis/spu/`, they are loaded at runtime, and **two of them are the
sequencer**: `fmodextinput.prx` is its synthesiser and `fmodsmsreverb.prx` is its reverb. The
import count is zero because the plugins are resolved by FMOD's own plugin loader rather than by
the dynamic linker. The statically linked Sony `aSfxDsp` is a different effect and is not what
`ReverbSetting` selects.

## How much of FMOD the game actually drives

**190 distinct FMOD entry points, 593 call sites**, concentrated in:

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

Designer events are used for ordinary SFX: at boot the game loads the `.fev` projects and fetches
the event groups `main/sfx`, `main/music` and `lbp3/sfx` (`EventSystem::getGroup` at `v0x9d3190`,
called from `v0x3e7960`), and event paths like `gameplay/items/collect_egg_music`,
`pod/pod_cursor_move`, `lbp3/sfx/ui/pod` are scattered through the code.

⚠️ **FMOD's own Music System is linked but never called.** No game→FMOD edge lands inside
`fmod_musicsystemi` (`v0x9daf18`–`v0x9dbc73`), `fmod_musicengine` (`v0xa0141e`–`v0xa02ab4`),
`fmod_segmentplayer` or `fmod_compositionentities`. Both of LBP3's musical features are written by
Media Molecule on top of FMOD's channel and DSP layer:

- the **Music Sequencer** (this project), and
- **Interactive Music** (`SetInteractiveMusic__ggffiQ5Thing`, `GetInteractiveMusicStemName__gi`,
  `GetInteractiveMusicNumSliders__g` …), which turns out to reach only `channelgroupi` and
  `soundgroupi` — the game synchronises the stems itself. That is a separate system with separate
  data (one `.fsb` per track under `lbp3\music\`); do not conflate it with the sequencer.

## The signal path the tracker has to reproduce

```
PSequencer::BeginPlayback   v0x1c4f00
   sequencer module         v0x1c3000 .. v0x1c7000     ← no direct FMOD calls
        │
   CWLib audio layer        v0x3dd000 .. v0x3fe000
        ├── v0x3e6700..v0x3e72c0   creates the DSP units  (fmod_dspi v0xa23680 / v0xa234d0)
        ├── v0x3fd4c0..v0x3fd5d0   10 × DSP::setParameter (fmod_dspi v0xa23970)
        └── v0x3de390              generic "play sound(id, flags, volume)"
        │
      FMOD  ── channels/channelgroups ── DSP chain ── sceAudioOut
```

`v0x3e7470`, which the sequencer calls directly, tail-jumps into the `DSP::setParameter` block. So
**`PSequencer`'s `EchoTime` / `EchoFeedback` / `EchoMix` / `ReverbSetting` end up as parameters on
FMOD DSP units** — they are not a bespoke effect. That is good news for fidelity: FMOD Ex's echo is
a plain delay line with feedback and a wet/dry mix, and reproducing it in an AudioWorklet is
arithmetic, not guesswork.

## The end of the chain: SMS WaveHammer, and it is a COMPRESSOR

✔ **Measured 2026-09-06.** The sequencer's channel carries three DSPs, and `Channel::addDSP` inserts
at the head, so the last one added sits closest to the output:

```
System::createDSP(&desc)      v0x3e66cb   name "Sequencer",      channels = 4, handle v0x132aac8
System::playDSP(FREE, …)      v0x3e6718   -> the Channel, at [rsp+0x18]
Channel::addDSP(reverb)       v0x3e67f9   "SMS Reverb",          channels = 0
Channel::addDSP(wavehammer)   v0x3e6976   "SMS WaveHammer",      channels = 0, handle v0x132aac0
```

**Sequencer → SMS Reverb → SMS WaveHammer → the mixer.** The description for the WaveHammer is
built on the stack at `v0x3e62b0` (its name arrives as a `movabs` immediate, so it is not in the
string table); `read` is loaded from `[v0x10cc3f8]`, the PRX's one export.

⚠️ The hard clip this project models — `vmaxps`/`vminps` against ∓1 at `0x0889`/`0x0891` of
`fmodextinput.prx` — is **inside the sequencer DSP**, two DSPs before the end. Reading it as "what
the game does at the end of its chain" was an inference, and it was wrong.

### The game configures it, and the limiter is switched OFF

❗ **This is the opposite of what the name suggests, and it is the reason to read a DSP rather than
recognise it.** The compressor section runs; the limiter section is bypassed.

The game never calls `DSP::setParameter` on the handle — `ebxref.py calls 0xa23970` finds fifteen
sites in the binary, nine of them `applyReverbPreset` and none of them this DSP, and `ebxref.py refs
0x132aac0` finds the only four paths to the handle, all create/add/teardown. It configures the
plugin one indirection further down instead: the create callback `v0x3fd6c0` ends with a
`rep movsd` at `v0x3fd8cb` of a **static 0x44-byte template at `v0x1062850`** into the plugin's own
parameter block, overriding eight of the sixteen declared defaults.

| # | Parameter | Unit | Default | **Shipped** | |
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

The parameter block is a plain C struct in declaration order — bools as bytes, numbers as **int32**,
not float — at offsets `0x00, 0x01, 0x04, 0x08, 0x0c, 0x10, 0x14, 0x18, 0x1c, 0x1d, 0x1e, 0x1f,
0x20, 0x24, 0x28, 0x2c`. Three independent readings agree on that layout: the offsets the
`setparameter` callback (`v0x3fda80`) marshals from, the type sequence of the paramdescs at
`v0x10783c0` (`numparameters` = 16, from `v0xbc10a0`), and the kernel's own arithmetic below.

`setparameter` copies that block into a second, **kernel-facing** config laid out as
`[compressor, limiter]` pairs — ratio at `+0x10/+0x14`, threshold at `+0x18/+0x1c`, output gain at
`+0x20/+0x24` — inverts both bypasses into `enabled` flags at `+0x00` (limiter) and `+0x01`
(compressor), and bumps two 16-bit dirty counters at `+0x40/+0x42`. The kernel compares those
against its own copies at `+0x140..+0x146` to decide whether to recompute coefficients.

### What the units mean, from the kernel rather than from the labels

`fmodsmswavehammer.prx` is 11,870 bytes with eight functions. `0x19f0` is the exported read
callback: it traps unless in- and out-channels are both **4** and the length is a multiple of
**256**, then calls `0x1770` per 256-frame block, stepping 0x1000 bytes each time (256 × 4ch × f32,
interleaved). `0x1770` memcpys the instance, the 0x180-byte state and the 0x80-byte config into
static buffers and calls `0xa40`, the kernel — an SPU-DMA shape kept intact on a console with no
SPU, which is why the module lives in `gamedata_orbis/spu/`.

The arithmetic in `0xa40` and in the coefficient function `0x620` settles the units exactly:

- `[cfg+0x18] × 0.1` → dB, so **"10th dB" is literal**: −180 is −18.0 dB (`0xb7c`).
- `[cfg+0x10] × 0.1` → ratio, so 100 is **10.0 : 1** (`0xb92`).
- `10^(x × 0.005)` for output gain, i.e. `10^(dB/20)` — a linear amplitude gain, and −180 gives
  **0.1259** (`0x851`–`0x881`). It reaches the signal at `0x1194`, `vmulss` against `[state+0x104]`.
- Thresholds carry a **6 dB soft knee**: the kernel builds `thresh + 3` and `thresh − 3` and
  interpolates between them (`0xbc0`, `0xbfb`).
- Attack and release become one-pole coefficients `0.1^(1/x)` with `x = round(rate × ms × 1e-4)/8 − 3`
  (`0x6c8`–`0x733`) — note the **1e-4**, not 1e-3, and the /8.
- The compressor is table-driven: a **4000-entry** gain curve in the 0x3e80-byte buffer, rebuilt
  only when the dirty counters move (`0xc43`) and otherwise memcpy'd back from the cache (`0xb44`).

### The static curve, exactly — measured 2026-09-06 from the table build at `0xc43`

The compressor is table-driven. `0xa40` fills **4000 float entries** at `scratch + 0x1000`, indexed
by a **linear sweep of the mean-square level**: entry `i` is the gain for `x = F + (1−F)·i/3999`,
where `F = [state+0xc8]` — which `create` memsets to zero and **nothing ever writes**, so `x = i/3999`.
`L = 10·log₁₀(x)` via `_FLog(1, ·)`, and that is `log10f`: `_FLog` is 21 bytes at libc `0x383e0`
and jumps to `0x37c20` for a positive first argument. Since `x` is a mean square, `L` is ordinary
dBFS and the `10^(ΔL/20)` at `0x0d1a` is the matching amplitude gain.

With threshold `T` (dB) and ratio `R`, the assembly builds

```
K  = 3(1 + 1/R)        A  = 6/K        B  = A/R          (R ≥ 50: K = 3, B = 0)
c2 = 3 − 2A − B        c3 = A + B − 2
t  = (L − T + 3) / 6                      the ±3 dB knee, normalised
out = (T−3) + K·(A·t + c2·t² + c3·t³)     for L ≤ T+3
out = T + (L − T)/R                       for L > T+3   (R ≥ 50: out = T)
gain = 10^((out − L)/20)
```

The cubic is not arbitrary: `P(1) = 1`, `K·A/6 = 1` and `K·B/6 = 1/R` hold **identically in R**, so
it is the unique Hermite that matches value *and* slope at both ends of the knee — unity gain at
`T−3`, slope `1/R` at `T+3`. Which collapses the whole thing to a closed form:

```
r = 0 if R ≥ 50 else 1/R                  the masked reciprocal, see below
gain_dB = −3(1 − r)·t²                    t ≤ 1
gain_dB =  3(1 − 2t)(1 − r)               t ≥ 1
```

⚠️ **`R ≥ 50` is not the same curve with a small `1/R`.** `0xbc9` masks the reciprocal to zero and
`0xcb6` takes `out = T` outright, so from 50:1 up the DSP is a hard limiter rather than a 50:1
compressor. Writing `1 − 1/R` there instead of `1 − 0` costs 0.74 dB at entry 1 — which is exactly
how `tools/wavehammer.py check` caught it, so that case stays in the configurations it sweeps.

✔ `tools/wavehammer.py` holds both the literal transcription of `0xbb4`–`0xd31` and the closed form;
`check` agrees them over five configurations × 3999 entries to **2.1e-14 dB**.

⚠️ **There is no lower clamp, and that is not an oversight in the reading** — `0xc99` branches only
on `L > T+3`, so the cubic is evaluated with `t < 0` all the way down. Below `T−3` the DSP is a
**downward expander**: −2.7 dB at 9 dB under the threshold, −16.9 dB at entry 1. And `table[0]` is
**NaN**, because `log10(0)` is −∞ and `out − L` is then ∞ − ∞. Entry 0 is exact digital silence.

⚠️ The axis is linear in *power*, so it is lopsided on purpose: with `T = −18 dB` the threshold
lands at entry **63 of 4000**. Everything below the threshold gets 63 entries; the compressing
region gets the other 3936.

### ❗ The −18 dB output gain is not an attenuation

After the loop, `0xd44` computes `0.995 / table[3999]` — an **automatic make-up**, unconditional in
this path — and `0xd5e`–`0xdad` multiplies it by the manual gain. So

```
[state+0x104] = (0.995 / table[3999]) · 10^(CompOutGain/20)
              = 6.4243 · 0.12589
              = 0.8088                      = −1.84 dB
```

The +16.16 dB of make-up all but cancels the −18.0 dB the parameter table shows. **Do not read
`CompOutGain = −180` as the game running 18 dB down**; the constant in the shipped configuration is
−1.84 dB. (`CompAutoGain = 0` does not disable this — that flag gates a *different* make-up in
`0x620`, computed from `[state+0x100]`, which the table-rebuild path here then overwrites.)

⚠️ **What is still not settled is how the table and that constant reach the samples.** `0x1194`
multiplies `[state+0x104]` into a value read from the second scratch buffer and compares it against
`[state+0xf0]` (1.0) — a level-domain test, not an output scaling. The buffer is filled by
**`0x180`**, the detector, called at `0x0e1a` and gated on `[cfg+1]`. Until that is read, the static
curve above is the DSP's shape and not yet its effect on a signal. See question 37 in
[open-questions.md](open-questions.md).

## The output stage: the game is a 7.1 renderer

✔ **Measured 2026-09-03**, `v0xa57770` -- the `GetDriverCaps` callback of the output description
built at `v0x13e3c78` and named **"FMOD Orbis AudioOut Output"**:

```
[rdx] = 0x84      FMOD_CAPS_OUTPUT_MULTICHANNEL | FMOD_CAPS_OUTPUT_FORMAT_PCMFLOAT
[rcx] = 0xbb80    48000, and v0xa577f7 rejects anything else
[r8]  = 6         FMOD_SPEAKERMODE_7POINT1
```

The game never calls `setSpeakerMode`, so that is the mode FMOD runs in. Its output plugin's `Init`
(`v0xa577a0`) accepts a speaker count of **2 or 8 and nothing else**, and passes
`param = 4 | (channels != 2)` to `sceAudioOutOpen` -- 4 is `FLOAT_STEREO`, 5 is `FLOAT_8CH` -- then
sets all eight speaker volumes to `32768`, 0 dB, applying no trim of its own.

⚠️ **So everything this project measures from a recording is measured through a downmix**, and the
stereo image the tracker matches is narrower than the game's internal one. That is not a defect in
the recordings; it is what a stereo listener hears. See *22. The stereo width* in
[answered-questions.md](answered-questions.md) for the constant (`PAN_WIDTH = 2-sqrt2`) and for
which half of it belongs to the game and which to the fold.

⚠️ **How the corpus of recordings is captured, and why it matters.** They come from **shadPS4**,
not from PS4 hardware. That is usually irrelevant -- but not for anything measured downstream of
FMOD, where the emulator supplies the code. Its fold lives in
`shared/src/core/libraries/audio/sdl_audio_out.cpp`, `DownmixF32_8CHToStereoPS4`, and it runs only
when the game opens six or more channels **and the host audio device is stereo**. Point shadPS4 at a
device with more than two channels and no downmix happens at all, which is the cheapest way to
capture the game's eight channels directly.

## What this means for matching the sound

- **Echo**: **settled** — not an FMOD DSP at all, but a delay inside `fmodextinput.prx` on a
  192,000-float interleaved-stereo ring. `EchoTime` is a delay in **beats**, its wet is added to the
  reverb send as well as the dry pair, and the plugin hard-clips all four output channels to ±1
  afterwards. See *2 / 2b. The echo* in [answered-questions.md](answered-questions.md).
- **Reverb**: **settled, and it is neither of the two candidates this file used to name.** It is
  `fmodsmsreverb.prx`, a plugin the game ships and loads, and the whole of it has been read: a mono
  downmix into a damped one-pole and a notch, a parallel bank of `tapCount - 2` damped feedback
  combs plus two stereo comb pairs, an output delay, and three panned early-reflection taps. There
  is no Freeverb, no allpass and no `aSfxDsp` in the path. See *6 / 14. The reverb* in
  [answered-questions.md](answered-questions.md); `src/audio/effects.ts` implements it.
- **Compressor**: **static curve settled, detector and application not.** `SMS WaveHammer` sits last
  on the sequencer's channel with its limiter bypassed and its compressor running at −18 dB / 10:1 /
  10 ms / 250 ms; its 4000-entry gain table is a closed form in `tools/wavehammer.py`, and its
  output constant is **−1.84 dB**, not the −18 dB the parameter table shows. See *The end of the
  chain* above. This project models none of it, and the hard clip it does model belongs two DSPs
  earlier. ❗ It reframes every headroom argument: a chain ending in a compressor can be driven hot
  on purpose, one ending in a hard clip cannot, and every judgement made about level here —
  including "`FOLD_GAIN` leaves room, peak 0.934 on the busiest corpus song" — assumed the clip was
  the end.
- **Resampling**: FMOD Ex interpolates in `fmod_dsp_resampler.cpp` at a selectable quality. If we
  play samples through the browser's `AudioBufferSourceNode.playbackRate`, we get *the browser's*
  interpolator instead, which differs between engines and cannot be pinned. This is the single
  strongest argument for writing our own mixer in an AudioWorklet — see
  [tracker-architecture.md](tracker-architecture.md).
- **Pan law**: FMOD's 2D pan is not the same curve as a naive linear pan. Worth one measurement
  before it becomes a systematic stereo-image error across every render.
