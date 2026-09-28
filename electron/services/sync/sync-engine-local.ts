/**
 * Small, failure-tolerant readers and writers the engine uses around cycles: local.json
 * pending_publish (hint only, written on a flip, spec 5.6 / 5.11), the status counters, the
 * bound file name, and the guard that logs bookkeeping failures instead of breaking the loop.
 */

import path from 'node:path';
import type { StatusPatch } from './sync-status.js';
import type { SyncEngineDeps } from './sync-engine-types.js';
import type { SyncLogger } from './host.js';
import { SYNC_LOG_PREFIX } from './host.js';

export function errMeta(err: unknown): { name: string; code: string | null } {
  const e = err as { name?: string; code?: unknown } | null | undefined;
  return { name: e?.name ?? 'Error', code: typeof e?.code === 'string' ? e.code : null };
}

/** Bookkeeping around cycles must never break the engine: log and continue. */
export function guarded(logger: SyncLogger, what: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    logger.error(`${SYNC_LOG_PREFIX} ${what} failed`, errMeta(err));
  }
}

/** fn's value, or null when it threw (logged like guarded). */
export function guardedValue<T>(logger: SyncLogger, what: string, fn: () => T): T | null {
  let value: T | null = null;
  guarded(logger, what, () => {
    value = fn();
  });
  return value;
}

type LocalDeps = Pick<SyncEngineDeps, 'replica' | 'host'>;

/** local.json pending_publish, written only on a flip (one atomic write per flip). */
export function persistPending(deps: LocalDeps, value: boolean): void {
  guarded(deps.host.logger, 'pending_publish', () => {
    if (deps.replica.local().pendingPublish === value) return;
    deps.replica.updateLocal((l) => ({ ...l, pendingPublish: value }));
  });
}

/** pending_publish, or true when local.json cannot be read (never claim everything is synced). */
export function readPending(deps: LocalDeps): boolean {
  try {
    return deps.replica.local().pendingPublish;
  } catch (err) {
    deps.host.logger.warn(`${SYNC_LOG_PREFIX} could not read pending_publish`, errMeta(err));
    return true;
  }
}

/** "N changes not yet synced": ops since the last publish, pending when either says so. */
export function counters(deps: LocalDeps, unsyncedOps: number): StatusPatch {
  let pending = unsyncedOps > 0;
  try {
    pending = pending || deps.replica.local().pendingPublish;
  } catch (err) {
    deps.host.logger.warn(`${SYNC_LOG_PREFIX} could not read pending_publish`, errMeta(err));
  }
  return { unsyncedOps, pendingPublish: pending };
}

export function boundFileName(deps: Pick<SyncEngineDeps, 'binding' | 'host'>): string | null {
  try {
    return path.basename(deps.binding.sharedPath());
  } catch (err) {
    deps.host.logger.warn(`${SYNC_LOG_PREFIX} no bound shared file`, errMeta(err));
    return null;
  }
}
