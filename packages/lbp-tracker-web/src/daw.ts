/**
 * The app: one page, one song, five views.
 *
 * The top bar holds the views' tabs, the transport and the file actions; the
 * views mount into their sections and share the song through `daw/session.ts`.
 * This file is the shell: tabs, transport, file panel, status, the global
 * keys. Everything a view does is in `daw/*`.
 */

import { sequencersOf, type BackupResult } from '@lbptracker/cwlib/backup.ts';
import type { Sequencer } from '@lbptracker/cwlib/project.ts';
import { songFromJson, songFromSequencer, newSong } from '@lbptracker/lib/song.ts';
import { mountFooter } from './footer.ts';
import { mountHelp } from './help.ts';
import { confirmDialog } from './confirm.ts';
import { APP_VERSION } from './version.ts';
import { isSongFile, openedTitle, readOpened, saveNote, type Opened } from './open-level.ts';
import { seqPicker } from './seq-picker.ts';
import { saveSongFile } from './song-file.ts';
import { mountOpen } from './widgets/open-panel.ts';
import {
  RATE, clock, ensureAssets, onPlan, onPlayer, onStatus, openSong, player, setError,
  setErrorSink, setStatus, state,
} from './daw/session.ts';
import { mountArrange } from './daw/arrange.ts';
import { mountMixer } from './daw/mixer.ts';
import { mountRender } from './daw/render-view.ts';
import { mountConvert } from './daw/convert-view.ts';
import { mountKeyboard } from './daw/keyboard-view.ts';
import type { Health } from './player.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// -------------------------------------------------------------------- status

const statusLine = $<HTMLDivElement>('status');
onStatus((text, bad) => {
  statusLine.textContent = text;
  statusLine.classList.toggle('bad', bad);
});
const errorCard = $<HTMLElement>('errorCard');
const errorBox = $<HTMLPreElement>('error');
setErrorSink((text) => {
  errorBox.textContent = text;
  errorCard.classList.toggle('show', text !== '');
});

// ---------------------------------------------------------------------- tabs

export type ViewName = 'home' | 'arrange' | 'mixer' | 'render' | 'convert' | 'keyboard';
const tabs = [...document.querySelectorAll<HTMLButtonElement>('.tabs [data-view]')];
const viewListeners = new Set<(view: ViewName) => void>();
let current: ViewName = 'home';

export const activeView = (): ViewName => current;

function showView(view: ViewName): void {
  current = view;
  document.body.dataset.view = view;
  for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.view === view));
  for (const section of document.querySelectorAll<HTMLElement>('.view')) {
    section.hidden = section.id !== `view-${view}`;
  }
  for (const l of viewListeners) l(view);
}
for (const tab of tabs) tab.addEventListener('click', () => showView(tab.dataset.view as ViewName));
/** A song just opened from the home view: show it. Any other view keeps its place. */
const leaveHome = () => { if (current === 'home') showView('arrange'); };
// The brand is the way to the home view: a presentation, over the song that
// stays open -- not a reload, which would lose it.
$('brand').addEventListener('click', (event) => {
  event.preventDefault();
  showView('home');
});
$('homeArrange').addEventListener('click', () => showView('arrange'));
$('homeOpen').addEventListener('click', () => $<HTMLDialogElement>('fileDialog').showModal());

// ----------------------------------------------------------------- transport

const playButton = $<HTMLButtonElement>('play');
const stopButton = $<HTMLButtonElement>('stop');
const loopButton = $<HTMLButtonElement>('loop');
const clockLabel = $<HTMLSpanElement>('clock');
const loadLabel = $<HTMLSpanElement>('load');
const volSlider = $<HTMLInputElement>('vol');
const tempoBox = $<HTMLInputElement>('tempoBox');

