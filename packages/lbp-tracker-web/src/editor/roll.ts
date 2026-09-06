/**
 * The piano roll: one placement's note grid, drawn on a canvas.
 *
 * What it draws is the game's own picture of a note: a chain of control
 * points joined by straight lines, each point's size its volume and its
 * colour its timbre -- blue at 0, orange at 15 -- with a keyboard down the
 * left and a step grid that can be switched between whole steps and thirds.
 * The engine glides linearly between consecutive points, so the straight
 * line is not a drawing convention: it is what will sound.
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
 * | empty           | draw a note; drag for its end | marquee | —         | —           |
 * | a point         | move it           | volume (up/down) | timbre (up/down) | delete it   |
 * | a line          | move the note     | —                | —                | delete note |
 * | double-click    | line: add a point; point: delete it                    |             |
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
  onGrid,
  pointRadius,
  positionLabel,
  rollPitchAt,
  rollSize,
  rollStepX,
  rollThirdsAt,
  rollX,
  rollY,
  segmentDistance,
  snapThirds,
  timbreColour,
  type RollLayout,
} from './geometry.ts';
import { capture, release } from './pointer.ts';
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
  | { mode: 'marquee'; x0: number; y0: number; x1: number; y1: number };

export class RollView {
  private readonly canvas: HTMLCanvasElement;
  private readonly scroller: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly state: EditorState;
  private readonly cb: RollCallbacks;
  private layout: RollLayout = { keys: KEYS, ruler: RULER, stepW: STEP_W, rowH: ROW_H, steps: 32, triplets: false };
  private playStep: number | null = null;
  private drag: Drag | null = null;
  private hoverPitch: number | null = null;
  private heldKey: number | null = null;
  private frame = 0;
  private lastClipId: number | null = null;
  /** Notes copied with Ctrl+C, relative to their first position. */
  private clipboard: SongNote[] = [];

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

  /** Scroll so the clip's notes -- or middle C -- are in the middle of the view. */
  scrollToNotes(): void {
    const clip = this.state.clip();
    let centre = 60;
    if (clip && clip.notes.length) {
      let lo = 127;
      let hi = 0;
      for (const n of clip.notes) for (const p of n.points) {
        lo = Math.min(lo, p.pitch);
        hi = Math.max(hi, p.pitch);
      }
      centre = (lo + hi) / 2;
    }
    this.measure();
    const y = rollY(this.layout, centre);
    this.scroller.scrollTop = Math.max(0, y - this.scroller.clientHeight / 2);
    this.scroller.scrollLeft = 0;
  }

  /** Keep a step in view while the song plays. */
  followStep(stepInClip: number): void {
    const x = rollStepX(this.layout, stepInClip);
    const left = this.scroller.scrollLeft;
    const width = this.scroller.clientWidth;
    if (x - left > width - 40 || x - left < this.layout.keys) {
      this.scroller.scrollLeft = Math.max(0, x - this.layout.keys - 40);
    }
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
      for (let i = 0; i < pts.length - 1; i += 1) {
        const a = pts[i];
        const b = pts[i + 1];
        ctx.strokeStyle = timbreColour(a.timbre, (on ? 1 : 0.8) * fade);
        ctx.lineWidth = on ? 3.5 : 2.5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(px(a.thirds), py(a.pitch));
        ctx.lineTo(px(b.thirds), py(b.pitch));
        ctx.stroke();
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
      this.drag = { mode: 'marquee', x0: x, y0: y, x1: x, y1: y };
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
          ` · point ${hitP.index + 1} of ${hitP.note.points.length}`,
        );
      } else {
        const t = this.snapped(x, clip.steps);
        this.cb.onHover(`${noteName(pitch ?? 0)} at ${positionLabel(t)}`);
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
        const x0 = Math.min(drag.x0, drag.x1);
        const x1 = Math.max(drag.x0, drag.x1);
        const y0 = Math.min(drag.y0, drag.y1);
        const y1 = Math.max(drag.y0, drag.y1);
        const ids = clip.notes
          .filter((n) => n.points.some((p) => {
            const px = rollX(this.layout, p.thirds);
            const py = rollY(this.layout, p.pitch);
            return px >= x0 && px <= x1 && py >= y0 && py <= y1;
          }))
          .map((n) => n.id);
        state.selectNotes(ids);
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

  copy(): void {
    const clip = this.state.clip();
    if (!clip) return;
    const notes = clip.notes.filter((n) => this.state.selection.noteIds.has(n.id));
    if (!notes.length) return;
    const first = Math.min(...notes.map((n) => n.points[0].thirds));
    this.clipboard = notes.map((n) => ({
      id: 0,
      points: n.points.map((p) => ({ ...p, thirds: p.thirds - first })),
    }));
  }

  /** Paste at the playhead if it is in the clip, else at the first free bar after the selection. */
  paste(atThirds?: number): void {
    const state = this.state;
    const clip = state.clip();
    if (!clip || !this.clipboard.length) return;
    let at = atThirds;
    if (at === undefined) {
      const selected = clip.notes.filter((n) => state.selection.noteIds.has(n.id));
      const end = selected.length
        ? Math.max(...selected.map((n) => n.points[n.points.length - 1].thirds))
        : -3;
      at = Math.ceil((end + 3) / 3) * 3;
    }
    const ids: number[] = [];
    state.edit('notes', (song) => {
      for (const n of this.clipboard) {
        const note = addNote(song, clip, { thirds: 0, pitch: 0 });
        note.points = n.points.map((p) => ({
          ...p, thirds: Math.min(lastThirds(clip), p.thirds + at!),
        }));
        ids.push(note.id);
      }
    });
    state.selectNotes(ids);
  }

  get hasClipboard(): boolean {
    return this.clipboard.length > 0;
  }
}
