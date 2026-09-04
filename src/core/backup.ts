/**
 * Opening a level BACKUP -- a folder, or a zip of one -- rather than one level.
 *
 * A creator's backup is not a file, it is a pile: the game writes each resource
 * under its own SHA-1 and a backup is the directory that holds them. Asking
 * somebody to find the level inside by hand is asking them to open forty
 * extensionless files and guess, so this takes the whole pile and reports what
 * is in it.
 *
 * A PS3 backup is one step further in: the folder holds a save game, and the
 * level is inside an XXTEA'd `FAR4` archive split across the files named `0`,
 * `1`, … `savearchive.ts` opens that, so the pile it hands back here is the
 * resources rather than the ciphertext.
 *
 * ⚠️ **Everything here works on bytes the caller already has.** The user's own
 * game files are read client-side and never uploaded -- see
 * `steering/game-assets.md` -- so this module fetches nothing and knows nothing
 * about `File`, directories or archives. The page hands it names and bytes.
 */

import type { Inflate } from './resource.ts';
import { readLevelProject, type LevelProject } from './project.ts';
import { psfName } from './psf.ts';
import { readSaveArchive, saveArchiveRevision } from './savearchive.ts';
import { readZip, type InflateRaw } from './zip.ts';

/** One file out of a folder or an archive. */
export interface BackupFile {
  /** Whatever the caller calls it: a path, a name, a SHA-1. Shown, never parsed. */
  readonly name: string;
  readonly bytes: Uint8Array;
}

export interface BackupResult {
  /** Every level in the pile that holds at least one music sequencer. */
  readonly projects: readonly LevelProject[];
  /** Files that parsed as a level but hold no sequencer. */
  readonly quiet: number;
  /** Files that are not levels at all: icons, save metadata, whatever else. */
  readonly other: number;
  /**
   * Files that look like a level and would not open.
   *
   * ❗ Reported rather than swallowed. A backup where one level of forty fails
   * is a bug in this parser and should be visible as one, not as a level that
   * quietly is not in the list.
   */
  readonly failed: readonly { readonly name: string; readonly why: string }[];
  /**
   * Save games in the pile: the folder, what the player called it, and how it
   * went.
   *
   * ❗ **A PS3 save holds a level and the level CAN be read.** This said the
   * opposite for a while, on evidence -- "8.000 bits per byte, all 256 values"
   * -- that is equally true of compressed data and so proved nothing. The
   * numbered files are not PS3 savedata encryption at all: they are the game's
   * own `FAR4` save archive under XXTEA with a key that is a literal in the
   * game, and the archive's magic sits **unencrypted in the last four bytes**.
   * `savearchive.ts` unpacks it; `resources` is what came out, and `why` is set
   * instead when it would not.
   *
   * ⚠️ **`PARAM.SFO` is not encrypted either**, so a save says what it is even
   * when it will not open: "FJ's Music Hub by Festerd_Jester" beats "a save
   * game", which beats "no sequencers in there".
   */
  readonly saves: readonly {
    readonly folder: string;
    readonly name?: string;
    readonly resources?: number;
    readonly why?: string;
  }[];
}

/**
 * The magics worth handing to the reader: a level, and a plan.
 *
 * ❗ **A plan is a saved Thing, not a level, and it is where most of the music
 * is.** A creator who copies a sequencer into their popit gets a `PLNb`, and a
 * backup is full of them: 224 across the six saves measured, **171 holding a
 * music sequencer** against six levels holding 19. `readLevelProject` dispatches
 * on this same magic and unwraps the plan's nested Thing blob.
 *
 * ⚠️ `PLNb` was in here before any of that worked, when it meant "read a plan as
 * if it were a world" -- eleven failures reported for one backup that was fine.
 * The magic was never the problem; the reader was.
 */
const LEVEL_MAGIC = ['LVLb', 'PLNb'];

/** A file's folder and its leaf name. Paths are shown, never otherwise parsed. */
function split(name: string): { folder: string; leaf: string } {
  const at = name.lastIndexOf('/');
  return at < 0 ? { folder: '', leaf: name } : { folder: name.slice(0, at), leaf: name.slice(at + 1) };
}

/**
 * Unpack every save archive in the pile, replacing it with what was inside.
 *
 * ❗ **A save is found by the `FAR` magic in a file's last four bytes**, not by
 * `PARAM.SFO` and not by the folder's name -- the magic is the one part the
 * writer leaves in the clear. Its siblings named `0`, `1`, … are the rest of the
 * archive, in numeric order, and `PARAM.SFO` beside them only supplies a name.
 */
