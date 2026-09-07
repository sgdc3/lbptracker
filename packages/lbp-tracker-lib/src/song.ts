/**
 * The song as the editor holds it: a board of clips, each a grid of notes.
 *
 * `Sequencer` and `Track` in `@lbptracker/cwlib/project.ts` are what a level
 * file yields -- immutable, with the file's own record bytes beside the decoded
 * notes -- and everything downstream of them (the renderer, the live player,
 * the MIDI exporter) reads that shape. An editor needs the opposite: something
 * mutable, with stable identities for undo and selection, and with a note as
 * a chain of control points it can drag one at a time. This is that shape, and
 * the two functions at the bottom are the boundary: `songFromSequencer` opens
 * a level's song for editing and `sequencerFromSong` turns the edit back into
 * exactly what the rest of the project plays.
 *
 * ❗ **The boundary goes through the game's own record encoding.** A `Track`
 * carries `records` and `notes`, and `sequencerFromSong` writes the records
 * with `encodeNotes` (the measured order, the resting bit) and then decodes
 * them again for `notes`, so the notes the player sees are the notes a level
 * saved from this song would hold -- clamped to seven bits, snapped to thirds,
 * ordered as the editor orders them. Nothing here can play a note the file
 * could not carry.
 *
 * Positions are in **thirds of a step** throughout, because that is the record
 * grid: a triplet sits at thirds 1 and 2 of a step, and a note's end is the
 * position of its last control point (the engine's gate closes a step after
 * it -- `duration = lastStep - firstStep + 1`, steering/sequencer-data-model.md).
 */

import {
  DEFAULT_VOLUME,
  decodeRecords,
  encodeNotes,
  groupNotes,
  thirdsOf,
  type Note,
  type WriteNote,
} from '@lbptracker/cwlib/notes.ts';
import { STEPS_PER_CELL, type Sequencer, type Track } from '@lbptracker/cwlib/project.ts';

/** One control point. `thirds` is the position within the clip, `timbre` the 0..15 nibble. */
export interface SongPoint {
  thirds: number;
  pitch: number;
  /** 0..127. */
  volume: number;
  /** 0..15 -- the modulation nibble the engine scales by 1/15. */
  timbre: number;
}

/** A note: a chain of control points in position order, the first being the note-on. */
export interface SongNote {
  readonly id: number;
  points: SongPoint[];
}

/** One instrument placed on the board -- a `PInstrument` Thing, with its note grid. */
export interface Clip {
  readonly id: number;
  /** The `RInstrument` GUID; 0 for an empty placement. */
  guid: number;
  name: string;
  /** Board column: 16 steps each. */
  cell: number;
  /** Board row, 0 at the top. */
  row: number;
  /**
   * The note grid's length, in steps: 32 to 128 in steps of 16 -- 4 to 16 bars, two at a time.
   *
   * ⚠️ Not a field of the file -- see `clipStepsFor`. It is what the editor
   * shows, and a note cannot be placed past it.
   */
  steps: number;
  key: number;
  scale: number;
  level: number;
  pan: number;
  echoSend: number;
  reverbSend: number;
  /** The inert bit the clip's records carry at rest; see `encodeNotes`. */
  rest: 0 | 1;
  notes: SongNote[];
}

export interface Song {
  name: string;
  tempo: number;
  swing: number;
  echoFeedback: number;
  echoTime: number;
  echoMix: number;
  reverb: number;
  loop: boolean;
  startPoint: number;
  numChannels: number;
  /** Six, as the part serialises them. */
  volumes: number[];
  /** The board's height in cells, which bands rows into channels. */
  boardRows: number;
  /**
   * Where the song ends, in steps, when the composer has dragged the end past
   * the last chip; 0 means "at the last chip". Whole cells. Not a field of
   * the file -- the game's sequencer stops with its last note -- but a
   * composer laying out a song wants room, and the end is where the transport
   * stops.
   */
  endSteps: number;
  clips: Clip[];
  /** The next `id` to hand out, for clips and notes alike. */
  nextId: number;
}

/**
 * The game's bar is **8 steps** -- two beats at four steps to the beat -- and
 * a board tile is four of them.
 *
 * Reported by the project's owner from the game's editor, 2026-09-06: a placed
 * instrument's grid is four bars and grows by two at a time. Measured against
 * the corpus the same day (steering/sequencer-data-model.md, *The tile*): of
 * 72,726 chips with a neighbour on their row, 63,337 sit exactly two cells
 * (32 steps) apart, and the notes of 66,837 of 74,864 clips need exactly two
 * cells -- so the default grid is 32 steps, one 105-unit square of the board,
 * and "four bars" makes a bar 8 steps. Under a 64-step default 64,483 chips
 * would overlap their neighbour; under this one 82 do, and the data itself
 * holds 55 overlaps.
 */
