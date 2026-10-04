/**
 * How much of the audio thread's time the mixer takes: the "audio %" figure.
 *
 * ❗ **The only clock the audio thread has is `Date.now()`, and it ticks once
 * a millisecond.** Measured in Chrome, 2026-10-04: in an
 * AudioWorkletGlobalScope `performance` is undefined, `Event.timeStamp` is
 * always 0, there is no `SharedArrayBuffer` (the page is not cross-origin
 * isolated), and the context has neither `renderCapacity` nor `playoutStats`.
 *
 * ⚠️ **A millisecond clock is unbiased only if the work starts at a random
 * point inside the millisecond, and here it does not.** Chrome renders in
 * bursts: three or four 128-frame quanta back to back, once per device
 * callback, and the callback comes every **10 ms exactly** (167 of 198 periods
 * measured, the rest 9 or 11). So the burst starts at nearly the same point of
 * the millisecond every time, a sub-millisecond burst reads 0 or 1 depending on
 * that point alone, and the point drifts over tens of seconds. Measured with a
 * constant load in one context, 2 s windows: **0.3–1.15 % for 30 s, then
 * 2–3.4 %** — the old meter, which summed `Date.now()` around each `process()`,
 * could sit five times under the truth for half a minute.
 *
 * ❗ **The cure is to make the start random, which costs a little time.** About
 * one burst in `every` waits a random fraction of a millisecond (`wait`, a
 * calibrated spin) before its start is read; the burst's reading is then an
 * unbiased sample of its length. The samples' mean, against the plain mean of
 * the same bursts, is the clock's bias per burst, and the figure is the plain
 * sum with that bias taken out. The wait averages half a millisecond per
 * sample, ~0.5 % of a core at one burst in ten. It is switched off above
 * `DITHER_OFF`, where a burst is several milliseconds long, the clock's error is
 * small beside it, and a millisecond's wait would eat into the time left
 * before a dropout.
 *
 * Everything is measured per burst, from the start of its first quantum to the
 * end of its last, so the other nodes of the graph that run between our quanta
 * are counted too (0.2–0.6 points, measured).
 *
 * ❗ **The plain sum is the figure; the samples only correct it.** Past 100 %
 * the thread never rests, no gap ever closes a burst, and no sample comes. A
 * meter that counted a burst only when it closed, and took the samples' mean
 * as the load, read **28 % and then 8 %** while 282 and then 688 ms of every
 * 5 s went missing -- then 78 % once the load was gone, when the one burst of
 * several seconds finally closed (2026-10-04, a spin added to our own
 * `process()`). Each report now takes the open burst's time so far, and a burst
 * longer than `LONG_MS` -- callbacks run together -- is left out of the
 * correction, where its one burst's worth of bias is nothing beside its length.
 *
 * ⚠️ **There is no peak.** The worst callback over its period was a bound
 * (under 30 %) at ordinary loads, where the clock cannot resolve a callback,
 * and read 100 % at a 57 % average with nothing lost, because two callbacks
 * less than two ticks apart are one burst to this clock. Sound actually lost is
 * what `DropoutCounter` measures, and that is the warning that means something.
 */

/** A gap this long between two `process()` calls means a new device callback. */
const BURST_GAP_MS = 2;
/** A burst longer than one callback's period is callbacks run together. */
const LONG_MS = 12;
/** Dithered samples needed before their mean is trusted to correct the plain sum. */
const MIN_SAMPLES = 5;
/** Above this load the dither is switched off; below `DITHER_ON` it comes back. */
const DITHER_OFF = 0.6;
const DITHER_ON = 0.5;

export interface LoadMeterOptions {
  /** On average one burst in this many is a dithered sample. */
  readonly every?: number;
  /** The averaging horizon, in seconds. */
  readonly horizon?: number;
}

export class LoadMeter {
  private readonly clock: () => number;
  private readonly random: () => number;
  private readonly wait: (fraction: number) => void;
  private readonly every: number;
  private readonly horizonMs: number;

  private lastEnd = -1;
  private burstStart = 0;
  /** How much of the open burst a report has already counted. */
  private counted = 0;
  private sampling = false;
  private dithering = true;
  /** Whether anything is playing: no dither is spent on silence. */
  private active = false;

  // This report window's raw sums.
  private windowStart = -1;
  private windowBusy = 0;
  private windowShort = 0;
  private windowShortBusy = 0;
  private windowSamples = 0;
  private windowSampleSum = 0;

  // The decayed sums over the horizon: the plain busy time, the short bursts
  // closed and their plain spans, and the dithered samples among them.
  private wall = 0;
  private busy = 0;
  private short = 0;
  private shortBusy = 0;
  private samples = 0;
  private sampleSum = 0;
  private last: number | null = null;

  /**
   * @param clock the clock, in whole milliseconds (`Date.now`)
   * @param random uniform in [0, 1) (`Math.random`)
   * @param wait busy-wait for about this fraction of a millisecond
   */
  constructor(
    clock: () => number,
    random: () => number,
    wait: (fraction: number) => void,
    options: LoadMeterOptions = {},
  ) {
    this.clock = clock;
    this.random = random;
    this.wait = wait;
    // Ten samples a second, averaged over five: a sample says 0 or 1 ms of a
    // 0.3 ms burst, so it takes fifty of them to put the mean within about
    // two thirds of a point, and the waits cost ~0.5 % of a core.
    this.every = options.every ?? 10;
    this.horizonMs = (options.horizon ?? 5) * 1000;
  }

