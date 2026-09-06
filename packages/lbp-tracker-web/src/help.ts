/**
 * The help behind every "?" on the page: one dialog, one topic at a time.
 *
 * Written for the person using the app, not for the person building it: what a
 * control does and what to expect of it, never how it is implemented or where
 * a number was measured -- that belongs to `steering/`, which the site does not
 * ship. The views themselves carry as little prose as they can; a "?" beside a
 * card's title opens the topic for that card.
 *
 * A button opts in with `data-help="<topic>"`. The click is caught on the
 * document, so a button drawn later by Vue needs no wiring of its own.
 */

import changelog from '../../../CHANGELOG.md?raw';

export type HelpTopic =
  | 'changelog'
  | 'app'
  | 'open'
  | 'board'
  | 'notes'
  | 'song'
  | 'engine'
  | 'render'
  | 'export'
  | 'import'
  | 'keyboard';

interface Topic {
  readonly title: string;
  /** Paragraphs and sub-headings; trusted markup written here, never user text. */
  readonly body: string;
}

const p = (html: string) => `<p>${html}</p>`;
const h = (text: string) => `<h4>${text}</h4>`;

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The changelog, from the repository's own CHANGELOG.md: headings, bullets and
 * paragraphs are all it uses, so that is all this reads. The first heading is
 * the file's title and the note under it is for the file's editors; both stop
 * at the first version heading.
 */
function changelogHtml(md: string): string {
  const lines = md.split('\n');
  const from = lines.findIndex((l) => l.startsWith('## '));
  const out: string[] = [];
  let list: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (list.length) out.push(`<ul>${list.map((i) => `<li>${i}</li>`).join('')}</ul>`);
    if (para.length) out.push(p(para.join(' ')));
    list = [];
    para = [];
  };
  for (const raw of lines.slice(from < 0 ? 0 : from)) {
    const line = raw.trimEnd();
    if (line.startsWith('## ')) { flush(); out.push(`<h3>${escape(line.slice(3))}</h3>`); }
    else if (line.startsWith('### ')) { flush(); out.push(h(escape(line.slice(4)))); }
    else if (line.startsWith('- ')) { if (para.length) flush(); list.push(escape(line.slice(2))); }
    else if (line.startsWith('  ') && list.length) list[list.length - 1] += ' ' + escape(line.trim());
    else if (line === '') flush();
    else para.push(escape(line));
  }
  flush();
  return out.join('');
}

