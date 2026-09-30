/**
 * The app follows the open vault's shared file when the engine binds it to another path (spec
 * 5.9: the automatic rebind and its [Undo], [Locate...], [Save a new copy here], an in-app
 * rename). Without this the app kept the old path: sync_get_state named the missing file, and
 * the recent vaults list offered only that path after a relaunch.
 */

import path from 'node:path';
import type { FileBindingPort } from './file-binding.js';
import { SYNC_LOG_PREFIX, type SyncLogger } from './host.js';

/** Renderer event with {path}: the vault store and the recent list follow the moved file. */
export const VAULT_PATH_CHANGED_EVENT = 'vault:path-changed';

export interface SharedPathChange {
  readonly from: string;
  readonly to: string;
}

/**
 * Calls `moved` whenever the binding's path differs from `current()` (null: the vault is no
 * longer the open one). A failing `moved` is logged, never thrown into the engine. Returns the
 * unsubscribe function.
 */
export function followSharedPath(
  binding: Pick<FileBindingPort, 'onChange'>,
  current: () => string | null,
  moved: (change: SharedPathChange) => void,
  logger: SyncLogger,
): () => void {
  return binding.onChange((b) => {
    const from = current();
    const to = path.resolve(b.sharedPath);
    if (from === null || path.resolve(from) === to) return;
    try {
      moved({ from, to });
    } catch (err) {
      logger.error(`${SYNC_LOG_PREFIX} following the moved shared file failed`, { name: err instanceof Error ? err.name : 'Error' });
    }
  });
}
