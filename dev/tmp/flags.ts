import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadResourceFile } from '../../src/platform/node.ts';
const man = JSON.parse(await readFile('fixtures/rinst/manifest.json','utf8'));
// Slot record on the wire: s32 baseNote, f32 baseBpm, bool pitched, bool a, bool b, f32 fineTune
// = 4+4+1+1+1+4 = 15 bytes. Find them by locating the first slot and stepping.
const counts = new Map<string,number>();
const perInst: string[] = [];
for (const r of man) {
  const data = (await loadResourceFile(path.join('fixtures/rinst', r.file))).data;
  // scan for a plausible slot table: 8 records of 15 bytes with baseNote 0..127
  for (let off = 0; off < data.length - 8*15; off++) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let ok = true; const flags: string[] = [];
    for (let i = 0; i < 8 && ok; i++) {
      const o = off + i*15;
      const bn = dv.getInt32(o, false);
      const bpm = dv.getFloat32(o+4, false);
      if (bn < 0 || bn > 127 || !(bpm > 20 && bpm < 400)) { ok = false; break; }
      flags.push(`${data[o+8]}${data[o+9]}${data[o+10]}`);
    }
    if (ok) { perInst.push(`${r.path.split('/').pop()!.padEnd(28)} ${flags.join(' ')}`); for(const f of flags) counts.set(f,(counts.get(f)||0)+1); break; }
  }
}
console.log('slot flag triples (pitched, ?, ?) across all slots:');
for (const [k,v] of [...counts].sort((a,b)=>b[1]-a[1])) console.log(`   ${k}: ${v}`);
console.log('\nsample instruments:');
for (const l of perInst.slice(0,10)) console.log('  '+l);
