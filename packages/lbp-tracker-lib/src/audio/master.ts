/**
 * A master bus: a glue compressor and a brickwall limiter, **ours, not the
 * game's**.
 *
 * ❗ **Nothing in LBP does this.** The sequencer's own output stage is the
 * plugin's hard clip, `SMS Reverb` and `SMS WaveHammer`, and all three are
 * modelled elsewhere (`compressor.ts`, `effects.ts`,
 * steering/lbp-audio-engine.md). This runs *after* all of that, past the
 * stereo fold, where nothing of the game's is left to be faithful to: it is
 * the last thing before the speakers and it exists because a composer asked
 * for a mix that holds together, not because the PS4 does it. It is off unless
 * switched on, and switching it on is a deliberate deviation -- see
 * steering/open-questions.md.
 *
 * The two stages:
 *
 *   1. **Glue.** A peak detector on `max(|l|, |r|)` drives a soft-knee
 *      compressor at 2.5:1. `amount` moves the threshold from -6 dBFS down to
 *      -22 dBFS and adds the makeup that the ratio takes back out, so turning
 *      it up squeezes the mix rather than just making it quieter.
 *   2. **Limiter.** A lookahead peak limiter with a hard ceiling. The signal is
 *      delayed by the lookahead while the gain is computed on what is coming,
 *      so the gain is already down when the peak arrives and nothing is
 *      clipped flat.
 *
 * ⚠️ **The gain applied to a sample is the smallest the lookahead window asks
 * for, not the newest.** Taking the newest and letting it release upwards is
 * the obvious way to write this and it is wrong: the peak is still inside the
 * delay line while the gain climbs back, so it comes out over the ceiling --
 * measured at +0.19 dB before this was a sliding minimum. A monotonic deque
 * keeps that minimum in constant time.
 *
 * ⚠️ And the gain may only ever fall at once and rise slowly. A release that
 * also applies downwards turns every transient into a click.
 */

/** Decibels to a linear gain. */
const dbToGain = (db: number): number => 10 ** (db / 20);

export interface MasterSettings {
  /** 0..10, the UI's one knob: how much glue. 0 is the compressor bypassed. */
  readonly amount: number;
  /** The limiter's hard ceiling in dBFS. Nothing leaves above it. */
  readonly ceilingDb: number;
}

export const MASTER_DEFAULTS: MasterSettings = { amount: 4, ceilingDb: -0.3 };

/** The compressor's fixed shape: the knob moves the threshold, not these. */
const RATIO = 2.5;
const KNEE_DB = 6;
const ATTACK_MS = 10;
const RELEASE_MS = 150;
/** How far the threshold travels across the knob's range. */
const THRESHOLD_TOP_DB = -6;
const THRESHOLD_SPAN_DB = 16;
/**
 * The level the makeup is worked out at.
 *
 * ⚠️ **Not 0 dBFS.** Taking back what the ratio removes *at full scale* assumes
 * the mix already peaks there; a real one does not, and the makeup then adds
 * more than the compressor took. Measured on `Ascetic` with the knob at 4:
 * against full scale the peaks went 0.52 to 0.97, +5.4 dB, with the limiter
 * holding the ceiling flat through the loud bars. -6 dBFS is where a mix that
 * has been through the game's own output stage actually sits.
 */
const MAKEUP_REFERENCE_DB = -6;
/** The limiter. 2 ms of lookahead is 96 frames at 48 kHz. */
const LOOKAHEAD_MS = 2;
const LIMIT_RELEASE_MS = 80;

export class MasterBus {
  private readonly rate: number;
  private thresholdDb = THRESHOLD_TOP_DB;
  private makeup = 1;
  private attack = 0;
  private release = 0;
  private limitRelease = 0;
  /** The compressor's smoothed gain reduction, as a linear gain. */
  private env = 1;
  /** The limiter's gain, which falls at once and recovers slowly. */
  private limitGain = 1;
  /** The last `lookahead` target gains, and a deque of their indices, smallest first. */
  private targets: Float32Array;
  private deque: Int32Array;
  private head = 0;
  private tail = 0;
  private frame = 0;
  private ceiling = dbToGain(MASTER_DEFAULTS.ceilingDb);
  /** The lookahead delay lines, and where the next sample goes. */
  private delayL: Float32Array;
  private delayR: Float32Array;
  private at = 0;
  private readonly lookahead: number;

