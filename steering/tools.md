# Tools — reference implementations, RE helpers and harnesses

Read before reaching for anything in `tools/` or `packages/*/dev/`. Every script carries its own
command lines in its docstring; this file says what each is *for*, the trap it exists because of,
and the environment variables that steer it. Nothing here is a fact about the game — those live in
the descriptive files — but several of the traps below are why a fact took a session longer than
it should have.

`tools/` holds **fourteen Python scripts and four Java ones**, deliberately dependency-light. Three
of the Python ones are the ground truth the TypeScript reproduces (`fsb.py`, `lbpres.py`,
`wavehammer.py`); the rest are instruments for reading the binaries.

- Python: `C:\Users\sgdc3\AppData\Local\Programs\Python\Python314\python.exe` (capstone 5.0.7
  installed).
- Java: ⚠️ `javac` here is JDK 25 and the first `java` on PATH is 1.8. Run the Java tools with the
  JDK's own binary — `"C:\Program Files\Eclipse Adoptium\jdk-25.0.3.9-hotspot\bin\java"` — or
  they fail with `UnsupportedClassVersionError`. Each `.java` header has its build and run lines;
  they link against the toolkit jar
  (`C:\Users\sgdc3\Desktop\LBP\toolkit\tools\sequencerdump\target\sequencerdump-0.1.jar`, `$JAR`
  below) and compile into `out/`.

## Reference implementations

| tool | what it is | checked how |
|---|---|---|
| `fsb.py` | FSB4 bank reader, IMA ADPCM decoder, WAV writer | decodes the game's `piano_C3` to a clean tone at the expected pitch (game-assets.md); `packages/lbp-tracker-lib/src/fsb.ts` + `ima.ts` are byte-identical to it |
| `lbpres.py` | the `LVLb`/`PLNb` container: revision, branch, zlib chunk table | 18 real levels, every chunk inflating to its declared size and the last one ending exactly on `depsOffset` (level-files.md) |
| `wavehammer.py` | the WaveHammer's gain curve — a literal transcription of the PRX plus the two-line closed form its knee reduces to | `wavehammer.py check` agrees the two over five configurations × 3999 entries to 2.1e-14 dB; `runhammer.py sweep` agrees it with the module *running* to 1e-4 dB |
| `panmeasure.py` | the stereo width of a recording: the least-squares leak of one channel into the other, with the residual that says whether one number describes it at all | how the pan width was settled (*22* in answered-questions.md). Use it on any new capture of the game |

**`runhammer.py` loads the actual `fmodsmswavehammer.prx` into this process and runs it** — both
segments at their own vaddrs in one RWX allocation so rip-relative references need no fixing, the
five non-PLT relocations and ten GOT slots written by hand, `powf`/`_FLog` shimmed to the CRT, and a
System V ← Windows thunk saving the registers the two ABIs disagree about (`rsi`, `rdi`,
`xmm6`–`xmm15`). `runhammer.py state` dumps the state block the module computes for itself.

❗ **Reach for it when a field looks uninitialised.** Three readings of that DSP were written down
wrong and two committed; the last died the moment the module printed `[state+0xc0] = 64`. A superset
disassembly had proved there was no store to `[reg+0xc0]` — correctly — and the field was written
all along as `[rbx+0x3c]` through an interior pointer. **An absolute-offset search is only sound if
every access uses the same base.** The harness is reusable on `fmodsmsreverb.prx` and
`fmodextinput.prx`, which are the same shape. See *37* in answered-questions.md.

## Getting the game's data out

