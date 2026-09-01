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

## 0. Leftovers from answered questions

Small residues from questions now in [answered-questions.md](answered-questions.md). None blocks
anything; all are places where an answer stopped just short.

- **The unison stack and `mime_artist`.** Layers are the same sample, verified on 14 of the 15
  stacked instruments (`slots == zones`). `mime_artist` is the exception: 4 samples, 1 zone,
  `Numstack` 5, and its 3 spare slots do not equal `Numstack - 1` either.
- **Per-note modulation across a note's own points.** 70,028 of 2,027,633 corpus notes (3.45%) change
  modulation between their control points, and those render at their opening value. Whether the
  engine re-reads it mid-note is unmeasured.
- **The `1/3` sub-step and `Swing`.** Triplets are settled and wired; `Swing` is a normalised 0..1
  ratio clamped at 0.99 and what the engine does with it is still unknown. It stays under question 3.
- **The voice pool did not explain the density report it was found chasing.** It cuts 248 of 1,684
  notes over one window and a listener heard no difference. See question 14's neighbourhood.

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
- ~~**Triplet timing.**~~ **Settled from the engine, and WIRED UP 2026-09-01.** The finding below
  sat in this file for a session without reaching the code: `decodeRecord` reduced the sub-step to a
  boolean `triplet`, and `schedule` never read even that. Every one of the 39,000 corpus notes that
  sits a third or two thirds of a step late was placed on the beat, which a listener reported as
  triplet passages sounding swung. `NoteRecord.subStep` is now 0/1/2 and `Note` carries
  `startPosition`/`endPosition` in fractional steps.

  ⚠️ **Bit 30 is in the FOURTH byte** (`b3 & 0x40`), not the first. The first byte's `0x40` is step
  bit 6 and 32,515 corpus records use it, so masking the step with `0x3f` — which looked right when
  the two candidate bits came out near-equally common — moves every one of them by 64 steps. The
  corpus decodes to sub-step 0 on 3,160,795 records, 1 on 21,582 and 2 on 17,411: the two thirds
  balanced, which is what a triplet group looks like, and no fourth value, which `bit7 << bit30`
  cannot produce.

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

✔ **The process loop and the topology were both found afterwards**, in `fmodsmsreverb.prx` — see
*The stage count, and how the two halves fit together* below. Slot 5 becomes a feedback gain through
`10^(-3t/RT60)` with `RT60 = slot5 / 10` seconds, which puts the presets at 0.6–5.0 s.

⚠️ Still unexplained: `v0x3fcd50` divides slot 2's level by 100, and slot 2's raw values are 0–18,
which do not read as millibels the way slots 0 and 1 do. Note that the levels are **tenths of a dB**
rather than millibels — `millibelToLinear` is `10^(v/200)`, and that is what makes the constructor's
−800 read as the −80 dB floor. The function keeps its misleading name because the eboot's own
naming is unknown.

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
decodes above). It is 609 instructions across nine loops, holds only two float constants of its own
(`0.5` and `1`), and delegates its coefficient setup to `sub_0x7f0`.

**Two coefficients are now measured rather than inferred**, out of `sub_0x7f0`:

```
0x09e2   gain = 10 ^ (delay * -0.003 / (slot5 * 0.1))     ; = 10^(-3t/RT60)
0x082a   [r15+0x18] = state[+0x2c] ;  [r15+0x14] = 1 - state[+0x2c]
```

So **`RT60 = slot5 × 0.1` seconds**, 0.6–5.0 s across the presets — exactly what
`src/audio/effects.ts` had guessed, now confirmed — and the damping is a one-pole
`y = a·x + (1−a)·y` with `a` from slot 10, which is also where that file had put it. **The nine loops are four kernels**, transcribed into `src/audio/effects.ts` and tested. Loops D, E
and F at `0x1500`, `0x16c0` and `0x17e0` are the *same* kernel at different buffer offsets, and the
three long-span loops are the outer iteration that runs the short ones once per tap:

| loop | at | what it computes |
|---|---|---|
| A | `0x12f0` | `out[i] = (x[i] + x[i + d]) * g` — a tap sum |
| B | `0x1340` | `y = a·y + b·x[i]`, stored at `buf[i + d]`, `y` kept in the state at `[r12+0x10]` — the damping one-pole |
| C | `0x13b0` | `prev = y; y = a·prev + b·buf[i] + c·older; buf[i] -= y` — an allpass section; the subtraction is what makes it one |
| D/E/F | `0x1500`… | `acc[i] += x[i]; y = a·y + b·x[i]; out[i] = g·(y + send[i])` — a damped comb with an injected send |

