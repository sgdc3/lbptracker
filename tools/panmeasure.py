r"""Measure the stereo width of a recording: how much of one channel leaks into the other.

    panmeasure.py <wav> [<wav> ...]

For each file it reports, over the whole file, the least-squares gain of the loud channel that best
explains the quiet one, the residual left over, the correlation and the best lag. On a recording of
a single hard-panned instrument that gain **is** the leak, directly, with no windowing to choose and
no threshold to tune.

This is how question 22 was settled. Two captures of LBP3, one instrument at pan 0 and one at pan 1:

    stereo-left.wav    gain 0.261202  residual 0.0008  correlation 1.000000  lag 0
    stereo-right.wav   gain 0.261202  residual 0.0008  correlation 1.000000  lag 0

against **0.261204** predicted beforehand from two interior placements. See
`steering/answered-questions.md` entry 22, and `PAN_WIDTH` in `src/core/render.ts`.

⚠️ **A residual near zero is the load-bearing part, not the gain.** It says the quiet channel is the
loud one times a constant -- no delay, no decorrelation, no reverb of its own -- which is what makes
a single number a complete description. A residual that is *not* near zero means the two channels
carry different signals and this whole measurement is the wrong one for that file.

⚠️ **The gain is a ratio and says nothing about absolute level.** Recordings are usually
level-matched before comparison, which destroys exactly that. Do not read a width off this and then
also claim a gain.

The reader handles PCM 8/16/24/32 and IEEE float 32/64, so REAPER's defaults all work.
"""
import io
import math
import struct
import sys


def read_wav(path):
    """(rate, [channel, ...]) with every sample a float in roughly -1..1."""
    b = io.open(path, 'rb').read()
    if b[:4] != b'RIFF' or b[8:12] != b'WAVE':
        raise SystemExit('%s: not a RIFF/WAVE file' % path)
    fmt = data = None
    o = 12
    while o + 8 <= len(b):
        cid = b[o:o + 4]
        sz, = struct.unpack_from('<I', b, o + 4)
        if cid == b'fmt ':
            fmt = b[o + 8:o + 8 + sz]
        elif cid == b'data':
            data = b[o + 8:o + 8 + sz]
        o += 8 + sz + (sz & 1)                     # chunks are word-aligned
    if fmt is None or data is None:
        raise SystemExit('%s: missing fmt or data chunk' % path)
    tag, ch, rate, _, _, bits = struct.unpack_from('<HHIIHH', fmt, 0)
    if tag == 0xFFFE and len(fmt) >= 26:           # WAVE_FORMAT_EXTENSIBLE
        tag, = struct.unpack_from('<H', fmt, 24)
    n = len(data) // (ch * (bits // 8))
    if tag == 3 and bits == 32:
        v = struct.unpack_from('<%df' % (n * ch), data, 0)
    elif tag == 3 and bits == 64:
        v = struct.unpack_from('<%dd' % (n * ch), data, 0)
    elif tag == 1 and bits == 16:
        v = [x / 32768.0 for x in struct.unpack_from('<%dh' % (n * ch), data, 0)]
    elif tag == 1 and bits == 32:
        v = [x / 2147483648.0 for x in struct.unpack_from('<%di' % (n * ch), data, 0)]
    elif tag == 1 and bits == 24:
        v = []
        for i in range(n * ch):
            x = data[i * 3] | (data[i * 3 + 1] << 8) | (data[i * 3 + 2] << 16)
            v.append(((x - 0x1000000) if x & 0x800000 else x) / 8388608.0)
    elif tag == 1 and bits == 8:
        v = [(x - 128) / 128.0 for x in data[:n * ch]]
    else:
        raise SystemExit('%s: unsupported format tag %d, %d bits' % (path, tag, bits))
    return rate, [list(v[c::ch]) for c in range(ch)]


def _dot(a, b, off=0):
    if off >= 0:
        a, b = a[off:], b[:len(b) - off]
    else:
        a, b = a[:len(a) + off], b[-off:]
    return sum(x * y for x, y in zip(a, b))


def measure(path):
    rate, ch = read_wav(path)
    if len(ch) != 2:
        raise SystemExit('%s: need a stereo file, got %d channels' % (path, len(ch)))
    n = len(ch[0])
    energy = [_dot(c, c) for c in ch]
    quiet = 0 if energy[0] < energy[1] else 1
    q, loud = ch[quiet], ch[1 - quiet]
    gain = _dot(q, loud) / energy[1 - quiet]
    residual = math.sqrt(sum((x - gain * y) ** 2 for x, y in zip(q, loud)) / n)
    corr = _dot(q, loud) / math.sqrt(energy[0] * energy[1])
    lag = max(range(-40, 41), key=lambda k: abs(_dot(q, loud, k)))
    return {
        'rate': rate, 'frames': n, 'seconds': n / rate,
        'quiet_channel': quiet, 'gain': gain,
        'residual': residual / math.sqrt(energy[quiet] / n),
        'correlation': corr, 'lag': lag,
    }


def main(paths):
    for p in paths:
        m = measure(p)
        print('%s' % p)
        print('   %d Hz, %d frames = %.3f s; the quiet channel is ch%d'
              % (m['rate'], m['frames'], m['seconds'], m['quiet_channel']))
        print('   gain quiet/loud   %.6f      (the leak)' % m['gain'])
        print('   residual / rms    %.4f        (0 = a pure scaled copy)' % m['residual'])
        print('   correlation       %.6f' % m['correlation'])
        print('   best lag          %d samples' % m['lag'])
        w = (1 - m['gain']) / (1 + m['gain'])
        print('   implied pan width %.6f      (2 - sqrt2 = %.6f)' % (w, 2 - math.sqrt(2)))


if __name__ == '__main__':
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    main(sys.argv[1:])
