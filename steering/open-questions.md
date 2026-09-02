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
  are unreachable as zones, which is what "1 zone, 4 samples" means. What is still open is only
  whether the engine reaches them as *layers*: this project plays slot 0 five times, and four
  octave-spaced samples going unused on a five-layer patch is suspicious on its own.
- **Per-note modulation across a note's own points.** 70,028 of 2,027,633 corpus notes (3.45%) change
  modulation between their control points, and those render at their opening value. Whether the
  engine re-reads it mid-note is unmeasured.
- **The `1/3` sub-step and `Swing`.** Triplets are settled and wired; `Swing` is a normalised 0..1
  ratio clamped at 0.99 and what the engine does with it is still unknown. It stays under question 3.
- **The voice pool did not explain the density report it was found chasing.** It cuts 248 of 1,684
  notes over one window and a listener heard no difference.

## 3. Grid resolution, swing, and triplets

The cell geometry is now **measured**: `gridX = floor(2*x/105 - 0.5)`, `gridY = floor(-y/105)` at
`v0x1c4ad0`. What is still open:

- ~~**Steps per grid unit.**~~ **Settled from the engine**: `v0x1c5cda` computes a step count as
  `trunc(x * 32 / 105)`, i.e. **32 steps per 105 world units, 16 per 52.5-unit cell**. Matches both
  `sequencerdump`'s constant and the corpus's step-31 ceiling.
- ~~**`Swing` semantics.**~~ **Fully settled** — the ratio *and* what the engine does with it. See
  *3b. Swing* in [answered-questions.md](answered-questions.md).
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

~~**Next step: find what writes `[slot + 0x78]`.**~~ **Done, 2026-09-02 — see *12b* in
[answered-questions.md](answered-questions.md).** It is the **sample length**, written by the mipmap
builder at `0x12e0`, with the **loop start at `+0x7c`** and the **loop length at `+0x80`** beside it;
all three are named from the wrap at `0x3780` and the voice-stop at `0x3035`.

That closes the field but **not the question**, and it closes off the escape route:

- ⚠️ The earlier reading, "a running maximum of sample lengths", was wrong in both halves — it is
  one slot's own length and the update is a **minimum**. `src/core/render.ts` scales `Params[2]` by
  `slot.wav.channels[0].length`, which is now right for a reason rather than by luck.
- ⚠️ **The tidy reconciliation is dead.** "If that field is the loop length it is zero for the
  loopless percussion samples and the offset vanishes" was the way out that let the code and the ear
  agree. `0x3780` reads the loop length from `+0x80`, a different field, so it is not available.
  `a_kit_1`'s kick would still start anywhere inside its own 0.8 seconds.

### The contradiction is now bare, and three escapes are closed

The stack loop was read a third time, in full, on 2026-09-02. `0x1a70`-`0x1bd5`:

```
0x1a80  edx &= 7 ; [voice+0xcc] = edx           ; the voice remembers its zone
0x1a8a  if (int)[inst+0x4e4] <= 0: skip         ; Numstack
0x1a98  ebx = 0 ; jmp body                      ; <- THE LOOP ENTERS AT LAYER 0
body:
  p2 = Params[2].x + mod*(y-x)                  ; +0x4f8 / +0x4fc
  p2 *= (float)slot[zone].sampleLength          ; +0x78
  [voice + ebx*8 + 0x40] = (double)(p2 * U(0,1))    ; the layer's start position
  p0 = Params[0].x + mod*(y-x)                  ; +0x4e8 / +0x4ec
  [voice + ebx*4 + 0x68] = 1 + U(-p0,p0)*0.05   ; the layer's pitch factor
  p1 = Params[1].x + mod*(y-x)                  ; +0x4f0 / +0x4f4
  [voice + ebx*4 + 0x7c] = U(-p1,p1)*0.5        ; the layer's pan offset
  ebx++
```

Closed on the way, so nobody re-opens them:

- **The layer index really does start at 0**, unconditionally — `xor ebx, ebx` then a `jmp` straight
  into the body, with no guard on `Numstack == 1`.
- **`voice+0x28` really is the note's modulation.** `0x057a`: `bextr` with `0x418` takes bits 24..27
  of the note word and scales by `1/15` before `0x19e0` stores it at `+0x28`.
- **The modulation cannot rescue the kits.** All six set `Params[2]` to **`1.000 .. 1.000`** — flat,
  so `x + mod*(y - x)` is 1.000 at every modulation. (`baiyon_drums_1`, by contrast, is
  `0.000 .. 0.194` and is harmless at modulation 0, which is where 89% of drum notes sit.)

So: the formula is read, every input is named, and applying it as written starts every kick, snare
and hat of six kits at a uniformly random point inside its own sample. A listener called that "the
start of the sample skipped, only the cut tail, with a click", and confining the three
randomisations to layers 1+ was worth **11.6 dB** of drum kit. **Both cannot be true.**

### Who writes `+0x78` on the eboot side — SEARCHED 2026-09-02, NOT FOUND, and that is informative

`+0x78` is never *initialised* in the PRX, only clamped downward by the mip builder, so something
else must fill it. Four searches, all negative, and together they rule out the obvious shape of the
answer:

- **The record builder does not.** It is at **`v0x2a1144`**, not `v0x2a1190` — that address is
  mid-function and disassembling from it prints garbage; the constructor above it starts at
  `v0x2a0e80` and reaches the builder through a vtable, so it has no direct callers. Read in full,
  the builder writes **only** `+0x5c0`…`+0x5e4`, `+0x4e8` (`Params`, a `memcpy` of `0xd8`),
  `+0x4c0`…`+0x4e4` (the nine `Splitnotes` and `Numstack`), and per slot `+0x84` (qword), `+0x8c`
  (dword), `+0x90` (word). **Nothing below `+0x84` in any slot**, so it never touches the mip
  pointers, the lengths, or these three fields.
- **Nothing in the eboot indexes a slot by its stride.** A disassembly of the whole image,
  `v0x100000`–`v0x1180000`, finds **zero** `imul ..., 0x98` sites. Every slot access in the eboot is
  unrolled, which is why the builder above has eight copies of the same three stores.
- **Searching the unrolled offsets does not discriminate.** `+0x78 + 0x98i` for i in 0..7 gives 196
  store sites image-wide, `+0x7c` 112 and `+0x80` 220, and the ones inspected are all unrelated
  structures — `0x78`, `0x110` and `0x240` are ordinary offsets in a 18 MB binary.
- **`0x5f0` is a stride in exactly one place**, `v0x00b3a820`, and that is a vector-grow: compute a
  new capacity, allocate `capacity * 0x5f0`, copy the old elements. The container for the records,
  not a filler.

⚠️ **So the shape of the answer is probably not "eboot code writes the field".** The fields below
`+0x84` — the three mip pointers at `+0x10`/`+0x38`/`+0x60`, their lengths, and `+0x78`/`+0x7c`/
`+0x80` — are the *sample* side, and everything about the search says they arrive as a **blob**:
no stride arithmetic anywhere, no per-field stores, and the PRX's only interaction with `+0x78` is a
clamp of a value that must already be there. A `setParameterData` copy into the record fits all four
negatives at once.

### And the blob route, followed 2026-09-02 — the eboot owns the whole state

⚠️ **There is no `setParameterData` to find.** FMOD **Ex 4**'s DSP parameters are floats and
nothing else; the data-parameter API is FMOD Studio's. So the block cannot arrive that way, and
looking for it wastes a session.

It arrives as an argument. Following the record-array pointer backwards:

- The PRX does not own the array. `0x0526`-`0x0547` takes its base from a **global block at
  `v0xb860`**, at `+0x08` or `+0x10`, selected by a byte flag at `+0x00` — two bases, so the eboot
  is double-buffering them.
