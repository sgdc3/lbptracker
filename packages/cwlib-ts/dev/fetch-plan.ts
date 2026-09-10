/** Fetch a root level from the public archive and pull its PLAN dependencies. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { readDependencies } from '@lbptracker/cwlib/resource.ts';

function url(sha1: string): string {
  const h = sha1.toLowerCase();
  return `https://archive.org/download/dry23r${h[0]}/dry${h.slice(0, 2)}.zip/${h.slice(0, 2)}%2F${h.slice(2, 4)}%2F${h}`;
}

async function get(sha1: string): Promise<Uint8Array | undefined> {
  const res = await fetch(url(sha1));
  if (!res.ok) return undefined;
  const bytes = new Uint8Array(await res.arrayBuffer());
  return bytes.length > 0x16 ? bytes : undefined;
}

const ROOT = process.argv[2] ?? '8febe1f9';
const OUT = 'fixtures/plans';

async function main() {
  await mkdir(OUT, { recursive: true });
  const local = ROOT.length !== 40;
  const root = local ? new Uint8Array(await readFile(ROOT)) : await get(ROOT);
  if (!root) { console.log('root not found'); return; }
  const magic = String.fromCharCode(...root.subarray(0, 4));
  const deps = readDependencies(root);
  console.log(`root ${magic} ${root.length} bytes, ${deps.length} deps`);
  const plans = deps.filter((d) => d.kind === 'sha1' && d.type === 38);
  console.log(`${plans.length} plan dependencies`);
  let got = 0;
  for (const dep of plans) {
    if (dep.kind !== 'sha1') continue;
    const bytes = await get(dep.sha1);
    if (!bytes) { console.log(`  ${dep.sha1.slice(0, 8)} MISSING`); continue; }
    await writeFile(`${OUT}/${dep.sha1}`, bytes);
    console.log(`  ${dep.sha1.slice(0, 8)} ${String.fromCharCode(...bytes.subarray(0, 4))} ${bytes.length}`);
    got += 1;
  }
  console.log(`${got} fetched into ${OUT}`);
}
main();
