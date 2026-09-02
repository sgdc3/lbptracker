/**
 * The sequencer's two send effects: echo and reverb.
 *
 * Both are now read out of the game rather than inferred. The echo lives inside
 * `fmodextinput.prx`; the reverb is a separate DSP, `fmodsmsreverb.prx`,
 * configured by the eboot at `v0x3fcd50`.
 *
 * ⚠️ **PRX addresses in this file are TRUE ELF vaddrs** (`file = vaddr + 0x7c0`
 * for `fmodsmsreverb.prx`, `+ 0x7e0` for `fmodextinput.prx`). Addresses recorded
 * anywhere in this project before 2026-09-02 used a delta 0x40 too small and are
 * therefore **0x40 too high**. The readings themselves were not wrong — a
 * rip-relative operand resolves through the same delta twice, so the data those
 * disassemblies reported was correct — but the labels do not match a real
 * disassembler. See `steering/eboot-re.md`.
 *
 * **The sends, measured** (`fmodextinput.prx` `0x3b4f`-`0x3d10`). Each voice
 * carries three floats:
 *
 * | field | source | used for |
 * |---|---|---|
 * | `voice+0x1c` | the instrument's Params pair at `+0x5b0`/`+0x5b4`, interpolated by the note's modulation, then offset by the placement's `2*echoSend - 1` and clamped to 0..1 | the **echo** send |
 * | `voice+0x20` | the instrument's Params pair at `+0x5b8`/`+0x5bc` | **nothing — it is written and never read** |
 * | `voice+0x24` | the placement's `reverbSend`, clamped to 0..1 | the **reverb** send |
 *
 * The mixer at `0x2f00`-`0x2f8f` writes `L, R` into channels 0-1 of the DSP's
 * four-channel output, `L*voice[0x24], R*voice[0x24]` into channels 2-3 — that
 * pair is the reverb send bus — and `L*voice[0x1c], R*voice[0x1c]` into a stereo
 * stack buffer, which is the echo's input. So the reverb send is **post-fader
 * and post-pan**: it is the voice's own stereo output, scaled.
 *
 * ⚠️ The echo send is a **bipolar offset**, not a blend: `0x1607e9` stores
 * `2*echoSend - 1` into the note block, and `0x3ca1` applies it as
 * `v + o*v` when `o < 0` and `v + o*(1 - v)` when `o >= 0`. An `echoSend` of
 * 0.5 therefore leaves the instrument's own send untouched, 0 mutes it and 1
 * forces it to unity.
 */

/**
 * The game's echo, `fmodextinput.prx` `0x0680`, driven from the setup at `0x0f6a`.
 *
 * It is not an FMOD DSP: it lives inside the sequencer's own plugin, on a
 * 768,000-byte ring at `[state+0x1b18]` — **192,000 floats**, and the engine
 * clamps the delay against exactly that number, so the ring is measured in
 * floats and holds **interleaved stereo**: 96,000 frames, 2.0 s at 48 kHz.
 *
 * ## The delay, and the factor of two that hid in it
 *
 * `0x0f6a`-`0x0fc1` builds the length and `0x0fcb`-`0x0fdb` advances the cursor:
 *
 * ```
 * steps  = (int)floor(stored * 16 + 0.5)      ; stored is EchoTime * 0.5
 * fps    = (int)(720000 / tempo)              ; frames in one step
 * len    = (steps * fps) & ~0xf               ; FLOATS, not frames
 * len    = clamp(len, 16, 192000)
 * cursor = (cursor + 2 * n) % len             ; n frames -> 2n floats
 * ```
 *
 * and `0x0680` reads `min(2n, len - cursor)` floats from the ring at `cursor`,
 * processes them as `[L, R, L, R, …]`, and writes them back **at the same
 * cursor**. Read and write at one cursor means the delay is one full trip round
 * the ring, so:
 *
 * **delay in frames = `len / 2`** — and `len / 2` frames is
 * `round(EchoTime * 8) / 2` steps, which at four steps to the beat is
 * **`EchoTime` beats exactly.**
 *
 * ⚠️ Three readings preceded that, and the third was still wrong. First
 * `EchoTime * 0.5` **seconds**, which cannot be right in a tempo-locked
 * sequencer. Then **beats**, argued from the corpus's musical detents. Then
 * **eight steps per unit** — two beats — from `stored * 16`, which corrected the
 * beats reading by a factor of four and was itself a factor of two out, because
 * `len` counts floats and every frame is two of them. The corpus never
 * distinguished these: `EchoTime` is 2.00 on 189 of 338 sequencers, 1.00 on 95
 * and 1.50 on 47, and two beats, two bars and half a bar are all musical. Only
 * the unit of the cursor settles it, and the cursor is a float index.
 *
 * ## Two features that are in the code and off in the game
 *
 * The kernel at `0x07c0` also carries, on the delayed signal:
 *
 * - **two cascaded one-poles**, `s += (x - s) * k` with `k = 1 - [state+0x1a40]`,
 *   feeding both the output and the feedback (states at `+0x1b20`..`+0x1b2c`);
 * - a **ping-pong**: when `[state+0x1a3c] > 0.5` the write-back indices become
 *   `(2i) | 1` and `(2i+1) ^ 1`, so the feedback path swaps L and R each pass.
 *
 * ⚠️ **Neither is reachable.** `0x11fd`/`0x1207` initialise both fields to zero
 * and **nothing writes them**: a scan of the whole eboot finds *no* store to
 * `+0x1a3c` at all, and both of the two state-upload paths (`v0x1c5cf8` and
 * `v0x1c62b7`) write tempo, swing and the three echo fields and skip these. With
 * `[+0x1a40] = 0` the coefficient is 1 and the one-poles are pass-through; with
 * `[+0x1a3c] = 0` the ping-pong is off. So the shipped echo is a plain stereo
 * delay, and this class does not implement either — but they are worth knowing
 * about before someone "discovers" a filter in that loop.
 */
