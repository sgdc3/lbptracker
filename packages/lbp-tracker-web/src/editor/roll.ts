/**
 * The piano roll: one placement's note grid, drawn on a canvas.
 *
 * What it draws is the game's own picture of a note: a chain of control
 * points joined by straight lines, each point's size its volume and its
 * colour its timbre -- blue at 0, orange at 15 -- with a keyboard down the
 * left and a step grid that can be switched between whole steps and thirds.
 * The engine glides linearly between consecutive points, so the straight
 * line is not a drawing convention: it is what will sound -- and the line
 * carries the glide, swelling with the volume and shifting hue with the
 * timbre from one point to the next.
 *
 * ❗ **A canvas the size of the viewport, not of the grid.** 128 pitch rows by
 * 128 steps is a 3,000 by 1,700 pixel surface, twice that on a high-density
 * screen, and the playhead redraws thirty times a second; so the canvas is
 * `position: sticky` inside a scroller whose spacer sets the scroll size, and
 * only the visible window is painted, offset by the scroll. The keyboard and
 * the ruler are painted over the content at the canvas's own edges, which is
 * what makes them stay put.
 *
 * The pointer's vocabulary, all of it visible in the hint under the grid:
 *
 * | on              | plain             | shift            | alt              | right click |
 * |-----------------|-------------------|------------------|------------------|-------------|
 * | empty           | draw a note; drag for its end | rectangle (ctrl too: add to the selection) | — | — |
 * | a point         | move it, or the whole selection when there is one | volume (up/down) | timbre (up/down) | delete it |
 * | a line          | move the note, or the whole selection | —          | —                | delete note |
 * | double-click    | line: add a point; point: delete it                    |             |
 *
 * Ctrl on a point or a line adds that note to the selection, or takes it out.
 * The rectangle catches a note by a point inside it **or by a line crossing
 * it**, so a held note is caught by a rectangle drawn across its middle.
 *
 * The commands the page's keys reach are at the end of the class:
 * `deleteSelection`, `nudge`, `adjust`, `selectAll`, `copy`, `cut`, `paste`,
 * `duplicateSelection`.
 */

import {
  addNote,
  addPoint,
  lastThirds,
  moveNote,
  movePoint,
  removeNote,
  removePoint,
  sortPoints,
  type Clip,
  type SongNote,
  type SongPoint,
} from '@lbptracker/lib/song.ts';
import {
  PITCHES,
  STEPS_PER_BAR,
  TRIPLET_THIRDS,
  gridUnit,
  isBlackKey,
  noteName,
  bestNoteWindow,
  onGrid,
  pointLineHalf,
  pointRadius,
  positionLabel,
  rollPitchAt,
  rollSize,
  rollStepX,
  rollThirdsAt,
  rollX,
  rollY,
  segmentDistance,
  segmentMeetsRect,
  snapThirds,
  timbreColour,
  type RollLayout,
} from './geometry.ts';
import { capture, release } from './pointer.ts';
import { Follow } from './follow.ts';
import type { EditorState } from './state.ts';

export interface RollCallbacks {
  /** The ruler was clicked: a step within the clip. */
  onSeek(stepInClip: number): void;
  /** A note was placed or clicked: play it. */
  onAudition(clip: Clip, note: SongNote): void;
  /** A key on the keyboard was pressed: play that pitch on the clip's instrument. */
  onAuditionPitch(clip: Clip, pitch: number): void;
  /** Something to say under the grid about what is under the pointer. */
  onHover(text: string): void;
}

const KEYS = 56;
const RULER = 20;
const STEP_W = 22;
const ROW_H = 13;
const HIT = 4;

type Drag =
  | { mode: 'create'; note: SongNote; startThirds: number; startPitch: number; extended: boolean }
  | { mode: 'point'; note: SongNote; point: SongPoint; moved: boolean; lastThirds: number; lastPitch: number }
  | { mode: 'volume' | 'timbre'; note: SongNote; point: SongPoint; startY: number; startValue: number; moved: boolean }
  | { mode: 'note'; notes: SongNote[]; startThirds: number; startPitch: number; lastThirds: number; lastPitch: number; moved: boolean }
  | { mode: 'marquee'; x0: number; y0: number; x1: number; y1: number; add: boolean };

export class RollView {
  private readonly canvas: HTMLCanvasElement;
  private readonly scroller: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly state: EditorState;
  private readonly cb: RollCallbacks;
  private layout: RollLayout = { keys: KEYS, ruler: RULER, stepW: STEP_W, rowH: ROW_H, steps: 32, triplets: false };
  private playStep: number | null = null;
  /** Following the playhead, unless the person scrolled away from it. */
  private readonly follow: Follow;
  private drag: Drag | null = null;
  private hoverPitch: number | null = null;
  private heldKey: number | null = null;
  private frame = 0;
  private lastClipId: number | null = null;
  /** Notes copied with Ctrl+C, relative to their first position. */
  private clipboard: SongNote[] = [];
  /** Where they were lifted from, so a cut and a paste put them back. */
  private clipboardAt = 0;

