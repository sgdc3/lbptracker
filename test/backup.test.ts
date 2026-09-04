import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';

import { looksLikeLevel, readBackup, readBackupZip, sequencersOf } from '../src/core/backup.ts';
import { psfName, readPsf } from '../src/core/psf.ts';
import { readSaveArchive, saveArchiveRevision } from '../src/core/savearchive.ts';
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
  // ❗ **A plan counts too, and it is where most of the music is.** It is not a
  // level -- its Things sit inside a nested `thingData` blob -- but
  // `readLevelProject` unwraps that now, and the corpus holds 172 sequencers
  // inside plans against 19 inside levels. See `test/plan.test.ts`.
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

/* --------------------------------------------------------- save archive */

/**
 * XXTEA over big-endian words, the encrypt direction.
 *
 * ❗ Deliberately here and not in `src`: nothing in this project writes a save,
 * and a decryptor with no encryptor to answer to is one nobody can test without
 * shipping somebody else's level as a fixture.
 */
function xxteaEncrypt(bytes: Uint8Array, end: number): void {
  const key = [0x01b70cbd, 0x149607d6, 0x07f94dd5, 0x10db8ca0];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = end / 4;
  const v = new Uint32Array(n);
  for (let i = 0; i < n; i += 1) v[i] = view.getUint32(i * 4, false);
  let sum = 0;
  for (let round = 0; round < 6 + Math.floor(52 / n); round += 1) {
    sum = (sum + 0x9e3779b9) >>> 0;
    const e = (sum >>> 2) & 3;
    for (let p = 0; p < n; p += 1) {
      const z = v[p > 0 ? p - 1 : n - 1];
      const y = v[p + 1 === n ? 0 : p + 1];
      v[p] += ((((z >>> 5) ^ (y << 2)) + ((y >>> 3) ^ (z << 4)))
        ^ ((sum ^ y) + (key[(p ^ e) & 3] ^ z))) >>> 0;
    }
  }
  for (let i = 0; i < n; i += 1) view.setUint32(i * 4, v[i], false);
}

/** A `FAR4` save archive holding these resources, encrypted the way the game's is. */
function buildSave(resources: readonly Uint8Array[]): Uint8Array {
  let body = 0;
  for (const r of resources) body += r.length;
  body += (4 - (body % 4)) % 4;
  const size = body + 0x84 + resources.length * 0x1c + 0x14 + 4 + 4;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  let fat = body + 0x84; // the save key is 0x84 bytes and nothing here reads it
  for (const resource of resources) {
    out.set(resource, at);
    out.set(new Uint8Array(createHash('sha1').update(resource).digest()), fat);
    view.setUint32(fat + 20, at, false);
    view.setUint32(fat + 24, resource.length, false);
    at += resource.length;
    fat += 0x1c;
  }
  view.setUint32(size - 8, resources.length, false);
  out.set(new TextEncoder().encode('FAR4'), size - 4);
  // ❗ Everything but the magic: the last four bytes are left in the clear, and
  // that is what makes a save recognisable without decrypting it first.
  xxteaEncrypt(out, size - 4);
  return out;
}

test('a save archive is told by the plaintext magic in its LAST four bytes', () => {
  // ❗ The evidence that a PS3 backup is readable at all was in the file the
  // whole time: `FAR4`, unencrypted, at the end. The entropy measurement that
  // "proved" the opposite could not see it, because it never looked there.
  const save = buildSave([new TextEncoder().encode('hello there')]);
  assert.equal(saveArchiveRevision(save), 4);
  assert.equal(new TextDecoder().decode(save.subarray(-4)), 'FAR4');
  assert.equal(saveArchiveRevision(new TextEncoder().encode('nope not this')), undefined);
});

test('a save archive decrypts to its resources, each under its own SHA-1', async () => {
  const one = new TextEncoder().encode('LVLb and then some bytes of level');
  const two = Uint8Array.from({ length: 300 }, (_, i) => (i * 37) & 0xff);
  const inside = await readSaveArchive([buildSave([one, two])]);
  assert.equal(inside.length, 2);
  assert.deepEqual([...inside[0].bytes], [...one]);
  assert.deepEqual([...inside[1].bytes], [...two]);
  assert.equal(inside[0].sha1, createHash('sha1').update(one).digest('hex'));
});

