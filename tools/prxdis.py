"""Disassemble fmodsmsreverb.prx by vaddr. file = vaddr + 0x780 (SELF segment [1])."""
import struct, sys
import capstone

PATH = r'D:\PS4Games\CUSA00063-patch\gamedata_orbis\spu\fmodsmsreverb.prx'
DELTA = 0x780
DATA = open(PATH, 'rb').read()
md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)

def f32(v):
    f = v + DELTA
    if f + 4 > len(DATA): return None
    return struct.unpack('<f', DATA[f:f+4])[0]

def dis(start, count=60):
    f = start + DELTA
    for insn in md.disasm(DATA[f:f + count*10], f):
        va = insn.address - DELTA
        op = insn.op_str
        note = ''
        import re
        m = re.search(r'\[rip \+ (0x[0-9a-f]+)\]', op)
        if m:
            tgt = va + insn.size + int(m.group(1), 16)
            vals = []
            v4 = f32(tgt)
            if v4 is not None: vals.append('f32 %.6g' % v4)
            fo = tgt + DELTA
            if fo + 8 <= len(DATA):
                vals.append('f64 %.6g' % struct.unpack('<d', DATA[fo:fo+8])[0])
            note = '  -> v0x%04x  %s' % (tgt, ' | '.join(vals))
        m2 = re.search(r'^(0x[0-9a-f]+)$', op)
        if m2 and insn.mnemonic in ('call','jmp','je','jne','jb','jbe','ja','jae','js','jns'):
            note = '  -> v0x%04x' % (int(m2.group(1),16) - DELTA)
        print('v0x%04x  %-10s %-42s%s' % (va, insn.mnemonic, op, note))

if __name__ == '__main__':
    dis(int(sys.argv[1], 16), int(sys.argv[2]) if len(sys.argv) > 2 else 60)