export class Echo {
  private readonly left: Float32Array;
  private readonly right: Float32Array;
  private cursor = 0;
  /** The delay in output frames — `len / 2`, so always a multiple of 8. */
  readonly frames: number;
  readonly feedback: number;
  readonly mix: number;
  /** The delay actually used, in seconds. Handy for reporting. */
  readonly seconds: number;

  /**
   * @param echoTime the sequencer's field, which is a delay in **beats**.
   * @param framesPerStep the sequencer's step length in output frames.
   */
  constructor(
    sampleRate: number,
    echoTime: number,
    framesPerStep: number,
    feedback: number,
    mix: number,
  ) {
    const steps = Math.max(0, Math.trunc(Math.max(echoTime, 0) * 0.5 * 16 + 0.5));
    // `& ~0xf` is the engine's block granularity, and the clamp's upper bound is
    // the ring's own float count. Both are applied to the FLOAT length.
    const floats = Math.min(
      192000,
      Math.max(16, Math.trunc(steps * Math.trunc(framesPerStep)) & ~0xf),
    );
    this.frames = floats >> 1;
    this.seconds = this.frames / sampleRate;
    this.left = new Float32Array(this.frames);
    this.right = new Float32Array(this.frames);
    // `vmaxss` against 0 then `vminss` against 0.95, at 0x0793-0x079b.
    this.feedback = Math.min(Math.max(feedback, 0), 0.95);
    this.mix = Math.min(Math.max(mix, 0), 1);
  }

  /**
   * Process one frame, returning the wet signal.
   *
   * ⚠️ In the engine this wet is added to **all four** of the plugin's output
   * channels (`0x0846`-`0x0858` builds `{wL, wR, wL, wR}`), and channels 2-3 are
   * the reverb send. **The echo feeds the reverb**, and the caller has to do
   * that; this returns one stereo pair.
   */
  process(l: number, r: number): { left: number; right: number } {
    const wetL = this.left[this.cursor];
    const wetR = this.right[this.cursor];
    this.left[this.cursor] = l + wetL * this.feedback;
    this.right[this.cursor] = r + wetR * this.feedback;
    this.cursor = this.cursor + 1 === this.frames ? 0 : this.cursor + 1;
    return { left: wetL * this.mix, right: wetR * this.mix };
  }
}

/**
 * The hard clip the sequencer's plugin puts on its own output.
 *
 * `0x0889`-`0x0899`: `vmaxps` against -1, `vminps` against +1, on all four
 * channels at once, applied to the dry mix **plus** the echo's wet, once per
 * frame. Channels 0-1 are what reaches the master and 2-3 are the reverb send,
 * so both are clipped — the reverb is fed a clipped signal.
 *
 * ⚠️ This is the only nonlinearity in the sequencer's output stage, and whether
 * it engages depends on our absolute level matching the game's, which is not
 * independently verified. `dev/render-level.ts` reports how much of the render
 * it touches, and `LBP_NO_CLIP=1` turns it off for an A/B.
 */
export function clipToUnit(v: number): number {
  return v > 1 ? 1 : v < -1 ? -1 : v;
}

/**
 * How a preset's eleven `int32` slots are named, from the DSP configure at
 * `v0x3fcd50` — the code that turns them into the plugin's parameter block.
 */
