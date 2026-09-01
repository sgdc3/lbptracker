import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findSample, readBank, sampleData } from '../src/core/fsb.ts';
import { decodeIma, toFloatChannels } from '../src/core/ima.ts';
import { writeWav } from '../src/core/wav.ts';

/**
 * The bank is the user's own copy of a copyrighted game asset and is never
 * committed -- see steering/game-assets.md. Point LBP_FSB at it to run these;
 * without it they skip.
 */
const BANK =
  process.env.LBP_FSB ??
  'D:\\PS4Games\\CUSA00063\\gamedata\\audio\\sfxbank_compressed.fsb';

const PYTHON =
  process.env.LBP_PYTHON ??
  'C:\\Users\\sgdc3\\AppData\\Local\\Programs\\Python\\Python314\\python.exe';

async function loadBank() {
  return readBank(new Uint8Array(await readFile(BANK)));
}

test('reports a helpful error on something that is not a bank', async () => {
  const { readBank: read, FsbFormatError } = await import('../src/core/fsb.ts');
  const notABank = new Uint8Array(0x40);
  notABank.set([0x4c, 0x56, 0x4c, 0x62]); // "LVLb"
  assert.throws(() => read(notABank), FsbFormatError);
});

test('bank header and sample table match what steering records', async (t) => {
  if (!existsSync(BANK)) {
    t.skip(`no bank at ${BANK} (set LBP_FSB)`);
    return;
  }
  const bank = await loadBank();

  assert.equal(bank.sampleCount, 1048, 'sfxbank_compressed.fsb holds 1048 samples');
  assert.equal(bank.version, 0x00040000, 'every LBP3 bank is version 0x40000');
  assert.equal(bank.mode, 0x20, 'every LBP3 bank has file mode 0x20');
  assert.equal(bank.samples.length, bank.sampleCount, 'walked every header');

  // Data offsets are cumulative; the last one plus its length must land on or
  // before the end of the file, which is an independent check that every
  // header's size field was read correctly.
  const last = bank.samples[bank.samples.length - 1];
  assert.ok(
    last.dataOffset + last.lengthBytes <= bank.bytes.length,
    'sample data fits inside the bank',
  );

  const codecs = new Set(bank.samples.map((s) => s.codec));
  assert.ok(codecs.has('ima_adpcm'), 'the instrument material is IMA ADPCM');
  assert.ok(!codecs.has('unknown'), 'no sample uses a codec we do not recognise');
});

test('the IMA block geometry holds for every ADPCM sample in the bank', async (t) => {
  if (!existsSync(BANK)) {
    t.skip(`no bank at ${BANK} (set LBP_FSB)`);
    return;
  }
  const bank = await loadBank();
  // 36 bytes per channel per 64 samples, with the tail padded to a 32-byte
  // boundary. This is the measurement game-assets.md rests on; assert it across
  // the whole bank rather than the three samples that were checked by hand.
  let checked = 0;
  for (const s of bank.samples) {
    if (s.codec !== 'ima_adpcm') continue;
    const blocks = Math.ceil(s.lengthSamples / 64);
    const expected = blocks * 36 * s.channels;
    const padded = Math.ceil(expected / 32) * 32;
    assert.ok(
      s.lengthBytes === padded || s.lengthBytes === expected,
      `${s.name}: ${s.lengthBytes} bytes, expected ${expected} (padded ${padded})`,
    );
    checked += 1;
  }
  // Every sample in this particular bank is ADPCM. (The 3601 figure in
  // game-assets.md is across all 236 banks, not this one.)
  assert.equal(checked, bank.sampleCount, 'every sample in this bank is ADPCM');
  assert.equal(checked, 1048);
});

test('piano_C3 decodes to the frames, rate and level steering records', async (t) => {
  if (!existsSync(BANK)) {
    t.skip(`no bank at ${BANK} (set LBP_FSB)`);
    return;
  }
  const bank = await loadBank();
  const sample = findSample(bank, 'piano_C3');
  assert.ok(sample, 'piano_C3 is in the bank');
  assert.equal(sample.codec, 'ima_adpcm');
  assert.equal(sample.freq, 22050);
  assert.equal(sample.channels, 1);

  const pcm = decodeIma(sampleData(bank, sample), sample.channels, sample.lengthSamples);
  assert.equal(pcm.length, 66112, 'frame count matches the Python reference');

  let peak = 0;
  let sumSquares = 0;
  let clipped = 0;
  for (const v of pcm) {
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sumSquares += v * v;
    if (v >= 32767 || v <= -32768) clipped += 1;
  }
  const rms = Math.sqrt(sumSquares / pcm.length);
  assert.equal(clipped, 0, 'a wrong decoder clips; a right one does not');
  assert.equal(peak, 28588, 'peak matches the Python reference');
  assert.ok(Math.abs(rms - 2770) < 1, `rms ${rms.toFixed(1)}, expected ~2770`);

  const [channel] = toFloatChannels(pcm, 1);
  assert.equal(channel.length, 66112);
  assert.ok(Math.max(...channel.subarray(0, 1000)) <= 1);
});

test('GOLDEN: the TypeScript decoder is byte-identical to tools/fsb.py', async (t) => {
  if (!existsSync(BANK)) {
    t.skip(`no bank at ${BANK} (set LBP_FSB)`);
    return;
  }
  if (!existsSync(PYTHON)) {
    t.skip(`no python at ${PYTHON} (set LBP_PYTHON)`);
    return;
  }

  const bank = await loadBank();
  const dir = mkdtempSync(path.join(tmpdir(), 'lbpt-golden-'));
  try {
    for (const name of ['piano_C3', 'triangle_synth_C4', 'eDrums_kick_01']) {
      const sample = findSample(bank, name);
      if (!sample || sample.codec !== 'ima_adpcm') continue;

      const out = path.join(dir, `${name}.wav`);
      execFileSync(PYTHON, ['tools/fsb.py', 'wav', BANK, sample.name, out], {
        stdio: 'pipe',
      });
      const expected = new Uint8Array(readFileSync(out));

      const pcm = decodeIma(
        sampleData(bank, sample),
        sample.channels,
        sample.lengthSamples,
      );
      const actual = writeWav(pcm, sample.channels, sample.freq);

      assert.equal(actual.length, expected.length, `${name}: wav length`);
      let firstDiff = -1;
      for (let i = 0; i < expected.length; i += 1) {
        if (actual[i] !== expected[i]) {
          firstDiff = i;
          break;
        }
      }
      assert.equal(
        firstDiff,
        -1,
        `${name}: first differing byte at ${firstDiff}` +
          (firstDiff >= 0
            ? ` (ts ${actual[firstDiff]}, py ${expected[firstDiff]})`
            : ''),
      );
      console.log(`    ${sample.name}: ${expected.length} bytes identical`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
