/**
 * A ZIP writer, stored (uncompressed) only.
 *
 * It exists because splitting a song across several MIDI files has to arrive as
 * one download; a browser blocks a burst of them and a listener should not have
 * to approve nine saves. Deflate is not implemented and not wanted: MIDI is
 * already compact, the browser has no synchronous deflate to borrow, and
 * shipping a compressor to save a few hundred kilobytes would be the largest
 * thing in this repository by some margin.
 *
 * ⚠️ **Sizes are written twice and both copies must agree.** A local header
 * carries the CRC and the two sizes, and so does the central directory entry.
 * Writers that do not know the size in advance set a flag and put them in a
 * trailing descriptor instead; everything here is in memory, so both are filled
 * and the flag stays clear. An unzipper trusts the central directory, so a file
 * whose local header disagrees opens in some tools and not others.
 */

export interface ZipEntry {
  /** Stored as UTF-8. Forward slashes only; a backslash is a path on Windows. */
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** The standard CRC-32, built once. */
const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const utf8 = new TextEncoder();

/**
 * MS-DOS date and time, which is what a ZIP stores.
 *
 * Two-second resolution and a 1980 epoch, both of them the format's. A date
 * before 1980 cannot be represented, so it is clamped rather than wrapped into
 * something that reads as the future.
 */
function dosStamp(when: Date): { date: number; time: number } {
  const year = Math.max(1980, when.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1),
  };
}

export function writeZip(entries: readonly ZipEntry[], when = new Date()): Uint8Array {
  const stamp = dosStamp(when);
  const prepared = entries.map((entry) => ({
    name: utf8.encode(entry.name.replace(/\\/g, '/')),
    bytes: entry.bytes,
    crc: crc32(entry.bytes),
  }));

  const localSize = prepared.reduce((sum, e) => sum + 30 + e.name.length + e.bytes.length, 0);
  const centralSize = prepared.reduce((sum, e) => sum + 46 + e.name.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);

  let at = 0;
  const offsets: number[] = [];
  for (const entry of prepared) {
    offsets.push(at);
    view.setUint32(at, 0x04034b50, true); // local file header
    view.setUint16(at + 4, 20, true); // version needed
    // Bit 11 says the name is UTF-8, which every unzipper written this century
    // reads and the ones that do not would have mangled it anyway.
    view.setUint16(at + 6, 0x0800, true);
    view.setUint16(at + 8, 0, true); // stored
    view.setUint16(at + 10, stamp.time, true);
    view.setUint16(at + 12, stamp.date, true);
    view.setUint32(at + 14, entry.crc, true);
    view.setUint32(at + 18, entry.bytes.length, true);
    view.setUint32(at + 22, entry.bytes.length, true);
    view.setUint16(at + 26, entry.name.length, true);
    view.setUint16(at + 28, 0, true); // no extra field
    out.set(entry.name, at + 30);
    out.set(entry.bytes, at + 30 + entry.name.length);
    at += 30 + entry.name.length + entry.bytes.length;
  }

  const centralAt = at;
  prepared.forEach((entry, index) => {
    view.setUint32(at, 0x02014b50, true); // central directory header
    view.setUint16(at + 4, 20, true); // version made by
    view.setUint16(at + 6, 20, true); // version needed
    view.setUint16(at + 8, 0x0800, true);
    view.setUint16(at + 10, 0, true); // stored
    view.setUint16(at + 12, stamp.time, true);
    view.setUint16(at + 14, stamp.date, true);
    view.setUint32(at + 16, entry.crc, true);
    view.setUint32(at + 20, entry.bytes.length, true);
    view.setUint32(at + 24, entry.bytes.length, true);
    view.setUint16(at + 28, entry.name.length, true);
    view.setUint16(at + 30, 0, true); // extra
    view.setUint16(at + 32, 0, true); // comment
    view.setUint16(at + 34, 0, true); // disk number
    view.setUint16(at + 36, 0, true); // internal attributes
    view.setUint32(at + 38, 0, true); // external attributes
    view.setUint32(at + 42, offsets[index], true);
    out.set(entry.name, at + 46);
    at += 46 + entry.name.length;
  });

  view.setUint32(at, 0x06054b50, true); // end of central directory
  view.setUint16(at + 4, 0, true);
  view.setUint16(at + 6, 0, true);
  view.setUint16(at + 8, prepared.length, true);
  view.setUint16(at + 10, prepared.length, true);
  view.setUint32(at + 12, centralSize, true);
  view.setUint32(at + 16, centralAt, true);
  view.setUint16(at + 20, 0, true); // no comment
  return out;
}

/* --------------------------------------------------------------- reading */

/**
 * One entry read out of a ZIP.
 *
 * `bytes` is the file's own content, already inflated.
 */
export interface ZipFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** Raw DEFLATE, which is what a ZIP stores -- no zlib header, no checksum. */
export type InflateRaw = (
  deflated: Uint8Array,
  rawSize: number,
) => Uint8Array | Promise<Uint8Array>;

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;

/**
 * Read a ZIP, stored and deflated entries both.
 *
 * ⚠️ **The central directory is the authority, and it is at the END.** A ZIP is
 * read backwards: find the end-of-central-directory record, walk the entries it
 * points at, and only then look at each local header -- which exists mainly to
 * be skipped, because a writer that did not know a size in advance leaves its
 * copy of the sizes zero and puts them in a trailing descriptor. Reading local
 * headers front to back is the classic way to get a ZIP subtly wrong.
 *
 * ❗ **Directories and empty files are dropped**, along with anything the
 * archive marks as a directory by trailing slash. A caller wanting to know what
 * was in the archive should count what comes back, not what it expected.
 *
 * Only methods 0 (stored) and 8 (deflate) are read. Everything else -- and
 * anything encrypted -- is skipped rather than returned as rubbish; a level
 * resource in a bzip2 entry has never been seen and would fail loudly at
 * `loadResource` if it were.
 */
export async function readZip(
  bytes: Uint8Array,
  inflateRaw: InflateRaw,
): Promise<ZipFile[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The EOCD is at the end, behind a comment of up to 65,535 bytes.
  let eocd = -1;
  for (let at = bytes.length - 22; at >= 0 && at >= bytes.length - 22 - 0xffff; at -= 1) {
    if (view.getUint32(at, true) === EOCD) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record');

  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const out: ZipFile[] = [];
  for (let i = 0; i < count && at + 46 <= bytes.length; i += 1) {
    if (view.getUint32(at, true) !== CENTRAL) break;
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const rawSize = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/') || rawSize === 0) continue;
    if (method !== 0 && method !== 8) continue;
    // ❗ The local header's name and extra fields are its own length, not the
    // central directory's: an archiver may put a Zip64 or timestamp field in one
    // and not the other, and using the wrong length lands mid-data.
    if (localAt + 30 > bytes.length) continue;
    const localNameLength = view.getUint16(localAt + 26, true);
    const localExtraLength = view.getUint16(localAt + 28, true);
    const from = localAt + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(from, from + compressed);
    if (data.length < compressed) continue;
    out.push({
      name,
      bytes: method === 0 ? data : await inflateRaw(data, rawSize),
    });
  }
  return out;
}
