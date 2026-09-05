/**
 * The MIDI page: a sequencer out to a `.mid`, and any `.mid` back in.
 *
 * The conversion itself is `src/core/midi.ts`, which is where the interesting
 * decisions and the corrected mistakes live. This file is the page around it --
 * the two drop zones, the pickers, and the tally that says what the conversion
 * could and could not carry.
 *
 * ⚠️ **The tally is not decoration.** Every honest converter loses something,
 * and the one this replaces lost its glides silently. Whatever this drops is
 * counted and shown, so nobody discovers it by ear a week later.
 *
 * Playing an imported file hands it to the live player rather than growing a
 * second one here: `dev/live.ts` already has the transport, the effects, the
 * mixer faders and the voice pool, and a second copy of any of that is exactly
 * the duplication `dev/assets.ts` and `dev/seq-picker.ts` exist to prevent.
 */

import { HANDOFF_KEY, manifest, type Manifest } from './assets.ts';
import { seqPicker } from './seq-picker.ts';
import {
  DEFAULT_BEND_RANGE,
  midiToSequencer,
  sequencerToMidi,
  splitSequencerToMidi,
  type MidiExportResult,
  type MidiImportResult,
  type MidiSplit,
} from '../src/core/midi.ts';
import { writeZip } from '../src/core/zip.ts';
import {
  readBackup, readBackupZip, sequencersOf, type BackupResult,
} from '../src/core/backup.ts';
import { type LevelProject, type Sequencer } from '../src/core/project.ts';
import { isZip, openedTitle, saveNote, wireOpen, type Opened } from './open-level.ts';
import { webInflateRaw } from '../src/platform/web.ts';
import { webInflate } from '../src/platform/web.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const dropZone = $<HTMLDivElement>('drop');
const fileInput = $<HTMLInputElement>('file');
const midiDrop = $<HTMLDivElement>('midiDrop');
const midiInput = $<HTMLInputElement>('midiFile');
const saveButton = $<HTMLButtonElement>('save');
const modeSelect = $<HTMLSelectElement>('mode');
const bakeSwing = $<HTMLInputElement>('bakeSwing');
const bendInput = $<HTMLInputElement>('bendRange');
const splitSelect = $<HTMLSelectElement>('split');
const autoBend = $<HTMLInputElement>('autoBend');
const exactBox = $<HTMLInputElement>('exact');
const mergeBox = $<HTMLInputElement>('mergeRows');
const logBox = $<HTMLDivElement>('log');

let project: LevelProject | undefined;
let rinstIndex: Manifest | undefined;
let imported: MidiImportResult | undefined;

function log(text: string, bad = false): void {
  const line = document.createElement('div');
  if (bad) line.className = 'bad';
  line.textContent = text;
  logBox.append(line);
  logBox.scrollTop = logBox.scrollHeight;
}

const setStatus = (id: string, text: string, bad = false) => {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle('bad', bad);
};

/* -------------------------------------------------------------------- tally */

interface Item {
  readonly value: string;
  readonly label: string;
  readonly warn?: boolean;
}

function showTally(host: string, items: readonly Item[]): void {
  $(host).innerHTML = items
    .map(
      (item) =>
        `<span class="item${item.warn ? ' warn' : ''}"><b>${item.value}</b>` +
        `<span>${item.label}</span></span>`,
    )
    .join('');
}

const plural = (n: number, one: string) => `${n.toLocaleString()} ${one}${n === 1 ? '' : 's'}`;

/* ------------------------------------------------------------------- export */

const picker = seqPicker($<HTMLDivElement>('seq'), () => convert());

function options() {
  return {
    mpe: modeSelect.value === 'mpe',
    bakeSwing: bakeSwing.checked,
    exact: exactBox.checked,
    mergeRows: mergeBox.checked,
    // The level stores no name on a placement, so without this every track in
    // the file is called `guid 148321` and a DAW is unreadable.
    instrumentName: (guid: number) => rinstIndex?.get(guid)?.file.replace('.rinst', ''),
    bendRange: autoBend.checked ? undefined : Number(bendInput.value),
  };
}

