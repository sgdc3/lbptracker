r"""Load `fmodsmswavehammer.prx` into this process and **run it**, as an oracle for the model.

    runhammer.py sweep      drive it with DC and compare against tools/wavehammer.py
    runhammer.py state      run it once and dump the state block it computed

❗ **This is what a static reading could not do, and it caught two wrong ones.** Reading the module
had produced "the window length is never initialised, so the compressor collapses to a constant
-18.04 dB". Running it printed `state+0xc0 = 64` in the first minute. The claim was wrong, the
compressor works, and the DSP had been described backwards in steering for a commit.

⚠️ **How the reading went wrong, because the technique looked airtight.** A superset disassembly --
decoding from every one of the 7,632 bytes so no desync could hide a store -- found no store to
`[reg + 0xc0]`, `[reg + 0xc4]` or `[reg + 0xc8]`, and that was *true*. The fields are written by
`0x380` through a pointer to a sub-struct at `state+0x84`, as

    mov qword ptr [rbx + 0x3c], rax        ; one 64-bit store: N at +0xc0 AND mask at +0xc4

**An absolute-offset search is only sound if every access uses the same base**, and a struct passed
by interior pointer breaks that. When a field looks uninitialised, the next question is not "did I
miss an instruction" but "can this field be reached under another name".

## What it needs

`fmodsmswavehammer.prx` where `tools/prxdis.py` points, and the eboot, for the parameter template at
`v0x1062850`. Nothing else -- the module has ten imports and only four are ever called on this path
(`memset`, `memcpy`, `powf`, `_FLog`), all of them satisfied here.

## How it works

The two PT_LOAD segments are copied to their own vaddrs inside one RWX allocation, so every
rip-relative reference in the module resolves without relocation; the five non-PLT relocations and
the ten PLT GOT slots are written by hand. `powf` and `_FLog` go to the CRT's `pow` and `log10`
through a shim that widens to double -- `_FLog(1, x)` is `log10f`, measured at libc `0x383e0`.

⚠️ The module is **System V**, this is Windows, so `sysv_thunk()` re-arranges the arguments and
saves what the two ABIs disagree about: `rsi`, `rdi` and `xmm6`-`xmm15` are callee-saved on Windows
and caller-saved on System V, so the PRX will clobber them. Getting the stack alignment wrong here
faults inside `vmovaps`, not at the call, so the frame arithmetic is spelled out below.

⚠️ `__stack_chk_fail` is wired to an `int3` and `_FLog`'s non-`log10` branches to another, so a
violated assumption crashes loudly instead of returning a plausible number.
"""
import ctypes
import math
import struct
import sys

import ebconf
import prxdis
import wavehammer as WH

TOTAL = 0x40000
THUNKS = 0xB000                       # the image ends at 0xa400
DATA = 0xC000
TEMPLATE_VADDR = 0x1062850            # the eboot's parameter template
N = 256                               # the block size the read callback demands

LAYOUT = dict(dsp_state=0x0000, canary=0x0010, inst=0x0020, params=0x0120, cfg=0x0170,
              state=0x0200, buf1000=0x0400, buf3e80=0x1400, inp=0x5300, out=0x6300)


