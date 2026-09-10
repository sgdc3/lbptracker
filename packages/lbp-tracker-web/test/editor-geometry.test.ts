import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  bandOf,
  barOfCell,
  boardCellAt,
  boardChipRect,
  boardRect,
  boardX,
  rectsMeet,
  noteName,
  onGrid,
  positionLabel,
  rollPitchAt,
  rollStepX,
  rollThirdsAt,
  rollX,
  rollY,
  segmentDistance,
  bestNoteWindow,
  snapThirds,
  timbreColour,
  type BoardLayout,
  type RollLayout,
} from '../src/editor/geometry.ts';

const board: BoardLayout = { cellW: 40, cellH: 30, gutter: 24, ruler: 18, cols: 10, rows: 4 };
const roll: RollLayout = { keys: 50, ruler: 20, stepW: 24, rowH: 12, steps: 32, triplets: false };
const tripletRoll: RollLayout = { ...roll, triplets: true };

test('board: a cell and its rectangle agree, and the gutter is not a cell', () => {
  const r = boardRect(board, 2, 1);
  assert.deepEqual(r, { x: 104, y: 48, w: 40, h: 30 });
  assert.deepEqual(boardCellAt(board, r.x + 1, r.y + 1), { cell: 2, row: 1 });
  assert.deepEqual(boardCellAt(board, r.x + r.w - 1, r.y + r.h - 1), { cell: 2, row: 1 });
  assert.equal(boardCellAt(board, 5, 40), null);
  assert.equal(boardCellAt(board, 100, 5), null);
  assert.equal(boardCellAt(board, 24 + 10 * 40 + 1, 40), null, 'past the last column');
  assert.equal(boardX(board, 16), 64, 'a cell is 16 steps');
  assert.equal(boardX(board, 8), 44);
});

test('board: rows band into channels the way channelVolume does', () => {
  // 13 rows, 2 channels: divisor 6, rows 0..5 -> 0, 6..11 -> 1, 12 -> clamped 1.
  assert.equal(bandOf(0, 13, 2), 0);
  assert.equal(bandOf(5, 13, 2), 0);
  assert.equal(bandOf(6, 13, 2), 1);
  assert.equal(bandOf(12, 13, 2), 1);
  // Fewer rows than channels: divisor 1, row is the channel, clamped.
  assert.equal(bandOf(2, 3, 6), 2);
  assert.equal(bandOf(7, 3, 6), 5);
  assert.equal(bandOf(4, 8, 1), 0);
});

test('roll: positions and pitches map both ways, pitch 127 at the top', () => {
  assert.equal(rollStepX(roll, 0), 50);
  assert.equal(rollStepX(roll, 1), 74);
  assert.equal(rollX(roll, 0), 62, 'a point on a step sits in the centre of the step');
  assert.equal(rollX(roll, 3), 86);
  assert.equal(rollX(roll, 1), 62, 'a point on a third sits in the centre of the third');
  assert.equal(rollX(tripletRoll, 0), 66, 'on the triplet grid a triplet cell is four thirds wide');
  assert.equal(rollX(tripletRoll, 4), 98);
  assert.equal(rollX(tripletRoll, 3), 86, 'a whole-step point off the triplet grid keeps its step centre');
  assert.equal(rollX(tripletRoll, 1), 62, 'and a stray third its third');
  assert.equal(rollThirdsAt(roll, 74), 3);
  assert.equal(rollThirdsAt(roll, 62), 1.5);
  assert.equal(rollY(roll, 127), 26, 'the top row\'s centre');
  assert.equal(rollY(roll, 0), 20 + 127.5 * 12);
  assert.equal(rollPitchAt(roll, 26), 127);
  assert.equal(rollPitchAt(roll, rollY(roll, 60)), 60);
  assert.equal(rollPitchAt(roll, -100), 127);
  assert.equal(rollPitchAt(roll, 1e6), 0);
});

test('snapThirds: the cell a position is in -- a step, or a third of a beat for triplets', () => {
  assert.equal(snapThirds(4, false, 32), 3);
  assert.equal(snapThirds(5.9, false, 32), 3, 'anywhere inside step 1 is step 1');
  assert.equal(snapThirds(6, false, 32), 6);
  assert.equal(snapThirds(3.9, true, 32), 0, 'a triplet cell is four thirds');
  assert.equal(snapThirds(4.4, true, 32), 4);
  assert.equal(snapThirds(11, true, 32), 8);
  assert.equal(snapThirds(12, true, 32), 12, 'three cells to the beat');
  assert.equal(snapThirds(-2, true, 32), 0);
  assert.equal(snapThirds(500, false, 32), 95, 'clamped to the last third of the last step');
  assert.equal(snapThirds(95.5, false, 32), 93, 'the last step, in whole-step mode');
  assert.equal(onGrid([{ thirds: 0 }, { thirds: 12 }], true), true);
  assert.equal(onGrid([{ thirds: 0 }, { thirds: 3 }], true), false, 'a whole step is not a triplet cell');
  assert.equal(onGrid([{ thirds: 0 }, { thirds: 4 }], false), false);
  assert.equal(onGrid([{ thirds: 8 }], false), false);
});