/**
 * What the last conversion produced, whether it came out as one file or several.
 *
 * A single file is modelled as a split of one, so everything downstream -- the
 * tally, the download, the counters -- has one shape to deal with rather than
 * two. The only difference the listener sees is whether the button says `.mid`
 * or `.zip`.
 */
let exported: MidiSplit | undefined;
let exportedName = 'song.mid';

/**
 * Convert the chosen sequencer, and say what it cost.
 *
 * Runs on every change rather than behind a button: the whole file for a big
 * level is a few tens of milliseconds, and the tally is the point -- switching
 * from MPE to plain and watching the glide count appear is how the trade
 * becomes visible.
 */
function convert(): void {
  const seq = songs.get(picker.value());
  saveButton.disabled = true;
  $('report').classList.remove('on');
  if (!seq) return;

  const opts = options();
  exported =
    splitSelect.value === 'packed'
      ? splitSequencerToMidi(seq, opts)
      : asSplit(seq, sequencerToMidi(seq, opts));
  const safe = (seq.name || `sequencer-${seq.uid}`).replace(/[^\w .-]+/g, '_').trim();
  exportedName =
    exported.files.length > 1 ? `${safe || 'song'}.zip` : (exported.files[0]?.name ?? 'song.mid');
  saveButton.textContent = exported.files.length > 1 ? 'Download .zip' : 'Download .mid';

  const lost: string[] = [];
  if (exported.droppedGlides > 0) {
    lost.push(
      `${plural(exported.droppedGlides, 'note')} lost a glide: plain mode has one channel per ` +
        `instrument, and a bend there would move the whole part. Switch to MPE to keep them.`,
    );
  }
  if (exported.flattened > 0) {
    lost.push(
      `${plural(exported.flattened, 'note')} lost a glide to a channel it had to share — the zone ` +
        `has fifteen and this passage wanted more at once. Bend and pressure belong to the ` +
        `channel, so a newcomer setting them would drag the note already there with it.`,
    );
  }
  if (exported.dropped > 0) {
    lost.push(
      `${plural(exported.dropped, 'note')} could not be written at all: more than fifteen copies ` +
        `of one pitch sounding together leaves no channel to tell them apart.`,
    );
  }
  if (exported.clampedPitch > 0) {
    lost.push(`${plural(exported.clampedPitch, 'note')} fell outside MIDI’s 0–127 and were clamped.`);
  }
  if (exported.dragged > 0) {
    lost.push(
      `${plural(exported.dragged, 'note')} sit on a channel that is being bent while they sound, ` +
        `so a synth will pull them along with it. Reading the file back here does not: the bend ` +
        `is known to belong to the note that claimed the channel.`,
    );
  }
  if (exported.clampedBend > 0) {
    lost.push(
      `${plural(exported.clampedBend, 'control point')} bent further than the range allows. Turn ` +
        `off “pick it from the music” only if you mean to.`,
    );
  }

  showTally('tally', [
    { value: exported.notes.toLocaleString(), label: 'notes' },
    { value: String(exported.parts), label: 'parts' },
    { value: exported.events.toLocaleString(), label: 'events' },
    ...(exported.files.length > 1
      ? [{ value: String(exported.files.length), label: 'files' }]
      : []),
    { value: `${(exported.bytes / 1024).toFixed(0)} kB`, label: 'in all' },
    // ⚠️ `dragged`, not `sharedChannel`. Sharing is usually free -- on
    // `Ascetic` 124 notes share and 6 are ever touched by a neighbour's bend --
    // and putting the big number in front of someone implies a damage that is
    // not there.
    ...(exported.dragged > 0
      ? [{ value: exported.dragged.toLocaleString(), label: 'take on a bend', warn: true }]
      : []),
    ...(exported.sharedChannel > 0
      ? [{ value: exported.sharedChannel.toLocaleString(), label: 'shared a channel' }]
      : []),
    ...(exported.patched > 0
      ? [{ value: exported.patched.toLocaleString(), label: 'clips carried whole' }]
      : []),
    ...(lost.length === 0 ? [{ value: '✓', label: 'nothing lost' }] : []),
  ]);
  $('lost').innerHTML = lost.map((line) => `<li>${line}</li>`).join('');
  $('report').classList.add('on');
  saveButton.disabled = false;
  setStatus(
    'status',
    `${seq.name || '(untitled)'} — ${plural(exported.notes, 'note')} over ` +
      `${plural(exported.parts, 'part')}`,
  );
}

