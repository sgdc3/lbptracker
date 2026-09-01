# Answered questions — the measurements, kept out of the way

Questions that are **settled and implemented**. They live here rather than in
[open-questions.md](open-questions.md) so that file stays a list of what is still unknown, but the
measurements are the project's ground truth and are not abridged: each section keeps the addresses,
the corpus counts and the wrong turns that led to it.

⚠️ **Read this before re-deriving anything.** Several of these were got wrong once, twice in one
case, and the sections say how — the failure modes are worth more than the answers. In particular:
a fix that removes a symptom is not evidence; a negative result from a pattern scan is only as
strong as the pattern; and a parameter's meaning is not settled until you have looked at what values
the game's own instruments carry.

Where an answer left something behind, the residue is listed under *Leftovers* in
[open-questions.md](open-questions.md).

## 5. `finetune` units — RESOLVED, 2026-09-01: **semitones**

`sub_0x1c40` adds the slot's f32 into the same sum as the note and the root note, before the one
division by 12 — same units, no scaling. `FINETUNE_PER_SEMITONE` is now 1.

The corpus agrees independently: the 23 distinct non-zero values the game's own instruments carry
run **−0.17 … +0.56**. Read as semitones that is −17 to +56 cents, an ordinary fine-tune range; read
as cents it would be five-thousandths of a semitone, which nobody would author.

*(The other half of this question — the "unnamed third bool" in the sample slot — was already
resolved: the serialiser writes `fitbpm` twice to the same member.)*

## 6b. The filter's four controls — SETTLED, and got wrong twice on the way

The final reading, all of it out of `fmodextinput.prx` `0x2a02`-`0x2a90`:

```
0x2a28   xmm4 = (1 - envAmount) + envB * envAmount      ; envFactor
0x2a3f   xmm6 = cutoff * cutoff                         ; cutoff²
0x2a6a   xmm1 = 1 + (pitchRatio - 1) * keyTrack         ; keytrack
0x2a6e   xmm1 = cutoff² * keytrack
0x2a72   xmm9 = envFactor * xmm1                        ; freq
0x2a90   xmm1 = xmm4 * resonance                        ; res = envFactor * resonance
```

with `Params[3..6]` = cutoff, resonance, keyTrack, envAmount. **This is what the code had before
this session touched it.** Two changes were made against it and both were wrong; they are recorded
because the trap is a good one and cheap to fall into again.

### Why it is hard, and what actually settles it

**The key-tracking and envelope terms are the same shape** — both are `1 + (X - 1) * p`, built from
the same `vsubps/vmulps/vaddps` triple. Nothing in the arithmetic distinguishes them. Reading the
block and asking "which of these looks like key tracking" gets a coin flip, and a coin flip is what
it got.

What settles it is the identity of `X`, and each one is a short trace:

| register | what it is | how that is known |
|---|---|---|
| `[rbp-0xa90]` | the **pitch ratio** | set to `1.0` at `0x1e25`, then multiplied at `0x1e4a` by `[rbp-0x9d0] / [rcx+rbx+0x88]` — a frequency over the slot's own base frequency |
| `[rbp-0xb70]` | **envelope B** | `0x21ef`-`0x220d` interpolate `Params[7..10]`, the filter ADSR, and `0x222d` calls the envelope evaluator with them and stores its result there |

`[rbp-0xa90]` pairs with `Params[5]`, so `Params[5]` is the key tracking. `[rbp-0xb70]` pairs with
`Params[6]` **and is the `xmm4` that reaches the resonance at `0x2a90`**, so `Params[6]` is the
envelope amount and the resonance takes the envelope, not the pitch.

### The two wrong turns

1. **"The resonance follows the key tracking."** Asserted from `0x2a90` alone, on the assumption
   that `xmm4` was the keytrack. It is the envFactor.
