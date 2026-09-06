/**
 * The live player page: a song scheduled into the audio thread instead of a file.
 *
 * ❗ **The player itself is `player.ts`**, shared with the editor since the
 * editor needed to play what it edits. This file is the page around it: the
 * drop zone, the picker, the transport, the meters, the control grids, and
 * the handoff from the MIDI page. Everything about *when* a voice is handed
 * over -- the plan, the pool, the look-ahead, the settings applied live -- is
 * the player's, and the reasons are written there.
 */

import { createApp, h, watch, type Component } from 'vue';
import ControlPanel from './controls/ControlPanel.vue';
import { live } from './controls/live.ts';
import { CONTROLS } from './controls/kit.ts';
import { HANDOFF_KEY, loaderFor, manifest, type Manifest } from './assets.ts';
import { seqPicker } from './seq-picker.ts';
import { readBackup, sequencersOf, type BackupResult } from '@lbptracker/cwlib/backup.ts';
import {
  CHANNEL_COUNT, type LevelProject, type Sequencer,
} from '@lbptracker/cwlib/project.ts';
import { isZip, openedTitle, saveNote } from './open-level.ts';
import { mountOpen } from './widgets/open-panel.ts';
import { readBackupZip } from '@lbptracker/cwlib/backup.ts';
import { webInflateRaw } from '@lbptracker/cwlib/platform/web.ts';
import { VOICES_UNLIMITED, VOICE_POOL_SIZE } from '@lbptracker/lib/polyphony.ts';
import { RATE, type InstrumentLoader } from '@lbptracker/lib/render.ts';
import { webInflate } from '@lbptracker/cwlib/platform/web.ts';
import { mountFooter } from './footer.ts';
import { Player, type Health } from './player.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const seqHost = $<HTMLDivElement>('seq');
const playButton = $<HTMLButtonElement>('play');
const rewindButton = $<HTMLButtonElement>('rewind');
const statusLine = $<HTMLDivElement>('status');
const clockLabel = $<HTMLSpanElement>('clock');
const loadLabel = $<HTMLSpanElement>('load');
const timeline = $<HTMLDivElement>('timeline');
const head = $<HTMLDivElement>('head');
const density = $<HTMLCanvasElement>('density');
const metersBox = $<HTMLDivElement>('meters');
const errorCard = $<HTMLElement>('errorCard');
const errorBox = $<HTMLPreElement>('error');
const drop = mountOpen('#open', { onOpen: (opened) => openBackup(opened) });
const volSlider = $<HTMLInputElement>('vol');

/**
 * The three control grids, as Vue islands.
 *
 * ⚠️ **Three mounts rather than one panel**: the page draws the voice pool
 * inside a `<details>`, the song's own settings in section 4 and the output
 * stage in section 5, so `only` picks the groups for each. `src/controls/live.ts`
 * is the single declaration behind all three.
 */
const island = (root: Component, at: string, props?: Record<string, unknown>) => {
  const app = createApp(props ? { render: () => h(root, props) } : root);
  app.provide(CONTROLS, live);
  app.mount(at);
};
island(ControlPanel, '#pool-panel', { only: ['pool'], grid: 'live' });
island(ControlPanel, '#song-panel', { only: ['timing', 'channels'], grid: 'live' });
island(ControlPanel, '#output-panel', { only: ['echo', 'reverb'], grid: 'live' });
const staleNote = $<HTMLParagraphElement>('staleNote');
const channelsBox = $<HTMLDivElement>('channels');

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

let project: LevelProject | null = null;
/**
 * Every sequencer the open backup holds, by the picker's key.
 *
 * ⚠️ **A uid is unique inside a level, not across a backup.** A folder of
 * forty levels routinely holds two sequencers numbered 7, so the page indexes
 * on `file#uid` and keeps the level beside the song -- the renderer needs both.
 */
let songs = new Map<string, { project: LevelProject; sequencer: Sequencer }>();
let rinstIndex: Manifest | null = null;
let smpIndex: Manifest | null = null;
let loader: InstrumentLoader | null = null;

/** The pool size the listener has asked for. */
const poolSize = () => (live.on('optNoCap') ? VOICES_UNLIMITED : live.raw('voices'));

let health: Health = { sounding: 0, notes: 0, queued: 0, audioLoad: null, dropouts: 0, lostMs: 0 };

