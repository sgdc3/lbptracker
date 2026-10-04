/**
 * Sound lost because the audio thread fell behind: the meter's red.
 *
 * ❌ **`currentFrame` never jumps in Chrome.** The detector this replaces
 * counted a dropout whenever the worklet's `currentFrame` advanced by more
 * than one quantum between two `process()` calls, and it counted none while a
 * spin in our own `process()` lost 282 and then 688 ms of every 5 s
 * (2026-10-04). Chrome renders every quantum, late; what the device could not
 * get in time it plays as silence, and from then on the context's audio plays
 * that much later.
 *
 * ❗ **So the sound lost is how far the output's audio clock has fallen behind
 * its wall clock**, and the page can read both at once:
 * `AudioContext.getOutputTimestamp()` gives the `contextTime` of the sample
 * leaving for the device and the `performanceTime` it leaves at. Their
 * difference held within about a millisecond over every 5 s of a load ramp up
 * to a reading of 90 %, and rose by 221–249 ms in the 4–5 s at 95–97 %.
 * Counted from it, three overloads came to 328, 290 and 361 ms where the
 * output lost 329, 290 and 361, with nothing counted anywhere else.
 *
 * ❌ **Not from inside the worklet.** Its only clock is `Date.now()`, and the
 * lag of `currentFrame` behind it moves with things that lose nothing: read at
 * the end of each quantum it rose whenever the load did (5 to 40 % read as a
 * dropout); read at the start of each burst it rose whenever a callback ran
 * late but still in time -- 39 ms "lost" after a jump in load where the output
 * lost 1.
 * The worklet cannot see the device's buffer; the output timestamp is the
 * device's own position.
 *
 * ⚠️ **Counted against what was counted, not against the last reading.** A
 * thread just past 100 % loses a little at a time, and a rule of "5 ms between
 * two readings" counted 135 of 243 ms, as 8 dropouts in 5 s (the worklet's
 * version); at 0.5 ms a reading it counts nothing (`test/dropouts.test.ts`).
 * Rises add up until they reach `STEP_MS` and are then counted whole. The two clocks also
 * drift apart steadily -- about 200 ppm on the machine measured, 1 ms in 5 s --
 * so a change too small to count is followed at `CREEP_PER_MS` at most, up or
 * down.
 */

/** A rise of the lag this big over what was counted is sound lost. */
const STEP_MS = 5;
/** How fast the counted lag follows a change too small to count, either way: 500 ppm. */
const CREEP_PER_MS = 0.0005;
/**
 * Losses closer together than this are one dropout. A slow loss is counted
 * `STEP_MS` at a time: at 5 ms a second, one second apart, and a second here
 * made seven dropouts of one.
 */
const EPISODE_MS = 3000;
/**
 * Readings ignored after a reset, as a precaution: nothing says the timestamp
 * is fresh before the first device callback after `resume()`, and a pause
 * is no loss.
 */
const SETTLE = 2;

export interface DropoutReading {
  /** Losses that began at this reading: losses less than `EPISODE_MS` apart are one. */
  readonly dropouts: number;
  /** Milliseconds of sound lost since the last reading. */
  readonly lostMs: number;
}

const NONE: DropoutReading = { dropouts: 0, lostMs: 0 };

export class DropoutCounter {
  /** The lag loss has been counted up to, and the wall clock when it was. */
  private counted: number | null = null;
  private countedAt = 0;
  private lastLoss = -Infinity;
  private settle = SETTLE;

  /**
   * One reading of `getOutputTimestamp()`: the wall time in milliseconds
   * (`performanceTime`) and the audio time in seconds (`contextTime`) of the
   * same sample. A context that has not output anything yet reads zeros, and
   * is skipped.
   */
  observe(performanceTime: number, contextTime: number): DropoutReading {
    if (!(performanceTime > 0) || !(contextTime > 0)) return NONE;
    if (this.settle > 0) {
      this.settle -= 1;
      return NONE;
    }
    const lag = performanceTime - contextTime * 1000;
    if (this.counted === null) {
      this.counted = lag;
      this.countedAt = performanceTime;
      return NONE;
    }
    const elapsed = Math.max(0, performanceTime - this.countedAt);
    this.countedAt = performanceTime;
    const rise = lag - this.counted;
    if (rise >= STEP_MS) {
      this.counted = lag;
      const began = performanceTime - this.lastLoss > EPISODE_MS;
      this.lastLoss = performanceTime;
      return { dropouts: began ? 1 : 0, lostMs: rise };
    }
    // Either way at the drift's pace, not at once: followed down at once, every
    // wobble low became the start of the next step, and about 240 ms lost
    // counted as 259.
    const creep = elapsed * CREEP_PER_MS;
    this.counted += Math.max(-creep, Math.min(rise, creep));
    return NONE;
  }

  /** Forget the clocks: every start, since a pause moves them apart and loses nothing. */
  reset(): void {
    this.counted = null;
    this.countedAt = 0;
    this.lastLoss = -Infinity;
    this.settle = SETTLE;
  }
}
