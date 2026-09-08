/**
 * The one loader: what is on screen while a level is being opened.
 *
 * ❗ **Opening a level is seconds long and none of it used to be visible.** The
 * archive panel says "fetching 8febe1f9…" and "12 of 30 resources…" into its
 * own note, and the drop zone says "reading …" into its title -- but both live
 * inside `#fileDialog`, and the two routes that need the message most, a
 * `?level=` link and a drop straight onto the home screen, never open that
 * dialog. A level would arrive after ten silent seconds.
 *
 * ⚠️ **It is a modal `<dialog>`, and that is the point, not decoration.** The
 * file dialog is itself modal, so it sits in the browser's top layer and an
 * ordinary `<div>` overlay -- whatever its `z-index` -- renders *underneath*
 * it. A second `showModal()` stacks above the first, which is the only way a
 * message can be seen over an open picker.
 *
 * Jobs nest: the archive fetch starts one, and the read of what it brought back
 * starts another inside it (`openLevel` in `daw.ts`). The newest job is the one
 * shown, and the loader goes away when the last one is done, so neither caller
 * has to know about the other.
 */

/** One thing being waited for. `done()` is safe to call twice. */
export interface LoadingJob {
  /** The line under the title: progress, counts, whatever is known. */
  note(text: string): void;
  done(): void;
}

interface Job {
  title: string;
  note: string;
}

const jobs: Job[] = [];
let host: HTMLDialogElement | null = null;
let titleEl: HTMLElement;
let noteEl: HTMLElement;

function mount(): HTMLDialogElement {
  if (host) return host;
  host = document.createElement('dialog');
  host.className = 'loading-dialog';
  host.innerHTML = '<div class="loading-box">'
    + '<div class="spinner" aria-hidden="true"></div>'
    + '<div class="loading-text">'
    + '<strong class="loading-title"></strong><span class="loading-note"></span>'
    + '</div></div>';
  // ⚠️ A modal dialog closes on Escape, and this one has no business
  // disappearing: it is not a choice, and the work carries on either way.
  host.addEventListener('cancel', (event) => event.preventDefault());
  titleEl = host.querySelector('.loading-title')!;
  noteEl = host.querySelector('.loading-note')!;
  document.body.append(host);
  return host;
}

function draw(): void {
  const top = jobs[jobs.length - 1];
  const el = mount();
  if (!top) {
    if (el.open) el.close();
    return;
  }
  titleEl.textContent = top.title;
  noteEl.textContent = top.note;
  // `showModal` throws on a dialog that is already open, and this is called on
  // every progress line.
  if (!el.open) el.showModal();
}

/** Show the loader for as long as one piece of work runs. */
export function loading(title: string, note = ''): LoadingJob {
  const job: Job = { title, note };
  jobs.push(job);
  draw();
  return {
    note: (text: string) => {
      job.note = text;
      draw();
    },
    done: () => {
      const at = jobs.indexOf(job);
      if (at >= 0) jobs.splice(at, 1);
      draw();
    },
  };
}
