/**
 * The engine's voice pool, and what happens when it runs out.
 *
 * The synthesiser has **32 voices and no more**: the DSP state reserves
 * `+0x0028`…`+0x1a27` for 32 records of `0xd0` = 208 bytes, which is most of
 * its 6,992 bytes. A player without that cap is not merely more permissive, it
 * is louder in exactly the places a composition is densest -- which is where a
 * listener notices it.
 *
 * The allocator is `fmodextinput.prx` `0x1640`-`0x1692`:
 *
 * ```
 * xmm0 = 1.0                       ; best score so far
 * ecx = 0                          ; index      edx = 0   ; best index
 * loop:
 *   cmp byte [rax], 0xff
 *   je  return                     ; a free record wins immediately
 *   xmm1 = [rax + 4] * [rax + 0xc] ; this voice's score
 *   cmovb edx, ecx                 ; remember it if it is the lowest so far
 *   xmm0 = min(xmm1, xmm0)
 *   rax += 0xd0 ; inc ecx ; cmp ecx, 0x20 ; jl loop
 * return rsi + edx * 0xd0          ; else the quietest voice
 * ```
 *
 * So: **take the first free voice; when none is free, steal the quietest.**
 *
 * The score is the product of two voice fields, and both are known from the
 * gain chain at `0x23c1`-`0x2408`: `+0x04` is the channel volume (written at
 * `0x3b52` as the mixer channel's level times the note's `bits 28..29` table
 * factor) and `+0x0c` is the note's own volume. **Neither the instrument's
 * `Params[24]` nor the amplitude envelope is in it** -- the engine ranks by
 * what the note asked for, not by how loud it currently happens to be.
 *
 * ⚠️ The initial best is **1.0**, not infinity, and the initial best index is
 * **0**. A pool in which every voice scores 1.0 or more therefore loses voice
 * 0 rather than the quietest, and that is reproduced here rather than tidied
 * away.
 */

export const VOICE_POOL_SIZE = 32;

/**
 * Pass this as the pool size to turn the cap off.
 *
 * 📝 **This belongs in the UI.** The cap is the engine's and is on by default,
 * because a faithful tracker reproduces it -- but it is also the single most
 * audible "why does my project sound different here" setting there is, and a
 * composer who has written past 32 voices will want to hear both. Expose it as
 * a voice-limit control (a number, not a checkbox: 32 is the game's, and
 * letting someone try 16 or 64 costs nothing) with the game's value as the
 * default and a note that raising it is no longer faithful.
 */
export const VOICES_UNLIMITED = Infinity;

/** Just enough of a note for the allocator to rank and place it. */
export interface PooledNote {
  /** When it starts, in whatever unit the caller uses consistently. */
  readonly start: number;
  /** When it would end if it ran to completion. */
  readonly end: number;
  /**
   * `voice[+0x04] * voice[+0x0c]`: the channel volume times the note volume.
   * Not the instrument level, and not the envelope.
   */
  readonly score: number;
}

/** What the pool decided for one note. */
export interface PooledResult {
  /** Index into the input array. */
  readonly index: number;
  /**
   * When the note actually stops. Equal to its own `end` unless a later note
   * stole its voice, in which case it is that note's `start`.
   */
  readonly end: number;
}

/**
 * Run notes through the pool, returning each note's real end.
 *
 * Notes are taken in start order, which is the order the sequencer triggers
 * them. A note whose voice is stolen stops at the moment of the theft; it is
 * never dropped outright, because the engine does not drop it either -- it
 * overwrites the record, and the sound stops there.
 */
