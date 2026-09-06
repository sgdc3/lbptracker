/**
 * The editor page: a song opened for editing, the board, the piano roll, the
 * inspector, and the player underneath them.
 *
 * ❗ **Every edit is heard through the renderer's own voice pass.** A change to
 * a note, a placement or an instrument rebuilds the player's plan through
 * `Player.load` with `restart` off -- swapped in under a running transport,
 * as the live page does for the voice pool -- so what plays after an edit is
 * what a render of the edited song would write. Settings that do not change a
 * voice (tempo, swing, the mixer) go through `Player.setSettings` and rebuild
 * nothing; the output stage is one message.
 *
 * The model is `@lbptracker/lib/song.ts`; the two canvases are `editor/board.ts`
 * and `editor/roll.ts`; the forms are Vue. This file wires them together and
 * owns the keyboard.
 */

import { createApp, h } from 'vue';
import { HANDOFF_KEY, loaderFor, manifest, type Manifest } from './assets.ts';
import { seqPicker } from './seq-picker.ts';
import { readBackup, readBackupZip, sequencersOf, type BackupResult } from '@lbptracker/cwlib/backup.ts';
import type { Sequencer } from '@lbptracker/cwlib/project.ts';
import { STEPS_PER_CELL } from '@lbptracker/cwlib/project.ts';
import { webInflate, webInflateRaw } from '@lbptracker/cwlib/platform/web.ts';
import { RATE, type InstrumentLoader } from '@lbptracker/lib/render.ts';
import { sequencerToMidi } from '@lbptracker/lib/midi.ts';
import {
  addClip,
  addNote,
  duplicateClip,
  looksLikeSongJson,
  newSong,
  removeClip,
  sequencerFromSong,
  songFromJson,
  songFromSequencer,
  songToJson,
  trackFromClip,
  type Clip,
  type Song,
  type SongNote,
} from '@lbptracker/lib/song.ts';
import { isZip, openedTitle, saveNote, type Opened } from './open-level.ts';
import { mountOpen } from './widgets/open-panel.ts';
import { mountFooter } from './footer.ts';
import { Player, type Health } from './player.ts';
import { BoardView } from './editor/board.ts';
import { RollView } from './editor/roll.ts';
import { EditorState } from './editor/state.ts';
import { instrumentsFrom, type InstrumentInfo } from './editor/instruments.ts';
import { STEPS_PER_BAR, barOfCell } from './editor/geometry.ts';
import Inspector from './editor/Inspector.vue';
import Palette from './editor/Palette.vue';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusLine = $<HTMLDivElement>('status');
const errorCard = $<HTMLElement>('errorCard');
const errorBox = $<HTMLPreElement>('error');
const playButton = $<HTMLButtonElement>('play');
const rewindButton = $<HTMLButtonElement>('rewind');
const clockLabel = $<HTMLSpanElement>('clock');
const loadLabel = $<HTMLSpanElement>('load');
const volSlider = $<HTMLInputElement>('vol');
const boardScroller = $<HTMLDivElement>('boardScroller');
const rollScroller = $<HTMLDivElement>('rollScroller');
const rollTitle = $<HTMLSpanElement>('rollTitle');
const hoverLine = $<HTMLDivElement>('hover');
const tripletsBox = $<HTMLInputElement>('triplets');
const saveNoteLine = $<HTMLSpanElement>('saveNote');
const fileInput = $<HTMLInputElement>('file');

const setStatus = (text: string, bad = false) => {
  statusLine.textContent = text;
  statusLine.classList.toggle('bad', bad);
};
const setError = (text: string) => {
  errorBox.textContent = text;
  errorCard.classList.toggle('show', text !== '');
};
const clock = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};

// --------------------------------------------------------------------- state

