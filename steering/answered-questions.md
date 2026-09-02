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

## 2 / 2b. The echo — SETTLED: a plain stereo delay, `EchoTime` in beats, and a hard clip

The echo is not an FMOD DSP. It lives in `fmodextinput.prx`: the block function `0x0a90` sets it up
at `0x0f6a` and calls the kernel at `0x0680`, and its ring is the 768,000-byte allocation at
`[state+0x1b18]` — **192,000 floats**, interleaved stereo, 96,000 frames, 2.0 s at 48 kHz.

⚠️ Addresses are TRUE ELF vaddrs (`file = vaddr + 0x7e0`); anything written before 2026-09-02 is
0x40 too high. See [eboot-re.md](eboot-re.md).

### The delay, and the factor of two three readings missed

```
0x0f6a  steps  = (int)floor(stored * 16 + 0.5)      ; stored = [state+0x1a30] = EchoTime * 0.5
0x0f8e  fps    = (int)(720000 / tempo)              ; frames in one step
0x0fa4  len    = (steps * fps) & ~0xf
0x0faa  len    = clamp(len, 16, 192000)
0x0fcb  cursor = (cursor + 2*n) % len                ; n frames per block -> 2n
```

`0x0680` then reads `min(2n, len - cursor)` **floats** from the ring at `cursor`, processes them as
`[L, R, L, R, …]`, and writes them back **at the same cursor** (`0x08d3`). One cursor for read and
write means the delay is one full trip round the ring, so:

**delay in frames = `len / 2`**, which is `round(EchoTime * 8) / 2` steps, which at four steps to
the beat is **`EchoTime` beats exactly**.

The decisive number is the clamp: **192,000 is the ring's float count**, not its frame count. If
`len` were a frame count the bound would have to be 96,000. Everything else about this field is
ambiguous and the corpus cannot break the tie — `EchoTime` is 2.00 on 189 of 338 sequencers, 1.00
on 95 and 1.50 on 47, and two beats, two bars and half a bar are all musical detents.

⚠️ **Three wrong readings, each of which looked settled.** First `EchoTime * 0.5` **seconds**, which
is tempo-independent and cannot be right in a tempo-locked sequencer. Then **beats**, argued from
those detents — which was the right answer for the wrong reason and was then "corrected" away. Then
**eight steps per unit** (two beats), read off `stored * 16` at `0x0f74`, which fixed the beats
reading by a factor of four and was itself a factor of two out. The lesson is narrow and useful:
`stored * 16` is a *length*, and a length means nothing until you know what it counts.

### The kernel, `0x07c0`

```
dL, dR = ring[2i], ring[2i+1]              ; the delayed stereo pair
s3 += (dL - s3) * k    s2 += (dR - s2) * k ; k = 1 - [state+0x1a40]
s1 += (s3 - s1) * k    s0 += (s2 - s0) * k ; a second, cascaded one-pole
wL, wR = EchoMix * s1, EchoMix * s0
out4[4i+0..3] = clamp(out4[4i+0..3] + {wL, wR, wL, wR}, -1, +1)
ring[2i], ring[2i+1] = fb*s1 + send[2i], fb*s0 + send[2i+1]   ; fb = clamp(EchoFeedback, 0, 0.95)
```

Two things there are worth more than the delay:

- **The wet is added to all four output channels** (`0x0846`-`0x0858` builds `{wL, wR, wL, wR}`),
  and channels 2-3 are the reverb send. **The echo feeds the reverb.**
- **The output is hard-clipped to ±1**, all four channels, once per frame (`0x0889`-`0x0891`). This
  is the only nonlinearity in the sequencer's output stage, and the reverb is therefore fed a
  clipped signal. On the reference render it touches 0.01% of frames, which is also a weak check
  that our absolute level is not far off the game's.

### Two features in the code that the game never reaches

- **Damping.** The two cascaded one-poles above, with `k = 1 - [state+0x1a40]`, on both the output
  and the feedback path (states at `+0x1b20`..`+0x1b2c`).
- **Ping-pong.** When `[state+0x1a3c] > 0.5` the write-back indices become `(2i) | 1` and
  `(2i+1) ^ 1`, so the feedback swaps L and R on every pass (`0x0866`, `0x087d`).

