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

export const INTERPOLATORS = { nearest, linear, cubic } as const;
export type InterpolatorName = keyof typeof INTERPOLATORS;

export const DEFAULT_INTERPOLATOR: InterpolatorName = 'linear';
