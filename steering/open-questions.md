# Open questions — decisions, residues, and what would settle each

Read before planning a work session. Nothing here is a guess dressed up as a fact, and **nothing
here blocks the build**: the note format, the containers, the level walk, the asset chain and the
whole signal path are measured, and import and playback are built. What is left is four
*decisions* where the project knowingly departs from the measured engine, a short list of measured
residues nothing models yet, and two questions that are not about fidelity at all. When one gets
resolved, move the answer into the descriptive file it belongs to and delete the entry.

## The decisions — deliberate deviations from the measured engine

Each is a listening judgement by the project's owner that outranks a static reading, kept one
switch away so a capture can settle it. The evidence rule for captures is in
[project-brief.md](project-brief.md): a shadPS4 capture is trustworthy for *structure* — how many
voices sound, whether a note is gated — and not for absolute level or spectrum, so every experiment
below is framed as a structural one.

## 29. The release tail — `RenderOptions.releaseTail`, default **off**

The engine frees a voice record when the sound ends, not when the note does — measured six ways in
`fmodextinput.prx` (the free predicate at `0x20de`–`0x20f1` → `0x3093`, the sample-end free at
`0x3035`–`0x3069`, the score factors, the gate, a released voice skipping the score update; *29* in
[answered-questions.md](answered-questions.md)). The tracker frees it at the note's written end,
because with the tail on a listener rejects `C4K3 S0NG` at **25.85 s** — the choir starts a
five-note chord and four of the five are stolen the instant they start — and with it off accepts
the same passage.

What is measured about how wrong the decision can be, on that song's uncapped demand:

| | median | p95 | p99 | peak | over 32 |
|---|---|---|---|---|---|
| tail off | 21 | 42 | 51 | 61 | **16.0% of the song** |
| tail on | 25 | 48 | 56 | 75 | **28.7% of the song** |

The song writes more notes than the hardware can play whichever model is used — counted straight
off the records, 21% of it wants more than 32 — so the engine steals constantly and the ear does
not hear it; the tail roughly doubles the time over the cap, and in the 12.7% of the song that is
over the cap only because of it, more than half is one to four records over. A pool of 36, or a
tail 15% shorter, would erase most of the difference; neither is justified by anything measured.

⚠️ **Be ready for the answer to be uncomfortable.** With the tail the game plays at most 32 notes
at once; without it this renderer routinely runs 35 to 50. If the tail is right our render is
*denser* than the game's, which is exactly why it sounds less truncated. The version that sounds
better may be the wrong one.

**What would settle it**: capture `C4K3 S0NG` from the game around 25.85 s and listen for whether
the choir chord enters with five voices or one. Two seconds, no counting, and a shadPS4 capture is
admissible because the voice pool is the game's own plugin executing. `LBP_RELEASE_TAIL=1`.

## 38. The compressor — `compressor`, default **off**

`SMS WaveHammer` is read end to end, checked against the module executing, implemented and pinned
to better than 2e-5 against vectors from that run ([lbp-audio-engine.md](lbp-audio-engine.md)),
and off on both the offline and the live path because the listener judged it wrong the first time
it ran. It costs `level-seq723339` 6.94 dB of RMS and 6.93 dB of peak.

❌ The first diagnosis — "our RMS sits 3.5 dB above its knee, so our level into the chain is too
hot" — was generalised from one song. Over four corpus sequencers against the knee bottom at
−21 dBFS:

| sequencer | notes | RMS dBFS | vs knee | peak dBFS | vs knee |
|---|---|---|---|---|---|
| 723339 | 821 | −16.4 | **+4.6** | −0.3 | +20.7 |
| 737099 | 280 | −29.3 | −8.3 | −13.8 | +7.2 |
| 732985 | 566 | −22.6 | −1.6 | +0.4 | +21.4 |
| 730116 | 765 | −22.4 | −1.4 | −2.0 | +19.0 |

Three of the four sit at or below the knee in RMS; **every song's peaks sit 7 to 21 dB above it**,
and the detector's window is 64 samples (1.33 ms) — far too short to follow an RMS. So the
compressor is riding peaks, and the question is **crest factor**, not loudness: either the game's
own mixes are as peaky as ours and its WaveHammer takes the same 7 dB off the dense songs, or ours
are peakier — through the pool, the envelope, the onset grid or the missing release tail — and the
compressor is fed transients the game never sends it. ❌ The `FOLD_GAIN` lead is retired: the gain
now runs after the compressor, where FMOD applies it (*39*), so the compressor sees the same signal
the game's does, and the one song it had "explained" was a coincidence (the other three land 6 to
13 dB below the knee).

**What would settle it**: a capture with a known reference beside it, so the *ratio* is admissible;
and, cheaper and needing no console, our own render at −0, −6 and −12 dB fed through the real DSP
with `tools/runhammer.py`, to see how much gain reduction each trim provokes. `LBP_COMPRESSOR=1`, or
`compressor: true`.

## 42. The master bus — `optMaster` / `RenderOptions.master`, default **off**

