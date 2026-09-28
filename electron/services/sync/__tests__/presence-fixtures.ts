// Presence registers on small in-memory states (presence and verify tests).
import { deviceRegKey } from '../catalog.js';
import { vhashOfValue } from '../hashing.js';
import { makePmem } from '../sibling.js';
import type { SyncState } from '../types.js';
import { DEVICE_A, appSib, epochKeysFor, makeState, pseudoSib, recordFor, seqRandom, withRegister } from './key-epoch-fixtures.js';

export { DEVICE_A };

const E1 = epochKeysFor('pw', 'salt1');

/** A state with only the epoch register (E1). */
export const E1_FIXTURE: SyncState = makeState({ current: E1, records: [recordFor(E1, null, 'salt1', seqRandom(3))] });

/** `state` with `_sync/device/<uuid>` = `text` as one sibling (dev 0: a pseudo sibling). */
export function stateWithPresence(state: SyncState, uuid: string, text: string, at: { readonly dev: number; readonly ms: number }): SyncState {
  const key = deviceRegKey(uuid);
  const vhash = vhashOfValue(key, text);
  if (at.dev > 0) return withRegister(state, key, [appSib(at.dev, at.ms, text, vhash)]);
  const pid = 'ab'.repeat(8);
  return withRegister(state, key, [pseudoSib(at.ms, pid, text, vhash)], makePmem(at.ms, [pid]));
}
