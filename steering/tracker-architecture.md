# Tracker architecture — how to build it

Read before starting implementation. This describes the intended shape and the reasoning behind the
non-obvious choices, so a future session can disagree with the reasoning rather than rediscover it.

## Opening a backup, not a level

A creator's backup is not a file, it is a **pile**: the game writes each
resource under its own SHA-1, so "open your level" otherwise means "find the
right extensionless file among forty and guess". All three pages that open
levels take a folder, a zip of one, or a single file.

- `src/core/backup.ts` — the reading, over `{ name, bytes }[]`. It knows nothing
  about files, directories or archives, because the user's own game data is read
  client-side and never uploaded.
- `src/core/zip.ts` — the writer grew a **reader**: stored and deflated entries,
  through an `InflateRaw` the platform supplies (`deflate-raw` in the browser,
  `inflateRawSync` in Node).
- `dev/open-level.ts` — the one drop zone, shared. The three pages had grown
  three copies of the drag wiring already.

❗ **A level is told from everything else by its first four bytes** — `LVLb` or
`PLNb` — and never by its name. A backup is full of `ICON0.PNG`, `PARAM.SFO`,
costumes and photographs; trying every file works and reports forty failures for
one level.

⚠️ **A uid is unique inside a level and NOT across a backup.** A folder of
forty routinely holds two sequencers numbered 7, so the picker is keyed on
`file#uid` and shows the level beside the song when there is more than one. A
picker keyed on the uid shows one row where there are two and plays the wrong
song; that is why `SeqRow.key` is a string.

⚠️ **`readEntries` returns a PAGE, not the directory.** It hands back at most
a hundred entries and has to be called again until it returns none. A reader
that calls it once opens the first hundred files of a backup and ignores the
rest — which looks like a backup that is missing levels, not like a bug.

⚠️ **The local header's name and extra fields are its own length**, not the
central directory's: an archiver may put a timestamp field in one and not the
other, and using the wrong length lands mid-data. And the central directory is
the authority: it is at the END of the file and a ZIP is read backwards.
`test/backup.test.ts` builds an archive with mismatched extra fields on purpose.

❗ **A level that will not open is reported, never swallowed.** A backup where
one of forty fails is a bug in this parser and should look like one, not like a
level that quietly is not in the list.

⚠️ **PS3 save folders cannot be read, and the page says so by name.**
`BCES00850LEVEL01…` holds `0` and `1` beside `ICON0.PNG`, `PARAM.PFD` and
`PARAM.SFO`, and the numbered files are encrypted with a key derived from the
title.

⚠️ **The first evidence written here was a guess dressed as a measurement**,
and it is worth keeping as one. It read "8.000 bits per byte, all 256 values
present, no run of four zeros" — all true, and all equally true of COMPRESSED
data, which is what an LBP resource is full of. It did not distinguish the two
cases at all. What does:

- `PARAM.PFD` carries the magic **`PFDB`**, the PS3 Protected File Database,
  and lists the save's files with their hashes;
- two saves **of the same game** share **0** of their 16-byte blocks, and agree
  byte-for-byte at **1,816 offsets of 472,960** where chance alone gives
  ~1,848. Two compressed files of one format would share a header at the least;
- nothing inflates at any of the first 4,096 offsets, and both files are a whole
  number of 16-byte blocks.

❗ **`PARAM.SFO` is NOT encrypted**, so a save can still say what it is:
`src/core/psf.ts` reads it and the pages show `SUB_TITLE`. "FJ's Music Hub by
Festerd_Jester is a PS3 save game" beats "a PS3 save game", which beats "no
sequencers in there".

⚠️ **The drop zone takes drops and nothing else.** A click anywhere on it
opening the file picker looked convenient and was a bug: pressing "open a
folder" opened BOTH pickers, because `input.click()` dispatches a click on the
input that bubbles back up to the zone, where it is indistinguishable from a
click on the background. Two buttons, one job each, and the drag still takes a
file or a folder.

## The live player's settings are applied, not re-planned

⚠️ **Read before adding a control to `dev/live.html`.** The page builds its plan once — the
render's whole voice pass, `renderSequencer` with `planOnly` — and a setting that forces that again
runs it on the thread that also feeds the audio. On `Ascetic`, 1,150 tracks. A listener heard the
player stutter every time the tempo, the swing, `NumChannels` or a channel fader moved, and the
450 ms debounce that was there made it happen less often rather than fixing it.

**None of those four changes a voice.** They change where it starts, how long it lasts and how loud
it is, so the plan holds **musical positions** (`startStep`, `endStep`) and a gain with the channel
factor divided out, and `pump()` derives frames and gain as it posts each note. Changing one is
three numbers and a re-point of the playhead.

✅ **Proved rather than argued**: `dev/live-settings.ts` builds the plan at a song's own settings,
applies new ones the way the page does, and compares against a render of a sequencer that had those
settings all along. **Bit-identical.** Run it after touching either file.

