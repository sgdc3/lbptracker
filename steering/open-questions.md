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

**Nothing about the engine's signal path is unread any more.** What is left in this file is two
measured things deliberately not applied (38, 39), two decisions with bounded error (section 0),
one question that is not about fidelity at all (24), and one about files this reader does not
claim to support (28).

⚠️ **38 and 39 are the only places this project knowingly does something the game does not**, both
added 2026-09-06 on listening judgements, and they are entangled: 39 leaves `FOLD_GAIN` applied
4.645 dB upstream of where the game folds. Read both before touching anything about gain or pan
— and read 38's corrected diagnosis first, because "our level is too hot" was measured on the
corpus's busiest song and does not hold on the other three.

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
  executes — so unlike the withdrawn question 23 this experiment does not need real hardware. See *Provenance
  rule 2* in [lbp-modding-toolchain.md](lbp-modding-toolchain.md).

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

### ❌ The diagnosis this entry first carried was generalised from one song

It said: turning the compressor on costs 6.94 dB, our RMS sits 3.5 dB above its knee, therefore our
absolute level into the chain is too hot. **The first number is right and the inference is not.**
Measured 2026-09-06 over four corpus sequencers, against the knee bottom at −21 dBFS (all figures
after the pan-width removal of *39*, which raised every one of them by about 1 dB):

| sequencer | notes | RMS dBFS | vs knee | peak dBFS | vs knee |
|---|---|---|---|---|---|
| 723339 | 821 | −16.4 | **+4.6** | −0.3 | +20.7 |
| 737099 | 280 | −29.3 | −8.3 | −13.8 | +7.2 |
| 732985 | 566 | −22.6 | −1.6 | +0.4 | +21.4 |
| 730116 | 765 | −22.4 | −1.4 | −2.0 | +19.0 |

❗ **Three of the four sit at or below the knee in RMS.** 723339 is the busiest song in the corpus
and it is the one the 6.94 dB was measured on; quoting it as "our level" was the same over-reach
this project keeps catching itself in.

### What the four songs actually say

The detector's window is **64 samples, 1.33 ms** — far too short to follow an RMS and short enough
to follow near-peaks. So the row that matters is the last one, and **every song's peaks sit 7 to
21 dB above the knee**. The compressor is therefore doing what a compressor does: riding peaks,
with a long-term cost that follows each song's crest factor rather than its loudness.

That leaves the real question narrower and harder than "are we too loud":

- If the game's own mixes have the same crest factor as ours, its WaveHammer takes the same 7 dB
  off the dense ones, and our chain is simply missing that.
- If ours are peakier — through the voice pool, the envelope, the onset grid, or the missing
  release tail — the compressor is being fed transients the game never sends it.

⚠️ **Neither can be told apart from a level match**, which is why the level-matched capture behind the
withdrawn *23* is useless here, and why the crest factor is the thing to ask a new capture for.

### The `FOLD_GAIN` lead, and what it is worth

*39* leaves `FOLD_GAIN` (+4.645 dB) applied to each voice, where the game folds after the whole DSP
chain — so it reaches our compressor 4.645 dB before the game's would. On 723339 removing it would
land the RMS within 0.01 dB of the knee, which looked decisive for about a minute; on the other
three it lands them 6 to 13 dB **below** it. ❗ **One song agreeing to two decimal places is a
coincidence, and this file has been wrong before by treating one as a measurement.**

### What would settle it

A capture, and this is now the only thing in this file that wants one it cannot get:

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

## 39. ❗ The stereo fold is measured, and half of it is deliberately not applied

Added 2026-09-06, the same day as *38* and for the same kind of reason: the listener asked for the
file's own pans, so the pan-width knob and the narrowing behind it were removed from all three front
ends and from `src/core/render.ts`.

### What is measured and what we now do

The fold is a **single linear operator**, read rather than fitted (see *22* in
[answered-questions.md](answered-questions.md)): the game renders 7.1, its centre carries
`k = 0.5` of the front pair, and BS.775 folds that back at `d = 1/√2`. That one operator both

- narrows the image by `PAN_WIDTH = 1/(1 + 2kd) = 2 − √2`, and
- raises the sum by `FOLD_GAIN = 1 + 2kd = 1/PAN_WIDTH`, worth **+4.645 dB**.

❌ **We now apply the gain and not the narrowing.** That is the *same shape of error this project
already made once, in the other direction* — applying the narrowing without the gain, which cost a
flat −4.645 dB and took a listener on the live page to catch. It is deliberate this time: the
result is a hybrid, the game's downmixed **level** with the game's internal **image**.

Removing the narrowing widened `level-seq723339` and raised it by **1.09 dB** (RMS 0.134 → 0.152,
peak 0.934 → 0.966). That rise is the linear pan law, not a bug: a centred voice carries
`2 × 0.5² = 0.5` of a hard-panned one's power, so any widening is louder.

### ❗ Why this is not just a taste decision

The fold happens in **FMOD's speaker matrix, after the whole DSP chain** — after the reverb and
after `SMS WaveHammer`. `FOLD_GAIN` in `src/core/render.ts` is folded into each *voice*, so in our
chain it arrives 4.645 dB too early, before the compressor rather than after it.

