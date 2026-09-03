/**
 * A level's music sequencers, turned into something a tracker can play.
 *
 * The input is a level file. `level.ts` walks the Thing graph and hands back
 * `PSequencer` settings and `PInstrument` placements; this module turns those
 * into tracks, a step timeline and a schedulable event list.
 *
 * ⚠️ **This used to take a JSON dump produced by a Java tool**, because
 * the Thing graph is sequential and has no length prefixes -- references are
 * inline ids and parts follow each other with nothing to skip past, so reading a
 * `PSequencer` means being able to parse **every part that precedes it on the
 * same Thing**. That turned out to be 30 part readers rather than the eight this
 * file once predicted; see `steering/tracker-architecture.md` for why the
 * smaller number was answering a different question. The walk exists now and the
 * Java is gone.
 *
 * One consequence worth keeping, because it was a real bug and the new path is
 * only free of it by construction: that tool could emit a **whole sequencer
 * twice**, and `importLevel` used to deduplicate. Every note then cost two of
 * the engine's 32 voices, so a passage that fits comfortably in the pool
 * overflowed it and the allocator started stealing -- at step 2176 of
 * `This Is Halloween` that was 42 simultaneous notes against a real 21, and the
 * lead vanished for two bars. This walk reads `PWorld.things` once, in order, so
 * a Thing is visited once: 62,158 placements across the ten-level corpus,
 * exactly the `INSTRUMENT` count `tools/PartCensus.java` reports for those
 * files.
 */

import { musicSequencers, readLevel, type Placement } from './level.ts';
import { partReaders } from './parts.ts';
import type { Inflate } from './resource.ts';
import type { Thing } from './thing.ts';
import { groupNotes, decodeRecords, type Note } from './notes.ts';

/** Cell geometry, measured at `v0x1c4ad0`-`v0x1c4b23`. */
export const CELL_WIDTH = 105 / 2;
export const CELL_HEIGHT = 105;

/**
 * Steps per grid cell along X.
 *
 * ✔ **Measured, and from two independent places** -- this comment used to say
 * UNMEASURED and credit the figure to the toolkit's `GRID_UNIT_STEPS`, which was
 * stale on both counts:
 *
 * - the eboot at `v0x1c5cda` computes a step count as `trunc(x * 32 / 105)`,
 *   i.e. 32 steps per 105 world units and so **16 per 52.5-unit cell**;
 * - `fmodextinput.prx` `0x3a13`-`0x3a31` takes the placement's board column from
 *   a 16-byte per-placement record, shifts it **left by 4**, and subtracts that
 *   from the playhead before comparing a note record's step. `gridX * 16` is the
 *   step offset, in the engine's own arithmetic.
 *
 * It sets where every clip lands on the timeline, so a wrong value would shift
 * whole instruments rather than detune them.
 */
export const STEPS_PER_CELL = 16;

/**
 * Board position to grid cell.
 *
 * **Measured** at `v0x1c4ad0`, which computes both indices and stores them at
 * `[obj+0x58]` and `[obj+0x5c]`:
 *
 * ```
 * gridX = floor(2*x / 105 - 0.5)     ; the -0.5 is a half-cell bias:
 * gridY = floor(-y / 105)            ; component positions are cell centres
 * ```
 *
 * ⚠️ The **sign flip on Y** is the engine's, not a convenience: board Y grows
 * upward and rows number downward. The toolkit's own `floor(x / 52.5)` omits
 * the bias, which is a real divergence and not a rounding preference.
 */
export function boardToGrid(x: number, y: number): { gridX: number; gridY: number } {
  // `v === 0 ? 0 : v` normalises negative zero, which `Math.floor(-0 / 105)`
  // produces for a component sitting on the board's origin row. It compares
  // equal to 0 everywhere that matters and unequal under Object.is, so it does
  // not break anything until something compares grid cells structurally -- and
  // then it does, silently.
  const zero = (v: number) => (v === 0 ? 0 : v);
  return {
    gridX: zero(Math.floor((2 * x) / CELL_HEIGHT - 0.5)),
    gridY: zero(Math.floor(-y / CELL_HEIGHT)),
  };
}

/** One instrument placed on a sequencer's timeline. */
export interface Track {
  /** The `RInstrument` GUID, or 0 when the placement has no instrument. */
  readonly guid: number;
  readonly name: string;
  /** Board cell. `gridY` groups tracks into rows. */
  readonly gridX: number;
  readonly gridY: number;
  /** Where this clip starts on the sequencer's own timeline, in steps. */
  readonly stepOffset: number;
  readonly level: number;
  readonly pan: number;
  readonly echoSend: number;
  readonly reverbSend: number;
  readonly key: number;
  readonly scale: number;
  readonly notes: readonly Note[];
  /**
   * Records that followed the last end flag. Reported rather than dropped --
   * a non-empty tail means either the record format or this reader is wrong,
   * and silently discarding it would hide that.
   */
  readonly trailingRecords: number;
}

