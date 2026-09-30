/**
 * Seeding a new W (spec 4.4 G1, 5.1): the genesis of a pre-sync S,
 * adopting a synced S (absorbed against its own tables), and a brand-new vault. Each seed is
 * saved with no baseline (every sync table written). Import through replica.ts.
 */

import type Database from 'better-sqlite3';
import { captureLegacy } from './capture-legacy.js';
import { genesisFromContent, newVaultState } from './genesis.js';
import { deriveEpochKeys, genesisIdOf, makeImplicitProvider } from './hashing.js';
import { HlcClock, startHlc } from './hlc.js';
import { SYNC_LOG_PREFIX } from './host.js';
import { buildKeyRing, verifyKey } from './key-epoch.js';
import { materializeAndSave } from './replica-commit.js';
import type { LineageIncarnation, ReplicaDeps, ReplicaOpenInput, ReplicaSeed } from './replica-types.js';
import { StateBuilder, currentEpochId } from './state-view.js';
import { loadContent, loadFile } from './state-store.js';
import { SyncCoreError, type AppDot, type EpochKeys, type HeldLegacyChange, type LocalNotice, type SyncContext } from './types.js';

export interface SeedOutcome {
  readonly notices: readonly LocalNotice[];
  readonly held: readonly HeldLegacyChange[];
  /** W holds something S lacks (sync tables, absorbed legacy edits, or S does not exist yet). */
  readonly publishPending: boolean;
  /** A dot this seed committed (new vault), for the high-water mark. */
  readonly stamp: AppDot | null;
}

interface SeedEnv {
  readonly db: Database.Database;
  readonly input: ReplicaOpenInput;
  readonly inc: LineageIncarnation;
  readonly deps: ReplicaDeps;
}

const GENESIS_ID_BYTES = 32;
const NOTHING: SeedOutcome = { notices: [], held: [], publishPending: false, stamp: null };

/** Runs the seed on W's connection (after ensureSyncSchema). 'existing' does nothing. */
export function runSeed(env: SeedEnv): SeedOutcome {
  const seed = env.input.seed;
  switch (seed.kind) {
    case 'existing':
      return NOTHING;
    case 'genesis':
      return seedGenesis(env, seed.sharedBytes);
    case 'adopt':
      return seedAdopt(env, seed);
    case 'new-vault':
      return seedNewVault(env, seed);
  }
}

function now(env: SeedEnv): number {
  return env.deps.host.clock.now();
}

function randomBytes(env: SeedEnv): (n: number) => Buffer {
  return (n) => env.deps.host.random.bytes(n);
}

/** The key the unlock policy accepted must open the file's verification token. */
function requireKeyOpens(k: EpochKeys, verification: string | null | undefined, what: string): void {
  if (verification == null || !verifyKey(k.kEpoch, verification)) {
    throw new SyncCoreError('KEY_MISMATCH', `${SYNC_LOG_PREFIX} the unlock key does not open ${what}`);
  }
}

/** G1: every non-default register of the pre-sync bytes becomes a genesis pseudo sibling. */
function seedGenesis(env: SeedEnv, bytes: Buffer): SeedOutcome {
  const { db, input, inc } = env;
  const content = loadContent(db);
  const k0 = deriveEpochKeys(input.key, input.lineageId);
  requireKeyOpens(k0, content.meta.get('verification'), 'the pre-sync file');
  const g = genesisFromContent({
    content,
    genesisId: genesisIdOf(bytes),
    lineageId: input.lineageId,
    k0,
    randomBytes: randomBytes(env),
    now: () => now(env),
  });
  const b = new StateBuilder(g.state);
  b.addDev({ dev: inc.dev, deviceUuid: input.deviceUuid, startedMs: now(env) });
  materializeAndSave(db, makeImplicitProvider(k0.kSync), { baseline: null, cache: g.cache, fileId: null }, b.build(), { content });
  env.deps.host.logger.info(`${SYNC_LOG_PREFIX} first genesis of a pre-sync vault`, { undecryptable: g.undecryptable });
  return { notices: g.notices, held: [], publishPending: true, stamp: null };
}

/** W = S's bytes; legacy edits made to S in place are absorbed against S's own tables (4.3). */
function seedAdopt(env: SeedEnv, seed: Extract<ReplicaSeed, { kind: 'adopt' }>): SeedOutcome {
  const { db, input, inc } = env;
  const file = loadFile(db);
  if (file.state.lineageId !== input.lineageId) {
    throw new SyncCoreError('CORRUPT_STATE', `${SYNC_LOG_PREFIX} the adopted file belongs to another lineage`);
  }
  const k = deriveEpochKeys(input.key, input.lineageId);
  if (currentEpochId(file.state) !== k.epochId) {
    throw new SyncCoreError('KEY_MISMATCH', `${SYNC_LOG_PREFIX} the unlock key is not the adopted file's current key`);
  }
  const ctx: SyncContext = {
    deviceUuid: input.deviceUuid,
    lineageId: input.lineageId,
    dev: inc.dev,
    incarnation: inc.incarnation,
    keys: buildKeyRing(file.state, k, input.lineageId),
    now: () => now(env),
    randomBytes: randomBytes(env),
  };
  const att = {
    kind: 'legacy',
    // Legacy delete dots derive from this time; dots are integer milliseconds.
    observedMtimeMs: Math.floor(seed.sharedMtimeMs),
    sideFilesPresent: seed.holdLegacy,
    serverSideFilesFlagRecent: false,
    absorbKeys: k,
    sourceSha256: seed.sharedSha256,
  } as const;
  const implicit = makeImplicitProvider(k.kSync);
  const res = captureLegacy({ state: file.state, content: file.content, cache: file.cache, implicit }, att, ctx);
  const base = { baseline: null, cache: file.cache, fileId: file.fileId };
  materializeAndSave(db, implicit, base, res.state, { content: file.content });
  return { notices: res.notices, held: res.held, publishPending: res.changed || res.contentRepairNeeded, stamp: null };
}

/** vault_create: random genesis id, E0 from the caller's salt and verification, app-dot registers. */
function seedNewVault(env: SeedEnv, seed: Extract<ReplicaSeed, { kind: 'new-vault' }>): SeedOutcome {
  const { db, input, inc } = env;
  const k0 = deriveEpochKeys(input.key, input.lineageId);
  requireKeyOpens(k0, seed.verification, 'the new vault verification token');
  const created = now(env);
  const h = new HlcClock(() => now(env), startHlc(created, [])).tick();
  const dot: AppDot = { dev: inc.dev, ms: h.ms, c: h.c };
  const state = newVaultState({
    lineageId: input.lineageId,
    genesisId: env.deps.host.random.bytes(GENESIS_ID_BYTES).toString('hex'),
    k0,
    salt: seed.salt,
    verification: seed.verification,
    createdMs: created,
    dot,
    vaultId: seed.vaultId,
    deviceUuid: input.deviceUuid,
  });
  materializeAndSave(db, makeImplicitProvider(k0.kSync), { baseline: null, cache: new Map(), fileId: null }, state, {});
  return { notices: [], held: [], publishPending: true, stamp: dot };
}