const player = new Player({
  health: (h) => {
    health = h;
    showLoad();
  },
  stolen: (total) => {
    const cell = document.getElementById('stolenCell');
    if (cell) cell.textContent = total.toLocaleString();
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
  const { sounding, notes, queued, audioLoad, dropouts, lostMs } = health;
  if (!player.playing && sounding === 0 && queued === 0) {
    loadLabel.textContent = player.hasPlan ? 'ready' : 'idle';
    return;
  }
  // Dropouts rather than a load percentage: see `lastFrame` in the worklet for
  // why a percentage cannot be measured from there, and why this answers the
  // question a load meter was only being asked as a proxy for.
  const dropped = dropouts === 0
    ? 'no dropouts'
    : `${dropouts} dropout${dropouts === 1 ? '' : 's'}` +
      (lostMs >= 1 ? ` (${lostMs.toFixed(0)} ms lost)` : '');
  const busy = audioLoad === null ? '' : `· audio ${(audioLoad * 100).toFixed(1)}% `;
  // ❗ **One number, and it is the one the cap counts.** The line used to carry
  // the sampler voices and the queued count beside it; a listener called them
  // useless once the notes were there, and they were right -- the voices are a
  // consequence of the notes (stack layers, releases, one-shot tails) and the
  // queue is an artefact of this page's look-ahead, not of the music. Both are
  // still measured, one is in the tooltip, and neither is on the line.
  //
  // ❌ The red flag that used to be here was on the VOICES and was wrong by
  // construction: `sounding` counts sampler voices and the pool counts notes,
  // so it fired constantly on music that was entirely correct (measured on
  // `C4K3 S0NG` at 25.85 s: 164 voices against 19 notes, pool not even full).
  // This one is on the notes, which is the number the cap is about.
  //
  // ⚠️ **It is still not the count of records held, and it reads high.** A note
  // keeps its tag while it rings out, and with the release tail off the pool
  // gives its record back at the gate -- so a passage of long releases lights
  // the warning with slots to spare. Measured on `C4K3 S0NG`, pool 32: see
  // question 17b. The alarm is "the engine is near its limit here", not "a
  // voice is being stolen right now"; `stolen` in the table below is that.
  // "Close to" is within an eighth of the cap -- 28 at the engine's 32 --
  // rather than a fixed distance, because the box goes down to 1 and `cap - 4`
  // would be red at every size a listener uses to hear the pool work.
  const cap = poolSize();
  const tight = Number.isFinite(cap) && notes >= Math.max(1, Math.ceil(cap * 0.875));
  loadLabel.innerHTML =
    `<span class="${tight ? 'bad' : ''}" title="Notes sounding: the unit the ` +
    `voice cap counts, though a note keeps its place here while it rings out. ` +
    `${sounding} sampler voices are rendering them, ${queued} more are queued.">` +
    `${notes} notes</span> ${busy}· ` +
    `<button type="button" class="drops${dropouts > 0 ? ' bad' : ''}" ` +
    `title="Click to reset the count">${dropped}</button>`;
}

/**
 * The two switches that are decided when a song is prepared, not while it plays.
 *
 * ⚠️ **Neither can be live, and pretending otherwise would be a lie in the
 * UI.** The pan width is folded into each voice as it is built, and the voice
 * pool's stealing is decided over the whole note list at once -- the allocator
 * needs every note to know which ones lose their record. Moving either marks the
 * plan stale rather than doing nothing quietly.
 */
const planOptions = () => ({
  // ❗ And no cap: the pool is applied live, per note. See `Planned` in player.ts.
  voiceLimit: VOICES_UNLIMITED,
});

let preparedWith = '';
const markStale = () => {
  staleNote.hidden = !player.hasPlan || JSON.stringify(planOptions()) === preparedWith;
};

/** Push the song's own output stage, with whatever the knobs currently say. */
function pushEffects(): void {
  player.setEffects({
    echoTime: live.value('echoTime'),
    feedback: live.value('echoFb'),
    mix: live.value('echoMix'),
    reverbSetting: live.value('reverbSet'),
    echoOn: live.on('optEcho'),
    reverbOn: live.on('optReverb'),
    clip: live.on('optClip'),
  });
}

// ------------------------------------------------------------------ the plan

/**
 * Build the plan, and put the transport where the caller asks.
 *
 * `restart` is the whole difference between picking a song and changing the
 * voice pool: one starts from the top, the other keeps playing.
 */
async function prepare(restart = true): Promise<void> {
  const chosen = songs.get(picker.value());
  const original = chosen?.sequencer;
  if (!original || !chosen || !rinstIndex || !smpIndex) return;
  project = chosen.project;

  if (restart) {
    setError('');
    setStatus(`getting "${original.name}" ready — ${original.tracks.length} tracks…`);
  }
  loader ??= await loaderFor(rinstIndex, smpIndex);

  // The song's own output stage, so the knobs start where the sequencer has them
  // rather than at a made-up default. `echoTime` is in beats and the slider is
  // tenths of a beat; `reverb` is the setting index straight through.
  // ❗ **No `* 10` or `* 100` here any more.** `setValue` is the spec's own
  // inverse of `value`, so the number written from a song and the number read
  // back for the worklet cannot use different scales.
  live.setValue('echoTime', original.echoTime);
  live.setValue('echoFb', original.echoFeedback);
  live.setValue('echoMix', original.echoMix);
  live.setValue('reverbSet', original.reverb);
  pushEffects();
  player.setPool(poolSize());

  const loaded = await player.load(original, loader, restart);
  preparedWith = JSON.stringify(planOptions());
  drawDensity();

  playButton.disabled = false;
  rewindButton.disabled = false;
  timeline.setAttribute('aria-valuemax', player.songSeconds.toFixed(1));
  metersBox.innerHTML = [
    ['voices', loaded.voices.toLocaleString()],
    // ⚠️ "skipped" means the instrument was not there, not that the pool dropped
    // the note: `renderSequencer` counts a note as skipped when
    // `loadInstrument` returns nothing for its GUID, which happens when that
    // instrument is missing from the extracted assets. It reads 0 on a complete
    // extraction, and the label says which question it is answering.
    [
      'notes',
      `${loaded.played.toLocaleString()} played` +
        (loaded.skipped > 0 ? `, ${loaded.skipped} with no instrument` : ''),
    ],
    // Counted as the song plays rather than read off a finished plan: the pool
    // decides its stealing live now, so this is the only place the number
    // exists. Updated through the player's `stolen` event.
    ['stolen so far', '<b id="stolenCell">0</b>'],
    ['samples', String(loaded.samples)],
    ['length', `${clock(player.songSeconds)} at ${player.tempo} BPM`],
  ]
    .map(([k, v]) => `<span>${k} ${v.startsWith('<b') ? v : `<b>${v}</b>`}</span>`)
    .join('');
  if (restart) {
    live.setValue('tempo', original.tempo);
    live.setValue('swing', original.swing);
    live.setValue('numChannels', Math.min(CHANNEL_COUNT, Math.max(1, original.numChannels)));
    buildFaders(original, original.volumes);
    showSongOptions();
  }
  markStale();
  paint();
  setStatus(`ready — ${loaded.voices.toLocaleString()} voices scheduled, press play`);
}

/** A voice-per-second histogram, so the song has a shape before it plays. */
function drawDensity(): void {
  const ctx = density.getContext('2d')!;
  const { width, height } = density;
  ctx.clearRect(0, 0, width, height);
  if (!player.hasPlan) return;
  const bins = player.densityBins(width);
  const peak = Math.max(...bins) || 1;
  ctx.fillStyle = '#3d4a52';
  for (let x = 0; x < width; x += 1) {
    const h = Math.max(1, (bins[x] / peak) * (height - 8));
    ctx.fillRect(x, height - h, 1, h);
  }
}

// ---------------------------------------------------------------- transport

function paint(): void {
  const frames = player.position();
  const ratio = player.songFrames > 0 ? Math.min(1, frames / player.songFrames) : 0;
  head.style.left = `${ratio * 100}%`;
  clockLabel.textContent = `${clock(frames / RATE)} / ${clock(player.songSeconds)}`;
  timeline.setAttribute('aria-valuenow', (frames / RATE).toFixed(1));
  timeline.setAttribute('aria-valuetext', `${clock(frames / RATE)} of ${clock(player.songSeconds)}`);
}

// -------------------------------------------------------------------- wiring

playButton.addEventListener('click', () => (player.playing ? player.stop() : player.play()));
rewindButton.addEventListener('click', () => player.seek(0));

timeline.addEventListener('pointerdown', (event) => {
  if (!player.hasPlan) return;
  const box = timeline.getBoundingClientRect();
  player.seek(((event.clientX - box.left) / box.width) * player.songFrames);
});

window.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement | null;
  if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
  if (event.code !== 'Space' || !player.hasPlan) return;
  event.preventDefault();
  if (player.playing) player.stop();
  else player.play();
});