- That global is filled by **`memcpy(v0xb860, arg3, 0x1b50)`** at `0x0abd`, inside the entry
  `0x0a90(rdi, esi, rdx)`. `0x1b50` is **6,992** — the DSP state block, whose size steering already
  had from the 32 voice records at `+0x28`…`+0x1a27`.
- `0x1060` is the matching initialiser: it zeroes `+0x00`, `+0x08`, `+0x10` and `+0x18`.

**So the eboot owns all 6,992 bytes and hands them over by pointer on each call**, records included
— which is why nothing in the PRX ever initialises `+0x78`, and why the mip builder can only clamp a
value that arrived from outside.

⚠️ And the eboot never mentions `0x1b50` **anywhere in the image**, so the block is a type there,
not a size constant. Its `0x5f0` sites are all one neighbourhood: a vector-grow at `v0x00b3a820`
(new capacity, allocate `capacity * 0x5f0`, copy the elements) and its callers around `v0x00b37c71`.
That is the container for the instrument records.

**Next step — two concrete addresses, in that neighbourhood, found by scanning it for the slot
offsets:**

- **`v0x00b3ab0e`–`v0x00b3ab20`**: reads `[r14 + 0x78]` and `[r14 + 0x80]` as **qwords** and writes
  them to `[rbx + 0x78]` / `[rbx + 0x80]` — a record-to-record copy of exactly the three fields in
  question, which means the struct is being copied whole somewhere and the *source* is upstream.
- **`v0x00b37e69`** / **`v0x00b37e7d`**: `[rax + 0x78] = 0` then `[rax + 0x7c] = rcx` as a qword — an
  initialiser shape.

⚠️ Both are in a region dense with `std::` container code, and `+0x10` alone matches 285 times in
five pages, so **verify the object identity before believing either** — the discriminator is
whether the same function also touches `+0x84` (the root note) or a `0x98` stride.

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

⚠️ **The detune had to follow, and the second symptom turned out to be a third bug.** Fixing only
the start offset put an audible **phaser** over the same kit, because `a_kit_1`'s `Params[0]` is
0.030 and `1 + 0.05 * detune * U(-1,1)` gave every hit a random ±0.15% pitch. That is inaudible on
one voice, and the note here used to say the level plays every drum hit on two board components at
once — 140 of 140 `(step, pitch)` slots doubled.

**It does not. The dump did.** The old Java dump emitted 60 of the corpus's 338 sequencers twice, so
every note in them was rendered twice and the "doubling" was ours. See *The `RawDump` duplication*
in [lbp-modding-toolchain.md](lbp-modding-toolchain.md). Two coherent copies a hair apart in pitch
really is a comb filter and really does sweep, so the phaser was real — but its cause was the
duplication, and confining the detune to layers after the first only hid it. The detune change
still stands on its own reasoning; it just was not what fixed the phaser.

⚠️ **The method failure worth keeping**: a doubling was observed, an explanation was invented
that fitted it ("the composer placed everything twice"), and it was written into steering as a fact
about the level. Nobody asked whether every cell being doubled was plausible as authored content.
One query — are the two components at the same board cell? — would have shown they were.

⚠️ **That is a repair, not an explanation.** It does not say why six kits set the value at all,
and a parameter that is meaningless on 18 of the 27 instruments that set it is probably not the
parameter this project thinks it is. The values cluster suggestively: exactly **1.000** on every
acoustic kit, small numbers (0.01–0.09) on textures like `record_static`, `mosquito` and
`ghost`, and ranges on `noise` and `ray_gun`. Worth re-deriving from the engine rather than trusting
the name.

⚠️ **The method failure is the lesson.** `Params[2]` was measured, documented, and wired up
without once checking what values the game's own instruments carry. Reading the corpus first — one
query — would have shown 1.000 against `Numstack` 1 and stopped the change.

## 15. `robot` sounds thin, and the numbers say why — but not whether it should

