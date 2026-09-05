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

❗ **The sampler side is now closed too.** Question 12 — `Params[2]`, the last unresolved thing the
engine does to a note before it sounds — was answered on 2026-09-05: the stack loop computes a
random start for every layer and the instruction after it clears layer 0's, which is why six drum
kits can set the parameter to 1.000 harmlessly. That entry is worth reading for its method failure
rather than its answer: **the measurement had been in
[sequencer-data-model.md](sequencer-data-model.md) since the day the loop was first read, two lines
above a summary table that contradicted it.**

❗ **And the output stage is closed, the same day.** Question 22 — why the game's centre speaker
carries the mono average of the front pair — was the last hop of the signal chain that was inferred
rather than read. It is read now, at `v0xa2599f`, and `PAN_WIDTH = 2 - sqrt2` is a derivation from
three measured constants instead of a fit. Its entry is the one to read before any vtable hunt in
this binary: **the eboot has RTTI**, 322 vtables can be named outright, and a session was spent
enumerating them by shape instead. `tools/ebvtable.py` is what came out of it.

**Nothing about the engine's signal path is unread any more.** What is left in this file is two
listening reports that need a capture from real hardware (15, 23), some semantics (0, 3), one
question that is not about fidelity at all (24), and one about files this reader does not claim to
support (28).

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
  are unreachable as zones, which is what "1 zone, 4 samples" means.

  ✔ **CLOSED 2026-09-05: they are not reachable as layers either, and this project is right.** The
  `0x98` slot stride appears at exactly four sites in the whole module — `0x1aca`, `0x1d6a`,
  `0x2c68`, `0x3046` — and every one of them indexes by `voice+0xcc`, the **zone**, which `0x1a83`
  writes once per note from `note & 7`. `0x2bc2` loads it once into `r12` for the render loop. There
  is no per-layer slot index anywhere, so a stacked voice plays one slot `Numstack` times, and
  `mime_artist`'s other three samples are dead weight in the patch. Nothing outstanding.
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

- **The release tail, question 29's residual.** The question itself is answered — the engine holds a
  record until the envelope reaches zero, measured six ways — and the model is a *decision*:
  `RenderOptions.releaseTail` defaults **off**, because a listener rejects the tail on and accepts it
  off. What is left is not an unknown about the engine but an unrun experiment: **capture
  `C4K3 S0NG` from the game at 25.85 s and count whether the choir chord enters with five voices or
  one.** The error the decision can be wrong by is bounded — the tail newly crowds 12.7% of that
  song, and more than half of that is one to four records over 32. See *29* in
  [answered-questions.md](answered-questions.md).
  ✔ **A shadPS4 capture settles this one.** Counting voices in a chord is a question about
  *structure*, and the voice pool lives in the game's own `fmodextinput.prx`, which the emulator
  executes — so unlike question 23 this experiment does not need real hardware. See *Provenance
  rule 2* in [lbp-modding-toolchain.md](lbp-modding-toolchain.md).

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

## 15. `robot` sounds thin, and the numbers say why — but not whether it should

⚠️ **Provenance, 2026-09-05: the reference is shadPS4.** "Thin, short of low end and short of
resonance" is a judgement about spectrum, which is the kind of claim an emulator's output path can
manufacture — see *Provenance rule 2* in [lbp-modding-toolchain.md](lbp-modding-toolchain.md) and
what it did to question 23. Everything below is still worth having, because it is all measured off
the *file* rather than off the capture, and every numeric explanation of the thinness was ruled out
that way. But the report itself now needs a real capture before it is chased further.

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

## 23. ⚠️ PARKED — a flat ~1 dB deficit above 315 Hz, against an emulator

❗ **The reference was shadPS4, not a PS4, and the listener who made the capture does not consider it
reliable** (2026-09-05). That retires this as a finding until a capture from real hardware exists.

