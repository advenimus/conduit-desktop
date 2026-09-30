/**
 * Listener lists of the replica (local commits, full-pass requests) and the hand-over from
 * captureInTransaction to afterCommit. A throwing listener is logged and never undoes a
 * committed mutation. Import through replica.ts.
 */

import { SYNC_LOG_PREFIX, type SyncLogger, type VaultMutationInfo } from './host.js';
import type { RowKey } from './types.js';

export interface CapturedPending {
  readonly changed: boolean;
  /** Content rows materialize changed beyond the mutator's own rows (renderer refresh). */
  readonly extraRows: readonly RowKey[];
}

const NOTHING_CAPTURED: CapturedPending = { changed: false, extraRows: [] };

export class ReplicaEvents {
  private readonly commitListeners = new Set<(m: VaultMutationInfo) => void>();
  private readonly fullPassListeners = new Set<(reason: string) => void>();
  private pending: CapturedPending = NOTHING_CAPTURED;

  constructor(private readonly logger: SyncLogger) {}

  onLocalCommit(listener: (m: VaultMutationInfo) => void): () => void {
    this.commitListeners.add(listener);
    return () => this.commitListeners.delete(listener);
  }

  onFullPassRequest(listener: (reason: string) => void): () => void {
    this.fullPassListeners.add(listener);
    return () => this.fullPassListeners.delete(listener);
  }

  localCommitted(m: VaultMutationInfo): void {
    for (const listener of [...this.commitListeners]) this.call('local-commit', () => listener(m));
  }

  fullPassRequested(reason: string): void {
    for (const listener of [...this.fullPassListeners]) this.call('full-pass-request', () => listener(reason));
  }

  /** Records what a capture inside a mutator transaction did; several captures in one transaction add up. */
  captured(changed: boolean, extraRows: readonly RowKey[]): void {
    this.pending = {
      changed: this.pending.changed || changed,
      extraRows: extraRows.length === 0 ? this.pending.extraRows : [...this.pending.extraRows, ...extraRows],
    };
  }

  takeCaptured(): CapturedPending {
    const out = this.pending;
    this.pending = NOTHING_CAPTURED;
    return out;
  }

  clear(): void {
    this.commitListeners.clear();
    this.fullPassListeners.clear();
    this.pending = NOTHING_CAPTURED;
  }

  private call(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.logger.error(`${SYNC_LOG_PREFIX} replica listener failed`, { what, name: err instanceof Error ? err.name : typeof err });
    }
  }
}
