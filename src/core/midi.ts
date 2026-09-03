/**
 * A sequencer to a MIDI file and back.
 *
 * `sequencerdump` already did the export half, and its author has ruled that
 * layer out as a reference; `steering/lbp-modding-toolchain.md` lists the
 * divergences. This module is the version with those fixed, so it is worth
 * saying which is which:
 *
 * | # | There | Here |
 * |---|---|---|
 * | 1 | grid `floor(x / 52.5)` | never re-derived: `Track.gridX` already carries the game's own `floor(2x/105 - 0.5)` |
 * | 2 | `volume`/`timbre` read as signed bytes | unsigned, from `decodeRecord` |
 * | 3 | duration from the record chain, extra point pushed at `step+1` | `endPosition - startPosition + 1`, the measured reading |
 * | 4 | triplets `group*96 + pos*32`, overrunning the quarter | `step + subStep/3`, exact at 480 PPQ: a third of a step is 40 ticks |
 * | 5 | mixer ignored, tracks grouped by row + instrument | `NumChannels` and `Volume[0..5]` travel in the header meta |
 *
 * And the sixth, which is the reason this file is long: **a note is a chain of
 * control points, not a value.** 53.9% of the corpus's notes carry more than
 * one, and the engine glides linearly between them. A converter that writes the
 * first point and drops the rest loses every pitch bend and every fade in the
 * game. MPE is what lets them survive -- a channel per sounding note, so the
 * glide belongs to the note instead of to the whole part -- and it is why this
 * exports MPE by default.
 *
 * ⚠️ **What a round trip preserves is the music, not the bytes.** Export bakes
 * `Key` and `Scale` into the note numbers, because a MIDI file has to play in
 * something that has never heard of an LBP scale; import therefore produces a
 * chromatic sequencer in C whose record pitches are MIDI note numbers. The
 * scheduled stream matches; the record bytes do not. Clip boundaries move too:
 * a step field is seven bits, so an imported part is re-cut into 128-step clips
 * wherever they fall.
 */

import { readNotes, NOTE_RECORD_SIZE, type NoteRecord } from './notes.ts';
import {
  CHANNEL_COUNT,
  STEPS_PER_CELL,
  schedule,
  type ScheduledNote,
  type Sequencer,
  type Track,
} from './project.ts';
import { blockRoot, notePitch } from './scale.ts';
import { swungFrame } from './swing.ts';
import {
  channelPressure,
  controlChange,
  meta,
  metaString,
  metaText,
  noteOff,
  noteOn,
  pitchBend,
  readMidi,
  sortEvents,
  tempoEvent,
  tempoFrom,
  timeSignature,
  writeMidi,
  type MidiEvent,
  type MidiTrack,
} from './smf.ts';

/** Sequencer steps in a quarter note: the grid is sixteenths. */
export const STEPS_PER_QUARTER = 4;

/**
 * Ticks per quarter note.
 *
 * ⚠️ **480 is not decoration: it is what makes triplets exact.** A step is
 * 120 ticks and a third of a step is 40, both whole numbers, so a note at
 * `step + 1/3` lands on a tick rather than between two. `sequencerdump`'s 96
 * PPQ could not do that -- its own triplet arithmetic overruns the quarter on
 * the fourth slot -- and the rounding is audible as a triplet passage that
 * sounds swung.
 */
export const DEFAULT_PPQ = 480;

/** MPE's own default: 48 semitones at full bend on a member channel. */
export const DEFAULT_BEND_RANGE = 48;

/** The text meta events that carry what MIDI has no room for. */
const SEQ_TAG = 'LBP-SEQ ';
const TRK_TAG = 'LBP-TRK ';

export interface MidiExportOptions {
  /**
   * A MIDI channel per sounding note, so bend and pressure are the note's own.
   * Off, every note of one part shares a channel and the glides have to be
   * dropped -- there is no third option, and that is MIDI, not a shortcoming.
   */
  readonly mpe?: boolean;
  /** Semitones at full bend. Wide by default: real glides reach +27. */
  readonly bendRange?: number;
  /**
   * Write the swung positions rather than the straight grid.
   *
   * Off by default, because the straight grid is what the sequencer holds and
   * what an import can give back; the swing rides along in the header meta. On
   * is for a DAW that has to sound like the game without knowing about it.
   */
  readonly bakeSwing?: boolean;
  readonly ppq?: number;
  /**
   * Give every part its own fifteen member channels instead of sharing them.
   *
   * ⚠️ **This is safe in a DAW and unsafe in a player.** A file's tracks share
   * one set of sixteen channels -- the channel is in the status byte, not the
   * track -- so two parts on channel 5 are the same channel 5 to anything that
   * plays the file as one stream. But a DAW that imports a format 1 file as
   * SEPARATE TRACKS gives each one its own instrument, and that instrument only
   * ever sees its own track's events: Reaper does this, and so does every other
   * DAW that lands one MIDI track per project track. There the parts never meet,
   * and the fifteen channels are fifteen per part.
   *
   * What it buys, over the corpus: nothing is dragged at all and the notes that
   * lose a glide fall from 1,535 to 825 -- the same as writing one file per
   * part, without the 4,909 files.
   *
   * What it costs: played as a single stream -- a hardware module, a simple
   * player, Reaper asked to import as one track -- parts collide on the same
   * channels, and two notes of one pitch there have indistinguishable note-offs.
   * So it is off by default.
   */
  readonly channelsPerPart?: boolean;
  /**
   * A GUID to a readable instrument name, for the track names.
   *
   * ⚠️ **`PInstrument` has no name field worth printing.** `Track.name` comes
   * from the Thing and is empty on every placement of all 22 corpus levels, so
   * without this a DAW shows `guid 148321` and nobody can tell it is the drum
   * kit. The caller has the resolver -- the extracted `.rinst` manifest -- and
   * this module has no business fetching anything.
   */
  readonly instrumentName?: (guid: number) => string | undefined;
  /**
   * How often a glide is resampled, in steps; 0 writes only the control points.
   *
   * ⚠️ **A glide written as two events is not a glide.** The engine ramps
   * linearly between control points; MIDI pitch bend holds its value until the
   * next message, so two events an octave apart are a step, not a slide. The
   * resampling is what turns one into the other, and the import folds it back
   * up again -- collinear points are dropped, so a round trip returns the two
   * points it started with.
   *
   * ⚠️ **It is rounded to a multiple of a third of a step, and that is not
   * a detail.** A record's position is `step + subStep/3`, so a third is the
   * finest place an imported point can land. Resampling on quarters -- which
   * this did, and which is the obvious choice -- puts the sample taken at 0.25
   * onto the record at 1/3, where its value is simply wrong: a fade measured at
   * a quarter of the way in, filed as though it were a third of the way in. The
   * round trip came back at volume 4 where the file said 5.29, and the
   * off-grid points could not be simplified away either, so a two-point glide
   * returned as ten.
   */
  readonly glideStep?: number;
}

export interface MidiExportResult {
  readonly bytes: Uint8Array;
  readonly notes: number;
  /** MIDI tracks written, not counting the conductor. */
  readonly parts: number;
  readonly events: number;
  /** Notes that had to share a member channel because all 15 were busy. */
  readonly sharedChannel: number;
  /**
   * Sharers that a neighbour's bend actually reaches.
   *
   * A subset of `sharedChannel`, and much the smaller number: most sharing is
   * free, because the channel is not being bent while the sharer sounds. These
   * are the ones a synth will pull out of tune -- this file's own importer
   * knows whose the bend is and is not fooled.
   */
  readonly dragged: number;
  /**
   * Notes whose timbre a sharer's CC 74 moved.
   *
   * A sharer keeps its own modulation -- losing it reads every `Params` range
   * from the wrong end -- at the cost of overwriting the modulation of whatever
   * is already on the channel. These are the notes that paid for that.
   */
  readonly timbred: number;
  /** Notes whose pitch left MIDI's 0..127 and was clamped to it. */
  readonly clampedPitch: number;
  /** Control points whose bend exceeded the range and was clamped. */
  readonly clampedBend: number;
  /** Notes whose glides could not be written, in plain (non-MPE) mode. */
  readonly droppedGlides: number;
  /**
   * Notes that had to share a channel AND carried a glide, so lost it.
   *
   * A subset of `sharedChannel`. Sharing costs a note its expression because
   * bend and pressure belong to the channel, not to the note -- see the note
   * in `sequencerToMidi` where it happens.
   */
  readonly flattened: number;
  /**
   * Notes MPE could not carry at all.
   *
   * Only one thing produces these: more than fifteen copies of the SAME pitch
   * sounding at once, which leaves no channel where the note could be told
   * apart from one already there. Sixteen unisons is not something a person
   * plays, but a level can hold one, and dropping notes without saying so is
   * how a converter earns its reputation.
   */
  readonly dropped: number;
}

const clamp7 = (v: number) => (v < 0 ? 0 : v > 127 ? 127 : Math.round(v));

/**
 * The note's modulation onto CC 74, and back.
 *
 * ⚠️ **It is a FOUR-bit field**, `(byte3 & 0x0f) / 15`, riding on a seven-bit
 * controller. The pair below is exact over all sixteen values -- `test/midi.test.ts`
 * checks every one -- which is what lets a round trip return the same nibble
 * rather than one a step away.
 */
const modTo7 = (mod: number) => clamp7(mod * 127);
const modFrom7 = (value: number) => value / 127;

