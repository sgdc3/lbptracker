# Open questions — ranked, with the anchor to attack each from

Read before planning a work session. Everything here is genuinely unknown or unconfirmed; nothing
here is a guess dressed up as a fact. When one gets resolved, move the answer into the descriptive
steering file it belongs to and delete the entry.

**Question 1 is the only blocking one left.** Everything below it affects fidelity, not
feasibility: the note format, the container and the level walk are all settled and measured, so
import can be built now.

Last re-ranked 2026-09-01, after analysing the toolkit and then measuring 1.6 million notes out of
a 22-level corpus — see [lbp-modding-toolchain.md](lbp-modding-toolchain.md) for what came from
whom, and [sequencer-data-model.md](sequencer-data-model.md) for the measurements.

---

## 1. `SampleGuids` → actual audio — **BLOCKING for real instruments**

**Why it matters.** We know `RInstrument` holds 8 `SampleGuids`. We know
`sfxbank_compressed.fsb` contains instrument multisamples of exactly the right shape
(`piano_C2..C6`, `epiano_C1..C5`, `triangle_synth_C2..C6`, `bass_guitar`, plus percussion). We have
**not** proved those are the same samples, nor how a GUID resolves to one.

**What the toolkit added.** `RInstrument` serialises these with `serializer.guid()` — they are
ordinary LBP GUIDs into the game's file database, **not** FSB bank indices. And the toolkit
declares `SAMPLE = 49` with no magic and **no implementation**, so the community has not solved
this either. That kills the cheapest hypothesis and leaves:

- **(a) GUID → `RSample` resource** inside a FARC, which then points at audio somehow.
- **(b) GUID → a lookup table** in the eboot or in a `.fev`/`.fsb` sidecar that yields a bank entry.

**How to attack it.** Find the sample-load path from `StartSamplePreload` (`v0x1c3ce8`, worker
`v0x1c37f0`) and follow what it does with a GUID. Whichever branch it takes answers the question.
Then, if it is (a), use the toolkit's FARC reader (`types/archives/Fart.java`, `BlockFile.java`) to
pull one `RSample` out and look at it — **do not re-derive the FARC index format ourselves**, that
was a dead end once already and the toolkit covers it.

---

## 2. Echo DSP parameter indices

`v0x3fd4c0`–`v0x3fd5d0` issues 10 `DSP::setParameter` calls (`fmod_dspi` `v0xa23970`). Read the
immediate parameter indices and the values fed in, and match them against
`FMOD_DSP_ECHO_*` / `FMOD_DSP_SFXREVERB_*`. That converts `EchoTime`/`EchoFeedback`/`EchoMix` from
"floats with suggestive names" into exact DSP settings, and very likely answers question 7 as a
side effect. Straightforward disassembly; no cleverness needed. **Do this before implementing the
echo**, or you will tune by ear against a moving target.

## 3. Grid resolution, swing, and triplets

The cell geometry is now **measured**: `gridX = floor(2*x/105 - 0.5)`, `gridY = floor(-y/105)` at
`v0x1c4ad0`. What is still open:

- **Steps per grid unit.** Clips in the corpus top out at step **31** overwhelmingly, with 63 as
  the only other common ceiling — so the editor grid is 32 steps wide and a clip may span two
  cells. With a 52.5-unit cell that gives 16 steps per cell, matching `sequencerdump`'s constant.
  Consistent, but still inferred from creator behaviour rather than from the engine.
- **`Swing` semantics.** Ratio, percentage, or fraction of a step? Still unknown, and the corpus
  cannot help: `Swing` is **0.0 in 103,538 of 105,785 instruments**. Almost nobody uses it, so
  there is no body of real examples to calibrate against and no tuning it by ear against the game.
  This one has to come out of the sequencer module.
- **Triplet timing.** `sequencerdump` re-times a `triplet` note to 1/12 notes with
  `group = step/4, pos = step%4, tick = group*96 + pos*32`, which overruns the quarter on the
  fourth slot. Its author has disowned that layer; treat it as unmeasured.

