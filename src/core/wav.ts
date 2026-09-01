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
