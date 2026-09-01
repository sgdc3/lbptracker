"""Read an FMOD FSB4 bank: list its samples, or extract one to a 16-bit PCM .wav.

This is the reference implementation of the asset pipeline the web tracker has to reproduce in
JavaScript. Everything here was derived from the bytes of LBP3's own banks, not from FMOD docs --
see steering/game-assets.md for the measurements that pin the codec down.

    fsb.py list   <bank.fsb> [name-substring]
    fsb.py info   <bank.fsb> <sample-name-or-index>
    fsb.py wav    <bank.fsb> <sample-name-or-index> <out.wav>
    fsb.py wavall <bank.fsb> <out-dir> [name-substring]

FSB4 layout: 0x30-byte file header, then `shdrsize` bytes of sample headers, then the sample data
back to back in header order. A sample header is `u16 size` followed by a 30-byte NUL-padded name
and the fields below; `size` covers the whole header, so headers are walked, never indexed.
"""
import os
import struct
import sys

HDR = struct.Struct('<4sIIIII')          # magic, numsamples, shdrsize, datasize, version, mode

# Sample-header mode bits (FSOUND_*). Only the ones LBP3 actually sets are named; the rest are
# left as raw bits on purpose -- guessing at flags we have never seen set is how you get a decoder
# that is subtly wrong.
MODE_BITS = {
    0x00000002: 'LOOP_NORMAL',
    0x00000020: 'MONO',
    0x00000040: 'STEREO',
    0x00000200: 'MPEG',
    0x00002000: '2D',
    0x00080000: 'HW2D',
    0x00100000: '3D',
    0x00400000: 'IMAADPCM',
}

IMA_BLOCK = 36        # bytes per channel per block
IMA_SAMPLES = 64      # samples per channel per block

IMA_STEP = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66,
    73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408,
    449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
    2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630,
    9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
    32767,
]
IMA_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8]


class Sample:
    __slots__ = ('index', 'name', 'length_samples', 'length_bytes', 'loop_start', 'loop_end',
                 'mode', 'freq', 'volume', 'pan', 'priority', 'channels', 'data_offset')

    def mode_names(self):
        got = [n for bit, n in sorted(MODE_BITS.items()) if self.mode & bit]
        rest = self.mode & ~sum(MODE_BITS)
        if rest:
            got.append('%#010x' % rest)
        return '|'.join(got) or '0'

    def codec(self):
        if self.mode & 0x00400000:
            return 'ima_adpcm'
        if self.mode & 0x00000200:
            return 'mpeg'
        return 'unknown'

    def __repr__(self):
        return ('<%3d %-34s %8d smp  %8d B  %5d Hz  ch=%d  %s>'
                % (self.index, self.name, self.length_samples, self.length_bytes, self.freq,
                   self.channels, self.mode_names()))


def read_bank(path):
    """Parse the header block only. Sample data is read lazily by offset."""
    with open(path, 'rb') as fh:
        head = fh.read(0x30)
        magic, numsamples, shdrsize, datasize, version, mode = HDR.unpack_from(head)
        if magic != b'FSB4':
            raise ValueError('%s: not an FSB4 bank (magic %r)' % (path, magic))
        shdr = fh.read(shdrsize)

    samples = []
    off = 0
    data_at = 0x30 + shdrsize
    cursor = 0
    while len(samples) < numsamples and off + 2 <= len(shdr):
        size = struct.unpack_from('<H', shdr, off)[0]
        if size == 0:
            break
        s = Sample()
        s.index = len(samples)
        s.name = shdr[off + 2:off + 32].split(b'\0')[0].decode('ascii', 'replace')
        (s.length_samples, s.length_bytes, s.loop_start, s.loop_end,
         s.mode, s.freq) = struct.unpack_from('<IIIIIi', shdr, off + 32)
        (s.volume, s.pan, s.priority, s.channels) = struct.unpack_from('<HhHH', shdr, off + 56)
        s.data_offset = data_at + cursor
        cursor += s.length_bytes
        samples.append(s)
        off += size

    return {'path': path, 'numsamples': numsamples, 'version': version, 'mode': mode,
            'datasize': datasize, 'data_at': data_at, 'samples': samples}


def read_data(bank, s):
    with open(bank['path'], 'rb') as fh:
        fh.seek(s.data_offset)
        return fh.read(s.length_bytes)