class Hammer:
    def __init__(self):
        k32 = ctypes.windll.kernel32
        k32.VirtualAlloc.restype = ctypes.c_void_p
        k32.VirtualAlloc.argtypes = [ctypes.c_void_p, ctypes.c_size_t,
                                     ctypes.c_uint32, ctypes.c_uint32]
        self.mem = k32.VirtualAlloc(None, TOTAL, 0x3000, 0x40)   # COMMIT|RESERVE, RWX
        if not self.mem:
            raise SystemExit('VirtualAlloc failed')
        self.buf = (ctypes.c_ubyte * TOTAL).from_address(self.mem)
        ctypes.memset(self.mem, 0, TOTAL)
        self.off = {k: DATA + v for k, v in LAYOUT.items()}
        self._load()
        self._imports()
        self._structs()
        self._entry()

    # -- loading ---------------------------------------------------------------
    def _load(self):
        data, segs = prxdis.segments(prxdis.MODULES['hammer'])
        for base, memsz, off in segs:
            # The slice truncates at end-of-file on its own, which is what .bss needs: the
            # allocation is already zeroed.
            ctypes.memmove(self.mem + base, data[off:off + memsz], len(data[off:off + memsz]))

    def poke64(self, vaddr, value):
        struct.pack_into('<Q', self.buf, vaddr, value & 0xFFFFFFFFFFFFFFFF)

    def _imports(self):
        self.poke64(0x40b0, self.mem + 0x40b0)             # RELATIVE
        self.poke64(0x4030, self.mem + 0x40e0)             # RELATIVE
        self.poke64(self.off['canary'], 0xDEADBEEFCAFEF00D)
        self.poke64(0x4018, self.mem + self.off['canary'])  # GLOB_DAT __stack_chk_guard

        crt = ctypes.CDLL('msvcrt')
        pw = ctypes.cast(crt.pow, ctypes.c_void_p).value
        lg = ctypes.cast(crt.log10, ctypes.c_void_p).value

        code, placed = bytearray(), {}

        def emit(name, body):
            placed[name] = THUNKS + len(code)
            code.extend(body)

        def call_double(addr, one_arg):
            widen = 'F30F5AC0' if one_arg else 'F30F5AC0F30F5AC9'
            return (bytes.fromhex(widen + '4883EC28') + b'\x48\xB8'
                    + struct.pack('<Q', addr) + b'\xFF\xD0'
                    + bytes.fromhex('4883C428F20F5AC0C3'))

        emit('memset', bytes.fromhex('4989FA4889D189F0FCF3AA4C89D0C3'))
        emit('memcpy', bytes.fromhex('4989FA4889D1FCF3A44C89D0C3'))
        emit('powf', call_double(pw, one_arg=False))
        emit('flog', bytes.fromhex('85FF7E01EB01CC') + call_double(lg, one_arg=True))
        emit('trap', b'\xCC')
        emit('ret0', bytes.fromhex('31C0C3'))
        ctypes.memmove(self.mem + THUNKS, bytes(code), len(code))

        for slot, name in {0x4058: 'memset', 0x4060: 'powf', 0x4068: 'memcpy', 0x4070: 'flog',
                           0x4078: 'ret0', 0x4080: 'ret0', 0x4088: 'trap',
                           0x4090: 'ret0', 0x4098: 'ret0', 0x40a0: 'ret0'}.items():
            self.poke64(slot, self.mem + placed[name])

    # -- the structures the eboot's create builds -------------------------------
    def _structs(self):
        put8 = lambda b, o, v: struct.pack_into('<B', self.buf, b + o, v & 0xFF)
        put32 = lambda b, o, v: struct.pack_into('<i', self.buf, b + o, v)
        template = ebconf.data()[TEMPLATE_VADDR + ebconf.DELTA:][:0x44]
        ctypes.memmove(self.mem + self.off['params'], template, 0x44)
        p = lambda o: template[o]
        i32 = lambda o: struct.unpack_from('<i', template, o)[0]

        c = self.off['cfg']
        put8(c, 0x00, 0 if p(0x01) else 1)      # !LimitBypass -> limiter enabled
        put8(c, 0x01, 0 if p(0x00) else 1)      # !CompBypass  -> compressor enabled
        put8(c, 0x0c, p(0x1f)); put8(c, 0x0d, p(0x1d)); put8(c, 0x0e, p(0x2c))
        for dst, src in ((0x10, 0x0c), (0x14, 0x0c), (0x18, 0x04), (0x1c, 0x20), (0x20, 0x08),
                         (0x24, 0x24), (0x28, 0x10), (0x2c, 0x14), (0x30, 0x28), (0x34, 0x18)):
            put32(c, dst, i32(src))
        put32(c, 0x38, p(0x1c)); put32(c, 0x3c, p(0x1e))
        put32(c, 0x04, 2); put32(c, 0x08, 48000)
        # create bumps 0x44/0x46; setparameter bumps 0x40/0x42. Either way the state's copies at
        # +0x140.. start at zero, so the first block recomputes.
        struct.pack_into('<H', self.buf, c + 0x44, 1)
        struct.pack_into('<H', self.buf, c + 0x46, 1)

        self.poke64(self.off['inst'] + 0xe0, self.mem + self.off['params'])
        self.poke64(self.off['inst'] + 0xf0, self.mem + self.off['cfg'])
        self.poke64(self.off['inst'] + 0xf8, self.mem + self.off['state'])
        self.poke64(self.off['dsp_state'] + 8, self.mem + self.off['inst'])
        self.reset()

    def reset(self):
        """A fresh instance: the state block as create leaves it."""
        ctypes.memset(self.mem + self.off['state'], 0, 0x180)
        struct.pack_into('<f', self.buf, self.off['state'] + 0x6c, 1.0)
        struct.pack_into('<f', self.buf, self.off['state'] + 0xf0, 1.0)
        self.poke64(self.off['state'] + 0x130, self.mem + self.off['buf1000'])
        self.poke64(self.off['state'] + 0x138, self.mem + self.off['buf3e80'])
        ctypes.memset(self.mem + self.off['buf1000'], 0, 0x1000)
        ctypes.memset(self.mem + self.off['buf3e80'], 0, 0x3e80)
        struct.pack_into('<H', self.buf, self.off['cfg'] + 0x44, 1)
        struct.pack_into('<H', self.buf, self.off['cfg'] + 0x46, 1)

    # -- Windows -> System V ----------------------------------------------------
    def _entry(self):
        """A thunk for `read(dsp_state, in, out, length, inchannels, outchannels)`.

        Frame: `push rbp` then seven more pushes leaves rsp%16 == 8; `sub rsp, 0xA8` brings it to
        0 so `movaps [rsp+..]` is aligned, and the `call` then lands at rsp%16 == 8, which is what
        System V requires at a function's entry. Arguments five and six are at [rbp+0x30] and
        [rbp+0x38] -- past the return address and the caller's 32-byte shadow space.
        """
        b = bytearray()
        #      push rbp   mov rbp,rsp  rsi rdi rbx  r12   r13   r14   r15
        b += bytes.fromhex('55' '4889E5' '56' '57' '53' '4154' '4155' '4156' '4157')
        b += bytes.fromhex('4881ECA8000000')                          # sub rsp, 0xA8
        saves = ('0F2974 2400', '0F297C 2410', '440F2944 2420', '440F294C 2430', '440F2954 2440',
                 '440F295C 2450', '440F2964 2460', '440F296C 2470',
                 '440F29B4 2480000000', '440F29BC 2490000000')
        for enc in saves:
            b += bytes.fromhex(enc.replace(' ', ''))
        b += bytes.fromhex('4889C84989D24D89C34C89C94889C74C89D64C89DA4C8B45304C8B4D38')
        b += b'\x48\xB8' + struct.pack('<Q', self.mem + 0x19f0) + b'\xFF\xD0'
        for enc in saves:
            b += bytes.fromhex(enc.replace(' ', '').replace('0F29', '0F28', 1))
        b += bytes.fromhex('4881C4A8000000415F415E415D415C5B5F5E5DC3')
        at = THUNKS + 0x800
        ctypes.memmove(self.mem + at, bytes(b), len(b))
        proto = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                                 ctypes.c_uint32, ctypes.c_int32, ctypes.c_int32)
        self._read = proto(self.mem + at)

    # -- driving ----------------------------------------------------------------
    def block(self, samples):
        """One 256-frame block. `samples` is 256 frames x 4 interleaved channels."""
        struct.pack_into('<%df' % (N * 4), self.buf, self.off['inp'], *samples)
        rc = self._read(self.mem + self.off['dsp_state'], self.mem + self.off['inp'],
                        self.mem + self.off['out'], N, 4, 4)
        if rc != 0:
            raise SystemExit('read callback returned %d' % rc)
        if struct.unpack_from('<Q', self.buf, self.off['canary'])[0] != 0xDEADBEEFCAFEF00D:
            raise SystemExit('stack canary clobbered -- the harness corrupted something')
        return list(struct.unpack_from('<%df' % (N * 4), self.buf, self.off['out']))

    def dc_gain(self, amp, blocks=200):
        """Settle on a DC input and return the steady-state gain."""
        self.reset()
        for _ in range(blocks):
            out = self.block([amp] * (N * 4))
        return out[(N - 1) * 4] / amp

    def state_f32(self, o):
        return struct.unpack_from('<f', self.buf, self.off['state'] + o)[0]

    def state_i32(self, o):
        return struct.unpack_from('<i', self.buf, self.off['state'] + o)[0]


