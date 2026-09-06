r"""The static gain curve of `fmodsmswavehammer.prx`, and the check that it is that curve.

    wavehammer.py                 the shipped configuration, its table and its constant
    wavehammer.py <T> <R>         another threshold (dB) and ratio
    wavehammer.py check           the transcription against the closed form, all 3999 entries

This is the reference implementation the TypeScript will have to reproduce, in the sense `fsb.py`
and `lbpres.py` are. The whole chain is read: detector, lookup, envelope and application.

## ❗ The headline: in the shipped configuration this DSP is a constant -18.04 dB

`0x330` is `out[i] = in[i] * gain[i]` and the gain comes from the table -- but the lookup at
`0x10f0` divides the detector's *windowed sum of squares* by `[state+0xc0]`, the window length, to
get a mean square, and **the game never sets that field**. A superset disassembly of all 7,632
bytes of the module finds no store at all to `+0xc0`, `+0xc4` or `+0xc8`, and the eboot's create
memsets the state block and afterwards writes only `+0x6c`, `+0xf0`, `+0x130`, `+0x138`.

So `1/N` is `+inf`, every non-silent sample saturates the index, and the lookup returns
`table[3999]` forever. Since the make-up at `0xd44` is `0.995 / table[3999]`, the product is

    table[3999] * [state+0x104]  ==  0.995 * 10^(CompOutGain/20)  ==  0.125263  ==  -18.04 dB

`shipped_chain_gain()` computes it both ways. ⚠️ **This is a static reading and it makes a
falsifiable prediction** -- the game's sequencer output should sit ~18 dB below an unattenuated
render of the same song. Nobody has captured that yet; see question 37.

## The static curve, which is what the rest of this file is

`0xa40` fills 4000 floats at `scratch + 0x1000`, entry `i` being the gain for a mean-square level
`x = i/3999` (the axis floor `[state+0xc8]` is that same never-written zero). `L = 10*log10(x)` --
`_FLog(1, .)` is `log10f`, 21 bytes at libc `0x383e0` jumping to `0x37c20` -- so `L` is ordinary
dBFS and the `10^(dL/20)` is the matching amplitude gain.

`build()` is a literal transcription of `0xbb4`-`0xd31`, in the order the assembly does it.
`closed_form_db()` is the algebra it reduces to, and `check` agrees them to 2.1e-14 dB. Keep both:
the transcription is the evidence, the closed form is what an implementation would use.

⚠️ **There is no lower clamp.** `0xc99` branches only on `L > T+3`, so the knee cubic is evaluated
with `t < 0` all the way down and the curve is a **downward expander** below `T-3`: -2.7 dB at 9 dB
under the threshold on the shipped settings. `table[0]` is NaN, because `log10(0)` is -inf and
`out - L` is then inf - inf. Neither reaches the audio while the lookup saturates, but both would
the moment `[state+0xc0]` were non-zero, so they stay modelled here.
"""
import math
import sys

# The game's own template, from eboot v0x1062850. See steering/lbp-audio-engine.md.
SHIPPED_THRESHOLD_DB = -18.0
SHIPPED_RATIO = 10.0
SHIPPED_OUT_GAIN_TENTHS = -180
ENTRIES = 4000


def build(threshold_db, ratio):
    """`(entry, coefficients)` -- a literal transcription of `0xbb4`-`0xd31`."""
    knee_top = threshold_db + 3.0                                  # [rbp-0x48]
    knee_bottom = threshold_db - 3.0                               # [rbp-0x68]
    inv_r = 10.0 / (ratio * 10.0)                                  # xmm5, from the raw tenths
    big = ratio >= 50.0
    k = 3.0 if big else inv_r * 3.0 + 3.0                          # [rbp-0x64]
    a = 6.0 / k                                                    # [rbp-0x6c]
    b = (0.0 if big else inv_r) * a                                # xmm0, after the vandps mask
    c3 = a + b - 2.0                                               # [rbp-0x70]
    c2 = 3.0 - 2.0 * a - b                                         # [rbp-0x74]

    def entry(x):
        if x <= 0.0:
            return float('nan')                                    # log10(0) -> inf - inf
        level = 10.0 * math.log10(x)                               # _FLog(1, x) * 10
        if level > knee_top:
            out = threshold_db if big else threshold_db + inv_r * (level - threshold_db)
        else:
            t = (level - threshold_db + 3.0) / 6.0
            out = knee_bottom + k * (a * t + c2 * t * t + c3 * t * t * t)
        return 10.0 ** ((out - level) * 0.05)

    return entry, dict(K=k, A=a, B=b, c2=c2, c3=c3, inv_r=inv_r)


def closed_form_db(threshold_db, ratio, level_db):
    """The gain in dB. The unique Hermite matching value and slope at both knee ends.

    ⚠️ `ratio >= 50` is **not** the same curve with a small `1/R`: the assembly masks `1/R` to zero
    at `0xbc9` and takes `out = T` above the knee, so the DSP is a hard limiter from 50:1 up rather
    than a 50:1 compressor. Using the true reciprocal there costs 0.74 dB at entry 1 -- which is how
    `check` caught it, so keep that case in the table it sweeps.
    """
    inv_r = 0.0 if ratio >= 50.0 else 1.0 / ratio
    t = (level_db - threshold_db + 3.0) / 6.0
    slope = 1.0 - inv_r
    return -3.0 * slope * t * t if t <= 1.0 else 3.0 * (1.0 - 2.0 * t) * slope


