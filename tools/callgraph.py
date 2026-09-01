"""BFS the direct-call graph from a seed vaddr and report the shortest paths that reach FMOD.

    callgraph.py <seed-vaddr> [max-depth]

Answers questions of the form "does this game subsystem actually touch the audio engine, and
through which part of it". Each hit is attributed to the FMOD source file it lives in, using the
same __FILE__-reference trick that measures FMOD's extent (see ebconf.source_path_sites).

Callee discovery is a linear sweep from each function entry to its first `ret`, collecting direct
`call`/`jmp` targets. That misses indirect and virtual calls -- so a *negative* result ("does not
reach FMOD") is weak evidence, while a positive one is solid. Keep that asymmetry in mind before
concluding that something is unused.
"""
import sys
from collections import defaultdict, deque

import capstone

import ebconf

_md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)


def callees(vaddr, limit=9000):
    data = ebconf.data()
    f = vaddr + ebconf.DELTA
    out = []
    for insn in _md.disasm(data[f:f + limit], f):
        if insn.mnemonic in ('call', 'jmp'):
            try:
                out.append(int(insn.op_str, 16) - ebconf.DELTA)
            except ValueError:
                pass
        if insn.mnemonic == 'ret':
            break
    return out


def main(seed, maxd=4):
    flo, fhi = ebconf.fmod_range()
    sites = ebconf.source_path_sites()
    fmod_sites = sorted(o for o, p in sites.items() if 'fmod' in p.lower())

    def attribute(v, span=0x2500):
        f = v + ebconf.DELTA
        for s in fmod_sites:
            if f <= s < f + span:
                return sites[s].split(ebconf.BS)[-1]
        return '?'

    names = ebconf.bindings()
    label = lambda v: names.get(v, 'sub_%x' % v)

    seen = {seed: None}
    q = deque([(seed, 0)])
    hits = []
    while q:
        v, d = q.popleft()
        if flo <= v <= fhi:
            hits.append(v)
            continue
        if d >= maxd:
            continue
        for t in callees(v):
            if t in seen or not (0x1000 <= t < 0x1050000):
                continue
            seen[t] = v
            q.append((t, d + 1))

    print('seed v%#x: visited %d functions, %d reach FMOD (depth <= %d)'
          % (seed, len(seen), len(hits), maxd))
    by = defaultdict(list)
    for h in hits:
        by[attribute(h)].append(h)
    for f, hs in sorted(by.items(), key=lambda kv: -len(kv[1])):
        print('   %-30s %3d   %s' % (f, len(hs), ' '.join(hex(x) for x in hs[:10])))
    print()
    for f, hs in sorted(by.items()):
        path, x = [], hs[0]
        while x is not None:
            path.append(label(x))
            x = seen[x]
        print('   path[%s]: %s' % (f, ' -> '.join(reversed(path))))


if __name__ == '__main__':
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    main(int(sys.argv[1], 0), int(sys.argv[2], 0) if len(sys.argv) > 2 else 4)
