import { strict as assert } from 'node:assert';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';

import { looksLikeLevel, readBackup, readBackupZip, sequencersOf } from '../src/core/backup.ts';
import { crc32, readZip, writeZip } from '../src/core/zip.ts';
import { nodeInflate, nodeInflateRaw } from '../src/platform/node.ts';

/* ------------------------------------------------------------------- zip */

test('a zip this project wrote reads back as what went in', async () => {
  const entries = [
    { name: 'a.txt', bytes: new TextEncoder().encode('hello') },
    { name: 'deep/b.bin', bytes: Uint8Array.of(0, 1, 2, 250, 251) },
  ];
  const back = await readZip(writeZip(entries), nodeInflateRaw);
  assert.deepEqual(back.map((e) => e.name), ['a.txt', 'deep/b.bin']);
  assert.deepEqual([...back[0].bytes], [...entries[0].bytes]);
  assert.deepEqual([...back[1].bytes], [...entries[1].bytes]);
});

test('a deflated entry inflates, and the local header is measured on its own', async () => {
  // ⚠️ **The local header's name and extra fields are its own length, not the
  // central directory's.** An archiver may put a timestamp field in one and not
  // the other, and using the wrong length lands mid-data. This builds exactly
  // that: five extra bytes in the local header and none in the central one.
  const raw = new TextEncoder().encode('the quick brown fox '.repeat(40));
  const packed = new Uint8Array(deflateRawSync(raw));
  const name = new TextEncoder().encode('x.txt');
  const extra = Uint8Array.of(1, 2, 3, 4, 5);
  const local = new Uint8Array(30 + name.length + extra.length + packed.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(8, 8, true); // deflate
  lv.setUint32(14, crc32(raw), true);
  lv.setUint32(18, packed.length, true);
  lv.setUint32(22, raw.length, true);
  lv.setUint16(26, name.length, true);
  lv.setUint16(28, extra.length, true);
  local.set(name, 30);
  local.set(extra, 30 + name.length);
  local.set(packed, 30 + name.length + extra.length);

  const central = new Uint8Array(46 + name.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(10, 8, true);
  cv.setUint32(16, crc32(raw), true);
  cv.setUint32(20, packed.length, true);
  cv.setUint32(24, raw.length, true);
  cv.setUint16(28, name.length, true);
  cv.setUint32(42, 0, true); // the local header is at 0
  central.set(name, 46);

  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, local.length, true);

  const zip = new Uint8Array(local.length + central.length + end.length);
  zip.set(local);
  zip.set(central, local.length);
  zip.set(end, local.length + central.length);

  const back = await readZip(zip, nodeInflateRaw);
  assert.equal(back.length, 1);
  assert.equal(new TextDecoder().decode(back[0].bytes), new TextDecoder().decode(raw));
});

test('a zip with no end-of-central-directory record is refused, not guessed at', async () => {
  await assert.rejects(
    () => readZip(new TextEncoder().encode('PK not really'), nodeInflateRaw),
    /no end-of-central-directory/,
  );
});

/* ---------------------------------------------------------------- backup */

test('a level is told from everything else by its first four bytes', () => {
  // ❗ Never by its name: the game names a resource after its SHA-1, so there is
  // no extension to go on and a backup is full of icons and save metadata.
  assert.ok(looksLikeLevel(new TextEncoder().encode('LVLb....')));
  assert.ok(looksLikeLevel(new TextEncoder().encode('PLNb....')));
  assert.ok(!looksLikeLevel(new TextEncoder().encode('\x89PNG')));
  assert.ok(!looksLikeLevel(Uint8Array.of(1, 2)));
});

test('a pile of files is sorted into levels, others and failures', async () => {
  const files = [
    { name: 'ICON0.PNG', bytes: new TextEncoder().encode('\x89PNG.....') },
    { name: 'PARAM.SFO', bytes: new TextEncoder().encode('\x00PSF.....') },
    // A level magic with nothing behind it: this is what a truncated or
    // unreadable level looks like, and it must be REPORTED.
    { name: 'broken', bytes: new TextEncoder().encode('LVLb') },
  ];
  const result = await readBackup(files, nodeInflate);
  assert.equal(result.projects.length, 0);
  assert.equal(result.other, 2, 'the icon and the save metadata are not levels');
  assert.equal(result.failed.length, 1, 'and the broken one is named, not swallowed');
  assert.equal(result.failed[0].name, 'broken');
});

test('a backup read as a folder and as a zip give the same answer', async () => {
  const files = [
    { name: 'ICON0.PNG', bytes: new TextEncoder().encode('\x89PNG.....') },
    { name: 'nothing', bytes: Uint8Array.of(7, 7, 7, 7, 7, 7) },
  ];
  const folder = await readBackup(files, nodeInflate);
  const zipped = await readBackupZip(writeZip(files), nodeInflate, nodeInflateRaw);
  assert.deepEqual(
    { p: folder.projects.length, o: folder.other, f: folder.failed.length },
    { p: zipped.projects.length, o: zipped.other, f: zipped.failed.length },
  );
});

test('a sequencer is keyed by its level and its uid, never the uid alone', () => {
  // ⚠️ **A uid is unique inside a level, not across a backup.** A folder of
  // forty levels routinely holds two sequencers numbered 7, and a picker keyed
  // on the uid shows one row where there are two and plays the wrong song.
  const one = { file: 'aaa', sequencers: [{ uid: 7, name: 'Intro', tracks: [1, 2] }] };
  const two = { file: 'bbb', sequencers: [{ uid: 7, name: 'Intro', tracks: [1] }] };
  const rows = sequencersOf({
    projects: [one, two] as never,
    quiet: 0,
    other: 0,
    failed: [],
  });
  assert.deepEqual(rows.map((r) => r.key), ['aaa#7', 'bbb#7']);
  assert.deepEqual(rows.map((r) => r.tracks), [2, 1], 'busiest first');
});
