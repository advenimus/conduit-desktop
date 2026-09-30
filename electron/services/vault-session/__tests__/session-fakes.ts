// Shared test seams for the device-session layer: ScriptedRpc (canned
// answers per RPC, recorded calls), FakeRealtime (manual row updates), FakePower, FakeActivity,
// FakeBusy, FakeTierCache, FakeAccess, and makeTestSessionHost() over makeTestSyncHost().
// fake-session-server.ts emulates the SQL of 9.5 for end-to-end lease tests.
import { RecordingEmitter, makeTestSyncHost, type TestSyncHost } from '../../sync/__tests__/host-fakes.js';
import type {
  ActivityHost,
  BusyHost,
  BusyReport,
  CachedTierLimit,
  LockedReason,
  PowerHost,
  RealtimeHandlers,
  RealtimeHost,
  RealtimeStatus,
  RealtimeSubscription,
  RpcCaller,
  RpcFailure,
  RpcResult,
  SessionEventMap,
  SessionHost,
  SessionRpcName,
  TierCacheHost,
  VaultAccessHost,
} from '../host.js';

// ---------- RPC ----------

export interface RpcCall {
  readonly fn: SessionRpcName;
  readonly args: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
}

export type RpcHandler = (args: Readonly<Record<string, unknown>>) => RpcResult | Promise<RpcResult>;

export const rpcOk = (data: unknown): RpcResult => ({ ok: true, data });
export const rpcFail = (failure: Partial<RpcFailure> & Pick<RpcFailure, 'kind'>): RpcResult => ({
  ok: false,
  failure: { status: null, code: null, message: failure.kind, ...failure },
});

/** Answers from a per-function queue (first) or a per-function handler; unscripted calls fail as 'network'. */
export class ScriptedRpc implements RpcCaller {
  readonly calls: RpcCall[] = [];
  private readonly queues = new Map<SessionRpcName, RpcResult[]>();
  private readonly handlers = new Map<SessionRpcName, RpcHandler>();

  enqueue(fn: SessionRpcName, ...results: RpcResult[]): void {
    this.queues.set(fn, [...(this.queues.get(fn) ?? []), ...results]);
  }

  handle(fn: SessionRpcName, handler: RpcHandler): void {
    this.handlers.set(fn, handler);
  }

  callsOf(fn: SessionRpcName): RpcCall[] {
    return this.calls.filter((c) => c.fn === fn);
  }

  async call(fn: SessionRpcName, args: Readonly<Record<string, unknown>>, timeoutMs: number): Promise<RpcResult> {
    this.calls.push({ fn, args, timeoutMs });
    const queued = this.queues.get(fn)?.shift();
    if (queued !== undefined) return queued;
    const handler = this.handlers.get(fn);
    if (handler !== undefined) return handler(args);
    return rpcFail({ kind: 'network', message: `unscripted ${fn}` });
  }
}

// ---------- Realtime ----------

export class FakeRealtime implements RealtimeHost {
  private readonly subs: { readonly deviceId: string; readonly handlers: RealtimeHandlers; active: boolean }[] = [];

  subscribeOwnSessionRows(deviceId: string, handlers: RealtimeHandlers): RealtimeSubscription {
    const sub = { deviceId, handlers, active: true };
    this.subs.push(sub);
    return {
      unsubscribe: () => {
        sub.active = false;
      },
    };
  }

  activeCount(): number {
    return this.subs.filter((s) => s.active).length;
  }

  /** Delivers an UPDATE row to active subscribers of row.device_id (as RLS + filter would). */
  push(row: Readonly<Record<string, unknown>>): void {
    for (const s of this.subs) {
      if (s.active && s.deviceId === row.device_id) s.handlers.onUpdate(row);
    }
  }

  status(status: RealtimeStatus): void {
    for (const s of this.subs) if (s.active) s.handlers.onStatus(status);
  }
}

// ---------- Power, activity, busy, tier cache ----------

export class FakePower implements PowerHost {
  idleSeconds = 0;
  private readonly suspendFns = new Set<() => void>();
  private readonly resumeFns = new Set<() => void>();

  onSuspend(fn: () => void): () => void {
    this.suspendFns.add(fn);
    return () => this.suspendFns.delete(fn);
  }

  onResume(fn: () => void): () => void {
    this.resumeFns.add(fn);
    return () => this.resumeFns.delete(fn);
  }

  systemIdleSeconds(): number {
    return this.idleSeconds;
  }

  suspend(): void {
    for (const fn of [...this.suspendFns]) fn();
  }

  resume(): void {
    for (const fn of [...this.resumeFns]) fn();
  }
}

export class FakeActivity implements ActivityHost {
  focused = true;
  lastFocus: number | null = null;

  isFocused(): boolean {
    return this.focused;
  }

  lastFocusMs(): number | null {
    return this.lastFocus;
  }
}

export class FakeBusy implements BusyHost {
  report: BusyReport = { sessions: 0, jobs: 0 };

  busy(): BusyReport {
    return this.report;
  }
}

export class FakeTierCache implements TierCacheHost {
  value: CachedTierLimit | null = null;

  read(): CachedTierLimit | null {
    return this.value;
  }
}

export class FakeAccess implements VaultAccessHost {
  readonly log: string[] = [];
  readonly privateOpens: { readonly path: string; readonly password: string }[] = [];

  blockAccess(reason: LockedReason): void {
    this.log.push(`block:${reason}`);
  }

  softLock(reason: LockedReason): void {
    this.log.push(`soft-lock:${reason}`);
  }

  async openPrivateInPlace(path: string, password: string): Promise<void> {
    this.privateOpens.push({ path, password });
  }

  async createPrivateInPlace(path: string, password: string): Promise<void> {
    this.log.push(`create:${path}`);
    this.privateOpens.push({ path, password });
  }
}

// ---------- Bundle ----------

export interface TestSessionHost extends Omit<TestSyncHost, 'host'> {
  readonly host: SessionHost;
  readonly rpc: ScriptedRpc;
  readonly realtime: FakeRealtime;
  readonly power: FakePower;
  readonly activity: FakeActivity;
  readonly busy: FakeBusy;
  readonly tierCache: FakeTierCache;
  readonly access: FakeAccess;
  readonly sessionEvents: RecordingEmitter<SessionEventMap>;
}

export function makeTestSessionHost(root: string, overrides: Partial<SessionHost> = {}): TestSessionHost {
  const base = makeTestSyncHost(root);
  const rpc = new ScriptedRpc();
  const realtime = new FakeRealtime();
  const power = new FakePower();
  const activity = new FakeActivity();
  const busy = new FakeBusy();
  const tierCache = new FakeTierCache();
  const access = new FakeAccess();
  const sessionEvents = new RecordingEmitter<SessionEventMap>();
  const host: SessionHost = {
    ...base.host,
    rpc,
    realtime,
    power,
    activity,
    busy,
    tierCache,
    access,
    sessionEvents,
    ...overrides,
  };
  return { ...base, host, rpc, realtime, power, activity, busy, tierCache, access, sessionEvents };
}
