/**
 * What turns two world matrices into a circuit-board cell — measured.
 *
 *   node --experimental-strip-types packages/cwlib-ts/dev/board-probe.ts [dir]
 *
 * `boardCell` in `packages/cwlib-ts/src/level.ts` exists because an **open** circuit board
 * stores no `CompactComponent.x/y` at all: the components are Things in the
 * world and the cell has to come back out of the matrices. This script is the
 * evidence for the formula it uses, and it is here so the next session can
 * re-run it instead of trusting the comment.
 *
 * Two measurements, and the second is only meaningful because of the first:
 *
 *  1. **The pattern to match.** On closed boards every stored `x` is an exact
 *     multiple of 52.5 and every stored `y` is an **odd** multiple of it. The
 *     asymmetry is the layout: steps are 52.5 apart so an instrument can sit on
 *     any multiple, while rows are twice that and a component sits at the row's
 *     centre, which is always odd. That is the fingerprint a recovered
 *     coordinate has to reproduce, and it pins the origin and the scale at once:
 *     shift the origin, or scale it, and `y` stops being an odd integer.
 *  2. **Which candidate reproduces it** on the open boards, where only matrices
 *     exist. A bare translation delta is the obvious guess and it is measurably
 *     wrong; the delta expressed in the board's own basis is exact.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { boardCell, readLevel } from '../src/level.ts';
import { partReaders, type Microchip } from '../src/parts.ts';
import { nodeInflate } from '../src/platform/node.ts';

const DIR = process.argv[2] ?? 'C:/Users/sgdc3/Desktop/LBP/toolkit/tools/sequencerdump/data';
/** One horizontal step. Rows are `CELL_HEIGHT`, twice this — see `project.ts`. */
const CELL = 52.5;

type V3 = [number, number, number];
const tr = (m: Float32Array): V3 => [m[12], m[13], m[14]];
const col = (m: Float32Array, i: number): V3 => [m[i * 4], m[i * 4 + 1], m[i * 4 + 2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.sqrt(dot(a, a));

/** The delta in `m`'s basis. `norm` keeps any scale instead of undoing it. */
function inBasis(m: Float32Array, d: V3, norm: boolean): { x: number; y: number } {
  const axis = (i: number) => {
    const c = col(m, i);
    const s = norm ? len(c) : dot(c, c);
    return s === 0 ? 0 : dot(c, d) / s;
  };
  return { x: axis(0), y: axis(1) };
}

const CANDIDATES: Record<string, (b: Float32Array, c: Float32Array) => { x: number; y: number }> = {
  'translation delta, no frame change': (b, c) => {
    const d = sub(tr(c), tr(b));
    return { x: d[0], y: d[1] };
  },
  "the board's basis — what boardCell does": (b, c) => boardCell(b, c),
  "the board's basis, scale kept": (b, c) => inBasis(b, sub(tr(c), tr(b)), true),
  "the child's basis — the old Java tool": (b, c) => inBasis(c, sub(tr(c), tr(b)), true),
};

/** Is `v` a multiple of one cell, and an odd one if `odd` is asked for? */
function onCell(v: number, odd: boolean): { hit: boolean; off: number } {
  const cells = v / CELL;
  const near = Math.round(cells);
  const off = Math.abs(cells - near);
  return { hit: off < 1e-3 && (!odd || Math.abs(near) % 2 === 1), off };
}

let closed = 0;
let closedOdd = 0;
let openBoards = 0;
let rotatedBoards = 0;
let openPlacements = 0;
const score = new Map<string, { hits: number; worst: number }>();
for (const name of Object.keys(CANDIDATES)) score.set(name, { hits: 0, worst: 0 });

for (const entry of await readdir(DIR, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  let things;
  try {
    ({ things } = await readLevel(
      new Uint8Array(await readFile(path.join(DIR, entry.name))),
      nodeInflate,
      partReaders(),
    ));
  } catch {
    continue;
  }

  for (const thing of things) {
    if (!thing?.parts.get('SEQUENCER')) continue;
    const chip = thing.parts.get('MICROCHIP') as Microchip | undefined;
    if (!chip) continue;

    if (chip.components.length > 0) {
      for (const component of chip.components) {
        if (!component.thing?.parts.get('INSTRUMENT')) continue;
        closed += 1;
        if (onCell(component.x, false).hit && onCell(component.y, true).hit) closedOdd += 1;
      }
      continue;
    }

    const boardPos = chip.board?.parts.get('POS') as Float32Array | undefined;
    if (!boardPos) continue;
    openBoards += 1;
    // A board hanging square on the screen has its own axes as the world's.
    const x = col(boardPos, 0);
    const y = col(boardPos, 1);
    if (Math.abs(Math.abs(x[0]) - len(x)) > 1e-4 || Math.abs(Math.abs(y[1]) - len(y)) > 1e-4) {
      rotatedBoards += 1;
    }

    for (const child of things) {
      if (!child || child.parent !== chip.board || !child.parts.get('INSTRUMENT')) continue;
      const childPos = child.parts.get('POS') as Float32Array | undefined;
      if (!childPos) continue;
      openPlacements += 1;
      for (const [name, f] of Object.entries(CANDIDATES)) {
        const cell = f(boardPos, childPos);
        const cx = onCell(cell.x, false);
        const cy = onCell(cell.y, true);
        const stat = score.get(name)!;
        if (cx.hit && cy.hit) stat.hits += 1;
        stat.worst = Math.max(stat.worst, cx.off, cy.off);
      }
    }
  }
}

const pct = (n: number, of: number) => `${((100 * n) / (of || 1)).toFixed(2)}%`;
console.log(
  `
CLOSED boards: ${closed} instrument placements, ${pct(closedOdd, closed)} with x an exact ` +
    `multiple of ${CELL} and y an odd multiple of it — the pattern to reproduce`,
);
console.log(
  `\nOPEN boards: ${openBoards} of them (${rotatedBoards} not square with the world), ` +
    `${openPlacements} instrument children with a PPos`,
);
for (const [name, stat] of score) {
  console.log(
    `  ${name.padEnd(42)} on a cell ${pct(stat.hits, openPlacements).padStart(7)}` +
      `  worst fractional cell ${stat.worst.toFixed(4)}`,
  );
}
