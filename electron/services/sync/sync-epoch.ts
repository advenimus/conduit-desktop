/**
 * Key-epoch flows that change W (spec 4.8, 12 rows 15/16/17/59/64): adopting S's newer epoch at
 * unlock or later ("Enter the new password to keep syncing"), linking a missing wrap when the
 * previous key is known ('needs-wrap'), absorbing a legacy password change with or without the
 * old key, and resolving concurrent changes. Built on core key-epoch.ts and rekey.ts exactly as
 * core-e2e-harness.ts SimDevice.enterNewPassword / adoptLegacyPasswordChange do, but committed
 * through the replica (setRing swaps ConduitVault's key) after the 5.10 pre-merge snapshot
 * (sync-epoch-commit.ts), so a mass delete that arrives with a password change can be undone.
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
  adoptPresyncPasswordChange,
  localNoticeLog,
  planLegacyChange,
  previousKeyFor,
  recordHeld,
  recordNotices,
  type HoldInputs,
  type NoticeSink,
} from './sync-epoch-legacy.js';
import { commitEpochPlan, type EpochPlan, type EpochSnapshotPorts } from './sync-epoch-commit.js';
import { captureSkippedWrites, type CommitOutcome, type ReplicaPort } from './replica.js';
import type { SnapshotStorePort } from './snapshots.js';
import { SYNC_LOG_PREFIX, type SyncHost } from './host.js';
import { SyncCoreError, type EpochKeys, type KeyRing, type LoadedFile, type SyncState, type UnlockDecision } from './types.js';

export { adoptPresyncPasswordChange } from './sync-epoch-legacy.js';
export type { NoticeSink, PresyncChangeInput } from './sync-epoch-legacy.js';
export type { EpochSnapshotPorts } from './sync-epoch-commit.js';

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
  /** Where the 5.10 pre-merge snapshot goes (snapshots/ of this lineage). */
  readonly snapshots: Pick<SnapshotStorePort, 'take' | 'list'>;
  /** Notices of the absorb and the 'mass-change' notice (default: straight into local.json). */
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
function planNewer(replica: ReplicaPort, shared: SharedForEpoch, key: Buffer, base: SyncState, hold: HoldInputs, sink: NoticeSink): EpochPlan {
  const lineage = replica.lineageId;
  const next = deriveEpochKeys(key, lineage);
  const ring = ringOverStates(next, [shared.file.state, base], lineage);
  if (!ring.byEpoch.has(requireCurrentEpoch(base, 'working'))) {
    throw new SyncCoreError('KEY_MISMATCH', 'the new key does not reach the working epoch');
  }
  const moved = reencryptState(base, ring, next).state;
  const absorbed = absorbUnder(replica, shared, next, ring, moved, hold);
  const merged = merge(moved, absorbed.state, makeImplicitProvider(next.kSync)).state;
  const after = (): void => {
    recordHeld(replica, absorbed.held);
    recordNotices(replica, absorbed.notices, sink);
  };
  return { before: moved, next: redactSuperseded(merged, ring), ring, key, after };
}

/** 'needs-wrap' adds the missing wrap with the previous key; 's-newer' uses W as it is. */
function linkerFor(input: AdoptAtOpenInput, via: 's-newer' | 'needs-wrap', host: EpochHost): (w: SyncState) => SyncState {
  if (via === 's-newer') return (w) => w;
  const { previousKey, key, replica, shared } = input;
  if (previousKey === null) throw new SyncCoreError('KEY_MISMATCH', 'needs-wrap without the previous key');
  const next = deriveEpochKeys(key, replica.lineageId);
  const prev = deriveEpochKeys(previousKey, replica.lineageId);
  return (w) => linkMissingWrap(w, shared.file.state, next, prev, (n) => host.random.bytes(n));
}

/**
 * Called by open-personal-vault right after openReplica when replica.epochAligned() is false:
 * 's-newer' re-encrypts W up to S's epoch through valid wraps; 'needs-wrap' first adds the
 * missing wrap with `previousKey` (throws KEY_MISMATCH without it); 'legacy-change' runs
 * rekey.absorbLegacyPasswordChange and merges. Redacts superseded epochs, takes the pre-merge
 * snapshot when the merge is a mass change, commits, setRing.
 */
