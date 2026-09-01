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
`FMODSmsWaveHammer`, `FMODVoIPMixer` — but each with **0 imported functions**, and no matching
`.prx` exists on disk. They are leftovers from the PS3 build system, not loaded plugins. The Sony
reverb is instead linked in statically as `lib\sfx\foreverb\aSfxDsp.cpp`.

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

## What this means for matching the sound

- **Echo**: reproducible essentially exactly, once we read the parameter indices out of the
  `v0x3fd4c0` block (open question 3).
- **Reverb**: the risk. `FMOD_DSP_TYPE_SFXREVERB` (a Freeverb derivative — reproducible) and the
  Sony `aSfxDsp` plugin (proprietary — not) are **both** linked, and `aSfxDsp` is called from game
  code at `v0xab51b0` (3 sites, from `v0xac67xx`). Which one `ReverbSetting` selects is unresolved.
  Plan for "close", expose a dry render.
- **Resampling**: FMOD Ex interpolates in `fmod_dsp_resampler.cpp` at a selectable quality. If we
  play samples through the browser's `AudioBufferSourceNode.playbackRate`, we get *the browser's*
  interpolator instead, which differs between engines and cannot be pinned. This is the single
  strongest argument for writing our own mixer in an AudioWorklet — see
  [tracker-architecture.md](tracker-architecture.md).
- **Pan law**: FMOD's 2D pan is not the same curve as a naive linear pan. Worth one measurement
  before it becomes a systematic stereo-image error across every render.
