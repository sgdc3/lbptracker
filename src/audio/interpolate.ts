/**
 * Resampling interpolators.
 *
 * This is the reason the project owns its mixer instead of using
 * `AudioBufferSourceNode.playbackRate`: the browser's own interpolator is
 * unspecified, differs between engines, and is not FMOD's. See
 * steering/tracker-architecture.md.
 *
 * ⚠️ **Which one FMOD Ex actually uses is still open.** `sinc8` is the default
 * because it adds least of its own character, not because it is known to match.
 * Everything here is behind one signature so swapping is a one-line change and
 * an A/B is trivial.
 */

/** The half-open loop region a voice is currently inside, if any. */
export interface LoopRegion {
  readonly start: number;
  /** Exclusive. */
  readonly end: number;
}

/**
 * Sample `data` at fractional position `position`.
 *
 * Implementations must return 0 outside the buffer rather than reading past
 * the end -- voices are allowed to run off the end of a sample and the mixer
 * relies on that being silent, not a crash.
 *
 * ⚠️ When `loop` is given the signal is **periodic** over that region and every
 * tap must be taken modulo it. Interpolating straight off the array instead
 * reads the frames that follow `loop.end` in the file -- which are not the
 * frames that follow it in the looped signal -- and puts a discontinuity at
 * every wrap. That is audible as a click, and worst on high notes, where the
 * loop is short and wraps tens of times a second.
 */
export type Interpolator = (
  data: Float32Array,
  position: number,
  loop?: LoopRegion,
) => number;

/** One tap, wrapped into the loop region when there is one. */
function tap(data: Float32Array, index: number, loop?: LoopRegion): number {
  if (loop) {
    const span = loop.end - loop.start;
    if (span > 0) {
      if (index >= loop.end || index < loop.start) {
        let wrapped = (index - loop.start) % span;
        if (wrapped < 0) wrapped += span;
        return data[loop.start + wrapped];
      }
    }
  }
  return index >= 0 && index < data.length ? data[index] : 0;
}

/** Nearest-neighbour. Aliases audibly; useful only as a reference point. */
export const nearest: Interpolator = (data, position, loop) => {
  const i = Math.round(position);
  if (!loop && (i < 0 || i >= data.length)) return 0;
  return tap(data, i, loop);
};

/** Linear. */
export const linear: Interpolator = (data, position, loop) => {
  if (!loop && (position < 0 || position >= data.length)) return 0;
  const i = Math.floor(position);
  const frac = position - i;
  const a = tap(data, i, loop);
  const b = tap(data, i + 1, loop);
  return a + (b - a) * frac;
};

/**
 * Catmull-Rom cubic. Smoother than linear and the usual "high quality" choice
 * in samplers; included so it can be compared by ear once there is something to
 * compare against.
 */
export const cubic: Interpolator = (data, position, loop) => {
  if (!loop && (position < 0 || position >= data.length)) return 0;
  const i = Math.floor(position);
  const frac = position - i;
  const at = (n: number) => tap(data, n, loop);
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

export const sinc8: Interpolator = (data, position, loop) => {
  if (!loop && (position < 0 || position >= data.length)) return 0;
  const centre = Math.floor(position);
  const frac = position - centre;

  let sum = 0;
  let weight = 0;
  for (let k = -SINC_TAPS + 1; k <= SINC_TAPS; k += 1) {
    const index = centre + k;
    if (!loop && (index < 0 || index >= data.length)) continue;
    const x = k - frac;
    let s: number;
    if (Math.abs(x) < 1e-9) {
      s = 1;
    } else {
      const px = Math.PI * x;
      s = Math.sin(px) / px;
    }
    const w = s * blackman(x, SINC_TAPS);
    sum += tap(data, index, loop) * w;
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