⚠️ **Neither is reachable in the shipped game.** `0x11fd` and `0x1207` initialise both fields to
zero and nothing writes them: a byte scan of the whole eboot finds **no store to `+0x1a3c` at all**,
and both state-upload paths (`v0x1c5cf8` and `v0x1c62b7`) write tempo, swing, `EchoFeedback`,
`EchoTime * 0.5` and `EchoMix` and skip these two. With `[+0x1a40] = 0` the coefficient is 1 and the
one-poles are pass-through. So the shipped echo is a plain stereo delay with feedback and a wet
gain — but do not "find" a filter in that loop later and wire it up.

### The parameters

| field | state | law |
|---|---|---|
| `EchoTime` | `+0x1a30`, stored as `× 0.5` | the delay, in **beats** |
| `EchoFeedback` | `+0x1a34` | clamped to `[0, 0.95]` at `0x0793`-`0x079b` |
| `EchoMix` | `+0x1a38` | a plain wet gain; the dry is not attenuated |

Across 338 sequencers `EchoFeedback` runs 0–0.9 (median 0.45) and `EchoMix` 0–1 (median 0.5).

The **send** into it is `voice+0x1c` — the instrument's own send interpolated by the note's
modulation, then offset by the placement's `2*echoSend - 1`. See the sends table in
*6 / 14. The reverb*.

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

## 6 / 14. The reverb — SETTLED: the whole DSP, read out of `fmodsmsreverb.prx`

This entry replaces everything this project previously wrote about the reverb. Most of that was
wrong, and the wrongness was structural rather than a detail here or there, so the old text is not
worth keeping even as history: what is kept below is the list of *specific* wrong readings, because
each of them was arrived at by a plausible-looking argument and could be arrived at again.

⚠️ **Addresses here are TRUE ELF vaddrs.** See the delta note in
[eboot-re.md](eboot-re.md): every PRX address written in this project before 2026-09-02 is **0x40
too high**, because `prxdis.py` used a segment offset 0x40 too small. The readings themselves were
not affected — a rip-relative operand resolves through the same delta twice — but the labels do not
match a real disassembler, and a re-check that trusts them will land mid-instruction.

### Where the parts live

| what | where |
|---|---|
| the preset table, 12 rows × 11 `int32` | eboot `v0x1062620` |
| `ReverbSetting` → preset remap, 8 entries | eboot `v0x1062830` |
| `applyReverbPreset` — pushes slots 1-10 into DSP parameters 1-10 | eboot `v0x3fd4c0` |
| the configure — slots → the plugin's parameter block | eboot `v0x3fcd50` |
| the plugin's own configure — parameter block → filter states | PRX `0x0b40` |
| the block processor — 256 frames of audio | PRX `0x14e0` |
| the four kernels, out of line | PRX `0x0910` (one-pole), `0x0960` (notch), `0x09d0` (comb), `0x0a30` (2-in mix) |

### The eleven slots

`v0x3fcd50` is the whole mapping, and it is unambiguous:

| slot | → parameter block | meaning |
|---|---|---|
| 0 | `+0x4c` | **dry** level, `10^(v/200)`. Pinned at **-800** by the constructor and never written from the table, and the conversion's floor is on `v*10 > -8000`, so it is a hard **zero**: the DSP is 100% wet |
| 1 | `+0x48` | **late** level, `10^(v/200)` |
| 2 | `+0x50` | **early** level, `10^(v/200)` **divided by 100** (`v0x3fce41`) |
| 3 | `+0x30` | tap-set index |
| 4 | `+0x34` | early-set index |
| 5 | `+0x38` | decay; RT60 = `v * 0.1` s |
| 6 | `+0x3c` | **output delay in milliseconds** — a delay line after the comb bank |
| 7 | `+0x20` | notch enable |
| 8 | `+0x28` | notch frequency: `f = v/48000`, then `/2.2` if `f < 1/96` else `/3.3`, clamped to `[0.0004, 0.49]` |
| 9 | `+0x24` | damping enable |
| 10 | `+0x2c` | damping: stores `-2π·v/48000`, and the PRX takes `expf` of it |

`[param+0x10]` is set to a literal **48000.0** at `v0x3fce4f` and `[param+0x40]` to a literal **2**
at `v0x3fce57`, so the sample rate and the channel count are hard-coded, not queried.

