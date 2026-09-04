/**
 * Opening a level BACKUP -- a folder, or a zip of one -- rather than one level.
 *
 * A creator's backup is not a file, it is a pile: the game writes each resource
 * under its own SHA-1 and a backup is the directory that holds them. Asking
 * somebody to find the level inside by hand is asking them to open forty
 * extensionless files and guess, so this takes the whole pile and reports what
 * is in it.
 *
 * ⚠️ **Everything here works on bytes the caller already has.** The user's own
 * game files are read client-side and never uploaded -- see
 * `steering/game-assets.md` -- so this module fetches nothing and knows nothing
 * about `File`, directories or archives. The page hands it names and bytes.
 */

import type { Inflate } from './resource.ts';
import { readLevelProject, type LevelProject } from './project.ts';
import { psfName } from './psf.ts';
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
   * PS3 save games in the pile: the folder, and what the player called it.
   *
   * ⚠️ **These hold a level and it cannot be read.** A PS3 save is encrypted
   * with a key derived from the title. That was first written here as a guess
   * dressed in a measurement -- "8.000 bits per byte, all 256 values" -- which
   * is equally true of COMPRESSED data and so proved nothing. What settles it:
   *
   * - `PARAM.PFD` carries the magic `PFDB`, the PS3 Protected File Database;
   * - two saves **of the same game** share **0** of their 16-byte blocks, and
   *   agree byte-for-byte at 1,816 offsets of 472,960 where chance alone gives
   *   ~1,848. Two compressed files of one format would share their header at
   *   the very least;
   * - nothing inflates at any of the first 4,096 offsets, and both files are a
   *   whole number of 16-byte blocks.
   *
   * ❗ **`PARAM.SFO` is NOT encrypted**, so the save can still say what it is.
   * "FJ's Music Hub by Festerd_Jester" beats "a PS3 save game", which beats
   * "no sequencers in there".
   */
  readonly ps3Saves: readonly { readonly folder: string; readonly name?: string }[];
}

/** The magics a level resource can carry; anything else is not one. */
const LEVEL_MAGIC = ['LVLb', 'PLNb'];

/**
 * The folders in a pile that are PS3 save games.
 *
 * ❗ By `PARAM.SFO`, which every PS3 save carries and nothing else here does.
 * The numbered files beside it (`0`, `1`) are the encrypted payload.
 */
function ps3SavesIn(files: readonly BackupFile[]): { folder: string; name?: string }[] {
  const found: { folder: string; name?: string }[] = [];
  for (const file of files) {
    const at = file.name.lastIndexOf('/');
    const leaf = at < 0 ? file.name : file.name.slice(at + 1);
    if (leaf.toUpperCase() !== 'PARAM.SFO') continue;
    found.push({ folder: at < 0 ? '' : file.name.slice(0, at), name: psfName(file.bytes) });
  }
  return found;
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
  for (const file of files) {
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
  return { projects, quiet, other, failed, ps3Saves: ps3SavesIn(files) };
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