const state = new EditorState(newSong());
let instruments: InstrumentInfo[] = [];
const byGuid = new Map<number, InstrumentInfo>();
let rinstIndex: Manifest | null = null;
let smpIndex: Manifest | null = null;
let loader: InstrumentLoader | null = null;
/** The instrument the palette last placed, for a double-click on the board. */
let lastGuid = 129085; // Square Wave, the corpus's most used
/** What a level gave us, by the picker's key. */
let songs = new Map<string, Sequencer>();

let health: Health = { sounding: 0, notes: 0, queued: 0, audioLoad: null, dropouts: 0, lostMs: 0 };

const player = new Player({
  health: (h) => {
    health = h;
    showLoad();
  },
  missingSample: (id) => setError(`the worklet has no sample "${id}"`),
  tick: () => paint(),
  playing: (on) => {
    playButton.textContent = on ? '⏸' : '▶';
    playButton.setAttribute('aria-label', on ? 'Pause' : 'Play');
    showLoad();
  },
  progress: (phase, done, total) => {
    setStatus(`preparing — ${phase} ${Math.round((done / Math.max(1, total)) * 100)}%`);
  },
});

function showLoad(): void {
  const { sounding, notes, queued, dropouts, lostMs } = health;
  if (!player.playing && sounding === 0 && queued === 0) {
    loadLabel.textContent = player.hasPlan ? 'ready' : 'idle';
    return;
  }
  const dropped = dropouts === 0
    ? 'no dropouts'
    : `${dropouts} dropout${dropouts === 1 ? '' : 's'}${lostMs >= 1 ? ` (${lostMs.toFixed(0)} ms lost)` : ''}`;
  loadLabel.textContent = `${notes} notes · ${dropped}`;
}

/** Make sure the game's assets are indexed and the loader exists. */
async function ensureAssets(): Promise<InstrumentLoader> {
  if (loader) return loader;
  [rinstIndex, smpIndex] = await Promise.all([manifest('fixtures/rinst'), manifest('fixtures/smp')]);
  instruments = instrumentsFrom(rinstIndex.values() as Iterable<{ guid: number; file: string; path?: string }>);
  byGuid.clear();
  for (const info of instruments) byGuid.set(info.guid, info);
  mountPalette();
  loader = await loaderFor(rinstIndex, smpIndex);
  return loader;
}

// ------------------------------------------------------------------ the plan

let replanTimer = 0;
let replanning = false;
let replanAgain = false;
let restartNext = true;

/**
 * Rebuild the plan from the song as it stands, debounced: a drag produces a
 * change per pixel, and the voice pass over a big song takes a second.
 */
function replanSoon(): void {
  window.clearTimeout(replanTimer);
  replanTimer = window.setTimeout(() => void replan(), 180);
}

async function replan(): Promise<void> {
  if (replanning) {
    replanAgain = true;
    return;
  }
  replanning = true;
  try {
    const load = await ensureAssets();
    const seq = sequencerFromSong(state.song);
    const restart = restartNext;
    restartNext = false;
    pushEffects();
    const loaded = await player.load(seq, load, restart);
    playButton.disabled = false;
    rewindButton.disabled = false;
    setStatus(
      `${state.song.clips.length} instrument${state.song.clips.length === 1 ? '' : 's'}, ` +
      `${loaded.played.toLocaleString()} note${loaded.played === 1 ? '' : 's'}` +
      (loaded.skipped ? `, ${loaded.skipped} with no instrument` : '') +
      ` — ${clock(loaded.seconds)} at ${state.song.tempo} BPM`,
    );
    paint();
  } catch (error) {
    setStatus('failed', true);
    setError(String((error as Error).stack ?? error));
  } finally {
    replanning = false;
    if (replanAgain) {
      replanAgain = false;
      replanSoon();
    }
  }
}

function pushEffects(): void {
  const song = state.song;
  player.setEffects({
    echoTime: song.echoTime,
    feedback: song.echoFeedback,
    mix: song.echoMix,
    reverbSetting: song.reverb,
    echoOn: true,
    reverbOn: true,
    clip: true,
  });
}

