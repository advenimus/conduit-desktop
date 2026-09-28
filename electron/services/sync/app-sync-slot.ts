/**
 * The one personal-vault slot of AppSyncManager (spec 6.3, 6.4): one open at a time, a lock or
 * quit that arrives during an open cancels its waits and closes whatever it opened (the open
 * then fails, so nothing reports the vault unlocked), and a new open waits for a lock that is
 * still flushing. A failed re-open keeps the soft-locked vault it was meant to replace.
 */

import { OPEN_CANCELLED_MESSAGE } from '../vault-session/open-errors.js';
import { SYNC_LOG_PREFIX, type SyncLogger } from './host.js';

export const VAULT_ALREADY_OPEN_MESSAGE = 'Lock the open vault before unlocking another one.';
export const OPEN_IN_PROGRESS_MESSAGE = 'The vault is still opening. Wait for it to finish.';

export type CloseKind = 'lock' | 'quit';

/** What the slot holds: the open vault's runtime is all it needs. */
export interface SlotItem {
  readonly runtime: {
    isSoftLocked(): boolean;
    lock(): Promise<unknown>;
    quit(): Promise<unknown>;
  };
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'Error';
}

export class VaultSlot<T extends SlotItem> {
  private item: T | null = null;
  private opening: Promise<void> | null = null;
  private closeAfterOpen: CloseKind | null = null;
  private cancelWaiters: (() => void)[] = [];
  private closing: Promise<void> | null = null;

  constructor(private readonly logger: SyncLogger) {}

  /** The open or soft-locked vault (null while closing). */
  current(): T | null {
    return this.item;
  }

  isOpening(): boolean {
    return this.opening !== null;
  }

  /** Opening, closing, open or soft-locked: a lease may still need a flush and release. */
  isBusy(): boolean {
    return this.opening !== null || this.closing !== null || this.item !== null;
  }

  /** Resolves when a lock or quit arrives during the current open (OpenProgress.cancelRequested). */
  cancelRequested(): Promise<void> {
    if (this.closeAfterOpen !== null) return Promise.resolve();
    return new Promise<void>((resolve) => this.cancelWaiters.push(resolve));
  }

  /** Runs `run` as the only open; the result replaces the current item only when it succeeds. */
  async open(run: () => Promise<T>): Promise<T> {
    if (this.opening !== null) throw new Error(OPEN_IN_PROGRESS_MESSAGE);
    let settle!: () => void;
    this.opening = new Promise<void>((resolve) => (settle = resolve));
    this.closeAfterOpen = null;
    try {
      if (this.closing !== null) await this.closing;
      this.throwIfCancelled();
      const current = this.item;
      if (current !== null && !current.runtime.isSoftLocked()) throw new Error(VAULT_ALREADY_OPEN_MESSAGE);
      const item = await run();
      const kind = this.closeAfterOpen;
      if (kind !== null) {
        this.logger.info(`${SYNC_LOG_PREFIX} a ${kind} arrived while the vault was opening; closing it again`);
        await this.closeItem(item, kind);
        throw new Error(OPEN_CANCELLED_MESSAGE);
      }
      this.item = item;
      return item;
    } finally {
      this.opening = null;
      this.closeAfterOpen = null;
      this.releaseCancelWaiters();
      settle();
    }
  }

  /** Lock or quit: an open in progress closes itself first; concurrent calls share one close. */
  async close(kind: CloseKind): Promise<void> {
    const opening = this.opening;
    if (opening !== null) {
      if (this.closeAfterOpen !== 'quit') this.closeAfterOpen = kind;
      this.releaseCancelWaiters();
      await opening;
    }
    if (this.closing !== null) return this.closing;
    const item = this.item;
    if (item === null) return;
    this.item = null;
    this.closing = this.closeItem(item, kind).finally(() => {
      this.closing = null;
    });
    return this.closing;
  }

  private throwIfCancelled(): void {
    if (this.closeAfterOpen !== null) throw new Error(OPEN_CANCELLED_MESSAGE);
  }

  private async closeItem(item: T, kind: CloseKind): Promise<void> {
    try {
      await (kind === 'quit' ? item.runtime.quit() : item.runtime.lock());
    } catch (err) {
      this.logger.error(`${SYNC_LOG_PREFIX} ${kind} did not finish cleanly`, { name: errName(err) });
    }
  }

  private releaseCancelWaiters(): void {
    const waiters = this.cancelWaiters;
    this.cancelWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
