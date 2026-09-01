/**
 * FMOD's IMA ADPCM variant, as LBP3's banks use it.
 *
 * Port of decode_ima() in tools/fsb.py, which is the reference implementation
 * and the oracle this is tested against. The block geometry was measured from
 * the banks, not taken from FMOD docs -- see steering/game-assets.md:
 *
 *   - 36 bytes per channel per block, 64 samples per channel per block
 *   - a block is a 4-byte preamble (i16 predictor, u8 step index, u8 pad)
 *     followed by 32 bytes of 4-bit nibbles, LOW NIBBLE FIRST
 *   - for stereo the channels' 36-byte blocks are stored back to back, NOT
 *     nibble-interleaved
 *
 * A wrong ADPCM decoder produces noise rather than an error, so treat the
 * golden test in test/fsb.test.ts as load-bearing.
 */

export const IMA_BLOCK_BYTES = 36;
export const IMA_BLOCK_SAMPLES = 64;

const STEP_TABLE = Int32Array.from([
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
  253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
  3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
  11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
]);

const INDEX_TABLE = Int32Array.from([
  -1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8,
]);

const MAX_INDEX = STEP_TABLE.length - 1; // 88

function clampIndex(value: number): number {
  if (value < 0) return 0;
  if (value > MAX_INDEX) return MAX_INDEX;
  return value;
}

/**
 * Decode one channel's blocks into `out`, writing every `stride` samples.
 *
 * `blockBase` is the byte offset of this channel's first block; blocks for the
 * same channel repeat every `blockStride` bytes.
 */
function decodeChannel(
  raw: Uint8Array,
  blockBase: number,
  blockStride: number,
  blockCount: number,
  out: Int16Array,
  outStart: number,
  outStride: number,
): number {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  let written = 0;
  let at = outStart;

  for (let block = 0; block < blockCount; block += 1) {
    const base = blockBase + block * blockStride;
    let predictor = view.getInt16(base, true);
    let index = clampIndex(raw[base + 2]);

    for (let byte = base + 4; byte < base + IMA_BLOCK_BYTES; byte += 1) {
      const packed = raw[byte];
      for (let half = 0; half < 2; half += 1) {
        const nibble = half === 0 ? packed & 0x0f : packed >> 4;
        const step = STEP_TABLE[index];

        let diff = step >> 3;
        if (nibble & 1) diff += step >> 2;
        if (nibble & 2) diff += step >> 1;
        if (nibble & 4) diff += step;
        if (nibble & 8) diff = -diff;

        predictor += diff;
        if (predictor > 32767) predictor = 32767;
        else if (predictor < -32768) predictor = -32768;

        index = clampIndex(index + INDEX_TABLE[nibble]);

        if (at < out.length) {
          out[at] = predictor;
          at += outStride;
          written += 1;
        }
      }
    }
  }
  return written;
}

/**
 * Decode a sample's raw ADPCM to interleaved 16-bit PCM.
 *
 * `lengthSamples` is the header's per-channel frame count; the result is
 * truncated to it, because the last block is padded out to a block boundary.
 */
export function decodeIma(
  raw: Uint8Array,
  channels: number,
  lengthSamples: number,
): Int16Array {
  if (channels < 1) {
    throw new RangeError(`channels must be >= 1, got ${channels}`);
  }
  const blockStride = IMA_BLOCK_BYTES * channels;
  const blockCount = Math.floor(raw.length / blockStride);
  const decodable = blockCount * IMA_BLOCK_SAMPLES;
  const frames = Math.max(0, Math.min(lengthSamples, decodable));

  const out = new Int16Array(frames * channels);
  for (let ch = 0; ch < channels; ch += 1) {
    decodeChannel(
      raw,
      ch * IMA_BLOCK_BYTES,
      blockStride,
      blockCount,
      out,
      ch,
      channels,
    );
  }
  return out;
}

/**
 * Split interleaved PCM into one Float32Array per channel, scaled to -1..1.
 *
 * The divisor is 32768 so that -32768 maps to exactly -1.0; this is the
 * convention the mixer works in.
 */
export function toFloatChannels(
  pcm: Int16Array,
  channels: number,
): Float32Array[] {
  const frames = Math.floor(pcm.length / channels);
  const out: Float32Array[] = [];
  for (let ch = 0; ch < channels; ch += 1) {
    const buf = new Float32Array(frames);
    for (let i = 0; i < frames; i += 1) {
      buf[i] = pcm[i * channels + ch] / 32768;
    }
    out.push(buf);
  }
  return out;
}
