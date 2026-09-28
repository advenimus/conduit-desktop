/**
 * Key-epoch flows that change W (spec 4.8, 12 rows 15/16/17/59/64): adopting S's newer epoch at
 * unlock or later ("Enter the new password to keep syncing"), linking a missing wrap when the
 * previous key is known ('needs-wrap'), absorbing a legacy password change with or without the
 * old key, and resolving concurrent changes. Built on core key-epoch.ts and rekey.ts exactly as
 * core-e2e-harness.ts SimDevice.enterNewPassword / adoptLegacyPasswordChange do, but committed
 * through the replica (setRing swaps ConduitVault's key).
 * Legacy flows (synced and pre-sync S): sync-epoch-legacy.ts.
 */

import { epochRegKey } from './catalog.js';
import { applyLocalWrites, prepareWrite } from './capture-local.js';
import { captureLegacy } from './capture-legacy.js';
import { deriveEpochKeys, epochIdOf, makeImplicitProvider } from './hashing.js';
import {
  addEpochRecord,
  createWrap,
  decideUnlock,
  epochChangeInfo,
  linkMissingWrap,
  redactSuperseded,
  reencryptState,
  requireCurrentEpoch,
  ringOverStates,
  type FileKeyMeta,
} from './key-epoch.js';
import { merge } from './merge.js';
import { recoveryFrom } from './state-view.js';
import {
  adoptLegacyChange,
  adoptPresyncPasswordChange,
  previousKeyFor,
  recordHeld,
  recordNotices,
  type HoldInputs,
  type NoticeSink,
} from './sync-epoch-legacy.js';
import { captureSkippedWrites, type CommitOutcome, type ReplicaPort } from './replica.js';
import { commitUnderRing } from './ring-commit.js';
import { SYNC_LOG_PREFIX, type SyncHost } from './host.js';
import { SyncCoreError, type EpochKeys, type KeyRing, type LoadedFile, type SyncState, type UnlockDecision } from './types.js';

export { adoptPresyncPasswordChange } from './sync-epoch-legacy.js';
export type { NoticeSink, PresyncChangeInput } from './sync-epoch-legacy.js';

export interface SharedForEpoch {
  readonly file: LoadedFile;
  readonly meta: FileKeyMeta;
  readonly sha256: string;
  readonly mtimeMs: number;
}

export type EpochHost = Pick<SyncHost, 'kdf' | 'random' | 'clock' | 'logger'>;

export interface AdoptAtOpenInput {
  readonly replica: ReplicaPort;
  readonly shared: SharedForEpoch;
  /** decideUnlock's ok decision with via 's-newer' | 'needs-wrap' | 'legacy-change'. */
  readonly decision: Extract<UnlockDecision, { ok: true }>;
  /** The accepted key (the replica was opened with it). */
  readonly key: Buffer;
  /** Key of W's current epoch when the user also entered the previous password, else null. */
  readonly previousKey: Buffer | null;
  /** 4.3 rule 2 inputs for the legacy absorb. */
  readonly sideFilesPresent: boolean;
  readonly serverSideFilesFlagRecent: boolean;
  /** Notices of the absorb (default: straight into local.json). */
  readonly notices?: NoticeSink;
}

function absorbUnder(replica: ReplicaPort, shared: SharedForEpoch, keys: EpochKeys, ring: KeyRing, recoverFrom: SyncState, hold: HoldInputs) {
  const s = shared.file;
  const att = {
    kind: 'legacy',
    observedMtimeMs: Math.floor(shared.mtimeMs),
    sideFilesPresent: hold.sideFilesPresent,
    serverSideFilesFlagRecent: hold.serverSideFilesFlagRecent,
    absorbKeys: keys,
    sourceSha256: shared.sha256,
    recover: recoveryFrom(recoverFrom),
  } as const;
  const implicit = makeImplicitProvider(keys.kSync);
  return captureLegacy({ state: s.state, content: s.content, cache: s.cache, implicit }, att, { ...replica.context(), keys: ring });
}

const NO_HOLD: HoldInputs = { sideFilesPresent: false, serverSideFilesFlagRecent: false };