export const STEPS_PER_BAR = 8;
/** Bars per board cell: a cell is 16 steps, a bar 8. */
export const BARS_PER_CELL = STEPS_PER_CELL / STEPS_PER_BAR;
/** A record's `x` is seven bits, so no clip grid can be longer than this: 16 bars. */
export const MAX_CLIP_STEPS = 128;
/** Four bars: one board tile. */
export const DEFAULT_CLIP_STEPS = 4 * STEPS_PER_BAR;
/** A grid grows two bars -- one cell, half a tile -- at a time. */
export const CLIP_STEPS_INCREMENT = 2 * STEPS_PER_BAR;
export const MAX_PITCH = 127;
export const MAX_VOLUME = 127;
export const MAX_TIMBRE = 15;
/** How many rows a board may have. Ours: the file's own limit is not measured, and this is far past any level seen. */
export const MAX_BOARD_ROWS = 64;
/** Six mixer channels serialise; the engine keeps eight records. */
export const MIXER_CHANNELS = 6;

/**
 * A new song's settings.
 *
 * ⚠️ **The tempo is the corpus's mode, not a measured default.** 240 is the
 * most common tempo over 338 sequencers, ahead of 125 (the engine's own
 * default, `fmodextinput.prx`), and a mode that strong in user levels is most
 * likely the value the editor starts a new sequencer at -- but nobody has read
 * that out of the game. The echo values are the corpus's medians for the same
 * reason. See steering/open-questions.md.
 */
export const NEW_SONG_DEFAULTS = {
  tempo: 240,
  swing: 0,
  echoFeedback: 0.45,
  echoTime: 2,
  echoMix: 0.5,
  reverb: 0,
  numChannels: 1,
  boardRows: 8,
} as const;

/** Defaults for a placement, from `PInstrument`'s initialisers. */
export const NEW_CLIP_DEFAULTS = {
  key: 0,
  scale: 0,
  level: 1,
  pan: 0.5,
  echoSend: 0,
  reverbSend: 0,
} as const;

/**
 * The end a song starts with, in steps: two tiles, eight bars. A new song has
 * no chip to take an end from, and an end at 0 is a board with no marker on
 * it and nothing to drag; this gives the composer a length to lay out against
 * from the first frame, and the first chip past it pushes it along.
 */
export const NEW_SONG_END_STEPS = 2 * DEFAULT_CLIP_STEPS;

export function newSong(name = 'untitled'): Song {
  return {
    name,
    ...NEW_SONG_DEFAULTS,
    loop: false,
    startPoint: 0,
    volumes: new Array<number>(MIXER_CHANNELS).fill(1),
    endSteps: NEW_SONG_END_STEPS,
    clips: [],
    nextId: 1,
  };
}

/**
 * The grid length a clip needs to hold its notes: four bars, or the even
 * number above that the notes reach into.
 *
 * ⚠️ **The file does not say how long a clip's grid is.** The eboot copies a
 * length in steps from `PInstrument + 0x60` into the engine's clip, but the
 * serialiser never names that member and `readInstrumentPart` reads nothing
 * for it, so it is derived at load. Over the corpus the highest `x` used is 31
 * in 60,318 of 105,785 clips and never above 63, which is what the rule below
 * reproduces. Steering carries the question.
 */
export function clipStepsFor(maxStep: number): number {
  const over = Math.max(0, maxStep + 1 - DEFAULT_CLIP_STEPS);
  const needed = DEFAULT_CLIP_STEPS + Math.ceil(over / CLIP_STEPS_INCREMENT) * CLIP_STEPS_INCREMENT;
  return Math.min(MAX_CLIP_STEPS, needed);
}

/** The grid lengths a clip may have: 32, 48, 64 ... 128. */
export const CLIP_STEP_CHOICES: readonly number[] = Array.from(
  { length: (MAX_CLIP_STEPS - DEFAULT_CLIP_STEPS) / CLIP_STEPS_INCREMENT + 1 },
  (_, i) => DEFAULT_CLIP_STEPS + i * CLIP_STEPS_INCREMENT,
);

