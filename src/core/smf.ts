/**
 * Standard MIDI File: the container, and nothing about LBP.
 *
 * A `.mid` is three primitives -- a chunk, a variable-length quantity, and a
 * stream of `(delta, event)` pairs -- and every one of them has a trap in it.
 * They are all here so that `midi.ts` above can be about music instead:
 *
 *  1. **Running status.** A channel event may omit its status byte and inherit
 *     the previous one. Files written by hardware do this constantly, and a
 *     reader that does not implement it desynchronises on the first repeat and
 *     then produces confident nonsense.
 *  2. **Meta and sysex clear running status**, channel events set it, and
 *     `F1`-`F6` leave it alone. Getting that wrong shows up only on the files
 *     that mix them.
 *  3. **Track lengths are authoritative.** A track is parsed to its declared
 *     length, not to its `End of Track`: real files carry bytes after it.
 *
 * Ticks are absolute here rather than deltas. Deltas are a storage detail and
 * every consumer wants positions, so the conversion happens at the edge.
 */

/** One event, at an absolute tick. `data` starts with the status byte. */
export interface MidiEvent {
  readonly tick: number;
  readonly data: Uint8Array;
}

export interface MidiTrack {
  readonly events: readonly MidiEvent[];
}

export interface MidiFile {
  /** 0 (one track), 1 (parallel tracks) or 2 (independent sequences). */
  readonly format: number;
  /**
   * Ticks per quarter note, positive; SMPTE division (a negative first byte)
   * is rejected rather than misread as a huge PPQ.
   */
  readonly division: number;
  readonly tracks: readonly MidiTrack[];
}

export class MidiError extends Error {}

const MTHD = 0x4d546864;
const MTRK = 0x4d54726b;

/** How many bytes a variable-length quantity takes. */
export function varLength(value: number): number {
  if (value < 0) throw new MidiError(`negative delta ${value}`);
  return value < 0x80 ? 1 : value < 0x4000 ? 2 : value < 0x200000 ? 3 : 4;
}

/** Write a variable-length quantity; returns the next offset. */
export function writeVar(out: Uint8Array, offset: number, value: number): number {
  if (value < 0 || value > 0x0fffffff) throw new MidiError(`delta ${value} out of range`);
  let at = offset;
  // Seven bits at a time, most significant first, every byte but the last
  // carrying the continuation bit.
  const shift = (varLength(value) - 1) * 7;
  for (let s = shift; s >= 0; s -= 7) {
    out[at] = ((value >>> s) & 0x7f) | (s > 0 ? 0x80 : 0);
    at += 1;
  }
  return at;
}

/* -------------------------------------------------------------------- write */

/**
 * How many bytes an event costs, including its delta.
 *
 * The writer sizes the buffer exactly rather than growing one, because a track
 * of a hundred thousand events is a plausible export and the copies are not.
 */
function eventSize(delta: number, data: Uint8Array): number {
  return varLength(delta) + data.length;
}

/**
 * Serialise a file.
 *
 * ⚠️ **Events are written in the order given, not sorted.** Order inside a tick
 * is meaning: MPE puts a note's expression *before* its note-on, and a sort by
 * tick alone -- even a stable one -- would be at the mercy of whatever the
 * caller happened to append first. Sorting is the caller's job, with its own
 * tie-break; see `sortEvents`.
 *
 * `End of Track` is appended to every track, and any the caller already wrote
 * is dropped: two of them is a malformed file, and callers building a track
 * from several sources cannot easily tell whether one is there.
 */
export function writeMidi(file: MidiFile): Uint8Array {
  const eot = Uint8Array.of(0xff, 0x2f, 0x00);
  const bodies = file.tracks.map((track) => {
    const events = track.events.filter(
      (e) => !(e.data.length === 3 && e.data[0] === 0xff && e.data[1] === 0x2f),
    );
    let size = 4; // the appended End of Track, delta 0
    let previous = 0;
    for (const event of events) {
      size += eventSize(event.tick - previous, event.data);
      previous = event.tick;
    }
    const body = new Uint8Array(size);
    let at = 0;
    previous = 0;
    for (const event of events) {
      at = writeVar(body, at, event.tick - previous);
      body.set(event.data, at);
      at += event.data.length;
      previous = event.tick;
    }
    at = writeVar(body, at, 0);
    body.set(eot, at);
    return body;
  });

  const total = 14 + bodies.reduce((sum, b) => sum + 8 + b.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, MTHD);
  view.setUint32(4, 6);
  view.setUint16(8, file.format);
  view.setUint16(10, file.tracks.length);
  view.setUint16(12, file.division);
  let at = 14;
  for (const body of bodies) {
    view.setUint32(at, MTRK);
    view.setUint32(at + 4, body.length);
    out.set(body, at + 8);
    at += 8 + body.length;
  }
  return out;
}

