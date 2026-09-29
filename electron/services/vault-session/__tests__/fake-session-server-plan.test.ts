// @vitest-environment node
// The FakeSessionServer's plan enforcement (docs/PLAN_ENFORCEMENT.md 2.3-2.5, the SQL cases O*, D*
// and V* of 7.1) through the real SessionClient: owners and grace per vault and per pair, p_claim,
// release with its cooldown and released_by, the account device cap with also_locks and the
// cross-vault `by`, and the minimum version.
import { describe, expect, it } from 'vitest';
import { FakeClock, MemoryLogger } from '../../sync/__tests__/host-fakes.js';
import { SessionClient, type AcquireArgs, type AcquireResult, type HeartbeatArgs } from '../session-client.js';
import { FakeSessionServer } from './fake-session-server.js';

const DAY = 24 * 60 * 60 * 1000;
const A = '11111111-1111-4111-8111-111111111111';
const B = '11111111-1111-4111-8111-222222222222';
const L1 = '22222222-2222-4222-8222-222222222221';
const L2 = '22222222-2222-4222-8222-222222222222';
const L3 = '22222222-2222-4222-8222-222222222223';
const NONCE = '66666666-6666-4666-8666-666666666661';
const dev = (n: number): string => `dddddddd-1111-4111-8111-${n.toString(16).padStart(12, '0')}`;

function world() {
  const clock = new FakeClock();
  const server = new FakeSessionServer(clock);
  const logger = new MemoryLogger();
  const client = (userId: string) => new SessionClient(server.clientFor(userId), { account: { userId: () => userId }, logger });
  return { clock, server, client };
}

function args(vaultKey: string, deviceId: string, over: Partial<AcquireArgs> = {}): AcquireArgs {
  return {
    vaultKey,
    deviceId,
    sessionNonce: NONCE,
    deviceName: `Device ${deviceId.slice(-2)}`,
    platform: 'macos',
    appVersion: '0.18.0',
    fileName: 'Vault.conduit',
    fileId: null,
    location: null,
    takeover: false,
    claim: true,
    ...over,
  };
}

function beat(vaultKey: string, deviceId: string, leaseId: string, over: Partial<HeartbeatArgs> = {}): HeartbeatArgs {
  return { vaultKey, deviceId, leaseId, active: true, busy: null, flags: null, fileName: null, fileId: null, location: null, marker: null, pending: null, ...over };
}

/** Backdates the vault and pair clocks by 15 days (the SQL tests update the rows the same way). */
function endGrace(server: FakeSessionServer, vaultKey: string): void {
  const row = server.plan.owners.get(vaultKey);
  if (row?.graceStartedMs != null) server.plan.patchOwner(vaultKey, { graceStartedMs: row.graceStartedMs - 15 * DAY });
  server.plan.backdatePairs(15 * DAY);
}

function leaseOf(r: AcquireResult): string {
  if (r.kind !== 'granted') throw new Error(`expected a grant, got ${r.kind}`);
  return r.leaseId;
}