/** The nearest allowed grid length. */
export function snapClipSteps(steps: number): number {
  const n = Math.round((steps - DEFAULT_CLIP_STEPS) / CLIP_STEPS_INCREMENT);
  return Math.min(
    MAX_CLIP_STEPS,
    Math.max(DEFAULT_CLIP_STEPS, DEFAULT_CLIP_STEPS + n * CLIP_STEPS_INCREMENT),
  );
}

export function addClip(song: Song, at: { cell: number; row: number }, guid: number, name = ''): Clip {
  const clip: Clip = {
    id: song.nextId++,
    guid,
    name,
    cell: Math.max(0, Math.round(at.cell)),
    row: Math.max(0, Math.round(at.row)),
    steps: DEFAULT_CLIP_STEPS,
    ...NEW_CLIP_DEFAULTS,
    rest: 1,
    notes: [],
  };
  song.clips.push(clip);
  return clip;
}

/** A copy of a clip on another cell, with fresh ids throughout. */
export function duplicateClip(song: Song, clip: Clip, at: { cell: number; row: number }): Clip {
  const copy = addClip(song, at, clip.guid, clip.name);
  copy.steps = clip.steps;
  copy.key = clip.key;
  copy.scale = clip.scale;
  copy.level = clip.level;
  copy.pan = clip.pan;
  copy.echoSend = clip.echoSend;
  copy.reverbSend = clip.reverbSend;
  copy.rest = clip.rest;
  for (const note of clip.notes) {
    copy.notes.push({ id: song.nextId++, points: note.points.map((p) => ({ ...p })) });
  }
  return copy;
}

export function removeClip(song: Song, id: number): boolean {
  const at = song.clips.findIndex((c) => c.id === id);
  if (at < 0) return false;
  song.clips.splice(at, 1);
  return true;
}

/** One more row at the bottom of the board. False at the limit. */
export function addRow(song: Song): boolean {
  if (song.boardRows >= MAX_BOARD_ROWS) return false;
  song.boardRows += 1;
  return true;
}

/**
 * Take a row out: its chips go, the rows below it move up one. Returns how
 * many chips went, or -1 when the row is not there or is the board's last.
 */
export function removeRow(song: Song, row: number): number {
  if (row < 0 || row >= song.boardRows || song.boardRows <= 1) return -1;
  const before = song.clips.length;
  song.clips = song.clips.filter((c) => c.row !== row);
  for (const clip of song.clips) if (clip.row > row) clip.row -= 1;
  song.boardRows -= 1;
  return before - song.clips.length;
}

const clampInt = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Math.round(v)));

/** The last position a point may sit at in a clip of `steps`. */
export const lastThirds = (clip: { steps: number }): number => clip.steps * 3 - 1;

/** Add a one-point note. Later points come from `addPoint`. */
export function addNote(
  song: Song,
  clip: Clip,
  at: { thirds: number; pitch: number; volume?: number; timbre?: number },
): SongNote {
  const note: SongNote = {
    id: song.nextId++,
    points: [
      {
        thirds: clampInt(at.thirds, 0, lastThirds(clip)),
        pitch: clampInt(at.pitch, 0, MAX_PITCH),
        volume: clampInt(at.volume ?? DEFAULT_VOLUME, 0, MAX_VOLUME),
        timbre: clampInt(at.timbre ?? 0, 0, MAX_TIMBRE),
      },
    ],
  };
  clip.notes.push(note);
  return note;
}

export function removeNote(clip: Clip, id: number): boolean {
  const at = clip.notes.findIndex((n) => n.id === id);
  if (at < 0) return false;
  clip.notes.splice(at, 1);
  return true;
}

/** Keep a note's points in position order; ties keep their relative order. */
export function sortPoints(note: SongNote): void {
  note.points = note.points
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p.thirds - b.p.thirds || a.i - b.i)
    .map(({ p }) => p);
}

/**
 * Insert a control point into a note at `thirds`, interpolating the values from
 * the segment it lands in -- so a new point on a straight line changes nothing
 * until it is moved, which is what makes it a handle.
 */
export function addPoint(clip: Clip, note: SongNote, thirds: number): SongPoint {
  const at = clampInt(thirds, 0, lastThirds(clip));
  const points = note.points;
  let point: SongPoint;
  if (at <= points[0].thirds) {
    point = { ...points[0], thirds: at };
  } else if (at >= points[points.length - 1].thirds) {
    point = { ...points[points.length - 1], thirds: at };
  } else {
    let i = 0;
    while (points[i + 1].thirds < at) i += 1;
    const a = points[i];
    const b = points[i + 1];
    const t = b.thirds === a.thirds ? 0 : (at - a.thirds) / (b.thirds - a.thirds);
    const lerp = (x: number, y: number) => Math.round(x + (y - x) * t);
    point = {
      thirds: at,
      pitch: lerp(a.pitch, b.pitch),
      volume: lerp(a.volume, b.volume),
      timbre: lerp(a.timbre, b.timbre),
    };
  }
  points.push(point);
  sortPoints(note);
  return point;
}

