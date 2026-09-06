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
 * it cost a day, which is why `packages/lbp-tracker-web/src/assets.ts` exists and why this is here.
 */

export interface SeqRow {
  /**
   * What identifies this row, and it is NOT the uid.
   *
   * ⚠️ **A uid is unique inside a level and not across a backup.** Opening a
   * folder of forty levels routinely gives two sequencers numbered 7, and a
   * picker keyed on the uid shows one row where there are two and hands the
   * caller the wrong song. `packages/cwlib-ts/src/backup.ts` builds these as
   * `file#uid`; a page with one level can pass the uid as a string.
   */
  readonly key: string;
  readonly name: string;
  readonly tracks: number;
  /** The level it came from, shown when a backup holds more than one. */
  readonly file?: string;
}

export interface SeqPicker {
  /** Replace the list and select the first row. Returns its key, or ''. */
  setRows(rows: readonly SeqRow[]): string;
  /** The key currently selected. */
  value(): string;
  /** Select a row without telling the caller's `onPick`. */
  select(key: string): void;
}

const title = (row: SeqRow) => row.name || '(untitled)';

/**
 * What to show for the file a sequencer came out of.
 *
 * ⚠️ **A resource is named after its SHA-1**, so its honest name is 40 hex
 * digits with a save folder in front — 63 characters of noise beside "12
 * instruments", on every row, and a backup of plans is 56 rows of it. Eight
 * digits tell two rows apart, which is this column's only job; identity runs on
 * `key`, which is untouched.
 */
const shortFile = (file: string): string => {
  const leaf = file.slice(file.lastIndexOf('/') + 1);
  return /^[0-9a-f]{40}$/.test(leaf) ? leaf.slice(0, 8) : leaf;
};

const detail = (row: SeqRow) =>
  // ❗ The level's name when a backup holds several: two songs called `Intro`
  // in one folder are told apart by the file they came out of and nothing else.
  `${row.tracks} instrument${row.tracks === 1 ? '' : 's'}` +
  `${row.file ? ` · ${shortFile(row.file)}` : ''}`;

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
  onPick: (key: string) => void,
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
  let chosen = '';
  /** Which row the arrow keys are on; -1 when nothing is highlighted. */
  let cursor = -1;
  let shown: SeqRow[] = [];

  const showField = () => {
    const row = rows.find((r) => r.key === chosen);
    name.textContent = row ? title(row) : 'no level open';
    detailEl.textContent = row ? detail(row) : '';
  };

  const draw = () => {
    const needle = search.value.trim().toLowerCase();
    shown = rows.filter((r) => needle === '' || title(r).toLowerCase().includes(needle));
    list.innerHTML = shown
      .map(
        (r, i) =>
          `<button type="button" role="option" class="picker-row${r.key === chosen ? ' on' : ''}` +
          `${i === cursor ? ' at' : ''}" data-key="${r.key}" aria-selected="${r.key === chosen}">` +
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
    cursor = shown.findIndex((r) => r.key === chosen);
    draw();
    search.focus();
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };

  const close = () => {
    pop.hidden = true;
    field.setAttribute('aria-expanded', 'false');
  };

  /** Choose a row. `quiet` selects without telling the page. */
  const pick = (key: string, quiet = false) => {
    if (key === chosen) {
      close();
      return;
    }
    chosen = key;
    showField();
    close();
    if (!quiet) onPick(key);
  };

  field.addEventListener('click', () => (pop.hidden ? open() : close()));
  list.addEventListener('click', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('.picker-row');
    if (row) pick(row.dataset.key ?? '');
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
      if (cursor >= 0 && shown[cursor]) pick(shown[cursor].key);
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
      chosen = next.length ? next[0].key : '';
      field.disabled = next.length === 0;
      search.value = '';
      draw();
      showField();
      return chosen;
    },
    value: () => chosen,
    select(key) {
      pick(key, true);
    },
  };
}
