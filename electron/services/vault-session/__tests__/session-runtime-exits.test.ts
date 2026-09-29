// @vitest-environment node
// The runtime's exits (spec 6.4, 6.6 steps 2-3, 6.8, 9.5): a displaced device always sends
// vault_session_release with its lease id, however the displacement was detected; a lock leaves
// no reconnect timer behind; a conflict answer after the soft lock never takes over.
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempRoot } from '../../sync/__tests__/host-fakes.js';
import { RECONNECT_ANSWER_MS } from '../displacement.js';
import { HEARTBEAT_MS, OFFLINE_RETRY_MS } from '../heartbeat.js';
import { LeaseTracker } from '../lease.js';
import { PersonalVaultRuntime, type RuntimeDeps } from '../session-runtime.js';
import { SessionClient, type AcquireResult } from '../session-client.js';
import { denied, granted as grantedAnswer } from './heartbeat-harness.js';
import { LINEAGE, NONCE, OWN, RuntimeEngine, RuntimeReplica, USER } from './runtime-fakes.js';
import { makeTestSessionHost, rpcOk, type TestSessionHost } from './session-fakes.js';

const LEASE = '55555555-5555-4555-8555-555555555555';
const MARKER = { dev: 9, ms: 800, c: 0 };
const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

interface Rig {
  readonly t: TestSessionHost;
  readonly lease: LeaseTracker;
  readonly engine: RuntimeEngine;
  readonly runtime: PersonalVaultRuntime;
}

function rig(): Rig {
  const root = makeTempRoot('runtime-exits');
  roots.push(root);
  const t = makeTestSessionHost(root);
  t.knobs.userId = USER;
  const lease = new LeaseTracker();
  const engine = new RuntimeEngine();
  const deps: RuntimeDeps = {
    host: t.host,
    config: { syncRoot: root, machineDir: root, dataDir: root, deviceUuid: OWN, sessionNonce: NONCE },
    lineageId: LINEAGE,
    shared: true,
    fileName: 'Vault.conduit',
    client: new SessionClient(t.rpc, t.host),
    lease,
    replica: new RuntimeReplica().asReplica(),
  };
  const runtime = new PersonalVaultRuntime(deps);
  runtime.attachEngine(engine.asEngine());
  return { t, lease, engine, runtime };
}

const granted: AcquireResult = { kind: 'granted', leaseId: LEASE, limit: 1, sessions: [], serverNowMs: null, deviceCap: null, ownership: null };

function releases(r: Rig): readonly Readonly<Record<string, unknown>>[] {
  return r.t.rpc.callsOf('vault_session_release').map((c) => c.args);
}

describe('release after displacement (6.6 step 3)', () => {
  it('Realtime-detected take-over: release carries the lease id, the marker and pending', async () => {
    const r = rig();
    r.t.rpc.handle('vault_session_release', () => rpcOk(null));
    r.runtime.start(granted);
    r.lease.markerPublished(MARKER);
    r.engine.final = { published: false, timedOut: true, pendingPublish: true, marker: null };
    r.t.realtime.push({ device_id: OWN, vault_key: LINEAGE, lease_id: LEASE, status: 'displaced', displaced_reason: 'takeover' });
    await r.t.clock.advance(20_000);
    expect(releases(r)).toHaveLength(1);
    expect(releases(r)[0]).toMatchObject({ p_lease_id: LEASE, p_pending: true });
  });

  it('heartbeat-detected take-over (Realtime missed, 12 row 27): the release is sent too', async () => {
    const r = rig();
    r.t.rpc.handle('vault_session_release', () => rpcOk(null));
    r.t.rpc.handle('vault_session_heartbeat', () => rpcOk({ status: 'displaced', reason: 'takeover', by: 'iPhone' }));
    r.runtime.start(granted);
    r.lease.markerPublished(MARKER);
    r.engine.final = { published: false, timedOut: true, pendingPublish: true, marker: null };
    await r.t.clock.advance(HEARTBEAT_MS + 20_000);
    expect(r.t.sessionEvents.last('vault:session-displaced')).toMatchObject({ reason: 'takeover', changesSaved: false });
    expect(releases(r)).toHaveLength(1);
    expect(releases(r)[0]).toMatchObject({ p_lease_id: LEASE, p_pending: true });
  });

  it('a heartbeat answering displaced during the final save does not drop the release', async () => {
    const r = rig();
    r.t.rpc.handle('vault_session_release', () => rpcOk(null));
    r.t.rpc.handle('vault_session_heartbeat', () => rpcOk({ status: 'displaced', reason: 'takeover', by: 'iPhone' }));
    r.runtime.start(granted);
    r.lease.markerPublished(MARKER);
    let open!: () => void;
    r.engine.finalGate = new Promise<void>((res) => (open = res));
    r.engine.final = { published: true, timedOut: false, pendingPublish: false, marker: null };
    await r.t.clock.advance(25_000);
    r.t.realtime.push({ device_id: OWN, vault_key: LINEAGE, lease_id: LEASE, status: 'displaced', displaced_reason: 'takeover' });
    await r.t.clock.advance(8_000);
    open();
    await r.t.clock.advance(20_000);
    expect(r.t.sessionEvents.last('vault:session-displaced')).toMatchObject({ reason: 'takeover' });
    expect(releases(r)).toHaveLength(1);
    expect(releases(r)[0]).toMatchObject({ p_lease_id: LEASE });
  });
});

