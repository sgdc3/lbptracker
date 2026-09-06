# Open questions — ranked, with the anchor to attack each from

Read before planning a work session. Everything here is genuinely unknown or unconfirmed; nothing
here is a guess dressed up as a fact. When one gets resolved, move the answer into the descriptive
steering file it belongs to and delete the entry.

**Nothing here blocks the build.** `SampleGuids` → audio, the last blocking unknown, was resolved on
2026-09-01: sequencer samples are plain RIFF/WAV files in the FARC archives, addressed by GUID
through the game's FileDB. See [game-assets.md](game-assets.md). The note format, the container, the
level walk and the asset chain are all measured — import and playback can both be built.

What remains below is fidelity work, ranked by how audible a mistake would be. **The synth side is
now fully recovered.** All 27 `Params` are named and the block turns out to be a small subtractive
synth — unison stack, 4-pole Moog ladder, two ADSRs, three LFOs, output stage (`src/core/params.ts`).
The sampler, the envelope, the scale quantiser (six rows at module vaddr `0x80c0`), the three LFO
destinations and the pan law are all measured; see
[sequencer-data-model.md](sequencer-data-model.md).

**The effects are closed.** Both were finished on 2026-09-02 and both are in
[answered-questions.md](answered-questions.md): *6 / 14. The reverb* (the whole of
`fmodsmsreverb.prx`) and *2 / 2b. The echo*. Read them before touching `src/audio/effects.ts` —
most of what this file used to say about either was wrong, and the tables of wrong readings are the
useful part. ~~**What is left is the remaining field semantics**, mainly `Notes.y` / `Splitnotes`
(question 4)~~ — **answered 2026-09-02**, and it *was* transposing imported levels: `Key` is a real
transposition and this project ignored it. See *18. `Notes.y`, `Key` and `Splitnotes`* in
[answered-questions.md](answered-questions.md).

⚠️ **Question 24 is a different kind of thing from the rest of this file** and is deliberately
last: nothing in it is audible and nothing in it is broken. It asks whether the MIDI converter's
verbatim record patch can be made smaller, not whether the game has been read correctly.

❗ **The sampler side is now closed too.** Question 12 — `Params[2]`, the last unresolved thing the
engine does to a note before it sounds — was answered on 2026-09-05: the stack loop computes a
random start for every layer and the instruction after it clears layer 0's, which is why six drum
kits can set the parameter to 1.000 harmlessly. That entry is worth reading for its method failure
rather than its answer: **the measurement had been in
[sequencer-data-model.md](sequencer-data-model.md) since the day the loop was first read, two lines
above a summary table that contradicted it.**

❗ **And the output stage is closed, the same day.** Question 22 — why the game's centre speaker
carries the mono average of the front pair — was the last hop of the signal chain that was inferred
rather than read. It is read now, at `v0xa2599f`, and `PAN_WIDTH = 2 - sqrt2` is a derivation from
three measured constants instead of a fit. Its entry is the one to read before any vtable hunt in
this binary: **the eboot has RTTI**, 322 vtables can be named outright, and a session was spent
enumerating them by shape instead. `tools/ebvtable.py` is what came out of it.

❗ **And question 3's last piece turned out to be the clock everything runs on.** The engine's DSP
block is a fixed **256 frames** (`0x0170` calls the block function with `mov esi, 0x100` and refuses
a length that is not a multiple of it), so the modulation staircase this project holds for a chunk
was being stepped at the AudioWorklet's 128 rather than the engine's 256. Fixed 2026-09-05, worth
−50.6 dB of difference at an unchanged RMS. The same read showed that **note onsets land on that
block** rather than on the sample, which is now the one open *decision* in section 0.

✔ **And question 15 is withdrawn**, 2026-09-05: the listener says `robot` now sounds right. It is in
[answered-questions.md](answered-questions.md) with **no cause attached**, which is the point of the
entry — the one systematic change that reaches `robot` is worth −33 dB and a mere reseed is worth
−4.6 dB, so the biggest thing that happened to it was its vibrato phases being reshuffled. A
difference smaller than a reseed is a difference a reshuffle could have produced.

