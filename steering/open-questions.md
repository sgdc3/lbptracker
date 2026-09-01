# Open questions — ranked, with the anchor to attack each from

Read before planning a work session. Everything here is genuinely unknown or unconfirmed; nothing
here is a guess dressed up as a fact. When one gets resolved, move the answer into the descriptive
steering file it belongs to and delete the entry.

**Nothing here blocks the build any more**, but question 1 changes what the tracker sounds like on
every multisampled instrument, so treat it as the next real piece of work.

** `SampleGuids` -> audio, the last blocking unknown, was resolved
on 2026-09-01: sequencer samples are plain RIFF/WAV files in the FARC archives, addressed by GUID
through the game's FileDB. See [game-assets.md](game-assets.md). The note format, the container,
the level walk and now the asset chain are all measured — import and playback can both be built.

What remains below is fidelity work, ranked by how audible a mistake would be.

Last re-ranked 2026-09-01, after analysing the toolkit and then measuring 1.6 million notes out of
a 22-level corpus — see [lbp-modding-toolchain.md](lbp-modding-toolchain.md) for what came from
whom, and [sequencer-data-model.md](sequencer-data-model.md) for the measurements.

---

## 1. The `Splitnotes` convention — **the one that changes what you hear**

**What is measured**, across the game's 68 `.rinst` instruments: `Splitnotes` is a **descending**
list of 9 values, `splitNotes[0]` is **87 in every single instrument**, and unused trailing entries
are 0. `numStack` is *not* the number of used slots (only 14 of 68 match) — use
`sampleGuids[i] != 0` for that.

**What is not.** Reading them as inclusive upper bounds — zone `i` covers
`splitNotes[i+1] < note <= splitNotes[i]` — puts a zone's own base note inside it only **56.8%** of
the time. Over the 257 zones of the multisampled instruments: base inside its own zone 146, inside
the zone above 31, neither 80.

| instrument | bounds | base notes | fits? |
|---|---|---|---|
| `baiyon_city_guildford` | 87, 73, 61, 49, 37, 25 | 84, 72, 60, 48, 36, 24 | **every zone** |
| `piano` | 87, 66, 54, 40, 30 | 84, 72, 60, 48, 36 | only the first |
| `honky_tonk_piano` | — | — | 1 of 5 |
| `clarinet` | — | — | 1 of 3 |

Drum kits explain some misses — a kit's base notes are arbitrary, one drum per key — but the piano
and the clarinet are pitched instruments and they do not fit. Under this reading the piano would
play C4 from the **C5** sample, twelve semitones down, while `piano_c4.smp` sits unused. That is
audible, and it is the difference between the right timbre and a dull one across the whole keyboard.

**How to attack it.** Three candidates, in order of cheapness:

1. **An off-by-one in the slot↔zone pairing.** 12.1% of bases land in the zone *above* theirs.
   Check whether `splitNotes[0]` is a global ceiling rather than zone 0's bound, which would shift
   every pairing by one.
2. **Different numbering.** cwlib annotates `baseNote` as MIDI and `Splitnotes` as piano key
   numbers (20 apart). `baseNote` is now confirmed MIDI — the piano's are 84/72/60/48/36 = C6..C2 —
   so if the annotation is right, `Splitnotes` needs converting before comparison.
3. **The runtime.** Find where the sequencer picks a slot and read the comparison directly. That is
   the only answer that ends the argument.

Until it is settled, `resolveSlot` in `src/core/instrument.ts` carries the upper-bound reading and
says all of this in its docstring.

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

## 7. FMOD's resampler quality and pan law — **now audible, not cosmetic**

Which interpolator `fmod_dsp_resampler.cpp` is configured to use, and what curve FMOD's 2D pan
applies.

**Why this was promoted.** The first listening test came back "extremely distorted, like dither" on
a single note. It was the interpolator. Every shipped instrument sample is 22050 or 32000 Hz and
plays on a 44100/48000 Hz device, so **every note is resampled** — this is not an edge case. SNR
against an analytic sine, 22050 Hz source at `playbackRate` 0.5:

| source Hz | nearest | linear | cubic | sinc8 |
|---|---|---|---|---|
| 440 | 27.1 | 57.1 | 107.8 | 87.6 |
| 2000 | 13.9 | 30.9 | 55.4 | 80.2 |
| **4000** | 8.0 | **19.0** | 32.0 | **72.0** |
| 8000 | 2.3 | 7.7 | 10.8 | 43.1 |

19 dB at 4 kHz is a 16% amplitude error, and a piano attack is full of 2–8 kHz. The default is now
`sinc8` (8-tap Blackman-windowed sinc), and `test/audio.test.ts` guards the floor.

⚠️ **Clean is not the goal — matching the game is.** If FMOD Ex interpolates crudely, that
roughness belongs in our output too, and `sinc8` would be *wrong* in the faithful direction. So this
question is now on the critical path: measure what the engine does before tuning anything by ear
against it.

**The pan law** is the other half and is unchanged in urgency: one measurement prevents a
stereo-image error across the entire project. Note `PInstrument.Pan` runs `0..1` centred at `0.5`,
not `-1..+1`; equal-power is currently assumed in `panGains`.

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
