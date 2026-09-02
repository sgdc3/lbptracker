r"""Resolve the eboot's dynamic imports: NID -> module, GOT slot, and every reference to it.

    ebdyn.py modules                 list the modules and libraries the eboot imports from
    ebdyn.py <nid-or-substring>      resolve a symbol and find who uses it

This exists because of a mistake that cost a session. `f7uOxY9mM1U#A#B` was read out of
`fmodextinput.prx` and matched against the eboot's dynamic string table, and the match was taken to
mean the eboot called the plugin. It does not: that NID is **libc, imported from libkernel**, and
the eboot loads its GOT slot from 18,094 sites. The plugin's actual export is `wycAbBCjLI4#C#D`,
where the trailing `#D` is the whole answer.

⚠️ **A NID's suffix names the module; read it before building anything on the symbol.** `NID#L#M`
encodes the library id `L` and module id `M` in the base64 alphabet `A-Za-z0-9+-`, and
`DT_SCE_NEEDED_MODULE` (`0x6100000f`) / `DT_SCE_IMPORT_LIB` (`0x61000009`) map those ids to names.
`modules` prints both tables.

⚠️ **Imports arrive by two different routes and only one of them is a PLT call.** A function called
through the PLT has a `JMPREL` entry, a stub `jmp qword ptr [rip+got]`, and `call rel32` sites
pointing at that stub. A function whose *address* is taken -- an FMOD callback, for instance -- has
a `RELA` `R_X86_64_GLOB_DAT` entry instead and is reached by `mov r64, [rip+got]`. This reports
both; a symbol with no `JMPREL` entry is not unused, it is the second kind.

⚠️ **`library ?` is normal, not a failure.** This eboot's `DT_SCE_IMPORT_LIB` holds only its own
export lib (id 0, the build path `Z:/bluray3day1/code/__BuildOutput__/ORBIS_Clang/pc/Opt/pc.elf`,
and id 54 `pc`), so the middle `#L` of an imported NID usually resolves to nothing. The module --
the trailing `#M` -- is the field that answers "whose symbol is this", and it always resolves.

Vaddrs in and out; the file delta lives in ebconf.py.
"""
import struct
import sys

import ebconf

B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-'

# Program-header search finds these; they are printed by `modules` so a moved build can be re-read.
_TAGS = {
    0x61000009: 'IMPORT_LIB', 0x6100000f: 'NEEDED_MODULE', 0x61000013: 'EXPORT_LIB',
    0x61000029: 'JMPREL', 0x6100002d: 'PLTRELSZ', 0x6100002f: 'RELA', 0x61000031: 'RELASZ',
    0x61000035: 'STRTAB', 0x61000037: 'STRSZ', 0x61000039: 'SYMTAB', 0x6100003f: 'SYMTABSZ',
}


def _segments(data):
    """(DYNAMIC file offset, size), (SCE_DYNLIBDATA file offset) from the program headers."""
    e_phoff, = struct.unpack_from('<Q', data, 0x20)
    e_phentsize, e_phnum = struct.unpack_from('<HH', data, 0x36)
    dyn = dl = None
    for k in range(e_phnum):
        o = e_phoff + k * e_phentsize
        p_type, = struct.unpack_from('<I', data, o)
        p_off, _, _, p_filesz, _ = struct.unpack_from('<QQQQQ', data, o + 8)
        if p_type == 2:
            dyn = (p_off, p_filesz)
        elif p_type == 0x61000000:
            dl = p_off
    return dyn, dl


def tables():
    """Every dynamic table the eboot declares, as file offsets, plus the id -> name maps."""
    data = ebconf.data()
    (dyn, dynsz), dl = _segments(data)
    t, mods, libs = {}, {}, {}
    for o in range(dyn, dyn + dynsz, 16):
        tag, val = struct.unpack_from('<QQ', data, o)
        if tag == 0:
            break
        name = _TAGS.get(tag)
        if name in ('NEEDED_MODULE', 'IMPORT_LIB', 'EXPORT_LIB'):
            (mods if name == 'NEEDED_MODULE' else libs)[(val >> 48) & 0xffff] = val & 0xffffffff
        elif name:
            t[name] = val
    strtab = dl + t['STRTAB']

    def s(off):
        return data[strtab + off:data.index(b'\x00', strtab + off)].decode('utf8', 'replace')

    return (data, dl, t, s,
            {k: s(v) for k, v in mods.items()}, {k: s(v) for k, v in libs.items()})