/** S newer: W re-encrypted up to S's epoch through valid wraps (no new dots), merged with S absorbed. */
function adoptNewer(replica: ReplicaPort, shared: SharedForEpoch, key: Buffer, base: SyncState, hold: HoldInputs, sink?: NoticeSink): CommitOutcome {
  const lineage = replica.lineageId;
  const next = deriveEpochKeys(key, lineage);
  const ring = ringOverStates(next, [shared.file.state, base], lineage);
  if (!ring.byEpoch.has(requireCurrentEpoch(base, 'working'))) {
    throw new SyncCoreError('KEY_MISMATCH', 'the new key does not reach the working epoch');
  }
  const moved = reencryptState(base, ring, next).state;
  const absorbed = absorbUnder(replica, shared, next, ring, moved, hold);
  const merged = merge(moved, absorbed.state, makeImplicitProvider(next.kSync)).state;
  const out = commitUnderRing(replica, ring, key, redactSuperseded(merged, ring));
  recordHeld(replica, absorbed.held);
  recordNotices(replica, absorbed.notices, sink);
  return out;
}

/**
 * Called by open-personal-vault right after openReplica when replica.epochAligned() is false:
 * 's-newer' re-encrypts W up to S's epoch through valid wraps; 'needs-wrap' first adds the
 * missing wrap with `previousKey` (throws KEY_MISMATCH without it); 'legacy-change' runs
 * rekey.absorbLegacyPasswordChange and merges. Redacts superseded epochs, commits, setRing.
 */
export function adoptEpochAtOpen(input: AdoptAtOpenInput, host: EpochHost): CommitOutcome {
  const { replica, shared, decision, key, previousKey } = input;
  const hold = { sideFilesPresent: input.sideFilesPresent, serverSideFilesFlagRecent: input.serverSideFilesFlagRecent };
  host.logger.info(`${SYNC_LOG_PREFIX} adopting the shared file's key epoch`, { via: decision.via });
  captureSkippedWrites(replica);
  if (decision.via === 'legacy-change') {
    return adoptLegacyChange({ replica, shared, newKey: key, previousKey, hold, notices: input.notices }, host);
  }
  if (decision.via !== 's-newer' && decision.via !== 'needs-wrap') {
    throw new SyncCoreError('KEY_MISMATCH', `no epoch to adopt for an unlock via ${decision.via}`);
  }
  let base = replica.state();
  if (decision.via === 'needs-wrap') {
    if (previousKey === null) throw new SyncCoreError('KEY_MISMATCH', 'needs-wrap without the previous key');
    const lineage = replica.lineageId;
    base = linkMissingWrap(base, shared.file.state, deriveEpochKeys(key, lineage), deriveEpochKeys(previousKey, lineage), (n) => host.random.bytes(n));
  }
  return adoptNewer(replica, shared, key, base, hold, input.notices);
}

/** 4.8 S newer, while running: decideUnlock on (W, S) with the typed password, then as adoptEpochAtOpen. */
export function enterNewPassword(
  replica: ReplicaPort,
  shared: SharedForEpoch,
  password: string,
  host: EpochHost,
  notices?: NoticeSink,
  hold: HoldInputs = NO_HOLD,
): UnlockDecision {
  const outcome = decideUnlock({
    lineageId: replica.lineageId,
    deriveFromSalt: (salt) => host.kdf.deriveKey(password, salt),
    w: replica.state(),
    s: { state: shared.file.state, meta: shared.meta },
  });
  const d = outcome.decision;
  if (!d.ok || outcome.key === null) return d;
  if (d.via === 'w-current' || d.via === 'no-w') {
    // This device's own password only opens the epoch S has moved past (4.8 unlock policy).
    const info = epochChangeInfo(shared.file.state);
    return { ok: false, reason: 'superseded', changedByDeviceUuid: info.deviceUuid, changedMs: info.ms };
  }
  const input: AdoptAtOpenInput = {
    replica,
    shared,
    decision: d,
    key: outcome.key,
    // This device is unlocked, so it holds W's key and can add the wrap a keyless absorb could not.
    previousKey: replica.ring().current.kEpoch,
    sideFilesPresent: hold.sideFilesPresent,
    serverSideFilesFlagRecent: hold.serverSideFilesFlagRecent,
    notices,
  };
  adoptEpochAtOpen(input, host);
  return d;
}

export interface LegacyChangeInput {
  readonly replica: ReplicaPort;
  readonly shared: SharedForEpoch;
  readonly newPassword: string;
  /** null: W's unpublished secrets become undecryptable siblings (notice 'undecryptable-secrets'). */
  readonly previousPassword: string | null;
  readonly sideFilesPresent: boolean;
  readonly serverSideFilesFlagRecent: boolean;
  readonly notices?: NoticeSink;
}