function pushSettings(): void {
  const song = state.song;
  player.setSettings({
    tempo: song.tempo,
    swing: song.swing,
    numChannels: song.numChannels,
    volumes: song.volumes,
    boardRows: song.boardRows,
  });
}

state.onChange((kind) => {
  updateTitle();
  if (kind === 'notes') replanSoon();
  else if (kind === 'settings') {
    pushSettings();
    paint();
  } else if (kind === 'effects') pushEffects();
});

// --------------------------------------------------------------- audition

/** Play one note of a clip, on its own, through the same pipeline as the song. */
function auditionNote(clip: Clip, note: SongNote): void {
  if (!note.points.length) return;
  const first = note.points[0].thirds;
  const solo: Clip = {
    ...clip,
    cell: 0,
    notes: [{ id: 1, points: note.points.map((p) => ({ ...p, thirds: p.thirds - first })) }],
  };
  void playSolo(solo);
}

function auditionPitch(clip: Clip, pitch: number): void {
  const solo: Clip = { ...clip, cell: 0, notes: [] };
  const song = newSong();
  addNote(song, solo, { thirds: 0, pitch });
  // One step long; the gate closes a step after the point, which is the shortest note there is.
  void playSolo(solo);
}

async function playSolo(solo: Clip): Promise<void> {
  try {
    const load = await ensureAssets();
    const song = state.song;
    // The song's own settings and board, so the note's channel band, key and
    // scale are the ones it will play under; only the notes are the solo's.
    const seq: Sequencer = {
      ...sequencerFromSong({ ...song, clips: [] }),
      tracks: [trackFromClip(solo)],
      lengthSteps: solo.steps,
    };
    await player.audition(seq, load);
  } catch (error) {
    setError(String((error as Error).stack ?? error));
  }
}

// --------------------------------------------------------------- the views

const board = new BoardView($<HTMLCanvasElement>('board'), state, {
  onSeek: (step) => player.hasPlan && player.seek(player.frameAt(Math.max(0, step))),
  onMove: (clip, to) => {
    state.edit('notes', () => {
      clip.cell = to.cell;
      clip.row = to.row;
    });
  },
  onAddAt: (at) => addInstrument(lastGuid, at),
  instrument: (guid) => byGuid.get(guid),
});

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

function addInstrument(guid: number, at?: { cell: number; row: number }): void {
  const song = state.song;
  let where = at ?? state.selection.cursor;
  if (!where) {
    // The first free cell on the first row, after everything on it.
    const row = 0;
    const used = new Set(song.clips.filter((c) => c.row === row).map((c) => c.cell));
    let cell = 0;
    while (used.has(cell)) cell += 1;
    where = { cell, row };
  }
  if (song.clips.some((c) => c.cell === where!.cell && c.row === where!.row)) {
    setStatus('that cell already holds an instrument — pick an empty one', true);
    return;
  }
  lastGuid = guid;
  let added: Clip | null = null;
  state.edit('notes', (s) => {
    added = addClip(s, where!, guid);
  });
  state.selection.cursor = null;
  state.selectClip(added!.id);
  rollScroller.focus({ preventScroll: true });
}

