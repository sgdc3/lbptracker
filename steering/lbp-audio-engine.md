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
- **Resampling**: FMOD Ex interpolates in `fmod_dsp_resampler.cpp` at a selectable quality. If we
  play samples through the browser's `AudioBufferSourceNode.playbackRate`, we get *the browser's*
  interpolator instead, which differs between engines and cannot be pinned. This is the single
  strongest argument for writing our own mixer in an AudioWorklet — see
  [tracker-architecture.md](tracker-architecture.md).
- **Pan law**: FMOD's 2D pan is not the same curve as a naive linear pan. Worth one measurement
  before it becomes a systematic stereo-image error across every render.