describe('ownership (O cases)', () => {
  it('O1/O2: the first account owns, another gets grace, and the owner sees shared_until', async () => {
    const w = world();
    w.server.setLimit(A, -1);
    w.server.setLimit(B, -1);
    const a = await w.client(A).acquire(args(L1, dev(1)));
    expect(a).toMatchObject({ kind: 'granted', ownership: { kind: 'owner', sharedUntilMs: null }, deviceCap: 5 });
    const b = await w.client(B).acquire(args(L1, dev(2)));
    expect(b).toMatchObject({ kind: 'granted', ownership: { kind: 'grace', untilMs: w.clock.now() + 14 * DAY } });
    const hb = await w.client(A).heartbeat(beat(L1, dev(1), leaseOf(a)));
    expect(hb).toMatchObject({ kind: 'ok', ownership: { kind: 'owner', sharedUntilMs: w.clock.now() + 14 * DAY } });
  });

  it('O3/O4: after grace another account is refused, and its open lease is displaced not_owner', async () => {
    const w = world();
    await w.client(A).acquire(args(L1, dev(1)));
    const b = await w.client(B).acquire(args(L1, dev(2)));
    endGrace(w.server, L1);
    expect(await w.client(B).heartbeat(beat(L1, dev(2), leaseOf(b)))).toEqual({ kind: 'displaced', reason: 'not_owner', byDeviceName: null, minVersion: null, released: false });
    const again = await w.client(B).acquire(args(L1, dev(3)));
    expect(again).toMatchObject({ kind: 'not-owner', released: false });
    expect(w.server.rows().filter((r) => r.deviceId === dev(3))).toEqual([]);
  });

  it('O5/O6/O13: release waits for the cooldown, hands over to the next claim, and the ex-owner reads released', async () => {
    const w = world();
    const c = w.client(A);
    await c.acquire(args(L1, dev(1)));
    expect(await c.releaseOwnership(L1)).toMatchObject({ released: false, reason: 'too_soon' });
    w.clock.advance(8 * DAY);
    expect(await c.releaseOwnership(L1)).toEqual({ released: true });
    expect(await w.client(B).acquire(args(L1, dev(2)))).toMatchObject({ kind: 'granted', ownership: { kind: 'owner' } });
    expect(await c.acquire(args(L1, dev(3)))).toMatchObject({ kind: 'granted', ownership: { kind: 'grace' } });
    endGrace(w.server, L1);
    expect(await c.acquire(args(L1, dev(3)))).toMatchObject({ kind: 'not-owner', released: true });
    expect(await w.client(B).releaseOwnership(L1)).toMatchObject({ released: false, reason: 'too_soon' });
    expect(await c.releaseOwnership(L1)).toEqual({ released: false, reason: 'not_owner' });
  });

  it('O7/O11: a re-acquire with p_claim false never claims', async () => {
    const w = world();
    w.server.setLimit(A, -1);
    const c = w.client(A);
    expect(await c.acquire(args(L1, dev(1), { claim: false }))).toMatchObject({ kind: 'granted', ownership: { kind: 'unowned' } });
    expect(w.server.plan.owners.size).toBe(0);
    await c.acquire(args(L1, dev(1)));
    w.clock.advance(8 * DAY);
    await c.releaseOwnership(L1);
    expect(await c.acquire(args(L1, dev(2), { claim: false }))).toMatchObject({ ownership: { kind: 'unowned' } });
    expect(w.server.plan.owners.get(L1)?.ownerId).toBeNull();
  });

  it('O10: the pair clock follows a copy into a new lineage', async () => {
    const w = world();
    await w.client(A).acquire(args(L1, dev(1)));
    await w.client(B).acquire(args(L1, dev(2)));
    endGrace(w.server, L1);
    expect(await w.client(B).acquire(args(L2, dev(3)))).toMatchObject({ kind: 'granted', ownership: { kind: 'owner' } });
    expect(await w.client(A).acquire(args(L2, dev(4)))).toMatchObject({ kind: 'not-owner' });
  });

  it('O12: refused acquires write no owner or pair row', async () => {
    const w = world();
    w.server.plan.setDeviceCap(B, 1);
    const b = w.client(B);
    await b.acquire(args(L2, dev(1)));
    expect(await b.acquire(args(L1, dev(2)))).toMatchObject({ kind: 'denied', cause: 'device_cap' });
    expect(w.server.plan.owners.has(L1)).toBe(false);
    expect(w.server.plan.pairs.size).toBe(0);
  });
});

