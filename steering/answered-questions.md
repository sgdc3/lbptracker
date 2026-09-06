# Answered questions — where each answer lives, and the wrong turns on the way

Questions that are **settled and implemented**. The measurement behind each now lives in the
descriptive file named at the top of its entry; what stays here is the answer in a line, the
evidence that is not restated elsewhere, and **the wrong turns** — which are the useful part.
Several of these were got wrong once, twice in one case, and every wrong reading below was arrived
at by a plausible-looking argument that could be arrived at again.

Numbers are the question's historical label; code and other files refer to them (*37*, *39*, …).
Entries are grouped by topic, not by number.

The recurring lessons, each with the entry that taught it: a fix that removes a symptom is not
evidence (*6b*, *10*); a negative result from a pattern scan is only as strong as the pattern
(*11*, *21*); a disassembly that contradicts a million-note corpus is a misread disassembly (*19*,
*12*); an absolute-offset search is only sound if every access uses the same base (*37*); "not
found" is not "not there" (*37*); a claim added to a steering file must be checked against what
the file already says (*12*); when a note quotes an address range, disassemble past its end
(*12*); a dump you produce to support a conclusion is a dump you are not reading (*the PS3
backup*); a partial fix that improves the number is the most misleading result there is (*34*); a
render that normalises cannot see a gain error (*22*).

---

# The synthesiser

## 5. `finetune` units — semitones

**Answer**: `0x1c60` adds the slot's f32 into the same sum as the note and the root note before the
one division by 12 — [synth-engine.md](synth-engine.md). `FINETUNE_PER_SEMITONE = 1`; it was 100
(cents) on a coin flip. The corpus's 23 distinct non-zero values (−0.17 … +0.56) read as an ordinary
fine-tune range in semitones and as five-thousandths of a semitone in cents.

## 7. The sampler and the pan law — linear, over octave mipmaps

**Answer**: the sequencer's sampler is `0x3780` in `fmodextinput.prx` — two taps on int16 scaled
by `1/32768`, the source switched to a ÷2 or ÷4 copy at ratio 2.0 and 4.0 — and its pan law is
`left = 1 − p`, `right = p`. Not `fmod_dsp_resampler.cpp`, not equal-power —
[synth-engine.md](synth-engine.md).

