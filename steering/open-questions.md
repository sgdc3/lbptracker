# Open questions — ranked, with the anchor to attack each from

Read before planning a work session. Everything here is genuinely unknown or unconfirmed; nothing
here is a guess dressed up as a fact. When one gets resolved, move the answer into the descriptive
steering file it belongs to and delete the entry.

Question 1 gates real instruments. Question 2 gates import/export but is now a **confirmation**
job rather than a discovery job. Everything below that affects fidelity, not feasibility.

Last re-ranked 2026-09-01, after analysing ennuo's toolkit — see
[lbp-modding-toolchain.md](lbp-modding-toolchain.md) for what that did and did not settle.

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

## 2. `end`, and how a note's duration is encoded

**What is settled.** The four field *roles* in the note record are confirmed against 18 real levels
— see "How the note record was confirmed" in [sequencer-data-model.md](sequencer-data-model.md).
Bytes 2 and 3 are 7-bit with modes exactly `0x60` and `0x40`, byte 0 low 7 is a non-decreasing step
index, byte 1 low 7 is a pitch in a musical range, and the same scan over shuffled bytes conforms
zero times out of 80,810. Decoded arrays read as recognisable melodies and basslines.

**What is not.** Under the chain reading — records accumulate into one held note until `end` is set
— real note lengths come out as 14,774 one-step, 5,026 two-step and only 74 longer. That is not
what music looks like; quarter and half notes should be everywhere and are absent. And only 80% of
multi-record runs have strictly consecutive `x`. Either `end` means something other than "the note
stops here", or duration is not encoded by chain length at all.

**Why it matters.** Duration is not a detail — it is half of what a note is, and we intend to write
these records back into people's levels.

**How to attack it.** The scan that produced those statistics pattern-matches at every 4-byte
offset instead of walking the Thing graph, so an unknown fraction of its 737 hits are coincidences
that pollute the distribution. **Parse a level structurally first** — reach genuine `PInstrument`
parts by their real offsets — and re-measure. If the distribution is still bimodal at 1 and 2 steps
with real arrays only, the chain model is wrong and needs replacing, not refining.

The in-game diff test remains the tiebreaker if it stays ambiguous: place one note, save, then
lengthen it and diff. That single pair of files answers it outright.

**Static, if needed.** A byte-scan of the sequencer module and the audio layer for the 7-bit mask
idiom found nothing (recorded in the data-model file), so the consumer is elsewhere. `v0x1c49e0`
and `v0x1c4720` turn out to be the *placement* path, not the note path — they compute grid indices
from board positions. Look instead at what `PSequencer::BeginPlayback` (`v0x1c4f00`) reaches that
touches `[instrument+0x68]`.

---

## 3. Echo DSP parameter indices

`v0x3fd4c0`–`v0x3fd5d0` issues 10 `DSP::setParameter` calls (`fmod_dspi` `v0xa23970`). Read the
immediate parameter indices and the values fed in, and match them against
`FMOD_DSP_ECHO_*` / `FMOD_DSP_SFXREVERB_*`. That converts `EchoTime`/`EchoFeedback`/`EchoMix` from
"floats with suggestive names" into exact DSP settings, and very likely answers question 7 as a
side effect. Straightforward disassembly; no cleverness needed. **Do this before implementing the
echo**, or you will tune by ear against a moving target.

## 4. Grid resolution, swing, and triplets

The cell geometry is now **measured**: `gridX = floor(2*x/105 - 0.5)`, `gridY = floor(-y/105)` at
`v0x1c4ad0`. What is still open:

- **Steps per grid unit.** The toolkit uses 16, which with its 52.5-wide cell means a cell is one
  bar of 16ths. Plausible and consistent, but unconfirmed.
- **`Swing` semantics.** Ratio, percentage, or fraction of a step? Untouched by the toolkit — it
  copies the float into its `Sequence` and never uses it.
- **Triplet timing.** The toolkit re-times a `triplet` note to 1/12 notes with
  `group = step/4, pos = step%4, tick = group*96 + pos*32`, which overruns the quarter on the
  fourth slot. That is their interpretation, not a measurement.

All three feed the same conversion in the scheduler
(`samplesPerStep = rate * 60 / (Tempo * stepsPerBeat)`). Answerable from the sequencer module, or
empirically by recording the game's output and measuring inter-onset intervals at a known tempo —
which has the advantage of validating the whole timing chain at once.

## 5. What `Notes.y` actually means

The toolkit feeds `y` straight into a MIDI `NOTE_ON` as an absolute note number and gets usable
MIDI out, so `y` is probably absolute pitch and `PInstrument.Key`/`Scale` only constrain what the
*editor* lets you place. "Probably" is doing real work in that sentence, and if it is wrong every
imported melody is transposed. Confirm alongside question 2's diff test: place a note, change
`Key`, and see whether the note record changes.

Related and unresolved: **`basenote` and `Splitnotes` may not use the same numbering.** The toolkit
annotates `basenote` as MIDI note numbers and `Splitnotes` as piano key numbers — 20 apart. Our
key-split logic compares them directly, so one of those annotations has to give.

## 6. `finetune` units

`finetune` is an f32, which is consistent with cents *or* semitones. The pitch formula in
[sequencer-data-model.md](sequencer-data-model.md) assumes cents and says so. The toolkit carries
the field but never interprets it, so it is no help. Find the arithmetic in the playback path, or
resolve it by ear against the game once the tracker can play a note.

*(The other half of this question — the "unnamed third bool" in the sample slot — is resolved: the
serialiser writes `fitbpm` twice to the same member. See the data-model file.)*

## 7. `ReverbSetting` → which reverb

`ReverbSetting` is an i32 preset index. Both `FMOD_DSP_TYPE_SFXREVERB` (Freeverb-derived,
reproducible) and Sony's `aSfxDsp` plugin (proprietary, called from game code at `v0xab51b0`) are
linked. Establish which one the sequencer's send feeds and, if it is SFXREVERB, dump the preset
table. If it is the Sony plugin, accept an approximation — reversing a proprietary reverb is out of
proportion to the payoff.

## 8. FMOD's resampler quality and pan law

Which interpolator `fmod_dsp_resampler.cpp` is configured to use (linear? spline?), and what curve
FMOD's 2D pan applies. Both are small, systematic errors that would otherwise be baked into every
render. The pan law in particular is a single measurement that prevents a stereo-image error across
the entire project — and note that `PInstrument.Pan` runs `0..1` centred at `0.5`, not `-1..+1`.

## 9. Semantics of the remaining fields

Recovered as names, sizes and defaults only:

- `Numstack` (default 1) — looks like a per-instrument voice-stacking count.
- `Loops` (default 1) on `PInstrument`.
- `Params` — **27** entries of two f32 each. 27 is an odd number; it is not 8 slots, not 9 splits.
- `Arpeggio` — **32** bytes, default `0xf`, with `Arpeggiate` as the on/off bool.
- `Behavior`, `TriggerPlayer`, `PreviewThing` on `PSequencer` — three fields our serialiser walk
  missed entirely; widen the window at `v0xd37d10`.

None are blocking: an instrument with `Arpeggiate` off and one stack behaves correctly without any
of this.

## 10. Board row → mixer channel

`PSequencer` has `NumChannels` and `Volume[0..5]`; instruments have a `gridY` row on the circuit
board. A row is very likely a mixer channel, but nothing has established the mapping — including
what happens when a board has more than 6 rows. The toolkit sidesteps it by grouping tracks on
"same row + same instrument" and ignoring the sequencer's mixer entirely.
