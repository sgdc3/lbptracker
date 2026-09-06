# Steering index — LBP Tracker

Building a faithful re-implementation of LittleBigPlanet 3's in-game **Music Sequencer** as a
standalone tracker, ideally in the browser. "Faithful" is the whole point of the project: the
target is not *a* tracker that sounds nice, it is a tracker whose output you cannot tell apart
from the game's.

Rules for this workspace's steering:
- **All steering files must always be written in English.**
- One topic per file under `steering/`. When adding a topic, create `steering/<topic>.md`
  (English, kebab-case name) and add a one-line entry to the list below saying *when to read it*.
- Steering holds durable knowledge about the target (the game) and about how we intend to build.
  Session history and dead ends belong to the auto-memory, not here.
- Facts in steering must be **measured**, not remembered. Every non-obvious claim here was taken
  out of the game's own bytes; if you add one, say how you measured it so the next session can
  re-check it. Where something is still a guess, it lives in `open-questions.md`, not in the
  descriptive files.

Steering files (read on demand, per the hints):
- [steering/project-brief.md](steering/project-brief.md) — **read FIRST**: what we are building,
  what "faithful" means concretely, the fidelity budget, scope and non-goals.
- [steering/sequencer-data-model.md](steering/sequencer-data-model.md) — **read before writing any
  parser or playback code**: the recovered `PSequencer` / `PInstrument` / `RInstrument` schemas
  with field names and struct offsets, the on-disk save format (endianness, stream order, revision
  gates, the note record, the circuit-board timeline), and the sampler formulas that follow.
- [steering/lbp-modding-toolchain.md](steering/lbp-modding-toolchain.md) — **read before writing a
  parser for any LBP resource or archive**: what ennuo's toolkit already solves, what it does not,
  and the rule for turning its readings into facts of ours.
- [steering/midi-interchange.md](steering/midi-interchange.md) — **read before touching
  `packages/lbp-tracker-lib/src/midi.ts`, or before adding a field to `Sequencer` or `Track`**: every side channel the
  MIDI file carries, what each costs over the corpus, and which one can go stale.
- [steering/game-assets.md](steering/game-assets.md) — read before touching audio data: where the
  banks are on disk, the FSB4 layout, the codecs (measured), and the asset-licensing stance.
- [steering/lbp-audio-engine.md](steering/lbp-audio-engine.md) — read when you need to know what
  the game's engine actually does: FMOD Ex 4.44.10, which parts of it LBP3 uses and which it
  ignores, the DSP chain, and what that implies for matching its sound.
- [steering/tracker-architecture.md](steering/tracker-architecture.md) — read before starting
  implementation: the three packages and where the seam between them runs, why the web layer has a
  bundler and Vue and the libraries have neither, why AudioWorklet and not `AudioBufferSourceNode`,
  the module breakdown and the build order.
- [steering/eboot-re.md](steering/eboot-re.md) — **read before opening the eboot**: address
  conventions (the delta trap that costs hours), the tools in `tools/`, the script-binding table,
  and the anchors already found in the sequencer module.
- [steering/open-questions.md](steering/open-questions.md) — **read before planning a work
  session**: everything still unknown, ranked, each with the concrete anchor to attack it from.
- [steering/answered-questions.md](steering/answered-questions.md) — **read before re-deriving
  anything**: the questions that are settled and implemented, with their addresses, corpus counts
  and — more useful — the wrong turns taken on the way to each.

## Layout — three npm workspaces, since 2026-09-06

| directory | package | what it is |
|---|---|---|
| `packages/cwlib-ts` | `@lbptracker/cwlib` | reading LBP's serialised resources: container, Thing graph, parts, saves |
| `packages/lbp-tracker-lib` | `@lbptracker/lib` | turning that into sound: sampler, DSP chain, render pipeline, MIDI |
| `packages/lbp-tracker-web` | `@lbptracker/web` | the four pages — Vite, and Vue for the panels |

Each has its own `src/`, `test/` and a `dev/`: Node harnesses in the libraries, the typecheck
entry point in the web package. Imports
cross by package name: `import { readWorld } from '@lbptracker/cwlib/level.ts'`.

- `npm install` — **now required**, and it was not before. Workspaces resolve the package names
  through symlinks in `node_modules`. Nothing is downloaded for the libraries.
- `npm test` — `node --test`, all three workspaces at once, from the root.
- `npm run typecheck` — two `tsc` projects, then `vue-tsc` for the web package.
  ⚠️ **The web package checks `.vue` through `typescript-native-bridge`**: `vue-tsc` needs a
  JavaScript API and `typescript@7` is the native compiler and has none. The bridge is tsgo 7.0.2
  with that API bolted on. See `packages/lbp-tracker-web/dev/typecheck.mjs`.
- `npm run serve` / `build` / `preview` — Vite, **in the web package only**.

❗ **The two libraries have no build step and must keep it that way.** Node runs their TypeScript
directly, so the file the browser executes is the file `node --test` executes, which is what the
fidelity argument rests on. The bundler stops at the web package's edge.