### The stage array, and the series chain at `0x1460`

The routing is in the code between the loops, at `0x1460`–`0x14f9`. The reverb holds an **array of
stages of `0x50` = 80 bytes** — `rbx = index * 5 * 16` — and each stage is a delay line with its own
damped one-pole:

| offset | type | what |
|---|---|---|
| `+0x08` | i32 | the stage's delay length |
| `+0x30` | ptr | its buffer |
| `+0x38` | ptr | the read pointer |
| `+0x40` | f32 | the one-pole's running `y`, carried across blocks |
| `+0x44` | f32 | `b` |
| `+0x48` | f32 | `a` |
| `+0x4c` | f32 | the stage's gain |

The write pointer is `[stage+0x30] + [stage+0x08] + 0x80` — the buffer advanced by the stage's own
length past an 0x80 header.

**And the stages are chained in series.** At `0x1466` an index is flipped with `xor ebx, 1`, and
`0x1477` loads a pointer from `[rbp + ebx*8 - 0x40]` — a **ping-pong pair of scratch buffers** —
which `0x1487` then stores into **`[next_stage + 0x30]`**, the *following* stage's input. Each
stage's output becomes the next one's input, alternating between two buffers.

### The stage count, and how the two halves fit together — RESOLVED, 2026-09-01

**The stage count is runtime data, not a constant.** `sub_0x11a0` reads it twice: at `0x1411`
`mov eax, [r12 + 0x510]` gates the whole loop (`je 0x15ac` when it is zero), and at `0x1589` it is
re-read as the back-edge bound (`cmp ecx, eax; jb 0x1460`). `r12` is `[rbp-0xa0]`, loaded at
`0x1d12` from `lea [rip + 0x2503]` → vaddr `0x4200`, which is past the data segment's `filesz`
(`0xb8`) and therefore **BSS**: the count is filled in at init. `v0x3fcc00` calls the per-stage
configure `v0x3fc8c0` **ten times**, which matches the ten tap lengths of a table A row, so there is
one stage per tap.

**And the two halves are Schroeder's, not one chain.** The four kernels say which is which:

- **`dampedComb` (D/E/F) carries an accumulator**, `acc[i] += x[i]`. Accumulating across stages is
  what a *parallel* bank does — a series chain has nothing to accumulate, it hands the signal on.
- **`allpassSection` (C) is what the ping-pong at `0x1460`–`0x14f9` walks.** Alternating between two
  scratch buffers so each stage's output lands in the next one's `[stage+0x30]` is what a *cascade*
  needs and a parallel bank does not.

So the series chain found at `0x1460` is the **allpass cascade**, and the combs are the parallel
bank feeding it: a parallel bank of damped feedback combs, summed, into a series chain of allpasses.
`src/audio/effects.ts` now runs that.

**Three things forced this rather than being chosen**, and they are worth recording because each was
found by a failure:

1. **The combs must recirculate.** A chain with no feedback is an FIR: it rings for exactly the sum
   of the delays and stops, and the decay parameter changes the tail's shape but never its length.
   The measured law `10^(-3t/RT60)` uses the *single* tap's `t`, which is the standard gain for one
   recirculating comb to fall 60 dB in RT60 — it is only meaningful with feedback.
2. **The combs cannot be in series.** A feedback comb has DC gain `1/(1-g)`; ten in series multiply
   to `(1/(1-g))^10`, which diverges within a second at the long-decay presets. Normalising the
   forward path by `1-g` stabilises it and kills the tail in 30 ms. A structure that can only be
   stabilised by destroying it is the wrong structure.
3. **Allpasses cascade safely** because they pass every frequency at equal magnitude, which is why
   the cascade is the half that ping-pongs.

**What is ours, and flagged at its line in `effects.ts`:** which taps are combs and which are
allpasses (the shortest two are taken as allpasses), the allpass coefficient (0.5 — the engine's is
`[stage+0x44]`, set somewhere in the undisassembled `v0x3fc8c0`), and the `1 - gain` normalisation
on each comb's contribution, without which the bank is ~9x unity at DC and the preset's own wet
level stops meaning anything. Also still unread: whether the DSP finally emits the accumulator or
the last stage's output.