/**
 * What has to happen first when several things land on one tick.
 *
 * ⚠️ **Notes are not written in time order any more.** Gliding notes are
 * allocated before flat ones, so a flat note ending at tick T is written after
 * a gliding note starting at T, and push order would put the note-on first. A
 * reader pairing by channel and pitch then ends the note that just began -- a
 * held note came back one step long, 728 of them across the corpus.
 *
 * The order is: what the track says, then everything that is finishing, then
 * the expression a starting note is about to need, then the notes themselves.
 * CC 74 rides with the note-on rather than with the other expression, because
 * it is read per note at the note-on and separating them lets a neighbour's
 * timbre be picked up instead.
 */
const rank = (event: MidiEvent): number => {
  const status = event.data[0];
  if (status === 0xff || status === 0xf0 || status === 0xf7) return 0;
  const kind = status & 0xf0;
  if (kind === 0x80) return 1;
  if (kind === 0xe0 || kind === 0xd0) return 2;
  return 3;
};

/* ------------------------------------------------------------------- export */

/**
 * The distinct voices in a sequencer: what a listener would call a part.
 *
 * A sequencer holds one placement per board cell, so `Ascetic` has 1150 of
 * them -- writing a MIDI track each would be unreadable in any DAW. Clips that
 * share an instrument, a row and every mixer setting are the same part played
 * at different times, and `stepOffset` is already absolute in the schedule, so
 * they merge. The 1150 become a handful.
 */
interface Part {
  readonly track: Track;
  readonly tracks: number[];
  /**
   * Each clip as `[gridX, steps]`, the cell it sits in and how far its own
   * notes reach.
   *
   * ⚠️ **The length is what makes the layout recoverable.** Clips of one part
   * overlap heavily -- a cell is 16 steps and a clip may hold 128 -- so on the
   * cells alone **86.50% of the corpus's notes fit more than one clip** and an
   * importer has to guess. With each clip's own extent as well that falls to
   * **0.09%**: 99.91% of notes fit exactly one. One number per clip.
   */
  readonly clips: [number, number][];
}

function partsOf(sequencer: Sequencer): Part[] {
  const byKey = new Map<string, Part>();
  sequencer.tracks.forEach((track, index) => {
    const key = [
      track.guid, track.gridY, track.level, track.pan,
      track.echoSend, track.reverbSend, track.key, track.scale,
    ].join('|');
    // How far the clip's own notes reach, which is its window.
    const steps = Math.min(
      128,
      Math.max(1, track.notes.reduce((most, note) => Math.max(most, note.endStep + 1), 0)),
    );
    const found = byKey.get(key);
    if (found) {
      found.tracks.push(index);
      found.clips.push([track.gridX, steps]);
    } else {
      byKey.set(key, { track, tracks: [index], clips: [[track.gridX, steps]] });
    }
  });
  return [...byKey.values()];
}

/**
 * Member channels for one MPE lower zone: master on 1, notes on 2..16.
 *
 * Zero-based here, so the master is 0 and the members are 1..15.
 */
const MEMBERS = Array.from({ length: 15 }, (_, i) => i + 1);
/** Channel 1, zero-based. It carries the zone's settings and, at a pinch, notes. */
const MASTER = 0;

/**
 * Which member channel each note gets.
 *
 * ⚠️ **Two notes of the same pitch must never share a channel**, whatever else
 * has to give: their note-offs are indistinguishable, so the second would end
 * the first and leave the second hanging. Everything below is arranged around
 * that one invariant -- a free channel when there is one, the emptiest safe
 * channel when there is not, and a refusal when even that is impossible.
 */
interface Span {
  readonly note: number;
  readonly from: number;
  readonly until: number;
  /** The note's modulation, to see whose timbre a newcomer's CC 74 moves. */
  readonly mod: number;
  /** Set once this note's timbre has been moved by somebody else's CC 74. */
  disturbed: boolean;
  gliding: boolean;
  /** Give up this span's glide, because something had to be placed in front. */
  demote(): void;
}

class VoicePool {
  /** Every span ever placed, per member channel. Append-only; see `rewind`. */
  private readonly placed: Span[][];
  /** The ones that can still overlap what is being asked about now. */
  private live: Span[][];
  /** The same two lists for the master channel, which is the overflow. */
  private readonly placedMaster: Span[] = [];
  private liveMaster: Span[] = [];
  private readonly freedAt: number[];
  shared = 0;
  refused = 0;
  /** Glides given up so that a note could be placed in front of them. */
  demoted = 0;
  /** Sharers that will hear somebody else's bend; see `take`. */
  dragged = 0;
  /**
   * Notes whose timbre a newcomer's CC 74 moves.
   *
   * ⚠️ **The other direction from `dragged`.** A sharer writes no bend and no
   * pressure but it does write its modulation, because losing that reads every
   * `Params` range from the wrong end. The price is that the note already on
   * the channel has its own modulation overwritten -- unless the two agree,
   * which they usually do, 80.74% of records being 0.
   */
  timbred = 0;

  constructor() {
    this.placed = MEMBERS.map(() => []);
    this.live = MEMBERS.map(() => []);
    this.freedAt = MEMBERS.map(() => 0);
  }

  /**
   * Start the clock again at zero without forgetting anything.
   *
   * \u26a0\ufe0f **The second pass goes back to the beginning of the song**, and the
   * live lists are pruned as the tick advances -- so without this they would be
   * empty of everything the first pass placed early, and flat notes would be
   * handed channels that gliding notes were already sounding on. Two notes of
   * one pitch then landed on one channel, whose note-offs are indistinguishable,
   * and the corpus check went from 0 sequencers disagreeing to 111.
   */
  rewind(): void {
    this.live = this.placed.map((spans) => [...spans]);
    this.liveMaster = [...this.placedMaster];
  }

  /**
   * `gliding` says whether this note will write bend and pressure of its own,
   * which is what makes exclusivity worth spending a channel on.
   */
  /**
   * Count a note whose timbre somebody else's CC 74 moved -- once, not once per
   * neighbour. A busy channel would otherwise report 434,674 casualties among
   * its 27,210 sharers, which is a count of disturbances and not of notes.
   */
  private disturb(span: Span): void {
    if (span.disturbed) return;
    span.disturbed = true;
    this.timbred += 1;
  }

  take(
    tick: number,
    note: number,
    until: number,
    gliding: boolean,
    mod: number,
    placement: { exclusive: boolean },
  ): { channel: number; exclusive: boolean } {
    // Pruning is by `until <= tick` only -- correct because the tick only moves
    // forward within a pass. What is left may still start after this note ends,
    // so the overlap test needs both ends.
    const clashes = (span: Span) => span.from < until;
    let free = -1;
    for (let i = 0; i < MEMBERS.length; i += 1) {
      this.live[i] = this.live[i].filter((b) => b.until > tick);
      // Least recently freed first, so channels rotate: a receiver's release
      // tail on the channel it just let go is the one thing round-robin buys.
      if (!this.live[i].some(clashes) && (free < 0 || this.freedAt[i] < this.freedAt[free])) {
        free = i;
      }
    }
    let best = free;
    let exclusive = true;
    if (best < 0) {
      /*
       * Nothing free, so something has to give. What follows tries the ways of
       * sharing in order of what they cost.
       *
       * ⚠️ **A sharer writes no expression of its own**, because bend and
       * pressure belong to the channel and setting them would drag whatever is
       * already sounding there. So a reader can only tell whose the channel's
       * bend is by asking who arrived first -- and that answer is only useful if
       * the note with the glide is always the earlier one. When a flat note was
       * allowed to start in front of a glide, the glide lost its whole tail: in
       * `Rain` a 32-step fade stopped at volume 30 instead of reaching 0,
       * because the newcomer had claimed the channel and the rest of the ramp
       * went to it.
       *
       *   QUIET     a channel nobody is bending at all
       *   MASTER    channel 1, which MPE lets carry notes and where nothing is
       *             ever bent, so a note parked there is never dragged
       *   BEHIND    one whose glides all began before this note. Our own
       *             importer knows whose the bend is (see `owners`), but a
       *             synth does not: this note WILL be dragged by it, which is
       *             what `dragged` counts and why the master comes first.
       *   DISPLACE  a channel where a glide has to be given up for this note
       *
       * The last one is a real loss and is counted. Refusing instead of
       * displacing cost 426 notes across the corpus, and a lost note is worse
       * than a lost glide.
       */
      const inFront = (i: number) =>
        this.live[i].filter(clashes).filter((b) => b.gliding && b.from > tick);

      for (const how of ['quiet', 'master', 'behind', 'displace'] as const) {
        if (how === 'master') {
          this.liveMaster = this.liveMaster.filter((b) => b.until > tick);
          if (this.liveMaster.some((b) => b.note === note && b.from < until)) continue;
          const span: Span = {
            note, from: tick, until, mod, disturbed: false, gliding: false, demote: () => {},
          };
          for (const other of this.liveMaster) if (other.mod !== mod) this.disturb(other);
          this.liveMaster.push(span);
          this.placedMaster.push(span);
          this.shared += 1;
          return { channel: MASTER, exclusive: false };
        }
        for (let i = 0; i < MEMBERS.length; i += 1) {
          const here = this.live[i].filter(clashes);
          // Never two of one pitch on a channel: their note-offs are the same
          // three bytes, so the second would end the first.
          if (here.some((b) => b.note === note)) continue;
          if (how === 'quiet' && here.some((b) => b.gliding)) continue;
          if (how !== 'displace' && inFront(i).length > 0) continue;
          if (best < 0) {
            best = i;
          } else if (
            how === 'displace'
              ? inFront(i).length < inFront(best).length
              : here.length < this.live[best].filter(clashes).length
          ) {
            best = i;
          }
        }
        if (best >= 0) {
          // Whatever this displaces stops being a glide: its owner is rewritten
          // flat, which is why allocation happens before anything is written.
          for (const span of inFront(best)) span.demote();
          break;
        }
      }
      if (best < 0) {
        // ⚠️ **Last resort: the master channel.** Fifteen member channels all
        // holding this pitch already leaves nowhere to put it that a note-off
        // could tell apart -- and MPE allows notes on the master channel, which
        // is exactly what it is for. They get no per-note expression there,
        // which costs nothing: a note that reaches this point had none to give.
        // Four notes in the corpus's 953,791 land here, all in one unison-heavy
        // passage of `Avian`, and before this they were dropped outright.
        this.liveMaster = this.liveMaster.filter((b) => b.until > tick);
        if (this.liveMaster.some((b) => b.note === note && b.from < until)) {
          this.refused += 1;
          return { channel: -1, exclusive: false };
        }
        const onMaster: Span = {
          note, from: tick, until, mod, disturbed: false, gliding: false, demote: () => {},
        };
        for (const other of this.liveMaster) if (other.mod !== mod) this.disturb(other);
        this.liveMaster.push(onMaster);
        this.placedMaster.push(onMaster);
        this.shared += 1;
        return { channel: MASTER, exclusive: false };
      }
      this.shared += 1;
      exclusive = false;
      // ⚠️ **Sharing a channel is usually free, and the raw count says
      // otherwise.** On `Ascetic` 124 notes share and only 18 of them ever have
      // a bend land on their channel; the rest sit on one that stays centred for
      // their whole life and lose nothing at all. This is the number worth
      // showing anyone.
      if (this.live[best].filter(clashes).some((b) => b.gliding)) this.dragged += 1;
      // And whoever is already here and disagrees about the modulation has its
      // own timbre moved by this note's CC 74 -- the other direction.
      for (const other of this.live[best].filter(clashes)) {
        if (other.mod !== mod) this.disturb(other);
      }
    }
    const span: Span = {
      note, from: tick, until, mod, disturbed: false, gliding: gliding && exclusive,
      demote: () => {
        if (!span.gliding) return;
        span.gliding = false;
        this.demoted += 1;
        placement.exclusive = false;
      },
    };
    this.live[best].push(span);
    this.placed[best].push(span);
    this.freedAt[best] = Math.max(this.freedAt[best], until);
    return { channel: MEMBERS[best], exclusive };
  }
}