/** Remove one point; the note itself goes when its last point does. */
export function removePoint(clip: Clip, note: SongNote, point: SongPoint): void {
  const at = note.points.indexOf(point);
  if (at < 0) return;
  note.points.splice(at, 1);
  if (note.points.length === 0) removeNote(clip, note.id);
}

/**
 * Move one point, kept between its neighbours and inside the clip.
 *
 * A point may share a position with a neighbour -- two records on one position
 * are a real thing the format allows (302 corpus notes) -- but may not pass it,
 * because the chain's order is its meaning.
 */
export function movePoint(
  clip: Clip,
  note: SongNote,
  point: SongPoint,
  to: { thirds?: number; pitch?: number; volume?: number; timbre?: number },
): void {
  const at = note.points.indexOf(point);
  if (at < 0) return;
  if (to.thirds !== undefined) {
    const lo = at > 0 ? note.points[at - 1].thirds : 0;
    const hi = at < note.points.length - 1 ? note.points[at + 1].thirds : lastThirds(clip);
    point.thirds = clampInt(to.thirds, lo, hi);
  }
  if (to.pitch !== undefined) point.pitch = clampInt(to.pitch, 0, MAX_PITCH);
  if (to.volume !== undefined) point.volume = clampInt(to.volume, 0, MAX_VOLUME);
  if (to.timbre !== undefined) point.timbre = clampInt(to.timbre, 0, MAX_TIMBRE);
}

/** Shift a whole note by `dThirds` and `dPitch`, as far as the clip allows. */
export function moveNote(clip: Clip, note: SongNote, dThirds: number, dPitch: number): void {
  const first = note.points[0].thirds;
  const last = note.points[note.points.length - 1].thirds;
  const lowest = Math.min(...note.points.map((p) => p.pitch));
  const highest = Math.max(...note.points.map((p) => p.pitch));
  const dt = clampInt(dThirds, -first, lastThirds(clip) - last);
  const dp = clampInt(dPitch, -lowest, MAX_PITCH - highest);
  for (const p of note.points) {
    p.thirds += dt;
    p.pitch += dp;
  }
}

/** The clip's highest step in use, or -1 when it is empty. */
export function highestStep(clip: Clip): number {
  let top = -1;
  for (const n of clip.notes) for (const p of n.points) top = Math.max(top, Math.floor(p.thirds / 3));
  return top;
}

/**
 * Resize a clip's grid. It cannot be made shorter than its notes need: the
 * caller sees `false` and the clip is untouched, rather than notes disappearing.
 */
export function resizeClip(clip: Clip, steps: number): boolean {
  const wanted = snapClipSteps(steps);
  if (highestStep(clip) >= wanted) return false;
  clip.steps = wanted;
  return true;
}

/**
 * Where the song ends on the board: the end of the last chip's grid, whether
 * or not its last bars hold a note. This is the end a composer sees and the
 * one the transport stops at; `songLengthSteps` is the notes' own end.
 */
export function songEndSteps(song: Song): number {
  let end = song.endSteps;
  for (const clip of song.clips) end = Math.max(end, clip.cell * STEPS_PER_CELL + clip.steps);
  return end;
}

/**
 * Move the song's end to a step: snapped to whole cells, never before the
 * last chip -- dragged back that far it becomes "at the last chip" again.
 */
export function setSongEnd(song: Song, steps: number): void {
  const cells = Math.max(0, Math.round(steps / STEPS_PER_CELL));
  let last = 0;
  for (const clip of song.clips) last = Math.max(last, clip.cell * STEPS_PER_CELL + clip.steps);
  const wanted = cells * STEPS_PER_CELL;
  song.endSteps = wanted > last ? wanted : 0;
}

/** The last step any clip reaches on the timeline, plus one; 0 when empty. */
export function songLengthSteps(song: Song): number {
  let end = 0;
  for (const clip of song.clips) {
    const top = highestStep(clip);
    if (top >= 0) end = Math.max(end, clip.cell * STEPS_PER_CELL + top + 1);
  }
  return end;
}

// --------------------------------------------------------------- the boundary

