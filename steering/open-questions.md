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

**What is left is mostly timing and effects**: what the engine does with `Swing` (question 3), the
echo's DSP parameter indices (2), which reverb the send feeds (6), how the ÷2 and ÷4 sample copies
are built (5b), and the `Notes.y` / `Splitnotes` numbering question (4) — which is the one that can
still transpose an imported level.

Last re-ranked 2026-09-01, after mapping `fmodextinput.prx` and then working outward from it. That
run closed questions 5 and 7 outright, the whole of 8's `Params`, and the triplet half of 3; it
opened 5b; and it corrected several things steering had wrong — the state block's pointers, the
scale table's address, `Numstack`, voice `+0x28`, and the pan law. See
[lbp-modding-toolchain.md](lbp-modding-toolchain.md) for what came from whom.

---

## 2. The echo — and `v0x3fd4c0` turned out to be the REVERB

⚠️ **This question was aimed at the wrong function.** `v0x3fd4c0` is
`applyReverbPreset(dsp, setting)`, not an echo setup: it indexes an 8-entry remap at `v0x1062830`,
multiplies by 44 to index the 12-preset table at `v0x1062620`, and pushes ten of each preset's
eleven `int32` slots into DSP parameters **1–10** — reading slots 7 and 9 as booleans and skipping
slot 0. Both tables are dumped in `src/audio/effects.ts`. So `ReverbSetting` 0–7 selects presets
**3, 6, 8, 5, 11, 2, 0, 0**, and the corpus only ever uses settings 1–5.

**The echo is not an FMOD DSP at all.** It is inside `fmodextinput.prx`: `sub_0x670` reads the
768,000-byte buffer at state `+0x1b18` with a wrapping two-part copy, and 768,000 bytes is
**192,000 floats = 48,000 frames × 4 channels = exactly 1.000 s at 48 kHz**. A one-second delay
line, four channels wide — the DSP's two stereo busses.

**What is left of this question**, and it is now a `sub_0x670` job rather than an FMOD one:

- the feedback path, the wet/dry law, and whether the two stereo busses cross-feed;
- **`EchoTime`'s unit.** The eboot stores `EchoTime × 0.5`, and `EchoTime` runs 1–4 across the
  corpus, so the state sees 0.5–2 against a one-second buffer. Seconds is the literal reading of
  those two facts and is what `src/audio/effects.ts` uses, clamped; tempo-synced beats would fit
  the numbers too and would sound quite different.

The parameters themselves are no longer in doubt: `EchoFeedback` runs 0–0.9 (median 0.45) and
`EchoMix` 0–1 (median 0.5) over 338 sequencers — a feedback coefficient and a wet/dry mix.

## 3. Grid resolution, swing, and triplets

The cell geometry is now **measured**: `gridX = floor(2*x/105 - 0.5)`, `gridY = floor(-y/105)` at
`v0x1c4ad0`. What is still open:

- ~~**Steps per grid unit.**~~ **Settled from the engine**: `v0x1c5cda` computes a step count as
  `trunc(x * 32 / 105)`, i.e. **32 steps per 105 world units, 16 per 52.5-unit cell**. Matches both
  `sequencerdump`'s constant and the corpus's step-31 ceiling.
- ~~**`Swing` semantics.**~~ **Settled from the engine**: `v0x1c5d0c` clamps it with `vminss`
  against **0.99** before handing it to the audio state, so `Swing` is a **normalised 0..1 ratio**,
  not a percentage and not a fraction of a step. What the engine *does* with that ratio is still
  unmeasured.
- ~~**Triplet timing.**~~ **Settled from the engine.** A note's position is
  **`step + subStep/3`**, where `subStep = bit7 << bit30` of the note word, so it takes the values
  0, 1 and 2 — thirds of a step, exactly. `sub_0x38e0` uses it for the ramp span (`v0x4558`,
  `v0x455c = ±0.333333`) and the voice record carries the note's start and end in the same units at
  `+0x3e`/`+0x3f`. `sequencerdump`'s `group*96 + pos*32` re-timing is not what the game does; it was
  already disowned by its author, and this confirms it.