/**
 * A range wide enough for the music, and no wider.
 *
 * ⚠️ **MPE's default of 48 semitones is not enough for this corpus.** 582 of
 * its 1,448,224 control points glide further than that -- the widest is 62 --
 * and a clamped bend is a note that arrives at the wrong pitch. Nothing reaches
 * 96, which is MIDI's own ceiling for the range, so widening only when the
 * music asks costs the ordinary file nothing: 48 stays 48, and the resolution
 * that comes with it stays too.
 */
function widestBend(sequencer: Sequencer): number {
  let widest = 0;
  for (const event of schedule(sequencer)) {
    if (!event.hasPitchAutomation) continue;
    const track = sequencer.tracks[event.track];
    const root = blockRoot(track.key);
    const base = notePitch(event.pitch, track.scale, root);
    for (const point of event.points) {
      widest = Math.max(widest, Math.abs(notePitch(point.pitch, track.scale, root) - base));
    }
  }
  return Math.max(DEFAULT_BEND_RANGE, Math.ceil(widest));
}

export function sequencerToMidi(
  sequencer: Sequencer,
  options: MidiExportOptions = {},
): MidiExportResult {
  const mpe = options.mpe ?? true;
  const bendRange = Math.max(
    1,
    Math.min(96, Math.round(options.bendRange ?? widestBend(sequencer))),
  );
  const ppq = options.ppq ?? DEFAULT_PPQ;
  const bakeSwing = options.bakeSwing ?? false;
  // Thirds of a step, always: see `glideStep`.
  const glideThirds = Math.max(1, Math.round((options.glideStep ?? 1 / 3) * 3));
  const ticksPerStep = ppq / STEPS_PER_QUARTER;

  const at = (position: number) =>
    Math.round(bakeSwing ? swungFrame(position, ticksPerStep, sequencer.swing) : position * ticksPerStep);

  const nameOf = (track: Track) =>
    track.name || options.instrumentName?.(track.guid) || `guid ${track.guid}`;
  const parts = partsOf(sequencer);
  const partOfTrack = new Map<number, number>();
  parts.forEach((part, index) => {
    for (const track of part.tracks) partOfTrack.set(track, index);
  });

  /**
   * One pool, or one per lane; see `channelsPerPart`.
   *
   * The counters are summed over whatever pools exist, so the rest of the
   * function does not need to know which arrangement it is in.
   */
  const perPart = options.channelsPerPart ?? false;
  const pools = new Map<number, VoicePool>();
  const poolFor = (lane: number) => {
    const key = perPart ? lane : -1;
    const found = pools.get(key);
    if (found) return found;
    const made = new VoicePool();
    pools.set(key, made);
    return made;
  };
  const tally = (pick: (p: VoicePool) => number) =>
    [...pools.values()].reduce((sum, p) => sum + pick(p), 0);
  let clampedPitch = 0;
  let clampedBend = 0;
  let droppedGlides = 0;
  let flattened = 0;
  let notes = 0;

  // Plain mode spends channels on instruments instead of on notes. Channel 10
  // is skipped: nothing here is General MIDI, but every DAW will treat it as
  // percussion, and a part that silently becomes a drum kit is a bad surprise.
  const plainChannels = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15];

  // ⚠️ The test is on the SEMITONES, not on the 14-bit value. A glide of
  // exactly `bendRange` maps to 16384, one past the top of the range, and
  // saturating there costs 1/8192 of the range -- 0.008 semitones at 62, which
  // is nothing. Counting it as a clamped bend reported 120 casualties in a
  // corpus that has none.
  const bendValue = (semitones: number) => {
    if (Math.abs(semitones) > bendRange + 1e-9) clampedBend += 1;
    return 8192 + (semitones / bendRange) * 8192;
  };

  /**
   * Which notes need a channel to themselves.
   *
   * ⚠️ **The order these are allocated in is the whole of the shared-channel
   * problem.** A zone has fifteen member channels and this engine has
   * thirty-two voices, so a dense passage runs out -- but only 9.3% of notes
   * carry a glide, and measured across the corpus only **1,172 notes arrive
   * while more than fifteen glides are already sounding**. Allocating in plain
   * time order let a flat note take the last channel a moment before a gliding
   * one needed it, and 3,593 notes lost a glide where at most 1,172 had to.
   * Two passes, the gliding notes first, is the fix.
   *
   * A note that opens at volume zero counts too: MIDI has no note-on velocity
   * of 0, so its opening level has to travel as pressure, which only an
   * exclusive channel may write.
   */
  const needsChannel = (event: ScheduledNote) =>
    event.hasPitchAutomation ||
    event.hasVolumeAutomation ||
    // ⚠️ **The modulation counts too, and leaving it out was a silent loss.**
    // It rides on CC 74, which belongs to the channel exactly as bend and
    // pressure do, so a note that ramps it needs a channel of its own for the
    // same reason. Without this, a note whose pitch and volume are flat but
    // whose modulation moves was allocated as flat -- and if it then had to
    // share, it lost the ramp with nothing counting it. That is where shared
    // mode's undeclared notes came from, once the corpus check started looking
    // at the modulation at all.
    event.points.some((point) => point.modulation !== event.points[0].modulation) ||
    clamp7(event.volume) === 0;

  const all = schedule(sequencer);

  /**
   * Which MIDI track each note is written to.
   *
   * ⚠️ **A part is not always one track.** Fifteen member channels is the
   * ceiling on how many notes of a part can sound at once and keep their own
   * bend, and a part can pass it on its own -- the corpus's busiest single part
   * reaches 26. Splitting such a part across two tracks gives it thirty, and a
   * DAW that lands one project track per MIDI track plays them on two instances
   * of the same instrument, which is the same sound. Without this, 825 notes
   * lost a glide with nowhere else they could have gone.
   *
   * The split is by NOTE, not by clip: a single clip can be polyphonic enough on
   * its own. Greedy in time order into the first lane with room, which is
   * optimal for intervals.
   *
   * Only in `channelsPerPart`. Sharing one pool across the file makes extra
   * tracks pure cost, since they compete for the same fifteen channels either
   * way, and the import merges them back regardless.
   */
  const laneOf = new Map<ScheduledNote, number>();
  const laneCount = parts.map(() => 1);
  if (perPart) {
    const byPart: ScheduledNote[][] = parts.map(() => []);
    for (const event of all) {
      const part = partOfTrack.get(event.track);
      if (part !== undefined) byPart[part].push(event);
    }
    byPart.forEach((own, index) => {
      const sounding: number[][] = [];
      for (const event of own) {
        const from = at(event.step);
        const until = Math.max(from + 1, at(event.step + event.durationSteps));
        let lane = 0;
        while (lane < sounding.length) {
          sounding[lane] = sounding[lane].filter((end) => end > from);
          if (sounding[lane].length < MEMBERS.length) break;
          lane += 1;
        }
        if (lane === sounding.length) sounding.push([]);
        sounding[lane].push(until);
        laneOf.set(event, lane);
      }
      laneCount[index] = Math.max(1, sounding.length);
    });
  }
  /** Where each part's lanes begin in `bodies`. */
  const laneBase: number[] = [];
  let bodyCount = 0;
  for (const count of laneCount) {
    laneBase.push(bodyCount);
    bodyCount += count;
  }
  const bodies: MidiEvent[][] = Array.from({ length: bodyCount }, () => []);
  const bodyOf = (event: ScheduledNote): number | undefined => {
    const part = partOfTrack.get(event.track);
    return part === undefined ? undefined : laneBase[part] + (laneOf.get(event) ?? 0);
  };

  const gliding = all.filter(needsChannel);
  const flat = all.filter((e) => !needsChannel(e));
  const order = [...gliding, ...flat];

  /**
   * Who gets a channel, decided before anything is written.
   *
   * ⚠️ **Allocating and writing have to be separate steps.** Placing a note
   * can take the exclusivity away from one already placed -- see `demote` -- and
   * a loop that wrote as it went would already have written that note's glide.
   */
  const placements = new Map<ScheduledNote, { channel: number; exclusive: boolean; base: number }>();
  if (mpe) {
    for (const event of order) {
      if (event === flat[0]) for (const p of pools.values()) p.rewind();
      const body = bodyOf(event);
      if (body === undefined) continue;
      const track = sequencer.tracks[event.track];
      const value = notePitch(event.pitch, track.scale, blockRoot(track.key));
      if (value < 0 || value > 127) clampedPitch += 1;
      const base = clamp7(value);
      const startTick = at(event.step);
      const endTick = Math.max(startTick + 1, at(event.step + event.durationSteps));
      const place = { channel: -1, exclusive: true, base };
      const taken = poolFor(body).take(
        startTick, base, endTick, needsChannel(event), event.modulation, place,
      );
      place.channel = taken.channel;
      place.exclusive = place.exclusive && taken.exclusive;
      placements.set(event, place);
    }
  }

  for (const event of order) {
    const partIndex = bodyOf(event);
    if (partIndex === undefined) continue;
    const track = sequencer.tracks[event.track];
    const root = blockRoot(track.key);
    // ❗ The pitch clamp is counted during allocation, not here: this runs over
    // the same notes a second time and would double every casualty.
    const toMidi = (raw: number) => clamp7(notePitch(raw, track.scale, root));

    const place = placements.get(event);
    const base = place ? place.base : toMidi(event.pitch);
    const startTick = at(event.step);
    const endTick = Math.max(startTick + 1, at(event.step + event.durationSteps));
    const out = bodies[partIndex];

    if (!mpe) {
      const channel = plainChannels[partIndex % plainChannels.length];
      out.push(noteOn(startTick, channel, base, Math.max(1, clamp7(event.volume))));
      out.push(noteOff(endTick, channel, base));
      if (event.hasPitchAutomation || event.hasVolumeAutomation) droppedGlides += 1;
      notes += 1;
      continue;
    }

    if (place === undefined || place.channel < 0) continue;
    const { channel, exclusive } = place;

    // ⚠️ **Points that share a position collapse, and the LAST one wins.**
    // The engine's interpolator is `t = span > 0 ? (elapsed - from) / span : 1`,
    // so a zero-length segment is taken at its far end the instant it arrives --
    // two records on the same step are authoring debris and the later value is
    // the one that sounds. Written naively they became a glide of zero length
    // whose every sample fell on the note's own start tick and was skipped, so
    // the second value was simply dropped: a note written 17 then 16 came back
    // as 17.
    const raw = event.points.map((p) => ({
      step: p.step,
      semitones: toMidi(p.pitch) - base,
      volume: p.volume,
      // ⚠️ **Per point, because the engine ramps it.** `sub_0x3930` writes a
      // slide rate for the modulation beside the ones for volume and pitch and
      // `sub_0x1c60` advances it every chunk, so a note that moves it changes
      // its filter, level, LFOs and drive as it sounds. Carrying only the
      // opening value lost that on 34,449 corpus notes -- every one of them.
      modulation: p.modulation,
    }));
    const points: typeof raw = [];
    for (const point of raw) {
      const last = points[points.length - 1];
      // ⚠️ **Only at the note's own start.** A coincident pair anywhere else
      // is a value that JUMPS at that instant, and the zero-length segment
      // below writes exactly that -- but a pair at position 0 would write both
      // of its samples onto the note-on's own tick, where they are skipped, so
      // that one collapses and the import rebuilds it from the opening bend.
      //
      // Collapsing everywhere erased the segment *leading into* the pair: a
      // note in `Diode` that dives from 68 to 37 over two steps and snaps back
      // came out flat at 68, because dropping the (6, 37) record left the ramp
      // before it with nowhere to go. It was the last two notes in the corpus
      // whose curve the round trip could not explain.
      if (last !== undefined && last.step === point.step && point.step === 0) {
        points[points.length - 1] = point;
      } else {
        points.push(point);
      }
    }
    const opening = points[0];

    // MPE's own ordering: the note's opening expression, then the note-on. A
    // receiver that saw the note first would sound one frame of it unbent.
    // ⚠️ `opening.modulation`, not the note's first record's. Coincident
    // points collapse to the later one -- see above -- and the bend and the
    // pressure both send the collapsed value, so sending the first record's
    // modulation here made the file disagree with itself: pitch and volume from
    // one record, modulation from another. What the engine sounds is the
    // collapsed one, from the instant the note starts.
    out.push(controlChange(startTick, channel, 74, modTo7(opening.modulation)));
    if (exclusive) {
      out.push(pitchBend(startTick, channel, bendValue(opening.semitones)));
      out.push(channelPressure(startTick, channel, clamp7(opening.volume)));
    }
    out.push(noteOn(startTick, channel, base, Math.max(1, clamp7(opening.volume))));

    // ❗ **A sharer still writes its CC 74**, unlike its bend and its pressure,
    // and that is a deliberate asymmetry. Losing a note's modulation outright
    // means every `Params` range reads from the wrong end -- a wrong cutoff, a
    // wrong resonance, wrong envelope times, all at once -- where the cost of
    // writing it is that a neighbour's timbre moves for as long as this note
    // lasts. 80.74% of records carry modulation 0, so in most sharing the value
    // written is the value already there and nothing moves at all.
    //
    // ⚠️ **A note sharing a channel writes no bend and no pressure at all.**
    // Both are per channel, so a newcomer that reset them to its own values
    // would drag whatever is already sounding there with it -- and the note
    // already there is, by construction, the one that got the channel to itself
    // and was written with its full glide. This was not hypothetical: in
    // `Twitch` a flat note at step 1062 came back four semitones sharp, having
    // inherited the tail of somebody else's slide. Its own expression is lost
    // instead, which is the smaller lie and is counted as `flattened`.
    if (!exclusive) {
      // ⚠️ **A silent opening counts too, not just a glide.** A shared note's
      // volume has to ride on its note-on velocity, and MIDI has no velocity 0 --
      // that byte is a note-off. So a note written at volume 0 comes back at 1,
      // and it is only ever 0 in the first place as the foot of a fade-in, which
      // is a shape worth being honest about losing.
      if (needsChannel(event)) flattened += 1;
      out.push(noteOff(endTick, channel, base));
      notes += 1;
      continue;
    }

    for (let i = 0; i + 1 < points.length; i += 1) {
      const from = points[i];
      const to = points[i + 1];
      const moves =
        from.semitones !== to.semitones ||
        from.volume !== to.volume ||
        from.modulation !== to.modulation;
      if (!moves) continue;
      const span = to.step - from.step;
      // Spans are whole thirds, because both ends are `step + subStep/3`.
      const thirds = Math.round(span * 3);
      const steps = thirds > 0 ? Math.max(1, Math.round(thirds / glideThirds)) : 1;
      // ⚠️ **From k = 0, not k = 1: a moving segment has to state where it
      // starts.** A segment where nothing moves writes no events at all, which
      // is right -- the value simply holds -- but it means the next segment's
      // opening value has never been sent. A note that sat at volume 96 for two
      // steps and then faded to nothing came back fading from the very first
      // frame, because the import saw 96 at the note-on and 0 at the end and had
      // no reason to believe there was a plateau between them.
      for (let k = 0; k <= steps; k += 1) {
        const t = k / steps;
        const position = from.step + span * t;
        const tick = at(event.step + position);
        if (tick <= startTick || tick >= endTick) continue;
        const semitones = from.semitones + (to.semitones - from.semitones) * t;
        const volume = from.volume + (to.volume - from.volume) * t;
        const modulation = from.modulation + (to.modulation - from.modulation) * t;
        if (from.semitones !== to.semitones) {
          out.push(pitchBend(tick, channel, bendValue(semitones)));
        }
        if (from.volume !== to.volume) {
          out.push(channelPressure(tick, channel, clamp7(volume)));
        }
        if (from.modulation !== to.modulation) {
          out.push(controlChange(tick, channel, 74, modTo7(modulation)));
        }
      }
    }
    out.push(noteOff(endTick, channel, base));
    // ⚠️ **A glide is undone when it ends.** Nothing else resets a member
    // channel, so the next note to land there would inherit the bend this one
    // finished on -- and a note that shares the channel while this one is still
    // sounding is being dragged by it until this fires. An exclusive note sets
    // its own bend on the way in, so this only matters for the ones that cannot.
    if (points.length > 1 && points[points.length - 1].semitones !== 0) {
      out.push(pitchBend(endTick, channel, bendValue(0)));
    }
    notes += 1;
  }

  /* --------------------------------------------------------- the conductor */
  const head: MidiEvent[] = [
    metaText(0, 0x03, sequencer.name || 'LBP sequencer'),
    tempoEvent(0, sequencer.tempo),
    timeSignature(0, 4, 2),
    metaText(0, 0x01, SEQ_TAG + JSON.stringify({
      v: 1,
      uid: sequencer.uid,
      name: sequencer.name,
      tempo: sequencer.tempo,
      swing: sequencer.swing,
      swingBaked: bakeSwing,
      echoFeedback: sequencer.echoFeedback,
      echoTime: sequencer.echoTime,
      echoMix: sequencer.echoMix,
      reverb: sequencer.reverb,
      loop: sequencer.loop,
      startPoint: sequencer.startPoint,
      numChannels: sequencer.numChannels,
      volumes: sequencer.volumes,
      stepsPerQuarter: STEPS_PER_QUARTER,
      bendRange,
      mpe,
    })),
  ];
  if (mpe) {
    // The MPE Configuration Message -- RPN 6 on the master channel -- then the
    // bend range. RPN 0 goes on the first member channel, which is where a
    // zone's own range is set, and on the master for its own smaller one.
    head.push(
      controlChange(0, 0, 101, 0), controlChange(0, 0, 100, 6), controlChange(0, 0, 6, 15),
      controlChange(0, 1, 101, 0), controlChange(0, 1, 100, 0), controlChange(0, 1, 6, bendRange),
      controlChange(0, 0, 101, 0), controlChange(0, 0, 100, 0), controlChange(0, 0, 6, 2),
    );
  }

  const tracks: MidiTrack[] = [{ events: sortEvents(head, rank) }];
  parts.forEach((part, index) => {
    const t = part.track;
    for (let lane = 0; lane < laneCount[index]; lane += 1) {
      // A lane is a continuation of the part, and says so in both places: the
      // name so a DAW's track list reads, and the meta so the import merges.
      const label = laneCount[index] > 1 ? `${nameOf(t)} (${lane + 1})` : nameOf(t);
      const header: MidiEvent[] = [
        metaText(0, 0x03, label),
        metaText(0, 0x01, TRK_TAG + JSON.stringify({
          guid: t.guid, name: nameOf(t), gridY: t.gridY,
          level: t.level, pan: t.pan, echoSend: t.echoSend, reverbSend: t.reverbSend,
          key: t.key, scale: t.scale, clips: part.clips,
          ...(laneCount[index] > 1 ? { lane } : {}),
        })),
      ];
      tracks.push({ events: [...header, ...sortEvents(bodies[laneBase[index] + lane], rank)] });
    }
  });

  const bytes = writeMidi({ format: 1, division: ppq, tracks });
  return {
    bytes,
    notes,
    parts: parts.length,
    events: tracks.reduce((sum, t) => sum + t.events.length, 0),
    sharedChannel: tally((p) => p.shared),
    dragged: tally((p) => p.dragged),
    timbred: tally((p) => p.timbred),
    flattened,
    clampedPitch,
    clampedBend,
    droppedGlides,
    dropped: tally((p) => p.refused),
  };
}

