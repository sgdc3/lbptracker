/**
 * The Craftworld Toolkit **`.mod`** -- a zip of resources with a FileDB to name them.
 *
 * Transcribed from cwlib's `types/mods/Mod.java` (`process` and `save`), which is
 * the format's only definition: a `.mod` is the toolkit's own container and the
 * game never sees one -- the toolkit installs its contents into a FileDB and a
 * FARC. Inside the zip:
 *
 * | entry | what |
 * |---|---|
 * | `config.json` | `ModInfo`: ID, type, title, version, author, description |
 * | `data.map` | a FileDB (`types/databases/FileDB.java`): path, date, size, SHA-1, GUID per row |
 * | `data.farc` | a `FAR4` save archive **in the clear**, the rows' bytes by SHA-1 |
 * | `icon.png`, `patches.json` | optional; neither is read or written here |
 *
 * ⚠️ **`data.farc` ends in the same `FAR4` magic a PS3 save does and is NOT
 * encrypted.** `backup.ts` finds a save by that magic and XXTEA-decrypts it, so
 * a mod handed to `readBackup` as a pile would fail every SHA-1. `readBackupZip`
 * asks `looksLikeMod` first.
 *
 * ⚠️ Only the zip format is read. The legacy single-file `MODb`/`MODe` that
 * `Mod.fromLegacyMod` still opens is not.
 */

import { readFar, writeFar } from './savearchive.ts';
import { writeZip, type ZipFile } from './zip.ts';

/** cwlib's `ModInfo`, with its defaults. */
export interface ModInfo {
  readonly ID: string;
  readonly type: string;
  readonly title: string;
  readonly version: string;
  readonly author: string;
  readonly description: string;
}

export const DEFAULT_MOD_INFO: ModInfo = {
  ID: 'sample',
  type: 'pack',
  title: 'Untitled Mod',
  version: '1.0',
  author: 'Sackthing',
  description: 'No description was provided.',
};

/** One row of `data.map` with the bytes it names. */
export interface ModEntry {
  readonly path: string;
  readonly guid: number;
  readonly bytes: Uint8Array;
}

/** `Mod()`'s database revision: an LBP3 FileDB, which is what picks the row layout. */
const MOD_DB_REVISION = 0x01480100;

/** `FileDB.MIN_SAFE_GUID`: "not used by any of the LittleBigPlanet games". */
export const MIN_SAFE_GUID = 0x00180000;

/** `Branch.MIZUKI` -- the toolkit's own branch, which `Mod()` stamps on its archive. */
const MIZUKI = { head: 0x021803f9, branchId: 0x4d5a, branchRevision: 0xc } as const;

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

const leaf = (files: readonly ZipFile[], name: string): ZipFile | undefined =>
  files.find((f) => f.name === name);

/** Whether an unpacked zip is a mod: it says what it is and what it holds. */
export function looksLikeMod(files: readonly ZipFile[]): boolean {
  return leaf(files, 'config.json') !== undefined && leaf(files, 'data.map') !== undefined;
}

/**
 * Read an unpacked `.mod`.
 *
 * A row's bytes come from `data.farc` by SHA-1, or failing that from a loose
 * file at the row's own path, as `Mod.process` does. A row with neither is
 * dropped: the FileDB of a mod may name things it does not carry.
 */
export async function readMod(
  files: readonly ZipFile[],
): Promise<{ config: ModInfo; entries: ModEntry[] }> {
  const configFile = leaf(files, 'config.json');
  const map = leaf(files, 'data.map');
  if (!configFile) throw new Error('mod is missing config.json');
  if (!map) throw new Error('mod has no contents: data.map is missing');
  const config: ModInfo = {
    ...DEFAULT_MOD_INFO,
    ...(JSON.parse(new TextDecoder().decode(configFile.bytes)) as Partial<ModInfo>),
  };

  const farc = leaf(files, 'data.farc');
  const bySha1 = new Map<string, Uint8Array>();
  if (farc) for (const r of await readFar(farc.bytes)) bySha1.set(r.sha1, r.bytes);

  const b = map.bytes;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const lbp3 = (view.getUint32(0, false) >>> 16) >= 0x148;
  const count = view.getUint32(4, false);
  const entries: ModEntry[] = [];
  const seen = new Set<number>();
  let at = 8;
  for (let i = 0; i < count; i += 1) {
    const length = lbp3 ? view.getUint16(at, false) : view.getUint32(at, false);
    at += lbp3 ? 2 : 4;
    if (at + length + (lbp3 ? 4 : 8) + 28 > b.length) throw new Error('data.map runs past its end');
    const path = new TextDecoder().decode(b.subarray(at, at + length));
    at += length + (lbp3 ? 4 : 8) + 4; // the date, the size
    const sha1 = hex(b.subarray(at, at + 20));
    const guid = view.getUint32(at + 20, false);
    at += 24;
    if (seen.has(guid)) continue;
    seen.add(guid);
    const bytes = bySha1.get(sha1) ?? leaf(files, path)?.bytes;
    if (bytes) entries.push({ path, guid, bytes });
  }
  return { config, entries };
}

/**
 * Write a `.mod`: `Mod.save`, without the icon and the patches.
 *
 * An entry with no GUID takes the next free one from `MIN_SAFE_GUID`, which is
 * `FileDB.getNextGUID`. Rows go out in ascending GUID order, as `FileDB.build`
 * sorts them. The zip is stored; Java's zip filesystem reads either.
 */
export async function writeMod(
  info: Partial<ModInfo>,
  items: readonly { path: string; bytes: Uint8Array; guid?: number }[],
  when = new Date(),
): Promise<Uint8Array> {
  const used = new Set(items.flatMap((i) => (i.guid === undefined ? [] : [i.guid])));
  if (used.size !== items.filter((i) => i.guid !== undefined).length) {
    throw new Error('two mod entries share a GUID');
  }
  let next = MIN_SAFE_GUID;
  const rows = [];
  for (const item of items) {
    let guid = item.guid;
    if (guid === undefined) {
      while (used.has(next)) next += 1;
      guid = next;
      used.add(guid);
    }
    rows.push({
      path: new TextEncoder().encode(item.path.replace(/\\/g, '/')),
      guid,
      bytes: item.bytes,
      sha1: new Uint8Array(await crypto.subtle.digest('SHA-1', item.bytes as BufferSource)),
    });
  }
  rows.sort((l, r) => l.guid - r.guid);

  const map = new Uint8Array(8 + rows.reduce((sum, r) => sum + 0x22 + r.path.length, 0));
  const view = new DataView(map.buffer);
  view.setUint32(0, MOD_DB_REVISION, false);
  view.setUint32(4, rows.length, false);
  let at = 8;
  const date = Math.floor(when.getTime() / 1000);
  for (const row of rows) {
    view.setUint16(at, row.path.length, false);
    map.set(row.path, at + 2);
    at += 2 + row.path.length;
    view.setUint32(at, date, false);
    view.setUint32(at + 4, row.bytes.length, false);
    map.set(row.sha1, at + 8);
    view.setUint32(at + 28, row.guid, false);
    at += 32;
  }

  const config = JSON.stringify({ ...DEFAULT_MOD_INFO, ...info }, null, 2);
  return writeZip([
    { name: 'config.json', bytes: new TextEncoder().encode(config) },
    { name: 'data.map', bytes: map },
    { name: 'data.farc', bytes: await writeFar(rows.map((r) => r.bytes), MIZUKI) },
  ], when);
}