2. **"`Params[5]` and `[6]` are swapped."** A consequence of the first: with the resonance wrongly
   taking the pitch, `musicbox.rinst` (key tracking 1) self-oscillated on high notes, and swapping
   the indices made that symptom go away. It made the symptom go away by moving the error, not by
   removing it — and it silently traded every instrument's filter-envelope depth for its key
   tracking, which a listener heard immediately as broken envelopes.

⚠️ **A fix that removes a symptom is not evidence.** Both changes were made because a render
sounded better or worse afterwards. The only thing that settled the question was tracing two stack
slots back to their writers, which cost less than either wrong turn did.

### The ladder's saturation and its bypass — both measured

**The saturation is `b4 -= b4³/6`, exactly**, and it applies to the last pole's output only:

```
0x32a1  xmm2 = b4 * b4
0x32a5  xmm2 = b4 * xmm2          ; b4³
0x32b9  xmm2 = xmm2 * 0.166667    ; v0x46a0, four lanes
0x32bd  b4   = b4 - xmm2
```

repeated identically in the second ladder site at `0x3320`-`0x332c`. So that part of the model was
already right.

**The clamps are the engine's too**, which this file and `moog.ts` both called ours. `0x2ae9`-`0x2b32`
clamps all four block values — the start and end of the cutoff ramp and of the resonance ramp —
with `vminps` against 1.0 and `vmaxps` against zero.

**And there is a bypass nobody had modelled.** `0x2ee9` compares the clamped cutoff against **0.99**
and `0x2f17` branches on it. The fall-through is a self-contained loop at `0x2f40`-`0x2fdb` (back
edge `jl 0x2f40`) that touches **none** of the ladder's constants — no `0.8`, no `5.6`, no `1/6` —
so it is the unfiltered path, taken when the cutoff is above the threshold. The compared value is
identified rather than inferred: `xmm9` receives `freq` at `0x2a72` and is not written again before
`0x2ae9` clamps it into the slot the comparison reads.

⚠️ **This is audible, because our ladder is not transparent at `freq = 1`**: a unit impulse
comes out at 0.833 and it is still ringing after half a second. `keys/piano.rinst` is cutoff 1.0 at
both ends with full key tracking, so at and above its base note it sits on the bypass side — every
one of those notes was being coloured by a filter the engine never runs. Below the base note its
cutoff genuinely tracks down (`freq` is just the playback rate) and the ladder does run, at
resonance zero, as a plain 4-pole lowpass. `FILTER_BYPASS_CUTOFF` in `moog.ts`.

⚠️ **Still open: whether `q` should reach 3.** With the correct reading, `musicbox` at full
modulation has resonance 0.856 at `freq ≈ 0.019`, and the Stilson/Smith compensation grows as the
cutoff falls, so `q ≈ 3.1`. The coefficient formula matches the engine instruction for instruction,
but the **saturation that bounds the ladder** has only been read as `b4 -= b4³/6`. If a resonant
patch still sounds like it is howling, that is where to look — not at these four indices.

## 6c. The unison stack — measured, documented, and NOT WIRED UP until now

`STACK_PARAMS` carried all three fields with their formulas, `OUTPUT_PARAMS.level` documented the
`sqrt(1 / Numstack)` beside it, and `LFO_PARAMS` documented the `× 2π / Numstack` layer fan.
**Nothing read any of them.** The renderer played one voice per note regardless of `Numstack`, so a
stacked patch came out as a single thin copy at the wrong level.

That is the other half of the same report. `ghost` has `Numstack` **3**, `spread` 0.15,
`startOffset` 0.06 and — the part that gives it its name — **LFO 3 spread 1.0 with depth 0.27**,
an auto-pan fanned a third of a cycle apart across the three layers. One layer cannot produce that
at all.

Now wired: `Numstack` layers per note, each with `1 + 0.05 * detune * U(-1,1)`, pan offset
`0.5 * spread * U(-1,1)`, start `startOffset * sampleLength * U(0,1)` frames in, gain
`sqrt(1 / Numstack)`, and LFO phases offset by `spread * 2π/Numstack * layer`. `VoiceSpec` gained
`startPosition` and `lfoPhaseOffset` for it; the renderer seeds a fixed PRNG so a render stays
comparable with the last one.

