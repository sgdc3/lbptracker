/**
 * The editor's two grids as arithmetic: where a cell, a step or a pitch sits
 * on a canvas, and back. No DOM here, so `test/editor-geometry.test.ts` can
 * hold it.
 *
 * The board is the game's: a cell is 16 steps, two of the game's 8-step bars,
 * half of one of its 105-unit tiles, and a row is one placement high
 * (steering/sequencer-data-model.md, *The timeline* and *The tile*). The piano roll is the placement's own note grid: positions
 * in thirds of a step, because that is the record's resolution, and one row
 * per pitch.
 */

import { STEPS_PER_CELL } from '@lbptracker/cwlib/project.ts';
import { BARS_PER_CELL, STEPS_PER_BAR } from '@lbptracker/lib/song.ts';

export { BARS_PER_CELL, STEPS_PER_BAR, STEPS_PER_CELL };

// ------------------------------------------------------------------ the board

export interface BoardLayout {
  /** Pixels per cell, each way. */
  readonly cellW: number;
  readonly cellH: number;
  /** The row-number gutter on the left, and the bar ruler above. */
  readonly gutter: number;
  readonly ruler: number;
  readonly cols: number;
  readonly rows: number;
}

export function boardSize(layout: BoardLayout): { width: number; height: number } {
  return {
    width: layout.gutter + layout.cols * layout.cellW,
    height: layout.ruler + layout.rows * layout.cellH,
  };
}

/** The cell under a canvas point, or null off the grid. */
export function boardCellAt(
  layout: BoardLayout,
  x: number,
  y: number,
): { cell: number; row: number } | null {
  const cell = Math.floor((x - layout.gutter) / layout.cellW);
  const row = Math.floor((y - layout.ruler) / layout.cellH);
  if (cell < 0 || row < 0 || cell >= layout.cols || row >= layout.rows) return null;
  return { cell, row };
}

export function boardRect(
  layout: BoardLayout,
  cell: number,
  row: number,
): { x: number; y: number; w: number; h: number } {
  return {
    x: layout.gutter + cell * layout.cellW,
    y: layout.ruler + row * layout.cellH,
    w: layout.cellW,
    h: layout.cellH,
  };
}

/** A step on the timeline to a board x. Fractional steps welcome: the playhead. */
export function boardX(layout: BoardLayout, step: number): number {
  return layout.gutter + (step / STEPS_PER_CELL) * layout.cellW;
}

/**
 * The mixer channel a row feeds: the board cut into `channels` bands of equal
 * height, as `channelVolume` computes it. Kept here for drawing the bands;
 * the one that decides the gain is in `@lbptracker/cwlib/project.ts`.
 */
export function bandOf(row: number, rows: number, channels: number): number {
  const count = Math.max(1, channels);
  const divisor = Math.max(Math.floor(rows / count), 1);
  return Math.min(count - 1, Math.max(0, Math.floor(row / divisor)));
}

// ------------------------------------------------------------- the piano roll

export interface RollLayout {
  /** The keyboard on the left, and the step ruler above. */
  readonly keys: number;
  readonly ruler: number;
  /** Pixels per step. */
  readonly stepW: number;
  /** Pixels per pitch row. */
  readonly rowH: number;
  /** The clip's grid length. */
  readonly steps: number;
}

export const PITCHES = 128;

export function rollSize(layout: RollLayout): { width: number; height: number } {
  return {
    width: layout.keys + layout.steps * layout.stepW,
    height: layout.ruler + PITCHES * layout.rowH,
  };
}

/**
 * A position in thirds of a step to its canvas x: the CENTRE of the third it
 * names, so a note sits inside its cell the way the game's grid draws it,
 * and the three thirds of a triplet spread across the step.
 */
export function rollX(layout: RollLayout, thirds: number): number {
  return layout.keys + ((thirds + 0.5) / 3) * layout.stepW;
}

/** A step boundary to its canvas x: the grid lines, the ruler, the playhead. */
export function rollStepX(layout: RollLayout, step: number): number {
  return layout.keys + step * layout.stepW;
}

/** A canvas x to a continuous position in thirds; `snapThirds` picks the cell. */
export function rollThirdsAt(layout: RollLayout, x: number): number {
  return ((x - layout.keys) / layout.stepW) * 3;
}

/** The centre of a pitch's row. Pitch 127 is the top row. */
export function rollY(layout: RollLayout, pitch: number): number {
  return layout.ruler + (PITCHES - 1 - pitch + 0.5) * layout.rowH;
}

/** The pitch whose row holds a canvas y. */
export function rollPitchAt(layout: RollLayout, y: number): number {
  const row = Math.floor((y - layout.ruler) / layout.rowH);
  return Math.max(0, Math.min(PITCHES - 1, PITCHES - 1 - row));
}

/**
 * The grid cell a continuous position falls in: a whole step, or a third when
 * the grid is set to triplets. A click anywhere inside a cell means that cell,
 * as on the game's grid; the switch only decides how fine the cells are.
 */
export function snapThirds(thirds: number, triplets: boolean, steps: number): number {
  const snapped = triplets ? Math.floor(thirds) : Math.floor(thirds / 3) * 3;
  return Math.max(0, Math.min(steps * 3 - 1, snapped));
}

/** A note's volume as a dot: 0..127 to a radius, never smaller than a target. */
export function pointRadius(volume: number, rowH: number): number {
  const t = Math.max(0, Math.min(127, volume)) / 127;
  return rowH * (0.18 + 0.32 * t);
}

/**
 * The note's timbre as a colour: blue at 0, orange at 15, as the game paints it.
 *
 * A straight blend in RGB between the two, which passes through a grey in the
 * middle; that is what the in-game grid does too, and it keeps the two ends
 * unmistakable.
 */
export function timbreColour(timbre: number, alpha = 1): string {
  const t = Math.max(0, Math.min(15, timbre)) / 15;
  const blue = [66, 140, 255];
  const orange = [255, 140, 36];
  const c = blue.map((b, i) => Math.round(b + (orange[i] - b) * t));
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** MIDI numbering: 60 is C4, which is the numbering `basenote` uses. */
export function noteName(pitch: number): string {
  return `${NAMES[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`;
}

export function isBlackKey(pitch: number): boolean {
  return [1, 3, 6, 8, 10].includes(((pitch % 12) + 12) % 12);
}

/** A position in thirds as "bar.beat.step+third" for a label; a bar is the game's 8 steps. */
export function positionLabel(thirds: number): string {
  const step = Math.floor(thirds / 3);
  const third = thirds - step * 3;
  const bar = Math.floor(step / STEPS_PER_BAR) + 1;
  const beat = Math.floor((step % STEPS_PER_BAR) / 4) + 1;
  const sub = (step % 4) + 1;
  return `${bar}.${beat}.${sub}${third ? `+${third}/3` : ''}`;
}

/** The game's bar a board cell starts at, 1-based, for labels. */
export function barOfCell(cell: number): number {
  return cell * BARS_PER_CELL + 1;
}

/** Distance from a point to a segment, for hit-testing a note's line. */
export function segmentDistance(
  px: number, py: number, ax: number, ay: number, bx: number, by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}
