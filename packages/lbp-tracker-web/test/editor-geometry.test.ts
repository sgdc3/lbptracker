import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  bandOf,
  barOfCell,
  boardCellAt,
  boardRect,
  boardX,
  noteName,
  positionLabel,
  rollPitchAt,
  rollStepX,
  rollThirdsAt,
  rollX,
  rollY,
  segmentDistance,
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
  assert.equal(rollX(tripletRoll, 0), 54, 'with a triplet grid every point is in its third');
  assert.equal(rollX(tripletRoll, 3), 78);
  assert.equal(rollThirdsAt(roll, 74), 3);
  assert.equal(rollThirdsAt(roll, 62), 1.5);
  assert.equal(rollY(roll, 127), 26, 'the top row\'s centre');
  assert.equal(rollY(roll, 0), 20 + 127.5 * 12);
  assert.equal(rollPitchAt(roll, 26), 127);
  assert.equal(rollPitchAt(roll, rollY(roll, 60)), 60);
  assert.equal(rollPitchAt(roll, -100), 127);
  assert.equal(rollPitchAt(roll, 1e6), 0);
});

test('snapThirds: the cell a position is in -- a step, or a third for triplets', () => {
  assert.equal(snapThirds(4, false, 32), 3);
  assert.equal(snapThirds(5.9, false, 32), 3, 'anywhere inside step 1 is step 1');
  assert.equal(snapThirds(6, false, 32), 6);
  assert.equal(snapThirds(4.4, true, 32), 4);
  assert.equal(snapThirds(4.9, true, 32), 4);
  assert.equal(snapThirds(-2, true, 32), 0);
  assert.equal(snapThirds(500, false, 32), 95, 'clamped to the last third of the last step');
  assert.equal(snapThirds(95.5, false, 32), 93, 'the last step, in whole-step mode');
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
