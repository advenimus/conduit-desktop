/**
 * The bytes a cloud or local backup encrypts. A vault the sync engine manages is read from a
 * VACUUM INTO snapshot of its working copy (spec 5.10), never from the shared file that other
 * devices and cloud drives rewrite. A vault opened in place is read from its file as before.
 * Snapshots go to a private temp folder (mode 0700) that is always removed.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Writes a consistent copy of the open vault to `target` (a path that does not exist yet). */
export type SnapshotWriter = (target: string) => Promise<void>;

export interface BackupSource {
  readonly vaultPath: string;
  readonly snapshot?: SnapshotWriter | null;
}

const SNAPSHOT_DIR_PREFIX = 'conduit-backup-';
const SNAPSHOT_FILE_NAME = 'snapshot.conduit';

async function removeQuietly(dir: string): Promise<void> {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch (err) {
    console.warn('[backup] Could not remove a temporary snapshot folder:', (err as NodeJS.ErrnoException)?.code ?? err);
  }
}

export async function readBackupBytes(source: BackupSource, tmpRoot: string = os.tmpdir()): Promise<Buffer> {
  if (!source.snapshot) return fs.promises.readFile(source.vaultPath);
  const dir = await fs.promises.mkdtemp(path.join(tmpRoot, SNAPSHOT_DIR_PREFIX));
  try {
    const target = path.join(dir, SNAPSHOT_FILE_NAME);
    await source.snapshot(target);
    return await fs.promises.readFile(target);
  } finally {
    await removeQuietly(dir);
  }
}