/** 4.8 legacy password change (desktop 0.17 changed the password in place). */
export function adoptLegacyPasswordChange(input: LegacyChangeInput, host: EpochHost): CommitOutcome {
  const { replica, shared } = input;
  const salt = shared.meta.salt;
  if (salt === null) throw new SyncCoreError('KEY_MISMATCH', 'the shared file has no salt');
  const newKey = host.kdf.deriveKey(input.newPassword, salt);
  const previousKey = input.previousPassword === null ? null : previousKeyFor(replica, input.previousPassword, host);
  const hold = { sideFilesPresent: input.sideFilesPresent, serverSideFilesFlagRecent: input.serverSideFilesFlagRecent };
  return adoptLegacyChange({ replica, shared, newKey, previousKey, hold, notices: input.notices }, host);
}

/** The pre-sync variant (12 row 64): the previous password, when given, links W's epoch with a wrap. */
export function adoptPresyncLegacyChange(
  replica: ReplicaPort,
  presync: { readonly meta: FileKeyMeta; readonly sha256: string },
  newPassword: string,
  previousPassword: string | null,
  host: EpochHost,
  notices?: NoticeSink,
): CommitOutcome {
  const previousKey = previousPassword === null ? null : previousKeyFor(replica, previousPassword, host);
  return adoptPresyncPasswordChange({ replica, meta: presync.meta, sha256: presync.sha256, newPassword, previousKey, notices }, host);
}

export interface ConcurrentInput {
  readonly replica: ReplicaPort;
  readonly shared: SharedForEpoch;
  readonly otherPassword: string;
  readonly winnerEpochId: string;
  readonly hold?: HoldInputs;
}

function otherBranchKeys(replica: ReplicaPort, shared: SharedForEpoch, otherPassword: string, host: EpochHost) {
  const otherId = requireCurrentEpoch(shared.file.state, 'shared');
  const rec = shared.file.state.epochs.get(otherId);
  if (rec === undefined || rec.salt === null) throw new SyncCoreError('KEY_MISMATCH', 'the other epoch has no salt');
  const key = host.kdf.deriveKey(otherPassword, rec.salt);
  if (epochIdOf(key) !== otherId) throw new SyncCoreError('KEY_MISMATCH', 'the other password does not open the other epoch');
  return { rec, keys: deriveEpochKeys(key, replica.lineageId) };
}

/**
 * 4.8 concurrent changes: derive the other branch's key from its retained salt, verify its key
 * check value, wrap the loser under the winner, re-encrypt everything into the winner, write
 * the epoch register (interactive), commit, setRing. If core lacks a needed primitive, report
 * it instead of approximating.
 */
export function resolveConcurrentEpoch(input: ConcurrentInput, host: EpochHost): CommitOutcome {
  const { replica, shared } = input;
  const lineage = replica.lineageId;
  const own = replica.ring().current;
  const other = otherBranchKeys(replica, shared, input.otherPassword, host);
  captureSkippedWrites(replica);
  if (input.winnerEpochId !== own.epochId && input.winnerEpochId !== other.keys.epochId) {
    throw new SyncCoreError('KEY_MISMATCH', 'the chosen epoch is neither of the two branches');
  }
  const winner = input.winnerEpochId === own.epochId ? own : other.keys;
  const loser = winner === own ? other.keys : own;
  const rand = (n: number): Buffer => host.random.bytes(n);
  const w = addEpochRecord(replica.state(), other.rec, [createWrap(winner, loser, rand)]);
  const ring = ringOverStates(winner, [w, shared.file.state], lineage);
  const absorbed = absorbUnder(replica, shared, other.keys, { current: other.keys, byEpoch: ring.byEpoch }, w, input.hold ?? NO_HOLD);
  const implicit = makeImplicitProvider(winner.kSync);
  const merged = merge(reencryptState(w, ring, winner).state, reencryptState(absorbed.state, ring, winner).state, implicit).state;
  const ctx = { ...replica.context(), keys: ring };
  const write = prepareWrite(epochRegKey(), { value: winner.epochId }, ctx, 'replace-all');
  const res = applyLocalWrites(merged, [write], { kind: 'local', dot: replica.tick(), interactive: true }, ctx, implicit, { ruleR: false });
  const out = commitUnderRing(replica, ring, winner.kEpoch, redactSuperseded(res.state, ring));
  recordHeld(replica, absorbed.held);
  host.logger.info(`${SYNC_LOG_PREFIX} resolved concurrent password changes`, { keptOwn: winner === own });
  return out;
}
