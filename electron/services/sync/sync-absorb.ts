/**
 * From a classified S to something mergeable (spec 4.3, 4.4 G2/G3, 4.8 alignEpoch, 4.1 dev
 * collision): absorb S's legacy edits against its own tables under its own epoch (absorbKeys
 * from the ring by S's current epoch; hold rule inputs from side files and the server flag;
 * values recovered from W), G2 for a pre-sync S while W exists (key check, baseline absorb from
 * genesis.conduit, or a synthetic candidate "A copy saved by an older Conduit app"), G3
 * adoption when genesis ids differ (the shared file's genesis wins; W's leftovers queued as a
 * rows candidate), epoch alignment, and the dev-collision guard with re-stamping. Pure over
 * the replica's state except for queueing candidates.
 */

import path from 'node:path';
import { captureLegacy } from './capture-legacy.js';
import { adoptGenesis, baselineAbsorb } from './genesis.js';
import { makeImplicitProvider } from './hashing.js';
import { detectDevCollision, restampOwnSiblings } from './identity.js';
import { alignEpoch, findKeyForVerification, type AlignResult, type FileKeyMeta } from './key-epoch.js';
import { readPresence } from './presence.js';
import { currentEpochId, recoveryFrom } from './state-view.js';
import type { CandidateQueuePort } from './candidate-queue.js';
import { captureSkippedWrites, type ReplicaPort } from './replica.js';
import type { SharedClass, SharedSnapshot } from './shared-file.js';
import { SYNC_LOG_PREFIX, type SyncHost, type SyncPrompt } from './host.js';
import {
  SyncCoreError,
  type CaptureResult,
  type ContentSnapshot,
  type EpochKeys,
  type LegacyAttribution,
  type LoadedFile,
  type SyncState,
} from './types.js';

/** 4.4 G3 step 3 label. */
export const G3_CANDIDATE_LABEL = 'Differences between two copies saved by older Conduit apps';
/** 4.4 G2 step 3 / 4.9 label. */
export const PRESYNC_CANDIDATE_LABEL = 'A copy saved by an older Conduit app';
const COPY_RAND_BYTES = 8;

export interface GenesisBaseline {
  readonly content: ContentSnapshot;
  readonly sha256: string;
}

export interface AbsorbInput {
  readonly replica: ReplicaPort;
  readonly snapshot: SharedSnapshot;
  /** Only 'presync' and 'synced' reach absorb. */
  readonly cls: Extract<SharedClass, { kind: 'presync' | 'synced' }>;
  /** 4.3 rule 2 inputs. */
  readonly sideFilesPresent: boolean;
  readonly serverSideFilesFlagRecent: boolean;
  /** genesis.conduit content when its SHA-256 equals W.genesisId, else null (G2 step 3). */
  readonly baseline: GenesisBaseline | null;
  readonly candidates: Pick<CandidateQueuePort, 'addFile' | 'addRows' | 'list' | 'ensureLoaded'>;
  readonly host: Pick<SyncHost, 'clock' | 'random' | 'logger' | 'fs'>;
}

export type PreparedIncoming =
  /** Merge W with s1 (5.6). `capture` carries notices, held changes and contentRepairNeeded. */
  | {
      readonly kind: 'merge';
      readonly s1: SyncState;
      readonly capture: CaptureResult;
      readonly relation: 'same' | 's-older';
    }
  /**
   * G3: commit with replica.commitWith(w => adoptGenesis(w, s1, implicit).merged.state); the
   * leftovers were already queued as a rows candidate.
   */
  | { readonly kind: 'adopt-genesis'; readonly s1: SyncState; readonly capture: CaptureResult; readonly candidateId: string | null }
  /** G2 without a baseline: nothing to merge; S queued as a candidate; publish W afterwards (content repair). */
  | { readonly kind: 'queued'; readonly candidateId: string }
  /** alignEpoch could not proceed, or G2's key check found a legacy password change. */
  | {
      readonly kind: 'paused';
      readonly reason: 'epoch-newer' | 'epoch-legacy' | 'epoch-concurrent';
      readonly prompt: SyncPrompt;
    };

type Paused = Extract<PreparedIncoming, { kind: 'paused' }>;

