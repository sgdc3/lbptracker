/**
 * `PARAM.SFO` -- the plain-text index beside a PS3 save.
 *
 * ❗ **This is where a backup's own name lives.** The numbered files beside it
 * hold the level and are XXTEA'd (`savearchive.ts` opens them); `PARAM.SFO` is
 * not encrypted at all, and it holds the title the player gave the backup. A zip
 * called `32406766.zip` says "FJ's Music Hub by Festerd_Jester" for thirty lines
 * of reading, and that is the name to put on screen.
 *
 * ⚠️ This module was written while the level was believed unreadable, as a
 * consolation prize -- "at least say what it is". The belief was wrong; the file
 * is still the only place the player's own title survives, so it stays.
 *
 * The format is a header, a key table, a value table, and one 16-byte entry per
 * pair. Values are UTF-8 strings (format `0x0204`) or 32-bit integers
 * (`0x0404`); this reads the strings, which is all a name needs.
 */

const MAGIC = 0x46535000; // "\0PSF", little-endian

/** Read the string entries of a `PARAM.SFO`, or an empty map if it is not one. */
export function readPsf(bytes: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  if (bytes.length < 0x14) return out;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) return out;
  const keyTable = view.getUint32(8, true);
  const valueTable = view.getUint32(12, true);
  const count = view.getUint32(16, true);
  // ⚠️ A count read out of the file is a length nobody has checked. Ten
  // thousand entries in a 420-byte file is a corrupt save, not a reason to spin.
  const entries = Math.min(count, 1024);
  for (let i = 0; i < entries; i += 1) {
    const at = 0x14 + i * 0x10;
    if (at + 0x10 > bytes.length) break;
    const keyAt = keyTable + view.getUint16(at, true);
    const format = view.getUint16(at + 2, true);
    const length = view.getUint32(at + 4, true);
    const valueAt = valueTable + view.getUint32(at + 12, true);
    if (format !== 0x0204) continue; // not a string
    if (keyAt >= bytes.length || valueAt + length > bytes.length) continue;
    let end = keyAt;
    while (end < bytes.length && bytes[end] !== 0) end += 1;
    const key = new TextDecoder().decode(bytes.subarray(keyAt, end));
    // The value is NUL-padded to its slot; the trailing zeros are not the text.
    let stop = valueAt + length;
    while (stop > valueAt && bytes[stop - 1] === 0) stop -= 1;
    out.set(key, new TextDecoder().decode(bytes.subarray(valueAt, stop)));
  }
  return out;
}

/**
 * What to call a save on screen: what the player named it, then the game's own.
 *
 * `SUB_TITLE` is the level's name -- "FJ's Music Hub by Festerd_Jester" -- and
 * `TITLE` is what the backup tool wrote, "LittleBigPlanet 2 Level Backup from
 * …". The first is the one somebody recognises.
 */
export function psfName(bytes: Uint8Array): string | undefined {
  const psf = readPsf(bytes);
  return psf.get('SUB_TITLE') || psf.get('TITLE') || undefined;
}
