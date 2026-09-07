# Changelog

What changed for the person using LBP Tracker, newest first. The site shows this file behind the
version number in its status bar, so it is written for them: what they can do now that they could
not before, never how it was done. No `--` or em dash in here; the site's text does without them.

## 0.2.17 (2026-09-07)

- The footer on the front page links to the source on GitHub, and to the issue tracker,
  so there is somewhere to say what broke.

## 0.2.16 (2026-09-07)

- The playhead in the note grid glides instead of stepping. It moved ten times a second, which at
  240 BPM is a lurch of a step and a half; it now moves with every frame the screen draws, the way
  the one on the board already did.
- A G beside the volume turns the master bus on and off from the top bar. It is the same switch as
  the one under Song/Mixer, and it lights up while it is on.

## 0.2.15 (2026-09-07)

- A master bus under the engine switches: a compressor and a limiter of this tracker's own,
  after everything the game does, for a mix that holds together. The glue knob says how much of
  it. On a busy song at the default it comes out about 4 dB louder with the peaks still under the
  ceiling, and it is off to begin with, because with it on what you hear is no longer what the
  game would play. The Render view has the same switch, so an exported WAV can carry it.
- Keyboard shortcuts of the kind a DAW has: Space plays and pauses where it is rather than going
  back to the start, Home or Enter return to the start without stopping, End jumps to the end of
  the song, and Ctrl+S saves. On the Arrange view, L turns the loop on and off, and M and S mute
  and solo the selected row.
- The media keys on a keyboard work as well, and so does whatever transport your computer shows
  on screen or on a headset: play, pause, stop, and the skip keys for the start and the end of the
  song. The song's name appears there while it plays.

## 0.2.14 (2026-09-07)

- The rectangle you drag in the note grid now selects points, not whole notes. You can take
  the tail of a glide and leave its head where it is, then move, nudge, delete or change the
  volume of just those points; half a glide copies as half a glide. Clicking a note's line still
  takes the whole note, and dragging any selected point moves everything selected with it.

## 0.2.13 (2026-09-07)

- Every sound now shows the icon the game gives it. The 68 pictures come from the game itself, so
  a chip on the board looks like the one you would have placed in the Music Sequencer.

## 0.2.12 (2026-09-07)

- Notes picked with a rectangle now move together when you drag any one of them by its dot, not
  just by the line between its points. Dragging a single selected note still moves the one point
  you grabbed, so a glide is still shaped the same way: press Esc to drop the selection first.
- The line under the note grid keeps its height when it has nothing to say, so the grid no longer
  jumps by six pixels every time the pointer leaves a note.
- The status line stopped getting stuck on "preparing: voices 0%". Editing one note took a short
  path that never wrote the line back afterwards; it now ends where the full rebuild does, and the
  note count follows the edit.
- "Find the notes" now goes to the view that actually holds the most notes, sideways as well as
  up and down. On a part with a bass line and one high note it used to land halfway between them,
  which is to say on nothing at all.

## 0.2.11 (2026-09-07)

- The reverbs have their real names, in the game's own order: Small Room, Room, Bright Plate,
  Hall, Big Hall and Cathedral. They came out of the game itself, not out of a guess, and the
  list is six rather than five: Small Room is a setting the game offers and no song in the
  corpus of 338 ever picked.

## 0.2.10 (2026-09-07)

- Every sound is called what the game calls it: "Saw Wave", "Beatbox Kit 2", "Electric Guitar
  Power Chords", instead of the file name it used to show ("saw wave", "bb kit 2",
  "e guitar power"). The names come from the game's own palette items and its own translations, so
  all 68 are named and none is invented.
- The sound picker shows the game's category beside each name, Keys or Plucked or Percussion, and
  searching now matches the category as well. Typing in lower case finds them again: with the
  names capitalised it would have stopped matching.

## 0.2.9 (2026-09-07)

- Reverb is a menu now, not a slider, and it lists the five settings the game actually writes: over
  338 sequencers from real levels the value is only ever 1 to 5, while the slider went to 15. Each
  option says how long that reverb rings, and hovering it gives the delay before the tail, the
  damping and the levels.
- A new song starts on reverb 5, the setting three out of five real sequencers use. It used to
  start on 0, which no sequencer in the corpus holds and which is not "no reverb" either.

## 0.2.8 (2026-09-07)

- The rectangle you drag round notes now catches a held note whose line crosses it, not only notes
  with a point inside it, and the line under the grid counts what it has caught as you drag. Hold
  Ctrl while dragging it to add to the selection instead of replacing it.
- New keys for a selection of notes: Ctrl+X cuts, Ctrl+D duplicates it one step further on and
  selects the copy, so pressing it again walks on down the grid. Pasting with nothing selected
  puts the notes back where they were cut from.
- The line under the grid says how many notes are selected and which keys act on them, so the
  commands are not only in the help.

## 0.2.7 (2026-09-07)

- The song's end marker can be dragged on a new song again. Since 0.2.6 it was drawn there but did
  not answer the pointer. Dragging it right up to the start now leaves it one tile in, instead of
  taking it away with no way to take hold of it again.

## 0.2.6 (2026-09-07)

