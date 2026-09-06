# Tracker architecture — how to build it

Read before starting implementation. This describes the intended shape and the reasoning behind the
non-obvious choices, so a future session can disagree with the reasoning rather than rediscover it.

## Opening a backup, not a level

A creator's backup is not a file, it is a **pile**: the game writes each
resource under its own SHA-1, so "open your level" otherwise means "find the
right extensionless file among forty and guess". All three pages that open
levels take a folder, a zip of one, a single file, **or a root level hash out of
the public archive** — and every one of those four ends in the same `onOpen`
with the same `{ name, bytes }[]`.

- `packages/cwlib-ts/src/backup.ts` — the reading, over `{ name, bytes }[]`. It knows nothing
  about files, directories or archives, because the user's own game data is read
  client-side and never uploaded.
- `packages/cwlib-ts/src/zip.ts` — the writer grew a **reader**: stored and deflated entries,
  through an `InflateRaw` the platform supplies (`deflate-raw` in the browser,
  `inflateRawSync` in Node).
- `packages/lbp-tracker-web/src/open-level.ts` — the one drop zone, shared. The three pages had grown
  three copies of the drag wiring already.
- `packages/lbp-tracker-web/src/lbparchive.ts` + `packages/lbp-tracker-web/src/archive-panel.ts` — the fourth route, for a listener
  with no backup of their own: paste the root level hash a level's page at
  zaprit.fish shows, and the level comes straight from the Internet Archive.
  Wired from `wireOpen` rather than from each page, for the reason the drop zone
  is. ❗ **It needs no server** — not even the dev one — which is why it is a
  hash and not a search; see *The public archive* in `lbp-modding-toolchain.md`
  for the search that was built and removed the same day.

❗ **A level is told from everything else by its first four bytes** — `LVLb` or
`PLNb` — and never by its name. A backup is full of `ICON0.PNG`, `PARAM.SFO`,
costumes and photographs; trying every file works and reports forty failures for
one level.

❗ **`CHKb` is a piece of a streamed adventure**, and the chain to its Things
is the deepest nesting in the format: a level names chunks, a chunk holds
islands, an island holds a whole `PLNb` resource. 171 chunks, 2,553 islands,
10,837 Things and 9 sequencers in the corpus. See *26. Streaming levels* in
[answered-questions.md](answered-questions.md) — including the three byte-width
bugs it uncovered, all invisible while every file in the corpus was compressed.

⚠️ **An island that will not open is reported, not swallowed.** Islands are
independent resources in one list, so one failing says nothing about its
neighbours — `LevelParse.problems` carries them out and `readBackup` puts them
in `failed`. This is the one place in the reader where a partial result is
honest; everything else is one stream, where a bad read poisons what follows.

❗ **`PLNb` is a plan, and that is where most of the music is.** 224 plans over
six real saves against 6 levels; **172 music sequencers inside plans, 19 inside
the levels**. A plan is a saved Thing, so its Things live in a nested blob with
its own reference table — `readPlan` unwraps it and `readLevelProject`
dispatches on the same four bytes. See *25. Plans* in
[answered-questions.md](answered-questions.md).

⚠️ **"56 levels" was a lie the moment plans opened**, and each page told it
differently. `openedTitle` in `packages/lbp-tracker-web/src/open-level.ts` composes the one line now:
"FJ's Music Gallery (30) by FJMusic — 1 level, 55 plans, 56 sequencers". The
level count only appears when there is something to tell it apart from.

⚠️ **A resource is named after its SHA-1**, so the picker's "which file did
this come from" column is 40 hex digits behind a save folder — 63 characters of
noise on every row, 56 rows deep for a gallery. `seq-picker.ts` shows the first
eight; `key` still carries the whole thing, because that is what identity runs
on.

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
`packages/cwlib-ts/test/backup.test.ts` builds an archive with mismatched extra fields on purpose.

❗ **A level that will not open is reported, never swallowed.** A backup where
one of forty fails is a bug in this parser and should look like one, not like a
level that quietly is not in the list.

