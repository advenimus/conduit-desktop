// Fakes for the openPersonalVault tests: scripted shared files (staged for real into the open's
// staging folder), replica, engine, runtime and session client. Built on the key-epoch fixtures
// so the real unlock policy (decideUnlock) decides every password case. Wired by open-harness.ts.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { currentEpochId } from '../../sync/key-epoch.js';
import { defaultLocalJson } from '../../sync/local-state.js';
import { nullSessionSignals } from '../../sync/sync-engine.js';
import { fakeDerive, ringOf } from '../../sync/__tests__/key-epoch-fixtures.js';
import type { Kdf, SessionRowView } from '../../sync/host.js';
import type { ReplicaOpenInput, ReplicaOpenResult, ReplicaPort } from '../../sync/replica.js';
import type { SharedClass, SharedReadOutcome, SharedSnapshot } from '../../sync/shared-file.js';
import type { CycleOutcome } from '../../sync/sync-engine.js';
import type { AdoptAtOpenInput } from '../../sync/sync-epoch.js';
import type {
  CaptureResult,
  ContentSnapshot,
  EpochKeys,
  FileHint,
  LoadedFile,
  LocalJson,
  LocalWrite,
  SyncContext,
  SyncState,
} from '../../sync/types.js';
import type { RuntimeDeps } from '../session-runtime.js';
import type {
  AbandonArgs,
  AcquireArgs,
  AcquireResult,
  HeartbeatResult,
  PeekResult,
  ReleaseArgs,
  SessionClientPort,
  SessionIds,
  SimpleResult,
} from '../session-client.js';
import type { Holder } from '../host.js';
import type { OpenCollaborators } from '../open-deps.js';

export const OWN_UUID = '0a0b0c0d-1111-4222-8333-444455556666';
export const OTHER_UUID = '9f8e7d6c-5555-4666-8777-888899990000';
export const EMPTY_CONTENT: ContentSnapshot = { entries: new Map(), folders: new Map(), history: new Map(), meta: new Map() };

/** fakeDerive as the host kdf, counting derivations (a typo costs no PBKDF2 when refused early). */
export class CountingKdf implements Kdf {
  calls = 0;

  deriveKey(password: string, saltB64: string): Buffer {
    this.calls += 1;
    return fakeDerive(password)(saltB64);
  }
}

// ---------- Shared files ----------

export type FakeFile =
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreachable'; readonly code: string }
  | { readonly kind: 'ok'; readonly bytes: Buffer; readonly cls: SharedClass; readonly mtimeMs?: number };

export function syncedClass(state: SyncState, fileId: string | null, meta = metaOf(state)): SharedClass {
  const file: LoadedFile = { state, content: EMPTY_CONTENT, cache: new Map(), fileId, syncFormat: 1 };
  return { kind: 'synced', file, meta };
}

export function presyncClass(meta: { salt: string | null; verification: string | null }): SharedClass {
  return { kind: 'presync', content: EMPTY_CONTENT, meta };
}

export function metaOf(state: SyncState): { salt: string | null; verification: string | null } {
  const rec = state.epochs.get(currentEpochId(state) ?? '');
  return { salt: rec?.salt ?? null, verification: rec?.verification ?? null };
}

/** readShared/classify scripted per path; staging writes the bytes for real (removal is observable). */
export class FakeShared {
  readonly reads: string[] = [];
  private readonly files = new Map<string, FakeFile[]>();
  private readonly classes = new Map<string, SharedClass>();

  /** Later reads of `p` take the next entry; the last one repeats. */
  set(p: string, ...entries: FakeFile[]): void {
    this.files.set(path.resolve(p), entries);
  }

  readShared: OpenCollaborators['readShared'] = async (p: string, dir: string): Promise<SharedReadOutcome> => {
    const key = path.resolve(p);
    this.reads.push(key);
    const queue = this.files.get(key) ?? [];
    const entry = queue.length > 1 ? (queue.shift() as FakeFile) : (queue[0] ?? { kind: 'missing' });
    if (entry.kind === 'missing') return { kind: 'missing' };
    if (entry.kind === 'unreachable') return { kind: 'unreachable', code: entry.code };
    const sha256 = crypto.createHash('sha256').update(entry.bytes).digest('hex');
    const stagedPath = path.join(dir, `${sha256}.conduit`);
    fs.writeFileSync(stagedPath, entry.bytes);
    this.classes.set(stagedPath, entry.cls);
    const stat = { size: entry.bytes.length, mtimeMs: entry.mtimeMs ?? 1_000, ino: '1', isFile: true, isDirectory: false, isSymbolicLink: false };
    const snapshot: SharedSnapshot = { path: key, bytes: entry.bytes, sha256, stat, stagedPath };
    return { kind: 'ok', snapshot };
  };