/* ------------------------------------------------------------------- import */

export interface MidiImportResult {
  readonly sequencer: Sequencer;
  /** True when the file carried this project's own meta events. */
  readonly ours: boolean;
  readonly notes: number;
  /** Notes shorter than the sixteenth grid, lengthened to one step. */
  readonly lengthened: number;
  /** Notes dropped because their part ran past a clip and could not be cut. */
  readonly dropped: number;
  /** Note-ons with no matching note-off, ended at the last event instead. */
  readonly unmatched: number;
  readonly clips: number;
}

interface RawNote {
  readonly channel: number;
  readonly note: number;
  readonly velocity: number;
  /**
   * The pressure and bend sent AT the note-on's own tick, if any.
   *
   * ⚠️ **This is how a note that opens at volume zero survives.** MIDI has no
   * note-on velocity of 0 -- that byte means note-off -- so the opening volume
   * of a fade-in cannot ride on the velocity and travels as the pressure MPE
   * puts immediately before the note. Reading it back off the velocity instead
   * returned volume 1, and the one-unit error then moved the reference line
   * under every resampled point of the glide: a two-point fade came back as
   * eighteen, and a re-export would have grown it again. `Northern Lights`
   * opens 96 of its notes at zero.
   */
  readonly opening?: number;
  readonly openingBend?: number;
  readonly startTick: number;
  endTick: number;
  readonly modulation: number;
  /** Bend, pressure and CC 74 while it sounded, absolute ticks. */
  readonly bends: { tick: number; semitones: number }[];
  readonly presses: { tick: number; volume: number }[];
  readonly mods: { tick: number; value: number }[];
}

