# The synthesiser — what `fmodextinput.prx` does with the data

Read before touching anything in `packages/lbp-tracker-lib/src` that makes sound. The sequencer's
audio is not a set of FMOD voices and the synthesis is not in the eboot: it is a **23 KB plugin**,
`gamedata_orbis/spu/fmodextinput.prx`, read here instruction by instruction. Module addresses are
**true ELF vaddrs** (`file = vaddr + 0x7e0`); eboot addresses carry a `v` prefix. ⚠️ Every PRX
address written in this project before 2026-09-02 was 0x40 too high — [eboot-re.md](eboot-re.md).
What the eboot puts *around* the plugin — the reverb, the compressor, the 7.1 output — is in
[lbp-audio-engine.md](lbp-audio-engine.md).

## Where the synthesiser is

The sequencer owns a custom FMOD DSP. `v0x3e65a0` builds the description **on the stack** (which is
why scanning the data for one found nothing), at `v0x3e664b`: name `"Sequencer"`, `channels = 4`,
`create = v0x3e6580`, `read` loaded from the global `v0x10cc3f8`, no parameters; `createDSP` at
`v0xa48b90`, the handle at `v0x132aac8`. That global carries an `R_X86_64_GLOB_DAT` relocation
naming dynamic symbol `wycAbBCjLI4#C#D` — the plugin's **only export**, at module vaddr `0x170`.
The `create` callback does nothing but cache the DSP's userdata at `[dspstate+8]`, and the userdata
is the game's **audio state block** (`v0x132bb10`, reached through the accessor `v0x3fbf20`).

The read callback (`0x170`) asserts 4 in and 4 out channels, zeroes the output, **asserts the
length is a multiple of 256** (`test r14b, r14b` then `int 0x41`) and calls the block function
`0xa90` with `mov esi, 0x100` in a loop. So **the engine works in fixed 256-frame blocks**, and
`0xa90`'s first act is `memcpy(0xb850, state, 0x1b50)` — it copies the game's whole 6,992-byte
sequencer state into the module's BSS and renders from it. The offsets it reads are the ones the
eboot writes (`v0x1c6250`, `v0x1c5640`), which is the cross-check that it is the same structure.

❌ **The inference that a library-provided read callback "cannot know about notes or instruments"
was wrong** — an argument from architecture, not a reading, and the module was on disk the whole
time. The eboot's 768,000-byte allocation (`v0x3e6c10`, stored at `[state+0x1b18]`) that the
inference took for the synthesis buffer is the **echo ring**, below.

