/**
 * The board: the sequencer's circuit board as a grid of cells, with one chip
 * per placed instrument, drawn on a canvas.
 *
 * ❗ **A canvas, not a `v-for`** -- a board is a few hundred chips on a grid
 * that scrolls and shows a playhead thirty times a second, which is what
 * steering/tracker-architecture.md says not to render as reactive components.
 * This class owns the drawing and the pointer; the page owns what a click
 * means for the rest of the screen, through the callbacks.
 *
 * A cell is a bar: 16 steps, four beats. A chip sits in one cell whatever its
 * grid's length, because that is how the game lays a board out -- clips of one
 * part overlap on the timeline every two cells in `Ascetic` -- and the extent
 * of its grid is drawn as a faint bar to its right so the overlap is visible.
 */

import { STEPS_PER_CELL } from '@lbptracker/cwlib/project.ts';
import type { Clip } from '@lbptracker/lib/song.ts';
import {
  bandOf,
  boardCellAt,
  boardRect,
  boardSize,
  boardX,
  type BoardLayout,
} from './geometry.ts';
import { MISSING_INSTRUMENT, drawGlyph, type InstrumentInfo } from './instruments.ts';
import { capture, release } from './pointer.ts';
import type { EditorState } from './state.ts';

export interface BoardCallbacks {
  /** Board coordinates to seek to; the page turns steps into frames. */
  onSeek(step: number): void;
  /** A chip was dropped on another cell; the page commits the move. */
  onMove(clip: Clip, to: { cell: number; row: number }): void;
  /** An empty cell was double-clicked: add the last-used instrument there. */
  onAddAt(at: { cell: number; row: number }): void;
  /** Which instrument a GUID is, for the colour and the glyph. */
  instrument(guid: number): InstrumentInfo | undefined;
}

const CELL_W = 44;
const CELL_H = 34;
const GUTTER = 30;
const RULER = 18;

export class BoardView {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly state: EditorState;
  private readonly cb: BoardCallbacks;
  private layout: BoardLayout = { cellW: CELL_W, cellH: CELL_H, gutter: GUTTER, ruler: RULER, cols: 24, rows: 8 };
  /** The playhead, in timeline steps, or null when there is nothing to show. */
  private playStep: number | null = null;
  private drag: {
    clip: Clip; startX: number; startY: number; at: { cell: number; row: number }; moved: boolean;
  } | null = null;
  private hover: { cell: number; row: number } | null = null;
  private frame = 0;