### The signal flow, from the block processor at `0x14e0`

```
 in L,R ──┬────────────────────────────────── * dry (= 0) ─────────────────┐
          │                                                               │
          ├─► earlyLine ─┬─ tap A ─ *(gL,gR) ─┐                            │
          │  (L and R    ├─ tap B ─ *(gL,gR) ─┼─ * earlyLevel ─────────────┤
          │   each)      └─ tap C ─ *(gL,gR) ─┘                            │
          │                                                               ▼
          └─►(L+R)*0.5 ─► damp ─► notch ─┬─► comb[2..n-1] ────► accL ──┐  out L,R
                                         ├─► comb(taps[0])  ────► accL │
                                         ├─► comb(0.93·t0)  ────► accL │
                                         │  accR is a COPY of accL here │
                                         ├─► comb(taps[1])  ────► accR │
                                         └─► comb(1.06·t1)  ────► accR │
                                                                       │
                              accL,accR ─► delay(slot6 ms) ─► * lateLevel
```

Line by line:

- **`0x1695`-`0x173e`** — the input is downmixed to mono, `(L + R) * 0.5`.
- **`0x1780`** — a one-pole, `y = a*y + b*x`, on that mono signal. `b` is `[state+0x14]` and `a` is
  `[state+0x18]`, built at `0x0b73`-`0x0ba5` as `a = expf([param+0x2c])`, `b = 1 - a`, or as
  `b = 1, a = 0` when damping is disabled. **This is the same coefficient pair every comb damps
  with**, and this project did not have this filter at all.
- **`0x1810`** — the notch, `out = x - (a*y1 + b*x + c*y2)`, **in place on the input**, gated by
  `[param+0x20]`. The eboot builds the three coefficients at `v0x3fcefb`-`v0x3fcf9f`:
  `r = exp(-10πf)`, `a = 2r·cos(2πf)`, `c = -r²`, `b = r² + 1 - a`.
- **`0x1960`** — `[state+0x510] = tapCount - 2` mono combs, on `taps[2..count-1]`, all accumulating
  into one buffer. The kernel is `0x09d0`:

  ```
  x       = delay.read()
  acc[i] += x                       ; the RAW delayed sample is what accumulates
  y       = a*y + b*x
  delay.write( gain * (y + send) )  ; the gain multiplies the input too
  ```

- **`0x1a41`** — the right accumulator is made as a **copy of the left**, after the mono combs and
  before the pairs. That copy is the entire stereo width of the late field.
- **`0x1b10` / `0x1c20`** — `[state+0x514] = 2` pairs of combs, the same kernel: pair 0 is `taps[0]`
  into the left accumulator and `taps[1]` into the right, pair 1 is `0.93·taps[0]` left and
  `1.06·taps[1]` right. The two ratios are the table at `v0x2bc8`.
- **`0x1d2a`-`0x1d90`, `0x1e0c`-`0x1e73`** — each accumulator is written into a delay line of
  `slot6` milliseconds and the **delayed** value is what gets `lateLevel`.
- **`0x1ef0`-`0x2051`** — the early reflections: two delay lines fed by the **raw L and R input**,
  three taps each, every tap panned into both outputs by a gain pair, the lot scaled by
  `earlyLevel`. Both lines have identical lengths, identical tap offsets and identical gains, so one
  line fed `L + R` is exactly equivalent.

Every comb gain is `powf(10, -0.003 * ms / rt60)` (`0x0d30`, `0x0d90`, `0x0fba`, `0x10e9`), with
`ms` the stage's own length in milliseconds and `rt60 = slot5 * 0.1` s. Every delay length is
`round(rate * ms / 1000)` (`0x0ec9`: multiply, add 0.5, `vcvttss2si`).

### The early-reflection rows

Nine floats: `[d0, d1, d2, g0, g1, g2, p0, p1, p2]` — three delays in milliseconds, three gains,
three pan positions in 0..1 (`0x1254`-`0x136b`).

- Fixed offsets are added to the delays before conversion: **+0.051, +0.151, +0.078 ms**, then
  `vcvttss2si` — truncation, unlike every other length in the DSP, which rounds.