That is the largest single lead on *38*. Our render sits 3.5 dB above the compressor's knee in RMS;
4.645 dB of gain that the game applies downstream of its compressor would more than account for it.
⚠️ **Do not "fix" this by moving `FOLD_GAIN` after the compressor without measuring** — with the
narrowing gone the operator is already half-applied, and moving the surviving half is a second
change on top of a first. The order to settle them in is: what our level *should* be (38), then
where the fold belongs, then whether the image narrows.

### The anchor

`PAN_WIDTH` and `FOLD_GAIN` in `src/core/render.ts` still carry the derivation and the numbers;
nothing about the measurement is in doubt and *22* is not reopened. `tools/panmeasure.py` is what
would check a new capture. Restoring the narrowing is one line at the `pan:` field where the voice
spec is built, plus the same at the stack spread.

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
| `0x272` | `4c44` (LEERDAMMER) | **0 of 19** at the shipped bound; **14 of 19 identical to cwlib** with it lowered by hand |
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

### ❗ Worked 2026-09-06. The wall moved four times; no LBP1 file reads correctly yet

**Nothing shipped changes.** `LBP3_MIN_VERSION` is still `0x3b7`, all 21 LBP1 files are still
refused at the bound, and the golden fixture is unmoved at 62,158 placements byte for byte.
Everything below was measured by lowering the bound to `0x100` by hand.

✔ **First: cwlib reads every one of these files.** 557, 524, 1054, 1475 Things. So they are not
damaged and the reader is simply wrong — which is worth knowing before spending a session on a hex
dump, and was not known before.

Four bugs found and fixed, all by reading cwlib rather than bytes:

