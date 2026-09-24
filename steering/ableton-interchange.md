# What our Ableton Live set carries — and how Live was made to say so

Read before touching `packages/lbp-tracker-lib/src/als.ts` or
`packages/lbp-tracker-web/src/daw/als-export.ts`. The module's header has the mapping table (part →
track, placement → clip, glide → per-note pitch, and the rest); this file has what that mapping
rests on, measured out of Live's own files, Live's own manual and Live itself, and what nobody has
looked at yet.

The MIDI export is the other way out of the tracker and shares three things with this one on
purpose: `partKey` (what a part is), `partLabel` (`row 4 - saw_wave`) and `rowGroups` (which parts
share a track), all in `midi.ts`, so the two files list the same song as the same tracks.
Everything about *why* is in [midi-interchange.md](midi-interchange.md).

## Why the target is Live 11.3's schema, member for member

Measured 2026-09-24 on this machine, whose only Live program is **11.3.43**
(`C:\ProgramData\Ableton\Live 11 Trial\Program`; Live 12.4.3 left its preferences behind and its
program is gone). Every line below is from Live's own `Log.txt`, read by
`tools/open-in-live.ps1`:

| the file | what Live 11 did |
|---|---|
| `sequencerdump`'s set, as written (`MinorVersion="12.0_12049"`) | refused: `Unsupported MinorVersion (12.0_12049)` |
| the same set with only the version rewritten to `11.0_11300` | **opened with no exception** — tracks named, tempo 130 — and **every clip slot empty** |
| ours | opens; tracks, tempo, returns, devices, clips, notes and their MPE all there (below) |

⚠️ **Live 11 fills a missing member with its default and says nothing.** That is how the second
row loses its music with a clean log, and it is why "no exception" is necessary and never
sufficient here. Live 12 is the stricter reader: on 2026-07-19 Live 12.4.3 refused the owner's own
set-from-scratch by naming what was missing — `Member "FollowActionEnabled" of Class FollowAction
is missing, path: LiveDocument/Scenes/0/FollowAction` — and another with `Set has no player
tracks`.

So the writer carries **every member Live itself writes**, from references Live saved:

- an **empty set saved by the owner's Live 11.3.43** (`MinorVersion 11.0_11300`,
  `SchemaChangeCount 7`): the `MidiTrack`, `ReturnTrack`, `MasterTrack`, `PreHearTrack`, scenes,
  transport, the `LiveSet` tail, and the **Reverb and Delay** its two returns hold;
- the Core Library's **`Ninajirachi - In The Rain (Live 11 Suite Demo).als`** (`11.0_11300`,
  Live 11.3d1): the only arrangement `MidiClip` with MPE on this disk that Live itself wrote.

⚠️ **Not a clip written by another tool.** `La Mosca e il Toro BACKUPPATO …als` in the owner's
Downloads says `Creator="dawtools (Ableton Live 11.3.43)"` and its clips lack eight members the demo
has (`ScaleInformation`, `ExpressionGrid`, the fold-scale pair and more); Live 11 opens it, which is
the silent-default behaviour above, not evidence that the members are optional.

The two devices were **derived, not transcribed**: a script read each out of the empty set, reduced
every member to one of four shapes (a float dial with its range, an on/off switch, an enum, a plain
value) — which is `DeviceMember` in `als.ts` — and the XML rebuilt from the reduction has the same
elements in the same order as Live's: 430 for the Reverb, 329 for the Delay.

Live 12 opens an 11 set and upgrades it; nothing opens the other way round. That is the whole reason
the target is 11. **Live 12 itself is unchecked** — *52* in [open-questions.md](open-questions.md).

`Creator` is free text — the `dawtools` set above opened in Live 11.3.43 on 2026-09-18 — so ours says
`LBP Tracker`. `MinorVersion` is what Live checks.

## The units, read off Live's own files