describe('device cap (D cases)', () => {
  async function fill(w: ReturnType<typeof world>, n: number): Promise<void> {
    w.server.setLimit(A, -1);
    for (let i = 1; i <= n; i++) {
      await w.client(A).acquire(args(i % 2 === 0 ? L2 : L1, dev(i)));
      w.clock.advance(1_000);
    }
  }

  it('D1/D5: a sixth device is refused with the least recent idle device first; peek says so too', async () => {
    const w = world();
    await fill(w, 5);
    const res = await w.client(A).acquire(args(L1, dev(6)));
    expect(res).toMatchObject({ kind: 'denied', cause: 'device_cap', deviceCap: 5 });
    if (res.kind !== 'denied') return;
    expect(res.holders).toHaveLength(5);
    expect(res.holders[0]?.deviceId).toBe(dev(1));
    expect(res.holders[0]?.vaults).toBe(1);
    const peek = await w.client(A).peek({ vaultKey: L1, deviceId: dev(6) });
    expect(peek).toMatchObject({ kind: 'ok', refusal: { kind: 'device-cap', deviceCap: 5 } });
  });

  it('D2/D8: a take-over displaces every vault of the least recent device, and its heartbeat names the new device', async () => {
    const w = world();
    await fill(w, 5);
    const first = w.server.rows().find((r) => r.deviceId === dev(1))!;
    expect(await w.client(A).acquire(args(L2, dev(6), { takeover: true, deviceName: 'New PC' }))).toMatchObject({ kind: 'granted' });
    expect(w.server.rows().filter((r) => r.deviceId === dev(1)).map((r) => r.status)).toEqual(['displaced']);
    expect(await w.client(A).heartbeat(beat(L1, dev(1), first.leaseId))).toEqual({
      kind: 'displaced',
      reason: 'device_cap',
      byDeviceName: 'New PC',
      minVersion: null,
      released: false,
    });
  });

  it('D3: a device that already holds another vault is not a new device', async () => {
    const w = world();
    await fill(w, 5);
    expect(await w.client(A).acquire(args(L2, dev(1)))).toMatchObject({ kind: 'granted' });
  });

  it('D4: lowering the cap displaces extra devices on their next heartbeat, keeping the busy one', async () => {
    const w = world();
    w.server.setLimit(A, -1);
    const leases = new Map<string, string>();
    for (let i = 1; i <= 3; i++) {
      leases.set(dev(i), leaseOf(await w.client(A).acquire(args(L1, dev(i)))));
      w.clock.advance(1_000);
    }
    await w.client(A).heartbeat(beat(L1, dev(1), leases.get(dev(1))!, { busy: { sessions: 2, jobs: 0 }, active: false }));
    w.server.plan.setDeviceCap(A, 1);
    expect(await w.client(A).heartbeat(beat(L1, dev(3), leases.get(dev(3))!))).toMatchObject({ kind: 'displaced', reason: 'device_cap' });
    expect(w.server.rows().find((r) => r.deviceId === dev(1))?.status).toBe('active');
  });

  it('D6/D7: a Free vault-limit denial names the device the cap would also lock', async () => {
    const w = world();
    w.server.plan.setDeviceCap(A, 2);
    await w.client(A).acquire(args(L1, dev(1)));
    w.clock.advance(1_000);
    await w.client(A).acquire(args(L2, dev(2), { deviceName: 'Old PC' }));
    w.clock.advance(1_000);
    await w.client(A).acquire(args(L3, dev(1)));
    w.clock.advance(1_000);
    const res = await w.client(A).acquire(args(L1, dev(3)));
    expect(res).toMatchObject({ kind: 'denied', cause: 'vault_limit', alsoLocks: { deviceId: dev(2), deviceName: 'Old PC' } });
    const solo = world();
    solo.server.plan.setDeviceCap(A, 1);
    await solo.client(A).acquire(args(L1, dev(1)));
    expect(await solo.client(A).acquire(args(L1, dev(3)))).toMatchObject({ kind: 'denied', cause: 'vault_limit', alsoLocks: null });
  });
});

describe('minimum version (V cases)', () => {
  it('V1/V2: acquire refuses below the minimum and an open lease is displaced on its heartbeat', async () => {
    const w = world();
    const lease = leaseOf(await w.client(A).acquire(args(L1, dev(1))));
    w.server.plan.minVersion = { desktop: '0.19.0', ios: '0.0.0' };
    expect(await w.client(A).acquire(args(L1, dev(2)))).toMatchObject({ kind: 'update-required', minVersion: '0.19.0' });
    expect(await w.client(A).heartbeat(beat(L1, dev(1), lease))).toEqual({
      kind: 'displaced',
      reason: 'update_required',
      byDeviceName: null,
      minVersion: '0.19.0',
      released: false,
    });
    expect(await w.client(A).acquire(args(L1, dev(3), { appVersion: '0.19.0' }))).toMatchObject({ kind: 'granted' });
  });

  it('peek answers update_required before the password when it sends the version', async () => {
    const w = world();
    w.server.plan.minVersion = { desktop: '1.0.0', ios: '0.0.0' };
    const logger = new MemoryLogger();
    const withDevice = new SessionClient(w.server.clientFor(A), {
      account: { userId: () => A },
      logger,
      device: { current: () => ({ name: 'Mac', platform: 'macos', appVersion: '0.18.0' }) } as never,
    });
    expect(await withDevice.peek({ vaultKey: L1, deviceId: dev(1) })).toMatchObject({ kind: 'ok', refusal: { kind: 'update-required', minVersion: '1.0.0' } });
  });
});