test('names and labels', () => {
  assert.equal(noteName(60), 'C4');
  assert.equal(noteName(61), 'C#4');
  assert.equal(noteName(0), 'C-1');
  assert.equal(noteName(127), 'G9');
  assert.equal(positionLabel(0), '1.1.1');
  assert.equal(positionLabel(3 * 9), '2.1.2', 'a bar is 8 steps');
  assert.equal(positionLabel(3 * 17), '3.1.2');
  assert.equal(positionLabel(3 * 4 + 1), '1.2.1+1/3');
  assert.equal(barOfCell(0), 1);
  assert.equal(barOfCell(3), 7, 'a cell is two bars');
});

test('colours and distances', () => {
  assert.equal(timbreColour(0), 'rgba(66, 140, 255, 1)');
  assert.equal(timbreColour(15), 'rgba(255, 140, 36, 1)');
  assert.equal(timbreColour(30, 0.5), 'rgba(255, 140, 36, 0.5)');
  assert.equal(segmentDistance(5, 5, 0, 0, 10, 0), 5);
  assert.equal(segmentDistance(20, 0, 0, 0, 10, 0), 10, 'past the end it is the distance to the end');
  assert.equal(segmentDistance(3, 4, 0, 0, 0, 0), 5, 'a zero-length segment is a point');
});

test('find the notes: the window that shows the most of them, not the middle of the range', () => {
  const view = { rows: 10, cols: 8, rowCount: 128, stepCount: 32 };
  // A bass cluster low down and one lonely note six octaves above it: the
  // midpoint of the range holds nothing at all.
  const bass = [0, 1, 2, 3].map((i) => ({ rowMin: 100 + i, rowMax: 100 + i, stepMin: i, stepMax: i }));
  const stray = { rowMin: 20, rowMax: 20, stepMin: 0, stepMax: 0 };
  const best = bestNoteWindow([...bass, stray], view, { row: 60, step: 0 });
  assert.equal(best.visible, 4, 'the four that can share a screen');
  assert.ok(best.row >= 94 && best.row <= 100, `the window holds the cluster, got ${best.row}`);

  // A tie leaves the view where the caller already was.
  const spread = [{ rowMin: 10, rowMax: 10, stepMin: 0, stepMax: 0 },
                  { rowMin: 90, rowMax: 90, stepMin: 0, stepMax: 0 }];
  assert.equal(bestNoteWindow(spread, view, { row: 85, step: 0 }).row, 85,
    'one note either way, so it stays put');

  // Everything visible at once when it fits.
  const tight = [{ rowMin: 40, rowMax: 42, stepMin: 1, stepMax: 3 },
                 { rowMin: 44, rowMax: 46, stepMin: 4, stepMax: 6 }];
  const all = bestNoteWindow(tight, view, { row: 0, step: 0 });
  assert.equal(all.visible, 2);

  // A note wider than the window is still counted from the origins that see part of it.
  const wide = [{ rowMin: 0, rowMax: 127, stepMin: 0, stepMax: 31 }];
  assert.equal(bestNoteWindow(wide, view, { row: 0, step: 0 }).visible, 1);
  assert.equal(bestNoteWindow([], view, { row: 7, step: 2 }).row, 7, 'no notes, no movement');
});

test('board: a chip is as long as its grid, and a rectangle catches it by touching it', () => {
  const chip = { cell: 2, row: 1, steps: 32 };
  assert.deepEqual(boardChipRect(board, chip), { x: 104, y: 48, w: 80, h: 30 });
  assert.deepEqual(boardChipRect(board, { ...chip, steps: 48 }), { x: 104, y: 48, w: 120, h: 30 });
  const r = boardChipRect(board, chip);
  assert.equal(rectsMeet({ x: 100, y: 40, w: 10, h: 10 }, r), true, 'a corner in');
  assert.equal(rectsMeet({ x: 0, y: 0, w: 500, h: 500 }, r), true, 'the chip inside');
  assert.equal(rectsMeet({ x: 184, y: 48, w: 10, h: 10 }, r), false, 'against the right edge is not a touch');
  assert.equal(rectsMeet({ x: 110, y: 78, w: 10, h: 10 }, r), false, 'against the bottom edge is not a touch');
  assert.equal(rectsMeet({ x: 120, y: 60, w: 0, h: 0 }, r), true, 'a point inside');
});