| | what it was |
|---|---|
| `fillThing` | read the UID before the parent for every file. cwlib `Thing.java:96`: below **0x27f** the parent comes first. A comment directly above the line already said so. |
| `fillThing` | the `0xAA` test marker is gated at `version >= 0x2a1` — and also on **LEERDAMMER from its own revision 5**. Every LBP1 file here is that branch at 0x17, so the marker was being taken as the first byte of the parent reference. |
| `fillThing` | the parts mask is likewise present on **LEERDAMMER from revision 2** (cwlib's `isCompressed`). Without it the mask was `-1`: every declared part treated as present. |
| `readPos` | below **0x341** the local matrix is stored as well as the world one. The comment said *"localPosition is regenerated above 0x341"* above a line that read one matrix always — so every pre-0x341 Thing was 64 bytes short. |

And `readShape` was rewritten against cwlib's `PShape`: below LBP3 the colour is four floats rather
than a packed ARGB, `brightness` does not exist below 0x301, `behavior`/`colorOff`/`brightnessOff`
below 0x303, `interactPlayMode`/`interactEditMode` exist at or below 0x306, `lethalType` is an
enum32 at or below 0x345, and below 0x2b5 three bools stand in for the flags word. **Five gates that
were simply absent.**

⚠️ **The result is progress, not success.** Two files now return Things instead of an error — and
cwlib says those two hold 26 and 39 Things where this reader returns **4**. So the honest count is
still **0 of 21 read correctly**. What changed is the *kind* of failure: the marker now catches
misalignment one Thing later instead of the stream running off the end, so every remaining failure
names a byte offset inside a part reader.

### ✔ The tool that makes the rest mechanical, and the span diff it gives

`tools/CwlibTrace.java`. cwlib's serialiser already logs every part boundary with its offset;
`ResourceSystem.LOG_LEVEL` turns it on. `CwlibTrace spans <level>` prints the reference reading and
`setTrace` in `src/core/thing.ts` prints ours, so a divergence is a diff rather than a hunt — and
the diff names the part, which names the file to open in cwlib.

That loop closed five more readers on `0-c33a7e`'s second Thing in one pass:

| part | before | cwlib | after |
|---|---|---|---|
| `BODY` | 63..82 | 63..82 | agreed already |
| `POS` | 82..121 | 82..121 | agreed already |
| `SHAPE` | 121..**248** | 121..233 | **121..233** |
| `REF` | 248..249 | 233..242 | **233..242** |
| `GROUP` | 249..250 | 242..288 | **242..288** |

❗ **`SHAPE`'s fifteen bytes were not in `PShape` at all.** They were in `Polygon`: `requiresZ`
arrives at **0x341**, and below it cwlib returns early with no flag byte and every vertex a `v3`.
This reader read the flag anyway — one byte — and then picked the vertex width from whatever that
byte happened to be, which is where the other fourteen went. **A field that does not exist yet costs
more than its own width when something downstream branches on it.**

`REF` was two bools that went away at 0x321 (`childrenSelectable`, `stripChildren`). `GROUP` was
three more: below 0x341 there is no flags byte and `COPYRIGHT`, `EDITABLE` and `PICKUP_ALL_MEMBERS`
are separate bools at three separate gates. And `PMetadata` was written from scratch — it had no
reader at all, because nothing above `LBP3_MIN_VERSION` ever reaches one.

### Where it stands: **14 of 19 LBP1 levels read identically to cwlib**

Thing for Thing, on the archive sample, with `LBP3_MIN_VERSION` lowered by hand:

```
0-011f09  521    0-9320a8 1472    0-cad1b2   36    1-248258 2359
0-4e5a15   86    0-935f66   55    0-d8ce66 1856    1-3a66ec 1684
0-8a38f8  507    0-beda44   87    0-ea18ed   23    1-68e357  510
1-139f11  156                                      1-dc0925  278
```

⚠️ **Compare the NON-NULL count.** cwlib's `things` list holds null entries and `readWorld`
filters them, so `CwlibTrace parts` prints both — `825 things (278 non-null)`. Comparing against the
total is what produced a bogus "0 of 21" in an earlier pass of this entry.

Ten readers are now fixed. Every one of them diverged the same way and none needed a hex dump:

| reader | what was wrong at 0x272 |
|---|---|
| `fillThing` | UID before parent below **0x27f**; the `0xAA` marker also gated on LEERDAMMER rev 5; the parts mask also on LEERDAMMER rev 2 |
| `readPos` | the local matrix is stored too below **0x341** — 64 bytes |
| `Polygon` | `requiresZ` arrives at **0x341**; below it there is no flag and every vertex is a v3 |
| `readShape` | five gates: colour as v4 below 0x389, no `brightness` below 0x301, no `behavior`/`colorOff` below 0x303, `interactPlayMode`/`EditMode` at or below 0x306, `lethalType` an enum32 at or below 0x345, three bools for the flags word below 0x2b5 |
| `readRef` | `childrenSelectable` and `stripChildren`, both gone at **0x321** |
| `readGroup` | no flags byte below **0x341**; `COPYRIGHT`, `EDITABLE`, `PICKUP_ALL_MEMBERS` are separate bools |
| `readMetadata` | did not exist |
| `readRenderMesh` | `editorColor` as v4 at or below **0x31a** — 15 bytes |
| `readTrigger` | `zOffset` arrives at **0x322** and was read always — 4 bytes |
| `readJoint` | `modDriven`, `interactPlayMode`/`EditMode`, `modScaleActive`; `tweakTarget*` are **ints** at or below 0x280; `behaviour` only from 0x2c4 |
| `readSwitch` | `oldActivation` below 0x2a0, and the whole **connector block** (`> 0x1fa && < 0x327`) — about fifty bytes that nothing above LBP3's bound has |

❗ **The last one is the one to remember**: `connectorPos` is a `vectorarray`, and cwlib's
`vectorarray` returns `Vector4f[]`. Reading it as v3 was the final thirteen bytes. **A helper's name
does not say its element width — open it.**

### What is still failing

- `0-3edc39`, `0-99167e`, `0-a0e15f`, `0-c33a7e` — the marker, at bytes 15,649 to 250,677. Same
  shape as the ten already fixed; run the loop again.
- `1-c8b731` — `PMetadata`'s **translation-tag** branch, four strings rather than four LAMS keys,
  which cwlib takes below LEERDAMMER revision 8. Every other file in the sample is at 0x17 and takes
  the key branch, so nothing here can check the tag branch and `readMetadata` refuses.

### ⚠️ The bound has NOT been lowered, and that is a decision, not an oversight

`LBP3_MIN_VERSION` is still `0x3b7` and every LBP1 file is still refused. Two reasons:

- **LBP1 has no Music Sequencer**, so opening these levels buys the tracker nothing musical. This
  work is reader correctness, not a feature.
- Five files still fail, and the bound is what keeps "we do not support this" from becoming "we
  read it and produced something".

Lowering it is a one-line change whenever the remaining five are done and somebody wants it.

### The loop, which is now the whole method

1. `node --experimental-strip-types dev/trace-level.ts <prefix>` for our spans.
2. `CwlibTrace spans <level>` for the reference's.
3. Diff. The first part that disagrees names the file in cwlib's `structs/things/parts/`.

❗ **Nine of the eleven divergences were a version gate that exists in the reader's own comment and
not in its code.** These parts were ported with their gates documented and then written for the LBP3
branch only, so a grep for "at or below", "above 0x" and "regenerated" in `src/core/parts.ts` is a
work list for the rest.

### What is left after that

- **The zero thing count**, above. This is the next thing to do and it is a header field, not a part.
- **A quest of a type other than 5** — still never seen in 103 archive levels or the saves.
  `readQuest` refuses rather than guessing.
- **Branch `0x4431`** — one level in the saves, `f331efa7`, version 0x3e2. ⚠️ Nothing in the archive
  is on it: every sampled level is branch `0/0` or `4c44`. One file is not enough to reverse a
  branch from, and a 103-level sample did not supply a second.
- **`0x26e` and one truncated file** — one level whose chunk table is not where this reader looks,
  and one the archive itself stores short. Neither is an LBP1 layout question.

**None of this is in the way of music**, and the archive sampler is still how the next one gets
found: every real reader bug since 2026-09-05 came out of a file no PS3 save on this machine
contains.

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