const LEGACY_PAUSE: Paused = Object.freeze({
  kind: 'paused',
  reason: 'epoch-legacy',
  prompt: Object.freeze({ kind: 'epoch-legacy', id: 'epoch-legacy' }),
});

function pausedFor(align: Exclude<AlignResult, { kind: 'proceed' }>, s: SyncState): Paused {
  switch (align.kind) {
    case 'pause-newer': {
      const uuid = align.changedByDeviceUuid;
      const name = uuid === null ? null : (readPresence(s, uuid)?.value.name ?? null);
      return {
        kind: 'paused',
        reason: 'epoch-newer',
        prompt: { kind: 'epoch-newer', id: 'epoch-newer', changedByDeviceName: name, changedMs: align.changedMs },
      };
    }
    case 'legacy-change':
      return LEGACY_PAUSE;
    case 'concurrent':
      return {
        kind: 'paused',
        reason: 'epoch-concurrent',
        prompt: { kind: 'epoch-concurrent', id: 'epoch-concurrent', epochIds: align.epochIds },
      };
  }
}

function legacyAttribution(input: AbsorbInput, absorbKeys: EpochKeys, w: SyncState): LegacyAttribution {
  return {
    kind: 'legacy',
    observedMtimeMs: Math.floor(input.snapshot.stat.mtimeMs),
    sideFilesPresent: input.sideFilesPresent,
    serverSideFilesFlagRecent: input.serverSideFilesFlagRecent,
    absorbKeys,
    sourceSha256: input.snapshot.sha256,
    recover: recoveryFrom(w),
  };
}

/** No key for S's epoch: alignEpoch says why (newer, legacy change or concurrent). */
function unreachableEpoch(file: LoadedFile, meta: FileKeyMeta, replica: ReplicaPort): Paused {
  const align = alignEpoch(file.state, meta, replica.state(), replica.ring());
  if (align.kind === 'proceed') throw new SyncCoreError('KEY_MISMATCH', 'no key for the shared file epoch');
  return pausedFor(align, file.state);
}

async function adoptOtherGenesis(input: AbsorbInput, s1: SyncState, capture: CaptureResult): Promise<PreparedIncoming> {
  const { replica } = input;
  const res = adoptGenesis(replica.state(), s1, replica.implicit());
  let candidateId: string | null = null;
  if (res.leftovers.size > 0) {
    const c = await input.candidates.addRows({
      rows: res.leftovers,
      epochId: replica.ring().current.epochId,
      source: 'genesis-leftovers',
      label: G3_CANDIDATE_LABEL,
    });
    candidateId = c.id;
  }
  input.host.logger.info(`${SYNC_LOG_PREFIX} adopting the shared file's genesis`, { leftovers: res.leftovers.size });
  return { kind: 'adopt-genesis', s1, capture, candidateId };
}

async function prepareSynced(input: AbsorbInput, file: LoadedFile, meta: FileKeyMeta): Promise<PreparedIncoming> {
  const { replica } = input;
  const w = replica.state();
  const epoch = currentEpochId(file.state);
  const absorbKeys = epoch === null ? undefined : replica.ring().byEpoch.get(epoch);
  if (absorbKeys === undefined) return unreachableEpoch(file, meta, replica);
  const implicit = makeImplicitProvider(absorbKeys.kSync);
  const capture = captureLegacy(
    { state: file.state, content: file.content, cache: file.cache, implicit },
    legacyAttribution(input, absorbKeys, w),
    replica.context(),
  );
  const align = alignEpoch(capture.state, meta, w, replica.ring());
  if (align.kind !== 'proceed') return pausedFor(align, capture.state);
  if (align.state.genesisId !== w.genesisId) return adoptOtherGenesis(input, align.state, capture);
  return { kind: 'merge', s1: align.state, capture, relation: align.relation };
}