| tool | what it does |
|---|---|
| `GuidLookup.java` | resolve a GUID (or a path substring) against the game's FileDB, `output/orbisguids.map` — GUID → path + SHA-1. This is how you find where any resource actually lives |
| `ExtractGuid.java` | GUID → FileDB → SHA-1 → FARC → bytes, plus a `manifest.json` the browser uses to resolve GUIDs without the 11 MB FileDB |
| `IconDump.java` | every `*instrument_*.plan`'s `InventoryItemDetails.icon`, decoded through `RTexture` into a 128 px PNG named after the `.rinst` it places |
| `trace-icons.py` | those PNGs into the SVG paths of `src/editor/icons.ts`: drop the frame, close the stripes down the y axis, marching squares, Douglas-Peucker. ⚠️ Both traps are in its header, and the second one bites anyone simplifying a closed loop. `EPS` is the one knob |
| `ReverbOrder.java` | a compiled `.ff` script through the LAMS table: every `LoadConstInstructionInt` operand in a function, translated. ⚠️ **The int is inline in the instruction word**, which is why searching a script's bytes for a LAMS id finds nothing. This is how the reverb list's order was read |
| `InstrumentNames.java` | every `*instrument_*.plan` → its inventory `titleKey` → the LAMS table → **the name the game shows for each sound**, joined to the `.rinst` GUID through the plan's dependencies. Feeds `src/editor/instrument-labels.ts` |

The sequencer's real samples and its `.rinst` instrument definitions come out of the game with:

```
java -cp "$JAR;out" ExtractGuid <orbisguids.map> <gamedir> fixtures/rinst .rinst
java -cp "$JAR;out" ExtractGuid <orbisguids.map> <gamedir> fixtures/smp  audio/music/samples
```

then `npm run serve` and open http://127.0.0.1:8173/ to play them.

⚠️ **Run these on JDK 21 or 25, not the `java` on PATH.** `javac` here is 25 and the JRE on PATH is
1.8, so `ExtractGuid` compiles and then dies with `UnsupportedClassVersionError: class file version
69.0`. Use `"C:/Program Files/Eclipse Adoptium/jdk-25.0.3.9-hotspot/bin/java.exe"`.

**The game's own words come out the same way.** `ExtractGuid ... "languages/english.trans"` pulls
the LAMS table (GUID 31131, 3.5 MB, out of `intro_001.farc`); its layout is `u32 count`, then
`count x (u32 key, u32 offset)`, then one UTF-16BE blob. ⚠️ **The offset is in BYTES and points at
the entry's own U+FEFF**, which is also the separator -- there are no NULs, and reading it as
characters or splitting on NUL gives strings that start mid-word and look almost right. The keys
are hashes: `cwlib.resources.RTranslationTable.makeLamsKeyID(String)` computes them, so the way to
read a name is to *propose* the key and look it up (`translate("REVERB_SETTING_CAVE")` → `Cave`).
That is how the reverb names were found ([lbp-audio-engine.md](lbp-audio-engine.md)). The eboot
holds none of these keys, as strings or as ids; the UI builds them in script.

**A `.ff` script decompresses with `lbpres.py --raw`**, and its string table then shows the class's
fields and method names -- `gamedata/scripts/tweaksequencer.ff` is the Music Sequencer's tweak
menu, `AddReverbs__` and `TranslatedReverbNames` and all. The bytecode's operands need a
disassembler nobody has written; the strings alone still say which script owns a piece of UI.

- ⚠️ `<gamedir>` is the folder holding `base_001.farc` — `D:\PS4Games\CUSA00063`, **not** the
  `-patch` folder, which holds only `patch_001.farc` and makes every row come back `MISSING`.
- ⚠️ **Two GUIDs can share a basename**, and the extractor once let the second overwrite the first
  (`a_kit_1/kick.smp` and `baiyon_drums/kick.smp`): one kit played the other's kick in every render
  for days. A name already claimed by a different GUID in the same run now gets the GUID prefixed
  (`148304-kick.smp`) and the clash is printed. **A manifest with more rows than files is a
  collision, and it is worth asserting** — `fixtures/rinst` had 68 rows and 68 files;
  `fixtures/smp` had 216 rows and 215 files and nobody counted. The cost is in game-assets.md.

## The level corpus