function duplicateSelected(): void {
  const clip = state.clip();
  if (!clip) return;
  const song = state.song;
  let at = state.selection.cursor;
  if (!at || song.clips.some((c) => c.cell === at!.cell && c.row === at!.row)) {
    // The next free cell to the right on the same row.
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

function mountPalette(): void {
  const host = $<HTMLDivElement>('palette');
  host.innerHTML = '';
  createApp({
    render: () => h(Palette, { instruments, onPick: (guid: number) => addInstrument(guid) }),
  }).mount(host);
}

createApp({
  render: () => h(Inspector, {
    state,
    instruments,
    onDuplicate: duplicateSelected,
    onRemove: removeSelectedClip,
    onStatus: (text: string) => setStatus(text, true),
  }),
}).mount('#inspector');

function updateTitle(): void {
  const clip = state.clip();
  if (!clip) {
    rollTitle.textContent = 'no instrument selected';
  } else {
    const info = byGuid.get(clip.guid);
    rollTitle.innerHTML = '';
    rollTitle.append(
      clip.name || info?.name || '(no instrument)',
      Object.assign(document.createElement('small'), {
        textContent: `${info && clip.name ? `${info.name} · ` : ''}bar ${barOfCell(clip.cell)}, row ${clip.row} · ${clip.steps / STEPS_PER_BAR} bars`,
      }),
    );
  }
  document.title = `LBP Tracker — editor${state.dirty ? ' •' : ''} — ${state.song.name}`;
}

// ---------------------------------------------------------------- transport

function paint(): void {
  const frames = player.position();
  clockLabel.textContent = `${clock(frames / RATE)} / ${clock(player.songSeconds)}`;
  if (!player.hasPlan) {
    board.setPlayhead(null);
    roll.setPlayhead(null);
    return;
  }
  const step = player.stepAt(frames);
  board.setPlayhead(step);
  const clip = state.clip();
  if (clip) {
    const inClip = step - clip.cell * STEPS_PER_CELL;
    roll.setPlayhead(inClip);
    if (player.playing && inClip >= 0 && inClip <= clip.steps) roll.followStep(inClip);
  } else roll.setPlayhead(null);
  if (player.playing) {
    const x = board.xOfStep(step);
    const left = boardScroller.scrollLeft;
    if (x - left > boardScroller.clientWidth - 30 || x < left) boardScroller.scrollLeft = Math.max(0, x - 60);
  }
}

playButton.addEventListener('click', () => (player.playing ? player.stop() : player.play()));
rewindButton.addEventListener('click', () => player.seek(0));
volSlider.addEventListener('input', () => player.setVolume(Number(volSlider.value)));
player.setVolume(Number(volSlider.value));

tripletsBox.addEventListener('change', () => {
  state.triplets = tripletsBox.checked;
  state.touch('selection');
});
$('fitNotes').addEventListener('click', () => roll.scrollToNotes());

// ----------------------------------------------------------------- keyboard

window.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement | null;
  if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
  const ctrl = event.ctrlKey || event.metaKey;
  const onBoard = target instanceof Node && boardScroller.contains(target);
  switch (event.code) {
    case 'Space':
      if (!player.hasPlan) return;
      event.preventDefault();
      if (player.playing) player.stop();
      else player.play();
      return;
    case 'Escape':
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
    case 'KeyS':
      event.preventDefault();
      saveSong();
      break;
    default:
      break;
  }
});

// --------------------------------------------------------------- the files

function openSong(song: Song, how: string): void {
  player.clear();
  restartNext = true;
  state.replace(song);
  state.selection.clipId = song.clips[0]?.id ?? null;
  updateTitle();
  setStatus(`${how} — ${song.clips.length} instrument${song.clips.length === 1 ? '' : 's'}`);
  replanSoon();
}

const picker = seqPicker($<HTMLDivElement>('seq'), (key) => {
  const seq = songs.get(key);
  if (seq) openSong(songFromSequencer(seq), `opened "${seq.name}"`);
});

const drop = mountOpen('#open', { onOpen: (opened) => openLevel(opened) });

