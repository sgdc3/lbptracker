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
- ~~**Per-note modulation across a note's own points.**~~ **SETTLED 2026-09-03: the engine ramps
  it and re-reads it every chunk.** `sub_0x3930` writes a slide rate for it at `0x3e8a` beside the
  ones for volume and pitch, and `sub_0x1c60` advances it by `slide × dt` at `0x1f4a` and reads the
  result four times. The cadence is per chunk per voice, under the DSP read callback at `sub_0x170`.
  Full chain and addresses in `answered-questions.md` 6d. **Implemented the same day, in full**:
  `VoiceSpec.morph` carries the ramp, `Voice.render` re-derives per 128-frame chunk, and the echo
  send follows it too — which turned out to be worth almost nothing, 68 notes in the corpus,
  because a placement with `echoSend == 0` mutes the instrument's send whatever the modulation
  does. Nothing outstanding.

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
- ~~the octave~~ — **REFUTED 2026-09-02 by the corpus.** `robot` is one looped sample,
  `rude_bass_c3` at base note 36, and across the 18 levels that parse it carries **49,447 notes**
  spread from **−12 to +30 semitones** relative to that base, smooth, peaking at +24…+28 — with
  **624 notes on the base note itself** and 242 an octave below it. A systematic octave error cannot
  produce that shape; it would move the whole distribution, not put a fat middle at +26 and a tail at
  −1. Composers simply use it as a lead. `LBP_PITCH` stays as a diagnostic, but there is nothing here
  for it to fix, and the thinness has to be explained by something that is not the pitch.

  ⚠️ `Key` was ruled out on the way: 49,270 of those 49,447 notes carry `Key = 0`, so question 4's
  transposition changes almost nothing for this instrument.

⚠️ One thing was ruled out on the way: byte 3 of a note record only ever holds `0x00`, `0x40` or a
low nibble — bits 4 and 5 are never set corpus-wide, and `0x40` is bit 30, which the engine already
uses for the triplet sub-step. There is no unread per-note flag hiding there.

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

  **This question is closed, and so is the implementing.** ⚠️ This entry used to end "what remains
  is not naming but implementing: the three LFOs and the two-bus output are recovered and not yet in
  the mixer" — stale. All three LFOs, both sends, the unison stack, the ladder, both ADSRs and
  (2026-09-02) the drive are in `src/audio/mixer.ts`.

  ✔ **And what each LFO modulates is now measured, all three**, where this used to say "only
  partly established":

  | LFO | the instruction that names it | destination |
  |---|---|---|
  | 1 (`Params[15..17]`) | `0x2788`/`0x281a` scale the depth by **0.05** — the constant the stack detune also uses, at `0x1b59` | the playback **rate** |
  | 2 (`Params[18..20]`) | `0x255c`-`0x2574`: `sin * depth`, then **`+ 1`**, then it multiplies a level | the **gain** |
  | 3 (`Params[21..23]`) | `0x26cb`-`0x2713`: abs, halve, `floor`, `frac * 2`, and `2 - t` above 1 | a **triangle fold** into `0..1` |

  ⚠️ LFO 3's *fold* is measured instruction for instruction and `src/audio/lfo.ts` reproduces it
  line for line. What stays a reading is only the **destination**: `t` is broadcast and written
  through a pointer in the same shape LFO 2's gain uses, and the last hop into the two per-channel
  factors was not read end to end. Pan is the reading because `t` lands in `0..1` and `panGains` —
  which is measured — is this voice's only consumer of one.

  ⚠️ **18 of the 68 instruments use at least one LFO**, including `square_wave`, `saw_wave`,
  `sine_wave`, `triangle_wave`, `pulse_wave`, `ray_gun` and `robot` — the corpus's most-played
  instruments — so a wrong destination here would not have been a corner case.
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
the note's two-bit selector is selecting between — is still unread.

✔ **But the selector is 0 on every note anyone has ever written.** Measured 2026-09-02 over the 18
levels that parse, **2,879,331 note records**: bits 28..29 are `0` on **100.0000%** of them, 1, 2 and
3 on none. Byte 3 takes only **32 distinct values, maximum `0x4f`** — bit 6 (the triplet sub-step)
and the low nibble (the modulation), and nothing else; bits 4 and 5 are never set.

