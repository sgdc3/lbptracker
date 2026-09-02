import { strict as assert } from 'node:assert';
import test from 'node:test';

import { boardCell } from '../src/core/level.ts';
import { boardToGrid } from '../src/core/project.ts';

/** Column-major, as `Serializer.matrix()` returns: column `i` is `4i..4i+2`. */
function transform(basis: number[][], translation: number[]): Float32Array {
  const m = new Float32Array(16);
  for (let i = 0; i < 3; i += 1) {
    m[i * 4] = basis[i][0];
    m[i * 4 + 1] = basis[i][1];
    m[i * 4 + 2] = basis[i][2];
  }
  m.set(translation, 12);
  m[15] = 1;
  return m;
}

const IDENTITY: number[][] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

test('a board square with the world is a plain translation delta', () => {
  const board = transform(IDENTITY, [1000, -2000, 30]);
  const child = transform(IDENTITY, [1000 + 52.5 * 7, -2000 - 52.5 * 3, 40]);
  const cell = boardCell(board, child);
  assert.ok(Math.abs(cell.x - 52.5 * 7) < 1e-3);
  assert.ok(Math.abs(cell.y + 52.5 * 3) < 1e-3);
});

/**
 * ⚠️ The case `dev/board-probe.ts` measures: one of the corpus's seven open
 * boards hangs on something rotated, and a bare translation delta puts its
 * components on fractional cells. Rotating the board must not move anything.
 */
test('a rotated board gives the same cell as an unrotated one', () => {
  const a = Math.PI / 5;
  const [c, s] = [Math.cos(a), Math.sin(a)];
  // The board turned about Z: its own axes stay its axes.
  const basis = [
    [c, s, 0],
    [-s, c, 0],
    [0, 0, 1],
  ];
  const origin = [-300, 900, 10];
  const board = transform(basis, origin);
  // A component seven steps right and three rows down *on the board*.
  const local = [52.5 * 7, -52.5 * 3, 10];
  const world = [
    origin[0] + basis[0][0] * local[0] + basis[1][0] * local[1],
    origin[1] + basis[0][1] * local[0] + basis[1][1] * local[1],
    origin[2] + local[2],
  ];
  const child = transform(basis, world);

  const cell = boardCell(board, child);
  assert.ok(Math.abs(cell.x - local[0]) < 1e-3, `x was ${cell.x}`);
  assert.ok(Math.abs(cell.y - local[1]) < 1e-3, `y was ${cell.y}`);
  assert.deepEqual(boardToGrid(cell.x, cell.y), boardToGrid(local[0], local[1]));

  // And the naive reading really is wrong here, which is why the frame change
  // is not optional.
  const naive = { x: world[0] - origin[0], y: world[1] - origin[1] };
  assert.ok(Math.abs(naive.x - local[0]) > 1);
});

/**
 * `RawDump.java` rotates by the *child's* inverse rotation, which agrees only
 * while a component lies flat against its board. Turn the component and the two
 * part company — the board's frame is the one that stays right.
 */
test('the board decides the frame, not the component', () => {
  const board = transform(IDENTITY, [0, 0, 0]);
  const a = Math.PI / 3;
  const [c, s] = [Math.cos(a), Math.sin(a)];
  const turned = [
    [c, s, 0],
    [-s, c, 0],
    [0, 0, 1],
  ];
  const child = transform(turned, [52.5 * 4, -52.5 * 2, 10]);
  const cell = boardCell(board, child);
  assert.ok(Math.abs(cell.x - 52.5 * 4) < 1e-3);
  assert.ok(Math.abs(cell.y + 52.5 * 2) < 1e-3);
});

test('a scaled board still lands on whole cells', () => {
  const scaled = [
    [2, 0, 0],
    [0, 2, 0],
    [0, 0, 2],
  ];
  const board = transform(scaled, [100, 100, 0]);
  const child = transform(scaled, [100 + 2 * 52.5 * 5, 100 - 2 * 52.5, 20]);
  const cell = boardCell(board, child);
  assert.ok(Math.abs(cell.x - 52.5 * 5) < 1e-3, `x was ${cell.x}`);
  assert.ok(Math.abs(cell.y + 52.5) < 1e-3, `y was ${cell.y}`);
});
