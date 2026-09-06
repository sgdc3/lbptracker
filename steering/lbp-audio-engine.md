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
where `F = [state+0xc8] = 10^((T−3)/10)` is the knee bottom as a power ratio, set by `0x380`.
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

❗ **The table build has no lower clamp, and it does not need one.** `0xc99` branches only on
`L > T+3`, so the cubic *would* be evaluated with `t < 0` — but the axis starts at `F`, which is
`t = 0` exactly, so `t` is never negative and **entry 0 is unity**. The lookup clamps the other
side: `x ≤ F` short-circuits to 1.0 at `0x10fc`. An earlier reading of this file had `F = 0` and
therefore reported a downward expander below the knee and a `NaN` at entry 0; both were artefacts of
that one wrong field. See below.

⚠️ The axis is linear in *power* over `[10^((T−3)/10), 1]`, so it is lopsided on purpose: the whole
4000 entries cover only the 21 dB from the knee bottom to full scale, and half of them sit in the
top 3 dB.

### The detector, the lookup, and what actually reaches the samples — measured 2026-09-06

The block function runs four passes over each 256-frame chunk, on a **de-interleaved** copy of the
input (`0x18b0` in the shim builds it: 2 channels × 256 floats):

1. **`0x1000` — the detector.** Per channel, a sliding sum of squares kept incrementally against a
   ring at `scratch + ch·0x200 + 0xc00`: `sum += x[i]² − x[i−N]²`, index masked by `[state+0xc4]`.
   The result is `max` across channels into the second scratch. (`0x180`, which the shim calls
   first, is **not** the detector — it is `memset(dest, 0, count·4)`, eight instructions, and it
   only zeroes that scratch so the `max` has an identity.)
2. **`0x10f0` — the lookup.** `x = energy/N` with `N = [state+0xc0]`, then index
   `(x − F)·3999/(1 − F)` into the gain table with **linear interpolation** between neighbours;
   `x ≤ F` gives unity, `index ≥ 3999` clamps to the last entry.
3. **`0x1190` — the envelope.** A one-pole on the *gain* — `g·[state+0x104]` against the running
   value, attack coefficient when it falls and release when it rises, the release coefficient
   scaled by how many samples it has been falling (`[state+0x114]`, clamped to 30…1000) — followed
   by a second one-pole, `s ← b₀·u + a₁·s`, `env ← s_prev + s_new`, with `(b₀, a₁)` from the
   `CompCoeffSet` pair: `(0.014048381, 0.97189)` set, `(0.066605777, 0.96715)` clear. Its DC gain is
   `2b₀/(1−a₁) = 0.9995`, so it is unity by design.
4. **`0x330`** — `out[i] = in[i] · env[i]`, four at a time, per channel.

### ✔ And it was RUN, which is how two readings got corrected

`tools/runhammer.py` loads the module into a Windows process — both segments at their own vaddrs in
one RWX allocation so rip-relative references resolve untouched, the five non-PLT relocations and
ten GOT slots written by hand, `powf`/`_FLog` shimmed to the CRT, and a System V ← Windows thunk that
saves the registers the two ABIs disagree about. It runs. The measured transfer, DC input, settled:

| in dBFS | gain | gain dB |
|---|---|---|
| −0.92 | 0.1377 | **−17.2** |
| −6.02 | 0.2338 | −12.6 |
| −12.04 | 0.4362 | −7.2 |
| −17.99 | 0.7480 | −2.5 |
| ≤ −26 | 0.8088 | **−1.84** |

✔ `tools/wavehammer.py` reproduces every one of those to **1e-4 dB**. So the DSP is a working
compressor: it engages above the knee bottom at −21 dBFS and settles to a constant −1.84 dB below it.

The state it computes for itself, which is the part reading got wrong:

```
[state+0xc0] = 64        the detector's window, in samples  (128 if CompLongLook)
[state+0xc4] = 63        the ring mask, N-1
[state+0xc8] = 0.0079433 the axis floor F = 10^((T-3)/10), i.e. the knee bottom as a power ratio
[state+0xe8] = 0.0158489 the threshold as a power ratio, 10^(T/10)
[state+0x104]= 0.808766  the output constant, -1.844 dB
```