All three feed the same conversion in the scheduler
(`samplesPerStep = rate * 60 / (Tempo * stepsPerBeat)`). Answerable from the sequencer module, or
empirically by recording the game's output and measuring inter-onset intervals at a known tempo —
which has the advantage of validating the whole timing chain at once.

## 4. What `Notes.y` actually means

`sequencerdump` feeds `y` straight into a MIDI `NOTE_ON` as an absolute note number and gets usable
MIDI out, and in the corpus `Key` is 0 in 101,536 of 105,785 instruments and `Scale` is 0 in
105,680 — while pitches span 0–95. That points at `y` being absolute pitch with `Key`/`Scale`
constraining only what the *editor* lets you place. It is not proof: `Key = 0` may simply mean C.
If it is wrong, every imported melody is transposed, so confirm it: place a note in-game, change
`Key`, save, and see whether the note record changes.

Related and unresolved: **`basenote` and `Splitnotes` may not use the same numbering.** The toolkit
annotates `basenote` as MIDI note numbers and `Splitnotes` as piano key numbers — 20 apart. Our
key-split logic compares them directly, so one of those annotations has to give.

## 5. `finetune` units — RESOLVED, 2026-09-01: **semitones**

`sub_0x1c40` adds the slot's f32 into the same sum as the note and the root note, before the one
division by 12 — same units, no scaling. `FINETUNE_PER_SEMITONE` is now 1.

The corpus agrees independently: the 23 distinct non-zero values the game's own instruments carry
run **−0.17 … +0.56**. Read as semitones that is −17 to +56 cents, an ordinary fine-tune range; read
as cents it would be five-thousandths of a semitone, which nobody would author.

*(The other half of this question — the "unnamed third bool" in the sample slot — was already
resolved: the serialiser writes `fitbpm` twice to the same member.)*

## 5b. How the ÷2 and ÷4 sample copies are produced — NEW

The sampler reads pre-decimated copies of every sample above pitch ratio 2.0 and 4.0 (see the PRX
section of [sequencer-data-model.md](sequencer-data-model.md)). The slot descriptor holds three
pointers; **what fills them is not known**, and it decides how our high notes sound:

- if the `.smp` resources carry the levels, we just read them — check whether a sample's byte length
  exceeds its frame count × 2, which would be the extra levels;
- if the game builds them at load, we must match the decimation filter. Plain frame-dropping,
  averaging pairs, and a proper half-band filter all sound different at the ÷4 level.

**Anchor**: the loader is on the eboot side, near the `RSample` load at `v0x1c38aa` and the preload
worker `v0x1c37f0` — look for a pass that allocates roughly 1.75× a sample's size (1 + ½ + ¼) and
writes three pointers 40 bytes apart into a 152-byte slot.

## 6. `ReverbSetting` → which reverb — **it is the GAME's own reverb, and it can be read**

The question was "which FMOD DSP?". The answer is none of them: **the reverb is game code**, so it
can be transcribed the way the sequencer's synth was, rather than approximated.

**The preset table is dumped** (see question 2 and `src/audio/effects.ts`): 12 presets of 44 bytes
at `v0x1062620`, an 8-entry remap at `v0x1062830`, ten fields per preset pushed into parameters
1–10. The fields never did fit `FMOD_DSP_SFXREVERB` — two of the ten are booleans, which SFXREVERB
has none of, the first two read as millibels and the last as a reference frequency in Hz.

**The construction, at `v0x3fd0d2`–`v0x3fd246`, settles it:**

```
alloc 0x4b000 = 307,200 bytes          ; 76,800 floats -- the delay memory
alloc 0x2c    =      44 bytes          ; a private copy of one preset
copy presetTable + 0x58 into it        ; 0x58 / 0x2c = preset 2, the default
[copy + 0] = 0xfffffce0 = -800         ; slot 0, the one the setter skips
memset([obj + 0xf0], 0, 0x100)         ; a 256-byte state
memset([obj + 0xf8], 0, 0x580)         ; a 1,408-byte state
call v0x3fcc00(state)                  ; init
call v0x3fcd50(state, preset, 1, buffer)  ; configure -- the same entry
                                          ; applyReverbPreset tail-calls
```