/** A part being assembled, before it is cut into clips. */
interface RawPart {
  name: string;
  guid: number;
  gridY: number;
  level: number;
  pan: number;
  echoSend: number;
  reverbSend: number;
  key: number;
  scale: number;
  /** The clips this part had, `[gridX, steps]`, when the file remembers them. */
  cells: [number, number][];
  notes: RawNote[];
}

/**
 * Neutral placement settings for a file that is not ours.
 *
 * ⚠️ These are choices, not measurements. The game's own defaults for a fresh
 * instrument have not been read out of it, and inventing numbers that look
 * measured is how a guess becomes a fact. Unity level, centred, no sends.
 */
const NEUTRAL = { level: 1, pan: 0.5, echoSend: 0, reverbSend: 0 };

/**
 * Key 12 and scale 0: `notePitch(p, 0, blockRoot(12)) === p`.
 *
 * That identity is the whole of the pitch import. `blockRoot(12)` is 12 and the
 * chromatic scale passes notes through, so a record's pitch field IS the MIDI
 * note number and nothing has to be inverted. Anything else would need
 * `quantise` run backwards, which has no inverse -- several notes snap to one.
 */
const CHROMATIC_C = { key: 12, scale: 0 };

export function midiToSequencer(bytes: Uint8Array, fallbackName = 'imported'): MidiImportResult {
  const file = readMidi(bytes);
  const ticksPerStep = file.division / STEPS_PER_QUARTER;

  let tempo = 120;
  let header: Record<string, unknown> | undefined;
  for (const track of file.tracks) {
    for (const event of track.events) {
      const found = tempoFrom(event);
      if (found !== undefined && header === undefined) tempo = found;
      const text = metaString(event);
      if (text?.type === 0x01 && text.text.startsWith(SEQ_TAG)) {
        try {
          header = JSON.parse(text.text.slice(SEQ_TAG.length)) as Record<string, unknown>;
        } catch {
          // A meta event we cannot parse is a file from somewhere else that
          // happens to start with our tag. Fall through to the generic path.
        }
      }
    }
  }
  const num = (key: string, fallback: number) =>
    typeof header?.[key] === 'number' ? (header[key] as number) : fallback;
  if (header !== undefined) tempo = num('tempo', tempo);
  const zoned = header?.mpe === true || hasMpeZone(file.tracks);
  const bendRange = num('bendRange', zoned ? DEFAULT_BEND_RANGE : 2);

  const parts: RawPart[] = [];
  let unmatched = 0;
  /**
   * Lanes of one part come back as one part.
   *
   * ⚠️ **A part too polyphonic for fifteen channels is written as several
   * MIDI tracks** -- see `laneOf` in the exporter -- and they carry the same
   * `LBP-TRK` identity precisely so that this can put them together again.
   * Everything in the key is a field `partsOf` grouped on, so two tracks sharing
   * it were one part; a file from a DAW has no meta and no two tracks can match,
   * because `gridY` falls back to the track's own index.
   */
  const byIdentity = new Map<string, RawPart>();
  for (const track of file.tracks) {
    const found = readPart(track, bendRange, parts.length, zoned);
    if (found === undefined) continue;
    unmatched += found.unmatched;
    const part = found.part;
    if (part.notes.length === 0 && part.cells.length === 0) continue;
    const identity = [
      part.guid, part.gridY, part.level, part.pan,
      part.echoSend, part.reverbSend, part.key, part.scale,
      part.cells.map((c) => c.join(':')).join(','),
    ].join('|');
    const already = byIdentity.get(identity);
    if (already) {
      already.notes.push(...part.notes);
      continue;
    }
    byIdentity.set(identity, part);
    parts.push(part);
  }

  const built = parts.map((part) => cutIntoClips(part, ticksPerStep));
  const tracks = built.flatMap((b) => b.tracks);
  let lengthSteps = 0;
  for (const track of tracks) {
    for (const note of track.notes) {
      lengthSteps = Math.max(lengthSteps, track.stepOffset + note.endStep + 1);
    }
  }

  const volumes = Array.isArray(header?.volumes)
    ? (header.volumes as number[]).slice(0, 6)
    : [1, 1, 1, 1, 1, 1];

  return {
    sequencer: {
      uid: num('uid', 0),
      name: typeof header?.name === 'string' ? (header.name as string) : fallbackName,
      tempo,
      swing: num('swing', 0),
      echoFeedback: num('echoFeedback', 0),
      echoTime: num('echoTime', 1),
      echoMix: num('echoMix', 0),
      reverb: num('reverb', 0),
      loop: typeof header?.loop === 'boolean' ? (header.loop as boolean) : true,
      startPoint: num('startPoint', 0),
      numChannels: Math.min(CHANNEL_COUNT, Math.max(1, num('numChannels', 1))),
      volumes,
      tracks,
      lengthSteps,
    },
    ours: header !== undefined,
    notes: parts.reduce((sum, p) => sum + p.notes.length, 0),
    lengthened: built.reduce((sum, b) => sum + b.lengthened, 0),
    dropped: built.reduce((sum, b) => sum + b.dropped, 0),
    unmatched,
    clips: tracks.length,
  };
}

/**
 * Does this file declare an MPE zone?
 *
 * The MPE Configuration Message is RPN 6 on channel 1 or 16 with a non-zero
 * member count. It decides who a pitch bend belongs to, so it is worth finding
 * even in a file that is not ours -- and a file that is ours says so in its
 * header as well, because a DAW that re-saves it may not keep the RPN.
 */