❌ **`sinc8` was the default for four sessions on the reasoning that it "added least of its own
character while the question was open".** The reasoning was right and its conclusion wrong: "adds
least character" is a tiebreaker, not evidence, and it survived because nobody went and read the
sampler. Clean was never the goal. The SNR table that promoted the question (linear 19.0 dB at
4 kHz against `sinc8`'s 72.0, at rate 0.5) is now a statement of how much the mipmapping has to do.
❌ `panGains` had assumed equal-power since early on; five tests depended on the old `sqrt(1/2)`
centre factor, which is a fair measure of how much a pan law touches.

## 5b. The ÷2 and ÷4 copies — an int16 pair average

**Answer**: `0x12e0` averages adjacent frames of the same channel in int16, rounding toward zero —
[synth-engine.md](synth-engine.md). Found by aligning a disassembly on a known instruction and
stepping the start offset until it decoded, because the function has no frame pointer and prologue
scans walked past it.

❌ This entry once said `[rdi + 0x78]` was "a running maximum of sample lengths, not one sample's
length". Both halves were wrong (*12b*), and the wrong reading corrected question 12 *away* from "a
per-slot length", which is what it is.

## 12b. `[slot + 0x78]` — the playable length, with the loop beside it

**Answer**: `+0x78` the playable length in frames, `+0x7c` the loop start, `+0x80` the loop length;
the mip builder only clamps `+0x78` down to what decoded (`jle` skips the store otherwise) and
nothing in the PRX initialises it — the records arrive filled from the eboot —
[synth-engine.md](synth-engine.md). `0x3780` wraps the position with them and `0x3035` stops a
loopless voice past `+0x78`, which is "a loopless sample plays to the end of the sample" written in
the engine.

⚠️ Four searches went looking for who writes `+0x78` in the eboot — no `imul …, 0x98`, no per-field
stores, no `setParameterData` — before the discovery that the eboot owns all 6,992 bytes and hands
them over by pointer. All correct, all irrelevant: the field was never the problem (*12*).

## 11. `Splitnotes` — the zone count and the strict bound

**Answer**: the zone count is the number of leading non-zero bounds, and the comparison is strict
(`bound > note` continues), so a note on a bound takes the zone above it —
[sequencer-data-model.md](sequencer-data-model.md), [synth-engine.md](synth-engine.md). 215,449 of
968,829 corpus notes on multi-slot instruments sit exactly on a bound, across 47 of 68 instruments.

❌ **"The synth PRX never reads `Splitnotes`."** The first scan looked only for `[reg + disp]`; the
walk uses `[rdx + rax*4 + 0x4c4]`, indexed addressing, so it was invisible. **A negative result
from a pattern scan is only as strong as the pattern.** Before the walk was found, two
engine-independent checks were run — unreachable zones with the count fixed (1 either way, the
ukulele) and corpus tracks reaching more distinct samples (5,657 for `<` against 3,900 for `<=`) —
and neither was decisive; `<` stayed because it was what was already there, with a base-in-zone
justification that this same file warns against. It was right by luck.

## 19. The key-zone walk — `+0x4c4` is `Splitnotes[1]`

**Answer**: the engine's walk indexes from `Splitnotes[1]`, `resolveSlot` already did, and
`test/instrument.test.ts` runs the two against each other over 68 × 128 notes —
[synth-engine.md](synth-engine.md).

❌ **The literal-from-`[0]` reading was implemented, measured and reverted inside an hour.** It was
posed as "the engine's walk contradicts the corpus": over 953,221 notes the median of (note played
− base note of its slot) moved from 0 to 7, `woodpecker` to +35, `marimba` to +20, and
`e_guitar_distorted` (bounds `[87,60,1,0,…]`, samples D5 base 62 and E4 base 52) sent note 65 to the
*lower* sample. **A disassembly that contradicts a million-note corpus is a misread disassembly.**
`instrument.ts`'s own comment — `MAX_SPLITS = 9; // 8 zones; [0] is a constant, [1..8] are the
bounds` — had said so all along.

## 18. `Notes.y`, `Key` and `Splitnotes` — one numbering, and `Key` really transposes

**Answer**: `y`, `basenote` and `Splitnotes` share one numbering (`pitch-probe.ts`: 188 of 249
zones contain their own base note against 48 with the toolkit's 20-semitone shift; the corpus
median of note − base is 0 with per-instrument medians scattering −18 … +28). `Key` transposes by
`key mod 12`, C at 12, 0 the untouched default, applied *after* the scale snap —
[synth-engine.md](synth-engine.md).

**What it cost while unread**: 2,461 of 129,696 placements (1.90%) and 75,073 of 3,199,788 notes
(2.35%) played in the wrong key, up to 11 semitones out, most commonly +3. ⚠️ `blockRoot` sat in
steering for a session as a named unknown: the quantiser takes exactly `edi` = note and `esi` =
scale, so **no key reaches it**, and the answer was two instructions away in the *other* binary
(`v0x160806`). When a formula has a term supplied from outside the module you are reading, the
module cannot tell you what that term means. ⚠️ `0x250` in older notes is inside the quantiser,
which starts at `0x240` — wrong by 0x10, not the usual 0x40.

## 20. The `x`/`y` interpolation — `x + f·(y − x)`, on all 27

**Answer**: every one of the 60 reads into the `Params` array is followed by `y − x` —
[synth-engine.md](synth-engine.md). It had been measured on the sends alone (`0x3b64`) and
*assumed* for the other twenty-six, and getting it backwards inverts every range in the game at
once on the 19% of corpus notes that carry a non-zero modulation.

⚠️ The four filter parameters are why a naive scan reports 23 of 27 (batched into `xmm8`…`xmm14`
and combined much later). Two things came free: the cutoff is squared *after* interpolation
(`0x29ff`), corroborating `filterAtInto`; and the filter block evaluates every parameter twice at
two different `f`s (`0x2a54` with `xmm15`) — a *Residue* in [open-questions.md](open-questions.md).

## 6b. The filter's four controls — settled, and got wrong twice on the way

**Answer**: `Params[3..6]` = cutoff, resonance, key tracking, envelope amount; the resonance takes
the envelope factor, not the pitch; the clamps and the 0.99 bypass are the engine's —
[synth-engine.md](synth-engine.md).

❌ **Two wrong turns, and the second was a consequence of the first.** "The resonance follows the
key tracking" was asserted from `0x2a90` alone, on the assumption that `xmm4` was the keytrack (it
is the envFactor). Then "`Params[5]` and `[6]` are swapped": with the resonance wrongly taking the
pitch, `musicbox.rinst` (key tracking 1) self-oscillated on high notes, and swapping the indices
made the symptom go away — by moving the error, not removing it, silently trading every
instrument's filter-envelope depth for its key tracking, which a listener heard immediately as
broken envelopes. **A fix that removes a symptom is not evidence.** What settled it: the two terms
have the same `1 + (X − 1)·p` shape, so only the identity of `X` distinguishes them — `[rbp-0xa90]`
is set to 1.0 at `0x1e25` and multiplied at `0x1e4a` by a frequency over the slot's base frequency
(the pitch ratio); `[rbp-0xb70]` receives the envelope evaluator's result at `0x222d` (envelope B).
Two short traces, cheaper than either wrong turn.

## 6c. The unison stack — measured, documented, and not wired up for a session

**Answer**: `Numstack` layers per note with per-layer detune, pan spread and start offset, gain
`sqrt(1/Numstack)`, LFO phases fanned by `spread · 2π/Numstack · layer` —
[synth-engine.md](synth-engine.md).

⚠️ `STACK_PARAMS` carried all three fields with their formulas and `OUTPUT_PARAMS.level`
documented the `sqrt(1/Numstack)` beside it, and **nothing read any of them**: the renderer played
one voice per note regardless. `ghost` — `Numstack` 3, LFO 3 spread 1.0 with depth 0.27, an
auto-pan fanned a third of a cycle apart — cannot be produced by one layer at all. Wiring it up
moved the rendered mix's peak from 1.749 to 1.491, the `sqrt(1/N)` correction arriving.

## 6d. Per-note modulation — ramped by the engine, re-read every block

**Answer**: the note word's bits 24..27 (`× 1/15`) pick a point inside every `Params` range; the
engine sets a slide rate for it beside the ones for volume and pitch and re-derives every
parameter once per block — [synth-engine.md](synth-engine.md). `VoiceSpec.morph` carries the ramp
and `Voice.render` re-derives per chunk from the *interpolated modulation*.

❌ **This entry said the opposite for two days, and the reason it gave was a reason and not a
measurement**: "modulation is not interpolated, because it feeds things read once when the voice
starts". The renderer had also been passing a hard-coded `0` for a day after the field was
correctly named, so every note used every parameter's `x` endpoint. ⚠️ **The send's weight was
measured wrong**: `Params[25]` swings up to 0.210 across the affected notes, and that number was
quoted — but the *effective* echo send swings at most 0.045, on 68 notes in 5 sequencers, because a
placement with `echoSend == 0` mutes the instrument's send before the modulation gets a say. The
whole audible weight of the modulation is in the filter, the level, the LFOs and the drive.
Verified from both ends: 25 s of `Indestructible` (no moving note) renders to the same md5 with and
without the change; 25 s of `Ascetic` (519 moving notes) differs on 30.3% of frames with the
difference only 22 dB below the signal.

## 12. `Params[2]` — the engine throws layer 0's random start away

**Answer**: the stack loop computes a random start for every layer and `0x1bda`, the instruction
after the loop, clears layer 0's; `Params[0]` and `[1]` are *not* cleared —
[synth-engine.md](synth-engine.md). A listener's repair by ear — confining all three
randomisations to layers 1+, worth 11.6 dB of drum kit — was half the engine's behaviour and half
wrong: it silently dropped a per-note detune from 19 unstacked instruments and a per-note pan
scatter from 4.

❗❗ **The answer was already written down, on 2026-09-01, and nobody joined it up.** The stack-loop
pseudocode in steering carried `voice.position[0] = 0 ; layer 0 always starts at the beginning`
from the day the loop was first read, and two lines below it a summary table said `Params[2]`
starts *each layer* at a random point. The file contradicted itself in one screen; the question was
opened beside it, re-attacked three times over four days, and repaired by ear while the
measurement sat there. **A prose table restating a transcript is exactly where the two drift
apart, and the drift is invisible because both halves look measured.** Before adding a summary row
next to a transcript, read the transcript.

⚠️ **Every re-read stopped at the `jl`.** The range steering named was `0x1a70`–`0x1bd5`, and
`0x1bd5` is the byte after the loop's backward jump — three sessions disassembled exactly up to the
answer and no further. ⚠️ "1.000 is a default nobody changed" was killed by the corpus (10
instruments at exactly `1.000/1.000` against 41 at `0.000/0.000`) and taken as evidence the field
must *do* something; it does, just not on those ten. A parameter can be deliberately set and still
be inert. And `RAND_MAX` was settled by reading the game's own `libc.prx` rather than reasoning
about FreeBSD, which would have got it wrong.

## 8. The remaining `Params` — LFO 3 pans, read end to end

**Answer**: LFO 3's folded value is written to one of two `{value, increment}` stack arrays
(`rbp-0x170`) and the per-sample loop spends it as the pan; LFO 2's goes to the other (`rbp-0xd0`)
and is spent as a gain — [synth-engine.md](synth-engine.md). Three layers of pan compose and
`lfo.ts` + `mixer.ts` already did exactly that.

⚠️ **Telling the two buffers apart is the whole trick**: reading either store without following
its pointer to the sample loop names the wrong destination. The oscillator at stub `0x130` is
`_FSin`, named from the import table by `tools/prxnid.py` rather than inferred; which of `edi = 0`
and `1` is the sine was not pinned and measurably does not matter — all six calls pass 0 and the
phases are randomised, so sine versus cosine is a constant offset on an already-random phase.

## 21. `Params[26]` — a soft-clip drive on the sampler's output

**Answer**: `f(x) = (1 + k)·x / (1 + k·|x|)` with `k = 2d/(1 − d)`, per layer, on the sample read,
before the gain and the pan — [synth-engine.md](synth-engine.md).

❌ **It was hiding behind a "settled" statement that was wrong twice over.** The reverb entry
recorded `voice+0x20` as "the instrument's own reverb send … and then nothing reads it — a grep of
the whole PRX finds the store and no read." `+0x5b8` is `Params[26]`, not the send (`Params[25]` is
at `+0x5b0`), and it **is** read — by a **`vbroadcastss`**, which is how a grep for `vmovss` missed
it. ⚠️ And the pairing that hid it: `e_guitar_power` and `e_guitar_distorted` carry the lowest
output levels in the game (0.088, 0.161), which is what you would expect if the drive adds level
that has to be taken back out. Implementing the level without the drive made them quiet *and*
clean — two errors partly cancelling, so nothing sounded obviously broken.

## 27. The LFO cadence — once per layer per block, not per sample

**Answer**: the six `call 0x130` sit in the per-layer loop, the phases advance once after it, and
the layer's rate is written as a double the sample loop reads as a constant —
[synth-engine.md](synth-engine.md). `stepLfos`.

**What it was worth** on `C4K3 S0NG` (244 tracks, 13,091 notes, 3,634 stolen at the time): the
live path's 30 busiest seconds 4,183 → 3,235 ms, the whole song offline 35.8 → 20.2 s, audio-thread
load 16–36% → 11–26%. Half of that was 1.19 `Math.sin` calls per voice-frame; the other half was
**a delay bug it uncovered**: a chunked voice counted its start delay one chunk at a time, so a
voice starting three minutes into an offline render did 78,000 empty iterations before its first
sample (the full-song render went from 35.8 s to 63.2 s the moment LFO voices started chunking,
which is how it was found). ⚠️ The chunk grid has to stay the block's, not the voice's:
`delay + 128k` boundaries make an offline and a live render disagree, and `audio.test.ts`'s
"same audio whatever the block size" caught it within a minute.

**Four things measured that were not worth doing**: per-quantum overhead does not exist (128 and
4,096 frames cost the same to the millisecond); hoisting `this.*` into locals made it 3% *slower*;
micro-fixing `readMipped` changed nothing despite the profiler attributing 13% to it — a sampling
profiler's per-function attribution inside a hot inlined loop is a hint, not a measurement;
extending the fixed-filter path to `keyTrack === 0` would reach 7% of voice-frames against 3%.
The engine's cost, for the next time: 50.3 M voice-frames per 30 s at 80 ns each, and nothing is
idling.

## 3 / 3b. Grid resolution, swing, triplets and the block clock

**Answer**: `gridX = floor(2x/105 − 0.5)`, 16 steps per cell (measured twice), `720000/tempo`
frames per step (four to the beat), swing `±swing/2` on alternate steps, positions in thirds, the
engine's block a fixed 256 frames, and note onsets on that block —
[synth-engine.md](synth-engine.md), [sequencer-data-model.md](sequencer-data-model.md).

⚠️ **`MORPH_FRAMES` was 128 — the AudioWorklet's render quantum, not the engine's block.** Moving it
to 256 was worth −50.6 dB of difference over 30 s of `Zero` at an unchanged RMS, and forced the grid
from "the offset within this call" to a mixer-wide frame clock, because 256 no longer divides a
live render's call. Advancing the oscillators per call stepped them twice as often as an offline
render and broke the equality outright — the first thing to fail. ⚠️ **The `frac(4·position)`
bound is not a musical boundary and reading it as one wastes an hour.** ✔ The `1/3` sub-step and
the swing interact exactly as `swungFrame` assumed: `floor(position)` cannot change inside a step,
so a triplet inside a stretched step stretches with it. The onset-on-block reading is the one
consequence not reproduced — *3* in [open-questions.md](open-questions.md).

## 30. `durationSteps` — verified against the engine's gate

**Answer**: the gate closes at `lastStep + 1 + endSubStep/3`, exactly `endPosition − startPosition
+ 1` with sub-steps as thirds — [synth-engine.md](synth-engine.md). And `subStep = bit7 << bit30`
is confirmed from the playback side (`0x3aa5`–`0x3ab0`), not just the editor's write path.

❌ **The other candidate must not be implemented as it stands.** The engine skips allocating a
record when a volume is not positive (`0x04d4`); read as "the note's opening volume" that would
delete `C4K3 S0NG`'s 701 fade-in notes — real music this project already rendered as silence
once. It tests `channelVolume × clip Level` (*31*), and never fires on real data.

## 31. The note word's bits 28..29 — the game throws them away

**Answer**: the eboot's clip filler clears them (`0xcfffffff`), so the plugin's `clip + 0x420 +
20·sel` always reads row 0, which is `PInstrument`'s `Level`, `Pan`, `EchoSend` and `ReverbSend`
field for field — [sequencer-data-model.md](sequencer-data-model.md). The corpus sets those bits
on 52% of records in sticky runs across 94% of clips, which looked like four instruments per clip
and a hole in the one-instrument `Track`. It is editor state, the same shape as bit 30's resting
value: **two of the note word's fields are written by the editor and ignored by the engine, and
both were nearly read as meaningful.**

⚠️ The function also has an inverting branch (`(95 − y) & 0x7f`) for a caller-supplied note array.
Its single caller passes `rdx = 0`, so the file's `y` reaches the plugin unchanged; a reading that
took the inverting loop for *the* note copy would have called the stored field a y-coordinate the
engine flips, and pitch-probe's median-0 corpus says it is not.

## 32. The release ramp — identical to ours

**Answer**: `level −= dt / release²`, linear, clamped at zero, with the level mirrored around 1 —
`Envelope.advance` with `evaluateAdsr` squaring and `ENVELOPE_SECONDS_PER_UNIT = 4` absorbing the
engine's `dt` unit — [synth-engine.md](synth-engine.md). So the moment a voice falls silent is the
same in both, and there is no shorter tail hiding in the envelope.

⚠️ The first measurement of that tail got one thing wrong: the time to zero is `release × (the
level the envelope had reached)`, not `release`. Recomputed with the level at gate close, the tail
takes `C4K3 S0NG`'s stealing to 22.3%, not the 29.5% first reported — the size of the gap, not its
existence.

## 13. The voice pool — 32 voices, steal the quietest

**Answer**: `0x1600`–`0x1692`: the first free record wins immediately, else the lowest
`[+0x04] × [+0x0c]`, with the running best starting at **1.0** and the best index at **0** —
[synth-engine.md](synth-engine.md). `polyphony.ts` reproduces the 1.0 rather than tidying it, and a
test pins it.

⚠️ **It fixed nothing audible, and that is the point of recording it.** The cap went in while
chasing "the aggressive synth with long notes is too loud at 1:30": on that window it cuts 248 of
1,684 notes and moves overall RMS 0.1324 → 0.1304, and **a listener compared the two renders and
heard no difference**. The cap stays because it is the engine's, not because it solved anything;
the report itself was a listener's impression of one passage, never reproduced, and was retired.

⚠️ **A near-miss that nearly cost a whole file.** Writing this entry truncated `open-questions.md`
to zero bytes, and the truncation was committed: `io.open(path, 'w')` empties the file before
anything is written, and a `UnicodeEncodeError` part-way through the string — an unpaired
surrogate — left nothing behind. Recovered with `git show <commit>^:steering/open-questions.md`.
**Write to a temporary file and move it into place, or write the text with the Write tool.**

## 17 / 17b. What a voice occupies in the pool — the sound, and one record per note

**Answer**: a one-shot holds its record for `sampleFrames / playbackRate` output frames, not for
its written note; a stolen voice has to actually stop (`VoiceSpec.cutFrame` is the allocator's,
separate from the gate's `endFrame`); and **a stacked note takes ONE record however many layers it
plays** — the per-layer loop is inside the per-record renderer — [synth-engine.md](synth-engine.md).

The accounting bug, measured on `Ascetic` (1,150 tracks, 14,499 notes): 352 notes in the first 24
seconds meant **1,760 simultaneous voices** in a 32-voice pool with the allocator reporting nothing
stolen, because `mime_artist` — five layers, loopless, 68 semitones below its base note — was
declared as "two steps" and was really five voices for 9.5 seconds. Render cost per second of
audio went 0.155, 0.408, 0.620 before (rising with the square of the length, "estremamente lento")
and 0.080, 0.123, 0.124 after. **When a cap exists to reproduce the engine's behaviour, check that
it is being told the truth before concluding the engine is generous**: "0 of 934 notes cut short"
on a passage with 1,760 sounding voices was an accusation against the accounting.

❌ **"`Numstack` layers are `Numstack` voices" was asserted with no address.** One record per note
takes `C4K3 S0NG` from 3,634 notes cut short (28%) to 1,526 (12%); a listener had heard it first
("molte voci vengono troncate, nell'originale non sento così tante note troncate"), with both of
their guesses the right shape. ⚠️ **It costs CPU to be right**: the live load went from 11–26%
back to 23–60% of a core, and the LFO fix paid for it and no more. ❌ The page used to turn the
"voices sounding" number red past the pool size, captioned "something is not respecting it";
nothing was — a stacked note plays up to five sampler voices from one record, a one-shot outlives
its gate, a release rings on — and dressing a right number as a fault teaches a listener to
distrust it. The meter shows **notes** now, red at ⅞ of the pool, and reads high on purpose:
measured over `C4K3 S0NG`'s first 60 s the warning lights with slots to spare in 12.8% of blocks,
because the pool gives a record back at the gate while the voice keeps its tag until it has
finished ringing.

## 33. Is the pool really 32, and really per sequencer? — yes to both

**Answer**: `(0x1a28 − 0x28) / 0xd0 = 32` is an immediate in the PS4 binary; one state block is one
whole sequencer; the allocator has no sub-pools — [synth-engine.md](synth-engine.md). Asked after a
listener heard too much stealing: *"are we sure the PS4 limit is not higher, or that it is not
applied to something narrower than the whole sequencer?"* Whether the eboot keeps more than one
state block does not matter: the game walks every `MusicSequencer` Thing when one begins, and even
if two could sound, neither would get more than 32.

## 29. Does a releasing voice still hold its record? — yes, and what ships is a decision

**Answer**: the engine frees a record when the envelope reaches zero at both ends of the block, or
an unlooped sample runs out, or a score factor is zero — every link re-derived from the binary and
holding — and `RenderOptions.releaseTail` defaults **off** anyway, for the reason and with the
measurements in *29* in [open-questions.md](open-questions.md).

The wrong turns are the useful part:

- ❌ **`[+0x14]` looked like the reconciliation and is dead code.** The allocator's fast path takes
  a record whose `+0x14 > 0` before asking whether it is free, but both callers pass `dil = 0`. The
  field is a plain marker written as 10000 when the record is claimed; ⚠️ "nothing reads it again"
  was then also wrong — `0x394d` tests it to release a record whose `+0x14` is zero when a state
  flag is clear, which changes no number on a claimed record but would have made the next reader
  wonder what else the note had missed.
- ❌ **"The steal sounds different in the game" — refuted.** `0x19e0` zeroes the whole record on
  takeover; the stolen voice stops instantly. A fade would be an invention.
- ❌ **"We schedule notes the engine would not."** The skip at `0x04d4` tests `channelVolume × clip
  Level`, not velocity (*31*); it never fires on real data.
- ❗ **The score follows the note's volume automation** — `[+0x0c]` is rewritten per block from the
  current control point — and a note fading out becomes the cheapest thing in the pool. Measured
  before being built: scoring every note by the quietest point it ever reaches gives 1,494 steals
  against 1,411. Slightly *more*. **Because the score does not decide HOW MANY notes are stolen,
  only WHICH ones** — the count is set by occupancy alone. So no refinement of the score can move
  the number, and the clip's `Level` went into the score for correctness, not as the way in.
- ✔ **The baseline is not ours — it is the song.** Counted straight off the records, `C4K3 S0NG`
  wants more than 32 records 21.0% of the time; the renderer asks for 16.0%. Three ways it could
  have been our fault were checked and all are clean: all 244 tracks are distinct; 0 of 13,091
  notes are one-shots, so the overhang is 0; and `duration` disagreeing with `endPosition −
  startPosition + 1` on 1,057 notes is the triplet population (whole steps versus thirds).
- ✔ **One thing came out unconditional**: a voice whose unlooped sample runs out gives its record
  back (`0x3035`–`0x3065`), and it was missing. A drum whose sample lasts 0.2 s no longer holds a
  record for its 1 s release: 1,411 cuts → 1,318.
- ⚠️ **Our own two halves disagree**: the mixer keeps a voice alive through its release
  (`env.finished` ends it); the pool frees the record at the note's written end. The pool is the
  optimistic one, and it is the half that matches the ear.

## 10. One-shots — the engine gates every voice

**Answer**: the envelope's gate argument is `voice[+0x10] == 0` with no branch on the loop or the
slot (`0x1f65`–`0x203f`), and `0x3035` is an *additional* stop for a loopless voice, not an
exemption — [synth-engine.md](synth-engine.md). Settled against a recording of `Ascetic`'s two
kits: envelope correlation with the game in eight two-second blocks favours `gate` over `full` and
`natural` in **eight of eight** (0.8368 vs 0.8237 in the first), and the per-hit decay error is
34.1 ms against 39.2. ✔ The capture was shadPS4's and the conclusion survives it: it rests on a
shape and on the code.

⚠️ **The old evidence was not wrong; it was about a different bug.** A listener reported the drums
as clipped and far too quiet, and the arithmetic backed them (`baiyon_drums_1`'s release is three
milliseconds) — but those renders were playing `baiyon_drums_1` with `a_kit_1`'s kick, because two
sample GUIDs had collided on one filename ([game-assets.md](game-assets.md)). With the right kick
the drums stopped sounding wrong and the rule invented to compensate stopped being needed. **A fix
that compensates for a symptom will survive the symptom's real cause being found, and go on
quietly making everything else wrong.** `options.oneShot` still offers `full` and `natural`
(`LBP_ONESHOT`), because the difference is small enough that only a measurement separates them.

## 15. `robot` sounds thin — withdrawn by the listener, and NOT attributed

**Answer**: on 2026-09-05 the listener says the lead synth in `This Is Halloween` now sounds right.
Nothing here claims to know why, and the refusal is measured rather than modest.

Exactly one systematic change of that session reaches `robot` (`Numstack` 1, modulation 0, key
tracking 0): the block clock, 128 → 256, credible on its face because `robot` takes 98% of its
cutoff from a filter envelope re-derived per block. ⚠️ **And the control says that is not enough to
conclude anything**: everything random in a voice comes from one seeded stream, and the session
reordered the draws. On `robot` alone over 25 s of `Ascetic`, the block clock is worth **−33.0 dB**
of difference and a reseed **−4.6 dB** — a reseed is 28 dB *larger*. **A difference smaller than a
reseed is a difference a reshuffle could have produced**; `LBP_SEED` exists for exactly this, and
the original reference was shadPS4, which the same day's evidence rule disqualified for spectrum.
Ruled out on the way, off the file rather than off a capture: the octave (49,447 notes from −12 to
+30 semitones with a fat middle at +26 — composers use it as a lead), `Key` (0 on 49,270 of them),
a hidden per-note flag (byte 3 only ever holds `0x00`, `0x40` or a low nibble), the interpolation
direction (*20*), and the resonance (every one of its records carries timbre 0).

## 2 / 2b. The echo — a stereo delay, `EchoTime` in beats, and a hard clip

**Answer**: inside `fmodextinput.prx`, a 192,000-float interleaved ring, delay `EchoTime` beats
exactly, feedback clamped to 0.95, wet added to all four lanes (so the echo feeds the reverb),
output hard-clipped to ±1 — [synth-engine.md](synth-engine.md).

❌ **Three wrong readings, each of which looked settled.** First `EchoTime × 0.5` **seconds** —
tempo-independent, which cannot be right in a tempo-locked sequencer. Then **beats**, argued from
the corpus's detents (2.00 on 189 of 338 sequencers, 1.00 on 95, 1.50 on 47 — but two beats, two
bars and half a bar are all musical detents), which was the right answer for the wrong reason and
was then "corrected" away. Then **eight steps per unit**, read off `stored * 16` at `0x0f74`, a
factor of two out. The decisive number was the clamp: 192,000 is the ring's *float* count, not its
frame count. `stored * 16` is a length, and a length means nothing until you know what it counts.
⚠️ The damping and ping-pong in the kernel are unreachable — nothing in the eboot writes the two
fields — so do not "find" a filter in that loop later and wire it up.

## 9. Board row → mixer channel — bands

**Answer**: the board is cut into `NumChannels` horizontal bands and a placement's channel is the
band its row falls in; `circuitBoardSizeY` is the datum, and it was being read and thrown away —
[sequencer-data-model.md](sequencer-data-model.md).

❌ **Two wrong readings, both reasonable.** `gridY` as a direct index — killed by the corpus, 88% of
tracks have a `gridY` outside `0..NumChannels−1`. Then `gridY % NumChannels` — it put every row in
range by construction, a listener had already corrected an earlier `% 8`, and it shipped for two
months; it wraps where the game bands, re-routing 667 of 1,821 tracks on the ten multi-channel
sequencers. ⚠️ **No amount of corpus work could have settled it** (308 of 338 sequencers run one
channel, where every rule agrees); it took the writer, found with the method this question had
carried for three days — byte-scan for `E8` displacements landing on a known callee, search
backwards for the caller's `55 48 89 e5`, disassemble from **there**.

---

# The chain

## 6 / 14. The reverb — the whole of `fmodsmsreverb.prx`

**Answer**: a mono downmix into a damped one-pole and a notch, `tapCount − 2` mono combs plus two
stereo comb pairs summed raw, an output delay, three panned early taps, 100% wet; slots, flow,
kernels and write-back in [lbp-audio-engine.md](lbp-audio-engine.md). Neither of the two
candidates the project spent four sessions choosing between — FMOD's `SFXREVERB` and Sony's
`aSfxDsp` — was the answer; the plugin was in a file next to the eboot that nobody had opened.

**The wrong readings, and what produced each** — every one looked reasonable:

| the claim | why it was believed | what it actually is |
|---|---|---|
| a Schroeder **allpass cascade** after the combs, 0.5 coefficient | the kernel at `0x0960` subtracts its own output from the signal, the shape of an allpass | with `a = 2r·cos(w)` and `c = −r²` the recursion is a **resonator**, so `x − y` is a **notch** — on the **input**, not the output |
| slot 8 is a **pre-delay in samples** | it is small, and reverbs have pre-delays | the **notch frequency in hertz**; the real delay is slot 6, in ms, and it sits **after** the combs |
| slot 1 the early level, slot 2 the late | both are millibel levels | slot 1 is **late**, slot 2 **early**; getting it backwards also moved the `/100` onto the tail, which silenced it |
| the early rows' columns 6-8 are gains, 3-5 "are not levels" | 46, −60 and 21 are absurd as gains | 3-5 **are** the gains — they multiply an early level of order 0.003 because of the `/100`; 6-8 are pan positions |
| each comb needs a `1 − gain` normalisation | eight feedback combs summed are ~9× unity at DC | the kernel sums the raw delay outputs with **nothing** between; the level is `lateLevel`, read off the wrong slot |
| `reverbSend` multiplies `Params[25]` | a `vmulss` sits next to the send's clamp | that multiply is on the **echo** path, the negative branch of the bipolar offset; the reverb send is the placement's field alone |

And two process errors: the renderer called `process()` twice per frame, once per channel, through
one instance, so every delay line ran at twice the frame rate with both channels sharing one state
(`Reverb.process` is stereo now); and a scan for the level fields was run against the **wrong PRX**
(`fmodextinput`) and concluded "the PRX never reads them", sending the search after an imaginary
output matrix in the eboot. ✔ The last unknown — what gain the eboot puts on the connection into
the reverb and back to the master — closed with *22*: there is no connection and no gain, the two
DSPs share one 4-channel buffer.

## 37. The WaveHammer — answered by RUNNING it, after three wrong readings

**Answer**: a compressor at −18 dB / 10:1 over a 64-sample sliding mean square, limiter bypassed,
configured by a static template; −17.2 dB of gain at −0.9 dBFS, −7.2 at −12, a floor of −1.84 dB
below −21 dBFS — [lbp-audio-engine.md](lbp-audio-engine.md), `tools/wavehammer.py` and
`tools/runhammer.py` agreeing to 1e-4 dB.

❗ **The value of this entry is the three wrong readings, two of them committed:**

| # | the claim | why it was believed | what was true |
|---|---|---|---|
| 1 | "It is a limiter." | the product is called Wave Hammer | it ships with `LimitBypass = 1`; the **compressor** section runs |
| 2 | "The game never configures it." | `DSP::setParameter` is never called on the handle — all fifteen call sites enumerated | true, and irrelevant: `create` `rep movsd`s a static template over the parameter block |
| 3 | "It collapses to a constant −18.04 dB." | a **superset disassembly** of all 7,632 bytes found no store to `[reg + 0xc0]`, so the window length looked uninitialised | `[state+0xc0] = 64`; `0x380` writes it as `mov qword ptr [rbx + 0x3c], rax` through an interior pointer to `state+0x84`, two fields in one store |

Reading 3 is the one to remember: the technique was **sound and exhaustive** and the conclusion
still false. Decoding from every byte proves "no instruction stores to `[reg+0xc0]`"; it does not
prove "this field is never written". One wrong field produced **four** self-consistent
conclusions — the constant, a `NaN` at table entry 0, a downward expander below the knee, and "the
compressor never compresses" — none of which looked wrong from inside the disassembler, and all
of which died the moment the module printed its own state. What survived every correction was
everything derived from the *arithmetic* rather than the state: the struct layout, the units, the
knee's closed form. Two more things only the running module's vectors caught: the second
smoother's seed and the `f32`-versus-`f64` misprint of `a1`.

## 22. The stereo width — the game narrows every pan to `2 − √2`

**Answer**: predicted from two interior points, measured at both extremes to six figures, and then
*derived* from three read constants — the plugin's linear pan, FMOD's `k = 0.5` centre feed at
`v0xa2599f`, BS.775's `1/√2` — [lbp-audio-engine.md](lbp-audio-engine.md). Open since a listener
said *"sembra che lbp non abbia mai un hard panning"*.

⚠️ **Within the affine family every form predicts the same ratio everywhere**, so no amount of
listening at interior pans separates width from mono-add from cross-bleed; only the extremes
separate the family from constant power (0.2612 against 0.198). ⚠️ The asymmetric alternative —
FMOD mapping the four channels straight into FL, FR, FC, LFE, which would give 0.2612 at pan 0
and **0** at pan 1 — is refuted by the captures themselves.

❌ **A session was spent enumerating vtables by shape** — runs of consecutive relocation slots
holding code addresses, filtered on plausibility — and produced five wrong candidates plus a near
miss (`v0xa287b0`, `DSP::setDefaults`) convincing enough to write up. The binary has RTTI and 322
vtables can be named in a third of a second ([eboot-re.md](eboot-re.md), `tools/ebvtable.py`).

❌ **"Width, not gain" for two days — half of a linear operator.** The captures are level-matched
and say nothing about absolute level, which was the right reason to be careful; but the fold is
read, and it fixes the level whether or not a capture can confirm it: narrowing without the
`(1 + 2kd)` gain is a uniform **−4.645 dB** at every pan. ❗ **And the first attempt made the gain
`1 / panWidth` instead of a constant** — defensible physics, and it turned the live page's width
slider into a volume control, +20 dB at 0.1. **A parameter that is a diagnostic must vary one
thing.** ⚠️ **A normalising renderer hid the missing gain for two days**: every offline check came
out at full scale, and it took a listener on the live page, which does not normalise, to say "the
whole sequencer is quiet". ⚠️ And `panWidth` existed for a day as "a DIAGNOSTIC, not a setting"
with a note that 0.58 reproduced the recording but must not be promoted until a mechanism was
found: a transfer function measured on the game's own output at four operating points **is**
evidence in its own right, and the renderer hard-panned a day longer than the evidence justified.

## 39. The stereo fold — the gain moved to where the game applies it

**Answer**: the fold's gain runs after the plugin's clip, the reverb and the compressor, where
FMOD's speaker matrix applies it; the narrowing is not applied, on a listening judgement —
[lbp-audio-engine.md](lbp-audio-engine.md), *39* in [open-questions.md](open-questions.md).

❗ **The old placement was a real bug, not a tidiness point.** Folded into each voice, the gain put
`clipToUnit` 4.645 dB hotter than the game's clip ever sees, so it engaged on material the game
passes untouched: on `level-seq732985` (20 s) the clip touched 0.05% of frames before and 0.00%
after, with the peak 1.046 (clipped) → 1.385. The echo, inside the same plugin, was equally
over-driven. ⚠️ And the count under-reported: the plugin clips all four lanes and `clippedFrames`
watched only the dry two. This also retired the biggest lead on *38*.

## 23. The ~1 dB deficit above 315 Hz — withdrawn, and NOT attributed

**Answer**: raised from a dry capture, parked when the listener said the reference was shadPS4,
withdrawn on 2026-09-06. Nothing replaced it: its evidence was never admissible — a per-band
decibel table is the kind of finding an emulator's output path manufactures — not because it was
explained.

The numbers as taken, kept so a capture from real hardware has something to compare against:

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

The bass was exact and everything from 315 Hz up quiet by roughly a decibel — suspiciously *flat*
for a filter, which always argued for something gain-like; the largest gain-like thing in the
renderer was `FOLD_GAIN`, now *39*'s.

---

# Files and the corpus

## 16. The board cell of a component on an open circuit board — the delta in the board's basis

**Answer**: three dot products against the board matrix's columns, each divided by the column's
squared length; 100.00% of 1,030 open-board placements on a cell, with the odd-multiple
fingerprint intact — [sequencer-data-model.md](sequencer-data-model.md),
`packages/cwlib-ts/dev/board-probe.ts`.

⚠️ The Java tool this replaced computed `thing.translation − board.translation`, rotated by the
**child's** inverse normalised rotation. It scored the same 100.00% on this corpus and was wrong
twice over: the child's rotation instead of the board's (they agree only because a component lies
flat against its board), and normalising instead of undoing the scale. Both are invisible on the
ten levels available, which is why the property test matters more than the agreement. The instinct
that produced the entry — *"it seems absurd that the game transforms rotations just to work out the
sequencer's structure"* — was half right in a useful way: the quaternion round-trip is absurd; the
frame change is not, and the corpus separated the two in ten minutes.

## 25. Plans (`PLNb`) — read, and they hold most of the music

**Answer**: `readPlan`, the nested Thing stream with its own reference table, and 172 sequencers
inside plans against 19 in the levels beside them — [level-files.md](level-files.md).

⚠️ `PLNb` had been in the level magic list all along, meaning "read a plan as if it were a world",
which produced eleven loud failures for a backup that was fine; taking the magic *out* was right
for an hour and wrong as a resting place. The magic was never the problem; the reader was.
`POCKET_ITEM` and `YELLOWHEAD` were written for two plans that failed by name — the growth path
working — and one plan at revision `0x272` is refused by the bound on purpose.

## 26. Streaming levels — the whole chain, down to the islands

**Answer**: `RLevel` → `StreamingManager` → `CHKb` chunks → islands → a whole `PLNb` each; 171
chunks, 2,553 islands, 10,837 Things, 9 sequencers — [level-files.md](level-files.md).

⚠️ **Three byte-width bugs it uncovered had all been invisible for the same reason**: everything
the corpus had ever contained was compressed, and a compressed stream hides whole classes of error
because a varint under 128 is one byte — exactly what a `u8` is. `isCompressed` read and ignored;
the parts revision guessed from the version instead of read from the stream; `FieldLayoutDetails`
as `enum32` where it is bytes (with it wrong, 101 of 2,553 islands died and the rest quietly lost
most of their Things — the first measurement said "0 sequencers in any island"). **The first
uncompressed resource is worth more than a hundred more compressed ones.** Fifteen part readers
came with it, every part an island scene uses.

## 35. Dependency types — answered by measurement

**Answer**: 1 texture, 9 a level inside an adventure, 38 plan, 46 recording, 61 streaming chunk,
62 an adventure's shared data — every row checked against the magic of the resource actually
downloaded — [level-files.md](level-files.md).

⚠️ **An adventure (`ADCb`) is not a level and would have opened as nothing.** Four of twelve
"adventure map" hashes off the index are one; `readBackup` skips it on its magic and its levels are
the type-9 dependencies. With the walk unticked a perfectly good hash would have done nothing,
silently, indistinguishable from a broken one — so the walk is not optional when the root cannot
itself be opened. No chunk found so far contains a sequencer; the plumbing is proved and the
payoff still hypothetical.

## 36. The island that would not parse — one byte

**Answer**: `PControlinator.parentBoneIndex` is one byte and was read as `i32` —
[level-files.md](level-files.md), which has the general lesson (`cf7` hides field widths) and the
technique.

The find, which is the part to copy: `setTrace` put the failure inside `CONTROLINATOR`; wrapping
every `Serializer` method logged each read as `(name, start, end, value)`; the tail of `SWITCH` read
plausibly, so that part was aligned and the next field was not — `parentBoneIndex = 4,161,536`,
which is `0x003F8000`: a zero byte followed by three quarters of the `1.0f` of the identity matrix
after it. Dumping the raw bytes then settled it in one look. 31 of 32 archived chunks → 32 of 32,
5,832 Things recovered, the golden fixture unchanged.

## The PS3 backup that "cannot be read" — it reads fine

**Answer**: the numbered files are the game's own `FAR4` archive under XXTEA with a constant key;
28 resources, 28 of 28 SHA-1s matching, 11 sequencers — [level-files.md](level-files.md).

❌ **Two rounds of evidence were produced for the wrong answer, and this is the most instructive
entry here.** Round one was a guess wearing a measurement's clothes: "472,960 bytes at 8.000 bits
per byte, all 256 values present, no run of four zeros" — every word true, every word equally true
of **compressed** data, which is what an LBP resource is made of. It never discriminated between
the two hypotheses on the table, and read as decisive because it had numbers in it. Round two was
a real measurement of the wrong question: `PFDB` in `PARAM.PFD`, two saves sharing 0 of 29,560
16-byte blocks, nothing inflating at 4,096 offsets — all sound, all establishing only "this is
ciphertext". *Whose*, under what key, was never asked, because round two was built to defend round
one. **The answer was in the bytes already printed**: the file ends `2d ba 61 d2 46 41 52 34` —
`FAR4`, in the clear — in a hex dump produced *as part of proving the file unreadable*. What broke
the deadlock was a question from outside: how can a site serve the same level both as a PS3 backup
and as loose resources? Only by *building* the backup, which means the encryption is public, which
means it is in that repository — `TEA_KEY` in `save_archive.rs`, thirty lines from the top.

❗ **"I cannot read it" is a claim about the reader, not the file.** And ⚠️ **the recipe was already
in steering**, three days earlier, in the file the index says to read before writing a parser for
any LBP archive. The measurement theatre was spent re-deriving — wrongly — something already
written down.

## 28. The LBP1 readers — 19 of 19 identical to cwlib

**Answer**: with `LBP3_MIN_VERSION` lowered by hand, all nineteen LBP1 files in the archive sample
read Thing for Thing identically to cwlib; the bound itself stays at `0x3b7` — the sweep, the
bound and what is left are in [level-files.md](level-files.md) and *28* in
[open-questions.md](open-questions.md).

Twelve readers were wrong below LBP3 and every one was found by the span diff, none by a hex dump:

| reader | what was wrong |
|---|---|
| `fillThing` | UID before parent below **0x27f**; the `0xAA` marker also on LEERDAMMER rev 5; the parts mask also on LEERDAMMER rev 2 — the comment directly above the UID line already said so |
| `readPos` | the local matrix is stored too below **0x341** — 64 bytes; the comment said *"regenerated above 0x341"* above a line that read one matrix always |
| `Polygon` | `requiresZ` arrives at **0x341**; below it there is no flag byte and every vertex is a v3. This reader read the flag anyway and then picked the vertex width from whatever that byte happened to be — **a field that does not exist yet costs more than its own width when something downstream branches on it** |
| `readShape` | six gates: the colour as a v4 below **0x389**, `brightness` absent below 0x301, `behavior`/`colorOff`/`brightnessOff` below 0x303, `interactPlayMode`/`EditMode` at or below 0x306, `lethalType` an enum32 at or below 0x345, three bools for the flags word below 0x2b5 |
| `readRef` | `childrenSelectable`, `stripChildren` — gone at **0x321** |
| `readGroup` | no flags byte below **0x341**; `COPYRIGHT`, `EDITABLE`, `PICKUP_ALL_MEMBERS` as separate bools at three gates |
| `readMetadata` | did not exist; LAMS keys, and the four translation-tag strings below LEERDAMMER rev 8 |
| `readRenderMesh` | `editorColor` as a v4 at or below **0x31a** — 15 bytes |
| `readTrigger` | `zOffset` only from **0x322**, read always — 4 bytes |
| `readJoint` | `modDriven`, `interactPlayMode`/`EditMode`, `modScaleActive`; `tweakTarget*` are **ints** at or below 0x280; `behaviour` only from 0x2c4 |
| `readSwitch` | `oldActivation` below 0x2a0, and the whole connector block (`> 0x1fa && < 0x327`), fifty-odd bytes; `connectorPos` is a `vectorarray` of **v4** |
| `readCreature` | the submerged pair, `hasScubaGear`, `outOfWaterJumpBoost` are `version >= X` **or LEERDAMMER** — ten bytes, and fixing them closed the last four files at once |

❌ **"0 of 21 read correctly" was a measurement error**: it compared against cwlib's total Thing
count, which includes nulls that `readWorld` filters. Compare the non-null count. ⚠️ And the scope
note in `serializer.ts` was wrong about its own code — it said cwlib's older branches had been
stripped in the port, when `parts.ts` carries 238 distinct version gates spanning `0x137`–`0x3f0`
and 163 subVersion gates; the branches were all there, never run against a file old enough to take
one, so "widening the range" means finding which ported branches are wrong, not adding them.

## 34. The live scheduler's −57 dB — it was the simulator

**Answer**: the scheduled path is bit-identical to the direct render; the −56.8 dB on `C4K3 S0NG`
and −59.1 dB on `Ascetic` were `live-sim.ts` rendering `TICK × RATE` = 4,800 frames per call where
the worklet renders 128 — 37.5 modulation chunks, so every other burst cut a chunk in half. Proved
before it was fixed: `LBP_TICK=0.08` (3,840 frames, exactly 30 chunks) went to −Infinity dB with
nothing else changed.

⚠️ **Rendering 128 frames at a time was not by itself the fix, and that cost the extra hour**:
quanta restarted at each tick boundary are every one of them 64 frames off the grid (`4800 % 128 =
64`), and the figure did not move. The quanta have to run on the **stream's** grid with the posting
inside that loop — which is what the player does. ❌ **Two fixes to the mixer were made and
reverted**: the chunk grid as the stream's with the mixer counting frames rendered (−56.8 → −63.8
dB, `Ascetic` −59.1 → −89.7 — an improvement that was a different wrong answer), and refreshing the
morph once per grid chunk. **The mixer was never wrong**, and either could have been committed as
"the fix" with a 7 dB improvement to show for it. 128 is the one block size that hides this;
`LBP_SCAN_BLOCK` and `LBP_DIFF_BLOCK` take the size for that reason.