### What the rewiring measured

| preset | nominal RT60 | measured T60 | ratio |
|---|---|---|---|
| setting 2 | 2.0 s | 1.00 s | 0.50 |
| setting 3 | 1.2 s | 0.70 s | 0.58 |
| setting 4 | 5.0 s | 3.05 s | 0.61 |
| setting 5 | 3.0 s | 1.20 s | 0.40 |

The measured T60 is consistently **short** of nominal because the damping one-pole sits inside the
feedback loop and removes energy on every pass, which the RT60 gain law does not account for.
`test/reverb.test.ts` asserts the ratio stays in 0.25–1.0 rather than asserting an absolute level.

⚠️ **Setting 1 has no late field at all, and that is correct.** Its preset is
`[-800, -100, -700, ...]`, and `millibelToLinear` is `10^(v/200)` — the values are **tenths of a
dB**, not millibels, which is what makes the constructor's `-800` floor read as −80 dB. So its late
level is −70 dB against early reflections at −10 dB: that preset is early reflections and nothing
else. Two successive test assertions were written that assumed every preset rings, and both were
wrong rather than the code.

On the real corpus render the reverb now sits at **10.6% of the dry mix** (it was 90.2% before the
comb bank was normalised, with the mix clipping at peak 1.9).

### The coefficients, read from the side that WRITES them — RESOLVED, 2026-09-01

The earlier pass read the kernels, which only showed *which* fields a stage uses. The init code
shows what goes **into** them, and it settles both counts and every coefficient.

**The counts are not runtime-variable in any interesting way.**

| what | where | value |
|---|---|---|
| allpass pairs | `fmodsmsreverb.prx` `0x0c39` | `[state+0x514] = 2`, a literal immediate |
| combs | `0x0c52`–`0x0c5d` | `[state+0x510] = (int)tapRow[0] - 2` |

So a ten-tap row gives **8 combs and 4 allpasses**. The eboot's memory sizer `v0x3fc8c0` agrees
independently: it allocates eight buffers at `[+0x54..+0x70]` from lengths `idx3..idx(n)`, then
`idx1`, `idx2`, `0.93 * idx1`, `1.06 * idx2` at `[+0x74]`, `[+0x78]`, `[+0x7c]`, `[+0x80]`. The two
ratios are a two-entry table at `v0x2c08` in the PRX.

⚠️ **Each table A row is ELEVEN floats, not ten.** The first is the count, read as
`vcvttss2si` in both modules; the other ten are lengths in milliseconds. `REVERB_TAP_SETS` already
held the ten, so it was right by luck — the counts are now exported separately as
`REVERB_TAP_COUNTS`. Rows 1, 7, 15 and 16 use 8 or 9 of their ten, and the surplus lengths are dead.

**Every stage record gets the same three fields**, comb and allpass alike. The kernels' `[base+0x44]`
/ `[+0x48]` / `[+0x4c]` *are* these fields: comb records sit at `state+0x300` while the kernel's base
is `state+0x2c0`, and `0x2c0 + 0x44 = 0x304`.

| field | value | where |
|---|---|---|
| `+0x04` = `b` | `1 - a` | `0x0bd1` |
| `+0x08` = `a` | `expf(state[+0x2c])`, derived from slot 10 | `0x0bbb` |
| `+0x0c` = gain | `powf(10, -0.003 * ms / RT60)` | `0x0ffa`–`0x100f` |

`b = 1 - a` is a one-pole with **unity DC gain**, which is the form the code uses. With damping off
(`state[+0x24]` zero) `0x0bdd` stores `b = 1, a = 0` as a single qword. RT60 is confirmed from this
side too: `0x0c9d` computes `[rsi+0x38] * 0.1`.

⚠️ **There is no allpass coefficient to find.** The question this section was opened to answer
turned out to be malformed. The allpass records take the identical gain law as the combs on their own
delays, so an allpass of `0.93 * idx1` has `g = 10^(-0.003 * 0.93 * idx1 / RT60)`. Nothing in the
module holds a constant allpass gain, and the Schroeder 0.5 that stood in for one is gone.

