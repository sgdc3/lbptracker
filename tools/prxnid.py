"""Resolve the imports of one of the audio PRXs, by NID.

    prxnid.py <module> imports              every PLT import, with its NID
    prxnid.py <module> <n>                  one PLT entry, by index or stub vaddr
    prxnid.py <module> guess <name> ...     hash names and say which import they are
    prxnid.py hash <name> ...               just the NID for a name

`<module>` is `reverb` (fmodsmsreverb.prx) or `input` (fmodextinput.prx).

⚠️ **`tools/ebdyn.py` does this for the eboot and cannot do it for a PRX**, which is
why this exists. The eboot's dynamic tables are where an ELF reader expects them;
a PRX's are not, and the two traps below cost an hour each.

## Trap 1 — half the SELF segments are digests, not data

The SELF table at `0x20 + n*0x20` holds `(props, offset, filesz, memsz)`, and
`props >> 20` is the ELF program-header index it belongs to. But the entries whose
low nibble is `4` with `filesz == 0x20` are **32-byte digest blocks** sitting in
front of the real segment. `fmodextinput.prx`:

```
seg[0] props=0x110004 idx=1 off=0x7a0  filesz=0x40    <- digest
seg[1] props=0x2804   idx=0 off=0x7e0  filesz=0x4b08  <- the code
seg[2] props=0x310004 idx=3 off=0x52f0 filesz=0x20    <- digest, and the ONLY
                                                         entry naming index 3
seg[5] props=0x602804 idx=6 off=0x5550 filesz=0x708   <- SCE_DYNLIBDATA
```

Reading `PT_DYNAMIC` at `0x52f0` because the table says index 3 lives there gives
thirty-two zero bytes and a dead end.

## Trap 2 — `PT_DYNAMIC` lives *inside* `SCE_DYNLIBDATA`

There is no data segment for it. Its contents are a sub-range of the dynlib blob,
and the program headers say where: `PT_DYNAMIC.p_offset - SCE_DYNLIBDATA.p_offset`
is the offset within it. **Every `d_val` in the dynamic table is likewise an offset
into that blob**, not a vaddr and not a file offset — `SCE_STRTAB`, `SCE_SYMTAB`,
`SCE_JMPREL` and the rest are all relative to it.

## The NID

`base64(SHA1(name + salt)[0:8] as little-endian u64)` over the alphabet
`A-Za-z0-9+-`, eleven characters, the last one being the low nibble shifted up by
two. The salt is the well-known `518D64A635DED8C1E6B039B1C3E55230`.

✔ Verified against two imports of this very PRX: `memset` is PLT #0 and `memcpy`
is PLT #8, and the shape of both call sites already said so — `0xe0` is called
with `(record, 0, 0xd0)` and its result discarded.

⚠️ **The hash is one-way**, so names come from a table. There are two, and the
second makes the first almost unnecessary:

- the handful seeded below, kept so this works with nothing else installed;
- ⚠️ **shadPS4's `aerolib.inl`**, 171,520 lines of `STUB("nid", name)` covering
  every symbol Sony ships. If the checkout is where `AEROLIB` points, everything
  resolves and `guess` becomes a curiosity.

✔ That table also **confirms the hash independently**: it gives `cpCOXWMgha0` as
`rand`, which is what the salt-and-SHA1 above computes and what question 12 hangs
on. Two derivations, one answer.

❗ It is worth knowing what sixty guesses could not find: `H2e8t5ScQGc`, imported
by both PRXs, is `__cxa_finalize`. Nobody would have guessed that.
"""
import hashlib
import struct
import sys

MODULES = {
    'reverb': r'D:\PS4Games\CUSA00063-patch\gamedata_orbis\spu\fmodsmsreverb.prx',
    'input': r'D:\PS4Games\CUSA00063-patch\gamedata_orbis\spu\fmodextinput.prx',
}

_SALT = bytes.fromhex('518D64A635DED8C1E6B039B1C3E55230')
_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-'

# shadPS4 ships the whole of Sony's NID table as `STUB("nid", name)` lines. It is
# the difference between resolving every import and guessing at them.
AEROLIB = (
    'C:' + chr(92) + 'Users' + chr(92) + 'sgdc3' + chr(92) + 'Desktop' + chr(92)
    + 'shadPS4' + chr(92) + 'shared' + chr(92) + 'src' + chr(92) + 'core'
    + chr(92) + 'aerolib' + chr(92) + 'aerolib.inl'
)

# Seeded from the hash below, so this still resolves the common ones with no
# shadPS4 checkout at all. `aerolib` overwrites and extends it when present.
KNOWN = {}


def nid(name):
    """The NID a symbol name hashes to."""
    digest = hashlib.sha1(name.encode() + _SALT).digest()
    value = int.from_bytes(digest[:8], 'little')
    head = ''.join(_ALPHABET[(value >> (58 - i * 6)) & 0x3F] for i in range(10))
    return head + _ALPHABET[(value & 0xF) << 2]