⚠️ **An import map does not reach a Worker or an AudioWorklet** — measured in Chrome, table in
`steering/tracker-architecture.md`. That is *why* the web package has a bundler, and it is the trap
to remember before moving anything into `audio/mixer-worklet.ts`'s import graph: a bare specifier in
there fails to load and the page goes silent with nothing on the main thread to say why.

`tools/` holds the reference implementations. They are Python, deliberately dependency-light, and
they are the ground truth the JavaScript has to reproduce:
- `fsb.py` — FSB4 bank reader + IMA ADPCM decoder + WAV writer. **Verified working.**
- `lbpres.py` — LBP serialised-resource container reader (`LVLb`/`PLNb`: revision, branch, zlib
  chunk table). **Verified working** on 18 real levels.
- `PartCensus.java` — which Thing parts a level corpus actually uses, overall and on the Things
  carrying a `SEQUENCER` or an `INSTRUMENT`. Its `INSTRUMENT` count for the ten-level corpus,
  62,158, is what `packages/cwlib-ts/test/project.test.ts` pins the TypeScript walk against. ⚠️ The "eight part
  readers" its output was once read as scoping the walk down to was a misreading — 30 were needed;
  see `steering/tracker-architecture.md`.
- `CwlibTrace.java` — **ask cwlib what it reads from a level, and where.** `CwlibTrace parts <level>`
  gives the Thing count and each Thing's decoded part list; `CwlibTrace spans <level>` turns on
  cwlib's own serialiser log and prints every part boundary **with its byte offset**, which
  `setTrace` in `packages/cwlib-ts/src/thing.ts` prints for our side. ❗ **Reach for this before tracing bytes by
  hand.** Question 28 spent one session on a hex dump and another guessing at version gates; four
  real bugs then came out of `Thing.java`, `PPos.java` and `PShape.java` in an afternoon, and the
  remaining work is now a span diff. ⚠️ `javac` here is JDK 25 and the first `java` on PATH is 1.8 —
  use the JDK's own `java` or it fails with `UnsupportedClassVersionError`. Its header has the
  command lines.
- `GuidLookup.java` — resolve a GUID (or a path substring) against the game's FileDB
  `output/orbisguids.map`. This is how you find where any resource actually lives.
- `ExtractGuid.java` — GUID → FileDB → SHA1 → FARC → bytes, plus a `manifest.json` the browser can
  use to resolve GUIDs without the 11 MB FileDB. This is how the sequencer's real samples and
  `.rinst` instrument definitions come out of the game:

  ```
  java -cp "$JAR;out" ExtractGuid <orbisguids.map> <gamedir> fixtures/rinst .rinst
  java -cp "$JAR;out" ExtractGuid <orbisguids.map> <gamedir> fixtures/smp  audio/music/samples
  ```

  Then `npm run serve` and open http://127.0.0.1:8173/ to play them.
- `wavehammer.py` / `runhammer.py` — the compressor the game ends its chain with. `wavehammer.py`
  is the model (a literal transcription of the PRX plus the two-line closed form its knee reduces
  to; `check` agrees them to 2.1e-14 dB). **`runhammer.py` loads the actual PRX into this process
  and runs it** — both segments at their own vaddrs in one RWX allocation, GOT written by hand,
  `powf`/`_FLog` shimmed to the CRT, and a System V ← Windows thunk — and `runhammer.py sweep`
  agrees the two to 1e-4 dB. ❗ **Reach for `runhammer.py` when a field looks uninitialised.** Three
  readings of this DSP were written down wrong and two committed; the last one died the moment the
  module printed `[state+0xc0] = 64`. Its docstring and *37* in `steering/answered-questions.md`
  have the trap: a superset disassembly proved there was no store to `[reg+0xc0]`, correctly, and
  the field was written all along as `[rbx+0x3c]` through an interior pointer. **An absolute-offset
  search is only sound if every access uses the same base.** The harness is reusable on
  `fmodsmsreverb` and `fmodextinput`, which are the same shape.
- `panmeasure.py` — the stereo width of a recording: the least-squares leak of one channel into the
  other, with the residual that says whether a single number describes it at all. This is how the
  pan width was settled; use it on any new capture of the game.