Two state objects, a 307 KB delay buffer and a preset struct, all allocated and initialised by the
eboot. Nothing is handed to FMOD.

**The preset fields are decoded.** `v0x3fcd50` converts the eleven slots into the reverb's state,
and the conversions name them:

```
level(v) = (v*10 > -8000) ? powf(10, v*10 * 0.0005) : 0      ; = 10^(v/200), so v is dB x 10
                                                             ; -- MILLIBELS, with a -80 dB floor
[state+0x4c] = level(slot 0)
[state+0x48] = level(slot 1)
[state+0x50] = level(slot 2) / 100
[state+0x30] = (int)  slot 3
[state+0x34] = (int)  slot 4
[state+0x38] = (float)slot 5
[state+0x3c] = (int)  slot 6
[state+0x20] = (bool) slot 7
       xmm0  = (float)slot 8 / 48000                         ; SAMPLES -> seconds
[state+0x24] = (bool) slot 9
[state+0x2c] = (double)slot 10 scaled                        ; the 3000..12000 Hz one
[state+0x10] = 48000.0f     [state+0x40] = 2     [state+0x44] = 1.0f
[state+0x18] = the 307 KB buffer
```

⚠️ **Slot 0 is never set from the table.** `applyReverbPreset` writes parameters 1–10, i.e. slots
1–10; the constructor stores **−800** into slot 0 of its private copy, so the sequencer's reverb runs
that level fixed at −8 dB regardless of preset.

**The anchors to finish it:**

| what | where |
|---|---|
| init | `v0x3fcc00` — 223 insns, 73 SIMD; sets up the delay structure |
| configure from a preset | `v0x3fcd50` — decoded above |
| per-parameter setter | `v0x3fd3d0` |
| apply a preset by `ReverbSetting` | `v0x3fd4c0` |
| construction | `v0x3fd0d2` |
| a second constructor | `v0x3fd6c0` — allocates and zeroes the 256-byte state |
| release | `v0x3fd260` — ⚠️ **not** the process callback, as this file said before: it frees the buffer and both states |

**The geometry is recovered.** `v0x3fc8c0` indexes two more tables with preset slots 3 and 4, which
turns out to mean those slots are **indices, not values**:

| table | at | rows | contents |
|---|---|---|---|
| tap sets | `v0xe1d5d0` | 19 × 44 B | a count, then up to **10 delay lengths in ms** (3–94 ms) |
| early sets | `v0xe1d920` | 7 × 36 B | 3 delays in ms, 3 values in −80…+100, 3 gains in 0…1 |

Both are transcribed into `src/audio/effects.ts`, and the reverb there is now built on them rather
than on a generic Freeverb. Its impulse response runs 0.03–3.31 s across the five settings the
corpus uses.

⚠️ **The middle three floats of an early row are not levels.** Reading them as decibels gives a gain
of 100,000 and an impulse peak of 15,864 — which is how it was caught. They run −80…+100 and are
more likely pan or angle; the last three, 0…1, behave like gains and are what the code uses.

⚠️ **What is still missing is the process loop**, and with it the topology: how the taps feed back
into one another, where the damping sits, and how slot 5 becomes a feedback gain (read here as an
RT60 over `slot5 / 10` seconds, which puts the presets at 0.6–5.0 s). Also unexplained: `v0x3fcd50`
divides slot 2's level by 100, and slot 2's raw values are 0–18, which do not read as millibels the
way slots 0 and 1 do.

### Finding the process loop: what has been ruled out

A session went looking for it and did not find it. The exclusions are worth more than the search
was, because each one was a plausible candidate:

| function | what it actually is | how it was excluded |
|---|---|---|
| `v0x3fcc00` | init | sets up, no loop |
| `v0x3fcd50` | configure from a preset | decoded in full, above |
| `v0x3fc8c0` | configure's table lookups | reads every coefficient exactly once |
| `v0x3fd0d2` | construction | allocates the buffer and both states |
| `v0x3fd260` | **release** | frees the buffer and the states — steering had called it the process |
| `v0x3fd3d0` | per-parameter setter | a 10-way switch, no audio |
| `v0x3fd4c0` | apply a preset | ten `setParameter` calls |
| `v0x3fd6c0` | a second constructor | allocates and zeroes a 256-byte state |
| `v0x3fded0` | **not audio at all** | a 4×4 matrix transpose — geometry |
| `v0x3fc2b0` | a channel mixer | works on `word`, i.e. int16 PCM, not floats |

⚠️ **Two search methods also failed, and both were reasonable:**

- Counting "SIMD" instructions by the `v` prefix **misses legacy SSE** (`mulss`, `addss`), so the
  first ranking of candidates was wrong. Match `v?(mul|add|sub|div|max|min)s[sd]` instead.
- Scanning `.rela.dyn` for `R_X86_64_RELATIVE` addends inside `v0x3fc000`–`v0x3fe000` finds ten
  pointers at `v0x010c8970`, which look exactly like a vtable and are **not**: nine are C++
  static-initialisation guards that all write the same vtable pointer, and the tenth is a small
  loop with no float work.

**So the process is not in the `v0x3fc000`–`v0x3fe000` window**, or is not reached by a pointer
stored at load time.

### The whole-`.text` search, and why it did not work either

- **By `[reg + 0x18]`**, the offset where `v0x3fcd50` stores the buffer: **1,714 functions**. The
  offset is far too common to discriminate.
- **By the coefficient offsets** `0x2c`–`0x50`, hoping a function that reads several of them
  together must be the reverb: three functions read **all ten**, and disassembling them shows all
  three are false positives — `v0xa189f0` is a `memset` loop over `0x4940`-byte objects,
  `v0xab7270` is a 6→1 channel downmix where those offsets are just consecutive channels. Offsets
  in that range are ordinary struct and array strides; they carry no signal.
- ⚠️ **Byte-pattern scans must be validated by disassembling.** The first pass matched
  `F3 0F 10` / `C5 FA 10` anywhere in the image, including inside other instructions and in data,
  and its best hit had no `movss` in it at all.
- **By the buffer's size**, `0x4b000`: it appears in code exactly **twice**, both inside
  `v0x3fcfe0`, the construction. Everything else reaches the buffer through the pointer, so there is
  no second textual mention to find.

⚠️ **Correction: `v0xab51b0` is not an `aSfxDsp` call.** This file has said so since the reverb was
first written up; it is four instructions of table lookup (`lea rcx, [rip+…]; mov rax, [rcx+rax*8];
ret`). The eboot also contains **no Sony audio-DSP library strings at all**, so the "FMOD SFXREVERB
or Sony's plugin" framing that opened this question was wrong on both halves.

### FOUND: the process loop is not in the eboot at all

`v0x3fcfe0` has no callers because it is a **callback**, and working forward from where it is
*registered* found the whole thing in four steps:

1. `v0x3fcfe0`, `v0x3fd260` and `v0x3fd3d0` are each `lea`-referenced exactly once, at `v0x3e64c6`,
   `v0x3e64d2` and `v0x3e64de` — three consecutive stores into a stack struct.
2. That struct is an **`FMOD_DSP_DESCRIPTION`**, and `v0x3e6491` writes its name as a pair of
   immediates: `0x6576655220534d53` + `0x6272` = **"SMS Reverb"**. The slots line up with FMOD Ex's
   layout — create `+0x28`, release `+0x30`, **read `+0x40`**, numparameters `+0x50`, paramdesc
   `+0x58`, setparameter `+0x60`, getparameter `+0x68`.
3. The **read callback is the one field not written from a `lea`**: `v0x3e64f6` loads it from the
   global `v0x10cc3f0`. That is why every search for it inside the eboot failed — there was nothing
   to find. The relocation on that global is `R_X86_64_GLOB_DAT` against symbol
   **`iO5jJEuFaSo#D#E`**, undefined, i.e. an **import**.