function hasMpeZone(tracks: readonly MidiTrack[]): boolean {
  for (const track of tracks) {
    let selected = -1;
    for (const event of track.events) {
      const status = event.data[0];
      if ((status & 0xf0) !== 0xb0) continue;
      const channel = status & 0x0f;
      if (channel !== 0 && channel !== 15) continue;
      if (event.data[1] === 101) selected = event.data[2] << 7;
      else if (event.data[1] === 100) selected = Math.max(0, selected) | event.data[2];
      else if (event.data[1] === 6 && selected === 6 && event.data[2] > 0) return true;
    }
  }
  return false;
}

/**
 * One MIDI track to one part.
 *
 * ⚠️ **Notes are matched by channel AND pitch**, and a second note-on for a
 * pair already sounding ends the first. That is what the specification asks
 * for, and it is also the only reading under which an MPE file survives: the
 * channel is the note there, so pairing on pitch alone would cross two fingers
 * playing the same key.
 */
function readPart(
  track: MidiTrack,
  bendRange: number,
  index: number,
  zoned: boolean,
): { part: RawPart; unmatched: number } | undefined {
  const part: RawPart = {
    name: `track ${index + 1}`,
    guid: 0,
    gridY: index,
    ...NEUTRAL,
    ...CHROMATIC_C,
    cells: [],
    notes: [],
  };
  for (const event of track.events) {
    const text = metaString(event);
    if (text?.type === 0x03 && text.text) part.name = text.text;
    if (text?.type === 0x01 && text.text.startsWith(TRK_TAG)) {
      try {
        const meta = JSON.parse(text.text.slice(TRK_TAG.length)) as Record<string, unknown>;
        const pick = (key: string, fallback: number) =>
          typeof meta[key] === 'number' ? (meta[key] as number) : fallback;
        part.guid = pick('guid', 0);
        part.gridY = pick('gridY', index);
        part.level = pick('level', NEUTRAL.level);
        part.pan = pick('pan', NEUTRAL.pan);
        part.echoSend = pick('echoSend', NEUTRAL.echoSend);
        part.reverbSend = pick('reverbSend', NEUTRAL.reverbSend);
        if (typeof meta.name === 'string') part.name = meta.name;
        if (Array.isArray(meta.clips)) {
          // ⚠️ Files written before the length was added carry bare cell
          // numbers. A whole clip is the honest fallback for those.
          part.cells = (meta.clips as unknown[]).flatMap((clip) => {
            if (typeof clip === 'number') return [[clip, 128] as [number, number]];
            if (Array.isArray(clip) && typeof clip[0] === 'number') {
              return [[clip[0], typeof clip[1] === 'number' ? clip[1] : 128] as [number, number]];
            }
            return [];
          });
        }
        // ⚠️ **`Key` is restored, `Scale` is not, and the difference is that
        // one is invertible.** The exporter folds both into the note numbers so
        // the file plays anywhere; getting the placement back means undoing
        // that. `blockRoot(key) - 12` is a transposition and subtracting it is
        // exact. `quantise` is a projection onto a scale and is **measured not
        // to be idempotent**, so there is no pitch to un-snap to -- a scaled
        // placement therefore still comes back chromatic, with the notes it
        // sounded. No placement in the 22-level corpus sets `Scale`.
        const scale = pick('scale', 0);
        if (scale === 0) part.key = pick('key', CHROMATIC_C.key);
      } catch {
        // Not ours after all.
      }
    }
  }

  /**
   * Which CC 74 events are a note's own opening modulation.
   *
   * ⚠️ **A newcomer's CC 74 must not join the ramp of whoever owns the
   * channel.** The exporter writes every note's opening modulation, sharer or
   * not, immediately before its note-on -- so taking every CC 74 as a control
   * point bent the modulation of notes that had nothing to do with it.
   *
   * ⚠️ **And it is the LAST one before the note-on, not every one at that
   * tick.** Excluding the whole tick was the first attempt and it threw away the
   * owner's own final ramp sample whenever a note happened to start on the same
   * instant the ramp ended -- three notes in `Orb` and `Blackfire` whose
   * modulation stopped one step short of where it was going. In the stream the
   * two are adjacent and in order: the owner's sample, then the newcomer's.
   */
  const events = track.events;
  const opensANote = new Set<number>();
  for (let i = 0; i < events.length; i += 1) {
    const status = events[i].data[0];
    if ((status & 0xf0) !== 0x90 || events[i].data[2] === 0) continue;
    const channel = status & 0x0f;
    for (let j = i - 1; j >= 0 && events[j].tick === events[i].tick; j -= 1) {
      const before = events[j].data;
      if ((before[0] & 0xf0) === 0xb0 && (before[0] & 0x0f) === channel && before[1] === 74) {
        opensANote.add(j);
        break;
      }
    }
  }

  // Bend and pressure are per channel and apply to whatever is sounding there.
  const sounding = new Map<number, RawNote>();
  const modulation = new Float64Array(16);
  // What a channel was set to, and when: expression at a note-on's own tick is
  // that note's opening value, and expression from an earlier note is not.
  const pressure = new Float64Array(16).fill(-1);
  const pressureTick = new Float64Array(16).fill(-1);
  const bend = new Float64Array(16);
  const bendTick = new Float64Array(16).fill(-1);
  /** The note each channel's expression is addressed to; see `owners`. */
  const ownerOf = new Map<number, RawNote>();
  let unmatched = 0;
  let last = 0;

  const end = (key: number, tick: number) => {
    const note = sounding.get(key);
    if (note === undefined) return;
    note.endTick = tick;
    sounding.delete(key);
    if (ownerOf.get(note.channel) === note) ownerOf.delete(note.channel);
  };

  /**
   * Which sounding notes a channel-wide bend or pressure belongs to.
   *
   * ⚠️ **In an MPE zone it is the note that OWNS the channel, and ownership
   * is claimed, not inherited.** MPE means one note per channel, so normally
   * there is nothing to choose between; the case that matters is a chord too
   * big for the zone, where a channel has to carry a second note. The exporter
   * writes bend and pressure immediately before the note-on of the note it gave
   * the channel to, and writes nothing at all for a newcomer, so a note-on that
   * finds expression at its own tick is the owner and one that does not is a
   * lodger.
   *
   * ⚠️ **This used to be "the oldest note on the channel", and that broke the
   * moment the exporter stopped allocating in time order.** Gliding notes are
   * now allocated first, so a flat note that started earlier can be sharing a
   * channel with a gliding note that started later -- and under the old rule
   * the glide went to the flat note. Ownership by claim does not care which
   * came first.
   *
   * Outside a zone a channel legitimately holds a chord, and a bend there
   * really does move all of it.
   */
  const owners = (channel: number): RawNote[] => {
    const on = [...sounding.values()].filter((note) => note.channel === channel);
    if (!zoned || on.length < 2) return on;
    const owner = ownerOf.get(channel);
    return owner !== undefined && on.includes(owner) ? [owner] : [];
  };

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const status = event.data[0];
    if (status < 0x80 || status >= 0xf0) continue;
    const kind = status & 0xf0;
    const channel = status & 0x0f;
    const a = event.data[1];
    const b = event.data[2];
    last = Math.max(last, event.tick);
    const key = channel * 128 + a;
    if (kind === 0x90 && b > 0) {
      end(key, event.tick);
      // ⚠️ **Only a note that finds its channel empty may claim the expression
      // sent at its tick, and claiming CONSUMES it.** A note joining a channel
      // wrote none of its own -- see the exporter -- so anything there belongs
      // to somebody else. Both halves are needed: without the emptiness test a
      // newcomer landing on a tick where the owner happened to emit a glide
      // sample claimed the whole rest of the ramp; without the consumption a
      // second note-on at the same instant claimed it a second time.
      const alone = ![...sounding.values()].some((n) => n.channel === channel);
      const claimsBend = alone && bendTick[channel] === event.tick;
      const claimsPress = alone && pressureTick[channel] === event.tick;
      const note: RawNote = {
        channel, note: a, velocity: b,
        opening: claimsPress ? pressure[channel] : undefined,
        openingBend: claimsBend ? bend[channel] : undefined,
        startTick: event.tick, endTick: event.tick,
        modulation: modulation[channel],
        bends: [], presses: [], mods: [],
      };
      if (claimsBend || claimsPress) {
        bendTick[channel] = -1;
        pressureTick[channel] = -1;
        ownerOf.set(channel, note);
      }
      sounding.set(key, note);
      part.notes.push(note);
    } else if (kind === 0x80 || (kind === 0x90 && b === 0)) {
      end(key, event.tick);
    } else if (kind === 0xe0) {
      const value = ((b << 7) | a) - 8192;
      const semitones = (value / 8192) * bendRange;
      bend[channel] = semitones;
      bendTick[channel] = event.tick;
      for (const note of owners(channel)) note.bends.push({ tick: event.tick, semitones });
    } else if (kind === 0xd0) {
      pressure[channel] = a;
      pressureTick[channel] = event.tick;
      for (const note of owners(channel)) note.presses.push({ tick: event.tick, volume: a });
    } else if (kind === 0xb0) {
      if (a === 74) {
        modulation[channel] = modFrom7(b);
        // Sounding notes take it as a control point -- unless this is the one
        // that opens a note starting here, which is that note's own value and
        // none of the owner's business.
        if (!opensANote.has(index)) {
          for (const note of owners(channel)) {
            note.mods.push({ tick: event.tick, value: modFrom7(b) });
          }
        }
      }
      else if (a === 120 || a === 123) {
        for (const k of [...sounding.keys()]) end(k, event.tick);
      }
    }
  }
  // A note-on with no note-off is a broken file, not a note that lasts forever.
  for (const key of [...sounding.keys()]) {
    unmatched += 1;
    end(key, Math.max(last, sounding.get(key)?.startTick ?? 0));
  }
  return part.notes.length > 0 || part.guid !== 0 ? { part, unmatched } : undefined;
}

