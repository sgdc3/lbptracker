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
- offline rendering for export by reusing the same `Mixer`.

⚠️ **Offline export must drive `Mixer` directly, not the worklet.** Measured in Chrome: samples and
voices posted to an `AudioWorkletNode` port *before* `OfflineAudioContext.startRendering()` never
reach the processor, and the render comes out silent — the identical sequence in a realtime
`AudioContext` produces the expected tone (441 Hz at the expected amplitude). Port messages are not
part of the offline render's ordering guarantees. Since `Mixer` is plain TypeScript with no Web
Audio, calling it in a loop for export is both simpler and exactly the same code path, so this
costs nothing. Do not "fix" it by adding delays before `startRendering`.

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

## The toolchain, and why it has no dependencies

Node 22.6+ strips TypeScript types at load, so `node src/whatever.ts` just runs. Node also ships a
test runner (`node --test`, auto-discovering `*.test.ts`) and zlib. Between them the whole `core/`
layer builds, runs and tests with **zero installed packages** — `node_modules` does not exist and
`npm install` has never been run.

That is worth protecting. Every dependency added later has to justify itself against a baseline
where `git clone && node --test` works on a machine with nothing but Node. A bundler will be needed
eventually for the browser build; `core/` should still run without one.

⚠️ **Strip-only type removal bans any TypeScript syntax that emits code.** Node deletes types, it
does not compile them, so **parameter properties** (`constructor(readonly x: T)`), `enum`,
`namespace` and decorators all fail at load with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Declare
fields longhand and use `const` objects with `as const` instead of enums. This is a syntax
restriction, not a typing one — interfaces, generics and `type` are all fine.

**Platform APIs are injected, never imported into `core/`.** `loadResource(bytes, inflate)` takes
its inflater as an argument: `src/platform/node.ts` passes `zlib.inflateSync`,
`src/platform/web.ts` passes a `DecompressionStream` wrapper. That is what keeps the same parser
running under `node --test` against the corpus and in the browser against a file the user picked.
Follow the pattern for anything else platform-shaped.

## What exists so far

| module | state |
|---|---|
| `src/core/stream.ts` | big-endian reader + `Revision` with the gate helpers. Done |
| `src/core/resource.ts` | the `LVLb`/`PLNb` container. Done; 22 real levels parse |
| `src/core/notes.ts` | note records, chaining, duration, automation flags. Done |
| `src/core/fsb.ts`, `ima.ts`, `wav.ts` | build order step 1. Done, **byte-identical to `tools/fsb.py`** |
| `src/core/instrument.ts`, `voice.ts` | slots, key splits, pitch/gain/pan math. Done |
| `src/audio/interpolate.ts`, `mixer.ts` | build order step 2: voices, resampling, panning, looping. Done |
| `src/audio/mixer-worklet.ts` | the AudioWorklet shell around `Mixer`. **Verified in Chrome**: 441 Hz in, 441 Hz out at the expected amplitude |
| `src/platform/node.ts`, `web.ts` | inflate adapters. Done |
| `dev/serve.mjs`, `dev/index.html`, `dev/app.ts` | the piano_C2..C6 listening test. Runs |
| the Thing-graph walk | **not started** — this is the next real piece |
| echo, reverb, UI | not started (build order steps 5–6) |

## The dev server, and why there is no bundler

`node dev/serve.mjs` serves the repository over `127.0.0.1:8173` and strips TypeScript types on the
fly with `module.stripTypeScriptTypes`, which is built into Node. The browser then imports
`/src/core/fsb.ts` as an ES module directly. No build step, no `node_modules`, and the source the
browser runs is the same source `node --test` runs.

AudioWorklet module scripts loaded this way **do** support static imports, so
`audioWorklet.addModule('/src/audio/mixer-worklet.ts')` pulls in `mixer.ts` and `interpolate.ts`
without bundling. That was the risky part of the design and it works.

The server serves only files inside the repository. Game assets never pass through it — the page
reads the user's bank through a file picker, in the tab, as the licensing story requires.

⚠️ **The Thing walk is the big one.** Reaching a `PInstrument` means deserialising every Thing and
every part that precedes it in the stream, because parts are variable-length and cannot be skipped
without being understood. `tools/RawDump.java` sidesteps this by borrowing the toolkit's ~55 part
serialisers. Doing it in TypeScript is a real port, not an afternoon — budget for it, and use
`RawDump`'s JSONL output as the golden reference while it is being written.

## Testing against the corpus

`test/resource.test.ts` reads real levels from `LBP_LEVELS` (defaulting to the local toolkit
checkout) and **skips** when they are absent, so the suite passes on a machine without the game.
Never commit a fixture derived from game assets or from someone's level; `fixtures/` is ignored for
locally generated ones.

## Things worth deciding early

- **Our own project format is JSON, not an LBP resource.** Import/export to the game's format is a
  boundary, not the internal model. Coupling the editor to a format we do not fully understand yet
  would be a mistake.
- **No server.** Everything client-side: it keeps the asset-licensing story clean (see
  [game-assets.md](game-assets.md)) and makes the tool trivially hostable as static files.
- **Golden-file tests from day one.** Render short fixtures offline and diff the PCM. Fidelity
  regressions are inaudible until they are not, and a diff catches them instantly.