A listener reports the lead synth in `This Is Halloween` as **thin, short of low end and short of
resonance** against the game. The instrument is `robot` (GUID 129082) — the report first named
`ghost`, which is not in that level at all.

What the data says, all of it consistent:

| instrument | sample | `baseNote` | notes it plays here |
|---|---|---|---|
| `robot` | `rude_bass_c3.smp` | **36** | 61, 69, 71, 78, 85 |
| `square_wave` | `kenny_square_a4.smp` | 57 | the same line |
| `pulse_wave` | `kenny_pulse_a5.smp` | 69 | |
| `saw_wave` / `sine_wave` | `kenny_saw_a4` / `kenny_sine_a4` | 57 | |

The sample names carry their own pitch and **every one of them agrees with its `baseNote`** under one
convention (C3 = 36, A4 = 57, A5 = 69). So the `baseNote` reading is not in doubt. It does mean
`robot` plays a **bass** sample **+25 to +49 semitones**, which is a thin sound by construction.

And the resonance is zero, for a measured reason. `robot`'s `Params` are
`cutoff 0.710..0.230`, `resonance 0.000..0.709` — a one-knob filter sweep — and **every one of its
1,696 note records in this level carries timbre 0**, so the interpolation lands on `x`: cutoff 0.71,
resonance 0. `square_wave` is the same story (`resonance 0.000..0.830`, all notes at 0). Corpus-wide
20.9% of records carry a non-zero timbre, so zero here is the composer's choice, not a parse failure.

**What is not settled** is whether the game sounds the same. Two things could still be wrong on our
side and neither is checked:

- ~~the direction of the `x`/`y` interpolation~~ — **SETTLED 2026-09-02 for all 27 parameters**, not
  just the sends. See *20* in [answered-questions.md](answered-questions.md);

⚠️ **A third thing, found 2026-09-02 and fixed on our side, but not settled on the engine's.**
The filter's key tracking was being fed the voice's **opening** playback rate, so a note that glides
kept the cutoff it started with. `Northern Lights` (`2bc7d95a`, uid 16629) opens on `noise` --
`kenny_noise.smp`, a one-second loop, `keyTrack` **1.000**, cutoff 0.465..0.120 -- glided from y34 to
y61 over 32 steps, which is +27 semitones and a rate of 4.76. With the cutoff pinned the riser did
not rise: measured by zero-crossing rate the output swept **1.83x**, against **3.47x** once the
current rate is used. `src/audio/mixer.ts` now passes the rate the voice is playing at this frame,
and the `envAmount === 0` shortcut no longer fires for a voice whose rate moves. **Which rate the
engine feeds that term is still this question**, and `LBP_NO_KEYTRACK` still exists because the term
may be inert altogether -- what is not in doubt is that between the opening rate and the current one,
only the current one lets a glide sweep.
- the octave, which is why `LBP_PITCH=<guid>:<semitones>` exists in `dev/render-level.ts` —
  `LBP_PITCH=129082:-12` renders `robot` an octave down, scaling only the playback rate so the key
  zone and the filter's key-tracking do not move with it.

⚠️ One thing was ruled out on the way: byte 3 of a note record only ever holds `0x00`, `0x40` or a
low nibble — bits 4 and 5 are never set corpus-wide, and `0x40` is bit 30, which the engine already
uses for the triplet sub-step. There is no unread per-note flag hiding there.

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

### The unbounded form of the rule is REFUTED — 2026-09-02

The rule was stated over *loopless samples* and reasoned about on drum kits, whose samples are under
a second and which play at a rate near 1. Stated that way it grants a voice the **stretched**
length, and a note far below the sample's base note stretches without limit.

