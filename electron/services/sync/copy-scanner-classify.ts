/**
 * Classification of one same-lineage copy (spec 5.8 table, 12 rows 9/42): in use elsewhere
 * (presence or session file_hint names it), nothing new (covered apart from presence, no legacy edits), safe
 * provider copy (only uncovered app dots and a provider conflict name), else needs review.
 * Read-only against the replica's current state. Import through copy-scanner.ts.
 */

import { absorbReplicaCandidate, buildSyntheticCandidate } from './candidates.js';
import { coversIgnoringPresence } from './digest.js';
import { isProviderConflictName } from './file-binding-names.js';
import { listPresence } from './presence.js';
import type { ReplicaPort } from './replica.js';
import type { SharedClass, SharedSnapshot } from './shared-file.js';
import { currentEpochId, recoveryFrom } from './state-view.js';
import { SYNC_LOG_PREFIX, type CopyClassView, type SessionRowView, type SyncLogger } from './host.js';
import { SyncCoreError, type CaptureResult, type ContentSnapshot, type LegacyAttribution, type LoadedFile, type SyncState } from './types.js';

export type CopyClass = CopyClassView;

export interface CopyContribution {
  /** Every sibling the copy adds is an uncovered app sibling and it has no legacy edits. */
  readonly appDotsOnly: boolean;
  readonly legacyEdits: number;
  readonly changedFields: number;
  readonly onlyInCopy: number;
  readonly deletions: number;
  /** No sync tables (always class 4). */
  readonly presync: boolean;
  /** Same lineage, different genesis_id (always class 4). */
  readonly otherGenesis: boolean;
}

export type SameLineageClass = Extract<SharedClass, { readonly kind: 'synced' | 'presync' }>;

/** Everything about a copy that depends only on its bytes and on M (cached per SHA and generation). */
export interface CopyAssessment {
  readonly cls: Exclude<CopyClass, 'in-use-elsewhere'>;
  readonly contribution: CopyContribution;
  readonly providerPattern: boolean;
  /** Absorbed and epoch-aligned replica state, ready to merge (class 3). */
  readonly absorbed: SyncState | null;
}

export interface AssessEnv {
  readonly replica: Pick<ReplicaPort, 'state' | 'ring' | 'context' | 'implicit'>;
  /** Stem of S's own name: provider patterns are conflict copies of S. */
  readonly ownStem: string;
  readonly logger: SyncLogger;
  /** W's content, read lazily (synthetic previews of pre-sync and other-genesis copies). */
  readonly wContent: () => ContentSnapshot;
}

interface Counts {
  readonly changedFields: number;
  readonly onlyInCopy: number;
  readonly deletions: number;
}

const NO_COUNTS: Counts = { changedFields: 0, onlyInCopy: 0, deletions: 0 };

function errCode(err: unknown): string | null {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : null;
}

/** Device names (presence `name`) in a copy's state, for the `<stem>-<HOST>` pattern. */
export function copyHostNames(copy: SyncState): ReadonlySet<string> {
  return new Set(listPresence(copy).map((p) => p.value.name).filter((n) => n !== ''));
}

function legacyCount(capture: CaptureResult): number {
  const s = capture.stats;
  return s.legacyEdits + s.legacyDeletes + s.legacyDropped + s.legacyHeld;
}

function hasLegacyChanges(capture: CaptureResult): boolean {
  return capture.changed || capture.held.length > 0 || capture.contentRepairNeeded || legacyCount(capture) > 0;
}

function contributionOf(counts: Counts, extra: Pick<CopyContribution, 'appDotsOnly' | 'legacyEdits' | 'presync' | 'otherGenesis'>): CopyContribution {
  return { ...counts, ...extra };
}

/** Counts of a synthetic preview (what [Review...] would show) for copies that cannot be absorbed. */
function syntheticCounts(name: string, content: ContentSnapshot, staleByNature: boolean, env: AssessEnv): Counts {
  try {
    const { replica } = env;
    const opts = { source: 'copy' as const, label: name, staleByNature };
    const syn = buildSyntheticCandidate(replica.state(), env.wContent(), content, opts, replica.context(), replica.implicit());
    return {
      changedFields: syn.preview.changedFields.length,
      onlyInCopy: syn.preview.onlyInCopy.length,
      deletions: syn.preview.missingFromCopy.length,
    };
  } catch (err) {
    env.logger.warn(`${SYNC_LOG_PREFIX} copy scanner: previewing a copy failed; counts unknown`, { code: errCode(err), name: (err as Error).name });
    return NO_COUNTS;
  }
}

function needsReviewSynthetic(name: string, content: ContentSnapshot, flags: { presync: boolean; otherGenesis: boolean; pattern: boolean }, env: AssessEnv): CopyAssessment {
  const counts = syntheticCounts(name, content, flags.presync, env);
  const contribution = contributionOf(counts, { appDotsOnly: false, legacyEdits: 0, presync: flags.presync, otherGenesis: flags.otherGenesis });
  return { cls: 'needs-review', contribution, providerPattern: flags.pattern, absorbed: null };
}

