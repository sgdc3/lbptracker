/**
 * Every primitive read the parse makes, with its offset and VALUE.
 *
 * The technique steering/level-files.md calls for: widths align at any offset,
 * values do not. Used here to recover what a real sequencer plan holds in the
 * parts this reader otherwise discards -- the chassis the writer has to
 * reproduce.
 */
import { readFile } from 'node:fs/promises';

import { readPlan } from '@lbptracker/cwlib/level.ts';
import { partReaders } from '@lbptracker/cwlib/parts.ts';
import { nodeInflate } from '@lbptracker/cwlib/platform/node.ts';
import { Serializer } from '@lbptracker/cwlib/serializer.ts';
import { setTrace } from '@lbptracker/cwlib/thing.ts';

const FILE = process.argv[2];
const WANT = (process.argv[3] ?? '').split(',').filter(Boolean);

interface Read { name: string; start: number; end: number; value: string }
const reads: Read[] = [];
const proto = Serializer.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
for (const name of ['u8', 'i8', 'bool', 'u16', 'i16', 'f32', 'i32', 'u32', 's32', 'u64Big',
  'str', 'wstr', 'guid', 'sha1', 'resource', 'matrix', 'bytes', 'uleb128']) {
  const original = proto[name];
  proto[name] = function patched(this: Serializer, ...args: unknown[]) {
    const start = this.position;
    const value = original.apply(this, args);
    if (name !== 'uleb128') {
      reads.push({ name, start, end: this.position, value: show(value) });
    }
    return value;
  };
}
function show(v: unknown): string {
  if (v instanceof Uint8Array) return `[${v.length}]${[...v.subarray(0, 24)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  if (v instanceof Float32Array) return `m[${[...v].join(',')}]`;
  if (v && typeof v === 'object') return JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? [...x] : x));
  return String(v);
}

const spans: { name: string; start: number; end: number }[] = [];
setTrace((name, start, end) => { if (end >= 0) spans.push({ name, start, end }); });
await readPlan(new Uint8Array(await readFile(FILE)), nodeInflate, partReaders());
setTrace(undefined);

const RANGE = (process.argv[4] ?? '').split('..').map(Number);
if (RANGE.length === 2) {
  for (const r of reads.filter((x) => x.start >= RANGE[0] && x.end <= RANGE[1])) {
    console.log(`  ${String(r.start).padStart(6)}..${String(r.end).padEnd(6)} ${r.name.padEnd(8)} ${r.value}`);
  }
  process.exit(0);
}
for (const span of spans) {
  const bare = span.name.split(' ')[0];
  if (WANT.length && !WANT.includes(bare)) continue;
  const inside = reads.filter((r) => r.start >= span.start && r.end <= span.end);
  console.log(`\n### ${span.name} ${span.start}..${span.end} (${span.end - span.start} bytes, ${inside.length} reads)`);
  for (const r of inside) console.log(`  ${String(r.start).padStart(6)}..${String(r.end).padEnd(6)} ${r.name.padEnd(8)} ${r.value}`);
}