def symbols():
    """{index: name} over the whole dynamic symbol table."""
    data, dl, t, s, _, _ = tables()
    base, n = dl + t['SYMTAB'], t['SYMTABSZ'] // 24
    return {k: s(struct.unpack_from('<I', data, base + k * 24)[0]) for k in range(n)}


def slot_of(index):
    """(GOT slot vaddr, which table) for a dynamic symbol, or None."""
    data, dl, t, _, _, _ = tables()
    for name, sz in (('JMPREL', 'PLTRELSZ'), ('RELA', 'RELASZ')):
        base = dl + t[name]
        for k in range(t[sz] // 24):
            r_off, r_info, _ = struct.unpack_from('<QQq', data, base + k * 24)
            if (r_info >> 32) == index:
                return r_off, name
    return None


def references(slot, limit=40):
    """Every code reference to a GOT slot: PLT stubs and their callers, plus direct loads."""
    data, delta = ebconf.data(), ebconf.DELTA
    end = len(data)
    stubs, direct = {}, []
    for f in range(delta, end - 8):
        b = data[f]
        if b == 0xFF and data[f + 1] in (0x15, 0x25):          # call/jmp qword ptr [rip+d]
            d, = struct.unpack_from('<i', data, f + 2)
            if (f - delta) + 6 + d == slot:
                if data[f + 1] == 0x25:
                    stubs[f - delta] = True                    # a PLT stub, not a use
                else:
                    direct.append(('call [rip]', f - delta))
        elif b in (0x48, 0x4C) and data[f + 1] == 0x8B and (data[f + 2] & 0xC7) == 0x05:
            d, = struct.unpack_from('<i', data, f + 3)
            if (f - delta) + 7 + d == slot:
                direct.append(('mov r64,[rip]', f - delta))
    calls = []
    if stubs:
        for f in range(delta, end - 5):
            if data[f] == 0xE8:
                d, = struct.unpack_from('<i', data, f + 1)
                if (f - delta) + 5 + d in stubs:
                    calls.append(('call stub', f - delta))
    return stubs, direct[:limit], calls[:limit], len(direct), len(calls)


def main(arg):
    _, _, _, _, mods, libs = tables()
    if arg == 'modules':
        print('modules (DT_SCE_NEEDED_MODULE) -- the trailing #M of a NID indexes this:')
        for k, v in sorted(mods.items()):
            print('  %3d (%s)  %s' % (k, B64[k] if k < 64 else '?', v))
        print('\nlibraries (DT_SCE_IMPORT_LIB / EXPORT_LIB) -- the middle #L:')
        for k, v in sorted(libs.items()):
            print('  %3d (%s)  %s' % (k, B64[k] if k < 64 else '?', v))
        return

    syms = symbols()
    hits = [(i, n) for i, n in syms.items() if arg in n]
    if not hits:
        print('no dynamic symbol contains %r' % arg)
        return
    for i, name in hits:
        mod = lib = '?'
        if len(name) > 4 and name[-2] == '#' and name[-4] == '#':
            mod = mods.get(B64.find(name[-1]), '?')
            lib = libs.get(B64.find(name[-3]), '?')
        print('\n%s   symbol %d' % (name, i))
        print('   module  %s' % mod)
        print('   library %s' % lib)
        got = slot_of(i)
        if not got:
            print('   no relocation -- not imported by address')
            continue
        slot, table = got
        print('   GOT slot v%#x  (%s)' % (slot, table))
        stubs, direct, calls, nd, nc = references(slot)
        for f in stubs:
            print('   PLT stub  v%#x' % f)
        if nd:
            print('   %d direct reference(s)%s:' % (nd, ', first 40' if nd > 40 else ''))
            for kind, a in direct:
                print('      %-14s v%#010x' % (kind, a))
        if nc:
            print('   %d call(s) to the stub%s:' % (nc, ', first 40' if nc > 40 else ''))
            for kind, a in calls:
                print('      %-14s v%#010x' % (kind, a))


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'modules')