def _sweep():
    h = Hammer()
    t, r = WH.SHIPPED_THRESHOLD_DB, WH.SHIPPED_RATIO
    print('DC sweep against tools/wavehammer.py   (threshold %.1f dB, ratio %.1f:1)' % (t, r))
    print('  %-9s %-11s %-12s %-12s %s' % ('DC amp', 'in dBFS', 'measured', 'model', 'diff dB'))
    worst = 0.0
    for amp in (0.9, 0.7, 0.5, 0.35, 0.25, 0.2, 0.15, 0.126, 0.1, 0.05, 0.01):
        got = h.dc_gain(amp)
        # DC makes the 64-sample sliding mean square exactly amp^2, so the model needs no window.
        want = WH.gain_for_mean_square(amp * amp, t, r, WH.SHIPPED_OUT_GAIN_TENTHS)
        diff = 20 * math.log10(got / want)
        worst = max(worst, abs(diff))
        print('  %-9g %-11.2f %-12.6f %-12.6f %+.4f'
              % (amp, 20 * math.log10(amp), got, want, diff))
    print('\n  worst |measured - model| = %.4f dB   %s'
          % (worst, 'OK' if worst < 0.01 else 'MISMATCH'))
    return 0 if worst < 0.01 else 1


def _state():
    h = Hammer()
    h.dc_gain(0.5)
    print('the state block the DSP computed for itself:')
    print('  +0xc0  window N            = %d' % h.state_i32(0xc0))
    print('  +0xc4  ring index mask     = %d' % h.state_i32(0xc4))
    print('  +0xc8  axis floor F        = %.8g   (10^((T-3)/10) = %.8g)'
          % (h.state_f32(0xc8), 10.0 ** ((WH.SHIPPED_THRESHOLD_DB - 3.0) / 10.0)))
    print('  +0xe8  threshold, power    = %.8g' % h.state_f32(0xe8))
    print('  +0x104 output constant     = %.6f  (%+.3f dB)'
          % (h.state_f32(0x104), 20 * math.log10(h.state_f32(0x104))))
    print('  +0xf8  attack coefficient  = %.6f' % h.state_f32(0xf8))
    print('  +0xfc  release coefficient = %.6f' % h.state_f32(0xfc))
    print('  +0x124 smoother b0         = %.9f' % h.state_f32(0x124))
    print('  +0x128 smoother a1         = %.9f' % h.state_f32(0x128))
    return 0


if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else 'sweep'
    if mode == 'sweep':
        raise SystemExit(_sweep())
    if mode == 'state':
        raise SystemExit(_state())
    raise SystemExit(__doc__)