export const PRESET_SLOT = {
  /**
   * Millibels — the **dry** level, `[param+0x4c]`.
   *
   * `v0x3fd4c0` pushes slots 1-10 into DSP parameters 1-10 and never touches
   * slot 0; the constructor pins it at **-800**. `millibelToLinear`'s floor is
   * on `v*10 > -8000`, so -800 converts to a hard **zero**: the DSP is a pure
   * send effect and emits no dry signal at all.
   */
  dryLevel: 0,
  /** Millibels — the **late** (comb network) level, `[param+0x48]`. */
  lateLevel: 1,
  /**
   * Millibels — the **early reflections** level, `[param+0x50]`, and the engine
   * **divides it by 100** (`v0x3fce41`, `vdivss` against a literal 100).
   *
   * The divide is not a curiosity: the early rows carry gains of 46, -60 and 21,
   * so the hundredth is what brings them back to sane numbers. An earlier
   * revision of this file tried the divide on the *late* level instead and
   * killed the tail.
   */
  earlyLevel: 2,
  /** Index into `REVERB_TAP_SETS` — the late network's delay lengths. */
  tapSet: 3,
  /** Index into `REVERB_EARLY_SETS` — the early reflections. */
  earlySet: 4,
  /** Decay in tenths of a second: RT60 = `slot5 * 0.1` s. The presets give 0.6-5.0 s. */
  decay: 5,
  /**
   * The **output delay in milliseconds**, `[param+0x3c]` — a delay line the
   * summed comb bank passes through before the late level is applied, one per
   * output channel (`state+0x400` and `state+0x440`).
   *
   * This slot was called `unknown6` for a long time. The presets give 1-70 ms,
   * which is exactly the range a reverb's pre-delay lives in.
   */
  outputDelayMs: 6,
  /** Boolean — whether the input notch runs, `[param+0x20]`. Always 1 in the presets. */
  notchEnable: 7,
  /**
   * The notch frequency in hertz, before the engine's own scaling.
   *
   * `v0x3fce8e`-`v0x3fceed`: `f = slot8 / 48000`, then **`f /= 2.2` when
   * `f < 1/96` and `f /= 3.3` otherwise**, then clamp to `[0.0004, 0.49]`. The
   * threshold is 500 Hz, which no preset reaches, so every preset takes the
   * `/2.2` branch: 20 Hz ends up at 19.2 Hz after the clamp, 100 at 45.5 and
   * 400 at 181.8.
   *
   * ⚠️ An earlier revision used `slot8 / 48000` with no divisor, putting the
   * corner 2.2x too high.
   */
  notchHz: 8,
  /** Boolean — whether the damping one-pole runs, `[param+0x24]`. Preset 8 has it **off**. */
  dampEnable: 9,
  /** Hertz, 3000-12000 — the damping corner. `a = exp(-2*PI*hf/48000)`. */
  dampHz: 10,
} as const;

export const REVERB_TAP_SETS: readonly (readonly number[])[] = [
  [23.583, 47.049, 25.481, 27.493, 29.67, 34.518, 32.056, 37.317, 40.358, 19.941], // 0: 10 taps
  [23.161, 18.481, 20.611, 16.035, 26.45, 29.281, 12.957, 33.46], // 1: 8 taps
  [53.703, 67.624, 41.051, 72.937, 84.262, 49.613, 45.85, 57.837, 62.5, 78.724], // 2: 10 taps
  [13.453, 24.966, 28.415, 12.028, 15.817, 17.836, 10.72, 19.719, 9.439, 22.011], // 3: 10 taps
  [54.208, 28.707, 21.029, 49.33, 44.418, 35.918, 12.332, 66.457, 40.313, 60.051], // 4: 10 taps
  [70.539, 46.457, 52.802, 39.727, 76.939, 58.518, 64.33, 31.62, 90.769, 83.537], // 5: 10 taps
  [46.463, 89.887, 53.024, 58.824, 83.067, 70.527, 39.707, 76.433, 64.719, 31.627], // 6: 10 taps
  [25.037, 34.831, 29.502, 37.527, 32.139, 22.731, 40.532, 43.812, 47.07], // 7: 9 taps
  [32.963, 35.329, 44.227, 38.224, 62.813, 30.368, 41.467, 47.525, 51.611, 56.539], // 8: 10 taps
  [13.407, 24.354, 11.88, 10.291, 4.527, 15.213, 20.313, 8.519, 17.221, 6.513], // 9: 10 taps
  [31.71, 21.921, 5.019, 27.327, 11.403, 16.029, 6.604, 9.733, 8.169, 13.309], // 10: 10 taps
  [13.319, 20.32, 12.034, 10.609, 4.697, 14.75, 17.036, 9.106, 6.564, 7.949], // 11: 10 taps
  [21.096, 66.413, 28.715, 49.337, 44.433, 35.993, 12.339, 40.301, 54.257, 60.013], // 12: 10 taps
  [41.005, 45.815, 49.637, 53.795, 57.812, 62.504, 67.637, 72.921, 78.721, 84.212], // 13: 10 taps
  [37.051, 45.853, 62.817, 53.717, 57.815, 17.296, 67.611, 72.953, 78.716, 84.214], // 14: 10 taps
  [50.139, 62.811, 53.916, 25.834, 17.235, 67.81, 73.626, 93.927, 84.219], // 15: 9 taps
  [31.737, 15.013, 11.528, 36.037, 19.131, 5.439, 9.41, 26.433, 7.437], // 16: 9 taps
  [3.101, 18.37, 12.86, 11.063, 5.027, 15.513, 6.544, 9.539, 21.734, 7.924], // 17: 10 taps
  [29.809, 12.764, 49.653, 20.817, 25.333, 43.015, 15.957, 4.613, 9.111, 36.519], // 18: 10 taps
];

