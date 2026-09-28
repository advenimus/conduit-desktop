/**
 * Legacy password change (spec 4.8): desktop 0.17 or older changed the master password, so
 * S's vault_meta salt and verification no longer match its recorded epoch E1. Every device
 * builds the same epoch E2 (epoch_id = KCV(K2), parent E1) and absorbs S under E2 (pids use
 * E2's K_pid, so all devices mint the same pseudo siblings). With the old key the absorb is
 * precise and the wrap (E2, E1) is added; without it, secrets still under E1 become
 * undecryptable siblings. Nothing is dropped. Import through rekey.ts.
 */

import { epochRegKey } from './catalog.js';
import { captureLegacy, legacyDeleteTime } from './capture-legacy.js';
import { withoutSeenValue } from './capture-local-write.js';
import { baseRefOf, deriveEpochKeys, makeImplicitProvider, pidOf, vhashOfValue, vrefPlain } from './hashing.js';
import {
  addEpochRecord,
  createWrap,
  makeEpochRecord,
  redactSuperseded,
  reencryptState,
  requireCurrentEpoch,
  ringOverStates,
  verifyKey,
} from './key-epoch.js';
import { identityKey, isUndecryptable, makePmem, pmemCovers, pmemJoin, vvCovers } from './sibling.js';
import { StateBuilder, getRegister, makeRegister, pmemOf, provisional, recoveryFrom, sibsOf } from './state-view.js';
import { PSEUDO_DEV, SyncCoreError } from './types.js';
import type {
  CaptureResult,
  ContentSnapshot,
  EpochKeys,
  ImplicitProvider,
  KeyRing,
  LegacyAttribution,
  LoadedFile,
  RegKey,
  Sibling,
  SyncContext,
  SyncState,
  ValueRecovery,
} from './types.js';

const META_SALT = 'salt';
const META_VERIFICATION = 'verification';

export interface LegacyPasswordChangeInput {
  /** S after a legacy password change: vault_meta salt/verification no longer match its recorded epoch. */
  readonly s: LoadedFile;
  readonly w: SyncState;
  /** PBKDF2(new password, S's vault_meta salt); verified again here against S's verification token. */
  readonly newKey: Buffer;
  /** W's ring when this device still holds the old key (unlocked, or old password entered). */
  readonly oldRing: KeyRing | null;
  readonly observedMtimeMs: number;
  readonly sourceSha256: string;
  /** Hold rule inputs (4.3 rule 2); default false. */
  readonly sideFilesPresent?: boolean;
  readonly serverSideFilesFlagRecent?: boolean;
  /** Value recovery for kept siblings (4.3); default recoveryFrom(w). */
  readonly recover?: ValueRecovery;
}

export interface LegacyPasswordChangeResult {
  /** S absorbed under the new epoch (pseudo dot on the epoch register). */
  readonly s1: SyncState;
  /** W moved to the new epoch; its unreadable secrets flagged undecryptable when no old key. */
  readonly w: SyncState;
  /** E2 current plus every epoch reachable through valid wraps of s1 and w. */
  readonly ring: KeyRing;
  /** Undecryptable secret siblings expected to survive merge(w, s1) (for the notice count). */
  readonly undecryptable: number;
  /** The legacy capture of S: notices, held changes and contentRepairNeeded for local.json. */
  readonly capture: CaptureResult;
}

interface KeyMeta {
  readonly salt: string;
  readonly verification: string;
}

function requireKeyMeta(content: ContentSnapshot): KeyMeta {
  const salt = content.meta.get(META_SALT);
  const verification = content.meta.get(META_VERIFICATION);
  if (!salt || !verification) {
    throw new SyncCoreError('CORRUPT_STATE', 'the absorbed file has no vault_meta salt or verification');
  }
  return { salt, verification };
}

/** E2 current; every key this device already holds stays usable for decryption. */
function workingRing(e2: EpochKeys, oldRing: KeyRing | null): KeyRing {
  const byEpoch = new Map<string, EpochKeys>([[e2.epochId, e2]]);
  for (const [id, keys] of oldRing?.byEpoch ?? []) {
    if (!byEpoch.has(id)) byEpoch.set(id, keys);
  }
  return { current: e2, byEpoch };
}

function attribution(input: LegacyPasswordChangeInput, e2: EpochKeys): LegacyAttribution {
  return {
    kind: 'legacy',
    observedMtimeMs: input.observedMtimeMs,
    sideFilesPresent: input.sideFilesPresent ?? false,
    serverSideFilesFlagRecent: input.serverSideFilesFlagRecent ?? false,
    absorbKeys: e2,
    sourceSha256: input.sourceSha256,
    recover: input.recover ?? recoveryFrom(input.w),
  };
}