export const HELP: Readonly<Record<HelpTopic, Topic>> = {
  changelog: {
    title: 'What changed',
    body: changelogHtml(changelog),
  },
  app: {
    title: 'Getting around',
    body:
      p('One song is open at a time and every view works on it: <strong>Arrange</strong> to write it, ' +
        '<strong>Song/Mixer</strong> for its tempo, channels and effects, <strong>Render</strong> to make a WAV, ' +
        '<strong>Import/Export</strong> for MIDI files, <strong>Keyboard</strong> to play the instruments by hand. ' +
        'Switching views never stops the music; the brand in the corner opens the home page over the song.') +
      h('Transport') +
      p('Play and stop are in the top bar; stop also goes back to the start, and the loop button starts the song ' +
        'over when it ends. <kbd>Space</kbd> plays and pauses from any view. The clock shows where you are and how ' +
        'long the song is, the BPM box changes the tempo as it plays, the fader sets the volume, and the two bars ' +
        'above it are the left and right output levels. The status bar at the bottom says how many notes are ' +
        'sounding, how busy the audio is, and whether it has dropped out.') +
      h('Files') +
      p('<strong>new</strong> starts an empty song, <strong>open</strong> takes a level, a backup, a zip or a song file, ' +
        'and <strong>save</strong> writes the song as a file this site can open again. A dot before the name means ' +
        'there are unsaved changes; the name itself is set under Song/Mixer. Nothing you open leaves your computer.'),
  },
  open: {
    title: 'Opening something',
    body:
      p('Drop a file on the box or click it. It can be a level of your own, a save backup, a zip holding either, ' +
        'or a song file saved here. The archive search finds levels other people published and fetches them for you.') +
      p('A level holding several songs lists them below the box: pick one and it becomes the song. ' +
        'Whatever is open is replaced, so save first if it matters.'),
  },
  board: {
    title: 'The board',
    body:
      p('Every row is one line of the arrangement and every rectangle is an instrument playing there, ' +
        'as long as its note grid. One row is selected at a time: click its number, an instrument on it, ' +
        'or an empty cell. As the song plays, the note panel follows the instrument the playhead is inside on that row.') +
      h('Placing instruments') +
      p('<strong>Drag across empty cells</strong> to draw a new instrument as long as the drag, four bars at least ' +
        'and then two at a time; pick which instrument when you let go. A double-click draws a four-bar one. ' +
        'Click an instrument to open its notes, drag it to another cell, <kbd>Delete</kbd> removes it and ' +
        '<kbd>Ctrl+D</kbd> duplicates it into the cursor cell. Instruments may overlap in time, though the game\'s ' +
        'composers rarely let them.') +
      h('Rows, channels and the end') +
      p('The <strong>+</strong> under the last row adds one. To remove a row, select it and click its number, which ' +
        'turns into an <strong>&times;</strong> under the pointer; a row that holds instruments asks first. ' +
        'The <strong>M</strong> and <strong>S</strong> boxes beside a row mute it or solo it. When the song has more ' +
        'than one mixer channel a white line divides the rows into channels, top to bottom. Click the bar numbers to ' +
        'jump there; drag the dashed line at the end of the song to make room past the last instrument.'),
  },
  notes: {
    title: 'The notes',
    body:
      p('The panel shows the selected instrument\'s note grid. <strong>Click</strong> to place a note, ' +
        '<strong>drag</strong> to give it an end: sideways for a held note, diagonally for a glide. A note is a chain ' +
        'of points and the sound slides from one to the next.') +
      h('Points') +
      p('The size of a point is its volume, its colour its timbre, from blue to orange. Drag a point to move it; ' +
        '<kbd>Shift</kbd>+drag up or down changes its volume, <kbd>Alt</kbd>+drag its timbre. Double-click a line to ' +
        'add a point, double-click a point to remove it; right-click removes a point or, on the line, the whole note. ' +
        'The point card on the right edits the selected point with sliders.') +
      h('Selection and keys') +
      p('<kbd>Shift</kbd>+drag on empty space selects, <kbd>Ctrl</kbd>+click adds to the selection. Arrow keys nudge ' +
        'the selection, <kbd>+</kbd>/<kbd>-</kbd> change its volume, <kbd>[</kbd>/<kbd>]</kbd> its timbre, ' +
        '<kbd>Delete</kbd> removes it, <kbd>Ctrl+C</kbd>/<kbd>V</kbd> copy and paste, <kbd>Ctrl+Z</kbd>/<kbd>Y</kbd> ' +
        'undo and redo. <kbd>T</kbd> switches to the triplet grid, three cells to the beat instead of four; notes on ' +
        'the other grid are drawn faded. The keyboard on the left plays the instrument.') +
      h('The instrument') +
      p('<strong>grid</strong> is how long the instrument is, in bars. <strong>key</strong> and <strong>scale</strong> ' +
        'transpose and fold its notes the way the game does. <strong>level</strong> and <strong>pan</strong> are its own ' +
        'volume and position; the two <strong>sends</strong> say how much of it goes to the song\'s echo and reverb. ' +
        '<strong>Loop this chip</strong> cuts the song off and goes round the chip\'s bars with every other row at a ' +
        'fifth of its volume, to hear the part in place while you edit it. It follows the chip you select; pressing ' +
        'it again plays the song on from the chip\'s start, and stop, or closing the panel, ends it too. ' +
        'Drag the panel\'s top edge to resize it; <kbd>Esc</kbd> closes it.'),
  },
  song: {
    title: 'The song',
    body:
      p('The <strong>name</strong> is what the song is saved as, and what a level calls it. ' +
        '<strong>Tempo</strong> and <strong>swing</strong> take effect at once, while it plays, and keep your place in the music. ' +
        '<strong>Loop</strong> starts the song over when it ends, here and in the game; the top bar has the same switch.') +
      h('Channels') +
      p('The board is cut into as many bands as there are channels, top to bottom, and each band has its own fader. ' +
        'The number beside a fader is how many instruments sit on that channel. <strong>Board rows</strong> is how many ' +
        'rows the board has.') +
      h('Echo and reverb') +
      p('The echo\'s <strong>time</strong> is in beats, so it follows the tempo; <strong>feedback</strong> is how long it ' +
        'repeats and <strong>mix</strong> how loud. <strong>Reverb</strong> picks one of the game\'s sixteen rooms. ' +
        'Each instrument sends its own amount to both, in its note panel.'),
  },
  engine: {
    title: 'The engine',
    body:
      p('These switches are not part of the song; they change how it is played here.') +
      p('The game plays at most <strong>32 notes at once</strong> and cuts the oldest when more arrive, which is part ' +
        'of how a busy song sounds. A smaller pool cuts more, and <strong>unlimited</strong> plays every note, which no ' +
        'longer sounds like the game. Changing it while the song plays takes effect at once.') +
      p('<strong>echo</strong>, <strong>reverb</strong> and <strong>output clip</strong> switch those parts of the sound ' +
        'off to hear the song without them. Below them: how many notes are sounding, how many times the audio could ' +
        'not keep up, and how many notes the pool has cut so far.'),
  },
  render: {
    title: 'Rendering',
    body:
      p('<strong>Render</strong> writes the whole song, or just a section, to a WAV file at studio quality, through ' +
        'the same engine you hear live. Tick <strong>just a section</strong> and give it a start and an end as ' +
        'minutes:seconds. The switches beside it are the same as the engine\'s: the size of the voice pool, and ' +
        'whether the echo, the reverb and the output clip are in.') +
      p('When it is done the waveform appears: click it to seek, <kbd>Space</kbd> plays, the arrow keys scrub. ' +
        '<strong>Download WAV</strong> saves it, and the cards below say what the render contained.'),
  },
  export: {
    title: 'Exporting a MIDI file',
    body:
      p('<strong>Download .mid</strong> writes the song as a MIDI file any DAW opens, one track per board row ' +
        'and instrument, named after both.') +
      h('The options') +
      p('<strong>MPE</strong> gives every note its own channel, so a glide stays with its note; ' +
        '<strong>plain</strong> gives every instrument one channel, which older software prefers. ' +
        '<strong>Split into several files</strong> when one is not enough. <strong>Bake the swing</strong> writes the ' +
        'swung timing into the notes rather than leaving it to the player. <strong>Carry what MIDI cannot say</strong> ' +
        'stores the rest of the song inside the file, so a file that comes back here is the same song; other ' +
        'programs simply ignore it. The <strong>bend range</strong> is how far a glide can reach; picked from the ' +
        'music, it is always enough.') +
      h('What cannot be carried') +
      p('A very dense passage runs out of MPE channels: notes that have to share one lose their own glide, and the ' +
        'tally says how many. Key and scale are folded into the notes, so an import comes back chromatic, sounding the same.'),
  },
  import: {
    title: 'Importing a MIDI file',
    body:
      p('Drop any MIDI file on the box. A file that was exported from here brings its instruments with it; ' +
        'one from a DAW has none, so pick what each part should sound like, then <strong>make it the song</strong>. ' +
        'That replaces whatever is open, so save first if it matters.'),
  },
  keyboard: {
    title: 'The keyboard',
    body:
      p('Play the game\'s instruments by hand. The instrument follows the one selected on the board, or pick any. ' +
        'Click the keys, or use the computer keyboard: <kbd>Z S X D C V G B H N J M</kbd> is one octave with its ' +
        'sharps, <kbd>Q 2 W 3 E R 5 T 6 Y 7 U</kbd> the octave above, <kbd>&larr;</kbd> <kbd>&rarr;</kbd> shift the ' +
        'octave, <kbd>Esc</kbd> silences everything. A note lasts as long as the key is down, and the keys play only ' +
        'while this view is open.') +
      h('A MIDI controller') +
      p('Pick it under <strong>MIDI in</strong>; the browser asks once for permission. An MPE controller is recognised ' +
        'on its own, and <strong>MPE</strong> can force a zone or switch it off; <strong>bend range</strong> is how far ' +
        'the wheel reaches. Pressure and slide can each be turned off.') +
      h('Turning things') +
      p('The faders change the sound while it plays. A group with an <strong>override</strong> box uses your values ' +
        'only while it is ticked; unticked, the instrument plays as the game made it. Double-click any fader to put ' +
        'it back where it started.') +
      h('The bench') +
      p('Three buttons play set sequences: every sample of the instrument at its own note, a scale, and a chromatic ' +
        'run. <strong>Note length</strong> is how long those hold each note. The engine and sampler choices play the ' +
        'same thing through different resamplers, to compare them by ear.'),
  },
};

