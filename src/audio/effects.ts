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
 * The game's reverb, built on the game's own delay geometry.
 *
 * **What is the game's here**, read out of the eboot: the tap lengths in
 * `REVERB_TAP_SETS` (19 sets of 8-10 delays in milliseconds, at `v0xe1d5d0`,
 * selected by preset slot 3), the early reflections in `REVERB_EARLY_SETS`
 * (`v0xe1d920`, slot 4: three delays in ms, three levels in dB, three
 * coefficients), the millibel levels and their −80 dB floor, and the pre-delay
 * in samples. That geometry is most of what makes a room sound like itself, and
 * it is why this is not a Freeverb any more.
 *
 * **The decay law is MEASURED**, out of `fmodsmsreverb.prx`'s `sub_0x7f0` at
 * `0x9e2`-`0x9f5`:
 *
 * ```
 * gain = 10 ^ (delay * -0.003 / (slot5 * 0.1))
 * ```
 *
 * which is `10^(-3t / RT60)` with **`RT60 = slot5 * 0.1` seconds** -- 0.6-5.0 s
 * across the presets. That is exactly the reading this file had guessed, so the
 * feedback gains below are the engine's rather than a plausible stand-in.
 *
 * The **damping** is confirmed as a one-pole too: `0x82a` writes `state[+0x2c]`
 * and `1 - state[+0x2c]` into an adjacent pair, the `a` / `1-a` of
 * `y = a*x + (1-a)*y`, with `a` from preset slot 10.
 *
 * ⚠️ **What is still ours: the topology** -- how the ten taps feed one another
 * and where the damping sits between them. That lives in the kernel at
 * `sub_0x11a0`, 609 instructions over nine loops, opened but not transcribed.
 * See steering/open-questions.md.
 */
export class Reverb {
  private readonly pre: Float32Array;
  private readonly preDelay: number;
  private preIndex = 0;
  private readonly lines: { buffer: Float32Array; index: number; damp: number; gain: number }[] = [];
  private readonly early: { delay: number; gain: number }[] = [];
  private readonly wet1: number;
  private readonly wet2: number;

  constructor(sampleRate: number, preset: readonly number[]) {
    const ms = (v: number) => Math.max(1, Math.round((v / 1000) * sampleRate));

    const taps = REVERB_TAP_SETS[preset[PRESET_SLOT.tapSet]] ?? REVERB_TAP_SETS[0];
    const early = REVERB_EARLY_SETS[preset[PRESET_SLOT.earlySet]] ?? REVERB_EARLY_SETS[0];

    // Long enough for the pre-delay AND the early taps, which reach ~62 ms and
    // would otherwise be clamped into a 20-sample buffer.
    const longest = Math.max(...early.slice(0, 3));
    this.pre = new Float32Array(
      Math.max(1, (preset[PRESET_SLOT.preDelay] | 0) + ms(longest) + 1),
    );
    this.preDelay = Math.max(0, preset[PRESET_SLOT.preDelay] | 0);

    // Three early reflections. ⚠️ The row's middle three floats are NOT levels:
    // they run -80..+100 and reading them as decibels gives a gain of 100,000,
    // which is how this was caught. They are more likely pan or angle. The last
    // three are 0..1 and behave like gains, so those are what is used here.
    for (let i = 0; i < 3; i += 1) {
      this.early.push({ delay: ms(early[i]), gain: early[6 + i] });
    }

    // The late network. The damping corner is the preset's Hz value as a
    // one-pole coefficient; the feedback is an RT60 over  seconds.
    const decaySeconds = Math.max(0.05, preset[PRESET_SLOT.decay] / 10);
    const hf = Math.min(Math.max(preset[PRESET_SLOT.hf], 500), sampleRate / 2 - 1);
    const damp = Math.exp((-2 * Math.PI * hf) / sampleRate);
    for (const tap of taps) {
      const length = ms(tap);
      this.lines.push({
        buffer: new Float32Array(length),
        index: 0,
        damp: 0,
        gain: 10 ** ((-3 * (length / sampleRate)) / decaySeconds),
      });
    }
    this.dampCoefficient = 1 - damp;

    this.wet1 = millibelToLinear(preset[PRESET_SLOT.level1]);
    // ⚠️ `v0x3fcd50` divides this one by 100 and nothing here explains why --
    // slot 2's raw values are 0..18, which do not read as millibels the way
    // slots 0 and 1 do. Used undivided, or the late reverb is inaudible.
    this.wet2 = millibelToLinear(preset[PRESET_SLOT.level2]);
  }

  private readonly dampCoefficient: number;

  /** One frame in, one frame out. Feed it the send bus; add the result to the mix. */
  process(input: number): number {
    this.pre[this.preIndex] = input;
    const tap = (back: number) =>
      this.pre[(this.preIndex + this.pre.length - Math.min(back, this.pre.length - 1)) % this.pre.length];
    const delayed = tap(this.preDelay);

    let out = 0;
    for (const e of this.early) out += tap(e.delay) * e.gain;
    this.preIndex = (this.preIndex + 1) % this.pre.length;
    out *= this.wet1;

    // The late network: parallel damped feedback lines, summed with alternating
    // signs so their outputs do not pile up in phase.
    let late = 0;
    let sign = 1;
    for (const line of this.lines) {
      const value = line.buffer[line.index];
      line.damp = value * this.dampCoefficient + line.damp * (1 - this.dampCoefficient);
      line.buffer[line.index] = delayed + line.damp * line.gain;
      line.index = (line.index + 1) % line.buffer.length;
      late += value * sign;
      sign = -sign;
    }
    // ⚠️ Normalised by sqrt(N), not N. Dividing a parallel comb bank by the
    // number of lines buries the tail: the lines are decorrelated, so their sum
    // grows like sqrt(N), and dividing by N attenuates by that factor again.
    // With /N and the renderer's old extra 0.35 the reverb came out at about 2%
    // of the dry signal and was inaudible -- which is what the user heard.
    return out + (late / Math.sqrt(this.lines.length)) * this.wet2;
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
 * `ReverbSetting` → preset index, from the 8-entry remap at `v0x1062830`.
 *
 * The corpus only ever uses settings 1–5.
 */
export const REVERB_REMAP: readonly number[] = [3, 6, 8, 5, 11, 2, 0, 0];

/** The preset a `ReverbSetting` selects, or the first when it is out of range. */
export function reverbPreset(setting: number): readonly number[] {
  const index = REVERB_REMAP[setting] ?? REVERB_REMAP[0];
  return REVERB_PRESETS[index] ?? REVERB_PRESETS[0];
}