| what | unit | read from |
|---|---|---|
| every time | beats; a step is a quarter of one | the demo |
| an arrangement clip | `Time` = `CurrentStart`, `CurrentEnd`, both absolute; `LoopStart`/`LoopEnd` in the clip's own content; notes relative to that content | the demo's clip at `Time="32"`: `CurrentEnd 160`, `LoopStart 4`, first note at `Time="4"` |
| per-note pitch, `CC="-2"` | **8192/48 = 170.67 per semitone**, ±48 | the demo's values: `341.3125` (a tone), `511.97` (3), `853.28` (5), `1194.59` (7), `1706.56` (10) — drawn by hand, so each within 0.1 of the multiple, and no other unit fits all five |
| per-note `TimeOffset` | beats from the **note's** start | the demo's note at `Time="32"` whose list opens at `TimeOffset="4"` |
| between two per-note events | a straight line: `CurveControl1/2` at `0.5` | the demo writes 0.5 on every event it has |
| pressure `CC="-1"`, slide `CC="74"` | 0..127 | Live's MPE ranges |
| track `Volume`, a send | linear gain; `0.0003162277571` (−70 dB, shown as −inf) to `1.99526238` (+6 dB); a send tops at 1 | the empty set's `MidiControllerRange` |
| `Pan` | −1..1, constant power (below) | the same; the law from the manual |
| `TimeSignature` 4/4 | `201` = `denominator index × 99 + numerator − 1` | the owner's `cubase_to_ableton.py`, checked in Live there (`3/4 = 200`, `4/2 = 102`) |
| `AutomationTarget`, `ModulationTarget`, `Pointee`, `ControllerTargets.N` | **one id space**, and `NextPointeeId` past all of it | the empty set; an envelope finds its parameter by that number |
| a track's automation | `AutomationEnvelope` in the track's `AutomationEnvelopes`, `PointeeId` = the dial's `AutomationTarget`; opens with an event at `Time="-63072000"`, "before the song" | the empty set's tempo envelope on the master |
| a step in an envelope | **two events at one time**, the old value then the new; one event alone ramps from the last | the demo's `BoolEvent`s at 224, and `FloatEvent`s at 339 and 368 in a set of the owner's |
| Delay's `DelayLine_SyncedSixteenth` | an index into **1, 2, 3, 4, 5, 6, 8, 16** sixteenths | the empty set's delay carries Live's "Dotted Eighth Note" preset at 2 (= 3); the whole menu read off the device in Live, with 4 lit for index 3 |
| Reverb `DecayTime`, `PreDelay` | ms | Live shows 3000 as `3.00 s` and 70 as `70.0 ms` |
| Reverb `MixReflect`, `MixDiffuse` | linear gain, floor 0.03 (−30 dB) | the empty set's range; Live shows the floor as `-30 dB` |

❗ **A glide goes in as its control points and nothing else.** The engine glides linearly between
records and Live draws a straight line between per-note events, so the MIDI export's resampling,
its simplifier and its fifteen-channel budget have no counterpart here.

## The mixer — the engine's gain on each channel, through Live's pan law

❗ **Live's pan law is constant power, 0 dB at the centre and +3 dB at either end**: the Live 11
manual's own *Audio Fact Sheet*, §34.3.9, page 835 of `User Manual English.pdf` beside the program
("Live uses constant power panning with sinusoidal gain curves"). So a track at volume `V` and pan
`x` puts `√2·cos θ·V` and `√2·sin θ·V` on its two channels, `θ = (x + 1)·π/4`. The engine's law is
linear ([synth-engine.md](synth-engine.md)): `2(1 − p)` and `2p` times `level × channelVolume` on a
mono sample, the 2 being the factor that enters with `Params[24]`. Both are unity at the centre, and
the two agree exactly when

```
x = (4/π)·atan2(p, 1 − p) − 1          V = level × channelVolume × √2 × √((1 − p)² + p²)
```

— `mixerOf` in `als.ts`. The fader rises to `√2` hard over, which with Live's +3 dB puts `2G` on the
one channel, as the game does. ⚠️ Writing the plain `2p − 1` put a part at pan 0.25 at 1.31 : 0.54
where the game plays 1.5 : 0.5. It is exact for a source that is the same on both channels, which
is what a mono sample through an instrument is; a stereo source gets the same gain per channel, and
whether the game pans a stereo sample that way is not checked.

`Params[24]` itself, the instrument's own output level, is not in the set: it belongs to the
instrument, and the instrument is whatever the user loads. The 7.1 fold's narrowing of the image is
not applied here either, for the same reason as in the renderer — the file's own pans — *39* in
[open-questions.md](open-questions.md).

## The colours — Live's palette, measured

A Live colour is an index, 0..69, into a palette that is not in any file. **Measured 2026-09-24**:
three sets of 24 folded tracks coloured 0..69 opened in Live 11.3.43, each header read off the
capture at three pixels that agreed on every row; the two indices read twice (23 and 46, selected
in one set and not in the other) gave the same value, so selection does not tint a header. The
values are `LIVE_PALETTE` in `als.ts`. A chip's tint (`drawnColour`, packed RGBA) goes to the
nearest of them in CIE Lab, on its track and on each of its clips, so a merged track keeps its
chips' colours. In Live the result reads as the board does: `This Is Halloween`'s pulse, music box
and piano rows came out blue, purple and yellow.