/**
 * Sort events into writing order: by tick, then `rank`, then the caller's order.
 *
 * ⚠️ **The index tie-break has to be explicit.** `Array.sort` is stable in
 * every current engine, but the events arrive from several loops -- one per
 * note, one per track -- and are concatenated, so "the order they were pushed
 * in" is only meaningful once they are numbered.
 *
 * ⚠️ **And push order alone is not enough when the caller does not build the
 * events in time order.** A note-off pushed late still has to precede a
 * note-on pushed early if they land on the same tick, or a reader pairs them
 * the wrong way round and ends the wrong note. `rank` is where a caller states
 * that; see the one in `midi.ts`.
 */
export function sortEvents(
  events: readonly MidiEvent[],
  rank: (event: MidiEvent) => number = () => 0,
): MidiEvent[] {
  return events
    .map((event, index) => ({ event, index, rank: rank(event) }))
    .sort((a, b) => a.event.tick - b.event.tick || a.rank - b.rank || a.index - b.index)
    .map((e) => e.event);
}

/* --------------------------------------------------------------------- read */

/** How many data bytes follow a channel status byte. */
function channelDataBytes(status: number): number {
  const kind = status & 0xf0;
  return kind === 0xc0 || kind === 0xd0 ? 1 : 2;
}

function readVar(bytes: Uint8Array, at: number, end: number): { value: number; at: number } {
  let value = 0;
  let cursor = at;
  for (let i = 0; i < 4; i += 1) {
    if (cursor >= end) throw new MidiError('variable-length quantity runs past the track');
    const byte = bytes[cursor];
    cursor += 1;
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, at: cursor };
  }
  throw new MidiError('variable-length quantity longer than four bytes');
}