/** One music sequencer from a level. */
export interface Sequencer {
  readonly uid: number;
  readonly name: string;
  readonly tempo: number;
  readonly swing: number;
  readonly echoFeedback: number;
  readonly echoTime: number;
  readonly echoMix: number;
  readonly reverb: number;
  readonly loop: boolean;
  readonly startPoint: number;
  readonly numChannels: number;
  readonly volumes: readonly number[];
  readonly tracks: readonly Track[];
  /** Highest step any of its notes reaches; 0 when it is empty. */
  readonly lengthSteps: number;
}

/** Every music sequencer in one level file. */
export interface LevelProject {
  readonly file: string;
  readonly sequencers: readonly Sequencer[];
}

/** Turn one board placement into a track. */
export function trackFrom(placement: Placement): Track {
  const { gridX, gridY } = boardToGrid(placement.x, placement.y);
  const instrument = placement.instrument;
  const grouped = groupNotes(decodeRecords(instrument.notes));
  return {
    guid: instrument.guid,
    name: instrument.name,
    gridX,
    gridY,
    stepOffset: gridX * STEPS_PER_CELL,
    level: instrument.level,
    pan: instrument.pan,
    echoSend: instrument.echoSend,
    reverbSend: instrument.reverbSend,
    key: instrument.key,
    scale: instrument.scale,
    notes: grouped.notes,
    trailingRecords: grouped.trailing.length,
  };
}

/**
 * Every music sequencer in one parsed level.
 *
 * Track order is the order the circuit board lists its components -- the compact
 * list's own order when the board is closed, and the Thing list's when it is
 * open. Neither is the timeline: `stepOffset` is, and it comes from the cell.
 */
export function importLevel(file: string, things: readonly (Thing | undefined)[]): LevelProject {
  const sequencers: Sequencer[] = [];
  for (const found of musicSequencers(things)) {
    const tracks = found.placements.map(trackFrom);
    let lengthSteps = 0;
    for (const track of tracks) {
      for (const note of track.notes) {
        lengthSteps = Math.max(lengthSteps, track.stepOffset + note.endStep + 1);
      }
    }
    const settings = found.settings;
    sequencers.push({
      uid: found.uid,
      name: found.name,
      tempo: settings.tempo,
      swing: settings.swing,
      echoFeedback: settings.echoFeedback,
      echoTime: settings.echoTime,
      echoMix: settings.echoMix,
      reverb: settings.reverbSettings,
      loop: settings.loop,
      startPoint: settings.startPoint,
      numChannels: settings.numChannels,
      volumes: settings.volumes,
      tracks,
      lengthSteps,
    });
  }
  return { file, sequencers };
}

/**
 * A level file straight to its sequencers -- bytes in, playable project out.
 *
 * This is the whole boundary the Java used to sit on. `inflate` is the only
 * thing that differs between Node and the browser; see `src/platform/`.
 */
export async function readLevelProject(
  file: string,
  bytes: Uint8Array,
  inflate: Inflate,
): Promise<LevelProject> {
  const { things } = await readLevel(bytes, inflate, partReaders());
  return importLevel(file, things);
}

/**
 * The engine's fixed headroom on every mixer channel.
 *
 * `fmodextinput.prx` initialises all eight channel records to `{0.75, 0, 0}` at
 * `0x10f7`-`0x11e7`, and the eboot writes `Volume[i] * 0.75` over them. A
 * sequencer whose volumes are all 1.0 therefore runs every channel at 0.75, not
 * at 1.0 -- a uniform -2.5 dB that a normalising render absorbs, and a real
 * level difference in one that does not normalise.
 */
export const CHANNEL_HEADROOM = 0.75;

/** How many channel records the engine keeps, whatever `NumChannels` says. */
export const CHANNEL_COUNT = 8;

/**
 * The mixer channel a track feeds, and the gain that comes with it.
 *
 * **What is measured**, in `fmodextinput.prx`:
 *
 * ```
 * 0x3a32  r15d = header[block] + 0x04        ; the 16-byte per-block header
 * 0x3afc  r15d = r15d mod 8                  ; signed modulo, eight records
 * 0x3b1b  rcx  = channel * 3                 ; 12-byte records
 * 0x3b3c  xmm0 = [state + 0x1a68 + 12*channel]   ; that channel's volume
 * ```
 *
 * ✔ **The wrap is `NumChannels`, and the plugin's `mod 8` is a bounds guard.**
 * Corrected 2026-09-03 by a listener who plays the game: a sequencer set to one
 * channel puts everything through that channel's fader, which `gridY % 8` does
 * not do.
 *
 * ⚠️ **Only the `mod 8` was ever measured**, and this file used to read more
 * into it than it said. The plugin holds eight channel records and clamps into
 * them; **what the eboot writes at `header + 0x04` was never read** -- the linear
 * disassembly of the sequencer module desynchronises and no indexed 16-byte
 * store was found -- so "that value is the board row" was an inference, and it
 * was flagged as one. Both readings survive the plugin: if the eboot has already
 * reduced the row to `0..NumChannels-1`, its `mod 8` never changes anything.
 *
 * The corpus argument that killed the *direct* index still stands and now points
 * here instead: **88% of tracks have a `gridY` outside `0..NumChannels-1`** and
 * boards run to 25 distinct rows, so the row cannot BE the channel -- but taken
 * modulo `NumChannels` it lands in range by construction, for every track.
 *
 * 308 of 338 sequencers set `NumChannels` to 1. Under the old reading their
 * eight faders each did a little and none did much; under this one a single
 * fader does all of it, which is what the game shows.
 *
 * Only 30 of 338 use more than one channel, and 28 of those carry a non-unit
 * volume -- typically a descending ramp like `1.00, 0.70, 0.50, 0.20`.
 */
