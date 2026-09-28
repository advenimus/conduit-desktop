/**
 * Opening or seeding W for a lineage (spec 3.1, 3.2, 4.4 G1, 5.1): the lineage
 * folder, local.json (validated, or parked and rebuilt), the per-launch incarnation, the seed
 * files, WorkingCopyHost.open, ensureSyncSchema, the seed itself, the ring, the HLC start, the
 * high-water check, local.json, hooks, and removal of an expired genesis.conduit. W is never
 * the shared path. Import through replica.ts.
 */

import path from 'node:path';
import { deriveEpochKeys } from './hashing.js';
import { ownStamps, startHlc } from './hlc.js';
import { SYNC_LOG_PREFIX, type JournalMode, type WorkingCopyHandle } from './host.js';
import { buildKeyRing } from './key-epoch.js';
import { defaultLocalJson, readLocalJson } from './local-state.js';
import { ensureLineageDirs, isInsideDir, isNetworkRoot, lineagePaths, writeFileAtomic, type LineagePaths } from './paths.js';
import { loadSnapshot } from './replica-commit.js';
import { Replica } from './replica-core.js';
import { runSeed, type SeedOutcome } from './replica-seed.js';
import {
  GENESIS_BASELINE_KEEP_MS,
  type LineageIncarnation,
  type ReplicaDeps,
  type ReplicaOpenInput,
  type ReplicaOpenResult,
} from './replica-types.js';
import { ensureSyncSchema } from './schema.js';
import { currentEpochId } from './state-view.js';
import type { FileBinding, KeyRing, LocalJson, SyncState } from './types.js';

const W_COMPANIONS = ['-wal', '-shm', '-journal'] as const;
const CASE_INSENSITIVE: ReadonlySet<NodeJS.Platform> = new Set(['win32', 'darwin']);

interface StoredLocal {
  readonly value: LocalJson | null;
  readonly rebuilt: boolean;
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const fold = (p: string) => (CASE_INSENSITIVE.has(platform) ? path.resolve(p).toLowerCase() : path.resolve(p));
  return fold(a) === fold(b);
}

/** The shared file must never be W or anything inside the lineage folder. */
function assertNotShared(binding: FileBinding | null, paths: LineagePaths, platform: NodeJS.Platform): void {
  if (binding === null) return;
  for (const p of [binding.sharedPath, binding.realpath]) {
    if (samePath(p, paths.working, platform) || isInsideDir(p, paths.dir, platform)) {
      throw new Error(`${SYNC_LOG_PREFIX} the shared file cannot be the working copy or live in its folder`);
    }
  }
}

function readStoredLocal(paths: LineagePaths, lineageId: string, nowMs: number, deps: ReplicaDeps): StoredLocal {
  const read = readLocalJson(paths.dir, nowMs);
  if (read.parkedTo !== null) {
    deps.host.logger.warn(`${SYNC_LOG_PREFIX} local.json was invalid; parked and rebuilt`, { errors: read.errors.length });
    return { value: null, rebuilt: true };
  }
  if (read.value !== null && read.value.lineageId !== lineageId) {
    deps.host.logger.warn(`${SYNC_LOG_PREFIX} local.json names another lineage; rebuilt`);
    return { value: null, rebuilt: true };
  }
  return { value: read.value, rebuilt: false };
}

function checkSeed(input: ReplicaOpenInput, wExists: boolean): void {
  if (input.seed.kind === 'existing' && !wExists) {
    throw new Error(`${SYNC_LOG_PREFIX} no working copy exists for this lineage`);
  }
  if (input.seed.kind !== 'existing' && wExists) {
    throw new Error(`${SYNC_LOG_PREFIX} a working copy already exists for this lineage (seed ${input.seed.kind})`);
  }
}

/** Stale -wal/-shm of a W that no longer exists would be replayed onto the new file. */
async function removeWCompanions(paths: LineagePaths, deps: ReplicaDeps): Promise<void> {
  for (const suffix of W_COMPANIONS) {
    const p = `${paths.working}${suffix}`;
    if ((await deps.host.fs.stat(p)) === null) continue;
    deps.host.logger.warn(`${SYNC_LOG_PREFIX} removing a leftover working copy companion`, { file: path.basename(p) });
    await deps.host.fs.rm(p, { recursive: false, force: true });
  }
}

