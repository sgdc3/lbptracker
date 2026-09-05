# Reverse-engineering LBP3's eboot

Read before opening the binary. The address conventions here have already cost one session several
hours; the rest is a map of what has been found so far.


## ⚠️ `v0x2a1190` is mid-function — the DSP-record builder starts at `v0x2a1144`

Recorded 2026-09-02, because it cost time twice. Steering named the builder that fills the DSP's
instrument record as `v0x2a1190`; that is the `lea rdi, [r14 + 0x4e8]` **inside** it, and
disassembling from there opens with `add byte ptr [rax], al`, which is what a desynchronised stream
looks like rather than an error.

The entry is `v0x2a1144` (`push r14 ; mov r14, rsi`). It has **no direct callers** — it is reached
through a vtable, so the usual "scan for `E8` landing here" finds nothing and the constructor above
it, `v0x2a0e80`, is what the call graph shows instead.

The general rule: in this eboot, **find the function start before disassembling**, by taking the
largest `E8` target at or below the address of interest. When that returns something implausibly far
away, suspect an indirect call rather than a long function.


## The files

| file | size | `file = vaddr + …` |
|---|---|---|
| `C:\Users\sgdc3\Desktop\shadPS4\lbp3-ebins\eboot-v128.bin` | 18,497,333 | **`0x4000`** |
| `D:\PS4Games\CUSA00063-patch\eboot.bin` (installed fSELF) | 18,506,517 | **`0x8AD0`** |
| `C:\Users\sgdc3\Desktop\shadPS4\lbp3-ebins\eboot-v100.bin` | 17,218,664 | derive it, don't assume |

⚠️⚠️ **The delta depends on which file you opened.** `eboot-v128.bin` is the already-peeled ELF —
its own program headers say so (`ebseg.py`: LOAD `off=0x4000, vaddr=0`). The installed `eboot.bin`
is the fSELF, whose extra container header shifts everything by `0x8AD0`. **All addresses in this
workspace are vaddrs**; convert at the point of use.

How to check you got it right, in one line: apply the delta to the 4222 script-binding targets and
count how many land on a `55 48 89 e5` prologue. The correct delta gives **3559/4222**; a wrong one
gives ~640/4222. `tools/lbpdis.py` already carries the right delta for `eboot-v128.bin`.

### The audio PRXs have the same trap, and this project fell into it

| file | `file = vaddr + …` |
|---|---|
| `gamedata_orbis/spu/fmodextinput.prx` | **`0x7e0`** |
| `gamedata_orbis/spu/fmodsmsreverb.prx` | **`0x7c0`** |

Same rule as the eboot: these are SELFs, the inner ELF's program headers are not file offsets, and
the real offset of ELF segment `i` is the SELF entry at `0x20 + n*0x20` whose `props >> 20` is `i`.

⚠️⚠️ **Every PRX address written in this project before 2026-09-02 is 0x40 too high.** `prxdis.py`
used **0x7a0** and **0x780** — the offsets of the 32-byte *digest* blocks that precede those
segments, not of the segments. The failure mode here is the opposite of the eboot's: it is
completely invisible. Disassembly from `start` reads `data[start + delta]`, so a uniform delta error
just relabels correct code, and a rip-relative target computed as `vaddr + size + disp` is read back
at `target + delta` — the same error twice, cancelling. **No fact recorded from those disassemblies
is wrong; every address is.** Subtract 0x40 before looking one up, and re-run it through
`tools/prxdis.py`, which now carries the measured deltas and can print the segment table.

⚠️ **The failure mode is silent and convincing.** With the wrong delta the identifier blob is dense
enough that you still read plausible-looking strings — just truncated by a byte or two
(`sSlotShareable__Q6SlotID` instead of `IsSlotShareable__Q6SlotID`) — and the disassembler starts
mid-instruction without complaining. If names look *almost* right, suspect the delta before
suspecting the data.

## The script-binding table

`C:\Users\sgdc3\Desktop\shadPS4\lbp3-re\bindings-1.28.txt` — 4222 `name -> vaddr` pairs.

Names with a `__` suffix are the game's script-VM bindings. They have **no rip-relative reference
anywhere in the binary**, which is why xref hunts for them always come back empty: the tables that
hold them are built from `R_X86_64_RELATIVE` relocations, so the pointers exist only as relocation
addends. `lbp3-re\ebrela.py` recovers them by finding the RELA array by shape.

⚠️ Use the **`vaddr` column only**. The `file` column in that file is computed with the `0x8AD0`
delta and is therefore wrong for `eboot-v128.bin`.

## Tools (in `tools/`)

| tool | what it does |
|---|---|
| `lbpdis.py <vaddr> [n]` | capstone disassembly by vaddr, resolving rip-relative targets to strings, tagging binding names and marking call targets that land inside FMOD |
| `callgraph.py <vaddr> [depth]` | BFS the direct-call graph from a seed and report the shortest paths that reach FMOD code |
| `fmodapi.py` | enumerate every game→FMOD call edge and attribute each callee to the FMOD `.cpp` it lives in |
| `ebvtable.py <name> [n]` | **name a C++ class's vtable through RTTI** and dump its slots; `slot <off> <name>` compares one slot across classes, `who <vaddr>` says which vtable slot holds a function |

They share one measurement trick worth understanding: **FMOD's code range is derived, not
assumed.** FMOD's memory tracker passes `__FILE__` at every allocation site, so every rip-relative
reference to a `Z:\LBP\sdk\fmod\...cpp` string sits inside FMOD code. Collect those and you get
FMOD's extent (`v0x9c5da3`–`v0xab6397`) and, per callee, which source file it belongs to. The same
trick works for the CWLib paths on the game side.

