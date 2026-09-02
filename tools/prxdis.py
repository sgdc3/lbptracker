"""Disassemble one of the audio PRXs by vaddr, resolving rip-relative operands to their data.

    prxdis.py <module> <vaddr> [instruction-count]

`<module>` is `reverb` (fmodsmsreverb.prx) or `input` (fmodextinput.prx).

⚠️ **The file delta comes from the SELF segment table, not from a guess, and getting it wrong is
silent.** These files are SELF-wrapped: the inner ELF's program headers give offsets into a file
layout that is not the one on disk, and the real offset of ELF segment `i` is the SELF entry at
`0x20 + n*0x20` whose `props >> 20` is `i`. For the code segment (ELF index 0, vaddr 0) that is
**0x7c0** in `fmodsmsreverb.prx` and **0x7e0** in `fmodextinput.prx`.

⚠️ **Every PRX address recorded in this project before 2026-09-02 is 0x40 too high.** An earlier
version of this script used 0x780 and 0x7a0 — the offsets of the 32-byte digest blocks that precede
the segments, not of the segments themselves. The *content* those disassemblies reported was still
correct, because a rip-relative target is computed as `vaddr + size + disp` and then read back at
`target + delta`, so the error cancels; only the labels are shifted. Subtract 0x40 from any PRX
address in an old steering note before looking it up here.

Disassemble from a **function start**, never from a round address: a mid-function start
desynchronises the stream and prints convincing nonsense. `dump_selfmap()` prints the segment table
if you need to re-check the delta.
"""
import re
import struct
import sys

import capstone

MODULES = {
    'reverb': (r'D:\PS4Games\CUSA00063-patch\gamedata_orbis\spu\fmodsmsreverb.prx', 0x7C0),
    'input': (r'D:\PS4Games\CUSA00063-patch\gamedata_orbis\spu\fmodextinput.prx', 0x7E0),
}

_md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
_RIP = re.compile(r'\[rip ([+-]) (0x[0-9a-f]+)\]')


def dump_selfmap(path):
    """The SELF segment table, which is where the delta above comes from."""
    data = open(path, 'rb').read()
    count, = struct.unpack_from('<H', data, 0x18)
    for i in range(count):
        props, off, filesz, memsz = struct.unpack_from('<QQQQ', data, 0x20 + i * 0x20)
        print('seg[%d] elf_index=%d off=%#x filesz=%#x memsz=%#x'
              % (i, (props >> 20) & 0xFFF, off, filesz, memsz))


def dis(module, start, count=60):
    path, delta = MODULES[module]
    data = open(path, 'rb').read()

    def note_for(target):
        f = target + delta
        if f < 0 or f + 4 > len(data):
            return ''
        bits = ['f32=%.8g' % struct.unpack('<f', data[f:f + 4])[0],
                'u32=%#x' % struct.unpack('<I', data[f:f + 4])[0]]
        if f + 8 <= len(data):
            bits.append('f64=%.8g' % struct.unpack('<d', data[f:f + 8])[0])
        return '  ; -> v%#06x %s' % (target, ' '.join(bits))

    for insn in _md.disasm(data[start + delta:start + delta + count * 15], start):
        note = ''
        m = _RIP.search(insn.op_str)
        if m:
            disp = int(m.group(2), 16) * (1 if m.group(1) == '+' else -1)
            note = note_for(insn.address + insn.size + disp)
        print('%#06x  %-10s %-46s%s' % (insn.address, insn.mnemonic, insn.op_str, note))
        count -= 1
        if count <= 0:
            return


if __name__ == '__main__':
    if len(sys.argv) < 3 or sys.argv[1] not in MODULES:
        raise SystemExit(__doc__)
    dis(sys.argv[1], int(sys.argv[2], 0), int(sys.argv[3], 0) if len(sys.argv) > 3 else 60)