// Delegated, because `showLoad` replaces the button ten times a second.
loadLabel.addEventListener('click', (event) => {
  if (!(event.target as HTMLElement).closest('.drops')) return;
  player.resetHealth();
});

volSlider.addEventListener('input', () => player.setVolume(Number(volSlider.value)));
player.setVolume(Number(volSlider.value));

// One watcher for the whole output stage, generated from the spec's `effects`
// flags rather than listed here — see `Controls.effectsSignature`.
watch(live.effectsSignature, () => pushEffects());

// The plan-time pair. Their labels come from the spec; their effect waits for
// Prepare.
live.setValue('voices', VOICE_POOL_SIZE);

/**
 * One fader per channel the song has, with how many tracks land on each.
 *
 * ⚠️ **The count is the point of the display.** A board row feeds
 * `row mod NumChannels`, so rows far apart share a fader and raising the channel
 * count fans the same rows out rather than adding parts. Seeing 1150 tracks on
 * one fader, then 600 and 550 on two, is what makes that legible.
 *
 * Existing positions are carried over so that changing the count does not throw
 * away a mix -- a channel that survives keeps its level.
 */
function buildFaders(
  seq: { tracks: readonly { gridY: number }[]; volumes: readonly number[] },
  levels: readonly number[],
): void {
  const count = Math.min(CHANNEL_COUNT, Math.max(1, live.raw('numChannels')));
  const perChannel = new Array<number>(count).fill(0);
  for (const t of seq.tracks) {
    perChannel[((t.gridY % count) + count) % count] += 1;
  }
  channelsBox.innerHTML = Array.from({ length: count }, (_, i) => {
    const v = i < levels.length ? levels[i] : 1;
    const used = perChannel[i];
    return (
      `<div class="knob"><label for="ch${i}" title="${used} track${used === 1 ? '' : 's'} ` +
      `on this channel">ch ${i} · ${used}</label>` +
      `<input type="range" id="ch${i}" class="chan" data-ch="${i}" min="0" max="150" ` +
      `value="${Math.round(v * 100)}"${used === 0 ? ' disabled' : ''}>` +
      `<output id="ch${i}Label">${v.toFixed(2)}</output></div>`
    );
  }).join('');
}