- The pan law is **linear**, `L = (1 - p)·g` and `R = p·g`, applied because `[param+0x40]` is 2.
- ⚠️ **The delay-to-gain pairing is not positional.** `0x1382`-`0x13ef` sorts the three delays and
  permutes the gains as it goes, and the permutation is not the identity even when nothing needs
  swapping. All seven rows are already sorted ascending, so one branch is always taken, and it pairs
  `d0` with `g1`/`p1`, `d1` with `g0`/`p0`, `d2` with `g2`/`p2`. Do not "fix" this by reading it as
  positional; and do not trust it for a hypothetical unsorted row, because the code there is
  self-contradictory.

### The sends, and how the wet gets back to the mix

`fmodextinput.prx` `0x3b4f`-`0x3d10` fills three floats on the voice:

| field | source | used for |
|---|---|---|
| `voice+0x1c` | the instrument's Params pair at `+0x5b0`/`+0x5b4`, interpolated by the note's modulation, then offset by the placement's `2·echoSend - 1`, clamped to 0..1 | the **echo** send |
| `voice+0x20` | the instrument's Params pair at `+0x5b8`/`+0x5bc` | **nothing.** It is stored and never loaded — a grep of the whole PRX finds the store at `0x3baf` and no read |
| `voice+0x24` | the placement's `reverbSend` at `[block+0x42c]`, clamped to 0..1 | the **reverb** send |

The mixer at `0x2f00`-`0x2f8f` then writes, per frame:

```
out4[4i+0] += L                 out4[4i+2] += L * voice[0x24]      ; the reverb send bus
out4[4i+1] += R                 out4[4i+3] += R * voice[0x24]
                                out2[2i+0] += L * voice[0x1c]      ; the echo's own input
                                out2[2i+1] += R * voice[0x1c]
```

`out4` is the DSP's own output buffer — `0x0170` asserts 4 in and 4 out channels — and `out2` is a
stack `alloca` inside the block function, so the echo is internal and the reverb send leaves the
plugin on channels 2-3. **The send is post-fader and post-pan**: it is the voice's finished stereo
output, scaled.

⚠️ **The echo's placement field is a bipolar offset, not a blend.** `v0x1607e9` writes
`2*echoSend - 1` into the note block, and `0x3ca1` applies it as `v + o·v` when `o < 0` and
`v + o·(1 - v)` when `o >= 0`. So 0.5 leaves the instrument's own send untouched, 0 mutes it and 1
forces unity.

### The wrong readings, and what produced each

These are worth more than the corrections, because every one of them looked reasonable:

| the claim | why it was believed | what it actually is |
|---|---|---|
| a Schroeder **allpass cascade** after the combs, with a 0.5 coefficient | the kernel at `0x0960` subtracts its own output from the signal, which is the shape of an allpass | with `a = 2r·cos(w)` and `c = -r²` the recursion is a **resonator**, so `x - y` is a **notch** — and it runs on the **input**, not the output |
| slot 8 is a **pre-delay in samples** | it is small, and reverbs have pre-delays | it is the **notch frequency in hertz**. The real delay is slot 6, in milliseconds, and it sits **after** the combs |
| slot 1 is the early level and slot 2 the late level | both are millibel levels and there was nothing to tell them apart | slot 1 is **late**, slot 2 is **early**. Getting this backwards also moved the `/100` onto the tail, which silenced it |
| the early rows' columns 6-8 are the gains, and 3-5 "are not levels" | 46, -60 and 21 are absurd as gains | 3-5 **are** the gains; they multiply an early level of order 0.003, because of the `/100`. Columns 6-8 are pan positions |
| each comb's contribution needs a `1 - gain` (or `sqrt(1 - gain)`) normalisation | eight feedback combs summed are ~9x unity at DC, and the preset's own wet level then means nothing | the kernel sums the raw delay outputs with **nothing** in between. The level is `lateLevel` and `earlyLevel`, and those were being read off the wrong slots |
| `PInstrument.reverbSend` multiplies the instrument's `Params[25]` | a `vmulss` sits next to the reverb send's clamp | that multiply is on the **echo** path, and it is the negative branch of the bipolar offset. The reverb send is the placement's field alone |

And two more that were process errors rather than misreadings:

- **The renderer called `process()` twice per frame**, once per channel, through one instance. Every
  delay line ran at twice the frame rate and both channels shared one state. `Reverb.process` is
  stereo now.
