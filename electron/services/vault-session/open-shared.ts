/**
 * Steps 5 and 6 of the unlock sequence for a shared vault (spec 6.3, 4.4 G1 and its wait,
 * 4.3 rule 2 at adoption, 4.8 epoch adoption at open, 7.3 variants): acquire, choose the seed
 * of W (existing, adopt a synced S, or genesis on a pre-sync S after the G1 wait), open the
 * replica, adopt S's newer key epoch before anything else runs, then hand over to
 * open-start.ts. Every failure from the acquire on rolls back (replica closed, lease
 * released) before rethrowing.
 */

import { SESSION_LOG_PREFIX } from '../sync/host.js';
import type { ReplicaPort, ReplicaSeed } from '../sync/replica.js';
import { SnapshotStore } from '../sync/snapshots.js';
import type { SessionRowView } from '../sync/host.js';
import type { FileBinding } from '../sync/types.js';
import { Rollback } from './open-async.js';
import { planBinding, type BindingPlan } from './open-binding.js';
import type { OpenContext } from './open-deps.js';
import { parkDamagedWorkingCopy } from './open-damaged.js';
import { OPEN_CANCELLED_MESSAGE } from './open-errors.js';
import { acquireLease } from './open-gate.js';
import type { VaultLocation } from './open-location.js';
import { verifySharedPassword, type AcceptedUnlock } from './open-password.js';
import { readSharedView, type SharedPeek, type SharedView, type SyncedView } from './open-peek.js';
import type { OpenedPersonalVault } from './open-personal-vault.js';
import { errCode } from './open-staging.js';
import { startSharedSession } from './open-start.js';
import type { AcquireResult } from './session-client.js';
import type { SharedProbe } from './stale-wait.js';
import type { TicketSource } from './own-copy-tickets.js';
import { sideFilesFlagRecent } from './session-runtime-parts.js';

const SIDE_FILE_SUFFIXES = ['-wal', '-shm'] as const;

interface Seeded {
  readonly seed: ReplicaSeed;
  readonly unlock: AcceptedUnlock;
  /** The S the seed and the epoch adoption use (the re-read one after a G1 wait). */
  readonly s: SharedView;
  readonly toStore: FileBinding | null;
}

export async function openSharedVault(
  ctx: OpenContext,
  loc: VaultLocation,
  peek: SharedPeek,
  unlock: AcceptedUnlock,
): Promise<OpenedPersonalVault> {
  const rollback = new Rollback(ctx.host.logger);
  try {
    if (peek.damagedW) await parkDamagedWorkingCopy(ctx, peek.lineageId);
    const plan = await planBinding(ctx, loc, peek);
    const source: TicketSource = peek.hasW
      ? { kind: 'working', lineageId: peek.lineageId, sharedPath: ctx.sharedPath }
      : { kind: 'shared', path: ctx.sharedPath };
    const keys = unlock.previousKey === null ? [unlock.key] : [unlock.key, unlock.previousKey];
    const acquire = await acquireLease(ctx, loc, peek.lineageId, plan.binding.fileId, rollback, { source, keys });
    const seeded = await chooseSeed(ctx, peek, unlock, acquire, plan);
    const opened = await ctx.c.openReplica(
      {
        syncRoot: ctx.config.syncRoot,
        machineDir: ctx.config.machineDir,
        deviceUuid: ctx.config.deviceUuid,
        lineageId: peek.lineageId,
        key: seeded.unlock.key,
        seed: seeded.seed,
        binding: seeded.toStore,
      },
      ctx.replicaDeps,
    );
    rollback.push('close replica', () => opened.replica.close());
    await alignEpochAtOpen(ctx, opened.replica, seeded, acquire);
    const st = {
      replica: opened.replica,
      notices: opened.notices,
      acquire,
      copyOf: plan.copyOf,
      unlock: seeded.unlock.decision,
      create: false,
      adoptLegacyChange: seeded.unlock.legacyChangeAfterOpen === true,
    };
    return await startSharedSession(ctx, loc, st, rollback);
  } catch (err) {
    await rollback.run();
    throw err;
  }
}

export function sessionsOf(acquire: AcquireResult | null): readonly SessionRowView[] {
  return acquire?.kind === 'granted' || acquire?.kind === 'denied' ? acquire.sessions : [];
}

/** -wal or -shm next to S (5.5). A stat failure counts as present: holding legacy deletes is the safe side. */
async function sideFilesNextTo(ctx: OpenContext, sharedPath: string): Promise<boolean> {
  for (const suffix of SIDE_FILE_SUFFIXES) {
    try {
      if ((await ctx.host.fs.stat(`${sharedPath}${suffix}`)) !== null) return true;
    } catch (err) {
      ctx.host.logger.warn(`${SESSION_LOG_PREFIX} open: side-file check failed; holding legacy changes`, { code: errCode(err) });
      return true;
    }
  }
  return false;
}