/** Labels for the channel strip: built imperatively per song, so not the spec's to draw. */
const showSongOptions = () => {
  for (const el of channelsBox.querySelectorAll<HTMLInputElement>('.chan')) {
    const out = document.getElementById(`ch${el.dataset.ch}Label`);
    if (out) out.textContent = (Number(el.value) / 100).toFixed(2);
  }
};

/**
 * Tempo, swing, channel count and the faders, applied without a rebuild.
 *
 * ✅ **Nothing the audio thread is working on is regenerated** -- see
 * `Player.setSettings` for why, and for the bug that shipped when the playhead
 * was allowed to move backwards.
 */
const songChanged = () => {
  showSongOptions();
  if (!player.hasPlan) return;
  player.setSettings({
    tempo: live.value('tempo'),
    swing: live.value('swing'),
    numChannels: live.raw('numChannels'),
    volumes: [...channelsBox.querySelectorAll<HTMLInputElement>('.chan')].map(
      (el) => Number(el.value) / 100,
    ),
  });
  timeline.setAttribute('aria-valuemax', player.songSeconds.toFixed(1));
  drawDensity();
  paint();
};

/**
 * Changing the count redraws the faders before the rest of the handler reads
 * them, keeping the levels of the channels that survive.
 */
watch(
  () => live.raw('numChannels'),
  () => {
    const seq = songs.get(picker.value())?.sequencer;
    if (seq) {
      const kept = [...channelsBox.querySelectorAll<HTMLInputElement>('.chan')].map(
        (el) => Number(el.value) / 100,
      );
      buildFaders(seq, kept.length ? kept : seq.volumes);
    }
    songChanged();
  },
);

watch(() => [live.raw('tempo'), live.raw('swing')], songChanged);
channelsBox.addEventListener('input', songChanged);

/**
 * The pool re-sizes without stopping.
 *
 * ❗ No rebuild at all: the plan has no cuts in it, so a new size is a new
 * pool and nothing else, replayed up to the playhead by the player.
 */
const replanSoon = () => {
  markStale();
  if (!player.hasPlan) return;
  player.setPool(poolSize());
  setStatus(
    `voice pool ${live.on('optNoCap') ? 'uncapped' : live.raw('voices')} — ` +
      `${player.plan.length.toLocaleString()} voices`,
  );
};
watch(() => [live.raw('voices'), live.on('optNoCap')], replanSoon);
markStale();