⚠️ **Check the other 67 instruments against this.** `numStack` equals the used-slot count in only
14 of them, and most 8-slot drum kits have `numStack` 1, so the corpus-wide effect of wiring it up
has not been measured — only that the peak of the rendered mix fell from 1.749 to 1.491, which is
the `sqrt(1/N)` correction arriving.

## 6d. Per-note modulation — WIRED UP 2026-09-01

The note word's bits 24..27 are the note's own modulation, `× 1/15` (`v0x4550`), and it is the
value that picks a point inside **every** `Params` range: `evaluateParam(p, mod) = p.x + mod*(p.y -
p.x)`. `sequencer-data-model.md` has had this since the row at `voice+0x28` was corrected from "pan"
to "modulation", and the renderer went on passing a hard-coded `0` — so every note used every
parameter's `x` endpoint and the `y` endpoint was unreachable.

**It is not a rounding-level difference.** Across 3,199,788 corpus records the nibble is 0 on
80.74% and **15 on 10.20%**, with the other nine per cent spread thinly over the fourteen values
between: mostly a two-position switch that a minority of authors sweep. On `synth/ghost.rinst`,
`Params[4]` runs 0.90 to 0.53, so a full-modulation note should have *little* resonance where an
unmodulated one has a lot — the two are not close.

Per sequencer it is very uneven, which is worth knowing before concluding a render is unaffected:

| sequencer | notes | with modulation | at full |
|---|---|---|---|
| 723339 "Ascetic" | 28,998 | 10 (0.0%) | 0 |
| 737099 "This Is Halloween" | 29,260 | **2,488 (8.5%)** | 2,440 |

⚠️ **The first point's value only.** 70,028 of the corpus's 2,027,633 notes (3.45%) change
modulation across their own control points, and those render at their opening value. Pitch and
volume are interpolated between points; modulation is not, because it feeds things read once when
the voice starts — the envelope times, the filter settings, the unison stack. Whether the engine
re-reads it mid-note is unmeasured.

## 13. The voice pool — 32 voices, steal the quietest — MEASURED AND IMPLEMENTED

The synthesiser has **32 voices and no more**: the DSP state reserves `+0x0028`…`+0x1a27` for 32
records of `0xd0` = 208 bytes, which is most of its 6,992. This project had no cap at all and peaks
at **88 simultaneous notes** on one corpus sequencer, so dense passages played louder than the game
can — which is where a listener notices.

The allocator is `fmodextinput.prx` `0x1640`-`0x1692`:

```
xmm0 = 1.0                       ; best score so far
ecx = 0                          ; index      edx = 0   ; best index
loop:
  cmp byte [rax], 0xff
  je  return                     ; a free record wins immediately
  xmm1 = [rax + 4] * [rax + 0xc] ; this voice's score
  cmovb edx, ecx                 ; remember it if it is the lowest so far
  xmm0 = min(xmm1, xmm0)
  rax += 0xd0 ; inc ecx ; cmp ecx, 0x20 ; jl loop
return rsi + edx * 0xd0          ; else the quietest voice
```

**Take the first free record; when none is free, steal the quietest.** The score is `voice[+0x04] *
voice[+0x0c]` — the channel volume times the note volume, both known from the gain chain at
`0x23c1`. Neither `Params[24]` nor the amplitude envelope is in it: the engine ranks by what the
note asked for, not by how loud it currently is.

WARNING: the running best starts at **1.0**, not infinity, and the best index at **0**. A pool where
every voice scores 1.0 or more loses voice 0 rather than the quietest. `src/core/polyphony.ts`
reproduces that rather than tidying it, and a test pins it.

**Exposed as a setting.** `allocateVoices` takes a pool size and `VOICES_UNLIMITED` turns the cap
off; the renderer reads `LBP_VOICES`. **This belongs in the UI** as a number rather than a checkbox
— 32 is the game's and is the default, and letting a composer try 16 or 64 costs nothing, but
raising it is no longer faithful and should say so.

