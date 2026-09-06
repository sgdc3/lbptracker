/**
 * The Arrange view: the board, the piano roll, the inspector, and the keys.
 *
 * The model is `@lbptracker/lib/song.ts`; the two canvases are
 * `editor/board.ts` and `editor/roll.ts`; the inspector is Vue. The song, the
 * player and the plan are the session's -- this file wires the three to
 * them and owns the view's keyboard, which only listens while the view is
 * the one shown.
 */

import { createApp, h } from 'vue';
import { STEPS_PER_CELL } from '@lbptracker/cwlib/project.ts';
import { addClip, duplicateClip, removeClip, setSongEnd, type Clip } from '@lbptracker/lib/song.ts';
import { BoardView } from '../editor/board.ts';
import { RollView } from '../editor/roll.ts';
import { STEPS_PER_BAR, barOfCell } from '../editor/geometry.ts';
import { pickInstrument } from '../editor/instrument-picker.ts';
import Inspector from '../editor/Inspector.vue';
import {
  auditionNote, auditionPitch, byGuid, instruments, onPlan, onPlayer, player, setStatus, state,
} from './session.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface ArrangeHandle {
  readonly board: BoardView;
  readonly roll: RollView;
  openPanel(): void;
  closePanel(): void;
}

export function mountArrange(opts: { isActive: () => boolean }): ArrangeHandle {
  const boardScroller = $<HTMLDivElement>('boardScroller');
  const rollScroller = $<HTMLDivElement>('rollScroller');
  const rollTitle = $<HTMLSpanElement>('rollTitle');
  const hoverLine = $<HTMLDivElement>('hover');
  const tripletsBox = $<HTMLInputElement>('triplets');
  const view = $<HTMLDivElement>('view-arrange');
  const panel = $<HTMLDivElement>('chipPanel');
  const grip = $<HTMLDivElement>('panelGrip');

  // ----------------------------------------------------------- the panel
  // The selected chip's notes and settings, up from the bottom over the board.
  // It opens when a chip is clicked or drawn, not when the playhead merely
  // moves the selection, and stays where it was dragged to.

  /** The board gets to scroll under the panel by the panel's height. */
  const insetBoard = () => {
    board.setBottomInset(panel.hidden ? 0 : panel.getBoundingClientRect().height);
  };
  const openPanel = () => {
    if (!panel.hidden) return;
    panel.hidden = false;
    roll.schedule();
    insetBoard();
  };
  const closePanel = () => {
    panel.hidden = true;
    window.dispatchEvent(new Event('lbp:stop'));
    insetBoard();
  };
  $('panelClose').addEventListener('click', closePanel);
  try {
    const stored = localStorage.getItem('lbp.panel-h');
    if (stored) view.style.setProperty('--panel-h', stored);
  } catch {
    // no storage: the default height
  }
  grip.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    const startY = event.clientY;
    const startH = panel.getBoundingClientRect().height;
    const total = view.getBoundingClientRect().height;
    const move = (e: PointerEvent) => {
      const h = Math.max(160, Math.min(total * 0.92, startH + (startY - e.clientY)));
      view.style.setProperty('--panel-h', `${h}px`);
      roll.schedule();
      insetBoard();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      try {
        localStorage.setItem('lbp.panel-h', view.style.getPropertyValue('--panel-h'));
      } catch {
        // no storage
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  const board = new BoardView($<HTMLCanvasElement>('board'), boardScroller, $<HTMLDivElement>('boardSpacer'), state, {
    onSeek: (step) => player.hasPlan && player.seek(player.frameAt(Math.max(0, step))),
    onMove: (clip, to) => {
      state.edit('notes', () => {
        clip.cell = to.cell;
        clip.row = to.row;
      });
    },
    onCreate: (at) => void createChip(at),
    instrument: (guid) => byGuid.get(guid),
    onPick: () => openPanel(),
    onEnd: (step) => state.edit('notes', (s) => setSongEnd(s, step), 'end'),
    onAddRow: () => state.addRow(),
    onRemoveRow: (row) => {
      const held = state.song.clips.filter((c) => c.row === row).length;
      if (held > 0 && !window.confirm(`Remove row ${row} and the ${held} instrument${held === 1 ? '' : 's'} on it?`)) return;
      state.removeRow(row);
    },
  });
  new ResizeObserver(insetBoard).observe(panel);

  const roll = new RollView(
    $<HTMLCanvasElement>('roll'), rollScroller, $<HTMLDivElement>('rollSpacer'), state, {
      onSeek: (stepInClip) => {
        const clip = state.clip();
        if (clip && player.hasPlan) player.seek(player.frameAt(Math.max(0, clip.cell * STEPS_PER_CELL + stepInClip)));
      },
      onAudition: auditionNote,
      onAuditionPitch: auditionPitch,
      onHover: (text) => {
        hoverLine.textContent = text;
      },
    },
  );

  /**
   * A chip drawn on the board wants an instrument: ask, then add it with the
   * length the drag gave it. Nothing is added if the question is dismissed.
   */
  async function createChip(at: { cell: number; row: number; steps: number }): Promise<void> {
    if (state.song.clips.some((c) => c.cell === at.cell && c.row === at.row)) {
      setStatus('that cell already holds an instrument; start from an empty one', true);
      return;
    }
    const bars = at.steps / STEPS_PER_BAR;
    const guid = await pickInstrument(
      instruments.value, `Which instrument, for ${bars} bars at bar ${barOfCell(at.cell)}, row ${at.row}?`,
    );
    if (guid === null) return;
    let added: Clip | null = null;
    state.edit('notes', (s) => {
      added = addClip(s, at, guid);
      added.steps = at.steps;
    });
    state.selection.cursor = null;
    state.selectClip(added!.id);
    openPanel();
    rollScroller.focus({ preventScroll: true });
  }

  function duplicateSelected(): void {
    const clip = state.clip();
    if (!clip) return;
    const song = state.song;
    let at = state.selection.cursor;
    if (!at || song.clips.some((c) => c.cell === at!.cell && c.row === at!.row)) {
      let cell = clip.cell + 1;
      while (song.clips.some((c) => c.cell === cell && c.row === clip.row)) cell += 1;
      at = { cell, row: clip.row };
    }
    let copy: Clip | null = null;
    state.edit('notes', (s) => {
      copy = duplicateClip(s, clip, at!);
    });
    state.selection.cursor = null;
    state.selectClip(copy!.id);
  }

  function removeSelectedClip(): void {
    const clip = state.clip();
    if (!clip) return;
    state.edit('notes', (s) => {
      removeClip(s, clip.id);
    });
    state.selectClip(null);
  }

  createApp({
    render: () => h(Inspector, {
      state,
      instruments: instruments.value,
      onDuplicate: duplicateSelected,
      onRemove: removeSelectedClip,
      onStatus: (text: string) => setStatus(text, true),
    }),
  }).mount('#inspector');

  function updateTitle(): void {
    const clip = state.clip();
    if (!clip) {
      rollTitle.textContent = 'no instrument selected';
      return;
    }
    const info = byGuid.get(clip.guid);
    rollTitle.innerHTML = '';
    rollTitle.append(
      clip.name || info?.name || '(no instrument)',
      Object.assign(document.createElement('small'), {
        textContent: `${info && clip.name ? `${info.name} · ` : ''}bar ${barOfCell(clip.cell)}, row ${clip.row} · ${clip.steps / STEPS_PER_BAR} bars`,
      }),
    );
  }
  state.onChange(updateTitle);
  updateTitle();

  // --------------------------------------------------------- the playhead

  /**
   * The chip the playhead was last inside on the selected row.
   *
   * ❗ **The roll follows the playhead by transitions, not by position.** When
   * the playhead enters a chip on the selected row the roll moves to it; while
   * it stays inside that chip a click on another chip holds, instead of being
   * snapped back on the next tick. Reset when the row changes.
   */
  let followed: number | null = null;
  let followedRow = -1;

  function chipUnder(step: number): Clip | undefined {
    let found: Clip | undefined;
    for (const c of state.song.clips) {
      if (c.row !== state.selection.row) continue;
      const start = c.cell * STEPS_PER_CELL;
      if (step >= start && step < start + c.steps) found = c;
    }
    return found;
  }

  function paint(): void {
    if (!player.hasPlan) {
      board.setPlayhead(null);
      roll.setPlayhead(null);
      return;
    }
    const step = player.stepAt(player.position());
    board.setPlayhead(step);
    if (followedRow !== state.selection.row) {
      followedRow = state.selection.row;
      followed = null;
    }
    const under = chipUnder(step);
    if ((under?.id ?? null) !== followed) {
      followed = under?.id ?? null;
      if (under && under.id !== state.selection.clipId) state.selectClip(under.id);
    }
    const clip = state.clip();
    if (clip) {
      const inClip = step - clip.cell * STEPS_PER_CELL;
      roll.setPlayhead(inClip);
      if (player.playing && opts.isActive() && inClip >= 0 && inClip <= clip.steps) roll.followStep(inClip);
    } else roll.setPlayhead(null);
    if (player.playing && opts.isActive()) board.followStep(step);
  }
  // The player ticks ten times a second; the playhead and the flashes want
  // every frame while it plays, and the board's own scan is cheap.
  let smoothing = false;
  const smooth = () => {
    if (!player.playing || !opts.isActive()) {
      smoothing = false;
      return;
    }
    board.setPlayhead(player.stepAt(player.position()));
    window.requestAnimationFrame(smooth);
  };
  const startSmoothing = () => {
    if (smoothing || !player.playing) return;
    smoothing = true;
    window.requestAnimationFrame(smooth);
  };
  onPlayer({ tick: () => { paint(); startSmoothing(); }, playing: startSmoothing });
  onPlan(paint);
  state.onChange((kind) => {
    if (kind === 'settings') paint();
  });

  tripletsBox.addEventListener('change', () => {
    state.triplets = tripletsBox.checked;
    state.touch('selection');
  });
  $('fitNotes').addEventListener('click', () => roll.scrollToNotes());

  // ------------------------------------------------------------ chip loop
  // The selected chip's bars round and round, its row at full volume and
  // every other row at a fifth: hearing one part in place while editing it.
  // Arming it cuts the song off -- whatever was ringing goes, so the loop
  // begins clean -- and starts the loop from the chip's start; disarming it
  // cuts the loop off the same way and plays the song on from the chip's
  // start. It follows the selection to another chip, and it is dropped when
  // the panel closes, the transport is stopped, or the song goes.
  const loopButton = $<HTMLButtonElement>('loopChip');
  let loopingClip: number | null = null;
  const aimChipLoop = (clip: Clip, seekToStart: boolean) => {
    const start = clip.cell * STEPS_PER_CELL;
    loopingClip = clip.id;
    player.setFocus(clip.row);
    player.setRegion(start, start + clip.steps);
    loopButton.setAttribute('aria-pressed', 'true');
    if (seekToStart && player.hasPlan) player.seek(player.frameAt(start));
  };
  /** Disarm; `resume` plays the song on from the chip's start. */
  const dropChipLoop = (resume = false) => {
    if (loopingClip === null) return;
    const clip = state.clip(loopingClip);
    loopingClip = null;
    player.setFocus(null);
    player.clearRegion();
    loopButton.setAttribute('aria-pressed', 'false');
    if (resume && clip && player.hasPlan) {
      player.stop();
      player.seek(player.frameAt(clip.cell * STEPS_PER_CELL));
      player.play();
    }
  };
  loopButton.addEventListener('click', () => {
    const clip = state.clip();
    if (loopingClip !== null) {
      dropChipLoop(true);
    } else if (clip) {
      player.stop();
      aimChipLoop(clip, true);
      if (player.hasPlan) player.play();
    }
  });
  state.onChange(() => {
    if (loopingClip === null) return;
    const clip = state.clip();
    if (!clip || !player.hasPlan) dropChipLoop();
    else aimChipLoop(clip, clip.id !== loopingClip);
  });
  window.addEventListener('lbp:stop', () => dropChipLoop());

  // ------------------------------------------------------------- keyboard

  window.addEventListener('keydown', (event) => {
    if (!opts.isActive()) return;
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
    const ctrl = event.ctrlKey || event.metaKey;
    const onBoard = target instanceof Node && boardScroller.contains(target);
    switch (event.code) {
      case 'Escape':
        // Once to drop the selection, again to close the panel.
        if (state.selection.noteIds.size === 0 && state.selection.point === null && !panel.hidden) {
          closePanel();
          return;
        }
        state.selection.cursor = null;
        state.selectNotes([]);
        return;
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        if (onBoard) removeSelectedClip();
        else roll.deleteSelection();
        return;
      case 'ArrowLeft':
        event.preventDefault();
        roll.nudge(-1, 0);
        return;
      case 'ArrowRight':
        event.preventDefault();
        roll.nudge(1, 0);
        return;
      case 'ArrowUp':
        event.preventDefault();
        roll.nudge(0, event.shiftKey ? 12 : 1);
        return;
      case 'ArrowDown':
        event.preventDefault();
        roll.nudge(0, event.shiftKey ? -12 : -1);
        return;
      case 'Equal':
      case 'NumpadAdd':
        roll.adjust('volume', event.shiftKey ? 8 : 1);
        return;
      case 'Minus':
      case 'NumpadSubtract':
        roll.adjust('volume', event.shiftKey ? -8 : -1);
        return;
      case 'BracketLeft':
        roll.adjust('timbre', -1);
        return;
      case 'BracketRight':
        roll.adjust('timbre', 1);
        return;
      case 'KeyT':
        if (ctrl) return;
        tripletsBox.checked = !tripletsBox.checked;
        tripletsBox.dispatchEvent(new Event('change'));
        return;
      default:
        break;
    }
    if (!ctrl) return;
    switch (event.code) {
      case 'KeyZ':
        event.preventDefault();
        if (event.shiftKey) state.redo();
        else state.undo();
        break;
      case 'KeyY':
        event.preventDefault();
        state.redo();
        break;
      case 'KeyA':
        event.preventDefault();
        roll.selectAll();
        break;
      case 'KeyC':
        event.preventDefault();
        roll.copy();
        break;
      case 'KeyV': {
        event.preventDefault();
        const clip = state.clip();
        let at: number | undefined;
        if (clip && player.hasPlan) {
          const inClip = player.stepAt(player.position()) - clip.cell * STEPS_PER_CELL;
          if (inClip >= 0 && inClip < clip.steps) at = Math.round(inClip) * 3;
        }
        roll.paste(at);
        break;
      }
      case 'KeyD':
        event.preventDefault();
        duplicateSelected();
        break;
      default:
        break;
    }
  });

  return { board, roll, openPanel, closePanel };
}