/**
 * The early-reflection rows at `v0xe1d920`, nine floats each.
 *
 * **The columns are `[d0, d1, d2, g0, g1, g2, p0, p1, p2]`** — three delays in
 * milliseconds, three gains, three pan positions in 0..1 — and the configure at
 * `0x1254`-`0x136b` is what says so:
 *
 * - the first three are multiplied by the sample rate, with the fixed offsets
 *   **+0.051, +0.151 and +0.078 ms** added first, and truncated to whole samples;
 * - the next three go straight into the tap gains at `state+0x51c`..`+0x530`;
 * - the last three are applied as `L = (1 - p) * g`, `R = p * g` — a **linear**
 *   pan law, not constant power — whenever the DSP is stereo, which it always is
 *   (`[param+0x40]` is pinned to 2 at `v0x3fce57`).
 *
 * ⚠️ An earlier revision read columns 6-8 as the gains and dismissed 3-5 as
 * "not levels" because 46, -60 and 21 are absurd as gains. They are not absurd:
 * the level they multiply is `10^(slot2/200) / 100`, of order 0.003.
 *
 * ⚠️ **The delay-to-gain pairing is not positional.** `0x1382`-`0x13ef` sorts
 * the three delays and permutes the gains as it goes, and the permutation is not
 * the identity even when nothing needs swapping. All seven rows happen to be
 * sorted ascending already, so the branch taken is always the same one, and it
 * pairs **`d0` with `g1`/`p1`, `d1` with `g0`/`p0`, `d2` with `g2`/`p2`**. That
 * is what `Reverb` implements. If a row ever arrived unsorted the pairing would
 * change, and reading the code that does it will not tell you what was intended.
 */
export const REVERB_EARLY_SETS: readonly (readonly number[])[] = [
  [6.113, 17.041, 29.231, 46, -60, 21, 0.14, 0.855, 0.474275], // 0
  [8.213, 20.043, 53.213, 56, -60, 18, 0.85, 0.15, 0.58], // 1
  [11.057, 17.049, 29.455, -47, 60, 28, 0.12, 1, 0.675], // 2
  [16.011, 30.058, 55.013, 79, -80, 40, 0.82, 0, 0.37], // 3
  [20.013, 29.021, 49.014, 100, -50, 40, 0.625, 0.355, 0.375], // 4
  [36.501, 47.132, 62.022, 100, -50, 40, 0.625, 0.355, 0.375], // 5
  [8.213, 20.043, 53.213, 56, -60, 18, 0.75, 0.85, 0.63], // 6
];

/** Millibels to linear, the engine's own conversion from `v0x3fcd50`. */
export function millibelToLinear(value: number): number {
  return value * 10 > -8000 ? 10 ** (value / 200) : 0;
}

/**
 * How many of a tap row's ten lengths a preset actually uses.
 *
 * The table at `v0xe1d5d0` is **eleven** floats per row, not ten: the first is a
 * count and the other ten are the lengths in milliseconds. `v0x3fc8c0` reads it
 * as `vcvttss2si r9, [row]`, and `fmodsmsreverb.prx` `0x0c12` does the same
 * against its own copy at `v0x2710`.
 */
export const REVERB_TAP_COUNTS: readonly number[] = [
  10, 8, 10, 10, 10, 10, 10, 9, 10, 10, 10, 10, 10, 10, 10, 9, 9, 10, 10,
];

/**
 * The two ratios the stereo comb pairs are detuned by, at `v0x2bc8`.
 *
 * Exactly two floats. `fmodsmsreverb.prx` `0x109d` indexes this table by the
 * pair index and multiplies the base delay by it, so the second pair's lengths
 * are `0.93 * taps[0]` and `1.06 * taps[1]`.
 *
 * ⚠️ These were called `REVERB_ALLPASS_RATIOS` for several revisions. There is
 * no allpass anywhere in this DSP; the stages they size are combs like all the
 * others, and what they do is decorrelate the left and right tails.
 */
export const REVERB_PAIR_RATIOS: readonly number[] = [0.93, 1.06];

/** The engine's own output rate, hard-coded at `v0x3fce4f` as `[param+0x10]`. */
const ENGINE_RATE = 48000;

