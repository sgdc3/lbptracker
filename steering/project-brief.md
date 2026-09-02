# Project brief — what we are building and what "faithful" means

## The thing

LittleBigPlanet 3 ships a **Music Sequencer**: a Create Mode gadget with a grid of steps, onto
which you place **Instruments**, each of which owns its own note grid. It has a tempo, a swing
amount, up to 6 mixable channels, and per-instrument echo and reverb sends. Composers in the LBP
community used it as a real DAW for a decade; the levels are full of original music that only
exists inside `.plan`/level files.

We are building a **standalone tracker** that reads that music, plays it back exactly as the game
does, lets you compose in it, and — ideally — writes it back out in a form the game can load.

Target platform is the **browser**. This is a real constraint, not a preference: the audience is
the LBP creator community, and asking them to install a native binary loses most of it. It is also
achievable — see [tracker-architecture.md](tracker-architecture.md).

## What "faithful" means, concretely

Ranked by how audible a mismatch would be. This is the fidelity budget: spend effort top-down.

| # | Aspect | Achievable fidelity | Why |
|---|---|---|---|
| 1 | Sample data | **Bit-exact** | The banks are plain FSB4 on disk; the IMA ADPCM decoder is deterministic and already verified against the game's own `piano_C3` |
| 2 | Pitch / note mapping | **Exact** | `basenote` + `finetune` + `Splitnotes` give a closed-form playback rate; no engine state involved |
| 3 | Timing (tempo, swing, loop, start point) | **Exact** | Integer/rational arithmetic on a fixed grid |
| 4 | Per-channel volume, pan, mix | **Exact** if we match FMOD's pan law | Needs one measurement (see open questions) |
| 5 | Echo | **Exact** | Settled 2026-09-02: it is not an FMOD DSP but a delay inside `fmodextinput.prx`, and `EchoTime` is a delay in **beats** |
| 6 | Resampling of pitched samples | **Very close** | FMOD Ex resamples with a selectable-quality interpolator. Matching it needs our own mixer, not the browser's — this is the main reason for AudioWorklet |
| 7 | Reverb | **Exact** | Settled 2026-09-02: it is `fmodsmsreverb.prx` and the whole DSP is read |

### The reverb caveat, withdrawn

This section used to say the reverb was the project's one genuine risk: the eboot links both FMOD's
`FMOD_DSP_TYPE_SFXREVERB` and Sony's proprietary `lib/sfx/foreverb/aSfxDsp.cpp`, and which one
`ReverbSetting` selected was unknown, so the plan was "close, not identical".

**Neither of them is the answer.** The sequencer's reverb is `fmodsmsreverb.prx`, a 16 KB plugin
the game ships in `gamedata_orbis/spu/` and loads at runtime, and it has been read end to end —
topology, coefficients, levels, sends and the path back to the master. See *6 / 14. The reverb* in
[answered-questions.md](answered-questions.md).

⚠️ The lesson is worth keeping even though the caveat is gone: the risk was declared on the
strength of *what the eboot links*, and the answer was in a file next to it that nobody had opened.
"Which of these two?" was the wrong question for four sessions.

## Scope

**In scope**
- Read the game's instrument definitions and sample banks from the user's own game files.
- Play back sequences with the game's synthesis model.
- Compose: a tracker-style grid editor.
- Export audio (offline render).
- Import existing LBP sequences, and export back to a game-loadable form.

**Out of scope, at least for v1**
- The "Interactive Music" object (stems + sliders). Different system, different data — see
  [lbp-audio-engine.md](lbp-audio-engine.md). Worth doing later; do not conflate it with the
  sequencer.
- Anything to do with the game's SFX, dialogue, or ambience.
- Emulating the game. We read its data files, we do not run its code.

## Assets and licensing

The instrument samples are copyrighted Sony/Media Molecule assets. **The tool must never ship
them.** It reads the banks from the user's own installation (drag-and-drop of
`sfxbank_compressed.fsb`, or a local path). Everything stays client-side; no upload. Design the
loading flow around that from day one rather than retrofitting it — see
[game-assets.md](game-assets.md).

## Where the knowledge came from

Everything in this workspace was recovered by datamining LBP3 1.28 (`CUSA00063`) on 2026-09-01:
the eboot's serializers, its call graph, its dynamic imports, and the shipped audio banks. The
methods and the exact anchors are in [eboot-re.md](eboot-re.md) so that the next session can
extend the map instead of re-deriving it.