❗ **And the chain's last DSP is closed, 2026-09-06 — by running it.** `SMS WaveHammer` turned out
to be a compressor (not a limiter), configured by a static template (not by `DSP::setParameter`),
and it does compress (an earlier reading said it collapsed to a constant). All three corrections are
in *37* in [answered-questions.md](answered-questions.md), which is worth reading for the third:
**a superset disassembly proved no store to `[reg+0xc0]`, correctly, and the field was still written
— as `[rbx+0x3c]` through an interior pointer.** `tools/runhammer.py` loads the PRX and runs it,
which is what settled it and is reusable on the other two plugins.

**Nothing about the engine's signal path is unread any more.** What is left in this file is one
measured DSP deliberately switched off (38), one listening report that needs a capture from real
hardware (23), two decisions with bounded error (section 0), one question that is not about fidelity
at all (24), and one about files this reader does not claim to support (28).

⚠️ **38 is the only place this project knowingly does something the game does not**, and it exists
because the compressor is the first instrument here that is sensitive to *absolute* level. Read it
before touching anything about gain.

Last re-ranked 2026-09-01, after mapping `fmodextinput.prx` and then working outward from it. That
run closed questions 5 and 7 outright, the whole of 8's `Params`, and the triplet half of 3; it
opened 5b; and it corrected several things steering had wrong — the state block's pointers, the
scale table's address, `Numstack`, voice `+0x28`, and the pan law. See
[lbp-modding-toolchain.md](lbp-modding-toolchain.md) for what came from whom.

---

## 0. Leftovers from answered questions

Small residues from questions now in [answered-questions.md](answered-questions.md). None blocks
anything; all are places where an answer stopped just short.

- **The unison stack and `mime_artist`.** Layers are the same sample, verified on 14 of the 15
  stacked instruments (`slots == zones`). `mime_artist` is the exception: 4 samples, 1 zone,
  `Numstack` 5, and its 3 spare slots do not equal `Numstack - 1` either.

  ⚠️ **Half of this is now settled and it is the half that mattered.** `mime_artist`'s bound
  array in the DSP record is all zeros -- `Splitnotes` is `[87,0,0,…]` and the walk reads `[1..8]`,
  see *19* in [answered-questions.md](answered-questions.md) -- so `0 <= note` on the first
  comparison and **every note resolves to slot 0**, the base-81 `pluck_a6`. The other three samples
  are unreachable as zones, which is what "1 zone, 4 samples" means.

  ✔ **CLOSED 2026-09-05: they are not reachable as layers either, and this project is right.** The
  `0x98` slot stride appears at exactly four sites in the whole module — `0x1aca`, `0x1d6a`,
  `0x2c68`, `0x3046` — and every one of them indexes by `voice+0xcc`, the **zone**, which `0x1a83`
  writes once per note from `note & 7`. `0x2bc2` loads it once into `r12` for the render loop. There
  is no per-layer slot index anywhere, so a stacked voice plays one slot `Numstack` times, and
  `mime_artist`'s other three samples are dead weight in the patch. Nothing outstanding.
- ~~**Per-note modulation across a note's own points.**~~ **SETTLED 2026-09-03: the engine ramps
  it and re-reads it every chunk.** `sub_0x3930` writes a slide rate for it at `0x3e8a` beside the
  ones for volume and pitch, and `sub_0x1c60` advances it by `slide × dt` at `0x1f4a` and reads the
  result four times. The cadence is per chunk per voice, under the DSP read callback at `sub_0x170`.
  Full chain and addresses in `answered-questions.md` 6d. **Implemented the same day, in full**:
  `VoiceSpec.morph` carries the ramp, `Voice.render` re-derives per 128-frame chunk, and the echo
  send follows it too — which turned out to be worth almost nothing, 68 notes in the corpus,
  because a placement with `echoSend == 0` mutes the instrument's send whatever the modulation
  does. Nothing outstanding.

- ~~**The `1/3` sub-step and `Swing`.**~~ ✔ **CLOSED 2026-09-05, and the implementation was
  right.** The block loop recomputes the step length from `floor(position) & 1`, which cannot change
  inside a step, so the position advances linearly at that step's own swung rate and a note fires
  when `frac(position)` passes `voice[+0x3e]/3`. A triplet inside a stretched step therefore
  stretches with it, which is exactly what `swungFrame` does. See *3* in
  [answered-questions.md](answered-questions.md).