test('a save archive that half decrypts is refused, not handed back', async () => {
  // ⚠️ **The SHA-1 check is the point.** XXTEA runs as one block over the whole
  // chunk, so a wrong key or a wrong chunk boundary still yields a table of
  // plausible-looking numbers; only the hashes say whether the bytes are the
  // game's. This is what guards the multi-chunk path, which no measured save
  // exercises.
  const save = buildSave([new TextEncoder().encode('a resource worth checking')]);
  save[8] ^= 0x01;
  await assert.rejects(() => readSaveArchive([save]), /SHA-1|runs past|no room/);
});

test('a save game in a backup is opened, and its own files step aside', async () => {
  // ❗ What a dropped PS3 backup looks like: one folder, the archive in `0`, and
  // the plumbing beside it. What gets scanned for levels is what came OUT of the
  // archive, not the folder.
  const save = buildSave([
    new TextEncoder().encode('LVLb'),
    new TextEncoder().encode('\x89PNG not a level'),
  ]);
  const result = await readBackup([
    { name: 'BCES00850LEVEL01EE7CEE/0', bytes: save },
    { name: 'BCES00850LEVEL01EE7CEE/ICON0.PNG', bytes: new TextEncoder().encode('\x89PNG') },
    { name: 'BCES00850LEVEL01EE7CEE/PARAM.SFO', bytes: new TextEncoder().encode('\x00PSF') },
  ], nodeInflate);
  assert.deepEqual(
    result.saves.map((s) => ({ folder: s.folder, resources: s.resources, why: s.why })),
    [{ folder: 'BCES00850LEVEL01EE7CEE', resources: 2, why: undefined }],
  );
  assert.equal(result.other, 1, 'one resource is not a level, and the icon left with the save');
  assert.equal(result.failed.length, 1, 'a four-byte LVLb is a level that will not open, and says so');
  assert.match(result.failed[0].why, /too short|runs past/);
  assert.match(result.failed[0].name, /^BCES00850LEVEL01EE7CEE\/[0-9a-f]{40}$/);
});

test('a PARAM.SFO gives the save its own name', () => {
  // ❗ The one part of a PS3 save that is NOT encrypted, and it holds what the
  // player called the backup. Built here the way the format is: a header, a key
  // table, a value table, and one 16-byte entry per pair.
  const keys = new TextEncoder().encode('SUB_TITLE\x00TITLE\x00');
  const values = new Uint8Array(64);
  values.set(new TextEncoder().encode("FJ's Music Hub"), 0);
  values.set(new TextEncoder().encode('LBP2 Level Backup'), 32);
  const head = new Uint8Array(0x14 + 0x20);
  const hv = new DataView(head.buffer);
  hv.setUint32(0, 0x46535000, true);
  hv.setUint32(8, head.length, true);
  hv.setUint32(12, head.length + keys.length, true);
  hv.setUint32(16, 2, true);
  const entry = (i: number, keyOff: number, len: number, valueOff: number) => {
    const at = 0x14 + i * 0x10;
    hv.setUint16(at, keyOff, true);
    hv.setUint16(at + 2, 0x0204, true);
    hv.setUint32(at + 4, len, true);
    hv.setUint32(at + 8, len, true);
    hv.setUint32(at + 12, valueOff, true);
  };
  entry(0, 0, 32, 0);
  entry(1, 10, 32, 32);
  const sfo = new Uint8Array(head.length + keys.length + values.length);
  sfo.set(head);
  sfo.set(keys, head.length);
  sfo.set(values, head.length + keys.length);

  assert.equal(readPsf(sfo).get('SUB_TITLE'), "FJ's Music Hub");
  assert.equal(readPsf(sfo).get('TITLE'), 'LBP2 Level Backup');
  assert.equal(psfName(sfo), "FJ's Music Hub", "the player's name wins over the tool's");
  assert.equal(psfName(new TextEncoder().encode('not a psf at all')), undefined);
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
    saves: [],
  });
  assert.deepEqual(rows.map((r) => r.key), ['aaa#7', 'bbb#7']);
  assert.deepEqual(rows.map((r) => r.tracks), [2, 1], 'busiest first');
});