function notesFrom(song: Song, track: Track): SongNote[] {
  const notes: SongNote[] = [];
  for (const note of track.notes) {
    notes.push({
      id: song.nextId++,
      points: note.points.map((p) => ({
        thirds: thirdsOf(p),
        pitch: p.pitch,
        // ⚠️ The file allows a volume above 127 and the corpus never uses one;
        // the editor works in seven bits, which is what the record grid is.
        volume: Math.min(MAX_VOLUME, p.volume),
        timbre: p.timbre & 0x0f,
      })),
    });
  }
  return notes;
}

/** Whether byte 3's bit 6 is set on a track's inert (sub-step 0) records. */
function restingBit(notes: readonly Note[]): 0 | 1 {
  let set = 0;
  let clear = 0;
  for (const note of notes) {
    for (const record of note.points) {
      if (record.subStep !== 0) continue;
      if ((record.timbre & 0x40) !== 0) set += 1;
      else clear += 1;
    }
  }
  // A clip with no inert record to read it from takes the modern editor's value.
  return set >= clear ? 1 : 0;
}

/** Open a level's sequencer for editing. */
export function songFromSequencer(seq: Sequencer): Song {
  const song = newSong(seq.name);
  song.tempo = seq.tempo;
  song.swing = seq.swing;
  song.echoFeedback = seq.echoFeedback;
  song.echoTime = seq.echoTime;
  song.echoMix = seq.echoMix;
  song.reverb = seq.reverb;
  song.loop = seq.loop;
  song.startPoint = seq.startPoint;
  song.numChannels = seq.numChannels;
  song.volumes = Array.from({ length: MIXER_CHANNELS }, (_, i) => seq.volumes[i] ?? 1);
  // A board with no measured height -- a MIDI import, say -- still needs rows
  // to draw, and enough of them to hold every placement.
  const lowest = seq.tracks.reduce((m, t) => Math.max(m, t.gridY), -1);
  song.boardRows = Math.max(seq.boardRows, lowest + 1, 1);
  for (const track of seq.tracks) {
    const clip: Clip = {
      id: song.nextId++,
      guid: track.guid,
      name: track.name,
      cell: track.gridX,
      row: track.gridY,
      steps: clipStepsFor(track.notes.reduce((m, n) => Math.max(m, n.endStep), -1)),
      key: track.key,
      scale: track.scale,
      level: track.level,
      pan: track.pan,
      echoSend: track.echoSend,
      reverbSend: track.reverbSend,
      rest: restingBit(track.notes),
      notes: [],
    };
    clip.notes = notesFrom(song, track);
    song.clips.push(clip);
  }
  return song;
}

/** A clip's notes in the form `encodeNotes` writes. */
function writable(clip: Clip): WriteNote[] {
  return clip.notes.map((note) => ({
    points: [...note.points]
      .sort((a, b) => a.thirds - b.thirds)
      .map((p) => ({
        step: Math.floor(p.thirds / 3),
        subStep: (p.thirds % 3) as 0 | 1 | 2,
        pitch: p.pitch,
        volume: p.volume,
        timbre: p.timbre,
      })),
  }));
}

/** One clip as the `Track` the player and the exporters read. */
export function trackFromClip(clip: Clip): Track {
  const records = encodeNotes(writable(clip), clip.rest);
  const grouped = groupNotes(decodeRecords(records));
  return {
    guid: clip.guid,
    name: clip.name,
    gridX: clip.cell,
    gridY: clip.row,
    stepOffset: clip.cell * STEPS_PER_CELL,
    level: clip.level,
    pan: clip.pan,
    echoSend: clip.echoSend,
    reverbSend: clip.reverbSend,
    key: clip.key,
    scale: clip.scale,
    notes: grouped.notes,
    records,
    trailingRecords: grouped.trailing.length,
  };
}

/**
 * The song as a `Sequencer`: what the live player schedules, the renderer
 * writes and the MIDI page exports. `uid` only has to be stable for one page.
 */
export function sequencerFromSong(song: Song, uid = 1): Sequencer {
  const tracks = song.clips.map(trackFromClip);
  let lengthSteps = 0;
  for (const track of tracks) {
    for (const note of track.notes) {
      lengthSteps = Math.max(lengthSteps, track.stepOffset + note.endStep + 1);
    }
  }
  return {
    uid,
    name: song.name,
    tempo: song.tempo,
    swing: song.swing,
    echoFeedback: song.echoFeedback,
    echoTime: song.echoTime,
    echoMix: song.echoMix,
    reverb: song.reverb,
    loop: song.loop,
    startPoint: song.startPoint,
    numChannels: song.numChannels,
    volumes: [...song.volumes],
    boardRows: song.boardRows,
    tracks,
    lengthSteps,
  };
}