The reason it retires *this* one and not the others is in *Provenance rule 2* in
[lbp-modding-toolchain.md](lbp-modding-toolchain.md): a capture under an emulator is evidence about
**structure** — how many voices sound, whether a note is gated, the ratio between two channels —
because the DSP is the game's own code being executed. It is not evidence about **absolute level or
spectrum**, because between the plugin's output and the .wav sit the emulator's mixer, its 7.1→stereo
downmix, SDL's resampler and the host device. A per-band decibel table is the second kind, and a
**flat** deficit across five octaves with exact bass is exactly the shape an output path
manufactures.

⚠️ **Do not chase the candidates below until the reference is real hardware.** They are still the
right list if the deficit survives one; the numbers under them are not evidence today.

The numbers as they were taken, kept because they cost a session and will be the thing to compare a
real capture against:

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

## 28. What still will not open — now measured against the archive, not six saves

⚠️ **Re-based 2026-09-05.** This used to list four failures out of six PS3 saves. The public archive
made a wider corpus possible, so it was swept: **47 levels off the index, across LBP1, LBP2 and both
LBP3 platforms.** That is a far better test than the saves, which are one creator's and one console
generation's.

### What the sweep found

**28 of 43 real resources parse**, and the failures fall into two piles that want completely
different things.

**Pile one — out of scope by design, 9 files.** Revisions below the LBP3 range `serializer.ts`
accepts: `0x23d`, `0x26e` (×4), `0x272` (×5, branch `4c44/17` — **LEERDAMMER**), and one `0x3b7`,
which misses the lower bound of `0x3b8` by a single revision. Widening the range means adding the
older branches field by field, not relaxing the check.

⚠️ **Four of those said "chunk 0/26 failed to inflate"**, which sends you to look at zlib. It is not
zlib: it is our header layout being wrong for an LBP1 resource, so the chunk table is garbage. The
message now names the revision.

**Pile two — real bugs on files this reader claims to support. It is now empty.** There were four
and all four are fixed; the sweep stands at **32 of 43**, with every remaining failure a revision
below the LBP3 range.

| file | was | |
|---|---|---|
| `8b904be1` | marker at 120328 | ✔ `PStreamingHint.connected` was a double reference |
| `69318581`, `7c0f1a1d` | marker at 10633 / 158804 | ✔ the **part mask lost a bit above 2^53** |
| `5576f758` | `no reader for part WORLD` | ✔ **`WORLD` was installed on a copy of the map** |

### ✔ `PStreamingHint.connected` was a double reference

`s.references((self) => readThingRef(self, readers))` reads a reference id **and then calls a
builder that reads another one**, so every element cost two ids where cwlib's `thingarray` reads
one. The fix is `things(s, readers)`, the helper every other Thing array already uses.

❗ **The whole corpus missed it because `connected` is empty in every file of it** — the loop never
ran. It took one level from the archive with a single connected Thing: measured on `8b904be1`, the
count is 1 at byte 120322, its one id is read at 120323, and the extra read ate the next Thing's
`0xaa` at 120328.

That is the second bug of exactly this shape in one day — question 36 was the first. **A field that
is empty or zero everywhere in the corpus is untested, whatever it is declared as.**

### ✔ A part mask above 2^53 lost its low bits

`Serializer.u64` returns a **`number`**, and a double has 53 bits of mantissa. The highest part
index is **53** (`STREAMING_HINT`). So a Thing carrying `STREAMING_HINT` *and* any low part has a
mask that cannot be held exactly:

```
the file says   0x20000008040039   bits 0, 3, 4, 5, 18, 27, 53
u64() returns   0x20000008040038   bit 0 is gone
```

That Thing lost its `BODY`, the walk read five parts where six were written, and the level failed
**560 bytes later** at the next Thing's marker. Measured on `69318581`, Thing 14249 at byte 10563:
the mask varint is `b9 80 90 c0 80 80 80 10`, its neighbour 14248's is `b9 80 90 40` — the same
three bytes and then a continuation instead of a stop.

⚠️ **`BigInt(s.u64())` does not fix it**, and `thing.ts` was already doing exactly that: converting
after the fact widens a value that has already been rounded. The bits have to survive the
accumulation, which is what `u64Big` is for.

