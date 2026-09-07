/**
 * The changelog is read by the person using the tracker, in a panel that
 * **escapes what it is given** (`changelogHtml` in `src/help.ts`: headings,
 * bullets and paragraphs, and every other character verbatim).
 *
 * ⚠️ So markdown inside an entry is not formatting, it is punctuation the
 * reader sees: `**master bus**` renders with its asterisks. It slipped in twice
 * and was spotted by the owner rather than by a test, which is what this is
 * for. The file's own header also forbids `--` and em dashes, for the same
 * reason: it is prose for a person, not source.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const CHANGELOG = path.resolve(import.meta.dirname, '../../../CHANGELOG.md');

test('no markdown, and no dashes, in what the reader is shown', () => {
  const lines = readFileSync(CHANGELOG, 'utf8').split(/\r?\n/);
  const from = lines.findIndex((l) => l.startsWith('## '));
  assert.ok(from > 0, 'the file should open with its note to editors, then the versions');
  const offences: string[] = [];
  lines.slice(from).forEach((line, i) => {
    const at = `line ${from + i + 1}: ${line.trim().slice(0, 60)}`;
    if (line.includes('**')) offences.push(`bold, ${at}`);
    if (line.includes('`')) offences.push(`code span, ${at}`);
    if (/\[[^\]]+\]\(/.test(line)) offences.push(`link, ${at}`);
    if (line.includes('--')) offences.push(`double dash, ${at}`);
    if (line.includes('—')) offences.push(`em dash, ${at}`);
  });
  assert.deepEqual(offences, []);
});
