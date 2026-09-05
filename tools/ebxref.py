r"""Who references an address in the eboot -- as data, or as a call target.

    ebxref.py refs  <vaddr>      every rip-relative reference to it (lea/mov/cmp/...)
    ebxref.py calls <vaddr>      every direct `call rel32` to it, clustered by caller

❗ **Run `calls` before writing down that the game never does something.** Question 37 stalled for a
session on "no `DSP::setParameter` call on the WaveHammer handle has been found" -- a true sentence
that was doing the work of a false one, because *not found* had never been separated from *not
there*. `calls 0xa23970` prints all fifteen sites in the binary in under a minute: nine are
`applyReverbPreset`, four are inside FMOD, one is a jump-table dispatcher on `[rdi+0x20]`, and that
is the whole population. The claim then stops being an absence of evidence.

And `refs` is the other half of it. The handle is a global at `v0x132aac0`; `refs` finds the four
`lea`s that read it, which is every path by which any code can reach the DSP. Three are teardown and
one is the `Channel::addDSP`, none stores it into an object -- so the dispatcher cannot be holding
it either. **Two enumerations, and an inference becomes a measurement.**

## How the game configured that DSP anyway

Worth keeping as the lesson rather than the anecdote: the answer was that it *is* configured, one
indirection away, by a `rep movsd` of a static 0x44-byte template into the plugin's own parameter
block at create time. A tool that enumerates call sites tells you an API is not used; it cannot tell
you the effect is absent. See *The end of the chain* in `steering/lbp-audio-engine.md`.

⚠️ **`refs` assumes the displacement is the instruction's last field**, which holds for `lea`/`mov`
and every load here, and fails for the forms that carry an immediate after it (`cmp dword [rip+d],
imm32` and friends) -- those reference `target - immediate_size` and are missed. It is the same
assumption `ebconf.source_path_sites` makes. The back-decode below prints the owning instruction
when one ends where it should and says so when none does, so a miss is visible rather than silent.

Both modes sweep the whole file, so they take tens of seconds. Addresses in and out are vaddrs.
"""
import struct
import sys

import capstone

import ebconf

_md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)


def refs(target):
    """`[(vaddr of the owning instruction, its text)]` -- the instruction, not the displacement.

    ⚠️ The distinction matters when you paste the result into `lbpdis.py`: the displacement sits
    three or four bytes into the instruction, so its address disassembles as nonsense.
    """
    data = ebconf.data()
    tf = target + ebconf.DELTA
    out = []
    for o in range(0x4000, len(data) - 4):
        disp = struct.unpack_from('<i', data, o)[0]
        if disp and o + 4 + disp == tf:
            out.append(_owner(data, o))
    return out


def _owner(data, o):
    """The instruction whose last four bytes are the displacement at file offset `o`."""
    for back in range(3, 12):
        for insn in _md.disasm(data[o - back:o - back + 16], o - back):
            if insn.address + insn.size == o + 4:
                return (insn.address - ebconf.DELTA, '%-9s %s' % (insn.mnemonic, insn.op_str))
            break
    return (o - ebconf.DELTA, '(no instruction ends here -- data, or an immediate follows)')


def calls(target):
    """Every direct `call rel32` to `target`, as vaddrs."""
    data = ebconf.data()
    tf = target + ebconf.DELTA
    out = []
    for o in range(0x4000, len(data) - 5):
        if data[o] == 0xE8 and o + 5 + struct.unpack_from('<i', data, o + 1)[0] == tf:
            out.append(o - ebconf.DELTA)
    return out


def _clusters(hits, gap=0x400):
    """Call sites grouped into runs, which is usually one group per calling function."""
    runs, cur = [], []
    for h in hits:
        if cur and h - cur[-1] >= gap:
            runs.append(cur)
            cur = []
        cur.append(h)
    if cur:
        runs.append(cur)
    return runs


def main(argv):
    if len(argv) < 3 or argv[1] not in ('refs', 'calls'):
        raise SystemExit(__doc__)
    target = int(argv[2], 0)
    lo, hi = ebconf.fmod_range()
    if argv[1] == 'refs':
        hits = refs(target)
        print('%d rip-relative references to v%#x' % (len(hits), target))
        for at, text in hits:
            print('  v%#010x  %s' % (at, text))
        return
    hits = calls(target)
    print('%d direct calls to v%#x  (FMOD code is v%#x..v%#x)' % (len(hits), target, lo, hi))
    for run in _clusters(hits):
        where = 'inside FMOD' if lo <= run[0] <= hi else 'game'
        span = 'v%#010x' % run[0] if len(run) == 1 else 'v%#010x .. v%#010x' % (run[0], run[-1])
        print('  %-28s %2d call%s   %s' % (span, len(run), ' ' if len(run) == 1 else 's', where))


if __name__ == '__main__':
    main(sys.argv)
