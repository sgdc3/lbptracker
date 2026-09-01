import { strict as assert } from 'node:assert';
import test from 'node:test';

test('the zone count comes from the splits, not the sample count', async () => {
  const { zoneCount, resolveSlot } = await import('../src/core/instrument.ts');
  // conga's shape: six bounds, seven samples, the seventh a spare whose base
  // note is out of sequence with the rest.
  const conga = {
    slots: Array.from({ length: 7 }, (_, i) => ({ baseNote: [87, 54, 42, 30, 18, 6, 48][i] })),
    splitNotes: [87, 60, 48, 36, 24, 12, 0, 0, 0],
  } as never as Parameters<typeof zoneCount>[0];
  assert.equal(zoneCount(conga), 6, 'six bounds, six zones');

  // Passing the sample count must not invent a seventh zone below the last
  // bound. Nothing can reach it -- zero of the corpus's 2,027,633 notes change
  // -- but it made the rule look broken when it was not.
  for (const note of [0, 1, 11, 12, 60, 87, 127]) {
    assert.ok(resolveSlot(conga, note, 7) < 6, `note ${note} must stay inside a real zone`);
  }
  assert.equal(resolveSlot(conga, 0, 7), 5, 'the lowest note lands in the last real zone');

  // mime_artist: one bound, four samples, Numstack 5 -- stack layers, not zones.
  const mime = { slots: [{}, {}, {}, {}], splitNotes: [87, 0, 0, 0, 0] } as never as Parameters<
    typeof zoneCount
  >[0];
  assert.equal(zoneCount(mime), 1);
  assert.equal(resolveSlot(mime, 40, 4), 0, 'every note plays the one zone');
});

test('a note exactly on a bound belongs to the zone above it', async () => {
  const { resolveSlot } = await import('../src/core/instrument.ts');
  // The engine's loop at fmodextinput.prx 0x05a0 continues while
  // `splitNotes[i + 1] > note`, so equality exits and the note keeps the
  // higher zone. 215,449 of 968,829 corpus notes sit exactly on a bound, so
  // this is 22.2% of everything, not an edge case.
  const kit = {
    slots: Array.from({ length: 8 }, (_, i) => ({ baseNote: [87, 78, 57, 51, 40, 33, 27, 21][i] })),
    splitNotes: [87, 72, 60, 54, 48, 36, 30, 24, 0],
  } as never as Parameters<typeof resolveSlot>[0];

  assert.equal(resolveSlot(kit, 24, 8), 6, 'on the bound -> the zone above it');
  assert.equal(resolveSlot(kit, 23, 8), 7, 'one below -> the zone under it');
  assert.equal(resolveSlot(kit, 25, 8), 6);
  // The whole drum pattern this came from: 12 and 24 must be different drums.
  assert.notEqual(resolveSlot(kit, 12, 8), resolveSlot(kit, 24, 8));

  // splitNotes[0] is a ceiling and is never compared -- the walk starts at
  // [0x4c4], one int past the base of the array.
  assert.equal(resolveSlot(kit, 87, 8), 0);
  assert.equal(resolveSlot(kit, 127, 8), 0, 'above the ceiling still lands in zone 0');
});
