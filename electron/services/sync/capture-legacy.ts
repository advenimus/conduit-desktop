/**
 * Capture of legacy edits (spec 4.3): changes an older app made to a file's content since its
 * own sync tables were written become deterministic pseudo siblings (keyed pid over vref and
 * base_ref). Implements the drop rule, the hold rule, the stale-revert rule, legacy delete
 * times from the observed file mtime, rule R re-assertions with pseudo dots, cascade rule H,
 * stale-key secrets (via key-epoch.readSecret) and the G2 staleness filter hook.
 * Pure: returns a new state.
 *
 * Parts: capture-legacy-rules (times, drop, stale revert), capture-legacy-change (one change),
 * capture-legacy-apply (row pass attribution, rule R, value repair). The row pass itself is
 * shared with capture-local (capture-local-diff).
 */

import { asBlob, registerDef } from './catalog.js';
import type { CaptureInput } from './capture-local.js';
import { diffFull } from './capture-local-diff.js';
import { absorbSecretKeys } from './capture-local-observe.js';
import { buildResult, newTally, unchangedResult } from './capture-local-result.js';
import { cursorOf } from './capture-local-write.js';
import { applyLegacyDiffs } from './capture-legacy-apply.js';
import { vhashOfSecret, vhashUndecryptable } from './hashing.js';
import { encryptSecret, readSecret } from './key-epoch.js';
import { identityKey, isPseudo, isRedacted, pmemCovers, pmemJoin } from './sibling.js';
import { StateBuilder, makeRegister, rowKeyStr, rowOf } from './state-view.js';
import {
  SIB_UNDECRYPTABLE,
  type CaptureResult,
  type HeldLegacyChange,
  type ImplicitProvider,
  type LegacyAttribution,
  type RegKey,
  type RowKey,
  type Sibling,
  type SyncContext,
  type SyncState,
} from './types.js';

export {
  isDroppedChange,
  isStaleRevert,
  legacyDeleteTime,
  legacyEditTime,
  type LegacyTime,
} from './capture-legacy-rules.js';

/**
 * capture(X, Legacy(file)) where X = the absorbed file's own state and content.
 * `input.implicit` must be built from att.absorbKeys.kSync.
 */
export function captureLegacy(input: CaptureInput, att: LegacyAttribution, ctx: SyncContext): CaptureResult {
  const keys = absorbSecretKeys(att.absorbKeys, ctx.keys);
  const diffs = diffFull(input, { keys, skipRow: att.filter?.skipRow });
  return applyLegacyDiffs(input, diffs, att, ctx, keys);
}

/**
 * [Apply these changes] on held legacy changes (7.3): re-applies each held sibling with the
 * 4.3 "otherwise" replacement (removes `replaces` and `replacesEqual` if still present and every
 * older pseudo sibling; siblings that arrived after the hold stay), joins pmemAdd. Held siblings whose register now covers them are skipped. A held
 * secret was sealed and hashed under the epoch of the absorbed file; it is moved to the state's
 * current epoch (ctx.keys.current) first, since a password change may have happened since.
 * `implicit` must be built from ctx.keys.current.kSync.
 */
export function applyHeld(
  state: SyncState,
  held: readonly HeldLegacyChange[],
  implicit: ImplicitProvider,
  ctx: Pick<SyncContext, 'keys' | 'randomBytes'>,
): CaptureResult {
  if (held.length === 0) return unchangedResult(state);
  const b = new StateBuilder(state);
  const rows = new Map<string, RowKey>();
  const tally = newTally();
  for (const h of held) {
    const cur = cursorOf(b, state, h.key, implicit);
    if (pmemCovers(cur.pmem, h.sibling)) continue;
    const replaced = new Set(h.replacesEqual ?? []);
    if (h.replaces !== null) replaced.add(h.replaces);
    const kept = cur.sibs.filter((s) => !isPseudo(s) && !replaced.has(identityKey(s)));
    const sibling = currentEpochSibling(h.key, h.sibling, ctx);
    b.setRegister(makeRegister(h.key, [...kept, sibling], pmemJoin(cur.pmem, h.pmemAdd)));
    rows.set(rowKeyStr(h.key), rowOf(h.key));
    if (h.kind === 'delete') tally.legacyDeletes++;
    else tally.legacyEdits++;
  }
  return buildResult(state, b.build(), [...rows.values()], tally);
}

/**
 * A held secret sibling under the state's current epoch (4.8 stale-key rule): opened with any
 * ring key, re-encrypted under the current key and re-hashed with its K_sync; undecryptable
 * when no ring key opens it. The identity (pid) never changes.
 */
function currentEpochSibling(key: RegKey, s: Sibling, ctx: Pick<SyncContext, 'keys' | 'randomBytes'>): Sibling {
  if (registerDef(key)?.secret !== true || isRedacted(s)) return s;
  const current = ctx.keys.current;
  const bytes = asBlob(s.value);
  const readable = s.flags & ~SIB_UNDECRYPTABLE;
  if (bytes === null || bytes.length === 0) {
    return { ...s, value: null, flags: readable, vhash: vhashOfSecret(key, null, current.kSync) };
  }
  const read = readSecret(bytes, ctx.keys);
  if (read.kind === 'undecryptable') {
    return { ...s, flags: s.flags | SIB_UNDECRYPTABLE, vhash: vhashUndecryptable(bytes) };
  }
  const value = read.kind === 'current' ? bytes : encryptSecret(read.plaintext, current, ctx.randomBytes);
  return { ...s, value, flags: readable, vhash: vhashOfSecret(key, read.plaintext, current.kSync) };
}