/** Rowless legacy write of `_sync/key/epoch` = E2 (4.3 rule 4: replaces w, siblings holding w's value, every pseudo sibling). */
function writeEpochPseudo(state: SyncState, e2: EpochKeys, ms: number, implicit: ImplicitProvider): SyncState {
  const key = epochRegKey();
  const sibs = sibsOf(state, key, implicit);
  const w = provisional(key.reg, sibs);
  const pid = pidOf(key, vrefPlain(key, e2.epochId), baseRefOf(w), e2.kPid);
  const p: Sibling = {
    dev: PSEUDO_DEV,
    ms,
    c: 0,
    pid,
    lt: ms,
    vhash: vhashOfValue(key, e2.epochId),
    flags: 0,
    value: e2.epochId,
    prevVhash: null,
  };
  const kept = withoutSeenValue(sibs, w).filter((s) => s.dev !== PSEUDO_DEV);
  const b = new StateBuilder(state);
  b.setRegister(makeRegister(key, [...kept, p], pmemJoin(pmemOf(state, key), makePmem(ms, [pid]))));
  return b.build();
}

/** merge() keeps a sibling of `from` when `other` carries its identity or has not covered it. */
function survives(other: SyncState, key: RegKey, s: Sibling, otherIds: ReadonlySet<string>): boolean {
  if (otherIds.has(identityKey(s))) return true;
  return s.dev === PSEUDO_DEV ? !pmemCovers(pmemOf(other, key), s) : !vvCovers(other.vv, s.dev, s);
}

function countSurvivors(from: SyncState, other: SyncState, skipShared: boolean): number {
  let n = 0;
  for (const row of from.rows.values()) {
    for (const reg of row.regs.values()) {
      if (!reg.sibs.some(isUndecryptable)) continue;
      const otherIds = new Set((getRegister(other, reg.key)?.sibs ?? []).map(identityKey));
      for (const s of reg.sibs) {
        if (!isUndecryptable(s) || (skipShared && otherIds.has(identityKey(s)))) continue;
        if (survives(other, reg.key, s, otherIds)) n++;
      }
    }
  }
  return n;
}

function survivingUndecryptable(s1: SyncState, w: SyncState): number {
  return countSurvivors(s1, w, false) + countSurvivors(w, s1, true);
}

function requireNewKey(input: LegacyPasswordChangeInput, meta: KeyMeta, e1Id: string): EpochKeys {
  if (input.s.state.lineageId !== input.w.lineageId) {
    throw new SyncCoreError('MERGE_PRECONDITION', 'the absorbed file belongs to another lineage');
  }
  if (!verifyKey(input.newKey, meta.verification)) {
    throw new SyncCoreError('KEY_MISMATCH', 'the new key does not open the file verification token');
  }
  const e2 = deriveEpochKeys(input.newKey, input.w.lineageId);
  if (e2.epochId === e1Id) throw new SyncCoreError('KEY_MISMATCH', 'the file key did not change');
  return e2;
}

/**
 * Legacy password change flow (4.8). With the old key (oldRing reaches S's recorded epoch):
 * S's trustworthy secret siblings are re-keyed to E2 before the capture, so only real edits
 * become pseudo siblings. Without it: non-secret registers are absorbed precisely, each secret
 * register the legacy app wrote gets a pseudo sibling from S's plaintext under E2, and every
 * sibling still under E1 (in S and in W) becomes undecryptable.
 */
export function absorbLegacyPasswordChange(input: LegacyPasswordChangeInput, ctx: SyncContext): LegacyPasswordChangeResult {
  const sState = input.s.state;
  const e1Id = requireCurrentEpoch(sState, 'absorbed');
  const meta = requireKeyMeta(input.s.content);
  const e2 = requireNewKey(input, meta, e1Id);
  const e1 = input.oldRing?.byEpoch.get(e1Id) ?? null;
  const work = workingRing(e2, input.oldRing);
  const rand = { randomBytes: ctx.randomBytes };

  const epochMs = legacyDeleteTime(pmemOf(sState, epochRegKey())?.ms ?? null, input.observedMtimeMs, ctx.now());
  const record = makeEpochRecord(e2, e1Id, meta.salt, meta.verification, epochMs);
  const wraps = e1 ? [createWrap(e2, e1, ctx.randomBytes)] : [];
  const sKeyed = addEpochRecord(sState, record, wraps);
  const pre = e1 ? reencryptState(sKeyed, work, e2, { ...rand, markUnreadable: false, verifyWith: e1 }).state : sKeyed;

  const implicit = makeImplicitProvider(e2.kSync);
  const capture = captureLegacy(
    { state: pre, content: input.s.content, cache: input.s.cache, implicit },
    attribution(input, e2),
    { ...ctx, keys: work },
  );
  const post = reencryptState(writeEpochPseudo(capture.state, e2, epochMs, implicit), work, e2, rand).state;
  const w = reencryptState(addEpochRecord(input.w, record, wraps), work, e2, rand).state;
  const ring = ringOverStates(e2, [post, w], input.w.lineageId);
  const s1 = redactSuperseded(post, ring);
  return { s1, w, ring, undecryptable: survivingUndecryptable(s1, w), capture };
}
