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

### The engine ramps it, and re-reads it every chunk — MEASURED AND IMPLEMENTED 2026-09-03

⚠️ **This section said the opposite until today, and the reason it gave was a reason and not a
measurement:** "modulation is not interpolated, because it feeds things read once when the voice
starts". The whole chain is now read out of `fmodextinput.prx`, and every step of it treats the
modulation exactly as it treats volume and pitch.

`sub_0x3930`, the note-block walker, sets three slide rates from one span and one reciprocal:

```
0x3e50   xmm6 = 1 / span                    ; span = pos(next) - pos(current), thirds allowed
0x3e66   [rbx+0x2c] = (nextVolume - voice.volume) / span
0x3e78   [rbx+0x30] = (nextPitch  - voice.pitch ) / span
0x3e8a   [rbx+0x34] = (nextMod    - voice.mod   ) / span
```

and zeroes all three when there is no next record (`0x3f06` clears `+0x2c` and `+0x30` in one
8-byte store, `0x3f0e` clears `+0x34`).

`sub_0x1c60`, the per-voice renderer, then consumes them:

```
0x1eb2   xmm0 = [r12+0x2c]                  ; volumeSlide
0x1eb9   xmm1 = [r12+0x34]                  ; modulationSlide
0x1ec0   xmm2 = dt * xmm0
0x1ec4   xmm3 = dt * xmm1
0x1f3b   [rbp-0xa60] = [r12+0x0c] + xmm2    ; volume this chunk
0x1f4a   [rbp-0xaa4] = [r12+0x28] + xmm3    ; MODULATION this chunk
```

and reads that stashed modulation **four times** afterwards — `0x208e`, `0x222c`, `0x25d5`,
`0x2713` — which are the `Params` evaluations.

**The cadence, which is what decides how expensive fixing this is.** `sub_0x1c60` is called in a
loop over the voice array inside `sub_0xa90` (stride `0xd0`, running to `0x1a28` — the 32 voice
records), and `sub_0xa90` is called once per DSP block from `sub_0x170`, the read callback, which
asserts `r8d == 4` and `r9d == 4` and traps with `int 0x41` otherwise — the 4-in/4-out DSP.
`sub_0xa90` itself walks the block in chunks, decrementing a frame counter at `0x0c99` and
advancing the output pointer by four channels. So the modulation is advanced and the parameters
re-evaluated **once per chunk per voice** — not per sample, and not once per voice.

**How much it was worth, measured before building it.** 34,449 notes in the corpus move their
modulation, and on **30,170 of them (87.6%) that moves some parameter by 0.35 or more**. The widest
swings over a single note are cutoff **0.906**, resonance **0.892**, level **0.591**, drive
**0.390**, and **26 of the 27 parameters move on some note** — only LFO 3's spread never does. So
it could not be done for a chosen few.

**How it is done.** `VoiceSpec.morph` carries the note's modulation ramp and the instrument's
`Params`, and `Voice.render` walks the buffer in 128-frame chunks, re-deriving between them — the
filter settings, both ADSRs, the LFO rates and depths, the drive and the output level. That mirrors
the engine, which re-derives inside its own per-voice renderer.

⚠️ **The modulation is what gets interpolated, not the things built on it.** `evaluateParam` is
affine in the modulation, so interpolating either end would give the same numbers — but
`evaluateAdsr` squares its times and the ladder squares its cutoff, so interpolating *those* would
not. The derivation is redone from the interpolated modulation, which is also what the engine does.

**Two things left where a caller's intent has to win over the modulation**: `noKeyTrack`, the A/B
that forces the filter's key tracking to 0, is honoured by leaving it at 0 rather than letting the
modulation put it back; and the output level moves as a *ratio* against the value the spec was built
with, because the spec's `gain` also carries the track level, the channel volume, the headroom, the
velocity and the stack correction, none of which the modulation owns.

**The echo send moves too, and it is the only send that can.**
`voice+0x1c = clamp01(bipolar(Params[25], 2*echoSend - 1))`, so the instrument's own send is bent
by the placement's field; `voice+0x24` is `reverbSend` alone and the modulation never touches it.
The buses belong to the mixer, so a voice now reports one span per chunk with the send that was
live for it, and the mixer sums each span at its own level. `Voice.maySend` decides whether the
buses are needed by looking along the whole ramp, because a voice can open at send 0 and rise.

⚠️ **And here is what that is worth, which is almost nothing — the figure recorded here before
was measuring the wrong thing.** `Params[25]` in isolation swings up to **0.210** across the
affected notes, and that is the number this section used to quote. The *effective* echo send swings
at most **0.045**, on **68 notes in 5 sequencers** of the whole 22-level corpus. The reason is the
bipolar offset: a placement with `echoSend == 0` gives offset **-1**, and `base + (-1)*base` is
**0** whatever the modulation does. Most placements are exactly that, so the instrument's send is
muted before the modulation gets a say. 25 s of `Ascetic` is bit-identical with and without the
send half of this change.

❗ **So do not cite `Params` swings as audible weight without the placement.** The whole audible
weight of the modulation fix is in the filter, the level, the LFOs and the drive; the send is
complete for correctness and inert in practice.

**Verified from both ends.** 25 s of `Indestructible` — 6,126 notes, not one of them moving its
modulation — renders to the **same md5** with and without this code, which is the invariant that
lets it ship. 25 s of `Ascetic`, whose 519 moving notes are 3.6% of it, differs on **30.3% of
frames** with a peak difference of 0.1419 against a signal RMS of 0.0751, and the difference's own
RMS is only **22 dB** below the signal. It was not a subtlety.

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

The array's home in the PRX block comes from the eboot's builder — whose entry is `v0x2a1144`;
`v0x2a1190` is mid-function and disassembles as garbage — which maps the
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

The builder is `fmodextinput.prx` **`0x12e0`** — a function with no frame pointer, which is why
earlier prologue scans walked past it. It was found by aligning a disassembly on a known instruction
(`cmp dword ptr [rdi + 0x78], r8d`, at `0x12e5`) and stepping the start offset until it decoded, which
is the technique in the method note. ⚠️ Its addresses were recorded 0x40 high, like every PRX
address from before 2026-09-02; they are corrected here.

```
0x12e2  r8d = [rdi]                          ; the decoded sample's length
0x12e5  cmp [rdi + 0x78], r8d ; jle          ; CLAMP the stored length down to it
0x12eb  [rdi+0x78] = r8d                     ; ... and when that fires,
0x12ef  [rdi+0x7c] = 0                       ;     drop the loop start
0x12f6  [rdi+0x80] = 0                       ;     and the loop length
0x1300  len/2 -> [rdi+0x28], [rdi+0x40]      ; the halved copy's length
0x130d  len/4 -> [rdi+0x50], [rdi+0x68]      ; and the quartered one's
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

⚠️ **This entry used to say `[rdi + 0x78]` was a "running maximum of sample lengths, not one
sample's length". Both halves were wrong**, and the correction is in *12b* below. It is one slot's
own length, and the update is a **minimum** — `jle` skips the store when the field is already the
smaller, so it can only be lowered. `rdi` is a single slot record throughout this function and the
value it is compared against is that same slot's `[rdi+0x00]`, so nothing accumulates across slots.

The wrong reading had a real consequence: question 12 was corrected *away* from "a per-slot length",
which is what it is.

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
| `voice+0x20` | the instrument's Params pair at `+0x5b8`/`+0x5bc`, i.e. **`Params[26]`, the drive** — not a reverb send, which is `Params[25]` at `+0x5b0` | ⚠️ **This row used to read "nothing, it is stored and never loaded". Wrong.** It is read at `0x1ee0`, by a `vbroadcastss` — which is why a grep for `vmovss` missed it — and drives a soft-clip waveshaper. See *21* in [open-questions.md](open-questions.md) |
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
- ~~What gain, if any, the eboot puts on the connection from the sequencer DSP's channels 2-3 into
  the reverb, and from the reverb's output into the master.~~ ✔ **ANSWERED 2026-09-05: there is no
  connection and no gain.** `Channel::addDSP` (eboot `v0x3e67f9`) puts the reverb in the same
  channel as the sequencer DSP, and its description declares `channels = 0`, so it inherits the
  sequencer's **4**. Its read callback `0x23a0` asserts 4 in and 4 out; `0x20e0` de-interleaves
  **channels 2-3 only** and writes `(dry + wet, dry + wet, 0, 0)` back into the same interleaved
  buffer. The two DSPs share one buffer, the send lanes are read in place and then cleared, and
  `src/audio/effects.ts`'s unity at both ends is right. See *22* for the write-back's instructions
  and for why the cleared lanes matter (they are what stops the send reaching the surrounds).

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

---

## 17. What a voice occupies in the 32-voice pool — SETTLED: not what the note says

The engine has 32 voice records and steals the quietest when they run out (question 6's allocator,
`fmodextinput.prx` 0x1640). `src/core/render.ts` fed that allocator one entry per note, ending at
the note's **written** end. Both halves of that were wrong, and on a dense sequencer the error is
not subtle.

### What a note really occupies

- **A one-shot runs past its note.** A slot whose sample has no loop is not gated (question 10), so
  it holds its record for `sampleFrames / playbackRate` output frames — and the rate is not known
  until the instrument is loaded and its key zone resolved, which is why the pool was never told.
- ❌ **"`Numstack` layers are `Numstack` voices" — WRONG, corrected 2026-09-04.** It is one
  record per NOTE however many layers it has. See the correction at the end of this section.

`Ascetic`'s `mime_artist` is both at once: five layers, loopless, 68 semitones below its sample's
base note. The pool was told "two steps"; the truth was **five voices for 9.5 seconds**. 352 notes
in the first 24 seconds meant **1,760 simultaneous voices** in a 32-voice pool, and the allocator
reported nothing stolen.

### And a stolen voice has to actually stop

`endFrame` closed the note's gate, and a one-shot ignores the gate by design — so even when the
allocator did take a record away, the voice carried on. `VoiceSpec.cutFrame` is now separate from
`endFrame`: the gate is the note's, the cut is the allocator's, and nothing ignores the cut. That is
what the engine does, since the caller simply overwrites the record it was handed.

### Measured, on `Ascetic` (uid 723339, tempo 240, 1,150 tracks, 14,499 notes)

| audio rendered | mix, before | mix, after |
|---|---|---|
| 6 s | 0.93 s | 0.48 s |
| 12 s | 4.90 s | 1.47 s |
| 24 s | 14.88 s | 2.98 s |

⚠️ Those "after" figures are with the **unbounded** one-shot rule still in place, so the pool
was busy stealing 2,276 of the song's 14,499 notes to make room for a drone that should never have
existed. Bounding the exemption (question 10, refuted the same day) took the same 24 s to **0.97 s**
and the stealing to **zero**. The accounting fix below is right either way; it is what made the
other bug visible instead of merely audible.

⚠️ Read the **shape**, not the ratio. Before, the cost per second of audio was 0.155, 0.408, 0.620 —
rising, because every extra second added notes whose voices never went away, so the work grew with
the square of the length. After: 0.080, 0.123, 0.124 — flat. The whole 339-second song now renders
in **26 s** (13× realtime); on the old curve it was heading for tens of minutes, which is what was
reported as "estremamente lento".

**The general rule this earns:** when a cap exists to reproduce the engine's behaviour, check that
it is being told the truth before concluding the engine is generous. "0 of 934 notes cut short by
voice stealing" on a passage with 1,760 sounding voices should have been read as an accusation
against the accounting, not as a fact about the music.

---

## 18. `Notes.y`, `Key` and `Splitnotes` — SETTLED: one numbering, and `Key` really transposes

This was open question 4, ranked as the one still able to transpose an entire imported level. It
was. Three separate things, two measured from the corpus and one from the binaries.

### `y` and `basenote` are the same numbering

The toolkit annotates `basenote` as MIDI note numbers and `Splitnotes` as **piano key** numbers —
20 apart — and this project compared them directly, so one annotation had to give.

`dev/pitch-probe.ts` asks the corpus two questions:

| | |
|---|---|
| zones whose own sample's base note falls inside them | **188 of 249 (75.5%)** |
| the same with `Splitnotes` shifted by +20 | **48 of 249 (19.3%)** |
| median of (note played − base note of the slot it resolves to), over **953,221 notes** on 44 instruments | **0** (mean 0.14) |

The 24.5% of zones that do not contain their own base note are all one shape — `piano`,
`honky_tonk_piano`, `space_piano` and friends put every base note *above* its zone, i.e. they are
voiced to always transpose downward, which steering already recorded as a voicing style rather than
an error. And the per-instrument medians scatter from −18 (`square_wave`) to +28 (`robot`): a
numbering mismatch would be the **same constant on every instrument**, and it is not. It is
composers choosing where to play.

### `Key` transposes by `key mod 12`, and 0 is the untouched default

The DSP half was already in `sequencer-data-model.md`: `voice.pitch = quantise(note, scale) +
blockRoot − 12`, at `fmodextinput.prx` `0x3c4e` and `0x3db5`, both spelled
`lea eax, [rax + rcx - 0xc]`. On its own that only says there is a root. **What fills it is the
eboot**, at `v0x160806`:

```
mov    eax, [rdi + 0x28]     ; PInstrument.Key
lea    ecx, [rax + 0xc]      ; key + 12
cmp    eax, 0xc
cmovae ecx, eax              ; ... unless the key is already >= 12
mov    [rsi + 0x10], ecx     ; -> the block's root
mov    ecx, [rdi + 0x2c]     ; PInstrument.Scale
mov    [rsi + 0xc], ecx      ; -> the block's scale
```

The struct is pinned rather than guessed: the four fields after `+0x28`/`+0x2c` — `+0x30`, `+0x34`,
`+0x38`, `+0x3c` — are copied to the block as level, pan, echo send and reverb send, in
`PInstrument`'s own declaration order.

So the transposition is `(key < 12 ? key + 12 : key) − 12`, which over the range the corpus uses is
exactly **`key mod 12`**. The corpus uses 0 and 12..23 and nothing else, so `Key` is a note within
one octave with **C at 12**, and **0 is the untouched default** — which is what the `< 12` branch
exists to turn into C. Reading 0 as "no key" and 0 as "C" happen to agree; reading it as a literal
root would drop 96.7% of all placements by an octave.

**What this cost while it was unread:** 2,461 of the corpus's 129,696 placements (1.90%) and
**75,073 of its 3,199,788 notes (2.35%)** were being played in the wrong key — up to 11 semitones
out. Most common are +3 (1,003 placements), +2, +4 and +11.

⚠️ The order is fixed by the instruction: the scale snaps **first**, then the key adds. Quantising
after the transposition would put the note back on a root-0 scale degree, which is a different note.

### And the quantiser is at 0x240, not 0x250

`sub_0x250` in older notes is wrong by **0x10** — not by the usual 0x40 PRX delta, so it is not that
mistake. `0x250` is inside the function, at the `mov rdx, rcx` of the divide-by-12, and
disassembling from there prints convincing nonsense. The entry is a direct-call target of `0x3c4e`
and `0x3db5` and takes exactly two arguments, `edi` = note and `esi` = scale: **no key reaches the
quantiser at all**, which is why the eboot has to add it afterwards.

**The general rule this earns:** when a formula has a term supplied from outside the module you are
reading, the module cannot tell you what that term means. `blockRoot` sat in steering for a session
as a named unknown, and the answer was two instructions away in the *other* binary.

---

## 19. The key-zone walk — SETTLED: `resolveSlot` already was the engine's, and the record layout is why

Opened and closed on 2026-09-02. It was posed as *"the engine's walk is read and it contradicts the
corpus"*, and the contradiction was an off-by-one in reading the **record layout**, not in the walk.

### The walk

`fmodextinput.prx` `0x0555`-`0x0577`, and verbatim again at `0x09f0`-`0x0a14` (two note-start paths):

```
ecx = bextr(noteWord, 0x708)          ; bits 8..14, the raw note
eax = 0
loop:
  r8d = 0                             ; the zone, if the walk never falls through
  if (int)eax > 7:  goto done         ; a fixed eight bounds
  cmp  [rdx + rax*4 + 0x4c4], ecx     ; signed
  eax += 1
  if   bound > note:  goto loop
  eax -= 1
  r8d = eax
done:
```

and the zone is passed to `0x19e0`, which tail-calls `0x1a70`, where at `0x1aca` it becomes

```
movsxd rax, edx
imul   rax, rax, 0x98                 ; the slot record size
vcvtsi2ss xmm1, xmm0, [r15 + rax + 0x78]
```

— **straight into the slot array, no remapping.** That was the named next step and it came out clean.

### The DSP's instrument record, which is what settles it

| offset | what |
|---|---|
| `+0x000` | **eight slots of `0x98`**, ending at `+0x4c0` |
| `+0x4c0` | `Splitnotes[0]` — **never read by the walk** |
| `+0x4c4` … `+0x4e3` | `Splitnotes[1..8]`, the eight bounds the walk indexes |
| `+0x4e4` | `Numstack` |
| `+0x4e8` | `Params`, 27 `(x,y)` pairs |
| `0x5f0` | the record's size (`imul rdx, rsi, 0x5f0` at `0x0526`) |

`Params` at `+0x4e8` is checkable rather than assumed: `Params[11].x`, the amplitude attack, is read
at `+0x540` (`0x1f8c`), and `0x4e8 + 11*8 = 0x540`.

So **`+0x4c4` is `Splitnotes[1]`**, and `src/core/instrument.ts` had this right all along — its own
`MAX_SPLITS = 9; // 8 zones; [0] is a constant, [1..8] are the bounds` says so. Transcribing the
walk as indexing from `Splitnotes[0]` is what made the engine appear to disagree.