**Re-measuring anything here**: the module's LOAD segments are `vaddr 0x0000, size 0x4ab0` (code +
rodata) and `vaddr 0x8000, filesz 0x210, memsz 0x53a0`, so `0x8210`–`0xd3a0` is BSS. Fields are
always reached through a register — the block copy's base is `r14` in `0xa90`, and every other
function receives the state or a record in an argument register (`rsi` in `0x3930`, `rdi` in
`0x3780`) — so a plain disassembly grep for rip-relative accesses finds only `lea`s of the base.
Follow branches from an entry point, then collect `[base + disp]`. ⚠️ **Read the PATCH copies**:
`tools/prxdis.py` and `tools/prxnid.py` open `D:\PS4Games\CUSA00063-patch\gamedata_orbis\spu\`,
whose three plugins differ from the base game's in size and rodata layout; every address in this
file is in those files ([eboot-re.md](eboot-re.md)).

## The state block — 6,992 bytes, three regions

Two independent loops walk the same array with the same stride (`0x0c69`: `r15 = 0x28 … add r15,
0xd0; cmp r15d, 0x1a28`; `0x0eb0`: the same from `0x28 + rbx`), and `0x1a00 / 0xd0 = 32` exactly:

| range | size | what |
|---|---|---|
| `+0x0000` … `+0x0027` | 40 | header; `+0x08`/`+0x10` two instrument-table bases, chosen by a byte flag at `+0x00` (double-buffered); `0x1060` zeroes them |
| `+0x0028` … `+0x1a27` | 6656 | **32 voice records of `0xd0` = 208 bytes** |
| `+0x1a28` … `+0x1b4f` | 296 | settings and playback runtime |

The settings, written by the eboot and read by the plugin:

| offset | type | what |
|---|---|---|
| `+0x1a28` | f32 | **Tempo**, copied verbatim; also passed to the renderer as its third float |
| `+0x1a2c` | f32 | Swing, `vminss` against 0.99 on the way in (`v0x1c5d0c`) |
| `+0x1a30` | f32 | `EchoTime × 0.5` (`v0xe60fe8`) |
| `+0x1a34`, `+0x1a38` | f32 | `EchoFeedback`, `EchoMix` |
| `+0x1a3c`, `+0x1a40` | f32 | echo ping-pong and damping — **never written by the game**, below |
| `+0x1a44` | i32 | disabled/paused — `0x3930` returns early unless 0 (`0x3944`) |
| `+0x1a48` | i32 | restart pending; set to 1 at the top of a block, cleared after the step runs |
| `+0x1a4c` | f32 | the previous playhead **in steps**; a step boundary is `floor(now) != floor(prev)` |
| `+0x1a58` | i32 | −1 sentinel |
| `+0x1a68 + 12·i` | f32 | **`Volume[i] × 0.75`** (`v0xe60fec`), `i = 0..7`, ending at `+0x1ac8` |
| `+0x1ad0`, `+0x1ad8` | ptr | the **clip arrays**, A and B — `0x470` bytes per clip |
| `+0x1af0` | i32 | how many clips |
| `+0x1af8`, `+0x1b00` | ptr | the clip **header** arrays, 16 bytes per entry |
| `+0x1b18` | ptr | the 768,000-byte echo ring |
| `+0x1b20`…`+0x1b2c` | f32 | the echo's damping states |

A/B is chosen by a module-global byte (`0x8210`), which is double buffering: the game can rebuild
the clips while the audio thread reads the other copy. `v0x1c5640` (playback start) fills the clip
pointers and the count and finishes by pushing the same settings `v0x1c6250` does.

### The clip — one placement, `0x470` bytes

Filled by the eboot's `v0x1607c0`, field for field in
[sequencer-data-model.md](sequencer-data-model.md): `+0x00` the record count, `+0x0c` `Scale`,
`+0x10` the root (`key < 12 ? key + 12 : key`), `+0x1c` the length in steps, `+0x20 + 4·cursor` the
records with bits 28..29 cleared, `+0x420`…`+0x42c` `Level`, `Pan`, `2·EchoSend − 1`, `ReverbSend`,
`+0x430` the instrument index. The 16-byte header beside it holds the clip's **start in units of
16 steps** at `+0x00` and its **mixer channel** at `+0x0c`, which `0x280` tests with `bt` against a
mask argument, so channels can be muted individually.

**The channel is a band of the board** (`v0x1608d0` writes it; `v0x1c7909`–`v0x1c793c` the divisor;
`v0x1c452a` the `<< 4` that indexes the array): `rows = floor(boardHeight/105 + 0.5)`,
`divisor = max(rows / NumChannels, 1)`, `channel = clamp(row / divisor, 0, NumChannels−1)`. The
plugin's `mod 8` at `0x3afc` is a bounds guard on that clamped value, not the mapping. ⚠️ No amount
of corpus work could have settled this: 308 of 338 sequencers set `NumChannels` to 1, where every
row lands on channel 0 under banding, wrapping and a direct index alike.

### The instrument record — `0x5f0` bytes, and where `Params` lives

`imul rdx, rax, 0x5f0` indexes instruments; `imul rbx, rax, 0x98` indexes slots from offset 0. The
eboot's builder — entry `v0x2a1144` (⚠️ `v0x2a1190` is mid-function and disassembles as garbage;
it has no direct callers, being reached through a vtable) — maps the `RInstrument` onto it:

```
memcpy(r14+0x4e8, rbx+0x110, 0xd8)     ; the 27 Params, 216 bytes
r14+0x4c0 .. r14+0x4e3  <- rbx+0xe8    ; Splitnotes, nine int32
r14+0x4e4               <- rbx+0x10c   ; Numstack
slots: rbx+0x48 + 0x10*i  ->  r14+0x84 + 0x98*i
```

| offset | what |
|---|---|
| `+0x000` | **eight slots of `0x98`** (152 bytes), ending at `+0x4c0` |
| `+0x4c0` | `Splitnotes[0]` — never read by the zone walk |
| `+0x4c4` … `+0x4e3` | `Splitnotes[1..8]`, the eight bounds |
| `+0x4e4` | `Numstack` — the `cmp` the stack loop does |
| `+0x4e8` | `Params`, 27 `(x, y)` float pairs, to `+0x5bf`; the next field starts at exactly `+0x5c0` |
| `+0x5c0` | `Arpeggio`, 32 bytes; `+0x5e0` `Arpeggiate`; `+0x5e4` the instrument id, used to dedupe the table |

`Params[11].x`, the amplitude attack, is read at `+0x540` (`0x1f8c`) and `0x4e8 + 11·8 = 0x540`.
**Eight slots** falls out of the arithmetic here and independently out of the serialised resource.

### The slot — 152 bytes, three mip levels

| offset | type | what |
|---|---|---|
| `+0x00`, `+0x28`, `+0x50` | 40 B each | **mip 0 (full rate), mip 1 (÷2), mip 2 (÷4)**; `+0x00` of each is its decoded length, data pointers at its `+0x08` and `+0x10` |
| `+0x78` | i32 | **the playable length in frames** — what the player stops at (`0x304d`) and what `Params[2]` scales (`0x1ad1`); `<= 0` switches the slot to a saw oscillator |
| `+0x7c` | i32 | **loop start** |
| `+0x80` | i32 | **loop length**; `<= 0` means no loop |
| `+0x84` | i32 | the root note — the first field the eboot's builder copies (`v0x2a1220`) |
| `+0x88` | f32 | the native tempo |
| `+0x8c` | f32 | fine tune, in **semitones** |
| `+0x90` | u8 | **pitched**: when 0 the ratio is forced to exactly 1.0 |
| `+0x91` | u8 | **tempo-synced** |
| `+0x94` | u8 | **stereo** (a ×4 stride over ×2) |

The records arrive **filled from the eboot** — nothing in the PRX initialises `+0x78`. The mip
builder `0x12e0` (a function with no frame pointer, found by aligning on `cmp dword ptr [rdi +
0x78], r8d`) only *clamps*: if the decoded length `[rdi]` is smaller than `+0x78` it lowers `+0x78`
to it and zeroes `+0x7c`/`+0x80`, because a loop cannot survive a buffer that turned out shorter.
A minimum, never a maximum, and `rdi` is one slot throughout. Then it builds the copies: each is a
**plain average of adjacent frames of the same channel** (`src[2i]` and `src[2i|2]` on an
interleaved stereo buffer), and ⚠️ **the arithmetic is int16 and rounds toward zero** — `(a + b)`
then a signed halve that keeps the low 16 bits — so every output lands back on the sample grid.
`decimateBy2` in `packages/lbp-tracker-lib/src/audio/mipmap.ts` does it the engine's way; `(a + b) *
0.5` in floats differs by under an LSB, which the brief still cares about.

**Looping** is a plain modulo (`0x3769`–`0x377a`): if `pos > loopStart + loopLength` then
`pos = (pos − loopStart) mod loopLength + loopStart`. The region is **`[loopStart, loopStart +
loopLength)`**, half-open, and the loader below fills both from `smpl` as written: `dwStart`, and
`min(dwEnd + 1, frames) − dwStart`. ❌ `loopRegion()` returned `[dwStart − 1, dwEnd + 1)` until
2026-09-08 on a smoothness measurement ([game-assets.md](game-assets.md)); the engine's region is
a frame shorter and its join is the literal one (*43* in
[answered-questions.md](answered-questions.md)).

### The loader — `v0xb3e520` in the eboot, and what it does to the loop

Found from the `RIFF`/`WAVE`/`smpl`/`fmt `/`data` immediates in the code (the string copies at
`v0xefbd1e`… belong to FMOD's own codecs, which the sequencer never uses); outside FMOD's range,
writes exactly the slot's fields, and ends by calling `v0x3fc2b0`, the eboot's copy of the mip
builder `0x12e0`. `rbx` is the slot, `rsi` a stream:

- Zeroes `+0x00`, `+0x10`, `+0x18`, `+0x78`, `+0x7c`, `+0x80`; checks `RIFF` and `WAVE`; walks
  the chunks.
- **`data`** (`v0xb3e697`): `+0x78 = size / 2` samples; allocates `(size/2 | 0xf) + 0x11`
  int16s — the data rounded up to 16 plus 16 of slack — reads the PCM verbatim, and zero-fills 16
  frames past it (`v0xb3e950`–`v0xb3e97e`); stereo halves `+0x78` into frames (`v0xb3e989`).
- **`smpl`** (`v0xb3e700`): per loop, `+0x7c = dwStart` (clamped to `frames − 1`), `+0x80 =
  min(dwEnd + 1, frames) − start`; then **copies frames `[start, start + 16)` over
  `[end, end + 16)`** (`v0xb3e77c`–`v0xb3e868`, both channels when stereo). That patch is why the
  sampler's unwrapped second tap (`0x3780` wraps only *past* `end`) lands on loop-start material:
  the audible join is `d[dwEnd] → d[dwStart]`. `patchLoop` / `engineSample` in
  `packages/lbp-tracker-lib/src/wav.ts`.
- **`fmt `** (`v0xb3e880`): reads four bytes — `wFormatTag`, `nChannels` — and keeps only
  `+0x94 = (nChannels == 2)`. ❗ **The sample rate is never read, and nothing resamples**: a
  frame is a frame at the plugin's 48 kHz whatever the file says. 42 of the 216 shipped `.smp`
  are 44.1 kHz — `ukulele`, `record_static` and five kits — and play 8.8% fast, +1.47 semitones,
  in the game. The tracker does the same since 2026-09-08; it corrected them before (*43*).

## The voice record — 208 bytes

| offset | type | what |
|---|---|---|
| `+0x00` | u8 | the **instrument** index (`0x3b1e`, from `[clip+0x430]`; the zone is at `+0xcc`); **`0xff` means the voice is free** |
| `+0x04` | f32 | `channelVolume × clip Level` — one factor of the pool score, rewritten per block |
| `+0x08` | f32 | pitch in **semitones** |
| `+0x0c` | f32 | volume at the start of the block, from the current control point's velocity |
| `+0x10` | i32 | **the gate**: 0 while the note is held, 1 once its chain has ended |
| `+0x14` | i32 | a marker, written as 10000 when the record is claimed; the caller skips `0x3930` while it is `> 0` |
| `+0x18` | f32 | the clip's pan, written per block from `[clip+0x424]` |
| `+0x1c`, `+0x24` | f32 | the **echo** send and the **reverb** send |
| `+0x20` | f32 | the drive (`Params[26]`), clamped to 0..1 |
| `+0x28` | f32 | the note's **modulation**, `bits 24..27 / 15` — the value that picks a point inside every `Params` range |
| `+0x2c`, `+0x30`, `+0x34` | f32 | **slide rates** per unit time for volume, pitch and the modulation |
| `+0x38` | i32 | which clip this voice reads |
| `+0x3c` | u16 | the **record cursor** within that clip |
| `+0x3e`, `+0x3f` | u8, u8 | the start and end sub-steps, in thirds (`v0x4558 = 0.333333`) |
| `+0x40 + 8i` | **f64** | **playback position in frames** for stack layer `i`, `i = 0..4` |
| `+0x68 + 4i` | f32 | per-layer detune, a ratio near 1 |
| `+0x7c + 4i` | f32 | per-layer pan spread, centred on 0 |
| `+0x90`, `+0x94` | f32 | envelope A and envelope B levels, cleared together at note start |
| `+0x98`, `+0x9c`, `+0xa0` | f32 | three LFO phases |
| `+0xa4` … `+0xc8` | 10 × f32 | the two Moog ladders, five states each |
| `+0xcc` | i32 | the zone, written once per note from the zone walk |

**Every byte from `+0x40` to `+0xcc` has an owner, and five layers tile the three arrays with no
slack** (`+0x40..+0x67`, `+0x68..+0x7b`, `+0x7c..+0x8f`), so **`Numstack` is at most 5** — `choir`
and `synth_strings`, the corpus's largest, are exactly 5.

### Note start — `0x19e0`, and the stack loop `0x1a70`

`0x19e0` **zeroes the whole record** (`call 0xe0` = memset at `0x1a0d`, `0xd0` bytes), then writes the zone,
the modulation, the clip index and the cursor, opens the gate, and tail-jumps into the stack loop.
⚠️ A stolen voice is therefore wiped — envelope, position, phases — and the new note starts from
silence: `Voice.renderChunk`'s hard stop is what the game does, and a fade would be an invention.
**Do not add one.**

**The zone walk** (`0x0555`–`0x0577`, verbatim again at `0x09f0`–`0x0a14`):

```
ecx = bextr(noteWord, 0x708)          ; bits 8..14, the RAW note, not the quantised one
eax = 0
loop:
  r8d = 0
  if (int)eax > 7:  goto done         ; a fixed eight bounds
  cmp  [rdx + rax*4 + 0x4c4], ecx     ; splitNotes[i + 1] vs note, signed
  eax += 1
  if   bound > note:  goto loop       ; STRICT: a note on a bound takes the zone above it
  eax -= 1
  r8d = eax