WARNING: **it fixed nothing audible, and that is the point of recording it.** The cap went in while
chasing a report that "the aggressive synth with long notes is too loud at 1:30, only there". On
that window it cuts 248 of 1,684 notes -- `robot` (110), `a_kit_1` (81), `pulse_wave` (22),
`musicbox` (17), `baiyon_drums_1` (13), with `ray_gun` untouched -- and overall RMS moves 0.1324 to
0.1304. **A listener compared the two renders and heard no difference.** The cap stays because it is
the engine's, not because it solved anything.

**So the 1:30 report is still open**, and the cheap leads are used up: it is not the gain chain
(measured against `0x23c1`-`0x2408`, every factor accounted for), not polyphony, not the stack
layers. What has not been looked at is why that passage in particular -- the next step is to find
which instrument it actually is by rendering the window one instrument at a time and asking, rather
than reasoning from the parameter tables.

### Stack layers are the same sample, not different slots

Checked while chasing the above, because `mime_artist` (4 samples, 1 zone, `Numstack` 5) suggested
otherwise. **14 of the 15 stacked instruments have `slots == zones`** — `piano` 5/5 with `Numstack`
2, `choir` 5/5 with 5, `e_guitar_power` 7/7 with 5. Only `mime_artist` has spare slots, and its 3
spares do not equal its `Numstack - 1` either. So layering one sample `Numstack` times, as
`dev/render-level.ts` does, is right, and `mime_artist` is its own puzzle.

### A near-miss worth keeping: this note nearly cost the whole file

Writing this section truncated `open-questions.md` to **zero bytes**, and the truncation was
committed. `io.open(path, 'w')` empties the file before anything is written, so a `UnicodeEncodeError`
part-way through the string — a `\ud83d\udcdd` escape, an unpaired surrogate — left nothing behind.
Recovered with `git show <commit>^:steering/open-questions.md`.

**Write to a temporary file and move it into place, or write the text with the Write tool.** Never
open a steering file for writing with a payload that has not already been built.

## 11. `Splitnotes` — the zone count and the boundary convention, both settled

Looked at after the drum work turned up `a_kit_1`'s ride sitting in a zone its own base note is
outside. That part is a red herring and this file already says why (the base-in-zone test measures
the sound designer, not the engine). Two other things came out of it.

### The zone count comes from the bounds, not the samples — FIXED

`resolveSlot` was being handed the number of slots that hold a sample. The zone count is the number
of **leading non-zero entries in `Splitnotes`**. On **62 of 68** instruments those are the same
number, which is why it went unnoticed; the six that differ do so for two distinct reasons:

- `conga`, `djembe`, `dumbek`, `ukulele` carry **spare slots** — six bounds
  (`87,60,48,36,24,12`) against seven samples, the seventh's base note out of sequence with the rest.
- `mime_artist` has **one** bound and four samples, with `Numstack` **5**: its slots are stack
  layers, not zones.

⚠️ **Nothing sounds different.** The invented zones sit below the last bound, so they were
already unreachable: **zero of the corpus's 2,027,633 notes change slot.** What they did was show up
as eight phantom "unreachable slots" and make the rule look broken when it was not. Counting bounds
leaves exactly one — `ukulele`, whose bounds are `87,60,40,40,16,12`, a genuinely empty zone in the
game's own data.

⚠️ `mime_artist` is also a warning about the unison stack as implemented: it layers **one**
sample `Numstack` times, and this instrument has four distinct samples with `Numstack` 5. Whether a
stack's layers can be different samples is unmeasured, and if they can, `dev/render-level.ts` is
wrong for it.

### `<` versus `<=` — SETTLED from the engine: strict

Found by re-scanning the PRX for **indexed** addressing. The first scan looked only for
`[reg + disp]` and concluded the PRX never touches `Splitnotes`; the walk uses
`[rdx + rax*4 + 0x4c4]`, so it was invisible. **A negative result from a pattern scan is only as
strong as the pattern.**