**The allpasses do not recirculate**, which is what makes those near-unity gains safe. Loop C
modifies its buffer in place (`buf[i] -= y`) and the stage walk ping-pongs between two scratch
buffers, so a stage reads one block and writes the other — there is no path back into the same
delay line. Implemented with feedback instead, the measured gains (0.92–0.95 at these delays)
stretched setting 2's tail to **4.95 s against a 2.0 s RT60**; as a feed-forward diffuser it smears
the tail without lengthening it, and the T60 ratios return to the 0.40–0.61 band.

⚠️ **`v0x3fc8c0` is not a per-stage configure.** This file called it one. It is a memory sizer:
it rounds every buffer up to 1 KB, keeps the running maximum against the existing allocation, sums
them all and returns the total. It writes no coefficients.

## 2b. The echo's unit — changed from one guess to a better one, still ours

The engine side is a dead end and it is worth saying why, so nobody re-runs it: **the only
`DSP::setParameter` caller in the whole audio layer other than the reverb applier is `v0x3e41d1`**
(byte-scan for `E8` relocations targeting `v0xa23970` across `v0x3d0000`–`v0x410000`: two blocks,
nine calls in `v0x3fd4c0` and one there). And that one is a generic dispatcher — a four-entry jump
table at `v0x3e4220` that forwards parameter ids 6..20 to whatever DSP it was handed. Nothing on the
code side names the echo's parameters.

So the unit was settled from the corpus instead. `EchoTime` takes **2** (67,140 placements), **1**
(48,374), **1.5** (12,955), **4** (750) and **3** (321), with a thin continuous tail (1.2, 1.7, 2.8).
That is a slider whose detents sit on musical divisions. Read as seconds those are 1–4 s, past
what an FMOD echo accepts and implausible as defaults; read as **beats** they are the obvious
sixteenth/eighth/quarter set.

`class Echo` now takes the tempo and uses `echoTime * 60 / tempo`. The previous reading was
`echoTime * 0.5` seconds — tempo-independent, which cannot be right in a sequencer whose grid is
tempo-locked, since the same project at half the tempo would echo off the beat.

⚠️ Still ours, and both are flagged in `effects.ts`: the beat length the field counts, and the
4 s buffer ceiling (the old 1 s ceiling rested on an unmeasured claim about the engine's buffer, and
would silently fold a four-beat echo at a slow tempo down to one beat).

## 12. `Params[2]` — the formula is now READ, and it contradicts our repair

The per-layer init is at `fmodextinput.prx` `0x1ae7`-`0x1bd5`, inside the stack loop
(`cmp [r15+0x4e4], 0` is `Numstack`, and the layer index starts at **0**):

```
0x1ae7  p    = Params[2].x + mod * (y - x)     ; mod is voice+0x28
0x1b11  p   *= (int)[slot + 0x78]              ; a length
0x1b21  rand()
0x1b47  [voice + layer*8 + 0x40] = p * rand01  ; the layer's start position, a double

0x1b4e  d    = Params[0].x + mod * (y - x)
0x1b8d  r    = rand01 * 2d - d                 ; U(-d, +d)
0x1b99  r   *= 0.05
0x1ba1  [voice + layer*4 + 0x68] = 1 + r       ; the layer's pitch factor
```

`Params[0]`'s formula is **exactly** what this project implements. `Params[2]`'s is too --
`offset * length * U(0,1)`.

⚠️ **But both run from layer 0**, so the engine applies them to a single-layer voice, and this
project no longer does. The repair that confined them to later layers was made because a listener
reported `a_kit_1`'s kick as "the start of the sample skipped, only the cut tail, with a click" --
which is precisely what `Params[2] = 1.000` with `Numstack` 1 produces, and six of the game's kits
set exactly that. The repair is worth **11.6 dB** of drum kit and is not in doubt as a description of
what sounds right; it is in doubt as a description of the engine.

**The reconciliation has to be `[slot + 0x78]`.** If that field is the *loop* length rather than the
sample length, it is zero for the loopless percussion samples and the offset vanishes for exactly the
instruments that would otherwise break -- and the code and the ear agree again. What is known: the
slot record is `0x98` bytes and starts at `+0x78`, twelve bytes before the `+0x84` that the eboot's
builder at `v0x2a1190` fills from the `RInstrument`; so `+0x78` is **not** copied from the
instrument, it is written by whatever loads the sample. Against that, `0x3086` compares the playback
position with the same field and stops the voice when it is past and `[slot+0x80]` is zero, which
reads more like a sample end than a loop end.

