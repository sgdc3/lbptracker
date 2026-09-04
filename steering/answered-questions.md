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
- **So question 12's contradiction stands**, unchanged: the engine runs the random start from layer
  0, and doing that destroys the drums by the ear's account. What has changed is that there is no
  longer a plausible misreading left to hide behind.
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
drum section and synced it against a render. Two independent lines of evidence agree, and they
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

What is left of question 22 in [open-questions.md](open-questions.md) is only *why* FMOD feeds the
centre at all.

### What was implemented

`PAN_WIDTH` in `src/core/render.ts`, applied where the voice spec is built; `LBP_PAN_WIDTH=1`
restores the file's own pans. ⚠️ **Width, not gain** -- the recordings were level-matched, so they
fix the ratio between the channels and say nothing about the absolute level. The implementation
scales the pan and leaves `left + right` at 1, changing only the quantity that was measured.
`panGains` itself stays hard-panning and linear, because that **is** the plugin's law at `0x2d21`;
the narrowing belongs above it.

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

⚠️ **"Voices sounding" on the live page counts LAYERS, not records**, so 104 with a 32-record pool
is right rather than alarming: 32 records at up to five layers each is 160 sampler voices, and the
engine renders exactly the same number.

### What it touched

`render.ts` allocates per note and applies the decision to every layer; `where.note` and
`where.layer` are reported so a live scheduler can do the same, and `dev/live.ts` and
`dev/live-sim.ts` both do. A stolen note takes **all** its layers with it — they were sharing the
record that was overwritten.