/** Positions are thirds of a step, which is the finest the record format has. */
const thirdsOf = (tick: number, ticksPerStep: number) =>
  Math.round((tick / ticksPerStep) * 3);

/**
 * Drop the control points that lie on the line between their neighbours.
 *
 * ⚠️ **This is the inverse of the exporter's glide resampling**, and it has to
 * be tolerant rather than exact: a resampled point is `round(lerp)`, so it
 * misses the true line by up to half a unit and an exact test would keep every
 * one of the hundred samples a long glide was written as. Half a unit is also
 * the largest error that cannot change a rendered note, since both fields are
 * integers.
 *
 * ⚠️ **And it has to be Douglas-Peucker, not a walk comparing each point to its
 * immediate neighbours.** The obvious incremental test fails on exactly the
 * data this exists for. Pitch comes back through `Math.round`, so a twelve
 * semitone glide is a twelve-tread staircase, and while every tread is within
 * half a unit of the *whole* line, a tread is not within half a unit of the
 * short line between the two points either side of it. The incremental version
 * returned ten points where the file had written two, and each re-export would
 * have grown them again.
 *
 * A genuine point that happens to sit on the line through its neighbours is
 * dropped too. It has to be: it is indistinguishable from a resampled one, and
 * the engine interpolates linearly, so the note sounds the same either way.
 */