/**
 * Wire the dialog and every `[data-help]` button on the page, present or
 * future. Call once.
 */
export function mountHelp(): void {
  const dialog = document.getElementById('helpDialog') as HTMLDialogElement;
  const title = document.getElementById('helpTitle')!;
  const body = document.getElementById('helpBody')!;
  document.getElementById('helpClose')!.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  const open = (name: string | undefined) => {
    const topic = HELP[name as HelpTopic];
    if (!topic) return false;
    title.textContent = topic.title;
    body.innerHTML = topic.body;
    body.scrollTop = 0;
    dialog.showModal();
    return true;
  };
  document.addEventListener('click', (event) => {
    const button = (event.target as Element).closest?.('[data-help]');
    if (button instanceof HTMLElement) open(button.dataset.help);
  });
  // A non-button with the attribute (the version in the status bar) opens on Enter too.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const el = event.target;
    if (el instanceof HTMLElement && !(el instanceof HTMLButtonElement) && el.dataset.help) open(el.dataset.help);
  });
  // The wheel over an open dialog scrolls its text, never the page behind it.
  // Done here rather than by hiding the page's overflow, which would drop the
  // scrollbar, shift the page by its width and unstick the top bar.
  for (const d of document.querySelectorAll<HTMLDialogElement>('dialog')) {
    d.addEventListener('wheel', (event) => {
      const scroller = (event.target as Element).closest?.('.help-body, .picker-list, .picker-scroll');
      if (!(scroller instanceof HTMLElement) || scroller.scrollHeight <= scroller.clientHeight) event.preventDefault();
    }, { passive: false });
  }
}