❗ **A PS3 save folder opens like anything else.** `BCES00850LEVEL01…` holds
`0` beside `ICON0.PNG`, `PARAM.PFD` and `PARAM.SFO`; the numbered files are the
game's own `FAR4` save archive under XXTEA with a constant key, and
`packages/cwlib-ts/src/savearchive.ts` unpacks them into resources before `readBackup` scans
the pile. Measured end to end: the real backup gives 28 resources, one level and
**11 sequencers**, in 102 ms. The format is in
[lbp-modding-toolchain.md](lbp-modding-toolchain.md).

⚠️ **This page said the opposite for two days, and how it got there matters
more than the fix.** The claim was "a PS3 save cannot be read", on evidence that
read "8.000 bits per byte, all 256 values present, no run of four zeros" — all
true, and all equally true of COMPRESSED data, which is what an LBP resource is
full of. It did not distinguish the two cases at all. The second round of
evidence was better and still wrong, because it only ever asked *is this
ciphertext?*: the answer was yes, and the question that mattered was **whose**.
The file ends with the four bytes `FAR4` **in the clear**, and they were sitting
in the hex dump printed to prove it unreadable. See
[answered-questions.md](answered-questions.md).

❗ **`PARAM.SFO` is not encrypted either**, so a save also says what it is:
`packages/cwlib-ts/src/psf.ts` reads `SUB_TITLE` and the pages title the drop zone "FJ's Music
Hub by Festerd_Jester" rather than `32406766.zip`. A save that will not open is
the only one that gets a sentence, and the sentence says why.

⚠️ **The drop zone takes drops and nothing else.** A click anywhere on it
opening the file picker looked convenient and was a bug: pressing "open a
folder" opened BOTH pickers, because `input.click()` dispatches a click on the
input that bubbles back up to the zone, where it is indistinguishable from a
click on the background. Two buttons, one job each, and the drag still takes a
file or a folder.

## What the audio thread costs, and what it does not

`C4K3 S0NG` -- 244 tracks, 13,091 notes, the 32-voice pool saturated -- is the stress test. On the
audio thread it runs at **11-26%** of one core with no dropouts, and the whole song renders offline
at 10.7x realtime. Both numbers are after 2026-09-04; see *27. The LFO cadence* in
[answered-questions.md](answered-questions.md) for what they were and why.

❗ **The cost is the per-frame DSP and nothing else.** Driving the mixer at 128 frames and at 4,096
costs the same to the millisecond, so there is no per-block overhead to chase: no scratch
allocation, span object or per-chunk setup shows up against the frame loop. 35 voices, each running
an envelope, a four-pole ladder with a re-solved cutoff, an LFO and a mipped sample read, is simply
what this song is.

⚠️ **Uncapping the voice pool nearly doubles it** -- 51 voices sounding instead of 32, and 53.7%
of a core against 26%. It is not the default and the page says `voice pool uncapped` when it is on,
but the browser used to restore the checkbox across a reload while everything else reset, which is
how a session ended up running that way without anyone choosing it. Every control on the live page
carries `autocomplete="off"` now.

## The live player steals what the renderer steals — checked, 2026-09-04

`packages/lbp-tracker-lib/dev/live-sim.ts` is the check: it builds the plan exactly as the page does and renders it three
ways — all voices at once, the same voices in 128-frame blocks, and the voices handed over in
look-ahead bursts with the pool applied live — then compares.

✔ **The live pool decides exactly as `allocateVoices` does.** On `C4K3 S0NG` the live-pool render
sits at **-56.9 dB** against the direct one, the same as the plain scheduled path; the pool
contributes nothing of its own. Its offline reference reports `1318 of 13091 notes stolen`, the
number `packages/lbp-tracker-lib/dev/render-level.ts` reports, so the occupancy reaches the live path unchanged — it travels
as `where.poolEnd`, and `planOptions()` sets no `releaseTail`, so the page takes the same default the
renderer does.

⚠️ **It did not, until this was run.** `renderLivePool` still asked the pool once per stack
**layer** where `packages/lbp-tracker-web/src/live.ts` had been fixed to ask once per note, and that alone put it at
**-8.9 dB** — a simulator disagreeing with the thing it exists to simulate. If a live-path bug is
ever hunted with this tool, check that the tool has kept up first.

