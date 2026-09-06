# Changelog

What changed for the person using LBP Tracker, newest first. The site shows this file behind the
version number in its status bar, so it is written for them: what they can do now that they could
not before, never how it was done. No `--` or em dash in here; the site's text does without them.

## 0.1.0 (2026-09-07)

The first release: one page, one song, five views.

### Arrange
- The board as the game lays it out, one instrument per chip, four bars to a tile; draw a chip by
  dragging over empty cells and pick its instrument when you let go.
- The note grid in a panel that rises over the board: points, glides, volume as size and timbre as
  colour, whole steps or the triplet grid, with undo, copy and paste, and a keyboard to try notes.
- Mute and solo per row, a draggable end of song, channels drawn as white lines between rows.

### Song/Mixer
- The song's name, tempo, swing and loop; the mixer channels and their faders; the echo and the
  reverb, exactly the fields the game keeps.
- The engine's own switches in their card: the voice pool, and the echo, reverb and output clip.

### Render
- The song, or a section of it, to a WAV through the same engine you hear live, with a player to
  check it and a summary of what the render contained.

### Import/Export
- Out as a MIDI file, MPE so a glide stays with its note, with a tally of what could not be
  carried; in from any MIDI file, each part given one of the game's instruments.

### Keyboard
- The game's instruments played by mouse, computer keys or a MIDI controller, MPE included, with
  every voice parameter to turn while it sounds.

### Everywhere
- Open a level of your own, a save backup, a zip, a song file, or a level from the public archive;
  nothing leaves your computer.
- Play, stop and loop in the top bar, with a VU meter; the status bar says how the audio is doing.
- A "?" on every card opens the help for it; the version number opens this list.