- `lbpdis.py`, `callgraph.py`, `fmodapi.py` — eboot RE helpers (see `eboot-re.md`).
- `ebvtable.py` — **name a C++ class's vtable in the eboot, through RTTI**: `ebvtable.py
  ChannelSoftware 24` dumps its slots, `ebvtable.py slot 0x98 Channel` compares one slot across
  classes, `ebvtable.py who <vaddr>` says which vtable a function sits in. ⚠️ **Reach for this
  before any structural vtable search.** Question 22 spent a session enumerating vtables by shape —
  runs of relocation slots holding code addresses — and produced five wrong candidates plus a near
  miss convincing enough to write up; the binary has 122 mangled `N4FMOD...E` names and 322 vtables
  that can simply be named. The trap that hides them is in the docstring: the slots are **zero on
  disk** and the pointers live in `R_X86_64_RELATIVE` addends, so searching the data finds nothing
  and it reads as "there is no RTTI".
- `ebxref.py` — **who references an address in the eboot**: `ebxref.py refs <vaddr>` finds every
  rip-relative reference to it, `ebxref.py calls <vaddr>` every direct call, clustered by caller and
  marked game-side or FMOD-internal. ⚠️ **Run `calls` before writing down that the game never does
  something.** Question 37 spent a session on "no `DSP::setParameter` call on the WaveHammer handle
  has been found" — true, and doing the work of a false sentence, because *not found* had not been
  separated from *not there*. Two enumerations turn that into a measurement; its docstring has the
  story, and the trap (the displacement is assumed to be the instruction's last field).
- `ebdyn.py` — the eboot's dynamic imports: `ebdyn.py modules` lists the modules a NID's `#L#M`
  suffix indexes, `ebdyn.py <nid>` resolves one to its module, GOT slot and every reference to it.
  ⚠️ **Run this before building anything on a NID.** Matching a NID against the string table alone
  once turned libc into "the sequencer plugin's only export"; the module suffix settles it in one
  query. Its docstring has the story.
- `prxnid.py` — **a PRX's imports and exports, by NID**: `prxnid.py input imports` lists all nine of
  `fmodextinput.prx`'s, `prxnid.py input 0x140` resolves one stub, `prxnid.py input guess rand`
  confirms a name against them, `prxnid.py hash <name>` just prints a NID, and
  **`prxnid.py libc export rand`** says where a name is *defined*. ⚠️ `ebdyn.py` does this
  for the eboot and **cannot** for a PRX: a PRX's `PT_DYNAMIC` has no data segment of its own, it
  lives inside `SCE_DYNLIBDATA`, and half the SELF segment entries are 32-byte digests rather than
  data. Both traps are in the docstring, with the addresses. It is how `0x140` in the unison stack
  loop was settled as **`rand`** rather than assumed. ✔ It reads shadPS4's
  `aerolib.inl` when that checkout is present — 171,520 `STUB("nid", name)` lines — so every import
  resolves rather than being guessed at, and Sony's own table agrees with the hash on `rand`.
- `prxdis.py` — the same for the PRXs' code: `prxdis.py reverb|input|libc <vaddr> [count]`,
  resolving rip-relative operands to the float/double there, and `prxdis.py <module> map` for the
  segment map. The whole reverb was read with it.
  Disassemble from a **function start**, not an arbitrary address: a mid-function start
  desynchronises the stream and prints convincing nonsense. ⚠️ Its file deltas were both **0x40
  too small** until 2026-09-02, so every PRX address in a steering note older than that is 0x40
  too high — the readings are fine, the labels are not. The script's docstring says why.

  ❗ **`libc` is in both tools because the game ships its own** at `sce_module/libc.prx`, so the
  libc `fmodextinput.prx` links against is a file on this disk rather than a fact about the
  console. That is how `RAND_MAX` was settled as `2^30 - 1` — `rand` is a 37-byte LCG at vaddr
  `0x17000` — which closed question 12. **When a question turns on what a system function does,
  check `sce_module/` before reasoning about the platform.**

`packages/cwlib-ts/dev/archive-sample.mjs` — **a corpus, from the archive's own index**: `node
packages/cwlib-ts/dev/archive-sample.mjs 60` reads `dry.db` (2.6 GB of SQLite from archive.org, 10.5M level slots),
picks an even spread of ids per game, downloads the root levels into `fixtures/archive/` and leaves
them for `packages/cwlib-ts/dev/walk-levels.ts`. ⚠️ **Reach for this before arguing about reader coverage from the
ten-level corpus**, which is one creator on one console generation: the 103-level sweep behind
`LBP3_MIN_VERSION` took one command, and every real `parts.ts` bug found on 2026-09-05 came out of a
file no PS3 save here contains. `LBP_DRY_DB` points at the index.

⚠️ **`RawDump.java` is gone**, deleted 2026-09-02. It walked a level's Thing graph through the
external toolkit jar and dumped every music sequencer's note records; `packages/cwlib-ts/src/level.ts` does
that now, in TypeScript, and nothing in the pipeline needs Java. What it leaves behind is
`fixtures/levels/sequencers.jsonl` — 129,696 rows over 22 levels, produced by cwlib rather than
by us, and the golden fixture `packages/cwlib-ts/dev/verify-levels.ts` still checks the walk against. **That file
can no longer be regenerated**, so it covers its own corpus and nothing newer, and it still
contains the 23,911 duplicate rows the tool used to emit — see *The `RawDump` duplication* in
`steering/lbp-modding-toolchain.md` before trusting a raw row count.

Python on this machine: `C:\Users\sgdc3\AppData\Local\Programs\Python\Python314\python.exe`
(capstone 5.0.7 is installed).