  classify: OpenCollaborators['classify'] = (snapshot: SharedSnapshot): SharedClass => {
    const cls = this.classes.get(snapshot.stagedPath);
    if (cls === undefined) throw new Error('FakeShared: classify of an unknown snapshot');
    return cls;
  };
}

// ---------- Replica ----------

export class FakeReplica {
  closed = false;
  aligned: boolean;
  readonly applied: { readonly writes: readonly LocalWrite[]; readonly interactive: boolean; readonly ruleR: boolean | undefined }[] = [];
  private readonly ctxv: SyncContext;

  constructor(
    readonly lineageId: string,
    readonly deviceUuid: string,
    private readonly st: SyncState,
    keys: EpochKeys,
    aligned: boolean,
    private localJson: LocalJson,
  ) {
    this.aligned = aligned;
    this.ctxv = {
      deviceUuid,
      lineageId,
      dev: 3,
      incarnation: 'cd'.repeat(16),
      keys: ringOf(keys),
      now: () => 1_000,
      randomBytes: (n) => crypto.randomBytes(n),
    };
  }

  epochAligned(): boolean {
    return this.aligned;
  }

  state(): SyncState {
    return this.st;
  }

  context(): SyncContext {
    return this.ctxv;
  }

  local(): LocalJson {
    return this.localJson;
  }

  updateLocal(fn: (l: LocalJson) => LocalJson): LocalJson {
    this.localJson = fn(this.localJson);
    return this.localJson;
  }

  applyWrites(writes: readonly LocalWrite[], opts: { interactive: boolean; ruleR?: boolean }): CaptureResult {
    this.applied.push({ writes, interactive: opts.interactive, ruleR: opts.ruleR });
    return { state: this.st, changed: true, changedRows: [], notices: [], held: [], contentRepairNeeded: false } as unknown as CaptureResult;
  }

  close(): void {
    this.closed = true;
  }
}

export class FakeReplicas {
  readonly opened: ReplicaOpenInput[] = [];
  readonly replicas: FakeReplica[] = [];
  /** Epoch key the replica's context uses; tests set it to the accepted key's epoch. */
  keys: EpochKeys | null = null;
  state: SyncState | null = null;
  /** The opened key belongs to W's epoch (false: adoptEpochAtOpen must run). */
  aligned = true;
  lastLimit: { value: number; atMs: number } | null = null;
  failWith: Error | null = null;
  readonly adopted: AdoptAtOpenInput[] = [];

  openReplica: OpenCollaborators['openReplica'] = async (input): Promise<ReplicaOpenResult> => {
    this.opened.push(input);
    if (this.failWith) throw this.failWith;
    if (this.state === null || this.keys === null) throw new Error('FakeReplicas: state and keys not set');
    const local = { ...defaultLocalJson(input.lineageId, 3, 'cd'.repeat(16)), lastLimit: this.lastLimit, binding: input.binding };
    const replica = new FakeReplica(input.lineageId, input.deviceUuid, this.state, this.keys, this.aligned, local);
    this.replicas.push(replica);
    return { replica: replica as unknown as ReplicaPort, created: input.seed.kind !== 'existing', seeded: input.seed.kind, notices: [], localRebuilt: false };
  };

  adoptEpochAtOpen: OpenCollaborators['adoptEpochAtOpen'] = (input) => {
    this.adopted.push(input);
    (input.replica as unknown as FakeReplica).aligned = true;
    return { state: input.replica.state(), changedRows: [], structural: [], generation: 1 };
  };

  last(): FakeReplica {
    const r = this.replicas[this.replicas.length - 1];
    if (r === undefined) throw new Error('FakeReplicas: nothing opened');
    return r;
  }
}

// ---------- Engine and runtime ----------

export class FakeEngine {
  readonly calls: string[] = [];
  readonly prompts: unknown[] = [];
  readonly notices: unknown[] = [];
  cycle: Promise<CycleOutcome> = Promise.resolve({ kind: 'up-to-date', merged: false });
  hint: FileHint = { file_id: 'f', location: 'local:cloud', file_name: 'Vault.conduit' };
  /** lastSharedState() for the runtime's stale-wait start. */
  sharedState: SyncState | null = null;
  /** Every status call (the runtime's badge and waiting state land here). */
  onStatus: (name: string, args: readonly unknown[]) => void = () => undefined;

  lastSharedState(): SyncState | null {
    return this.sharedState;
  }

