"""Enumerate every FMOD entry point the GAME calls, attributed to the FMOD source file it lives in.

    fmodapi.py [caller-clusters]

With no argument: a table of FMOD `.cpp` files, how many distinct entry points of each the game
calls, and how many call sites. That is the map of how much of FMOD LBP3 actually drives -- and,
by omission, which parts it ignores (the Music System, notably).

With `caller-clusters`: the same edges grouped by *caller* address, which is how the game's own
audio layer was located (v0x3dd000-v0x3fe000).

Method: FMOD's code range is measured from its __FILE__ references (see ebconf), then every
`call rel32` from outside that range into it is a game -> FMOD edge. Callees are filtered to
plausible function entries by first opcode, so the counts are a slight undercount rather than
inflated by false positives.
"""
import struct
import sys
from collections import Counter, defaultdict

import ebconf


def edges():
    data = ebconf.data()
    lo, hi = ebconf.fmod_range()
    flo, fhi = lo + ebconf.DELTA, hi + ebconf.DELTA
    ENTRY = (0x55, 0x41, 0x53, 0x48, 0x50, 0x31, 0x8b, 0x40, 0x89, 0xf3, 0xc5)
    out = defaultdict(list)
    for o in range(0x4000, len(data) - 5):
        if data[o] != 0xE8:
            continue
        t = o + 5 + struct.unpack_from('<i', data, o + 1)[0]
        if not (flo <= t <= fhi) or (flo <= o <= fhi):
            continue                                  # out of range, or FMOD-internal
        if data[t] not in ENTRY:
            continue
        out[t - ebconf.DELTA].append(o - ebconf.DELTA)
    return out


def main(mode=None):
    sites = ebconf.source_path_sites()
    fmod_sites = sorted(o for o, p in sites.items() if 'fmod' in p.lower())
    lo, hi = ebconf.fmod_range()
    print('FMOD code (vaddr) %#x .. %#x' % (lo, hi))

    def attribute(v, span=0x2500):
        f = v + ebconf.DELTA
        for s in fmod_sites:
            if f <= s < f + span:
                return sites[s].split(ebconf.BS)[-1]
        return '?'

    e = edges()
    total = sum(len(v) for v in e.values())
    print('%d distinct FMOD entry points called from game code, %d call sites' % (len(e), total))

    if mode == 'caller-clusters':
        c = Counter(caller >> 12 for cs in e.values() for caller in cs)
        print('\ncaller clusters (4 KiB pages) with >= 3 edges:')
        for page, n in sorted(c.items()):
            if n >= 3:
                print('   v%#08x  %d' % (page << 12, n))
        return

    byfile = defaultdict(list)
    for callee, callers in e.items():
        byfile[attribute(callee)].append((len(callers), callee))
    for fn in sorted(byfile, key=lambda k: -sum(c for c, _ in byfile[k])):
        lst = sorted(byfile[fn], reverse=True)
        print('\n%-34s %3d entry points, %4d call sites'
              % (fn, len(lst), sum(c for c, _ in lst)))
        print('   ' + '  '.join('%#x(%d)' % (v, c) for c, v in lst[:14]))


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else None)