❗ **The only DSP in this project that is not the game's.** `audio/master.ts` is a glue compressor
(2.5:1, soft knee, threshold moved by one knob from -6 to -22 dBFS) followed by a lookahead peak
limiter with a -0.3 dBFS ceiling, and it runs **after the stereo fold**, where the game's chain has
ended: past the plugin's clip, past `SMS Reverb`, past `SMS WaveHammer`. Nothing in LBP does this.
It exists because the project's owner asked for a mix that holds together, and it is off in the
live engine and in the render alike, so nothing measured against a capture of the game is affected
unless somebody switches it on.

Measured live on `Ascetic` at the default setting (glue 4): peaks 0.35/0.52 without, 0.56/0.85
with, a lift of about 4.2 dB, and the limiter holding everything under the ceiling.

⚠️ **Two traps, both of them cost a test.** The limiter's gain has to be the *smallest the
lookahead window asks for*, not the newest: taking the newest and releasing upwards lets the peak
out of the delay line at +0.19 dB over the ceiling. And the window must include the frame leaving
the delay this very sample, or the one peak it never sees is its own. Both are pinned in
`test/master.test.ts`.

⚠️ **The makeup is referenced to -6 dBFS, not to 0.** Taking back what the ratio removes at full
scale assumes the mix already peaks there; ours does not, and the makeup then adds more than the
compressor took -- +7.4 dB at the default, against +4.2 dB now.

**What would settle whether it should ever be on by default**: nothing measurable. It is a taste
question, and the answer this project gives is that the faithful path is the default and this is a
switch beside it.

## 39. The stereo narrowing — not applied

The 7.1 centre feed folds every pan to `2 − √2` of its width for a stereo listener, derived from
three read constants and confirmed to six figures ([lbp-audio-engine.md](lbp-audio-engine.md)).
The fold's **gain** (+4.645 dB) is applied after the whole chain; the **narrowing** is not, because
the listener asked for the file's own pans. It is still half of a linear operator, and that is
worth saying plainly: if a capture ever shows the image is wrong, the other half is one line at the
`pan:` field where the voice spec is built, plus the same at the stack spread. Nothing measurable is
left of this one.

## 3. Note onsets — sample-accurate, where the engine places them on its block

`0x1cc6`–`0x1cdc` computes the in-chunk onset offset as `trunc((start − frac(p)) / N)`, which is 0
for every chunk longer than a frame: **a note begins at the first frame of the 256-frame block it
falls in** ([synth-engine.md](synth-engine.md)), 5.33 ms at 48 kHz. Reproducing it would move every
onset later by 0 to 5.33 ms and rests on the block grid being song-aligned — `p` is 0 at the first
block, so it should be, but that is an inference. **What would settle it**: capture a fast unswung
drum pattern and measure inter-onset intervals against the exact step clock. On a 256-frame grid
the deviation is a sawtooth with a 5.33 ms range, which is unmistakable; sample-accurate onsets
have none.

## Residues — measured, not modelled, not audible so far

- **The reverb's block granularity.** `fmodsmsreverb.prx` works in 256-frame blocks and rounds
  every delay buffer up to 1 KB, so a tap shorter than 256 samples cannot behave as a plain
  per-sample delay there. Tap set 10's shortest is 5.019 ms = 241 samples, so preset 3
  (`ReverbSetting` 0) is the one place this could show.
- **The chunk bounds inside a block.** The engine splits a 256-frame block into chunks at the
  step clock's `frac(4 · position)` bounds and evaluates its ramps per chunk; the tracker's
  segments end on the block grid and at the voice's own events. Both are piecewise-linear ramps
  between the same curve's values, and only the knots differ, by less than a block. Reproducing
  the engine's bounds needs the sequencer clock inside the mixer, which the keyboard has none of.
- **Whether `q` should reach 3.** With the correct filter reading `musicbox` at full modulation
  has resonance 0.856 at `freq ≈ 0.019`, and the Stilson/Smith compensation grows as the cutoff
  falls, so `q ≈ 3.1`. The coefficient formula matches instruction for instruction; the saturation
  bounding the ladder has only been read as `b4 −= b4³/6`. If a resonant patch howls, look there,
  not at the four indices (*6b*).