❗ **The one part that has to be rebuilt is the in-note automation.** `automation` and
`morph.points` carry frames from the voice's own start, and those frames were bent by the tempo AND
the swing — `swungFrame(step + offset) - swungFrame(step)`. Everything else about a voice is in
seconds or is a ratio. So the plan carries each control point's step offset (`pointSteps`) and
`onClock` puts the frames back. Skipping this looks like it works and is **15.9 dB wrong**: the
notes land in the right places and glide at the old tempo inside themselves.

⚠️ **Tempo is only free of the voice because no instrument the game ships sets `fitBpm`** — 0 of
68, which `test/instrument.test.ts` measures. One that did would have its playback rate scaled by
the tempo and would need the rebuild after all.

The voice pool was already live for the same reason and by the same route: the plan carries no cuts,
and `LiveVoicePool` applies the size per note. ❗ Its **score** is not immune, though: the pool is in
steps and so ignores tempo and swing, but `channelVolume * velocityGain` means a fader changes which
voice gets stolen. The plan carries `baseScore` for the same reason it carries `baseGain`.

### ⚠️ `nextIndex` must never move backwards — a bug that shipped

Applying the settings live re-points the playhead, and the first version let `nextIndex` land
**before the end of the look-ahead window `pump` had already handed to the worklet**. Every voice in
that window was posted a second time, thirty times a second while a slider was held. A listener
described it exactly: "the notes are played several times and the volume becomes very loud" —
because they were and it was.

Three things now stop it, and the first two are the fix:

- `nextIndex = Math.max(nextIndex, want)`, so the playhead can move under the transport without the
  scheduler rewinding;
- `rebuildPoolTo(nextIndex)` replays the pool **by index rather than by frame**, so what has already
  been handed over stays in it — rebuilding to the playhead instead would forget the window and
  then hand it over again;
- and `pump` skips a plan entry already in `handed`, which is the invariant stated outright.
  `handed` is cleared only by `seek`, where re-posting is right because the worklet has been told to
  stop everything.

❗ `handed` stores the note's **step**, not its frame: the tempo can move after a voice was handed
over, and a frame written under the old clock measures a steal's cut from the wrong place — too
long a cut leaves a stolen voice sounding, which is more loudness nobody asked for.

`dev/live-settings.ts` reproduces a slider drag and counts how many times each note is handed over.
With the fix, 0 of 163 more than once; with the bug put back, **159 of 163**.

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
  dsp/echo.ts        the game's own delay, ported from fmodextinput.prx 0x0680
  dsp/reverb.ts      the game's own DSP, ported from fmodsmsreverb.prx (see answered-questions.md)
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

1. ~~**Port `fsb.py` to TypeScript**~~ — **done**, and byte-identical to the Python oracle. Note
   this turned out to serve the game's *SFX*, not the sequencer; see step 4.
2. ~~**The voice engine**~~ — **done**: worklet, interpolators, pitch formula, key splits.
3. ~~**`RInstrument` reading**~~ — **done**. `SampleGuids` resolve through the FileDB
   (`output/orbisguids.map`) to plain RIFF/WAV `.smp` files in the FARC archives, at 48 kHz 16-bit.
   All 68 of the game's instruments parse exactly, and `dev/` plays them.
4. ~~**Level import**~~ — **done, both halves.**
   `src/core/project.ts` turns a dump into sequencers, tracks and a scheduled event list, and it
   imports the whole corpus: **19 files, 338 sequencers, 129,696 tracks, 2,027,633 notes, zero
   records falling outside a note.** Tempos run 30–240, grid cells 0–334, rows 0–24. The
   extraction is `src/core/thing.ts` + `level.ts` + `parts.ts`, and the Java tool that used to do
   it is deleted. Its output survives as `fixtures/levels/sequencers.jsonl`, the golden fixture
   `dev/verify-levels.ts` checks the walk against — unregenerable, so it covers its own 22 levels
   and nothing newer.

   **The Thing-graph walk, scoped by measurement rather than by feel** (`tools/PartCensus.java`):

   - The stream is strictly sequential. References are inline ids and parts carry no lengths, so
     nothing can be skipped: reading a `PSequencer` means parsing every part before it on that
     Thing.
   - Across the corpus: **34 distinct part types over 172,139 Things**; over the 10 level files that
     load, **33 types over 81,946 Things**. Roughly 5,500 lines of serialiser in cwlib's terms.
   - Only nine part types ever share a Thing with a `SEQUENCER`, in eight combinations across all
     1,169 of them, and **128,666 of 129,696 instrument Things carry `INSTRUMENT` alone**.

   ⚠️ **This file used to conclude from that second bullet that the walk needs eight part
   readers. It needs all 33, and the mistake is worth keeping.** The nine-types figure answers
   "what sits on a sequencer's Thing", which would matter if a Thing could be reached directly. It
   cannot: parts carry no length, references expand inline at their first mention, and
   `PWorld.things` is an array of them, so reaching the 443rd Thing means having fully read the 442
   before it. `PartCensus.java`'s own header said as much — "a TypeScript walk cannot skip
   anything" — so the tool was right and the inference drawn from its output was not. Two
   sessions of planning were done against a number that was answering a different question.

   Done, 2026-09-02, in 30 part readers. `dev/walk-levels.ts` was the loop — it names the next
   missing part rather than throwing a stack trace — and `dev/verify-levels.ts` is the check against
   the Java dump:

   ```
   10 levels parsed, 149 music sequencers matched the dump exactly,
   62158 instrument placements byte for byte, 62158 board cells whole and distinct
   ```

   62,158 is exactly the `INSTRUMENT` count `PartCensus.java` reports for those ten files.

   ⚠️ **A component on an open circuit board has no stored cell**, and that was the last thing
   holding the walk to Java. See `boardCell` in `level.ts` and the measurement in
   `dev/board-probe.ts`: the cell is the world-space delta expressed in the **board's** basis —
   three dot products, no quaternion — and a bare delta gets only 78.93% of the corpus's 1,030
   open-board placements onto a cell at all.