/**
 * genesis.conduit = the exact bytes of this G1. An older one (from a W that is gone) can never
 * match the new genesis_id, so it is replaced rather than kept as a useless G2 baseline.
 */
async function writeGenesisBaseline(paths: LineagePaths, bytes: Buffer, deps: ReplicaDeps): Promise<void> {
  if ((await deps.host.fs.stat(paths.genesis)) !== null) {
    const existing = await deps.host.fs.readFile(paths.genesis);
    if (existing.equals(bytes)) return;
    deps.host.logger.warn(`${SYNC_LOG_PREFIX} replacing a genesis.conduit left by an earlier working copy`);
  }
  writeFileAtomic(paths.genesis, bytes);
}

async function writeSeedFiles(input: ReplicaOpenInput, paths: LineagePaths, deps: ReplicaDeps): Promise<void> {
  await removeWCompanions(paths, deps);
  const seed = input.seed;
  if (seed.kind === 'genesis') {
    await writeGenesisBaseline(paths, seed.sharedBytes, deps);
    writeFileAtomic(paths.working, seed.sharedBytes);
  } else if (seed.kind === 'adopt') {
    writeFileAtomic(paths.working, seed.sharedBytes);
  }
}

function ringFor(state: SyncState, input: ReplicaOpenInput): KeyRing {
  const k = deriveEpochKeys(input.key, input.lineageId);
  if (k.epochId === currentEpochId(state)) return buildKeyRing(state, k, input.lineageId);
  return { current: k, byEpoch: new Map([[k.epochId, k]]) };
}

interface LocalUpdate {
  readonly input: ReplicaOpenInput;
  readonly dev: number;
  readonly incarnation: string;
  readonly seed: SeedOutcome;
  readonly stored: StoredLocal;
}

/** local.json after the open: this launch's dev and incarnation, the binding, the seed's results. */
function openedLocal(base: LocalJson, u: LocalUpdate): LocalJson {
  const binding = u.input.binding ?? base.binding;
  const pending = base.pendingPublish || u.seed.publishPending || u.stored.rebuilt;
  const same =
    base.dev === u.dev && base.incarnation === u.incarnation && binding === base.binding && pending === base.pendingPublish;
  if (same && u.seed.held.length === 0 && u.stored.value !== null) return base;
  const held = u.seed.held;
  return {
    ...base,
    dev: u.dev,
    incarnation: u.incarnation,
    binding,
    pendingPublish: pending,
    heldLegacy: held.length === 0 ? base.heldLegacy : [...base.heldLegacy, ...held],
  };
}

async function removeExpiredGenesis(paths: LineagePaths, deps: ReplicaDeps): Promise<void> {
  try {
    const st = await deps.host.fs.stat(paths.genesis);
    if (st === null || deps.host.clock.now() - st.mtimeMs <= GENESIS_BASELINE_KEEP_MS) return;
    await deps.host.fs.rm(paths.genesis, { recursive: false, force: true });
    deps.host.logger.info(`${SYNC_LOG_PREFIX} removed genesis.conduit after 180 days`);
  } catch (err) {
    deps.host.logger.warn(`${SYNC_LOG_PREFIX} could not remove an expired genesis.conduit`, { name: errName(err) });
  }
}

interface Opened {
  readonly input: ReplicaOpenInput;
  readonly deps: ReplicaDeps;
  readonly paths: LineagePaths;
  readonly handle: WorkingCopyHandle;
  readonly journalMode: JournalMode;
  readonly inc: LineageIncarnation;
  readonly stored: StoredLocal;
}

