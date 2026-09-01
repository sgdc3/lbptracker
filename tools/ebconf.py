r"""Shared configuration for the eboot RE helpers.

Override either path with an environment variable if the game or the dumps move:
    LBP_EBOOT     path to the peeled ELF dump (default below)
    LBP_BINDINGS  path to the script-binding table

⚠️ DELTA is per-file. `eboot-v128.bin` is the already-peeled ELF (`file = vaddr + 0x4000`, which
its own program headers state). The installed fSELF at `D:\PS4Games\CUSA00063-patch\eboot.bin`
needs `0x8AD0` instead. Getting this wrong does not raise an error -- it silently reads strings
truncated by a byte or two and disassembles from mid-instruction. See steering/eboot-re.md.
"""
import json
import os
import re
import struct

EBOOT = os.environ.get(
    'LBP_EBOOT', r'C:\Users\sgdc3\Desktop\shadPS4\lbp3-ebins\eboot-v128.bin')
BINDINGS = os.environ.get(
    'LBP_BINDINGS', r'C:\Users\sgdc3\Desktop\shadPS4\lbp3-re\bindings-1.28.txt')
DELTA = int(os.environ.get('LBP_DELTA', '0x4000'), 0)

BS = chr(92)
_data = None


def data():
    global _data
    if _data is None:
        with open(EBOOT, 'rb') as fh:
            _data = fh.read()
    return _data


def bindings():
    """vaddr -> binding name. Only the vaddr column of the table is portable across eboot files."""
    out = {}
    try:
        fh = open(BINDINGS)
    except OSError:
        return out
    with fh:
        for line in fh:
            m = re.match(r'(\S+)\s+-> vaddr (0x[0-9a-f]+)', line)
            if m:
                out.setdefault(int(m.group(2), 16), m.group(1))
    return out


_STR = re.compile(rb'[\x20-\x7e]{3,}')


def string_at(file_off):
    d = data()
    if file_off < 0 or file_off + 3 > len(d):
        return None
    m = _STR.match(d, file_off)
    return m.group().decode() if m else None


_SRC = re.compile(rb'[A-Za-z]:' + BS.encode() * 2 + rb'[ -~]{4,160}?[.](?:cpp|hpp|h|inl|c)\x00')


_sites = None


def source_path_sites():
    """file offset of a rip-relative reference -> the __FILE__ path it points at.

    FMOD's memory tracker passes __FILE__ at every allocation, so these sites sit *inside* the
    code of the file they name. That is what lets us measure FMOD's extent instead of guessing it.

    The scan is a byte-by-byte sweep of the whole eboot, so the result is cached on disk next to
    this file (keyed by eboot size) -- otherwise every tool invocation pays ~30 s of startup.
    """
    global _sites
    if _sites is not None:
        return _sites

    d = data()
    cache = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         '.srcsites-%d.json' % len(d))
    try:
        with open(cache) as fh:
            _sites = {int(k): v for k, v in json.load(fh).items()}
            return _sites
    except (OSError, ValueError):
        pass

    paths = {m.start(): m.group()[:-1].decode() for m in _SRC.finditer(d)}
    sites = {}
    for o in range(0, len(d) - 4):
        disp = struct.unpack_from('<i', d, o)[0]
        if disp and (o + 4 + disp) in paths:
            sites[o] = paths[o + 4 + disp]
    try:
        with open(cache, 'w') as fh:
            json.dump({str(k): v for k, v in sites.items()}, fh)
    except OSError:
        pass
    _sites = sites
    return sites


def fmod_range():
    """(lo, hi) vaddrs of FMOD's code, measured from its own __FILE__ references."""
    sites = sorted(o for o, p in source_path_sites().items()
                   if 'fmod' in p.lower() and 0x904000 <= o <= 0xb04000)
    return sites[0] - DELTA, sites[-1] - DELTA