async function openLevel(opened: Opened): Promise<void> {
  setError('');
  drop.busy(true);
  setStatus(`reading ${opened.label}…`);
  try {
    const only = opened.files.length === 1 ? opened.files[0] : undefined;
    // One of our own song files, dropped where a level goes: fine.
    if (only && /\.json$/i.test(only.name)) {
      const text = new TextDecoder().decode(only.bytes);
      if (!looksLikeSongJson(text)) throw new Error(`${only.name} is not an LBP Tracker song file`);
      openSong(songFromJson(text), `opened ${only.name}`);
      drop.loaded(true);
      drop.say(only.name);
      return;
    }
    const result: BackupResult = only && isZip(only)
      ? await readBackupZip(only.bytes, webInflate, webInflateRaw)
      : await readBackup(opened.files, webInflate);
    songs = new Map();
    for (const p of result.projects) {
      for (const sequencer of p.sequencers) songs.set(`${p.file}#${sequencer.uid}`, sequencer);
    }
    const rows = sequencersOf(result).map((r) => ({
      key: r.key,
      name: r.name,
      tracks: r.tracks,
      file: result.projects.length > 1 ? r.file : undefined,
    }));
    const first = picker.setRows(rows);
    drop.loaded(true);
    drop.say(openedTitle(result, rows.length, opened.label));
    const note = saveNote(result);
    if (first) {
      const seq = songs.get(first)!;
      openSong(songFromSequencer(seq), `opened "${seq.name}"`);
    } else if (note) setStatus(note, true);
    else if (result.failed.length) setStatus(`nothing to edit: ${result.failed[0].why}`, true);
    else setStatus('no sequencers in there', true);
    if (result.failed.length > 0) {
      setError(result.failed.map((f) => `${f.name}: ${f.why}`).join('\n'));
    }
  } catch (error) {
    setStatus('failed', true);
    setError(String((error as Error).stack ?? error));
  } finally {
    drop.busy(false);
  }
}

$('newSong').addEventListener('click', () => {
  if (state.dirty && !window.confirm('Throw away the unsaved changes?')) return;
  songs = new Map();
  picker.setRows([]);
  openSong(newSong(), 'a new song');
  state.selection.cursor = { cell: 0, row: 0 };
  state.touch('selection');
});

$('openSong').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  void (async () => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await openLevel({ label: file.name, files: [{ name: file.name, bytes }], many: false });
  })();
});

function download(name: string, bytes: Uint8Array | string, type: string): void {
  const blob = new Blob([bytes as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const safeName = () => (state.song.name.replace(/[^\w.-]+/g, '_') || 'song');

function saveSong(): void {
  download(`${safeName()}.lbptracker.json`, songToJson(state.song), 'application/json');
  state.dirty = false;
  updateTitle();
  saveNoteLine.textContent = `saved ${new Date().toLocaleTimeString()}`;
}

$('save').addEventListener('click', saveSong);

$('toLive').addEventListener('click', () => {
  try {
    sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(sequencerFromSong(state.song)));
  } catch (error) {
    setStatus(`too big to hand over: ${String((error as Error).message)}`, true);
    return;
  }
  window.open('./live.html', '_blank');
});

$('toMidi').addEventListener('click', () => {
  try {
    const result = sequencerToMidi(sequencerFromSong(state.song));
    download(`${safeName()}.mid`, result.bytes, 'audio/midi');
    saveNoteLine.textContent = `MIDI: ${result.notes.toLocaleString()} notes, ${result.parts} tracks`;
  } catch (error) {
    setError(String((error as Error).stack ?? error));
  }
});

window.addEventListener('beforeunload', (event) => {
  if (!state.dirty) return;
  event.preventDefault();
});

// A song handed over to this page -- from the MIDI page, say -- opens for editing.
try {
  const stored = sessionStorage.getItem(HANDOFF_KEY);
  if (stored !== null) {
    sessionStorage.removeItem(HANDOFF_KEY);
    const seq = JSON.parse(stored) as Sequencer;
    openSong(songFromSequencer(seq), `opened "${seq.name}"`);
    drop.loaded(true);
    drop.say(`${seq.name} — handed over`);
  }
} catch {
  // storage refused, or not ours; nothing was handed over
}

void ensureAssets().catch((error: unknown) => {
  setStatus('the game\'s instruments are not available: extract them first', true);
  setError(String((error as Error).stack ?? error));
});

updateTitle();
mountFooter();

// Everything a console session needs to poke the page, as the bench does.
(window as unknown as { __lbpEditor: unknown }).__lbpEditor = { state, player, board, roll };
