// Fakes of the engine's sibling ports for sync-engine unit tests: a replica whose local.json
// lives on disk, and minimal shared-file, binding, side-files, scanner, candidates, snapshots and
// watcher ports, with the real SyncStatusModel and Notices on top. Cycle bodies and tracker
// doubles are in engine-fakes-body.ts (re-exported here).
import fs from 'node:fs';
import path from 'node:path';
import { Notices, ReminderRegistry } from '../notices.js';
import { SyncStatusModel } from '../sync-status.js';
import { SyncEngine, nullSessionSignals, type SyncEngineDeps } from '../sync-engine.js';
import { defaultLocalJson, writeLocalJson } from '../local-state.js';
import { ensureLineageDirs, lineagePaths } from '../paths.js';
import { emptyState } from '../state-view.js';
import { makeTestSyncHost, type TestSyncHost } from './host-fakes.js';
import { DEV, DEVICE, LINEAGE, ScriptedBody, TestBackoff, TestRegressions, TestTorn, TestVerifier } from './engine-fakes-body.js';
import type { FileWatchListener, FileWatcherPort } from '../file-watch.js';
import type { SideFilesView } from '../side-files.js';
import type { SessionSignals } from '../host.js';
import type { CaptureResult, FileBinding, LocalJson, SideFileTuple, SyncState } from '../types.js';

export * from './engine-fakes-body.js';

// ---------- ports ----------

export class FakeReplica {
  readonly lineageId = LINEAGE;
  readonly deviceUuid = DEVICE;
  readonly journalMode: 'wal' | 'delete';
  readonly paths;
  readonly handle = null;
  private localJson: LocalJson;
  private readonly commitListeners = new Set<() => void>();
  private readonly fullPassListeners = new Set<(r: string) => void>();
  gen = 0;
  fullPasses = 0;
  fullPassChanges = false;
  applied: unknown[][] = [];

  constructor(root: string, journalMode: 'wal' | 'delete' = 'wal') {
    this.journalMode = journalMode;
    this.paths = lineagePaths(path.join(root, 'machine'), LINEAGE);
    ensureLineageDirs(this.paths);
    this.localJson = defaultLocalJson(LINEAGE, DEV, 'c'.repeat(32));
    writeLocalJson(this.paths.dir, this.localJson);
  }

  database(): never {
    return {} as never;
  }
  dev(): number {
    return DEV;
  }
  state(): SyncState {
    return emptyState(LINEAGE, 'd'.repeat(64), 1);
  }
  structural(): readonly never[] {
    return [];
  }
  generation(): number {
    return this.gen;
  }
  local(): LocalJson {
    return this.localJson;
  }
  updateLocal(fn: (l: LocalJson) => LocalJson): LocalJson {
    this.localJson = fn(this.localJson);
    writeLocalJson(this.paths.dir, this.localJson);
    return this.localJson;
  }
  fullPass(): CaptureResult {
    this.fullPasses += 1;
    return { changed: this.fullPassChanges } as CaptureResult;
  }
  applyWrites(writes: readonly unknown[]): CaptureResult {
    this.applied.push([...writes]);
    this.gen += 1;
    this.mutate();
    return { changed: true, state: this.state(), changedRows: [] } as unknown as CaptureResult;
  }
  onLocalCommit(listener: () => void): () => void {
    this.commitListeners.add(listener);
    return () => this.commitListeners.delete(listener);
  }
  onFullPassRequest(listener: (r: string) => void): () => void {
    this.fullPassListeners.add(listener);
    return () => this.fullPassListeners.delete(listener);
  }
  /** A ConduitVault mutation committed through the hooks. */
  mutate(): void {
    this.gen += 1;
    for (const l of this.commitListeners) l();
  }
  requestFullPass(): void {
    for (const l of this.fullPassListeners) l('raw write');
  }
  listenerCount(): number {
    return this.commitListeners.size + this.fullPassListeners.size;
  }
}

export class FakeWatcher implements FileWatcherPort {
  started = false;
  stopped = false;
  paths: string[] = [];
  acks: { sha256: string | null }[] = [];
  observedAcks = 0;
  constructor(
    sharedPath: string,
    readonly listener: FileWatchListener,
  ) {
    this.paths.push(sharedPath);
  }
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
  acknowledge(_sig: unknown, sha256: string | null): void {
    this.acks.push({ sha256 });
  }
  acknowledgeObserved(): void {
    this.observedAcks += 1;
  }
  setSharedPath(p: string): void {
    this.paths.push(p);
  }
  async pollNow(): Promise<void> {}
  async hashNow(): Promise<void> {}
}

export function sideView(state: SideFilesView['state'], walNonEmpty = false): SideFilesView {
  return {
    state,
    tuples: [],
    walNonEmpty,
    upgradeWording: false,
    publishAllowed: state !== 'present',
    holdLegacy: state === 'present',
  };
}

