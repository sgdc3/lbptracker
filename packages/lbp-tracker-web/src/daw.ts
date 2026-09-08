/**
 * The app: one page, one song, five views.
 *
 * The top bar holds the views' tabs, the transport and the file actions; the
 * views mount into their sections and share the song through `daw/session.ts`.
 * This file is the shell: tabs, transport, file panel, status, the global
 * keys. Everything a view does is in `daw/*`.
 */

// ❗ Both sheets from here, in this order: see the note at the top of daw.css.
import '../ui.css';
import '../daw.css';
import { sequencersOf, type BackupResult } from '@lbptracker/cwlib/backup.ts';
import type { Sequencer } from '@lbptracker/cwlib/project.ts';
import { songEndSteps, songFromJson, songFromSequencer, newSong } from '@lbptracker/lib/song.ts';
import { mountFooter } from './footer.ts';
import { mountHelp } from './help.ts';
import { confirmDialog } from './confirm.ts';
import { APP_VERSION } from './version.ts';
import { isSongFile, openedTitle, readOpened, saveNote, type Opened } from './open-level.ts';
import { seqPicker } from './seq-picker.ts';
import { saveSongFile } from './song-file.ts';
import { mountOpen } from './widgets/open-panel.ts';
import { loading } from './widgets/loading.ts';
import { pickWanted, rememberSequencer, songFromQuery } from './link.ts';
import {
  RATE, clock, ensureAssets, onPlan, onPlayer, onStatus, openSong, player, setError,
  setErrorSink, setStatus, state,
} from './daw/session.ts';
import { mountArrange } from './daw/arrange.ts';
import { mountMixer } from './daw/mixer.ts';
import { mountRender } from './daw/render-view.ts';
import { mountConvert } from './daw/convert-view.ts';
import { mountKeyboard } from './daw/keyboard-view.ts';
import { mountMediaKeys } from './daw/media-keys.ts';
import { engine } from './controls/engine.ts';
import { watch } from 'vue';
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

/**
 * The G in the bar is the master bus's own switch, not a second setting: it
 * reads and writes `optMaster`, so the Song/Mixer card and this button can
 * never disagree. What it turns on is ours and not the game's, which is what
 * the title says and why it is off to begin with.
 */
const glueButton = $<HTMLButtonElement>('glue');
const paintGlue = () => {
  const on = engine.on('optMaster');
  glueButton.setAttribute('aria-pressed', String(on));
  glueButton.classList.toggle('on', on);
};
glueButton.addEventListener('click', () => {
  engine.set('optMaster', !engine.on('optMaster'));
  paintGlue();
});
// The card under Song/Mixer moves the same switch; follow it.
watch(engine.effectsSignature, paintGlue);
paintGlue();
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

/**
 * The rows behind the picker, kept so a link can name one of them.
 *
 * ❗ **A song's name in a link is its uid**, and `link.ts` says why the file
 * sometimes has to go with it. `unique` is read once per open rather than per
 * pick: it is a property of the pile that was opened.
 */
let pickerRows: { key: string; uid: number }[] = [];
let uidIsUnique = true;

const chose = (key: string): void => {
  rememberSequencer(pickerRows.find((r) => r.key === key), uidIsUnique);
};

const picker = seqPicker($<HTMLDivElement>('seq'), async (key) => {
  const seq = songs.get(key);
  if (!seq) return;
  if (state.dirty && !(await confirmDialog('Throw away the unsaved changes?', 'throw them away'))) return;
  openSong(songFromSequencer(seq), `opened "${seq.name}"`);
  chose(key);
  fileDialog.close();
});

const drop = mountOpen('#open', { onOpen: (opened) => openLevel(opened) });

