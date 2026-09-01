"""Disassemble the LBP3 eboot by vaddr, annotated for this project.

Resolves rip-relative operands to their target vaddr and to the string there, names call targets
that are script bindings, and marks any target that lands inside FMOD's code with `<<FMOD>>`.

    lbpdis.py <vaddr> [instruction-count]

Addresses in and out are vaddrs; the file delta lives in ebconf.py. See steering/eboot-re.md for
why that matters more than it looks.
"""
import re
import sys

import capstone

import ebconf

_md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
_BIND = ebconf.bindings()
_FLO, _FHI = ebconf.fmod_range()


def _tag(vaddr):
    bits = []
    if vaddr in _BIND:
        bits.append('BIND %s' % _BIND[vaddr])
    if _FLO <= vaddr <= _FHI:
        bits.append('<<FMOD>>')
    return ('  ; ' + ' '.join(bits)) if bits else ''


def dis(start_vaddr, count=60, out=sys.stdout):
    data = ebconf.data()
    f = start_vaddr + ebconf.DELTA
    for insn in _md.disasm(data[f:f + count * 10], f):
        op = insn.op_str
        note = ''
        m = re.search(r'\[rip ([+-]) (0x[0-9a-f]+)\]', op)
        if m:
            disp = int(m.group(2), 16) * (1 if m.group(1) == '+' else -1)
            tgt = insn.address + insn.size + disp          # file offset
            s = ebconf.string_at(tgt)
            note = '  -> v%#010x%s' % (tgt - ebconf.DELTA, ('  "%s"' % s[:52]) if s else '')
            note += _tag(tgt - ebconf.DELTA)
        elif insn.mnemonic in ('call', 'jmp') or insn.mnemonic.startswith('j'):
            try:
                tgt = int(op, 16) - ebconf.DELTA
                note = '  -> v%#010x%s' % (tgt, _tag(tgt))
            except ValueError:
                pass
        print('v%#010x  %-9s %s%s' % (insn.address - ebconf.DELTA, insn.mnemonic, op, note),
              file=out)
        count -= 1
        if count <= 0:
            return


if __name__ == '__main__':
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    dis(int(sys.argv[1], 0), int(sys.argv[2], 0) if len(sys.argv) > 2 else 60)