4. Library id `D` = 3 in the eboot's import table is **`FMODSmsReverb`**.

**So the reverb lives in `fmodsmsreverb.prx`, exactly as the sequencer's synth lives in
`fmodextinput.prx`** — and it is on disk beside it, 14,898 bytes:
`D:\PS4Games\CUSA00063\gamedata_orbis\spumodsmsreverb.prx`. It **exports `iO5jJEuFaSo#C#A`**,
the same NID the eboot imports as the DSP's read callback.

**Everything needed to finish it:**

| | |
|---|---|
| module | `fmodsmsreverb.prx`, 14,898 bytes — smaller than the synth's 23,614 |
| code segment | SELF segment `[1]`, `off 0x780`, `filesz 0x2a98` → **`file = vaddr + 0x780`** |
| the process loop | the export **`iO5jJEuFaSo`** |
| what the eboot feeds it | the state built by `v0x3fcfe0`, configured by `v0x3fcd50` (decoded above), with the 307 KB buffer at `[state+0x18]` |

⚠️ **And this corrects what this file said two entries ago.** "The reverb is game code, so it can be
transcribed the way the sequencer's synth was" was right about the conclusion and wrong about the
place: it is not in the eboot, it is in a PRX — which is *more* like the synth than claimed, and
readable by exactly the method that worked there.

### Inside `fmodsmsreverb.prx` — the process is mapped, the kernel is not yet read

Its program headers give `PT_LOAD 0` at `off 0x4000 vaddr 0`, but the **SELF** segment table is what
addresses the file: entry `[1]`, `off 0x780`, `filesz 0x2a98`, so **`file = vaddr + 0x780`**. The
`PT_DYNAMIC` payload lands at file `0x3728` and the symbol table at `0x3470`, 13 symbols — the same
parse that worked on the synth.

**The export `iO5jJEuFaSo` is at vaddr `0x1f70`**, and it is a thin wrapper of exactly the shape
`fmodextinput.prx`'s is:

```
read(state, in, out, frames, inch, outch):
    if inch != 4 || outch != 4: trap
    for blocks of 0x100 = 256 frames:
        sub_0x1cb0(state, in, out, 256, 4)
        in += 0x1000; out += 0x1000        ; 256 x 16 B = 4 channels of f32
```

`sub_0x1cb0`, the core, does three things:

1. **copies 0x100 = 256 bytes of state** from `[dsp_state + 8]` into a static buffer at vaddr
   `0x4100` — the same trick the synth uses with its 6,992-byte block, and the reason `[state+0x18]`
   never appeared in an eboot search;
2. **de-interleaves** the four input channels into stack buffers (loop at `0x1dc0`, stride 4);
3. calls **`sub_0x11a0`** — 799 instructions, 12 loops, the reverb itself;
4. **re-interleaves and adds to the input** (loop at `0x1ec0`: `vaddps` of the processed channels
   onto the original, then `vmovaps` to the output). So the DSP is an insert that mixes its wet
   signal onto the dry rather than replacing it.

**What is left is `sub_0x11a0` alone**, at file `0x11a0 + 0x780`. Everything around it is now known:
its input format (four de-interleaved channel buffers of 256 floats), its output contract (added to
the dry), and its parameters (the 256-byte state, whose fields `v0x3fcd50` fills and this file
decodes above).

⚠️ Worth doing, and worth doing before more of the mix is tuned: **71,781 of 129,696 instrument
placements (55%) send to reverb.** Until it is done, `src/audio/effects.ts` carries a Schroeder
network of ours that responds to the send levels and reproduces nothing — and says so.

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

## 8. Semantics of the remaining fields

Recovered as names, sizes and defaults only:

- `Numstack` (default 1) — looks like a per-instrument voice-stacking count.
- `Loops` on `PInstrument` — **1 in all 105,785 instruments of the corpus**, so whatever it
  does, no creator has used it. Safe to treat as 1 and revisit only if the editor exposes it.