  constructor(
    canvas: HTMLCanvasElement,
    scroller: HTMLElement,
    spacer: HTMLElement,
    state: EditorState,
    cb: RollCallbacks,
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
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerleave', () => {
      this.hoverPitch = null;
      this.cb.onHover('');
      this.schedule();
    });
    scroller.addEventListener('scroll', () => this.schedule());
    this.follow = new Follow(scroller, () => {
      if (this.playStep === null) return true;
      const x = rollStepX(this.layout, this.playStep) - scroller.scrollLeft;
      return x >= this.layout.keys && x <= scroller.clientWidth;
    });
    new ResizeObserver(() => this.schedule()).observe(scroller);
    state.onChange(() => {
      const clip = state.clip();
      if ((clip?.id ?? null) !== this.lastClipId) {
        this.lastClipId = clip?.id ?? null;
        // A new clip: put its notes in view rather than whatever row was there.
        window.requestAnimationFrame(() => this.scrollToNotes());
      }
      this.schedule();
    });
    this.schedule();
  }

  setPlayhead(stepInClip: number | null): void {
    if (this.playStep === stepInClip) return;
    this.playStep = stepInClip;
    this.schedule();
  }

  schedule(): void {
    if (this.frame) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  /**
   * Put the notes in view: **the window that holds the most of them**.
   *
   * ⚠️ Centring the pitch range is not the same thing and was what this did.
   * A clip whose bass sits at C1 and whose hats sit at C7 has a midpoint no
   * note is anywhere near, so "find the notes" landed on an empty band with
   * the music off both edges. `bestNoteWindow` counts what each scroll
   * position would actually show and takes the best, and it moves nothing when
   * a tie means the old centring was as good.
   */
  scrollToNotes(): void {
    const clip = this.state.clip();
    this.measure();
    const layout = this.layout;
    const viewH = this.scroller.clientHeight - layout.ruler;
    const viewW = this.scroller.clientWidth - layout.keys;
    if (!clip || !clip.notes.length) {
      // Nothing to find: middle C in the middle, as an empty grid always did.
      this.scroller.scrollTop = Math.max(0, rollY(layout, 60) - this.scroller.clientHeight / 2);
      this.scroller.scrollLeft = 0;
      return;
    }
    const boxes = clip.notes.map((n) => {
      let lo = 127;
      let hi = 0;
      let first = Infinity;
      let last = 0;
      for (const p of n.points) {
        lo = Math.min(lo, p.pitch);
        hi = Math.max(hi, p.pitch);
        first = Math.min(first, p.thirds);
        last = Math.max(last, p.thirds);
      }
      return {
        rowMin: PITCHES - 1 - hi,
        rowMax: PITCHES - 1 - lo,
        stepMin: Math.floor(first / 3),
        stepMax: Math.floor(last / 3),
      };
    });
    // Where the old rule would have gone, which is where a tie stays.
    const midPitch = boxes.reduce((m, b) => m + (b.rowMin + b.rowMax) / 2, 0) / boxes.length;
    const best = bestNoteWindow(
      boxes,
      {
        rows: Math.max(1, Math.floor(viewH / layout.rowH)),
        cols: Math.max(1, Math.floor(viewW / layout.stepW)),
        rowCount: PITCHES,
        stepCount: layout.steps,
      },
      {
        row: Math.max(0, Math.round(midPitch - viewH / layout.rowH / 2)),
        step: 0,
      },
    );
    this.scroller.scrollTop = Math.max(0, best.row * layout.rowH);
    this.scroller.scrollLeft = Math.max(0, best.step * layout.stepW);
  }

  /** Keep a step in view while the song plays. */
  followStep(stepInClip: number): void {
    if (!this.follow.on) return;
    const x = rollStepX(this.layout, stepInClip);
    const left = this.scroller.scrollLeft;
    const width = this.scroller.clientWidth;
    if (x - left > width - 40 || x - left < this.layout.keys) {
      this.follow.scrollTo(Math.max(0, x - this.layout.keys - 40));
    }
  }

  /** A seek or a play: follow again from wherever the view is. */
  followAgain(): void {
    this.follow.resume();
  }

  // ----------------------------------------------------------------- drawing

  private measure(): void {
    const clip = this.state.clip();
    this.layout = { ...this.layout, steps: clip?.steps ?? 32, triplets: this.state.triplets };
    const full = rollSize(this.layout);
    const viewW = this.scroller.clientWidth;
    const viewH = this.scroller.clientHeight;
    this.spacer.style.width = `${full.width}px`;
    this.spacer.style.height = `${Math.max(0, full.height - viewH)}px`;
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
    const clip = state.clip();
    const viewW = this.scroller.clientWidth;
    const viewH = this.scroller.clientHeight;
    const sx = this.scroller.scrollLeft;
    const sy = this.scroller.scrollTop;
    const styles = getComputedStyle(this.canvas);
    const ink = styles.getPropertyValue('--ink').trim() || '#e8eaee';
    const dim = styles.getPropertyValue('--dimmer').trim() || '#6e7684';
    const accent = styles.getPropertyValue('--accent').trim() || '#6fd3a0';

    ctx.clearRect(0, 0, viewW, viewH);
    if (!clip) {
      ctx.fillStyle = dim;
      ctx.font = '13px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('select an instrument on the board to edit its notes', viewW / 2, viewH / 2);
      return;
    }

    // The visible pitch rows and step columns.
    const rowTop = Math.max(0, Math.floor((sy) / layout.rowH));
    const rowBottom = Math.min(PITCHES - 1, Math.ceil((sy + viewH) / layout.rowH));
    const stepLeft = Math.max(0, Math.floor((sx) / layout.stepW));
    const stepRight = Math.min(layout.steps, Math.ceil((sx + viewW) / layout.stepW));

    // Row shading: black-key rows darker, as the game's grid does.
    for (let row = rowTop; row <= rowBottom; row += 1) {
      const pitch = PITCHES - 1 - row;
      const y = layout.ruler + row * layout.rowH - sy;
      ctx.fillStyle = isBlackKey(pitch) ? 'rgba(0,0,0,0.22)' : 'rgba(255,255,255,0.025)';
      ctx.fillRect(layout.keys, y, viewW - layout.keys, layout.rowH);
      if (pitch % 12 === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.09)';
        ctx.fillRect(layout.keys, y + layout.rowH - 1, viewW - layout.keys, 1);
      }
    }

    // The grid's lines: every beat firmer, every 8-step bar firm, and between
    // them the cells -- steps, or with the grid set to triplets the three
    // four-third cells of each beat, which is why that grid is sparser.
    ctx.lineWidth = 1;
    for (let step = stepLeft; step <= stepRight; step += 1) {
      const bar = step % STEPS_PER_BAR === 0;
      const beat = step % 4 === 0;
      if (bar || beat || !state.triplets) {
        const x = Math.round(rollStepX(layout, step) - sx) + 0.5;
        ctx.strokeStyle = bar ? 'rgba(255,255,255,0.28)' : beat ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.08)';
        ctx.beginPath();
        ctx.moveTo(x, layout.ruler);
        ctx.lineTo(x, viewH);
        ctx.stroke();
      }
      if (state.triplets && beat && step < layout.steps) {
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        for (const cell of [1, 2]) {
          const tx = Math.round(rollStepX(layout, step + (cell * TRIPLET_THIRDS) / 3) - sx) + 0.5;
          ctx.beginPath();
          ctx.moveTo(tx, layout.ruler);
          ctx.lineTo(tx, viewH);
          ctx.stroke();
        }
      }
    }
    // Past the clip's end there is nothing to place a note on.
    const endX = rollStepX(layout, layout.steps) - sx;
    if (endX < viewW) {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(endX, layout.ruler, viewW - endX, viewH - layout.ruler);
    }

    // The notes: lines first so points sit on top.
    ctx.save();
    ctx.beginPath();
    ctx.rect(layout.keys, layout.ruler, viewW - layout.keys, viewH - layout.ruler);
    ctx.clip();
    const selected = state.selection.noteIds;
    const sel = state.selection.point;
    const px = (t: number) => rollX(layout, t) - sx;
    const py = (p: number) => rollY(layout, p) - sy;
    /**
     * A note that is not on this grid's cells is drawn through: on the
     * triplet grid a note with a point off the four-third cells, on the
     * whole-step grid one with a point on a third. It is still there and
     * still editable, it is just not what this grid is for.
     */
    const dimmed = (note: SongNote) => !onGrid(note.points, state.triplets);
    for (const note of clip.notes) {
      const on = selected.has(note.id);
      const pts = note.points;
      const fade = dimmed(note) ? 0.3 : 1;
      /**
       * A segment is drawn as a ribbon, not a stroke: its half-width at each
       * end is that point's volume (`pointLineHalf`) and its colour at each
       * end that point's timbre, so it swells and shifts hue exactly as the
       * engine's gliding volume and modulation do between the two -- the
       * engine ramps the modulation as it ramps the volume
       * (steering/synth-engine.md, the slide rates at `+0x2c`).
       */
      const weight = on ? 1.35 : 1;
      const alpha = (on ? 1 : 0.8) * fade;
      for (let i = 0; i < pts.length - 1; i += 1) {
        const a = pts[i];
        const b = pts[i + 1];
        const ax = px(a.thirds);
        const ay = py(a.pitch);
        const bx = px(b.thirds);
        const by = py(b.pitch);
        const dx = bx - ax;
        const dy = by - ay;
        const len = Math.hypot(dx, dy);
        if (len === 0) continue;
        // The normal, to offset each end by its own half-width.
        const nx = (-dy / len) * weight;
        const ny = (dx / len) * weight;
        const ha = pointLineHalf(a.volume, layout.rowH);
        const hb = pointLineHalf(b.volume, layout.rowH);
        if (a.timbre === b.timbre) {
          ctx.fillStyle = timbreColour(a.timbre, alpha);
        } else {
          // Only the 3.9% of notes that automate the timbre pay for a gradient.
          const grad = ctx.createLinearGradient(ax, ay, bx, by);
          grad.addColorStop(0, timbreColour(a.timbre, alpha));
          grad.addColorStop(1, timbreColour(b.timbre, alpha));
          ctx.fillStyle = grad;
        }
        ctx.beginPath();
        ctx.moveTo(ax + nx * ha, ay + ny * ha);
        ctx.lineTo(bx + nx * hb, by + ny * hb);
        ctx.lineTo(bx - nx * hb, by - ny * hb);
        ctx.lineTo(ax - nx * ha, ay - ny * ha);
        ctx.closePath();
        ctx.fill();
      }
      // ⚠️ Nothing past the last point. The gate closes a step after it, but
      // the game draws no tail: a note's end IS its last point, and a note of
      // one record is one point. A faint tail drawn here read as a second
      // point that was not there, and the owner had it removed.
    }
    for (const note of clip.notes) {
      const on = selected.has(note.id);
      const fade = dimmed(note) ? 0.3 : 1;
      note.points.forEach((p, i) => {
        const r = pointRadius(p.volume, layout.rowH);
        const x = px(p.thirds);
        const y = py(p.pitch);
        ctx.fillStyle = timbreColour(p.timbre, fade);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        if (i === 0) {
          // The note-on carries a darker core so a chain reads left to right.
          ctx.fillStyle = `rgba(0,0,0,${0.35 * fade})`;
          ctx.beginPath();
          ctx.arc(x, y, Math.max(1, r * 0.4), 0, Math.PI * 2);
          ctx.fill();
        }
        if (on) {
          ctx.strokeStyle = sel && sel.noteId === note.id && sel.index === i ? accent : '#ffffff';
          ctx.lineWidth = sel && sel.noteId === note.id && sel.index === i ? 2.5 : 1.5;
          ctx.beginPath();
          ctx.arc(x, y, r + 1.5, 0, Math.PI * 2);
          ctx.stroke();
        }
      });
    }
    // The marquee.
    if (this.drag?.mode === 'marquee') {
      const d = this.drag;
      ctx.strokeStyle = accent;
      ctx.fillStyle = 'rgba(111,211,160,0.08)';
      ctx.lineWidth = 1;
      const x0 = Math.min(d.x0, d.x1) - sx;
      const y0 = Math.min(d.y0, d.y1) - sy;
      ctx.fillRect(x0, y0, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    }
    // The playhead.
    if (this.playStep !== null && this.playStep >= 0 && this.playStep <= layout.steps) {
      const x = rollStepX(layout, this.playStep) - sx;
      ctx.strokeStyle = ink;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, layout.ruler);
      ctx.lineTo(x, viewH);
      ctx.stroke();
    }
    ctx.restore();

    // The keyboard, over the content, at the canvas's left edge.
    for (let row = rowTop; row <= rowBottom; row += 1) {
      const pitch = PITCHES - 1 - row;
      const y = layout.ruler + row * layout.rowH - sy;
      const black = isBlackKey(pitch);
      const held = this.heldKey === pitch;
      ctx.fillStyle = held ? accent : black ? '#1a1f26' : '#dfe4ea';
      ctx.fillRect(0, y, layout.keys - 1, layout.rowH - 1);
      if (pitch % 12 === 0 || this.hoverPitch === pitch) {
        ctx.fillStyle = black ? '#c8d0d8' : '#3a424c';
        ctx.font = '9px ui-monospace, Consolas, monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(noteName(pitch), layout.keys - 5, y + layout.rowH / 2);
      }
    }
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(layout.keys - 1, layout.ruler, 1, viewH);

    // The ruler, over the content, at the top edge: bars and beats.
    ctx.fillStyle = '#171b21';
    ctx.fillRect(0, 0, viewW, layout.ruler);
    ctx.fillStyle = dim;
    ctx.font = '10px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let step = stepLeft; step < stepRight; step += 4) {
      const x = rollStepX(layout, step) - sx;
      if (x < layout.keys) continue;
      const bar = Math.floor(step / STEPS_PER_BAR) + 1;
      const beat = ((step % STEPS_PER_BAR) / 4) + 1;
      ctx.fillStyle = beat === 1 ? ink : dim;
      ctx.fillText(beat === 1 ? `${bar}` : `${bar}.${beat}`, x + 3, layout.ruler / 2);
    }
    ctx.fillStyle = '#171b21';
    ctx.fillRect(0, 0, layout.keys, layout.ruler);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(0, layout.ruler - 1, viewW, 1);
  }

  // ------------------------------------------------------------ hit testing

  /** Canvas coordinates to content coordinates. */
  private at(event: MouseEvent): { x: number; y: number; cx: number; cy: number } {
    const box = this.canvas.getBoundingClientRect();
    const cx = event.clientX - box.left;
    const cy = event.clientY - box.top;
    return { x: cx + this.scroller.scrollLeft, y: cy + this.scroller.scrollTop, cx, cy };
  }

  private hitPoint(clip: Clip, x: number, y: number): { note: SongNote; point: SongPoint; index: number } | null {
    // Topmost drawn last, so search backwards; selected notes first so a
    // point can be grabbed out from under an overlapping note.
    const order = [...clip.notes].sort((a, b) =>
      Number(this.state.selection.noteIds.has(a.id)) - Number(this.state.selection.noteIds.has(b.id)));
    for (let n = order.length - 1; n >= 0; n -= 1) {
      const note = order[n];
      for (let i = note.points.length - 1; i >= 0; i -= 1) {
        const p = note.points[i];
        const r = pointRadius(p.volume, this.layout.rowH) + HIT;
        if (Math.hypot(rollX(this.layout, p.thirds) - x, rollY(this.layout, p.pitch) - y) <= r) {
          return { note, point: p, index: i };
        }
      }
    }
    return null;
  }

  private hitLine(clip: Clip, x: number, y: number): { note: SongNote; segment: number } | null {
    for (let n = clip.notes.length - 1; n >= 0; n -= 1) {
      const note = clip.notes[n];
      const pts = note.points;
      for (let i = 0; i < pts.length - 1; i += 1) {
        const d = segmentDistance(
          x, y,
          rollX(this.layout, pts[i].thirds), rollY(this.layout, pts[i].pitch),
          rollX(this.layout, pts[i + 1].thirds), rollY(this.layout, pts[i + 1].pitch),
        );
        if (d <= HIT + 1) return { note, segment: i };
      }
    }
    return null;
  }

  /**
   * The notes a rectangle catches: one with a point inside it, **or with a
   * line crossing it**. A held note's two points can both sit outside a
   * rectangle drawn straight across the middle of it, and leaving that note
   * out is not what the drag meant.
   */
  private notesInRect(
    clip: Clip,
    r: { x0: number; y0: number; x1: number; y1: number },
  ): number[] {
    const x0 = Math.min(r.x0, r.x1);
    const x1 = Math.max(r.x0, r.x1);
    const y0 = Math.min(r.y0, r.y1);
    const y1 = Math.max(r.y0, r.y1);
    const ids: number[] = [];
    for (const note of clip.notes) {
      const pts = note.points;
      let caught = false;
      for (const p of pts) {
        const px = rollX(this.layout, p.thirds);
        const py = rollY(this.layout, p.pitch);
        if (px >= x0 && px <= x1 && py >= y0 && py <= y1) { caught = true; break; }
      }
      for (let i = 0; !caught && i < pts.length - 1; i += 1) {
        caught = segmentMeetsRect(
          rollX(this.layout, pts[i].thirds), rollY(this.layout, pts[i].pitch),
          rollX(this.layout, pts[i + 1].thirds), rollY(this.layout, pts[i + 1].pitch),
          x0, y0, x1, y1,
        );
      }
      if (caught) ids.push(note.id);
    }
    return ids;
  }

  private snapped(x: number, steps: number): number {
    return snapThirds(rollThirdsAt(this.layout, x), this.state.triplets, steps);
  }

  // ----------------------------------------------------------------- pointer

  private onDown = (event: PointerEvent): void => {
    const clip = this.state.clip();
    if (!clip) return;
    const { x, y, cx, cy } = this.at(event);
    if (cy < this.layout.ruler) {
      if (cx >= this.layout.keys) this.cb.onSeek(rollThirdsAt(this.layout, x) / 3);
      return;
    }
    if (cx < this.layout.keys) {
      const pitch = rollPitchAt(this.layout, y);
      this.heldKey = pitch;
      this.cb.onAuditionPitch(clip, pitch);
      capture(this.canvas, event);
      this.schedule();
      return;
    }
    const state = this.state;
    const hitP = this.hitPoint(clip, x, y);
    if (event.button === 2) {
      if (hitP) {
        state.edit('notes', () => removePoint(clip, hitP.note, hitP.point));
        state.selectNotes(clip.notes.some((n) => n === hitP.note) ? [hitP.note.id] : []);
      } else {
        const hitL = this.hitLine(clip, x, y);
        if (hitL) {
          state.edit('notes', () => removeNote(clip, hitL.note.id));
          state.selectNotes([]);
        }
      }
      return;
    }
    if (event.button !== 0) return;
    capture(this.canvas, event);
    if (hitP) {
      const { note, point, index } = hitP;
      if (event.ctrlKey || event.metaKey) {
        const ids = new Set(state.selection.noteIds);
        if (ids.has(note.id)) ids.delete(note.id);
        else ids.add(note.id);
        state.selectNotes(ids, ids.has(note.id) ? { noteId: note.id, index } : null);
        return;
      }
      if (!state.selection.noteIds.has(note.id)) state.selectNotes([note.id], { noteId: note.id, index });
      else state.selectNotes(state.selection.noteIds, { noteId: note.id, index });
      state.beginDrag();
      if (event.shiftKey) {
        this.drag = { mode: 'volume', note, point, startY: y, startValue: point.volume, moved: false };
      } else if (event.altKey) {
        this.drag = { mode: 'timbre', note, point, startY: y, startValue: point.timbre, moved: false };
      } else if (state.selection.noteIds.size > 1) {
        /**
         * **A point of a note inside a set drags the whole set.** The dots are
         * what the pointer lands on, so a selection that can only be moved by
         * grabbing the thin line between them is a selection that cannot be
         * moved. To shape one point again, drop the selection first (Esc, or
         * a click on empty grid) and grab it on its own.
         */
        const notes = clip.notes.filter((n) => state.selection.noteIds.has(n.id));
        const t = this.snapped(x, clip.steps);
        const p = rollPitchAt(this.layout, y);
        this.drag = { mode: 'note', notes, startThirds: t, startPitch: p, lastThirds: t, lastPitch: p, moved: false };
      } else {
        this.drag = { mode: 'point', note, point, moved: false, lastThirds: point.thirds, lastPitch: point.pitch };
      }
      this.cb.onAudition(clip, note);
      return;
    }
    const hitL = this.hitLine(clip, x, y);
    if (hitL) {
      const { note } = hitL;
      if (event.ctrlKey || event.metaKey) {
        const ids = new Set(state.selection.noteIds);
        if (ids.has(note.id)) ids.delete(note.id);
        else ids.add(note.id);
        state.selectNotes(ids);
        return;
      }
      if (!state.selection.noteIds.has(note.id)) state.selectNotes([note.id]);
      const notes = clip.notes.filter((n) => state.selection.noteIds.has(n.id));
      state.beginDrag();
      const t = this.snapped(x, clip.steps);
      const p = rollPitchAt(this.layout, y);
      this.drag = { mode: 'note', notes, startThirds: t, startPitch: p, lastThirds: t, lastPitch: p, moved: false };
      this.cb.onAudition(clip, note);
      return;
    }
    if (event.shiftKey) {
      this.drag = { mode: 'marquee', x0: x, y0: y, x1: x, y1: y, add: event.ctrlKey || event.metaKey };
      this.schedule();
      return;
    }
    // Empty: a new note, one point, at the snapped position.
    const thirds = this.snapped(x, clip.steps);
    const pitch = rollPitchAt(this.layout, y);
    state.beginDrag();
    let created: SongNote | null = null;
    state.during((song) => {
      created = addNote(song, clip, { thirds, pitch });
    });
    const note = created!;
    state.selectNotes([note.id], { noteId: note.id, index: 0 });
    this.drag = { mode: 'create', note, startThirds: thirds, startPitch: pitch, extended: false };
    this.cb.onAudition(clip, note);
  };

  private onMove = (event: PointerEvent): void => {
    const clip = this.state.clip();
    if (!clip) return;
    const { x, y, cx, cy } = this.at(event);
    const state = this.state;
    const drag = this.drag;
    if (!drag) {
      if (this.heldKey !== null) return;
      const pitch = cy >= this.layout.ruler ? rollPitchAt(this.layout, y) : null;
      if (pitch !== this.hoverPitch) {
        this.hoverPitch = pitch;
        this.schedule();
      }
      if (cx < this.layout.keys || cy < this.layout.ruler) {
        this.cb.onHover(pitch === null ? '' : noteName(pitch));
        return;
      }
      const hitP = this.hitPoint(clip, x, y);
      if (hitP) {
        const p = hitP.point;
        this.cb.onHover(
          `${noteName(p.pitch)} (${p.pitch}) at ${positionLabel(p.thirds)} · volume ${p.volume} · timbre ${p.timbre}` +
          ` · point ${hitP.index + 1} of ${hitP.note.points.length}`
          + (this.state.selection.noteIds.size > 1 && this.state.selection.noteIds.has(hitP.note.id)
            ? `  ·  drag moves all ${this.state.selection.noteIds.size}` : ''),
        );
      } else {
        const t = this.snapped(x, clip.steps);
        const n = this.state.selection.noteIds.size;
        // With something selected the line says what the keys will do to it:
        // the commands are otherwise only in the help.
        this.cb.onHover(n === 0
          ? `${noteName(pitch ?? 0)} at ${positionLabel(t)}  ·  shift+drag selects`
          : `${noteName(pitch ?? 0)} at ${positionLabel(t)}  ·  ${n} note${n === 1 ? '' : 's'} selected`
            + '  ·  ctrl+D duplicate, ctrl+X cut, ctrl+C copy, ctrl+V paste, Delete removes');
      }
      return;
    }
    switch (drag.mode) {
      case 'create': {
        const thirds = this.snapped(x, clip.steps);
        const pitch = rollPitchAt(this.layout, y);
        if (!drag.extended && thirds === drag.startThirds && pitch === drag.startPitch) return;
        state.during(() => {
          if (!drag.extended) {
            addPoint(clip, drag.note, Math.max(drag.startThirds, thirds));
            drag.extended = true;
          }
          const end = drag.note.points[drag.note.points.length - 1];
          movePoint(clip, drag.note, end, { thirds: Math.max(drag.startThirds, thirds), pitch });
        });
        break;
      }
      case 'point': {
        const thirds = this.snapped(x, clip.steps);
        const pitch = rollPitchAt(this.layout, y);
        if (thirds === drag.lastThirds && pitch === drag.lastPitch) return;
        drag.lastThirds = thirds;
        drag.lastPitch = pitch;
        drag.moved = true;
        state.during(() => movePoint(clip, drag.note, drag.point, { thirds, pitch }));
        break;
      }
      case 'volume': {
        const value = Math.round(drag.startValue + (drag.startY - y) / 2);
        if (value === drag.point.volume) return;
        drag.moved = true;
        state.during(() => movePoint(clip, drag.note, drag.point, { volume: value }));
        this.cb.onHover(`volume ${drag.point.volume}`);
        break;
      }
      case 'timbre': {
        const value = Math.round(drag.startValue + (drag.startY - y) / 8);
        if (value === drag.point.timbre) return;
        drag.moved = true;
        state.during(() => movePoint(clip, drag.note, drag.point, { timbre: value }));
        this.cb.onHover(`timbre ${drag.point.timbre}`);
        break;
      }
      case 'note': {
        const thirds = this.snapped(x, clip.steps);
        const pitch = rollPitchAt(this.layout, y);
        const dt = thirds - drag.lastThirds;
        const dp = pitch - drag.lastPitch;
        if (dt === 0 && dp === 0) return;
        drag.lastThirds = thirds;
        drag.lastPitch = pitch;
        drag.moved = true;
        state.during(() => {
          for (const note of drag.notes) moveNote(clip, note, dt, dp);
        });
        break;
      }
      case 'marquee': {
        drag.x1 = x;
        drag.y1 = y;
        // The count comes from the same test the drop will use, so the hint
        // cannot say one thing and the selection do another.
        const n = this.notesInRect(clip, drag).length;
        this.cb.onHover(`${n} note${n === 1 ? '' : 's'}${drag.add ? ' to add' : ''}`);
        this.schedule();
        break;
      }
    }
  };

  private onUp = (event: PointerEvent): void => {
    release(this.canvas, event);
    if (this.heldKey !== null) {
      this.heldKey = null;
      this.schedule();
      return;
    }
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    const state = this.state;
    const clip = state.clip();
    switch (drag.mode) {
      case 'create':
        state.endDrag('notes', true);
        break;
      case 'point':
        if (drag.moved && clip) sortPoints(drag.note);
        state.endDrag('notes', drag.moved);
        break;
      case 'volume':
      case 'timbre':
      case 'note':
        state.endDrag('notes', drag.moved);
        break;
      case 'marquee': {
        if (!clip) break;
        const ids = this.notesInRect(clip, drag);
        // Ctrl held: the rectangle adds to what is already selected.
        state.selectNotes(drag.add ? new Set([...state.selection.noteIds, ...ids]) : ids);
        break;
      }
    }
  };

  private onDouble = (event: MouseEvent): void => {
    const clip = this.state.clip();
    if (!clip) return;
    const { x, y, cx, cy } = this.at(event);
    if (cx < this.layout.keys || cy < this.layout.ruler) return;
    const hitP = this.hitPoint(clip, x, y);
    if (hitP) {
      this.state.edit('notes', () => removePoint(clip, hitP.note, hitP.point));
      this.state.selectNotes(clip.notes.includes(hitP.note) ? [hitP.note.id] : []);
      return;
    }
    const hitL = this.hitLine(clip, x, y);
    if (hitL) {
      const thirds = this.snapped(x, clip.steps);
      let index = 0;
      this.state.edit('notes', () => {
        const p = addPoint(clip, hitL.note, thirds);
        index = hitL.note.points.indexOf(p);
      });
      this.state.selectNotes([hitL.note.id], { noteId: hitL.note.id, index });
    }
  };

  // --------------------------------------------------------------- commands
  // The page's keyboard reaches these; they act on the selection.

  deleteSelection(): void {
    const state = this.state;
    const clip = state.clip();
    if (!clip) return;
    const sel = state.point();
    if (sel && state.selection.noteIds.size === 1) {
      state.edit('notes', () => removePoint(clip, sel.note, sel.point));
      state.selectNotes(clip.notes.includes(sel.note) ? [sel.note.id] : []);
      return;
    }
    if (state.selection.noteIds.size === 0) return;
    const ids = new Set(state.selection.noteIds);
    state.edit('notes', () => {
      for (const id of ids) removeNote(clip, id);
    });
    state.selectNotes([]);
  }

  /** Move the selected notes by a grid unit and/or a semitone. */
  nudge(dSteps: number, dPitch: number): void {
    const state = this.state;
    const clip = state.clip();
    if (!clip || state.selection.noteIds.size === 0) return;
    const dt = dSteps * gridUnit(state.triplets);
    state.edit('notes', () => {
      for (const note of clip.notes) {
        if (state.selection.noteIds.has(note.id)) moveNote(clip, note, dt, dPitch);
      }
    }, 'nudge');
  }

  /** Volume or timbre of the selected point, or of every point of the selected notes. */
  adjust(field: 'volume' | 'timbre', delta: number): void {
    const state = this.state;
    const clip = state.clip();
    if (!clip) return;
    const sel = state.point();
    state.edit('notes', () => {
      if (sel) {
        movePoint(clip, sel.note, sel.point, { [field]: sel.point[field] + delta });
        return;
      }
      for (const note of clip.notes) {
        if (!state.selection.noteIds.has(note.id)) continue;
        for (const p of note.points) movePoint(clip, note, p, { [field]: p[field] + delta });
      }
    }, `adjust-${field}`);
  }

  selectAll(): void {
    const clip = this.state.clip();
    if (clip) this.state.selectNotes(clip.notes.map((n) => n.id));
  }

  /** The selected notes, each point's position relative to the earliest of them. */
  private lift(): SongNote[] {
    const clip = this.state.clip();
    if (!clip) return [];
    const notes = clip.notes.filter((n) => this.state.selection.noteIds.has(n.id));
    if (!notes.length) return [];
    const first = Math.min(...notes.map((n) => n.points[0].thirds));
    return notes.map((n) => ({
      id: 0,
      points: n.points.map((p) => ({ ...p, thirds: p.thirds - first })),
    }));
  }

  copy(): void {
    const lifted = this.lift();
    if (!lifted.length) return;
    this.clipboard = lifted;
    this.clipboardAt = this.selectionStart();
  }

  /** Copy the selection and take it away, as one entry in the undo stack. */
  cut(): void {
    const lifted = this.lift();
    if (!lifted.length) return;
    this.clipboard = lifted;
    this.clipboardAt = this.selectionStart();
    this.deleteSelection();
  }

  /**
   * A copy of the selection, one step past its own end, selected in its place
   * so a second Ctrl+D goes on down the grid. It leaves the clipboard alone:
   * duplicating is not a reason to lose what was copied.
   */
  duplicateSelection(): void {
    const lifted = this.lift();
    if (!lifted.length) return;
    this.insert(lifted, this.afterSelection());
  }

  /** The earliest point of the selection, or 0 when nothing is selected. */
  private selectionStart(): number {
    const clip = this.state.clip();
    if (!clip) return 0;
    const selected = clip.notes.filter((n) => this.state.selection.noteIds.has(n.id));
    return selected.length ? Math.min(...selected.map((n) => n.points[0].thirds)) : 0;
  }

  /** One step past the last point of the selection, on a whole step. */
  private afterSelection(): number {
    const clip = this.state.clip();
    if (!clip) return 0;
    const selected = clip.notes.filter((n) => this.state.selection.noteIds.has(n.id));
    const end = selected.length
      ? Math.max(...selected.map((n) => n.points[n.points.length - 1].thirds))
      : -3;
    return Math.ceil((end + 3) / 3) * 3;
  }

  /** Put a lifted set of notes into the clip at a position, and select it. */
  private insert(notes: readonly SongNote[], atThirds: number): void {
    const state = this.state;
    const clip = state.clip();
    if (!clip) return;
    const ids: number[] = [];
    state.edit('notes', (song) => {
      for (const n of notes) {
        const note = addNote(song, clip, { thirds: 0, pitch: 0 });
        note.points = n.points.map((p) => ({
          ...p, thirds: Math.min(lastThirds(clip), p.thirds + atThirds),
        }));
        ids.push(note.id);
      }
    });
    state.selectNotes(ids);
  }

  /**
   * Paste at the playhead when it is in the clip, else one step past the
   * selection -- and with nothing selected, back where the clipboard was
   * lifted from, so a cut followed by a paste puts the notes back rather than
   * dropping them at the start of the grid.
   */
  paste(atThirds?: number): void {
    if (!this.state.clip() || !this.clipboard.length) return;
    const at = atThirds
      ?? (this.state.selection.noteIds.size ? this.afterSelection() : this.clipboardAt);
    this.insert(this.clipboard, at);
  }

  get hasClipboard(): boolean {
    return this.clipboard.length > 0;
  }
}
