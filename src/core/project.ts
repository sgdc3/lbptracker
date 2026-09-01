/**
 * A level's music sequencers, turned into something a tracker can play.
 *
 * ## Why this takes a dump rather than a level file
 *
 * The Thing graph is sequential and has no length prefixes: references are
 * inline ids and parts follow each other with nothing to skip past, so reading
 * a `PSequencer` out of a level means being able to parse **every part that
 * precedes it on the same Thing**. Measured across the 22-level corpus with
 * `tools/PartCensus.java`: 34 distinct part types across 172,139 Things, about
 * 5,500 lines of serialiser in cwlib's terms.
 *
 * The census also says the job is far smaller than that number suggests, and
 * that is what makes it worth doing later rather than never:
 *
 * - **128,666 of 129,696 instrument Things carry `INSTRUMENT` and nothing
 *   else.** Another 1,030 add `POS` and/or `RENDER_MESH`.
 * - Only **nine** part types ever share a Thing with a `SEQUENCER`, in **eight**
 *   distinct combinations across all 1,169 of them. In serialisation order:
 *   `RENDER_MESH`, `POS`, `TRIGGER`, `STICKERS`, `DECORATIONS`, `SWITCH`,
 *   `GROUP`, `MICROCHIP`, `SEQUENCER`.
 *
 * So the in-browser walk needs **eight** part readers, not thirty-four, and the
 * heavy one is `PSwitch`. Until those exist, `tools/RawDump.java` does the
 * extraction and this module does everything after it. The boundary is
 * deliberate: nothing below depends on where the rows came from, so replacing
 * the Java step later changes one function and no logic.
 */

import { groupNotes, decodeRecords, type Note } from './notes.ts';

/**
 * One row of `tools/RawDump.java`'s output: one instrument on one sequencer.
 *
 * Field names are the dump's, verbatim, so the two can be diffed.
 */
export interface DumpRow {
  readonly file: string;
  readonly seqUID: number;
  readonly seqName: string;
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
  readonly instIdx: number;
  /** Position on the microchip's circuit board, in world units. */
  readonly boardX: number;
  readonly boardY: number;
  /**
   * The `RInstrument` reference as the toolkit prints a `ResourceDescriptor`:
   * **`g` followed by the GUID** (`"g129085"`), or a 40-character SHA1 for a
   * resource carried inside the level, or empty for none. Parse it with
   * `parseResourceGuid`, not with `Number` -- which returns `NaN` for every
   * real value and silently imports a level with no instruments at all.
   */
  readonly instRes: string;
  readonly instName: string;
  readonly level: number;
  readonly pan: number;
  readonly echoSend: number;
  readonly reverbSend: number;
  readonly loops: number;
  readonly key: number;
  readonly scale: number;
  readonly noteCount: number;
  /** The note records as raw bytes, hex, four bytes each. */
  readonly notes: string;
}

/** Cell geometry, measured at `v0x1c4ad0`-`v0x1c4b23`. */
export const CELL_WIDTH = 105 / 2;
export const CELL_HEIGHT = 105;

/**
 * ⚠️ **UNMEASURED.** Steps per grid cell along X. This is the toolkit's
 * `GRID_UNIT_STEPS`, not ours -- the 52.5-unit cell width is confirmed from the
 * engine, this multiplier is not. It sets where every clip lands on the
 * timeline, so a wrong value shifts whole instruments rather than detuning
 * them. See steering/open-questions.md.
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

/**
 * The GUID out of a `ResourceDescriptor` string, or 0 when there is not one.
 *
 * A descriptor is `g<guid>` when the resource lives in the game's own FileDB
 * and a bare SHA1 when it is embedded in the level. Only the first kind can be
 * resolved against `fixtures/rinst`; a hash means the level ships its own
 * instrument, which is a real case and is reported as 0 rather than guessed at.
 */
export function parseResourceGuid(descriptor: string): number {
  const match = /^g(\d+)$/.exec(descriptor.trim());
  return match ? Number(match[1]) : 0;
}

function hexToBytes(hex: string): Uint8Array {
  const n = hex.length >> 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) out[i] = Number.parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/** Turn one dump row into a track. */
export function trackFrom(row: DumpRow): Track {
  const { gridX, gridY } = boardToGrid(row.boardX, row.boardY);
  const grouped = groupNotes(decodeRecords(hexToBytes(row.notes)));
  return {
    guid: parseResourceGuid(row.instRes),
    name: row.instName,
    gridX,
    gridY,
    stepOffset: gridX * STEPS_PER_CELL,
    level: row.level,
    pan: row.pan,
    echoSend: row.echoSend,
    reverbSend: row.reverbSend,
    key: row.key,
    scale: row.scale,
    notes: grouped.notes,
    trailingRecords: grouped.trailing.length,
  };
}

/**
 * Group a level's dump rows into sequencers.
 *
 * Rows arrive one per instrument; `seqUID` is what ties them together, and the
 * sequencer's own settings are repeated on every row of it. Order within a
 * sequencer follows `instIdx`, which is the order the circuit board lists its
 * components.
 */
export function importLevel(rows: readonly DumpRow[]): LevelProject[] {
  const byFile = new Map<string, Map<number, DumpRow[]>>();
  for (const row of rows) {
    let seqs = byFile.get(row.file);
    if (!seqs) byFile.set(row.file, (seqs = new Map()));
    const list = seqs.get(row.seqUID);
    if (list) list.push(row);
    else seqs.set(row.seqUID, [row]);
  }

  const out: LevelProject[] = [];
  for (const [file, seqs] of byFile) {
    const sequencers: Sequencer[] = [];
    for (const [uid, group] of seqs) {
      const head = group[0];
      const tracks = [...group]
        .sort((a, b) => a.instIdx - b.instIdx)
        .map(trackFrom);
      let lengthSteps = 0;
      for (const track of tracks) {
        for (const note of track.notes) {
          lengthSteps = Math.max(lengthSteps, track.stepOffset + note.endStep + 1);
        }
      }
      sequencers.push({
        uid,
        name: head.seqName,
        tempo: head.tempo,
        swing: head.swing,
        echoFeedback: head.echoFeedback,
        echoTime: head.echoTime,
        echoMix: head.echoMix,
        reverb: head.reverb,
        loop: head.loop,
        startPoint: head.startPoint,
        numChannels: head.numChannels,
        volumes: head.volumes,
        tracks,
        lengthSteps,
      });
    }
    out.push({ file, sequencers });
  }
  return out;
}

/** One note, placed on a sequencer's timeline. */
export interface ScheduledNote {
  readonly step: number;
  readonly durationSteps: number;
  /** Index into the sequencer's `tracks`. */
  readonly track: number;
  readonly guid: number;
  /** The note record's pitch field, **before** the scale quantiser. */
  readonly pitch: number;
  readonly volume: number;
  readonly timbre: number;
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
        step: track.stepOffset + note.startStep,
        durationSteps: note.duration,
        track: index,
        guid: track.guid,
        pitch: first.pitch,
        volume: first.volume,
        timbre: first.timbre,
      });
    }
  });
  out.sort((a, b) => a.step - b.step || a.track - b.track);
  return out;
}