### The check that closed it

`test/instrument.test.ts` now runs `resolveSlot` against the loop above over **every instrument the
game ships and every note**: 68 x 128 = **8,704 comparisons, no disagreement**. It is a test rather
than a note, because the two implementations are independent and either can drift.

### What it also settles

- **`mime_artist` really does play everything on slot 0.** Its bounds are `[87,0,0,…]`, so the
  record's array is all zeros and the first comparison already satisfies `0 <= note`: zone 0,
  `pluck_a6`, base 81. The other three samples are unreachable *as zones*. Whether the engine reaches
  them as stack layers is a different question and stays open.
- **`[slot + 0x78]`** — open question 12's unknown — is a per-slot field, indexed by the zone. That
  does not say what it holds, but it does say where it lives.

### The wrong turn, kept

The literal-from-`[0]` reading was implemented, measured and reverted inside an hour. Measured over
953,221 corpus notes with `dev/pitch-probe.ts`, the median of (note played − base note of its slot)
moved from **0 to 7**, and `woodpecker` went to +35, `nylonguitar` +30, `marimba` +20. The clearest
single counter-example was `e_guitar_distorted` — bounds `[87,60,1,0,…]`, samples D5 base 62 and E4
base 52 — where it sent note 65 to the *lower* sample. **A disassembly that contradicts a
million-note corpus is a misread disassembly**, and the corpus is what caught it before the change
could ship.

---

## 12b. `[slot + 0x78]` — SETTLED: the sample length, with the loop beside it

The named next step of question 12 was "find what writes `[slot + 0x78]`". It is written in the
PRX, not the eboot, and the three fields around it read each other, so naming one names all three.

### What writes it

`fmodextinput.prx` `0x12e0`, the mipmap builder, and **nothing else in the module** — a sweep from
every function start for any instruction touching a `+0x78` field finds exactly this write, the read
in the stack loop at `0x1ad1`, the stop condition at `0x304d` and the wrap at `0x3784`.

```
0x12e2  r8d = [rdi]                  ; the decoded sample's length
0x12e5  cmp [rdi + 0x78], r8d
0x12e9  jle skip                     ; already <= it? leave it alone
0x12eb  [rdi + 0x78] = r8d           ; else clamp down to what actually decoded
0x12ef  [rdi + 0x7c] = 0             ; and drop the loop, because it cannot be
0x12f6  [rdi + 0x80] = 0             ; inside a buffer that turned out shorter
```

⚠️ A **minimum**, not the maximum this project recorded for a session. `jle` skips the store when
the field is already the smaller one, so the value can only ever be lowered, and `rdi` is one slot
throughout.

### What reads it, and what that names

`0x3780`, the sample read, wraps the position:

```
0x3784  ecx = [rdi + 0x78]           ; > 0 or there is nothing to play
0x379d  esi = [rdi + 0x80]           ; the LOOP LENGTH; <= 0 means no loop
0x37a7  r8d = [rdi + 0x7c]           ; the LOOP START
0x37ab  eax = r8d + esi              ; loop start + length = loop end
0x37af  cmp edx, eax ; jle           ; past it?
0x37b3  edx -= r8d                   ; then wrap by the loop start
```

and `0x3035` stops the voice:

```
0x303f  rax = [r14 + 0xcc]           ; the voice's zone
0x3046  imul rcx, rax, 0x98
0x304d  eax = [r8 + rcx + 0x78]      ; slot[zone]'s sample length
0x3056  vucomiss xmm0, xmm1 ; jbe    ; position past it?
0x305c  cmp [r8 + rcx + 0x80], 0     ; and no loop?
0x3067  test eax, eax ; jle          ; and a real length?
0x306b  [r14 + 4] = 0                ; -> the voice is done
```

| offset | field |
|---|---|
| `+0x00` | the decoded length, mip 0 |
| `+0x10`, `+0x38`/`+0x30`, `+0x60`/`+0x58` | the three mip buffers |
| `+0x28`/`+0x40`, `+0x50`/`+0x68` | the /2 and /4 lengths |
| **`+0x78`** | **the sample length** the player uses, clamped to `+0x00` |
| **`+0x7c`** | **the loop start** |
| **`+0x80`** | **the loop length**, 0 when there is no loop |
| `+0x84` | the root note, and the first field the eboot's builder copies (`v0x2a1220`) |
| `+0x94` | a flag the mip builder branches on |

### What it settles, and what it does not

- **`Params[2]` scales the playing slot's own sample length.** `src/core/render.ts` already used
  `slot.wav.channels[0].length`, so the code was right for a reason it did not have.
- **The old reconciliation stays ruled out.** "If that field is the loop length it is zero for
  loopless percussion and the offset vanishes" was the tidy way out of question 12, and `0x3780`
  kills it: the loop length is `+0x80`, a different field. `a_kit_1`'s kick would still start
  anywhere inside its own 0.8 seconds.
- ~~**So question 12's contradiction stands**~~ — **RESOLVED 2026-09-05, three days later**: the
  loop does run the random start from layer 0, and the instruction *after* the loop throws layer
  0's away. Every field named above is still right; what was missing was one more instruction. See
  *12* below.
- ⚠️ **`0x3035` is direct code evidence for question 10** — a voice whose position passes the
  sample length **with no loop** is stopped, which is "a loopless sample plays to the end of the
  sample" written in the engine rather than inferred from a corpus. It says nothing about whether a
  gate can stop it *earlier*, which is the half question 10 still turns on, and it is in tension with
  the bound `holdFramesFor` puts on that rule. Read both before touching either.

---

## 20. The `x`/`y` interpolation — SETTLED: `x + f·(y − x)`, on all 27 parameters

This was the first bullet of question 15, and it mattered more than its size suggests: the direction
was **measured on the sends alone** (`0x3b64`) and *assumed* for the other twenty-six. Getting it
backwards inverts every range in the game at once, silently, on the 19% of corpus notes that carry a
non-zero modulation — a wrong resonance, a wrong cutoff, a wrong attack, all at the same time and
none of them obviously wrong on their own.

### How it was checked

A sweep from every function start in `fmodextinput.prx`, collecting every instruction whose operand
resolves into the `Params` array (`+0x4e8` … `+0x5b7`, 27 `(x, y)` pairs of floats). That finds
**60 reads covering all 27 parameters**, always `.x` first and `.y` second, and for each one the
`vsubss` that follows:

| parameters | where the subtraction is | order |
|---|---|---|
| 0, 1, 2 — the unison stack | `0x1b20`, `0x1b82`, `0x1ab9` | `y − x` |
| 7–10 — the filter ADSR | `0x214f`, `0x2175`, `0x219b`, `0x21c1` | `y − x` |
| 11–14 — the amplitude ADSR | `0x1f9c`, `0x1fc0`, `0x1fe4`, `0x200b` | `y − x` |
| 15–23 — the three LFOs | `0x224f`…`0x2806`, nine sites (three read twice) | `y − x` |
| 24 — output level | `0x23ac` | `y − x` |
| 25, 26 — send, drive | `0x3b64`, `0x3ba3` | `y − x` |
| **3, 4, 5, 6 — the filter** | `0x29ec`, `0x2a36`, `0x2a03`, `0x29c2` | `y − x` |

⚠️ The four filter parameters are the reason a naive scan reports only 23 of 27. They are loaded
into `xmm8`…`xmm14` in one batch at `0x2945`-`0x297d` and combined much later, so "the `vsubss`
immediately after the `.y` load" finds nothing for them. Each still resolves to
`x + f·(y − x)` — e.g. the cutoff:

```
0x29ec  vsubss xmm10, xmm10, xmm13     ; y - x
0x29f1  vmulss xmm6,  xmm7,  xmm10     ; * the modulation
0x29f6  vaddss xmm6,  xmm13, xmm6      ; x + f*(y - x)
0x29ff  vmulps xmm6,  xmm6,  xmm6      ; ... and then SQUARED
```

### Two things that came free

- **The cutoff is squared after interpolation** (`0x29ff`), which is what `filterAtInto` already
  does — `settings.cutoff * settings.cutoff`. Independent corroboration of a formula that had been
  taken from a different reading.
- ⚠️ **The filter block evaluates every parameter twice, at two different `f`s.** `0x2a54` onward
  repeats all four with **`xmm15`** in place of `xmm7`. Two modulation values in one call is not
  something this project models, and the obvious guesses — the two ends of a per-block ramp, or two
  channels — are guesses. It is written down here rather than in a descriptive file for that reason.

---

## 21. `Params[26]` — SETTLED and IMPLEMENTED: a soft-clip drive on the sampler's output

Opened and closed on 2026-09-02. It was the largest unmodelled thing left in the synth, and it was
hiding behind a "settled" statement that was wrong twice over.

### ⚠️ What steering used to say

The reverb entry recorded `voice+0x20` as *"the instrument's own reverb send … and then **nothing
reads it** — a grep of the whole PRX finds the store and no read."* Both halves were wrong. `+0x5b8`
is **`Params[26]`**, which this project names `drive`; the send is `Params[25]` at `+0x5b0`. And it
**is** read — by a **`vbroadcastss`**, which is how a grep for `vmovss` missed it.

### The whole thing, measured

```
0x3b93  d = Params[26].x + mod*(y - x)
0x3baf  [voice + 0x20] = d
0x3cd8  [voice + 0x20] = clamp(d, 0, 1)          ; at note start

0x1ee0  d  = broadcast([voice + 0x20])           ; once per block
0x1ee7  d  = min(d,  0.95)                       ; keeps 1 - d off zero
0x1eef  d  = max(d, -0.95)
0x1ef7  a  = d * 2
0x1f07  b  = 1 - d
0x1f0b  r  = vrcpps(b) + one Newton step         ; 2r - b*r*r
0x1f1f  k  = a * r = 2d / (1 - d)
0x2b4d  1 + k

0x2c88  call 0x3780                              ; the sampler
0x2cab  |x|                                      ; vandps with the sign mask
0x2cc0  k * |x|
0x2cc4  1 + k*|x|
0x2ccc  its reciprocal, vrcpps + a Newton step again
0x2cf1  out = (1 + k) * x / (1 + k*|x|)
0x2d0d  ... then the gain, and 0x2d25 the pan
```

So `f(x) = (1 + k)·x / (1 + k·|x|)` — the standard soft clip — applied **per layer, to the
sampler's output, before the gain and the pan**.

Two properties that make it safe to add to an existing renderer:

- **`k = 0` is an exact bypass**, `f(x) = x` with no rounding, so the 59 instruments that leave
  `Params[26]` at zero render bit-identically.
- **The rails are fixed points**: `f(±1) = ±1`, so however hard it is driven the shaper never
  exceeds full scale. It is a compressor towards the rail, not a clipper at it.

### What it changes

| | |
|---|---|
| instruments that set it | **9 of 68** |
| notes whose *evaluated* drive is non-zero | **50,383 of 1,842,515 (2.73%)**, in **109 sequencers** |
| `e_guitar_power` | k = **5.442** — a gain of 6.4x on small signals |
| `e_guitar_distorted` | k = 2.651…4.667 |
| `electric_harpsichord` | k = 0.053…1.279 |
| `baiyon_drums_1`, `baiyon_city_kyoto`, `baiyon_shiny_01` | k up to 0.5 |

⚠️ Read the two counts together. 17.24% of corpus notes are *on* an instrument that sets a drive,
but most of those are `baiyon_drums_1`, whose range is `0.000 … 0.087` — zero at modulation 0, where
most notes sit. The number that matters is the evaluated one, 2.73%.

⚠️ And note the pairing that hid this: `e_guitar_power` and `e_guitar_distorted` carry the **lowest
output levels in the game**, 0.088 and 0.161, which is what you would expect if the drive adds level
that has to be taken back out. Implementing the level without the drive made them quiet *and* clean
— two errors partly cancelling, which is why nothing sounded obviously broken.

### What is deliberately not claimed

- ⚠️ **The engine reciprocates with `vrcpps` plus one Newton step, twice.** That lands within an ulp
  of a true divide, and `vrcpps`'s 12-bit seed cannot be reproduced from JavaScript, so
  `src/audio/mixer.ts` divides. It is the one place in the shaper that is not bit-exact.
- ⚠️ **Its position is measured only relative to the sampler.** `0x2c88` calls the sample read, the
  shaper runs on the result, and the gain and pan follow — that much is certain. The **ladder's**
  position relative to it is not established: that loop is per-layer and the filter is not in it.
  The implementation applies the shaper immediately after the sample read, which keeps it where it
  was measured, but a later reading could move the filter across it.

---

## 10. One-shots — SETTLED against a recording: **the engine gates every voice**

Open since the beginning, closed 2026-09-03 when a listener recorded the game's own output for one
drum section and synced it against a render. ✔ **That recording was made under shadPS4 and the
conclusion survives it**: it rests on *envelope correlation* — a shape — and on the code, not on any
absolute level. See *Provenance rule 2* in [lbp-modding-toolchain.md](lbp-modding-toolchain.md),
which was written when the same listener retired question 23 for being a spectrum measurement
against the same reference. Two independent lines of evidence agree, and they
overturn what this project had believed.

### The code

```
0x1f65  r15d = [voice + 0x10]      ; the gate: 1 once the note's records end
0x1f6d  sete al                    ; "still held"
0x203a  edi = al                   ; -> the first argument to the envelope
0x203f  call 0x16b0
```

No branch on the loop, the slot or anything else, and `0x3093` frees the voice when the envelope is
done. `0x3035` — which this project read as "a loopless sample plays to the end of the sample" — is
an **additional** stop, not an exemption: a loopless voice *also* ends when its position passes
`[slot+0x78]`.

### The recording

`Ascetic`'s two kits, 18 seconds, aligned at a lag of 0.503 s. Envelope correlation against the game
in eight two-second blocks, for the three rules `options.oneShot` offers:

| block | `full` | `natural` | `gate` |
|---|---|---|---|
| 0-2 | 0.8237 | 0.8243 | **0.8368** |
| 2-4 | 0.7751 | 0.7762 | **0.8011** |
| 4-6 | 0.8309 | 0.8318 | **0.8501** |
| 6-8 | 0.7856 | 0.7868 | **0.8096** |
| 8-10 | 0.7901 | 0.7912 | **0.8087** |
| 10-12 | 0.7775 | 0.7785 | **0.8026** |
| 12-14 | 0.8292 | 0.8301 | **0.8489** |
| 14-16 | 0.8100 | 0.8114 | **0.8331** |

**Eight blocks out of eight.** The per-hit decay error agrees: mean |error| 34.1 ms for `gate`
against 39.2 ms for the other two, over eleven isolated hits.

### ⚠️ What this overturns, and why the old evidence was not wrong

Question 10 existed because a listener reported the drums as clipped and far too quiet, and the
arithmetic backed them: `a_kit_1`'s amplitude release is 0.068 s and `baiyon_drums_1`'s is **three
milliseconds**, so a gated kit is cut to its written note and little more.

That report was real, and it was about **the same session's renders** — which were playing
`baiyon_drums_1` with `a_kit_1`'s kick, because two sample GUIDs had collided on one filename (see
*Two sample GUIDs shared one filename* in [game-assets.md](game-assets.md)). With the right kick the
drums stopped sounding wrong, and the rule invented to compensate stopped being needed.

**The general rule this earns:** a fix that compensates for a symptom will survive the symptom's real
cause being found, and go on quietly making everything else wrong. `natural` was reasonable, it was
endorsed by an ear, and it was a workaround for a filename collision two layers away.

### What is kept

`options.oneShot` still offers `'full'` and `'natural'`, and `LBP_ONESHOT` still selects them.
They are what this project believed for a while, the difference between them and the truth is small
enough that only a measurement separates them, and that is exactly why they should stay runnable.

---

## 22. The stereo width -- SETTLED: the game narrows every pan to `2 - sqrt2`

Open since a listener said *"sembra che lbp non abbia mai un hard panning"*. Closed 2026-09-03 by
two recordings of the game at the extremes, and closed the good way: **the number was predicted
before it was measured.**

### The prediction

Two placements in `Ascetic` at written pans 0.40 and 0.60 came out of the game at a channel ratio of
0.5586 where this renderer gave 0.6000. Two interior points fix a one-parameter affine family, and
that family predicted **0.261204** for the quiet channel of a hard-panned voice -- while a
constant-power law over a reduced angle, the one candidate that is not affine, predicted 0.198.

### The measurement

One instrument at pan 0 and one at pan 1, recorded from the game, 18.0 s and 6.5 s. Least squares of
the quiet channel against the loud one over the whole file:

| | pan 0 | pan 1 | predicted |
|---|---|---|---|
| gain, quiet / loud | **0.261202** | **0.261202** | **0.261204** |
| residual / quiet rms | 0.0008 | 0.0008 | |
| correlation | 1.000000 | 1.000000 | |
| best lag | 0 samples | 0 samples | |

**Six significant figures, on two independent files, at an operating point the fit had never seen.**
Constant power is refuted by a wide margin. The residual and the unit correlation say the quiet
channel is the loud one times a constant -- no delay, no decorrelation, no reverb of its own -- so
at a hard pan the game's output is effectively mono.

### The law, in its three equal forms

```
width      p' = 0.5 + (p - 0.5) * s      s = 2 - sqrt2      = 0.5857864
mono add   L' = L + c*(L+R)              c = 2^-1.5         = 0.3535534
cross-bleed L' = L + b*R                 b = 1/(1 + 2sqrt2) = 0.2612039
```

All three are the same law and differ only by an overall gain. ⚠️ **That is why the interior points
could not settle it and the extremes could**: within the family every form predicts the same ratio
everywhere, so no amount of listening separates them -- but the family as a whole predicts 0.2612 at
the extreme where constant power predicts 0.198.

`c = 2^-1.5` is `0.5 / sqrt2`: the mono average of a stereo pair folded back at the standard -3 dB,
which is what a **centre channel** does.

### ✔ And the fold happens below the game

Read the same day, `v0xa57770` -- the `GetDriverCaps` callback of the output description named
"FMOD Orbis AudioOut Output" -- reports `FMOD_SPEAKERMODE_7POINT1` (`[r8] = 6`), 48000 Hz, and
`FMOD_CAPS_OUTPUT_MULTICHANNEL | FMOD_CAPS_OUTPUT_FORMAT_PCMFLOAT` (`0x84`). The game never calls
`setSpeakerMode`, so that is the mode it runs in, and `sceAudioOutOpen` gets `param = 5`,
`FLOAT_8CH`.

**LBP3 renders eight channels.** The stereo anyone hears is a downmix underneath it.

### ✔ And the downmix itself is read, because the captures were made under shadPS4

`shared/src/core/libraries/audio/sdl_audio_out.cpp`, `DownmixF32_8CHToStereoPS4`, taken when the
game opens six or more channels and the host device is stereo:

```c
static constexpr float DOWNMIX_CENTER = 0.7071f;                 // FC = 2
d[i*2 + 0] = s[o + FL] + 0.7071f * s[o + FC] + 0.7071f * (s[o+4] + s[o+6]);
d[i*2 + 1] = s[o + FR] + 0.7071f * s[o + FC] + 0.7071f * (s[o+5] + s[o+7]);
```

A 7.1 fold cross-feeds **only** through the centre, so the measurement pins the content:
`0.7071 * FC = 0.3536 * (L+R)`, hence `FC = (L+R)/2`. ⚠️ **The asymmetric alternative is refuted by
the recordings themselves**: had FMOD mapped the DSP's four channels straight into the bus as
FL, FR, FC, LFE, the centre would hold `L * send` and the ratio would be 0.2612 at pan 0 and **0**
at pan 1. Both captures give 0.261202.

**So the two halves have different owners.** The centre feed is the *game's* -- FMOD putting a mono
average there when it upmixes the 4-channel DSP into 7.1 -- and the `1/sqrt2` fold is the
*downmixer's*, and it is the ITU-R BS.775 coefficient that real hardware and a compliant emulator
share. A stereo listener hears this narrowing either way, which is why the tracker reproduces it.

### ✔ And the centre feed is now READ, 2026-09-05 -- the last link

`FC = (L+R)/2` was the leading hypothesis for two days: a textbook quad->7.1 upmix computes exactly
that, it fitted to six figures with no free parameter, and steering refused to write it down because
*"nothing in the eboot has been read that does it"*. It is read now, and the hypothesis was right.

The chain, every hop measured:

```
System::createDSP("Sequencer", channels = 4)      eboot v0x3e66cb
DSP::setDefaults(freq, vol, pan = 0.0, prio = 0)  eboot v0x3e66f4
System::playDSP(FREE, dsp, paused, &channel)      eboot v0x3e6718   <- the DSP IS the channel head
Channel::setMode(FMOD_2D = 8)                     eboot v0x3e67cb
Channel::addDSP(reverbDSP)                        eboot v0x3e67f9   <- "SMS Reverb", channels = 0,
                                                                      so it inherits the 4
ChannelSoftware::setPan(0.0, 1.0)                 vtable +0x98  -> v0xabdf30
  -> pan 0 gives L = R = 1.0, and for a source of more than 2 channels it calls
     setSpeakerMix(L, R, 1, 1, L, R, L, R)        vtable +0xa8  -> v0xabe160
  -> which asks for the channel->speaker matrix   v0xa243a0(speakermode, nchannels, maptype, ...)
     switch speakermode -> 7POINT1                jump table v0xa2664c[5]  -> v0xa24874
     switch nchannels   -> 4                      jump table v0xa2670c[3]  -> v0xa2599f
```

**`v0xa2599f` is the answer.** It writes an 8x4 `levels[speaker][sourceChannel]` matrix, having
first scaled every level except the two fronts by **`k = 0.5`** (`v0xefc008`):

| speaker | ch0 | ch1 | ch2 | ch3 |
|---|---|---|---|---|
| front L | `fl` | 0 | 0 | 0 |
| front R | 0 | `fr` | 0 | 0 |
| **centre** | **`c·0.5`** | **`c·0.5`** | 0 | 0 |
| LFE | `lfe·0.5` | `lfe·0.5` | 0 | 0 |
| back L / side L | 0 | 0 | `·0.5` | 0 |
| back R / side R | 0 | 0 | 0 | `·0.5` |

The centre row is `0.5·(ch0 + ch1)` — **the mono average of the front pair, at 0.5, in FMOD's own
code**. The stereo->7.1 case at `v0xa2579c` does the same thing, so this is FMOD Ex's general rule
for feeding a centre a source does not have, not something about four channels.

### The width is now derived rather than fitted

Three read constants and no free parameter:

```
plugin pan law   ch0 = (1-p)x, ch1 = px            PRX 0x2d21 / 0x2d40
FMOD upmix       FC = k(ch0 + ch1),   k = 0.5      eboot v0xa2599f, v0xefc008
BS.775 downmix   L = FL + d·FC,       d = 1/sqrt2  shadPS4, and real hardware

L = x[(1-p) + kd],  R = x[p + kd],  so the normalised pan spans 1/(1 + 2kd)
                                                 = 1/(1 + 1/sqrt2) = 2 - sqrt2
```

**`PAN_WIDTH = 2 - Math.SQRT2` is a derivation now**, matching the measured 0.261202 to six figures
from the other direction. Nothing in `src/core/render.ts` changes; what changes is that it is no
longer a fit.

### ✔ The send channels do NOT leak into the surrounds

The matrix above puts source channels 2-3 on the four surrounds at 0.5, and those channels are the
sequencer's **reverb send** — which would have meant the send bleeding into the dry stereo output at
`0.7071` through the downmix, a real fidelity difference. It does not happen, and the reason is one
instruction pair.

`fmodsmsreverb.prx` exports exactly one symbol, `iO5jJEuFaSo` at `0x23a0`, its read callback. It
**asserts 4 in and 4 out** (`cmp r8d, 4` / `cmp r9d, 4`, else `int 0x41`) and runs `0x20e0` over
256-frame blocks. That function de-interleaves **channels 2 and 3 only** (`0x21f0`-`0x2216`, reading
`in[4i+2]` and `in[4i+3]`), and its write-back at `0x2335`-`0x235d` is:

```
xmm0 = 0
xmm2 = wet + in[ch0..ch1]           ; dry plus wet, two frames at a time
[out] = vmovq(xmm2)                 ; low 8 bytes kept, HIGH 8 BYTES ZEROED
[out+0x10] = vpalignr(xmm0, xmm2, 8)   ; the next frame, zeros shifted in
```

`vmovq` and `vpalignr` against a zero register are how you clear the upper two lanes. **The reverb
writes `(dryL + wetL, dryR + wetR, 0, 0)`**, so the surrounds are silent and the only thing the
7.1 bus carries is the front pair and the centre's average of it.

That also closes the reverb's own last unknown, which entry *6 / 14* listed as *"what gain, if any,
the eboot puts on the connection from the sequencer DSP's channels 2-3 into the reverb, and from the
reverb's output into the master"*. **There is no connection and no gain**: the two DSPs share one
4-channel buffer, the reverb reads the send lanes out of its own input and writes the sum back into
the dry lanes. `src/audio/effects.ts` assumed unity at both ends and unity is what it is.

### How it was found, after a session of failing to

⚠️ **The eboot has RTTI, and one session was spent not using it.** The earlier attempt enumerated
vtables *structurally* — runs of consecutive relocation slots holding code addresses, filtered on
which slots looked plausible — and produced five wrong candidates plus a near miss
(`v0xa287b0`, `DSP::setDefaults`) convincing enough to be written up. The binary carries 122
Itanium-mangled `N4FMOD...E` names and **322 vtables can simply be named**:

```
"N4FMOD15ChannelSoftwareE"  -> type_info + 8 -> type_info -> vtable - 8 -> vtable
```

each hop a lookup in the `R_X86_64_RELATIVE` map. `tools/ebvtable.py` does it in a third of a
second. The object at `[channel + 0x90]` is a `ChannelSoftware`, its `+0x98` is `setPan`, and from
there the disassembly is a straight line.

⚠️ **The trap that hides the RTTI**: this is a PIE, every vtable slot is **zero on disk**, and the
pointer lives in a relocation addend. Searching the image for a pointer to a type_info returns
nothing at all, which reads as "there is no RTTI" rather than "look in the relocations".

⚠️ **And the trap inside the trap**: a pointer to `X`'s type_info comes from `X`'s vtable *and* from
every derived class's `__si_class_type_info`. Half the candidates a naive walk produces are
type_infos, and dumping one prints strings where functions should be. Require slot 0 to be code.

### What was implemented

`PAN_WIDTH` in `src/core/render.ts`, applied where the voice spec is built; `LBP_PAN_WIDTH=1`
restores the file's own pans. `panGains` itself stays hard-panning and linear, because that **is**
the plugin's law at `0x2d21`; the narrowing belongs above it.

❌ **It said "width, not gain" for two days, and that was half of a linear operator.** The captures
are level-matched and say nothing about absolute level, which was the right reason to be careful —
but the fold is *read* now, and it fixes the level relative to the DSP whether or not a capture can
confirm it. `L = ch0 + k·d·(ch0+ch1)` shrinks the difference by `1/(1 + 2kd)` and grows the **sum**
by `(1 + 2kd)`, the same number. Narrowing without it is a uniform **−4.645 dB**, at every pan:

| pan | engine L | ours L | ratio |
|---|---|---|---|
| 0.00 | 1.353553 | 0.792893 | 0.585786 |
| 0.50 | 0.853553 | 0.500000 | 0.585786 |
| 1.00 | 0.353553 | 0.207107 | 0.585786 |

`FOLD_GAIN = 1 / PAN_WIDTH` in `src/core/render.ts` is the missing half, applied once in the voice
spec's gain. Corpus peaks go 0.547 → 0.934, 0.435 → 0.743, 0.119 → 0.203 with no frame clipped.

❗ **It is a constant, and the first attempt made it `1 / panWidth` instead.** That is defensible
physics — a narrower fold is a bigger centre feed, which really is louder — and it wrecked the
instrument: the live page's width slider became a volume control, **+20 dB at 0.1** and back to the
−4.6 dB the fix existed to remove at 1.0. A listener found it in minutes. The game's `k = 0.5` and
`d = 1/sqrt2` are constants of FMOD and of BS.775, not settings, so the gain is fixed and
`panWidth` stays a diagnostic on the **image** at constant level. Measured after: the render's rms
moves 0.09914 → 0.09784 across width 1 → 0.2, which is the 0.11 dB the narrowing genuinely
redistributes between channels, against the 4.6 dB it used to swing.

⚠️ **The lesson is about the knob, not the physics.** A parameter that is a *diagnostic* must vary
one thing; coupling a second to it — however honestly — makes the comparison it exists for
impossible to hear.

⚠️ **A normalising renderer hid it for two days.** `dev/render-level.ts` normalises its WAV, so
every offline check came out at full scale and nothing ever looked quiet. It took a listener playing
the **live** page, which does not normalise, to say "the whole sequencer is quiet" — which is
exactly what a half-applied fold sounds like. **A test that normalises cannot see a gain error**, and
this project has a lot of tests that normalise.

### The wrong turn, and it lasted a day

`panWidth` existed for a day as *"a DIAGNOSTIC, not a setting"* defaulting to 1, with a note saying
`0.58` reproduced the recording but must not be promoted until a call site said so. That caution was
right about the *mechanism* and wrong about the *measurement*: a transfer function measured on the
game's own output at four operating points is a reading, and it does not need the mechanism to be
implemented. **A measured input-output relationship is evidence in its own right.** The renderer
hard-panned for a day longer than the evidence justified.

## The PS3 backup that "cannot be read" — RESOLVED 2026-09-04: it reads fine

`32406766.zip` is a PS3 save-game folder. `src/core/backup.ts` reported it as unreadable and the
three pages said so on screen. It is not: the numbered files are the game's own `FAR4` save archive
under XXTEA with a key that is a literal in every tool that touches these files, and unpacking it
gives 28 resources — 28 of 28 SHA-1s matching — one level, and **11 music sequencers**, one of them
the "Ascetic - Festerd_Jester" this project's own MIDI fixture came from. The format, the key and
the sources are in [lbp-modding-toolchain.md](lbp-modding-toolchain.md).

### The wrong turn, and it is the most instructive one here

Two rounds of evidence were produced for the wrong answer.

**Round one was a guess wearing a measurement's clothes.** "The `0` file is 472,960 bytes at 8.000
bits per byte, all 256 values present, without a single run of four zeros." Every word true. Every
word **equally true of compressed data**, which is what an LBP resource is made of. It never
discriminated between the two hypotheses on the table, so it was worth nothing, and it read as
decisive because it had numbers in it.

**Round two was a real measurement of the wrong question.** Challenged, the evidence became: `PFDB`
in `PARAM.PFD`; two saves of the same game sharing **0** of 29,560 16-byte blocks and agreeing at
1,816 of 472,960 offsets against ~1,848 by chance; nothing inflating at 4,096 offsets. All of that
is sound and all of it establishes only **"this is ciphertext"**. The question that decided the
outcome was *whose ciphertext, under what key* — and it was never asked, because round two was
built to defend round one's conclusion rather than to test it.

**The answer was in the bytes already printed.** The file ends `2d ba 61 d2 46 41 52 34` — `FAR4`,
in the clear, because the writer leaves the last four bytes unencrypted. It appeared in a hex dump
produced *as part of proving the file unreadable*, and went unread. ⚠️ **A dump you produce to
support a conclusion is a dump you are not reading.**

What actually broke the deadlock was a question from outside: *how can a site serve the same level
both as a PS3 backup and as loose resources?* It cannot, unless it holds the plaintext — which
means the backup is something it **builds**, which means the encryption is public, which means it is
in that repository. It was: `TEA_KEY` in `save_archive.rs`, thirty lines from the top.

❗ **The lesson for this file: "I cannot read it" is a claim about the reader, not the file.** Before
writing one down, name what would have to be true and go and check that, rather than gathering more
descriptions of the bytes.

### And it was already written down here

⚠️ **`steering/lbp-modding-toolchain.md` had the recipe three days earlier.** *How to get from
a file to a set of sequencers* has said "**XXTEA-decrypt each fragment**, strip the last 4 bytes of
the final one, concatenate, append `FAR4`" since commit `197a00a` on **2026-09-01**; the "cannot be
read" claim went in on **2026-09-04**. `CLAUDE.md` says to read that file *before writing a parser
for any LBP resource or archive*, and it was not read. The measurement theatre of the two rounds
above was spent re-deriving — wrongly — something this project had already written down.

## 25. Plans (`PLNb`) — RESOLVED 2026-09-04: read, and they hold most of the music

A plan is a saved Thing rather than a world — a costume, a vehicle, or a music sequencer copied into
somebody's popit. `src/core/level.ts`'s `readPlan` opens one, and `readLevelProject` dispatches on
the resource magic, which is the first four bytes of the file and needs nothing inflated.

`RPlan` is four fields and only the third matters:

```
bool  isUsedForStreaming   subVersion >= 0xcc          (Revisions.STREAMING_PLAN)
i32   revision             the plan's own, IGNORED -- the resource's revision wins
i32   length               \  thingData
byte  data[length]         /  a Thing[] as a reference array: i32 count, then each
...   inventoryData        head >= 0x197 and not streaming -- never read here
```

⚠️ **The Things are in a nested stream with a fresh reference table.** Reference ids inside
`thingData` mean nothing outside it, so the blob gets its own `Serializer` with the same revision
and compression flags. Reading it in place would work by accident on a plan holding one Thing.