function absorbAttribution(snapshot: SharedSnapshot, file: LoadedFile, m: SyncState, env: AssessEnv): LegacyAttribution | null {
  const epochId = currentEpochId(file.state);
  const absorbKeys = epochId === null ? undefined : env.replica.ring().byEpoch.get(epochId);
  if (absorbKeys === undefined) return null;
  return {
    kind: 'legacy',
    observedMtimeMs: snapshot.stat.mtimeMs,
    sideFilesPresent: false,
    serverSideFilesFlagRecent: false,
    absorbKeys,
    sourceSha256: snapshot.sha256,
    recover: recoveryFrom(m),
  };
}

function assessReplica(name: string, snapshot: SharedSnapshot, file: LoadedFile, env: AssessEnv): CopyAssessment {
  const m = env.replica.state();
  const pattern = isProviderConflictName(name, env.ownStem, copyHostNames(file.state));
  const att = absorbAttribution(snapshot, file, m, env);
  const unreachable = (): CopyAssessment => ({
    cls: 'needs-review',
    contribution: contributionOf(NO_COUNTS, { appDotsOnly: false, legacyEdits: 0, presync: false, otherGenesis: false }),
    providerPattern: pattern,
    absorbed: null,
  });
  if (att === null) {
    env.logger.info(`${SYNC_LOG_PREFIX} copy scanner: a copy is under a key epoch this device cannot open`, { sha8: snapshot.sha256.slice(0, 8) });
    return unreachable();
  }
  let res;
  try {
    res = absorbReplicaCandidate(file, m, att, { source: 'copy', label: name }, env.replica.context(), env.replica.implicit());
  } catch (err) {
    if (!(err instanceof SyncCoreError) || err.code !== 'KEY_MISMATCH') throw err;
    env.logger.info(`${SYNC_LOG_PREFIX} copy scanner: a copy needs another password to align`, { sha8: snapshot.sha256.slice(0, 8) });
    return unreachable();
  }
  const legacy = hasLegacyChanges(res.capture);
  const contribution = contributionOf(
    { changedFields: res.preview.changedFields.length, onlyInCopy: res.preview.onlyInCopy.length, deletions: res.preview.deletions.length },
    { appDotsOnly: res.appDotsOnly, legacyEdits: legacyCount(res.capture), presync: false, otherGenesis: false },
  );
  const cls = !legacy && coversIgnoringPresence(m, res.state) ? 'nothing-new' : res.appDotsOnly && pattern ? 'safe-provider-copy' : 'needs-review';
  return { cls, contribution, providerPattern: pattern, absorbed: res.state };
}

/** 5.8 classes 2 to 4 for a same-lineage copy (class 1 is decided per scan from presence and sessions). */
export function assessCopy(name: string, snapshot: SharedSnapshot, cls: SameLineageClass, env: AssessEnv): CopyAssessment {
  if (cls.kind === 'presync') {
    return needsReviewSynthetic(name, cls.content, { presync: true, otherGenesis: false, pattern: isProviderConflictName(name, env.ownStem, new Set()) }, env);
  }
  if (cls.file.state.genesisId !== env.replica.state().genesisId) {
    const pattern = isProviderConflictName(name, env.ownStem, copyHostNames(cls.file.state));
    return needsReviewSynthetic(name, cls.file.content, { presync: false, otherGenesis: true, pattern }, env);
  }
  return assessReplica(name, snapshot, cls.file, env);
}

export interface InUseInput {
  readonly copyName: string;
  /** sync_state.file_id of the copy (null for pre-sync copies). */
  readonly copyFileId: string | null;
  readonly ownFileId: string;
  readonly ownDeviceUuid: string;
  readonly state: SyncState;
  readonly sessions: readonly SessionRowView[];
}

/**
 * 5.8 class 1: another device's presence or session row names this copy (its file_id, when
 * that is not ours, or its file name). Returns that device's name.
 */
export function inUseBy(input: InUseInput): string | null {
  const copyName = input.copyName.toLowerCase();
  const names = (fileId: string | null, fileName: string | null): boolean => {
    if (fileId !== null && fileId === input.ownFileId) return false;
    if (input.copyFileId !== null && fileId === input.copyFileId) return true;
    return fileName !== null && fileName.toLowerCase() === copyName;
  };
  for (const p of listPresence(input.state)) {
    const hint = p.value.file_hint;
    if (p.deviceUuid !== input.ownDeviceUuid && hint !== null && names(hint.file_id, hint.file_name)) return p.value.name;
  }
  for (const row of input.sessions) {
    if (row.deviceId !== input.ownDeviceUuid && names(row.fileId, row.fileName)) return row.deviceName;
  }
  return null;
}
