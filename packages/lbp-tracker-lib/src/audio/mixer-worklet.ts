/**
 * The AudioWorkletProcessor. A thin shell around Mixer.
 *
 * Everything that decides what the output sounds like lives in mixer.ts, which
 * is plain TypeScript with no Web Audio: that is what lets the same code be
 * unit-tested under `node --test` and re-run under OfflineAudioContext for
 * export, and it is why a render is reproducible rather than
 * browser-dependent. Keep this file boring.
 *
 * This module is loaded with `audioWorklet.addModule()`, so it runs in the
 * AudioWorkletGlobalScope and cannot import anything platform-specific.
 */

import { WaveHammer } from './compressor.ts';
import { MasterBus, type MasterSettings } from './master.ts';
import { Echo, FOLD_GAIN, Reverb, clipToUnit, reverbPreset } from './effects.ts';
import { INTERPOLATORS, type InterpolatorName } from './interpolate.ts';
import { Mixer, type SampleBuffer, type VoiceSpec } from './mixer.ts';
import { buildMipChain } from './mipmap.ts';

/** A sample handed over from the main thread, with its channels transferred. */
export interface SamplePayload {
  readonly id: string;
  readonly channels: Float32Array[];
  readonly sampleRate: number;
  readonly loop?: { start: number; end: number };
}

export type MixerMessage =
  | { type: 'load'; sample: SamplePayload }
  /**
   * ⚠️ **A `VoiceSpec.random` cannot cross a thread** -- it is a function, and
   * `postMessage` drops it. That used to mean a scheduler wanting the render's
   * exact LFO phases had to draw them on its own side and send them alongside;
   * it does not any more. `VoiceSpec.lfoPhase` holds them as three plain
   * numbers, drawn once per note by the render, and an array crosses.
   */
  | { type: 'play'; sampleId: string; voice: Omit<VoiceSpec, 'sample'> }
  // 'engine' is not an interpolator: it selects the game's own sampler, which
  // is linear plus octave mipmaps and is the faithful setting. The named
  // interpolators switch it off so they can be heard against it.
  | { type: 'interpolator'; name: InterpolatorName | 'engine' }
  /**
   * Rebuild the output stage. Everything here is a sequencer field, so a
   * keyboard can offer exactly what a song can set.
   *
   * ⚠️ **This allocates**, so it runs in the message handler and never in
   * `process`. Both effects size their delay lines from their parameters, so
   * changing one means a new instance and a lost tail; that is a bench making a
   * new sound, not a song being played.
   */
  | {
      type: 'effects';
      echoTime: number;
      framesPerStep: number;
      feedback: number;
      mix: number;
      reverbSetting: number;
      echoOn: boolean;
      reverbOn: boolean;
      clip: boolean;
      compressor?: boolean;
      /** Our own master bus, or null for off. See `audio/master.ts`. */
      master?: MasterSettings | null;
    }
  /** Close the gate on the voices carrying `tag`; see `Mixer.release`. */
  | { type: 'release'; tag: number }
  /** Take a tagged voice away after `frames` more of its own sounding time. */
  | { type: 'cutAt'; tag: number; frames: number }
  /**
   * Move a sounding voice's live expression; see `Mixer.expression`.
   *
   * ⚠️ **One message per dimension per controller frame is the wrong shape.**
   * An MPE controller sends bend, pressure and slide as separate MIDI messages
   * at up to a few hundred hertz each, and every one of them crosses a thread
   * boundary. The fields are all optional so a sender may coalesce a frame's
   * worth into one message; omitted ones keep their current value rather than
   * resetting, which is what makes coalescing safe.
   */
  | {
      type: 'expression';
      tag: number;
      bend?: number;
      pressure?: number;
      timbre?: number;
    }
  /**
   * Forget the health counters and the frame the dropout detector compares to.
   *
   * ⚠️ **Sent when playback starts, because a suspended context looks exactly
   * like a stall.** `process` is not called at all while an AudioContext is
   * suspended, so the first call after `resume()` sees `currentFrame` jump by
   * however long the pause lasted -- which the detector reads, correctly by its
   * own rule, as a lost block. Every session therefore began with one dropout
   * that meant nothing.
   */
  | { type: 'resetHealth' }
  | { type: 'stopAll' };

