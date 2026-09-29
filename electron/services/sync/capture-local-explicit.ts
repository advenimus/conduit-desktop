/**
 * Explicit register writes (spec 4.2 step 5, 7.3): prepareWrite builds a consistent LocalWrite
 * (keyed vhash and ciphertext for secrets, JCS for json), applyLocalWrites stamps a batch of
 * them under one dot with rule R, and the `_sync` presence and owner-claim writes.
 */

import { jcs, jcsFromText } from './canonical.js';
import {
  LIFE_LIVE,
  LIFE_REG,
  deviceRegKey,
  isContentTbl,
  isDefaultValue,
  ownerRegKey,
  ownerTagRegKey,
  requireDef,
} from './catalog.js';
import { modeOf } from './capture-local-apply.js';
import { buildResult, newTally, unchangedResult } from './capture-local-result.js';
import { AppWriter, applyAppRuleR, lifeKey, regId } from './capture-local-write.js';
import { vhashOfSecret, vhashOfValue } from './hashing.js';
import { encryptSecret } from './key-epoch.js';
import { isEligible } from './sibling.js';
import { rowKeyStr, rowOf } from './state-view.js';
import type {
  CaptureResult,
  ImplicitProvider,
  LocalAttribution,
  LocalWrite,
  OwnerClaimValue,
  OwnerTagValue,
  PresenceValue,
  RegKey,
  RegisterDef,
  RowKey,
  Sibling,
  SyncContext,
  SyncState,
  SyncValue,
  WriteMode,
} from './types.js';

/** How a write's value is given: a logical value, a secret's plaintext, or an existing sibling to copy. */
export type WriteInput =
  | { readonly value: SyncValue }
  | { readonly plaintext: string | null }
  | { readonly sibling: Sibling };

export interface ApplyWritesOptions {
  /** Apply rule R re-assertions for rows the writes leave live (default true). */
  readonly ruleR?: boolean;
}

function localWrite(key: RegKey, value: SyncValue, vhash: string, mode: WriteMode | undefined): LocalWrite {
  return mode === undefined ? { key, value, vhash } : { key, value, vhash, mode };
}

function normalizeJson(def: RegisterDef, value: SyncValue): SyncValue {
  return def.kind === 'json' && typeof value === 'string' ? jcsFromText(value) ?? value : value;
}

/**
 * Builds a consistent LocalWrite. `{sibling}` copies an existing sibling's value and vhash and
 * is valid only for that sibling's own register (secret vhashes include row_id and reg).
 */
export function prepareWrite(key: RegKey, input: WriteInput, ctx: SyncContext, mode?: WriteMode): LocalWrite {
  const def = requireDef(key);
  if ('sibling' in input) {
    if (!isEligible(input.sibling)) throw new Error('sync write: cannot copy an undecryptable or redacted sibling');
    return localWrite(key, input.sibling.value, input.sibling.vhash, mode);
  }
  if ('plaintext' in input) {
    if (!def.secret) throw new Error(`sync write: plaintext given for non-secret register ${key.reg}`);
    const plain = input.plaintext;
    const value = plain ? encryptSecret(plain, ctx.keys.current, ctx.randomBytes) : null;
    return localWrite(key, value, vhashOfSecret(key, plain, ctx.keys.current.kSync), mode);
  }
  if (def.secret) throw new Error(`sync write: secret register ${key.reg} needs plaintext`);
  const value = normalizeJson(def, input.value);
  return localWrite(key, value, vhashOfValue(key, value), mode);
}

/** `_sync/device/<ctx.deviceUuid>` presence write; its dot is the publish marker (5.3, 6.11). */
export function presenceWrite(value: PresenceValue, ctx: SyncContext): LocalWrite {
  return prepareWrite(deviceRegKey(ctx.deviceUuid), { value: jcs(value) }, ctx, 'replace-all');
}

/** `_sync/owner/owner` claim write (6.7). */
export function ownerClaimWrite(value: OwnerClaimValue, ctx: SyncContext): LocalWrite {
  return prepareWrite(ownerRegKey(), { value: jcs(value) }, ctx, 'replace-all');
}

/** `_sync/owner/account` owner tag write (plan enforcement 3.2). */
export function ownerTagWrite(value: OwnerTagValue, ctx: SyncContext): LocalWrite {
  return prepareWrite(ownerTagRegKey(), { value: jcs(value) }, ctx, 'replace-all');
}

function assertUnique(writes: readonly LocalWrite[]): void {
  const seen = new Set<string>();
  for (const w of writes) {
    const id = regId(w.key);
    if (seen.has(id)) throw new Error(`sync write: register written twice in one operation: ${id}`);
    seen.add(id);
  }
}

/** A register of a row the base state does not know yet stays implicit when written with its default. */
function skipAsDefault(base: SyncState, write: LocalWrite): boolean {
  if (write.key.reg === LIFE_REG || base.rows.has(rowKeyStr(write.key))) return false;
  const def = requireDef(write.key);
  return def.secret ? write.value === null : isDefaultValue(def, write.value);
}

/**
 * Applies explicit writes under one dot (4.2 step 5): each register gets one new app sibling
 * (force-stamped even when equal to the provisional value), replacing siblings per its
 * WriteMode; unknown content rows also get `_life = live`; rule R re-asserts `_life` on the
 * written rows left live, their container chain and live referenced rows.
 */
export function applyLocalWrites(
  state: SyncState,
  writes: readonly LocalWrite[],
  att: LocalAttribution,
  ctx: SyncContext,
  implicit: ImplicitProvider,
  options?: ApplyWritesOptions,
): CaptureResult {
  if (writes.length === 0) return unchangedResult(state);
  assertUnique(writes);
  const w = new AppWriter(state, att.dot, implicit);
  const mode = modeOf(att);
  const touched = new Map<string, RowKey>();
  for (const write of writes) {
    const row = rowOf(write.key);
    if (isContentTbl(row.tbl)) touched.set(rowKeyStr(row), row);
    if (skipAsDefault(state, write)) continue;
    w.write(write.key, write.value, write.vhash, 0, write.mode ?? mode);
  }
  for (const [ks, row] of touched) {
    if (!state.rows.has(ks) && !w.hasWritten(lifeKey(row))) w.writeLife(row, LIFE_LIVE, mode);
  }
  if (options?.ruleR !== false) applyAppRuleR(w, touched.values());
  const tally = newTally();
  tally.appWrites = w.count;
  const { state: next, changedRows } = w.finish(ctx);
  return buildResult(state, next, changedRows, tally);
}
