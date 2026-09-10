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
 * A cell is 16 steps: half of one of the game's 105-unit board tiles, two of
 * its 8-step bars. A chip is a rectangle from its cell to the end of its grid
 * -- one tile for the default four bars, half a tile more per two bars -- so
 * the corpus's boards, chips two cells apart on a row, come out edge to edge.
 * Chips may overlap in time (55 of 72,726 corpus neighbours do); a translucent
 * body keeps the one underneath visible, and the selected one is drawn last.
 *
 * The pointer's vocabulary, the roll's wherever the two grids share a gesture:
 *
 * | on           | plain                                   | shift                                      | ctrl                   | right click |
 * |--------------|-----------------------------------------|--------------------------------------------|------------------------|-------------|
 * | empty        | the cursor; drag to draw a chip         | rectangle: the chips it touches (with ctrl: added to the block) | — | — |
 * | a chip       | select it alone and open it; drag it -- and the block it is in -- to move | rectangle; a click: in or out of the block | in or out of the block | open it |
 * | double-click | a four-bar chip where none is anchored  |                                            |                        |             |
 *
 * The block is `selection.clips` on the state. The page's keys act on it
 * (`daw/arrange.ts`: Delete, Ctrl+C, X, V, D and A), and a drag of any chip in
 * it moves the block as one, clamped to the board.
 *
 * ❗ **The canvas is the size of its viewport, like the roll's**: `Ascetic` is
 * 15,000 pixels wide, and the bar numbers and row numbers have to stay put
 * while the board scrolls either way, so the canvas is `position: sticky` in
 * a scroller whose spacer sets the scroll size, the content is drawn offset by
 * the scroll, and the ruler and the gutter are painted over it at the canvas's
 * own edges. The scroller is resizable in height and fixed in width.
 */

import { STEPS_PER_CELL } from '@lbptracker/cwlib/project.ts';
import {
  DEFAULT_CLIP_STEPS, clampClipShift, clipsEndCell, setSongEnd, snapClipSteps, songEndSteps,
  type Clip, type ClipShift,
} from '@lbptracker/lib/song.ts';
import {
  bandOf,
  boardCellAt,
  boardChipRect,
  boardRect,
  boardSize,
  boardX,
  barOfCell,
  rectsMeet,
  type BoardLayout,
  type Rect,
} from './geometry.ts';
import { drawnColour } from '@lbptracker/cwlib/chips.ts';
import { MISSING_INSTRUMENT, chipColour, drawIcon, type InstrumentInfo } from './instruments.ts';
import { capture, release } from './pointer.ts';
import { Follow } from './follow.ts';
import type { EditorState } from './state.ts';

export interface BoardCallbacks {
  /** Board coordinates to seek to; the page turns steps into frames. */
  onSeek(step: number): void;
  /**
   * Chips were dropped elsewhere: the block as it was selected, and the shift
   * it took, already clamped to the board. The page commits the move.
   */
  onMove(clips: readonly Clip[], shift: ClipShift): void;
  /**
   * A chip was drawn on empty cells -- a drag for its length, or a double-click
   * for the default -- and wants an instrument. The page asks.
   */
  onCreate(at: { cell: number; row: number; steps: number }): void;
  /** Which instrument a GUID is, for the colour and the glyph. */
  instrument(guid: number): InstrumentInfo | undefined;
  /** A chip was clicked -- not merely selected by the playhead. The page opens its panel. */
  onPick?(clip: Clip): void;
  /** The song's end was dragged to a step; the page commits it. */
  onEnd(step: number): void;
  /** The "+" under the last row. */
  onAddRow(): void;
  /** The "x" on the selected row's number. The page asks when the row holds chips. */
  onRemoveRow(row: number): void;
}

const CELL_W = 44;
/**
 * The horizontal zoom: how wide a cell is drawn, as a factor on `CELL_W`.
 * Rows keep their height; only time stretches. Chosen with the "- / +" in the
 * corner cell between the row numbers and the bar numbers, kept in
 * localStorage so the board opens the way it was left.
 */
const ZOOM_LEVELS = [0.4, 0.6, 0.8, 1, 1.35, 1.8, 2.5] as const;
const ZOOM_KEY = 'lbp.board-zoom';
const CELL_H = 34;
/** The gutter: the row number, then the mute and solo buttons. */
const GUTTER = 66;
const MUTE_X = 26;
const SOLO_X = 46;
const BUTTON_W = 17;
/** The strip under the last row that holds the "+" for another one. */
const ADD_STRIP = CELL_H;
/** How long a chip, and its row's number, stay lit after a note starts on it. */
const FLASH_MS = 260;
const RULER = 18;

