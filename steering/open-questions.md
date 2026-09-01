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
- `Params` — **27** pairs of f32, all in 0..1. **The envelope is almost certainly in here** and no
  index is identified. Attacked on 2026-09-01 from three directions; all three failed, so the
  negative results are below to stop the next attempt repeating them.

  **What the block's shape says** (68 instruments, so 136 values per index):

  | kind | indices | evidence |
  |---|---|---|
  | boolean | **23** | only two distinct values ever, 0 and 1 |
  | near-boolean | **13** | 6 distinct values, 1.0 ×69 and 0.0 ×56 |
  | centred bipolar, neutral 0.5 | **21**, **18**, **15** | 21 is 0.5 in 110 of 136, range 0.34–0.62, and x = y in 67 of 68 |
  | level, usually full | **9**, **5** | 1.0 in 94 and 81 of 136 |
  | per-instrument, genuinely paired | **24**, **3**, **14** | 24 has x ≠ y in 52 of 68 and 92 distinct values; 14 has 67 distinct |
  | barely used | 17, 20, 22, 26 | non-zero in 9 instruments or fewer |

  Indices 24, 3 and 14 are where an envelope would live if it is here: they vary per instrument and
  carry two different numbers, which is what a (value, key-tracking) or (min, max) pair looks like.

  **What failed, and why:**

  1. **Correlation with behaviour.** Labelled each instrument by whether its samples loop (a proxy
     for "sustains"), its measured sample decay in dB, and its unpitched fraction, then correlated
     all 54 components. Best results are |r| ≈ 0.5 at n = 59 — real, but several indices share it
     and the target is itself only a proxy. It narrows, it does not name.
  2. **The tweak UI.** `gamedata/scripts/tweakinstrument.ff` (GUID 122184) is the *sequencer's* note
     editor — `edit_notes_mode`, `InTripletMode`, `pattern_width`, `BeginSequencerPlayback`. There is
     no in-game editor for the sampler's parameters, so no label exists to recover. The only other
     sequencer scripts are `tweaksequencer.ff` and `tweaksequencergame.ff`.
  3. **The serialiser.** It names them literally: the format string at `v0xc68bea` is `"%s_%d"` over
     the base `"Params[i]"`, giving `Params[i]_0`, `Params[i]_1`, … The game does not name them
     either.
  4. **The runtime.** Scanned all 25,074 function prologues in the eboot for code touching the pair
     at `+0x1e8`/`+0x1ec`: 70 functions, and 42 of those also touch `+0x48`, `+0xc8` or `+0xe8`.
     Those offsets are far too common to discriminate; this did not converge.

  **What is left to try:** find the RInstrument consumer from the *object* rather than the offsets —
  whatever the sample-preload path (`v0x1c37f0`) hands its loaded instrument to. Or accept the
  envelope as ours and mark it as such, which is what `VoiceSpec.release` already does.
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