- `Params` — **27** pairs of f32, all in 0..1, each a *range* that the note's own 4-bit modulation
  field picks a point inside. **Twelve are now named, 2026-09-01:**

  | indices | what |
  |---|---|
  | `Params[0..2]` | the unison stack: per-layer **detune**, **spread**, **random start position** |
  | `Params[3..6]` | the low-pass: **cutoff** (squared), **resonance**, **key tracking**, **envelope amount** |
  | `Params[7..10]` | the **filter** ADSR — envelope B |
  | `Params[11..14]` | the **amplitude** ADSR — envelope A |
  | `Params[15..23]` | three **LFOs**, as (rate, depth, layer phase spread) triples |
  | `Params[24..26]` | output: **level**, **send**, **drive** |

  **This question is closed.** The evidence and the formulas are in
  [sequencer-data-model.md](sequencer-data-model.md), the names in `src/core/params.ts`. What
  remains is not naming but **implementing**: the three LFOs and the two-bus output are recovered
  and not yet in the mixer, and **what each LFO modulates is only partly established** — LFO 2's
  gain target is measured, LFO 1's pitch target is a natural reading, LFO 3's was not traced.
  The oscillator at stub `0x130` is **identified** — it is libc's sine/cosine, `ZtjspkJQ+vw`, with
  an integer selector in `edi` — so what is left is following each LFO's result to its destination,
  not naming the function. The parse that pinned it, and the `PT_SCE_DYNLIBDATA` type mix-up that
  had blocked it, are written up in [sequencer-data-model.md](sequencer-data-model.md).

  ⚠️ **Read the failure record below with this in mind: the shape analysis had already seen the
  answer and mis-read it.** It filed index 13 under "near-boolean — 6 distinct values, 1.0 ×69 and
  0.0 ×56" and moved on. But a *sustain level* is exactly that shape: an instrument either holds its
  note or it does not, and only the few in between (the piano's 0.070) are interesting. The
  reasoning had classified by distribution and then assumed a two-valued distribution meant a flag.
  What broke it open was labelling the instruments by **how they behave as instruments** — struck
  versus sustained — and asking which param separates the groups. Index 13 came back at Cohen's
  *d* = −3.54, with nothing else close.

  The three earlier attempts failed for reasons worth keeping: they are below.

  **What the block's shape says** (68 instruments, so 136 values per index):

  | kind | indices | evidence |
  |---|---|---|
  | boolean | **23** | only two distinct values ever, 0 and 1 |
  | near-boolean | **13** | 6 distinct values, 1.0 ×69 and 0.0 ×56 |
  | centred bipolar, neutral 0.5 | **21**, **18**, **15** | 21 is 0.5 in 110 of 136, range 0.34–0.62, and x = y in 67 of 68 |
  | level, usually full | **9**, **5** | 1.0 in 94 and 81 of 136 |
  | per-instrument, genuinely paired | **24**, **3**, **14** | 24 has x ≠ y in 52 of 68 and 92 distinct values; 14 has 67 distinct |
  | barely used | 17, 20, 22, 26 | non-zero in 9 instruments or fewer |

  Indices 24, 3 and 14 are where an envelope would live if it is here: they vary per instrument and
  carry two different numbers, which is what a (value, key-tracking) or (min, max) pair looks like.

  **What failed, and why:**

  1. **Correlation with behaviour.** Labelled each instrument by whether its samples loop (a proxy
     for "sustains"), its measured sample decay in dB, and its unpitched fraction, then correlated
     all 54 components. Best results are |r| ≈ 0.5 at n = 59 — real, but several indices share it
     and the target is itself only a proxy. It narrows, it does not name.

     ⚠️ **This one was the right idea with the wrong labels.** Whether a *sample* loops is a fact
     about the recording, not about the patch; `piano_c6` loops and the piano still decays. Hand-
     labelling the *instruments* — a marimba is struck, a choir is not — and scoring the groups
     with Cohen's *d* named index 13 immediately. Prefer a small hand-labelled set that means what
     you want over a large automatic proxy that does not.
  2. **The tweak UI.** `gamedata/scripts/tweakinstrument.ff` (GUID 122184) is the *sequencer's* note
     editor — `edit_notes_mode`, `InTripletMode`, `pattern_width`, `BeginSequencerPlayback`. There is
     no in-game editor for the sampler's parameters, so no label exists to recover. The only other
     sequencer scripts are `tweaksequencer.ff` and `tweaksequencergame.ff`.
  3. **The serialiser.** It names them literally: the format string at `v0xc68bea` is `"%s_%d"` over
     the base `"Params[i]"`, giving `Params[i]_0`, `Params[i]_1`, … The game does not name them
     either.
  4. **The runtime.** Scanned all 25,074 function prologues in the eboot for code touching the pair
     at `+0x1e8`/`+0x1ec`: 70 functions, and 42 of those also touch `+0x48`, `+0xc8` or `+0xe8`.
     Those offsets are far too common to discriminate; this did not converge.

  5. **Following the object.** Walked the preload path properly: `PSequencer::BeginPlayback`
     (`v0x1c4f00`) builds a container at `[obj+0x80]`, calls the spawner `v0x1c3c80` at `v0x1c530a`,
     which starts worker `v0x1c37f0` under the name `"StartSamplePreload"`, and the worker loads
     resource type `0x31` = `RSample` at `v0x1c38aa`. That is the whole asset chain confirmed from
     the code side — but **`BeginPlayback` never touches `+0xc8`, `+0xe8` or `+0x1e8`**. It handles
     note data (`+0x68`) and the `MusicSequencer` flag (`+0x56`) and nothing from the sampler patch.

  6. **Hunting the voice start.** The preload path only resolves *which samples to load*, so the
     envelope must be applied at note-trigger time. Attacked from three angles, all dry for the
     Params:
     - The pitch math. FMOD's cents→frequency conversion is `v0xa73c10` (constants −6900, 1/1200,
       440.0 at `v0xefd780`–`v0xefd78c`) but it is reached through function pointers, so the call
       graph dead-ends inside FMOD after four hops.
     - The three large float-heavy sequencer functions `v0x1c7390`, `v0x1c74b0`, `v0x1c7de0`. All
       three are the **Create Mode editor**, not audio: their constants are 105, −52.5 and 7.5,
       which is circuit-board geometry, and they call the grid-placement helper. Do not re-examine
       them.
     - `v0x1c5640`, the real playback start. It touches note data and the sequencer's own settings
       and **nothing from `RInstrument`**.

  **Where that leaves it.** Six attempts, none naming a parameter. Every route through the
  *sequencer module* is exhausted — that module is overwhelmingly Create Mode UI. What has never
  been searched is the **CWLib audio layer** (`v0x3dd000`–`v0x3fe000`) from the note-trigger side:
  `v0x1c5640` hands off to the generic play-sound `v0x3de390`, and whatever turns a note into a
  voice lives past that, not in the sequencer.

  ⚠️ **This stopped being a fidelity refinement.** A listener hears a flutter at the loop-wrap rate
  that only an envelope can plausibly hide (see [game-assets.md](game-assets.md)), so the envelope
  is now the difference between "close" and "wrong". Until it is recovered the envelope is ours and
  is marked as such: `VoiceSpec.release` and `VoiceSpec.decayDbPerSecond`, both defaulting to
  neutral.
- `Arpeggio` — **32** bytes, default `0xf`, with `Arpeggiate` as the on/off bool.
- `Behavior`, `TriggerPlayer`, `PreviewThing` on `PSequencer` — three fields our serialiser walk
  missed entirely; widen the window at `v0xd37d10`.

None are blocking: an instrument with `Arpeggiate` off and one stack behaves correctly without any
of this.

## 9. Board row → mixer channel

`PSequencer` has `NumChannels` and `Volume[0..5]`; instruments have a `gridY` row on the circuit
board. A row is very likely a mixer channel, but nothing has established the mapping — including
what happens when a board has more than 6 rows. The toolkit sidesteps it by grouping tracks on
"same row + same instrument" and ignoring the sequencer's mixer entirely.
