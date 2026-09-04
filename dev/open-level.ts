/**
 * One drop zone that takes a level, a backup folder, or a zip of one.
 *
 * A creator's backup is a directory of resources named after their SHA-1, so
 * "open your level" means "find the right extensionless file among forty and
 * guess". This takes the whole thing instead: drop the folder, drop a zip of
 * it, or drop one file if that is what you have.
 *
 * ⚠️ **Shared on purpose.** Three pages open levels and the last time two of
 * them grew their own copy of something this small it cost a day -- the same
 * reason `dev/assets.ts` and `dev/seq-picker.ts` exist.
 *
 * ❗ **Nothing is uploaded.** Every byte is read from the `File` the browser
 * hands over, in the page, and the reading is `src/core/backup.ts` which knows
 * nothing about files at all. See `steering/game-assets.md`.
 */

import type { BackupFile } from '../src/core/backup.ts';

/**
 * Files bigger than this are skipped without being read.
 *
 * ⚠️ A backup holds photographs, audio and video as well as levels, and a
 * corpus level is under 4 MB. Reading a 600 MB capture into memory to look at
 * its first four bytes is how a page dies on a folder somebody dragged in by
 * accident.
 */
const BIGGEST = 64 * 1024 * 1024;

/** How deep a dropped folder is walked. Backups are flat or nearly so. */
const DEEPEST = 8;

export interface Opened {
  /** What to call it on screen: the file's name, or the folder's. */
  readonly label: string;
  readonly files: readonly BackupFile[];
  /** True when the source was a folder or an archive rather than one file. */
  readonly many: boolean;
}

const read = async (file: File, name = file.name): Promise<BackupFile | undefined> =>
  (file.size > BIGGEST || file.size === 0
    ? undefined
    : { name, bytes: new Uint8Array(await file.arrayBuffer()) });

/**
 * Everything under a dropped directory entry.
 *
 * ⚠️ **`readEntries` returns a PAGE, not the directory.** It hands back at most
 * a hundred entries and has to be called again until it returns none; a reader
 * that calls it once opens the first hundred files of a backup and silently
 * ignores the rest. That is the classic bug with this API and it looks like a
 * backup that is missing levels.
 */
async function walk(
  entry: FileSystemEntry,
  prefix: string,
  depth: number,
  out: BackupFile[],
): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject));
    const found = await read(file, `${prefix}${entry.name}`);
    if (found) out.push(found);
    return;
  }
  if (!entry.isDirectory || depth >= DEEPEST) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject));
    if (batch.length === 0) break;
    for (const child of batch) await walk(child, `${prefix}${entry.name}/`, depth + 1, out);
  }
}

/** What a drop gave us: one file, an archive, or a folder. */
export async function fromDrop(transfer: DataTransfer): Promise<Opened | undefined> {
  const items = [...transfer.items].filter((i) => i.kind === 'file');
  const entries = items.map((i) => i.webkitGetAsEntry?.() ?? null);
  const folders = entries.filter((e): e is FileSystemEntry => e?.isDirectory === true);
  if (folders.length > 0) {
    const out: BackupFile[] = [];
    for (const folder of folders) await walk(folder, '', 0, out);
    return { label: folders.map((f) => f.name).join(', '), files: out, many: true };
  }
  const files = [...transfer.files];
  return fromFiles(files);
}

/** What an `<input type="file">` gave us, single or `webkitdirectory`. */
export async function fromFiles(list: readonly File[]): Promise<Opened | undefined> {
  if (list.length === 0) return undefined;
  if (list.length === 1 && !isZip(list[0])) {
    const one = await read(list[0]);
    return one ? { label: list[0].name, files: [one], many: false } : undefined;
  }
  const out: BackupFile[] = [];
  for (const file of list) {
    // `webkitRelativePath` is the path inside the folder that was picked, and
    // it is the only place the folder's own name survives.
    const found = await read(file, file.webkitRelativePath || file.name);
    if (found) out.push(found);
  }
  const first = list[0].webkitRelativePath.split('/')[0];
  return {
    label: first || (list.length === 1 ? list[0].name : `${list.length} files`),
    files: out,
    many: true,
  };
}

/** Whether this is an archive rather than a resource. Read by extension only. */
export function isZip(file: File | { name: string }): boolean {
  return /\.zip$/i.test(file.name);
}

/**
 * Wire a drop zone and its two buttons to one handler.
 *
 * ⚠️ **The zone itself takes drops and nothing else.** Making a click
 * anywhere on it open the file picker looked convenient and was a bug: pressing
 * "choose a folder" opened BOTH pickers, because `input.click()` dispatches a
 * click on the input that bubbles straight back up to the zone, and the zone
 * cannot tell it from a click on its own background. Two buttons, one job each,
 * and the drag stays for a file or a folder.
 */
export function wireOpen(opts: {
  zone: HTMLElement;
  fileInput: HTMLInputElement;
  folderInput?: HTMLInputElement;
  fileButton?: HTMLElement | null;
  folderButton?: HTMLElement | null;
  onOpen: (opened: Opened) => void | Promise<void>;
}): void {
  const { zone, fileInput, folderInput, fileButton, folderButton, onOpen } = opts;
  const give = async (from: Promise<Opened | undefined>) => {
    const opened = await from;
    if (opened && opened.files.length > 0) await onOpen(opened);
  };
  fileButton?.addEventListener('click', () => fileInput.click());
  folderButton?.addEventListener('click', () => folderInput?.click());
  fileInput.addEventListener('change', () => {
    void give(fromFiles([...(fileInput.files ?? [])]));
  });
  folderInput?.addEventListener('change', () => {
    void give(fromFiles([...(folderInput.files ?? [])]));
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
    const transfer = (event as DragEvent).dataTransfer;
    if (transfer) void give(fromDrop(transfer));
  });
}
