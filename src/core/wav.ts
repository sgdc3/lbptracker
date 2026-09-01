/**
 * Canonical 16-bit PCM WAV writer.
 *
 * Byte-for-byte identical to write_wav() in tools/fsb.py, deliberately: that
 * equality is what makes the golden test in test/fsb.test.ts a real check of
 * the decoder rather than a smoke test.
 *
 * WAV is little-endian, like FSB4 and unlike LBP's own resources.
 */

const HEADER_SIZE = 44;

export interface WavLoop {
  /** First frame of the loop. */
  readonly start: number;
  /**
   * Last frame of the loop, INCLUSIVE, as the `smpl` chunk defines it. The
   * mixer wants an exclusive end, so it uses `end + 1`.
   */
  readonly end: number;
  /** 0 = forward, 1 = alternating, 2 = backward. Only 0 is seen in LBP. */
  readonly type: number;
}

export interface WavData {
  readonly channels: Float32Array[];
  readonly sampleRate: number;
  readonly bitsPerSample: number;
  /**
   * Loop points from the `smpl` chunk, if the file has one.
   *
   * ⚠️ **These matter, they are not DAW leftovers.** Every pitched sequencer
   * sample carries one, and without honouring it a note's length follows the
   * sample's length divided by the playback rate: notes below the slot's base
   * note ring far too long, notes above it cut off early. That is exactly the
   * symptom the instrument bench produced before this was read.
   */
  readonly loop?: WavLoop;
  /**
   * `smpl`'s MIDI unity note. ⚠️ **Not authoritative** — it reads 60 on every
   * piano sample regardless of the note actually recorded, so it is the DAW's
   * default. `RInstrument`'s `baseNote` is the real pitch reference.
   */
  readonly unityNote?: number;
}

export class WavFormatError extends Error {}

/**
 * Read a 16-bit PCM RIFF/WAVE file.
 *
 * This is the sequencer's actual sample format: the `.smp` resources in the
 * FARC archives are plain RIFF, 48000 Hz 16-bit mono for the instruments
 * measured so far. See steering/game-assets.md.
 *
 * Chunks are walked rather than assumed at fixed offsets -- a `fmt ` chunk can
 * be longer than 16 bytes and extra chunks can sit before `data`.
 */
export function readWav(bytes: Uint8Array): WavData {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) =>
    String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);

  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new WavFormatError('not a RIFF/WAVE file');
  }

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let data: Uint8Array | undefined;
  let loop: WavLoop | undefined;
  let unityNote: number | undefined;

  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      data = bytes.subarray(body, Math.min(body + size, bytes.length));
    } else if (id === 'smpl' && size >= 36) {
      unityNote = view.getUint32(body + 12, true);
      const loops = view.getUint32(body + 28, true);
      if (loops > 0 && size >= 36 + 24) {
        loop = {
          type: view.getUint32(body + 36 + 4, true),
          start: view.getUint32(body + 36 + 8, true),
          end: view.getUint32(body + 36 + 12, true),
        };
      }
    }
    at = body + size + (size & 1); // chunks are word-aligned
  }

  if (!data) throw new WavFormatError('no data chunk');
  if (format !== 1) throw new WavFormatError(`format ${format} is not PCM`);
  if (bitsPerSample !== 16) {
    throw new WavFormatError(`${bitsPerSample}-bit is not supported, only 16`);
  }
  if (channels < 1) throw new WavFormatError('no channels');

  const frames = Math.floor(data.length / (2 * channels));
  const out: Float32Array[] = [];
  const pcm = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let ch = 0; ch < channels; ch += 1) {
    const buf = new Float32Array(frames);
    for (let i = 0; i < frames; i += 1) {
      buf[i] = pcm.getInt16((i * channels + ch) * 2, true) / 32768;
    }
    out.push(buf);
  }
  // A loop that runs past the data is authoring debris, not a loop.
  if (loop && (loop.end >= frames || loop.start >= loop.end)) loop = undefined;

  return { channels: out, sampleRate, bitsPerSample, loop, unityNote };
}

export function writeWav(
  pcm: Int16Array,
  channels: number,
  sampleRate: number,
): Uint8Array {
  if (channels < 1) throw new RangeError(`channels must be >= 1, got ${channels}`);

  const bodyBytes = pcm.length * 2;
  const out = new Uint8Array(HEADER_SIZE + bodyBytes);
  const view = new DataView(out.buffer);

  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) out[at + i] = text.charCodeAt(i);
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + bodyBytes, true);
  ascii(8, 'WAVE');

  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true); // byte rate
  view.setUint16(32, channels * 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample

  ascii(36, 'data');
  view.setUint32(40, bodyBytes, true);

  for (let i = 0; i < pcm.length; i += 1) {
    view.setInt16(HEADER_SIZE + i * 2, pcm[i], true);
  }
  return out;
}