So records 1-3 are unreachable from authored content, and rendering as though the selector were
always zero is exact for every level in the corpus. ⚠️ That is a fact about the *corpus*, not about
the format: if the editor can set those bits, a level that does would take a path nobody has read.

⚠️ **Two different `+0x04`s.** The one this question is about is in the **16-byte** array at
`[state+0x1b00]`; the one `v0x1607c0` writes is in the **0x470-byte note block**. They are not the
same field and a search for one will keep finding the other.

### The inferred link, 2026-09-02: **its neighbour is now proven to be `gridX`**

What the eboot writes into that array still has not been read — linear disassembly of the sequencer
module desynchronises and no indexed 16-byte store was found. But the record's **other** field has
been read, and it changes how good the inference is.

`0x39cb`-`0x3a41`, the note-record walk:

```
0x39cb  rdx = [state + 0x1b00]        ; the 16-byte array   (or +0x1af8, double-buffered)
0x39d5  rdi = block << 4              ; 16 bytes per entry
0x39f0  eax  = A[block] + 0x00
0x39f2  r15d = A[block] + 0x04        ; -> mod 8 -> the mixer channel
...
0x3a0e  r11 = noteBlock + index*4 + 0x20   ; the 4-byte note records
0x3a13  eax <<= 4                     ; A[block][0] * 16
0x3a31  r12d -= eax                   ; the playhead, MINUS that
0x3a3e  edx = *r11 & 0x7f             ; the record's step
0x3a41  cmp r12d, edx                 ; has the playhead reached it?
```

**`A[block][0] * 16` is subtracted from the playhead before a record's step is compared.** That is
`stepOffset = gridX * 16` — so `+0x00` **is the board column**, and the `<< 4` is a second,
independent sighting of `STEPS_PER_CELL = 16` (the first was `v0x1c5cda`'s `trunc(x * 32 / 105)`).

⚠️ So `+0x04` is **the field immediately after a proven `gridX`, in a 16-byte record written per
placement**. The row was previously the candidate only because it was "the only per-track integer
wide enough to need wrapping"; now it is the natural partner of the field next to it. That is a much
better inference and still an inference: the writer has not been read. `channelVolume` in
`project.ts` implements it and says so. If it is wrong, the 30 multi-channel sequencers are mixed
wrong — but they were mixed wrong before too, since the volumes were not applied at all.

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

---

## 22. Why FMOD feeds the centre speaker a mono sum -- everything downstream is now read

⚠️ **Read [answered-questions.md](answered-questions.md) entry 22 first.** The narrowing is
measured to six significant figures and implemented (`PAN_WIDTH = 2-sqrt2`). Both ends of the chain
below the sequencer are now *read*, not fitted, and what is left is one step inside FMOD.

### ✔ The game renders 7.1

`v0xa57770`, the `GetDriverCaps` callback of the output description built at `v0x13e3c78` and named
**"FMOD Orbis AudioOut Output"**:

```
0xa57775  [rdx] = 0x84      ; FMOD_CAPS_OUTPUT_MULTICHANNEL | FMOD_CAPS_OUTPUT_FORMAT_PCMFLOAT
0xa57780  [rcx] = 0xbb80    ; 48000
0xa5778b  [r8]  = 6         ; FMOD_SPEAKERMODE_7POINT1
```

Its neighbours confirm it is that table: `v0xa57720` writes one driver, `v0xa57730` copies
`"Orbis AudioOut output"`. The game never calls `setSpeakerMode`, so this is the mode FMOD runs in,
and `sceAudioOutOpen` gets `param = 5`, `FLOAT_8CH`. **Eight channels leave the game.**

The Init callback was reached the direct way in the end: it is called once, from a C++ adjustor
thunk at `v0xa574a0` (`add rax, -0x38`), whose address is taken at `v0xa57412` -- the description
being built. Searching for the real function's address had failed because nothing takes it.

### ✔ The fold to stereo, read from shadPS4's source

The listener's captures were made under shadPS4, so the downmix is not inferred at all --
`shared/src/core/libraries/audio/sdl_audio_out.cpp`, `DownmixF32_8CHToStereoPS4`:

```c
static constexpr float DOWNMIX_FRONT   = 1.0f;
static constexpr float DOWNMIX_CENTER  = 0.7071f;
static constexpr float DOWNMIX_SURROUND = 0.7071f;

const float center = DOWNMIX_CENTER * s[o + FC];              // FC = 2
d[i*2 + 0] = DOWNMIX_FRONT * s[o + FL] + center + DOWNMIX_SURROUND * (s[o+4] + s[o+6]);
d[i*2 + 1] = DOWNMIX_FRONT * s[o + FR] + center + DOWNMIX_SURROUND * (s[o+5] + s[o+7]);
```

selected when `num_channels >= 6` and the host device reports 1 or 2 channels (`ps4_downmix`).
**A 7.1 downmix cross-feeds only through the centre**: the surround terms go to their own side.

### ✔ Therefore the centre carries `(L+R)/2` -- derived, not fitted

With the fold read, the measurement forces the content. `0.7071 * FC = 0.3536 * (L+R)` gives
`FC = (L+R)/2`, and the obvious alternative is **refuted by the recordings**: if FMOD mapped the
DSP's four channels straight into the bus as FL, FR, FC, LFE, the centre would hold `L * send` and
the result would be *asymmetric* -- ratio 0.2612 at pan 0 and **0** at pan 1. The two captures give
the same 0.261202 at both. Any scheme feeding one side into the centre dies the same way.

### What is left, and it is one step

**Why does FMOD Ex put the mono average of a 4-channel 2D source into the centre speaker when it
upmixes to 7.1?** That is the only unread link. The channel is created by `playDSP`, is `FMOD_2D`,
has pan `0.0`, volume `1.0`, and no `setSpeakerMix` or `setSpeakerLevels` is ever called on it, so
whatever does this is FMOD's default matrix -- `fmod_dspi.cpp` / `fmod_dsp_connectionpool.cpp`.

⚠️ **This is now a curiosity, not a fidelity risk.** The centre feed is the *game's* (FMOD's), and
the `1/sqrt2` fold is the *downmixer's* and is the ITU-R BS.775 coefficient, which real hardware and
a compliant emulator share. So a stereo listener hears this narrowing either way, and the tracker is
right to reproduce it.