/** G2 step 3: a private copy of S's bytes becomes a synthetic candidate; W publishes afterwards. */
async function queuePresync(input: AbsorbInput): Promise<PreparedIncoming> {
  const { replica, snapshot, host } = input;
  // A blocked publish reads the same S again, in this session or a later one: one candidate per
  // distinct pre-sync file, also before start's housekeeping loaded the queue.
  await input.candidates.ensureLoaded();
  const queued = input.candidates
    .list()
    .find((c) => c.source === 'presync-no-baseline' && c.payload.kind === 'file' && c.payload.sha256 === snapshot.sha256);
  if (queued !== undefined) return { kind: 'queued', candidateId: queued.id };
  await host.fs.mkdir(replica.paths.tmp);
  const copy = path.join(replica.paths.tmp, `presync-${host.random.bytes(COPY_RAND_BYTES).toString('hex')}.conduit`);
  await host.fs.writeFile(copy, snapshot.bytes);
  const c = await input.candidates.addFile({ path: copy, source: 'presync-no-baseline', label: PRESYNC_CANDIDATE_LABEL, staleByNature: true });
  host.logger.info(`${SYNC_LOG_PREFIX} a pre-sync copy was queued for review`, { sha8: snapshot.sha256.slice(0, 8) });
  return { kind: 'queued', candidateId: c.id };
}

function absorbAgainstBaseline(input: AbsorbInput, content: ContentSnapshot, baseline: GenesisBaseline, sKeys: EpochKeys): CaptureResult {
  const { replica, snapshot } = input;
  return baselineAbsorb(
    {
      w: replica.state(),
      baseline: baseline.content,
      s: content,
      sMtimeMs: Math.floor(snapshot.stat.mtimeMs),
      sSha256: snapshot.sha256,
      sKeys,
      sideFilesPresent: input.sideFilesPresent,
      serverSideFilesFlagRecent: input.serverSideFilesFlagRecent,
    },
    replica.context(),
  );
}

/** G2 (4.4): key check, baseline absorb when genesis.conduit matches, else a candidate. */
async function preparePresync(input: AbsorbInput, cls: Extract<AbsorbInput['cls'], { kind: 'presync' }>): Promise<PreparedIncoming> {
  const { replica, baseline } = input;
  const w = replica.state();
  const sKeys = cls.meta.verification === null ? null : findKeyForVerification(replica.ring(), cls.meta.verification);
  if (sKeys === null) return LEGACY_PAUSE;
  if (baseline === null || baseline.sha256 !== w.genesisId) return queuePresync(input);
  let capture: CaptureResult;
  try {
    capture = absorbAgainstBaseline(input, cls.content, baseline, sKeys);
  } catch (err) {
    if (!(err instanceof SyncCoreError) || err.code !== 'KEY_MISMATCH') throw err;
    input.host.logger.info(`${SYNC_LOG_PREFIX} the baseline does not match the pre-sync file; queued for review`);
    return queuePresync(input);
  }
  const align = alignEpoch(capture.state, cls.meta, w, replica.ring());
  if (align.kind !== 'proceed') return pausedFor(align, capture.state);
  // S lacks sync tables: one publish is due however the merge ends (5.6 content repair).
  return { kind: 'merge', s1: align.state, capture: { ...capture, contentRepairNeeded: true }, relation: align.relation };
}

export async function prepareIncoming(input: AbsorbInput): Promise<PreparedIncoming> {
  if (input.cls.kind === 'presync') return preparePresync(input, input.cls);
  return prepareSynced(input, input.cls.file, input.cls.meta);
}

export type CollisionOutcome =
  | { readonly kind: 'none' }
  /** New incarnation started and W re-stamped (replica committed it); report sync.dev_collision. */
  | { readonly kind: 'restamped'; readonly oldDev: number; readonly newDev: number };

const NO_COLLISION: CollisionOutcome = Object.freeze({ kind: 'none' });

/**
 * 4.1 before every merge: identity.detectDevCollision(s1, W, dev); on collision start a new
 * incarnation and commit identity.restampOwnSiblings(W, s1, oldDev, newDot).
 */
export function guardDevCollision(replica: ReplicaPort, s1: SyncState): CollisionOutcome {
  const oldDev = replica.dev();
  if (!detectDevCollision(s1, replica.state(), oldDev).collided) return NO_COLLISION;
  const { newDev } = replica.startNewIncarnation('dev-collision');
  captureSkippedWrites(replica);
  const newDot = replica.tick();
  replica.commit(restampOwnSiblings(replica.state(), s1, oldDev, newDot));
  return { kind: 'restamped', oldDev, newDev };
}