export function allocateVoices(
  notes: readonly PooledNote[],
  poolSize: number = VOICE_POOL_SIZE,
): PooledResult[] {
  // `VOICES_UNLIMITED` short-circuits: nothing is ever stolen, so every note
  // keeps the end it was given.
  if (!Number.isFinite(poolSize)) {
    return notes.map((note, index) => ({ index, end: note.end }));
  }
  const order = notes
    .map((note, index) => ({ note, index }))
    .sort((a, b) => a.note.start - b.note.start || a.index - b.index);

  /** One slot per voice record; `undefined` is `+0x00 == 0xff`. */
  const pool: ({ index: number; end: number; score: number } | undefined)[] = new Array(
    poolSize,
  ).fill(undefined);
  const ends = new Map<number, number>();

  for (const { note, index } of order) {
    // A record frees itself when its voice finishes, so retire the expired
    // ones before looking for a free slot.
    for (let i = 0; i < poolSize; i += 1) {
      const held = pool[i];
      if (held && held.end <= note.start) pool[i] = undefined;
    }

    let chosen = pool.findIndex((slot) => slot === undefined);
    if (chosen === -1) {
      // ⚠️ Best starts at 1.0 and best index at 0, exactly as at 0x1640-0x164d.
      let best = 1;
      chosen = 0;
      for (let i = 0; i < poolSize; i += 1) {
        const held = pool[i]!;
        if (held.score < best) {
          best = held.score;
          chosen = i;
        }
      }
      const stolen = pool[chosen]!;
      ends.set(stolen.index, note.start);
    }

    pool[chosen] = { index, end: note.end, score: note.score };
    ends.set(index, note.end);
  }

  return notes.map((_, index) => ({ index, end: ends.get(index) ?? notes[index].end }));
}

/**
 * The same allocator, fed one note at a time.
 *
 * ⚠️ **`allocateVoices` is causal** -- it walks notes in start order, retires
 * the slots whose voices have ended, and steals the lowest-scoring survivor,
 * never looking at a note it has not reached. That is the engine's own runtime
 * behaviour (`0x1640`-`0x164d`), so the offline pass is a model of something
 * that can be done live, and this is that same rule with the loop turned inside
 * out.
 *
 * `add` returns the note's own end, plus the note whose voice it stole and the
 * frame the theft happens at -- everything a live scheduler needs to revise a
 * voice it has already handed over.
 *
 * ⚠️ **Notes must arrive in the order `allocateVoices` would have sorted them**:
 * by `start`, ties broken by the order they were added. `packages/lbp-tracker-lib/test/polyphony.test.ts`
 * pins the equivalence, because the moment these two disagree the live player
 * and the renderer are different instruments.
 */
export class LiveVoicePool {
  private readonly pool: ({ index: number; end: number; score: number } | undefined)[];
  private readonly poolSize: number;

  constructor(poolSize: number = VOICE_POOL_SIZE) {
    // A parameter property would be tidier and `erasableSyntaxOnly` forbids it:
    // this project type-strips rather than compiles, so nothing may survive
    // erasure. See tsconfig.
    this.poolSize = poolSize;
    this.pool = new Array(Number.isFinite(poolSize) ? poolSize : 0).fill(undefined);
  }

  add(index: number, note: PooledNote): { end: number; stole?: { index: number; at: number } } {
    if (!Number.isFinite(this.poolSize)) return { end: note.end };

    for (let i = 0; i < this.pool.length; i += 1) {
      const held = this.pool[i];
      if (held && held.end <= note.start) this.pool[i] = undefined;
    }

    let chosen = this.pool.findIndex((slot) => slot === undefined);
    let stole: { index: number; at: number } | undefined;
    if (chosen === -1) {
      // ⚠️ Best starts at 1.0 and best index at 0, exactly as at 0x1640-0x164d.
      let best = 1;
      chosen = 0;
      for (let i = 0; i < this.pool.length; i += 1) {
        const held = this.pool[i]!;
        if (held.score < best) {
          best = held.score;
          chosen = i;
        }
      }
      stole = { index: this.pool[chosen]!.index, at: note.start };
    }
    this.pool[chosen] = { index, end: note.end, score: note.score };
    return { end: note.end, stole };
  }
}
