/**
 * `SMS WaveHammer` — the compressor the game's chain ends in.
 *
 * The last of three DSPs on the sequencer's channel:
 * `Sequencer → SMS Reverb → SMS WaveHammer → the mixer`. `Channel::addDSP` is
 * called at eboot `v0x3e67f9` and `v0x3e6976`, and it inserts at the head, so
 * the last one added sits closest to the output.
 *
 * ✔ **Every constant here is measured, and the model is checked against the
 * module actually running.** `tools/runhammer.py` loads `fmodsmswavehammer.prx`
 * into a process and executes it; `tools/wavehammer.py` is the same arithmetic
 * in Python; the two agree to 1e-4 dB over a DC sweep from −40 to −0.9 dBFS, and
 * `packages/lbp-tracker-lib/test/compressor.test.ts` pins this file against vectors taken from the
 * harness. See *The end of the chain* in `steering/lbp-audio-engine.md`.
 *
 * ❗ **The name is a trap and this project fell into it three times.** Wave
 * Hammer is a compressor *and* a limiter; the game ships `LimitBypass = 1`, so
 * the limiter never runs. The three wrong readings — "it is a limiter", "the
 * game never configures it", "it collapses to a constant −18 dB" — are tabulated
 * in *37* in `steering/answered-questions.md`. The last one survived a
 * disassembly of every byte of the module and died the moment it was run.
 *
 * ## What it does, per sample
 *
 * 1. **Detector** (`0xa40` `0x1000`): a 64-sample sliding sum of squares per
 *    channel, kept incrementally against a ring, then `max` across the two.
 * 2. **Lookup** (`0x10f0`): divide by the window to get a mean square, then
 *    index a 4000-entry gain table spanning `[F, 1]` with linear interpolation.
 *    `F` is the knee bottom as a power ratio, so `x ≤ F` short-circuits to unity.
 * 3. **Envelope** (`0x1190`): a one-pole on the *gain* — the attack coefficient
 *    when the gain falls, release when it rises — then a second one-pole whose
 *    output is `s_prev + s_new`.
 * 4. **Apply** (`0x330`): `out = in · gain`, the same gain on both channels, so
 *    the compressor is stereo-linked.
 *
 * ⚠️ The engine runs this per 256-frame block and shares one ring index between
 * the two channels rather than keeping one each. That is only harmless because
 * `256 % 64 == 0` returns the index to where the other channel started; it is
 * equivalent to the per-channel rings below, and stops being equivalent if the
 * block size ever changes — which the read callback refuses to let happen.
 */

/** How `SMS WaveHammer` is configured, in the plugin's own units. */
export interface WaveHammerParams {
  /** `CompThresh`, dB. The game ships −18. */
  readonly thresholdDb: number;
  /** `CompRatio`. The game ships 10. ⚠️ 50 and above is a hard limiter, not a steep ratio. */
  readonly ratio: number;
  /** `CompOutGain`, in **tenths** of a dB. The game ships −180. */
  readonly outGainTenths: number;
  /** `CompAttack`, ms. The game ships 10. */
  readonly attackMs: number;
  /** `CompRel`, ms. The game ships 250. */
  readonly releaseMs: number;
  /** `CompCoeffSet`, which picks the second smoother's pair. The game ships it set. */
  readonly coeffSet: boolean;
  /** `CompLongLook`, which doubles the detector's window to 128. The game ships it clear. */
  readonly longLook: boolean;
}

/**
 * The game's own settings, from the 0x44-byte template the create callback
 * copies over the plugin's parameter block (eboot `v0x1062850`, `rep movsd` at
 * `v0x3fd8cb`). It overrides eight of the sixteen declared defaults.
 *
 * ⚠️ The game never calls `DSP::setParameter` on this handle — all fifteen call
 * sites in the binary were enumerated (`tools/ebxref.py calls 0xa23970`) and
 * none of them is this DSP. That fact was once read as "the game does not
 * configure it", which is why the template took a session to find.
 */
export const WAVEHAMMER_SHIPPED: WaveHammerParams = {
  thresholdDb: -18,
  ratio: 10,
  outGainTenths: -180,
  attackMs: 10,
  releaseMs: 250,
  coeffSet: true,
  longLook: false,
};