### Where the last link is, and the three dead ends already walked

⚠️ **No experiment is available.** The listener has no multichannel host device, so the 8-channel
stream cannot be captured, and no PS4 hardware, so the fold cannot be compared against another
downmixer. This has to come out of FMOD's code in the eboot.

The channel's own setup **is** read, `v0xa0b2e0`. `[channel+0x11c]` selects how its output is placed:

| value | meaning | data |
|---|---|---|
| 1 | an explicit speaker **mix** | eight floats at `[channel+0x1a8]`..`[+0x1c4]` |
| 2 | an explicit speaker **levels** array | `[channel+0x208]` |
| 0 | a plain **pan** | `[channel+0x1a4]`, clamped to +-1 |

The sequencer's channel is case **0**: `setDefaults` gave it pan `0.0` and nothing ever calls
`setSpeakerMix` or `setSpeakerLevels` on it. At `v0xa0b4cf` that branch clamps the pan, writes
`[channel+0x11c] = 0`, and forwards the value through a **virtual at `+0x98`** on the attached DSP
unit and on each of the channel's others. **So the matrix is built per-DSP-unit behind a vtable, and
that call is where the next attempt has to go** -- resolving the DSP unit's vtable, not searching for
constants.

### The vtable was attacked directly and did NOT resolve

Attempted 2026-09-03 at the listener's request. It did not land, but the target is now boxed in and
six routes are eliminated, so the next attempt starts much further along.

**What is known about the object at `[channel+0x90]`:**

- it is **created by a factory virtual at `+0x8`** of another object, called at `v0xa0a856` as
  `(..., &out, ecx=1, r8d=1, r9d=0)`, then stored at `v0xa0a892` with `[channel+0x88] = 1`;