**Next step:** find what writes `[slot + 0x78]`. It is in the block the eboot hands the DSP, so the
writer is on the eboot side, near whatever resolves a sample GUID to its decoded frames.

## 12b. The old note on `Params[2]`

Reported by ear: "the acoustic kit's kick is broken, as if the start of the sample were skipped and
only the cut tail played, with a click at the front." That is exactly what it was, and the cause was
this project's own code.

`STACK_PARAMS.startOffset` is documented as "per-layer random start,
`r · sampleLength · U(0, 1)` frames in", and wiring the unison stack applied it to **every** voice.
**`a_kit_1` sets `Params[2]` to 1.000 with `Numstack` 1**, so every drum hit began at a uniformly
random point anywhere in its own sample — on average half a kick, with no transient and a click at
the discontinuity. Six of the game's kits do the same: `8bit_kit_1`, `a_kit_1`, `bb_kit_1`,
`bb_kit_2`, `e_kit_1`, `e_perc_1`, all at 1.000 and all with `Numstack` 1. Of the 27 instruments with
a non-zero `Params[2]`, **18 have `Numstack` ≤ 1**.

The measured cost, `a_kit_1` isolated over one 25-second window:

| | RMS | peak |
|---|---|---|
| offset on every voice | 0.0186 | 0.211 |
| offset on layers after the first | **0.0711** | **0.646** |

**11.6 dB of drum kit.** It also resolves the puzzle that had been chased for several rounds: the
kit rendered 13 dB below `baiyon_drums_1` with a similar note count, and afterwards sits 1.5 dB
below it — which is exactly their `Params[24]` difference (0.344 against 0.419, 1.7 dB).

The code now applies **all three** of `Params[0..2]` only to layers after the first, on the reasoning
that a per-layer randomisation exists to decorrelate stacked layers and one layer has nothing to
decorrelate.

⚠️ **The detune had to follow, and the second symptom is the more instructive one.** Fixing only
the start offset put an audible **phaser** over the same kit, because
`a_kit_1`'s `Params[0]` is 0.030 and `1 + 0.05 * detune * U(-1,1)` gave every hit a random ±0.15%
pitch. That is inaudible on one voice — but **this level plays every drum hit on two board
components at once**: in the 25-second window, 140 of 140 distinct `(step, pitch)` slots are doubled,
across 146 components carrying `a_kit_1`. Two coherent copies a hair apart in pitch is a comb filter,
and it sweeps. The random start had been hiding it by making the copies incoherent; repairing one
bug exposed the other.

⚠️ **That is a repair, not an explanation.** It does not say why six kits set the value at all,
and a parameter that is meaningless on 18 of the 27 instruments that set it is probably not the
parameter this project thinks it is. The values cluster suggestively: exactly **1.000** on every
acoustic kit, small numbers (0.01–0.09) on textures like `record_static`, `mosquito` and
`ghost`, and ranges on `noise` and `ray_gun`. Worth re-deriving from the engine rather than trusting
the name.

⚠️ **The method failure is the lesson.** `Params[2]` was measured, documented, and wired up
without once checking what values the game's own instruments carry. Reading the corpus first — one
query — would have shown 1.000 against `Numstack` 1 and stopped the change.

## 14. The reverb send is `Params[25]`, and the wet level rests on one invented factor

Reported: the reverb seems missing on many tracks, or imperceptible.

**The per-voice send is measured**, at `fmodextinput.prx` `0x3b8f`-`0x3bb0`, in the same block that
writes the channel volume:

```
xmm0 = [rbx + 0x28]        ; the note's modulation
xmm1 = [rcx + 0x5b0]       ; Params[25].x      (0x5b0 - 0x4e8) / 8 = 25
xmm2 = [rcx + 0x5b4]       ; Params[25].y
[rbx + 0x1c] = x + mod * (y - x)
```

So the voice's send into the DSP's second stereo pair is **`Params[25]` evaluated at the note's own
modulation**, and nothing else. `+0x1c` then scales that pair in the render loop (`0x2fab`,
`0x338c`, `0x368b`).

⚠️ **The renderer does not apply `Params[25]` at all** -- it sends `PInstrument.reverbSend`, which on
seq 737099 is 0.6 or 1.0 on 958 of 1,690 tracks, where `Params[25]` runs **0.03 to 0.18** on the
instruments in play. Adding it would make the reverb *quieter*, not louder, so it does not explain
the report; and where `PInstrument.reverbSend` is applied on the engine side has not been found.
Both belong in the same investigation.