let health: Health = { sounding: 0, notes: 0, queued: 0, audioLoad: null, dropouts: 0, lostMs: 0 };
function showLoad(): void {
  const { sounding, notes, queued, audioLoad, dropouts, lostMs } = health;
  if (!player.playing && sounding === 0 && queued === 0) {
    loadLabel.textContent = player.hasPlan ? 'ready' : 'idle';
    return;
  }
  const dropped = dropouts === 0
    ? 'no dropouts'
    : `${dropouts} dropout${dropouts === 1 ? '' : 's'}${lostMs >= 1 ? ` (${lostMs.toFixed(0)} ms lost)` : ''}`;
  // The audio thread's worst block as a share of realtime -- the CPU figure
  // the old page showed; null when the worklet has no clock to measure with.
  const busy = audioLoad === null ? '' : ` · audio ${(audioLoad * 100).toFixed(1)}%`;
  loadLabel.textContent = `${notes} notes${busy} · ${dropped}`;
}
function paintClock(): void {
  clockLabel.textContent = `${clock(player.position() / RATE)} / ${clock(player.songSeconds)}`;
}
onPlayer({
  health: (h) => {
    health = h;
    showLoad();
  },
  tick: paintClock,
  playing: (on) => {
    playButton.textContent = on ? '⏸' : '▶';
    playButton.setAttribute('aria-label', on ? 'Pause' : 'Play');
    showLoad();
  },
});
onPlan(() => {
  playButton.disabled = false;
  stopButton.disabled = false;
  paintClock();
  showLoad();
});
playButton.addEventListener('click', () => (player.playing ? player.stop() : player.play()));
// Stop: silence, and back to the start -- a stop, not a pause; the pause is
// the play button pressed again.
stopButton.addEventListener('click', () => {
  // Stop drops the chip loop too: what plays next is the song from the top.
  window.dispatchEvent(new Event('lbp:stop'));
  player.stop();
  player.seek(0);
});
// Loop is the song's own flag -- the same one the Song/Mixer view ticks -- so
// the button edits the song, and the header pass mirrors it into the player.
loopButton.addEventListener('click', () => {
  state.edit('selection', (s) => { s.loop = !s.loop; });
});
volSlider.addEventListener('input', () => player.setVolume(Number(volSlider.value)));
player.setVolume(Number(volSlider.value));

/**
 * The VU meter: two bars, left over right, the output's peak after the master
 * fader on a -60..0 dB scale, with a peak-hold mark that falls back. Drawn
 * every frame once the audio exists; reading two analysers is nothing.
 */
const vu = $<HTMLCanvasElement>('vu');
const vuCtx = vu.getContext('2d')!;
const held = [0, 0];
const shown = [0, 0];
function drawVu(): void {
  const peaks = player.peaks();
  const { width, height } = vu;
  vuCtx.clearRect(0, 0, width, height);
  if (peaks) {
    peaks.forEach((peak, i) => {
      // Amplitude to a bar: -60 dB is empty, 0 dB is full.
      const db = peak > 0 ? 20 * Math.log10(peak) : -120;
      const level = Math.max(0, Math.min(1, (db + 60) / 60));
      // The bar falls a little slower than the signal; the hold mark slower still.
      shown[i] = Math.max(level, shown[i] - 0.06);
      held[i] = Math.max(shown[i], held[i] - 0.01);
      const y = i * (height / 2);
      const h = height / 2 - 1;
      const w = Math.round(shown[i] * width);
      const grad = vuCtx.createLinearGradient(0, 0, width, 0);
      grad.addColorStop(0, '#6fd3a0');
      grad.addColorStop(0.75, '#e3b341');
      grad.addColorStop(1, '#ef6b6b');
      vuCtx.fillStyle = grad;
      vuCtx.fillRect(0, y, w, h);
      if (held[i] > 0.01) {
        vuCtx.fillStyle = held[i] > 0.98 ? '#ef6b6b' : '#e8eaee';
        vuCtx.fillRect(Math.min(width - 2, Math.round(held[i] * width) - 1), y, 2, h);
      }
    });
  }
  requestAnimationFrame(drawVu);
}
drawVu();

tempoBox.addEventListener('change', () => {
  const tempo = Math.max(20, Math.min(400, Math.round(Number(tempoBox.value)) || state.song.tempo));
  tempoBox.value = String(tempo);
  if (tempo !== state.song.tempo) state.edit('settings', (s) => { s.tempo = tempo; }, 'tempo');
});

// ---------------------------------------------------------------- the title

const songName = $<HTMLSpanElement>('songName');
const dirty = $<HTMLSpanElement>('dirty');
function refreshHeader(): void {
  loopButton.setAttribute('aria-pressed', String(state.song.loop));
  player.loop = state.song.loop;
  // Read-only here: the name is edited under Song/Mixer with the description.
  songName.textContent = state.song.name || 'untitled';
  if (document.activeElement !== tempoBox) tempoBox.value = String(state.song.tempo);
  dirty.textContent = state.dirty ? '•' : '';
  document.title = `LBP Tracker${state.dirty ? ' •' : ''} · ${state.song.name || 'untitled'}`;
}
state.onChange(refreshHeader);

// ----------------------------------------------------------------- the files