export class BoardView {
  private readonly canvas: HTMLCanvasElement;
  private readonly scroller: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly state: EditorState;
  private readonly cb: BoardCallbacks;
  private layout: BoardLayout = { cellW: CELL_W, cellH: CELL_H, gutter: GUTTER, ruler: RULER, cols: 24, rows: 8 };
  private zoomIndex = ZOOM_LEVELS.indexOf(1);
  /** Which part of the corner cell the pointer is over: 0 out, 1 the glass, 2 in; null elsewhere. */
  private cornerHover: 0 | 1 | 2 | null = null;
  /** The playhead, in timeline steps, or null when there is nothing to show. */
  private playStep: number | null = null;
  /** Following the playhead, unless the person scrolled away from it. */
  private readonly follow: Follow;
  private drag:
    | {
        /** The block being dragged, by one chip of it. */
        kind: 'move'; clips: Clip[]; lead: Clip; startX: number; startY: number;
        /** Cells between the lead chip's own cell and the one it was grabbed by. */
        grab: number;
        /** Where the block would land: one shift for every chip in it, clamped to the board. */
        shift: ClipShift; moved: boolean;
      }
    /** Drawing a new chip: from the cell pressed to the cell under the pointer. */
    | { kind: 'create'; row: number; startCell: number; endCell: number; startX: number; moved: boolean }
    /** Dragging the song's end: the step it is at now. */
    | { kind: 'end'; step: number; moved: boolean }
    /**
     * A rectangle over the board: the chips it touches become the selection
     * when it is let go -- added to `base`, the selection before, with Ctrl.
     */
    | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number; base: Set<number> | null; moved: boolean }
    | null = null;
  private hover: { cell: number; row: number } | null = null;
  /** The pointer over the gutter: a row's number, or the "+" strip under the last row. */
  private gutterHover: number | null = null;
  /**
   * Notes starting as the playhead passes: the chip and the row light up for
   * a moment. Keyed by chip id and by row, valued with when the note began.
   * Found by scanning the song between two playhead positions, not from the
   * audio: what is drawn is the score, and it stays in step with the sound
   * to within a frame.
   */
  private readonly chipFlash = new Map<number, number>();
  private readonly rowFlash = new Map<number, number>();
  private lastPlayStep: number | null = null;
  /** The pointer is on the song's end marker. */
  private overEnd = false;
  private frame = 0;
  private bottomInset = 0;
  /** The accent colour as the stylesheet has it, read once per frame for the chips. */
  private accent = '#6fd3a0';

  constructor(
    canvas: HTMLCanvasElement,
    scroller: HTMLElement,
    spacer: HTMLElement,
    state: EditorState,
    cb: BoardCallbacks,
  ) {
    this.canvas = canvas;
    this.scroller = scroller;
    this.spacer = spacer;
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
      this.gutterHover = null;
      this.cornerHover = null;
      this.schedule();
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    scroller.addEventListener('scroll', () => this.schedule());
    try {
      const stored = Number(localStorage.getItem(ZOOM_KEY));
      const at = ZOOM_LEVELS.indexOf(stored as (typeof ZOOM_LEVELS)[number]);
      if (at >= 0) this.zoomIndex = at;
    } catch {
      // no storage: the default zoom
    }
    this.follow = new Follow(scroller, () => {
      if (this.playStep === null) return true;
      const x = this.xOfStep(this.playStep) - scroller.scrollLeft;
      return x >= this.layout.gutter && x <= scroller.clientWidth;
    });
    new ResizeObserver(() => this.schedule()).observe(scroller);
    state.onChange(() => this.schedule());
    this.schedule();
  }

  /** Move the playhead; `null` hides it. Cheap enough to call per frame. */
  setPlayhead(step: number | null): void {
    const last = this.lastPlayStep;
    this.playStep = step;
    this.lastPlayStep = step;
    // Forward by a little: the notes that began in between light their chips.
    // A seek, a loop or a stop skips the scan rather than lighting a bar's worth.
    if (step !== null && last !== null && step > last && step - last < 8) this.flashBetween(last, step);
    this.schedule();
  }

  private flashBetween(from: number, to: number): void {
    const now = performance.now();
    for (const clip of this.state.song.clips) {
      const start = clip.cell * STEPS_PER_CELL;
      if (start > to || start + clip.steps < from || !this.state.rowAudible(clip.row)) continue;
      for (const note of clip.notes) {
        const at = start + note.points[0]!.thirds / 3;
        if (at > from && at <= to) {
          this.chipFlash.set(clip.id, now);
          this.rowFlash.set(clip.row, now);
          break;
        }
      }
    }
  }

  /** How lit something is, 0..1, and gone from the map once dark. */
  private flashOf(map: Map<number, number>, key: number, now: number): number {
    const t0 = map.get(key);
    if (t0 === undefined) return 0;
    const a = 1 - (now - t0) / FLASH_MS;
    if (a <= 0) {
      map.delete(key);
      return 0;
    }
    return a;
  }

  /** The content x of a step, for the page to scroll the playhead into view. */
  xOfStep(step: number): number {
    return boardX(this.layout, step);
  }

  /**
   * How much of the view's bottom something else covers -- the chip panel --
   * so the board can scroll that far past its last row.
   */
  setBottomInset(px: number): void {
    if (this.bottomInset === px) return;
    this.bottomInset = px;
    this.schedule();
  }

  /** Keep a step in view while the song plays, unless the person scrolled away. */
  followStep(step: number): void {
    if (!this.follow.on) return;
    const x = this.xOfStep(step);
    const left = this.scroller.scrollLeft;
    const width = this.scroller.clientWidth;
    if (x - left > width - 30 || x - left < this.layout.gutter) {
      this.follow.scrollTo(Math.max(0, x - this.layout.gutter - 60));
    }
  }

  /** A seek or a play: follow again from wherever the view is. */
  followAgain(): void {
    this.follow.resume();
  }

  schedule(): void {
    if (this.frame) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
      // Anything still lit fades over the next frames.
      if (this.chipFlash.size > 0 || this.rowFlash.size > 0) this.schedule();
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
    if (this.drag?.kind === 'create') lastCell = Math.max(lastCell, this.drag.endCell + 2);
    if (this.drag?.kind === 'move' && this.drag.moved) {
      lastCell = Math.max(lastCell, clipsEndCell(this.drag.clips) + this.drag.shift.cells);
    }
    lastCell = Math.max(lastCell, Math.ceil((this.drag?.kind === 'end' ? this.drag.step : songEndSteps(song)) / STEPS_PER_CELL));
    this.layout = {
      cellW: Math.round(CELL_W * ZOOM_LEVELS[this.zoomIndex]), cellH: CELL_H, gutter: GUTTER, ruler: RULER,
      cols: Math.max(24, lastCell + 8),
      rows: Math.max(1, song.boardRows),
    };
    const full = boardSize(this.layout);
    const viewW = this.scroller.clientWidth;
    const viewH = this.scroller.clientHeight;
    this.spacer.style.width = `${full.width}px`;
    // Room to scroll past the last row by whatever covers the bottom of the
    // view, so a low row can be brought up from under the chip panel.
    this.spacer.style.height = `${Math.max(0, full.height + ADD_STRIP - viewH + this.bottomInset)}px`;
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(viewW * dpr) || this.canvas.height !== Math.round(viewH * dpr)) {
      this.canvas.width = Math.round(viewW * dpr);
      this.canvas.height = Math.round(viewH * dpr);
      this.canvas.style.width = `${viewW}px`;
      this.canvas.style.height = `${viewH}px`;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private draw(): void {
    this.measure();
    const { ctx, layout, state } = this;
    const flashNow = performance.now();
    const song = state.song;
    const { width, height } = boardSize(layout);
    const viewW = this.scroller.clientWidth;
    const viewH = this.scroller.clientHeight;
    const sx = this.scroller.scrollLeft;
    const sy = this.scroller.scrollTop;
    const styles = getComputedStyle(this.canvas);
    const ink = styles.getPropertyValue('--ink').trim() || '#e8eaee';
    const dim = styles.getPropertyValue('--dimmer').trim() || '#6e7684';
    const accent = styles.getPropertyValue('--accent').trim() || '#6fd3a0';
    this.accent = accent;

    ctx.clearRect(0, 0, viewW, viewH);

    // The content, in board coordinates offset by the scroll, clipped to the
    // area right of the gutter and below the ruler.
    ctx.save();
    ctx.beginPath();
    ctx.rect(layout.gutter, layout.ruler, viewW - layout.gutter, viewH - layout.ruler);
    ctx.clip();
    ctx.translate(-sx, -sy);

    // Channel bands: the board cut into NumChannels strips, alternately tinted;
    // and the selected row, the one the roll follows, lit across the board.
    for (let row = 0; row < layout.rows; row += 1) {
      const band = bandOf(row, layout.rows, song.numChannels);
      const r = boardRect(layout, 0, row);
      ctx.fillStyle = band % 2 === 0 ? 'rgba(255,255,255,0.025)' : 'rgba(111,211,160,0.05)';
      ctx.fillRect(layout.gutter, r.y, width - layout.gutter, r.h);
      if (row === state.selection.row) {
        ctx.fillStyle = 'rgba(111,211,160,0.13)';
        ctx.fillRect(layout.gutter, r.y, width - layout.gutter, r.h);
      }
    }
    // A line between one channel's band and the next, when there is more
    // than one: the mixer's cut through the board, made visible.
    if (song.numChannels > 1) {
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      for (let row = 1; row < layout.rows; row += 1) {
        if (bandOf(row, layout.rows, song.numChannels) === bandOf(row - 1, layout.rows, song.numChannels)) continue;
        const r = boardRect(layout, 0, row);
        ctx.fillRect(layout.gutter, r.y - 1, width - layout.gutter, 2);
      }
    }

    // The grid: rows, and the cells -- a firm line every tile (two cells,
    // the game's square), a faint one at the half.
    ctx.lineWidth = 1;
    for (let c = 0; c <= layout.cols; c += 1) {
      const x = layout.gutter + c * layout.cellW + 0.5;
      ctx.strokeStyle = c % 2 === 0 ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.05)';
      ctx.beginPath();
      ctx.moveTo(x, layout.ruler);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.beginPath();
    for (let r = 0; r <= layout.rows; r += 1) {
      const y = layout.ruler + r * layout.cellH + 0.5;
      ctx.moveTo(layout.gutter, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();
    if (song.numChannels > 1) {
      ctx.font = '10px ui-monospace, Consolas, monospace';
      ctx.textBaseline = 'middle';
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

    // The chips: each a rectangle as long as its grid. The selected ones are
    // drawn last so they sit on top of whatever they overlap, the roll's chip
    // just under them when it is not one of them.
    const lead = state.clip();
    const moving = this.drag?.kind === 'move' && this.drag.moved ? this.drag : null;
    const lifted = new Set(moving?.clips ?? []);
    const caught = this.drag?.kind === 'marquee' && this.drag.moved ? this.marqueeHits(this.drag) : null;
    const chosen = (clip: Clip) => state.selection.clips.has(clip.id) || (caught?.has(clip.id) ?? false);
    const heard = (clip: Clip) => (state.rowAudible(clip.row) ? 1 : 0.35);
    for (const clip of song.clips) {
      if (lifted.has(clip) || chosen(clip) || clip === lead) continue;
      this.drawChip(clip, clip.cell, clip.row, 'plain', heard(clip));
    }
    if (lead && !lifted.has(lead) && !chosen(lead)) this.drawChip(lead, lead.cell, lead.row, 'lead', heard(lead));
    for (const clip of song.clips) {
      if (lifted.has(clip) || !chosen(clip)) continue;
      this.drawChip(clip, clip.cell, clip.row, 'selected', heard(clip));
    }
    // The block being dragged, where it would land.
    if (moving) {
      for (const clip of moving.clips) {
        this.drawChip(clip, clip.cell + moving.shift.cells, clip.row + moving.shift.rows, 'selected', 0.85);
      }
    }
    // The rectangle being drawn, over the chips it is catching.
    if (this.drag?.kind === 'marquee' && this.drag.moved) {
      const r = this.marqueeRect(this.drag);
      ctx.fillStyle = 'rgba(111,211,160,0.1)';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w), Math.round(r.h));
      ctx.setLineDash([]);
    }
    // The one being drawn: its outline, as long as the drag so far.
    if (this.drag?.kind === 'create' && this.drag.moved) {
      const { cell, cells } = this.creating(this.drag);
      const r = boardRect(layout, cell, this.drag.row);
      ctx.strokeStyle = accent;
      ctx.fillStyle = 'rgba(111,211,160,0.12)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      roundRect(ctx, r.x + 2, r.y + 2, cells * layout.cellW - 4, r.h - 4, 5);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = accent;
      ctx.font = '10px ui-monospace, Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${(cells * STEPS_PER_CELL) / 8} bars`, r.x + 8, r.y + r.h / 2);
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

    // The end of the song: the end of the last chip, marked, and the board
    // beyond it shaded -- there is nothing there to play.
    const endStep = this.drag?.kind === 'end' ? this.drag.step : songEndSteps(song);
    const endX = boardX(layout, endStep);
    // An empty song has an end of its own (`NEW_SONG_END_STEPS`), so the
    // marker is there to drag before the first chip is placed; only an end
    // dragged back to the very start leaves nothing to mark.
    if (endStep > 0 || this.drag?.kind === 'end') {
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(endX, layout.ruler, width - endX, height - layout.ruler);
      ctx.strokeStyle = this.drag?.kind === 'end' || this.overEnd ? accent : 'rgba(232,234,238,0.45)';
      ctx.lineWidth = this.drag?.kind === 'end' || this.overEnd ? 2 : 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(Math.round(endX) + 0.5, layout.ruler);
      ctx.lineTo(Math.round(endX) + 0.5, height);
      ctx.stroke();
      ctx.setLineDash([]);
      // A grip at the top of the line, so it reads as something to drag.
      ctx.fillStyle = this.drag?.kind === 'end' || this.overEnd ? accent : 'rgba(232,234,238,0.6)';
      ctx.fillRect(Math.round(endX) - 4, layout.ruler, 9, 12);
    }

    // The playhead.
    if (this.playStep !== null) {
      const x = boardX(layout, this.playStep);
      ctx.strokeStyle = ink;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, layout.ruler);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    ctx.restore();

    // The gutter, over the content at the canvas's left edge: row numbers,
    // the selected row lit, scrolled with the rows but not with the columns.
    ctx.fillStyle = '#171b21';
    ctx.fillRect(0, layout.ruler, layout.gutter, viewH - layout.ruler);
    ctx.font = '10px ui-monospace, Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (let row = 0; row < layout.rows; row += 1) {
      const r = boardRect(layout, 0, row);
      const y = r.y - sy;
      if (y + r.h < layout.ruler || y > viewH) continue;
      if (row === state.selection.row) {
        ctx.fillStyle = 'rgba(111,211,160,0.13)';
        ctx.fillRect(0, y, layout.gutter, r.h);
        ctx.fillStyle = accent;
        ctx.fillRect(0, y, 3, r.h);
      }
      const lit = this.flashOf(this.rowFlash, row, flashNow);
      if (lit > 0) {
        ctx.fillStyle = `rgba(255,255,255,${(0.1 * lit).toFixed(3)})`;
        ctx.fillRect(0, y, MUTE_X - 2, r.h);
      }
      // The selected row's number turns into an "x" under the pointer: the
      // way to remove a row without a button that would widen the gutter.
      const removable = row === state.selection.row && this.gutterHover === row && layout.rows > 1;
      ctx.fillStyle = removable ? '#ef6b6b' : row === state.selection.row ? accent : dim;
      if (removable) {
        ctx.font = 'bold 12px ui-sans-serif, system-ui, sans-serif';
        ctx.fillText('\u00d7', MUTE_X - 5, y + r.h / 2 + 0.5);
        ctx.font = '10px ui-monospace, Consolas, monospace';
      } else {
        ctx.fillText(String(row), MUTE_X - 5, y + r.h / 2);
      }
      // Mute and solo: two small boxes, lit when on. A solo anywhere greys
      // the mute boxes, since solos outrank them.
      const muted = state.mutedRows.has(row);
      const solo = state.soloRows.has(row);
      const soloing = state.soloRows.size > 0;
      const box = (x: number, on: boolean, colour: string, label: string, faded: boolean) => {
        const bh = Math.min(16, r.h - 8);
        const by = y + (r.h - bh) / 2;
        ctx.fillStyle = on ? colour : 'rgba(255,255,255,0.06)';
        ctx.globalAlpha = faded ? 0.4 : 1;
        ctx.fillRect(x, by, BUTTON_W, bh);
        ctx.fillStyle = on ? '#0d1a14' : dim;
        ctx.textAlign = 'center';
        ctx.font = 'bold 9px ui-sans-serif, system-ui, sans-serif';
        ctx.fillText(label, x + BUTTON_W / 2, by + bh / 2 + 0.5);
        ctx.globalAlpha = 1;
        ctx.textAlign = 'right';
        ctx.font = '10px ui-monospace, Consolas, monospace';
      };
      box(MUTE_X, muted, '#ef6b6b', 'M', soloing && !solo);
      box(SOLO_X, solo, '#e3b341', 'S', false);
    }
    // Under the last row: a "+" for one more.
    {
      const y = layout.ruler + layout.rows * layout.cellH - sy;
      if (y < viewH) {
        const over = this.gutterHover === layout.rows;
        ctx.fillStyle = over ? 'rgba(111,211,160,0.18)' : 'rgba(255,255,255,0.04)';
        ctx.fillRect(4, y + 5, layout.gutter - 8, ADD_STRIP - 10);
        ctx.fillStyle = over ? accent : dim;
        ctx.font = 'bold 14px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('+', layout.gutter / 2, y + ADD_STRIP / 2 + 0.5);
        ctx.textAlign = 'right';
        ctx.font = '10px ui-monospace, Consolas, monospace';
      }
    }
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(layout.gutter - 1, layout.ruler, 1, viewH);

    // The ruler, over the content at the top edge: the game's bar numbers,
    // one per cell -- a cell is two bars -- scrolled with the columns only.
    ctx.fillStyle = '#171b21';
    ctx.fillRect(0, 0, viewW, layout.ruler);
    ctx.textAlign = 'left';
    for (let c = 0; c < layout.cols; c += 1) {
      const x = layout.gutter + c * layout.cellW - sx;
      if (x + layout.cellW < layout.gutter || x > viewW) continue;
      ctx.fillStyle = c % 2 === 0 ? dim : 'rgba(110,118,132,0.55)';
      ctx.fillText(String(barOfCell(c)), x + 3, layout.ruler / 2);
    }
    if (this.playStep !== null) {
      const x = boardX(layout, this.playStep) - sx;
      ctx.fillStyle = ink;
      ctx.fillRect(x - 1, 0, 2, layout.ruler);
    }
    ctx.fillStyle = '#171b21';
    ctx.fillRect(0, 0, layout.gutter, layout.ruler);
    this.drawCorner();
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(0, layout.ruler - 1, viewW, 1);
  }

  /** The corner cell: zoom out, the glass (back to 1:1), zoom in. */
  private drawCorner(): void {
    const { ctx, layout } = this;
    const third = layout.gutter / 3;
    const cy = layout.ruler / 2;
    const paint = (part: 0 | 1 | 2, enabled: boolean) => {
      if (this.cornerHover === part && enabled) {
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(part * third, 0, third, layout.ruler - 1);
      }
      ctx.fillStyle = enabled ? '#aab2bd' : 'rgba(170,178,189,0.3)';
      ctx.strokeStyle = ctx.fillStyle;
    };
    ctx.save();
    ctx.lineWidth = 1.4;
    ctx.lineCap = 'round';
    // "-"
    paint(0, this.zoomIndex > 0);
    ctx.beginPath();
    ctx.moveTo(third * 0.5 - 3.5, cy);
    ctx.lineTo(third * 0.5 + 3.5, cy);
    ctx.stroke();
    // The glass
    paint(1, this.zoomIndex !== ZOOM_LEVELS.indexOf(1));
    const gx = third * 1.5 - 1;
    ctx.beginPath();
    ctx.arc(gx, cy - 1, 3.6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(gx + 2.6, cy + 1.6);
    ctx.lineTo(gx + 5.5, cy + 4.5);
    ctx.stroke();
    // "+"
    paint(2, this.zoomIndex < ZOOM_LEVELS.length - 1);
    const px = third * 2.5;
    ctx.beginPath();
    ctx.moveTo(px - 3.5, cy);
    ctx.lineTo(px + 3.5, cy);
    ctx.moveTo(px, cy - 3.5);
    ctx.lineTo(px, cy + 3.5);
    ctx.stroke();
    ctx.restore();
  }

  /** Which third of the corner cell a canvas point is in, or null outside it. */
  private cornerPart(cx: number, cy: number): 0 | 1 | 2 | null {
    if (cx < 0 || cx >= this.layout.gutter || cy < 0 || cy >= this.layout.ruler) return null;
    return Math.min(2, Math.floor((cx / this.layout.gutter) * 3)) as 0 | 1 | 2;
  }

  /**
   * Change the zoom, keeping the step at the left edge of the view where it
   * is, so the bars in sight stay the bars in sight.
   */
  setZoom(index: number): void {
    const next = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, index));
    if (next === this.zoomIndex) return;
    const leftStep = ((this.scroller.scrollLeft) / this.layout.cellW) * STEPS_PER_CELL;
    this.zoomIndex = next;
    try {
      localStorage.setItem(ZOOM_KEY, String(ZOOM_LEVELS[next]));
    } catch {
      // no storage: this session only
    }
    this.measure();
    this.follow.scrollTo(Math.max(0, (leftStep / STEPS_PER_CELL) * this.layout.cellW));
    this.schedule();
  }

  get zoom(): number {
    return ZOOM_LEVELS[this.zoomIndex];
  }

  /**
   * One chip: a rectangle from its cell to the end of its grid, **the chip's
   * own tint** as a translucent body so that chips overlapping in time --
   * which the game allows and `Ascetic` does every two cells -- read as
   * stacked rather than hidden, with the glyph and the name at the cell it
   * sits in.
   *
   * ❗ The colour is the placement's `PInstrument.Colour`, which the game draws
   * and a composer sets. A chip nobody has tinted shows its instrument's own
   * colour -- either because it carries it, as every file below revision
   * `0x3ec` does, or through `drawnColour`, which is what white means -- so the
   * board reads by instrument family without being told to.
   */
  private drawChip(clip: Clip, cell: number, row: number, look: 'plain' | 'lead' | 'selected', alpha: number): void {
    const { ctx, layout } = this;
    const selected = look === 'selected';
    const r = boardRect(layout, cell, row);
    const cells = Math.max(1, clip.steps / STEPS_PER_CELL);
    const w = cells * layout.cellW;
    const info = this.cb.instrument(clip.guid) ?? MISSING_INSTRUMENT;
    const tint = chipColour(drawnColour(clip.guid, clip.colour));
    const pad = 2;
    ctx.globalAlpha = alpha;
    // Body: the chip's own tint, translucent, over a dark base.
    roundRect(ctx, r.x + pad, r.y + pad, w - pad * 2, r.h - pad * 2, 5);
    ctx.fillStyle = 'rgba(27,32,39,0.85)';
    ctx.fill();
    ctx.fillStyle = tint;
    ctx.globalAlpha = alpha * (selected ? 0.34 : 0.2);
    ctx.fill();
    const lit = this.flashOf(this.chipFlash, clip.id, performance.now());
    if (lit > 0) {
      ctx.fillStyle = '#ffffff';
      ctx.globalAlpha = alpha * 0.12 * lit;
      ctx.fill();
    }
    ctx.globalAlpha = alpha;
    // White for the block; the accent for the roll's chip when it is outside the block.
    ctx.strokeStyle = selected ? '#ffffff' : look === 'lead' ? this.accent : tint;
    ctx.lineWidth = selected ? 2 : look === 'lead' ? 1.6 : 1.2;
    ctx.stroke();
    // The glyph, in the first cell.
    ctx.fillStyle = tint;
    ctx.strokeStyle = tint;
    const size = r.h * 0.6;
    drawIcon(ctx, info, r.x + pad + 5, r.y + (r.h - size) / 2, size);
    // The name after it, clipped to the chip.
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x + pad, r.y + pad, w - pad * 2 - 14, r.h - pad * 2);
    ctx.clip();
    ctx.fillStyle = 'rgba(232,234,238,0.9)';
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(clip.name || info.name, r.x + pad + 5 + size + 5, r.y + r.h / 2);
    ctx.restore();
    // A note count in the corner, when there is anything in the grid.
    if (clip.notes.length > 0) {
      ctx.fillStyle = 'rgba(232,234,238,0.75)';
      ctx.font = '8px ui-monospace, Consolas, monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(String(clip.notes.length), r.x + w - pad - 3, r.y + r.h - pad - 3);
    }
    ctx.globalAlpha = 1;
  }

  // ----------------------------------------------------------------- pointer

  /** Content coordinates (`x`, `y`) and the canvas's own (`cx`, `cy`). */
  private at(event: PointerEvent | MouseEvent): { x: number; y: number; cx: number; cy: number } {
    const box = this.canvas.getBoundingClientRect();
    const cx = event.clientX - box.left;
    const cy = event.clientY - box.top;
    return { x: cx + this.scroller.scrollLeft, y: cy + this.scroller.scrollTop, cx, cy };
  }

  /** The chip anchored at a cell, if any. */
  private anchoredAt(cell: number, row: number): Clip | undefined {
    let found: Clip | undefined;
    for (const clip of this.state.song.clips) if (clip.cell === cell && clip.row === row) found = clip;
    return found;
  }

  /**
   * The chip under a cell: the one anchored there first, then a selected one
   * covering it (the block is drawn on top), then the roll's chip, then the
   * topmost cover.
   */
  private clipAt(cell: number, row: number): Clip | undefined {
    const anchored = this.anchoredAt(cell, row);
    if (anchored) return anchored;
    const covers = (clip: Clip) =>
      clip.row === row && cell >= clip.cell && cell < clip.cell + clip.steps / STEPS_PER_CELL;
    for (const clip of this.state.boardSelection()) if (covers(clip)) return clip;
    const lead = this.state.clip();
    if (lead && covers(lead)) return lead;
    let found: Clip | undefined;
    for (const clip of this.state.song.clips) if (covers(clip)) found = clip;
    return found;
  }

  /** Where a chip being drawn starts and how many cells it spans: two at least, then whole cells. */
  private creating(drag: { startCell: number; endCell: number }): { cell: number; cells: number } {
    const cell = Math.min(drag.startCell, drag.endCell);
    const span = Math.abs(drag.endCell - drag.startCell) + 1;
    return { cell, cells: snapClipSteps(span * STEPS_PER_CELL) / STEPS_PER_CELL };
  }

  /** The rectangle a marquee drag has drawn so far, in content pixels. */
  private marqueeRect(drag: { x0: number; y0: number; x1: number; y1: number }): Rect {
    return {
      x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1),
      w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0),
    };
  }

  /** The chips a marquee touches, on top of the selection it adds to. */
  private marqueeHits(drag: { x0: number; y0: number; x1: number; y1: number; base: Set<number> | null }): Set<number> {
    const rect = this.marqueeRect(drag);
    const hits = new Set(drag.base ?? []);
    for (const clip of this.state.song.clips) {
      if (rectsMeet(rect, boardChipRect(this.layout, clip))) hits.add(clip.id);
    }
    return hits;
  }

  /** A chip clicked: alone, unless it is in the block, which then stays and is led by it. */
  private pickChip(clip: Clip): void {
    const { clips } = this.state.selection;
    if (clips.has(clip.id)) this.state.selectClips(clips, clip.id);
    else this.state.selectClip(clip.id);
  }

  private onDown = (event: PointerEvent): void => {
    const { x, y, cx, cy } = this.at(event);
    if (cy < this.layout.ruler) {
      const part = this.cornerPart(cx, cy);
      if (part === 0) this.setZoom(this.zoomIndex - 1);
      else if (part === 1) this.setZoom(ZOOM_LEVELS.indexOf(1));
      else if (part === 2) this.setZoom(this.zoomIndex + 1);
      else if (cx >= this.layout.gutter) this.cb.onSeek(((x - this.layout.gutter) / this.layout.cellW) * STEPS_PER_CELL);
      return;
    }
    if (cx < this.layout.gutter) {
      // The gutter: the mute and solo boxes, the row number to select the row
      // (and, on the selected row, to remove it), or the "+" under the last.
      const row = Math.floor((y - this.layout.ruler) / this.layout.cellH);
      if (row === this.layout.rows && y - this.layout.ruler < this.layout.rows * this.layout.cellH + ADD_STRIP) {
        this.cb.onAddRow();
        return;
      }
      if (row < 0 || row >= this.layout.rows) return;
      if (cx >= MUTE_X && cx < MUTE_X + BUTTON_W) this.state.toggleMute(row);
      else if (cx >= SOLO_X && cx < SOLO_X + BUTTON_W) this.state.toggleSolo(row);
      else if (row === this.state.selection.row && this.layout.rows > 1) this.cb.onRemoveRow(row);
      else this.state.selectRow(row);
      return;
    }
    if (event.button === 0 && this.nearEnd(x)) {
      this.drag = { kind: 'end', step: songEndSteps(this.state.song), moved: false };
      capture(this.canvas, event);
      this.schedule();
      return;
    }
    const at = boardCellAt(this.layout, x, y);
    if (!at) return;
    if (event.button === 0 && event.shiftKey) {
      // A rectangle, wherever it starts: the chips it touches are the
      // selection when it is let go, added to the one there is with Ctrl.
      const add = event.ctrlKey || event.metaKey;
      this.drag = {
        kind: 'marquee', x0: x, y0: y, x1: x, y1: y,
        base: add ? new Set(this.state.selection.clips) : null, moved: false,
      };
      capture(this.canvas, event);
      this.schedule();
      return;
    }
    const clip = this.clipAt(at.cell, at.row);
    if (event.ctrlKey || event.metaKey) {
      // Ctrl on a chip puts it in the block or takes it out; nothing is dragged.
      if (clip && event.button === 0) this.state.toggleClip(clip.id);
      return;
    }
    if (event.button === 2) {
      if (clip) {
        this.pickChip(clip);
        this.cb.onPick?.(clip);
      }
      return;
    }
    if (clip) {
      this.state.selection.cursor = null;
      this.pickChip(clip);
      this.cb.onPick?.(clip);
      // Grabbed some cells into the chip: keep that offset while it is dragged,
      // and the rest of the block keeps its place around it.
      this.drag = {
        kind: 'move', clips: this.state.boardSelection(), lead: clip, startX: x, startY: y,
        grab: at.cell - clip.cell, shift: { cells: 0, rows: 0 }, moved: false,
      };
      capture(this.canvas, event);
    } else {
      this.state.selection.cursor = at;
      this.state.selectRow(at.row);
      // A drag from here draws a chip; a click leaves the cursor.
      this.drag = { kind: 'create', row: at.row, startCell: at.cell, endCell: at.cell, startX: x, moved: false };
      capture(this.canvas, event);
    }
    this.schedule();
  };

  private onMove = (event: PointerEvent): void => {
    const { x, y, cx, cy } = this.at(event);
    const at = cx < this.layout.gutter || cy < this.layout.ruler ? null : boardCellAt(this.layout, x, y);
    if (this.drag?.kind === 'move') {
      if (!this.drag.moved && Math.hypot(x - this.drag.startX, y - this.drag.startY) > 4) this.drag.moved = true;
      if (at) {
        const { lead, grab, clips } = this.drag;
        this.drag.shift = clampClipShift(
          clips, { cells: at.cell - grab - lead.cell, rows: at.row - lead.row }, this.layout.rows,
        );
      }
      this.schedule();
      return;
    }
    if (this.drag?.kind === 'marquee') {
      if (!this.drag.moved && Math.hypot(x - this.drag.x0, y - this.drag.y0) > 4) this.drag.moved = true;
      this.drag.x1 = x;
      this.drag.y1 = y;
      this.canvas.style.cursor = 'crosshair';
      this.schedule();
      return;
    }
    if (this.drag?.kind === 'end') {
      // Never onto the very start: on a song with chips `setSongEnd` reads a
      // cell as "back to the last chip" anyway, and on an empty one an end at
      // step 0 would take the marker away with no way to take hold of it again.
      const step = Math.max(1, Math.round((x - this.layout.gutter) / this.layout.cellW)) * STEPS_PER_CELL;
      if (step !== this.drag.step) {
        this.drag.step = step;
        this.drag.moved = true;
        this.schedule();
      }
      return;
    }
    if (this.drag?.kind === 'create') {
      if (!this.drag.moved && Math.abs(x - this.drag.startX) > 6) this.drag.moved = true;
      // Only the length follows the pointer: the chip stays on the row it started in.
      const cell = Math.max(0, Math.floor((x - this.layout.gutter) / this.layout.cellW));
      if (cell !== this.drag.endCell) {
        this.drag.endCell = cell;
        this.schedule();
      }
      return;
    }
    const overEnd = cy >= this.layout.ruler && cx >= this.layout.gutter && this.nearEnd(x);
    // Over the gutter: which row's number, or the "+" strip (numbered as the row after the last).
    let gutterHover: number | null = null;
    if (cx < this.layout.gutter && cy >= this.layout.ruler) {
      const row = Math.floor((y - this.layout.ruler) / this.layout.cellH);
      if (row === this.layout.rows) gutterHover = row;
      else if (row >= 0 && row < this.layout.rows && cx < MUTE_X) gutterHover = row;
    }
    const corner = this.cornerPart(cx, cy);
    const changed = (at?.cell !== this.hover?.cell) || (at?.row !== this.hover?.row)
      || overEnd !== this.overEnd || gutterHover !== this.gutterHover || corner !== this.cornerHover;
    this.hover = at;
    this.overEnd = overEnd;
    this.gutterHover = gutterHover;
    this.cornerHover = corner;
    const removable = gutterHover !== null && gutterHover === this.state.selection.row && this.layout.rows > 1;
    this.canvas.style.cursor = overEnd ? 'ew-resize'
      : (corner !== null || (gutterHover !== null && (removable || gutterHover === this.layout.rows))) ? 'pointer'
      : at && event.shiftKey ? 'crosshair' : '';
    if (changed) this.schedule();
  };

  /**
   * Within a few pixels of the song's end marker.
   *
   * ⚠️ The condition has to be the one `draw` marks the end under, or the
   * marker is there and cannot be grabbed. It was `clips.length > 0` in both
   * places; when an empty song was given an end of its own only the drawing
   * was changed, and the marker a new song shows went dead (0.2.6).
   */
  private nearEnd(x: number): boolean {
    const end = songEndSteps(this.state.song);
    if (end <= 0) return false;
    return Math.abs(x - boardX(this.layout, end)) <= 6;
  }

  private onUp = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    release(this.canvas, event);
    if (drag.kind === 'end') {
      if (drag.moved) this.cb.onEnd(drag.step);
    } else if (drag.kind === 'move') {
      if (drag.moved && (drag.shift.cells !== 0 || drag.shift.rows !== 0)) this.cb.onMove(drag.clips, drag.shift);
    } else if (drag.kind === 'marquee') {
      this.canvas.style.cursor = '';
      if (drag.moved) {
        this.state.selectClips(this.marqueeHits(drag));
      } else {
        // A Shift+click that never moved: the chip under it into the block, or out.
        const at = boardCellAt(this.layout, drag.x0, drag.y0);
        const clip = at && this.clipAt(at.cell, at.row);
        if (clip) this.state.toggleClip(clip.id);
      }
    } else if (drag.moved) {
      const { cell, cells } = this.creating(drag);
      this.cb.onCreate({ cell, row: drag.row, steps: cells * STEPS_PER_CELL });
    }
    this.schedule();
  };

  private onDouble = (event: MouseEvent): void => {
    const { x, y, cx, cy } = this.at(event);
    if (cx < this.layout.gutter || cy < this.layout.ruler) return;
    const at = boardCellAt(this.layout, x, y);
    // Anchored, not covered: a chip may start under another's tail, as the
    // game's boards do.
    if (!at || this.anchoredAt(at.cell, at.row)) return;
    this.cb.onCreate({ ...at, steps: DEFAULT_CLIP_STEPS });
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