The array's home in the PRX block comes from the eboot's builder at `v0x2a1190`, which maps the
`RInstrument` onto the block the DSP receives:

```
memcpy(r14+0x4e8, rbx+0x110, 0xd8)     ; the 27 Params
r14+0x4c0 .. r14+0x4e3  <- rbx+0xe8    ; Splitnotes, nine int32
r14+0x4e4               <- rbx+0x10c   ; Numstack
slots: rbx+0x48 + 0x10*i  ->  r14+0x84 + 0x98*i
```

and the walk itself is at `0x05a0`, repeated identically at `0x0a40`:

```
bextr ecx, r12d, 0x708          ; note = bits 8..14 of the note word
xor   eax, eax                  ; i = 0
loop: cmp eax, 7
      jg  done                  ; i > 7 -> slot 0
      cmp [rdx + rax*4 + 0x4c4], ecx   ; splitNotes[i + 1] vs note
      lea rax, [rax + 1]
      jg  loop                  ; keep going while splitNotes[i + 1] > note
      dec eax
      mov r8d, eax              ; slot = i
```

- **The comparison is strict**, so a note on a bound takes the zone **above** it. That settles the
  22.2% (215,449 of 968,829 corpus notes sit exactly on a bound) in favour of what the code already
  did — though the reason recorded for it was a base-in-zone argument, which is the reasoning this
  same file warns against. It was right by luck.
- **The walk starts at `splitNotes[1]`** (`0x4c4` against an array at `0x4c0`), so `splitNotes[0]`
  is a ceiling that is never compared.
- **The cap is a fixed 8**, not a slot count. Our extra clamp to the slots actually held never
  changes the answer: entries past the last real bound are zero and `0 > note` is false.

⚠️ **The note is the RAW field.** `bextr ..., 0x708` takes bits 8..14 of the note word
directly — the scale quantiser applies to the *pitch*, not to the slot choice, and the renderer was
passing the quantised note. Only 185 corpus notes are on a non-chromatic scale and none changes
slot, so nothing sounds different today; a project authored in a scale would diverge. Fixed anyway.

### The old note on this question, kept for the method

The two differ exactly when a note sits on a bound, and **215,449 of 968,829 corpus notes on
multi-slot instruments do** — across 47 of the 68 instruments. This is not a detail.