/**
 * One damped feedback comb — the kernel at `fmodsmsreverb.prx` `0x09d0`:
 *
 * ```
 * x       = delay.read()
 * acc[i] += x                       ; the RAW delayed sample is what accumulates
 * y       = a*y + b*x               ; damped, inside the loop only
 * delay.write( gain * (y + send) )
 * ```
 *
 * Two details a Freeverb-shaped guess gets wrong, and this project did: the
 * value that leaves the comb is the **undamped** delay output, and the gain
 * multiplies the **input as well as** the recirculation.
 */
class Comb {
  private readonly buffer: Float32Array;
  private readonly gain: number;
  private index = 0;
  private y = 0;

  constructor(lengthSamples: number, gain: number) {
    this.buffer = new Float32Array(Math.max(1, lengthSamples));
    this.gain = gain;
  }

  /** Runs one sample and returns the raw delayed value to accumulate. */
  step(send: number, a: number, b: number): number {
    const x = this.buffer[this.index];
    this.y = a * this.y + b * x;
    this.buffer[this.index] = this.gain * (this.y + send);
    this.index = this.index + 1 === this.buffer.length ? 0 : this.index + 1;
    return x;
  }
}

/** A plain ring delay: read this sample's taps, then write the input. */
class DelayLine {
  private readonly buffer: Float32Array;
  private index = 0;

  constructor(lengthSamples: number) {
    this.buffer = new Float32Array(Math.max(1, lengthSamples));
  }

  tap(back: number): number {
    const n = this.buffer.length;
    const d = back >= n ? n - 1 : back;
    return this.buffer[(this.index + n - d) % n];
  }

  push(value: number): void {
    this.buffer[this.index] = value;
    this.index = this.index + 1 === this.buffer.length ? 0 : this.index + 1;
  }
}

/**
 * The game's reverb, `fmodsmsreverb.prx`.
 *
 * ## The signal flow, read from the block processor at `0x14e0`
 *
 * ```
 *  in L,R ──┬───────────────────────────────── * dryLevel ─────────────────┐
 *           │                                                              │
 *           ├─► earlyLine ─┬─ tap d0 ─ *(gL,gR) ─┐                          │
 *           │  (fed L + R) ├─ tap d1 ─ *(gL,gR) ─┼─ * earlyLevel ───────────┤
 *           │              └─ tap d2 ─ *(gL,gR) ─┘                          │
 *           │                                                              ▼
 *           └─►(L+R)*0.5 ─► damp ─► notch ─┬─► comb[2..n-1] ──► accL ──┐   out
 *                                          ├─► comb(taps[0])   ──► accL │   L,R
 *                                          ├─► comb(0.93*t0)   ──► accL │
 *                                          │       accR starts as a copy │
 *                                          ├─► comb(taps[1])   ──► accR │
 *                                          └─► comb(1.06*t1)   ──► accR │
 *                                                                       │
 *                                accL,accR ─► delay(slot6 ms) ─► * lateLevel
 * ```
 *
 * Every arrow above is a line of the disassembly:
 *
 * - **the mono downmix**, `(L + R) * 0.5`, at `0x1695`-`0x173e`;
 * - **the input damping one-pole**, `y = a*y + b*x`, at `0x1780`, with `b` at
 *   `[state+0x14]` and `a` at `[state+0x18]` — the same pair every comb uses;
 * - **the notch**, `out = x - (a*y1 + b*x + c*y2)`, in place at `0x1810`, gated
 *   by `[param+0x20]`. It is on the **input**, not the output, and it is what a
 *   long-standing "Schroeder allpass cascade" in this file was actually looking
 *   at;
 * - **`[state+0x510] = tapCount - 2` mono combs** on `taps[2..count-1]`, at
 *   `0x1960`, all accumulating into one buffer;
 * - **`[state+0x514] = 2` stereo pairs**, at `0x1b10` and `0x1c20`: pair 0 is
 *   `taps[0]` into the left accumulator and `taps[1]` into the right, pair 1 is
 *   `0.93*taps[0]` left and `1.06*taps[1]` right. The right accumulator is a
 *   **copy of the left** taken at `0x1a41`, after the mono combs and before the
 *   pairs, and that copy is the whole of the reverb's stereo width;
 * - **the output delay**, `0x1d2a`-`0x1d90` and `0x1e0c`-`0x1e73`: each
 *   accumulator goes into a delay line of `slot6` ms and the delayed value is
 *   what gets `lateLevel`;
 * - **the early reflections**, `0x1ef0`-`0x2051`: two delay lines fed by the raw
 *   L and R input, three taps each, every tap panned by a gain pair and all of
 *   it scaled by `earlyLevel`. Both lines have identical lengths, identical tap
 *   offsets and identical gains, so one line fed `L + R` is exactly equivalent
 *   and is what this uses.
 *
 * ## What is no longer here
 *
 * - **No allpass, and no allpass coefficient.** There is not one in the module.
 * - **No `1 - gain` normalisation on the comb outputs**, and no `/ sqrt(N)`.
 *   The kernel sums the raw delay outputs with nothing in between; the level is
 *   set entirely by `lateLevel` and `earlyLevel`, and both are measured.
 * - **No notch on the wet output.** It is on the input.
 * - **No pre-delay from slot 8.** Slot 8 is the notch frequency; the delay in
 *   the reverb is slot 6, and it sits after the combs rather than before them.
 *
 * ## What is still not modelled
 *
 * - The engine works in 256-frame blocks and rounds every delay buffer up to
 *   1 KB, so a tap shorter than 256 samples cannot behave as a plain per-sample
 *   delay there. Tap set 10's shortest is 5.019 ms = 241 samples, so preset 3
 *   (`ReverbSetting` 0) is the one place this could show.
 * - What gain, if any, the eboot puts on the connection from the sequencer DSP's
 *   channels 2-3 into this DSP, and from this DSP's output into the master. This
 *   class assumes unity at both ends.
 */