export function channelVolume(sequencer: Sequencer, track: Track): number {
  // A sequencer claiming no channels still has one to play through, and the
  // plugin only has eight records however many the field claims.
  const count = Math.min(CHANNEL_COUNT, Math.max(1, sequencer.numChannels));
  const channel = ((track.gridY % count) + count) % count;
  // Records past `Volume[5]` keep the engine's initialised 0.75, which is the
  // same as a volume of 1.0 through the headroom factor.
  const volume = channel < sequencer.volumes.length ? sequencer.volumes[channel] : 1;
  return CHANNEL_HEADROOM * volume;
}

/** One note, placed on a sequencer's timeline. */
export interface ScheduledNote {
  readonly step: number;
  readonly durationSteps: number;
  /** Index into the sequencer's `tracks`. */
  readonly track: number;
  readonly guid: number;
  /** The first control point's pitch, **before** the scale quantiser. */
  readonly pitch: number;
  readonly volume: number;
  readonly timbre: number;
  /**
   * The first control point's modulation, 0..1 -- the value that picks a point
   * inside every `Params` range.
   *
   * ⚠️ **The first point's, not a curve.** 3.45% of the corpus's 2,027,633
   * notes change modulation across their own points, and those are rendered at
   * their opening value. Pitch and volume are interpolated between points;
   * modulation is not, because it feeds parameters that are read once when the
   * voice starts (the envelopes' times, the filter settings, the stack).
   */
  readonly modulation: number;
  /**
   * Every control point, in step order, **relative to `step`**.
   *
   * ⚠️ A note is a chain, not a value: the engine glides linearly between
   * consecutive points, and that glide is the sequencer's pitch bend. **53.9%
   * of the corpus's notes have more than one point** and 6.7% bend in pitch, so
   * a player that reads only the first is wrong more often than it is right --
   * which is exactly what an earlier version of this did.
   */
  readonly points: readonly {
    readonly step: number;
    readonly pitch: number;
    readonly volume: number;
    readonly timbre: number;
    /**
     * `(timbre & 0x0f) / 15`, per point.
     *
     * ⚠️ It is the same byte as `timbre`, not a field of its own -- the low
     * nibble of the note word's fourth byte. It is here per point because the
     * engine RAMPS it between them, like pitch and volume; `modulation` above
     * is only the opening value, which is all a caller wanting one number
     * needs.
     */
    readonly modulation: number;
  }[];
  readonly hasPitchAutomation: boolean;
  readonly hasVolumeAutomation: boolean;
}

/**
 * Flatten a sequencer to a time-ordered event list.
 *
 * ⚠️ `pitch` is the raw record field. Turning it into a semitone needs
 * `notePitch(pitch, scale, root)` from `./scale.ts` -- the engine snaps it to
 * the sequencer's scale first, and skipping that detunes anything not authored
 * chromatically.
 */
export function schedule(sequencer: Sequencer): ScheduledNote[] {
  const out: ScheduledNote[] = [];
  sequencer.tracks.forEach((track, index) => {
    for (const note of track.notes) {
      const first = note.points[0];
      out.push({
        // ⚠️ `startPosition`, not `startStep`: a note a third of a step late is
        // a third of a step late. Scheduling by the integer step collapsed
        // every triplet onto the beat -- 39,000 corpus notes, and the reason a
        // triplet passage came out sounding swung.
        step: track.stepOffset + note.startPosition,
        durationSteps: note.endPosition - note.startPosition + 1,
        track: index,
        guid: track.guid,
        pitch: first.pitch,
        volume: first.volume,
        timbre: first.timbre,
        modulation: first.modulation,
        points: note.points.map((p) => ({
          step: p.step + p.subStep / 3 - note.startPosition,
          pitch: p.pitch,
          volume: p.volume,
          timbre: p.timbre,
          modulation: p.modulation,
        })),
        hasPitchAutomation: note.hasPitchAutomation,
        hasVolumeAutomation: note.hasVolumeAutomation,
      });
    }
  });
  out.sort((a, b) => a.step - b.step || a.track - b.track);
  return out;
}