def table(threshold_db, ratio):
    entry, _ = build(threshold_db, ratio)
    return [entry(i / (ENTRIES - 1.0)) for i in range(ENTRIES)]


def output_constant(threshold_db, ratio, out_gain_tenths):
    """`[state+0x104]`: the automatic make-up at `0xd44` times the manual gain at `0xd5e`."""
    entry, _ = build(threshold_db, ratio)
    makeup = 0.995 / entry(1.0)                                    # 0.995 / table[3999]
    manual = 0.0 if out_gain_tenths * 10 <= -9000 else 10.0 ** (out_gain_tenths * 0.005)
    return makeup * manual, makeup, manual


def lookup(energy, window_length, floor, table_):
    """`0x10f0`-`0x1153`: normalise the windowed sum, index the table, interpolate.

    ❗ `window_length` is `[state+0xc0]` and **the game leaves it at zero**, so `1/N` is `+inf` and
    every non-silent sample saturates to the last entry. That is not a transcription slip -- a
    superset disassembly of all 7,632 bytes of the module finds *no store at all* to `+0xc0`,
    `+0xc4` or `+0xc8`, and the eboot's create memsets the state block and then writes only `+0x6c`,
    `+0xf0`, `+0x130` and `+0x138`.
    """
    scale = float('inf') if window_length == 0 else 1.0 / window_length
    x = scale * energy
    if not (x > floor):                       # NaN (inf*0) lands here too, as `jbe` does
        return 1.0
    index = (x - floor) * (3999.0 / (1.0 - floor))
    if index >= 3999.0:
        return table_[3999]
    lo = int(index)
    return table_[lo] + (index - lo) * (table_[lo + 1] - table_[lo])


def shipped_chain_gain():
    """The gain the shipped WaveHammer actually multiplies the sequencer's samples by.

    table lookup (saturated) x [state+0x104], which reduces to `0.995 * 10^(CompOutGain/20)`
    because the make-up is `0.995 / table[3999]` and the lookup always returns `table[3999]`.
    """
    tbl = table(SHIPPED_THRESHOLD_DB, SHIPPED_RATIO)
    net, _, manual = output_constant(SHIPPED_THRESHOLD_DB, SHIPPED_RATIO, SHIPPED_OUT_GAIN_TENTHS)
    return lookup(0.25, 0, 0.0, tbl) * net, 0.995 * manual


def _check():
    worst = 0.0
    for threshold_db, ratio in ((-18.0, 10.0), (-6.0, 2.0), (-30.0, 1.5), (-12.0, 50.0), (-24.0, 4.0)):
        entry, _ = build(threshold_db, ratio)
        for i in range(1, ENTRIES):
            x = i / (ENTRIES - 1.0)
            level = 10.0 * math.log10(x)
            worst = max(worst, abs(20.0 * math.log10(entry(x))
                                   - closed_form_db(threshold_db, ratio, level)))
    print('transcription vs closed form, 5 configurations x %d entries' % (ENTRIES - 1))
    print('  max error %.3e dB   %s' % (worst, 'OK' if worst < 1e-9 else 'MISMATCH'))
    return 0 if worst < 1e-9 else 1


def _report(threshold_db, ratio):
    entry, co = build(threshold_db, ratio)
    print('threshold %.1f dB   ratio %.1f : 1' % (threshold_db, ratio))
    print('  ' + '  '.join('%s=%.6f' % kv for kv in co.items()))
    print()
    print('  %-7s %-11s %-11s %s' % ('entry', 'x (power)', 'L dBFS', 'gain dB'))
    for i in (1, 8, 63, 253, 1000, 2000, ENTRIES - 1):
        x = i / (ENTRIES - 1.0)
        print('  %-7d %-11.6f %-11.3f %.3f'
              % (i, x, 10.0 * math.log10(x), 20.0 * math.log10(entry(x))))
    net, makeup, manual = output_constant(threshold_db, ratio, SHIPPED_OUT_GAIN_TENTHS)
    print()
    print('  make-up  0.995/table[%d] = %.6f  (%+.3f dB)' % (ENTRIES - 1, makeup, 20 * math.log10(makeup)))
    print('  manual   CompOutGain %d  = %.6f  (%+.3f dB)' % (SHIPPED_OUT_GAIN_TENTHS, manual, 20 * math.log10(manual)))
    print('  [state+0x104]           = %.6f  (%+.3f dB)' % (net, 20 * math.log10(net)))
    if (threshold_db, ratio) == (SHIPPED_THRESHOLD_DB, SHIPPED_RATIO):
        chain, algebra = shipped_chain_gain()
        print()
        print('  !! the detector never gets a window length, so the lookup saturates and the')
        print('     whole DSP collapses to a constant:')
        print('     table[3999] * [state+0x104] = %.6f  (%+.3f dB)' % (chain, 20 * math.log10(chain)))
        print('     which is exactly 0.995 * 10^(CompOutGain/20) = %.6f' % algebra)


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'check':
        raise SystemExit(_check())
    if len(sys.argv) == 3:
        _report(float(sys.argv[1]), float(sys.argv[2]))
    elif len(sys.argv) == 1:
        _report(SHIPPED_THRESHOLD_DB, SHIPPED_RATIO)
    else:
        raise SystemExit(__doc__)
