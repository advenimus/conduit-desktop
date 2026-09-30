// The openPersonalVault test harness: a SessionHost over a temp root with the fakes of
// open-fakes.ts wired in as collaborators, simple stand-ins for the pure sibling helpers
// (effective limit, claims, presence, location), and small file helpers. Re-exports the fakes.
import fs from 'node:fs';
import path from 'node:path';
import { ownerClaimWrite } from '../../sync/capture-local.js';
import { makeTestSessionHost, type TestSessionHost } from './session-fakes.js';
import { CountingKdf, FakeClient, FakeEngine, FakeReplicas, FakeRuntime, FakeShared, OWN_UUID } from './open-fakes.js';
import type { SyncEngine } from '../../sync/sync-engine.js';
import type { PresenceValue, SyncState } from '../../sync/types.js';
import type { ClaimVerdict } from '../claims.js';
import type { G1WaitInput, SharedProbe } from '../stale-wait.js';
import type { PersonalVaultRuntime } from '../session-runtime.js';
import type { SessionConfig } from '../host.js';
import type { OpenCollaborators } from '../open-deps.js';
import type { OpenDeps, OpenPersonalVaultInput, OpenProgress } from '../open-personal-vault.js';

export * from './open-fakes.js';

export interface OpenHarness {
  readonly t: TestSessionHost;
  readonly root: string;
  readonly config: SessionConfig;
  readonly kdf: CountingKdf;
  readonly shared: FakeShared;
  readonly replicas: FakeReplicas;
  readonly engines: FakeEngine[];
  readonly runtimes: FakeRuntime[];
  readonly client: FakeClient;
  readonly bound: Map<string, string>;
  readonly withW: Set<string>;
  readonly wStates: Map<string, SyncState>;
  readonly waits: G1WaitInput[];
  g1Outcome: 'synced' | 'timeout' | 'continued' | 'not-needed';
  verdict: ClaimVerdict;
  readonly presence: Map<string, PresenceValue>;
  readonly waitingStates: unknown[];
  readonly deps: OpenDeps;
  engineFactory: () => FakeEngine;
}

function limitOf(i: Parameters<OpenCollaborators['effectiveLimit']>[0]): ReturnType<OpenCollaborators['effectiveLimit']> {
  if (!i.signedIn) return { limit: 1, source: 'default' };
  if (i.confirmed && i.serverLimit !== null) return { limit: i.serverLimit, source: 'server' };
  if (i.localLast !== null) return { limit: i.localLast.value, source: 'local-json' };
  const cached = i.tierCache?.vaultMaxOpenDevices ?? null;
  return cached !== null ? { limit: cached, source: 'tier-cache' } : { limit: 1, source: 'default' };
}

export function presenceOf(name: string, over: Partial<PresenceValue> = {}): PresenceValue {
  return {
    platform: 'macos',
    name,
    app_version: '0.18.0',
    first_seen_ms: 1,
    last_active_ms: 1_000,
    session_open: 1,
    session_since_ms: 1,
    account_hint: null,
    file_hint: null,
    side_files_seen_ms: null,
    ...over,
  };
}

export function makeOpenHarness(root: string): OpenHarness {
  const kdf = new CountingKdf();
  const t = makeTestSessionHost(root, { kdf });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'cloud'), { recursive: true });
  const config: SessionConfig = {
    syncRoot: path.join(root, 'sync'),
    machineDir: path.join(root, 'sync', 'm-abcdef12'),
    dataDir: path.join(root, 'data'),
    deviceUuid: OWN_UUID,
    sessionNonce: '12345678-1234-4234-8234-123456789abc',
  };
  const shared = new FakeShared();
  const replicas = new FakeReplicas();
  const client = new FakeClient(() => t.knobs.userId !== null);
  const bound = new Map<string, string>();
  const withW = new Set<string>();
  const wStates = new Map<string, SyncState>();
  const waitingStates: unknown[] = [];
  const progress: OpenProgress = {
    waiting: (s) => waitingStates.push(s),
    continueRequested: () => new Promise<void>(() => undefined),
  };
  const h = {
    t,
    root,
    config,
    kdf,
    shared,
    replicas,
    engines: [] as FakeEngine[],
    runtimes: [] as FakeRuntime[],
    client,
    bound,
    withW,
    wStates,
    waits: [] as G1WaitInput[],
    g1Outcome: 'not-needed' as OpenHarness['g1Outcome'],
    verdict: { kind: 'none' } as ClaimVerdict,
    presence: new Map<string, PresenceValue>(),
    waitingStates,
    engineFactory: () => new FakeEngine(),
  } as Omit<OpenHarness, 'deps'> & { deps?: OpenDeps };
  const collaborators: Partial<OpenCollaborators> = {
    readShared: shared.readShared,
    classify: shared.classify,
    findBoundLineage: async (_m, realpath) => bound.get(realpath) ?? null,
    hasWorkingCopy: async (_m, lineage) => withW.has(lineage),
    readWorkingState: async (workingPath) => {
      const s = wStates.get(workingPath);
      if (s === undefined) throw new Error('harness: no W state for this path');
      return s;
    },
    openReplica: replicas.openReplica,
    adoptEpochAtOpen: replicas.adoptEpochAtOpen,
    createClient: () => client,
    createRuntime: (deps) => {
      const r = new FakeRuntime(deps);
      h.runtimes.push(r);
      return r as unknown as PersonalVaultRuntime;
    },
    waitForSyncedFile: async (input) => {
      h.waits.push(input);
      if (h.g1Outcome === 'synced') {
        const probed: SharedProbe = await input.probe();
        if (probed !== 'synced') return 'timeout';
      }
      return h.g1Outcome;
    },
    effectiveLimit: limitOf,
    claimsApply: (limit) => limit === 1,
    evaluateClaims: () => h.verdict,
    unlockClaimAction: (v) => (v.kind === 'other' ? (v.recentlyActive ? 'prompt' : 'claim') : v.kind === 'none' ? 'claim' : 'skip'),
    claimWrites: (hint, ctx) => [ownerClaimWrite({ a: hint, d: ctx.deviceUuid }, ctx)],
    readPresence: (_state, uuid) => {
      const value = h.presence.get(uuid);
      return value === undefined ? null : { deviceUuid: uuid, value, dot: null };
    },
    buildPresence: (prev, f) =>
      presenceOf(f.device.name, {
        first_seen_ms: prev?.first_seen_ms ?? f.nowMs,
        last_active_ms: f.nowMs,
        session_open: f.sessionOpen ? 1 : 0,
        session_since_ms: f.sessionSinceMs,
        account_hint: f.accountHint,
        file_hint: f.fileHint,
      }),
    locationOf: (realpath) => `local:${path.basename(path.dirname(realpath))}`,
  };
  const deps: OpenDeps = {
    host: t.host,
    config,
    progress,
    collaborators,
    assembleEngine: () => {
      const e = h.engineFactory();
      h.engines.push(e);
      return e as unknown as SyncEngine;
    },
  };
  return Object.assign(h, { deps }) as OpenHarness;
}

export function openInput(p: string, over: Partial<OpenPersonalVaultInput> = {}): OpenPersonalVaultInput {
  return { path: p, password: 'pw1', previousPassword: null, source: 'vault_unlock', takeover: false, create: false, ...over };
}

/** Every file under `dir` (relative paths), for "nothing was written" checks. */
export function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p).map((x) => path.join(e.name, x)));
    else out.push(e.name);
  }
  return out;
}