| tool | what it does |
|---|---|
| `PartCensus.java` | which Thing parts a level corpus actually uses, overall and on the Things carrying a `SEQUENCER` or an `INSTRUMENT`. Its `INSTRUMENT` count for the ten-level corpus, **62,158**, is what `packages/cwlib-ts/test/project.test.ts` pins the TypeScript walk against |
| `CwlibTrace.java` | **ask cwlib what it reads from a level, and where.** `CwlibTrace parts <level>` gives the Thing count and each Thing's decoded part list; `CwlibTrace spans <level>` turns on cwlib's own serialiser log and prints every part boundary **with its byte offset** |
| `packages/cwlib-ts/dev/trace-level.ts` | the other half: our reader's part spans in the same units, so a divergence is a diff that names the part and therefore the cwlib file to open |
| `packages/cwlib-ts/dev/walk-levels.ts` | walk a directory of resources and name the next part with no reader, rather than throwing a stack trace |
| `packages/cwlib-ts/dev/verify-levels.ts` | the golden fixture: the walk against `fixtures/levels/sequencers.jsonl`, plus the structural check that every board cell is whole and distinct |
| `packages/cwlib-ts/dev/board-probe.ts` | the measurement behind `boardCell` — why the cell of a component on an open board is the delta in the board's basis and not the bare delta |
| `packages/cwlib-ts/dev/archive-sample.mjs` | **a corpus from the archive's own index**: `node packages/cwlib-ts/dev/archive-sample.mjs 60` reads `dry.db`, picks an even spread of ids per game, downloads the root levels into `fixtures/archive/` and leaves them for `walk-levels.ts` |

- ❗ **Reach for `CwlibTrace` before tracing bytes by hand.** Question 28 spent one session on a hex
  dump and another guessing at version gates; twelve real reader bugs then came out of the span
  diff, none needing a hex dump. `ResourceSystem.LOG_LEVEL` is what turns cwlib's log on.
- ⚠️ `CwlibTrace parts` prints `825 things (278 non-null)`; **compare the non-null count.** cwlib's
  `things` list holds nulls and `readWorld` filters them; comparing against the total once produced
  a bogus "0 of 21 read correctly".
- ⚠️ `PartCensus.java`'s output was once read as scoping the walk down to "eight part readers". It
  answers *what sits on a sequencer's Thing*, which would matter if a Thing could be reached
  directly — it cannot, the stream is sequential. **`partReaders()` returns 50 today.** Count it, do
  not quote it.
- ⚠️ **Reach for `archive-sample.mjs` before arguing about reader coverage from the ten-level
  corpus**, which is one creator on one console generation. The 103-level sweep behind
  `LBP3_MIN_VERSION` took one command, and every real `parts.ts` bug found on 2026-09-05 came out of
  a file no PS3 save here contains. It needs the index (`LBP_DRY_DB`) and a Python to query it with
  (`LBP_PYTHON`), because no Node this repo targets ships SQLite.
- ⚠️ **`tools/RawDump.java` is gone**, deleted 2026-09-02. It walked a level's Thing graph through
  the toolkit jar and dumped every music sequencer's note records; `packages/cwlib-ts/src/level.ts`
  does that now and nothing in the pipeline needs Java. What it leaves behind is
  `fixtures/levels/sequencers.jsonl` — 129,696 rows over **19 files** (⚠️ its `level` field is a
  float, not a name; the source file is `file`), which `verify-levels.ts` still checks the walk
  against. **It cannot be regenerated**, so it covers its own corpus and nothing newer, and it still
  contains the 23,911 duplicate rows the tool used to emit — see *The `RawDump` duplication* in
  lbp-modding-toolchain.md before trusting a raw row count.

## The eboot and the PRXs

`ebconf.py` is **not a command; it is where every eboot tool gets its binary**, and three
environment variables override its defaults: `LBP_EBOOT` (the dump, default
`shadPS4\lbp3-ebins\eboot-v128.bin`), `LBP_BINDINGS` (the script-binding table) and `LBP_DELTA`
(the file↔vaddr delta, `0x4000`). Point these at another version rather than editing a tool. The
address conventions themselves — and the delta trap that costs hours — are in eboot-re.md.