/** What a level gave us, by the picker's key. Picking one makes it the song. */
let songs = new Map<string, Sequencer>();
const fileDialog = $<HTMLDialogElement>('fileDialog');
$('openToggle').addEventListener('click', () => fileDialog.showModal());
$('fileClose').addEventListener('click', () => fileDialog.close());
fileDialog.addEventListener('click', (event) => {
  if (event.target === fileDialog) fileDialog.close();
});

const picker = seqPicker($<HTMLDivElement>('seq'), async (key) => {
  const seq = songs.get(key);
  if (!seq) return;
  if (state.dirty && !(await confirmDialog('Throw away the unsaved changes?', 'throw them away'))) return;
  openSong(songFromSequencer(seq), `opened "${seq.name}"`);
  fileDialog.close();
});

const drop = mountOpen('#open', { onOpen: (opened) => openLevel(opened) });

async function openLevel(opened: Opened): Promise<void> {
  setError('');
  drop.busy(true);
  setStatus(`reading ${opened.label}…`);
  try {
    await ensureAssets();
    const only = opened.files.length === 1 ? opened.files[0] : undefined;
    // One of our own song files opens as the song it holds -- ids, names and
    // grid lengths intact -- rather than through the sequencer it also is.
    if (only && isSongFile(only)) {
      openSong(songFromJson(new TextDecoder().decode(only.bytes)), `opened ${only.name}`);
      leaveHome();
      drop.loaded(true);
      drop.say(only.name);
      songs = new Map();
      picker.setRows([]);
      fileDialog.close();
      return;
    }
    const result: BackupResult = await readOpened(opened.files);
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
      leaveHome();
      // One song: nothing to choose, so the dialog can go. Several: leave the
      // picker in view, the choice is the point.
      if (rows.length === 1) fileDialog.close();
    } else if (note) setStatus(note, true);
    else if (result.failed.length) setStatus(`nothing to open: ${result.failed[0].why}`, true);
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

const startNew = async () => {
  if (state.dirty && !(await confirmDialog('Throw away the unsaved changes?', 'throw them away'))) return;
  songs = new Map();
  picker.setRows([]);
  openSong(newSong(), 'a new song');
  state.selection.cursor = { cell: 0, row: 0 };
  state.touch('selection');
  showView('arrange');
};
$('newSong').addEventListener('click', () => void startNew());
$('homeNew').addEventListener('click', () => void startNew());

function saveSong(): void {
  const name = saveSongFile(state.song);
  state.dirty = false;
  refreshHeader();
  setStatus(`saved ${name}`);
}
$('save').addEventListener('click', saveSong);

window.addEventListener('beforeunload', (event) => {
  if (state.dirty) event.preventDefault();
});

// --------------------------------------------------------------- the views

const isActive = (view: ViewName) => () => current === view;
const arrange = mountArrange({ isActive: isActive('arrange') });
mountMixer();
mountRender({ isActive: isActive('render') });
mountConvert({ isActive: isActive('convert'), onShow: (l) => viewListeners.add((v) => v === 'convert' && l()) });
mountKeyboard({ isActive: isActive('keyboard'), onShow: (l) => viewListeners.add((v) => v === 'keyboard' && l()) });

// Space plays and pauses from anywhere but a field.
window.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement | null;
  if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
  if (event.code !== 'Space' || !player.hasPlan) return;
  event.preventDefault();
  if (player.playing) player.stop();
  else player.play();
});

// The arrange view is fixed between the bar and the footer, whose heights
// depend on wrapping; measure them and hand them to the CSS.
const measureChrome = () => {
  const top = document.querySelector<HTMLElement>('.daw-top')?.offsetHeight ?? 0;
  const foot = document.querySelector<HTMLElement>('.daw-foot')?.offsetHeight ?? 0;
  document.documentElement.style.setProperty('--top-h', `${top}px`);
  document.documentElement.style.setProperty('--foot-h', `${foot}px`);
};
new ResizeObserver(measureChrome).observe(document.querySelector('.daw-top')!);
new ResizeObserver(measureChrome).observe(document.querySelector('.daw-foot')!);
measureChrome();

// ---------------------------------------------------------------- start up

// The site opens on the home view, over an empty song; opening or starting
// one moves to the arranger. The view is not remembered across loads.
showView('home');
refreshHeader();
void ensureAssets().catch((error: unknown) => {
  setStatus('the game\'s instruments are not available: extract them first', true);
  setError(String((error as Error).stack ?? error));
});
mountFooter();
mountHelp();
$('version').textContent = `v${APP_VERSION}`;

// Everything a console session needs to poke the app, as the bench does.
(window as unknown as { __lbpEditor: unknown }).__lbpEditor = {
  state, player, board: arrange.board, roll: arrange.roll, showView,
};