❗ **This one was not archive-only.** Any Thing in anyone's level with `STREAMING_HINT` and a low
part hit it, silently, and the symptom was a marker failure hundreds of bytes downstream. The golden
fixture is unchanged (62,158 placements byte for byte), so no file in the ten-level corpus happened
to carry that combination — which is the whole reason it lasted.

### ✔ `WORLD` was set on a map nothing looked at

`partReaders` binds every reader as `(s) => read(s, readers)`, closing over **the map it builds**.
`readLevel` then did `new Map(readers)` and set `WORLD` on the copy — so the copy had a world
reader and every part reader still consulted the original, which did not. A world Thing reached
through any part therefore threw `no reader for part WORLD`.

❗ **A level really can carry a second world Thing.** `5576f758` has one inside a `CREATURE` at byte
290542: uid −1, no parent, `createdBy`/`changedBy` −1, guid 0 — the same shape as the level's own
world at byte 2. So the fix is two things, not one:

- install `WORLD` on the map the readers captured, and
- **only the outermost world stops the parse.** `readWorld` threw `StopParse` unconditionally, which
  is right for the level's own world and would have returned the *creature's* inner Things as if
  they were the level's. It returns now, and `readLevel`'s wrapper throws the first time only.

### The anchor for what is left

The technique that found both, in order: `setTrace` from `thing.ts` for the part spans; then patch
`Serializer.prototype` from a probe so **every read is logged with its value** — widths align at any
offset, values do not; then read the raw bytes at the disagreement.

✔ **The step that cracked it was neither of those**: list every top-level Thing with its span, and
look for the one whose *size* breaks the pattern. Nineteen Things of 575-588 bytes and then one of
**64** says exactly where to look, and it needs no byte-level reading at all. `0xaa` then a plausible
uid varint also locates the true next Thing — 11187, not 10633 — which turns "how far off are we"
into a number.

Nothing in scope is left to point it at. What remains of this entry is one decision and two
unknowns, below.

### What is left: one decision and two unknowns

- **Revisions below `0x3b8`** — 11 of the 43, and a *decision* rather than a mystery: `0x23d`,
  `0x26e`, `0x272` (branch `4c44/17`, LEERDAMMER) and one `0x3b7` that misses the bound by a single
  revision. Widening means adding the older branches field by field.
- ~~**`YELLOWHEAD`**~~ — ✔ **implemented and verified, 2026-09-05.** `PYellowHead` plus the whole
  `Poppet` tree under it (`PoppetMode`, `RaycastResults`, `PoppetMaterialOverride`,
  `PoppetShapeOverride`), ported from cwlib. The two `SerializationException` ranges that made this
  look expensive — subVersion `[0xc, 0x66)` and `[0x88, 0xa3)` — **cannot fire in the range this
  reader accepts**, which starts at 0x207, so LBP3 is a clean path through it. The corpus goes from
  **211 plans parsing to 212**, and `test/plan.test.ts` verifies it properly rather than by not
  throwing: `readPlan` requires the Thing array to fill `thingData` exactly, so every field was read
  at the right width. ⚠️ Only the post-0x2ec `Poppet` layout is implemented; below that it is a
  different structure and `requireLbp3` rules those files out first.
- **A quest of a type other than 5** — still never seen, in the saves or in 43 archive levels.
  `readQuest` refuses rather than guessing; the other types carry a trailing block whose shape
  depends on the type.
- **Branch `0x4431`** — one level in the saves, `f331efa7`, version 0x3e2, a branch cwlib does not
  know either. ⚠️ **Nothing in the archive is on it**: 43 levels and 86 further resources are all
  branch `0/0` or `4c44` (LEERDAMMER). One file is still not enough to reverse a branch from, and
  the archive does not supply a second.

**None of this is in the way of music** — the 28 that parse yield 26 sequencers — but the archive is
now where these get found, and it will keep finding them.
