/**
 * The song picker: one searchable control, shared by the live player and the
 * renderer.
 *
 * ⚠️ **A native `<select>` with a search box beside it was the first attempt and
 * it was wrong.** Two controls for one choice, the box doing nothing until you
 * notice what it is for, and the list still a native popup that cannot show a
 * filter. This is one control: it reads as a field, it opens a panel with the
 * matches in it, and typing filters them.
 *
 * The last time two of these pages grew their own copy of something this small
 * it cost a day, which is why `dev/assets.ts` exists and why this is here.
 */

export interface SeqRow {
  readonly uid: number;
  readonly name: string;
  readonly tracks: number;
}

export interface SeqPicker {
  /** Replace the list and select the first row. Returns its uid, or 0. */
  setRows(rows: readonly SeqRow[]): number;
  /** The uid currently selected. */
  value(): number;
  /** Select a row without telling the caller's `onPick`. */
  select(uid: number): void;
}

const title = (row: SeqRow) => row.name || '(untitled)';
const detail = (row: SeqRow) => `${row.tracks} instrument${row.tracks === 1 ? '' : 's'}`;

const escape = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * Turn a container into the picker. It supplies its own markup, so a page only
 * has to give it somewhere to live.
 *
 * `onPick` fires for a real choice and never for filtering.
 */
export function seqPicker(
  host: HTMLElement,
  onPick: (uid: number) => void,
): SeqPicker {
  host.classList.add('picker');
  host.innerHTML =
    '<button type="button" class="picker-field" aria-haspopup="listbox" aria-expanded="false" disabled>' +
    '<span class="picker-name">no level open</span>' +
    '<span class="picker-detail"></span></button>' +
    '<div class="picker-pop" hidden>' +
    '<input class="picker-search" type="text" placeholder="search songs…" aria-label="Search songs">' +
    '<div class="picker-list" role="listbox"></div>' +
    '<div class="picker-none" hidden>nothing matches</div></div>';

  const field = host.querySelector<HTMLButtonElement>('.picker-field')!;
  const name = host.querySelector<HTMLElement>('.picker-name')!;
  const detailEl = host.querySelector<HTMLElement>('.picker-detail')!;
  const pop = host.querySelector<HTMLElement>('.picker-pop')!;
  const search = host.querySelector<HTMLInputElement>('.picker-search')!;
  const list = host.querySelector<HTMLElement>('.picker-list')!;
  const none = host.querySelector<HTMLElement>('.picker-none')!;

  let rows: readonly SeqRow[] = [];
  let chosen = 0;
  /** Which row the arrow keys are on; -1 when nothing is highlighted. */
  let cursor = -1;
  let shown: SeqRow[] = [];

  const showField = () => {
    const row = rows.find((r) => r.uid === chosen);
    name.textContent = row ? title(row) : 'no level open';
    detailEl.textContent = row ? detail(row) : '';
  };

  const draw = () => {
    const needle = search.value.trim().toLowerCase();
    shown = rows.filter((r) => needle === '' || title(r).toLowerCase().includes(needle));
    list.innerHTML = shown
      .map(
        (r, i) =>
          `<button type="button" role="option" class="picker-row${r.uid === chosen ? ' on' : ''}` +
          `${i === cursor ? ' at' : ''}" data-uid="${r.uid}" aria-selected="${r.uid === chosen}">` +
          `<span>${escape(title(r))}</span><span class="picker-detail">${detail(r)}</span></button>`,
      )
      .join('');
    none.hidden = shown.length > 0;
  };

  const open = () => {
    if (field.disabled) return;
    pop.hidden = false;
    field.setAttribute('aria-expanded', 'true');
    search.value = '';
    cursor = shown.findIndex((r) => r.uid === chosen);
    draw();
    search.focus();
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };

  const close = () => {
    pop.hidden = true;
    field.setAttribute('aria-expanded', 'false');
  };

  /** Choose a row. `quiet` selects without telling the page. */
  const pick = (uid: number, quiet = false) => {
    if (uid === chosen) {
      close();
      return;
    }
    chosen = uid;
    showField();
    close();
    if (!quiet) onPick(uid);
  };

  field.addEventListener('click', () => (pop.hidden ? open() : close()));
  list.addEventListener('click', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('.picker-row');
    if (row) pick(Number(row.dataset.uid));
  });
  search.addEventListener('input', () => {
    cursor = shown.length ? 0 : -1;
    draw();
  });

  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      close();
      field.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!shown.length) return;
      cursor = (cursor + (event.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length;
      draw();
      list.children[cursor]?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      if (cursor >= 0 && shown[cursor]) pick(shown[cursor].uid);
    } else {
      return;
    }
    event.preventDefault();
  });

  // Clicking away closes it. `pointerdown` rather than `click`, so it closes
  // before whatever was clicked reacts.
  document.addEventListener('pointerdown', (event) => {
    if (!pop.hidden && !host.contains(event.target as Node)) close();
  });

  return {
    setRows(next) {
      rows = next;
      chosen = next.length ? next[0].uid : 0;
      field.disabled = next.length === 0;
      search.value = '';
      draw();
      showField();
      return chosen;
    },
    value: () => chosen,
    select(uid) {
      pick(uid, true);
    },
  };
}
