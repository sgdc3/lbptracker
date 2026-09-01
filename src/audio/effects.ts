/**
 * The sequencer's two send effects: echo and reverb.
 *
 * ## What is measured, and what is not
 *
 * **Measured.** The sequencer carries `EchoTime`, `EchoFeedback` and `EchoMix`,
 * and each instrument an `echoSend` and a `reverbSend`. Across the corpus's 338
 * sequencers `EchoFeedback` runs 0–0.9 (median 0.45) and `EchoMix` 0–1 (median
 * 0.5) — a feedback coefficient and a wet/dry mix, unmistakably. `ReverbSetting`
 * runs 1–5. Of 129,696 instrument placements, **71,781 (55%) send to reverb**
 * and 28,244 (22%) to echo, so a dry render is missing more than it keeps.
 *
 * **Measured about the echo's implementation.** It is not an FMOD DSP: it lives
 * in `fmodextinput.prx`, and `sub_0x670` reads the 768,000-byte buffer at state
 * `+0x1b18` with a wrapping two-part copy. 768,000 bytes is **192,000 floats =
 * 48,000 frames × 4 channels = exactly 1.000 s at 48 kHz** — a one-second
 * delay line, and the DSP's own four channels are the two stereo busses the
 * renderer accumulates into.
 *
 * ⚠️ **Not measured: the echo's topology and `EchoTime`'s unit.** The eboot
 * writes `EchoTime × 0.5` into the state, and `EchoTime` itself runs 1–4, so
 * the state sees 0.5–2 against a buffer that holds 1 s. Seconds is the literal
 * reading of those two facts and is what this uses, clamped; beats at some
 * tempo would fit too. The feedback path, the wet/dry law and any stereo
 * cross-feed were not traced out of `sub_0x670` either. **Finish that trace
 * before trusting this to sound like the game** — what is below is a plain
 * delay, which is the shape those parameters describe and no more.
 *
 * **The reverb is now built on the game's own geometry.** Its tap lengths and
 * early reflections are read out of the eboot -- see the `Reverb` class -- and
 * only its topology is still inferred. It is no longer a Freeverb with a label.
 */

/** A stereo delay with feedback, driven by the sequencer's three fields. */
export class Echo {
  private readonly left: Float32Array;
  private readonly right: Float32Array;
  private cursor = 0;
  private readonly delay: number;
  readonly feedback: number;
  readonly mix: number;

  /**
   * @param echoTime the sequencer's field, **not** the halved value the engine
   *   stores — the halving happens here so the one place it matters is visible.
   */
  constructor(sampleRate: number, echoTime: number, feedback: number, mix: number) {
    // The engine's buffer is one second; anything longer would wrap onto itself.
    const seconds = Math.min(Math.max(echoTime * 0.5, 0), 1);
    const size = Math.max(1, Math.round(seconds * sampleRate));
    this.left = new Float32Array(size);
    this.right = new Float32Array(size);
    this.delay = size;
    this.feedback = Math.min(Math.max(feedback, 0), 0.95);
    this.mix = Math.min(Math.max(mix, 0), 1);
  }

  /** Process one frame, returning the wet signal to add to the mix. */
  process(l: number, r: number): { left: number; right: number } {
    const wetL = this.left[this.cursor];
    const wetR = this.right[this.cursor];
    this.left[this.cursor] = l + wetL * this.feedback;
    this.right[this.cursor] = r + wetR * this.feedback;
    this.cursor = (this.cursor + 1) % this.delay;
    return { left: wetL * this.mix, right: wetR * this.mix };
  }
}