All three feed the same conversion in the scheduler
(`samplesPerStep = rate * 60 / (Tempo * stepsPerBeat)`). Answerable from the sequencer module, or
empirically by recording the game's output and measuring inter-onset intervals at a known tempo —
which has the advantage of validating the whole timing chain at once.

## 4. What `Notes.y` actually means

`sequencerdump` feeds `y` straight into a MIDI `NOTE_ON` as an absolute note number and gets usable
MIDI out, and in the corpus `Key` is 0 in 101,536 of 105,785 instruments and `Scale` is 0 in
105,680 — while pitches span 0–95. That points at `y` being absolute pitch with `Key`/`Scale`
constraining only what the *editor* lets you place. It is not proof: `Key = 0` may simply mean C.
If it is wrong, every imported melody is transposed, so confirm it: place a note in-game, change
`Key`, save, and see whether the note record changes.

Related and unresolved: **`basenote` and `Splitnotes` may not use the same numbering.** The toolkit
annotates `basenote` as MIDI note numbers and `Splitnotes` as piano key numbers — 20 apart. Our
key-split logic compares them directly, so one of those annotations has to give.

## 5. `finetune` units

`finetune` is an f32, which is consistent with cents *or* semitones. The pitch formula in
[sequencer-data-model.md](sequencer-data-model.md) assumes cents and says so. The toolkit carries
the field but never interprets it, so it is no help. Find the arithmetic in the playback path, or
resolve it by ear against the game once the tracker can play a note.

*(The other half of this question — the "unnamed third bool" in the sample slot — is resolved: the
serialiser writes `fitbpm` twice to the same member. See the data-model file.)*

## 6. `ReverbSetting` → which reverb

`ReverbSetting` is an i32 preset index. Both `FMOD_DSP_TYPE_SFXREVERB` (Freeverb-derived,
reproducible) and Sony's `aSfxDsp` plugin (proprietary, called from game code at `v0xab51b0`) are
linked. Establish which one the sequencer's send feeds and, if it is SFXREVERB, dump the preset
table. If it is the Sony plugin, accept an approximation — reversing a proprietary reverb is out of
proportion to the payoff.

## 7. FMOD's resampler quality and pan law

Which interpolator `fmod_dsp_resampler.cpp` is configured to use (linear? spline?), and what curve
FMOD's 2D pan applies. Both are small, systematic errors that would otherwise be baked into every
render. The pan law in particular is a single measurement that prevents a stereo-image error across
the entire project — and note that `PInstrument.Pan` runs `0..1` centred at `0.5`, not `-1..+1`.

## 8. Semantics of the remaining fields

Recovered as names, sizes and defaults only:

- `Numstack` (default 1) — looks like a per-instrument voice-stacking count.
- `Loops` on `PInstrument` — **1 in all 105,785 instruments of the corpus**, so whatever it
  does, no creator has used it. Safe to treat as 1 and revisit only if the editor exposes it.
- `Params` — **27** entries of two f32 each. 27 is an odd number; it is not 8 slots, not 9 splits.
- `Arpeggio` — **32** bytes, default `0xf`, with `Arpeggiate` as the on/off bool.
- `Behavior`, `TriggerPlayer`, `PreviewThing` on `PSequencer` — three fields our serialiser walk
  missed entirely; widen the window at `v0xd37d10`.

None are blocking: an instrument with `Arpeggiate` off and one stack behaves correctly without any
of this.

## 9. Board row → mixer channel

`PSequencer` has `NumChannels` and `Volume[0..5]`; instruments have a `gridY` row on the circuit
board. A row is very likely a mixer channel, but nothing has established the mapping — including
what happens when a board has more than 6 rows. The toolkit sidesteps it by grouping tracks on
"same row + same instrument" and ignoring the sequencer's mixer entirely.
