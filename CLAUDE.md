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
  with field names and struct offsets, and the sampler formulas that follow from them.
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
  The top item blocks importing real levels.

`tools/` holds the reference implementations. They are Python, deliberately dependency-light, and
they are the ground truth the JavaScript has to reproduce:
- `fsb.py` — FSB4 bank reader + IMA ADPCM decoder + WAV writer. **Verified working.**
- `lbpdis.py`, `callgraph.py`, `fmodapi.py` — eboot RE helpers (see `eboot-re.md`).

Python on this machine: `C:\Users\sgdc3\AppData\Local\Programs\Python\Python314\python.exe`
(capstone 5.0.7 is installed).
