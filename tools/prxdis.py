"""Disassemble one of the game's PRXs by vaddr, resolving rip-relative operands to their data.

    prxdis.py <module> <vaddr> [instruction-count]
    prxdis.py <module> map                       the segment map, vaddr -> file offset

`<module>` is `reverb` (fmodsmsreverb.prx), `input` (fmodextinput.prx), `hammer`
(fmodsmswavehammer.prx) or **`libc`** (`sce_module/libc.prx`).

❗ **`hammer` is the last DSP on the sequencer's channel and it is a COMPRESSOR, not a limiter** --
the game ships it with `LimitBypass = 1` -- and nothing in this project models it yet.
`Channel::addDSP` puts it after the reverb (eboot `v0x3e6976`). Eight functions, no more: `0x0`,
`0x180`, `0x380`, `0x620` (coefficients), `0xa40` (the kernel), `0x1770` (256-frame block shim),
`0x19f0` (the one export), `0x1a80`. See open question 37 and *The end of the chain* in
`steering/lbp-audio-engine.md`.

❗ **`libc` is here because the game ships its own copy**, so the libc that `fmodextinput.prx`
imports from is a file on this disk rather than an assumption about the console. That is how
`RAND_MAX` was settled for question 12: `rand` is at vaddr `0x17000`, 37 bytes, a 64-bit LCG
returning `(state >> 32) & 0x3fffffff`, so it is `2**30 - 1`. Find any other export's address with
`tools/prxnid.py`'s NID hash against libc's own symbol table.

⚠️ **The file delta comes from the SELF segment table, not from a guess, and getting it wrong is
silent.** These files are SELF-wrapped: the inner ELF's program headers give offsets into a file
layout that is not the one on disk, and the real offset of ELF segment `i` is the SELF entry at
`0x20 + n*0x20` whose `props >> 20` is `i`. It is computed per segment here rather than hardcoded,
because **`libc.prx` has two loadable segments with different deltas** (0xd60 and 0x6d0) and one
constant cannot serve both. The audio PRXs have one loadable segment each, at 0x7c0 and 0x7e0.

⚠️ **Every PRX address recorded in this project before 2026-09-02 is 0x40 too high.** An earlier
version of this script used 0x780 and 0x7a0 — the offsets of the 32-byte digest blocks that precede
the segments, not of the segments themselves. The *content* those disassemblies reported was still
correct, because a rip-relative target is computed as `vaddr + size + disp` and then read back at
`target + delta`, so the error cancels; only the labels are shifted. Subtract 0x40 from any PRX
address in an old steering note before looking it up here.

Disassemble from a **function start**, never from a round address: a mid-function start
desynchronises the stream and prints convincing nonsense. `prxdis.py <module> map` prints the
segment map if you need to re-check a delta.
"""
import re
import struct
import sys

import capstone

MODULES = {
    'reverb': r'D:\PS4Games\CUSA00063-patch\gamedata_orbis\spu\fmodsmsreverb.prx',
    'input': r'D:\PS4Games\CUSA00063-patch\gamedata_orbis\spu\fmodextinput.prx',
    'hammer': r'D:\PS4Games\CUSA00063-patch\gamedata_orbis\spu\fmodsmswavehammer.prx',
    'libc': r'D:\PS4Games\CUSA00063-patch\sce_module\libc.prx',
}

_md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
_RIP = re.compile(r'\[rip ([+-]) (0x[0-9a-f]+)\]')


def segments(path):
    """`[(vaddr, memsz, file offset)]` for each loadable segment.

    The vaddr and size come from the inner ELF's program headers; the file offset comes from the
    SELF entry that claims the same ELF index. ⚠️ Entries with `filesz == 0x20` are the 32-byte
    digest blocks in front of the real segments, which is the trap the docstring is about.
    """
    data = open(path, 'rb').read()
    count, = struct.unpack_from('<H', data, 0x18)
    where = {}
    for i in range(count):
        props, off, filesz, _ = struct.unpack_from('<QQQQ', data, 0x20 + i * 0x20)
        if filesz > 0x20:
            where[(props >> 20) & 0xFFF] = off
    elf = data.index(b'\x7fELF')
    phoff, = struct.unpack_from('<Q', data, elf + 0x20)
    phentsize, phnum = struct.unpack_from('<HH', data, elf + 0x36)
    out = []
    for i in range(phnum):
        p = elf + phoff + i * phentsize
        p_type, = struct.unpack_from('<I', data, p)
        _off, vaddr, _paddr, _filesz, memsz = struct.unpack_from('<QQQQQ', data, p + 8)
        if p_type == 1 and i in where:  # PT_LOAD that the SELF actually carries
            out.append((vaddr, memsz, where[i]))
    return data, out


def dis(module, start, count=60):
    data, segs = segments(MODULES[module])

    def file_offset(vaddr):
        for base, size, off in segs:
            if base <= vaddr < base + size:
                return off + (vaddr - base)
        return None

    def note_for(target):
        f = file_offset(target)
        if f is None or f + 4 > len(data):
            return '  ; -> v%#06x (not in a loaded segment)' % target
        bits = ['f32=%.8g' % struct.unpack('<f', data[f:f + 4])[0],
                'u32=%#x' % struct.unpack('<I', data[f:f + 4])[0]]
        if f + 8 <= len(data):
            bits.append('f64=%.8g' % struct.unpack('<d', data[f:f + 8])[0])
        return '  ; -> v%#06x %s' % (target, ' '.join(bits))

    at = file_offset(start)
    if at is None:
        raise SystemExit('v%#x is not in a loaded segment of %s' % (start, module))
    for insn in _md.disasm(data[at:at + count * 15], start):
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
    if sys.argv[2] == 'map':
        for base, size, off in segments(MODULES[sys.argv[1]])[1]:
            print('v%#010x..%#010x -> file %#x   (delta %#x)' % (base, base + size, off, off - base))
        raise SystemExit
    dis(sys.argv[1], int(sys.argv[2], 0), int(sys.argv[3], 0) if len(sys.argv) > 3 else 60)