### The wet level, settled by ear against a bracket — and by REMOVING a factor

Two invented factors were stacked in the comb bank: `1 - gain` on each contribution (so a comb is
unity at DC, which has a stated reason) and `/ sqrt(N)` on the sum (on the assumption that mutually
incoherent taps add in power, which never had one). Together they put the wet signal at **22% of the
dry**, reported as far too little; with both off it reached **216%**, which is indefensible whatever
the topology turns out to be.

Dropping only `/ sqrt(N)` lands it at **60.1%**, inside the range a listener bracketed by ear and
close to the 69% they picked as right for amount. **The fix was to remove one invention, not to add
a third** — with the combs already unity at DC, summing them is the simpler reading.

### The allpasses were not allpasses, and that was the "too bright"

Reported as the reverb being clearly too bright and metallic, and it was this project's doing. The
allpasses had been made **feed-forward only**, to stop a tail that ran 2.48x the nominal RT60. But
`z^-L - g` is not an allpass: with the RT60 gain near 0.93 it ripples about **29 dB** — a comb
filter. Restoring the feedback term made them flat in magnitude and the metallic character went
away, confirmed by ear.

⚠️ **The allpass gain is still ours.** Both readings that follow from the record layout are provably
wrong: the RT60 gain in a true allpass rings 2.48x nominal, and feed-forward is the comb above.
Schroeder's conventional **0.5** stands in — flat, no tail stretch — until the wiring of the four
kernels is read rather than inferred.

### What was confirmed on the re-check, and one lead that died

`v0x3fcd50` converts the preset into the DSP state, and two of this project's formulas came back
exactly right:

- the level law is `powf(10, slot/200)` with the `-8000` floor (`0x3fcd92`-`0x3fcdd5`), which is
  `millibelToLinear` unchanged;
- the damping is `state[+0x2c] = slot10 * -6.283185307 / 48000` (`0x3fce67`-`0x3fce80`) — literally
  `-2*pi*hf/48000`, the formula already in use. **The damping was never missing**; the brightness was
  the allpass.

The state map is pinned with it: `[state+0x30 + 4k]` is slot `3+k`, which is why the PRX reads the
tap row at `[rsi+0x30]` and RT60 as `[rsi+0x38] * 0.1`.

⚠️ **Do not chase the `0.5` at `v0x2744`.** It looks like an allpass coefficient and is not: its loop
is `out[i] = (a[i] + b[i]) * 0.5`, a downmix.

⚠️ **The PRX never reads `[state+0x48]`, `[+0x4c]` or `[+0x50]`** — the three fields `v0x3fcd50`
fills from slots 0, 1 and 2 through the level law. So the wet levels are applied **outside** the DSP,
by the eboot, and where `Reverb` applies them internally is a guess about placement even though the
values are right. Slot 2's is additionally divided by 100 at `0x3fce41`, which nothing here accounts
for.

### The old note on the level, kept for the reasoning

The comb bank's one unmeasured factor. A feedback comb has DC gain `1/(1 - gain)`, so eight summed
are about nine times unity, and each contribution is scaled by `1 - gain` to bring it back. On the
presets these levels use the gains sit near **0.87**, so that factor is about **0.13** -- an **18 dB
attenuation invented to solve a problem the engine solves some other way.**

Measured on the 1:25-1:40 window, reverb against the dry mix:

| | |
|---|---|
| with the normalisation | **9.0%** |
| without it | **69.1%** |

Freeverb solves the same problem with a fixed input gain (0.015) rather than per-comb scaling, and
that is the shape worth looking for. `Reverb` takes a `normaliseCombs` flag and the renderer reads
`LBP_REVERB_NORM=off`, so the two ends can be compared while the real scaling is still unknown.

## 10. One-shots — percussion is not gated by its note, and the reason is inferred

A listener reported the drums as far too quiet, and the ride cymbal at 5:17 of one level as barely
audible. The gains were not the problem — in that window `a_kit_1` and `baiyon_drums_1` were the
**loudest** voices in the mix (average voice gain 0.49 and 0.61, against 0.23 for the music box and
0.06 for the ray gun), both on tracks at `level = 1.0`. The problem was duration:

| note | sample | note length | sample length |
|---|---|---|---|
| kick | `kick.smp` | 0.083 s | 0.806 s |
| snare | `snare.smp` | 0.167 s | 0.543 s |
| ride | `ride.smp` | 0.500 s | 0.811 s |
| open hi-hat | `hihat_open.smp` | 0.333 s | 0.630 s |

Every one truncated, the kick to a tenth of itself. **89.4% of the corpus's 673,037 percussion notes
last two steps or fewer**, and `a_kit_1`'s amplitude envelope is a bare gate (`sustain 1`,
`release 0.068`), so gating clips essentially every drum hit in every level to a stub. A one-step
kick is nobody's intention.

`Voice` now treats **a sample with no loop as a one-shot**: it is never released, and it ends when
the sample does.

⚠️ **This is inferred, and the inference is the weak part.** There is no one-shot flag — the
slot carries only `baseNote`, `baseBpm`, `pitched`, `fitBpm` and `fineTune`, and every drum slot
reads `pitched: true` like everything else. The loop's presence in the sample is the only signal the
engine has available, and the corpus statistics say gating cannot be what happens; but **the code
that acts on it has not been found**. It should be in `sub_0x38e0`'s note-off path, near the voice
record's `+0x3e`/`+0x3f` start/end pair.

⚠️ **A second oddity found on the way, and left alone.** `a_kit_1`'s ride sits in slot 1, whose
zone is notes 60..72 (`Splitnotes` `87,72,60,54,...`) but whose `baseNote` is **78** — outside its
own zone. So notes 66 and 68 play the ride at rates 0.50 and 0.56, an octave down. Six of the eight
slots have their base inside their zone and this one does not, which matches the corpus check
already recorded ("one bound per slot: 62/68"). Whether the engine pitches a kit slot at all, or
whether `Splitnotes` is being read half a zone out, is open question 4's territory and was not
touched here.

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

## 9. Board row → mixer channel — the routing is MEASURED; one link is still inferred

The old note here guessed "a row is very likely a mixer channel" as a direct index. **The corpus
refutes that**: 88% of tracks have a `gridY` outside `0..NumChannels-1`, boards run to 25 distinct
rows, and **308 of 338 sequencers have `NumChannels = 1`**. A row cannot be a channel index.

Taken **modulo 8** it fits exactly, and that is what the engine does:

```
0x3a0b  rdx  = [state + 0x1b00]            ; the 16-byte per-block header array
0x3a32  r15d = [rdx + block*16 + 4]        ; header + 0x04
0x3afc  r15d = r15d mod 8                  ; signed modulo
0x3b1b  rcx  = channel * 3                 ; 12-byte records
0x3b3c  xmm0 = [state + 0x1a68 + 12*channel]
```

Eight records against a `NumChannels` capped at 6 is what the `mod 8` is for, and it is why a board
row of 24 is not out of range.

**The headroom is real and constant.** `0x10f7`-`0x11e7` initialises all eight records to
`{0.75, 0, 0}`, and the eboot writes `Volume[i] * 0.75` over them. A sequencer whose volumes are all
1.0 runs every channel at **0.75**, not 1.0 — uniform −2.5 dB, absorbed by a normalising render
and audible in one that does not normalise.

**A second factor rides along.** `0x3b11`-`0x3b49` extracts **bits 28..29 of the note word** with
`bextr 0x21c`, indexes one of four 20-byte records at `+0x420`, and multiplies the channel volume by
its first float. So the note's own two-bit table selector scales the channel gain. What the four
tables hold is unread.

⚠️ **The inferred link: that `header + 0x04` is the board row.** What the eboot writes there
has not been read — linear disassembly of the sequencer module desynchronises and no indexed
16-byte store was found. The row is the candidate because it is the only per-track integer wide
enough to need wrapping (`gridY` runs 0..24). `channelVolume` in `project.ts` implements it and says
so. If it is wrong, the 30 multi-channel sequencers are mixed wrong — but they were mixed wrong
before too, since the volumes were not applied at all.

⚠️ **Neither rendered sequencer exercises any of this**: 723339 and 737099 both have
`NumChannels = 1` with all six volumes at 1.0, so every row lands on the same 0.75. The 30 that do
use it carry descending ramps like `1.00, 0.70, 0.50, 0.20` — which reads like an intensity
layering, not a per-instrument mixer.