`0x380` sets all of them, from the threshold: `powf(10, T/20)` squared for the power ratio, then
`× 0.50118721` (`10^-0.3`) for the floor and `× 1.9952623` (`10^+0.3`) for the top. So **the table's
axis spans exactly the knee**, `[10^((T-3)/10), 1]`, which is why entry 0 is unity.

### ❌ Two readings this file carried, and the single mistake under both

For one commit this section said the DSP **collapsed to a constant −18.04 dB** because
`[state+0xc0]` was never initialised. It is 64. The store is in `0x380`:

```
0x0482  movabs rax, 0x3f00000040          ; N = 64, mask = 63, packed in one register
0x048c  mov qword ptr [rbx + 0x3c], rax   ; rbx = state+0x84, so this writes +0xc0 AND +0xc4
```

❗ A superset disassembly — decoding from every one of the 7,632 bytes so no desync could hide a
store — found **no store to `[reg + 0xc0]`**, and that was *true*. The conclusion did not follow:
**an absolute-offset search is only sound if every access uses the same base**, and this struct is
passed to `0x380` by interior pointer, so the same field is written at `+0x3c` under another name.
The technique was airtight about the wrong question.

The same mistake put `F` at zero, and everything else followed from it: the phantom `table[0] = NaN`
(entry 0 is really the knee bottom, gain 1.0) and the phantom downward expander below the knee (with
the real `F` the cubic is never evaluated below `t = 0`). One wrong field, four wrong conclusions,
all of them self-consistent — which is exactly why none of them looked wrong from inside the
disassembler.

### Where the make-up comes from, and the reading it corrected

After the table loop, `0xd44` computes `0.995 / table[3999]` — an **automatic make-up**,
unconditional on this path — and `0xd5e`–`0xdad` multiplies it by the manual gain, giving
`[state+0x104] = 6.4243 · 0.12589 = 0.8088`. `CompAutoGain = 0` does not disable it: that flag gates
a *different* make-up in `0x620`, computed from `[state+0x100]`, which this path then overwrites.

✔ **That constant is the DSP's floor gain, and it is what the running module produces below the
knee.** `[state+0x104] = 0.808766` multiplies the *table's* gain, so a signal under the knee gets
`1.0 × 0.808766 = −1.84 dB` and a signal at full scale gets `0.154882 × 0.808766 = −17.2 dB`.

❌ For one commit this section instead said the constant was −18.04 dB, reasoning that the lookup
always returned `table[3999]` and cancelled the make-up. That followed from `F` and `N` being read
as zero, and it is wrong. The correction is recorded above rather than deleted because the shape of
it is worth keeping: **four self-consistent conclusions came out of one wrong field**, and running
the module was the only thing that separated them from the truth.

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
- **Compressor**: **read end to end, and then run.** `SMS WaveHammer` sits last on the sequencer's
  channel with its limiter bypassed and its compressor at −18 dB / 10:1 / 10 ms / 250 ms, over a
  64-sample sliding mean square. Measured by executing the module: **−17.2 dB of gain at −0.9 dBFS,
  −7.2 dB at −12 dBFS, and a floor of −1.84 dB below −21 dBFS.** `tools/wavehammer.py` reproduces
  that to 1e-4 dB and `tools/runhammer.py sweep` is the check. ✔ **Implemented 2026-09-06** in
  `src/audio/compressor.ts`, on both the offline and live paths, and pinned by
  `test/compressor.test.ts` against vectors taken from the running module. ❗ It costs a real
  render **6.94 dB of RMS and 6.93 dB of peak** — `level-seq723339` goes from 0.134/0.934 to
  0.060/0.420 — so the note elsewhere in this project that "`FOLD_GAIN` leaves room, peak 0.934 on
  the busiest corpus song" was measuring a chain two DSPs short of the game's.
- **Resampling**: FMOD Ex interpolates in `fmod_dsp_resampler.cpp` at a selectable quality. If we
  play samples through the browser's `AudioBufferSourceNode.playbackRate`, we get *the browser's*
  interpolator instead, which differs between engines and cannot be pinned. This is the single
  strongest argument for writing our own mixer in an AudioWorklet — see
  [tracker-architecture.md](tracker-architecture.md).
- **Pan law**: FMOD's 2D pan is not the same curve as a naive linear pan. Worth one measurement
  before it becomes a systematic stereo-image error across every render.
