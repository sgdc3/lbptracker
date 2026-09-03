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
  readonly clips: number[];
}

function partsOf(sequencer: Sequencer): Part[] {
  const byKey = new Map<string, Part>();
  sequencer.tracks.forEach((track, index) => {
    const key = [
      track.guid, track.gridY, track.level, track.pan,
      track.echoSend, track.reverbSend, track.key, track.scale,
    ].join('|');
    const found = byKey.get(key);
    if (found) {
      found.tracks.push(index);
      found.clips.push(track.gridX);
    } else {
      byKey.set(key, { track, tracks: [index], clips: [track.gridX] });
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
  take(
    tick: number,
    note: number,
    until: number,
    gliding: boolean,
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
          const span: Span = { note, from: tick, until, gliding: false, demote: () => {} };
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
        const onMaster: Span = { note, from: tick, until, gliding: false, demote: () => {} };
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
    }
    const span: Span = {
      note, from: tick, until, gliding: gliding && exclusive,
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

  const parts = partsOf(sequencer);
  const partOfTrack = new Map<number, number>();
  parts.forEach((part, index) => {
    for (const track of part.tracks) partOfTrack.set(track, index);
  });

  const bodies: MidiEvent[][] = parts.map(() => []);
  const pool = new VoicePool();
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
    event.hasPitchAutomation || event.hasVolumeAutomation || clamp7(event.volume) === 0;

  const all = schedule(sequencer);
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
      if (event === flat[0]) pool.rewind();
      if (partOfTrack.get(event.track) === undefined) continue;
      const track = sequencer.tracks[event.track];
      const value = notePitch(event.pitch, track.scale, blockRoot(track.key));
      if (value < 0 || value > 127) clampedPitch += 1;
      const base = clamp7(value);
      const startTick = at(event.step);
      const endTick = Math.max(startTick + 1, at(event.step + event.durationSteps));
      const place = { channel: -1, exclusive: true, base };
      const taken = pool.take(startTick, base, endTick, needsChannel(event), place);
      place.channel = taken.channel;
      place.exclusive = place.exclusive && taken.exclusive;
      placements.set(event, place);
    }
  }

  for (const event of order) {
    const partIndex = partOfTrack.get(event.track);
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
    }));
    const points: typeof raw = [];
    for (const point of raw) {
      if (points.length > 0 && points[points.length - 1].step === point.step) {
        points[points.length - 1] = point;
      } else {
        points.push(point);
      }
    }
    const opening = points[0];

    // MPE's own ordering: the note's opening expression, then the note-on. A
    // receiver that saw the note first would sound one frame of it unbent.
    out.push(controlChange(startTick, channel, 74, clamp7(event.modulation * 127)));
    if (exclusive) {
      out.push(pitchBend(startTick, channel, bendValue(opening.semitones)));
      out.push(channelPressure(startTick, channel, clamp7(opening.volume)));
    }
    out.push(noteOn(startTick, channel, base, Math.max(1, clamp7(opening.volume))));

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
      const moves = from.semitones !== to.semitones || from.volume !== to.volume;
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
        if (from.semitones !== to.semitones) {
          out.push(pitchBend(tick, channel, bendValue(semitones)));
        }
        if (from.volume !== to.volume) {
          out.push(channelPressure(tick, channel, clamp7(volume)));
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
    const header: MidiEvent[] = [
      metaText(0, 0x03, t.name || `guid ${t.guid}`),
      metaText(0, 0x01, TRK_TAG + JSON.stringify({
        guid: t.guid, name: t.name, gridY: t.gridY,
        level: t.level, pan: t.pan, echoSend: t.echoSend, reverbSend: t.reverbSend,
        key: t.key, scale: t.scale, clips: part.clips,
      })),
    ];
    tracks.push({ events: [...header, ...sortEvents(bodies[index], rank)] });
  });

  const bytes = writeMidi({ format: 1, division: ppq, tracks });
  return {
    bytes,
    notes,
    parts: parts.length,
    events: tracks.reduce((sum, t) => sum + t.events.length, 0),
    sharedChannel: pool.shared,
    dragged: pool.dragged,
    flattened,
    clampedPitch,
    clampedBend,
    droppedGlides,
    dropped: pool.refused,
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
  /** Bend and pressure while it sounded, absolute ticks. */
  readonly bends: { tick: number; semitones: number }[];
  readonly presses: { tick: number; volume: number }[];
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
  for (const track of file.tracks) {
    const part = readPart(track, bendRange, parts.length, zoned);
    if (part === undefined) continue;
    unmatched += part.unmatched;
    if (part.part.notes.length > 0) parts.push(part.part);
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
        // ⚠️ `key` and `scale` are deliberately NOT restored. The exporter
        // already folded them into the note numbers, so applying them again
        // would transpose and re-snap a pitch that is finished.
      } catch {
        // Not ours after all.
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

  for (const event of track.events) {
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
        bends: [], presses: [],
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
      if (a === 74) modulation[channel] = b / 127;
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
  points: { thirds: number; pitch: number; volume: number }[],
): { thirds: number; pitch: number; volume: number }[] {
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
    let worstBy = TOLERANCE;
    for (let i = a + 1; i < b; i += 1) {
      const t = width > 0 ? (points[i].thirds - from.thirds) / width : 0;
      const by = Math.max(
        Math.abs(from.pitch + (to.pitch - from.pitch) * t - points[i].pitch),
        Math.abs(from.volume + (to.volume - from.volume) * t - points[i].volume),
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
      const moves = [
        ...raw.bends.map((b) => ({ tick: b.tick, pitch: base + Math.round(b.semitones), volume: undefined as number | undefined })),
        ...raw.presses.map((p) => ({ tick: p.tick, pitch: undefined as number | undefined, volume: p.volume })),
      ].sort((x, y) => x.tick - y.tick);

      const collected = new Map<number, { thirds: number; pitch: number; volume: number }>();
      let pitch = base + Math.round(raw.openingBend ?? 0);
      let volume = raw.opening ?? raw.velocity;
      collected.set(startThirds, { thirds: startThirds, pitch, volume });
      for (const move of moves) {
        if (move.pitch !== undefined) pitch = move.pitch;
        if (move.volume !== undefined) volume = move.volume;
        const thirds = Math.min(Math.max(thirdsOf(move.tick, ticksPerStep), startThirds), endThirds);
        collected.set(thirds, { thirds, pitch, volume });
      }
      if (!collected.has(endThirds)) collected.set(endThirds, { thirds: endThirds, pitch, volume });
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
        points.unshift({ thirds: startThirds, pitch: base, volume: points[0].volume });
      }
      return { startThirds, endThirds, points, modulation: raw.modulation };
    })
    .sort((a, b) => a.startThirds - b.startThirds);

  const tracks: Track[] = [];
  let clipStart = 0;
  let open: typeof notes = [];
  const flush = () => {
    if (open.length === 0) return;
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
        bytes[at + 1] = (clamp7(point.pitch) & 0x7f) | (last ? 0x80 : 0);
        bytes[at + 2] = clamp7(point.volume);
        // The fourth byte is the packed field: modulation in the low nibble,
        // and bit 6 is the sub-step's high bit. Bits 4..5 select one of four
        // per-block tables and nothing here models them, so they stay clear.
        bytes[at + 3] = Math.round(note.modulation * 15) | (subStep === 2 ? 0x40 : 0);
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
      key: CHROMATIC_C.key,
      scale: CHROMATIC_C.scale,
      notes: grouped.notes,
      trailingRecords: grouped.trailing.length,
    });
    open = [];
  };

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