async function holdInputs(ctx: OpenContext, acquire: AcquireResult | null): Promise<{ sideFiles: boolean; serverFlag: boolean }> {
  return {
    sideFiles: await sideFilesNextTo(ctx, ctx.sharedPath),
    serverFlag: sideFilesFlagRecent(sessionsOf(acquire), ctx.host.clock.now()),
  };
}

async function adoptSeed(ctx: OpenContext, s: SyncedView, acquire: AcquireResult | null): Promise<ReplicaSeed> {
  const hold = await holdInputs(ctx, acquire);
  return {
    kind: 'adopt',
    sharedBytes: s.snapshot.bytes,
    sharedSha256: s.snapshot.sha256,
    sharedMtimeMs: s.snapshot.stat.mtimeMs,
    holdLegacy: hold.sideFiles || hold.serverFlag,
  };
}

async function chooseSeed(
  ctx: OpenContext,
  peek: SharedPeek,
  unlock: AcceptedUnlock,
  acquire: AcquireResult | null,
  plan: BindingPlan,
): Promise<Seeded> {
  const base = { unlock, s: peek.s, toStore: plan.toStore };
  if (peek.hasW) return { ...base, seed: { kind: 'existing' } };
  if (peek.s.kind === 'synced') return { ...base, seed: await adoptSeed(ctx, peek.s, acquire) };
  if (peek.s.kind !== 'presync') throw new Error('[vault-session] open: no working copy and no usable shared file');
  const synced = await waitForSynced(ctx, peek.lineageId, acquire);
  if (synced === null) return { ...base, seed: { kind: 'genesis', sharedBytes: peek.s.snapshot.bytes } };
  // The synced file came from another device: the password is checked again against its epochs.
  const again = verifySharedPassword(ctx, { lineageId: peek.lineageId, s: synced, w: null });
  const fileId = synced.file.fileId;
  const toStore = plan.toStore !== null && fileId !== null ? { ...plan.toStore, fileId } : plan.toStore;
  return { unlock: again, s: synced, toStore, seed: await adoptSeed(ctx, synced, acquire) };
}

/** 4.4 G1: when a session shows a publish marker, wait (up to 2 min, [Continue anyway]) for the synced file. */
async function waitForSynced(ctx: OpenContext, lineageId: string, acquire: AcquireResult | null): Promise<SyncedView | null> {
  const latest: { view: SyncedView | null } = { view: null };
  const probe = async (): Promise<SharedProbe> => {
    try {
      const view = await readSharedView(ctx, ctx.sharedPath, { lineageId: null });
      if (view.kind === 'synced') {
        if (view.file.state.lineageId !== lineageId) return 'foreign';
        latest.view = view;
        return 'synced';
      }
      if (view.kind === 'presync') return 'presync';
      return probeOf(view.problem.kind);
    } catch (err) {
      ctx.host.logger.warn(`${SESSION_LOG_PREFIX} open: shared file probe failed during the first-genesis wait`, { code: errCode(err) });
      return 'unreadable';
    }
  };
  const outcome = await ctx.c.waitForSyncedFile({
    sessions: sessionsOf(acquire),
    probe,
    host: ctx.host,
    waiting: (state) => ctx.progress.waiting(state),
    continueRequested: ctx.progress.continueRequested(),
    cancelRequested: ctx.progress.cancelRequested?.(),
  });
  ctx.host.logger.info(`${SESSION_LOG_PREFIX} open: first-genesis wait ended`, { outcome });
  if (outcome === 'cancelled') throw new Error(OPEN_CANCELLED_MESSAGE);
  return outcome === 'synced' ? latest.view : null;
}

function probeOf(kind: Exclude<SharedView, { kind: 'synced' | 'presync' }>['problem']['kind']): SharedProbe {
  if (kind === 'missing' || kind === 'unreachable') return 'missing';
  if (kind === 'unreadable') return 'unreadable';
  return 'foreign';
}

/** 4.8 at open: W moves to S's newer epoch (s-newer, needs-wrap, legacy-change) before any cycle. */
async function alignEpochAtOpen(ctx: OpenContext, replica: ReplicaPort, seeded: Seeded, acquire: AcquireResult | null): Promise<void> {
  if (replica.epochAligned()) return;
  const s = seeded.s;
  if (s.kind !== 'synced') throw new Error('[vault-session] open: the key belongs to another epoch and the shared file cannot be absorbed');
  const hold = await holdInputs(ctx, acquire);
  await ctx.c.adoptEpochAtOpen(
    {
      replica,
      shared: { file: s.file, meta: s.meta, sha256: s.snapshot.sha256, mtimeMs: s.snapshot.stat.mtimeMs },
      decision: seeded.unlock.decision,
      key: seeded.unlock.key,
      previousKey: seeded.unlock.previousKey,
      sideFilesPresent: hold.sideFiles,
      serverSideFilesFlagRecent: hold.serverFlag,
      snapshots: new SnapshotStore(replica.paths.snapshots, ctx.host),
    },
    ctx.host,
  );
  ctx.host.logger.info(`${SESSION_LOG_PREFIX} open: adopted the shared file's key epoch`, { via: seeded.unlock.decision.via });
}
