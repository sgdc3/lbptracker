/**
 * The LBP **save archive** -- what a PS3 level backup actually holds.
 *
 * A backup from a PS3 is a save-game folder: `PARAM.SFO`, `PARAM.PFD`,
 * `ICON0.PNG`, and numbered files `0`, `1`, … that carry the level. Those
 * numbered files are one archive split into 0x240000-byte chunks, each
 * **XXTEA-encrypted**, and the archive inside is a `FAR4`: the resources back to
 * back, then a save key, then a table of `SHA-1 + offset + size`, and the entry
 * count and magic in the last eight bytes.
 *
 * ❗ **The encryption is the game's own and its key is a constant.** This module
 * once said a PS3 save "cannot be read", on evidence -- "8.000 bits per byte,
 * all 256 values" -- that is equally true of COMPRESSED data and so distinguished
 * nothing. The file was not PS3 savedata encryption at all. It ends with the
 * four bytes `FAR4` **in the clear**, which was sitting in the hex dump that was
 * offered as proof of the opposite.
 *
 * ✔ **Measured**, on `BCES00850LEVEL01EE7CEE/0` from a real backup: decrypting
 * with the key below yields 28 resources whose **28 SHA-1s all match their
 * bytes**, one of them a 275 KB `LVLb` holding 11 music sequencers -- including
 * "Ascetic - Festerd_Jester", which is where this project's own MIDI fixture
 * came from. A wrong key cannot produce 28 matching SHA-1s.
 *
 * The same key and the same table appear in two independent implementations,
 * ennuo's `cwlib/util/Crypto.java` (`TEA_KEY`, "used for encrypting/decrypting
 * RLocalProfile and profile backups") and Zaprit's `lbp_archive_dl`
 * (`src/serializers/lbp/save_archive.rs`), which is how a website can serve the
 * same level as a PS3 backup and as loose resources: it holds the resources and
 * encrypts on the way out.
 *
 * ⚠️ **`crypto.subtle` is used here and nothing else platform-shaped is.** It is
 * a web standard present in the browser and in Node, like the `TextDecoder` that
 * `psf.ts` uses, and the SHA-1 it computes is not decoration: it is the check
 * that says the decryption was right. See the chunk note below for the case it
 * is guarding.
 */

/**
 * XXTEA key, used for save archives and profile backups.
 *
 * Not a secret and never was: it is a literal in the game and in every tool that
 * reads these files.
 */
const TEA_KEY = [0x01b70cbd, 0x149607d6, 0x07f94dd5, 0x10db8ca0];

const DELTA = 0x9e3779b9;

/**
 * Bytes per chunk: the archive is cut into files `0`, `1`, … at this size.
 *
 * ⚠️ **UNVERIFIED for more than one chunk.** The only save measured here is
 * 472,960 bytes and so a single chunk; the size comes from `lbp_archive_dl`,
 * whose writer the game must agree with for its output to load. Each chunk is
 * encrypted on its own, so a wrong boundary would decrypt chunk 0 correctly and
 * turn the rest to noise -- which is exactly what the per-resource SHA-1 check
 * catches, loudly, instead of handing back a corrupt level.
 */
const CHUNK = 0x240000;

/** "FAR", the top three bytes of the archive magic; the fourth is a digit. */
const FAR = 0x464152;

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** One resource out of a save archive. */
export interface SaveResource {
  /** The resource's SHA-1, lower-case hex -- the name the game knows it by. */
  readonly sha1: string;
  readonly bytes: Uint8Array;
}

/**
 * XXTEA over big-endian 32-bit words, in place.
 *
 * The whole buffer is ONE block -- not eight-byte blocks like TEA -- so `rounds`
 * is 6 for anything of real size and every word depends on its neighbours.
 */
