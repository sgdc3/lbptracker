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
  /** The delay actually used, in seconds. Handy for reporting. */
  readonly seconds: number;

  /**
   * @param echoTime the sequencer's field.
   * @param framesPerStep the sequencer's step length in output frames.
   *
   * **The unit is measured.** `v0x1c5d32` stores `EchoTime * 0.5` into the audio
   * state at `[state+0x1a30]`, and `fmodextinput.prx` `0x0faa` turns that into a
   * delay:
   *
   * ```
   * eax = (int)(stored * 16 + 0.5)       ; round to a whole number of steps
   * ecx = (int)(720000 / tempo)          ; frames in one step
   * ecx = ecx * eax
   * ecx = ecx & ~0xf                     ; aligned down to 16 frames
   * ```
   *
   * `stored * 16` is `EchoTime * 8`, so the delay is **`round(EchoTime * 8)`
   * steps** -- eight steps, two beats, per unit of the field.
   *
   * The corpus agrees and is worth keeping as the sanity check: `EchoTime` is
   * 2.00 on 189 of 338 sequencers, which is 16 steps, **a whole bar**; 1.00 on
   * 95 (half a bar); 1.50 on 47. Those are bar-relative delays, which is what a
   * musician would set.
   *
   * WARNING: an earlier reading called the field **beats**, which made every
   * echo four times too fast.
   */
  constructor(
    sampleRate: number,
    echoTime: number,
    framesPerStep: number,
    feedback: number,
    mix: number,
  ) {
    const steps = Math.max(0, Math.trunc(Math.max(echoTime, 0) * 0.5 * 16 + 0.5));
    // `& ~0xf` in the engine: the delay is aligned down to a multiple of 16
    // frames, which is its block granularity.
    const size = Math.max(1, Math.trunc(steps * framesPerStep) & ~0xf);
    this.seconds = size / sampleRate;
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
  /**
   * The **notch frequency in hertz** — not a pre-delay, which is what this said.
   * `v0x3fce8e` divides it by 48,000 and clamps to `[0.0004, 0.49]`, and
   * `v0x3fcefb`-`v0x3fcf9f` turns that into a two-pole resonator whose output is
   * subtracted from the signal. The presets use 20, 100 and 400 — highpass
   * corners, which is what a reverb puts there.
   */
  notchHz: 8,
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
 * How many of a tap row's ten lengths a preset actually uses.
 *
 * The table at `v0xe1d5d0` is **eleven** floats per row, not ten: the first is a
 * count and the other ten are the lengths in milliseconds. `v0x3fc8c0` reads it
 * as `vcvttss2si r9, [row]`, and `fmodsmsreverb.prx` `0x0c52` does the same
 * against its own copy of the table at `v0x2750`.
 */
export const REVERB_TAP_COUNTS: readonly number[] = [
  10, 8, 10, 10, 10, 10, 10, 9, 10, 10, 10, 10, 10, 10, 10, 9, 9, 10, 10,
];

/**
 * The two delay ratios the allpass pair is built from, at `v0x2c08`.
 *
 * Exactly two floats. `fmodsmsreverb.prx` `0x10d6` indexes this table by the
 * allpass index and multiplies the base delay by it, which is why the eboot's
 * sizer allocates `idx1`, `idx2`, `0.93 * idx1` and `1.06 * idx2`.
 */
export const REVERB_ALLPASS_RATIOS: readonly number[] = [0.93, 1.06];

/**
 * The game's reverb.
 *
 * ## The topology, read from the code that builds it
 *
 * `fmodsmsreverb.prx` builds stage arrays of `0x50` = 80 bytes each, and the
 * counts are not guesses:
 *
 * - **`[state+0x514] = 2`**, a literal immediate at `0x0c39`.
 * - **`[state+0x510] = (int)tapRow[0] - 2`** at `0x0c52`-`0x0c5d`: the row's
 *   count float, minus two. A ten-tap row gives **8**.
 *
 * The loop bounded by `0x510` builds the **combs** from lengths `idx3..idx(n)`.
 *
 * ⚠️ **What the `0x514` loops build is NOT an allpass cascade.** This file said
 * so for several revisions and it was wrong at every level: there is no
 * Schroeder allpass in the reverb, no cascade, and therefore no allpass
 * coefficient. The kernel those stages run (`0x1850`) computes a two-pole
 * resonator and **subtracts** it from the signal, which is a notch — see the
 * `notch` field. `REVERB_ALLPASS_RATIOS` keeps its measured values because the
 * eboot's sizer really does allocate `0.93 * idx1` and `1.06 * idx2`, but what
 * those buffers are for is no longer claimed.
 *
 * Combs run in parallel and sum -- `dampedComb` carries `acc[i] += x[i]`, and a
 * series chain has nothing to accumulate.
 *
 * ## The coefficients, read from the code that writes them
 *
 * Every stage record -- comb and allpass alike -- gets the same three fields,
 * and the kernel's `[base+0x44]`/`[+0x48]`/`[+0x4c]` are those fields (the comb
 * records sit at `state+0x300` and the kernel's base is `state+0x2c0`, so
 * `0x2c0+0x44 = 0x304`, the record's `+0x04`):
 *
 * | field | value | where |
 * |---|---|---|
 * | `+0x04` = `b` | `1 - a` | `0x0bd1` |
 * | `+0x08` = `a` | `expf(state[+0x2c])`, derived from slot 10 | `0x0bbb` |
 * | `+0x0c` = gain | `powf(10, -0.003 * ms / RT60)` | `0x0ffa`-`0x100f` |
 *
 * With damping disabled (`state[+0x24]` zero) `0x0bdd` stores `b = 1, a = 0` as
 * one qword. `b = 1 - a` is a one-pole with **unity DC gain**, which is the form
 * used here.
 *
 * WARNING: **there is no separate allpass coefficient.** A previous revision
 * used Schroeder's conventional 0.5. The allpass records get the identical gain
 * law as the combs, on their own delays -- so an allpass whose delay is
 * `0.93 * idx1` has `g = 10^(-0.003 * 0.93 * idx1 / RT60)`. Nothing in the
 * module holds a constant allpass gain.
 *
 * RT60 is `slot5 * 0.1` seconds, confirmed from the writing side at `0x0c9d`
 * (`[rsi+0x38] * 0.1`).
 *
 * ## What is still ours
 *
 * One thing, flagged at its line: the `1 - gain` normalisation on each comb's
 * contribution. Without it the bank is about nine times unity at DC and the
 * preset's own wet level stops meaning anything. Also unread: whether the DSP
 * emits the accumulator or the last stage's output.
 *
 * The early reflections and the millibel levels are unchanged and are the
 * engine's: `REVERB_EARLY_SETS` (`v0xe1d920`, slot 4), the levels through
 * `millibelToLinear`, and the pre-delay in samples from slot 8.
 */
export class Reverb {
  private readonly pre: Float32Array;
  private readonly preDelay: number;
  private preIndex = 0;
  /** The parallel bank: `tapCount - 2` damped feedback combs whose outputs sum. */
  private readonly combs: {
    buffer: Float32Array;
    index: number;
    y: number;
    gain: number;
  }[] = [];
  /**
   * The two-pole notch the comb bank feeds.
   *
   * **This replaced an invented Schroeder allpass cascade that had no basis in
   * the code.** The kernel is `fmodsmsreverb.prx` `0x1850`:
   *
   * ```
   * y      = a*prev + b*x + c*older
   * buf[i] = x - y                     ; in place
   * ```
   *
   * with the coefficients read from `[rec+0x30]`, `[rec+0x34]`, `[rec+0x38]` at
   * `0x1828`-`0x1832` and the state at `+0x20`/`+0x24`. The eboot builds all
   * three from one number at `v0x3fcefb`-`v0x3fcf9f`:
   *
   * ```
   * r = exp(-10*PI*f)
   * a = 2 * r * cos(2*PI*f)     ; -> +0x34, the `prev` coefficient
   * c = -r*r                    ; -> +0x38, via a sign-flip mask
   * b = r*r + 1 - a             ; -> +0x30, the input coefficient
   * ```
   *
   * `a = 2r cos(w)` with `c = -r²` is a resonator, and subtracting a resonator
   * from the signal is a **notch**. At the presets' 20 Hz that is a rumble
   * filter; the preset that uses 400 Hz gets an audible highpass.
   */
  private readonly notch: { a: number; b: number; c: number };
  private notchPrev = 0;
  private notchOlder = 0;
  private readonly early: { delay: number; gain: number }[] = [];
  /** `b` of the shared one-pole; `a` is `1 - b`. */
  private readonly damp: number;
  private readonly wet1: number;
  private readonly wet2: number;

  /**
   * Whether each comb's contribution is scaled by `1 - gain`.
   *
   * WARNING: this factor is OURS and it is the only unmeasured thing left in
   * the reverb. A feedback comb has DC gain `1/(1 - gain)`, so eight of them
   * summed are about nine times unity; scaling each contribution makes it
   * unity at DC. But on the presets in use the gains run near 0.87, so
   * `1 - gain` is about **0.13** -- an 18 dB attenuation invented to solve a
   * problem the engine solves some other way. A listener reported the reverb
   * as imperceptible, and this is the one place a whole reverb could go.
   *
   * **Off by default now**, and the reason is that the compensation it was
   * compensating for turned out to be a bug of ours. The send reaching the
   * reverb was `PInstrument.reverbSend` alone; the engine multiplies that by the
   * instrument's `Params[25]` (`0x3d38`-`0x3d50`), which on this corpus makes
   * the send **47.8x smaller** on average. With the send too large by that much,
   * the wet path had to be held down, and this factor was doing it.
   *
   * With the send measured, turning this off lands the reverb at 42.4% of the
   * dry mix -- inside the range a listener bracketed by ear -- and leaves the
   * allpass coefficient as the only invented number in the reverb.
   */
  private readonly normaliseCombs: boolean;

  constructor(sampleRate: number, preset: readonly number[], normaliseCombs = true) {
    this.normaliseCombs = normaliseCombs;
    const ms = (v: number) => Math.max(1, Math.round((v / 1000) * sampleRate));
    const row = preset[PRESET_SLOT.tapSet];
    const taps = REVERB_TAP_SETS[row] ?? REVERB_TAP_SETS[0];
    const count = REVERB_TAP_COUNTS[row] ?? taps.length;
    const early = REVERB_EARLY_SETS[preset[PRESET_SLOT.earlySet]] ?? REVERB_EARLY_SETS[0];

    const longest = Math.max(...early.slice(0, 3));
    this.pre = new Float32Array(Math.max(1, ms(longest) + 1));
    // WARNING: there is no pre-delay. Slot 8 was read as one, in samples, and
    // it is the notch frequency in hertz. Nothing measured takes its place, so
    // the late field starts from the input rather than after a delay.
    this.preDelay = 0;

    const f = Math.min(0.49, Math.max(0.0004, preset[PRESET_SLOT.notchHz] / 48000));
    const r = Math.exp(-10 * Math.PI * f);
    const rr = Math.exp(-20 * Math.PI * f);
    const a = 2 * r * Math.cos(2 * Math.PI * f);
    this.notch = { a, b: rr + 1 - a, c: -rr };

    // WARNING: the early row's middle three floats run -80..+100 and are NOT
    // levels -- reading them as decibels gives a gain of 100,000. The last
    // three are 0..1 and behave like gains.
    for (let i = 0; i < 3; i += 1) {
      this.early.push({ delay: ms(early[i]), gain: early[6 + i] });
    }

    const hf = Math.min(Math.max(preset[PRESET_SLOT.hf], 500), sampleRate / 2 - 1);
    this.damp = 1 - Math.exp((-2 * Math.PI * hf) / sampleRate);

    // `powf(10, -0.003 * ms / RT60)`, with the delay in **milliseconds** and
    // RT60 = slot5 / 10 seconds. Both halves read straight off the writing code.
    const rt60 = Math.max(0.05, preset[PRESET_SLOT.decay] / 10);
    const gainFor = (lengthMs: number) => 10 ** ((-0.003 * lengthMs) / rt60);

    // The combs are lengths idx3..idx(count) -- indices 2..count-1 here, since
    // these rows already have the count float stripped off the front.
    for (let i = 2; i < Math.min(count, taps.length); i += 1) {
      this.combs.push({
        buffer: new Float32Array(ms(taps[i])),
        index: 0,
        y: 0,
        gain: gainFor(taps[i]),
      });
    }

    // The allpasses: idx1 and idx2 straight, then the same two scaled. Build
    // order is the loop order -- both `0x514` loops run 0 then 1.
    // The allpass cascade that used to be built here is gone: see `notch`.

    this.wet1 = millibelToLinear(preset[PRESET_SLOT.level1]);
    this.wet2 = millibelToLinear(preset[PRESET_SLOT.level2]);
  }

  /** One frame in, one frame out. Feed it the send bus; add the result to the mix. */
  process(input: number): number {
    this.pre[this.preIndex] = input;
    const tap = (back: number) =>
      this.pre[
        (this.preIndex + this.pre.length - Math.min(back, this.pre.length - 1)) % this.pre.length
      ];

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
      // WARNING: `1 - gain` is OURS. A feedback comb has DC gain
      // `1/(1 - gain)`, so eight of them summed are about nine times unity, and
      // the preset's own wet level -- the part that is measured -- stops meaning
      // anything. Scaling each comb's *contribution* makes it unity at DC and
      // leaves its decay untouched, unlike scaling the recirculation.
      // ⚠️ OURS, and the last invented number in the reverb. A feedback comb has
      // DC gain `1/(1 - gain)`; normalising by `1 - gain` makes it unity in
      // **amplitude**, and by `sqrt(1 - gain)` unity in **power**. For a bank of
      // decaying resonators summing incoherently, power is the apt one -- and it
      // is what lands the wet level inside the range a listener brackets by ear:
      // amplitude normalisation gives 8.0% of the dry mix and none at all gives
      // 57.9%, reported as too little and too much respectively.
      //
      // The engine's own scaling is still unfound: the PRX never reads the three
      // level fields at `[state+0x48]`, `[+0x4c]`, `[+0x50]`, so the eboot mixes
      // the wet in somewhere this project has not located.
      wet += (this.normaliseCombs ? Math.sqrt(1 - comb.gain) : 1) * comb.y;
    }
    // WARNING: there is no `/ sqrt(N)` here any more, and its removal is the
    // reverb's level.
    //
    // It was here on the assumption that mutually incoherent taps add in power.
    // That is a reasonable thing to believe and it was never measured, and with
    // each comb already normalised to unity at DC it made the bank 2.83x rather
    // than 8x -- which put the wet signal at 22% of the dry, reported as far too
    // little. Dropping it leaves the one normalisation that has a stated reason
    // (`1 - gain`, so a comb is unity at DC) and lands the wet level inside the
    // range a listener bracketed by ear.
    //
    // Two invented factors were stacked here and the fix was to remove one, not
    // to add a third.

    // The notch, `out = x - resonator(x)`, exactly as at 0x1850.
    const { a, b, c } = this.notch;
    const y = a * this.notchPrev + b * wet + c * this.notchOlder;
    this.notchOlder = this.notchPrev;
    this.notchPrev = y;
    wet -= y;

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
