/**
 * What the editor is looking at, and the history behind it.
 *
 * ❗ **The song is a plain object, not a reactive one.** The board and the piano
 * roll are canvases redrawn on a change signal, and a `Song` wrapped in Vue's
 * proxies would make every note a proxy and every drag a cascade of dependency
 * tracking for no listener; see *Vue, and where it is not allowed* in
 * steering/tracker-architecture.md. The panels that ARE Vue read the song
 * through `version`, a counter that ticks on every change, and write through
 * `edit`.
 *
 * Undo is by snapshot: the song is small enough (`Ascetic`, the corpus's
 * largest, is 1,150 clips and 91,000 points, a few hundred kilobytes) that a
 * structured clone per edit is cheaper than a command log and impossible to
 * get out of step.
 */

import { ref } from 'vue';
import { addRow, removeRow, type Clip, type Song, type SongNote, type SongPoint } from '@lbptracker/lib/song.ts';

/**
 * What an edit touched, so the page knows what to do about it: the plan has
 * to be rebuilt for a note, a placement or an instrument; the mixer and the
 * clock are applied live for a setting; the output stage is one message.
 */
export type ChangeKind = 'notes' | 'settings' | 'effects' | 'selection' | 'mix';

export interface Selection {
  /**
   * The board row the roll follows: while the song plays, the chip the
   * playhead is inside on this row is the one shown. Row 0 to begin with.
   */
  row: number;
  /** The clip whose grid the piano roll shows. */
  clipId: number | null;
  /** Note ids within that clip. */
  noteIds: Set<number>;
  /** One point of one of those notes, for the inspector. */
  point: { noteId: number; index: number } | null;
  /** The board's cursor: where the next instrument goes. */
  cursor: { cell: number; row: number } | null;
}

export class EditorState {
  song: Song;
  /** Ticks on every change; the Vue panels depend on it. */
  readonly version = ref(0);
  readonly selection: Selection = { row: 0, clipId: null, noteIds: new Set(), point: null, cursor: null };
  /** The piano roll's grid: thirds of a step when on, whole steps when off. */
  triplets = false;
  /**
   * Rows muted and soloed, for listening only.
   *
   * ⚠️ Not the song's: the game has no mute or solo, so neither is written to
   * the song file or the MIDI. They decide which rows reach the player's plan
   * and the render -- what is heard -- and any solo outranks every mute.
   */
  readonly mutedRows = new Set<number>();
  readonly soloRows = new Set<number>();
  dirty = false;

  private undoStack: Song[] = [];
  private redoStack: Song[] = [];
  private lastKey: string | undefined;
  private lastAt = 0;
  private readonly listeners = new Set<(kind: ChangeKind) => void>();

  constructor(song: Song) {
    this.song = song;
  }

  onChange(listener: (kind: ChangeKind) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Whether a row is heard, under the mutes and solos as they stand. */
  rowAudible(row: number): boolean {
    return this.soloRows.size > 0 ? this.soloRows.has(row) : !this.mutedRows.has(row);
  }

  toggleMute(row: number): void {
    if (!this.mutedRows.delete(row)) this.mutedRows.add(row);
    this.notify('mix');
  }

  toggleSolo(row: number): void {
    if (!this.soloRows.delete(row)) this.soloRows.add(row);
    this.notify('mix');
  }

  /** One more row under the last. */
  addRow(): void {
    this.edit('settings', (song) => { addRow(song); });
  }

  /**
   * Take a row out, chips and all. The mutes and solos below it move up with
   * their rows; the selection moves to the row now in its place.
   */
  removeRow(row: number): void {
    if (row < 0 || row >= this.song.boardRows || this.song.boardRows <= 1) return;
    const shift = (rows: Set<number>) => {
      const next = [...rows].filter((r) => r !== row).map((r) => (r > row ? r - 1 : r));
      rows.clear();
      for (const r of next) rows.add(r);
    };
    shift(this.mutedRows);
    shift(this.soloRows);
    if (this.selection.cursor && this.selection.cursor.row >= row) {
      this.selection.cursor = this.selection.cursor.row === row
        ? null
        : { ...this.selection.cursor, row: this.selection.cursor.row - 1 };
    }
    this.edit('notes', (song) => { removeRow(song, row); });
    // The selection may name the chips that went; a row's worth of them.
    if (!this.clip()) {
      this.selection.clipId = null;
      this.selection.noteIds = new Set();
      this.selection.point = null;
    }
    if (this.selection.row >= row) {
      this.selectRow(Math.min(this.song.boardRows - 1, Math.max(0, this.selection.row === row ? row : this.selection.row - 1)));
    }
  }

  private notify(kind: ChangeKind): void {
    this.version.value += 1;
    for (const listener of this.listeners) listener(kind);
  }

  /** Something other than the song changed -- the selection, the grid switch. */
  touch(kind: ChangeKind = 'selection'): void {
    this.notify(kind);
  }

  /**
   * Mutate the song under one undo entry.
   *
   * `key` coalesces: consecutive edits with the same key inside a second share
   * one entry, so a slider dragged across fifty values undoes in one step.
   */
  edit(kind: ChangeKind, fn: (song: Song) => void, key?: string): void {
    const now = Date.now();
    if (key === undefined || key !== this.lastKey || now - this.lastAt > 1000) {
      this.undoStack.push(structuredClone(this.song));
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack = [];
    }
    this.lastKey = key;
    this.lastAt = now;
    fn(this.song);
    this.dirty = true;
    this.notify(kind);
  }

  /**
   * A drag: one undo entry taken at the start, then mutations applied directly
   * with `during`, and `endDrag` to say what kind of change it was.
   */
  beginDrag(): void {
    this.undoStack.push(structuredClone(this.song));
    this.redoStack = [];
    this.lastKey = undefined;
  }

  during(fn: (song: Song) => void): void {
    fn(this.song);
    this.notify('selection');
  }

  endDrag(kind: ChangeKind, changed = true): void {
    if (!changed) {
      // Nothing moved: the entry taken at the start would undo nothing.
      this.undoStack.pop();
      this.notify('selection');
      return;
    }
    this.dirty = true;
    this.notify(kind);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(this.song);
    this.song = previous;
    this.lastKey = undefined;
    this.afterRestore();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.song);
    this.song = next;
    this.lastKey = undefined;
    this.afterRestore();
  }