/** How a preset's eleven `int32` slots are named, from `v0x3fcd50`. */
export const PRESET_SLOT = {
  /** Millibels. ⚠️ Never set from the table — the constructor pins it at −800. */
  level0: 0,
  /** Millibels. */
  level1: 1,
  /** Millibels, then divided by 100. */
  level2: 2,
  /** Index into `REVERB_TAP_SETS` — the late network's delay lengths. */
  tapSet: 3,
  /** Index into `REVERB_EARLY_SETS` — the early reflections. */
  earlySet: 4,
  /** Decay, read here as tenths of a second: the presets give 0.6–5.0 s. */
  decay: 5,
  /** An integer the configure copies raw; role unknown. */
  unknown6: 6,
  flag7: 7,
  /** A delay in **samples at 48 kHz** — the pre-delay. */
  preDelay: 8,
  flag9: 9,
  /** Hertz, 3000–12000. Read here as the damping corner. */
  hf: 10,
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
 * The game's reverb.
 *
 * **What is the engine's here**, all read out of the game rather than chosen:
 *
 * - the tap lengths (`REVERB_TAP_SETS`, `v0xe1d5d0`, selected by preset slot 3)
 *   and early reflections (`REVERB_EARLY_SETS`, `v0xe1d920`, slot 4);
 * - the millibel levels and their -80 dB floor, from `v0x3fcd50`;
 * - the pre-delay in samples, slot 8;
 * - **the decay law**, from `fmodsmsreverb.prx` `0x9e2`:
 *   `gain = 10^(delay * -0.003 / (slot5 * 0.1))`, i.e. `10^(-3t/RT60)` with
 *   `RT60 = slot5 * 0.1` seconds. `t` is the *single* tap's length, which is the
 *   standard gain for one **recirculating** comb to fall 60 dB in RT60 -- the
 *   law is only meaningful if each tap feeds back into itself;
 * - **the damping**, a one-pole `y = a*y + (1-a)*x` whose `a` is `state[+0x2c]`,
 *   derived from slot 10 (`0x82a`).
 *
 * ## The topology
 *
 * Schroeder's: a **parallel bank of damped feedback combs**, summed, into a
 * **series chain of allpass sections**. Both halves are visible in
 * `sub_0x11a0`'s nine loops:
 *
 * - `dampedComb` (loops D/E/F) carries an accumulator, `acc[i] += x[i]`. An
 *   accumulator across stages is what a **parallel** bank does; a series chain
 *   has nothing to accumulate, it just hands the signal on.
 * - `allpassSection` (loop C) is walked by the stage loop at `0x1460`-`0x14f9`,
 *   which **ping-pongs between two scratch buffers** (`xor ebx, 1`) so each
 *   stage's output becomes the next one's input. That is a **series** chain, and
 *   ping-ponging is what a cascade of allpasses needs and a parallel bank does
 *   not.
 *
 * So the series chain found at `0x1460` is the allpass cascade, not the combs.
 * The stage count is runtime data at `[r12+0x510]`; `v0x3fcc00` calls the
 * per-stage configure `v0x3fc8c0` **ten times**, which matches the ten tap
 * lengths of a table A row, so there is one stage per tap.
 *
 * Two things below are **ours, not measured**, and both are flagged at their
 * line: which taps are combs and which are allpasses, and the allpass
 * coefficient. See open question 6.
 *
 * ⚠️ A previous revision ran all ten taps as a *series* of feedback combs. It
 * is recorded here because the failure is instructive: combs in series multiply
 * their DC gains (`1/(1-g)` each), so ten of them diverge; and normalising the
 * forward path by `1-g` to fix that killed the tail in 30 ms. A structure that
 * can only be stabilised by destroying it is the wrong structure.
 */
export class Reverb {
  private readonly pre: Float32Array;
  private readonly preDelay: number;
  private preIndex = 0;
  /** The parallel bank. Each is a damped feedback comb; their outputs sum. */
  private readonly combs: {
    buffer: Float32Array;
    index: number;
    y: number;
    gain: number;
  }[] = [];
  /** The series cascade the bank feeds, in order. */
  private readonly allpasses: { buffer: Float32Array; index: number }[] = [];
  private readonly early: { delay: number; gain: number }[] = [];
  private readonly damp: number;
  private readonly wet1: number;
  private readonly wet2: number;

  /**
   * ⚠️ OURS. Schroeder's allpass coefficient. The engine's is `[stage+0x44]`,
   * computed somewhere in `v0x3fc8c0`, which has not been disassembled.
   */
  private static readonly ALLPASS_GAIN = 0.5;

  /** ⚠️ OURS: how many of a tap set's entries are allpasses rather than combs. */
  private static readonly ALLPASS_TAPS = 2;

  constructor(sampleRate: number, preset: readonly number[]) {
    const ms = (v: number) => Math.max(1, Math.round((v / 1000) * sampleRate));
    const taps = REVERB_TAP_SETS[preset[PRESET_SLOT.tapSet]] ?? REVERB_TAP_SETS[0];
    const early = REVERB_EARLY_SETS[preset[PRESET_SLOT.earlySet]] ?? REVERB_EARLY_SETS[0];

    const longest = Math.max(...early.slice(0, 3));
    this.pre = new Float32Array(
      Math.max(1, (preset[PRESET_SLOT.preDelay] | 0) + ms(longest) + 1),
    );
    this.preDelay = Math.max(0, preset[PRESET_SLOT.preDelay] | 0);

    // ⚠️ The early row's middle three floats run -80..+100 and are NOT levels:
    // reading them as decibels gives a gain of 100,000. The last three are
    // 0..1 and behave like gains.
    for (let i = 0; i < 3; i += 1) {
      this.early.push({ delay: ms(early[i]), gain: early[6 + i] });
    }

    const hf = Math.min(Math.max(preset[PRESET_SLOT.hf], 500), sampleRate / 2 - 1);
    this.damp = 1 - Math.exp((-2 * Math.PI * hf) / sampleRate);

    // RT60 = slot5 / 10 seconds, measured. The shortest taps become the
    // allpasses -- ⚠️ OURS: the split is not measured, only the fact that both
    // kinds of stage exist. Sorting keeps it deterministic across tap sets of
    // 8, 9 and 10 entries.
    const rt60 = Math.max(0.05, preset[PRESET_SLOT.decay] / 10);
    const ordered = [...taps].sort((a, b) => b - a);
    const split = Math.max(1, ordered.length - Reverb.ALLPASS_TAPS);
    for (const tap of ordered.slice(0, split)) {
      const length = ms(tap);
      this.combs.push({
        buffer: new Float32Array(length),
        index: 0,
        y: 0,
        gain: 10 ** ((-3 * (length / sampleRate)) / rt60),
      });
    }
    for (const tap of ordered.slice(split)) {
      this.allpasses.push({ buffer: new Float32Array(ms(tap)), index: 0 });
    }

    this.wet1 = millibelToLinear(preset[PRESET_SLOT.level1]);
    this.wet2 = millibelToLinear(preset[PRESET_SLOT.level2]);
  }

  /** One frame in, one frame out. Feed it the send bus; add the result to the mix. */
  process(input: number): number {
    this.pre[this.preIndex] = input;
    const tap = (back: number) =>
      this.pre[(this.preIndex + this.pre.length - Math.min(back, this.pre.length - 1)) % this.pre.length];

    let out = 0;
    for (const e of this.early) out += tap(e.delay) * e.gain;
    out *= this.wet1;

    const signal = tap(this.preDelay);
    this.preIndex = (this.preIndex + 1) % this.pre.length;

    // The parallel bank: read the delay, damp it, write the input back plus the
    // recirculated tail, and sum. This is the kernel's `acc[i] += x[i]`.
    let wet = 0;
    for (const comb of this.combs) {
      const delayed = comb.buffer[comb.index];
      comb.y = comb.y + this.damp * (delayed - comb.y);
      comb.buffer[comb.index] = signal + comb.gain * comb.y;
      comb.index = (comb.index + 1) % comb.buffer.length;
      // ⚠️ `1 - gain` is OURS. A feedback comb has DC gain `1/(1 - gain)`, so
      // eight of them summed are about nine times unity, and the preset's own
      // wet level -- which is the thing that is measured -- stops meaning
      // anything. Scaling each comb's *contribution* makes it unity at DC and
      // leaves its decay untouched, unlike scaling the recirculation.
      wet += (1 - comb.gain) * comb.y;
    }
    // Summing N combs that each rang at unit amplitude would be N times too
    // loud; the taps are mutually incoherent, so they add in power.
    wet /= Math.sqrt(this.combs.length);

    // The series cascade. An allpass passes every frequency at equal magnitude
    // and only smears phase, so it thickens the tail without changing its
    // level -- which is why cascading them is stable where cascading combs is
    // not.
    for (const ap of this.allpasses) {
      const delayed = ap.buffer[ap.index];
      ap.buffer[ap.index] = wet + Reverb.ALLPASS_GAIN * delayed;
      ap.index = (ap.index + 1) % ap.buffer.length;
      wet = delayed - Reverb.ALLPASS_GAIN * wet;
    }

    return out + wet * this.wet2;
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
 * The four kernels of `sub_0x11a0`, transcribed.
 *
 * Its nine loops are four distinct kernels: D, E and F are the same damped comb
 * at different buffer offsets, and the three long-span loops are the outer
 * iteration that runs the short ones once per tap. Each takes a block of
 * samples, since the engine processes 256 frames at a time.
 *
 * ⚠️ **These are the pieces, not the machine.** How they are chained -- which
 * buffer feeds which, in what order, and where the damping sits between the
 * taps -- is the topology, and that is still the one thing unread. Wiring them
 * up by taste would produce a reverb that sounds fine and is not the game's,
 * which is the failure mode this project keeps finding in its own past work.
 */

/** Loop A at `0x12f0`: `out[i] = (x[i] + x[i + offset]) * gain`. */
export function combSum(
  x: Float32Array, out: Float32Array, offset: number, gain: number, n: number,
): void {
  for (let i = 0; i < n; i += 1) out[i] = (x[i] + x[i + offset]) * gain;
}

/**
 * Loop B at `0x1340`: a one-pole written into a delayed slot.
 *
 * `y = a*y + b*x[i]` with the result stored at `buf[i + offset]`, and the final
 * `y` written back to the state at `[r12+0x10]` — so the filter's memory
 * survives the block, as it must.
 */
export function onePoleInto(
  buf: Float32Array, offset: number, a: number, b: number, y0: number, n: number,
): number {
  let y = y0;
  for (let i = 0; i < n; i += 1) {
    y = a * y + b * buf[i];
    buf[i + offset] = y;
  }
  return y;
}

/**
 * Loop C at `0x13b0`: an allpass-shaped section.
 *
 * ```
 * prev = y;  y = a*prev + b*buf[i] + c*older;  buf[i] = buf[i] - y;  older = prev
 * ```
 *
 * The `buf[i] - y` is what makes it allpass rather than a comb.
 */
export function allpassSection(
  buf: Float32Array, a: number, b: number, c: number, y0: number, older0: number, n: number,
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
 * Loops D, E and F at `0x1500`, `0x16c0` and `0x17e0` — the same kernel three
 * times, at different offsets into the state's buffers.
 *
 * ```
 * acc[i] += x[i]                       ; the tap accumulates
 * y = a*y + b*x[i]                     ; damped
 * out[i] = gain * (y + send[i])
 * ```
 */
export function dampedComb(
  x: Float32Array, acc: Float32Array, send: Float32Array, out: Float32Array,
  a: number, b: number, gain: number, y0: number, n: number,
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