/**
 * `0x6c8`–`0x733`: a one-pole coefficient as `0.1^(1/x)` with
 * `x = round(rate · ms · 1e-4)/8 − 3`, and zero when that is not positive.
 *
 * ⚠️ The `1e-4` is not a milliseconds-to-seconds conversion and the `/8` is not
 * a block size. Together they turn 10 ms at 48 kHz into `x = 3`, whose
 * coefficient 0.464159 is exactly what the running module reports at
 * `[state+0xf8]`, and 250 ms into `x = 147` and 0.984458 at `[state+0xfc]`.
 * Neither factor is explained here; both are measured, and the two agreements
 * are what say the formula is read right.
 */
export function waveHammerCoefficient(ms: number, sampleRate: number): number {
  const x = Math.round(sampleRate * ms * 1e-4) / 8 - 3;
  return x > 0 ? 0.1 ** (1 / x) : 0;
}

/**
 * The 4000-entry gain table `0xc43` builds, over the axis `[floor, 1]` in
 * mean-square level.
 *
 * The knee is the unique cubic Hermite matching value *and* slope at both ends —
 * unity gain at `T−3`, slope `1/R` at `T+3` — which is why `P(1) = 1`,
 * `K·A/6 = 1` and `K·B/6 = 1/R` hold identically in `R`. The whole table
 * therefore reduces to `gain_dB = −3(1−r)t²` for `t ≤ 1` and `3(1−2t)(1−r)`
 * above, with `t = (L − T + 3)/6`; `tools/wavehammer.py check` agrees that
 * closed form with a literal transcription of the assembly to 2.1e-14 dB.
 *
 * ⚠️ `ratio ≥ 50` is **not** the same curve with a small `1/R`: `0xbc9` masks
 * the reciprocal to zero and `0xcb6` takes `out = T` outright.
 */
export function waveHammerTable(
  thresholdDb: number,
  ratio: number,
  floor: number,
): Float32Array {
  const big = ratio >= 50;
  const invR = big ? 0 : 1 / ratio;
  const k = big ? 3 : invR * 3 + 3;
  const a = 6 / k;
  const b = invR * a;
  const c3 = a + b - 2;
  const c2 = 3 - 2 * a - b;
  const out = new Float32Array(4000);
  for (let i = 0; i < 4000; i += 1) {
    const x = floor + (1 - floor) * (i / 3999);
    const level = 10 * Math.log10(x);
    let target: number;
    if (level > thresholdDb + 3) {
      target = big ? thresholdDb : thresholdDb + invR * (level - thresholdDb);
    } else {
      const t = (level - thresholdDb + 3) / 6;
      target = thresholdDb - 3 + k * (a * t + c2 * t * t + c3 * t * t * t);
    }
    out[i] = 10 ** ((target - level) * 0.05);
  }
  return out;
}

/** The bottom of the table's axis: the knee bottom as a power ratio (`0x408`). */
export function waveHammerFloor(thresholdDb: number): number {
  return 10 ** ((thresholdDb - 3) / 10);
}

export class WaveHammer {
  private readonly gains: Float32Array;
  private readonly floor: number;
  private readonly indexScale: number;
  private readonly invWindow: number;
  private readonly window: number;
  private readonly mask: number;
  /** `[state+0x104]`: the automatic make-up at `0xd44` times the manual gain. */
  private readonly constant: number;
  private readonly attack: number;
  private readonly release: number;
  private readonly b0: number;
  private readonly a1: number;

  /** Two rings of `window` samples, channel 0 then channel 1. */
  private readonly ring: Float32Array;
  private at = 0;
  private sumL = 0;
  private sumR = 0;
  /** `[state+0xf0]`, which `create` and `0x39a` both set to 1.0. */
  private env = 1;
  /** `[state+0xf4]`, the coefficient last chosen. Zero until the first sample. */
  private coef = 0;
  /** `[state+0x114]`, how many samples the gain has been falling for. */
  private falling = 0;
  /**
   * `[state+0x12c]`, the second smoother's state.
   *
   * ⚠️ It is **not** zero at reset: `0x901` seeds it with `(1 − b0)/(1 + a1)`,
   * which is 0.5 for either coefficient pair. That is the smoother's own fixed
   * point for a gain of 1, so the first sample comes out near unity instead of
   * near `b0`. Starting it at zero makes sample 0 read 0.0126 where the running
   * module reads 0.998561 — an 18 dB hole at the top of every render.
   */
  private smooth: number;