  constructor(canvas: HTMLCanvasElement, state: EditorState, cb: BoardCallbacks) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.state = state;
    this.cb = cb;
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('dblclick', this.onDouble);
    canvas.addEventListener('pointerleave', () => {
      this.hover = null;
      this.schedule();
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    state.onChange(() => this.schedule());
    this.schedule();
  }

  /** Move the playhead; `null` hides it. Cheap enough to call per tick. */
  setPlayhead(step: number | null): void {
    this.playStep = step;
    this.schedule();
  }

  /** The canvas x of a step, for the page to scroll the playhead into view. */
  xOfStep(step: number): number {
    return boardX(this.layout, step);
  }

  schedule(): void {
    if (this.frame) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  // ----------------------------------------------------------------- drawing

  private measure(): void {
    const song = this.state.song;
    let lastCell = 0;
    for (const clip of song.clips) {
      lastCell = Math.max(lastCell, clip.cell + Math.ceil(clip.steps / STEPS_PER_CELL));
    }
    if (this.state.selection.cursor) lastCell = Math.max(lastCell, this.state.selection.cursor.cell + 1);
    this.layout = {
      cellW: CELL_W, cellH: CELL_H, gutter: GUTTER, ruler: RULER,
      cols: Math.max(24, lastCell + 8),
      rows: Math.max(1, song.boardRows),
    };
    const { width, height } = boardSize(this.layout);
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)) {
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private draw(): void {
    this.measure();
    const { ctx, layout, state } = this;
    const song = state.song;
    const { width, height } = boardSize(layout);
    const styles = getComputedStyle(this.canvas);
    const ink = styles.getPropertyValue('--ink').trim() || '#e8eaee';
    const dim = styles.getPropertyValue('--dimmer').trim() || '#6e7684';
    const accent = styles.getPropertyValue('--accent').trim() || '#6fd3a0';

    ctx.clearRect(0, 0, width, height);

    // Channel bands: the board cut into NumChannels strips, alternately tinted.
    for (let row = 0; row < layout.rows; row += 1) {
      const band = bandOf(row, layout.rows, song.numChannels);
      const r = boardRect(layout, 0, row);
      ctx.fillStyle = band % 2 === 0 ? 'rgba(255,255,255,0.025)' : 'rgba(111,211,160,0.05)';
      ctx.fillRect(layout.gutter, r.y, width - layout.gutter, r.h);
    }

    // The grid.
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = 0; c <= layout.cols; c += 1) {
      const x = layout.gutter + c * layout.cellW + 0.5;
      ctx.moveTo(x, layout.ruler);
      ctx.lineTo(x, height);
    }
    for (let r = 0; r <= layout.rows; r += 1) {
      const y = layout.ruler + r * layout.cellH + 0.5;
      ctx.moveTo(layout.gutter, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();

    // The ruler: bar numbers, one per cell.
    ctx.fillStyle = dim;
    ctx.font = '10px ui-monospace, Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (let c = 0; c < layout.cols; c += 1) {
      if (c % 4 === 0 || layout.cellW > 36) {
        ctx.fillText(String(c + 1), layout.gutter + c * layout.cellW + 3, layout.ruler / 2);
      }
    }
    // The gutter: row numbers and the channel each row feeds.
    ctx.textAlign = 'right';
    for (let row = 0; row < layout.rows; row += 1) {
      const r = boardRect(layout, 0, row);
      ctx.fillStyle = dim;
      ctx.fillText(String(row), layout.gutter - 4, r.y + r.h / 2);
    }
    if (song.numChannels > 1) {
      ctx.textAlign = 'left';
      ctx.fillStyle = accent;
      let last = -1;
      for (let row = 0; row < layout.rows; row += 1) {
        const band = bandOf(row, layout.rows, song.numChannels);
        if (band === last) continue;
        last = band;
        const r = boardRect(layout, 0, row);
        ctx.fillText(`ch ${band}`, layout.gutter + 3, r.y + 7);
      }
    }

    // The grid extents first, so chips sit on top of them.
    for (const clip of song.clips) {
      const cells = clip.steps / STEPS_PER_CELL;
      if (cells <= 1) continue;
      const r = boardRect(layout, clip.cell, clip.row);
      const info = this.cb.instrument(clip.guid) ?? MISSING_INSTRUMENT;
      ctx.fillStyle = info.colour;
      ctx.globalAlpha = 0.16;
      ctx.fillRect(r.x + r.w, r.y + r.h * 0.35, (cells - 1) * layout.cellW - 2, r.h * 0.3);
      ctx.globalAlpha = 1;
    }

    // The chips.
    for (const clip of song.clips) {
      if (this.drag?.clip === clip && this.drag.moved) continue;
      this.drawChip(clip, clip.cell, clip.row, clip.id === state.selection.clipId, 1);
    }
    // The one being dragged, at the cell under the pointer.
    if (this.drag?.moved) {
      this.drawChip(this.drag.clip, this.drag.at.cell, this.drag.at.row, true, 0.85);
    }

    // The cursor: where the next instrument goes.
    const cursor = state.selection.cursor;
    if (cursor && !this.drag) {
      const r = boardRect(layout, cursor.cell, cursor.row);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(r.x + 2, r.y + 2, r.w - 4, r.h - 4);
      ctx.setLineDash([]);
    } else if (this.hover && !this.drag) {
      const r = boardRect(layout, this.hover.cell, this.hover.row);
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 1;
      ctx.strokeRect(r.x + 2.5, r.y + 2.5, r.w - 5, r.h - 5);
    }

    // The playhead.
    if (this.playStep !== null) {
      const x = boardX(layout, this.playStep);
      ctx.strokeStyle = ink;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
  }

  private drawChip(clip: Clip, cell: number, row: number, selected: boolean, alpha: number): void {
    const { ctx, layout } = this;
    const r = boardRect(layout, cell, row);
    const info = this.cb.instrument(clip.guid) ?? MISSING_INSTRUMENT;
    const pad = 2;
    ctx.globalAlpha = alpha;
    // Body.
    ctx.fillStyle = '#1b2027';
    ctx.strokeStyle = selected ? '#ffffff' : info.colour;
    ctx.lineWidth = selected ? 2 : 1.2;
    roundRect(ctx, r.x + pad, r.y + pad, r.w - pad * 2, r.h - pad * 2, 5);
    ctx.fill();
    ctx.stroke();
    // A colour bar at the top edge, the family's colour.
    ctx.fillStyle = info.colour;
    ctx.fillRect(r.x + pad + 3, r.y + pad + 2, r.w - pad * 2 - 6, 3);
    // The glyph.
    ctx.fillStyle = info.colour;
    ctx.strokeStyle = info.colour;
    const size = Math.min(r.w, r.h) * 0.62;
    drawGlyph(ctx, info.family, r.x + (r.w - size) / 2, r.y + pad + 6 + (r.h - pad * 2 - 9 - size) / 2 + 2, size);
    // A note count in the corner, when there is anything in the grid.
    if (clip.notes.length > 0) {
      ctx.fillStyle = 'rgba(232,234,238,0.75)';
      ctx.font = '8px ui-monospace, Consolas, monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(String(clip.notes.length), r.x + r.w - pad - 3, r.y + r.h - pad - 3);
    }
    ctx.globalAlpha = 1;
  }

  // ----------------------------------------------------------------- pointer

  private at(event: PointerEvent | MouseEvent): { x: number; y: number } {
    const box = this.canvas.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  private clipAt(cell: number, row: number): Clip | undefined {
    // The last one drawn is on top, so the last one found wins.
    let found: Clip | undefined;
    for (const clip of this.state.song.clips) if (clip.cell === cell && clip.row === row) found = clip;
    return found;
  }

  private onDown = (event: PointerEvent): void => {
    const { x, y } = this.at(event);
    if (y < this.layout.ruler && x >= this.layout.gutter) {
      this.cb.onSeek(((x - this.layout.gutter) / this.layout.cellW) * STEPS_PER_CELL);
      return;
    }
    const at = boardCellAt(this.layout, x, y);
    if (!at) return;
    const clip = this.clipAt(at.cell, at.row);
    if (event.button === 2) {
      if (clip) this.state.selectClip(clip.id);
      return;
    }
    if (clip) {
      this.state.selection.cursor = null;
      this.state.selectClip(clip.id);
      this.drag = { clip, startX: x, startY: y, at, moved: false };
      capture(this.canvas, event);
    } else {
      this.state.selection.cursor = at;
      this.state.touch('selection');
    }
    this.schedule();
  };

  private onMove = (event: PointerEvent): void => {
    const { x, y } = this.at(event);
    const at = boardCellAt(this.layout, x, y);
    if (this.drag) {
      if (!this.drag.moved && Math.hypot(x - this.drag.startX, y - this.drag.startY) > 4) this.drag.moved = true;
      if (at) this.drag.at = at;
      this.schedule();
      return;
    }
    const changed = (at?.cell !== this.hover?.cell) || (at?.row !== this.hover?.row);
    this.hover = at;
    if (changed) this.schedule();
  };

  private onUp = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    release(this.canvas, event);
    if (drag.moved && (drag.at.cell !== drag.clip.cell || drag.at.row !== drag.clip.row)) {
      this.cb.onMove(drag.clip, drag.at);
    }
    this.schedule();
  };

  private onDouble = (event: MouseEvent): void => {
    const { x, y } = this.at(event);
    const at = boardCellAt(this.layout, x, y);
    if (!at || this.clipAt(at.cell, at.row)) return;
    this.cb.onAddAt(at);
  };
}

function roundRect(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
