# Tracker architecture — how to build it

Read before starting implementation. This describes the intended shape and the reasoning behind the
non-obvious choices, so a future session can disagree with the reasoning rather than rediscover it.

## The central decision: own the mixer

The obvious way to build a sampler in the browser is one `AudioBufferSourceNode` per voice with
`playbackRate` set for pitch. **Do not do that for this project.** `playbackRate` resampling is
performed by the browser's own interpolator; it differs between Chrome, Firefox and Safari, it is
not specified, and it is not FMOD's. Every pitched note would carry a small, engine-dependent
timbre error — which is precisely the thing this project exists to avoid.

Instead: **one `AudioWorkletProcessor` that is the whole mixer.** It owns the voices, the
interpolation, the per-channel gain and pan, the two sends and the two effects, and emits final
stereo frames. That gives us:

- an interpolator we control and can match to `fmod_dsp_resampler.cpp`,
- sample-accurate note scheduling instead of `setTimeout` drift,
- deterministic output — the same project renders identically on every browser and every run,
- offline rendering for export by running the same processor under `OfflineAudioContext`.

The cost is that we write our own voice allocation and mixing. That is a few hundred lines, and it
is the part of the project that has to be right anyway.

## Module breakdown

```
core/           pure, no DOM, no Web Audio — unit-testable, shared with the Node CLI
  fsb.ts          FSB4 parser  (port of tools/fsb.py)
  ima.ts          IMA ADPCM decoder → Float32Array
  stream.ts       big-endian reader/writer + the revision gate — every LBP struct needs both
  instrument.ts   RInstrument → { slots[8], splitnotes[9], arpeggio, … }
  sequence.ts     PSequencer + PMicrochip components + PInstrument note chains
                  → the tracker's own project model
  voice.ts        note → { slot, playbackRate, gain, pan } using the formula in
                  steering/sequencer-data-model.md
audio/
  mixer-worklet.ts   the AudioWorkletProcessor: voices, interpolation, channels, sends
  dsp/echo.ts        delay line + feedback + wet/dry, parameters from PSequencer
  dsp/reverb.ts      Freeverb-style; explicitly an approximation (see lbp-audio-engine.md)
  render.ts          OfflineAudioContext wrapper for WAV export
io/
  bank-loader.ts     user picks their own .fsb; parse client-side, never upload
  project-io.ts      our own save format (JSON) + LBP import/export once the note format is known
ui/
  grid, instrument editor, mixer strip, transport
```

Keep `core/` free of Web Audio and DOM so the same code can run in Node against `tools/fsb.py`'s
output as a golden reference. The Python tools are not throwaway: they are the oracle the
TypeScript is tested against.

## Playback model

The sequencer is a fixed grid, so the natural clock is **steps, not seconds**. Convert once, at the
edge of the worklet:

```
samplesPerStep = outputRate * 60 / (Tempo * stepsPerBeat)
```

`stepsPerBeat` is very likely 4 — a grid cell is 52.5 world units wide (measured) and holds 16
steps (ennuo's toolkit), i.e. one bar of 16ths. Not confirmed; see open question 4. Swing offsets
alternate steps; the exact convention — whether `Swing` is a ratio, a percentage, or a fraction of
a step — is still unknown. Until both are pinned, put them behind named constants in one place
rather than sprinkling magic numbers through the scheduler.

A note is **not** `(pitch, start, length, velocity)`. It is a chain of per-step records carrying
their own pitch, volume and timbre, terminated by an `end` flag — so pitch glide and per-step
volume/timbre automation are native to the format. Model the chain from the start; retrofitting
automation onto a flat note struct means rewriting the scheduler and the editor together. See
[sequencer-data-model.md](sequencer-data-model.md).

Voice allocation: `Numstack` in `RInstrument` suggests a per-instrument voice-stacking limit, and
`Loops` on `PInstrument` controls repetition. Neither is fully understood; model them explicitly
rather than assuming "infinite polyphony" and having to unpick it later.

## Build order

Each step is chosen so that it either produces something audible or removes a real unknown. Do not
reorder 1 and 2 — you want the asset pipeline proven before anything depends on it.

1. **Port `fsb.py` to TypeScript and play `piano_C3` in a browser.** No unknowns; the reference
   implementation and a verified expected output already exist. Half a day. Test by rendering the
   decoded PCM offline and comparing it byte-for-byte against `tools/fsb.py`'s WAV.
2. **The voice engine**: worklet, interpolation, the pitch formula, key splits. Play a scale from
   `piano_C2..C6` and check the splits land where `Splitnotes` says.
3. **Level import**: read `PSequencer` + `PMicrochip` + `PInstrument` + the note chains out of a
   real `.plan`/level. The record layout is written down (from ennuo's toolkit) but unconfirmed —
   build the reader, then confirm it with the in-game diff of open question 2. Reading a real
   composition and playing it back *is* the confirmation.
4. **`RInstrument` reading** — needs `SampleGuids` resolved (open question 1). Until then,
   hand-write instrument definitions matching what the banks contain.
5. **Echo and reverb** with the real parameters.
6. **UI**.
7. **Round-trip export** back into a game-loadable resource. This is the feature that makes the
   project matter to the LBP community, and it depends on step 3 being *confirmed*, not merely
   plausible — we are writing into people's levels.

Steps 1, 2, 5 and 6 have no blocking unknowns and can proceed immediately. Step 3 is now mostly a
matter of writing the parser, since the format is documented; step 4 is still gated on RE, and
step 7 on confirming step 3. See [open-questions.md](open-questions.md) and
[lbp-modding-toolchain.md](lbp-modding-toolchain.md).

## Things worth deciding early

- **Our own project format is JSON, not an LBP resource.** Import/export to the game's format is a
  boundary, not the internal model. Coupling the editor to a format we do not fully understand yet
  would be a mistake.
- **No server.** Everything client-side: it keeps the asset-licensing story clean (see
  [game-assets.md](game-assets.md)) and makes the tool trivially hostable as static files.
- **Golden-file tests from day one.** Render short fixtures offline and diff the PCM. Fidelity
  regressions are inaudible until they are not, and a diff catches them instantly.
