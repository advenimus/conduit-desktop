/**
 * Shapes of backup restores for synced vaults (spec 5.10). Import through restore.ts.
 */

import type { ContentSnapshot, EpochKeys, ImplicitProvider, PreviewField, PreviewRow, SyncContext, SyncState } from './types.js';

export const CHANGED_BY_ROLLBACK = 'rollback';

export interface BackupContent {
  readonly content: ContentSnapshot;
  /** Keys of the backup's own vault_meta (salt + verification) when the password opens it, else null. */
  readonly keys: EpochKeys | null;
}

export interface RollbackPreview {
  /** Rows live now but absent from the backup: deleted by the rollback. */
  readonly deletions: readonly PreviewRow[];
  /** Rows in the backup that are dead or unknown now: re-created. */
  readonly restorations: readonly PreviewRow[];
  /** Fields whose current provisional value differs from the backup (secrets masked). */
  readonly replacements: readonly PreviewField[];
  /** Secret fields the backup key could not read (skipped, reported). */
  readonly unreadableSecrets: number;
}

export interface RollbackInput {
  readonly backup: BackupContent;
  readonly current: SyncState;
  readonly ctx: SyncContext;
  readonly implicit: ImplicitProvider;
}
