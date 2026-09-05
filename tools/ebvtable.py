r"""Resolve a C++ class in the eboot to its vtable, and a vtable slot to its function.

    ebvtable.py <name-substring>            classes whose RTTI name matches, with their vtables
    ebvtable.py <name-substring> <n>        dump n slots of each matching vtable
    ebvtable.py slot <offset> <substring>   what every matching class puts at that slot offset
    ebvtable.py who <vaddr>                 which vtable slots hold this function

❗ **The eboot has RTTI, and that is the whole trick.** A vtable's typeinfo pointer names its class,
so 322 vtables in this binary can be *named* rather than guessed at. Question 22 spent a session
enumerating vtables by shape -- "runs of consecutive slots holding code addresses" -- filtering on
which slots looked plausible, and got five wrong candidates and a convincing near miss. The RTTI
route names the right one in a second. **Try this before any structural vtable search.**

## Trap -- the pointers are not in the file

⚠️ **Searching the data for a pointer to a type_info finds nothing.** This is a PIE: every vtable
slot is **zero** on disk and the value lives in the addend of an `R_X86_64_RELATIVE` relocation. The
relocations are plain 24-byte `(r_offset, r_info, r_addend)` triples with `r_info == 8`, sitting in
the image like any other data, so a stride-8 sweep for `r_info == 8` recovers the whole table
without parsing a single section header. `slots()` below is that sweep, and it is what turns
"the vtable is all zeros" into a map.

## How a name reaches a vtable

Itanium ABI, three hops, each one a lookup in the relocation map:

```
"N4FMOD15ChannelSoftwareE"      the mangled name, a plain string in .rodata
  <- type_info + 8              a relocation whose addend is the string
     type_info                  = that r_offset - 8
  <- vtable - 8                 a relocation whose addend is the type_info
     vtable                     = that r_offset + 8   <- slot 0 lives here
```

⚠️ **The second hop is ambiguous and the ambiguity is silent.** A pointer to `X`'s type_info comes
from `X`'s own vtable *and* from the `__si_class_type_info` of every class derived from `X`, where
it sits at `type_info + 16`. Both look identical in the relocation map, so half the "vtables" a
naive walk finds are really derived classes' type_infos, and dumping one prints strings and small
integers where functions should be. `_is_vtable` below rejects them by requiring slot 0 to be code.

## What it does not give you

Slot *numbers*, not method names -- nothing in the binary carries those. Identify a slot the way the
call site does: `v0xa0b539` calls `[vtable + 0x98]` with two floats and no integer, which is enough
to recognise `setPan(pan, spread)` once the class is known to be `ChannelSoftware`.
"""
import json
import os
import re
import struct
import sys

import ebconf

_TEXT = range(0x100000, 0xF00000)

_byoff = None
_byadd = None


def _load():
    """`(r_offset -> addend, addend -> [r_offset])` for every R_X86_64_RELATIVE in the image.

    The sweep is ~18 MB of stride-8 unpacking, so it is cached on disk next to this file the way
    `ebconf.source_path_sites` is, keyed by eboot size.
    """
    global _byoff, _byadd
    if _byoff is not None:
        return _byoff, _byadd
    d = ebconf.data()
    cache = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         '.relocs-%d.json' % len(d))
    try:
        with open(cache) as fh:
            _byoff = {int(k): v for k, v in json.load(fh).items()}
    except (OSError, ValueError):
        _byoff = {}
        for p in range(0, len(d) - 24, 8):
            if struct.unpack_from('<Q', d, p + 8)[0] != 8:
                continue
            off, = struct.unpack_from('<Q', d, p)
            add, = struct.unpack_from('<Q', d, p + 16)
            if off and add:
                _byoff[off] = add
        try:
            with open(cache, 'w') as fh:
                json.dump({str(k): v for k, v in _byoff.items()}, fh)
        except OSError:
            pass
    _byadd = {}
    for off, add in _byoff.items():
        _byadd.setdefault(add, []).append(off)
    return _byoff, _byadd


def names():
    """vaddr -> mangled RTTI name, for every Itanium-mangled type name in the image."""
    d = ebconf.data()
    return {m.start() - ebconf.DELTA: m.group()[:-1].decode()
            for m in re.finditer(rb'N\d+[A-Za-z0-9_]+E\x00', d)}


def _is_vtable(base):
    """A real vtable's slot 0 is a code address; a derived type_info's `base` field is not."""
    byoff, _ = _load()
    return byoff.get(base) in _TEXT


def vtables(substring=''):
    """`[(vtable vaddr, class name)]` for every RTTI-named vtable whose name matches."""
    byoff, byadd = _load()
    out = []
    for name_va, name in names().items():
        if substring and substring.lower() not in name.lower():
            continue
        for ti_name_slot in byadd.get(name_va, []):
            for slot in byadd.get(ti_name_slot - 8, []):
                if _is_vtable(slot + 8):
                    out.append((slot + 8, name))
    return sorted(set(out))


def slot(vtable, offset):
    """What a vtable holds at a byte offset, or None when that slot is not a relocated pointer."""
    return _load()[0].get(vtable + offset)


def main(argv):
    if len(argv) < 2:
        raise SystemExit(__doc__)
    if argv[1] == 'who':
        want = int(argv[2], 0)
        byoff, byadd = _load()
        owners = {v: n for v, n in vtables()}
        for off in byadd.get(want, []):
            base = max((v for v in owners if v <= off), default=None)
            where = ('%s +%#x' % (owners[base], off - base)) if base is not None else '(no vtable)'
            print('slot v%#010x  %s' % (off, where))
        return
    if argv[1] == 'slot':
        want = int(argv[2], 0)
        for base, name in vtables(argv[3] if len(argv) > 3 else ''):
            fn = slot(base, want)
            print('v%#010x  +%#05x -> %-14s %s'
                  % (base, want, ('v%#010x' % fn) if fn else '-', name))
        return
    found = vtables(argv[1])
    count = int(argv[2], 0) if len(argv) > 2 else 0
    for base, name in found:
        print('%s   vtable v%#010x' % (name, base))
        for i in range(count):
            fn = slot(base, i * 8)
            print('    [+%#05x] slot %-3d %s' % (i * 8, i, ('v%#010x' % fn) if fn else '-'))
    if not found:
        print('no RTTI-named vtable matches %r' % argv[1])


if __name__ == '__main__':
    main(sys.argv)