async function openLevel(opened: Opened): Promise<void> {
  setError('');
  drop.busy(true);
  setStatus(`reading ${opened.label}…`);
  // ❗ **The loader is the only thing a reader sees on some routes.** The drop
  // zone's own title lives inside `#fileDialog`, and a `?level=` link or a drop
  // on the home screen never opens that dialog; reading a big backup is
  // seconds. See `widgets/loading.ts`.
  const job = loading(`Reading ${opened.label}`, 'loading the game’s instruments…');
  try {
    await ensureAssets();
    job.note(
      opened.files.length > 1
        ? `unpacking ${opened.files.length} resources…`
        : 'unpacking the level…',
    );
    const only = opened.files.length === 1 ? opened.files[0] : undefined;
    // One of our own song files opens as the song it holds -- ids, names and
    // grid lengths intact -- rather than through the sequencer it also is.
    if (only && isSongFile(only)) {
      openSong(songFromJson(new TextDecoder().decode(only.bytes)), `opened ${only.name}`);
      leaveHome();
      drop.loaded(true);
      drop.say(only.name);
      songs = new Map();
      pickerRows = [];
      picker.setRows([]);
      fileDialog.close();
      return;
    }
    const result: BackupResult = await readOpened(opened.files);
    songs = new Map();
    for (const p of result.projects) {
      for (const sequencer of p.sequencers) songs.set(`${p.file}#${sequencer.uid}`, sequencer);
    }
    // `found` keeps the uid the picker's rows do not carry: it is what a link
    // names a song by (`link.ts`).
    const found = sequencersOf(result);
    const rows = found.map((r) => ({
      key: r.key,
      name: r.name,
      tracks: r.tracks,
      uid: r.uid,
      file: result.projects.length > 1 ? r.file : undefined,
    }));
    const first = picker.setRows(rows);
    pickerRows = found.map((r) => ({ key: r.key, uid: r.uid }));
    uidIsUnique = new Set(pickerRows.map((r) => r.uid)).size === pickerRows.length;
    drop.loaded(true);
    drop.say(openedTitle(result, rows.length, opened.label));
    const note = saveNote(result);
    // ❗ **`?seq=<uid>` opens straight into one song of the level**, which is
    // what a link to a song has to do: a level holds sixteen of them and the
    // biggest one is rarely the one being shared. A uid that is not in this
    // level falls back to the first row rather than to nothing.
    const wanted = pickWanted(found, songFromQuery(window.location.search));
    const start = wanted?.key ?? first;
    if (start) {
      const seq = songs.get(start)!;
      if (wanted) picker.select(start);
      openSong(songFromSequencer(seq), `opened "${seq.name}"`);
      chose(start);
      leaveHome();
      // One song: nothing to choose, so the dialog can go. Several: the picker
      // is the point, and it is *put up* rather than merely left up, because
      // the route that most needs it never opened it -- a `?level=` link goes
      // straight from an empty page to a song, and the other fifteen in the
      // level would be invisible. A link that named one has chosen already.
      if (rows.length === 1 || wanted) fileDialog.close();
      else if (!fileDialog.open) fileDialog.showModal();
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
    job.done();
  }
}

const startNew = async () => {
  if (state.dirty && !(await confirmDialog('Throw away the unsaved changes?', 'throw them away'))) return;
  songs = new Map();
  pickerRows = [];
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

/**
 * Unsaved work stands in the way of closing the tab: the browser asks first.
 *
 * ⚠️ **Both signals, or it is silent somewhere.** `preventDefault()` is what
 * the standard asks for and what Chrome takes; Safari and older browsers only
 * look at the legacy `returnValue`, and setting it costs nothing. The browser
 * writes its own wording either way, and it only asks at all once the page has
 * been interacted with, which editing a song is.
 */
window.addEventListener('beforeunload', (event) => {
  if (!state.dirty) return;
  event.preventDefault();
  event.returnValue = '';
});

// --------------------------------------------------------------- the views

const isActive = (view: ViewName) => () => current === view;
const arrange = mountArrange({ isActive: isActive('arrange') });
mountMixer();
mountRender({ isActive: isActive('render') });
mountConvert({ isActive: isActive('convert'), onShow: (l) => viewListeners.add((v) => v === 'convert' && l()) });
mountKeyboard({ isActive: isActive('keyboard'), onShow: (l) => viewListeners.add((v) => v === 'keyboard' && l()) });
// The keyboard's media keys and the system's own transport, if the browser has them.
mountMediaKeys();

/**
 * The transport's keys, from any view but a text field.
 *
 * The set a DAW's hands already know: space plays and pauses **where it is**
 * (`player.stop` keeps the position; only the stop button rewinds), Home and
 * Enter go back to the start, End goes to the song's end, and Ctrl+S saves.
 *
 * ⚠️ **Letters stay out of here.** The Keyboard view plays notes on
 * `Z S X D C V G B H N J M , L .`, so a global `L` for loop or `M` for mute
 * would sound a note there instead. Those live in the arrange view's own
 * handler, which only answers while that view is shown.
 */
window.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement | null;
  if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
  if (event.ctrlKey || event.metaKey) {
    if (event.code !== 'KeyS' || event.shiftKey) return;
    event.preventDefault();          // the browser would offer to save the page
    saveSong();
    return;
  }
  if (!player.hasPlan) return;
  switch (event.code) {
    case 'Space':
      event.preventDefault();
      if (player.playing) player.stop();
      else player.play();
      return;
    case 'Home':
    case 'Enter':
    case 'NumpadEnter':
      // Back to the top, and still playing if it was: a DAW does not stop
      // because you asked it where the start is.
      event.preventDefault();
      player.seek(0);
      return;
    case 'End':
      event.preventDefault();
      player.seek(player.frameAt(songEndSteps(state.song)));
      return;
    default:
  }
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

// The service worker: the site installs as an app, and opens without a
// network. Not on the dev server, where it would sit between Vite and the
// page for no gain. See `public/sw.js` for why it is network-first.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').catch(() => {
      // No worker: the app runs as it always did, online only.
    });
  });
}
$('version').textContent = `v${APP_VERSION}`;

// Everything a console session needs to poke the app, as the bench does.
(window as unknown as { __lbpEditor: unknown }).__lbpEditor = {
  state, player, board: arrange.board, roll: arrange.roll, showView,
};