⚠️ **A -57 dB residual remains in the scheduling path itself**, and it is not the pool's: it is
there with the pool switched off, and on `Ascetic`, which steals nothing (-59.1 dB). That is 0.14%
of RMS and inaudible, but the file's own header says the two should be identical. See question 34.

## The live player's settings are applied, not re-planned

⚠️ **Read before adding a control to `packages/lbp-tracker-web/live.html`.** The page builds its plan once — the
render's whole voice pass, `renderSequencer` with `planOnly` — and a setting that forces that again
runs it on the thread that also feeds the audio. On `Ascetic`, 1,150 tracks. A listener heard the
player stutter every time the tempo, the swing, `NumChannels` or a channel fader moved, and the
450 ms debounce that was there made it happen less often rather than fixing it.

**None of those four changes a voice.** They change where it starts, how long it lasts and how loud
it is, so the plan holds **musical positions** (`startStep`, `endStep`) and a gain with the channel
factor divided out, and `pump()` derives frames and gain as it posts each note. Changing one is
three numbers and a re-point of the playhead.

✅ **Proved rather than argued**: `packages/lbp-tracker-lib/dev/live-settings.ts` builds the plan at a song's own settings,
applies new ones the way the page does, and compares against a render of a sequencer that had those
settings all along. **Bit-identical.** Run it after touching either file.

❗ **The one part that has to be rebuilt is the in-note automation.** `automation` and
`morph.points` carry frames from the voice's own start, and those frames were bent by the tempo AND
the swing — `swungFrame(step + offset) - swungFrame(step)`. Everything else about a voice is in
seconds or is a ratio. So the plan carries each control point's step offset (`pointSteps`) and
`onClock` puts the frames back. Skipping this looks like it works and is **15.9 dB wrong**: the
notes land in the right places and glide at the old tempo inside themselves.

⚠️ **Tempo is only free of the voice because no instrument the game ships sets `fitBpm`** — 0 of
68, which `packages/lbp-tracker-lib/test/instrument.test.ts` measures. One that did would have its playback rate scaled by
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

`packages/lbp-tracker-lib/dev/live-settings.ts` reproduces a slider drag and counts how many times each note is handed over.
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
   `packages/cwlib-ts/src/project.ts` turns a dump into sequencers, tracks and a scheduled event list, and it
   imports the whole corpus: **19 files, 338 sequencers, 129,696 tracks, 2,027,633 notes, zero
   records falling outside a note.** Tempos run 30–240, grid cells 0–334, rows 0–24. The
   extraction is `packages/cwlib-ts/src/thing.ts` + `level.ts` + `parts.ts`, and the Java tool that used to do
   it is deleted. Its output survives as `fixtures/levels/sequencers.jsonl`, the golden fixture
   `packages/cwlib-ts/dev/verify-levels.ts` checks the walk against — unregenerable, so it covers its own 22 levels
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

   Done, 2026-09-02, in 30 part readers. `packages/cwlib-ts/dev/walk-levels.ts` was the loop — it names the next
   missing part rather than throwing a stack trace — and `packages/cwlib-ts/dev/verify-levels.ts` is the check against
   the Java dump:

   ```
   10 levels parsed, 149 music sequencers matched the dump exactly,
   62158 instrument placements byte for byte, 62158 board cells whole and distinct
   ```

   62,158 is exactly the `INSTRUMENT` count `PartCensus.java` reports for those ten files.

   ⚠️ **A component on an open circuit board has no stored cell**, and that was the last thing
   holding the walk to Java. See `boardCell` in `level.ts` and the measurement in
   `packages/cwlib-ts/dev/board-probe.ts`: the cell is the world-space delta expressed in the **board's** basis —
   three dot products, no quaternion — and a bare delta gets only 78.93% of the corpus's 1,030
   open-board placements onto a cell at all.
5. **Echo and reverb** — both are read out of the game and implemented in `packages/lbp-tracker-lib/src/audio/effects.ts`.
6. **UI**.
7. **Round-trip export** back into a game-loadable resource. The feature that makes the project
   matter to the LBP community, and it depends on step 4.

