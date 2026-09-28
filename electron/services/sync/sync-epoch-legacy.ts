/**
 * Legacy password changes (spec 4.8, 12 rows 16/64): desktop 0.17 changed the master password
 * in place. On a synced S, rekey.absorbLegacyPasswordChange absorbs S under the new epoch
 * (precisely with the old key, with undecryptable siblings without it). On a pre-sync S (the
 * change happened before this device's first publish, G2 key check), W itself joins the new
 * epoch (epoch_id = KCV(new key), parent = W's epoch, the wrap when the old key is known) and
 * the next cycle absorbs S's content as G2 under that epoch. Held changes and notices go to
 * local.json. Import through sync-epoch.ts.
 */

import { epochRegKey } from './catalog.js';
import { applyLocalWrites, prepareWrite } from './capture-local.js';
import { makeNotice } from './capture-local-result.js';
import { deriveEpochKeys, epochIdOf, makeImplicitProvider } from './hashing.js';
import {
  addEpochRecord,
  buildKeyRing,
  createWrap,
  makeEpochRecord,
  redactSuperseded,
  reencryptState,
  requireCurrentEpoch,
  ringOverStates,
  verifyKey,
  type FileKeyMeta,
} from './key-epoch.js';
import { merge } from './merge.js';
import { capNewest, noticeDedupeKey, type NoticesPort } from './notices.js';
import { absorbLegacyPasswordChange } from './rekey.js';
import { isUndecryptable } from './sibling.js';
import { regKeyStr } from './state-view.js';
import { captureSkippedWrites, type CommitOutcome, type ReplicaPort } from './replica.js';
import { commitUnderRing } from './ring-commit.js';
import type { SharedForEpoch, EpochHost } from './sync-epoch.js';
import { SYNC_LOG_PREFIX } from './host.js';
import { SyncCoreError, type EpochKeys, type HeldLegacyChange, type KeyRing, type LocalNotice, type SyncState } from './types.js';

export interface HoldInputs {
  readonly sideFilesPresent: boolean;
  readonly serverSideFilesFlagRecent: boolean;
}

/** Where epoch flows put their notices: the engine's notices port, or local.json directly at open. */
export type NoticeSink = Pick<NoticesPort, 'addFromCapture'>;

function heldId(h: HeldLegacyChange): string {
  const s = h.sibling;
  return `${regKeyStr(h.key)}|${s.dev}:${s.ms}:${s.c}:${s.pid}`;
}

/** 4.3 held changes of an epoch flow's legacy absorb, appended to local.json (deduplicated). */
export function recordHeld(replica: ReplicaPort, held: readonly HeldLegacyChange[]): void {
  if (held.length === 0) return;
  replica.updateLocal((l) => {
    const seen = new Set(l.heldLegacy.map(heldId));
    const fresh = held.filter((h) => !seen.has(heldId(h)));
    return fresh.length === 0 ? l : { ...l, heldLegacy: [...l.heldLegacy, ...fresh] };
  });
}