function simplify(
  points: { thirds: number; pitch: number; volume: number; mod: number }[],
): { thirds: number; pitch: number; volume: number; mod: number }[] {
  if (points.length <= 2) return points;
  const keep = points.map(() => false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const span = stack.pop();
    if (span === undefined) break;
    const [a, b] = span;
    if (b - a < 2) continue;
    const from = points[a];
    const to = points[b];
    const width = to.thirds - from.thirds;
    let worst = -1;
    // Normalised, so 1 is "at its tolerance" for whichever field is worst.
    let worstBy = 1;
    for (let i = a + 1; i < b; i += 1) {
      const t = width > 0 ? (points[i].thirds - from.thirds) / width : 0;
      // Each field against its own tolerance, then the worst of the three.
      // Pitch is held far tighter than the others because it is no longer
      // rounded before it gets here: what arrives is the ramp the file drew,
      // and the only slack it needs is the bend's own 14-bit step.
      const by = Math.max(
        Math.abs(from.pitch + (to.pitch - from.pitch) * t - points[i].pitch) / PITCH_TOLERANCE,
        Math.abs(from.volume + (to.volume - from.volume) * t - points[i].volume) / TOLERANCE,
        // ❗ On the nibble's own scale: the modulation is 0..1 in steps of 1/15.
        Math.abs((from.mod + (to.mod - from.mod) * t - points[i].mod) * 15) / TOLERANCE,
      );
      if (by > worstBy) {
        worstBy = by;
        worst = i;
      }
    }
    if (worst < 0) continue;
    keep[worst] = true;
    stack.push([a, worst], [worst, b]);
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Half a unit, and a hair, because both fields are integers.
 *
 * A resampled point is `round(exact)`, so it can miss the true line by exactly
 * half; the hair keeps floating point from turning that into a split. Half a
 * unit is also the largest error that cannot change a rendered note.
 */
const TOLERANCE = 0.5 + 1e-9;

/**
 * How far a pitch may sit off the line and still be dropped, in semitones.
 *
 * ❗ Far tighter than half a step, because the pitch is not rounded before the
 * simplifier sees it. A 14-bit bend over the widest range this writes carries a
 * semitone to 96/16384 = 0.006, so 0.02 is three times the quantiser and a
 * fiftieth of the smallest musical interval there is.
 */
const PITCH_TOLERANCE = 0.02;

/**
 * A part to LBP clips.
 *
 * ⚠️ **A record's step field is seven bits.** A clip therefore covers 128 steps
 * and starts on a cell boundary, `gridX * 16`, so anything longer than that is
 * re-cut here -- greedily, in note order, opening a clip at the cell of the
 * first note that will not fit in the current one. Clip boundaries after a
 * round trip are the exporter's, not the original's; the music is the same and
 * the board layout is not.
 */
function cutIntoClips(
  part: RawPart,
  ticksPerStep: number,
): { tracks: Track[]; lengthened: number; dropped: number } {
  const MAX_STEP = 127;
  let lengthened = 0;
  let dropped = 0;

  const notes = part.notes
    .map((raw) => {
      const startThirds = thirdsOf(raw.startTick, ticksPerStep);
      // A note lasts `last - first + 1` steps, so its final record sits one
      // whole step before its note-off.
      let endThirds = thirdsOf(raw.endTick, ticksPerStep) - 3;
      if (endThirds < startThirds) {
        endThirds = startThirds;
        lengthened += 1;
      }
      const base = raw.note;
      // ⚠️ **One timeline, walked once, carrying the last value of each field.**
      // Bend and pressure arrive as two independent streams and a control point
      // needs both, so a point made by a bend has to inherit whatever the
      // pressure was at that instant, and the other way round. Merging first and
      // walking once is what makes that true; filling each stream in on its own
      // reads the wrong neighbour whenever the two interleave.
      type Move = {
        tick: number;
        pitch?: number;
        volume?: number;
        mod?: number;
      };
      const moves: Move[] = [
        // ⚠️ **Fractional, and rounded only when a record is written.** The
        // engine's glide is linear in semitones and the bend carries it to
        // within 0.006 of one; rounding each sample to an integer first turns a
        // ramp into a staircase, and the simplifier then keeps the tread where
        // the rounding crossed a half rather than the control point the file
        // actually named. A one-semitone rise over three thirds came back a
        // third early -- 2,432 notes across the corpus.
        ...raw.bends.map((b) => ({ tick: b.tick, pitch: base + b.semitones })),
        ...raw.presses.map((p) => ({ tick: p.tick, volume: p.volume })),
        ...raw.mods.map((m) => ({ tick: m.tick, mod: m.value })),
      ].sort((x, y) => x.tick - y.tick);

      const collected = new Map<number, { thirds: number; pitch: number; volume: number; mod: number }>();
      let pitch = base + Math.round(raw.openingBend ?? 0);
      let volume = raw.opening ?? raw.velocity;
      let mod = raw.modulation;
      collected.set(startThirds, { thirds: startThirds, pitch, volume, mod });
      for (const move of moves) {
        if (move.pitch !== undefined) pitch = move.pitch;
        if (move.volume !== undefined) volume = move.volume;
        if (move.mod !== undefined) mod = move.mod;
        const thirds = Math.min(Math.max(thirdsOf(move.tick, ticksPerStep), startThirds), endThirds);
        collected.set(thirds, { thirds, pitch, volume, mod });
      }
      if (!collected.has(endThirds)) {
        collected.set(endThirds, { thirds: endThirds, pitch, volume, mod });
      }
      const points = simplify([...collected.values()].sort((x, y) => x.thirds - y.thirds));
      // ⚠️ **A note that starts already bent keeps BOTH pitches**, the written
      // one and the bent one, on the same position. The MIDI note number is the
      // key that was struck and the bend is where it went, and the two are not
      // interchangeable here: the engine picks the sample SLOT from the record's
      // own pitch and only then applies the glide, so folding the bend into the
      // first record can cross a key split and change which sample plays. This
      // is also exactly the shape the exporter collapsed on the way out, so the
      // pair round-trips.
      const openingBend = Math.round(raw.openingBend ?? 0);
      if (openingBend !== 0) {
        points.unshift({
          thirds: startThirds, pitch: base, volume: points[0].volume, mod: points[0].mod,
        });
      }
      return { startThirds, endThirds, points, modulation: raw.modulation };
    })
    .sort((a, b) => a.startThirds - b.startThirds);

  /**
   * Where the clips go.
   *
   * ⚠️ **The board cells the author used are in the file, and using them is
   * the difference between giving the level back its layout and giving it a
   * layout.** `LBP-TRK` carries the `gridX` of every clip the part had; each
   * note goes into the LAST of them that can hold it, which is the cell it was
   * most likely written in. Clips of one part overlap heavily -- `Ascetic` has
   * them every two cells, each holding 128 steps -- so a note that two cells
   * could hold is genuinely ambiguous, and either answer puts it at the same
   * place on the timeline.
   *
   * With no cells to go on -- a file from a DAW -- this falls back to cutting
   * greedily, opening a clip at the cell of the first note that will not fit in
   * the one before.
   */
  const cells = [...part.cells].sort((a, b) => a[0] - b[0]);
  /** Every clip that could hold a note, nearest cell last. */
  const fitting = (startStep: number, endStep: number): number[] => {
    // The clips' own windows first, and whole clips only if nothing fits --
    // a length can be short of the truth if the file was written elsewhere.
    for (const wide of [false, true]) {
      const found: number[] = [];
      for (const [cell, steps] of cells) {
        const at = cell * STEPS_PER_CELL;
        const room = wide ? MAX_STEP + 1 : steps;
        if (at <= startStep && endStep - at < room) found.push(at);
      }
      if (found.length > 0) return found;
    }
    return [];
  };

  // What the exporter added to every note number, and this has to take away.
  const transpose = blockRoot(part.key) - 12;

  const tracks: Track[] = [];
  let clipStart = 0;
  let open: typeof notes = [];
  const flush = (allowEmpty = false) => {
    if (open.length === 0 && !allowEmpty) return;
    const bytes = new Uint8Array(
      open.reduce((sum, n) => sum + n.points.length, 0) * NOTE_RECORD_SIZE,
    );
    let at = 0;
    for (const note of open) {
      note.points.forEach((point, index) => {
        const thirds = point.thirds - clipStart * 3;
        const step = Math.floor(thirds / 3);
        const subStep = thirds - step * 3;
        const last = index === note.points.length - 1;
        bytes[at] = (step & 0x7f) | (subStep > 0 ? 0x80 : 0);
        // ❗ Back through the placement's own key, so `notePitch` puts the note
        // where the file says it sounds. `transpose` is 0 for a chromatic C.
        bytes[at + 1] = (clamp7(point.pitch - transpose) & 0x7f) | (last ? 0x80 : 0);
        bytes[at + 2] = clamp7(point.volume);
        // The fourth byte is the packed field: modulation in the low nibble,
        // and bit 6 is the sub-step's high bit. Bits 4..5 select one of four
        // per-block tables and nothing here models them, so they stay clear.
        bytes[at + 3] = Math.round(point.mod * 15) | (subStep === 2 ? 0x40 : 0);
        at += NOTE_RECORD_SIZE;
      });
    }
    const grouped = readNotes(bytes);
    tracks.push({
      guid: part.guid,
      name: part.name,
      gridX: clipStart / STEPS_PER_CELL,
      gridY: part.gridY,
      stepOffset: clipStart,
      level: part.level,
      pan: part.pan,
      echoSend: part.echoSend,
      reverbSend: part.reverbSend,
      key: part.key,
      scale: part.scale,
      notes: grouped.notes,
      trailingRecords: grouped.trailing.length,
    });
    open = [];
  };

  // The author's own cells first, when the file remembers them.
  if (cells.length > 0) {
    const byCell = new Map<number, typeof notes>();
    const leftOver: typeof notes = [];
    const put = (at: number, note: (typeof notes)[number]) => {
      const found = byCell.get(at);
      if (found) found.push(note);
      else byCell.set(at, [note]);
    };
    // ⚠️ **The notes only one clip can hold go first.** With each clip's length
    // known that is 99.91% of them; the rest are genuinely ambiguous -- clips of
    // one part overlap -- and taking the nearest cell for those emptied 52 clips
    // across the corpus whose every note some neighbour could also hold. Placing
    // the certain ones first leaves the ambiguous ones something to fill.
    const unsure: { note: (typeof notes)[number]; where: number[] }[] = [];
    for (const note of notes) {
      const where = fitting(Math.floor(note.startThirds / 3), Math.floor(note.endThirds / 3));
      if (where.length === 0) leftOver.push(note);
      else if (where.length === 1) put(where[0], note);
      else unsure.push({ note, where });
    }
    for (const { note, where } of unsure) {
      const empty = where.find((at) => !byCell.has(at));
      put(empty ?? where[where.length - 1], note);
    }
    // ⚠️ **Every declared cell is emitted, including the ones nothing lands
    // in.** 52 placements across the corpus hold no notes at all -- an
    // instrument dropped on the board and never written in -- and there is
    // nothing in a MIDI file to bring them back except the cell list itself.
    // Without this the round trip quietly returned 62,106 clips for 62,158.
    for (const [cell] of cells) {
      const at = cell * STEPS_PER_CELL;
      clipStart = at;
      open = byCell.get(at) ?? [];
      byCell.delete(at);
      flush(true);
    }
    for (const [at, group] of [...byCell].sort((a, b) => a[0] - b[0])) {
      clipStart = at;
      open = group;
      flush();
    }
    if (leftOver.length === 0) return { tracks, lengthened, dropped };
    notes.length = 0;
    notes.push(...leftOver);
  }

  for (const note of notes) {
    const startStep = Math.floor(note.startThirds / 3);
    const endStep = Math.floor(note.endThirds / 3);
    if (open.length === 0) {
      clipStart = Math.floor(startStep / STEPS_PER_CELL) * STEPS_PER_CELL;
    } else if (endStep - clipStart > MAX_STEP) {
      flush();
      clipStart = Math.floor(startStep / STEPS_PER_CELL) * STEPS_PER_CELL;
    }
    // One note longer than a whole clip cannot be placed at all.
    if (endStep - clipStart > MAX_STEP) {
      dropped += 1;
      continue;
    }
    open.push(note);
  }
  flush();
  return { tracks, lengthened, dropped };
}

/** Re-exported so a caller can name the meta events without reaching in. */
export const META_TAGS = { sequencer: SEQ_TAG, track: TRK_TAG };

/** Kept for callers that want the raw record helper alongside the mapping. */
export type { NoteRecord };
export { meta };

/* -------------------------------------------------------------------- split */

export interface MidiSplit {
  readonly files: readonly { readonly name: string; readonly result: MidiExportResult }[];
  /** The counters, summed over the set. */
  readonly notes: number;
  readonly parts: number;
  readonly events: number;
  readonly bytes: number;
  readonly sharedChannel: number;
  readonly dragged: number;
  readonly timbred: number;
  readonly flattened: number;
  readonly droppedGlides: number;
  readonly dropped: number;
  readonly clampedPitch: number;
  readonly clampedBend: number;
}

/**
 * The same song across several files, so that fewer notes have to share.
 *
 * ⚠️ **A MIDI file's tracks do NOT get a channel space each.** The header can
 * declare 65,535 of them and they are still one shared set of sixteen channels:
 * the channel lives in the status byte, and two tracks writing `0x93` address
 * the same channel 4. A track is an editing container. That is the whole reason
 * a dense song runs out of member channels no matter how many tracks it uses,
 * and it is why splitting means splitting into FILES.
 *
 * (There is a `FF 21` MIDI Port meta event that does give a track its own
 * sixteen. It is deprecated, unevenly honoured, and a reader that ignores it
 * collapses every port back onto one channel space with no allocator having
 * planned for the collisions -- overlapping notes of one pitch, ambiguous
 * note-offs, notes left hanging. It is not worth the trade.)
 *
 * Measured over the corpus's 953,791 notes:
 *
 * | | files | dragged | glide lost |
 * |---|---|---|---|
 * | one file | 149 | 1,245 (0.131%) | 1,535 (0.161%) |
 * | packed, here | 249 | 193 (0.020%) | 1,016 (0.107%) |
 * | one per part | 4,909 | 0 | 825 (0.086%) |
 *
 * One file per part is perfect on drag and unusable in bulk -- `Ascetic` alone
 * becomes 46 files. Packing parts into as few files as their combined polyphony
 * allows gets most of the benefit for two.
 */
export function splitSequencerToMidi(
  sequencer: Sequencer,
  options: MidiExportOptions = {},
): MidiSplit {
  const groups = partsOf(sequencer).map((part) => {
    const tracks = part.tracks.map((index) => sequencer.tracks[index]);
    return { tracks, spans: spansOf({ ...sequencer, tracks }) };
  });

  // First-fit descending: the busiest parts choose first, which is what keeps
  // the bin count near the lower bound. `MEMBERS.length` is the limit because a
  // note beyond it is one that must share.
  groups.sort((a, b) => peak(b.spans) - peak(a.spans));
  const bins: { tracks: Track[]; spans: Span2[] }[] = [];
  for (const group of groups) {
    const bin = bins.find((b) => peak([...b.spans, ...group.spans]) <= MEMBERS.length);
    if (bin) {
      bin.tracks.push(...group.tracks);
      bin.spans.push(...group.spans);
    } else {
      bins.push({ tracks: [...group.tracks], spans: [...group.spans] });
    }
  }

  const stem = (sequencer.name || `sequencer-${sequencer.uid}`).replace(/[^\w .-]+/g, '_').trim();
  const files = bins.map((bin, index) => ({
    name: bins.length === 1
      ? `${stem || 'song'}.mid`
      : `${stem || 'song'} ${String(index + 1).padStart(2, '0')}.mid`,
    result: sequencerToMidi({ ...sequencer, tracks: bin.tracks }, options),
  }));

  const sum = (pick: (r: MidiExportResult) => number) =>
    files.reduce((total, file) => total + pick(file.result), 0);
  return {
    files,
    notes: sum((r) => r.notes),
    parts: sum((r) => r.parts),
    events: sum((r) => r.events),
    bytes: sum((r) => r.bytes.length),
    sharedChannel: sum((r) => r.sharedChannel),
    dragged: sum((r) => r.dragged),
    timbred: sum((r) => r.timbred),
    flattened: sum((r) => r.flattened),
    droppedGlides: sum((r) => r.droppedGlides),
    dropped: sum((r) => r.dropped),
    clampedPitch: sum((r) => r.clampedPitch),
    clampedBend: sum((r) => r.clampedBend),
  };
}

/** A note's life, in thirds of a step. Only the packing needs this. */
type Span2 = readonly [number, number];

function spansOf(sequencer: Sequencer): Span2[] {
  return schedule(sequencer).map(
    (event) =>
      [Math.round(event.step * 3), Math.round((event.step + event.durationSteps) * 3)] as Span2,
  );
}

/** The most notes sounding at once, by sweeping the ends. */
function peak(spans: readonly Span2[]): number {
  const edges: Span2[] = [];
  for (const [from, to] of spans) {
    edges.push([from, 1]);
    edges.push([to, -1]);
  }
  // A note ending exactly where another begins does not overlap it, so the
  // closing edge has to be taken first at a shared tick.
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let now = 0;
  let top = 0;
  for (const [, delta] of edges) {
    now += delta;
    top = Math.max(top, now);
  }
  return top;
}