/** One file, in the shape a split has, so the page has one path through. */
const asSplit = (seq: { name: string; uid: number }, result: MidiExportResult): MidiSplit => {
  const safe = (seq.name || `sequencer-${seq.uid}`).replace(/[^\w .-]+/g, '_').trim();
  return {
    files: [{ name: `${safe || 'song'}.mid`, result }],
    notes: result.notes,
    parts: result.parts,
    events: result.events,
    bytes: result.bytes.length,
    sharedChannel: result.sharedChannel,
    dragged: result.dragged,
    timbred: result.timbred,
    flattened: result.flattened,
    droppedGlides: result.droppedGlides,
    dropped: result.dropped,
    clampedPitch: result.clampedPitch,
    clampedBend: result.clampedBend,
    patched: result.patched,
    unpatched: result.unpatched,
  };
};

saveButton.addEventListener('click', () => {
  if (!exported) return;
  // A browser blocks a burst of downloads, so several files arrive as one zip.
  const single = exported.files.length === 1;
  const payload = single
    ? exported.files[0].result.bytes
    : writeZip(exported.files.map((f) => ({ name: f.name, bytes: f.result.bytes })));
  const blob = new Blob([payload as unknown as BlobPart], {
    type: single ? 'audio/midi' : 'application/zip',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = exportedName;
  link.click();
  // Revoked on the next turn of the loop: doing it synchronously races the
  // click in some browsers and downloads nothing.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  log(
    `saved ${exportedName} — ${(payload.length / 1024).toFixed(0)} kB` +
      (single ? '' : `, ${exported.files.length} files`),
  );
});

const showBend = () => {
  $('bendRangeLabel').textContent = autoBend.checked
    ? 'auto'
    : `±${bendInput.value}`;
  bendInput.disabled = autoBend.checked;
};
for (const el of [modeSelect, bakeSwing, bendInput, autoBend, splitSelect, exactBox, mergeBox]) {
  el.addEventListener('change', () => {
    showBend();
    convert();
  });
}
bendInput.addEventListener('input', showBend);
bendInput.value = String(DEFAULT_BEND_RANGE);
showBend();

/**
 * Every sequencer the open backup holds, by the picker's key.
 *
 * ⚠️ A uid is unique inside a level and not across a backup; see
 * `src/core/backup.ts`.
 */
let songs = new Map<string, Sequencer>();

async function openLevel(opened: Opened): Promise<void> {
  dropZone.classList.add('busy');
  rinstIndex = rinstIndex ?? (await manifest('fixtures/rinst').catch(() => undefined));
  setStatus('status', `reading ${opened.label}…`);
  try {
    const only = opened.files.length === 1 ? opened.files[0] : undefined;
    const result: BackupResult = only && isZip(only)
      ? await readBackupZip(only.bytes, webInflate, webInflateRaw)
      : await readBackup(opened.files, webInflate);
    songs = new Map();
    for (const p of result.projects) {
      for (const sequencer of p.sequencers) songs.set(`${p.file}#${sequencer.uid}`, sequencer);
    }
    project = result.projects[0] ?? null;
    const list = sequencersOf(result).map((r) => ({
      key: r.key,
      name: r.name,
      tracks: r.tracks,
      file: result.projects.length > 1 ? r.file : undefined,
    }));
    picker.setRows(list);
    dropZone.classList.add('loaded');
    const title = openedTitle(result, list.length, opened.label);
    $('dropTitle').textContent = title;
    $('dropHint').textContent = 'Click, or drop a level, a backup folder or a zip.';
    log(title);
    for (const save of result.saves) {
      log(`${save.name ?? save.folder}: save game, ${save.why ?? `${save.resources} resources`}`,
        save.why !== undefined);
    }
    // ⚠️ A level that would not open is logged, never swallowed.
    for (const bad of result.failed) log(`${bad.name}: ${bad.why}`, true);
    if (list.length) convert();
    else setStatus('status', saveNote(result) || 'no sequencers in there', true);
  } catch (error) {
    setStatus('status', String((error as Error).message ?? error), true);
    log(String(error), true);
  } finally {
    dropZone.classList.remove('busy');
  }
}

/* ------------------------------------------------------------------- import */

/**
 * Which instrument each imported part should play.
 *
 * A file this page wrote carries its GUIDs and needs nothing. A file from a DAW
 * has none, so the parts arrive silent-by-default and this is where they are
 * given a voice -- one picker per part, seeded with whatever the file knew.
 */
function buildAssign(result: MidiImportResult): void {
  const host = $('assign');
  if (!rinstIndex) {
    host.innerHTML = '';
    return;
  }
  const instruments = [...rinstIndex.entries()]
    .map(([guid, row]) => ({ guid, name: row.file.replace('.rinst', '') }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // Parts, not clips: a long song is re-cut into many clips of the same part.
  const parts = new Map<string, { name: string; guid: number; clips: number }>();
  for (const track of result.sequencer.tracks) {
    const key = `${track.name}|${track.gridY}`;
    const found = parts.get(key);
    if (found) found.clips += 1;
    else parts.set(key, { name: track.name, guid: track.guid, clips: 1 });
  }
  host.innerHTML =
    '<p class="hintline" style="margin-bottom:.4rem">what each part plays</p>' +
    [...parts.entries()]
      .map(([key, part]) => {
        const known = rinstIndex?.has(part.guid) ?? false;
        return (
          `<div class="row" style="margin-top:.35rem"><label style="min-width:11rem" ` +
          `for="asg${key}">${part.name || '(unnamed)'}</label>` +
          `<select data-part="${key}" id="asg${key}">` +
          instruments
            .map(
              (i) =>
                `<option value="${i.guid}"${known && i.guid === part.guid ? ' selected' : ''}>` +
                `${i.name}</option>`,
            )
            .join('') +
          `</select><span class="hintline" style="margin:0">${plural(part.clips, 'clip')}` +
          `${known ? ' · from the file' : ''}</span></div>`
        );
      })
      .join('');
}

/** The imported sequencer with the assignment applied. */
function assigned(): Sequencer | undefined {
  if (!imported) return undefined;
  const chosen = new Map<string, number>();
  for (const select of $('assign').querySelectorAll<HTMLSelectElement>('select[data-part]')) {
    chosen.set(String(select.dataset.part), Number(select.value));
  }
  return {
    ...imported.sequencer,
    tracks: imported.sequencer.tracks.map((track) => {
      const guid = chosen.get(`${track.name}|${track.gridY}`);
      return guid === undefined ? track : { ...track, guid };
    }),
  };
}

async function openMidi(file: File): Promise<void> {
  midiDrop.classList.add('busy');
  setStatus('midiStatus', `reading ${file.name}…`);
  $('inReport').classList.remove('on');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    imported = midiToSequencer(bytes, {
      fallbackName: file.name.replace(/\.midi?$/i, ''),
      // ❗ The same manifest that named the GUIDs on the way out, read
      // backwards: it is what lets a track renamed `row 4 - piano` in a DAW
      // come back playing the piano.
      instrumentGuid: (name) => {
        for (const [guid, entry] of rinstIndex ?? []) {
          if (entry.file.replace('.rinst', '') === name) return guid;
        }
        return undefined;
      },
    });
    rinstIndex = rinstIndex ?? (await manifest('fixtures/rinst'));

    const lost: string[] = [];
    if (imported.unmatched > 0) {
      lost.push(`${plural(imported.unmatched, 'note')} had no note-off and were ended at the last event.`);
    }
    if (imported.lengthened > 0) {
      lost.push(
        `${plural(imported.lengthened, 'note')} were shorter than a sixteenth and were stretched ` +
          `to one: the sequencer's grid has no room below that.`,
      );
    }
    if (imported.dropped > 0) {
      lost.push(`${plural(imported.dropped, 'note')} were longer than a 128-step clip and were dropped.`);
    }
    showTally('inTally', [
      { value: imported.notes.toLocaleString(), label: 'notes' },
      { value: String(imported.clips), label: 'clips' },
      { value: `${Math.round(imported.sequencer.tempo)}`, label: 'BPM' },
      { value: imported.ours ? 'ours' : 'foreign', label: imported.ours ? 'written here' : 'from elsewhere' },
      ...(lost.length > 0 ? [{ value: String(lost.length), label: 'things to know', warn: true }] : []),
    ]);
    buildAssign(imported);
    $('inReport').classList.add('on');
    $<HTMLButtonElement>('play').disabled = false;
    setStatus(
      'midiStatus',
      `${file.name} — ${plural(imported.notes, 'note')} in ${plural(imported.clips, 'clip')}`,
    );
    for (const line of lost) log(line);
    midiDrop.classList.add('loaded');
    $('midiTitle').textContent = `${file.name} — ${plural(imported.notes, 'note')}`;
    $('midiHint').textContent = 'Click or drop to open a different file.';
  } catch (error) {
    setStatus('midiStatus', String((error as Error).message ?? error), true);
    log(String(error), true);
  } finally {
    midiDrop.classList.remove('busy');
  }
}

/**
 * Hand the imported song to the live player.
 *
 * ⚠️ `sessionStorage`, not a query string: a sequencer is a few megabytes of
 * note records for a long song and a URL is not. It is per tab and it is
 * cleared as soon as the other page has read it, so a reload there does not
 * silently resurrect an old import.
 */
$('play').addEventListener('click', () => {
  const seq = assigned();
  if (!seq) return;
  try {
    sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(seq));
  } catch (error) {
    setStatus('midiStatus', `too big to hand over: ${String((error as Error).message)}`, true);
    return;
  }
  window.location.href = './live.html';
});

/* --------------------------------------------------------------- drop zones */

function wireDrop(zone: HTMLElement, input: HTMLInputElement, open: (file: File) => void): void {
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) open(file);
  });
  for (const type of ['dragenter', 'dragover']) {
    zone.addEventListener(type, (event) => {
      event.preventDefault();
      zone.classList.add('over');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    zone.addEventListener(type, (event) => {
      event.preventDefault();
      zone.classList.remove('over');
    });
  }
  zone.addEventListener('drop', (event) => {
    const file = (event as DragEvent).dataTransfer?.files?.[0];
    if (file) open(file);
  });
}

wireOpen({
  zone: dropZone,
  fileInput,
  folderInput: (document.getElementById('folder') as HTMLInputElement | null) ?? undefined,
  fileButton: document.getElementById('pickFile'),
  folderButton: document.getElementById('pickFolder'),
  archiveButton: document.getElementById('pickArchive'),
  archiveHost: document.getElementById('archive'),
  onOpen: openLevel,
});
wireDrop(midiDrop, midiInput, (file) => void openMidi(file));