export class Reverb {
  private readonly monoCombs: Comb[] = [];
  private readonly leftCombs: Comb[] = [];
  private readonly rightCombs: Comb[] = [];
  private readonly outDelayL: DelayLine;
  private readonly outDelayR: DelayLine;
  private readonly outDelay: number;
  private readonly earlyLine: DelayLine;
  /** Tap delays in samples, and the linear-panned gain pair for each. */
  private readonly earlyTaps: { delay: number; gainL: number; gainR: number }[] = [];

  /** The shared damping one-pole: `y = a*y + b*x`, `b = 1 - a`. */
  private readonly dampA: number;
  private readonly dampB: number;
  private inY = 0;

  private readonly notchOn: boolean;
  private readonly notchA: number;
  private readonly notchB: number;
  private readonly notchC: number;
  private notchY1 = 0;
  private notchY2 = 0;

  readonly dryLevel: number;
  readonly lateLevel: number;
  readonly earlyLevel: number;

  constructor(sampleRate: number, preset: readonly number[]) {
    // 0x0ec9-0x0edb: `rate * ms/1000 + 0.5`, then truncate — round to nearest.
    const samples = (ms: number) => Math.max(1, Math.trunc((ms / 1000) * sampleRate + 0.5));

    const row = preset[PRESET_SLOT.tapSet];
    const taps = REVERB_TAP_SETS[row] ?? REVERB_TAP_SETS[0];
    const count = Math.min(REVERB_TAP_COUNTS[row] ?? taps.length, taps.length);
    const early = REVERB_EARLY_SETS[preset[PRESET_SLOT.earlySet]] ?? REVERB_EARLY_SETS[0];

    // `[rsi+0x38] * 0.1` at 0x0c5d, and `powf(10, -0.003 * ms / rt60)` at
    // 0x0d30. Both halves come off the writing code; neither is a choice.
    const rt60 = Math.max(0.05, preset[PRESET_SLOT.decay] * 0.1);
    const gainFor = (ms: number) => 10 ** ((-0.003 * ms) / rt60);

    // 0x0b65-0x0ba5: with `[param+0x24]` clear the engine stores `b = 1, a = 0`
    // as one qword, which is a filter that does nothing.
    if (preset[PRESET_SLOT.dampEnable]) {
      this.dampA = Math.exp((-2 * Math.PI * preset[PRESET_SLOT.dampHz]) / ENGINE_RATE);
      this.dampB = 1 - this.dampA;
    } else {
      this.dampA = 0;
      this.dampB = 1;
    }

    // v0x3fce8e-v0x3fcf9f. `r` and `-r*r` are a resonator's pole radius and its
    // square and `a = 2r*cos(w)`; subtracting that resonator from the signal is
    // a notch.
    const raw = preset[PRESET_SLOT.notchHz] / ENGINE_RATE;
    const scaled = raw < 1 / 96 ? raw / 2.2 : raw / 3.3;
    const f = Math.min(0.49, Math.max(0.0004, scaled));
    const r = Math.exp(-10 * Math.PI * f);
    const rr = Math.exp(-20 * Math.PI * f);
    this.notchA = 2 * r * Math.cos(2 * Math.PI * f);
    this.notchC = -rr;
    this.notchB = rr + 1 - this.notchA;
    this.notchOn = preset[PRESET_SLOT.notchEnable] !== 0;

    // The mono bank: lengths idx3..idx(n), which are indices 2..count-1 here
    // since these rows already have the count float stripped off the front.
    for (let i = 2; i < count; i += 1) {
      this.monoCombs.push(new Comb(samples(taps[i]), gainFor(taps[i])));
    }
    // The two stereo pairs. 0x0f70 sizes pair 0 from taps[0] and taps[1];
    // 0x1090 sizes pair 1 from the same two scaled by REVERB_PAIR_RATIOS.
    this.leftCombs.push(new Comb(samples(taps[0]), gainFor(taps[0])));
    this.rightCombs.push(new Comb(samples(taps[1]), gainFor(taps[1])));
    const leftDetuned = taps[0] * REVERB_PAIR_RATIOS[0];
    const rightDetuned = taps[1] * REVERB_PAIR_RATIOS[1];
    this.leftCombs.push(new Comb(samples(leftDetuned), gainFor(leftDetuned)));
    this.rightCombs.push(new Comb(samples(rightDetuned), gainFor(rightDetuned)));

    // 0x11a9-0x11d0: zero milliseconds still allocates one sample.
    this.outDelay = Math.max(
      1,
      Math.trunc((preset[PRESET_SLOT.outputDelayMs] / 1000) * sampleRate),
    );
    this.outDelayL = new DelayLine(this.outDelay + 1);
    this.outDelayR = new DelayLine(this.outDelay + 1);

    // 0x1254-0x12a1: the fixed offsets, then `vcvttss2si` — truncation, not
    // rounding, unlike every other length in the DSP.
    const perMs = sampleRate / 1000;
    const OFFSETS = [0.051, 0.151, 0.078];
    const delays = [0, 1, 2].map((i) => Math.max(0, Math.trunc((early[i] + OFFSETS[i]) * perMs)));
    // The pairing the sort leaves behind for an already-ascending row.
    const PAIRING = [1, 0, 2];
    for (let i = 0; i < 3; i += 1) {
      const gain = early[3 + PAIRING[i]];
      const pan = early[6 + PAIRING[i]];
      this.earlyTaps.push({ delay: delays[i], gainL: (1 - pan) * gain, gainR: pan * gain });
    }
    this.earlyLine = new DelayLine(Math.max(1, ...delays) + 1);

    this.dryLevel = millibelToLinear(preset[PRESET_SLOT.dryLevel]);
    this.lateLevel = millibelToLinear(preset[PRESET_SLOT.lateLevel]);
    this.earlyLevel = millibelToLinear(preset[PRESET_SLOT.earlyLevel]) / 100;
  }

