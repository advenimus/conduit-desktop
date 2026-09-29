// @vitest-environment node
// The FakeSessionServer against the real SessionClient, HeartbeatLoop and SessionRealtime (spec
// 9.5 SQL, 12 rows 24/55/67/68): take-over order, plan-limit ranking on heartbeat, superseded
// nonces, never-revive, markers and abandon, the JSON and auth guards, and Realtime rows.
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock, MemoryLogger, flushAsync, makeTempRoot } from '../../sync/__tests__/host-fakes.js';
import { LEASE_TTL_MS, LeaseTracker } from '../lease.js';
import { SessionRealtime } from '../realtime.js';
import { SessionClient, type AcquireArgs, type AcquireResult, type HeartbeatArgs } from '../session-client.js';
import { uncoveredSideFilesFlag } from '../session-runtime-parts.js';
import type { ReplicaPort } from '../../sync/replica.js';
import type { DisplacementReason } from '../host.js';
import { FakeSessionServer } from './fake-session-server.js';

const USER = '11111111-1111-4111-8111-111111111111';
const VAULT = '22222222-2222-4222-8222-222222222222';
const DEV_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const DEV_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const DEV_C = 'cccccccc-3333-4333-8333-333333333333';
const NONCE_1 = '66666666-6666-4666-8666-666666666661';
const NONCE_2 = '66666666-6666-4666-8666-666666666662';
const FILE = '77777777-7777-4777-8777-777777777777';

const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

interface World {
  readonly clock: FakeClock;
  readonly server: FakeSessionServer;
  readonly logger: MemoryLogger;
  client(userId?: string | null): SessionClient;
}

function world(): World {
  roots.push(makeTempRoot('session-server'));
  const clock = new FakeClock();
  const server = new FakeSessionServer(clock);
  const logger = new MemoryLogger();
  return {
    clock,
    server,
    logger,
    client: (userId: string | null = USER) => new SessionClient(server.clientFor(userId), { account: { userId: () => userId ?? 'x' }, logger }),
  };
}

function acquireArgs(deviceId: string, name: string, over: Partial<AcquireArgs> = {}): AcquireArgs {
  return {
    vaultKey: VAULT,
    deviceId,
    sessionNonce: NONCE_1,
    deviceName: name,
    platform: 'macos',
    appVersion: '0.18.0',
    fileName: 'Vault.conduit',
    fileId: FILE,
    location: 'icloud:Vaults',
    takeover: false,
    claim: true,
    ...over,
  };
}

function beatArgs(deviceId: string, leaseId: string, over: Partial<HeartbeatArgs> = {}): HeartbeatArgs {
  return {
    vaultKey: VAULT,
    deviceId,
    leaseId,
    active: true,
    busy: { sessions: 0, jobs: 0 },
    flags: { sideFiles: false },
    fileName: null,
    fileId: null,
    location: null,
    marker: null,
    pending: false,
    ...over,
  };
}

function leaseOf(r: AcquireResult): string {
  if (r.kind !== 'granted') throw new Error(`expected a grant, got ${r.kind}`);
  return r.leaseId;
}