- ~~**The voice pool did not explain the density report it was found chasing.**~~ **RETIRED
  2026-09-05.** The report was a listener's impression of one passage, never reproduced, and the
  pool itself is measured and implemented (*13* and *33*). There is nothing here to measure: what is
  left is a description of a session, and that belongs to the auto-memory rather than to steering.

- ❗ **Note onsets land on the engine's 256-frame block, and this project renders them
  sample-accurately.** Not an unknown — `0x1cd4` computes the in-block offset as
  `trunc((start - frac(p)) / N)`, which is 0 for every block longer than a frame — but a *decision*,
  like the release tail below. Reproducing it moves every onset later by 0 to 5.33 ms and rests on
  the block grid being song-aligned, which is an inference. The anchor is a capture of a fast
  unswung drum pattern: on a 256-frame grid the onset deviation is a sawtooth with a 5.33 ms range,
  and sample-accurate onsets have none. Full reading in *3* in
  [answered-questions.md](answered-questions.md).

- **The release tail, question 29's residual.** The question itself is answered — the engine holds a
  record until the envelope reaches zero, measured six ways — and the model is a *decision*:
  `RenderOptions.releaseTail` defaults **off**, because a listener rejects the tail on and accepts it
  off. What is left is not an unknown about the engine but an unrun experiment: **capture
  `C4K3 S0NG` from the game at 25.85 s and count whether the choir chord enters with five voices or
  one.** The error the decision can be wrong by is bounded — the tail newly crowds 12.7% of that
  song, and more than half of that is one to four records over 32. See *29* in
  [answered-questions.md](answered-questions.md).
  ✔ **A shadPS4 capture settles this one.** Counting voices in a chord is a question about
  *structure*, and the voice pool lives in the game's own `fmodextinput.prx`, which the emulator
  executes — so unlike question 23 this experiment does not need real hardware. See *Provenance
  rule 2* in [lbp-modding-toolchain.md](lbp-modding-toolchain.md).

## 23. ⚠️ PARKED — a flat ~1 dB deficit above 315 Hz, against an emulator

❗ **The reference was shadPS4, not a PS4, and the listener who made the capture does not consider it
reliable** (2026-09-05). That retires this as a finding until a capture from real hardware exists.

The reason it retires *this* one and not the others is in *Provenance rule 2* in
[lbp-modding-toolchain.md](lbp-modding-toolchain.md): a capture under an emulator is evidence about
**structure** — how many voices sound, whether a note is gated, the ratio between two channels —
because the DSP is the game's own code being executed. It is not evidence about **absolute level or
spectrum**, because between the plugin's output and the .wav sit the emulator's mixer, its 7.1→stereo
downmix, SDL's resampler and the host device. A per-band decibel table is the second kind, and a
**flat** deficit across five octaves with exact bass is exactly the shape an output path
manufactures.

⚠️ **Do not chase the candidates below until the reference is real hardware.** They are still the
right list if the deficit survives one; the numbers under them are not evidence today.

The numbers as they were taken, kept because they cost a session and will be the thing to compare a
real capture against:

| band | ours − game |
|---|---|
| 20-40 Hz | −0.39 dB |
| 40-80 | −0.54 |
| 80-160 | **+0.27** |
| 160-315 | **+0.07** |
| 315-630 | **−1.43** |
| 630-1250 | −0.99 |
| 1250-2500 | −0.89 |
| 2500-5000 | −0.75 |
| 5000-10000 | −0.79 |
| 10000-20000 | −1.41 |

**The bass is exact** — within 0.5 dB, and 0.07 dB at 160-315. Everything from 315 Hz up is quiet by
roughly a decibel, with the worst at either end of that range.

Candidates, none checked: the mipmap chain's crossover (a mip taken too early loses highs); the
interpolator (linear interpolation is a lowpass whose loss grows with frequency, and the engine's
own is measured, so this would have to be a bug rather than a difference); the ladder's coefficient
solve at low cutoffs; or the capture chain again. ⚠️ It is suspiciously *flat* for a filter — a
resampling or interpolation error would tilt with frequency rather than sit at −1 dB across five
octaves, which argues for something gain-like that this project applies to part of the signal.

## 24. The last 54 clips that need a verbatim record patch

⚠️ **Nothing here is audible, and nothing here is broken.** The MIDI round trip is exact — 0 records
different in 1,448,224 — *because* the exporter carries these clips' records verbatim in the
`LBP-TRK` meta's `fix`. The question is only whether the patch can be made smaller, which matters
because every clip in it is a clip whose bytes go stale the moment a DAW edits its notes. See
[midi-interchange.md](midi-interchange.md) for what `fix` is and why it exists.

