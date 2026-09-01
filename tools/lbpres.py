"""LBP serialised-resource container reader (LVLb / PLNb / ...).

Reference implementation, in the same spirit as fsb.py: the JavaScript has to
reproduce this. The layout below was derived from the bytes of real LBP2/LBP3
level resources, not from any third-party source, and verified the way you
would want it verified -- see "How this was checked".

Container layout, all integers BIG-ENDIAN:

    0x00  char[4]  magic          "LVLb" = level, "PLNb" = plan, ...
    0x04  u32      revision       e.g. 0x3ee. When the high half is non-zero it
                                  carries a branch id: 0x021303f9 seen on an
                                  LBP3-branch level (branch 0x0213, rev 0x03f9).
    0x08  u32      depsOffset     start of the dependency table = end of chunks
    0x0c  u32      (zero in every file seen)
    0x10  u32      (0x07010001 in every file seen -- flags, not yet split out)
    0x14  u16      numChunks
    0x16  ...      chunk table: numChunks x (u16 compressedSize, u16 rawSize)
    ...            chunk payloads, back to back, each a complete zlib stream

Chunks are 0x8000 bytes raw except the last, which is short. The zlib header is
0x68 0xNN (CINFO=6, 16 KiB window), NOT the more familiar 0x78 -- a scan that
greps for 0x78 0x9c finds nothing and looks like a dead end.

How this was checked: on ten real levels (revisions 0x3b8 to 0x3f9), every
chunk decompresses, every chunk's length matches its declared rawSize, and the
byte offset just past the last chunk lands EXACTLY on depsOffset. Ten
independent hits on an offset the parser never uses is not a coincidence.

Usage:
    python tools/lbpres.py <file> [<file> ...]        # header report
    python tools/lbpres.py --raw <file> <out.bin>     # write decompressed data
"""
import os
import struct
import sys
import zlib


class Resource(object):
    def __init__(self, magic, revision, deps_offset, chunks, data, file_size,
                 chunk_end):
        self.magic = magic
        self.revision = revision
        self.deps_offset = deps_offset
        self.chunks = chunks
        self.data = data
        self.file_size = file_size
        self.chunk_end = chunk_end

    @property
    def branch(self):
        """Branch id, or 0 for a mainline revision."""
        return self.revision >> 16

    @property
    def version(self):
        """The revision proper, with any branch id stripped."""
        return self.revision & 0xffff

    def __repr__(self):
        return ('<Resource %s rev=%#x branch=%#x %d chunks %d bytes>'
                % (self.magic.decode('latin1'), self.version, self.branch,
                   len(self.chunks), len(self.data)))


def load(path):
    with open(path, 'rb') as fh:
        d = fh.read()
    if len(d) < 0x16:
        raise ValueError('%s: too short to be a resource' % path)

    magic = d[:4]
    revision, deps_offset = struct.unpack_from('>II', d, 4)
    count, = struct.unpack_from('>H', d, 0x14)

    chunks = []
    table = 0x16
    for k in range(count):
        comp, raw = struct.unpack_from('>HH', d, table + 4 * k)
        chunks.append((comp, raw))

    out = bytearray()
    pos = table + 4 * count
    for i, (comp, raw) in enumerate(chunks):
        blob = d[pos:pos + comp]
        pos += comp
        try:
            dec = zlib.decompress(blob)
        except zlib.error as exc:
            raise ValueError('%s: chunk %d/%d failed to inflate: %s'
                             % (path, i, count, exc))
        if len(dec) != raw:
            raise ValueError('%s: chunk %d inflated to %d, header says %d'
                             % (path, i, len(dec), raw))
        out += dec

    if pos != deps_offset:
        # Not fatal, but it means the layout is not what we think it is.
        sys.stderr.write('%s: WARNING chunks end at %#x, deps table at %#x\n'
                         % (os.path.basename(path), pos, deps_offset))

    return Resource(magic, revision, deps_offset, chunks, bytes(out), len(d), pos)


def main(argv):
    if len(argv) < 2:
        raise SystemExit(__doc__)

    if argv[1] == '--raw':
        res = load(argv[2])
        with open(argv[3], 'wb') as fh:
            fh.write(res.data)
        print('%s -> %s (%d bytes)' % (argv[2], argv[3], len(res.data)))
        return

    for path in argv[1:]:
        if not os.path.isfile(path):
            continue
        try:
            r = load(path)
        except ValueError as exc:
            print('%-42s ERROR %s' % (os.path.basename(path)[:40], exc))
            continue
        print('%-42s %s rev=%#06x branch=%#06x chunks=%3d raw=%9d file=%8d'
              % (os.path.basename(path)[:40], r.magic.decode('latin1'),
                 r.version, r.branch, len(r.chunks), len(r.data), r.file_size))


if __name__ == '__main__':
    main(sys.argv)