### What the corpus says, and it is the reason this was worth doing

Six real PS3 saves (the five in the checkout plus a downloaded backup), 663 resources:

| | |
|---|---|
| plans | **224** |
| plans that parse | **222** |
| Things inside them | **83,188** |
| music sequencers inside plans | **172** |
| music sequencers inside the levels beside them | 19 |

**Nine tenths of the music in a creator's backup is in plans, not levels.** A gallery level is a rack
of speakers pointing at plans; the songs are the plans. `test/plan.test.ts` pins 213/211/172 over the
checkout alone.

Two proofs the wrapper offsets are right, neither of which needs a plan to hold anything in
particular:

- the Thing array **fills `thingData` exactly** — 0 bytes left on 220 of 220, now asserted, so a
  part reader that takes the wrong number fails here instead of quietly losing what follows;
- every Thing carries the 0xAA test marker and 83,188 of them checked out, which is a per-Thing
  checksum over the whole walk.

### The two that do not parse, and one part that had to be written

`POCKET_ITEM` was missing and is now in `parts.ts` (two plans, subVersion 0x208/0x209). Left over:
one plan carrying `YELLOWHEAD` — a player's poppet state, which drags in the whole `Poppet` struct
for one file — and one at revision `0x272`, which `requireLbp3` refuses on purpose. Both fail by
name, which is the growth path working.

⚠️ **`PLNb` had been in `LEVEL_MAGIC` all along**, when it meant "read a plan as if it were a
world". That produced eleven loud failures for a backup that was fine, and the fix on 2026-09-04 was
to take the magic *out* — which was right for an hour and wrong as a resting place. The magic was
never the problem; the reader was.

## 26. Streaming levels — RESOLVED 2026-09-04: the whole chain, down to the islands

An LBP3 adventure is not one level. `RLevel` → `StreamingManager` → `LevelData.chunkFileList` names
a pile of `CHKb` resources; each chunk holds **islands**; each island holds a whole `PLNb` resource;
that holds the Things. Four levels of nesting, and the reader now walks all of it.

`emptyOnly` used to refuse a non-empty `chunkFileList`, which was right for the ten-level corpus it
was written against and wrong for two of the six PS3 saves — *Meched Inc.* (42 chunks) and *New
Heights* (129). Both open now.

### The layout, all of it measured against those two saves

```
ChunkFile      sha1 chunkHash                       subVersion > 0x130
               StreamingCheckpoint[] QuestTracker[] QuestSwitch[] CollectableData[]
               i32 n, then n resource descriptors WITH AN INLINE TYPE   (>= 0xde)
               v3 min, v3 max, 4 bools, i32 n + n GUIDs, i32 n + n SHA-1s
StreamingIsland i32 timeZone, i32 flags, v3 min, v3 max
               bytearray planData        <- a complete PLNb resource, header and all
               the same four lists, then the GUID and hash lists
RStreamingChunk  StreamingIsland[] (references), then an intvector of chunk codes
```

**171 chunks, 2,553 islands, 10,837 Things, and 9 music sequencers**, with every island opening and
the chunk's own stream ending exactly on its last byte. `test/plan.test.ts` pins all four numbers.

### Three bugs it uncovered, and all three had been invisible for the same reason

Everything the corpus had ever contained was **compressed**, and a compressed stream hides whole
classes of error because a varint under 128 is one byte — exactly what a `u8` is.

1. **`isCompressed` was read and ignored** in `resource.ts`. An uncompressed resource has no chunk
   table: the payload starts after the flag and runs to the dependency table. `CHKb` is the first
   one, and the reader took "96 chunks" out of the payload's own first bytes.
2. **The Thing's parts revision is in the stream**, an `s32` before the part mask, and this project
   guessed it from the version instead. The byte that had to be eaten to make the mask decode was
   recorded in `thing.ts` as *"one byte cwlib does not account for"*: it is that field, one byte as
   a zigzag varint and **four** when the stream is not compressed.
3. **`FieldLayoutDetails` is bytes, not enums, from 0x3d9.** `machineType`, `fishType` and
   `arrayBaseMachineType` are `u8`; reading them as `enum32` costs nine bytes per field on an
   uncompressed stream and none at all on a compressed one. This is the one that mattered: with it
   wrong, 101 of 2,553 islands died and **the rest quietly lost most of their Things** — the first
   measurement said "0 sequencers in any island", and the true answer is 9. `PCostume.creatureFilter`
   was the same mistake in the other direction (`u8` where the game writes an `i32`).

⚠️ **The lesson: a compressed corpus cannot tell a `u8` from a small `i32`.** Nine part readers
and one struct in this project were written against nothing but compressed files. The first
uncompressed resource is worth more than a hundred more compressed ones, and if another turns up,
run the whole corpus through it before trusting a byte width again.

### Nine part readers came with it

`TRANSITION`, `FADER`, `ANIMATION_TWEAK`, `WIND_TWEAK`, `STREAMING_DATA`, `STREAMING_HINT`, `REF`,
`POWER_UP`, `ANIMATION`, `ATMOSPHERIC_TWEAK`, `SCRIPT_NAME`, `QUEST`, `WORMHOLE`,
`MATERIAL_OVERRIDE`, `CONNECTOR_HOOK` — every part an island scene uses. What is left is in
question 26 of [open-questions.md](open-questions.md): four resources, each failing by name.

## 27. The LFO cadence — RESOLVED 2026-09-04: **once per chunk**, not once per sample

This project advanced the three LFOs and evaluated their sine **every frame**. The engine does not.
In `fmodextinput.prx`'s per-voice renderer the oscillator lives in the **per-layer** loop at
`0x24a0`-`0x28e3`, which is a separate loop sitting entirely *before* the per-sample loop at
`0x2b70`-`0x2df9` (the one holding the sampler call at `0x2c88`):

```
0x27e6  xmm0 = [rbp-0xab0]              ; this chunk's phase increment
0x27ee  xmm0 += [rbp-0x9d0]             ; plus this layer's running phase
0x282e  call 0x130                      ; sin(), once per layer per chunk
0x283e  xmm0 = sin * (depth * 0.05)     ; v0x4580 = 0.05, the LFO 1 scale
0x284e  xmm0 = detune + that            ; pitchFactor
0x2876  [r14] = the layer's rate        ; a double the sample loop then reads
...  after the loop:
0x28f1  [r12+0x98] += [rbp-0xab0]       ; the three stored phases advance
0x2915  [r12+0x9c] += [rbp-0xab8]       ; ONCE, outside every per-sample loop
0x293b  [r12+0xa0] += [rbp-0xac4]
```

Six `call 0x130` inside that loop — two per LFO — and three phase accumulators at voice `+0x98`,
`+0x9c`, `+0xa0` advanced once after it. The layer's resulting rate is written as a **double** that
the sample loop reads as a constant. So the modulation the game applies is a **staircase held for a
chunk**, not a smooth per-sample curve.

This is the same `sub_0x1c60` whose per-chunk cadence question 6d already established for the
modulation ramp, so `MORPH_FRAMES` was already the right clock; the LFOs simply were not on it.

### What it was worth

`C4K3 S0NG` (`Meched Inc.`, 244 tracks, 13,091 notes, the pool saturated — 3,634 notes stolen) is
the stress test. Measured over 30 s of its busiest stretch, driven the way the worklet drives it:

| | before | after |
|---|---|---|
| live path, 128-frame quanta | 4,183 ms | **3,235 ms** |
| offline, whole song | 35.8 s | **20.2 s** |
| browser audio-thread load | 16-36% | **11-26%** |

Half of that is the LFO; the other half is the delay bug below. It is **1.19 `Math.sin` calls per
voice-frame** that stop being made — the oscillator was 10.1% of a live render, measured by
stubbing `Math.sin` out and re-timing.

⚠️ **The output changes**, deliberately, for every voice with a live LFO. RMS over ten seconds of
`C4K3 S0NG` moves 0.10188 → 0.10179 and the peak 0.906 → 0.908. That is the point: it is closer to
the engine, not merely cheaper.

### The delay bug it uncovered, which was worth more than the LFO

Chunking a voice made every LFO voice walk `Voice.render`'s loop — and a chunked voice **counted its
start delay one chunk at a time**. `renderChunk` skips the delay by arithmetic, but only after being
entered, so a voice starting three minutes into an offline render did **78,000 empty iterations**
before its first sample. The full-song render went from 35.8 s to 63.2 s the moment LFO voices
started chunking, which is how it was found; skipping the delay before the chunk loop took it to
20.2 s — **40% below where it started**, because morphing voices had been paying it all along.

⚠️ **And the chunk grid has to stay the block's, not the voice's.** `at = delay` then
`at += MORPH_FRAMES` puts the boundaries at `delay + 128k`, so an offline render and a 128-frame
live one step the modulation at different frames and stop agreeing. `MORPH_FRAMES - (at %
MORPH_FRAMES)` for the first chunk keeps them on one grid. `test/audio.test.ts`'s "the mixer renders
the same audio whatever the block size" caught this within a minute of it being written.

### What the engine actually costs, for the next time this comes up

50.3M voice-frames for 30 s of `C4K3 S0NG` — about 35 voices sounding — at **80 ns each**. Per
voice-frame, counted: **100%** run the amplitude envelope, **92%** re-solve the filter and **87%**
run the four-pole ladder, **119%** ran an LFO (1.19 of them), **18%** evaluate `2 ** (semitones/12)`
for a real glide, 100% walk the automation, all of them read a mipped sample. Nothing is idling.

### Four things measured that turned out NOT to be worth doing

- **Per-quantum overhead does not exist.** Driving the mixer at 128 frames and at 4,096 costs the
  same to the millisecond. The scratch allocation, the span objects and the per-chunk setup are all
  in the noise; the cost is the frame loop and nothing else.
- **Hoisting `this.*` into locals across the frame loop made it 3% SLOWER.** V8 was already doing it,
  and the extra locals cost more than the loads.
- **Micro-fixing `readMipped`** (one `Math.floor` instead of a floor and a trunc) changed nothing
  measurable, despite the profiler attributing 13% of the run to that function. ⚠️ A sampling
  profiler's per-function attribution inside a hot inlined loop is a hint, not a measurement:
  stubbing a thing out and re-timing is what actually answered every question here.
- **Extending the fixed-filter path to `keyTrack === 0`** would reach 7% of voice-frames against the
  3% it already covers. Left alone.

## 17b. A stacked note takes ONE record, not `Numstack` — corrected 2026-09-04

Question 17 fixed the pool's accounting and got half of it wrong. *"A one-shot runs past its note"*
was measured. *"`Numstack` layers are `Numstack` voices"* was **asserted with no address**, and it
is not what the engine does.

`sub_0xa90` walks the voice array and renders each record:

```
0x0c51  ebx = 0x28                    ; the first record
0x0c6a  rdi = r12 + rbx               ; this record
0x0c84  call 0x1c60                   ; render it
0x0c89  rbx += 0xd0                   ; stride: 208 bytes per record
0x0c90  cmp rbx, 0x1a28               ; (0x1a28 - 0x28) / 0xd0 = 32 exactly
```

✔ **So the pool really is 32** — that half stands, and now it has an address.

But `sub_0x1c60`, called once per record, contains the **per-layer loop** at `0x24a0`-`0x28e3`:
`Numstack` iterations, stride 0x20, writing one rate double per layer at `[r14]` (stride 0x10) for
the sample loop to read. The three LFO phases live at `[r12+0x98..0xa0]` — **once per record**, with
a per-layer spread added on top inside the loop. A record that held one layer would need neither the
loop nor the spread.

**One record plays every layer of its note.**

### What the error cost

`C4K3 S0NG` (13,091 notes, 22,399 voices — 1.71 layers a note):

| | notes cut short by stealing |
|---|---|
| one pool entry per layer | **3,634** (28%) |
| one per note, as the engine | **1,526** (12%) |

A listener heard it before any of this was measured: *"molte voci vengono troncate, nell'originale
non sento così tante note troncate"*. Both of their guesses were the right shape — either the
counting was wrong or the limit was higher — and it was the first.

⚠️ **It costs CPU to be right.** Those 2,108 notes now play, and the live load on `C4K3 S0NG` goes
from 11-26% of a core back to 23-60%. The LFO fix in question 27 paid for it and no more. A
correctness fix that makes the meter worse is still a correctness fix.

⚠️ **"Voices sounding" on the live page counts SAMPLER VOICES, not records**, and three separate
things separate the two — measured on `C4K3 S0NG` at 25.85 s, where **164 voices sound against 19
notes in play**, with the pool not even full:

- a stacked instrument plays up to five layers out of one record, so 32 records are up to 160
  voices, and the engine renders exactly the same number;
- a voice rings on through its **release** after the pool has taken its record back — the whole of
  question 29;