- its vtable has **at least 38 entries** -- `v0xa0a7cc` calls `[vtable+0x128]`;
- **`+0x88` takes one float** (the channel's volume, `[channel+0x19c]`, at `v0xa0b38f`);
- **`+0x98` takes exactly two floats**: the clamped pan and the literal `1.0` (`v0xa0b539`).

**The method that should have worked, and why it did not.** Vtables can be enumerated from the
`R_X86_64_RELATIVE` relocations: 33,235 of them, of which 10,445 form runs of consecutive slots
holding code addresses, 204 of length >= 20. Filtering those on `+0x88`, `+0x98` and `+0x128` all
being FMOD code leaves **five**, and every one is an Event-system or `fmod_soundi.cpp` class -- no
panner. Dropping the contiguity requirement (a pure-virtual stub or an out-of-range entry splits a
run) widens it to 175 `+0x98` candidates, of which only two take a second float.

⚠️ **The near miss, which will cost the next session an hour if it is not written down.**
`v0xa287b0` is shared by **eight** vtables -- the right multiplicity for the DSP type hierarchy --
and has exactly the right shape:

```
vminss/vmaxss xmm1        ; clamp volume to [0, 1]
vmaxss/vminss xmm2        ; clamp pan to [-1, 1]
cmp esi, 0x100            ; clamp priority
[rdi+0x1a4] = xmm0   [rdi+0x1a0] = xmm1   [rdi+0x1a8] = xmm2   [rdi+0x1ac] = eax
```

That is `setDefaults(frequency, volume, pan, priority)`. **It is not the function being called**: the
call site passes two floats and this one takes three plus an int, and the argument that would be the
pan (`xmm2`) is never set by the caller. The offsets `+0x1a0`/`+0x1a4` matching the channel's own
layout is a shared base class, not an identification.

**Where to go next**, in order of promise: resolve `rax` at `v0xa0a856` and read the factory, which
names the class outright; or enumerate vtables allowing interior non-code entries *and* accepting a
`+0x98` whose body is a plain two-float store, which is what a `setPan(pan, spread)` would be.

Six routes are dead; do not repeat them:

- **`v0xa47400` is `SpeakerLevelsPool::free`, not the allocator.** Its two callers (`v0xa0af30`,
  `v0xa0b454`) are both channel teardown, releasing `[channel+0x208]`. The pool is not a way in.
- **The eight-element float rows at `v0xe46ae0`** (8x `0.5`, then 8x `0.70711`, then 8x `-0.0`) look
  exactly like a speaker table and are not one: the `lea`s that reach that neighbourhood resolve to
  the strings `"ID3"` and `"fLaC"`, so these are SIMD constants in the codec block. `v0xe1c440` is a
  genuine cosine table at 30-degree steps, but nothing has tied it to this path.
- **Searching for the address of the output plugin's `Init`** found nothing because nothing takes
  it; it is called through a C++ adjustor thunk. Same trap will apply to any other FMOD callback.
- **`System::createDSP` -> `v0xa52560` loads no vtable base** in its first 0x900 bytes, so the DSP
  object's construction is deeper still; that path did not shortcut to the class.
- **The sine table at `v0xe1c440`** (0, 0.5, 0.7071, 0.866, 0.9659, 1, ... -- sin at 15-degree steps)
  is the obvious speaker-angle table and belongs to **the game, not FMOD**: all five references to it
  come from `v0x22e9f8`, `v0x24c820`, `v0x24fb83`, `v0x519f96` and `v0x7ca340`, none in FMOD's range.

### The leading hypothesis, and why it is not written down as fact

A textbook quad->7.1 upmix computes `C = (FL + FR) / 2`, which is **exactly** what the measurement
requires, to six figures, with no free parameter left over. It is the obvious thing for FMOD to do
and it fits perfectly. ⚠️ **It is still a guess.** Nothing in the eboot has been read that does
it, and this project has already been burnt once this week by an inference from architecture
("a shared library cannot know about our types") that the disassembly then refuted.

One observation does support an output-stage fold over a per-voice one: the captures' residual is
0.0008 **over the whole file**, tails included, so every part of the signal gets the same treatment
rather than the dry path alone. That is what a fold below the mix looks like.

### What has been eliminated, with the address that eliminated it

| hypothesis | verdict |
|---|---|
| the pan is compressed before reaching the voice | **no** — `0x3b20`/`0x3b29` copy it raw |
| the pan law is not linear | **no** — `0x2d21`/`0x2d40` are `1-p` and `p` |
| a constant in the plugin | **no** — no float between 0.35 and 0.5 is referenced anywhere in it |
| a constant in the eboot's sequencer module | **no** — 39 functions, only 0.25/0.5/0.75/0.95 |
| stereo samples | **no** — every kit sample is mono, 48 kHz |
| the pan LFO or the unison spread | **no** — both kits leave every depth at 0, `Numstack` 1 |
| a mono reverb send bleeding into the output | **no** — the two dominant placements have `reverbSend` **0.000** |
| the mixer-channel records carrying a pan | **no** — `0x10b7`-`0x10cb` fill them `{0.75, 0, 0}` and `0x3adf`/`0x3ae9` read the second and third as **integer flags**, `or`-ed with a global |
| the level position | **no** — the listener plays the game and says so |


## 23. A flat ~1 dB deficit above 315 Hz

From the same comparison, and independent of question 22 — it is present in the **total** energy
`L² + R²`, which does not care about stereo width.

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

**The bass is exact** — within 0.5 dB, and 0.07 dB at 160-315. Everything from 315 Hz up is quiet by
roughly a decibel, with the worst at either end of that range.

Candidates, none checked: the mipmap chain's crossover (a mip taken too early loses highs); the
interpolator (linear interpolation is a lowpass whose loss grows with frequency, and the engine's
own is measured, so this would have to be a bug rather than a difference); the ladder's coefficient
solve at low cutoffs; or the capture chain again. ⚠️ It is suspiciously *flat* for a filter — a
resampling or interpolation error would tilt with frequency rather than sit at −1 dB across five
octaves, which argues for something gain-like that this project applies to part of the signal.

## 24. The last 109 clips that need a verbatim record patch

⚠️ **Nothing here is audible, and nothing here is broken.** The MIDI round trip is exact — 0 records
different in 1,448,224 — *because* the exporter carries these clips' records verbatim in the
`LBP-TRK` meta's `fix`. The question is only whether the patch can be made smaller, which matters
because every clip in it is a clip whose bytes go stale the moment a DAW edits its notes. See
[midi-interchange.md](midi-interchange.md) for what `fix` is and why it exists.

**Where it stands, measured 2026-09-04 over the ten-level corpus** (`LBP_MIDI_LOOSE=1` turns the
patch off so the residue is visible):

| | clips | |
|---|---|---|
| a ramp re-cut onto the staircase its own rounding makes | **73** | the reconstruction is *tighter* to the curve than the author's encoding |
| byte 3's resting bit is not uniform within the clip | **31** | inert to the engine; per note, and MIDI has no free per-note carrier |
| not diagnosed | **5** | |

**109 of 62,158 clips (0.18%), 23 kB, 0.10% of the file.** It was 177 the same day and 649 the day
before; the things that closed the gap are written up in `midi-interchange.md`, and each of them was
a case where MIDI *could* say the thing after all.

### 24a. The re-cut ramps — 73 clips

The exporter resamples a glide onto thirds of a step and the importer folds the samples back with
Douglas–Peucker at a half-unit tolerance. Volume and modulation are integers, so a ramp is really a
staircase, and the reconstruction keeps the staircase's own corner where the author named an
endpoint: `28+0:63:44 29+0:53:75 30+0:53:75 32+0:55:44 47+0:55:22 63+0:55:0` comes back with an
extra record at `46+2/3`.

⚠️ **It is tighter to the curve, not looser**, so loosening the simplifier to make the record count
match would make the curve *worse*. That is why this is not simply a bug to fix.

**The anchor**: when two candidate breakpoints both sit inside the tolerance, Douglas–Peucker takes
the one furthest from the chord. Preferring the one on a **whole step** at equal deviation would
match the author's encoding more often for free, since authors write on steps. The experiment is one
comparison in `simplify` and a corpus run; if it does not move the 73, the remaining ones are
genuinely ambiguous and the patch is the right answer.

### 24b. Byte 3's resting bit inside a mixed clip — 31 clips

The bit is described in [sequencer-data-model.md](sequencer-data-model.md): the engine reads it only
when byte 0's bit 7 is set, and the editor writes it anyway, decided by the level's revision. It is
uniform within a note in 953,777 of 953,791 and within a clip in 62,075 of 62,106, so it travels as
a per-clip default in the `clips` tuple. These 31 clips hold notes with both values.

**The anchor**: measure whether the bit is constant across a **contiguous run** of a mixed clip's
notes — a level saved across the editor change would have the old notes first and the new ones
after, which is a run-length and would fit in the clips tuple in a few bytes. If it is scattered
instead, only a per-note carrier could hold it and the patch stays.

### 24c. The five that are not diagnosed

The scratchpad's field-by-field diff (`why177.ts` in this session's scratch) buckets the patched
clips by which field differs; these five fall into mixtures (`pitch + position + record count +
volume` and the like) that were never opened. **Print them before theorising.**