  constructor(sampleRate: number, settings: MasterSettings = MASTER_DEFAULTS) {
    this.rate = sampleRate;
    this.lookahead = Math.max(1, Math.round((LOOKAHEAD_MS / 1000) * sampleRate));
    this.delayL = new Float32Array(this.lookahead);
    this.delayR = new Float32Array(this.lookahead);
    // ⚠️ `lookahead + 1` entries, not `lookahead`: the window has to include the
    // frame that is leaving the delay line this very sample, or its own peak is
    // the one thing the minimum never sees.
    this.targets = new Float32Array(this.lookahead + 1);
    this.targets.fill(1);
    this.deque = new Int32Array(this.lookahead + 2);
    this.attack = Math.exp(-1 / ((ATTACK_MS / 1000) * sampleRate));
    this.release = Math.exp(-1 / ((RELEASE_MS / 1000) * sampleRate));
    this.limitRelease = Math.exp(-1 / ((LIMIT_RELEASE_MS / 1000) * sampleRate));
    this.set(settings);
  }

  set(settings: MasterSettings): void {
    const amount = Math.max(0, Math.min(10, settings.amount));
    this.thresholdDb = THRESHOLD_TOP_DB - (amount / 10) * THRESHOLD_SPAN_DB;
    // What the ratio takes off a signal sitting at the reference, so a mix
    // comes back to about the level it went in at rather than well above it.
    const removed = Math.max(0, MAKEUP_REFERENCE_DB - this.thresholdDb) * (1 - 1 / RATIO);
    this.makeup = dbToGain(removed);
    this.ceiling = dbToGain(settings.ceilingDb);
    if (amount === 0) this.makeup = 1;
  }

  reset(): void {
    this.env = 1;
    this.limitGain = 1;
    this.at = 0;
    this.frame = 0;
    this.head = 0;
    this.tail = 0;
    this.delayL.fill(0);
    this.delayR.fill(0);
    this.targets.fill(1);
  }

  /**
   * The smallest target gain in the lookahead window, kept in constant time.
   *
   * The deque holds frame numbers whose targets rise from front to back, so
   * the front is always the window's minimum: anything behind a smaller,
   * newer value can never be the answer again and is dropped as it arrives.
   */
  private windowMin(target: number): number {
    const size = this.lookahead + 1;
    const ring = this.deque.length;
    this.targets[this.frame % size] = target;
    while (this.tail > this.head
      && this.targets[this.deque[(this.tail - 1) % ring] % size] >= target) this.tail -= 1;
    this.deque[this.tail % ring] = this.frame;
    this.tail += 1;
    // Frames older than the window are behind the sample now leaving the delay.
    while (this.deque[this.head % ring] < this.frame - this.lookahead) this.head += 1;
    const min = this.targets[this.deque[this.head % ring] % size];
    this.frame += 1;
    return min;
  }

  /** The gain the compressor asks for at this input level, as a linear gain. */
  private compressorGain(peak: number): number {
    if (peak <= 0) return 1;
    const db = 20 * Math.log10(peak);
    const over = db - this.thresholdDb;
    if (over <= -KNEE_DB / 2) return 1;
    // A quadratic knee: the ratio comes in over KNEE_DB rather than at a corner.
    const reduction = over >= KNEE_DB / 2
      ? over - over / RATIO
      : ((1 - 1 / RATIO) * (over + KNEE_DB / 2) ** 2) / (2 * KNEE_DB);
    return dbToGain(-reduction);
  }

  /**
   * One frame in, one frame out -- **delayed by the lookahead**, which is what
   * lets the limiter see a peak before it plays it.
   */
  process(left: number, right: number): { left: number; right: number } {
    // --- the glue, on the signal as it arrives
    const peak = Math.max(Math.abs(left), Math.abs(right));
    const want = this.compressorGain(peak);
    // Falling gain uses the attack, rising uses the release: a compressor
    // clamps down quickly and lets go slowly, not the other way about.
    const coeff = want < this.env ? this.attack : this.release;
    this.env = want + (this.env - want) * coeff;
    const glueL = left * this.env * this.makeup;
    const glueR = right * this.env * this.makeup;

    // --- into the delay, and out with what went in `lookahead` frames ago
    const outL = this.delayL[this.at];
    const outR = this.delayR[this.at];
    this.delayL[this.at] = glueL;
    this.delayR[this.at] = glueR;
    this.at = (this.at + 1) % this.lookahead;

    // --- the limiter, on the smallest gain the window asks for
    const ahead = Math.max(Math.abs(glueL), Math.abs(glueR));
    const need = this.windowMin(ahead > this.ceiling ? this.ceiling / ahead : 1);
    // ⚠️ Down at once, up slowly. See the note at the top of the file.
    this.limitGain = need < this.limitGain
      ? need
      : need + (this.limitGain - need) * this.limitRelease;

    return { left: outL * this.limitGain, right: outR * this.limitGain };
  }
}
