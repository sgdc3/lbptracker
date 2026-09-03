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

import { Echo, Reverb, clipToUnit, reverbPreset } from './effects.ts';
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
   * `lfoPhase` is the three LFO start phases, in radians, already including
   * whatever spread the spec asked for.
   *
   * ⚠️ **A `VoiceSpec.random` cannot cross a thread** -- it is a function, and
   * `postMessage` drops it -- so a scheduler that wants the render's exact LFO
   * phases has to compute them on its own side and send the numbers. When they
   * are present the voice's own randomness is switched off, which is the whole
   * point: the phases ARE the offsets.
   */
  | {
      type: 'play';
      sampleId: string;
      voice: Omit<VoiceSpec, 'sample'>;
      lfoPhase?: readonly [number, number, number];
    }
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
    }
  /** Close the gate on the voices carrying `tag`; see `Mixer.release`. */
  | { type: 'release'; tag: number }
  | { type: 'stopAll' };

declare const sampleRate: number;
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
   * This is the same chain `src/core/render.ts` runs offline and in the same
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
   * Frames since the last voice-count report.
   *
   * The count is posted on a timer rather than per block: a render quantum is
   * 128 frames, which would be nearly four hundred messages a second for a
   * number a person reads ten times a second at most.
   */
  private sinceReport = 0;
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
          // above one octave up. See src/audio/mipmap.ts.
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
        this.mixer.play(
          message.lfoPhase
            ? {
                ...message.voice,
                sample,
                lfoPhaseOffset: message.lfoPhase,
                random: () => 0,
              }
            : { ...message.voice, sample },
        );
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
      case 'stopAll':
        this.mixer.stopAll();
        break;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const left = output[0];
    const right = output.length > 1 ? output[1] : output[0];

    if (!this.echo && !this.reverb && !this.clip) {
      this.mixer.render(left, right);
      if (output.length > 1 && right === left) right.set(left);
      this.report(left.length);
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
    }
    if (output.length > 1 && right === left) right.set(left);
    this.report(left.length);
    return true; // stay alive across silence; the graph decides when to stop
  }

  private report(frames: number): void {
    this.sinceReport += frames;
    if (this.sinceReport < sampleRate / 10) return;
    this.sinceReport = 0;
    const { total, sounding } = this.mixer.counts();
    this.port.postMessage({ type: 'voices', total, sounding });
  }
}

registerProcessor('lbp-mixer', MixerProcessor);