export async function adoptEpochAtOpen(input: AdoptAtOpenInput, host: EpochHost): Promise<CommitOutcome> {
  const { replica, shared, decision, key, previousKey } = input;
  const hold = { sideFilesPresent: input.sideFilesPresent, serverSideFilesFlagRecent: input.serverSideFilesFlagRecent };
  const notices = input.notices ?? localNoticeLog(replica);
  const ports: EpochSnapshotPorts = { snapshots: input.snapshots, notices };
  host.logger.info(`${SYNC_LOG_PREFIX} adopting the shared file's key epoch`, { via: decision.via });
  if (decision.via === 'legacy-change') {
    const legacy = { replica, shared, newKey: key, previousKey, hold, notices };
    return commitEpochPlan(replica, ports, host, shared.sha256, () => planLegacyChange(legacy, host));
  }
  if (decision.via !== 's-newer' && decision.via !== 'needs-wrap') {
    throw new SyncCoreError('KEY_MISMATCH', `no epoch to adopt for an unlock via ${decision.via}`);
  }
  const link = linkerFor(input, decision.via, host);
  return commitEpochPlan(replica, ports, host, shared.sha256, () => {
    captureSkippedWrites(replica);
    return planNewer(replica, shared, key, link(replica.state()), hold, notices);
  });
}

/** 4.8 S newer, while running: decideUnlock on (W, S) with the typed password, then as adoptEpochAtOpen. */
export async function enterNewPassword(
  replica: ReplicaPort,
  shared: SharedForEpoch,
  password: string,
  host: EpochHost,
  ports: EpochSnapshotPorts,
  hold: HoldInputs = NO_HOLD,
): Promise<UnlockDecision> {
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
    snapshots: ports.snapshots,
    notices: ports.notices,
  };
  await adoptEpochAtOpen(input, host);
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
  readonly ports: EpochSnapshotPorts;
}

/** 4.8 legacy password change (desktop 0.17 changed the password in place). */
export async function adoptLegacyPasswordChange(input: LegacyChangeInput, host: EpochHost): Promise<CommitOutcome> {
  const { replica, shared, ports } = input;
  const salt = shared.meta.salt;
  if (salt === null) throw new SyncCoreError('KEY_MISMATCH', 'the shared file has no salt');
  const newKey = host.kdf.deriveKey(input.newPassword, salt);
  const previousKey = input.previousPassword === null ? null : previousKeyFor(replica, input.previousPassword, host);
  const hold = { sideFilesPresent: input.sideFilesPresent, serverSideFilesFlagRecent: input.serverSideFilesFlagRecent };
  const legacy = { replica, shared, newKey, previousKey, hold, notices: ports.notices };
  return commitEpochPlan(replica, ports, host, shared.sha256, () => planLegacyChange(legacy, host));
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
  readonly ports: EpochSnapshotPorts;
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

type OtherBranch = ReturnType<typeof otherBranchKeys>;

function planConcurrent(input: ConcurrentInput, other: OtherBranch, host: EpochHost): EpochPlan {
  const { replica, shared } = input;
  const own = replica.ring().current;
  captureSkippedWrites(replica);
  const winner = input.winnerEpochId === own.epochId ? own : other.keys;
  const loser = winner === own ? other.keys : own;
  const rand = (n: number): Buffer => host.random.bytes(n);
  const w = addEpochRecord(replica.state(), other.rec, [createWrap(winner, loser, rand)]);
  const ring = ringOverStates(winner, [w, shared.file.state], replica.lineageId);
  const absorbed = absorbUnder(replica, shared, other.keys, { current: other.keys, byEpoch: ring.byEpoch }, w, input.hold ?? NO_HOLD);
  const implicit = makeImplicitProvider(winner.kSync);
  const moved = reencryptState(w, ring, winner).state;
  const merged = merge(moved, reencryptState(absorbed.state, ring, winner).state, implicit).state;
  const ctx = { ...replica.context(), keys: ring };
  const write = prepareWrite(epochRegKey(), { value: winner.epochId }, ctx, 'replace-all');
  const res = applyLocalWrites(merged, [write], { kind: 'local', dot: replica.tick(), interactive: true }, ctx, implicit, { ruleR: false });
  const after = (): void => {
    recordHeld(replica, absorbed.held);
    host.logger.info(`${SYNC_LOG_PREFIX} resolved concurrent password changes`, { keptOwn: winner === own });
  };
  return { before: moved, next: redactSuperseded(res.state, ring), ring, key: winner.kEpoch, after };
}

/**
 * 4.8 concurrent changes: derive the other branch's key from its retained salt, verify its key
 * check value, wrap the loser under the winner, re-encrypt everything into the winner, write
 * the epoch register (interactive), take the pre-merge snapshot when the merge is a mass
 * change, commit, setRing. If core lacks a needed primitive, report it instead of approximating.
 */
export async function resolveConcurrentEpoch(input: ConcurrentInput, host: EpochHost): Promise<CommitOutcome> {
  const { replica, shared } = input;
  const own = replica.ring().current;
  const other = otherBranchKeys(replica, shared, input.otherPassword, host);
  if (input.winnerEpochId !== own.epochId && input.winnerEpochId !== other.keys.epochId) {
    throw new SyncCoreError('KEY_MISMATCH', 'the chosen epoch is neither of the two branches');
  }
  return commitEpochPlan(replica, input.ports, host, shared.sha256, () => planConcurrent(input, other, host));
}
