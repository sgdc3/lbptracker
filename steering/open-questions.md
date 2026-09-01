# Open questions — ranked, with the anchor to attack each from

Read before planning a work session. Everything here is genuinely unknown; nothing here is a
guess dressed up as a fact. When one gets resolved, move the answer into the descriptive steering
file it belongs to and delete the entry.

Questions 1 and 2 gate the features that make the project worth doing. Questions 3–7 affect
fidelity but not feasibility, and can be answered while implementation proceeds.

---

## 1. The 4-byte note record — **BLOCKING**

**Why it matters.** Without it we can build a tracker that sounds like LBP but cannot read a single
existing LBP composition, and cannot write one back. Import/export is the whole reason the LBP
community would use this.

**What is known.** `PInstrument.Notes` at `+0x68` is an array descriptor `{ptr, count, capacity}`
whose elements are **4 bytes each** (measured from the growth helper `v0xd68370`, which allocates
`count * 4`; the same helper for `Name` gives 1, so the multiplier is the element size). A note
plausibly carries pitch, step position, length and possibly velocity, but **none of that is
confirmed** — the field could equally be a bitfield with flags we have not anticipated.

**How to attack it.**
1. Find the consumer. The reader is in the sequencer module `v0x1c3000`–`v0x1c7000`; look for code
   that loads `[instrument+0x68]`, reads the count at `+0x70`, and indexes by 4. `v0x1c49e0` and
   `v0x1c4720` are called from `BeginPlayback` and are the first candidates. The shift/mask
   sequence applied to the loaded `u32` gives the field layout directly.
2. Cross-check empirically. Build a level in-game with exactly one note, save, and diff the
   resource against a version with the note moved one step right, then one semitone up, then
   lengthened. Three diffs pin the three fields with certainty and validate whatever the
   disassembly suggested. This is slower but it is the check that makes the answer trustworthy.
3. Do both. Static analysis proposes the layout, the diff confirms it.

---

## 2. `SampleGuids` → actual audio — **BLOCKING for real instruments**

**Why it matters.** We know `RInstrument` holds 8 `SampleGuids` (u32 each). We know
`sfxbank_compressed.fsb` contains instrument multisamples of exactly the right shape
(`piano_C2..C6`, `epiano_C1..C5`, `triangle_synth_C2..C6`, `bass_guitar`, plus percussion). We have
**not** proved those are the same samples, nor how a GUID resolves to one.

**Two hypotheses, both live.**
- **(a) GUID → FSB bank + index.** There is a resolution table somewhere mapping GUIDs to bank
  entries. Cheap to test: find where `SampleGuids` are consumed and see whether the result is an
  FSB index or a resource handle.
- **(b) GUID → `RSample` resource (type 49) inside a FARC.** LBP has a dedicated `RSample` resource
  type, which would be pointless if samples only lived in FSBs. If so, sequencer audio is inside
  `base_001.farc` / `chunk1_001.farc`, and the browser tool has a much worse asset story (multi-GB
  archive instead of a 40 MB bank).

**How to attack it.** Find the sample-load path from `StartSamplePreload` (`v0x1c3ce8`, worker
`v0x1c37f0`) and follow what it does with a GUID. Whichever branch it takes answers the question.

⚠️ **Do not re-derive the FARC index format.** The last 12 bytes are
`[u32 BE 20825][u32 BE 1770]["FARC"]`, but no combination of those counts with 24/28/32/36-byte
strides yields a plausible offset table — the hash table is probably compressed. The LBP modding
community has a mature toolchain that already reads FARC and LBP resource types; evaluate it before
writing our own.

---

## 3. Echo DSP parameter indices

`v0x3fd4c0`–`v0x3fd5d0` issues 10 `DSP::setParameter` calls (`fmod_dspi` `v0xa23970`). Read the
immediate parameter indices and the values fed in, and match them against
`FMOD_DSP_ECHO_*` / `FMOD_DSP_SFXREVERB_*`. That converts `EchoTime`/`EchoFeedback`/`EchoMix` from
"floats with suggestive names" into exact DSP settings. Straightforward disassembly; no cleverness
needed. **Do this before implementing the echo**, or you will tune by ear against a moving target.

## 4. `finetune` units, and the third sample-slot bool

The sample slot serialises `basenote` (i32), `basebpm` (f32), `finetune` (f32), `pitched` (bool),
`fitbpm` (bool) **and a third bool whose name was not resolved** — the serialiser emits three
`bool` calls but only two names were recovered from the disassembly window. Widen the window at
`v0xcc0e90` and read it.

`finetune` being a float is consistent with cents *or* semitones. The pitch formula in
[sequencer-data-model.md](sequencer-data-model.md) assumes cents and says so. Find the arithmetic in
the playback path, or resolve it by ear against the game once the tracker can play a note.

## 5. Grid resolution and `Swing` semantics

How many steps per beat does the grid hold, and is `Swing` a ratio, a percentage, or a fraction of a
step? Both feed the same conversion in the scheduler
(`samplesPerStep = rate * 60 / (Tempo * stepsPerBeat)`). Answerable from the sequencer module, or
empirically by recording the game's output and measuring inter-onset intervals at a known tempo —
which has the advantage of validating the whole timing chain at once.

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
the entire project.

## 8. `Numstack`, `Loops`, `Params[i]`, `Arpeggio`

Recovered as field names only. `Numstack` looks like a per-instrument voice-stacking count,
`Params[i]_*` is two floats per index, `Arpeggio_*`/`Arpeggiate` is an arpeggiator pattern. All
need semantics before the instrument editor can expose them honestly. Not blocking: an instrument
with `Arpeggiate` off and one stack behaves correctly without any of this.