describe('lock or quit during a displacement (6.6 steps 2-3)', () => {
  it('waits for the displaced final save before reporting the vault closed', async () => {
    const r = rig();
    r.t.rpc.handle('vault_session_release', () => rpcOk(null));
    r.runtime.start(granted);
    let open!: () => void;
    r.engine.finalGate = new Promise<void>((res) => (open = res));
    r.engine.final = { published: true, timedOut: false, pendingPublish: false, marker: null };
    r.t.realtime.push({ device_id: OWN, vault_key: LINEAGE, lease_id: LEASE, status: 'displaced', displaced_reason: 'takeover' });
    await r.t.clock.advance(1_000);
    expect(r.engine.calls).toContain('final:displaced');
    let outcome: unknown = null;
    void r.runtime.lock().then((res) => (outcome = res));
    await r.t.clock.advance(10);
    expect(outcome).toBeNull();
    open();
    await r.t.clock.advance(1_000);
    expect(outcome).toMatchObject({ published: true, pendingPublish: false });
    expect(r.runtime.isSoftLocked()).toBe(true);
    expect(r.engine.calls.filter((c) => c.startsWith('final:'))).toEqual(['final:displaced']);
    expect(releases(r)).toHaveLength(1);
  });
});

describe('lock and conflict answers', () => {
  it('a denied acquire retry during the lock final cycle leaves no timer and never soft-locks', async () => {
    const r = rig();
    r.runtime.start({ kind: 'unconfirmed', reason: 'network', detail: 'network' });
    r.t.rpc.enqueue('vault_session_acquire', denied());
    await r.t.clock.advance(OFFLINE_RETRY_MS - 1_000);
    let release!: () => void;
    r.engine.finalGate = new Promise<void>((res) => (release = res));
    const locking = r.runtime.lock();
    await r.t.clock.advance(1_500);
    release();
    await locking;
    expect(r.t.clock.pending()).toBe(0);
    expect(r.t.sessionEvents.of('vault:session-conflict')).toEqual([]);
    await r.t.clock.advance(RECONNECT_ANSWER_MS);
    expect(r.t.access.log).toEqual([]);
    expect(r.t.sessionEvents.of('vault:session-displaced')).toEqual([]);
  });

  it('[Use here instead] after the 60 s soft lock sends no take-over', async () => {
    const r = rig();
    r.t.rpc.enqueue('vault_session_acquire', denied(), grantedAnswer('55555555-5555-4555-8555-555555555556'));
    r.runtime.start({ kind: 'unconfirmed', reason: 'network', detail: 'network' });
    await r.t.clock.advance(OFFLINE_RETRY_MS);
    await r.t.clock.advance(RECONNECT_ANSWER_MS);
    expect(r.runtime.isSoftLocked()).toBe(true);
    const before = r.t.rpc.callsOf('vault_session_acquire').length;
    await r.runtime.answerConflict('use-here');
    expect(r.t.rpc.callsOf('vault_session_acquire')).toHaveLength(before);
    expect(r.lease.state().kind).not.toBe('confirmed');
  });
});