- **A scan for the level fields was run against the wrong PRX** (`fmodextinput` instead of
  `fmodsmsreverb`) and concluded "the PRX never reads them", which sent the search after an
  imaginary output matrix in the eboot.

### What is still not modelled

- The engine works in **256-frame blocks** and rounds every delay buffer up to 1 KB, so a tap
  shorter than 256 samples cannot behave as a plain per-sample delay there. Tap set 10's shortest is
  5.019 ms = 241 samples, so preset 3 (`ReverbSetting` 0) is the one place this could show.
- What gain, if any, the eboot puts on the connection from the sequencer DSP's channels 2-3 into the
  reverb, and from the reverb's output into the master. `src/audio/effects.ts` assumes unity at both
  ends. This is the last unknown in the reverb, and it is a constant.

---

## 16. The board cell of a component on an **open** circuit board — SETTLED: the delta in the board's basis

A closed circuit board stores each component as a `CompactComponent`: a Thing reference and a flat
`x, y, angle, scaleX, scaleY, flipped`. An **open** one stores none of that. While the board is
open in the editor the game promotes its components to real Things parented to the board, leaves
`PMicrochip.components` empty, and the only thing left of the layout is a 4×4 per Thing. Reading
just the compact list therefore finds a sequencer with **no instruments at all** — on one corpus
level that is five sequencers and 1,030 placements silently missing.

`boardCell` in `src/core/level.ts` recovers the pair; `dev/board-probe.ts` is the measurement.

### What the answer is

The cell is the world-space translation delta **expressed in the board's own basis**. The board
matrix is column-major, so that is three dot products — column *i* against the delta, divided by
that column's squared length so a scaled board still lands on integers. No quaternion appears
anywhere.

### Why a frame change is needed at all, since it looks unnecessary

A circuit board normally hangs square on the screen, so subtracting the two translations looks like
it should be enough, and it is tempting to conclude that the engine cannot be doing anything as
baroque as inverting a transform just to lay out a sequencer. **Measured, the bare delta is
wrong**: it puts only **78.93%** of the corpus's 1,030 open-board placements on a cell. One of the
seven open sequencer boards is attached to something rotated in the world, and every component on
it comes out on a fractional cell. In the board's basis: **100.00%**, worst fractional part 0.0004
of a cell.

So the frame change is not decoration — but it is also not a quaternion. A board is a Thing in the
world and can be turned with whatever it is stuck to; expressing a child's offset in its parent's
axes is the cheapest possible way to say that, and it is what the columns of the parent's matrix
already are.

### What pins the units and the origin — nothing had to be calibrated

Over all 61,128 instrument placements on **closed** sequencer boards:

- every stored `x` is an exact multiple of **52.5** — 100.00%
- every stored `y` is an **odd** multiple of 52.5 — 100.00%

The asymmetry is the layout itself: steps are 52.5 apart so an instrument can sit on any multiple,
rows are 105 (`CELL_HEIGHT`) and a component sits at the row's *centre*, which is always odd. That
pair of properties is a fingerprint, and it is what makes the open-board result checkable without
any ground truth to compare against: run the formula over the 1,030 recovered placements and
**1,030 of 1,030** carry the same signature. A wrong origin, or a wrong scale, could not.

`dev/verify-levels.ts` now also asserts the stronger structural property across the whole corpus —
**62,158 board cells whole and distinct**, stored and recovered alike. A board cell holds one
component, so two components landing in one cell would mean the frame was wrong.

### The wrong turn, kept

The Java tool this walk replaced computed it as

```java
thing.getTranslation().sub(container.getTranslation())
     .rotate(thing.getNormalizedRotation(new Quaternionf()).invert())
```

which scored the same 100.00% on this corpus — and was wrong twice over. It rotated by the
**child's** rotation rather than the board's; those agree only because a component lies flat
against its board, so it is right by accident and would part company with the engine the moment a
component were turned on the board. And it normalises the rotation instead of undoing the scale, so
a scaled board would come out scaled. Both are invisible on the ten levels available, which is
exactly why the property test above matters more than the agreement does.

⚠️ The instinct that produced this entry was *"it seems absurd that the game transforms rotations
just to work out the sequencer's structure"* — and it was half right in a useful way. The
quaternion round-trip is indeed absurd; the frame change is not, and the corpus is what separated
the two in about ten minutes.
