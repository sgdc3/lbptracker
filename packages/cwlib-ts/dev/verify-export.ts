/**
 * Does the plan writer produce a file the reader reads back unchanged, and are
 * its non-musical parts the bytes the game itself writes?
 *
 * Two checks, one script:
 *
 * 1. **Round trip.** Every sequencer in every file given is imported, written
 *    out as a plan, read back and compared -- settings field by field and note
 *    records byte for byte.
 * 2. **Chassis diff.** The parts a sequencer carries that hold no music are
 *    written from constants (`src/write-plan.ts`); this dumps the byte span of
 *    each one from our output and from the real plan beside it and reports the
 *    first difference.
 *
 * ⚠️ The real plans are at subVersion `0x218` (PS4), so the diff runs at that
 * revision; the writer's default is `0x213` (PS3), which differs only where the
 * gates say it does.
 *
 *     node --experimental-strip-types dev/verify-export.ts fixtures/plans
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { readPlan } from '../src/level.ts';
import { partReaders } from '../src/parts.ts';
import { nodeDeflate, nodeInflate } from '../src/platform/node.ts';
import { importLevel, type Sequencer } from '../src/project.ts';
import { loadResource, readDependencies } from '../src/resource.ts';
import { setTrace } from '../src/thing.ts';
import { LBP3_PS4, writeSequencerPlan } from '../src/write-plan.ts';

const hex = (a: Uint8Array) => [...a].map((b) => b.toString(16).padStart(2, '0')).join('');

/** The part spans of a plan's root Thing, by part name. */
async function chassis(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const resource = await loadResource(bytes, nodeInflate);
  let at = resource.revision.branch >= 0xcc ? 1 : 0;
  const varint = () => {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      const byte = resource.data[at];
      at += 1;
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value;
    }
  };
  varint();
  const length = varint();
  const thingData = resource.data.subarray(at, at + length);
  const spans = new Map<string, Uint8Array>();
  // ⚠️ Depth, so the parts compared are the ROOT Thing's. The group chain's own
  // GROUP parts come first in the stream and are a different part of a
  // different Thing.
  let depth = 0;
  setTrace((name, start, end) => {
    const isThing = name.startsWith('THING');
    if (end < 0) { depth += 1; return; }
    if (isThing) { depth -= 1; return; }
    depth -= 1;
    if (depth !== 1 || spans.has(name)) return;
    spans.set(name, thingData.subarray(start, end));
  });
  try { await readPlan(bytes, nodeInflate, partReaders()); } finally { setTrace(undefined); }
  return spans;
}

function compare(a: Sequencer, b: Sequencer): string[] {
  const problems: string[] = [];
  const fields = ['tempo', 'swing', 'echoFeedback', 'echoTime', 'echoMix', 'reverb', 'loop',
    'startPoint', 'numChannels', 'name'] as const;
  for (const field of fields) {
    if (a[field] !== b[field]) problems.push(`${field}: ${String(a[field])} -> ${String(b[field])}`);
  }
  for (let i = 0; i < 6; i += 1) {
    if (a.volumes[i] !== b.volumes[i]) problems.push(`volumes[${i}]`);
  }
  if (a.tracks.length !== b.tracks.length) {
    problems.push(`tracks: ${a.tracks.length} -> ${b.tracks.length}`);
    return problems;
  }
  for (let i = 0; i < a.tracks.length; i += 1) {
    const x = a.tracks[i];
    const y = b.tracks[i];
    for (const field of ['guid', 'gridX', 'gridY', 'level', 'pan', 'echoSend', 'reverbSend',
      'key', 'scale', 'name', 'colour'] as const) {
      if (x[field] !== y[field]) problems.push(`track ${i} ${field}: ${String(x[field])} -> ${String(y[field])}`);
    }
    if (hex(x.records) !== hex(y.records)) problems.push(`track ${i} records differ`);
  }
  return problems;
}

async function* files(root: string): AsyncGenerator<string> {
  for (const name of await readdir(root)) {
    const file = path.join(root, name);
    if ((await stat(file)).isDirectory()) yield* files(file);
    else yield file;
  }
}

let checked = 0;
let failed = 0;
let chassisChecked = 0;
for (const root of process.argv.slice(2)) {
  for await (const file of files(root)) {
    const bytes = new Uint8Array(await readFile(file));
    if (bytes.length < 0x16 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'PLNb') continue;
    let project;
    try { project = importLevel(file, (await readPlan(bytes, nodeInflate, partReaders())).things, 'plan'); }
    catch { continue; }
    if (project.sequencers.length === 0) continue;

    const theirs = await chassis(bytes);
    for (const sequencer of project.sequencers) {
      checked += 1;
      const written = await writeSequencerPlan(sequencer, nodeDeflate, { revision: LBP3_PS4 });
      const back = importLevel('written', (await readPlan(written, nodeInflate, partReaders())).things, 'plan');
      if (back.sequencers.length !== 1) {
        failed += 1;
        console.log(`✘ ${path.basename(file).slice(0, 8)}: read back ${back.sequencers.length} sequencers`);
        continue;
      }
      const problems = compare(sequencer, back.sequencers[0]);
      if (problems.length) {
        failed += 1;
        console.log(`✘ ${path.basename(file).slice(0, 8)}: ${problems.slice(0, 4).join('; ')}${
          problems.length > 4 ? ` (+${problems.length - 4} more)` : ''}`);
      }
      // The chassis diff only makes sense against the first sequencer.
      if (chassisChecked === 0) {
        const ours = await chassis(written);
        for (const [name, mine] of ours) {
          const real = theirs.get(name);
          if (!real) continue;
          const same = hex(mine) === hex(real);
          console.log(`${same ? '✔' : '·'} ${name.padEnd(12)} ours ${String(mine.length).padStart(3)}B  game ${String(real.length).padStart(3)}B${same ? '' : `\n    ours ${hex(mine)}\n    game ${hex(real)}`}`);
        }
        chassisChecked = 1;
      }
    }
    const deps = readDependencies(await writeSequencerPlan(project.sequencers[0], nodeDeflate));
    if (checked <= 1) {
      console.log(`dependencies of the first written plan: ${deps.length}`);
      console.log(`  ${deps.map((d) => (d.kind === 'guid' ? `g${d.guid}/t${d.type}` : `hash/t${d.type}`)).join(' ')}`);
    }
  }
}
console.log(`\n${checked} sequencers round-tripped, ${failed} failed`);