5. **Echo and reverb** — both are read out of the game and implemented in `src/audio/effects.ts`.
6. **UI**.
7. **Round-trip export** back into a game-loadable resource. The feature that makes the project
   matter to the LBP community, and it depends on step 4.

Steps 1–3 and 5 are done. Step 4 plays a real level end to end, and **the render itself is now in
the browser**: `src/core/render.ts` holds the pipeline, `dev/render-level.ts` is the Node wrapper and
`dev/render-worker.ts` the browser one, and on 2026-09-02 the two produced the *same file* — 368
seconds of `This Is Halloween`, 70,704,044 bytes, one SHA-256. **Nothing in the pipeline needs Java
any more**. Steps 6–7 follow.
See
[open-questions.md](open-questions.md) — none of what remains blocks the build, it only affects
fidelity.

## The toolchain, and why it has no dependencies

Node 22.6+ strips TypeScript types at load, so `node src/whatever.ts` just runs. Node also ships a
test runner (`node --test`, auto-discovering `*.test.ts`) and zlib. Between them the whole `core/`
layer builds, runs and tests with **zero installed packages** — `node_modules` does not exist and
`npm install` has never been run.

That is worth protecting, and the line to hold is **runtime and tests**, not tooling: `git clone &&
node --test` still works on a machine with nothing but Node, and nothing under `src/` imports a
package. TypeScript and `@types/node` are now in `devDependencies` for `tsc --noEmit`, which is
opt-in and earns its place — see below. A bundler will be needed eventually for the browser build;
`core/` should still run without one.

⚠️ **Typechecking is not optional-in-practice — it found a real bug the tests could not.**
`loop`, `loopStart` and `loopEnd` belong to `AudioBufferSourceNode`, **not** to `AudioBuffer`.
Setting them on the buffer is silently ignored, and that left the page's "browser resampler"
control not looping at all while our own mixer did. `tsconfig.json` also sets
`erasableSyntaxOnly`, which enforces Node's strip-only restriction at compile time instead of
leaving it to memory.

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
| `src/audio/interpolate.ts`, `mixer.ts` | build order step 2: voices, resampling, panning, looping. Done; default is `sinc8` after the first listening test found `linear` audibly broken (open question 7) |
| `src/audio/mixer-worklet.ts` | the AudioWorklet shell around `Mixer`. **Verified in Chrome**: 441 Hz in, 441 Hz out at the expected amplitude |
| `src/platform/node.ts`, `web.ts` | inflate adapters. Done |
| `src/core/rinstrument.ts` | the `INSb` sampler patch. Parses all 68 instruments exactly |
| `src/core/wav.ts` | 16-bit PCM RIFF read + write — the sequencer's own sample format |
| `dev/serve.mjs`, `dev/index.html`, `dev/app.ts` | the instrument bench: picks any of the game's 68 instruments, loads its real samples, plays them across its key splits |
| `src/core/thing.ts`, `level.ts`, `parts.ts` | the Thing-graph walk, in TypeScript. **All 10 corpus levels parse, and `dev/verify-levels.ts` matches `tools/RawDump.java` on 149 music sequencers and 62,158 instrument placements byte for byte** — every instrument in the corpus |
| `src/core/render.ts` | the whole pipeline as one platform-neutral function. **Verified 2026-09-02: the Node render and a Chrome render of the same level are byte-identical** — 70,704,044 bytes, SHA-256 `1785d0d8…`. ⚠️ That file predates the voice-pool fix later the same day; the equality does not depend on it |
| `dev/render.html`, `render-app.ts`, `render-worker.ts` | the browser renderer: pick any of the corpus's 338 sequencers, render it in a worker, play it and save the WAV. **The level dump is opened by the user**, not served — the same file, opened from disk, renders to the same bytes |
| echo, reverb | done and measured — see *2 / 2b* and *6 / 14* in [answered-questions.md](answered-questions.md) |
| UI | not started (build order step 6) |

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

~~**The Thing walk is the big one.**~~ Done, and it was a real port rather than an afternoon:
reaching a `PInstrument` means deserialising every Thing and every part that precedes it in the
stream, because parts are variable-length and cannot be skipped without being understood. The Java
tool sidestepped that by borrowing the toolkit's ~55 part serialisers; `src/core/parts.ts` has 30
of its own, and the tool's JSONL output stayed the golden reference the whole time it was being
written — which is exactly how to do the next port of this kind.

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
