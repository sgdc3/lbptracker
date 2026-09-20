import { strict as assert } from 'node:assert';
import test from 'node:test';

import { readBackup, readBackupZip } from '../src/backup.ts';
import { DEFAULT_CHIP_COLOUR } from '../src/chips.ts';
import { MIN_SAFE_GUID, looksLikeMod, readMod, writeMod } from '../src/mod.ts';
import { nodeDeflate, nodeInflate, nodeInflateRaw } from '../src/platform/node.ts';
import type { Sequencer } from '../src/project.ts';
import { readFar, saveArchiveRevision, writeFar } from '../src/savearchive.ts';
import { writeSequencerPlan } from '../src/write-plan.ts';
import { readZip } from '../src/zip.ts';

const song: Sequencer = {
  uid: 1,
  name: 'mod song',
  author: '',
  tempo: 130,
  swing: 0,
  echoFeedback: 0.54,
  echoTime: 1,
  echoMix: 0.6,
  reverb: 5,
  loop: true,
  startPoint: 0,
  numChannels: 1,
  volumes: [1, 1, 1, 1, 1, 1],
  boardRows: 4,
  lengthSteps: 1,
  tracks: [{
    guid: 129085,
    name: '',
    colour: DEFAULT_CHIP_COLOUR,
    gridX: 0,
    gridY: 0,
    stepOffset: 0,
    level: 1,
    pan: 0.5,
    echoSend: 0,
    reverbSend: 0,
    key: 0,
    scale: 0,
    notes: [],
    records: Uint8Array.of(0, 60 | 0x80, 0x60, 0x40),
    trailingRecords: 0,
  }],
};

test('a plain FAR4 reads back, sorted by hash and with the key 4-aligned', async () => {
  const a = Uint8Array.of(1, 2, 3, 4, 5); // five bytes: forces the pad
  const b = Uint8Array.of(9, 9);
  const far = await writeFar([a, b, a], { head: 0x021803f9, branchId: 0x4d5a, branchRevision: 0xc });
  assert.equal(saveArchiveRevision(far), 4);
  const back = await readFar(far);
  assert.equal(back.length, 2, 'the same bytes twice are one resource');
  assert.deepEqual(back.map((r) => r.sha1), back.map((r) => r.sha1).sort());
  assert.deepEqual([...back.find((r) => r.bytes.length === 5)!.bytes], [...a]);
  // 7 bytes of data, 1 of pad, then the key opens with the head revision.
  assert.equal(new DataView(far.buffer).getUint32(8, false), 0x021803f9);
  assert.equal(far.length, 8 + 0x84 + 2 * 0x1c + 0x14 + 8);
});

test('a mod holds its config and its rows, and hands out GUIDs from the safe range', async () => {
  const mod = await writeMod({ title: 'T', author: 'me' }, [
    { path: 'plans/b.plan', bytes: Uint8Array.of(2) },
    { path: 'plans/a.plan', bytes: Uint8Array.of(1), guid: MIN_SAFE_GUID },
  ]);
  const files = await readZip(mod, nodeInflateRaw);
  assert.deepEqual(files.map((f) => f.name), ['config.json', 'data.map', 'data.farc']);
  assert.ok(looksLikeMod(files));
  const back = await readMod(files);
  assert.equal(back.config.title, 'T');
  assert.equal(back.config.type, 'pack', 'what was not given is ModInfo\'s default');
  assert.deepEqual(
    back.entries.map((e) => [e.path, e.guid, e.bytes[0]]),
    [['plans/a.plan', MIN_SAFE_GUID, 1], ['plans/b.plan', MIN_SAFE_GUID + 1, 2]],
  );
  await assert.rejects(writeMod({}, [
    { path: 'x', bytes: Uint8Array.of(1), guid: 5 },
    { path: 'y', bytes: Uint8Array.of(2), guid: 5 },
  ]));
});

test('a sequencer exported as a mod opens as the sequencer it was', async () => {
  const plan = await writeSequencerPlan(song, nodeDeflate);
  const mod = await writeMod({ title: song.name }, [{ path: 'plans/lbptracker/mod_song.plan', bytes: plan }]);
  const result = await readBackupZip(mod, nodeInflate, nodeInflateRaw);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.saves, [], 'data.farc is not a save and is not decrypted as one');
  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0].file, 'plans/lbptracker/mod_song.plan');
  const [seq] = result.projects[0].sequencers;
  assert.equal(seq.name, 'mod song');
  assert.deepEqual([...seq.tracks[0].records], [...song.tracks[0].records]);
});

test('the trap the mod route exists for: its farc, read as a pile, is taken for a save', async () => {
  const plan = await writeSequencerPlan(song, nodeDeflate);
  // A second resource whose hash sorts first, so the farc does not happen to
  // OPEN with the plan -- a one-plan farc starts with `PLNb` and reads as a
  // plan with rubbish after it, which is luck and not a route.
  let filler = Uint8Array.of(0);
  for (let i = 0; ; i += 1) {
    filler = Uint8Array.of(i);
    const far = await writeFar([plan, filler], { head: 0, branchId: 0, branchRevision: 0 });
    if (far[0] === i) break;
  }
  const mod = await writeMod({}, [{ path: 'p.plan', bytes: plan }, { path: 'f.bin', bytes: filler }]);
  const result = await readBackup(await readZip(mod, nodeInflateRaw), nodeInflate);
  assert.equal(result.projects.length, 0);
  assert.equal((await readBackupZip(mod, nodeInflate, nodeInflateRaw)).projects.length, 1);
  assert.ok(result.saves[0]?.why, 'XXTEA over plain bytes fails every SHA-1');
});