| tool | what it does |
|---|---|
| `lbpdis.py <vaddr> [n]` | capstone disassembly by vaddr, resolving rip-relative targets to strings, tagging binding names and marking call targets that land inside FMOD |
| `callgraph.py <vaddr> [depth]` | BFS the direct-call graph from a seed and report the shortest paths that reach FMOD. ⚠️ It sees direct calls only, so *"does not reach FMOD"* is weak evidence and *"reaches it"* is solid |
| `fmodapi.py` | every game→FMOD call edge, attributed to the FMOD `.cpp` the callee lives in — the map of how much of FMOD the game drives, and by omission what it ignores |
| `ebvtable.py <name> [n]` | **name a C++ class's vtable through RTTI** and dump its slots; `slot <off> <name>` compares one slot across classes; `who <vaddr>` says which vtable slot holds a function |
| `ebxref.py refs\|calls <vaddr>` | **who references an address**: `refs` every rip-relative reference, `calls` every direct call, clustered by caller and marked game-side or FMOD-internal. All in vaddr space |
| `ebdyn.py modules \| <nid>` | the eboot's dynamic imports: the modules a NID's `#L#M` suffix indexes, or one NID resolved to its module, GOT slot and every reference to it |
| `prxnid.py <module> imports\|<n>\|guess\|export`, `prxnid.py hash <name>` | **a PRX's imports and exports, by NID** — `<module>` is `reverb`, `input`, `hammer` or `libc` |
| `prxdis.py <module> <vaddr> [n]`, `prxdis.py <module> map` | disassembly of a PRX by vaddr, resolving rip-relative operands to the float/double there; `map` prints the segment table |

The traps, each of which cost at least a session:

- ⚠️ **Reach for `ebvtable.py` before any structural vtable search.** Question 22 spent a session
  enumerating vtables by shape and produced five wrong candidates plus a near miss convincing
  enough to write up; the binary has 204 mangled `N4FMOD…E` names and 322 vtables that can simply
  be named. The trap that hides them: the slots are **zero on disk** and the pointers live in
  `R_X86_64_RELATIVE` addends, so searching the data finds nothing and it reads as "there is no
  RTTI".
- ⚠️ **Run `ebxref.py calls` before writing down that the game never does something.** Question 37
  spent a session on "no `DSP::setParameter` call on the WaveHammer handle has been found" — true,
  and doing the work of a false sentence, because *not found* had not been separated from *not
  there*. Its docstring has the trap in the tool itself: the displacement is assumed to be the
  instruction's last field.
- ⚠️ **Run `ebdyn.py` before building anything on a NID.** Matching a NID against the string table
  alone once turned libc into "the sequencer plugin's only export"; the module suffix settles it in
  one query.
- ⚠️ **`ebdyn.py` cannot do a PRX; `prxnid.py` can.** A PRX's `PT_DYNAMIC` has no data segment of
  its own — it lives inside `SCE_DYNLIBDATA` — and half the SELF segment entries are 32-byte digests
  rather than data. Both traps are in the docstring with the addresses. `prxnid.py input 0x140` is
  how the unison stack's `rand` was settled rather than assumed, and ✔ it reads shadPS4's
  `aerolib.inl` when that checkout is present — 171,520 lines carrying **94,276** `STUB("nid", name)`
  entries — so every import resolves; Sony's own table agrees with the hash on `rand`.
- ❗ **`libc` is a module in both PRX tools because the game ships its own** at
  `sce_module/libc.prx`. The libc a plugin links against is a file on this disk, not a fact about
  the console: that is how `RAND_MAX` was settled as `2^30 − 1` (`rand` is a 37-byte LCG at vaddr
  `0x17000`). **When a question turns on what a system function does, check `sce_module/` before
  reasoning about the platform.**