`mime_artist` is where that shows. It is four **plucks** — `pluck_a6`, `pluck_a5`, `pluck_a4`,
`pluck_a3`, 9,142 frames each, and none of them carries a `smpl` chunk, so they are genuinely
loopless — at base notes 81, 69, 57, 45, with `Numstack` 5. `Splitnotes` is `[87,0,0,…]`: one
bound, so every note resolves to the base-81 slot. `Ascetic` plays it at notes 13–24, **57 to 68
semitones below that base**, so the rate is 0.020–0.037 and a **0.19-second pluck becomes 9.02
seconds**, five layers deep, from notes the composer wrote **0.12 seconds** long.

Measured over that one sequencer:

| | |
|---|---|
| peak simultaneous voice demand | **216**, against a pool of 32 |
| of which `mime_artist` | **200** |
| its share of all voice-time in the song | **82.1%** |
| its allocator score | 0.57–0.75, the **highest** in the piece |

The score is what makes it fatal rather than merely wasteful: the allocator steals the *quietest*,
so the drone never loses and everything else is taken instead. A listener reported exactly that —
first *"note basse incasinate"*, then, once the pool was made to account for the real occupancy,
*"le note basse saturano le 32 voci mutando tutto il resto"*. **A published level cannot sound like
that**, so the unbounded rule is wrong independently of anything about the pool.

### What replaced it, and what is still open

`holdFramesFor` in `src/core/render.ts`: the exemption grants the sample **its own duration at its
own rate**, `sampleFrames * RATE / sampleRate` output frames, rather than the stretched one. A
sample's length is a property of the sample; the stretch is a property of the note, and the note
already has a gate.

- **Percussion is untouched.** A kit plays at rate 0.45–1.33, so natural and stretched are nearly
  the same. Rendering `Ascetic`'s drums alone under both rules: `a_kit_1` RMS 0.03886 → 0.03883 and
  the same peak 0.379; `baiyon_drums_1` identical to five figures. Every drum measurement above
  stands.
- **`Ascetic` stops eating itself.** Voice stealing over the whole song goes from 2,276 notes cut to
  **0 of 14,499**, and the render from 26 s to 13 s.

⚠️ **The bound is still an inference, and this question is still open.** `options.oneShot` is the
A/B — `'full'` is the old unbounded rule, `'gate'` no exemption at all, `'natural'` the default —
and `LBP_ONESHOT` exposes it on `dev/render-level.ts`. What would settle it is the engine's note-off
path, `sub_0x38e0` near the voice record's `+0x3e`/`+0x3f` start/end pair.

⚠️ **A second thing this turned up and did not resolve.** `mime_artist`'s four samples are an
octave apart — 81, 69, 57, 45 — which is the shape of key **zones**, not of stack layers, but
`Splitnotes` names only one bound so `zoneCount` gives 1 and every note lands on the base-81 sample.
`e_guitar_distorted` has the same disagreement (two samples, three bounds). Whether the engine
derives the missing bounds from the base notes is worth knowing: for a note at 13 it is the
difference between transposing 68 semitones down and 32.

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

### Hunting `header + 0x04`: what was eliminated, 2026-09-02

A pass went looking for the writer and did not find it. The eliminations are worth more than the
search was, because each was a plausible candidate:

| candidate | why it looked right | why it is not |
|---|---|---|
| `v0x1c74b0` | the **only** function in the sequencer module with a stack frame ≥ 4 KB — `sub rsp, 0x1bb8`, 7,096 bytes, enough to hold a copy of the 6,992-byte audio state | 411 instructions to its first `ret` and **not one** touches `+0x1ad0`, `+0x1ad8`, `+0x1af0`, `+0x1af8`, `+0x1b00` or a `*16` index. Steering's standing "do not re-examine" holds, and now for a measured reason rather than its constants |
| `v0x521d5f` | a real `mov dword ptr [rsi + 0x1af0], ebx` — a write to what the data model calls the block count | its neighbours write `[r14+0x1b28] = 0xb`, `[r14+0x1b38] = 0x4b00000005` and so on. A different structure that happens to have a field at the same offset |
| `imul ..., 0x98` anywhere in the eboot | the slot-record stride | **zero** sites. The builder at `v0x2a1190` writes slot fields at fixed unrolled offsets (`0x84`, `0x11c`, `0x1b4`, …), so nothing indexes them |