async function unpackSaves(files: readonly BackupFile[]): Promise<{
  files: BackupFile[];
  saves: { folder: string; name?: string; resources?: number; why?: string }[];
}> {
  const folders = new Map<string, BackupFile[]>();
  for (const file of files) {
    const { folder } = split(file.name);
    const group = folders.get(folder);
    if (group) group.push(file);
    else folders.set(folder, [file]);
  }
  const out: BackupFile[] = [];
  const saves: { folder: string; name?: string; resources?: number; why?: string }[] = [];
  for (const [folder, group] of folders) {
    const tail = group.find((f) => saveArchiveRevision(f.bytes) !== undefined);
    if (!tail) {
      out.push(...group);
      continue;
    }
    const numbered = group
      .filter((f) => /^\d+$/.test(split(f.name).leaf))
      .sort((a, b) => Number(split(a.name).leaf) - Number(split(b.name).leaf));
    const chunks = numbered.includes(tail) ? numbered : [tail];
    const sfo = group.find((f) => split(f.name).leaf.toUpperCase() === 'PARAM.SFO');
    const name = sfo ? psfName(sfo.bytes) : undefined;
    try {
      const inside = await readSaveArchive(chunks.map((c) => c.bytes));
      for (const resource of inside) {
        out.push({ name: folder ? `${folder}/${resource.sha1}` : resource.sha1, bytes: resource.bytes });
      }
      saves.push({ folder, name, resources: inside.length });
    } catch (error) {
      // ⚠️ The save's own files stay in the pile when it will not open, so a
      // folder that is a save in name only is still scanned like anything else.
      out.push(...group);
      saves.push({ folder, name, why: error instanceof Error ? error.message : String(error) });
    }
  }
  return { files: out, saves };
}

/**
 * Whether a file is worth handing to `readLevelProject` at all.
 *
 * ⚠️ **By its first four bytes, never by its name.** The game names a resource
 * after its SHA-1, so there is no extension to go on, and a backup is full of
 * things that are not levels -- `ICON0.PNG`, `PARAM.SFO`, palettes, costumes.
 * Trying every file works but reports forty failures for one level.
 */
export function looksLikeLevel(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  return LEVEL_MAGIC.includes(magic);
}

/**
 * Read every level in a pile of files.
 *
 * The order in is the order out, so a folder listing and the list on screen
 * agree.
 */
export async function readBackup(
  files: readonly BackupFile[],
  inflate: Inflate,
): Promise<BackupResult> {
  const projects: LevelProject[] = [];
  const failed: { name: string; why: string }[] = [];
  let quiet = 0;
  let other = 0;
  const unpacked = await unpackSaves(files);
  for (const file of unpacked.files) {
    if (!looksLikeLevel(file.bytes)) {
      other += 1;
      continue;
    }
    try {
      const project = await readLevelProject(file.name, file.bytes, inflate);
      if (project.sequencers.length === 0) quiet += 1;
      else projects.push(project);
    } catch (error) {
      failed.push({ name: file.name, why: error instanceof Error ? error.message : String(error) });
    }
  }
  return { projects, quiet, other, failed, saves: unpacked.saves };
}

/**
 * The same, for a zip: unpack it and read what is inside.
 *
 * ❗ **One level deep is enough and nesting is not followed.** A zip of a zip is
 * something a person did on purpose and can undo on purpose; guessing at it
 * would mean inflating anything that happened to start with `PK`.
 */
export async function readBackupZip(
  bytes: Uint8Array,
  inflate: Inflate,
  inflateRaw: InflateRaw,
): Promise<BackupResult> {
  return readBackup(await readZip(bytes, inflateRaw), inflate);
}

/**
 * Every sequencer in a backup, with the level it came from, biggest first.
 *
 * ⚠️ **The uid is unique inside a level and not across one backup**, so a
 * picker keyed on it alone would show one row where two levels each have a
 * sequencer numbered 7. `key` is what to index on.
 */
export function sequencersOf(result: BackupResult): {
  key: string;
  file: string;
  uid: number;
  name: string;
  tracks: number;
}[] {
  const rows = result.projects.flatMap((project) =>
    project.sequencers.map((sequencer) => ({
      key: `${project.file}#${sequencer.uid}`,
      file: project.file,
      uid: sequencer.uid,
      name: sequencer.name,
      tracks: sequencer.tracks.length,
    })),
  );
  return rows.sort((a, b) => b.tracks - a.tracks);
}
