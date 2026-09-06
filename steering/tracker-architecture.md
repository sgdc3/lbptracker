# Tracker architecture — how it is built, and why

Read before starting implementation. This describes the shape and the reasoning behind the
non-obvious choices, so a future session can disagree with the reasoning rather than rediscover
it. What the game does is in [synth-engine.md](synth-engine.md) and
[lbp-audio-engine.md](lbp-audio-engine.md); this file is about how *we* reproduce it.

## The central decision: own the mixer

The obvious way to build a sampler in the browser is one `AudioBufferSourceNode` per voice with
`playbackRate` set for pitch. **Do not do that for this project.** `playbackRate` resampling is the
browser's own interpolator — unspecified, different between Chrome, Firefox and Safari — and the
game's is a two-tap linear interpolator over octave mipmaps built from an int16 pair average
([synth-engine.md](synth-engine.md)). Every pitched note would carry a small, engine-dependent
timbre error, which is precisely the thing this project exists to avoid.

Instead: **one `AudioWorkletProcessor` that is the whole mixer**
(`packages/lbp-tracker-lib/src/audio/mixer-worklet.ts` around `mixer.ts`). It owns the voices, the
interpolation, the envelopes, the filter, the LFOs, the per-channel gain and pan, the two sends and
the effects, and emits final stereo frames. That gives an interpolator matched to the engine,
sample-accurate scheduling instead of `setTimeout` drift, deterministic output — the same project
renders identically on every browser and every run — and offline rendering by reusing the same
`Mixer`.

⚠️ **Offline export must drive `Mixer` directly, not the worklet.** Measured in Chrome: samples and
voices posted to an `AudioWorkletNode` port *before* `OfflineAudioContext.startRendering()` never
reach the processor, and the render comes out silent; the identical sequence in a realtime
`AudioContext` produces the expected tone (441 Hz at the expected amplitude). Port messages are
not part of the offline render's ordering guarantees. `Mixer` is plain TypeScript with no Web
Audio, so calling it in a loop for export is the same code path. Do not "fix" it with delays.

`packages/lbp-tracker-lib/src/render.ts` is that loop: the whole pipeline as one platform-neutral
function, with `packages/lbp-tracker-lib/dev/render-level.ts` the Node wrapper and
`packages/lbp-tracker-web/src/render-worker.ts` the browser one. ✔ On 2026-09-02 the two produced
the *same file* — 368 seconds of `This Is Halloween`, 70,704,044 bytes, one SHA-256.

### The mixer's clock is the engine's block

The engine re-derives everything modulation-driven once per **256-frame block** and the
AudioWorklet's render quantum is 128, so the grid cannot be "the offset within this call". Three
things follow, all in `mixer.ts`: `Mixer.clock` counts frames modulo the block and is handed to
every voice, so a 128-frame live call and a whole-song offline call cross the same boundaries; a
chunk that *continues* a block must not re-derive (`Voice.derived`); and the oscillators are
advanced in `stepLfos` by the whole remaining block, never by the part of it a caller asked for.
`packages/lbp-tracker-lib/test/audio.test.ts` pins "the mixer renders the same audio whatever the
block size", and it catches a grid mistake within a minute of it being made.

## The monorepo — three packages, one seam

| directory | package | what it is |
|---|---|---|
| `packages/cwlib-ts` | `@lbptracker/cwlib` | reading LBP's serialised resources: the container, the Thing graph and its **50** part readers, plans, chunks, saves, archives |
| `packages/lbp-tracker-lib` | `@lbptracker/lib` | turning that into sound: the sampler, the DSP chain, the render pipeline, MIDI |
| `packages/lbp-tracker-web` | `@lbptracker/web` | the four pages |