/**
 * Choosing a song gets it ready. There is no button for it.
 *
 * ⚠️ Preparing means running the whole render's voice pass, which is where the
 * voice pool decides its stealing -- it cannot be skipped or done lazily. It is
 * fast (about a second for a five-minute song), so making the listener ask for
 * it twice, once by picking and once by pressing, bought nothing.
 */
const prepareNow = () => {
  player.stop();
  void prepare().catch((error: unknown) => {
    setStatus('failed', true);
    setError(String((error as Error).stack ?? error));
  });
};
const picker = seqPicker(seqHost, prepareNow);

// ------------------------------------------------------------------ the file

/**
 * Open whatever was dropped: one level, a backup folder, or a zip of one.
 *
 * ❗ A backup is a pile of resources named after their SHA-1, so the page reads
 * the pile and reports what was in it -- a listener should never have to find
 * the level among forty extensionless files by hand.
 */
async function openBackup(opened: {
  label: string;
  files: readonly { name: string; bytes: Uint8Array }[];
  many: boolean;
}): Promise<void> {
  player.clear();
  playButton.disabled = true;
  rewindButton.disabled = true;
  metersBox.innerHTML = '';
  setError('');
  drop.busy(true);
  setStatus(`reading ${opened.label}…`);
  try {
    const only = opened.files.length === 1 ? opened.files[0] : undefined;
    const result: BackupResult = only && isZip(only)
      ? await readBackupZip(only.bytes, webInflate, webInflateRaw)
      : await readBackup(opened.files, webInflate);
    [rinstIndex, smpIndex] = await Promise.all([
      manifest('fixtures/rinst'),
      manifest('fixtures/smp'),
    ]);
    songs = new Map();
    for (const p of result.projects) {
      for (const sequencer of p.sequencers) {
        songs.set(`${p.file}#${sequencer.uid}`, { project: p, sequencer });
      }
    }
    const rows = sequencersOf(result).map((r) => ({
      key: r.key,
      name: r.name,
      tracks: r.tracks,
      // Only worth showing when there is more than one level to tell apart.
      file: result.projects.length > 1 ? r.file : undefined,
    }));
    project = result.projects[0] ?? null;
    picker.setRows(rows);
    drop.loaded(true);
    drop.say(openedTitle(result, rows.length, opened.label), 'Click, or drop a level, a backup folder or a zip.');
    // ⚠️ A save game that would not open is a bug here and says so; one that
    // opened needs no sentence, because its levels are in the list.
    const note = saveNote(result);
    if (rows.length) prepareNow();
    else if (note) setStatus(note, true);
    else if (result.failed.length) {
      setStatus(`nothing playable: ${result.failed[0].why}`, true);
    } else setStatus('no sequencers in there', true);
    // ⚠️ A level that would not open is reported, never swallowed: a backup
    // where one of forty fails is a bug here and should look like one.
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

/**
 * A song handed over by the MIDI page or the editor, if there is one.
 *
 * ⚠️ **Taken once and then removed.** It is a one-way handover, not a
 * setting: leaving it in `sessionStorage` would resurrect last week's import
 * every time this tab was reloaded, in front of whatever level was open.
 */
async function takeHandoff(): Promise<void> {
  let stored: string | null = null;
  try {
    stored = sessionStorage.getItem(HANDOFF_KEY);
    if (stored !== null) sessionStorage.removeItem(HANDOFF_KEY);
  } catch {
    return; // storage refused; nothing was handed over
  }
  if (stored === null) return;
  drop.busy(true);
  setStatus('reading the imported song…');
  try {
    const seq = JSON.parse(stored) as LevelProject['sequencers'][number];
    project = { file: `${seq.name}.mid`, kind: 'level', sequencers: [seq] };
    [rinstIndex, smpIndex] = await Promise.all([
      manifest('fixtures/rinst'),
      manifest('fixtures/smp'),
    ]);
    const key = `${project.file}#${seq.uid}`;
    songs = new Map([[key, { project: project as LevelProject, sequencer: seq }]]);
    picker.setRows([{ key, name: seq.name, tracks: seq.tracks.length }]);
    drop.loaded(true);
    drop.say(`${seq.name} — handed over`, 'Click or drop to open a level instead.');
    prepareNow();
  } catch (error) {
    setStatus('the imported song could not be read', true);
    setError(String((error as Error).stack ?? error));
  } finally {
    drop.busy(false);
  }
}

void takeHandoff();

void project;

mountFooter();
