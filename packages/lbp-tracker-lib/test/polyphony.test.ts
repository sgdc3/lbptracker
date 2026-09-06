import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  VOICES_UNLIMITED,
  VOICE_POOL_SIZE,
  allocateVoices,
  LiveVoicePool,
  type PooledNote,
} from '../src/polyphony.ts';

const note = (start: number, end: number, score = 0.5): PooledNote => ({ start, end, score });

test('the pool is the engine’s 32 records', () => {
  assert.equal(VOICE_POOL_SIZE, 32);
});

test('notes that fit the pool are untouched', () => {
  const notes = Array.from({ length: 32 }, () => note(0, 100));
  const out = allocateVoices(notes);
  assert.ok(out.every((r) => r.end === 100), 'nothing is stolen while a record is free');
});

test('the 33rd note steals the quietest, not the oldest', () => {
  // Thirty-two held notes, one of them markedly quieter than the rest.
  const notes = Array.from({ length: 32 }, (_, i) => note(0, 100, i === 7 ? 0.1 : 0.9));
  notes.push(note(50, 150, 0.9));
  const out = allocateVoices(notes);
  assert.equal(out[7].end, 50, 'the quiet one is cut at the moment of the theft');
  assert.equal(out[0].end, 100, 'the oldest survives -- this is not round-robin');
  assert.equal(out[32].end, 150);
});

test('a freed record is preferred over any theft', () => {
  const notes = Array.from({ length: 32 }, (_, i) => note(0, i === 3 ? 10 : 100, 0.9));
  notes.push(note(20, 120, 0.9));
  const out = allocateVoices(notes);
  assert.ok(out.every((r, i) => (i === 3 ? r.end === 10 : r.end >= 100)), 'nothing was stolen');
});

test('a pool where every voice scores 1.0 or more loses voice zero', () => {
  // ⚠️ Faithful to 0x1640: the running best starts at 1.0 and the best index at
  // 0, so scores at or above 1.0 never beat it and the search falls through to
  // index 0. Tidying this to "steal the true minimum" would diverge.
  const notes = Array.from({ length: 32 }, (_, i) => note(0, 100, 1 + i));
  notes.push(note(50, 150, 1));
  const out = allocateVoices(notes);
  assert.equal(out[0].end, 50, 'voice 0 goes, even though voice 31 is louder');
  assert.equal(out[31].end, 100);
});

test('the cap can be turned off, which is a UI setting', () => {
  const notes = Array.from({ length: 64 }, () => note(0, 100));
  const capped = allocateVoices(notes);
  assert.ok(capped.some((r) => r.end < 100), 'capped, some are stolen');
  const free = allocateVoices(notes, VOICES_UNLIMITED);
  assert.ok(free.every((r) => r.end === 100), 'uncapped, none are');
});

// ⚠️ THE EQUIVALENCE THE LIVE PLAYER RESTS ON. `allocateVoices` decides the
// voice pool's stealing for a whole song at once; `LiveVoicePool` decides it one
// note at a time so the pool can be changed while a song plays. The moment these
// two disagree, the live player and the renderer are different instruments.
//
// A seeded generator rather than a handful of cases: the interesting failures
// are ties on `start`, ties on `score`, and notes that end exactly where the
// next begins, and those are found by volume rather than by imagination.
test('the incremental pool decides exactly what the offline one decides', () => {
  let seed = 0x9e3779b9;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  for (const poolSize of [1, 2, 4, 32, VOICES_UNLIMITED]) {
    for (let round = 0; round < 40; round += 1) {
      const notes: PooledNote[] = [];
      const count = 5 + Math.floor(rand() * 120);
      for (let i = 0; i < count; i += 1) {
        // Coarse starts and lengths, so ties and exact abutments are common.
        const start = Math.floor(rand() * 24);
        const end = start + Math.floor(rand() * 8);
        // Scores off a short ladder, so ties on score happen constantly.
        notes.push({ start, end, score: Math.floor(rand() * 4) / 4 });
      }

      const offline = allocateVoices(notes, poolSize);

      // The order `allocateVoices` sorts into, which is the order a scheduler
      // posts in: by start, ties by the order they were added.
      const order = notes
        .map((n, index) => ({ n, index }))
        .sort((a, b) => a.n.start - b.n.start || a.index - b.index);
      const pool = new LiveVoicePool(poolSize);
      const ends = new Map<number, number>();
      for (const { n, index } of order) {
        const { end, stole } = pool.add(index, n);
        ends.set(index, end);
        if (stole) ends.set(stole.index, stole.at);
      }

      for (const row of offline) {
        assert.equal(
          ends.get(row.index),
          row.end,
          `pool ${poolSize}, round ${round}, note ${row.index}`,
        );
      }
    }
  }
});