function xxtea(v: Uint32Array, decrypt: boolean): void {
  const n = v.length;
  if (n < 2) return;
  const rounds = 6 + Math.floor(52 / n);
  const mix = (p: number, sum: number, e: number): number => {
    const z = v[p > 0 ? p - 1 : n - 1];
    const y = v[p + 1 === n ? 0 : p + 1];
    // Every term here is an int32 in JavaScript and the additions may exceed it;
    // `^` applies ToInt32, which wraps modulo 2^32, so the arithmetic is the
    // reference implementation's despite the doubles in between.
    return ((((z >>> 5) ^ (y << 2)) + ((y >>> 3) ^ (z << 4)))
      ^ ((sum ^ y) + (TEA_KEY[(p ^ e) & 3] ^ z))) >>> 0;
  };
  if (decrypt) {
    let sum = (rounds * DELTA) >>> 0;
    while (sum !== 0) {
      const e = (sum >>> 2) & 3;
      for (let p = n - 1; p >= 0; p -= 1) v[p] -= mix(p, sum, e);
      sum = (sum - DELTA) >>> 0;
    }
  } else {
    let sum = 0;
    for (let i = 0; i < rounds; i += 1) {
      sum = (sum + DELTA) >>> 0;
      const e = (sum >>> 2) & 3;
      for (let p = 0; p < n; p += 1) v[p] += mix(p, sum, e);
    }
  }
}

/** Read `count` big-endian words out of `bytes`, decrypt or encrypt, write back. */
function crypt(bytes: Uint8Array, end: number, decrypt: boolean): void {
  if (end % 4 !== 0) throw new Error(`save archive chunk of ${end} bytes is not 4-aligned`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const words = new Uint32Array(end / 4);
  for (let i = 0; i < words.length; i += 1) words[i] = view.getUint32(i * 4, false);
  xxtea(words, decrypt);
  for (let i = 0; i < words.length; i += 1) view.setUint32(i * 4, words[i], false);
}

/**
 * The archive revision, from the magic in the LAST four bytes, or `undefined`.
 *
 * ❗ **The magic is at the end and it is not encrypted.** The writer leaves the
 * final four bytes of the final chunk in the clear, so `FAR4` is readable in the
 * raw file -- which is how a save is told from anything else here, and it is
 * cheap enough to check before doing any work.
 */
export function saveArchiveRevision(bytes: Uint8Array): number | undefined {
  if (bytes.length < 8) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(bytes.length - 4, false);
  if (magic >>> 8 !== FAR) return undefined;
  const revision = (magic & 0xff) - 0x30;
  return revision >= 2 && revision <= 5 ? revision : undefined;
}

/**
 * Decrypt a save archive's chunks and hand back the resources inside.
 *
 * `chunks` are the numbered files in order. Throws if the archive does not
 * unpack -- including if a resource's bytes do not hash to the SHA-1 the table
 * gives, which is the one check that can tell a decryption that half worked from
 * one that worked.
 */
export async function readSaveArchive(
  chunks: readonly Uint8Array[],
): Promise<SaveResource[]> {
  if (chunks.length === 0) throw new Error('no chunks');
  const last = chunks[chunks.length - 1];
  const revision = saveArchiveRevision(last);
  if (revision === undefined) throw new Error('not a save archive: no FAR magic at the end');

  let size = 0;
  for (const chunk of chunks) size += chunk.length;
  const archive = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    if (chunk.length > CHUNK) throw new Error(`chunk of ${chunk.length} bytes is over 0x240000`);
    const copy = archive.subarray(at, at + chunk.length);
    copy.set(chunk);
    // The four magic bytes at the very end were never encrypted.
    crypt(copy, chunk.length - (at + chunk.length === size ? 4 : 0), true);
    at += chunk.length;
  }

  const view = new DataView(archive.buffer);
  const count = view.getUint32(size - 8, false);
  // ⚠️ A count read out of a file is a length nobody has checked, and this one
  // came out of a decryption that may have gone wrong. 0x1c bytes per entry.
  let fat = size - 8 - count * 0x1c;
  if (revision > 2) fat -= 0x14; // the hashinate signature
  if (revision === 5) fat -= 4; // Vita: a fragment count as well
  if (fat < 0) throw new Error(`save archive claims ${count} resources it has no room for`);

  const out: SaveResource[] = [];
  const bad: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const entry = fat + i * 0x1c;
    const sha1 = hex(archive.subarray(entry, entry + 20));
    const offset = view.getUint32(entry + 20, false);
    const length = view.getUint32(entry + 24, false);
    if (offset + length > fat) throw new Error(`resource ${sha1} runs past the archive`);
    const bytes = archive.subarray(offset, offset + length);
    if (hex(new Uint8Array(await crypto.subtle.digest('SHA-1', bytes))) !== sha1) bad.push(sha1);
    out.push({ sha1, bytes });
  }
  if (bad.length > 0) {
    throw new Error(`${bad.length} of ${count} resources failed their SHA-1 (${bad[0]}…)`);
  }
  return out;
}