Steps 1–3 and 5 are done. Step 4 plays a real level end to end, and **the render itself is now in
the browser**: `packages/lbp-tracker-lib/src/render.ts` holds the pipeline, `packages/lbp-tracker-lib/dev/render-level.ts` is the Node wrapper and
`packages/lbp-tracker-web/src/render-worker.ts` the browser one, and on 2026-09-02 the two produced the *same file* — 368
seconds of `This Is Halloween`, 70,704,044 bytes, one SHA-256. **Nothing in the pipeline needs Java
any more**. Steps 6–7 follow.
See
[open-questions.md](open-questions.md) — none of what remains blocks the build, it only affects
fidelity.

## The monorepo — three packages, one seam

Three npm workspaces, since 2026-09-06:

| directory | package | what it is |
|---|---|---|
| `packages/cwlib-ts` | `@lbptracker/cwlib` | reading LBP's serialised resources: the `LVLb`/`PLNb` container, the Thing graph, its 30 parts, and the saves and archives they arrive in |
| `packages/lbp-tracker-lib` | `@lbptracker/lib` | turning that into sound: the sampler, the DSP chain, the render pipeline, MIDI |
| `packages/lbp-tracker-web` | `@lbptracker/web` | the four pages |

❗ **The split is by dependency direction, not by taxonomy**, and the graph was made to decide it:
`cwlib` is closed under its own imports and names nothing above it. That is what makes it a package
rather than a folder — and it is why `scale.ts` and `swing.ts` are in `lib` despite being sequencer
facts. They are readings of `fmodextinput.prx`, about what the **engine** does with the data, not
about how the data is written.

⚠️ **`rinstrument.ts` is in `lib`, not in `cwlib`**, even though `INSb` is an LBP resource. It reads
into `instrument.ts`'s structures, and those are the sampler's; putting the parser in `cwlib` would
have pointed an arrow backwards. A parser belongs with the model it fills, not with the file format
it happens to read.

A test lives with the package it exercises, and the one that straddles says so: `notes.test.ts`
tests `cwlib`'s note records but reaches for `lib`'s `quantise`, so it sits in `lib` rather than put
a `cwlib → lib` edge in a package that must not have one.

## The toolchain

Node 24 strips TypeScript types at load, so `node packages/…/whatever.ts` just runs. Node also ships
a test runner (`node --test`, which finds every `*.test.ts` across the workspaces in one go) and
zlib. **The two libraries need nothing else**: no build step, no bundler, no transpile — the file
the browser runs is the file `node --test` runs, which is the property the whole fidelity argument
rests on.

⚠️ **`npm install` is now required, and it was not before.** Workspaces resolve
`@lbptracker/cwlib/level.ts` through symlinks in `node_modules`, so `git clone && node --test` no
longer works on its own. Nothing is downloaded for the libraries — the install links three
directories and fetches Vite for the web package alone.

❗ **Node does not strip types inside `node_modules`, and this survives it anyway.** A workspace
entry is a symlink, and Node resolves the realpath before deciding, so the file it loads is
`packages/cwlib-ts/src/level.ts` and not a path under `node_modules`. Measured before the split was
committed, with a two-package probe; if that ever changes, every test in this repo stops loading at
once and the reason will not be obvious.

⚠️ **`rewriteRelativeImportExtensions` had to go.** It makes `tsc` reject every `.ts` extension on a
non-relative specifier — TS2877 on all 283 of them — because it cannot rewrite what it does not
emit. `noEmit` is set and the emit is Vite's, so the option was doing nothing but forbidding the
package names. `allowImportingTsExtensions` stays and is what allows `.ts` at all.

⚠️ **Typechecking is not optional-in-practice — it found a real bug the tests could not.**
`loop`, `loopStart` and `loopEnd` belong to `AudioBufferSourceNode`, **not** to `AudioBuffer`.
Setting them on the buffer is silently ignored, and that left the page's "browser resampler"
control not looping at all while our own mixer did. `tsconfig.base.json` also sets
`erasableSyntaxOnly`, which enforces Node's strip-only restriction at compile time instead of
leaving it to memory. `npm run typecheck` runs the three projects in order.