  /** A new song altogether: opened, or started blank. */
  replace(song: Song): void {
    this.song = song;
    this.undoStack = [];
    this.redoStack = [];
    this.lastKey = undefined;
    this.dirty = false;
    // The chip nearest the start of the song, and its row: the roll opens on
    // the first thing that will sound, not on whatever the file listed first
    // (on Ascetic that was a chip at bar 175). Row 0 when the song is empty.
    const first = [...song.clips].sort((a, b) => a.cell - b.cell || a.row - b.row)[0];
    this.selection.row = first?.row ?? 0;
    this.selection.clipId = first?.id ?? null;
    this.mutedRows.clear();
    this.soloRows.clear();
    this.selection.noteIds = new Set();
    this.selection.point = null;
    this.selection.cursor = null;
    this.notify('notes');
  }

  private afterRestore(): void {
    // The selection may name things the restored song no longer has.
    const clip = this.clip();
    if (!clip) {
      this.selection.clipId = this.song.clips[0]?.id ?? null;
      this.selection.noteIds = new Set();
      this.selection.point = null;
    } else {
      const ids = new Set(clip.notes.map((n) => n.id));
      this.selection.noteIds = new Set([...this.selection.noteIds].filter((id) => ids.has(id)));
      if (this.selection.point && !ids.has(this.selection.point.noteId)) this.selection.point = null;
    }
    this.dirty = true;
    this.notify('notes');
  }

  // --------------------------------------------------------------- lookups

  clip(id: number | null = this.selection.clipId): Clip | undefined {
    return id === null ? undefined : this.song.clips.find((c) => c.id === id);
  }

  note(clip: Clip, id: number): SongNote | undefined {
    return clip.notes.find((n) => n.id === id);
  }

  /** The selected point, resolved. */
  point(): { clip: Clip; note: SongNote; point: SongPoint; index: number } | undefined {
    const clip = this.clip();
    const sel = this.selection.point;
    if (!clip || !sel) return undefined;
    const note = this.note(clip, sel.noteId);
    const point = note?.points[sel.index];
    if (!note || !point) return undefined;
    return { clip, note, point, index: sel.index };
  }

  /** The chip on a row nearest the start of the song. */
  firstClipOnRow(row: number): Clip | undefined {
    return this.song.clips
      .filter((c) => c.row === row)
      .sort((a, b) => a.cell - b.cell)[0];
  }

  /** Select a clip, and with it the row it sits on. */
  selectClip(id: number | null): void {
    const clip = this.clip(id);
    if (clip) this.selection.row = clip.row;
    if (this.selection.clipId === id) {
      this.notify('selection');
      return;
    }
    this.selection.clipId = id;
    this.selection.noteIds = new Set();
    this.selection.point = null;
    this.notify('selection');
  }

  /**
   * Select a row: the roll moves to its first chip unless the selected chip
   * is already on it.
   */
  selectRow(row: number): void {
    const current = this.clip();
    this.selection.row = row;
    if (current && current.row === row) {
      this.notify('selection');
      return;
    }
    this.selectClip(this.firstClipOnRow(row)?.id ?? null);
  }

  selectNotes(ids: Iterable<number>, point: Selection['point'] = null): void {
    this.selection.noteIds = new Set(ids);
    this.selection.point = point;
    this.notify('selection');
  }
}