  /**
   * One stereo frame of the send bus in, one stereo frame of reverb out.
   *
   * The DSP's dry level is a hard zero on every preset the game uses, so what
   * comes back is wet only and is meant to be added to the mix.
   */
  process(left: number, right: number): { left: number; right: number } {
    // Early reflections. One line stands in for the engine's two: both are read
    // at the same offsets with the same gains, so their taps sum to the taps of
    // `L + R`.
    let outL = 0;
    let outR = 0;
    for (let i = 0; i < 3; i += 1) {
      const t = this.earlyTaps[i];
      const x = this.earlyLine.tap(t.delay);
      outL += t.gainL * x;
      outR += t.gainR * x;
    }
    outL *= this.earlyLevel;
    outR *= this.earlyLevel;
    this.earlyLine.push(left + right);

    // The late field's input: mono, damped, notched.
    this.inY = this.dampA * this.inY + this.dampB * (left + right) * 0.5;
    let send = this.inY;
    if (this.notchOn) {
      const y = this.notchA * this.notchY1 + this.notchB * send + this.notchC * this.notchY2;
      this.notchY2 = this.notchY1;
      this.notchY1 = y;
      send -= y;
    }

    const a = this.dampA;
    const b = this.dampB;
    let accL = 0;
    for (const comb of this.monoCombs) accL += comb.step(send, a, b);
    let accR = accL;
    for (const comb of this.leftCombs) accL += comb.step(send, a, b);
    for (const comb of this.rightCombs) accR += comb.step(send, a, b);

    outL += this.lateLevel * this.outDelayL.tap(this.outDelay);
    outR += this.lateLevel * this.outDelayR.tap(this.outDelay);
    this.outDelayL.push(accL);
    this.outDelayR.push(accR);

    // Zero on every preset the game uses, and kept because the engine has it.
    outL += this.dryLevel * left;
    outR += this.dryLevel * right;
    return { left: outL, right: outR };
  }
}

/**
 * The reverb preset table, read out of the eboot at `v0x1062620`.
 *
 * Twelve presets of eleven `int32` slots each. `v0x3fd4c0` pushes slots 1-10
 * into DSP parameters 1-10, reading slots 7 and 9 as booleans; **slot 0 it never
 * touches**, and the constructor at `v0x3fd0d2` pins that slot to **-800** in
 * its private copy, so it is written as -800 here rather than left out. The
 * meanings come from `v0x3fcd50` and are named in `PRESET_SLOT`.
 */
