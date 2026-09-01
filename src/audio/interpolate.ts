/**
 * Resampling interpolators.
 *
 * This is the reason the project owns its mixer instead of using
 * `AudioBufferSourceNode.playbackRate`: the browser's own interpolator is
 * unspecified, differs between engines, and is not FMOD's. See
 * steering/tracker-architecture.md.
 *
 * ⚠️ **Which one FMOD Ex actually uses is open question 7.** Until that is
 * measured, `linear` is the default because it is the most likely and the
 * cheapest, not because it is known to be right. Everything here is behind one
 * signature so swapping is a one-line change and an A/B is trivial.
 */

/**
 * Sample `data` at fractional position `position`.
 *
 * Implementations must return 0 outside the buffer rather than reading past
 * the end -- voices are allowed to run off the end of a sample and the mixer
 * relies on that being silent, not a crash.
 */
export type Interpolator = (data: Float32Array, position: number) => number;

/** Nearest-neighbour. Aliases audibly; useful only as a reference point. */
export const nearest: Interpolator = (data, position) => {
  const i = Math.round(position);
  return i >= 0 && i < data.length ? data[i] : 0;
};

/** Linear. The default. */
export const linear: Interpolator = (data, position) => {
  if (position < 0 || position >= data.length) return 0;
  const i = position | 0;
  const frac = position - i;
  const a = data[i];
  const b = i + 1 < data.length ? data[i + 1] : 0;
  return a + (b - a) * frac;
};

/**
 * Catmull-Rom cubic. Smoother than linear and the usual "high quality" choice
 * in samplers; included so it can be compared by ear once there is something to
 * compare against.
 */
export const cubic: Interpolator = (data, position) => {
  if (position < 0 || position >= data.length) return 0;
  const i = position | 0;
  const frac = position - i;
  const at = (n: number) => (n >= 0 && n < data.length ? data[n] : 0);
  const p0 = at(i - 1);
  const p1 = at(i);
  const p2 = at(i + 1);
  const p3 = at(i + 2);
  const a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
  const b = p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3;
  const c = -0.5 * p0 + 0.5 * p2;
  return ((a * frac + b) * frac + c) * frac + p1;
};

/**
 * Windowed-sinc, 8 taps either side, Blackman window.
 *
 * Point interpolators are not resamplers. Measured SNR against an analytic
 * sine, resampling a 22050 Hz source to 44100 Hz:
 *
 * | source Hz | nearest | linear | cubic | sinc8 |
 * |---|---|---|---|---|
 * | 440       | 27.1 dB | 57.1 dB | 107.8 dB | (see test/audio.test.ts) |
 * | 4000      |  8.0 dB | **19.0 dB** | 32.0 dB | |
 * | 8000      |  2.3 dB |  7.7 dB | 10.8 dB | |
 *
 * 19 dB at 4 kHz is a 16% amplitude error, and a piano's attack is full of
 * 2-8 kHz. That is audible as broadband grunge, and it is what the first
 * listening test heard.
 *
 * ⚠️ This being better does NOT make it right. The goal is to match FMOD Ex,
 * not to be clean -- if the game's own sampler interpolates crudely, that
 * roughness is part of the sound we are reproducing. Open question 7 decides;
 * it just stopped being cosmetic.
 */
const SINC_TAPS = 8;

function blackman(x: number, n: number): number {
  const t = (x + n) / (2 * n);
  return 0.42 - 0.5 * Math.cos(2 * Math.PI * t) + 0.08 * Math.cos(4 * Math.PI * t);
}

export const sinc8: Interpolator = (data, position) => {
  if (position < 0 || position >= data.length) return 0;
  const centre = Math.floor(position);
  const frac = position - centre;

  let sum = 0;
  let weight = 0;
  for (let k = -SINC_TAPS + 1; k <= SINC_TAPS; k += 1) {
    const index = centre + k;
    if (index < 0 || index >= data.length) continue;
    const x = k - frac;
    let s: number;
    if (Math.abs(x) < 1e-9) {
      s = 1;
    } else {
      const px = Math.PI * x;
      s = Math.sin(px) / px;
    }
    const w = s * blackman(x, SINC_TAPS);
    sum += data[index] * w;
    weight += w;
  }
  // Normalising keeps the DC gain at 1 even where the window is truncated by
  // the ends of the buffer, which otherwise dips the first and last few frames.
  return weight > 1e-9 ? sum / weight : 0;
};

export const INTERPOLATORS = { nearest, linear, cubic, sinc8 } as const;
export type InterpolatorName = keyof typeof INTERPOLATORS;

/**
 * ⚠️ Still a guess, but a better-founded one than `linear` was: it is the
 * option that adds least of its own character while open question 7 is open.
 */
export const DEFAULT_INTERPOLATOR: InterpolatorName = 'sinc8';
