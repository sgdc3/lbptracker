/**
 * The names the staged site serves are boring: `publicName` turns each of
 * the game's file names into one that `encodeURIComponent` leaves alone, so a
 * static host never has to decode `%23` or `%20` back into a file name.
 *
 * Over the real manifests when they are present — 216 samples, 3 with a `#`
 * and 48 with a space as of 2026-09-06 — and over the three known `#` names
 * always, so the rule is tested on a machine without the game too.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { publicName } from '../dev/stage-site.ts';

const KNOWN = [
  'violin_spic_string4_f#4.smp',
  'choir_f#3_v2.smp',
  'choir_g#4_v2.smp',
  'piano hi c4.smp',
];

test('publicName is the identity under encodeURIComponent', () => {
  for (const name of KNOWN) {
    const pub = publicName(name);
    assert.equal(encodeURIComponent(pub), pub, name);
    assert.doesNotMatch(pub, /[# ]/);
  }
  assert.equal(publicName('choir_f#3_v2.smp'), 'choir_f-sharp3_v2.smp');
  assert.equal(publicName('plain.smp'), 'plain.smp');
});

test('every name in the real manifests stays unique and boring', async (t) => {
  for (const dir of ['rinst', 'smp']) {
    let rows: { file: string }[];
    try {
      rows = JSON.parse(
        await readFile(new URL(`../../../fixtures/${dir}/manifest.json`, import.meta.url), 'utf8'),
      ) as { file: string }[];
    } catch {
      t.diagnostic(`fixtures/${dir}/manifest.json absent — skipped`);
      continue;
    }
    const pubs = new Set<string>();
    for (const { file } of rows) {
      const pub = publicName(file);
      assert.equal(encodeURIComponent(pub), pub, file);
      assert.ok(!pubs.has(pub), `collision on ${pub}`);
      pubs.add(pub);
    }
    assert.equal(pubs.size, rows.length);
  }
});
