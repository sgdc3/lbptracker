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
import { INSTRUMENT_LABELS } from '../src/editor/instrument-labels.ts';
import { instrumentsFrom } from '../src/editor/instruments.ts';

const MANIFEST = path.resolve(import.meta.dirname, '../../../fixtures/rinst/manifest.json');

test('every icon is a path, and the table names the 68 sounds', () => {
  for (const [key, icon] of Object.entries(ICONS)) {
    // Traced silhouettes come as `f` and are filled; `d` is stroked. One or
    // the other has to be there, or the sound falls back to a family glyph.
    assert.ok(icon.d || icon.f, `${key}: no path at all`);
    for (const path of [icon.d, icon.f]) {
      if (path === undefined) continue;
      assert.match(path, /^M/, `${key}: a path starts with a move`);
      assert.doesNotMatch(path, /NaN|undefined/, key);
      assert.ok(path.endsWith('Z') || icon.d === path, `${key}: a filled path closes`);
    }
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

test('every sound carries the name the game gives it, and every name a sound', { skip: !existsSync(MANIFEST) }, () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { guid: number; file: string }[];
  const guids = new Set(manifest.map((r) => r.guid));
  const labelled = Object.keys(INSTRUMENT_LABELS).map(Number);
  assert.deepEqual(
    {
      unnamed: manifest.filter((r) => !(r.guid in INSTRUMENT_LABELS)).map((r) => r.file),
      strays: labelled.filter((g) => !guids.has(g)),
    },
    { unnamed: [], strays: [] },
  );
  // Every label is "Category: Name", and both halves survive the split.
  for (const [guid, label] of Object.entries(INSTRUMENT_LABELS)) {
    assert.match(label, /^[A-Z][^:]*: \S/, `${guid}: ${label}`);
  }
  const info = instrumentsFrom(manifest);
  const harp = info.find((i) => i.guid === 129021);
  assert.deepEqual(
    harp && { name: harp.name, category: harp.category },
    { name: 'Harp', category: 'Plucked' },
    'the split keeps the two halves apart',
  );
});