export class FakeSideFiles {
  current: SideFilesView = sideView('none');
  confirmed = false;
  view(): SideFilesView {
    return this.current;
  }
  observe(tuples: readonly SideFileTuple[]): SideFilesView {
    const any = tuples.some((t) => t.exists);
    this.current = sideView(!any ? 'none' : this.confirmed ? 'confirmed' : 'present');
    return this.current;
  }
  async confirm(): Promise<{ kind: 'confirmed'; movedTo: string | null }> {
    this.confirmed = true;
    this.current = sideView('confirmed');
    return { kind: 'confirmed', movedTo: null };
  }
  async stageWalCopy(): Promise<string> {
    return '/tmp/wal-copy.conduit';
  }
  heartbeatFlag(): 'present' | null {
    return this.current.state === 'present' ? 'present' : null;
  }
  lastSeenMs(): number | null {
    return null;
  }
  async cleanup(): Promise<number> {
    return 0;
  }
  pendingRetry(): null {
    return null;
  }
  setSharedPath(): void {}
}

export interface Harness {
  readonly t: TestSyncHost;
  readonly engine: SyncEngine;
  readonly deps: SyncEngineDeps;
  readonly body: ScriptedBody;
  readonly replica: FakeReplica;
  readonly status: SyncStatusModel;
  readonly sideFiles: FakeSideFiles;
  readonly backoff: TestBackoff;
  readonly verifier: TestVerifier;
  readonly regressions: TestRegressions;
  readonly session: SessionSignals & { readonly log: string[] };
  readonly sharedPath: string;
  readonly vacuums: string[];
  scan: { copies: unknown[]; skipped: number };
  /** What binding.locate answers next. */
  locate: { kind: 'bound'; binding: FileBinding } | { kind: 'other-lineage'; lineageId: string | null } | { kind: 'unreadable' };
  readonly located: string[];
  readonly queued: { path: string; source: string; label: string }[];
  readonly ignored: string[];
  watcher(): FakeWatcher;
  bindingListeners: ((b: FileBinding) => void)[];
}

function recordingSession(): SessionSignals & { log: string[] } {
  const log: string[] = [];
  const base = nullSessionSignals();
  return {
    ...base,
    log,
    published: (m) => log.push(`published:${m.dev}:${m.ms}`),
    sharedRead: () => log.push('sharedRead'),
    sideFilesChanged: (p) => log.push(`sideFiles:${p}`),
  };
}

export function makeHarness(root: string, opts: { journalMode?: 'wal' | 'delete' } = {}): Harness {
  const t = makeTestSyncHost(root);
  const replica = new FakeReplica(root, opts.journalMode);
  const sharedPath = path.join(root, 'cloud', 'Vault.conduit');
  fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
  const status = new SyncStatusModel(LINEAGE, t.host);
  const notices = new Notices({ replica: replica as never, host: t.host, reminders: new ReminderRegistry() });
  const sideFiles = new FakeSideFiles();
  const session = recordingSession();
  const vacuums: string[] = [];
  const watchers: FakeWatcher[] = [];
  const bindingListeners: ((b: FileBinding) => void)[] = [];
  const binding: FileBinding = { sharedPath, realpath: sharedPath, fileId: '33333333-4444-4555-8666-777777777777' };
  const h = {
    scan: { copies: [] as unknown[], skipped: 0 },
    locate: { kind: 'unreadable' } as Harness['locate'],
    located: [] as string[],
    queued: [] as { path: string; source: string; label: string }[],
    ignored: [] as string[],
  };
  const deps = {
    host: t.host,
    replica,
    shared: {
      vacuumInto: (_db: unknown, target: string) => {
        vacuums.push(target);
        fs.writeFileSync(target, 'W');
      },
      cleanupPublishTemps: async () => 0,
      cleanupIncoming: async () => 0,
    },
    binding: {
      binding: () => binding,
      sharedPath: () => binding.sharedPath,
      fileHint: () => ({ file_id: binding.fileId, location: 'local:cloud', file_name: 'Vault.conduit' }),
      onChange: (l: (b: FileBinding) => void) => {
        bindingListeners.push(l);
        return () => undefined;
      },
      locate: async (p: string) => {
        h.located.push(p);
        return h.locate;
      },
    },
    sideFiles,
    scanner: { scan: async () => h.scan, mergeSafe: async () => null, ignore: (sha: string) => h.ignored.push(sha) },
    candidates: {
      load: async () => undefined,
      ensureLoaded: async () => undefined,
      list: () => [],
      addFile: async (input: { path: string; source: string; label: string }) => {
        h.queued.push({ path: input.path, source: input.source, label: input.label });
        return { id: `c${h.queued.length}`, label: input.label };
      },
    },
    divergence: {},
    snapshots: { prune: async () => 0 },
    status,
    notices,
    session,
    createWatcher: (p: string, l: FileWatchListener) => {
      const w = new FakeWatcher(p, l);
      watchers.push(w);
      return w;
    },
  } as unknown as SyncEngineDeps;
  const body = new ScriptedBody(() => t.clock.now());
  const backoff = new TestBackoff();
  const verifier = new TestVerifier();
  const regressions = new TestRegressions();
  const engine = new SyncEngine(deps, {
    runCycleBody: body.run,
    errorBackoff: backoff,
    verifier,
    regressions,
    torn: new TestTorn(),
  });
  const watcher = (): FakeWatcher => {
    const w = watchers[watchers.length - 1];
    if (w === undefined) throw new Error('no watcher yet');
    return w;
  };
  return Object.assign(h, {
    t,
    engine,
    deps,
    body,
    replica,
    status,
    sideFiles,
    backoff,
    verifier,
    regressions,
    session,
    sharedPath,
    vacuums,
    watcher,
    bindingListeners,
  });
}