  /** Whether there is anything to measure; set from the voice count. */
  setActive(active: boolean): void {
    this.active = active;
  }

  /** At the top of `process()`. */
  begin(): void {
    const now = this.clock();
    if (this.lastEnd >= 0 && now - this.lastEnd < BURST_GAP_MS) return;
    if (this.lastEnd >= 0) this.closeBurst();
    this.burstStart = now;
    // ⚠️ **Chosen at random, not every n-th.** Chrome's callbacks come in a
    // cycle of four -- 4, 4, 4 and 3 quanta, 1,920 frames being 15 of them --
    // and "every 16th" landed on the 3-quantum one every time, which read
    // 80 % of the load. Any fixed stride can alias with some cycle; a coin
    // cannot.
    if (this.active && this.dithering && this.random() * this.every < 1) {
      this.wait(this.random());
      // Read after the wait: the burst's own start, at a random point of the
      // millisecond, and its span no longer includes the wait.
      this.burstStart = this.clock();
      this.sampling = true;
    }
  }

  /** At the bottom of `process()`. */
  end(): void {
    this.lastEnd = this.clock();
  }

  private closeBurst(): void {
    const span = this.lastEnd - this.burstStart;
    this.windowBusy += span - this.counted;
    this.counted = 0;
    if (span <= LONG_MS) {
      this.windowShort += 1;
      this.windowShortBusy += span;
      if (this.sampling) {
        this.windowSamples += 1;
        this.windowSampleSum += span;
      }
    }
    this.sampling = false;
  }

  /**
   * Fold the window into the horizon and say what it comes to: the share of
   * wall time the audio thread spent rendering, 0..1, or null before there is
   * a window to say it of. Called right after an `end()`.
   */
  report(): number | null {
    const now = this.clock();
    if (this.windowStart < 0) {
      this.windowStart = now;
      return this.last;
    }
    const elapsed = now - this.windowStart;
    if (elapsed <= 0) return this.last;
    this.windowStart = now;
    // The burst still open, so far: under overload it is the only one there is.
    if (this.lastEnd >= 0) {
      const open = this.lastEnd - this.burstStart;
      this.windowBusy += open - this.counted;
      this.counted = open;
    }
    const keep = Math.exp(-elapsed / this.horizonMs);
    this.wall = this.wall * keep + elapsed;
    this.busy = this.busy * keep + this.windowBusy;
    this.short = this.short * keep + this.windowShort;
    this.shortBusy = this.shortBusy * keep + this.windowShortBusy;
    this.samples = this.samples * keep + this.windowSamples;
    this.sampleSum = this.sampleSum * keep + this.windowSampleSum;
    this.windowBusy = 0;
    this.windowShort = 0;
    this.windowShortBusy = 0;
    this.windowSamples = 0;
    this.windowSampleSum = 0;

    const plain = this.busy / this.wall;
    let load = plain;
    if (this.dithering && this.samples >= MIN_SAMPLES && this.short > 0) {
      // Per short burst: what the samples say it lasted, less what the plain
      // reading said.
      const bias = this.sampleSum / this.samples - this.shortBusy / this.short;
      load = plain + (bias * this.short) / this.wall;
    }
    load = Math.min(1, Math.max(0, load));
    if (this.dithering && load > DITHER_OFF) this.dithering = false;
    else if (!this.dithering && plain < DITHER_ON) this.dithering = true;
    this.last = load;
    return load;
  }

  /** Forget everything: a new start. */
  reset(): void {
    this.lastEnd = -1;
    this.counted = 0;
    this.sampling = false;
    this.windowStart = -1;
    this.windowBusy = 0;
    this.windowShort = 0;
    this.windowShortBusy = 0;
    this.windowSamples = 0;
    this.windowSampleSum = 0;
    this.wall = 0;
    this.busy = 0;
    this.short = 0;
    this.shortBusy = 0;
    this.samples = 0;
    this.sampleSum = 0;
    this.dithering = true;
    this.last = null;
  }
}

/** Waits between recalibrations: about six seconds at ten samples a second. */
const RECALIBRATE = 64;

/**
 * The dither's wait: a spin of a calibrated number of iterations.
 *
 * ⚠️ **Calibrated against the same clock, from one tick to the next**, and
 * again every `RECALIBRATE` waits, because the speed of a spin follows the
 * CPU's clock and the JIT: the first calibration runs in the interpreter. A
 * recalibration ends exactly on a tick, and the random spin that follows it
 * still lands anywhere in the millisecond, so that sample stays a fair one.
 * The loop body is the calibration's own -- a `Date.now()` and an add -- so the
 * two run at the same speed.
 */
export class Spinner {
  private readonly clock: () => number;
  private perMs = 0;
  private calls = 0;
  /** Kept so the loop cannot be optimised away. */
  sink = 0;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
    this.calibrate();
    this.calibrate();
  }

  private calibrate(): void {
    const first = this.clock();
    while (this.clock() === first) this.sink += 1;
    const edge = this.clock();
    let n = 0;
    while (this.clock() === edge) n += 1;
    this.perMs = n;
  }

  readonly wait = (fraction: number): void => {
    this.calls += 1;
    if (this.calls === 2 || this.calls % RECALIBRATE === 0) this.calibrate();
    const n = Math.floor(fraction * this.perMs);
    let sink = 0;
    for (let i = 0; i < n; i += 1) sink += this.clock() & 1;
    this.sink += sink;
  };
}