/** Persists notices through `sink`, or straight into local.json (same dedupe and cap) when there is none yet. */
export function recordNotices(replica: ReplicaPort, notices: readonly LocalNotice[], sink: NoticeSink | undefined): void {
  if (notices.length === 0) return;
  if (sink !== undefined) {
    sink.addFromCapture(notices);
    return;
  }
  replica.updateLocal((l) => {
    const seen = new Set(l.notices.map(noticeDedupeKey));
    const fresh = notices.filter((n) => {
      const key = noticeDedupeKey(n);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return fresh.length === 0 ? l : { ...l, notices: capNewest([...l.notices, ...fresh]) };
  });
}

export interface LegacyAdoptInput {
  readonly replica: ReplicaPort;
  readonly shared: SharedForEpoch;
  /** The key derived from the new password and S's vault_meta salt. */
  readonly newKey: Buffer;
  /** Key of W's current epoch when known, else null (W's unreadable secrets become undecryptable). */
  readonly previousKey: Buffer | null;
  readonly hold: HoldInputs;
  readonly notices?: NoticeSink;
}

/** 4.8 legacy change on a synced S: absorb under the new epoch, merge with W moved to it, commit. */
export function adoptLegacyChange(input: LegacyAdoptInput, host: EpochHost): CommitOutcome {
  const { replica, shared, newKey, previousKey, hold } = input;
  const lineage = replica.lineageId;
  captureSkippedWrites(replica);
  const w = replica.state();
  const oldRing = previousKey === null ? null : buildKeyRing(w, deriveEpochKeys(previousKey, lineage), lineage);
  const res = absorbLegacyPasswordChange(
    {
      s: shared.file,
      w,
      newKey,
      oldRing,
      observedMtimeMs: Math.floor(shared.mtimeMs),
      sourceSha256: shared.sha256,
      sideFilesPresent: hold.sideFilesPresent,
      serverSideFilesFlagRecent: hold.serverSideFilesFlagRecent,
    },
    replica.context(),
  );
  const out = commitUnderRing(replica, res.ring, newKey, merge(res.w, res.s1, makeImplicitProvider(res.ring.current.kSync)).state);
  recordHeld(replica, res.capture.held);
  const count = res.undecryptable > 0 ? [makeNotice('undecryptable-secrets', null, res.undecryptable, shared.sha256, host.clock.now())] : [];
  recordNotices(replica, [...count, ...res.capture.notices], input.notices);
  host.logger.info(`${SYNC_LOG_PREFIX} adopted a password change made by an older Conduit`, {
    withOldKey: previousKey !== null,
    undecryptable: res.undecryptable,
  });
  return out;
}

/** W's key checked against its current epoch record (the typed previous password). */
export function previousKeyFor(replica: ReplicaPort, previousPassword: string, host: EpochHost): Buffer {
  const epochId = replica.ring().current.epochId;
  const rec = replica.state().epochs.get(epochId);
  if (rec === undefined || rec.salt === null) throw new SyncCoreError('KEY_MISMATCH', 'the working epoch has no salt');
  const key = host.kdf.deriveKey(previousPassword, rec.salt);
  if (epochIdOf(key) !== epochId) throw new SyncCoreError('KEY_MISMATCH', 'the previous password does not open this device');
  return key;
}

export interface PresyncChangeInput {
  readonly replica: ReplicaPort;
  /** S's vault_meta salt and verification (pre-sync: no sync tables). */
  readonly meta: FileKeyMeta;
  readonly sha256: string;
  readonly newPassword: string;
  /** Key of W's current epoch when known, else null. */
  readonly previousKey: Buffer | null;
  readonly notices?: NoticeSink;
}

function requireMeta(meta: FileKeyMeta): { readonly salt: string; readonly verification: string } {
  if (meta.salt === null || meta.verification === null) {
    throw new SyncCoreError('KEY_MISMATCH', 'the shared file has no salt or verification');
  }
  return { salt: meta.salt, verification: meta.verification };
}

function countUndecryptable(state: SyncState): number {
  let n = 0;
  for (const row of state.rows.values()) {
    for (const reg of row.regs.values()) n += reg.sibs.filter(isUndecryptable).length;
  }
  return n;
}

function workRing(e2: EpochKeys, old: EpochKeys | null): KeyRing {
  const byEpoch = new Map<string, EpochKeys>([[e2.epochId, e2]]);
  if (old !== null) byEpoch.set(old.epochId, old);
  return { current: e2, byEpoch };
}

/** `_sync/key/epoch` = E2 under one interactive dot (it supersedes W's epoch everywhere). */
function writeEpochRegister(replica: ReplicaPort, state: SyncState, e2: EpochKeys, ring: KeyRing): SyncState {
  const ctx = { ...replica.context(), keys: ring };
  const write = prepareWrite(epochRegKey(), { value: e2.epochId }, ctx, 'replace-all');
  const att = { kind: 'local', dot: replica.tick(), interactive: true } as const;
  return applyLocalWrites(state, [write], att, ctx, makeImplicitProvider(e2.kSync), { ruleR: false }).state;
}

/**
 * 12 row 64: 0.17 changed the password before this device's first publish (S is pre-sync).
 * W joins the new epoch; S's content is then absorbed by the next cycle (G2: baseline absorb,
 * or a candidate "A copy saved by an older Conduit app"), and W publishes under the new salt.
 */
export function adoptPresyncPasswordChange(input: PresyncChangeInput, host: EpochHost): CommitOutcome {
  const { replica } = input;
  const lineage = replica.lineageId;
  const meta = requireMeta(input.meta);
  const newKey = host.kdf.deriveKey(input.newPassword, meta.salt);
  if (!verifyKey(newKey, meta.verification)) throw new SyncCoreError('KEY_MISMATCH', 'the new password does not open the shared file');
  const e2 = deriveEpochKeys(newKey, lineage);
  captureSkippedWrites(replica);
  const w = replica.state();
  const e1Id = requireCurrentEpoch(w, 'working');
  if (e2.epochId === e1Id) return replica.commitWith((cur) => cur);
  const e1 = input.previousKey === null ? null : deriveEpochKeys(input.previousKey, lineage);
  if (e1 !== null && e1.epochId !== e1Id) throw new SyncCoreError('KEY_MISMATCH', 'the previous key does not open this device');
  const rand = (n: number): Buffer => host.random.bytes(n);
  const record = makeEpochRecord(e2, e1Id, meta.salt, meta.verification, host.clock.now());
  const keyed = addEpochRecord(w, record, e1 === null ? [] : [createWrap(e2, e1, rand)]);
  const moved = reencryptState(keyed, workRing(e2, e1), e2, { randomBytes: rand }).state;
  const written = writeEpochRegister(replica, moved, e2, workRing(e2, e1));
  const ring = ringOverStates(e2, [written], lineage);
  const next = redactSuperseded(written, ring);
  const out = commitUnderRing(replica, ring, newKey, next);
  const unreadable = countUndecryptable(next) - countUndecryptable(w);
  if (unreadable > 0) {
    recordNotices(replica, [makeNotice('undecryptable-secrets', null, unreadable, input.sha256, host.clock.now())], input.notices);
  }
  host.logger.info(`${SYNC_LOG_PREFIX} joined the password change found in a pre-sync shared file`, { withOldKey: e1 !== null });
  return out;
}
