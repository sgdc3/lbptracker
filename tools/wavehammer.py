r"""The gain curve of `fmodsmswavehammer.prx`, checked against the module actually running.

    wavehammer.py                 the shipped configuration, its curve and its constant
    wavehammer.py <T> <R>         another threshold (dB) and ratio
    wavehammer.py check           the transcription against the closed form, all 3999 entries

The reference implementation the TypeScript will have to reproduce, in the sense `fsb.py` and
`lbpres.py` are. ✔ `tools/runhammer.py sweep` loads the real PRX and agrees with this file to
**1e-4 dB** across a DC sweep from -40 to -0.9 dBFS.

## What the DSP is

A working compressor, and on the shipped settings (-18 dB, 10:1) it reduces gain by 17.2 dB at
-0.9 dBFS, 7.2 dB at -12 dBFS, and settles to a constant **-1.84 dB** below the knee.

Four passes per 256-frame block: a 64-sample sliding mean square per channel, `max` across
channels (`0x1000`); a table lookup with linear interpolation (`0x10f0`); a one-pole on the gain
with attack/release plus a second smoother (`0x1190`); `out = in * gain` (`0x330`).

`0xa40` fills the 4000-entry table, entry `i` being the gain for a mean-square level
`x = F + (1-F)*i/3999`, with `F = 10^((T-3)/10)` — the knee bottom, so **entry 0 is unity** and
`x <= F` short-circuits to 1.0. `L = 10*log10(x)` via `_FLog(1, .)`, which is `log10f`, 21 bytes at
libc `0x383e0` jumping to `0x37c20`; `L` is therefore ordinary dBFS.

`build()` is a literal transcription of `0xbb4`-`0xd31`, in the order the assembly does it.
`closed_form_db()` is the algebra it reduces to, and `check` agrees them to 2.1e-14 dB. Keep both:
the transcription is the evidence, the closed form is what an implementation would use.

## ❌ What this file said before, and why

For one commit this docstring led with *"the window length is never initialised, so the DSP
collapses to a constant -18.04 dB"*. It was wrong. `[state+0xc0]` is 64, set by `0x380` as

    mov qword ptr [rbx + 0x3c], rax      ; one 64-bit store: N at +0xc0 AND the mask at +0xc4

through a pointer to a sub-struct at `state+0x84`. A superset disassembly looking for stores to
`[reg + 0xc0]` found none, correctly, and the conclusion still did not follow: **an absolute-offset
search is only sound if every access uses the same base.** The same mistake made `F` zero, which is
what produced the phantom `table[0] = NaN` and the phantom downward expander below the knee — with
the real `F` the cubic is never evaluated below `t = 0` at all.

The lesson is why `runhammer.py` exists: when a field looks uninitialised, run the thing.
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
    """The 4000 entries as `0xa40` writes them, on the real axis `[F, 1]`."""
    entry, _ = build(threshold_db, ratio)
    f = axis_floor(threshold_db)
    return [entry(f + (1.0 - f) * i / (ENTRIES - 1.0)) for i in range(ENTRIES)]


def output_constant(threshold_db, ratio, out_gain_tenths):
    """`[state+0x104]`: the automatic make-up at `0xd44` times the manual gain at `0xd5e`."""
    entry, _ = build(threshold_db, ratio)
    makeup = 0.995 / entry(1.0)                                    # 0.995 / table[3999]
    manual = 0.0 if out_gain_tenths * 10 <= -9000 else 10.0 ** (out_gain_tenths * 0.005)
    return makeup * manual, makeup, manual


def axis_floor(threshold_db):
    """`[state+0xc8]`, the bottom of the table's level axis, from `0x380`.

    `0x380` turns the threshold into a power ratio (`0x3f7`: `powf(10, T/20)` squared) and takes
    3 dB off it (`x 0.50118721` = `10^-0.3`), so the axis starts **exactly at the knee bottom** and
    the table covers `[10^((T-3)/10), 1]`. That is why entry 0 is unity and why the cubic is never
    evaluated below the knee.
    """
    return 10.0 ** ((threshold_db - 3.0) / 10.0)


def window_length(long_look=False):
    """`[state+0xc0]` / `[state+0xc4]`: `0x482` stores 0x3f00000040, `0x476` stores 0x7f00000080."""
    return 128 if long_look else 64


def gain_for_mean_square(mean_square, threshold_db, ratio, out_gain_tenths):
    """The gain the DSP multiplies a sample by, given the detector's mean-square level.

    ✔ Agrees with the executing PRX to 1e-4 dB over a DC sweep -- see `tools/runhammer.py sweep`.
    """
    entry, _ = build(threshold_db, ratio)
    floor = axis_floor(threshold_db)
    tbl_gain = lookup_interpolated(mean_square, floor, entry)
    return tbl_gain * output_constant(threshold_db, ratio, out_gain_tenths)[0]


def lookup_interpolated(x, floor, entry):
    """`0x10f0`-`0x1153` on the real axis: unity below the floor, linear interpolation above."""
    if not (x > floor):                       # NaN lands here too, as the `jbe` does
        return 1.0
    index = (x - floor) * (3999.0 / (1.0 - floor))
    if index >= 3999.0:
        return entry(1.0)
    lo = int(index)
    a = entry(floor + (1.0 - floor) * lo / 3999.0)
    b = entry(floor + (1.0 - floor) * (lo + 1) / 3999.0)
    return a + (index - lo) * (b - a)


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
        print()
        print('  detector window  = %d samples   axis floor F = %.8g  (= knee bottom)'
              % (window_length(), axis_floor(threshold_db)))
        print('  %-11s %-12s %s' % ('in dBFS', 'gain', 'gain dB'))
        for amp in (0.9, 0.5, 0.25, 0.126, 0.05):
            g = gain_for_mean_square(amp * amp, threshold_db, ratio, SHIPPED_OUT_GAIN_TENTHS)
            print('  %-11.2f %-12.6f %+.2f' % (20 * math.log10(amp), g, 20 * math.log10(g)))
        print()
        print('  verify against the real thing:  tools/runhammer.py sweep')


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'check':
        raise SystemExit(_check())
    if len(sys.argv) == 3:
        _report(float(sys.argv[1]), float(sys.argv[2]))
    elif len(sys.argv) == 1:
        _report(SHIPPED_THRESHOLD_DB, SHIPPED_RATIO)
    else:
        raise SystemExit(__doc__)
