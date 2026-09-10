/**
 * Whether the roll follows the playhead is a **state the person owns**, and
 * these are the four ways it changes hands.
 *
 * ❗ It used to be neither on nor off, and both failures were reported from
 * use rather than caught here: a chip clicked on the playhead's own row was
 * shown until the playhead crossed into the next one and then yanked away
 * mid-edit, and a chip clicked on another row was overridden on the very next
 * frame. `EditorState.followPlayhead` is the switch; `daw/arrange.ts` reads it
 * every frame and owns the fifth rule -- moving the roll ONTO the playhead's
 * own chip follows again -- which needs a playhead and so lives there.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addClip, newSong } from '@lbptracker/lib/song.ts';
import { EditorState } from '../src/editor/state.ts';

function stateWithChips(): { state: EditorState; ids: number[] } {
  const song = newSong('follow');
  song.boardRows = 3;
  const ids = [
    addClip(song, { cell: 0, row: 0 }, 129085).id,
    addClip(song, { cell: 4, row: 0 }, 129085).id,
    addClip(song, { cell: 0, row: 1 }, 129031).id,
  ];
  return { state: new EditorState(song), ids };
}

test('a song opens following, and clicking a chip stops it', () => {
  const { state, ids } = stateWithChips();
  assert.equal(state.followPlayhead, true, 'a new state follows');
  state.selectClip(ids[1]);
  assert.equal(state.followPlayhead, false, 'the person pointed at a chip');
  assert.equal(state.selection.clipId, ids[1]);
});

test('the playhead moving the roll is not the person, so it keeps following', () => {
  const { state, ids } = stateWithChips();
  state.followClip(ids[1]);
  assert.equal(state.followPlayhead, true);
  assert.equal(state.selection.clipId, ids[1], 'and it still moves the roll');
});

test('choosing a row means watch that row, however the roll got off it', () => {
  const { state, ids } = stateWithChips();
  state.selectClip(ids[1]);
  assert.equal(state.followPlayhead, false);
  state.selectRow(1);
  assert.equal(state.followPlayhead, true);
  assert.equal(state.selection.clipId, ids[2], 'the row’s first chip');
  // And the same when the roll is already on a chip of that row: the early
  // return in `selectRow` has to arm it too, which it did not at first.
  state.selectClip(ids[2]);
  assert.equal(state.followPlayhead, false);
  state.selectRow(1);
  assert.equal(state.followPlayhead, true);
});

test('a block of chips is the person choosing too, and a new song follows again', () => {
  const { state, ids } = stateWithChips();
  state.selectClips([ids[0], ids[1]], ids[0]);
  assert.equal(state.followPlayhead, false);
  state.replace(newSong('another'));
  assert.equal(state.followPlayhead, true);
});
