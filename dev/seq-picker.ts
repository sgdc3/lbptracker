/**
 * A filtered sequencer picker, shared by the live player and the renderer.
 *
 * A level can hold twenty-five songs and the busiest ones are not always the
 * ones somebody opened the file for, so the list needs a search box. Both pages
 * need the same one, and the last time two pages grew their own copy of
 * something this small it cost a day (see `dev/assets.ts`).
 */

export interface SeqRow {
  readonly uid: number;
  readonly name: string;
  readonly tracks: number;
}

export interface SeqPicker {
  /** Replace the list. Selects the first row and returns its uid, or 0. */
  setRows(rows: readonly SeqRow[]): number;
  /** The uid currently selected. */
  value(): number;
}

const label = (row: SeqRow) =>
  `${row.name || '(untitled)'} — ${row.tracks} instrument${row.tracks === 1 ? '' : 's'}`;

/**
 * Wire a `<select>` to a search box.
 *
 * ⚠️ **Filtering never changes what is selected.** On the live page choosing a
 * song starts preparing it, so a filter that dropped the current selection
 * would throw away a prepared song for a keystroke. The selected row is kept in
 * the list even when it does not match, and `onPick` fires only for a real
 * choice.
 */
export function seqPicker(
  select: HTMLSelectElement,
  search: HTMLInputElement,
  onPick: (uid: number) => void,
): SeqPicker {
  let rows: readonly SeqRow[] = [];

  const draw = () => {
    const needle = search.value.trim().toLowerCase();
    const chosen = Number(select.value);
    const matches = (r: SeqRow) => needle === '' || label(r).toLowerCase().includes(needle);
    // The selected row is always listed, even when it does not match, so that
    // filtering cannot silently change what is playing.
    const shown = rows.filter((r) => matches(r) || r.uid === chosen);
    select.innerHTML = shown
      .map((r) => `<option value="${r.uid}">${label(r)}</option>`)
      .join('');
    // Keep the selection across a redraw; the option element is a new one.
    if (shown.some((r) => r.uid === chosen)) select.value = String(chosen);
    // Judged on real matches, not on `shown`: the kept selection would otherwise
    // make "no results" impossible to reach.
    search.classList.toggle('bad', needle !== '' && !rows.some(matches));
  };

  search.addEventListener('input', draw);
  select.addEventListener('change', () => onPick(Number(select.value)));

  return {
    setRows(next) {
      rows = next;
      search.value = '';
      select.innerHTML = next
        .map((r) => `<option value="${r.uid}">${label(r)}</option>`)
        .join('');
      select.disabled = next.length === 0;
      search.disabled = next.length === 0;
      return next.length ? next[0].uid : 0;
    },
    value: () => Number(select.value),
  };
}