// ----------------------------------------------------------------- the file

/**
 * The project file: the song as JSON, under a name and a version.
 *
 * "Our own project format is JSON, not an LBP resource" was decided at the
 * start (steering/tracker-architecture.md); this is that format. Version 1.
 */
export const SONG_FORMAT = 'lbptracker-song';
export const SONG_FORMAT_VERSION = 1;

export interface SongFile {
  readonly format: typeof SONG_FORMAT;
  readonly version: number;
  readonly song: Song;
}

export function songToJson(song: Song): string {
  const file: SongFile = { format: SONG_FORMAT, version: SONG_FORMAT_VERSION, song };
  return JSON.stringify(file);
}

/** Whether some text is one of our project files, before parsing all of it. */
export function looksLikeSongJson(text: string): boolean {
  return text.slice(0, 200).includes(SONG_FORMAT);
}

/**
 * Parse a project file, checking the shape rather than trusting it: a file is
 * the one thing a page reads that nobody on this side wrote.
 */
export function songFromJson(text: string): Song {
  const parsed = JSON.parse(text) as Partial<SongFile>;
  if (parsed.format !== SONG_FORMAT) throw new Error('not an LBP Tracker song file');
  if (typeof parsed.version !== 'number' || parsed.version > SONG_FORMAT_VERSION) {
    throw new Error(`song file version ${String(parsed.version)} is newer than this page`);
  }
  const raw = parsed.song;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.clips)) {
    throw new Error('song file has no clips');
  }
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const song = newSong(typeof raw.name === 'string' ? raw.name : 'untitled');
  song.tempo = num(raw.tempo, song.tempo);
  song.swing = num(raw.swing, song.swing);
  song.echoFeedback = num(raw.echoFeedback, song.echoFeedback);
  song.echoTime = num(raw.echoTime, song.echoTime);
  song.echoMix = num(raw.echoMix, song.echoMix);
  song.reverb = num(raw.reverb, song.reverb);
  song.loop = raw.loop === true;
  song.startPoint = num(raw.startPoint, 0);
  song.numChannels = clampInt(num(raw.numChannels, 1), 1, MIXER_CHANNELS);
  song.volumes = Array.from({ length: MIXER_CHANNELS }, (_, i) =>
    num(Array.isArray(raw.volumes) ? raw.volumes[i] : undefined, 1));
  song.boardRows = clampInt(num(raw.boardRows, NEW_SONG_DEFAULTS.boardRows), 1, MAX_BOARD_ROWS);
  song.endSteps = Math.max(0, Math.round(num(raw.endSteps, 0) / STEPS_PER_CELL)) * STEPS_PER_CELL;
  for (const c of raw.clips as Partial<Clip>[]) {
    if (!c || typeof c !== 'object') continue;
    const clip = addClip(song, { cell: num(c.cell, 0), row: num(c.row, 0) }, clampInt(num(c.guid, 0), 0, 0x7fffffff), typeof c.name === 'string' ? c.name : '');
    clip.steps = snapClipSteps(num(c.steps, DEFAULT_CLIP_STEPS));
    clip.key = clampInt(num(c.key, 0), 0, 23);
    clip.scale = clampInt(num(c.scale, 0), 0, 5);
    clip.level = num(c.level, 1);
    clip.pan = num(c.pan, 0.5);
    clip.echoSend = num(c.echoSend, 0);
    clip.reverbSend = num(c.reverbSend, 0);
    clip.rest = c.rest === 0 ? 0 : 1;
    for (const n of Array.isArray(c.notes) ? (c.notes as Partial<SongNote>[]) : []) {
      if (!n || !Array.isArray(n.points) || n.points.length === 0) continue;
      const note = addNote(song, clip, { thirds: 0, pitch: 0 });
      note.points = (n.points as Partial<SongPoint>[]).map((p) => ({
        thirds: clampInt(num(p?.thirds, 0), 0, lastThirds(clip)),
        pitch: clampInt(num(p?.pitch, 60), 0, MAX_PITCH),
        volume: clampInt(num(p?.volume, DEFAULT_VOLUME), 0, MAX_VOLUME),
        timbre: clampInt(num(p?.timbre, 0), 0, MAX_TIMBRE),
      }));
      sortPoints(note);
    }
  }
  return song;
}