done:
```

The zone goes straight into the slot array with no remapping (`imul rax, rax, 0x98` at `0x1aca`).
`resolveSlot` in `packages/lbp-tracker-lib/src/instrument.ts` is checked against this loop over
every instrument the game ships and every note — 68 × 128 = 8,704 comparisons, no disagreement
(`test/instrument.test.ts`). ⚠️ The walk indexes from `+0x4c4` = `Splitnotes[1]`; transcribing it as
indexing from `[0]` makes the engine appear to contradict a million-note corpus (*19* in
[answered-questions.md](answered-questions.md)).

**The stack loop**, `Numstack` times:

```
for i in 0 .. Numstack-1:
    r01 = rand() * 2^-30                            ; 0x1ae1 call 0x140, then v0x4540; U(0,1) exactly -- RAND_MAX below
    voice.position[i]  = eval(Params[2]) * slot[zone].length * r01     ; +0x40 + 8i, a double
    r = eval(Params[0]);  voice.detune[i] = 1 + 0.05 * (r01' * 2r - r)  ; +0x68 + 4i; 0.05 and 1 at v0x4544/v0x4548
    r = eval(Params[1]);  voice.spread[i] = 0.5 * (r01'' * 2r - r)      ; +0x7c + 4i
voice.position[0] = 0                               ; 0x1bda -- LAYER 0's START IS CLEARED
voice.envelopeA = voice.envelopeB = 0               ; one qword clears +0x90 and +0x94
voice.lfoPhase[0..2] = rand() * 2*pi/2^30           ; 0x1bfa/0x1c18/0x1c36, v0x4550; three U(0, 2pi) phases, once per NOTE
```

where `eval(P) = P.x + mod · (P.y − P.x)`. So `Params[2]`, the random start, is **inert on any
instrument with `Numstack` 1** — 18 of the 27 that set it, including six drum kits at a flat
`1.000` — while `Params[0]` and `Params[1]` **do** apply to layer 0 (nothing clears `+0x68` or
`+0x7c`): `baiyon_city_guildford` (`Numstack` 1, detune `0.406..0.394`, spread `0.631..0.000`)
spreads its 616 notes in `Zero` over pan 0.317..0.685 and ±230 cents. ⚠️ The stack loop reads the
length of the note's **own zone**, not slot 0's (`0x1aa0` reloads `[r14 + 0xcc]` each iteration).
The three LFO phases carry no layer index: a stacked voice's layers share one base phase and differ
only by `Params[17|20|23] · 2π/Numstack · layer`.

**`RAND_MAX` is `2^30 − 1`**, measured out of the game's own `sce_module/libc.prx` rather than
assumed: `rand` at vaddr `0x17000` is a 37-byte 64-bit LCG (`state = state · 0x5851f42d4c957f2d + 1`,
`return (state >> 32) & 0x3fffffff`), so the multiplier `9.3132257e-10 = 2^-30` at `v0x4540` makes
`rand() · 2^-30` exactly `U(0, 1)` and `5.85167e-09 · 2^30 = 2π` (`v0x4550`) a uniform phase. ⚠️ The plausible
wrong answer was FreeBSD's `2^31 − 1`, which would make the pitch spread `U(−d, +3d)` and put half
of every kit's hits past the end of their own sample.

## The clock — steps, sub-chunks and the block grid

Inside a block, `0x0be3`–`0x0c2e` and `0x0bf2`–`0x0c1f`:

```
L         = 720000 / tempo                       ; frames per step at 48 kHz
L        += L * swing * 0.5 * table[floor(position) & 1]    ; table at v0x44f0 = [1, -1], 0x0be2
N         = min(trunc((1 - frac(4*position)) * L + 1), frames left in the block)   ; the 4 at v0x44bc, 0x0bf2
position += N / L                                 ; [state+0x1a4c], in STEPS
```

- **`720000 / tempo`** at the engine's default tempo of 125 is 5,760 frames, and
  `48000 · 60 / (125 · 4)` is 5,760 too: **four steps to the beat**, at a 48 kHz output rate,
  measured rather than assumed.
- **Swing**: an even step stretches to `L · (1 + swing/2)` and the odd step after it squeezes to
  `L · (1 − swing/2)`, so the pair still lasts `2L` and swing never drifts against the bar; at
  `swing = 1` the ratio is 3:1, and the field is clamped just below 1. `swing.ts` implements it and
  every note position, duration and automation point goes through `swungFrame`. Because
  `floor(position)` cannot change inside a step, the position advances linearly at that step's own
  swung rate, and a triplet at `k + s/3` sounds `L(k)·s/3` frames into step `k` — **a triplet inside
  a stretched step stretches with it**, which is exactly what `swungFrame` does.
- ⚠️ **The `frac(4·position)` bound is not a musical boundary** — it lines up with neither steps
  nor thirds; it guarantees a chunk advances **at most one step**, which the note window needs
  (`0x1c9b` handles a wrap by adding 1 and cannot handle two). Simulated over a second it gives
  chunk lengths of 1, 127, 129, 255 and 256.
- The position is in steps, proved from the scheduler side too: `0x0d13` shifts a clip's cell index
  left by 4 and compares `cell · 16` against it, so **a board cell is 16 steps**.

❗ **A note begins at the first frame of the block it falls in.** `0x1cc6`–`0x1cdc` computes the
in-chunk onset offset as `trunc((start − frac(position)) / N)` with `start = voice[+0x3e]/3 < 2`
and `N` the chunk's frames — a divide where a multiply belongs — which is 0 for every chunk longer
than one frame. The onset grid is therefore the 256-frame block, 5.33 ms at 48 kHz. **Not
reproduced, deliberately** — the decision and what would settle it are *3* in
[open-questions.md](open-questions.md).

### The gate and the ramps — `0x3930`, the per-block note update

The function start is `0x3930` (found by the largest `E8` target at or below its stores; it ends in
a clean epilogue at `0x3f23`) — ⚠️ steering called it `0x38e0` for a while, a stale label. Per
voice per block it walks the clip's chain:

```
0x3a0a  edx = word [rbx + 0x3c]     ; the record cursor
0x3a0e  r11 = rdi + rdx*4 + 0x20    ; the records
0x3a13  eax <<= 4                   ; gridX * 16, the clip's step offset
0x3a31  r12d -= eax                 ; the playhead, relative to the clip
0x3a3e  edx = [r11] & 0x7f          ; this record's step
0x3a41  cmp r12d, edx ; jle         ; playhead <= step: not reached
0x3a46  test ah, 0x80               ; bit 15, the end-of-chain flag
0x3a49  je  advance                 ; not the end: advance the cursor and go again
0x3a4b  [rbx+0x10] = 1              ; the end: close the gate
0x3aa5  bextr eax, ecx, 0x107 ; ecx >>= 30 ; cl &= 1 ; eax <<= cl   ; subStep = bit7 << bit30
0x3ab2  [rbx + 0x3f] = al           ; the END sub-step
0x3ab5  [rbx + 0x10] = 0            ; ... and the gate is re-opened for the last third
```

and `0x1c60` closes it for good once the playhead's fraction passes `[+0x3f]/3` (`0x2988`–`0x29b1`).
✔ **The gate therefore closes at `lastStep + 1 + endSubStep/3`**, which is exactly `startPosition +
(endPosition − startPosition + 1)`: `durationSteps` is right to the third of a step, and the
sub-step decoding is confirmed from the playback side as well as the editor's.

The same function reads the **current and the next** record and sets **three slide rates** from one
span (`0x3e1e`–`0x3e8a`, `v0x45ac = 1/3`): `[+0x2c] = (nextVolume − volume)/span`,
`[+0x30] = (nextPitch − pitch)/span`, `[+0x34] = (nextMod − mod)/span`, and zeroes all three when
there is no next record (`0x3f06`, `0x3f0e`). When the playhead is already partway between two
records it catches all three up by `rate × elapsed` (`0x3edd`–`0x3eff`). So a note glides
**linearly in semitones** between its control points — the engine ramps `voice.pitch` and only
afterwards feeds it to `exp2f`, so interpolating the playback rate instead sags in the middle of
every bend — holds flat otherwise, and **ramps the modulation exactly as it ramps volume and
pitch**. The slides are per unit of **steps**: the span is in thirds (`v0x45ac`) and the renderer's
`t` is the chunk's advance in steps (`N / L`, `0x0c28`), so under swing a glide bends at every step
boundary in frame time. `render.ts` cuts every ramp at the integer steps it crosses, which makes
its frame-linear segments the engine's step-linear ones (2026-09-08; 13 of 338 corpus sequencers
swing). ⚠️ `+0x28` was read as a pan for a day and its third ramp as a `panSlide`; it is the
modulation, and a renderer that holds it at the note's opening value is wrong on the 3.45% of
notes that move it — 30,170 of the 34,449 that do move some parameter by 0.35 or more, and 26 of
the 27 parameters move on some note.

It also rewrites both pool-score factors per block: `[+0x04]` from the channel volume times the
clip's `Level` (`0x3b12`), `[+0x0c]` from **the current control point's** velocity (`0x3c29`,
`bextr eax, [note], 0x810`). A released voice (`0x3963` → `0x3f06`) skips the update and keeps the
score it had.

## The per-voice renderer — `0x1c60`, once per record per block

Called from `0xa90`'s loop over the 32 records (`0x0c51`–`0x0c97`: `ebx = 0x28; … add rbx, 0xd0;
cmp rbx, 0x1a28`). Everything modulation-driven is evaluated **twice per chunk, at its start and
its end** — the two envelopes (`0x203f`/`0x2089`), the pitch ratio (`0x1dc2`/`0x1e63`, the second
with the slide added), the three LFOs (two `call 0x130` each), the filter's cutoff and resonance
(`0x2a02`, then `0x2a54` onward with `xmm15`, the end modulation) — and each layer's rate, gain
and pan become a `{value, step}` pair (`0x2876`, `0x25a5`, `0x274f`) that the per-sample loop
steps every frame (`0x2d5d`, `0x2d78`, `0x2d8f`). ❗ **Inside a chunk the game applies a linear
ramp between the two evaluations, not a value held flat.** Only the drive and the two sends are
chunk constants (`0x1ee0`; `0x2f3f`–`0x2f89`). ❌ This paragraph said "a staircase held for a
256-frame block" until 2026-09-08 — *44* in [answered-questions.md](answered-questions.md). `Voice`
in `packages/lbp-tracker-lib/src/audio/mixer.ts` does the same per *segment* — a block of the
mixer's own frame clock, cut short at the voice's own events — and re-derives at both ends from
the *interpolated modulation*: `evaluateParam` is affine in it, but the ADSR squares its times and
the ladder squares its cutoff, so interpolating *those* would not be the same arithmetic.

### The record's accumulator, its clip, and where the ladder sits

The per-sample loop (`0x2b70`–`0x2df9`) is a loop over the layers with the loop over the frames
inside it, and every layer accumulates into **one interleaved L/R buffer on the stack**
(`[rbp-0x9c0]`, 512 floats): `L[i] += (1 − pan)·gain·x` at `0x2d2e`, `R[i] += pan·gain·x` at
`0x2d47`, after the drive (`0x2cab`). After the last layer, `0x2e00`–`0x2e2d` **clamps that buffer
to ±1** (`vmaxps −1`, `vminps +1`, all 512 floats); then the ten ladder states are loaded from the
record (`0x2e2f`–`0x2e90`, `+0xa4`..`+0xc8`), the bypass is decided on the block-start cutoff
(`0x2e99`, `0.99 < freq`), and the two ladders run on that buffer's L and R (`0x31c6`/`0x31d3`) —
**one pair per record, after the gain, the pan and the sum of the layers, and after a hard clip
nothing outside the plugin sees**. The clip is also why the ladder never leaves its `[−1, 1]`
domain. The filtered or bypassed buffer then goes to the output lanes and the sends (`0x2f00`,
`0x32fc`). So the order is: sample → drive → gain → pan → sum of layers → clip → ladder → out.
`Voice.renderSegment` keeps it. ❌ Until 2026-09-08 the tracker filtered each layer on its own,
before the gain and the pan, with a ladder pair per layer — the same thing for a linear filter and
not for this one, on the 13 shipped instruments that are both stacked and filtered (*45*).

### The note word, decoded with `bextr`

| bits | what |
|---|---|
| 0..6 | step within the clip, compared against `currentStep − header.start × 16` |
| 7 | the sub-step's low bit, **shifted left by bit 30** → 0, 1 or 2 |
| 8..14 | the note — the file's `y`, which the eboot copies through with only bits 28..29 cleared |
| 15 | end of the note's chain |
| 16..23 | velocity → `voice.volume = v × 1/127` (`0x3c32`, `v0x45a0`) |
| 24..27 | the modulation → `× 1/15` |
| 28..29 | always 0 at runtime — the eboot's clip filler clears them |
| 30 | the sub-step shift |

The modulation is not a rounding-level thing: across 3,199,788 corpus records the nibble is 0 on
80.74% and **15 on 10.20%**, mostly a two-position switch. On `ghost.rinst` `Params[4]` runs 0.90 to
0.53, so a full-modulation note has *little* resonance where an unmodulated one has a lot.

### The pitch — the scale quantiser, the root, and `exp2f`

```
voice.pitch = quantise(note, clip.scale) + clip.root - 12         ; 0x3c4e and 0x3db5, `lea eax, [rax + rcx - 0xc]`
quantise(n, s):                                                    ; 0x240 -- ⚠️ NOT 0x250, which is mid-function
    if (unsigned)(s - 1) > 4:  return n                            ; out of range -> chromatic
    return (n / 12) * 12 + TABLE[s][n mod 12]                      ; signed division; the octave is preserved
```

`TABLE` is at module vaddr **`0x80c0`** — read off the **addend of the `R_X86_64_RELATIVE`
relocation** on the pointer slot at `0x8020` (reloc record at file `0x5888`), not computed from the
segment mapping, which put it 48 bytes early on a row of zeros and named every scale one place
late. Six rows of twelve `int32`; the seventh reads as garbage:

| scale | row | tones |
|---|---|---|
| 0 | `0 1 2 3 4 5 6 7 8 9 10 11` | chromatic — the identity, and never reached |
| 1 | `0 0 2 2 4 5 5 7 7 9 9 11` | **major** |
| 2 | `0 0 2 3 3 5 5 7 8 8 10 10` | **natural minor** |
| 3 | `0 0 0 3 3 5 5 7 7 7 10 10` | **minor pentatonic** |
| 4 | `0 0 3 3 5 5 6 6 7 7 10 10` | **blues** |
| 5 | `0 0 2 2 4 4 6 7 7 9 9 11` | **lydian** |

⚠️ **It is not a downward snap**: the blues row sends position 2 *up* to 3, and ties do not break
consistently (position 4 goes up to 5 while 11 goes down to 10). **Use the tables; do not replace
them with a rule.** `scale.ts`. The root comes from the eboot (`v0x160806`: `key < 12 ? key + 12 :
key`), so the transposition is `key mod 12` with C at 12 and 0 the untouched default; the scale
snaps **first**, then the key adds — quantising after the transposition would land on a different
note. ⚠️ **No key reaches the quantiser at all** — it takes exactly `edi` = note and `esi` = scale —
which is why `blockRoot` sat for a session as a named unknown whose answer was two instructions
away in the *other* binary.

Then the rate (`0x1d71`–`0x1db7`, the `1/12` at `v0x455c`, an imported `exp2f` at stub `0x150`):

```
if (!slot.pitched)  ratio = 1.0
else                ratio = exp2f((t·pitchSlide + voice.pitch + slot.fineTune − slot.rootNote) · (1/12))
if (slot.tempoSynced)  ratio *= Tempo / slot.nativeTempo
```

### The sampler is LINEAR, and it mipmaps by octave — `0x3780`

`0x3780` is the sample read (`mov ecx, [rdi + 0x78]` is its second instruction; ⚠️ `0x3740`, an
older label, is mid-function). It wraps the position through the loop (`0x379d`–`0x37b9`), then
selects the mip on the rate it was handed — the ramped, per-sample rate, so a glide across an
octave changes copy mid-note:

| ratio | compared at | mip | position scale |
|---|---|---|---|
| `>= 4.0` (`v0x4584`) | `0x37d4` | `slot + 0x50` | `× 0.25` (`v0x4588`, `0x3829`) |
| `>= 2.0` (`v0x458c`) | `0x37de` | `slot + 0x28` | `× 0.5` (`v0x4590`, `0x3850`) |
| otherwise | | `slot + 0x00` | `× 1` |

The fraction is carried into the mip (`(frac + (pos mod 4)) / 4` for the ÷4 level), so a note two
octaves above its slot's root reads a pre-decimated copy rather than skipping frames. The
interpolation (`0x389b`–`0x38ef`, the `1/32768` at `v0x4594`) is **two taps, plain linear**:
`a = d[i]/32768, b = d[i+1]/32768, out = a + (b − a)·frac`; the stereo path is bilinear — it lerps
L and R by a blend the caller passes, and the two frames by `frac`. **That blend is the note's
modulation**, ramped per sample (`[rbp-0xaa4]` → `[rbp-0x9d0]` at `0x2c48`, stepped at `0x2da6`):
a stereo `.smp` plays as **one** channel morphing from L to R with the modulation, and is then
panned like any mono sample. None of the 216 shipped samples is stereo; the tracker's stereo path
reads and pans each channel on its own, a convenience for its own buffers and not the engine's
behaviour. When a slot has no data (`length <= 0`) the reader synthesises `frac(pos × 0.01) × 2 −
1`, a **saw oscillator** fallback (`0x37fb`–`0x380b`, the `−1` at `v0x459c`); no shipped slot is
empty and the tracker skips an instrument whose sample is missing instead.

⚠️ **The position reaches the sampler as a float32.** The record keeps it as a double (`+0x40 +
8i`, stepped by `vaddsd` at `0x2d59`), but the call at `0x2c72` converts it with `vcvtsd2ss` and
`0x3780` truncates, floors and subtracts in single precision, so the interpolation fraction has a
float's precision at that position — a 256th of a frame between 32,768 and 65,535, a 32nd past
131,072 — a small, real roughness on long samples. `readMipped` passes the position through
`Math.fround` for the same one (2026-09-08). The velocity is read as eight bits × `1/127`
(`0x3c29`), so a record could ask for 2.0; none of 3,199,788 corpus records is above 127 and the
editor writes seven bits.

How much of the keyboard the mips cover, from every instrument's own splits and pitch formula:
55 of 68 instruments ever land on a mip over notes 0..87 (17.3% of note-slots), 68 of 68 over
0..127 (41.7%) — concentrated in the 21 single-slot instruments (`woodpecker` reaches rate 383); a
dense multisample like the piano keeps the rate near 1 across the middle.

⚠️ **`sinc8` is the wrong default for a faithful tracker, and `linear` is the target.** The SNR
table in `packages/lbp-tracker-lib/src/audio/interpolate.ts` still stands — linear is 19 dB at
4 kHz at rate 0.5, a 16% amplitude error — and the game simply lives with that roughness; the
mipmapping is what keeps it from being as bad as the table implies. `DEFAULT_INTERPOLATOR` is
`'linear'`; `sinc8` is kept for A/B.

### `Params` — every one a range, and all 27 named

Every use has the shape `value = Params[i].x + mod · (Params[i].y − Params[i].x)`, with `mod` the
voice's `+0x28`. A sweep from every function start collecting every operand that resolves into the
array finds **60 reads covering all 27 parameters**, always `.x` first and `.y` second, and the
`vsubss` after each is `y − x` for every one — ⚠️ the four filter parameters are loaded into
`xmm8`…`xmm14` in one batch at `0x2945`–`0x297d` and combined much later, so "the `vsubss`
immediately after the `.y` load" finds only 23 of 27. Where `.x == .y` — most instruments, most
params — the parameter is simply fixed.

| indices | section | detail |
|---|---|---|
| 0..2 | unison stack | detune spread, pan spread, random start (above) |
| 3..6 | Moog ladder | cutoff (squared), resonance, key tracking, envelope amount |
| 7..10 | envelope B | the filter ADSR |
| 11..14 | envelope A | the amplitude ADSR |
| 15..23 | three LFOs | (rate, depth, layer spread) each |
| 24..26 | output | level, send, drive |

Named in `packages/lbp-tracker-lib/src/params.ts`.

**The two ADSRs** — `0x16b0`, `(bool gate, float *level, float dt, a, d, s, r)`, called
twice per envelope per block (once with a near-zero `dt` and once with the block's, for a start and
an end value to ramp between — ⚠️ and the first call **advances the state too**, by
`frames / 48,000,000` units against the second's `frames / 192,000`, so the engine's envelopes run
a 250th faster than its clock and an attack of zero stands at full level from the first frame):

| envelope | level | A | D | S | R | passed at |
|---|---|---|---|---|---|---|
| A — amplitude | `voice + 0x90` | `Params[11]` | `Params[12]` | `Params[13]` | `Params[14]` | `0x1fa3`, `0x1fed` |
| B — filter | `voice + 0x94` | `Params[7]` | `Params[8]` | `Params[9]` | `Params[10]` | `0x2193`, `0x21cd` |

The gate is `voice[+0x10] == 0`. **The stages are linear in level and the stage time is the
parameter squared**: the release branch (`0x1750`–`0x1792`) computes `release²`, un-mirrors the
stored level (values above 1 encode the rising phase, hence `2 − x`), then `level −= dt / release²`
and clamps at 0, which ends the voice. `dt = frames · 5.20833e-06` = `frames / 192000`,
i.e. quarter-seconds at 48 kHz, so a stage time is **`param² × 4` seconds**
(`ENVELOPE_SECONDS_PER_UNIT = 4` in `envelope.ts`; ⚠️ the other `dt` constant, `1/48,000,000` at
`v0x4560` (`0x201f`), feeds the first call of each pair and is read as a sampling of the current
level).
`Envelope.advance` is verified identical, including the mirrored storage. The corpus says which is
which without the disassembly: `Params[13].x` (sustain) separates 18 struck from 15 sustained
instruments with Cohen's *d* = −3.54 — exactly `1.000` on `strings_ensemble`, `choir`, `brass`,
`clarinet`, `concertina`, `sine_wave`, `saw_wave`, exactly `0.000` on `glockenspiel`, `marimba`,
`kalimba`, `harp`, `strings_pizz`, `musicbox`, `vibraphone`, `tubular_bells`, `0.070` on the piano.
`Params[12]` (decay) is largest on `vibraphone` 0.894, `tubular_bells` 0.850, `marimba` 0.756.

**The filter** — a 4-pole Moog ladder, the Stilson/Smith "Moog VCF, variation 1" from musicdsp.org
reproduced constant for constant (`0x3070`–`0x30d0` the coefficients with `1.0`, `0.8`, `0.5`,
`5.6`, `−1.0`; `0x3181`–`0x3259` the ladder), **two of them interleaved, one per output channel,
on the record's summed and clipped L/R** (*The record's accumulator*, above) — the ten floats at
voice `+0xa4`…`+0xc8`:

```
q = 1 - freq ;  p = freq + 0.8·freq·q ;  f = 2p - 1 ;  q = res·(1 + 0.5·q·(1 - q + 5.6·q²))
in -= q·b4
b1 = (in + b0)·p - b1·f ;  b2 = (b1 + t1)·p - b2·f ;  b3 = (b2 + t2)·p - b3·f ;  b4 = (b3 + t1)·p - b4·f
b4 -= b4³/6                                          ; 0x32a1-0x32bd, and again at 0x3320-0x332c
b0 = in
```

driven, twice per block (`0x2a02`–`0x2a90`), by

```
keytrack  = 1 + (pitchRatio − 1) · Params[5]      ; pitchRatio: the voice's playback rate, [rbp-0xa90]
envFactor = 1 + Params[6] · (envelopeB − 1)       ; envelopeB: [rbp-0xb70]
freq = clamp(Params[3]² · keytrack · envFactor, 0, 1)
res  = clamp(Params[4] · envFactor, 0, 1)         ; the resonance takes the ENVELOPE, not the pitch (0x2a90)
```

⚠️ The key-tracking and envelope terms are the same shape, built from the same
`vsubps/vmulps/vaddps` triple, and nothing in the arithmetic distinguishes them; what settles it is
the identity of `X`, traced back to its writer (*6b* in [answered-questions.md](answered-questions.md)).
The clamps are the engine's too (`0x2ae9`–`0x2b32`). ❗ **And there is a bypass**: `0x2ee9` compares
the clamped cutoff against **0.99** and the fall-through is a loop touching none of the ladder's
constants, so a cutoff above the threshold is unfiltered. It is audible, because the ladder is not
transparent at `freq = 1` (a unit impulse comes out at 0.833 and rings for half a second):
`piano.rinst` sits on the bypass side at and above its base note. `FILTER_BYPASS_CUTOFF` in
`moog.ts`. Past the bypass, `0x30d8` compares the block's two ends: equal, and `0x310b` runs the
ladder with one set of coefficients; different, and `0x33d6` onward re-derives them **per sample**
from a linear ramp of `freq` and `res` (`(end − start) / N` at `0x33f3`). Corpus: cutoff wide open in 38/68; resonance zero in 60/68 (`ghost` 0.90, `saw_wave`
0.76, `space_piano` 0.65, `noise` 0.58); key tracking near-binary (1.0 in 41, 0.0 in 17); envelope
amount ≈0.98 on `square_wave`, `pulse_wave`, `e_guitar_distorted`, `robot`, `electric_piano`,
`noise`; the filter ADSR inert in 33/68 — and 27 of the 28 with amount 0 also have an inert
envelope B, the redundancy the two off-switches predict.

**The three LFOs** — the stride-3 tell at `0x21e5`–`0x22ea`, where `Params[15]`, `[18]`, `[21]` are
added to the three phases:

| LFO | phase | rate | scale | depth | layer spread | destination |
|---|---|---|---|---|---|---|
| 1 | `+0x98` | `Params[15]` | ×100 | `Params[16]` | `Params[17]` | **pitch**: `rate = pitchRatio · (detune[i] + 0.05 · depth · osc)` (`0x2770`–`0x27eb`) — vibrato and unison detune share the 0.05 |
| 2 | `+0x9c` | `Params[18]` | ×100 | `Params[19]` | `Params[20]` | **amplitude**: `gain = baseGain · (1 + depth · osc)` — tremolo |
| 3 | `+0xa0` | `Params[21]` | ×50 | `Params[22]` | `Params[23]` | **pan**: `v = \|osc·depth + clipPan + spread[i]\|`, folded to `[0, 1]` as a triangle (`0x25fc`–`0x2634`), straight into the pan law |

The layer spread is `Params[17|20|23] · 2π/Numstack` (`0x2306`–`0x2346`), fanning a stacked voice's
layers around the cycle. The corpus confirms which member is which: depths are zero in 62, 65 and
62 of 68, rates in 1, 0 and 0. The oscillator at stub `0x130` is libc's `_FSin` (NID `ZtjspkJQ+vw`,
sine/cosine with an integer selector in `edi`, zero for sine — 368 call sites in the eboot use the
same idiom), pinned by parsing the PRX's import table rather than inferred. ⚠️ **The oscillator runs twice per
layer per chunk, not per sample**: the six `call 0x130` in the per-layer loop (`0x24a0`–`0x28e3`,
*before* the per-sample loop at `0x2b70`–`0x2df9`) are **two per LFO** — at the phase (`0x24df`,
`0x25f9`, `0x27a0`) and at the phase plus the chunk's increment (`0x2557`, `0x26c6`, `0x282e`) —
and each pair becomes a `{value, step}` the sample loop ramps (`0x25a5`/`0x274f`/`0x2876` write
them; `0x2d78`, `0x2d8f`, `0x2d5d` step them). The three stored phases advance **once**, after the
loop (`0x28f1`, `0x2915`, `0x293b`), by `rate × scale × frames / 48000` (`0x2263`–`0x22cf`, the
`1/48000` at `0x20ce`) — a velocity in radians per second, not an increment per block. ❌ This file
read "the layer's rate is written as a double the sample loop reads as a constant" until
2026-09-08; the double at `[r14-8]` is the start value and the one at `[r14]` is the step (*44* in
[answered-questions.md](answered-questions.md)). `Voice.startSegment` in `mixer.ts` does the same;
evaluating the sine per sample cost 1.19 `Math.sin` calls per voice-frame and was 10% of a render.
Three layers of pan compose — the clip's own (`voice+0x18`), the unison spread, and LFO 3 — and
`lfo.ts` + `mixer.ts` do exactly that. **There is no branch on the depth**: every record's pan goes
through the fold, so a layer spread past 1 turns back rather than clamping, and the fold's input is
the pan as written — feeding it `2 × pan` put every centred voice on the right wall for a week
(*8*).

**The output stage**:

| param | role | corpus |
|---|---|---|
| `Params[24]` | **output level**, entering the gain chain with `sqrt(1/Numstack)` (the equal-power stacking correction) and a factor of 2 | never zero, 61 distinct values in 68 — the trim that balances the set; loudest `triangle_wave` 0.67, quietest `ray_gun` 0.07 |
| `Params[25]` | the **echo send** — `voice+0x1c = clamp01(bipolar(Params[25], 2·echoSend − 1))` | zero on 33 of 68, never above 0.23 |
| `Params[26]` | the **drive** — a soft clip on the sampler's output | zero on 64 of 68: `e_guitar_power` 0.73, `e_guitar_distorted` 0.57/0.70, `space_piano` 0.51, `electric_harpsichord` 0.39 |

The drive (`0x1ee0`–`0x1f1f`, then `0x2c88`–`0x2cf1`): `d = clamp(Params[26], −0.95, 0.95)`,
`k = 2d/(1 − d)`, and per layer on the sample read, before the gain and the pan,
`f(x) = (1 + k)·x / (1 + k·|x|)` — the standard soft clip. `k = 0` is an exact bypass, the rails
`f(±1) = ±1` are fixed points, and the reciprocals are `vrcpps` plus one Newton step, which
JavaScript cannot reproduce bit for bit, so `mixer.ts` divides. `e_guitar_power`'s `k = 5.442` is a
gain of 6.4× on small signals, and it carries the lowest output level in the game (0.088) — two
errors cancelling is why implementing the level without the drive made it quiet *and* clean rather
than obviously wrong. 50,383 corpus notes (2.73%) have a non-zero *evaluated* drive.

⚠️ **The echo send's placement field is a bipolar offset, not a blend**: `0x3ca1` applies it as
`v + o·v` when `o < 0` and `v + o·(1 − v)` when `o >= 0`, so 0.5 leaves the instrument's own send
untouched, 0 mutes it and 1 forces unity. Most placements are exactly 0, so the modulation's effect
on the send is inert in practice — 68 notes in 5 sequencers of the whole corpus. **Do not cite
`Params` swings as audible weight without the placement.** The reverb send, `voice+0x24`, is the
placement's `reverbSend` alone (`[clip+0x42c]`), untouched by the modulation.

### The pan law is LINEAR, not equal-power

`0x2d39`–`0x2dda`: `L += (1 − p)·gain·sample`, `R += p·gain·sample`. Amplitudes sum to 1 rather than
powers, so a sound crossing the centre dips about 3 dB relative to an equal-power law — the
worse-sounding law, and the game's. `panGains` in `voice.ts` had been equal-power for most of the
project's life; five tests depended on the old `sqrt(1/2)` centre factor. FMOD's own narrowing of
the image sits *above* this, in [lbp-audio-engine.md](lbp-audio-engine.md).

### The output lanes and the sends — `0x2f00`–`0x2f8f`

```
out4[4i+0] += L                 out4[4i+2] += L * voice[0x24]      ; the reverb send bus
out4[4i+1] += R                 out4[4i+3] += R * voice[0x24]
                                out2[2i+0] += L * voice[0x1c]      ; the echo's own input
                                out2[2i+1] += R * voice[0x1c]
```

`out4` is the DSP's 4-channel output buffer; `out2` is a stack `alloca` inside the block function,
so the echo is internal and the reverb send leaves the plugin on channels 2-3. **Both sends are
post-fader and post-pan.**

## The voice pool — 32, steal the quietest

**32 is an immediate** (`cmp rbx, 0x1a28` against records of `0xd0` from `0x28`), the PRX out of
`CUSA00063` is the PS4 build, and the eboot links it directly (it appears only in the import
tables, never as a runtime-registered plugin), so nothing can raise it. One state block is one
whole sequencer — it holds the clip count, the clip arrays, the eight channel volumes and the 32
records — so **`C4K3 S0NG`'s 244 clips share one pool of 32**, and the game walks every
`MusicSequencer` Thing when one starts (`v0x1c5773`), so even two sounding sequencers could not
give one more.

The allocator, `0x1600`–`0x1692`:

```
xmm0 = 1.0 ; edx = 0                    ; best score so far, best index -- ⚠️ 1.0 and 0, not infinity
loop over 32 records:
  if byte [rec] == 0xff: return rec      ; a free record wins immediately
  score = [rec + 0x04] * [rec + 0x0c]    ; channelVolume × clip Level × the current point's velocity/127
  keep the lowest
return the quietest
```

No channel comparison, no instrument comparison, no reservation: anything can steal anything.
⚠️ A pool where every voice scores 1.0 or more loses voice 0 rather than the quietest;
`polyphony.ts` reproduces that and a test pins it. The `[+0x14]` fast path at `0x1610` (take a
record whose `+0x14 > 0` before asking whether it is free) is **dead**: both callers (`0x4ef`,
`0x96b`) pass `dil = 0`.

**A record is freed when the sound ends, not when the note does** (measured six ways, *29* in
[answered-questions.md](answered-questions.md)): when the envelope's level reaches zero at both
ends of the block (`0x20de`–`0x20f1` → `0x3093`, `[rec] = 0xff`), or when an **unlooped** sample's
position passes its frame count (`0x3035`–`0x3069`), or when the chunk-end **volume ramp** is not
positive (`0x209a`/`0x20de`: the velocity ramp at `t_end`, not the envelope — so a note that opens
at 0 and *holds* it is freed after one block and never sounds, 3,132 corpus notes, while a fade-in
from 0 lives because its chunk-end ramp is positive; and a note that fades to 0 before its end is
freed there), or when `channelVolume × Level` is not positive (`0x20ea`). `Voice.silentAfter` and
`silentAt` in `render.ts` are the last two (2026-09-08). A one-shot
therefore plays to the end of its sample whatever its note says; a gated note rings through its
release still holding its record. **One record plays every layer of its note** — the per-layer loop
is inside `0x1c60`, once per record — so a stacked note is one record, not `Numstack`
(`C4K3 S0NG`: 3,634 notes cut short counting per layer, 1,526 per note).

**The skip at `0x04d4`** — a record is not allocated when `channelVolume × [clip+0x420]` is not
positive — tests the clip's `Level`, **not the note's velocity**: 0 of 74,864 corpus clips set
`Level` to zero and 0 notes sit on a muted channel, so it never fires on real data, and the 701
`C4K3 S0NG` notes that open at velocity 0 and rise (`Northern Lights`-style fade-ins) get a record
exactly as they do here. ⚠️ Reading it as "the note's opening volume" would delete them.

What ships: `allocateVoices` in `polyphony.ts` with the engine's score and pool, `VOICES_UNLIMITED`
to switch the cap off, and `RenderOptions.releaseTail` **defaulting off** — the one place the pool
knowingly departs from the engine, a decision recorded in [open-questions.md](open-questions.md).

## The echo — a stereo delay in beats, with a hard clip

Not an FMOD DSP. `0xa90` sets it up at `0x0f6a` and calls the kernel at `0x0680`/`0x07c0`, and its
ring is the 768,000-byte allocation at `[state+0x1b18]`: **192,000 floats**, interleaved stereo,
96,000 frames, 2.0 s at 48 kHz.

```
0x0f6a  steps  = (int)floor(stored * 16 + 0.5)      ; stored = [state+0x1a30] = EchoTime * 0.5
0x0f8e  fps    = (int)(720000 / tempo)              ; frames in one step
0x0fa4  len    = (steps * fps) & ~0xf
0x0faa  len    = clamp(len, 16, 192000)
0x0fcb  cursor = (cursor + 2*n) % len                ; n frames per block -> 2n floats
```

`0x0680` reads `min(2n, len − cursor)` **floats** from the ring at `cursor`, processes them as
`[L, R, L, R, …]`, and writes back **at the same cursor** (`0x08d3`). One cursor for read and write
means the delay is one full trip round the ring, so **delay in frames = `len / 2` = `round(EchoTime
× 8) / 2` steps = `EchoTime` beats exactly**. The decisive number is the clamp: 192,000 is the
ring's float count, not its frame count. ⚠️ Three readings preceded this — `EchoTime × 0.5`
*seconds*, then beats for the wrong reason, then eight steps per unit read off `stored * 16` — and
the lesson is narrow: `stored * 16` is a *length*, and a length means nothing until you know what
it counts.

The kernel, `0x07c0`, per frame:

```
dL, dR = ring[2i], ring[2i+1]
s3 += (dL - s3) * k ;  s2 += (dR - s2) * k          ; k = 1 - [state+0x1a40]  -- pass-through, below
s1 += (s3 - s1) * k ;  s0 += (s2 - s0) * k
wL, wR = EchoMix * s1, EchoMix * s0
out4[4i+0..3] = clamp(out4[4i+0..3] + {wL, wR, wL, wR}, -1, +1)
ring[2i], ring[2i+1] = fb*s1 + send[2i], fb*s0 + send[2i+1]    ; fb = clamp(EchoFeedback, 0, 0.95)
```

- **The wet is added to all four output channels**, and channels 2-3 are the reverb send: **the
  echo feeds the reverb.**
- **The output is hard-clipped to ±1**, all four lanes, once per frame (`0x0889`–`0x0891`). This is
  the only nonlinearity in the plugin's output, it sits *inside* the plugin two DSPs before the end
  of the chain, and the reverb is fed a clipped signal. `clipToUnit` in `effects.ts`; ⚠️ its frame
  counter has to watch all four lanes, and a fold gain applied upstream of it once engaged it on
  material the game passes untouched (*39*).
- ⚠️ **Two features in the code the game never reaches**: the cascaded one-pole damping
  (`[state+0x1a40]`) and ping-pong (`[state+0x1a3c] > 0.5` swaps L and R on the write-back). `0x11fd`
  and `0x1207` initialise both to zero and nothing writes them — a byte scan of the whole eboot
  finds no store to `+0x1a3c`, and both state-upload paths (`v0x1c5cf8`, `v0x1c62b7`) skip them.
  With `[+0x1a40] = 0` the coefficient is 1 and the one-poles are pass-through. Do not "find" a
  filter in that loop later and wire it up.

| field | state | law |
|---|---|---|
| `EchoTime` | `+0x1a30`, stored as `× 0.5` | the delay, in **beats** |
| `EchoFeedback` | `+0x1a34` | clamped to `[0, 0.95]` at `0x0793`–`0x079b` |
| `EchoMix` | `+0x1a38` | a plain wet gain; the dry is not attenuated |

## The imports, pinned

Parsed from the fSELF rather than guessed: its ELF header is at file `0x120`; `PT_SCE_DYNLIBDATA` is
type `0x61000000` (⚠️ not `0x6fffff00`, which is `PT_SCE_COMMENT`); the dynlibdata blob is at file
`0x54a0` with `PT_DYNAMIC` inside it at `0x5938`; every `DT_SCE_*` value is an offset into that blob
(`STRTAB 0x18`, `SYMTAB 0x160` with 14 symbols, `JMPREL 0x2b0` with 9 entries, `RELA 0x388`). A PLT
stub's `push N` is its `JMPREL` index, whose `r_info >> 32` is the symbol index.

| stub | symbol | what |
|---|---|---|
| `0xe0` | `8zTFvBIAIN8` | `memset` |
| `0x120` | `Ou3iL1abvng` | `__stack_chk_fail` |
| `0x130` | `ZtjspkJQ+vw` | `_FSin` — sine/cosine |
| `0x140` | `cpCOXWMgha0` | `rand` |
| `0x150` | `wuAQt-j+p4o` | `exp2f` |

`libkernel` is library 1, `libc` library 2, and the `#B#C` group is libc — the game's own
`sce_module/libc.prx`. `tools/prxnid.py` does this for any of the PRXs.