### What has already been ruled out — do not repeat these

- **The flat-run markers are not the cause of the stray thirds.** Turning them off takes the patch
  from 109 clips to **277**, so they are carrying far more than they cost.
- **Six clip-assignment tie-break rules** (nearest, earliest, tightest, loosest, busiest, same-start)
  were measured against each other and moved the total from 686 to 680 at best. The cell ambiguity
  is not where the remaining clips are.
- **A fourth record-order key does not exist.** Position ascending, then pitch descending, then the
  end ascending are each 100% over the corpus; among the 254 clips tied on all three, nothing beats
  98.8% (modulation ascending) and 94.9% (volume descending). Adding one would look like the other
  three and not be one.

## 28. Four resources in the corpus that still will not open

Everything else in the six measured saves reads. These four do not, and each fails **by name**,
which is the reader's growth path working rather than a silence to chase.

- **`YELLOWHEAD`** — one plan. `PYellowHead` is a player's poppet state: two dozen fields, a nested
  `Poppet` struct with its own tree, and a `SerializationException` thrown by cwlib itself in two
  subVersion ranges. Twenty minutes of layout for one file, and a plan carrying a *player* is not
  where music lives. Anchor: `cwlib/structs/things/parts/PYellowHead.java`.
- **Revision `0x272`** — one plan, an LBP1-era resource `requireLbp3` refuses on purpose. Widening
  the range means adding the older branches field by field, not relaxing the check; see
  `serializer.ts`.