def decode_ima(raw, channels, length_samples):
    """FMOD's IMA ADPCM: 36-byte blocks per channel, 64 samples per channel per block.

    A block is a 4-byte preamble (s16 predictor, u8 step index, u8 pad) followed by 32 bytes of
    4-bit nibbles, low nibble first. For stereo the two channels' blocks are stored back to back
    (all of L's 36 bytes, then all of R's), NOT nibble-interleaved.
    """
    stride = IMA_BLOCK * channels
    nblocks = len(raw) // stride
    out = [None] * channels
    for ch in range(channels):
        pcm = []
        for b in range(nblocks):
            base = b * stride + ch * IMA_BLOCK
            pred, idx = struct.unpack_from('<hB', raw, base)
            pred = int(pred)
            idx = max(0, min(88, idx))
            for byte in raw[base + 4:base + IMA_BLOCK]:
                for nib in (byte & 0x0F, byte >> 4):
                    step = IMA_STEP[idx]
                    diff = step >> 3
                    if nib & 1:
                        diff += step >> 2
                    if nib & 2:
                        diff += step >> 1
                    if nib & 4:
                        diff += step
                    if nib & 8:
                        diff = -diff
                    pred = max(-32768, min(32767, pred + diff))
                    idx = max(0, min(88, idx + IMA_INDEX[nib]))
                    pcm.append(pred)
        out[ch] = pcm

    n = min(length_samples, min(len(c) for c in out)) if out else 0
    if channels == 1:
        return out[0][:n]
    inter = []
    for i in range(n):
        for ch in range(channels):
            inter.append(out[ch][i])
    return inter


def write_wav(path, pcm, channels, freq):
    body = struct.pack('<%dh' % len(pcm), *pcm)
    with open(path, 'wb') as fh:
        fh.write(b'RIFF' + struct.pack('<I', 36 + len(body)) + b'WAVE')
        fh.write(b'fmt ' + struct.pack('<IHHIIHH', 16, 1, channels, freq,
                                       freq * channels * 2, channels * 2, 16))
        fh.write(b'data' + struct.pack('<I', len(body)) + body)


def pick(bank, key):
    if key.isdigit():
        return bank['samples'][int(key)]
    hits = [s for s in bank['samples'] if s.name == key]
    if not hits:
        hits = [s for s in bank['samples'] if key.lower() in s.name.lower()]
    if not hits:
        raise SystemExit('no sample matching %r' % key)
    if len(hits) > 1:
        print('ambiguous, %d matches; using the first:' % len(hits), file=sys.stderr)
        for h in hits[:8]:
            print('   ', h, file=sys.stderr)
    return hits[0]


def main(argv):
    if len(argv) < 3:
        raise SystemExit(__doc__)
    cmd, path = argv[1], argv[2]
    bank = read_bank(path)

    if cmd == 'list':
        needle = argv[3].lower() if len(argv) > 3 else None
        n = 0
        for s in bank['samples']:
            if needle and needle not in s.name.lower():
                continue
            print(s)
            n += 1
        print('--- %d/%d samples, bank version %#x mode %#x ---'
              % (n, bank['numsamples'], bank['version'], bank['mode']), file=sys.stderr)

    elif cmd == 'info':
        s = pick(bank, argv[3])
        print(s)
        print('  codec        %s' % s.codec())
        print('  data offset  %#x  (%d bytes)' % (s.data_offset, s.length_bytes))
        print('  loop         %d .. %d' % (s.loop_start, s.loop_end))
        print('  volume=%d pan=%d priority=%d' % (s.volume, s.pan, s.priority))
        if s.codec() == 'ima_adpcm':
            blocks = s.length_bytes / (IMA_BLOCK * s.channels)
            print('  ima blocks   %.3f  (expected %.3f from length_samples)'
                  % (blocks, s.length_samples / IMA_SAMPLES))

    elif cmd == 'wav':
        s = pick(bank, argv[3])
        if s.codec() != 'ima_adpcm':
            raise SystemExit('%s is %s; only ima_adpcm is decoded here '
                             '(mpeg samples are raw MP3, dump them with `raw`)' % (s.name, s.codec()))
        pcm = decode_ima(read_data(bank, s), s.channels, s.length_samples)
        write_wav(argv[4], pcm, s.channels, s.freq)
        print('%s -> %s  (%d frames, %d Hz, %d ch)'
              % (s.name, argv[4], len(pcm) // s.channels, s.freq, s.channels))

    elif cmd == 'raw':
        s = pick(bank, argv[3])
        with open(argv[4], 'wb') as fh:
            fh.write(read_data(bank, s))
        print('%s -> %s (%d bytes, %s)' % (s.name, argv[4], s.length_bytes, s.codec()))

    elif cmd == 'wavall':
        out_dir = argv[3]
        needle = argv[4].lower() if len(argv) > 4 else None
        os.makedirs(out_dir, exist_ok=True)
        n = 0
        for s in bank['samples']:
            if needle and needle not in s.name.lower():
                continue
            if s.codec() != 'ima_adpcm':
                continue
            pcm = decode_ima(read_data(bank, s), s.channels, s.length_samples)
            stem = ''.join(c if c.isalnum() or c in '._-' else '_' for c in s.name)
            if not stem.lower().endswith('.wav'):
                stem += '.wav'
            write_wav(os.path.join(out_dir, '%04d_%s' % (s.index, stem)), pcm, s.channels, s.freq)
            n += 1
        print('wrote %d wavs to %s' % (n, out_dir))

    else:
        raise SystemExit(__doc__)


if __name__ == '__main__':
    main(sys.argv)