- In the note grid the line between a note's points now shows what it does between them: it
  swells where the volume rises and thins where it falls, and its colour runs from one point's
  timbre to the next. The dots still say what each point is; the line now says what happens on
  the way.
- A new song starts with an end marker two tiles along the board, so there is a length to lay a
  song out against, and something to drag, before the first instrument is placed. It used to
  appear only once a chip was there.
- Closing the tab or the window with unsaved changes asks first on every browser; Safari and the
  older ones were closing without a word.

## 0.2.5 (2026-09-07)

- The site installs as an app: on a phone or a desktop the browser offers to add it, and it then
  opens in its own window, with its own icon, and starts without a network.
- A link to the site now unfurls with a title, a description and the icon, and search engines are
  told what the site is.

## 0.2.4 (2026-09-07)

- With the note panel open, the board's horizontal scrollbar sits just above it instead of under it.

## 0.2.3 (2026-09-07)

- The board zooms in time: "-" and "+" in the corner cell between the row numbers and the bar
  numbers make the bars narrower or wider, the glass between them puts them back, and the rows
  keep their height. The choice is remembered.

## 0.2.2 (2026-09-07)

- On the published site the top bar sat 20 px down over the bar numbers, the status bar was
  taller than meant and the views were capped in width: the page's own styles were losing to
  the shared ones there, and only there. Fixed.

## 0.2.1 (2026-09-07)

- The board and the note grid follow the playhead only until you scroll away from it, ahead or
  behind; scrolling back to it, seeking, or pressing play makes them follow again.
- Removing a row with instruments on it, and throwing away unsaved changes, ask through the
  app's own dialog rather than the browser's.

## 0.2.0 (2026-09-07)

### One page, one song
- The five pages are one app: Arrange, Song/Mixer, Render, Import/Export and Keyboard are views
  on the same song, and switching between them never stops the music.
- A top bar with the views, the transport (play, stop, loop), the clock, the tempo, the volume
  under a stereo VU meter, the song's name, and new, open and save. Space plays from any view, and
  the loop goes round without a gap.
- A status bar at the bottom: what is going on, the notes sounding, the audio load and any
  dropouts, and the version, which opens this list.
- A home page behind the brand, with the app presented in a few lines; the site opens on it, and
  reading it does not lose the song.
- "Open" is a dialog: a level of your own, a save backup, a zip, a song file or a level from the
  public archive, dropped or picked, with a searchable list of the songs when a level holds several.
- A song file (.json) saves the song as it is here and opens again anywhere a level would.
- A "?" beside every card opens the help for it; the views themselves carry little prose.
- An icon of its own for each of the 68 sounds, on the chips, in the picker and in the sound fields.
- A favicon: the note from the logo, in its square.

### Arrange, new
- The board as the game lays it out: a row per line, a chip per instrument, as long as its note
  grid, four bars to a tile. Drag over empty cells to draw a chip and pick its instrument; drag a
  chip to move it, duplicate or remove it, and the bar numbers and row numbers stay put as you
  scroll.
- Rows select; the note grid follows the chip the playhead is inside on the selected row.
- Mute and solo on every row; a white line between the mixer channels; the end of the song shown,
  respected by the playhead, and draggable to make room past the last chip.
- A "+" under the last row adds one; the selected row's number turns into an "x" to remove it,
  asking first when it holds instruments. Chips and row numbers light up as their notes start.
- The note grid in a panel that rises over the board, resizable by its top edge: notes as chains
  of points joined by lines, the size of a point its volume and its colour its timbre, a note
  ending at its last point. Triplet grid at three cells to the beat, with the other grid's notes
  drawn faded. Undo and redo, copy and paste, a selection box, the arrow keys to nudge, and a
  keyboard on the left to try the instrument.
- Editing inside a chip, drawing one, removing one or muting a row while the song plays is heard at
  once, without a stutter: only that chip is re-planned, and nothing already on its way to the
  speakers is played twice.
- "Loop this chip" in the note panel cuts the song off and goes round the chip's bars with every
  other row at a fifth of its volume, to work on one part in place; pressing it again leaves the
  song at the chip's start, playing on from there if it was playing before.
- The chip's own settings beside the grid: its length in bars (four, then two at a time), key and
  scale, level, pan, and its sends to the echo and the reverb; and the selected point's pitch,
  volume and timbre as sliders.

### Song/Mixer
- The song's name, tempo, swing and loop; the channels and their faders, with how many chips each
  carries; the board's rows; the echo and the reverb: every field the game keeps, in one card.
  Tempo and swing change while the song plays without losing your place.
- The engine's own switches and meters in a card of their own: the voice pool, the echo, reverb
  and output clip switches, and what the audio thread is doing.

### Render
- Renders the song as it is, mutes and solos included, and lays the summary out as cards.

### Import/Export
- Renamed from Converter. Exports the open song; an imported MIDI file becomes the song, with an
  instrument picked for each part.

### Keyboard
- Follows the chip selected on the board, and opens with the piano already loaded; the sound is
  picked from the same searchable list as on the board. The first card is two groups: the
  instrument, and the MIDI controller.

## 0.1.0 (2026-09-06)

The first release.