/** Steps 6-13 on the open handle: schema, seed, load, ring, HLC, high-water, local.json, hooks. */
function finishOpen(o: Opened): { readonly replica: Replica; readonly seed: SeedOutcome } {
  const { input, deps, handle, inc } = o;
  ensureSyncSchema(handle.db);
  const seed = runSeed({ db: handle.db, input, inc, deps });
  if (seed.stamp !== null) inc.highWater.stamp(seed.stamp);
  const loaded = loadSnapshot(handle.db, input.lineageId);
  const nowMs = deps.host.clock.now();
  const base = o.stored.value ?? defaultLocalJson(input.lineageId, inc.dev, inc.incarnation);
  const replica = new Replica({
    lineageId: input.lineageId,
    deviceUuid: input.deviceUuid,
    paths: o.paths,
    journalMode: o.journalMode,
    handle,
    deps,
    snapshot: loaded.snapshot,
    structural: loaded.structural,
    ring: ringFor(loaded.snapshot.state, input),
    incarnation: inc,
    clockStart: startHlc(nowMs, ownStamps(loaded.snapshot.state, input.deviceUuid)),
    local: base,
  });
  replica.highWaterCheck();
  const update: LocalUpdate = { input, dev: replica.dev(), incarnation: replica.incarnation(), seed, stored: o.stored };
  replica.updateLocal((l) => openedLocal(l, update));
  handle.setHooks(replica.hooks());
  return { replica, seed };
}

/** The open already failed; a close error is logged so it does not hide the original one. */
function closeAfterFailure(handle: WorkingCopyHandle, deps: ReplicaDeps): void {
  try {
    handle.setHooks(null);
    handle.close();
  } catch (err) {
    deps.host.logger.error(`${SYNC_LOG_PREFIX} closing the working copy after a failed open failed`, { name: errName(err) });
  }
}

async function discardFailedSeed(paths: LineagePaths, deps: ReplicaDeps): Promise<void> {
  try {
    await deps.host.fs.rm(paths.working, { recursive: false, force: true });
    await removeWCompanions(paths, deps);
  } catch (err) {
    deps.host.logger.error(`${SYNC_LOG_PREFIX} could not remove a half-seeded working copy`, { name: errName(err) });
  }
}

/**
 * Opens (or seeds) W for a lineage: lineage folder, local.json (validate or park and rebuild
 * from W), new incarnation, WorkingCopyHost.open, ensureSyncSchema, the seed, loadFile, ring,
 * HLC start, hooks installed on the handle, genesis.conduit older than 180 days removed.
 */
export async function openReplica(input: ReplicaOpenInput, deps: ReplicaDeps): Promise<ReplicaOpenResult> {
  const host = deps.host;
  const paths = lineagePaths(input.machineDir, input.lineageId);
  assertNotShared(input.binding, paths, host.paths.platform);
  ensureLineageDirs(paths);
  const stored = readStoredLocal(paths, input.lineageId, host.clock.now(), deps);
  const inc = deps.incarnations.forLineage(input.lineageId, input.deviceUuid, host.random);
  const wExisted = (await host.fs.stat(paths.working)) !== null;
  checkSeed(input, wExisted);
  if (!wExisted) await writeSeedFiles(input, paths, deps);
  const journalMode: JournalMode = isNetworkRoot(input.syncRoot, (p) => host.paths.isNetworkPath(p)) ? 'delete' : 'wal';
  let handle: WorkingCopyHandle | null = null;
  let opened: { readonly replica: Replica; readonly seed: SeedOutcome };
  try {
    handle = host.workingCopy.open({ path: paths.working, key: input.key, journalMode, create: input.seed.kind === 'new-vault' });
    opened = finishOpen({ input, deps, paths, handle, journalMode, inc, stored });
  } catch (err) {
    host.logger.error(`${SYNC_LOG_PREFIX} opening the working copy failed`, { seed: input.seed.kind, name: errName(err) });
    if (handle !== null) closeAfterFailure(handle, deps);
    if (!wExisted) await discardFailedSeed(paths, deps);
    throw err;
  }
  await removeExpiredGenesis(paths, deps);
  return {
    replica: opened.replica,
    created: !wExisted,
    seeded: input.seed.kind,
    notices: opened.seed.notices,
    localRebuilt: stored.rebuilt,
  };
}