  trigger(t: string): void {
    this.calls.push(`trigger:${t}`);
  }

  runCycle(reason: string): Promise<CycleOutcome> {
    this.calls.push(`runCycle:${reason}`);
    return this.cycle;
  }

  publishInitial(): Promise<boolean> {
    this.calls.push('publishInitial');
    return this.cycle.then(() => true);
  }

  exclusive<T>(fn: () => T): Promise<T> {
    this.calls.push('exclusive');
    return this.cycle.then(() => fn());
  }

  adoptLegacyPasswordChange(newPassword: string, previousPassword: string | null): Promise<unknown> {
    this.calls.push(`adoptLegacy:${newPassword}:${previousPassword ?? ''}`);
    return this.cycle.then(() => ({}));
  }

  start(): void {
    this.calls.push('start');
  }

  async stop(): Promise<void> {
    this.calls.push('stop');
  }

  parts(): unknown {
    const status = new Proxy(
      {},
      {
        get: (_t, name) => (...args: unknown[]) => {
          if (name === 'setPrompt') this.prompts.push(args[0]);
          this.onStatus(String(name), args);
        },
      },
    );
    return {
      status,
      notices: { addFromCapture: (n: unknown) => this.notices.push(n) },
      binding: { fileHint: () => this.hint },
    };
  }
}

export class FakeRuntime {
  readonly calls: string[] = [];
  started: AcquireResult | null | undefined = undefined;
  engine: unknown = null;

  constructor(readonly deps: RuntimeDeps) {}

  signals(): ReturnType<typeof nullSessionSignals> {
    return nullSessionSignals();
  }

  attachEngine(engine: unknown): void {
    this.calls.push('attachEngine');
    this.engine = engine;
  }

  start(acquire: AcquireResult | null): void {
    this.calls.push('start');
    this.started = acquire;
  }
}

// ---------- Session client ----------

export class FakeClient implements SessionClientPort {
  readonly calls: { readonly fn: string; readonly args: unknown; readonly timeoutMs?: number }[] = [];
  peekResult: PeekResult | Promise<PeekResult> = { kind: 'ok', limit: 1, holders: [] };
  acquireResult: AcquireResult = { kind: 'granted', leaseId: 'lease-1', limit: 1, sessions: [], serverNowMs: null };
  releaseResult: SimpleResult = { kind: 'ok' };

  constructor(private readonly signedIn: () => boolean) {}

  of(fn: string): { readonly fn: string; readonly args: unknown; readonly timeoutMs?: number }[] {
    return this.calls.filter((c) => c.fn === fn);
  }

  async peek(ids: SessionIds, timeoutMs?: number): Promise<PeekResult> {
    if (!this.signedIn()) return { kind: 'unconfirmed', reason: 'signed-out', detail: '' };
    this.calls.push({ fn: 'peek', args: ids, timeoutMs });
    return this.peekResult;
  }

  async acquire(args: AcquireArgs): Promise<AcquireResult> {
    this.calls.push({ fn: 'acquire', args });
    return this.acquireResult;
  }

  async heartbeat(): Promise<HeartbeatResult> {
    this.calls.push({ fn: 'heartbeat', args: null });
    return { kind: 'unconfirmed', reason: 'network', detail: 'fake' };
  }

  async release(args: ReleaseArgs, timeoutMs?: number): Promise<SimpleResult> {
    this.calls.push({ fn: 'release', args, timeoutMs });
    return this.releaseResult;
  }

  async abandon(args: AbandonArgs): Promise<SimpleResult> {
    this.calls.push({ fn: 'abandon', args });
    return { kind: 'ok' };
  }
}

export function holder(name: string, location: string | null = 'local:cloud'): Holder {
  return { deviceId: OTHER_UUID, deviceName: name, platform: 'macos', fileName: 'Vault.conduit', fileId: 'f', location, lastActiveMs: 1_000, busySessions: 3, busyJobs: 1 };
}

export function sessionRow(over: Partial<SessionRowView> = {}): SessionRowView {
  return {
    deviceId: OTHER_UUID,
    deviceName: 'MacBook',
    platform: 'macos',
    fileName: 'Vault.conduit',
    fileId: 'f',
    location: 'local:cloud',
    status: 'released',
    lastActiveMs: 1_000,
    busySessions: 0,
    busyJobs: 0,
    heartbeatAtMs: null,
    sideFilesFlag: false,
    marker: { dev: 9, ms: 500, c: 0 },
    writtenAtMs: 500,
    pendingChanges: false,
    abandoned: false,
    ...over,
  };
}