❗ **The split is by dependency direction, not by taxonomy**, and the import graph decided it:
`cwlib` is closed under its own imports and names nothing above it. That is why `scale.ts` and
`swing.ts` are in `lib` despite being sequencer facts — they are readings of `fmodextinput.prx`,
about what the *engine* does with the data — and why `rinstrument.ts` is in `lib` even though
`INSb` is an LBP resource: it reads into `instrument.ts`'s structures, which are the sampler's. **A
parser belongs with the model it fills, not with the file format it happens to read.** A test lives
with the package it exercises; `notes.test.ts` tests `cwlib`'s records but reaches for `lib`'s
`quantise`, so it sits in `lib` rather than put a `cwlib → lib` edge in a package that must not
have one.

**Platform APIs are injected, never imported into `cwlib`.** `loadResource(bytes, inflate)` takes
its inflater as an argument: `platform/node.ts` passes `zlib.inflateSync`, `platform/web.ts` a
`DecompressionStream` wrapper. That is what keeps the same parser running under `node --test`
against the corpus and in the browser against a file the user picked.

## The toolchain

Node 24 strips TypeScript types at load, so `node packages/…/whatever.ts` just runs; it also ships
the test runner (`node --test` finds every `*.test.ts` across the workspaces) and zlib. **The two
libraries need nothing else**: no build, no bundler, no transpile — the file the browser runs is
the file `node --test` runs, which is the property the fidelity argument rests on.

- ⚠️ **`npm install` is required.** Workspaces resolve `@lbptracker/cwlib/level.ts` through
  symlinks in `node_modules`; nothing is downloaded for the libraries.
- ❗ **Node does not strip types inside `node_modules`, and this survives it** because a workspace
  entry is a symlink and Node resolves the realpath before deciding. Measured with a two-package
  probe before the split; if it ever changes, every test stops loading at once and the reason will
  not be obvious.
- ⚠️ **Strip-only type removal bans any syntax that emits code**: parameter properties, `enum`,
  `namespace` and decorators fail at load with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Declare fields
  longhand and use `as const` objects. `tsconfig.base.json` sets `erasableSyntaxOnly` to enforce it
  at compile time.
- ⚠️ **`rewriteRelativeImportExtensions` had to go**: it makes `tsc` reject every `.ts` extension
  on a non-relative specifier (TS2877, all 283 of them). `noEmit` is set and the emit is Vite's, so
  it did nothing but forbid the package names; `allowImportingTsExtensions` is what allows `.ts`.
- ⚠️ **Typechecking found a bug the tests could not.** `loop`, `loopStart` and `loopEnd` belong to
  `AudioBufferSourceNode`, not `AudioBuffer`; setting them on the buffer is silently ignored, and
  the bench's "browser resampler" control was not looping while our mixer did.
- ⚠️ **`typescript@7` is the native compiler** — a Go binary, no `lib/tsc.js`, no JavaScript API —
  and Volar, which puts `.vue` files in front of the checker, patches that API, so `vue-tsc` on it
  dies with `ERR_PACKAGE_PATH_NOT_EXPORTED: './lib/tsc'`. **`typescript-native-bridge`** is a fork
  carrying a `tsgoChecker` overlay — the API for Volar, tsgo still doing the checking — pinned to
  the same 7.0.2; `packages/lbp-tracker-web/dev/typecheck.mjs` hands `vue-tsc` its path and it
  announces itself with `TNB ACTIVE`. It is a third-party fork days old when adopted, which is why
  it checks **the web package only** and the libraries go through `tsc -p` against the real
  `typescript`. It was accepted only after being made to fail (a `const x: number = string` in
  `Fader.vue` and a `max: 'oops'` in a spec both came back as TS2322): **an exit code of 0 from a
  checker means nothing on its own.**
- ⚠️ `typescript` and `typescript-native-bridge` both declare `bin: tsc`, so npm installs neither
  shim (`node_modules/.bin` holds `vite` and `vue-tsc` and no `tsc`) and a script saying `tsc`
  dies with `'tsc' is not recognized` — which reads as a broken PATH. The libraries' `typecheck`
  scripts therefore name the file: `node ../../node_modules/typescript/bin/tsc -p .`. Both
  packages are hoisted to the root `node_modules`, so the path is stable.