**109 → 54 on 2026-09-05**, and every anchor this entry carried before that was wrong. What follows
is the state after, with the wrong turns kept because two of the three were wrong in an instructive
way.

### Where it stands, measured 2026-09-05

`LBP_MIDI_LOOSE=1` turns the patch off so the residue is visible. Bucketed by which record field
differs — which is a better taxonomy than the one this entry used to carry, and cheap: 40 lines
against `decodeRecords` on both sides.

| | clips |
|---|---|
| the reconstruction has **more** records than the file, or **fewer** | 44 |
| the same count, different notes | 10 |

**54 of 62,158 clips (0.09%).** ❗ **They are one family, not four**: a part's clips overlap — a
cell is 16 steps and a clip may hold 128 — and a note that two of them could hold went to the other
one. `5aa77945` seq 745160 cells 31 and 107 are the same story from both ends, one clip short of
its last sixteen notes and its neighbour long by them.

⚠️ **That family is already ruled out as tractable**, below: six tie-break rules were measured
against each other and the best moved the total by 6. Trying a seventh is the thing not to do.

### What closed the other 55

Three changes, and the second and third only work together:

- **A per-record bitmap for byte 3's resting bit** — 31 clips, 93 bytes of bitmap over the whole
  corpus. `restingBits` in `src/core/midi.ts`; it rides in the `clips` tuple's fourth slot. A DAW
  that edits the notes misaligns it and puts an inert bit on the wrong record, which is precisely
  why a bitmap is safe where a verbatim patch is not.