- **Branch `0x4431`** — one level, `f331efa7`, version 0x3e2. Neither `LEERDAMMER` (0x4c44) nor
  `MIZUKI` (0x4d5a), so **cwlib does not know this branch either**. Its first Thing reports no
  `WORLD` part, which means the header layout diverges before the part mask. Unknowable from the
  corpus alone: one file is not enough to reverse a branch from.
- **A quest of a type other than 5** — not seen yet, and `readQuest` refuses rather than guessing:
  the other types carry a trailing block whose shape depends on the type.

**None of these is in the way of music.** They are listed so that a failure on screen can be
recognised as one of them rather than investigated twice.

## 29. Does a releasing voice still hold its record?

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

Nothing in `fmodextinput.prx` reads or decrements it again; the block driver zeroes `+0x10` and
`+0x14` together when it frees a record (`0x10a0`-`0x10a3`). A constant 10000 and a dead branch.

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

### ❗ It cannot be settled from the binary, and here is what would settle it

Both models are self-consistent; what separates them is what the game **sounds like** on a dense
passage, and that is a recording. This project has done exactly that before — question 10, the
one-shot gate, was settled against a capture of the game and overturned what the code had implied.

The experiment: capture `C4K3 S0NG` (or any passage that wants more than 32 records) from the game,
and count the notes that stop early. **The two models differ by more than a factor of two**, 10.8%
against 22.3%, so a single capture separates them without any subtlety.

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
