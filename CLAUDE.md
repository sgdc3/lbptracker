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
- [steering/game-assets.md](steering/game-assets.md) — read before touching audio data: where the
  banks are on disk, the FSB4 layout, the codecs (measured), and the asset-licensing stance.
- [steering/lbp-audio-engine.md](steering/lbp-audio-engine.md) — read when you need to know what
  the game's engine actually does: FMOD Ex 4.44.10, which parts of it LBP3 uses and which it
  ignores, the DSP chain, and what that implies for matching its sound.
- [steering/tracker-architecture.md](steering/tracker-architecture.md) — read before starting
  implementation: the web architecture, why AudioWorklet and not `AudioBufferSourceNode`, the
  module breakdown and the build order.
- [steering/eboot-re.md](steering/eboot-re.md) — **read before opening the eboot**: address
  conventions (the delta trap that costs hours), the tools in `tools/`, the script-binding table,
  and the anchors already found in the sequencer module.
- [steering/open-questions.md](steering/open-questions.md) — **read before planning a work
  session**: everything still unknown, ranked, each with the concrete anchor to attack it from.
- [steering/answered-questions.md](steering/answered-questions.md) — **read before re-deriving
  anything**: the questions that are settled and implemented, with their addresses, corpus counts
  and — more useful — the wrong turns taken on the way to each.

`tools/` holds the reference implementations. They are Python, deliberately dependency-light, and
they are the ground truth the JavaScript has to reproduce:
- `fsb.py` — FSB4 bank reader + IMA ADPCM decoder + WAV writer. **Verified working.**
- `lbpres.py` — LBP serialised-resource container reader (`LVLb`/`PLNb`: revision, branch, zlib
  chunk table). **Verified working** on 18 real levels.
- `PartCensus.java` — which Thing parts a level corpus actually uses, overall and on the Things
  carrying a `SEQUENCER` or an `INSTRUMENT`. Its `INSTRUMENT` count for the ten-level corpus,
  62,158, is what `test/project.test.ts` pins the TypeScript walk against. ⚠️ The "eight part
  readers" its output was once read as scoping the walk down to was a misreading — 30 were needed;
  see `steering/tracker-architecture.md`.
- `GuidLookup.java` — resolve a GUID (or a path substring) against the game's FileDB
  `output/orbisguids.map`. This is how you find where any resource actually lives.
- `ExtractGuid.java` — GUID → FileDB → SHA1 → FARC → bytes, plus a `manifest.json` the browser can
  use to resolve GUIDs without the 11 MB FileDB. This is how the sequencer's real samples and
  `.rinst` instrument definitions come out of the game:

  ```
  java -cp "$JAR;out" ExtractGuid <orbisguids.map> <gamedir> fixtures/rinst .rinst
  java -cp "$JAR;out" ExtractGuid <orbisguids.map> <gamedir> fixtures/smp  audio/music/samples
  ```

  Then `node dev/serve.mjs` and open http://127.0.0.1:8173/ to play them.
- `lbpdis.py`, `callgraph.py`, `fmodapi.py` — eboot RE helpers (see `eboot-re.md`).
- `prxdis.py` — the same for the two audio PRXs: `prxdis.py reverb|input <vaddr> [count]`,
  resolving rip-relative operands to the float/double there. The whole reverb was read with it.
  Disassemble from a **function start**, not an arbitrary address: a mid-function start
  desynchronises the stream and prints convincing nonsense. ⚠️ Its file deltas were both **0x40
  too small** until 2026-09-02, so every PRX address in a steering note older than that is 0x40
  too high — the readings are fine, the labels are not. The script's docstring says why.

⚠️ **`RawDump.java` is gone**, deleted 2026-09-02. It walked a level's Thing graph through the
external toolkit jar and dumped every music sequencer's note records; `src/core/level.ts` does
that now, in TypeScript, and nothing in the pipeline needs Java. What it leaves behind is
`fixtures/levels/sequencers.jsonl` — 129,696 rows over 22 levels, produced by cwlib rather than
by us, and the golden fixture `dev/verify-levels.ts` still checks the walk against. **That file
can no longer be regenerated**, so it covers its own corpus and nothing newer, and it still
contains the 23,911 duplicate rows the tool used to emit — see *The `RawDump` duplication* in
`steering/lbp-modding-toolchain.md` before trusting a raw row count.

Python on this machine: `C:\Users\sgdc3\AppData\Local\Programs\Python\Python314\python.exe`
(capstone 5.0.7 is installed).