**What was learned on the way**, and is new:

- A note block is reached through a **handle**, not a pointer: `{+0x50: block index, +0x54:
  generation}`, and every accessor re-validates `[+0x50] < [state+0x1ac8]` and `[+0x54]` against a
  module global before indexing. So **`[state+0x1ac8]` is the block count** — the data model's
  `+0x1af0` is something else, or there are two.
- Nine such accessors sit at `v0x160930`-`v0x1610e6`, all of the same shape: call `v0x3fff20` for the
  state, validate the handle, `imul index, 0x470`, add `[state+0x1ad0]` or `[state+0x1ad8]` for the
  A/B copy, tail-call the worker. `v0x1609a0` packs a 7-bit value into bits 8..14 of `[state+0x1b34]`,
  which is a note being written — so this family is the **editor's** API over note blocks.

⚠️ **A refinement to the method note, learned by being fooled.** Byte-scanning for a displacement
and validating by decoding backwards produces **false positives**: `[rsp + 0x1af8]`, `[rsp + 0x1ac8]`
and friends appeared repeatedly at `v0x1c59xx`-`v0x1c5cxx` and looked like a state copy on the stack,
but no function there has a frame big enough to hold one. The displacement bytes happen to end a
valid instruction. **Validate a hit by decoding forward from a confirmed function start until it
reaches the address, not by decoding backwards into it.**

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

**A second factor rides along, and the record it comes from is now read.** `0x3b11`-`0x3b49`
extracts **bits 28..29 of the note word** with `bextr 0x21c` and indexes one of four 20-byte records
at note-block `+0x420`, multiplying the channel volume by its first float. `v0x1607c0` is what
fills such a record, from the runtime `PInstrument` at `rdi`:

```
[block + 0x04]  = [inst + 0x20]                 ; an int -- NOT the 16-byte header's +0x04
[block + 0x420] = [inst + 0x30]                 ; the placement's level -- this is the factor
[block + 0x424] = [inst + 0x34]                 ; pan
[block + 0x428] = [inst + 0x38] * 2 - 1         ; the echo send, as a bipolar offset
[block + 0x42c] = [inst + 0x3c]                 ; the reverb send
[block + 0x430] = instrument index              ; written separately at v0x1c44c9
```

and `v0x1c450e` then multiplies `[block+0x420]` by **0.25 or 1.0** depending on a stack flag.

⚠️ **`v0x1607c0` fills record 0 only**, so what puts anything in records 1-3 — and therefore what
the note's two-bit selector is selecting between — is still unread. Do not assume the selector is
always zero; assume nothing, and read the writer.

⚠️ **Two different `+0x04`s.** The one this question is about is in the **16-byte** array at
`[state+0x1b00]`; the one `v0x1607c0` writes is in the **0x470-byte note block**. They are not the
same field and a search for one will keep finding the other.

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

### A method note: linear disassembly of the eboot desynchronises

Three separate searches this session returned **zero hits** on questions that later turned out to
have obvious answers — the block-header writer, the indexed stores in the sequencer module, the
`DSP::setParameter` callers — because a linear sweep of the eboot's `.text` from an arbitrary offset
drifts out of instruction alignment and silently disassembles nonsense.

What works instead, in order of preference:

1. **Byte-scan for the encoding**, then validate each hit by disassembling backwards a few bytes
   (this is how the `E8` relocations to `v0xa23970` were found).
2. **Disassemble from a known function start**, never from a round address.
3. In a PRX, **include indexed forms in the pattern**: the `Splitnotes` walk was declared absent
   because the scan only matched `[reg + disp]` and the walk is `[rdx + rax*4 + 0x4c4]`.

⚠️ A negative result from a pattern scan is only as strong as the pattern.

