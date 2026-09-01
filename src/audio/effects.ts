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
 * ⚠️ **The reverb here is entirely ours.** The game's preset table is recovered
 * — 12 presets of 44 bytes at `v0x1062620`, selected through an 8-entry remap
 * at `v0x1062830`, so `ReverbSetting` 0–7 picks presets 3, 6, 8, 5, 11, 2, 0, 0
 * — and `v0x3fd4c0` pushes ten of each preset's fields into DSP parameters 1–10.
 * But **which DSP** consumes them is still open (question 6), and the fields do
 * not match `FMOD_DSP_SFXREVERB`: two of the ten are booleans, and the levels
 * look like millibels with a reference frequency in Hz. Until that is settled a
 * faithful reverb cannot be written, so this is a small Schroeder network that
 * responds to the send levels and sounds plausible. It is a placeholder that
 * says so.
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

/**
 * ⚠️ **Ours, not the game's.** A four-comb, two-allpass Schroeder network — the
 * standard cheap reverb. It exists so a level with 55% of its instruments
 * sending to reverb does not render dry; it is not a reproduction of anything.
 * Replace it once open question 6 names the DSP.
 */
export class Reverb {
  private readonly combs: { buffer: Float32Array; index: number; store: number }[] = [];
  private readonly allpasses: { buffer: Float32Array; index: number }[] = [];
  private readonly damp: number;
  private readonly roomSize: number;

  constructor(sampleRate: number, roomSize = 0.8, damping = 0.4) {
    this.roomSize = Math.min(Math.max(roomSize, 0), 0.98);
    this.damp = Math.min(Math.max(damping, 0), 1);
    // Freeverb's tunings, scaled from its 44.1 kHz assumption.
    const scale = sampleRate / 44100;
    for (const n of [1116, 1188, 1277, 1356]) {
      this.combs.push({ buffer: new Float32Array(Math.round(n * scale)), index: 0, store: 0 });
    }
    for (const n of [556, 441]) {
      this.allpasses.push({ buffer: new Float32Array(Math.round(n * scale)), index: 0 });
    }
  }

  process(input: number): number {
    let out = 0;
    for (const comb of this.combs) {
      const value = comb.buffer[comb.index];
      out += value;
      comb.store = value * (1 - this.damp) + comb.store * this.damp;
      comb.buffer[comb.index] = input + comb.store * this.roomSize;
      comb.index = (comb.index + 1) % comb.buffer.length;
    }
    out *= 0.25;
    for (const ap of this.allpasses) {
      const buffered = ap.buffer[ap.index];
      const value = out;
      out = -value + buffered;
      ap.buffer[ap.index] = value + buffered * 0.5;
      ap.index = (ap.index + 1) % ap.buffer.length;
    }
    return out;
  }
}

/**
 * The reverb preset table, read out of the eboot at `v0x1062620`.
 *
 * Twelve presets of eleven `int32` slots each; the setter at `v0x3fd4c0` skips
 * slot 0 and pushes the other ten into DSP parameters 1–10, reading slots 7 and
 * 9 as booleans. The names are **not** recovered — the shapes are: the first
 * two look like millibel levels, the last like a reference frequency in Hz.
 */
export const REVERB_PRESETS: readonly (readonly number[])[] = [
  [-350, -200, 0, 3, 25, 30, 1, 20, 1, 12000],
  [-350, -200, 0, 3, 25, 30, 1, 20, 1, 12000],
  [-160, -120, 8, 5, 30, 70, 1, 20, 1, 7000],
  [-200, -100, 10, 1, 6, 1, 1, 20, 1, 5000],
  [-350, -300, 4, 2, 25, 60, 1, 20, 1, 5000],
  [-150, -150, 2, 1, 12, 5, 1, 20, 1, 5000],
  [-100, -700, 13, 0, 12, 5, 1, 20, 1, 5000],
  [-160, -200, 18, 5, 25, 10, 1, 400, 1, 3000],
  [-250, -100, 16, 3, 20, 15, 1, 20, 0, 5000],
  [-130, -170, 18, 3, 20, 15, 1, 20, 1, 10000],
  [-240, -200, 2, 1, 10, 10, 1, 20, 1, 8000],
  [-280, -60, 4, 5, 50, 45, 1, 100, 1, 10000],
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