  constructor(p: WaveHammerParams = WAVEHAMMER_SHIPPED, sampleRate = 48000) {
    this.window = p.longLook ? 128 : 64;
    this.mask = this.window - 1;
    this.invWindow = 1 / this.window;
    this.ring = new Float32Array(this.window * 2);
    this.floor = waveHammerFloor(p.thresholdDb);
    this.indexScale = 3999 / (1 - this.floor);
    this.gains = waveHammerTable(p.thresholdDb, p.ratio, this.floor);
    const manual = p.outGainTenths * 10 <= -9000 ? 0 : 10 ** (p.outGainTenths * 0.005);
    this.constant = (0.995 / this.gains[3999]) * manual;
    this.attack = waveHammerCoefficient(p.attackMs, sampleRate);
    this.release = waveHammerCoefficient(p.releaseMs, sampleRate);
    // `0x8a4` / `0x8c7`: one qword holding two floats, chosen by `CompCoeffSet`.
    // ⚠️ Read the *second float*, not the qword as a double: `prxdis` prints an
    // `f64` beside every operand and 0.96715366 is that double, not `a1`.
    this.b0 = p.coeffSet ? 0.0140483807772398 : 0.06660577654838562;
    this.a1 = p.coeffSet ? 0.9719032645225525 : 0.8667884469032288;
    // Both pairs are chosen so the smoother has unity DC gain, `2·b0/(1−a1)`.
    this.smooth = (1 - this.b0) / (1 + this.a1);
  }

  /** One frame in; the gain to apply to **both** channels out. */
  gainFor(left: number, right: number): number {
    const other = this.window;
    const oldL = this.ring[this.at];
    const oldR = this.ring[other + this.at];
    this.ring[this.at] = left;
    this.ring[other + this.at] = right;
    this.at = (this.at + 1) & this.mask;
    this.sumL += left * left - oldL * oldL;
    this.sumR += right * right - oldR * oldR;

    const x = Math.max(this.sumL, this.sumR) * this.invWindow;
    let table = 1;
    if (x > this.floor) {
      const index = (x - this.floor) * this.indexScale;
      if (index >= 3999) {
        table = this.gains[3999];
      } else {
        const lo = index | 0;
        table = this.gains[lo] + (index - lo) * (this.gains[lo + 1] - this.gains[lo]);
      }
    }

    const target = table * this.constant;
    let c: number;
    if (target >= this.env) {
      // The gain is rising, so the signal is getting quieter: release. `0x11d0`.
      if (this.falling === 0) {
        c = this.coef;
      } else {
        if (this.falling > 30) {
          // ⚠️ `0x121f` scales the count by `[state+0x120]`, and **nothing ever
          // writes that slot** — `CompRelMod` lands one word earlier at `+0x11c`
          // and is never read. Confirmed by running the module with `CompRelMod`
          // at 0, 50 and 100: `+0x11c` moves, `+0x120` stays zero and the output
          // does not change. So the count collapses to 30, the expression below
          // reduces to `release`, and the parameter is dead.
          if (this.falling >= 1001) this.falling = 1000;
          const scaled = (((this.falling - 30) * 0) | 0) / 30 + 1;
          c = this.release / (this.release + (1 - this.release) / scaled);
        } else {
          c = this.release;
        }
        this.coef = c;
        this.falling = 0;
      }
    } else {
      // The gain is falling, so the signal is getting louder: attack. `0x11ac`.
      c = this.attack;
      this.coef = c;
      this.falling += 1;
    }

    const u = this.env * c + target * (1 - c);
    const previous = this.smooth;
    this.smooth = this.b0 * u + this.a1 * previous;
    // ⚠️ `0x129a` writes `s_prev + s_new`, not `s_new`, and that sum is both the
    // gain applied and the value the next sample compares its target against.
    this.env = previous + this.smooth;
    return this.env;
  }
}