describe('FakeSessionServer (9.5)', () => {
  it('Free: a second device is denied with the holder, then takes over; the first learns it on its heartbeat', async () => {
    const w = world();
    const c = w.client();
    const leaseA = leaseOf(await c.acquire(acquireArgs(DEV_A, 'MacBook')));
    const denied = await c.acquire(acquireArgs(DEV_B, 'Windows PC'));
    expect(denied).toMatchObject({ kind: 'denied', limit: 1 });
    expect(denied.kind === 'denied' && denied.holders.map((h) => h.deviceName)).toEqual(['MacBook']);
    expect(await c.peek({ vaultKey: VAULT, deviceId: DEV_B })).toMatchObject({ kind: 'ok', limit: 1 });
    leaseOf(await c.acquire(acquireArgs(DEV_B, 'Windows PC', { takeover: true })));
    expect(await c.heartbeat(beatArgs(DEV_A, leaseA))).toEqual({ kind: 'displaced', reason: 'takeover', byDeviceName: 'Windows PC', minVersion: null, released: false });
  });

  it('take-over displaces idle devices before busy ones', async () => {
    const w = world();
    const c = w.client();
    w.server.setLimit(USER, 2);
    const leaseA = leaseOf(await c.acquire(acquireArgs(DEV_A, 'A')));
    await w.clock.advance(1_000);
    const leaseB = leaseOf(await c.acquire(acquireArgs(DEV_B, 'B')));
    await c.heartbeat(beatArgs(DEV_A, leaseA, { busy: { sessions: 2, jobs: 0 } }));
    leaseOf(await c.acquire(acquireArgs(DEV_C, 'C', { takeover: true })));
    expect(await c.heartbeat(beatArgs(DEV_B, leaseB))).toMatchObject({ kind: 'displaced', reason: 'takeover' });
    expect(await c.heartbeat(beatArgs(DEV_A, leaseA))).toMatchObject({ kind: 'ok' });
  });

  it('12 row 24: Pro becomes Free: the next heartbeat keeps the busy device, then the most recent', async () => {
    const w = world();
    const c = w.client();
    w.server.setLimit(USER, -1);
    const leases = new Map<string, string>();
    for (const [dev, name] of [[DEV_A, 'MacBook'], [DEV_B, 'Windows PC'], [DEV_C, 'iPhone']] as const) {
      leases.set(dev, leaseOf(await c.acquire(acquireArgs(dev, name))));
      await w.clock.advance(1_000);
    }
    await c.heartbeat(beatArgs(DEV_A, leases.get(DEV_A)!, { busy: { sessions: 3, jobs: 1 } }));
    w.server.setLimit(USER, 1);
    expect(await c.heartbeat(beatArgs(DEV_C, leases.get(DEV_C)!))).toEqual({ kind: 'displaced', reason: 'plan_limit', byDeviceName: 'MacBook', minVersion: null, released: false });
    expect(await c.heartbeat(beatArgs(DEV_B, leases.get(DEV_B)!))).toMatchObject({ kind: 'displaced', reason: 'plan_limit' });
    expect(await c.heartbeat(beatArgs(DEV_A, leases.get(DEV_A)!, { busy: { sessions: 3, jobs: 1 } }))).toMatchObject({ kind: 'ok', limit: 1 });
  });

  it('5.5: an idle device that reports side files again after the click pauses the confirming device again', async () => {
    const w = world();
    const c = w.client();
    w.server.setLimit(USER, -1);
    const leaseA = leaseOf(await c.acquire(acquireArgs(DEV_A, 'MacBook')));
    const leaseB = leaseOf(await c.acquire(acquireArgs(DEV_B, 'Windows PC')));
    await c.heartbeat(beatArgs(DEV_B, leaseB, { flags: { sideFiles: true } }));
    await w.clock.advance(5_000);
    const confirmedAtMs = w.clock.now();
    const replica = { local: () => ({ sideFilesConfirmedAtMs: confirmedAtMs }) } as unknown as ReplicaPort;
    const lease = new LeaseTracker();
    const viewOfA = async (): Promise<boolean> => {
      lease.onHeartbeat(await c.heartbeat(beatArgs(DEV_A, leaseA)), w.clock.now());
      return uncoveredSideFilesFlag(lease, replica, w.logger, w.clock.now());
    };
    lease.onAcquire({ kind: 'granted', leaseId: leaseA, limit: -1, sessions: [], serverNowMs: null, deviceCap: null, ownership: null }, w.clock.now());
    expect(await viewOfA()).toBe(false);
    await w.clock.advance(5_000);
    await c.heartbeat(beatArgs(DEV_B, leaseB, { active: false, flags: { sideFiles: true } }));
    const rowB = () => lease.sessions().find((r) => r.deviceId === DEV_B);
    expect(await viewOfA()).toBe(true);
    expect(rowB()!.lastActiveMs).toBeLessThan(confirmedAtMs);
    expect(rowB()!.heartbeatAtMs).toBeGreaterThan(confirmedAtMs);
    await c.heartbeat(beatArgs(DEV_B, leaseB, { active: false, flags: { sideFiles: false } }));
    expect(await viewOfA()).toBe(false);
  });

  it('12 row 55: the same device id with another nonce supersedes the older copy', async () => {
    const w = world();
    const c = w.client();
    const first = leaseOf(await c.acquire(acquireArgs(DEV_A, 'Linux VM')));
    leaseOf(await c.acquire(acquireArgs(DEV_A, 'Linux VM', { sessionNonce: NONCE_2 })));
    expect(await c.heartbeat(beatArgs(DEV_A, first))).toEqual({ kind: 'lost', reason: 'superseded' });
  });

  it('12 row 68: a heartbeat after release is lost/released and never revives the row', async () => {
    const w = world();
    const c = w.client();
    const lease = leaseOf(await c.acquire(acquireArgs(DEV_A, 'MacBook')));
    expect(await c.release({ vaultKey: VAULT, deviceId: DEV_A, leaseId: lease, marker: null, pending: false })).toEqual({ kind: 'ok' });
    expect(await c.heartbeat(beatArgs(DEV_A, lease))).toEqual({ kind: 'lost', reason: 'released' });
    expect(w.server.rows()[0]).toMatchObject({ status: 'released' });
    expect(await c.acquire(acquireArgs(DEV_B, 'PC'))).toMatchObject({ kind: 'granted' });
  });

  it('a lease not renewed for 90 s expires; its heartbeat is lost/expired', async () => {
    const w = world();
    const c = w.client();
    const lease = leaseOf(await c.acquire(acquireArgs(DEV_A, 'MacBook')));
    await w.clock.advance(LEASE_TTL_MS + 1);
    expect(await c.heartbeat(beatArgs(DEV_A, lease))).toEqual({ kind: 'lost', reason: 'expired' });
    expect(w.server.rows()[0]).toMatchObject({ status: 'expired' });
  });

  it('records markers whatever the status; abandon holds until a new marker is reported (12 row 67)', async () => {
    const w = world();
    const c = w.client();
    w.server.setLimit(USER, -1);
    const leaseB = leaseOf(await c.acquire(acquireArgs(DEV_B, 'iPhone')));
    await c.heartbeat(beatArgs(DEV_B, leaseB, { marker: { dev: 9, ms: 700, c: 0 }, pending: true }));
    const seen = await c.acquire(acquireArgs(DEV_A, 'MacBook'));
    expect(seen.kind === 'granted' && seen.sessions[0]).toMatchObject({ deviceId: DEV_B, marker: { dev: 9, ms: 700, c: 0 }, abandoned: false, pendingChanges: true });
    await c.abandon({ vaultKey: VAULT, deviceId: DEV_A, targetDeviceId: DEV_B });
    await c.heartbeat(beatArgs(DEV_B, leaseB));
    expect(w.server.rows().find((r) => r.deviceId === DEV_B)?.abandonedAtMs).not.toBeNull();
    await c.heartbeat(beatArgs(DEV_B, leaseB, { marker: { dev: 9, ms: 800, c: 0 } }));
    expect(w.server.rows().find((r) => r.deviceId === DEV_B)?.abandonedAtMs).toBeNull();
  });

  it('maps the SQL guards to unconfirmed answers, never to denials', async () => {
    const w = world();
    const c = w.client();
    const lease = leaseOf(await c.acquire(acquireArgs(DEV_A, 'MacBook')));
    const raw = await w.server.clientFor(USER).call(
      'vault_session_heartbeat',
      { p_vault_key: VAULT, p_device_id: DEV_A, p_lease_id: lease, p_active: true, p_busy: { padding: 'x'.repeat(300) } },
      1_000,
    );
    expect(raw).toMatchObject({ ok: false, failure: { kind: 'postgres', code: '23514' } });
    const anon = new SessionClient(w.server.clientFor(null), { account: { userId: () => USER }, logger: w.logger });
    expect(await anon.peek({ vaultKey: VAULT, deviceId: DEV_A })).toMatchObject({ kind: 'unconfirmed', reason: 'auth' });
    expect(await anon.acquire(acquireArgs(DEV_B, 'PC'))).toMatchObject({ kind: 'unconfirmed', reason: 'auth' });
    w.server.failNext({ kind: 'network', status: null, code: null, message: 'offline' });
    expect(await c.heartbeat(beatArgs(DEV_A, lease))).toMatchObject({ kind: 'unconfirmed', reason: 'network' });
    expect(await c.heartbeat(beatArgs(DEV_A, lease))).toMatchObject({ kind: 'ok' });
  });

  it('too many sessions in a day is unconfirmed (too_many_sessions)', async () => {
    const w = world();
    const c = w.client();
    w.server.setLimit(USER, -1);
    // Refused acquires write no row, so the device cap must be off to reach the daily guard.
    w.server.plan.setDeviceCap(USER, -1);
    for (let i = 0; i < 201; i++) {
      const dev = `aaaaaaaa-1111-4111-8111-${i.toString(16).padStart(12, '0')}`;
      await c.acquire(acquireArgs(dev, `D${i}`));
    }
    expect(await c.acquire(acquireArgs(DEV_B, 'one more'))).toMatchObject({ kind: 'unconfirmed', reason: 'too-many-sessions' });
  });

  it('delivers own-row updates over Realtime: a take-over displaces the holder within the same turn', async () => {
    const w = world();
    const c = w.client();
    const lease = new LeaseTracker();
    lease.onAcquire(await c.acquire(acquireArgs(DEV_A, 'MacBook')), w.clock.now());
    const got: [DisplacementReason, string | null][] = [];
    const rt = new SessionRealtime({
      realtime: w.server.realtimeFor(USER),
      vaultKey: VAULT,
      deviceId: DEV_A,
      lease,
      host: { logger: w.logger },
      deviceName: () => 'Windows PC',
      onDisplaced: (reason, by) => got.push([reason, by]),
      sessionNonce: NONCE_1,
    });
    rt.start();
    await c.acquire(acquireArgs(DEV_B, 'Windows PC', { takeover: true, sessionNonce: NONCE_2 }));
    await flushAsync();
    expect(got).toEqual([['takeover', 'Windows PC']]);
    rt.stop();
    expect(w.server.subscriberCount()).toBe(0);
  });
});