## The returns — Live's Reverb and Delay, set from the sequencer

| the sequencer | the return |
|---|---|
| `ReverbSetting` 0..5 | A, Live's Reverb: `DecayTime` = the preset's RT60, `PreDelay` = the time before its late field, the high shelf at its damping frequency (off for Bright Plate), and the early reflections as far below the late field as the preset has them — [lbp-audio-engine.md](lbp-audio-engine.md), *The six the sequencer offers*. 6 and 7, which no menu offers, take Small Room |
| `EchoTime` | B, Live's Delay, synced to that many sixteenths when Live's menu has them — 2, 1 and 1.5 beats are 331 of the corpus's 338 sequencers — and in seconds at the song's tempo otherwise |
| `EchoFeedback` | the Delay's feedback, clamped to 0.95: the engine's own clamp and Live's own maximum |
| `EchoMix` | return B's fader: the engine's echo is a plain wet gain |
| the echo feeding the reverb | return B sends into return A at 1, post-fader — the engine adds the echo's wet to all four output lanes, and lanes 2-3 are the reverb's input ([synth-engine.md](synth-engine.md), *The echo*) |

Checked in Live on `This Is Halloween`: the Delay reads Sync on both sides with 4 lit, feedback
54 %, dry/wet 100 %; the Reverb reads predelay 70.0 ms, decay 3.00 s, high shelf 7.00 kHz, reflect
−30 dB — the Cathedral, whose early reflections are 36 dB under its tail and meet Live's −30 dB
floor.

⚠️ **Two different algorithms.** This sets what the two have in common — how long the room rings,
when its tail arrives, how dark it is, how loud the early reflections are against it, the echo's
time and feedback — and is not the game's sound. The echo's hard clip and the reverb's absolute
level have no counterpart set.

## The instruments — Live's Sampler from the `.rinst`, off by default

❗ **An option, off unless asked for, by the owner's rule (2026-09-24)**: on, the download carries
Sony / Media Molecule's samples ([game-assets.md](game-assets.md), *Asset licensing*) and becomes a
zip holding a Live project; off, the `.als` alone, a file of notes. The owner has Live 11 Suite,
which has the Sampler. `als-sampler.ts` has the mapping table; what it rests on:

- **The device is derived, not typed.** `SAMPLER` is Live's own `Core Library/Defaults/Instruments/
  Sampler.adv` reduced to `DeviceNode`s (`als-xml.ts`), and rebuilt without overrides it has the same
  1,243 elements in the same order as the file. The Shaper is the one in the Core Library's `Saw
  Filtered Bass` preset. A device in a track's list needs an `Id` the preset file's root lacks —
  without it Live refuses the set: `Not all list members have Ids`.
- **Zones** are `resolveSlot` run backwards, each shifted by the track's `Key` (the engine picks the
  zone off the raw note, Live off the key it is given); fine tune and `fitBpm` go into the root and
  the cents; an unpitched slot is one zone per key, each its own root. Checked in Live on
  `Ascetic`'s double bass: silence above 73 and below 24 and `db_c3_dsp1` between, root 48, exactly
  as the instrument has it.
- **Samples** are the `.smp` frames verbatim under a 48 kHz header, since the engine never reads the
  rate: Live then plays the 44.1 kHz ones 8.8 % fast, as the game does, with nothing to correct.
- **The loop**: Live's Sample tab showed `piano_c4` at Loop Start 20251 and Loop End 36562 —
  `[dwStart, dwEnd + 1)`, the loader's region — with `SustainLoop` `Mode` 1 as the forward loop and
  0 as none, and `ReleaseLoop` `Mode` 3 as off.
- **The project**: a sample referenced with `RelativePathType` 3 and a path relative to the set is
  found **only when the folder holds `Ableton Project Info`** — without it Live's log says `Il file
  "piano_c4.wav" non può essere aperto`, with it the set opens with its samples. Windows' own
  extractor keeps the empty folder from our zip, and `This Is Halloween`'s project, unzipped, opened
  with 0 missing files.
- **The MIDI tab**, read off Live with a numbered connection on every row. The rows (`KeyDst`,
  `VelDst` and `RelVelDst` are Key, Velocity and Off Vel):

  | `MidiCtrl.0` | `.1` | `.2` | `.3` | `.4` | `.5` |
  |---|---|---|---|---|---|
  | **Pressure** | Pitch Bend | Mod Wheel | Foot Ctrl | **Slide** | Note PB (±48 st) |

  and what a `Connection` number names:

  | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
  |---|---|---|---|---|---|---|---|---|
  | Sample Selector | Sample Offset | Loop Start | Loop Length | Release Loop | Pitch | Pitch Sample | Pitch Osc | Pitch Env |

  | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 |
  |---|---|---|---|---|---|---|---|---|
  | Volume Osc | Shaper Amt | **Filter Freq** | Filter Q (Legacy) | **Filter Res** | Filter Morph | Filter Drive | Filter Env | **Volume** |

  The list goes on past 18, unread: Ableton's own Core Library presets route to 19–23, 25–27, 29
  and 30, all with the LFO on but `MPE Dulcimatica`'s 20, which has every LFO and the auxiliary
  envelope off (a scan of its `.adv`/`.adg` files). ❌ **A probe setting 19 to 36 at once crashed
  Live 11.3.43 on load**, and which of them did it is not known. One crash: Live packs the same
  dump into `Live Reports` again at each later start, five zips of it that night.
- ❗ **Every note carries its level on per-note pressure, because at 100 the Pressure row leaves a
  note with none silent.** The row is there for the volume ramp. The first export put pressure on
  the ramped notes only, the rest keeping their level as velocity, and it played nothing: the
  owner heard silence from `Ascetic`, whose first 872 notes, 22 seconds of it, have no ramp, and
  a capture of Live playing `This Is Halloween` has every meter flat (2026-09-24). So on a
  track with a Sampler every note gets a pressure list, a flat note's as one point, and velocity
  127: one law for every level. ⚠️ The price: a note drawn in Live, or played on a keyboard without
  aftertouch, is silent until it is given pressure or the row's Amount is turned down.
- **Voices**: `Globals.NumVoices` is an index — 5 shows 6 voices (the default), 13 shows 24, 14
  shows 32, the engine's pool. The default 6 would cut every chord denser than that; the default
  retrigger (`RetriggerMode`) would end a note where the same key strikes again, and the engine
  gives both a voice. The export writes 14 and no retrigger.
- **Filter and envelopes**, checked on `Ascetic`'s square wave: Clean circuit, 24 dB, 480 Hz at rest
  with an envelope amount of 67 semitones (its envelope amount 0.98 takes the cutoff from 2 % to all
  of it: 12·log2 50), filter release 4.00 s, volume −8.23 dB. Live's envelope amount stops at 72
  semitones, and past it the export keeps the peak and lets the rest rise: kept at the rest, an
  amount of 1 peaked at 6 % of the cutoff. 13 of the 68 instruments in `fixtures/rinst` pass 72 at
  modulation 0 or 1, `concertina` and `space_piano` at every modulation.

⚠️ **Measured to be what the file says, not to sound like the game.** This Live is a Trial that
renders nothing, so no Sampler here has been compared by ear or by capture; what is unmeasured in
the mapping is *53* in [open-questions.md](open-questions.md).

## Measured over the corpus — `packages/lbp-tracker-lib/dev/export-als.ts`, 2026-09-24

```
150 sequencers, 0 malformed
3222 tracks from 4909 parts, 3056 mixer switches, 62094 clips from 62158 placements, 953791 notes, 78647 glides, 19.4 MB gzipped
clamped: 0 keys, 582 bend points; 11528 notes overlap one of their own key
```

- **3,222 tracks from 4,909 parts**, with `mergeRows` on (the default): one track per row and
  instrument, the MIDI export's own `rowGroups`, which puts the same corpus on 3,224 MIDI tracks —
  the two extra are its lanes ([midi-interchange.md](midi-interchange.md)). `This Is Halloween` is
  124 parts on 46 tracks, `Ascetic` 46 on 36. Live imposes no limit either way; what a track costs
  is an instrument to load.
- ❗ **3,056 mixer switches, and 1,371 of them go back to a part the track has already played.**
  Parts sharing a track interleave — A at cell 0, B at cell 2, A again at cell 4 — so the mixer
  steps wherever a part's note starts after another part's, not once per part. Counted twice: by
  the export, and by a separate walk of the notes on every merged track; both give 3,056. The MIDI
  export wrote its mixer once per part and was fixed for it; the measurement and the check are in
  [midi-interchange.md](midi-interchange.md).
- The step sits at the new part's first note. The engine fixes a voice's gain when the note starts;
  a Live track's automation moves whatever is still ringing, so a release tail that outlasts the
  switch takes the next part's mixer. Parts share a track only when their notes never overlap, so
  it is a tail and never a note.
- **78,647 notes bend in pitch.** [midi-interchange.md](midi-interchange.md)'s 88,893 counts a
  volume ramp as a glide too (`hasPitchAutomation || hasVolumeAutomation` in `verify-midi.ts`);
  counting pitch alone gives 78,647 whether the raw field or the quantised pitch is compared.
- **582 control points glide past 48 semitones** — the same 582 the MIDI steering counts past MPE's
  default — and stop at 48, since Live's per-note range is fixed. The MIDI export widens its bend
  range instead; an `.als` has no range to widen.
- ⚠️ **Only 64 placements share a clip.** A clip's window is its cell to where its own last note stops
  sounding (`endPosition + 1`), and Live plays one arrangement clip per track at a time, so windows
  on one track that overlap are merged into one clip, whichever parts they belong to. The MIDI
  steering's "clips of one part overlap heavily" is about the 128 steps a clip *may* hold; what the
  notes actually reach rarely leaves the cell.
- ✔ **11,528 notes start while a note of the same key is still sounding on their clip, and Live
  keeps both.** 11,397 of them are inside one placement, the commonest shape (3,751) a two-step note
  re-struck by the same key one step later. A probe clip — a four-beat note with a one-beat note of
  its key on top, and that corpus shape — opened in Live with every note at its full length and the
  overlaps drawn darker, two notes lying on one another. ⚠️ This file and the page said "Live ends
  the first where the second begins" until that was looked at; it was a guess. Whether an
  instrument voices both is the instrument's affair.

## How it was checked — making Live show what the file says

`tools/open-in-live.ps1 -file x.als -shot x.png` opens the set in Live, prints the log lines about
the load, captures **Live's window alone**, and closes Live ([tools.md](tools.md)). Input sent from
the script never reached Live — a `SendKeys` Tab and `mouse_event` clicks both missed, for a reason
not looked into — so everything Live has to *show* is asked for in the file, in a debug copy:

| to see | set in a copy | measured |
|---|---|---|
| the Arrangement, not the Session view | `ChooserBar` 0 | the demo says 0 and opens on its Arrangement, the empty set says 1; ❗ **the export writes 0** |
| a track's devices in the detail panel | `HighlightedTrackIndex` = the track, counting MIDI tracks then returns | the Echo return's Delay and the Reverb return's Reverb, read above |
| a clip's notes | `ViewStateDetailIsSample` true, the set's `TimeSelection` over the clip, the track's `IsContentSelectedInDocument` true | `Ascetic`'s `cell 41`, sixteen A#3s at velocity 47 |
| the clip's MPE | and the track's `PreferredContentViewMode` 2 | the Note Expression tab: each note rising in a line and holding, pressure ramping and holding, slide flat — exactly the file's `0:0 0.25:512` pitch (+3 semitones), `0:47 0.25:96` pressure and zero slide |
| envelopes on a track without an instrument | one of the track's envelopes pointed at the master's tempo | Live shows the envelope's opening 99.00 over the fader's 180, with the automation marker |

⚠️ **Capture the window, never the screen.** The first capture of this work was a full-screen grab,
and it took whatever else was open on the owner's desktop instead of Live. `PrintWindow` on Live's
own handle cannot.

⚠️ This Live is a Trial whose saving and export are switched off (its status bar says so), so a set
cannot be re-saved by Live to see what Live would write, and nothing can be rendered to audio.

⚠️ **Count tracks, not parts.** `MidiExportResult.parts` counts parts; reading it as MIDI tracks once
made `mergeRows` look inert — 124 "tracks" for `This Is Halloween` with it on and off. Count the
`MTrk` chunks, or `AlsExportResult.tracks`.

## What the set does not carry

- **The sounds, unless asked for**: with the instruments off the tracks have no device; on, a
  Sampler as above.
- **Per-note modulation**, with the instruments on: every `Params` range is read at the modulation
  the track uses most. Over the corpus (`LBP_ALS_INSTRUMENTS=1`): 3,222 of 3,222 tracks got a
  Sampler, 105.7 MB of samples, and **44,787 notes (4.7 %) sit at another modulation** and play at
  the track's; 0 notes sit on a track whose parts differ in `Key`.
- **The unison stack, the three LFOs, the mip levels and the ladder's saturation.**
- **A glide past 48 semitones**, which Live's per-note range cannot hold.
- **The game's reverb and echo themselves**: the returns hold Live's, set as above.
