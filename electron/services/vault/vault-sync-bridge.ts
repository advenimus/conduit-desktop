/**
 * The sync side of ConduitVault (spec 4.2, 6.6): capture hooks called inside
 * every mutator transaction, the interactive flag of 4.2 step 5, and the access block a
 * displaced device sets before its final save. ConduitVault owns one bridge per instance;
 * team vaults and in-place vaults never install hooks, so their mutators only gain a transaction.
 */

import type { VaultMutationInfo, VaultSyncHooks } from '../sync/host.js';
import { TBL, type RowKey } from '../sync/types.js';
import type { LockedReason } from '../vault-session/host.js';

export const VAULT_LOCKED_MESSAGE = 'Vault is locked';
const LOG_PREFIX = '[sync]';

/** Thrown by vault reads and writes while locked; `reason` is set while another device holds the vault. */
export class VaultLockedError extends Error {
  readonly reason: LockedReason | null;

  constructor(reason: LockedReason | null = null) {
    super(VAULT_LOCKED_MESSAGE);
    this.name = 'VaultLockedError';
    this.reason = reason;
  }
}

/** A mutator's return value and the content rows it touched (deleted rows included). */
export interface MutationOutcome<T> {
  readonly value: T;
  readonly rows: readonly RowKey[];
}

export const entryRow = (rowId: string): RowKey => ({ tbl: TBL.entries, rowId });
export const folderRow = (rowId: string): RowKey => ({ tbl: TBL.folders, rowId });
export const historyRow = (rowId: string): RowKey => ({ tbl: TBL.history, rowId });

/** Runs `fn` inside one SQLite transaction and returns its result (ConduitDatabase.runInTransaction). */
export type TransactionRunner = <R>(fn: () => R) => R;

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'Error';
}

function isThenable(v: unknown): boolean {
  return typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function';
}

export class VaultSyncBridge {
  private hooks: VaultSyncHooks | null = null;
  private interactive = true;
  private blocked: LockedReason | null = null;

  setHooks(hooks: VaultSyncHooks | null): void {
    this.hooks = hooks;
  }

  block(reason: LockedReason | null): void {
    this.blocked = reason;
  }

  blockedReason(): LockedReason | null {
    return this.blocked;
  }

  /** Called by ConduitVault.lock(): hooks and the block end with the connection. */
  reset(): void {
    this.hooks = null;
    this.blocked = null;
  }

  /** MCP, importers and autofill-selector saves (4.2 step 5). `fn` must be synchronous. */
  runNonInteractive<T>(fn: () => T): T {
    const previous = this.interactive;
    this.interactive = false;
    try {
      const out = fn();
      if (isThenable(out)) console.warn(`${LOG_PREFIX} runNonInteractive got an async callback; later writes count as interactive`);
      return out;
    } finally {
      this.interactive = previous;
    }
  }

  /**
   * Writes and capture in one transaction: a capture that throws rolls the writes back.
   * afterCommit runs once the transaction committed and never fails the mutation.
   */
  run<T>(transaction: TransactionRunner, write: () => MutationOutcome<T>): T {
    const captured: { info: VaultMutationInfo | null } = { info: null };
    const value = transaction(() => {
      const out = write();
      const info: VaultMutationInfo = { rows: out.rows, interactive: this.interactive };
      this.hooks?.captureInTransaction(info);
      captured.info = info;
      return out.value;
    });
    if (captured.info !== null) this.afterCommit(captured.info);
    return value;
  }

  /** Before or after a write that bypasses the hooks (vault_meta). */
  requestFullPass(reason: string): void {
    try {
      this.hooks?.requestFullPass(reason);
    } catch (err) {
      console.error(`${LOG_PREFIX} full pass request failed`, { reason, name: errorName(err) });
    }
  }

  private afterCommit(info: VaultMutationInfo): void {
    try {
      this.hooks?.afterCommit(info);
    } catch (err) {
      console.error(`${LOG_PREFIX} afterCommit hook failed; the next cycle picks the change up`, { name: errorName(err) });
    }
  }
}