Other tools live in `C:\Users\sgdc3\Desktop\shadPS4\lbp3-re\`: `ebrela.py` (binding table),
`ebseg.py` (program headers — run this first on any new binary), `ebxref.py` (rip-relative xrefs in
file-offset space), `ebschema.py` (recover a serialised struct's field names and offsets),
`ebstr.py` (string scan; ⚠️ its `v=` column uses a stale delta, ignore it).

## Techniques that worked here

- **Serialiser walking.** Every LBP resource and part has a serialiser that emits, per field, a
  `lea` to the member offset and a `lea` to the field-name string. Disassemble it linearly and you
  get the whole schema with names. This is how `PSequencer`, `PInstrument`, `RInstrument` and the
  sample-slot struct were recovered. ⚠️ `ebschema.py` assumes the member `lea` comes **first** and
  the name second — pairing them the other way shifts every field by one and still looks plausible.
- **Array element sizes from the growth helper.** Array fields pass an element callback whose
  allocation multiplier is the element size (`lea edx, [r13*4]` → 4 bytes). That is how `Notes` was
  measured, cross-checked against `Name` giving 1.
- **Field-name neighbourhoods.** Serialiser name strings are packed contiguously, so dumping the
  strings around one known field name usually reveals the whole struct at once.
- **Import-library names from the dynamic section.** `DT_SCE_IMPORT_LIB` entries encode
  `(id << 48) | (version << 32) | name_offset`; the id maps to the symbol suffix through the same
  base64 alphabet as NIDs. That is how the `FMOD*` libraries and the 5 `libSceAudioOut` imports
  were found.
- ❗ **RTTI names vtables, and this binary has it.** 122 Itanium-mangled `N4FMOD...E` strings and
  **322 nameable vtables**. Three hops, each a lookup in the relocation map:
  `name -> type_info + 8 -> type_info -> vtable - 8 -> vtable`. `ebvtable.py` does it in a third of
  a second, and it is what closed question 22 after a session of structural vtable enumeration had
  produced five wrong candidates and one very convincing near miss.

  ⚠️ **Every vtable slot is ZERO on disk.** This is a PIE and the pointer lives in an
  `R_X86_64_RELATIVE` addend, so searching the image for a pointer to a type_info returns nothing —
  which reads as "no RTTI" rather than "look in the relocations". The relocations are plain 24-byte
  `(r_offset, r_info, r_addend)` triples with `r_info == 8`, recoverable by a stride-8 sweep with no
  section headers.

  ⚠️ **A pointer to `X`'s type_info comes from `X`'s vtable *and* from every derived class's
  `__si_class_type_info`** (at `type_info + 16`). Half the candidates a naive walk finds are
  type_infos, and dumping one prints strings and small integers where functions should be. Require
  slot 0 to be a code address.
- **Naming the slot, once the class is named.** Nothing carries method names. Identify a slot from
  the call site's *shape*: `v0xa0b539` calls `[vtable + 0x98]` with two floats and no integer, which
  is `setPan(pan, spread)` on a `ChannelSoftware` and could not be the four-argument
  `DSP::setDefaults` that a structural search had offered.

## Anchors already mapped

| what | vaddr |
|---|---|
| sequencer module | `v0x1c3000` … `v0x1c7000` |
| `PSequencer::BeginPlayback` | `v0x1c4f00` |
| "stop all other music sequencers" walk | `v0x1c5670` |
| sample-preload job (`StartSamplePreload` at `v0x1c3ce8`) | worker `v0x1c37f0` |
| CWLib audio layer | `v0x3dd000` … `v0x3fe000` |
| audio init / `.fev` load / `EventSystem::getGroup` calls | `v0x3e7960` |
| DSP creation | `v0x3e6700` … `v0x3e72c0` |
| `DSP::setParameter` block (10 calls) | `v0x3fd4c0` … `v0x3fd5d0` |
| generic play-sound(id, flags, volume) | `v0x3de390` |
| VoIP audio-out port open | `v0x3f5650` |
| FMOD code | `v0x9c5da3` … `v0xab6397` |
| Sony reverb plugin (`aSfxDsp`) entry — **not** the sequencer's reverb | `v0xab51b0` |
| reverb preset table (12 x 11 `int32`) / `ReverbSetting` remap | `v0x1062620` / `v0x1062830` |
| `applyReverbPreset(dsp, setting)` | `v0x3fd4c0` |
| reverb DSP configure — slots to parameter block | `v0x3fcd50` |
| `PInstrument` serialiser | `v0xd36c60` |
| `PSequencer` serialiser | `v0xd37d10` |
| `RInstrument` serialiser | `v0xc68a70` |
| sample-slot serialiser | `v0xcc0e90` |

## A live-tracing option, if static analysis stalls

The shadPS4 workspace has (uncommitted) a guest breakpoint tracer, `src/core/guest_trace.{h,cpp}`,
driven by `SHADPS4_TRACE=<addr,addr>` and `SHADPS4_TRACE_OUT=<path>`. Every hit logs the address,
the return address read from `[rsp]` (which names the caller even for indirect calls) and the
argument registers. Every script→native call also funnels through **one** indirect call at file
`0x3d9e72`, callee in `rbx` — breakpoint that and cross the `rbx` values against the binding table
and you get a complete script call trace.

⚠️ Three traps documented there, all of which look like "the code is never called": the trap
arrives with RIP **on** the address rather than after it; never call `LOG_*` from inside the
handler (deadlock); and the handler must be registered with `AddVectoredExceptionHandler(1, …)`.
Always arm the eboot entry point as a positive control before believing a zero.