- **A moving segment now states where it ENDS as well as where it starts** (`k === steps` joins
  `k === 0` in the exporter's de-duplication exemption). The resampled values are rounded, so a ramp
  reaches its final value one or two thirds *before* the control point the author wrote; suppressing
  the last sample as a repeat left the segment's end unstated.
- **Douglas–Peucker prefers a whole step at a near tie** (`WHOLE_STEP_BAND`). Authors write on
  steps; the exporter resamples onto thirds; and a corner in a rounded staircase deviates from its
  chord by almost as much one third early as at the corner itself.

❗ **Neither of the last two is worth anything alone.** Measured: the segment end alone moves the
count by 0 — the point exists but the simplifier still prefers the neighbouring third — and the
tie-break alone by 3, because the point it would prefer is not in the file. Together they are worth
**24**. That is the shape to remember: a fix that measures as worthless may be half of one.

### What has already been ruled out — do not repeat these

- **Six clip-assignment tie-break rules** (nearest, earliest, tightest, loosest, busiest,
  same-start) were measured against each other and moved the total by 6 at best. Re-measured
  2026-09-05 on the new baseline: `busiest` gives 52 against `first-empty`'s 54, and the rule as it
  stands was chosen to stop clips being emptied. **The cell ambiguity is not worth another rule.**
- **A fourth record-order key does not exist.** Position ascending, then pitch descending, then the
  end ascending are each 100% over the corpus; among the 254 clips tied on all three, nothing beats
  98.8% (modulation ascending) and 94.9% (volume descending).
- **The flat-run markers are carrying their weight.** Turning them off took the patch from 109 clips
  to 277 on the old baseline.

### The three anchors this entry used to carry, and why each was wrong

Worth more than the fixes, because all three were plausible and all three cost a session's worth of
belief:

- ❌ **"73 clips are a ramp re-cut onto the staircase its own rounding makes, and the anchor is a
  whole-step tie-break in Douglas–Peucker."** The tie-break was the right idea and **73 was not a
  measured number** — it came from a taxonomy that bucketed by a guess rather than by diffing the
  records. Implemented alone it moved **3**. The real fix was upstream, in the exporter, and the
  diff found it in one command.
- ❌ **"31 clips mix byte 3's resting bit; measure whether it is constant across a contiguous run,
  because a level saved across the editor change would have the old notes first and the new ones
  after."** Measured: **11** of the 31 are two runs and the rest scatter over as many as **eleven**
  — `10110111111111111010101111` is a real one. There is no run structure. A bitmap does not care,
  and one bit per record is smaller than any run-length would have been anyway.
- ❌ **"Five are not diagnosed; print them before theorising."** There were never five of anything:
  the old three-way split did not survive contact with a field-by-field diff. **Print them first,
  not before theorising — the theorising is what produced the buckets.**

## 38. ❗ The compressor is measured, implemented, and switched OFF

Added 2026-09-06. `SMS WaveHammer` is read end to end, checked against the module executing
(`tools/runhammer.py`), implemented in `src/audio/compressor.ts` and pinned by
`test/compressor.test.ts` to better than 2e-5 against vectors from that run. It is nevertheless
**off by default on both the offline and the live path**, because the listener judged it wrong the
first time it was switched on.

⚠️ **This is a deliberate deviation from the measured chain**, and it is the only one in the
project. It is recorded here rather than quietly defaulted because a reader who finds
`compressor = false` in `src/core/render.ts` deserves to know it is a judgement and not an oversight.

### The diagnosis, which is that this is probably not about the compressor

Turning it on costs `level-seq723339` **6.94 dB of RMS and 6.93 dB of peak**. It only takes that
much from a signal sitting well above its knee, and ours does:

| | our render | against the knee bottom at −21 dBFS |
|---|---|---|
| RMS | −17.5 dBFS | **+3.5 dB** |
| peak | −0.6 dBFS | **+20.4 dB** |

So the compressor is engaged nearly all the time and our peaks reach the very top of its table.
If the game's own sequencer output sits *below* that knee, its WaveHammer barely touches it — and
ours squashing the mix by 7 dB is then evidence that **our absolute level into the chain is too
hot**, not that the DSP is modelled wrong. The DSP is not in doubt; the thing feeding it is.

❗ That the compressor sounds wrong is therefore a *symptom worth keeping*, not a bug to fix. It is
the first instrument this project has ever had that is sensitive to absolute level — everything
else (pan ratios, spectra, envelopes) survives a level match and so could never have caught this.

### What would settle it

The same capture question that parks *23*, and now with a second use:

1. **A capture with a known reference** — any song recorded from the game together with something
   whose level we know, so the *ratio* is provenance-legal under rule 2 in
   [lbp-modding-toolchain.md](lbp-modding-toolchain.md).
2. **Our own render at several trims through the real DSP.** `tools/runhammer.py` will take any
   audio; feeding it our render at −0, −6 and −12 dB says how much gain reduction each trim
   provokes, and the trim whose reduction is small is the one our level should be near if the
   game's mix is not being squashed. That needs no console at all and is the cheapest next step.

### The anchor

`LBP_COMPRESSOR=1 node --experimental-strip-types dev/render-level.ts` reproduces it in one
command, and `compressor: true` does it from code. The measurement of the DSP itself is settled —
see *37* in [answered-questions.md](answered-questions.md); nothing here reopens it.

## 28. What still will not open — measured over 103 archive levels

⚠️ **Re-based twice.** This listed four failures out of six PS3 saves, then 43 levels pulled by
hand through the browser. It is now **103 levels sampled from the archive's own index**, and the
sampling is a command rather than an errand: `node dev/archive-sample.mjs` reads `dry.db` — the
10,467,874-slot SQLite the archive publishes — picks an even spread of ids per game, downloads the
root levels and leaves them for `dev/walk-levels.ts`. Ids are chronological, so an even spread over
them is an even spread over the game's life, which is what puts old revisions in the sample.

### What the sweep finds, 2026-09-05

| version | branch | parses |
|---|---|---|
| `0x3b7` | `0/0` | **4 of 4** |
| `0x3b8`–`0x3f9` | `0/0` | **78 of 78** |
| `0x272` | `4c44` (LEERDAMMER) | **5 of 19**, and no failure is a missing part any more |
| `0x26e` | — | 0 of 1, the chunk table is not where this reader looks |
| — | — | 1 file the archive stores truncated |

**82 of 103**, and there is not a single failure anywhere in the range the reader claims. The wall
is at LBP1 and it is sharp.

### ✔ The bound was one revision too high, and that is now measured

`LBP3_MIN_VERSION` was `0x3b8` because that is where the **ten-level corpus** starts — not because
anything changes there. Two measurements settle it:

- **cwlib has exactly one gate at `0x3b8` in its whole tree**, `PPhysicsTweak`'s
  `version > 0x3b8 && configuration == 0xd`, and `readPhysicsTweak` has it. A `0x3b7` file therefore
  takes the older branch because the branch is there.
- **All four `0x3b7` levels in the sample parse** the moment the bound allows them.

It is `0x3b7` now. ❗ **And the reason the bound cannot simply be dropped is measured too**: at
`0x272` it is **2 of 19**, which is what "reading an older layout with newer rules and producing
plausible nonsense" looks like from the outside.

### ❌ The scope note in `serializer.ts` was wrong about its own code

It said cwlib's older branches had been stripped in the port — *"roughly nine tenths of them are
dead … implementing only that range turns `PSwitch`'s 323 lines into a few dozen"*. Counted:
`src/core/parts.ts` carries **238 distinct version gates spanning `0x137`–`0x3f0`** and **163
subVersion gates**. The branches are all there; they have simply never been run against a file old
enough to take one.

⚠️ **That changes what "widening the range" means.** It is not "add the older branches field by
field" — it is "find out which of the branches already ported are wrong". The 2-of-19 says at least
some are.

### What is left

- **LBP1, `0x272` and below** — 19 of the 103, now **5 of 19 parsing** where it was 2, and
  ❗ **not one failure left is a missing part.** Every remaining one is the stream genuinely
  diverging: negative string lengths, a read past the end. That is the honest wall, and it is where
  a byte-level trace has to start rather than a part list.

  ⚠️ **What moved it was not the part it looked like.** 13 of the 19 said `no reader for part
  EFFECTOR`, so `PEffector` was ported — nine fields, no version gates, 46 bytes. Then the span
  tracer said `EFFECTOR 1B x13`: **all 13 are a null reference**, and the reader has never run. The
  walk was refusing on the mask *bit*, before reading the id that says whether the field holds
  anything. Moving the refusal inside `s.reference` is what freed them, and it is a real bug in the
  walk rather than an LBP1 nicety — `UnimplementedPartError` now means "this file has data for a
  part nothing here can read" instead of "this file mentions one".

  ❗ **`readEffector` is therefore untested and is documented as such.** A faithful port of a
  gate-free struct is a good guess and nothing more; 103 archive levels do not contain a single
  effector with a body.
- **A quest of a type other than 5** — still never seen, now in 103 archive levels as well as the
  saves. `readQuest` refuses rather than guessing.
- **Branch `0x4431`** — one level in the saves, `f331efa7`, version 0x3e2. ⚠️ **Nothing in the
  archive is on it**: every sampled level is branch `0/0` or `4c44`. One file is not enough to
  reverse a branch from, and a 103-level sample did not supply a second.

**None of this is in the way of music**, and the sampler is now the way to find the next one: every
real reader bug since 2026-09-05 came out of a file no PS3 save on this machine contains.

### How the four fixed bugs were found — the technique, kept

`setTrace` from `thing.ts` for the part spans; then patch `Serializer.prototype` from a probe so
**every read is logged with its value** — widths align at any offset, values do not; then read the
raw bytes at the disagreement.

✔ **The step that cracked it was neither of those**: list every top-level Thing with its span and
look for the one whose *size* breaks the pattern. Nineteen Things of 575-588 bytes and then one of
**64** says exactly where to look, and it needs no byte-level reading at all. `0xaa` then a plausible
uid varint also locates the true next Thing — 11187, not 10633 — which turns "how far off are we"
into a number.

The four, with what each turned out to be:

| file | was | |
|---|---|---|
| `8b904be1` | marker at 120328 | `PStreamingHint.connected` was a **double reference** — `s.references(builder)` reads an id and then the builder reads another. Empty in every corpus file, so the loop never ran |
| `69318581`, `7c0f1a1d` | marker at 10633 / 158804 | the **part mask lost a bit above 2^53**. `Serializer.u64` returned a `number`; the highest part index is 53, so a Thing with `STREAMING_HINT` *and* a low part cannot be held exactly. ⚠️ `BigInt(s.u64())` does not fix it — the bits have to survive the accumulation, which is what `u64Big` is for |
| `5576f758` | `no reader for part WORLD` | **`WORLD` was installed on a copy of the reader map.** A level really can carry a second world Thing — this one has one inside a `CREATURE` — so only the outermost may throw `StopParse` |

❗ **A field that is empty or zero everywhere in the corpus is untested, whatever it is declared
as.** Two of those four are exactly that shape, found on the same day.
