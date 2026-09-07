/**
 * Every sound the game ships has an icon of its own, and every icon is for a
 * sound that exists: the table in `src/editor/icons.ts` against the
 * extracted manifest, when the fixtures are there.
 */

import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ICONS, iconKeyOf } from '../src/editor/icons.ts';

const MANIFEST = path.resolve(import.meta.dirname, '../../../fixtures/rinst/manifest.json');

test('every icon is a path, and the table names the 68 sounds', () => {
  for (const [key, icon] of Object.entries(ICONS)) {
    assert.match(icon.d, /^M/, `${key}: the stroke path starts with a move`);
    if (icon.f) assert.match(icon.f, /^M/, `${key}: the fill path starts with a move`);
    assert.doesNotMatch(icon.d, /NaN|undefined/, key);
  }
  assert.equal(Object.keys(ICONS).length, 68);
});

test('the manifest and the icon table name the same sounds', { skip: !existsSync(MANIFEST) }, () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { instruments?: { file: string }[] } | { file: string }[];
  const rows = Array.isArray(manifest) ? manifest : (manifest.instruments ?? []);
  const files = new Set(rows.map((r) => iconKeyOf(r.file)));
  const missing = [...files].filter((f) => !(f in ICONS));
  const extra = Object.keys(ICONS).filter((k) => !files.has(k));
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] });
});