declare const sampleRate: number;
/** The sample index of the block about to be rendered; see `lastFrame`. */
declare const currentFrame: number;
declare function registerProcessor(
  name: string,
  processor: typeof MixerProcessor,
): void;
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}

export class MixerProcessor extends AudioWorkletProcessor {
  private readonly mixer = new Mixer(sampleRate);
  private readonly samples = new Map<string, SampleBuffer>();

  /*
   * The output stage, live.
   *
   * This is the same chain `packages/lbp-tracker-lib/src/render.ts` runs offline and in the same
   * order (`fmodextinput.prx` 0x07c0): the echo's wet is added to the dry pair
   * *and* to the reverb send pair, all four are clipped to +-1, and only then
   * does the reverb see its input. Keeping the two in step matters more than
   * either one being convenient -- a bench that flatters the render is worse
   * than no bench.
   */
  private echo: Echo | null = null;
  private reverb: Reverb | null = null;
  private echoOn = false;
  private reverbOn = false;
  private clip = true;
  /**
   * `SMS WaveHammer`, the compressor the game's chain ends in.
   *
   * It lives here rather than in the caller because its detector and envelope
   * are stateful across blocks; `packages/lbp-tracker-lib/src/render.ts` runs the same class over
   * the same signal at the same point, so the two paths agree.
   *
   * ❗ **Off unless `compressor` is set, which mirrors the offline default and is
   * a deviation from the game.** See the `compressor` option in
   * `packages/lbp-tracker-lib/src/render.ts` for why, and question 38 in
   * `steering/open-questions.md` for what would settle it.
   */
  private readonly hammer = new WaveHammer();
  private compressor = false;
  /**
   * **Ours, past the fold**: a glue compressor and a limiter, off unless the
   * page switches them on. Nothing in the game does this, which is why it is
   * built only when it is asked for. See `master.ts`.
   */
  private master: MasterBus | null = null;
  /**
   * Frames since the last voice-count report.
   *
   * The count is posted on a timer rather than per block: a render quantum is
   * 128 frames, which would be nearly four hundred messages a second for a
   * number a person reads ten times a second at most.
   */
  private sinceReport = 0;
  /**
   * The worst `process()` cost seen since the last report, as a fraction of the
   * block's own duration.
   *
   * ⚠️ **A live renderer can fail in a way an offline one cannot**: if a block
   * takes longer than it lasts, the device gets nothing and the gap is audible
   * as notes cutting out at random. It is worth knowing whether that is what is
   * happening before blaming the scheduler, so the number is measured rather
   * than guessed at. `currentTime` is not usable here -- it advances per block --
   * so this uses the wall clock the worklet scope exposes.
   */
  /**
   * Whether the wall clock is readable from this scope at all.
   *
   * ⚠️ `performance` is not guaranteed in an AudioWorkletGlobalScope, and a
   * load that is missing must not look like a load that is zero -- the whole
   * point of the meter is to tell "the audio thread is fine" apart from "nobody
   * checked".
   */
  /**
   * Whether a clock is readable at all from this scope.
   *
   * ⚠️ **`performance` is NOT exposed to an AudioWorkletGlobalScope** -- probed
   * in Chrome, `typeof performance === 'undefined'` -- and neither is
   * `AudioContext.renderCapacity` on the other side. `Date` is, because it is a
   * language built-in rather than a Web API, and `Date.now()` there returns a
   * real timestamp with 1 ms resolution.
   *
   * ⚠️ **1 ms against a 2.67 ms block is coarse**, so a single block measures 0
   * or 1 and nothing in between. Summed across the ~37 blocks of a report
   * window it comes out right on average, because a block's start has no
   * relationship to the millisecond tick -- the estimate is noisy per window and
   * unbiased over several, which is why the reported figure is smoothed.
   *
   * ⚠️ **The figure is a share of WALL time, on a CPU whose speed follows its
   * load.** Measured 2026-09-07 on Ascetic from the start, Chrome 148, a
   * 16-core Windows machine: ~6-8% with the page idle (the old live page and
   * the Song/Mixer view alike), ~0.3% on the Arrange view, which redraws its
   * board every frame while playing, and ~2% on Song/Mixer with a 6 ms
   * busy-loop added per frame. Not the meter: a fixed 3e6-iteration loop on
   * the main thread took 7-14 ms with the machine idle and 3.5 ms with a
   * worker spinning beside it. The audio thread really does its work two to
   * three times faster once something keeps the clock up, so the reading
   * falls. It is honest; it is not a measure of the mixer's cost in cycles.
   */
  private readonly canTime = typeof Date !== 'undefined';
  /** Milliseconds spent inside `process` since the last report. */
  private busyMs = 0;
  /** Wall clock at the last report, for the window's own length. */
  private windowStart = 0;
  /** Smoothed busy fraction, so the readout does not flicker with the noise. */
  private smoothed = 0;
  /**
   * The audio clock at the previous `process`, for spotting skipped blocks.
   *
   * ⚠️ **This is the metric that works here.** A wall clock is not exposed to an
   * AudioWorkletGlobalScope -- `performance` is absent in Chrome -- and
   * `AudioContext.renderCapacity`, which would answer the question directly, is
   * not implemented either. But `currentFrame` is the sample index of the block
   * about to be rendered, and it advances by exactly one block per call while
   * the thread keeps up. When it jumps further, blocks were skipped and the
   * device got nothing: a dropout, which is what "notes cutting out" sounds
   * like and the only thing worth reporting.
   */
  private lastFrame = -1;
  private dropouts = 0;
  private lostFrames = 0;
  /** Send buses, grown on demand. A render quantum is 128 frames today. */
  private echoL = new Float32Array(128);
  private echoR = new Float32Array(128);
  private reverbL = new Float32Array(128);
  private reverbR = new Float32Array(128);

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<MixerMessage>) => {
      this.handle(event.data);
    };
  }

  private handle(message: MixerMessage): void {
    switch (message.type) {
      case 'load':
        this.samples.set(message.sample.id, {
          channels: message.sample.channels,
          sampleRate: message.sample.sampleRate,
          loop: message.sample.loop,
          // Built here, at load, because that is when the game builds them --
          // and because a voice must never allocate on the audio thread. Costs
          // 50% more memory per sample and buys the engine's own anti-aliasing
          // above one octave up. See packages/lbp-tracker-lib/src/audio/mipmap.ts.
          mips: message.sample.channels.map((c) => buildMipChain(c)),
        });
        break;
      case 'play': {
        const sample = this.samples.get(message.sampleId);
        // Dropping a voice for a sample that never arrived is the right
        // failure: silence beats a crash mid-render, and the id is reported.
        if (!sample) {
          this.port.postMessage({ type: 'missingSample', id: message.sampleId });
          return;
        }
        // The file's own pan, untouched. The stereo fold's narrowing used
        // to be applied here from a `panWidth` message; it was removed on
        // 2026-09-06 on a listening judgement. `FOLD_GAIN` in
        // `packages/lbp-tracker-lib/src/render.ts` is the fold's other half and still applies.
        this.mixer.play({ ...message.voice, sample, pan: message.voice.pan });
        break;
      }
      case 'interpolator':
        this.mixer.setEngineSampler(message.name === 'engine');
        if (message.name !== 'engine') {
          this.mixer.setInterpolator(INTERPOLATORS[message.name]);
        }
        break;
      case 'effects':
        this.echoOn = message.echoOn;
        this.reverbOn = message.reverbOn;
        this.clip = message.clip;
        this.compressor = message.compressor ?? false;
        if (message.master) {
          if (this.master) this.master.set(message.master);
          else this.master = new MasterBus(sampleRate, message.master);
        } else {
          this.master = null;
        }
        this.echo = message.echoOn
          ? new Echo(
              sampleRate,
              message.echoTime,
              message.framesPerStep,
              message.feedback,
              message.mix,
            )
          : null;
        this.reverb = message.reverbOn
          ? new Reverb(sampleRate, reverbPreset(message.reverbSetting))
          : null;
        break;
      case 'release':
        this.mixer.release(message.tag);
        break;
      case 'cutAt':
        this.mixer.cutAt(message.tag, message.frames);
        break;
      case 'expression':
        this.mixer.expression(message.tag, message.bend, message.pressure, message.timbre);
        break;
      case 'resetHealth':
        this.lastFrame = -1;
        this.dropouts = 0;
        this.lostFrames = 0;
        this.busyMs = 0;
        this.windowStart = 0;
        break;
      case 'stopAll':
        this.mixer.stopAll();
        break;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const began = this.canTime ? Date.now() : 0;
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const left = output[0];
    const right = output.length > 1 ? output[1] : output[0];

    if (!this.echo && !this.reverb && !this.clip && !this.compressor && !this.master) {
      this.mixer.render(left, right);
      // The fold's gain is FMOD's speaker matrix, not one of the switchable
      // effects: it stays on with everything else off, or the level would jump
      // by 4.645 dB on the last switch.
      const stereo = right !== left;
      for (let i = 0; i < left.length; i += 1) {
        left[i] *= FOLD_GAIN;
        if (stereo) right[i] *= FOLD_GAIN;
      }
      if (output.length > 1 && right === left) right.set(left);
      this.report(left.length, began);
      return true;
    }

    const frames = left.length;
    if (this.echoL.length < frames) {
      // Only ever on a quantum change, never per block.
      this.echoL = new Float32Array(frames);
      this.echoR = new Float32Array(frames);
      this.reverbL = new Float32Array(frames);
      this.reverbR = new Float32Array(frames);
    }
    this.mixer.render(left, right, {
      echo: [this.echoL, this.echoR],
      reverb: [this.reverbL, this.reverbR],
    });

    for (let i = 0; i < frames; i += 1) {
      const e = this.echo?.process(this.echoL[i], this.echoR[i]);
      const wetL = e ? e.left : 0;
      const wetR = e ? e.right : 0;
      let dryL = left[i] + wetL;
      let dryR = right[i] + wetR;
      let sendL = this.reverbL[i] + wetL;
      let sendR = this.reverbR[i] + wetR;
      if (this.clip) {
        dryL = clipToUnit(dryL);
        dryR = clipToUnit(dryR);
        sendL = clipToUnit(sendL);
        sendR = clipToUnit(sendR);
      }
      const r = this.reverb?.process(sendL, sendR);
      left[i] = dryL + (r ? r.left : 0);
      right[i] = dryR + (r ? r.right : 0);
      // `Channel::addDSP` put the WaveHammer after the reverb, so it sees the sum.
      if (this.compressor) {
        const g = this.hammer.gainFor(left[i], right[i]);
        left[i] *= g;
        right[i] *= g;
      }
      // The stereo fold's gain, last, where FMOD's speaker matrix applies it.
      left[i] *= FOLD_GAIN;
      right[i] *= FOLD_GAIN;
      // And ours after it, where the game's chain has ended.
      if (this.master) {
        const out = this.master.process(left[i], right[i]);
        left[i] = out.left;
        right[i] = out.right;
      }
    }
    if (output.length > 1 && right === left) right.set(left);
    this.report(left.length, began);
    return true; // stay alive across silence; the graph decides when to stop
  }

  private report(frames: number, began: number): void {
    if (this.canTime) this.busyMs += Date.now() - began;
    if (this.lastFrame >= 0) {
      const advanced = currentFrame - this.lastFrame;
      if (advanced > frames) {
        this.dropouts += 1;
        this.lostFrames += advanced - frames;
      }
    }
    this.lastFrame = currentFrame;
    this.sinceReport += frames;
    if (this.sinceReport < sampleRate / 10) return;
    this.sinceReport = 0;
    const { total, sounding, notes } = this.mixer.counts();
    let load: number | null = null;
    if (this.canTime) {
      const now = Date.now();
      const elapsed = this.windowStart > 0 ? now - this.windowStart : 0;
      // Against the wall clock the window actually took, not against the audio
      // time it represents: they agree while the thread keeps up, and when they
      // do not, the wall clock is the honest denominator.
      if (elapsed > 0) {
        const raw = this.busyMs / elapsed;
        this.smoothed = this.smoothed === 0 ? raw : this.smoothed * 0.7 + raw * 0.3;
        load = this.smoothed;
      }
      this.windowStart = now;
      this.busyMs = 0;
    }
    this.port.postMessage({
      type: 'voices',
      total,
      sounding,
      notes,
      load,
      dropouts: this.dropouts,
      lostFrames: this.lostFrames,
    });
    this.dropouts = 0;
    this.lostFrames = 0;
  }
}

registerProcessor('lbp-mixer', MixerProcessor);