**The synth PRX cannot settle it**: `fmodextinput.prx` never reads `Splitnotes`. A scan of every
structure offset it touches below the parameter block at `+0x4e8` finds exactly one field, `+0x4e4`
= `Numstack` (the stack loop's bound at `0x1c0d`). So the slot is chosen eboot-side, in code that
has not been located.

Two engine-independent checks were run and **neither is decisive**:

| check | `<` | `<=` |
|---|---|---|
| unreachable zones, with the zone count fixed | 1 (ukulele) | 1 (ukulele) |
| corpus tracks reaching more distinct samples | 5,657 | 3,900 |

The second leans toward `<` and that is all it does. `<` stays because it is what was already
there — **not because it was proved**, and the earlier justification for it in `instrument.ts` was
a base-in-zone argument, which is the reasoning that same file warns against.

**To settle it:** find the eboot's slot walk. The lead is whatever builds the block the PRX
receives, since that block has `Numstack` at `+0x4e4` and the 27 parameters at `+0x4e8`.

## 7. FMOD's pan law — the resampler half is ANSWERED

**RESOLVED, 2026-09-01: the sampler interpolates linearly and mipmaps by octave.** It is not
`fmod_dsp_resampler.cpp` at all — the sequencer's sampler is `sub_0x3740` in `fmodextinput.prx`, two
taps on int16 scaled by `1/32768`, with the source switched to a ÷2 or ÷4 pre-decimated copy once the
pitch ratio reaches 2.0 or 4.0. Read the disassembly and the constants in
[sequencer-data-model.md](sequencer-data-model.md). Consequences already applied: the default
interpolator is `linear`, and the mipmapping is a **new** thing to implement — it is what stops
linear from sounding as bad as the table below says.

**RESOLVED too, 2026-09-01: the pan law is LINEAR.** `left = 1 - pan`, `right = pan`, read off
`0x2d39`–`0x2dda` where the voice's pan becomes the two per-channel factors. It came out of tracing
LFO 3, which writes that same value. Amplitudes sum to 1 rather than powers, so a sound dips about
3 dB crossing the centre — the worse-sounding law, and the game's.

⚠️ `panGains` had assumed equal-power since early on. Corrected, along with the five tests that
depended on the old `sqrt(1/2)` centre factor.

**This question is closed.**

---

The measurement that promoted this question is kept below, because it is still the reason the
choice matters. SNR against an analytic sine, 22050 Hz source at `playbackRate` 0.5:

| source Hz | nearest | linear | cubic | sinc8 |
|---|---|---|---|---|
| 440 | 27.1 | 57.1 | 107.8 | 87.6 |
| 2000 | 13.9 | 30.9 | 55.4 | 80.2 |
| **4000** | 8.0 | **19.0** | 32.0 | **72.0** |
| 8000 | 2.3 | 7.7 | 10.8 | 43.1 |

19 dB at 4 kHz is a 16% amplitude error, and a piano attack is full of 2–8 kHz. `sinc8` was the
default on the reasoning that it added least of its own character while the question was open.

⚠️ **That reasoning was right and its conclusion was wrong**, which is worth keeping as a lesson:
"adds least character" is a tiebreaker, not evidence, and it survived four sessions because nobody
went and read the sampler. Clean was never the goal — matching the game is, and the game is linear.
The table is now a statement about *how much* the mipmapping has to do, since without it linear
would sit at 19 dB on exactly the notes that need it most.

## 2b. `EchoTime`'s unit — SETTLED: eight steps per unit

`v0x1c5d2d`-`v0x1c5d3a` stores `EchoTime * 0.5` into the audio state at `[state+0x1a30]`, and
`fmodextinput.prx` `0x0faa` turns that into a delay:

```
eax = (int)(stored * 16 + 0.5)       ; round to a whole number of steps
ecx = (int)(720000 / tempo)          ; frames in one step
ecx = ecx * eax
ecx = ecx & ~0xf                     ; aligned down to 16 frames
```

`stored * 16` is `EchoTime * 8`, so the delay is **`round(EchoTime * 8)` steps** — eight steps, two
beats, per unit of the field.

The corpus is the check and it is a clean one: `EchoTime` is **2.00 on 189 of 338 sequencers**,
which is 16 steps — **a whole bar** — 1.00 on 95 (half a bar) and 1.50 on 47. Bar-relative delays are
what a musician sets, and no other reading produces them.

⚠️ **Two wrong readings preceded this.** First `EchoTime * 0.5` seconds, which is
tempo-independent and cannot be right in a tempo-locked sequencer. Then **beats**, argued from the
corpus's musical detents — right that it was musical, wrong by a factor of four. The corpus said
*which family* of answers was plausible; only the engine said which member.

## 3b. Swing — SETTLED: alternate steps stretch and squeeze by `swing/2`

`fmodextinput.prx` `0x0be3`-`0x0c2e`, with `[state+0x1a2c]` holding `Swing` (clamped to 0.99 on the
way in at `v0x1c5d0c`) and `[state+0x1a4c]` the running step position:

```
L  = 720000 / tempo                        ; the step's nominal length
L += L * swing * 0.5 * table[floor(position) & 1]
```

The table at `v0x4530` is **`[1, -1]`**, so an even step stretches to `L * (1 + swing/2)` and the odd
step after it squeezes to `L * (1 - swing/2)`. **The pair still lasts `2L`**, so swing moves the
off-beat without ever drifting against the bar. At `swing = 1` the ratio is 3:1, and the field is
clamped just below 1 rather than at it.

13 of 338 corpus sequencers use it, up to 0.75. `src/core/swing.ts` implements it and every note
position, duration and automation point in the renderer goes through `swungFrame`.

### And a constant that was being assumed

`720000 / tempo` is the step length in frames. At the engine's own default tempo of 125 that is
**5,760**, and `48000 * 60 / (125 * 4)` is 5,760 too — so **four steps to the beat** is measured now,
not assumed, and it is measured at a 48 kHz output rate.

## 5b. How the ÷2 and ÷4 copies are produced — SETTLED: an int16 pair average

The builder is `fmodextinput.prx` **`0x1320`** — a function with no frame pointer, which is why
earlier prologue scans walked past it. It was found by aligning a disassembly on a known instruction
(`cmp dword ptr [rdi + 0x78], r8d` at `0x1325`) and stepping the start offset until it decoded, which
is the technique in the method note.

```
0x1322  r8d = [rdi]                          ; the sample's length
0x1325  cmp [rdi + 0x78], r8d ; jle          ; keep the running maximum
0x1340  len/2 -> [rdi+0x28], [rdi+0x40]      ; the halved copy's length
0x134d  len/4 -> [rdi+0x50], [rdi+0x68]      ; and the quartered one's
0x13ae  esi = (int16)src[2i]
0x13b9  edx = (int16)src[2i | 2]             ; the next frame of that channel
0x13bd  edx += esi
0x13f4  ebx = edx; ebx >>>= 31; ebx += edx; ebx >>= 1
0x13fd  dst[i] = (int16)ebx
```

So each copy is a **plain average of adjacent frames**, which is what `decimateBy2` already did. Two
refinements come out of the code:

- The `| 2` rather than `+ 1` is because the buffer is **interleaved stereo** — `2i` and `2i|2` are
  consecutive frames of the *same* channel, and `0x1400`-`0x1429` repeats the whole thing on the odd
  elements for the other. Per channel it is exactly `(a + b) / 2`.
- ⚠️ **The arithmetic is int16 and rounds toward zero.** The `shr` by one after adding the sign bit
  is a signed halve that only works because the store keeps the low 16 bits, so every output lands
  back on the sample grid. `(a + b) * 0.5` in floats differs by under an LSB — still a difference the
  brief cares about, and `decimateBy2` now does it the engine's way.

⚠️ **`[rdi + 0x78]` is a running maximum of sample lengths, not one sample's length.** That matters
beyond this question: the stack loop at `0x1b11` scales `Params[2]` by the same field, so the random
start offset is a fraction of *the largest sample the instrument has loaded*, not of the one being
played. Question 12 was reasoning about it as a per-slot length; it is not.

## 14b. Where `PInstrument.reverbSend` is applied — SETTLED: it multiplies `Params[25]`

The note block carries **five floats per placement** at `+0x420 + 20i`, and they are `PInstrument`'s
own fields in its own order:

| offset | field | where it is used |
|---|---|---|
| `+0x420` | `level` | multiplied into the channel volume, `0x3b49` |
| `+0x424` | `pan` | stored at `voice+0x18`, `0x3b69` |
| `+0x428` | `echoSend` | `0x3cca` |
| `+0x42c` | `reverbSend` | `0x3d38` |
| `+0x430` | instrument index | `0x3b57`, stored as `voice+0x00` |

and the two sends are combined with the voice's own:

```
0x3cca  xmm2 = [block + 20i + 0x428]     ; PInstrument.echoSend
0x3cd4  xmm1 = [voice + 0x1c]            ; the voice's send = Params[25]
0x3ce3  xmm0 = xmm2 * xmm1
0x3d33  [voice + 0x20] = min(xmm0, 1)    ; the echo send, clamped
0x3d38  xmm1 = [block + 20i + 0x42c]     ; PInstrument.reverbSend
0x3d50  [voice + 0x24] = min(., 1)       ; the reverb send, clamped
```

⚠️ **CORRECTED, and the correction matters more than the original.** The two sends are *not* the
same shape, and neither is a product:

```
voice+0x1c = min(Params[25] + echoSend * (1 - Params[25]), 1)   ; the echo send, a BLEND
voice+0x24 = min(reverbSend, 1)                                 ; the reverb send, DIRECT
```

The `vmulss` at `0x3ce3` that suggested a product is the **`echoSend < 0` branch**: `jbe` at
`0x3ce1` sends every non-negative send straight past it to `0x3cf1`, so on real data it never runs.
Reading a fragment without resolving the jump made the rare path look like the main one, and the
resulting send was **47.8x too small** — it left the reverb inaudible and the echo silent.

**The echo's blend is the interesting half.** Because the send is `Params[25]` *plus* the
placement's share of what is left, **every instrument sends at least `Params[25]` to the echo** even
when its own `echoSend` is zero. This project sent `echoSend` alone, which is zero on 1,682 of seq
737099's 1,690 tracks — so the echo was silent where the game has it at a few per cent.

### What that unlocked

The oversized send had been forcing a compensating error the other way. The comb bank carried an
invented `1 - gain` normalisation — about **0.13** on these presets, −18 dB — and it was there to
hold down a wet path fed 47.8x too hard. With the send measured, that factor comes out and the reverb
lands at **42.4%** of the dry mix on the window a listener bracketed at 22%–216%.

Two independent things improved at once, which is the sign that the change is real rather than
tuned:

| | with the invented normalisation | without it |
|---|---|---|
| T60 as a fraction of the preset's own RT60 | 0.40–0.61 | **0.80–1.17** |

**The decay now follows the RT60 law the preset asks for.** It did not before, and nothing about the
decay was touched — only the gain that had been standing in for a wrong send.

⚠️ **One invented number is left in the reverb**: the allpass coefficient, 0.5. Everything else —
tap sets, early sets, the level law, the RT60 gain, the damping pole, the sends — is measured.

## 6f. The allpass coefficient — SETTLED: there is no allpass

Asked to find the reverb's last invented number. The answer is that the number does not exist,
because neither does the filter it belonged to.

The kernel those stages run is `fmodsmsreverb.prx` `0x1850`:

```
y      = a*prev + b*x + c*older
buf[i] = x - y                     ; in place
```

with the coefficients read from `[rec+0x30]`, `[rec+0x34]`, `[rec+0x38]` (`0x1828`-`0x1832`) and the
state at `+0x20`/`+0x24`. The eboot builds all three from **one** number at `v0x3fcefb`-`v0x3fcf9f`:

```
r = exp(-10*PI*f)
a = 2 * r * cos(2*PI*f)     ; [+0x94] -> the record's +0x34
c = -r*r                    ; [+0x98] -> +0x38, applied through a sign-flip mask
b = r*r + 1 - a             ; [+0x9c] -> +0x30
```

`a = 2r cos(w)` with `c = -r²` is a **two-pole resonator**, and subtracting a resonator from the
signal is a **notch**. At DC the resonator's gain is `b / (1 - a - c) = 1` exactly, so the notch is
perfect there.

### And slot 8 is not a pre-delay

`f` comes from `v0x3fce8e`: **slot 8 divided by 48,000**, clamped to `[0.0004, 0.49]`. The presets use
20, 100 and 400, which map to 20 Hz, 100 Hz and 400 Hz — highpass corners, which is what a reverb
puts there. `PRESET_SLOT` called it `preDelay`, "a delay in samples at 48 kHz", and used it as one.
There is now **no measured pre-delay at all**, and the code says so rather than inventing one.

### Why the engine can afford an un-normalised comb bank

Eight feedback combs at `g ≈ 0.87` have a DC gain near **62**, and a reverb that piles up DC is what
made a `1 - gain` normalisation look necessary. The notch is the engine's answer: it removes exactly
that. The two belong together, and this project had neither.

⚠️ **The RMS-against-dry number is no longer comparable across this change.** It fell from 42.4% to
3.0% on the same window, and most of that drop is inaudible sub-20 Hz energy the notch removes.
Judging the wet level by that ratio was measuring rumble as much as reverb.

