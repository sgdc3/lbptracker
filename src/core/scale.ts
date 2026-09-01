/**
 * The sequencer's scale quantiser -- `sub_0x250` in `fmodextinput.prx`.
 *
 * A note in the sequencer is **not** played at the semitone it names. The
 * engine snaps it to the sequencer's scale first, so a note the editor shows on
 * a black key can sound a semitone or two away. Skipping this does not merely
 * lose a feature, it detunes anything authored on a non-chromatic scale.
 *
 * ⚠️ The snap is to a nearby tone, **not** reliably downward: the blues table
 * sends position 2 up to 3, and its ties break in both directions. The tables
 * are the fact; do not replace them with a rule.
 *
 * The tables are at module vaddr **`0x80c0`**, which is the addend of the
 * `R_X86_64_RELATIVE` relocation on the pointer slot at `0x8020` -- not a
 * figure derived from a segment mapping. Six rows of twelve `int32`. See
 * steering/sequencer-data-model.md.
 *
 * ⚠️ **An earlier reading of this table was off by one row**, which named every
 * scale wrongly and lost one entirely. It came from computing the address from
 * the segment mapping instead of reading the relocation, landing 48 bytes
 * early on a row of zeros that looked like a plausible "unused" row 0. Read the
 * relocation.
 */

/**
 * Semitone for each chromatic position, per scale. Index with the scale id.
 *
 * Row 0 exists only so the ids line up with the engine's; it is never read,
 * since `quantise` passes scale 0 through unchanged.
 */
export const SCALE_TABLES: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], // chromatic -- the identity
  [0, 0, 2, 2, 4, 5, 5, 7, 7, 9, 9, 11], // major            {0,2,4,5,7,9,11}
  [0, 0, 2, 3, 3, 5, 5, 7, 8, 8, 10, 10], // natural minor    {0,2,3,5,7,8,10}
  [0, 0, 0, 3, 3, 5, 5, 7, 7, 7, 10, 10], // minor pentatonic {0,3,5,7,10}
  [0, 0, 3, 3, 5, 5, 6, 6, 7, 7, 10, 10], // blues            {0,3,5,6,7,10}
  [0, 0, 2, 2, 4, 4, 6, 7, 7, 9, 9, 11], // lydian           {0,2,4,6,7,9,11}
];

/**
 * Names in the engine's id order, for display.
 *
 * Row 0 is never reached through `quantise` -- the engine returns early for
 * scale 0 -- but it holds the identity, so naming it chromatic is honest: an id
 * of 0 and an id out of range both leave the note alone.
 */
export const SCALE_NAMES: readonly string[] = [
  'chromatic',
  'major',
  'natural minor',
  'minor pentatonic',
  'blues',
  'lydian',
];

/** The highest scale id the engine accepts; anything else is chromatic. */
export const MAX_SCALE = 5;

/**
 * Snap a note to `scale`, preserving its octave.
 *
 * ⚠️ The engine's guard is `(unsigned)(scale - 1) > 4`, so **scale 0 and
 * anything above 5 pass through unchanged** -- an out-of-range id is not an
 * error and must not be treated as one.
 *
 * The division is signed and truncating, matching the engine's `imul`/`sar`
 * sequence, so negative notes fold the same way they do there.
 */
export function quantise(note: number, scale: number): number {
  if (scale < 1 || scale > MAX_SCALE) return note;
  const octave = Math.trunc(note / 12);
  const within = note - octave * 12;
  // A negative note leaves `within` negative; the engine indexes the table with
  // it just the same, so guard rather than reproduce an out-of-bounds read.
  if (within < 0 || within > 11) return note;
  return octave * 12 + SCALE_TABLES[scale][within];
}

/**
 * A note word's 7-bit field to the pitch the voice actually plays.
 *
 * `root` is the note block's `+0x10`. The `- 12` is the engine's, at `0x3c20`
 * (`lea eax, [rax + rdx - 0xc]`).
 */
export function notePitch(note: number, scale: number, root: number): number {
  return quantise(note, scale) + root - 12;
}