- a **one-shot plays to the end of its sample whatever its note says** (`Voice.finished`: "a
  one-shot ends when the sample does, and only then"), so a cymbal outlives its gate by seconds.

❌ The page used to turn that number **red** when it passed the pool size, captioned "something is
not respecting it". Nothing was: the alarm fired constantly on music that was entirely correct, and
dressing a right number as a fault teaches a listener to distrust it. Removed 2026-09-04.

✔ **The meter shows the notes, 2026-09-04.** Removing the false alarm left "164 sounding" with
nothing to read it against; the number a listener wants beside the 32 in the voices box is the
count of notes. `Mixer.counts()` returns it, by counting distinct `VoiceSpec.tag`s among the voices
that have started (untagged voices count individually), and `dev/live.ts` / `dev/live-sim.ts`
therefore **tag by note rather than by layer** — the same grouping the pool already uses, so one
`cutAt` takes a stolen note's whole stack where a loop over its layers was needed before. The audio
is untouched: `dev/live-sim.ts` still reports the live pool at −56.9 dB and 1,318 of 13,091 notes
stolen. The sampler voices and the queue were shown beside it for one commit and then moved into
the tooltip — a listener called them useless once the notes were there, and they are: the voices
are a consequence of the notes and the queue is an artefact of the page's look-ahead.

### ⚠️ Notes sounding is not records held, measured

The line turns **red at ⅞ of the pool size** (28 at the engine's 32; proportional because the box
goes down to 1). That alarm is on the right quantity, unlike the one it replaces — but it reads
high, and by how much is worth knowing before trusting it.

Measured 2026-09-04 by instrumenting `renderLivePool` in `dev/live-sim.ts` to log, per 100 ms
block, the mixer's tag count against the pool slots actually spanning that block. `C4K3 S0NG`,
first 60 s, pool 32, 600 blocks:

| | mean | max | blocks ≥ 28 |
|---|---|---|---|
| records held | 16.9 | 32 | 71 (11.8%) |
| notes sounding | 19.7 | **50** | 134 (22.3%) |

**The warning lights with slots to spare in 12.8% of blocks.** The cause is the release: with the
tail off (question 29) the pool gives a record back at the gate, while the voice keeps its tag
until it has finished ringing, so a passage of long releases shows more notes than records. Reading
it as "the engine is near its limit here" is right; reading it as "a voice is being stolen right
now" is not — the `stolen` counter in the table below is that.

⚠️ The exact number is available if it is ever wanted: the main thread owns the `LiveVoicePool`, so
counting slots whose `end` is past the audible step would report records held rather than notes
ringing. It is not done because it would lead the audio by up to the 350 ms look-ahead, and because
the number a listener hears is the ringing one.

### What it touched

`render.ts` allocates per note and applies the decision to every layer; `where.note` and
`where.layer` are reported so a live scheduler can do the same, and `dev/live.ts` and
`dev/live-sim.ts` both do. A stolen note takes **all** its layers with it — they were sharing the
record that was overwritten.

## 30. `durationSteps` — VERIFIED against the engine's gate, 2026-09-04

`schedule()` gives a note `durationSteps = endPosition - startPosition + 1`, with both positions
including the sub-step as `step + subStep/3`. Question 29 listed the `+ 1` as unchecked. It is
**right**, and the engine's gate is in two halves that only make sense together.

**The chain walk**, `sub_0x3930` — the per-block note update:

```
0x3a0a  edx = word [rbx + 0x3c]     ; the record cursor
0x3a0e  r11 = rdi + rdx*4 + 0x20    ; the note records, four bytes each
0x3a13  eax <<= 4                   ; gridX * 16, the clip's step offset
0x3a31  r12d -= eax                 ; the playhead, relative to the clip
0x3a3e  edx = [r11] & 0x7f          ; this record's step, bits 0..6
0x3a41  cmp r12d, edx
0x3a44  jle 0x3a6e                  ; playhead <= step: not reached, leave the gate
0x3a46  test ah, 0x80               ; bit 15, the end-of-chain flag
0x3a49  je  0x3a66                  ; not the end: advance the cursor and go again
0x3a4b  [rbx+0x10] = 1              ; the end: close the gate
```

✔ So the gate stays open while `playhead <= lastStep` and closes once the playhead is **inside the
next step**. That is the `+ 1`.

**Then it hands the last third of a step to the renderer.** Having closed the gate, the same pass
re-opens it and leaves a sub-step behind:

```
0x3aa0  eax = 0x107                 ; bextr: start 7, length 1
0x3aa5  bextr eax, ecx, eax         ; bit 7
0x3aaa  ecx >>= 0x1e ; cl &= 1      ; bit 30
0x3ab0  eax <<= cl                  ; subStep = bit7 << bit30
0x3ab2  [rbx + 0x3f] = al           ; the END sub-step
0x3ab5  [rbx + 0x10] = 0            ; and the gate is OPEN again
```

and `sub_0x1c60` closes it for good when the playhead's fraction passes it:

```
0x2988  al = byte [r12 + 0x3f]      ; nothing to do if it is zero
0x2997  xmm4 = (float)al
0x299b  xmm4 *= 0.33333334          ; subStep / 3 of a step
0x29a3  xmm1 = [rbp - 0xb78]        ; the playhead's fraction -- floor'd off at 0x0c42
0x29ab  vucomiss xmm1, xmm4
0x29b1  [r14 + 0x10] = 1            ; past it: close
```

**The gate therefore closes at `lastStep + 1 + endSubStep/3`, which is exactly
`startPosition + (endPosition - startPosition + 1)`.** `durationSteps` is correct to the third of a
step.

✔ **And `subStep = bit7 << bit30` is now confirmed from the PLAYBACK side.** It was recovered from
the editor's write path; `0x3aa5`-`0x3ab0` is the engine reading it back, the same two bits and the
same shift. `[+0x3e]` holds the start sub-step and `[+0x3f]` the end.

### The other candidate, and why it was NOT implemented

The engine skips allocating a record at all when a volume is not positive — `v0x4ef`'s caller:

```
0x04cb  vmulss xmm0, xmm0, [rbx + rax*4 + 0x420]   ; rax = bits 28..29 of the record, times 5
0x04d4  vucomiss xmm0, 0
0x04dc  jbe 0x410                                  ; not positive: no record, no note
```

Our model allocates for every note. On `C4K3 S0NG` that is **701 of 13,091** notes whose score is
zero, and skipping them takes the stealing from 11.7% to 9.7% (and, with the release tail, 29.9% to
29.0%) — so it does not reconcile anything either way.

❌ **And it must not be implemented as it stands.** All 701 are notes whose **own volume opens at
zero and rises** — none is on a muted channel. Those are the `Northern Lights` fade-ins that
`render.ts` documents at length: real music that this project already rendered as silence once.
Reading `0x04d4` as "the note's opening volume" would delete them again.

⚠️ **What `[rbp-0x78]` holds is not known**, and the multiplier beside it is indexed by the note
record's **bits 28..29** — the block-table select — into a four-entry, five-dword table at `+0x420`.
That is not the row-to-channel mapping `channelVolume` uses, and it is a thread worth pulling before
anything here is acted on.

## 31. The note word's bits 28..29 — RESOLVED 2026-09-04: **the game throws them away**

The plugin indexes a 20-byte row at `clip + 0x420 + 20 * sel`, with `sel` taken from the note word's
bits 28..29 (`0x04bd`-`0x04cb`), and the corpus sets those bits on **52% of 1,739,058 records**, in
sticky runs, across 94% of clips. That looked like four instruments per clip and a hole in this
project's one-instrument `Track`.

**It is not.** `v0x1607c0` is the eboot's clip filler — `PInstrument` in `rdi`, the DSP's clip in
`rsi` — and its note-copy loop rewrites every word on the way in:

```
v0x160865  edi = [notes + i*4]              ; the word as the FILE holds it
v0x160868  [clip + i*4 + 0x20] = edi
...
v0x160884  and edi, 0xcfff80ff              ; bits 8..14 and bits 28..29 CLEARED
v0x16088a  or  edi, eax                     ; bits 8..14 rewritten
v0x16088c  [clip + i*4 + 0x20] = edi        ; and stored again
```

`0xcfff80ff` clears exactly bits **8..14** and **28..29**. So the selector is **always zero at
runtime**, the plugin always reads row 0, and the field is editor state the engine discards — the
same shape as bit 30's resting value. ⚠️ Note the parallel: **two of the note word's fields are
written by the editor and ignored by the engine**, and both were nearly read as meaningful.

### And row 0 is `PInstrument`, field for field

The rest of the same function, which is worth having written down:

| clip | from | what |
|---|---|---|
| `+0x00` | `Notes.count` | how many records |
| `+0x04` | `PInstrument + 0x20` | `Colour` |
| `+0x08` | `+0x24` | `Loops` |
| `+0x0c` | `+0x2c` | `Scale` |
| `+0x10` | `+0x28`, as `key < 12 ? key + 12 : key` | `Key` — this **is** `blockRoot` |
| `+0x1c` | `+0x60` | the bound the plugin compares a record's step against |
| `+0x20`… | `Notes[]` | the records, masked as above |
| `+0x420` | `+0x30` | `Level` |
| `+0x424` | `+0x34` | `Pan` |
| `+0x428` | `2 x (+0x38) - 1` | `EchoSend` — **exactly `render.ts`'s `echoOffset`** |
| `+0x42c` | `+0x3c` | `ReverbSend` |
| `+0x430` | (written by `v0x1c4420`) | the instrument index |

✔ So **one instrument, one level, one pan, one echo send and one reverb send per clip** — which is
what `Track` has always carried. The model was right; what was missing was the proof.

✔ Three things this confirms for free: `blockRoot`'s `key < 12 ? key + 12 : key` clamp, the
`2 x echoSend - 1` offset, and — from the bits 8..14 rewrite, `(K1 + K2 - stored) & 0x7f` — that the
stored field is a **y coordinate** the engine inverts into a note, which is question 18's "one
numbering" seen from the engine's side.

### Why it was worth chasing anyway

The question came out of a listener's ear, through `occupancySteps`, through the allocator's volume
test. It ends with nothing to change — but the volume test itself (`channelVolume x [clip+0x420] >
0`, `0x04d4`) is now fully understood, and the 701 zero-volume notes it would skip are still the
open lead in question 29.

## 32. The release ramp — VERIFIED identical to ours, 2026-09-04

`sub_0x16b0` is the engine's envelope. Its release branch, taken when the gate byte is clear:

```
0x1750  xmm2 = release * release        ; the parameter, SQUARED
0x1758  vucomiss xmm2, 0
0x175c  jbe 0x1792                      ; zero -> store 0, the voice is done
0x175e  xmm1 = [rsi]                    ; the stored value, mirrored around 1
0x176a  if (1 < stored) xmm1 = 2 - stored  ; un-mirror to the audible level
0x177c  vdivss xmm0, xmm0, xmm2         ; dt / release^2
0x1780  xmm0 = level - that             ; LINEAR in level
0x178c  [rsi] = xmm0
0x1790  jae ...                         ; still positive: carry on
0x1792  [rsi] = 0                       ; below zero: clamp and finish
```

✔ **`level -= dt / release²`, linear, clamped at zero** — which is exactly `Envelope.advance`, with
`evaluateAdsr` doing the squaring and `ENVELOPE_SECONDS_PER_UNIT = 4` absorbing the engine's `dt`
unit. The mirrored-around-1 storage this project kept "because the handover from attack to decay
depends on it" is the engine's own, visible at `0x176a`.

So the moment a voice falls silent is the same in both, and with it the moment the engine frees the
record. There is no shorter tail hiding in the envelope.

⚠️ **One thing the first measurement of that tail got wrong**: the time to zero is
`release x (the level the envelope had reached)`, not `release`. Recomputed with the level at gate
close — the sustain, or the attack ramp's value for a note that ends inside its attack — the tail
takes `C4K3 S0NG`'s stealing to **22.3%**, not the 29.5% first reported. Still far above the 10.8%
today's occupancy gives, so it changes the size of the gap and not its existence.

## 33. Is the pool really 32, and really per sequencer? — YES to both, 2026-09-04

Asked after a listener heard too much stealing: *"are we sure the PS4 limit is not higher, or that
it is not applied to something narrower than the whole sequencer?"* Both halves are now nailed down.

### 32 is an immediate in the PS4 binary

```
0x0c51  mov ebx, 0x28          ; sub_0xa90, the block callback: the first record
0x0c6a  lea rdi, [r12 + rbx]
0x0c84  call 0x1c60            ; render it
0x0c89  add rbx, 0xd0          ; 208 bytes per record
0x0c90  cmp rbx, 0x1a28        ; (0x1a28 - 0x28) / 0xd0 = 32 EXACTLY
0x0c97  jne 0xc60
```

`fmodextinput.prx` out of `CUSA00063` **is** the PS4 build — there is no other one to be higher.
The bound is a literal, not a parameter, not a config value and not something the eboot can raise:
the eboot links the PRX directly (`FMODExtInput.prx` appears only in the import tables, never as a
runtime-registered DSP plugin), so it cannot even reach the constant.

### The state layout leaves no room for more

`sub_0xa90` copies the caller's state into a global scratch and back out again — `0x0ac4`
`memcpy(global, arg, 0x1b50)` and `0x1003` the reverse — so the records are **per state block**, and
the block is **0x1b50 = 6,992 bytes**. The voice array runs `0x28`…`0x1a28`, which is `32 x 208 =
6,656`, and the remaining `0x128` bytes are the fields after it. The arithmetic closes exactly.

### One state block is one whole sequencer

The same block holds everything the sequencer needs, so the pool cannot be per clip, per channel or
per instrument:

| field | what |
|---|---|
| `[state + 0xc8]` | how many clips — `sub_0x280` loops over all of them |
| `[state + 0x1ad0]` / `+0x1ad8` | the clip array, double-buffered, `0x470` bytes each |
| `[state + 0x1a68 + 12k]` | the eight mixer channels' volumes |
| `[state + 0x28 + 0xd0k]` | the 32 voice records |

`C4K3 S0NG`'s **244 clips share one pool of 32.**

### And the allocator has no sub-pools

`0x1600`-`0x1640` walks all 32 testing only whether a record is free (`byte[rec] == 0xff`) and its
score. **No channel comparison, no instrument comparison, no reservation.** Anything can steal
anything.

### What is not closed, and why it cannot help

Whether the eboot keeps more than one state block — two sequencers sounding at once would have 32
each. It does not matter here: the game walks every Thing carrying `MusicSequencer` (`PSequencer +
0x56`, tested at `v0x1c5773`) when one begins playing, which is the "stop all other music
sequencers" behaviour, and **even if two could sound, neither would get more than 32**. A single
sequencer has 32 and that is the number the pool must model.

## 35. Dependency types — ANSWERED by measurement, 2026-09-05

`dev/archive-panel.ts` opens a level from the public archive by walking its dependency table, and
the question was which type a streaming level's chunk file carries. Answered, and four more with it.
**Every row was checked against the magic of the resource actually downloaded for it** — no enum was
transcribed:

| type | magic | what it is | fetched |
|---|---|---|---|
| 1 | `TEX ` | a texture | 3 |
| 9 | `LVLb` | **a level inside an adventure** | 10 |
| 38 | `PLNb` | a plan | 17 |
| 46 | `VOPb` | a recording | 2 |
| 61 | `CHKb` | **a streaming chunk** | 32 |
| 62 | `ADSb` | an adventure's shared data, 35-270 bytes | 2 |

The 32 chunks came from three levels on two platforms (PS3 and PS4), so 61 is not one creator's
quirk. **31 of the 32 parse clean**; the one exception is question 36.

### The surprise: an adventure is not a level, and would have opened as nothing

Four of twelve "adventure map" hashes taken off the index are **`ADCb`**, which `readBackup` skips on
its magic — `looksLikeLevel` tests for `LVLb`, `PLNb`, `CHKb` and nothing else. An `ADCb` has no
world of its own: **its levels are type-9 dependencies**, ten of which were fetched and all ten
parse clean.

So the walk is **not optional when the root cannot itself be opened**. With the checkbox unticked a
perfectly good adventure hash would have done nothing at all, silently, and a listener would have
had no way to tell that from a broken hash. `open_` tests `looksLikeLevel(root)` and walks anyway.

### What it is worth, and what it is not

⚠️ **No chunk found so far contains a sequencer** — all 32 hold zero, across an Adventure Time map,
a "big space" level and a streaming music level whose songs are all in the level and its plans. The
walk is right and the plumbing is proved; the payoff is still hypothetical, exactly as it is for
plans (16 distinct songs either way on "Music Gallery #3"). What is now certain is that a hash off
the index opens *something* whatever kind of thing it names, which was not true before.

## 29. Does a releasing voice still hold its record? — ANSWERED: yes, 2026-09-05

**Yes.** The engine frees a voice record when the sound ends, not when the note does, and that is
measured from six independent places in `fmodextinput.prx` (the table below). The question is closed.

⚠️ **What the tracker ships is a decision rather than the measurement**, and it is deliberate:
`RenderOptions.releaseTail` (`LBP_RELEASE_TAIL=1`) defaults **off**. With the tail on, a listener
rejects the render at a named timestamp; with it off, the same listener accepts it. Shipping an
artefact the game does not have is worse than shipping a model that is knowingly short, and the
switch keeps the measured behaviour one environment variable away.

**The residual is one experiment, not an unknown**: capture the game at 25.85 s of `C4K3 S0NG` and
count the choir chord's voices. Everything else on both sides is measured, including how far wrong
the decision can be — the tail newly crowds 12.7% of that song and more than half of that is one to
four records over the cap.

What follows is the whole investigation as it stood, because the wrong turns in it are the useful
part.

**The engine frees a voice record when the SOUND ends, not when the note does.** Measured in
`fmodextinput.prx`'s per-voice renderer, at the bottom of `sub_0x1c60`:

```
0x3035  xmm0 = (float)[r14+0x40]        ; the voice position, a double
0x304d  eax  = [r8 + slot*0x98 + 0x78]  ; the slot's frame count
0x3056  vucomiss xmm0, xmm1             ; past the end of the sample?
0x305c  cmp [r8 + slot*0x98 + 0x80], 0  ; ...and not looped?
0x306b  [r14+4] = 0                     ; then silence it
0x3093  [r14] = 0xff                    ; and FREE the record
0x3097  [r14+0x10] = 1
        -- or, the other way in:
0x20ea  vucomiss xmm3(=0), [r12+4]      ; has the voice's level reached zero?
0x2117  [rbp-0xb74] = 1                 ; -> free it at 0x3093
```

`[r12+4]` is the same field the allocator scores with, so the second condition is "this voice has
faded to nothing". **A record is therefore held for the note plus its release tail**, and
`occupancySteps` in `src/core/render.ts` is the note's written duration and nothing else.

### Why it is not simply implemented

Measured on `C4K3 S0NG` (13,091 notes, step = 115.4 ms). Release times in steps: median **0.18**,
p90 **2.65**, p99 **6.48**, max **10.77**; **19.1%** of notes release for longer than a step. Adding
that tail to the occupancy:

| occupancy | notes cut short |
|---|---|
| the written duration (today) | 1,526 (11.7%) |
| plus the release tail | **3,908 (29.9%)** |

⚠️ **That is worse than the bug that was just fixed.** A listener rejected 3,634 (28%) by ear as
"nothing like the original", and this would land at 3,908. So the model is missing something that
lets a releasing voice give up its record cheaply.

### `[+0x14]` — found, and it is NOT the answer

The allocator has a branch that looked like the reconciliation:

```
0x1610  test dil, dil                ; a bool the CALLER passes
0x1615  cmp dword [rax + 0x14], 0
0x1619  jg 0x1652                    ; take THIS record, before asking if it is free
0x161b  cmp byte [rax], 0xff         ; the ordinary free test
```

❌ **It is dead code in this plugin.** The allocator has exactly two callers — found by scanning
the file for `E8` displacements that land on `0x1600`, `v0x4ef` and `v0x96b` — and **both pass
`xor edi, edi`**. `dil` is never set, so the fast path is never taken and `[+0x14]` never decides
anything here.

And `[+0x14]` itself is a plain marker, written at note start by the same store that opens the gate:

```
0x0a47  mov byte [r13], r12b            ; claim the record: [+0x00] = the slot index
0x0a4b  movabs rax, 0x271000000000
0x0a55  mov qword [r13 + 0x10], rax     ; [+0x10] = 0 (held), [+0x14] = 10000
```

The block driver zeroes `+0x10` and `+0x14` together when it frees a record (`0x10a0`-`0x10a3`). A
constant 10000 and a dead branch.

⚠️ **Correction, 2026-09-05: it IS read again.** `sub_0x3930` opens with

```
0x3944  cmp dword [rsi + 0x1a44], 0     ; a state-block flag
0x394b  jne 0x395f
0x394d  cmp dword [rbx + 0x14], 0       ; <- the "never read again" field
0x3951  jne 0x395f
0x3953  test r14, r14
0x3956  jne 0x395f
0x3958  mov dword [rbx + 0x10], 1       ; release the voice
```

so a record whose `+0x14` is **zero** is released when that state flag is clear. On a claimed record
`+0x14` is 10000 and the branch never fires, which is why this changes no number — but "nothing
reads it" was wrong and the next person to look would have found the same instruction and wondered
what else the note had missed.

### So the tail really is held, and the discrepancy is somewhere else

With that door closed, everything measured says the engine holds a record through the release:

- the free predicate is the **envelope reaching zero** — `0x2089` calls the envelope, `0x20e0`
  compares its result against 0 and jumps to `0x2117`, which sets the flag `0x307f` reads to free
  the record at `0x3093`;
- the allocator's score is `[+0x04] * [+0x0c]`, and the renderer only ever **reads** those, so a
  fading voice does not become a cheaper victim as it fades;
- the release times are not inflated: `ENVELOPE_SECONDS_PER_UNIT = 4` is measured off the engine's
  own `dt` arithmetic, not chosen.

### ❌ "The steal sounds different" — refuted by the code, 2026-09-04

The hypothesis was that the engine hands the record over smoothly where we stop the voice dead, so
that the same count of steals would sound far gentler. **It does not.** The note-start path calls
the record initialiser at `0x19e0`, and that opens with:

```
0x1a06  xor esi, esi
0x1a08  mov edx, 0xd0        ; the whole 208-byte voice record
0x1a0d  call 0xe0            ; zero it
0x1a12  mov byte [rbx], r14b ; then the slot index
0x1a1a  [rbx+0x28] = xmm0    ; the modulation
0x1a1f  [rbx+0x10] = 0       ; gate: held
```

`0xe0` is a PLT stub taking `(record, 0, 0xd0)` with its result discarded; a source pointer of zero
rules out the `memcpy` in the import set, so it is a fill. ⚠️ The NID was **not** resolved — this is
measured from the call's shape, not from the symbol.

**So the engine wipes the record: envelope accumulator, position, phases, all of it.** The stolen
voice stops instantly and the new note starts from silence. `Voice.renderChunk`'s hard stop at
`begin + this.cut` is exactly what the game does, and a fade would be an invention. **Do not add
one.**

### Where that leaves it

Every part of the engine's side is now measured and none of it explains the ear:

| | |
|---|---|
| the pool is 32 | ✔ `(0x1a28 - 0x28) / 0xd0` |
| a stacked note takes one record | ✔ the layer loop is inside the per-voice renderer |
| a record is held until the envelope reaches zero | ✔ `0x2089` → `0x20e0` → `0x3093` |
| a releasing voice is not a cheaper victim | ✔ the score fields are only read |
| the `[+0x14]` fast path could yield one | ❌ dead: both callers pass `dil = 0` |
| release times are not inflated | ✔ `ENVELOPE_SECONDS_PER_UNIT` is measured |
| a steal is abrupt in the game too | ✔ the record is zeroed on takeover |

That predicts **29.9%** of `C4K3 S0NG`'s notes cut short, and a listener says the game is nothing
like that. Both candidates on **our** side have since been checked, and both are clean:

- ✔ **`durationSteps` is right**, to the third of a step. The gate closes at
  `lastStep + 1 + endSubStep/3` and that is exactly what `endPosition - startPosition + 1` gives.
  See *30* in [answered-questions.md](answered-questions.md) for the two halves of the mechanism.
- ❌ **"We schedule notes the engine would not" was a misreading, closed 2026-09-04.** The skip at
  `0x04d4` tests `channelVolume x clipLevel`, **not the note's velocity** — `0x04cb` multiplies by
  `[clip + 0x420]`, which `v0x1607c6` fills from `PInstrument.Level`. Measured over the corpus:
  **0 of 74,864 clips set `Level` to zero and 0 notes sit on a muted channel**, so the skip never
  fires on real data. The 701 notes were zero-**velocity** — a quantity the test does not look at —
  and the engine gives every one of them a record, exactly as we do.

❗ **What that chase did turn up is a real divergence, and it is now the whole of this question.**
`sub_0x3930` rewrites both score factors once per block: `[record+0x04]` from the channel volume
times the clip's `Level`, and `[record+0x0c]` from **the current control point's** velocity
(`0x3c29 bextr eax, [note], 0x810`). So the engine's score **follows the note's volume automation**,
and a note fading out becomes the cheapest thing in the pool while it fades. `allocateVoices` scores
a note once, at its opening velocity, and never again.

That is a mechanism by which a note on its way out yields its record early. **It was measured before
being built, and it does not help this question at all.** Scoring every note by the quietest point
it ever reaches — the most generous a following score could ever be to a thief — gives **1,494**
steals against today's 1,411. Slightly *more*, not fewer.

❗ **Because the score does not decide HOW MANY notes are stolen, only WHICH ones.** The count is
set by the occupancy model alone: when more than 32 records are wanted at once, something is stolen
whatever the scores say. So no refinement of the score can move 29.9% toward what the ear accepts,
and **this question is entirely about occupancy**. The score work stands on its own — the clip's
`Level` was genuinely missing and is now in — but it is not the way in.

What remains, then, is the same single fact with nothing else attached: the engine holds a record
until the envelope reaches zero, and a listener says the game is nothing like that. Every other
number on both sides is measured and agrees — including the envelope itself, whose release is now
verified identical to ours (*32* in [answered-questions.md](answered-questions.md)), so there is no
shorter tail hiding in it. Computed properly, with the level the envelope had actually reached at
the gate rather than the full `0 → 1` time, the tail gives **22.3%** against today's 10.8%.

### ❗ A listener found the reproducer, 2026-09-04

The release tail was implemented and the song rendered for judgement. The verdict came back with a
timestamp: *"at 0:25 a choir note is interrupted; in the original it is not."*

At **25.85 s** `C4K3 S0NG`'s choir (`choir.rinst`, guid 186894) starts a five-note chord and **four
of the five are stolen at the instant they start**, so they never sound at all. With the tail off,
**nothing is cut in that window**. The A/B is exact and the reproducer is two seconds long.

Why the choir and not something else: it is genuinely the cheapest thing in the song. Its clips
carry `Level` 0.09-0.60 against 1.0 for the drums and strings, and its velocities run 28-91 against
127 — a score of 0.033 where the drums score 0.750. **Our score is the engine's formula exactly**
(`channelVolume x clipLevel x velocity/127`, `sub_0x3930` `0x3afc`-`0x3c3a`), so the engine would rob
the choir first too. The disagreement is not about which voice is stolen; it is about whether the
pool was full.

⚠️ **And the song sits right on the edge**, which is why this is so sensitive: most instruments have
releases of 0-70 ms and add under 10% to their occupancy. One (`129081`, 1,694 notes) has 305 ms
against a 231 ms median gate and nearly doubles its own hold. That small a change in total occupancy
moves **1,512 notes** between cut and not cut.

### ❗ Re-derived from the binary, 2026-09-05 — and the framing was wrong

Every link was disassembled again from scratch, and **all of them hold**:

| | address | what it says |
|---|---|---|
| the allocator | `0x1620`-`0x1631` | score is `[rec+0x04] * [rec+0x0c]`, minimum wins; a free record (`byte == 0xff`) short-circuits first |
| the score's factors | `0x3b12`, `0x3c3a` | `[+0x04] = channelVolume x clip Level`, `[+0x0c] = the control point's velocity` |
| the free predicate | `0x20de`, `0x20e4`, `0x20f1` -> `0x3093` | freed when the envelope's level reaches **zero at both ends of the block**, or the score factor is zero |
| the sample-end free | `0x3035`-`0x3069` | position past an unlooped sample's frame count |
| the gate | `0x3a24`, `0x3a4b`, `0x3a5a` | the record walks its clip's note chain and releases at the note carrying bit 15 |
| a released voice | `0x3963` -> `0x3f06` | **skips the score update entirely**, so it keeps the score it had — it does not fade into being a cheap victim |

So the engine's side is not in doubt and there is no unexplored door in it.

### ✔ What the numbers say instead, measured 2026-09-05

Two censuses of `C4K3 S0NG`'s *uncapped* demand, taken from the plan the renderer builds.

**At 25.85 s, the listener's own reproducer:**

| | records held | of them releasing |
|---|---|---|
| tail off | **18** | 0 |
| tail on | **35** | **17** |

and the seventeen tails are three instruments — `synth_strings` (6), `choir` (6), `mime_artist` (5).
All three have **decay 0 and sustain 1.0**, so a note reaches the gate at full level and its tail is
the whole release: 0.176 s, 0.076 s, 0.058 s. It is a chord change: the outgoing chord is still
decaying while the incoming one asks for records, and three instruments changing chord together is
what puts 35 where 32 fit.

**Over the whole song, and this is the part that reframes the question:**

| | median | p95 | p99 | peak | over 32 |
|---|---|---|---|---|---|
| tail off | 21 | 42 | 51 | 61 | **16.0% of the song** |
| tail on | 25 | 48 | 56 | 75 | **28.7% of the song** |

❗ **The pool is not "tipped over" by the tail — it is saturated either way.** Our model already
wants more than 32 records for a sixth of the song with the tail off, peaking at 61, and the
listener accepts that render. So the tail is not the thing that turns a comfortable song into a
crowded one; it roughly doubles the time already spent over the cap, and the ear rejects the
difference between 16% and 29%.

That moved the suspicion onto the baseline, and the baseline was then checked.

### ✔ The baseline is not ours — it is the song, 2026-09-05

Counted **straight off the note records**, with no renderer in the way: every track's `stepOffset`
plus each note's `startPosition`, held for `endPosition - startPosition + 1`.

| | median | p95 | peak | over 32 |
|---|---|---|---|---|
| from the raw records | 24 | 44 | 63 | **21.0%** |
| what the renderer asks the pool for | 21 | 42 | 61 | 16.0% |

**`C4K3 S0NG` writes more notes than the hardware can play**, and our occupancy is *lower* than the
music, not higher — the sample-exhaustion rule takes 21% down to 16%. Three ways it could have been
our fault were checked and all three are clean:

- ❌ **Duplicate placements.** All **244 tracks are distinct** in at least one field with positions
  included; 85 distinct clip contents reused at different offsets, which is composition.
- ❌ **One-shot overhang.** `max(durationSteps, oneShotSteps)` could have inflated drums. **0 of the
  13,091 notes are one-shots** in this song, and the overhang is 0 record-steps.
- ❌ **The note length.** `duration` and `endPosition - startPosition + 1` disagree on 1,057 notes,
  which looks alarming and is not: `duration` is whole steps (`endStep - startStep + 1`) and the
  other carries the sub-step, so the gap is the triplet population. `render.ts` uses the sub-step
  one, which question 30 verified. The gate walk read today agrees: `0x3a41 cmp r12d, edx; jle` —
  the release fires as soon as the integer step **passes** the last point's step.

❗ **So the engine steals constantly on this song, tail or no tail.** A fifth of it wants more than
32 records. "The game does not sound truncated" cannot mean "the game never steals": it steals a
lot, and the ear does not hear it, because the victim is always the cheapest voice in a texture of
twenty-four.

### ✔ What the tail actually changes, and it is small

Comparing the two occupancy timelines moment by moment:

| | share of the song |
|---|---|
| over 32 with or without the tail | 16.0% |
| **over 32 only because of the tail** | **12.7%** |
| over 32 only without it | 0.0% |

And in that newly crowded 12.7%, how far over it goes:

| records wanted | share of that time |
|---|---|
| 33-34 | 29.6% |
| 35-36 | 24.0% |
| 37-40 | 28.3% |
| 41-48 | 16.1% |
| 49+ | 2.0% |

**More than half of it is one to four records over.** So the tail is *marginally* too generous, not
structurally wrong — and what it does is turn passages that were comfortably under the cap into
passages that steal. That is exactly where an ear notices, and it is why the reproducer is a quiet
chord change at 25.85 s (18 records without the tail, 35 with) rather than a dense one.

⚠️ **A pool of 36, or a tail 15% shorter, would erase most of the difference.** Neither is
justified by anything measured — the pool is `(0x1a28 - 0x28) / 0xd0 = 32` and the release is
verified identical to the engine's — but it says how small the remaining error is, and that a
capture only has to settle a few records either way.

### Where it has been left

`RenderOptions.releaseTail` (`LBP_RELEASE_TAIL=1` on the CLI), **defaulting OFF** — the unmeasured
reading. That is deliberate and uncomfortable: the engine plainly holds the record through the
release, and shipping an artefact the game does not have is still worse than shipping a model that
is short. The switch keeps the measured behaviour one environment variable away.

✔ **Confirmed by ear on the corrected render, same day**: with the tail off the choir enters whole
at 25.85 s and the passage sounds right. That is one listener against a static reading of the
binary, and it is what the default rests on until a capture says otherwise — the same kind of
evidence, from the same person, that settled question 10.

✔ **One thing did come out of it and is unconditional**: a voice whose **unlooped sample runs out**
gives its record back — the other half of the engine's free condition (`0x3035`-`0x3065`, the
position past the frame count with no loop) and it was missing here. A drum whose sample lasts 0.2 s
no longer holds a record for its 1 s release. That alone took the default from 1,411 cuts to
**1,318**.

### It cannot be settled from the binary, and here is what would settle it

Both models are self-consistent; what separates them is what the game **sounds like** on a dense
passage, and that is a recording. This project has done exactly that before — question 10, the
one-shot gate, was settled against a capture of the game and overturned what the code had implied.

The experiment is now **two seconds long**: capture `C4K3 S0NG` from the game around **25.85 s** and
listen for whether the choir chord enters with five voices or one. That is the whole question, and
it needs no counting.

⚠️ **And be ready for the answer to be uncomfortable.** With the tail, the game plays at most 32
notes at once; without it, this renderer routinely runs 35 to 50. If the tail is right then our
render is *denser* than the game's, which is exactly why it sounds less truncated — the cuts are
masked by notes the game never played. The version that sounds better may be the wrong one.

**So every number on both sides of the line is now measured, and they still disagree with the ear.**
That is where this stands. The remaining thread is the one the volume test exposed: its multiplier
is indexed by the note record's **bits 28..29**, the block-table select, into a four-entry table at
`+0x420` — which is not the row-to-channel mapping `channelVolume` uses. Somebody should find out
what `[rbp-0x78]` and that table are before trusting either reading.

⚠️ **And our own two halves disagree.** The mixer keeps a voice alive through its release
(`env.finished` ends it); the pool frees the record at the note's written end. The pool is the
optimistic one, and it is the half that matches the ear — a coincidence until something above
explains it.

⚠️ **Do not implement the tail until this is answered.** Today's model is knowingly short by the
release, and short is audibly right; long is audibly wrong.

## 36. The island that would not parse — ANSWERED: one byte, 2026-09-05

`parentBoneIndex` in `PControlinator` is **one byte**, and `readControlinator` read it with
`s.i32()`.

### Why the whole corpus missed it

⚠️ **With `COMPRESSED_INTEGERS` an `i32` of 0 is a single varint byte.** Every level and plan this
project has ever parsed is `cf7`, so `s.i32()` consumed exactly one byte there and was right by
accident on 62,158 placements. The chunks pulled out of the public archive are **`cf0`** —
uncompressed, every integer at full width — and there the same call ate four bytes and left the
reader three past the next Thing's `0xaa`.

❗ **So `cf7` hides field-width bugs, and until 2026-09-05 this project had no `cf0` corpus at all.**
That is the general lesson, and it is worth more than the fix: any field whose value is usually zero
or small reads correctly under compression whatever width it is declared with.

### How it was found, which is the part to copy

The failure is reported one Thing later — that is what the `0xAA` marker is for — so the byte it
names is never the byte that is wrong. What located it:

1. `setTrace` from `thing.ts` gives every part's span. It put the failure inside `CONTROLINATOR`
   (64938-65710) and showed the Thing before it closing at 65710.
2. Wrapping every `Serializer` method on the island's `thingData` logged each read as
   `(name, start, end, value)`. **Values, not just widths** — widths align at any offset.
3. The tail of `SWITCH` read plausibly (radius 250, 18 outputs, `angleRange` 180,
   `randomOnTimeMin/Max` 30 and 30), so that part was aligned. The next field was not:
   `parentBoneIndex = 4,161,536`.
4. `4,161,536` is `0x003F8000` — a zero byte followed by three quarters of `3F 80 00 00`, which is
   **1.0f**. Dumping the raw bytes settled it: an identity matrix begins at 65641, its four 1.0s
   landing exactly on m00, m05, m10 and m15, and `CONTROLINATOR` ends at 65707 — which is where the
   `-1417.5f / +1417.5f` min-max pair after it starts.

### What it is worth

| | before | after |
|---|---|---|
| archived chunks parsing | 31 of 32 | **32 of 32** |
| island problems | 1 | **0** |
| Things recovered from them | — | **5,832** |
| the golden fixture | 62,158 placements byte for byte | **unchanged** |

✔ **The 32 chunks are now a `cf0` regression corpus**, which is a dimension the ten-level corpus
never tested. Anything that reads a field width should be run against them.

## 34. The live scheduler's -57 dB — ANSWERED: it was the simulator, 2026-09-05

`dev/live-sim.ts` measured the scheduled path at **-56.8 dB** against the direct render on
`C4K3 S0NG` and **-59.1 dB** on `Ascetic`, while its own header said the two should be identical.
They are. **The fault was in the measuring instrument.**

### The scheduling tick and the render block are two different cadences

`dev/live.ts` posts notes every `TICK` (0.1 s). The worklet renders **128 frames** per `process()`
call, whatever the tick is. The simulator rendered `TICK * RATE` = **4,800 frames** per call, which
is **37.5** of the mixer's 128-frame modulation chunks — so every other burst cut a chunk in half,
`refreshMorph` ran at a different `elapsed`, and the modulation came out at a different frame.

✔ **Proved before it was fixed**: with `LBP_TICK=0.08` — 3,840 frames, exactly 30 chunks — the
scheduled render went to **-Infinity dB**, bit for bit, with nothing else changed.

⚠️ **Rendering 128 frames at a time is not by itself the fix, and this is the part that cost the
extra hour.** Quanta restarted at each tick boundary are every one of them 64 frames off the grid,
because `4800 % 128 = 64`, and the figure did not move: still -48.5 dB. The quanta have to run on
the **stream's** grid with the posting happening inside that loop — which is what the player does,
and is now what the simulator does.

### What it measures now

| | `C4K3 S0NG`, 40 s, pool 32 | `Ascetic`, 30 s |
|---|---|---|
| blocked, played once | -Infinity | -Infinity |
| scheduled (live) | **-Infinity** (was -56.8) | **-Infinity** (was -59.1) |
| live pool | **-Infinity** (was -56.9) | — |

**All three paths are now bit-identical to the offline render**, with 1,318 of 13,091 notes stolen
by the pool in the live path exactly as offline.

### ❌ Two fixes to the mixer that were made and reverted

Both looked right and neither was needed once the simulator was correct, and reverting them is the
point: **the mixer was never wrong.**

- Making the chunk grid the *stream's* (`(origin + at) % 128`, with the mixer counting frames
  rendered) rather than the call's. It moved `C4K3 S0NG` from -56.8 to -63.8 dB and `Ascetic` from
  -59.1 to -89.7 — an improvement that was really a different wrong answer.
- Refreshing the morph once per grid chunk rather than once per `renderChunk`, for chunks split
  across a call boundary. It changed nothing measurable on top of the first.

⚠️ **A partial fix that improves the number is the most misleading result there is.** Both of those
made the figure better while the actual cause was untouched, and either could have been committed as
"the fix" with a 7 dB improvement to show for it.

### The tool keeps what it learned

`LBP_SCAN_BLOCK` and `LBP_DIFF_BLOCK` now take the block size, defaulting to 128. **128 is the one
size that hides this**: every call the worklet makes is 128 frames and the offline render makes one
call, so both sit on the grid. Scanning at 128 reports nothing; scanning at 4,800 reported 270 of
600 voices differing on their own.

### What it was, as it stood

`dev/live-sim.ts` says the two should be identical: the same voices with the same specs, and only
the moment each is handed to the mixer differs. Measured 2026-09-04 they are not, by a small
constant amount:

| song | scheduled vs direct |
|---|---|
| `C4K3 S0NG`, 40 s | **-56.8 dB**, worst at 30.038 s |
| `Ascetic`, 30 s | **-59.1 dB**, worst at 13.183 s |

✔ **It is not the voice pool.** The figure is the same with the pool off, and `Ascetic` steals
nothing at all. ✔ **It is not the block size**: the "played once, rendered in 128-frame blocks"
variant is bit-identical to the direct render (`-Infinity dB`), which is the invariant
`test/audio.test.ts` pins.

So it is the hand-over itself, and the obvious suspects do not survive a reading: `delay` is
`round(at - now)` where `at` is already an integer frame and `now` is a block boundary, so it is
exact; `endFrame` rebases to the same length; the LFO phases are frozen per plan row by the
simulator on purpose.

**0.14% of RMS is inaudible** and this has presumably been there since the scheduler was written,
which is why nobody heard it. It is worth a name anyway: a live render that is not bit-identical to
the offline one is a fact this project would rather know than discover later.

**The anchor**: `LBP_DIFF=<index>` in `dev/live-sim.ts` already bisects one voice's two renders
frame by frame. Find a voice near 30.038 s whose scheduled render differs, and it will be one spec
small enough to put in a unit test.

## 8. The remaining fields — ANSWERED: LFO 3 pans, read end to end, 2026-09-05

All 27 `Params` were named on 2026-09-01 and implemented by 2026-09-02. What kept this open was one
sentence: LFO 3's *fold* was measured instruction for instruction, but its **destination** was a
reading — "`t` lands in 0..1 and `panGains` is this voice's only consumer of one". It is now read.

### The chain, in the order the code walks it

```
0x2670  xmm0 = [voice + 0x18] + [voice + layer*4 + 0x7c]   ; clip pan + the layer's unison spread
0x26c6  call 0x130                                          ; _FSin
0x26cb  xmm0 = sin * depth
0x26db  xmm0 = base + that
0x262c..0x2649 / 0x26f9..0x270f   abs, x0.5, floor, frac, x2, and 2-t above 1   ; the fold
0x2657  vpshufd xmm0, xmm0, 0                               ; broadcast to four lanes
0x266b  [rax - 0x10] = xmm0                                 ; rax = rbp-0x160 -> buffer 1's VALUE
0x274f  [r13]        = xmm0                                 ; ...and its INCREMENT, one block later
```

Two folds rather than one, because the block is evaluated at both ends and ramped across — the same
shape the amplitude envelope uses.

### And buffer 1 is the pan

The per-sample loop reads it back and spends it:

```
0x2c04  xmm1 = [rbp + layer*32 - 0x170]     ; buffer 1's value
0x2c40  [rbp - 0xa10] = xmm1
0x2d19  xmm3 = [rbp - 0xa10]
0x2d21  xmm1 = 1 - xmm3                     ; the left gain
0x2d25  xmm1 = xmm1 * sample
0x2d2e  [rbp + rax*4 - 0x9c0] += xmm1       ; into the output
```

`1 - p` then `p` at `0x2d40` is the **linear pan law** question 22 already measured and excluded as
a suspect. So the field LFO 3 writes is the field the pan law consumes, with nothing in between.

✔ **Three layers of pan compose, and all three are now read**: the clip's own pan (`voice + 0x18`,
written per block by `sub_0x3930` from `[clip + 0x424]`), the unison stack's per-layer spread
(`voice + layer*4 + 0x7c`, written from `Params[1]` at note start), and LFO 3's triangle on top.
`src/audio/lfo.ts` and `src/audio/mixer.ts` already do exactly this — the reading was right, and it
is now a measurement.

⚠️ **Two buffers, and telling them apart is the whole trick.** The layer loop keeps two
`{value, increment}` arrays on the stack, 32 bytes per layer: `rbp-0x170` and `rbp-0xd0`. LFO 2's
gain ramp — `sin * depth`, then `+ 1`, then a multiply — goes to `rbp-0xd0` (`0x2511` value,
`0x25a5` increment) and is spent at `0x2d0d` as a gain. LFO 3's goes to `rbp-0x170`. Reading either
store without following its pointer to the sample loop names the wrong destination.

### The rest of the question was already settled

- `Numstack` is the per-instrument layer count, walked from layer 0 at `0x1a98`.
- `Loops` is **1 in all 105,785 instruments of the corpus**, so no creator has used it.
- The 27 `Params` are the unison stack, the ladder, two ADSRs, three LFOs and the output stage; the
  table is in [sequencer-data-model.md](sequencer-data-model.md).
- The oscillator at stub `0x130` is `_FSin`, named from the PRX's import table by `tools/prxnid.py`
  rather than inferred — it takes an integer selector in `edi`, zero for sine.

## 9. Board row → mixer channel — ANSWERED and IMPLEMENTED: bands, 2026-09-05

**The board is cut into `NumChannels` horizontal bands of equal height, and a placement's channel is
the band its row falls in.**

```
rows    = floor(circuitBoardSizeY / 105 + 0.5)    the board's height in cells
divisor = max(rows / NumChannels, 1)              integer division, at least one
channel = clamp(row / divisor, 0, NumChannels-1)
```

`v0x1608d0` writes it into the 16-byte block header; `v0x1c7909`-`v0x1c793c` computes the divisor;
`v0x1c452a` is the `<< 4` that indexes the array. The plugin's `mod 8` at `0x3afc` — which every
earlier reading reasoned from — is a **bounds guard on an already-clamped value**, not the mapping.

### ❌ Two wrong readings preceded it, and both were reasonable

- `gridY` as a **direct index**. Killed by the corpus: 88% of tracks have a `gridY` outside
  `0..NumChannels-1`.
- `gridY % NumChannels`. It put every row in range by construction, a listener had already corrected
  an earlier `% 8`, and it shipped for two months. It wraps where the game bands: **667 of 1,821
  tracks change channel** on the ten multi-channel sequencers in the corpus.

⚠️ **No amount of corpus work could have settled it.** 308 of 338 sequencers set `NumChannels` to 1,
where every row lands on channel 0 under banding, wrapping and a direct index alike. It took the
writer, and the writer took the method note this question had been carrying since 2026-09-02:
byte-scan for `E8` displacements landing on a known callee, find the caller's prologue by searching
backwards for `55 48 89 e5`, and disassemble from **there** — never from a round address.

### The datum that was missing was in the file all along

`readMicrochip` read `circuitBoardSizeX` and `circuitBoardSizeY` and **threw both away**. They are
now kept, carried out through `FoundSequencer.boardHeight`, and turned into `Sequencer.boardRows`.

✔ **The corpus confirms the unit twice.** Board heights come out **3..25 cells, median 13**, and 25
is exactly the largest row any placement uses. In all 51 sequencers with tracks the highest
placement sits **strictly inside** its board — `max gridY` 24 against `max rows` 25, **none**
outside. A half-extent or a doubled unit would put placements off the board everywhere; none is.

### What it touched

`channelVolume` bands, and falls back to the old modulo only when `boardRows` is 0 — which never
happens on a real level, because `circuitBoardSizeY` is written at every revision this reader
accepts. ⚠️ `boardRows` is also now in the **MIDI header**, for the reason `midi-interchange.md`
gives: MIDI has no board, and losing it re-routes every track on the way back.


## 12. `Params[2]` — ANSWERED, 2026-09-05: the engine throws layer 0's away

The contradiction stood for three days: the stack loop computes a random start offset for **every**
layer including layer 0, six of the game's kits set `Params[2]` to a flat `1.000` with `Numstack`
1, and applying it as written starts every kick, snare and hat at a uniformly random point inside
its own sample. A listener called that "the start of the sample skipped, only the cut tail, with a
click", and confining the three randomisations to layers 1+ was worth **11.6 dB** of drum kit.

**The answer is the instruction after the loop.** `sub_0x1a70` ends:

```
0x1bca  inc rbx
0x1bcd  cmp ebx, [r15 + 0x4e4]           ; Numstack
0x1bd4  jl  0x1aa0                       ; <- the loop
0x1bda  mov qword ptr [r14 + 0x40], 0    ; LAYER 0's START POSITION, CLEARED
0x1be2  mov qword ptr [r14 + 0x90], 0
0x1bed  call 0x140                       ; rand()
0x1bfa  vmulss xmm0, xmm0, [v0x4550]     ; 5.8516725e-09 = 2*PI / 2^30
0x1c02  [r14 + 0x98] = xmm0              ; LFO 1's start phase
0x1c0b  ... [r14 + 0x9c] = ...           ; LFO 2's
0x1c29  ... [r14 + 0xa0] = ...           ; LFO 3's
0x1c51  ret
```

`+0x40` is a qword — layer 0's position is a `double` and this is exactly it, not the pitch at
`+0x68` and not the pan at `+0x7c`. **Both paths reach it**: the loop falls through, and the
`Numstack <= 0` guard at `0x1a92` jumps straight there. Nothing later in the function writes it and
the function ends at `0x1c51`.

So the engine does draw a random start for layer 0, and then starts layer 0 at zero. **The repair
made by ear was the engine's own behaviour**, and it is now in the code for that reason instead.

### The corpus says the same thing, from the other end

`Params[2]` is non-zero on 27 of the 68 instruments and **18 of those 27 have `Numstack` 1**, where
the field is now known to do nothing at all. That is what makes a flat `1.000` on six drum kits an
unremarkable thing for a sound designer to leave in a patch: the knob is inert on a single-layer
instrument, and the editor does not say so.

The other two of the three are **not** cleared, and that is the half this project had wrong:

| param | applies to layer 0? | non-zero on | of those, unstacked |
|---|---|---|---|
| `Params[0]` detune | **yes** | 29 instruments | 19 |
| `Params[1]` pan spread | **yes** | 15 | 4 |
| `Params[2]` start offset | **no**, cleared at `0x1bda` | 27 | 18 |

Confining all three to layers 1+ therefore silently dropped a per-note detune from 19 unstacked
instruments and a per-note pan scatter from 4. The strongest case is `baiyon_city_guildford`
(`Numstack` 1, detune `0.406..0.394`, spread `0.631..0.000`): its 616 notes in `Zero` (uid 15844)
now spread over pan **0.317..0.685** and ±230 cents of rate variation where they used to be a
single dead-centre value. `baiyon_drums_1`, `baiyon_tinkle_01` and `baiyon_shiny_01` are the others.

### `RAND_MAX` is `2^30 - 1`, measured out of the game's own libc

The multiplier at `v0x4540` is `9.3132257e-10`, exactly `2^-30`, and whether `rand() * 2^-30` is
`U(0, 1)` depends entirely on what `RAND_MAX` is. Reasoning about it was going nowhere — the PS4's
libc is FreeBSD-derived, where `RAND_MAX` is `2^31 - 1`, which would make the pitch spread
`U(-p, +3p)` and put half of every kit's hits past the end of their own sample.

❗ **The game ships its own libc**, at `sce_module/libc.prx`, and the import resolves to it: the
NID suffix `#B#C` indexes `IMPORT_LIB` id 1 and `NEEDED_MODULE` id 2, both named `libc`. So the
function is a file on this disk. `prxnid.py libc export rand` puts it at vaddr `0x17000`, 37 bytes:

```
0x17000  lea    rcx, [rip + 0xa18e9]              ; the state, initially 1
0x17007  movabs rax, 0x5851f42d4c957f2d
0x17011  imul   rax, [rcx]
0x17015  inc    rax
0x17018  [rcx] = rax                              ; a 64-bit LCG
0x1701b  shr    rax, 0x20
0x1701f  and    eax, 0x3fffffff                   ; <- RAND_MAX = 2^30 - 1
0x17024  ret
```

`rand() * 2^-30` **is** `U(0, 1)`, the `2^-30` is exactly `1/(RAND_MAX + 1)`, and the pitch and pan
lines beside it really are the symmetric `U(-d, +d)` they look like. The steering had been calling
it `U(0,1)` on an assumption since the block was first read; it is a measurement now.

### The three LFO phases, and why they are not per layer

`0x1bed`-`0x1c3e` draws three `U(0, 2*PI)` phases into `+0x98`, `+0x9c`, `+0xa0`. **The offsets
carry no layer index**, so a stacked voice's five layers share one base phase and differ only by
`Params[17|20|23] * 2*PI / Numstack * layer`. This project drew a fresh phase per layer, which is a
more diffuse sound and not the engine's; `src/core/render.ts` now draws once per note and `Lfo`
takes the phase rather than a generator.

### The voice record's layer arrays tile at exactly five

Falling out of the same read, and worth having because it bounds `Numstack` from the engine rather
than from the corpus:

| offset | array | stride | five layers end at |
|---|---|---|---|
| `+0x40` | start position, `double` | 8 | `+0x68` |
| `+0x68` | pitch factor, `float` | 4 | `+0x7c` |
| `+0x7c` | pan offset, `float` | 4 | `+0x90` |

`+0x90` is the next field, cleared at `0x1be2`. **Five is the maximum**, and `choir` and
`synth_strings` — the corpus's largest — are exactly 5.

### Two corrections to what steering said about the slot

Both were in *12b* and both were nearly right; the mip builder's head reads differently from a
function start:

- **`+0x78` is not "the sample length" written by the mip builder.** The length is `+0x00`. `0x12e5`
  *clamps `+0x78` down to it* and zeroes `+0x7c`/`+0x80` when it does, which is "the playable end
  ran past the buffer, so truncate and drop the loop". Everything downstream is unchanged: `0x304d`
  stops a voice past `+0x78` and `0x1ad1` scales `Params[2]` by it, so `slot.wav.channels[0].length`
  is still the right thing for the tracker to use.
- **The stack loop reads the length of the note's own zone**, not of slot 0: `0x1aa0` reloads
  `[r14 + 0xcc]` and `0x1aca` multiplies it by the `0x98` slot stride each iteration.

### The wrong turns, and the first one is the one that matters

- ❗❗ **The answer was already written down, on 2026-09-01, and nobody joined it up.**
  `steering/sequencer-data-model.md` has carried the line `voice.position[0] = 0 ; layer 0 always
  starts at the beginning` in its stack-loop pseudocode since commit `f559cf5`, the *same* commit
  that first read the loop. Two lines below it, the same section's table said "`Params[2]`: **each
  layer** begins at `range · length · U(0,1)` frames in". The file contradicted itself in one
  screen, question 12 was opened beside it, re-attacked three times over four days, and repaired by
  ear — while the measurement sat there.

  **The lesson is not about the engine.** A steering file is only ground truth if a claim added to
  it is checked against what the file already says; a prose table restating a pseudocode block is
  exactly where the two drift apart, and the drift is invisible because both halves look measured.
  Before adding a summary row next to a transcript, read the transcript.

- ⚠️ **Every re-read stopped at the `jl`.** The range steering named was `0x1a70`-`0x1bd5`, and
  `0x1bd5` is the byte after the loop's backward jump — so three separate sessions disassembled
  exactly up to the answer and no further. **When a note quotes an address range, disassemble past
  its end**: a range that stops at a loop's back-edge stops before the loop's own conclusion.
- ⚠️ **Four searches went looking for who writes `+0x78` in the eboot** (see *12b* and question 12's
  old text): no `imul ..., 0x98`, no per-field stores, no `setParameterData`, and finally the
  discovery that the eboot owns all 6,992 bytes and hands them over by pointer. All of it correct,
  all of it irrelevant — the field was never the problem.
- ⚠️ **"1.000 is a default nobody changed" was killed by the corpus** (10 instruments at exactly
  `1.000/1.000` against 41 at `0.000/0.000`) and that was taken as evidence the field must *do*
  something. It does; just not on those ten. A parameter can be deliberately set and still be inert.
- ✔ **The listener's ear was right and the reasoning behind the repair was wrong.** "A per-layer
  randomisation exists to decorrelate stacked layers, and one layer has nothing to decorrelate" gave
  the correct answer for `Params[2]` and the wrong one for `Params[0..1]`, which is why the repair
  had to be split rather than kept.

## 3. Grid resolution and the block clock — ANSWERED, 2026-09-05

Question 3 asked for the grid, the swing and the triplets. The first two were settled earlier
(`gridX = floor(2x/105 - 0.5)` at `v0x1c4ad0`, 32 steps per 105 world units at `v0x1c5cda`, and *3b*
above for swing); this is the rest, and it turned out to be the clock the whole scheduler runs on.

### ✔ The running position is in STEPS, confirmed from the other end

`[state+0x1a4c]` was *called* a step position on the strength of `720000/tempo` being a step length.
It is one, and the proof is in the scheduler rather than in the arithmetic. `0x0d11`-`0x0d1f`:

```
esi = [clip]                   ; the clip's cell index
esi <<= 4                      ; * 16
if (newPosition >= (float)esi) ...      ; and again at 0x0d5b with + [clip + 0x1c], its length
```

A clip starting at `cell * 16` in the same units as the position means **16 steps per board cell**,
which is exactly the geometry question 3 already had from the world-space side. Two independent
measurements, one number.

### ✔ The engine's block is 256 frames, fixed

`fmodextinput.prx`'s DSP read callback, the module's only export, at `0x0170`:

```
0x0184  assert inchannels == 4 && outchannels == 4    ; else int 0x41
0x0194  memset(outbuffer, 0, length * 16)             ; 4 channels of float
0x01a4  test r14b, r14b ; jne -> int 0x41             ; assert (length & 0xff) == 0
0x01c4  mov esi, 0x100                                ; <- 256
0x01cc  call 0xa90(outbuffer, 256, state)             ; the block function, in a loop
```

**256 frames per block**, and the callback refuses a length that is not a multiple of it. Everything
the modulation feeds — the three LFOs, the ramped volume, pitch, pan and modulation, the drive, the
sends — is re-derived once per that block (question 27 for the cadence; this is the length).

⚠️ **`MORPH_FRAMES` was 128 and that was the AudioWorklet's render quantum, not the engine's block.**
It is 256 now, and because 256 no longer divides a live render's call, the grid had to move from
"the offset within this `render` call" to a **mixer-wide frame clock**. Three things follow, all in
`src/audio/mixer.ts`:

- `Mixer.clock` counts frames modulo the block and is handed to every voice, so a 128-frame live
  call and a whole-song offline call cross the same boundaries;
- a chunk that *continues* a block must not re-derive, so `Voice.derived` gates the first one per
  voice rather than per call;
- the oscillators moved out of `renderChunk` into `stepLfos`, advanced by the whole remaining block
  and never by the part of it a caller happened to ask for. Advancing per call stepped them twice as
  often as an offline render and broke the equality outright — it was the first thing to fail.

Worth **−50.6 dB** of difference over 30 s of `Zero` at an unchanged RMS, which is what halving a
staircase's rate looks like. `dev/live-sim.ts` still renders bit for bit against the direct path.

### ✔ Swing and the `1/3` sub-step interact exactly as `swungFrame` assumes

This was the last live bullet of the leftovers. The block loop recomputes the step length every
chunk from `floor(position) & 1`, and inside one step `floor(position)` cannot change — so `L` is
constant across a step and the position advances **linearly at `1/L(k)` steps per frame** for the
whole of step `k`. A note fires when `frac(position)` passes `voice[+0x3e] / 3` (`0x1cb1`, the
constant `0.333333343` at `v0x4558`).

So a triplet at `k + s/3` sounds `L(k)·s/3` frames into step `k`, where `L(k)` is *that step's own
swung length* — **a triplet inside a stretched step stretches with it**. `src/core/swing.ts` scales
the fraction by `stepLength(step, …)` for exactly that reason, and it was right.

### ❗ And note onsets land on the block grid, not on the sample

Reading the onset offset was not the point of this session and it is the most consequential thing in
it. `sub_0x1c60`, `0x1cc6`-`0x1cdc`:

```
0x1ca9  start = voice[+0x3e] / 3          ; the note's position within the step, in thirds
0x1cb9  if (newFrac <= start) return      ; not in this chunk
0x1cc6  if (start <= oldFrac) r10 = 0     ; already begun -> no offset
        else
0x1ccc    xmm5 = start - oldFrac          ; how far into the chunk, IN STEPS
0x1cd0    xmm3 = (float)N                 ; the chunk length, IN FRAMES
0x1cd4    r10  = trunc(xmm5 / xmm3)       ; <- a divide where a multiply belongs
0x1cdc  N -= r10                          ; and r10 offsets the output pointer (0x2ee6, 0x2eee)
```

`start` is bounded by `newFrac < oldFrac + 1 < 2`, so `start - oldFrac` is under 2 and **`r10` is 0
for every chunk longer than one frame**. The engine has the code to place a voice inside a block and
it always computes zero: **a note begins at the first frame of the block it falls in.**

The onset grid is therefore the block grid — 256 frames, 5.33 ms at 48 kHz, minus the occasional
short chunk the bound at `0x0bf2`-`0x0c1f` produces:

```
L  = 720000/tempo, swung by the step's parity
N  = min(trunc((1 - frac(4*position)) * L + 1), frames left in the block)
position += N / L
```

⚠️ **That bound is not a musical boundary and reading it as one wastes an hour.** `frac(4p)` never
lines up with steps or with thirds; what it guarantees is that a chunk advances **at most one step**,
which is precisely the invariant the note window needs — `0x1c9b` handles a wrap by adding 1 to
`newFrac` and could not handle two. Simulated over a second it gives chunk lengths of 1, 127, 129,
255 and 256.

**Not implemented, deliberately.** Reproducing it would move every note onset later by 0 to 5.33 ms
and could only be right if the block grid's phase against the song is what it looks like — `p` is 0
at the first block, so it should be song-aligned, but that is an inference and the renderer being
degraded is not. The anchor for settling it is a capture: **record a fast unswung drum pattern from
the game and measure inter-onset intervals against the exact step clock.** If the onsets sit on a
256-frame grid the deviation is a sawtooth with a 5.33 ms range, which is unmistakable; if they are
sample-accurate this reading is wrong somewhere.

## 15. `robot` sounds thin — WITHDRAWN by the listener, 2026-09-05, and NOT attributed

The report was: the lead synth in `This Is Halloween` is **thin, short of low end and short of
resonance** against the game. On 2026-09-05 the listener says it now sounds right.

❗ **Nothing here claims to know why, and the refusal is measured rather than modest.** This project
has one recorded method failure of exactly this shape — a doubling was observed, an explanation was
invented that fitted it, and it went into steering as a fact about the level (see *12b*). What
follows is what can be said.

### What changed that could reach `robot` at all

`robot` is `Numstack` 1 and its notes carry modulation 0, so every parameter evaluates to its `x`:

| | value at modulation 0 | what this session did |
|---|---|---|
| `Params[0]` detune | **0.000** | applied to layer 0 now — multiplied by zero |
| `Params[1]` spread | **0.000** | applied to layer 0 now — multiplied by zero |
| `Params[2]` start offset | 0.030 | layer 0's is cleared, as it was before |
| `Params[5]` key tracking | **0.000** | the 2026-09-02 key-track fix cannot reach it |
| `Params[6]` filter env amount | **0.980** | — |
| `Params[16]` LFO 1 depth | **0.060** | a live vibrato |

So exactly **one systematic change** touches it: the modulation block clock, `MORPH_FRAMES`
128 → 256, which is the engine's own (question 3). It is credible on its face — `robot` takes 98%
of its cutoff from a filter envelope that is re-derived once per block, and "thin, short of
resonance" is a filter-envelope complaint.

### ⚠️ And the control says that is not enough to conclude anything

Everything random in a voice comes from one seeded stream, so a change that merely **reorders the
draws** moves the output too. This session reordered them: a `Numstack`-1 voice used to draw 3
values (its LFO phases, in the mixer) and now draws 6 (three phases in the render, plus the detune,
pan and start offset that layer 0 now takes part in). Measured on `robot` alone over 25 s of
`Ascetic`, 136 notes:

| | difference | rms |
|---|---|---|
| block clock 256 against 128 | **−33.0 dB** | 0.014492 vs 0.014501 |
| same clock, another seed | **−4.6 dB** | 0.014492 vs 0.014602 |

**A reseed is 28 dB LARGER than the block clock.** So the biggest thing that happened to `robot`
this session was its vibrato phases being reshuffled — which changes the rendering and not its
character. The systematic change is real, small, and cannot be shown to be the one that was heard.

❗ **`LBP_SEED` exists for this**, in `dev/render-level.ts`: reseeding is the null hypothesis, and a
difference smaller than a reseed is a difference a reshuffle could have produced.

⚠️ **The original reference was shadPS4**, which the same day's *Provenance rule 2* had already
disqualified for judgements about spectrum. So the report that opened this and the report that
closes it are both against an output path that is not a PS4's.

### What was ruled out on the way, and is worth keeping

All of it measured off the *file* rather than off a capture, which is why it survives the provenance
caveat:

- **The octave.** `robot` is one looped sample, `rude_bass_c3` at base note 36, and across the 18
  levels that parse it carries **49,447 notes** from −12 to +30 semitones, smooth, peaking at
  +24…+28, with 624 on the base note and 242 an octave below. A systematic octave error moves a
  distribution; it does not put a fat middle at +26 and a tail at −1. Composers use it as a lead.
- **`Key`.** 49,270 of those 49,447 notes carry `Key = 0`.
- **A hidden per-note flag.** Byte 3 only ever holds `0x00`, `0x40` or a low nibble corpus-wide;
  bits 4 and 5 are never set, and `0x40` is the triplet sub-step.
- **The `x`/`y` interpolation direction**, settled for all 27 parameters — see *20*.
- **The resonance.** `robot` is `resonance 0.000..0.709` and every one of its 1,696 note records in
  that level carries timbre 0, so the interpolation lands on `x` and there is no resonance to hear.
  20.9% of corpus records carry a non-zero timbre, so zero here is the composer's choice.

⚠️ **One thing is still fixed on our side and unsettled on the engine's**: which playback rate the
filter's key tracking is fed. It was the voice's *opening* rate, so a note that glides kept the
cutoff it started with; `Northern Lights`'s `noise` riser swept 1.83× where the pitch swept 4.76×,
and it is the current rate now. `LBP_NO_KEYTRACK` stays because the term may be inert altogether.
None of this reaches `robot`, whose `keyTrack` is 0 at the modulation its notes carry.

## 37. The WaveHammer — ANSWERED by RUNNING it, 2026-09-06, after three wrong readings

The last DSP on the sequencer's channel. What it is and what it computes now live in
[lbp-audio-engine.md](lbp-audio-engine.md) under *The end of the chain*; `tools/wavehammer.py` is
the model and `tools/runhammer.py` loads the real module and checks it. **They agree to 1e-4 dB.**

The answer in one line: a compressor at −18 dB / 10:1 over a 64-sample sliding mean square, giving
−17.2 dB of gain at −0.9 dBFS, −7.2 dB at −12 dBFS, and a floor of −1.84 dB below −21 dBFS.

### ❗ The value of this entry is the three wrong readings, not the answer

Each was confidently written down, and two of them were committed.

| # | The claim | Why it was believed | What was actually true |
|---|---|---|---|
| 1 | "It is a limiter." | The product is called Wave Hammer and the PRX is `fmodsmswavehammer`. | It ships with `LimitBypass = 1`. The **compressor** section runs. |
| 2 | "The game never configures it." | `DSP::setParameter` is never called on the handle — verified by enumerating all fifteen call sites. | True, and irrelevant: `create` `rep movsd`s a static template over the parameter block, overriding 8 of 16 defaults. |
| 3 | "It collapses to a constant −18.04 dB." | A **superset disassembly** of all 7,632 bytes found no store to `[reg + 0xc0]`, so the detector's window length looked uninitialised. | `[state+0xc0] = 64`. `0x380` writes it as `mov qword ptr [rbx + 0x3c], rax` through an interior pointer to `state+0x84`. |

Reading 3 is the one to remember, because the technique was **sound and exhaustive** and the
conclusion was still false. Decoding from every byte proves "no instruction stores to `[reg+0xc0]`";
it does not prove "this field is never written", because a struct passed by interior pointer reaches
the same field under a different offset — and here one 64-bit store wrote two fields at once.

⚠️ **An absolute-offset search is only sound if every access uses the same base.** When a field
looks uninitialised, the next question is not "did I miss an instruction" but "can this field be
reached under another name" — and the cheapest way to answer that is to run the thing.

One wrong field produced **four** self-consistent conclusions: the −18.04 dB constant, a `NaN` at
table entry 0, a downward expander below the knee, and "the compressor never compresses". None
looked wrong from inside the disassembler; all four died the moment the module printed its own
state.

### What survived the corrections

The parts derived from the arithmetic rather than from the state were right throughout, and are
worth trusting again: the parameter struct's layout (confirmed three ways), the units
(`×0.1` for "10th dB", `10^(x·0.005)` for gain, `10·log₁₀` for level), `_FLog` = `log10f`, and the
knee's closed form — the unique Hermite matching value and slope at both ends, which
`wavehammer.py check` still agrees with the literal transcription to 2.1e-14 dB.

### ✔ Implemented 2026-09-06, the same day

`src/audio/compressor.ts` runs it on both the offline and the live path, after the reverb sum where
`Channel::addDSP` put it. `test/compressor.test.ts` pins it against **vectors taken from the running
module**, not against itself: a deterministic LCG signal under a raised cosine, driven through the
real PRX by `runhammer.py`, with seventeen sampled gains reproduced to better than 2e-5.

Two things the vectors caught that reading had not:

- **`[state+0x12c]` is not zero at reset.** `0x901` seeds the second smoother with `(1 − b0)/(1 + a1)`,
  which is 0.5 for either coefficient pair — its own fixed point for a gain of 1. Starting it at zero
  makes the first sample read 0.0126 where the module reads 0.998561: an 18 dB hole at the top of
  every render, lasting about 50 ms.
- **`a1` for `CompCoeffSet` clear is 0.8667884, not 0.96715366.** The second number is what `prxdis`
  prints as the `f64` beside the operand — the qword read as a double rather than as the next float.
  ⚠️ The `f32`/`u32`/`f64` triple that tool prints is a convenience, and two of the three are
  usually wrong; take the one the instruction's operand size asks for.

❗ **It costs a real render 6.94 dB of RMS and 6.93 dB of peak.** `level-seq723339` goes from
0.134/0.934 to 0.060/0.420. Both fall by the same amount, so on this material the DSP is riding the
level rather than catching transients — its closed-loop pole at the release coefficient is
`2·b0·c + a1 = 0.99957`, about 48 ms of time constant.

⚠️ **It is off by default**, from the same day: the listener judged it wrong the first time it ran,
and a listening report outranks a reading here. `LBP_COMPRESSOR=1` or `compressor: true` turns it
on. That the *implementation* is right is not in question — the vectors say so; what is in question
is the level reaching it, which is question 38 in [open-questions.md](open-questions.md).

### The harness, because it is reusable

`tools/runhammer.py` loads a PS4 PRX into a Windows process: both segments at their own vaddrs in
one RWX allocation so rip-relative references need no fixing, the five non-PLT relocations and ten
GOT slots written by hand, `powf`/`_FLog` shimmed to the CRT, and a System V ← Windows thunk saving
the registers the two ABIs disagree about (`rsi`, `rdi`, `xmm6`–`xmm15`). It took an afternoon and
it is the strongest instrument this project has for any of the game's DSP plugins — `fmodsmsreverb`
and `fmodextinput` are the same shape.