- **Which playback rate the filter's key tracking is fed.** It is the current rate (`Northern
  Lights`'s `noise` riser swept 1.83× on the opening rate where the pitch swept 4.76×); the engine
  reads `[rbp-0xa90]`, the cached `exp2f` result, and `LBP_NO_KEYTRACK` stays because the term may
  be inert altogether on the instruments that matter.
- **The piano's loop contour.** A 5.75% flutter at F5's wrap rate was measured before the
  amplitude envelope existed ([game-assets.md](game-assets.md)); the piano's sustain is 0.070, and
  whether the flutter survives the envelope has not been re-measured. A sustained F5 captured from
  the game, run through the same modulation measurement, settles it: if the game flutters too the
  artefact is in the asset.
- **`PInstrument + 0x60`.** Copied into the engine's clip as its length in steps and not named by
  the serialiser walk ([sequencer-data-model.md](sequencer-data-model.md)); what serialises it, if
  anything, is unread — `readInstrumentPart` reads nothing for it, so it is derived at load. The
  project's owner reports from the game's editor that a placed instrument's grid is four bars and
  grows by two at a time, and the corpus's chip spacing makes the bar 8 steps (*The tile* in
  [sequencer-data-model.md](sequencer-data-model.md)), so the editor derives 32, 48 … 128 from
  the notes (`clipStepsFor` in [editor.md](editor.md)) — a rule consistent with the data, not a
  reading of the length. **What would settle it**: find the writer of `+0x60` in the eboot — the
  likeliest sources are the component's `scaleX` on the board and the highest `x` in `Notes` —
  or save a level with an empty six-bar grid and see what changes in the file.

## 40. What a new sequencer starts at — the editor's defaults are the corpus's modes

Nothing has been read out of the game about the values a freshly placed Music Sequencer or
Instrument holds. `NEW_SONG_DEFAULTS` in `packages/lbp-tracker-lib/src/song.ts` uses the corpus's
corpus medians for the echo (2.00 beats, feedback 0.45,
mix 0.5), on the reasoning that a mode that strong across 338 user sequencers is most likely the
value the editor starts at. A decision, not a measurement.

⚠️ **The tempo is no longer one of them.** The corpus's mode is 240 (ahead of 125, the *engine's*
default in `fmodextinput.prx` — the two are not the same thing), but since neither is a reading of
the editor, a new song starts at **120**: a blank song's tempo is a usability choice, 240 read as a
bug to every listener who opened one, and a loaded sequencer always carries its own tempo, so
nothing about fidelity turns on it. **What would settle it**: place a new
sequencer in the game, save, and read its `PSequencer`; the toolkit's field initialisers are the
other source, and they are a reading of the same kind as this one.

## 24. The last 54 clips that need a verbatim record patch

⚠️ **Nothing here is audible and nothing here is broken.** The MIDI round trip is exact — 0 records
different in 1,448,224 — *because* the exporter carries these clips' records verbatim in the
`LBP-TRK` meta's `fix` ([midi-interchange.md](midi-interchange.md)). The question is only whether
the patch can be made smaller, which matters because every clip in it goes stale the moment a DAW
edits its notes.

**54 of 62,158 clips (0.09%), and they are one family**: a part's clips overlap — a cell is 16 steps
and a clip may hold 128 — and a note that two of them could hold went to the other one.
`5aa77945` seq 745160 cells 31 and 107 are the same story from both ends, one clip short of its
last sixteen notes and its neighbour long by them. Bucketed by which record field differs
(`LBP_MIDI_LOOSE=1`, forty lines against `decodeRecords` on both sides): 44 clips have more or
fewer records than the file, 10 the same count with different notes.

**Ruled out — do not repeat:**

- **Six clip-assignment tie-break rules** (nearest, earliest, tightest, loosest, busiest,
  same-start) measured against each other moved the total by 6 at best; on the current baseline
  `busiest` gives 52 against `first-empty`'s 54, and the rule as it stands was chosen to stop clips
  being emptied. The cell ambiguity is not worth another rule.
- **A fourth record-order key does not exist**: among the 254 clips tied on all three, nothing
  beats 98.8%.
- **The flat-run markers are carrying their weight**: turning them off took the patch from 109
  clips to 277.
- ❌ Three anchors this entry once carried were all wrong in the same way — a taxonomy that
  bucketed by a guess rather than by diffing the records ("73 clips are a ramp re-cut", "31 clips
  mix the resting bit, look for runs", "five are not diagnosed"). **Print the diff first; the
  theorising is what produced the buckets.**

## 28. What still will not open — the archive sweep's leftovers

The reader is measured over 103 archive levels: no failure anywhere in the range it claims, and
19 of 19 LBP1 files identical to cwlib with the bound lowered by hand
([level-files.md](level-files.md)). What is left is not layout:

- **The allowed-set decision.** `LBP3_MIN_VERSION` is `0x3b7` and all nineteen LBP1 files are
  refused, deliberately: LBP1 has no Music Sequencer, so opening them buys the tracker nothing
  musical, and the range `0x272`–`0x3b7` has zero coverage — admitting it wholesale is exactly the
  plausible-nonsense failure the bound exists to prevent. The right change, if one is wanted, is an
  **allowed set** — `0x272` plus `0x3b7..0x3ff`, refusing the untested span between — and it is a
  design decision to take on purpose.
- **`0x26e`** — one level whose chunk table is not where this reader looks; a container question.
- **Branch `0x4431`** — one level in the saves, `f331efa7`, version `0x3e2`. Nothing in the archive
  sample is on it; one file is not enough to reverse a branch from.
- **A quest of a type other than 5** — never seen in 103 archive levels or the saves; `readQuest`
  refuses rather than guessing.
- **One truncated file** — the archive itself stores `0-aaaffe` short. Nothing to fix.

None of it is in the way of music, and `packages/cwlib-ts/dev/archive-sample.mjs` is how the next
one gets found: every real reader bug since 2026-09-05 came out of a file no PS3 save on this
machine contains.