- Each package owns its `test` and `typecheck` scripts; the root's `typecheck` is
  `npm run typecheck --workspaces`, which runs all three and exits non-zero if any fails
  (measured with a `const x: number = 'oops'` in `cwlib`: exit 1, and the web check still ran
  after it), and `npm run check` chains it with the tests. `node --test` at
  the root finds every `*.test.ts` under `packages/` in one process, which is faster than three.

## Serving and shipping: Vite, in the web package only

`npm run serve` is `vite` on `127.0.0.1:8173`; `npm run build` writes `dist/`; `npm run preview`
serves it on `:8174`. `packages/lbp-tracker-web/vite.config.ts` is the **only** build in the
repository.

❗ **Why a bundler at all, measured rather than argued.** The project ran with none until
2026-09-06 — a hand-rolled dev server stripped types per request and a hand-rolled build did the
same ahead of time (`git log -- packages/lbp-tracker-web/dev` has them). One measurement killed it,
probed in Chrome with a page carrying `{"@probe/": "./pkg/"}` and three consumers of one module:

| context | bare specifier |
|---|---|
| the page | ✔ resolves |
| `new Worker(url, {type:'module'})` | ✘ load error |
| `audioWorklet.addModule(url)` | ✘ `Failed to resolve module specifier` |

`render-worker.ts` reaches `assets.ts`, `render.ts` and `backup.ts` — the worker's module graph is
very nearly the whole engine. Without a bundler every one of those files would have to name its
neighbours with a path like `../../cwlib-ts/src/project.ts`, and the packages would be folders with
extra steps. ⚠️ **The AudioWorklet needs `?worker&url`, not a path**:
`import MIXER_WORKLET_URL from '@lbptracker/lib/audio/mixer-worklet.ts?worker&url'` makes Vite
bundle that graph ahead of time; a bare specifier inside the worklet realm fails to load and the
page goes silent with no error on the main thread.

