/**
 * The game's sampler, reproduced.
 *
 * `src/audio/interpolate.ts` holds interpolators as a family so they can be
 * compared. This file holds something different: **one function that does what
 * `sub_0x3740` in `fmodextinput.prx` does**, including the parts that are not
 * "quality" choices at all -- the octave mipmapping and the exact shape of the
 * loop wrap. See the PRX section of steering/sequencer-data-model.md.
 *
 * The two halves of the design only make sense together. Linear interpolation
 * alone measures 19 dB SNR at 4 kHz, which is poor; the game never asks it to
 * stretch further than one octave, because past that it swaps the source for a
 * pre-decimated copy. Implementing the lerp without the mipmapping reproduces
 * the weakness and not the compensation, which is worse than either.
 */

/**
 * A sample at successive halvings: `chain[0]` is the sample's own rate,
 * `chain[1]` is decimated by 2, `chain[2]` by 4.
 */
export type MipChain = readonly Float32Array[];

/** The game keeps three. Measured: two thresholds, scales 0.5 and 0.25. */
export const MIP_LEVELS = 3;

/**
 * Pitch ratios at which the source is swapped, **measured** from rodata:
 * `v0x4538 = 2.0` selects the /2 copy and `v0x4530 = 4.0` the /4 copy.
 */
export const MIP_THRESHOLDS = [2, 4] as const;

/** Which mip a voice reads at this playback rate. */
export function mipLevelFor(playbackRate: number): number {
  if (playbackRate >= MIP_THRESHOLDS[1]) return 2;
  if (playbackRate >= MIP_THRESHOLDS[0]) return 1;
  return 0;
}

/**
 * **MEASURED: the copies are a pair average.**
 *
 * The builder is `fmodextinput.prx` `0x1320`, and it is a plain average of
 * adjacent frames:
 *
 * ```
 * 0x1340  len/2 -> [rdi+0x28], [rdi+0x40]      ; the halved copy's length
 * 0x134d  len/4 -> [rdi+0x50], [rdi+0x68]      ; and the quartered one's
 * 0x13ae  esi = (int16)src[2i]
 * 0x13b9  edx = (int16)src[2i | 2]             ; the next frame of that channel
 * 0x13bd  edx += esi
 * 0x13f4  ebx = edx; ebx >>>= 31; ebx += edx; ebx >>= 1
 * 0x13fd  dst[i] = (int16)ebx
 * ```
 *
 * The `| 2` rather than `+ 1` is because the buffer is **interleaved stereo**:
 * elements `2i` and `2i|2` are consecutive frames of the same channel, and
 * `0x1400`-`0x1429` repeats the whole thing on the odd elements for the other.
 * Per channel it is exactly `(a + b) / 2`.
 *
 * ⚠️ **The arithmetic is int16 and rounds toward zero.** The `shr` by one after
 * adding the sign bit is a signed halve that works because only the low 16 bits
 * are kept, so the result lands back on the sample grid. `(a + b) * 0.5` in
 * floats differs by under an LSB, which is still a difference the brief cares
 * about.
 *
 * The `.smp` files almost certainly hold level 0 only: they are plain RIFF with
 * a single `data` chunk, and their `smpl` loop points land where a loop belongs
 * in the audible material rather than in the first 57% that extra levels would
 * leave.
 */
export function decimateBy2(data: Float32Array): Float32Array {
  const out = new Float32Array(data.length >> 1);
  for (let i = 0; i < out.length; i += 1) {
    // The engine averages the pair in **int16**, not in floats:
    //
    //   esi = (int16)src[2i]; edx = (int16)src[2i|2]; edx += esi
    //   ebx = edx; ebx >>>= 31; ebx += edx; ebx >>= 1     ; toward zero
    //   dst[i] = (int16)ebx
    //
    // so the result lands on the sample grid, rounded toward zero rather than
    // to nearest. The difference from `(a + b) * 0.5` is under one LSB, but the
    // brief asks for bit-exact sample data and this is what bit-exact means
    // here.
    const sum = Math.round(data[i * 2] * 32768) + Math.round(data[i * 2 + 1] * 32768);
    out[i] = Math.trunc(sum / 2) / 32768;
  }
  return out;
}

/** Build `levels` successive halvings, `chain[0]` being `data` itself. */
export function buildMipChain(data: Float32Array, levels = MIP_LEVELS): Float32Array[] {
  const chain: Float32Array[] = [data];
  for (let i = 1; i < levels; i += 1) {
    const previous = chain[i - 1];
    // A one-frame level cannot be halved again, and a lerp needs two taps.
    chain.push(previous.length >= 4 ? decimateBy2(previous) : previous);
  }
  return chain;
}

/** Half-open, in **level-0 frames** -- the units the voice's position is in. */
export interface LoopSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * Read one frame, the way the game does.
 *
 * `position` is in level-0 frames whatever the mip: the engine keeps the voice
 * position in the sample's own rate (a `double` at voice record `+0x40`,
 * compared against the slot's frame count) and converts at read time, so the
 * loop arithmetic never has to know which copy is being read.
 *
 * ⚠️ **Two details here are the engine's, not conventional sampler practice.**
 * Both were read off `sub_0x3740` and both are audible at the wrap:
 *
 * 1. **Only the integer index is wrapped; the second tap is not.** At the last
 *    frame of the loop the engine interpolates towards the frame that follows
 *    it *in the file*, not towards the frame the loop jumps back to. Wrapping
 *    both taps -- which `interpolate.ts` does, for a defensible reason -- is
 *    smoother and is not what the game plays.
 * 2. **The wrap triggers on `>` , not `>=`.** Index `loop.end` is read
 *    directly, and the frame after it maps to `loop.start + 1` rather than to
 *    `loop.start`. So `loop.start` is visited once, on the way in; the
 *    repeating region is effectively `[start + 1, end]`.
 */
export function readMipped(
  chain: MipChain,
  position: number,
  level: number,
  loop?: LoopSpan,
): number {
  const full = chain[0];
  let index = Math.trunc(position);
  const frac = position - Math.floor(position);

  if (loop) {
    const span = loop.end - loop.start;
    // `>` and not `>=`: see note 2 above.
    if (span > 0 && index > loop.end) {
      index = loop.start + ((index - loop.start) % span);
    }
  }
  if (index < 0 || index >= full.length) return 0;

  let source = full;
  let at = index;
  let t = frac;
  if (level > 0) {
    const divisor = 1 << level;
    source = chain[Math.min(level, chain.length - 1)];
    at = Math.trunc(index / divisor);
    t = (frac + (index % divisor)) / divisor;
  }

  const a = at >= 0 && at < source.length ? source[at] : 0;
  const b = at + 1 >= 0 && at + 1 < source.length ? source[at + 1] : 0;
  return a + (b - a) * t;
}