for _name in (
    'memset', 'memcpy', 'memmove', 'memcmp', 'rand', 'srand', 'random', 'srandom',
    'arc4random', 'malloc', 'free', 'calloc', 'realloc', 'abort', 'qsort',
    '__stack_chk_fail', '__stack_chk_guard', '__cxa_atexit',
    'sinf', 'cosf', 'tanf', 'powf', 'expf', 'logf', 'sqrtf', 'floorf', 'ceilf',
    'fabsf', 'atan2f', 'fmodf', 'asinf', 'acosf', 'atanf', 'log10f', 'exp2f',
    'sceKernelUsleep', 'sceKernelGetProcessTime', 'clock_gettime',
):
    KNOWN[nid(_name)] = _name

try:
    with open(AEROLIB, encoding='utf-8', errors='replace') as _f:
        for _line in _f:
            _at = _line.find('STUB("')
            if _at < 0:
                continue
            _rest = _line[_at + 6:]
            _nid, _, _rest = _rest.partition('"')
            _name = _rest.strip().lstrip(',').strip().rstrip(')').strip()
            if _nid and _name:
                KNOWN[_nid] = _name
except OSError:
    pass  # no checkout; the seeded names above still work


def _dynlib(path):
    """The dynlib blob's file offset and the dynamic table inside it."""
    data = open(path, 'rb').read()
    elf = data.index(b'\x7fELF')
    phoff, = struct.unpack_from('<Q', data, elf + 0x20)
    phentsize, phnum = struct.unpack_from('<HH', data, elf + 0x36)
    dynamic = dynlibdata = None
    for i in range(phnum):
        p = elf + phoff + i * phentsize
        p_type, = struct.unpack_from('<I', data, p)
        p_off, = struct.unpack_from('<Q', data, p + 8)
        if p_type == 2:
            dynamic = p_off
        elif p_type == 0x61000000:
            dynlibdata = p_off
    if dynamic is None or dynlibdata is None:
        raise SystemExit('no PT_DYNAMIC or SCE_DYNLIBDATA in %s' % path)

    # Where the dynlib blob really is: the SELF entry for its index that carries
    # data rather than a digest. See trap 1.
    count, = struct.unpack_from('<H', data, 0x18)
    blob = None
    for i in range(count):
        props, off, filesz, _ = struct.unpack_from('<QQQQ', data, 0x20 + i * 0x20)
        if filesz > 0x20 and (props >> 20) & 0xFFF == 6:
            blob = off
    if blob is None:
        raise SystemExit('no SCE_DYNLIBDATA segment in the SELF table')
    return data, blob, blob + (dynamic - dynlibdata)


def tables(path):
    """`(data, blob, tags)` — every dynamic tag, by its PS4 number."""
    data, blob, dyn = _dynlib(path)
    tags = {}
    at = dyn
    while True:
        tag, val = struct.unpack_from('<QQ', data, at)
        at += 16
        if tag == 0:
            break
        tags[tag] = val
    return data, blob, tags


def imports(module):
    """Every PLT relocation: `(index, got, nid, name-or-None)`."""
    data, blob, tags = tables(MODULES[module])
    strtab = blob + tags[0x61000035]
    symtab = blob + tags[0x61000039]
    jmprel = blob + tags[0x61000029]
    count = tags[0x6100002D] // 24
    out = []
    for i in range(count):
        got, info, _ = struct.unpack_from('<QQq', data, jmprel + i * 24)
        st_name, = struct.unpack_from('<I', data, symtab + (info >> 32) * 24)
        p = strtab + st_name
        name = data[p:data.index(b'\0', p)].decode('ascii', 'replace')
        out.append((i, got, name, KNOWN.get(name.split('#')[0])))
    return out


def _show(rows):
    for i, got, raw, name in rows:
        # A plain symbol -- `module_start` and friends -- is already its own name.
        shown = name or ('' if '#' in raw else raw) or '?'
        # The stub for PLT entry i is the one that pushes i; they start at 0xe0
        # and are 16 bytes apart in both of these files.
        print('  #%-2d stub %#06x  got %#08x  %-20s %s'
              % (i, 0xE0 + i * 0x10, got, raw, shown))


def main(argv):
    if len(argv) >= 3 and argv[1] == 'hash':
        for name in argv[2:]:
            print('%-32s %s' % (name, nid(name)))
        return
    if len(argv) < 3 or argv[1] not in MODULES:
        raise SystemExit(__doc__)
    module, what = argv[1], argv[2]
    rows = imports(module)
    if what == 'imports':
        print('%s: %d PLT imports' % (module, len(rows)))
        _show(rows)
        return
    if what == 'guess':
        table = {r[2].split('#')[0]: r for r in rows}
        for name in argv[3:]:
            hit = table.get(nid(name))
            print('%-32s %s  %s' % (name, nid(name),
                                    ('= PLT #%d' % hit[0]) if hit else 'not imported here'))
        return
    n = int(what, 0)
    # A stub address rather than an index: 0xe0 + 16i.
    if n >= 0xE0:
        n = (n - 0xE0) // 0x10
    _show([r for r in rows if r[0] == n] or [])


if __name__ == '__main__':
    main(sys.argv)