What was kept: the libraries have no build (the bundler stops at the web package's edge; `node
--test` runs 291 tests against the source); the output is relocatable (`base: './'`, every path
`./assets/…`, checked by grep after each build and by serving `dist/` at a bare root);
**`fixtures/` is served, never built** — a ten-line middleware serves `/fixtures/…` in dev and
preview, and `publicDir` was not used because it would copy the lot into `dist/`; and the dev server
makes **no outbound requests** (below).

⚠️ **`asset()` anchors on `import.meta.url` and now depends on chunk depth.** It resolves against
`new URL('../', import.meta.url)` because a bare relative URL in a **worker** resolves against the
worker's directory and a leading slash breaks under a prefix — and that rests on the web package's
modules being exactly one directory below the site root (`/src/assets.ts` in dev, `/assets/assets-*.js`
in the build). Both checked in the browser; change `build.rollupOptions.output` filenames and the
fixtures 404 with no other symptom.

### Deployment — Cloudflare, assets included

`npm run deploy` is `vite build`, then `packages/lbp-tracker-web/dev/stage-site.ts`, then
`wrangler deploy` on `packages/lbp-tracker-web/wrangler.jsonc` — an assets-only Worker, no script,
`send_metrics` off. `wrangler login` once before the first deploy.

❗ **The staging step is the one place game data enters `dist/`.** It copies exactly what
`fixtures/rinst/manifest.json` and `fixtures/smp/manifest.json` name — 286 files, 6.7 MB on
2026-09-06 — rewrites the two manifests, and writes `_headers`: hashed bundles immutable, samples a
day, `nosniff` everywhere. `fixtures/archive` stays out; the pages read levels from archive.org.

⚠️ **The staged names are not the game's.** `publicName` turns `#` into `-sharp` and a space into
`_`, so no host ever has to decode `%23` back into a file name — the class of trap that cost a day
in `assets.ts`. The manifest is the indirection; `fixtures/` on disk is untouched;
`test/stage-site.test.ts` holds every name in the real manifests to being the identity under
`encodeURIComponent`, with no collisions (the game already has a `harp_fsharp3.smp`, which is why
the rule is `-sharp` and not `sharp`).

⚠️ **Vite's preview never exercises the staged copies** — its middleware answers `/fixtures/` from
the repository first. The check is `npx wrangler dev` (launch config `cloudflare`, port 8175),
which serves `dist/` the way Cloudflare will, `_headers` included. Measured that way on
2026-09-06: the choir's two `#` samples loaded under the staged names, the three header rules
applied, the worklet started. ⚠️ npm 11's install-script gate holds `workerd`'s and `esbuild`'s
postinstall; `wrangler dev` and `wrangler deploy --dry-run` both ran regardless, because the
platform binaries arrive as optional dependencies.

## Vue, and where it is not allowed

The pages are Vue 3, and the first thing to know is the line it does not cross:

| | |
|---|---|
| ✔ Vue | panels, forms, lists, pickers — anything whose state is what the reader typed |
| ✘ not Vue | the audio graph, the note scheduler, the worklet and worker protocols, the keyboard, the canvas |

❗ **The real-time layer is called by components, never owned by them.** A note-on writes to a
`MessagePort`, not to a reactive object; the keyboard toggles a class on 88 elements at key-down
rate; the meters run at `requestAnimationFrame`. ⚠️ **The tracker grid, when it is built, is not a
`v-for`** — a pattern editor scrolling thousands of cells at 60 fps is a canvas or a virtualised
list, a custom component registered on Vue. Rendering it as reactive components is the predictable
way to make the editor slow.

**`src/controls/`**: one spec per page (`bench.ts`, `live.ts`, `render.ts`, `midi.ts`) and `kit.ts`
turning each into a typed store, five components. The win is that **a control is declared once**.
Every fader used to be written twice — in the HTML with its `min`/`max`/`value`, and in the module
as a row carrying its formatter, joined by a string id, with `${id}Label` naming a third element —
and every way of getting it wrong was silent: a mistyped id read the neighbouring control; a
formatter dividing by 100 beside a reader dividing by 10 showed one number while playing another;
`setSlider('echoFb', seq.echoFeedback * 100)` had to be the exact inverse of `num('echoFb') / 100`
350 lines away. Now `Controls<FaderId, CheckId, ChoiceId>` carries the unions from the spec so a
wrong id will not compile; ❗ **`per` is one number, not two functions** (`value = raw / per`,
`raw = value * per`), so the inverse cannot disagree; `format` is handed the *engine's* number; the
watcher that rebuilds the output stage is generated from the `effects` flags. ⚠️ A store belongs to
one page — ids repeat with different ranges — so components take it through `provide`/`inject`.
`render.html` was converted least, on purpose: its options live in `.switch` cards beside prose,
so only the checks moved into a spec.

**`src/widgets/`**: what more than one page draws — `SeqPicker.vue`, `ArchivePanel.vue`,
`OpenLevel.vue` — each behind an imperative façade (`seqPicker`, `wireArchiveOpen`, `mountOpen`)
because the pages drive them from event handlers and none has a Vue root for props to flow down
from. Converting them found four bugs: the picker's detail column carried **a filename out of the
opened backup** through `innerHTML` with no escaper, and the archive button exists to download
other people's zips; the drop zone was written out three times and had drifted; only one page
cleared its file input, without which choosing the *same* file again fires no `change` at all;
and `defineExpose` unwraps refs, so `ui.busy.value = true` throws only when the zone is first used.

- ⚠️ **`open-level.ts` must not import Vue, and nothing says so but a crash.** `render-worker.ts`
  imports `openedTitle` from it; when the mounting lived in the same file the worker pulled in Vue
  and died with `ReferenceError: document is not defined`. The build is happy either way. The
  mounting half is `widgets/open-panel.ts`, and the rule is general: **a module a worker imports
  may not reach the DOM.**
- ⚠️ **`Symbol.for`, not `Symbol`, for the injection key.** Vite appends `?t=…` to a changed
  module's URL in dev, so a page can hold both `kit.ts` and `kit.ts?t=…` — two module instances,
  two distinct `Symbol()`s — and `inject` returns `undefined` in half the tree while the panel
  still renders correctly.

## Opening a backup, not a level

A creator's backup is a **pile**: the game writes each resource under its own SHA-1, so "open your
level" otherwise means "find the right extensionless file among forty and guess". All three pages
that open levels take a folder, a zip of one, a single file, **or a root level hash out of the
public archive**, and every route ends in the same `onOpen` with the same `{ name, bytes }[]`.
The formats are in [level-files.md](level-files.md); this is the behaviour around them.

- `packages/cwlib-ts/src/backup.ts` reads over `{ name, bytes }[]` and knows nothing about files,
  directories or archives, because the user's data is read client-side and never uploaded.
  `zip.ts` reads stored and deflated entries through an `InflateRaw` the platform supplies. ⚠️
  **`readEntries` returns a PAGE**, at most a hundred entries, and has to be called again until it
  returns none — a reader that calls it once opens the first hundred files and ignores the rest,
  which looks like a backup missing levels. ⚠️ **The local header's name and extra fields are its
  own length**, not the central directory's; `test/backup.test.ts` builds an archive with
  mismatched extra fields on purpose.
- ❗ **A level that will not open is reported, never swallowed.** One of forty failing is a bug in
  this parser and should look like one, not like a level that quietly is not in the list.
- ⚠️ **"56 levels" was a lie the moment plans opened.** `openedTitle` in `src/open-level.ts`
  composes the one line — "FJ's Music Gallery (30) by FJMusic — 1 level, 55 plans, 56
  sequencers" — and the level count appears only when there is something to tell it apart from.
- ⚠️ A resource is named after its SHA-1, so the picker shows the first eight hex digits and keys
  on `file#uid`, because a uid is unique inside a level and not across a backup: a picker keyed on
  the uid shows one row where there are two and plays the wrong song.
- ⚠️ **The drop zone takes drops and nothing else.** A click anywhere on it opening the picker was
  a bug: `input.click()` dispatches a click that bubbles back to the zone, so "open a folder"
  opened BOTH pickers. Two buttons, one job each.
- ❗ **The archive route needs no server — not even the dev one** — which is why it is a hash and
  not a search. For one commit the dev server proxied a level search to zaprit.fish (which sends no
  CORS headers), scraping its HTML; it worked and was removed the same day, deliberately: it only
  worked on a dev machine, so the tracker's most useful "I have no backup" path would have broken
  the moment anyone hosted it. **A file server should not also be a proxy**, and a feature that
  needs a Node process beside the page is the wrong shape for the one route that exists because
  the listener has nothing set up. The dev server makes no outbound requests at all: a level from
  the archive is fetched by the page straight from archive.org, which answers any origin.

## The live player — settings are applied, not re-planned

⚠️ **Read before adding a control to `packages/lbp-tracker-web/live.html`.** The page builds its
plan once — the render's whole voice pass, `renderSequencer` with `planOnly` — and a setting that
forces that again runs it on the thread that also feeds the audio (`Ascetic`: 1,150 tracks). A
listener heard the player stutter every time the tempo, the swing, `NumChannels` or a fader moved,
and a 450 ms debounce made it happen less often rather than fixing it.

**None of those four changes a voice.** They change where it starts, how long it lasts and how loud
it is, so the plan holds **musical positions** (`startStep`, `endStep`) and a gain with the channel
factor divided out, and `pump()` derives frames and gain as it posts each note. ✅
`packages/lbp-tracker-lib/dev/live-settings.ts` proves it: the plan at a song's own settings, new
ones applied the way the page does, against a render of a sequencer that had them all along —
**bit-identical**.

- ❗ **The in-note automation has to be rebuilt.** `automation` and `morph.points` carry frames from
  the voice's start, bent by tempo AND swing (`swungFrame(step + offset) − swungFrame(step)`), so
  the plan carries each control point's step offset (`pointSteps`) and `onClock` puts the frames
  back. Skipping this is **15.9 dB wrong**: the notes land in the right places and glide at the old
  tempo inside themselves.
- ⚠️ Tempo is only free of the voice because no shipped instrument sets `fitBpm` — 0 of 68,
  measured by `test/instrument.test.ts`. One that did would need the rebuild after all.
- The pool is live for the same reason: the plan carries no cuts and `LiveVoicePool` applies the
  size per note. Its score is not immune — `channelVolume * velocityGain` means a fader changes
  which voice is stolen — so the plan carries `baseScore` as it carries `baseGain`.
- ❗ **`nextIndex` must never move backwards — a bug that shipped.** Re-pointing the playhead let it
  land before the end of the look-ahead window `pump` had already handed to the worklet, and every
  voice in it was posted again, thirty times a second while a slider was held ("the notes are
  played several times and the volume becomes very loud"). `nextIndex = Math.max(nextIndex, want)`;
  `rebuildPoolTo(nextIndex)` replays the pool **by index rather than by frame**; `pump` skips a
  plan entry already in `handed`, cleared only by `seek`. `handed` stores the note's **step**, not
  its frame, because the tempo can move after a voice was handed over. `live-settings.ts`
  reproduces a slider drag: 0 of 163 notes handed over twice with the fix, 159 of 163 without.

✔ **The live path steals exactly what the renderer steals.** `packages/lbp-tracker-lib/dev/live-sim.ts`
builds the plan as the page does and renders it three ways — all voices at once, in 128-frame
blocks, and handed over in look-ahead bursts with the pool applied live — and all three are
**bit-identical** to the direct render, with 1,318 of `C4K3 S0NG`'s 13,091 notes stolen either way.
⚠️ When that file and the renderer disagree, suspect the file first: its −57 dB was the simulator
rendering 4,800 frames per tick where the worklet renders 128 (*34* in answered-questions.md), and
before that it asked the pool once per stack *layer* where `live.ts` had been fixed to ask once per
note (−8.9 dB).

**What the audio thread costs.** `C4K3 S0NG` — 244 tracks, 13,091 notes, the 32-voice pool
saturated — runs at **23-60%** of one core with no dropouts; it was 11-26% before one record per
note (*17b*) put 2,108 more notes into play. ❗ The cost is the per-frame DSP and nothing else: driving the
mixer at 128 frames and at 4,096 costs the same to the millisecond, hoisting `this.*` into locals
made it 3% *slower*, and a sampling profiler's per-function attribution inside the hot loop was a
hint at best — stubbing a thing out and re-timing is what answered every question. ⚠️ Uncapping the
pool nearly doubles the load, and the browser used to restore that checkbox across a reload while
everything else reset; every control on the live page carries `autocomplete="off"` now. The meter
shows **notes**, not sampler voices (a stacked note plays up to five voices from one record, a
one-shot outlives its gate, a release rings on) and turns red at ⅞ of the pool — reading high by
design, because the pool gives a record back at the gate while the voice keeps its tag until it has
finished ringing.

## Playback model

The sequencer is a fixed grid, so the natural clock is **steps, not seconds**, converted once at the
edge: `720000 / tempo` frames per step at 48 kHz — four steps to the beat, measured — with alternate
steps stretched and squeezed by `swing/2` and positions in thirds of a step (`swing.ts`,
[synth-engine.md](synth-engine.md)). A note is **not** `(pitch, start, length, velocity)`: it is a
chain of per-step records carrying their own pitch, volume and modulation, terminated by an `end`
flag, so glides and per-step automation are native to the format and modelled from the start. A
note occupies one of **32** pool records however many unison layers it plays, and the pool steals
the quietest (`polyphony.ts`).

## Build order, and what exists

1. ~~**Port `fsb.py`**~~ — done, byte-identical to the Python oracle; it serves the game's SFX, not
   the sequencer.
2. ~~**The voice engine**~~ — done: worklet, the engine's own interpolator and mipmaps, pitch
   formula, key splits, envelopes, ladder, LFOs, drive, pool.
3. ~~**`RInstrument` reading**~~ — done: all 68 of the game's instruments parse exactly and the bench
   plays them from the real `.smp` samples.
4. ~~**Level import**~~ — done, both halves: `packages/cwlib-ts/src/project.ts` turns a level into
   sequencers, tracks and a scheduled event list; the whole corpus imports (19 files, 338
   sequencers, 129,696 tracks, 2,027,633 notes, zero records falling outside a note; tempos 30–240,
   cells 0–334, rows 0–24), and `dev/verify-levels.ts` matches cwlib's dump on 149 sequencers and
   62,158 placements byte for byte.
5. ~~**Echo, reverb, compressor**~~ — done and measured (`audio/effects.ts`, `audio/compressor.ts`).
6. **The editor.** ⚠️ **Not started.** The four pages are benches and players — they open, play,
   render and export — and nothing in them edits a song: no grid, no piano roll, no undo.
7. **Round-trip export** back into a game-loadable resource — the feature that makes the project
   matter to the LBP community. `cwlib`'s `zip.ts` already writes; the resource writer does not
   exist yet.

| where | what |
|---|---|
| `packages/cwlib-ts/src/` | `stream.ts` (big-endian reader, varints, `Revision` gates), `serializer.ts`, `resource.ts` (container, dependency table), `thing.ts` + `parts.ts` (the walk, 50 readers), `level.ts` (worlds, plans, chunks, `boardCell`), `project.ts` + `notes.ts` (the sequencer as data), `savearchive.ts`, `psf.ts`, `zip.ts`, `backup.ts`, `platform/` |
| `packages/lbp-tracker-lib/src/` | `render.ts` (the pipeline), `audio/mixer.ts` (voices, resampling, panning, looping, per-chunk re-derivation), `audio/interpolate.ts` + `mipmap.ts` (default `linear`; `sinc8` kept for A/B), `audio/moog.ts`, `audio/lfo.ts`, `audio/effects.ts` (echo, reverb, fold constants), `audio/compressor.ts`, `audio/mixer-worklet.ts`, `rinstrument.ts` + `instrument.ts` + `voice.ts`, `envelope.ts`, `params.ts`, `polyphony.ts`, `scale.ts`, `swing.ts`, `fsb.ts` + `ima.ts` + `wav.ts`, `midi.ts` + `smf.ts` |
| `packages/lbp-tracker-web/` | `index.html` the instrument bench; `live.html` the live player; `render.html` the offline renderer, in a worker; `midi.html` the MIDI bridge; `src/controls/`, `src/widgets/`, `src/assets.ts`, `src/lbparchive.ts`, `src/footer.ts` |

## Testing against the corpus

The corpus tests read `LBP_LEVELS`, `LBP_RINST`, `LBP_SMP` and `LBP_FSB` and **skip** when they
are absent, so the suite passes on a machine without the game. Never commit a fixture derived from
game assets or from someone's level ([level-files.md](level-files.md) has the corpora).
**Golden-file tests from day one**: render short fixtures and diff the PCM, because fidelity
regressions are inaudible until they are not, and a diff catches them instantly. ⚠️ A test that
normalises cannot see a gain error, and several here normalise.

## Decided early

- **Our own project format is JSON, not an LBP resource.** Import/export to the game's format is a
  boundary, not the internal model.
- **No server.** Everything client-side: it keeps the asset-licensing story clean and makes the tool
  hostable as static files.