export function readMidi(bytes: Uint8Array): MidiFile {
  if (bytes.length < 14) throw new MidiError('too short to be a MIDI file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== MTHD) throw new MidiError('not a MIDI file: no MThd');
  const headerLength = view.getUint32(4);
  const format = view.getUint16(8);
  const declared = view.getUint16(10);
  const division = view.getInt16(12);
  if (division <= 0) {
    throw new MidiError(`SMPTE time division (${division}) is not supported; needs ticks per beat`);
  }
  // The header's length is authoritative too: the spec allows it to grow.
  let at = 8 + headerLength;

  const tracks: MidiTrack[] = [];
  while (at + 8 <= bytes.length) {
    const id = view.getUint32(at);
    const length = view.getUint32(at + 4);
    const start = at + 8;
    const end = Math.min(start + length, bytes.length);
    at = start + length;
    // Anything that is not an MTrk is skipped by its own length, which is what
    // the spec asks for and what makes a file with a vendor chunk still read.
    if (id !== MTRK) continue;
    tracks.push({ events: readTrack(bytes, start, end) });
  }
  if (tracks.length === 0) throw new MidiError('no MTrk chunks');
  if (declared !== tracks.length && format !== 0) {
    // Not fatal: the count in the header is redundant and files disagree with
    // it. Reading what is actually there beats trusting the count.
  }
  return { format, division, tracks };
}

function readTrack(bytes: Uint8Array, start: number, end: number): MidiEvent[] {
  const events: MidiEvent[] = [];
  let at = start;
  let tick = 0;
  let running = 0;
  while (at < end) {
    const delta = readVar(bytes, at, end);
    tick += delta.value;
    at = delta.at;
    if (at >= end) break;
    let status = bytes[at];
    if (status < 0x80) {
      // Running status: the byte is data, and the previous channel status
      // applies. Without a previous one the file is malformed here.
      if (running === 0) throw new MidiError(`data byte 0x${status.toString(16)} with no status`);
      status = running;
    } else {
      at += 1;
      if (status < 0xf0) running = status;
      else if (status === 0xff || status === 0xf0 || status === 0xf7) running = 0;
    }

    if (status === 0xff) {
      const type = bytes[at];
      const len = readVar(bytes, at + 1, end);
      const from = len.at;
      const to = Math.min(from + len.value, end);
      const data = new Uint8Array(2 + (to - from) + varLength(len.value));
      data[0] = 0xff;
      data[1] = type;
      const after = writeVar(data, 2, len.value);
      data.set(bytes.subarray(from, to), after);
      events.push({ tick, data });
      at = to;
    } else if (status === 0xf0 || status === 0xf7) {
      const len = readVar(bytes, at, end);
      const to = Math.min(len.at + len.value, end);
      const data = new Uint8Array(1 + varLength(len.value) + (to - len.at));
      data[0] = status;
      const after = writeVar(data, 1, len.value);
      data.set(bytes.subarray(len.at, to), after);
      events.push({ tick, data });
      at = to;
    } else {
      const count = channelDataBytes(status);
      const data = new Uint8Array(1 + count);
      data[0] = status;
      for (let i = 0; i < count; i += 1) data[1 + i] = bytes[at + i];
      events.push({ tick, data });
      at += count;
    }
  }
  return events;
}

/* ------------------------------------------------------------------ helpers */

export const noteOn = (tick: number, channel: number, note: number, velocity: number): MidiEvent =>
  ({ tick, data: Uint8Array.of(0x90 | channel, note & 0x7f, velocity & 0x7f) });

/**
 * ⚠️ A real `0x80` note-off, not `0x90` with velocity 0.
 *
 * The two are equivalent to a synth, but only the first survives a round trip
 * through a reader that distinguishes them -- and `0x90 v0` inside a run of
 * running-status note-ons is exactly the pattern that makes a hand-written
 * parser drop notes.
 */
export const noteOff = (tick: number, channel: number, note: number): MidiEvent =>
  ({ tick, data: Uint8Array.of(0x80 | channel, note & 0x7f, 0x40) });

export const controlChange = (tick: number, channel: number, cc: number, value: number): MidiEvent =>
  ({ tick, data: Uint8Array.of(0xb0 | channel, cc & 0x7f, value & 0x7f) });

export const channelPressure = (tick: number, channel: number, value: number): MidiEvent =>
  ({ tick, data: Uint8Array.of(0xd0 | channel, value & 0x7f) });

/** 14-bit, centred at 8192, low seven bits first. */
export const pitchBend = (tick: number, channel: number, value: number): MidiEvent => {
  const v = Math.max(0, Math.min(16383, Math.round(value)));
  return { tick, data: Uint8Array.of(0xe0 | channel, v & 0x7f, (v >> 7) & 0x7f) };
};

export function meta(tick: number, type: number, payload: Uint8Array): MidiEvent {
  const data = new Uint8Array(2 + varLength(payload.length) + payload.length);
  data[0] = 0xff;
  data[1] = type;
  const after = writeVar(data, 2, payload.length);
  data.set(payload, after);
  return { tick, data };
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

export const metaText = (tick: number, type: number, text: string): MidiEvent =>
  meta(tick, type, utf8.encode(text));

/** Microseconds per quarter note, from beats per minute. */
export const tempoEvent = (tick: number, bpm: number): MidiEvent => {
  const usec = Math.max(1, Math.min(0xffffff, Math.round(60_000_000 / bpm)));
  return meta(tick, 0x51, Uint8Array.of((usec >> 16) & 0xff, (usec >> 8) & 0xff, usec & 0xff));
};

/** `numerator/2**denominatorPower`, plus the two clock fields nothing reads. */
export const timeSignature = (tick: number, numerator: number, denominatorPower: number): MidiEvent =>
  meta(tick, 0x58, Uint8Array.of(numerator, denominatorPower, 24, 8));

/** The payload of a meta event, or undefined when the event is not one. */
export function metaPayload(event: MidiEvent): { type: number; bytes: Uint8Array } | undefined {
  if (event.data.length < 3 || event.data[0] !== 0xff) return undefined;
  const len = readVar(event.data, 2, event.data.length);
  return { type: event.data[1], bytes: event.data.subarray(len.at, len.at + len.value) };
}

export function metaString(event: MidiEvent): { type: number; text: string } | undefined {
  const payload = metaPayload(event);
  return payload === undefined
    ? undefined
    : { type: payload.type, text: fromUtf8.decode(payload.bytes) };
}

/** Beats per minute from a tempo meta event, or undefined. */
export function tempoFrom(event: MidiEvent): number | undefined {
  const payload = metaPayload(event);
  if (payload === undefined || payload.type !== 0x51 || payload.bytes.length < 3) return undefined;
  const usec = (payload.bytes[0] << 16) | (payload.bytes[1] << 8) | payload.bytes[2];
  return usec > 0 ? 60_000_000 / usec : undefined;
}
