/**
 * Existing vault flows on an engine-managed personal vault: the master-password change as one
 * W transaction with a new key epoch (spec 4.8), the backup snapshot of W (5.10), and a rename
 * of the shared file that rebinds the engine. Each runs in the engine's lane.
 */

import path from 'node:path';
import { INVALID_PASSWORD_MESSAGE } from '../vault-session/open-personal-vault.js';
import { vacuumInto } from './shared-file.js';
import type { SyncLogger } from './host.js';
import type { EngineVault } from './app-sync-review.js';

export const WRONG_CURRENT_PASSWORD_MESSAGE = 'Current password is incorrect';

export async function changeEnginePassword(v: EngineVault, currentPassword: string, newPassword: string, eraseRecentlyDeleted: boolean): Promise<void> {
  try {
    await v.engine.exclusive(() => v.replica.changePassword(currentPassword, newPassword, eraseRecentlyDeleted));
  } catch (err) {
    if (err instanceof Error && err.message === INVALID_PASSWORD_MESSAGE) throw new Error(WRONG_CURRENT_PASSWORD_MESSAGE);
    throw err;
  }
  v.engine.trigger('sync-now');
}

/** A VACUUM INTO snapshot of W at `target`, for cloud and local backups. */
export async function snapshotEngineVault(v: EngineVault, target: string, logger: SyncLogger): Promise<void> {
  await v.engine.exclusive(() => vacuumInto(v.replica.database(), target, logger));
}

export const RENAME_WHILE_OLDER_OPEN_MESSAGE =
  'An older version of Conduit has this vault open on another computer. Close Conduit there, then rename the vault.';

/** Renames S only and rebinds. Refused while an older desktop has S open (5.5): its side files keep the old name. */
export async function renameEngineShared(v: EngineVault, newFileName: string): Promise<string> {
  const parts = v.engine.parts();
  const b = await v.engine.exclusive(() => {
    const olderAppOpen = parts.sideFiles.view().state === 'present' || parts.session.serverSideFilesFlagRecent(parts.host.clock.now());
    if (olderAppOpen) throw new Error(RENAME_WHILE_OLDER_OPEN_MESSAGE);
    return parts.binding.renameShared(newFileName);
  });
  v.engine.parts().status.update({ fileName: path.basename(b.sharedPath) });
  v.engine.trigger('sync-now');
  return b.sharedPath;
}