- ⚠️ **`prxdis.py`: disassemble from a function start, never from an arbitrary address.** A
  mid-function start desynchronises the stream and prints convincing nonsense. Its file deltas were
  both 0x40 too small until 2026-09-02, so every PRX address in a note older than that is 0x40 too
  high — the readings are fine, the labels are not (eboot-re.md has why).
- ⚠️ **`prxdis.py` prints an `f32`/`u32`/`f64` triple beside every rip-relative operand, and two of
  the three are usually wrong.** Take the one the instruction's operand size asks for. The
  WaveHammer's `a1` coefficient was read as the qword-as-double (0.96715) instead of the float
  (0.86679) that way.

### Outside the repository

`C:\Users\sgdc3\Desktop\shadPS4\lbp3-re\` holds an older set that predates the delta being fixed:
`ebrela.py` (recovers the script-binding table by finding the RELA array by shape), `ebseg.py`
(program headers — **run this first on any new binary**), `ebschema.py` (recover a serialised
struct's field names and offsets; ⚠️ it assumes the member `lea` comes first and the name second —
pairing them the other way shifts every field by one and still looks plausible), `ebstr.py` (string
scan; ⚠️ its `v=` column uses a stale delta, ignore it). ⚠️ **It also has an `ebxref.py`, and that
one works in file-offset space.** The one you want is this repository's.

The shadPS4 workspace also has an uncommitted guest breakpoint tracer,
`src/core/guest_trace.{h,cpp}`, driven by `SHADPS4_TRACE=<addr,addr>` and `SHADPS4_TRACE_OUT=<path>`.
Every hit logs the address, the return address read from `[rsp]` (which names the caller even for
indirect calls) and the argument registers; every script→native call funnels through **one**
indirect call at file `0x3d9e72` with the callee in `rbx`, so a breakpoint there crossed against the
binding table is a complete script call trace. ⚠️ Three traps that all look like "the code is never
called": the trap arrives with RIP **on** the address rather than after it; never call `LOG_*` from
inside the handler (deadlock); the handler must be registered with
`AddVectoredExceptionHandler(1, …)`. Always arm the eboot entry point as a positive control before
believing a zero.

## The sound harnesses — `packages/lbp-tracker-lib/dev/`

All run as `node <file>` — Node 24 strips the types unaided, and `engines` in the root
`package.json` says so. None is in the pipeline; each exists so that a
question can be answered in seconds instead of by ear.

| harness | what it proves |
|---|---|
| `render-level.ts [seqIndex] [seconds]` | one sequencer from a real level to a WAV, through the whole pipeline in `src/render.ts`. The Node half of the wrapper whose browser half is `packages/lbp-tracker-web/src/render-worker.ts`; the two produced the same 70,704,044-byte file on 2026-09-02 |
| `verify-midi.ts` | the MIDI round trip over the corpus: every sequencer exported and read back, records compared byte for byte, and the loose (no-patch) numbers with `LBP_MIDI_LOOSE=1` |
| `live-sim.ts` | the live scheduler under Node: the plan built as `Player.load` builds it, fed to a `Mixer` in look-ahead bursts, compared against the plain render. All three variants are bit-identical to the direct render; ⚠️ **when this file and the renderer disagree, suspect this file first** — it has to imitate two cadences at once, and *34* in answered-questions.md is what that cost |
| `live-settings.ts` | that tempo, swing and the channel mixer can be applied live without re-planning: bit-identical against a render that had those settings all along, and 0 of 163 notes handed over twice |
| `pitch-probe.ts` | that `Notes.y`, `basenote` and `Splitnotes` share one numbering: zones against their own base notes, and the corpus's notes against the samples they resolve to |

⚠️ **A render that normalises cannot see a gain error.** `render-level.ts` normalises its WAV, and a
half-applied stereo fold sat unnoticed for two days until a listener played the live page, which
does not. Several tests normalise too; check the level with something that does not before ruling
a gain question out.

## Environment variables

| variable | read by | meaning |
|---|---|---|
| `LBP_LEVELS` | the corpus tests, `render-level.ts`, `verify-midi.ts`, `live-sim.ts`, `live-settings.ts` | a directory of level resources; default the toolkit checkout's `tools/sequencerdump/data`. The tests **skip** without it |
| `LBP_RINST`, `LBP_SMP` | `rinstrument.test.ts`, `envelope.test.ts`, `fsb.test.ts` | the extracted instruments and samples; default `fixtures/rinst`, `fixtures/smp` |
| `LBP_FSB`, `LBP_PYTHON` | `fsb.test.ts`, `archive-sample.mjs` | a bank to decode against the Python oracle, and the interpreter to run `tools/` with |
| `LBP_DRY_DB` | `archive-sample.mjs` | the archive index, `dry.db` |
| `LBP_EBOOT`, `LBP_BINDINGS`, `LBP_DELTA` | `tools/ebconf.py` | the eboot dump, the binding table, the file↔vaddr delta |
| `LBP_UID` | `render-level.ts`, `live-sim.ts`, `live-settings.ts` | which sequencer, by uid |
| `LBP_FROM`, `LBP_SECONDS` | `render-level.ts`; `live-sim.ts`, `live-settings.ts` | the window to render, in seconds |
| `LBP_ONLY`, `LBP_SKIP` | `render-level.ts` | comma-separated instrument GUIDs to keep, or to drop |
| `LBP_SEED` | `render-level.ts` | the PRNG seed. ❗ **Reseeding is the null hypothesis**: a difference smaller than a reseed is a difference a reshuffle could have produced (*15*) |
| `LBP_VOICES=<n\|off>` | `render-level.ts` | the pool size; `off` is `VOICES_UNLIMITED` |
| `LBP_COMPRESSOR=1`, `LBP_RELEASE_TAIL=1` | `render-level.ts` | switch on the two measured behaviours that are off by default (*38*, *29* in open-questions.md) |
| `LBP_ONESHOT=full\|natural\|gate` | `render-level.ts` | the one-shot rule; `gate` is the engine's (*10*) |
| `LBP_NO_REVERB=1`, `LBP_NO_ECHO=1`, `LBP_NO_CLIP=1` | `render-level.ts` | drop a stage, for A/B |
| `LBP_NO_KEYTRACK=1` | `render-level.ts` | force the filter's key tracking to 0 |
| `LBP_PITCH=<guid>:<semitones>[,…]`, `LBP_UNPITCHED=<guids>`, `LBP_UNPITCHED_PERCUSSION=1` | `render-level.ts` | A/B switches on one instrument's playback rate — they answer *"is a sample mapped to the wrong octave?"* and nothing else |
| `LBP_LOOKAHEAD`, `LBP_TICK` | `live-sim.ts` | the page's look-ahead (0.35 s) and tick (0.1 s) |
| `LBP_POOL`, `LBP_LIVEPOOL=1` | `live-sim.ts` | the pool size for the live-pool variant, and whether to run it |
| `LBP_BLOCK`, `LBP_DIFF=<index>`, `LBP_DIFF_BLOCK`, `LBP_SCAN=1`, `LBP_SCAN_VOICES`, `LBP_SCAN_BLOCK` | `live-sim.ts` | render block size; bisect one voice's two renders frame by frame; scan every voice for a divergence. ⚠️ 128 is the one block size that hides the cadence bug of *34* |
| `LBP_STRIP=envelope,filter,…` | `live-sim.ts` | fields to delete from every voice spec before it is played, to bisect a divergence by feature |
| `LBP_TEMPO`, `LBP_SWING`, `LBP_CHANNELS` | `live-settings.ts` | the settings to turn to, as a listener would |
| `LBP_MIDI_LOOSE=1` | `verify-midi.ts` | export without the verbatim record patch, so MIDI alone is measured |