⚠️ **Strip-only type removal bans any TypeScript syntax that emits code.** Node deletes types, it
does not compile them, so **parameter properties** (`constructor(readonly x: T)`), `enum`,
`namespace` and decorators all fail at load with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Declare
fields longhand and use `const` objects with `as const` instead of enums. This is a syntax
restriction, not a typing one — interfaces, generics and `type` are all fine.

**Platform APIs are injected, never imported into `cwlib`.** `loadResource(bytes, inflate)` takes
its inflater as an argument: `packages/cwlib-ts/src/platform/node.ts` passes `zlib.inflateSync`,
`packages/cwlib-ts/src/platform/web.ts` passes a `DecompressionStream` wrapper. That is what keeps the same parser
running under `node --test` against the corpus and in the browser against a file the user picked.
Follow the pattern for anything else platform-shaped.

## What exists so far

| module | state |
|---|---|
| `packages/cwlib-ts/src/stream.ts` | big-endian reader + `Revision` with the gate helpers. Done |
| `packages/cwlib-ts/src/resource.ts` | the `LVLb`/`PLNb` container. Done; 22 real levels parse |
| `packages/cwlib-ts/src/notes.ts` | note records, chaining, duration, automation flags. Done |
| `packages/lbp-tracker-lib/src/fsb.ts`, `ima.ts`, `wav.ts` | build order step 1. Done, **byte-identical to `tools/fsb.py`** |
| `packages/lbp-tracker-lib/src/instrument.ts`, `voice.ts` | slots, key splits, pitch/gain/pan math. Done |
| `packages/lbp-tracker-lib/src/audio/interpolate.ts`, `mixer.ts` | build order step 2: voices, resampling, panning, looping. Done; default is `sinc8` after the first listening test found `linear` audibly broken (open question 7) |
| `packages/lbp-tracker-lib/src/audio/mixer-worklet.ts` | the AudioWorklet shell around `Mixer`. **Verified in Chrome**: 441 Hz in, 441 Hz out at the expected amplitude |
| `packages/cwlib-ts/src/platform/node.ts`, `web.ts` | inflate adapters. Done |
| `packages/lbp-tracker-lib/src/rinstrument.ts` | the `INSb` sampler patch. Parses all 68 instruments exactly |
| `packages/lbp-tracker-lib/src/wav.ts` | 16-bit PCM RIFF read + write — the sequencer's own sample format |
| `packages/lbp-tracker-web/index.html`, `packages/lbp-tracker-web/src/app.ts` | the instrument bench: picks any of the game's 68 instruments, loads its real samples, plays them across its key splits |
| `packages/cwlib-ts/src/thing.ts`, `level.ts`, `parts.ts` | the Thing-graph walk, in TypeScript. **All 10 corpus levels parse, and `packages/cwlib-ts/dev/verify-levels.ts` matches `tools/RawDump.java` on 149 music sequencers and 62,158 instrument placements byte for byte** — every instrument in the corpus |
| `packages/lbp-tracker-lib/src/render.ts` | the whole pipeline as one platform-neutral function. **Verified 2026-09-02: the Node render and a Chrome render of the same level are byte-identical** — 70,704,044 bytes, SHA-256 `1785d0d8…`. ⚠️ That file predates the voice-pool fix later the same day; the equality does not depend on it |
| `packages/lbp-tracker-web/render.html`, `render-app.ts`, `render-worker.ts` | the browser renderer: pick any of the corpus's 338 sequencers, render it in a worker, play it and save the WAV. **The level dump is opened by the user**, not served — the same file, opened from disk, renders to the same bytes |
| echo, reverb | done and measured — see *2 / 2b* and *6 / 14* in [answered-questions.md](answered-questions.md) |
| UI | not started (build order step 6) |

## Serving and shipping: Vite, in the web package only

`npm run serve` is `vite` on `127.0.0.1:8173`; `npm run build` writes `dist/`; `npm run preview`
serves it on `:8174`. The config is `packages/lbp-tracker-web/vite.config.ts` and it is the **only**
build in the repository — `cwlib` and `lib` are still plain TypeScript that Node runs unaided.

### ⚠️ Why the bundler, measured rather than argued

This project ran with **no bundler at all** until 2026-09-06: `dev/serve.mjs` stripped types per
request with `module.stripTypeScriptTypes` and `dev/build.mjs` did the same ahead of time, so the
browser ran the same file `node --test` ran. Both are gone. What killed the design was one
measurement, not a preference:

❗ **An import map does not reach a Worker or an AudioWorklet.** Probed in Chrome with a page
carrying `{"@probe/": "./pkg/"}` and three consumers of the same module:

| context | bare specifier |
|---|---|
| the page | ✔ resolves |
| `new Worker(url, {type:'module'})` | ✘ load error |
| `audioWorklet.addModule(url)` | ✘ `Failed to resolve module specifier` |

Package names are only worth having if every file can use them, and `render-worker.ts` reaches
`assets.ts`, `render.ts` and `backup.ts` — the worker's module graph is **very nearly the whole
engine**. Without a bundler every one of those files would have to name its neighbours with a path
like `../../cwlib-ts/src/project.ts`, and the three packages would be folders with extra steps.

⚠️ **The AudioWorklet needs `?worker&url`, not a path.** `import MIXER_WORKLET_URL from
'@lbptracker/lib/audio/mixer-worklet.ts?worker&url'` makes Vite resolve and bundle that graph ahead
of time and hand back a URL. The old code passed `asset('src/audio/mixer-worklet.ts')`, which cannot
work now: the worklet realm has no import map, so a bare specifier inside it fails to load and the
page goes silent with no error on the main thread.

### What was kept

- ❗ **The libraries have no build.** The bundler stops at the web package's edge. `node --test`
  runs 291 tests against the source, and that is what the fidelity work is checked with.
- ❗ **The output is relocatable**, `base: './'`. Every path in the built HTML is `./assets/…` and no
  chunk imports from `/`; checked by grep after each build, and by serving `dist/` at a bare root.
- ⚠️ **`fixtures/` is served, never built.** They are the user's own game data (see *Asset licensing*
  in [game-assets.md](game-assets.md)), and they live at the repository root, one level above Vite's
  root. A ten-line middleware in the config serves `/fixtures/…` in dev **and** in preview;
  `publicDir` was not used, because it would copy the lot into `dist/`.
- ❗ **No outbound requests.** The dev server still makes none — see the section below, which
  predates Vite and is unchanged by it.

### ⚠️ `asset()` still anchors on `import.meta.url`, and now depends on chunk depth

`asset(p)` resolves against `new URL('../', import.meta.url)` — the module's own directory, up one —
because a bare relative URL in a **worker** resolves against the worker's directory and a leading
slash breaks under a prefix. That still holds, but it now rests on the web package's modules being
exactly one directory below the site root: `/src/assets.ts` in dev, `/assets/assets-*.js` in the
build. Both are true and both were checked in the browser. Change `build.rollupOptions.output`
filenames and the fixtures 404 with no other symptom.

## The dev server makes no outbound requests

Vite serves only files inside the repository, plus `fixtures/` through the middleware above, and **makes no outbound requests at all**. Game
assets never pass through it — the page reads the user's bank through a file picker, in the tab, as
the licensing story requires — and neither does a level: one opened from the archive is fetched by
the page straight from archive.org, which answers any origin.

❗ **That is a decision, not an absence.** For one commit the server proxied a level search to
zaprit.fish, which sends no CORS headers; it worked and was removed the same day. A file server
should not also be a proxy, a listener's search should not travel through it, and — the part that
settled it — a feature that needs a Node process beside the page is the wrong shape for the one
route that exists *because* the listener has nothing set up. See *The search, built and then
removed* in `lbp-modding-toolchain.md`.

~~**The Thing walk is the big one.**~~ Done, and it was a real port rather than an afternoon:
reaching a `PInstrument` means deserialising every Thing and every part that precedes it in the
stream, because parts are variable-length and cannot be skipped without being understood. The Java
tool sidestepped that by borrowing the toolkit's ~55 part serialisers; `packages/cwlib-ts/src/parts.ts` has 30
of its own, and the tool's JSONL output stayed the golden reference the whole time it was being
written — which is exactly how to do the next port of this kind.

## Testing against the corpus

`packages/cwlib-ts/test/resource.test.ts` reads real levels from `LBP_LEVELS` (defaulting to the local toolkit
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
