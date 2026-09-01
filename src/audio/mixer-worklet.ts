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

import { INTERPOLATORS, type InterpolatorName } from './interpolate.ts';
import { Mixer, type SampleBuffer, type VoiceSpec } from './mixer.ts';

/** A sample handed over from the main thread, with its channels transferred. */
export interface SamplePayload {
  readonly id: string;
  readonly channels: Float32Array[];
  readonly sampleRate: number;
  readonly loop?: { start: number; end: number };
}

export type MixerMessage =
  | { type: 'load'; sample: SamplePayload }
  | { type: 'play'; sampleId: string; voice: Omit<VoiceSpec, 'sample'> }
  | { type: 'interpolator'; name: InterpolatorName }
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
        this.mixer.play({ ...message.voice, sample });
        break;
      }
      case 'interpolator':
        this.mixer.setInterpolator(INTERPOLATORS[message.name]);
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
    this.mixer.render(left, right);
    if (output.length > 1 && right === left) right.set(left);
    return true; // stay alive across silence; the graph decides when to stop
  }
}

registerProcessor('lbp-mixer', MixerProcessor);
