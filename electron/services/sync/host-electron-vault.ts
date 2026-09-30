/**
 * The working copy W through ConduitVault (spec 3.3 single connection, 5.1):
 * WorkingCopyHost.open() asks the current personal ConduitVault to open W as its connection
 * with the accepted key, and the handle routes key changes, hooks, content refreshes and close
 * back to that same vault object. SyncableVault is the contract ConduitVault implements
 * (electron/services/vault/vault.ts, main-process integration).
 */

import type Database from 'better-sqlite3';
import { SYNC_LOG_PREFIX } from './host.js';
import type {
  SyncLogger,
  TimerHandle,
  Timers,
  VaultSyncHooks,
  WorkingCopyHandle,
  WorkingCopyHost,
  WorkingCopyOpenInput,
} from './host.js';
import type { RowKey } from './types.js';

/**
 * What ConduitVault provides for a working copy. The vault keeps `getFilePath()` = the shared
 * path S (settings, backups, rename, biometric) and uses W only as its connection.
 */
export interface SyncableVault {
  /**
   * Opens `input.path` (W) with ConduitDatabase (migrations, CREATE_SCHEMA, busy_timeout,
   * foreign_keys, `input.journalMode`), adopts `input.key` without a password check, and
   * returns the raw better-sqlite3 connection, which becomes W's ONLY connection. `create`:
   * the file must not exist. Throws when the vault is already unlocked.
   */
  openWorkingCopy(input: WorkingCopyOpenInput): Database.Database;
  /** W moved to another key epoch: decrypt and encrypt with `key` from now on. */
  setSyncKey(key: Buffer): void;
  /** Hooks called inside every mutator transaction (null removes them). */
  setSyncHooks(hooks: VaultSyncHooks | null): void;
  /** Clears the key and closes the connection (idempotent). */
  lock(): void;
}

/** One renderer reload per burst of merge commits. */
export const CONTENT_REFRESH_COALESCE_MS = 150;

export interface VaultWorkingCopyDeps {
  /** The current personal vault at open time (AppState.vault). */
  readonly vault: () => SyncableVault;
  /** Sends `vault:entries-refreshed` to the renderer (the existing reload event). */
  readonly refreshRenderer: () => void;
  readonly timers: Timers;
  readonly logger: SyncLogger;
}

class CoalescedRefresh {
  private timer: TimerHandle | null = null;

  constructor(private readonly deps: VaultWorkingCopyDeps) {}

  request(rows: readonly RowKey[]): void {
    if (rows.length === 0 || this.timer !== null) return;
    this.timer = this.deps.timers.setTimeout(() => {
      this.timer = null;
      try {
        this.deps.refreshRenderer();
      } catch (err) {
        this.deps.logger.warn(`${SYNC_LOG_PREFIX} renderer refresh failed`, { name: (err as Error)?.name ?? 'Error' });
      }
    }, CONTENT_REFRESH_COALESCE_MS);
  }

  cancel(): void {
    this.timer?.cancel();
    this.timer = null;
  }
}

class VaultWorkingCopy implements WorkingCopyHandle {
  private closed = false;
  private readonly refresh: CoalescedRefresh;

  constructor(
    readonly db: Database.Database,
    private readonly vault: SyncableVault,
    deps: VaultWorkingCopyDeps,
  ) {
    this.refresh = new CoalescedRefresh(deps);
  }

  setKey(key: Buffer): void {
    this.vault.setSyncKey(key);
  }

  setHooks(hooks: VaultSyncHooks | null): void {
    this.vault.setSyncHooks(hooks);
  }

  contentChanged(rows: readonly RowKey[]): void {
    if (!this.closed) this.refresh.request(rows);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.refresh.cancel();
    this.vault.setSyncHooks(null);
    this.vault.lock();
  }
}

export function createVaultWorkingCopyHost(deps: VaultWorkingCopyDeps): WorkingCopyHost {
  return {
    open(input: WorkingCopyOpenInput): WorkingCopyHandle {
      const vault = deps.vault();
      const db = vault.openWorkingCopy(input);
      deps.logger.info(`${SYNC_LOG_PREFIX} working copy opened`, { journal: input.journalMode, create: input.create });
      return new VaultWorkingCopy(db, vault, deps);
    },
  };
}
