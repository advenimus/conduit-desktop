// States carrying an owner tag (`_sync/owner/account`) with a chosen value and HLC ms, for the owner-tag tests.
import { applyLocalWrites, prepareWrite } from '../../sync/capture-local.js';
import { ownerTagRegKey } from '../../sync/catalog.js';
import { emptyState } from '../../sync/state-view.js';
import type { SyncContext, SyncState } from '../../sync/types.js';
import { GENESIS, dot, implicitFor, makeCtx, type TestCtx } from '../../sync/__tests__/capture-fixtures.js';

const DEV = 101;
const CTX: TestCtx = makeCtx({ dev: DEV, nowMs: 1_000 });

export function contextFor(_state: SyncState): SyncContext {
  return CTX;
}

/** An empty state of `lineageId`, then each tag value written by one app dot at its ms (the last one stays). */
export function stateWithOwnerTag(lineageId: string, tags: readonly { readonly value: string; readonly ms: number }[]): SyncState {
  let state = emptyState(lineageId, GENESIS, 0);
  const implicit = implicitFor(CTX);
  for (const t of tags) {
    const write = prepareWrite(ownerTagRegKey(), { value: t.value }, CTX, 'replace-all');
    state = applyLocalWrites(state, [write], { kind: 'local', dot: dot(DEV, t.ms), interactive: true }, CTX, implicit, { ruleR: false }).state;
  }
  return state;
}