export const REVERB_PRESETS: readonly (readonly number[])[] = [
  [-800, -350, -200, 0, 3, 25, 30, 1, 20, 1, 12000], // 0
  [-800, -350, -200, 0, 3, 25, 30, 1, 20, 1, 12000], // 1
  [-800, -160, -120, 8, 5, 30, 70, 1, 20, 1, 7000], // 2
  [-800, -200, -100, 10, 1, 6, 1, 1, 20, 1, 5000], // 3
  [-800, -350, -300, 4, 2, 25, 60, 1, 20, 1, 5000], // 4
  [-800, -150, -150, 2, 1, 12, 5, 1, 20, 1, 5000], // 5
  [-800, -100, -700, 13, 0, 12, 5, 1, 20, 1, 5000], // 6
  [-800, -160, -200, 18, 5, 25, 10, 1, 400, 1, 3000], // 7
  [-800, -250, -100, 16, 3, 20, 15, 1, 20, 0, 5000], // 8
  [-800, -130, -170, 18, 3, 20, 15, 1, 20, 1, 10000], // 9
  [-800, -240, -200, 2, 1, 10, 10, 1, 20, 1, 8000], // 10
  [-800, -280, -60, 4, 5, 50, 45, 1, 100, 1, 10000], // 11
];

/**
 * `ReverbSetting` -> preset index, from the 8-entry remap at `v0x1062830`.
 *
 * The corpus only ever uses settings 1-5.
 */
export const REVERB_REMAP: readonly number[] = [3, 6, 8, 5, 11, 2, 0, 0];

/** The preset a `ReverbSetting` selects, or the first when it is out of range. */
export function reverbPreset(setting: number): readonly number[] {
  const index = REVERB_REMAP[setting] ?? REVERB_REMAP[0];
  return REVERB_PRESETS[index] ?? REVERB_PRESETS[0];
}

/**
 * The four block kernels of `fmodsmsreverb.prx`, transcribed.
 *
 * They exist out of line at `0x08f0`-`0x0a30` and again inlined in the block
 * processor. `Reverb` runs the same arithmetic one sample at a time; these are
 * kept because they are what a re-check should be compared against, and because
 * each one's *role* was wrong in this file for a long time.
 */

/**
 * `0x0a30`: `out[i] = g0*a[i] + g1*b[i]`, a two-input weighted mix.
 *
 * The block processor uses it for the **stereo-to-mono downmix of the input**
 * with both gains at 0.5 (`0x1695`), which is where the late field's `(L+R)/2`
 * comes from.
 */
export function mixPair(
  a: Float32Array,
  b: Float32Array,
  out: Float32Array,
  g0: number,
  g1: number,
  n: number,
): void {
  for (let i = 0; i < n; i += 1) out[i] = g0 * a[i] + g1 * b[i];
}

/**
 * `0x0910`: a one-pole, `y = a*y + b*x`, written into a second buffer.
 *
 * The block processor uses it once per block on the mono input (`0x1780`), with
 * the same `a`/`b` the combs damp with. The final `y` is written back to the
 * state, so the filter's memory survives the block.
 */
export function onePoleInto(
  buf: Float32Array,
  offset: number,
  a: number,
  b: number,
  y0: number,
  n: number,
): number {
  let y = y0;
  for (let i = 0; i < n; i += 1) {
    y = a * y + b * buf[i];
    buf[i + offset] = y;
  }
  return y;
}

/**
 * `0x0960`: the notch, `out = x - (a*y1 + b*x + c*y2)`.
 *
 * ```
 * prev = y;  y = a*prev + b*buf[i] + c*older;  buf[i] = buf[i] - y;  older = prev
 * ```
 *
 * ⚠️ This was called `allpassSection` and described as "what makes it allpass".
 * It is not an allpass: with `a = 2r*cos(w)` and `c = -r*r` the recursion is a
 * resonator, and subtracting a resonator from the signal is a notch. The block
 * processor runs it in place on the **input** (`0x1810`), never on the output.
 */
export function notchSection(
  buf: Float32Array,
  a: number,
  b: number,
  c: number,
  y0: number,
  older0: number,
  n: number,
): { y: number; older: number } {
  let y = y0;
  let older = older0;
  for (let i = 0; i < n; i += 1) {
    const prev = y;
    const value = buf[i];
    y = a * prev + b * value + c * older;
    buf[i] = value - y;
    older = prev;
  }
  return { y, older };
}

/**
 * `0x09d0`: the damped comb, the only kernel the late field is built from.
 *
 * ```
 * acc[i] += x[i]                       ; the raw delayed sample accumulates
 * y       = a*y + b*x[i]
 * out[i]  = gain * (y + send[i])
 * ```
 */
export function dampedComb(
  x: Float32Array,
  acc: Float32Array,
  send: Float32Array,
  out: Float32Array,
  a: number,
  b: number,
  gain: number,
  y0: number,
  n: number,
): number {
  let y = y0;
  for (let i = 0; i < n; i += 1) {
    const value = x[i];
    acc[i] += value;
    y = a * y + b * value;
    out[i] = gain * (y + send[i]);
  }
  return y;
}
