// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HEARTBEAT_MS, OFFLINE_RETRY_MS } from '../heartbeat.js';
import type { RpcResult } from '../host.js';
import { LEASE, LEASE_2, NONCE, OTHER, VAULT } from './session-client-fixtures.js';
import { HeartbeatHarness, deferred, denied, displacedAnswer, granted, lost, offline, okBeat } from './heartbeat-harness.js';
import { rpcFail, rpcOk } from './session-fakes.js';

describe('HeartbeatLoop: lost, displaced, offline, sleep', () => {
  let h: HeartbeatHarness;

  beforeEach(() => {
    h = new HeartbeatHarness();
  });

  afterEach(() => {
    h.dispose();
  });

  it('T-FS-68: a heartbeat after release gets lost/released, acquires again and never revives the old lease', async () => {
    h.t.rpc.enqueue('vault_session_heartbeat', lost('released'), okBeat());
    h.t.rpc.enqueue('vault_session_acquire', granted(LEASE_2));
    h.startConfirmed();
    await h.t.clock.advance(HEARTBEAT_MS);
    expect(h.acquires()).toHaveLength(1);
    expect(h.acquires()[0].args).toMatchObject({ p_takeover: false, p_session_nonce: NONCE, p_vault_key: VAULT });
    expect(h.lease.leaseId()).toBe(LEASE_2);
    await h.t.clock.advance(HEARTBEAT_MS);
    expect(h.beats().map((c) => c.args.p_lease_id)).toEqual([LEASE, LEASE_2]);
    expect(h.rec.displaced).toEqual([]);
    expect(h.rec.conflicts).toEqual([]);
  });

  it('a released answer acknowledges the marker (the UPDATE ran)', async () => {
    h.t.rpc.enqueue('vault_session_heartbeat', lost('released'));
    h.t.rpc.enqueue('vault_session_acquire', granted(LEASE_2));
    h.startConfirmed();
    h.lease.markerPublished({ dev: 42, ms: 1000, c: 1 });
    await h.loop.beatNow();
    expect(h.lease.markerToSend()).toBeNull();
  });

  it('a lost/unknown answer does not acknowledge the marker; it is sent again with the new lease', async () => {
    h.t.rpc.enqueue('vault_session_heartbeat', lost('unknown'), okBeat());
    h.t.rpc.enqueue('vault_session_acquire', granted(LEASE_2));
    h.startConfirmed();
    h.lease.markerPublished({ dev: 42, ms: 1000, c: 1 });
    await h.loop.beatNow();
    await h.loop.beatNow();
    expect(h.beats().map((c) => [c.args.p_lease_id, c.args.p_written_vv])).toEqual([
      [LEASE, { '42': [1000, 1] }],
      [LEASE_2, { '42': [1000, 1] }],
    ]);
  });

  it('displaced by the server: reports reason and device, then stops scheduling', async () => {
    h.t.rpc.enqueue('vault_session_heartbeat', displacedAnswer('takeover', 'iPhone'));
    h.startConfirmed();
    await h.t.clock.advance(HEARTBEAT_MS);
    expect(h.rec.displaced).toEqual([['takeover', 'iPhone']]);
    expect(h.t.clock.pending()).toBe(0);
    await h.t.clock.advance(10 * HEARTBEAT_MS);
    expect(h.beats()).toHaveLength(1);
    expect(await h.loop.beatNow()).toBeNull();
  });

  it('T-FS-24: a plan downgrade displaces with plan_limit', async () => {
    h.t.rpc.enqueue('vault_session_heartbeat', okBeat(-1), displacedAnswer('plan_limit', "Chris's MacBook"));
    h.startConfirmed(-1);
    await h.t.clock.advance(2 * HEARTBEAT_MS);
    expect(h.rec.displaced).toEqual([['plan_limit', "Chris's MacBook"]]);
    expect(h.t.clock.pending()).toBe(0);
  });

  it('T-FS-55: superseded by another running copy with this device identity', async () => {
    h.t.rpc.enqueue('vault_session_heartbeat', lost('superseded'));
    h.startConfirmed();
    await h.t.clock.advance(HEARTBEAT_MS);
    expect(h.rec.displaced).toEqual([['superseded', null]]);
    expect(h.acquires()).toHaveLength(0);
    expect(h.t.clock.pending()).toBe(0);
  });

  it('T-FS-35: an unconfirmed heartbeat keeps beating every 30 s and flips confirmation both ways', async () => {
    h.t.rpc.enqueue('vault_session_heartbeat', offline(), rpcFail({ kind: 'http', status: 503 }), okBeat());
    h.startConfirmed();
    await h.t.clock.advance(HEARTBEAT_MS);
    expect(h.rec.leaseChanged).toEqual([false]);
    await h.t.clock.advance(HEARTBEAT_MS);
    expect(h.rec.leaseChanged).toEqual([false]);
    await h.t.clock.advance(HEARTBEAT_MS);
    expect(h.beats().map((c) => c.args.p_lease_id)).toEqual([LEASE, LEASE, LEASE]);
    expect(h.rec.leaseChanged).toEqual([false, true]);
    expect(h.acquires()).toHaveLength(0);
  });

  it('an oversize payload (23514) is unconfirmed, never a displacement', async () => {
    h.t.rpc.enqueue('vault_session_heartbeat', rpcFail({ kind: 'postgres', status: 400, code: '23514' }));
    h.startConfirmed();
    await h.loop.beatNow();
    expect(h.lease.state()).toMatchObject({ kind: 'unconfirmed', leaseId: LEASE, reason: 'constraint' });
    expect(h.rec.displaced).toEqual([]);
    expect(h.t.clock.pending()).toBe(1);
  });

  it('6.8: offline at start retries acquire every 60 s, then a live holder raises one reconnect conflict', async () => {
    h.t.rpc.enqueue('vault_session_acquire', offline(), offline(), denied(), denied());
    h.lease.onAcquire({ kind: 'unconfirmed', reason: 'network', detail: 'network' }, h.t.clock.now());
    h.loop.start();
    await h.t.clock.advance(OFFLINE_RETRY_MS - 1);
    expect(h.acquires()).toHaveLength(0);
    await h.t.clock.advance(1);
    expect(h.acquires()).toHaveLength(1);
    await h.t.clock.advance(2 * OFFLINE_RETRY_MS);
    expect(h.acquires()).toHaveLength(3);
    expect(h.rec.conflicts).toHaveLength(1);
    expect(h.rec.conflicts[0][0]).toMatchObject({ deviceId: OTHER, busySessions: 3, busyJobs: 1 });
    await h.t.clock.advance(OFFLINE_RETRY_MS);
    expect(h.acquires()).toHaveLength(4);
    expect(h.rec.conflicts).toHaveLength(1);
    expect(h.beats()).toHaveLength(0);
    expect(h.acquires().every((c) => c.args.p_takeover === false)).toBe(true);
  });

  it('offline at start, then granted: starts beating 30 s later and reports the lease and limit', async () => {
    h.t.rpc.enqueue('vault_session_acquire', granted(LEASE_2, 1));
    h.t.rpc.handle('vault_session_heartbeat', () => okBeat());
    h.lease.onAcquire({ kind: 'unconfirmed', reason: 'timeout', detail: 'timeout' }, h.t.clock.now());
    h.loop.start();
    await h.t.clock.advance(OFFLINE_RETRY_MS);
    expect(h.rec.leaseChanged).toEqual([true]);
    expect(h.rec.limits).toEqual([1]);
    await h.t.clock.advance(HEARTBEAT_MS);
    expect(h.beats().map((c) => c.args.p_lease_id)).toEqual([LEASE_2]);
  });

  it('a lost lease that meets another holder raises the conflict, and a later grant resumes beating', async () => {
    h.t.rpc.enqueue('vault_session_heartbeat', lost('expired'), okBeat());
    h.t.rpc.enqueue('vault_session_acquire', denied(), granted(LEASE_2));
    h.startConfirmed();
    await h.t.clock.advance(HEARTBEAT_MS);
    expect(h.rec.conflicts).toHaveLength(1);
    expect(h.t.clock.pending()).toBe(1);
    await h.t.clock.advance(OFFLINE_RETRY_MS);
    expect(h.lease.leaseId()).toBe(LEASE_2);
    expect(h.rec.leaseChanged).toEqual([false, true]);
    await h.t.clock.advance(HEARTBEAT_MS);
    expect(h.beats().map((c) => c.args.p_lease_id)).toEqual([LEASE, LEASE_2]);
  });

  it('a take-over answered by the runtime steers the loop back to beating on beatNow', async () => {
    h.t.rpc.enqueue('vault_session_heartbeat', lost('expired'), okBeat());
    h.t.rpc.enqueue('vault_session_acquire', denied());
    h.startConfirmed();
    await h.loop.beatNow();
    expect(h.rec.conflicts).toHaveLength(1);
    h.lease.onAcquire({ kind: 'granted', leaseId: LEASE_2, limit: 1, sessions: [], serverNowMs: null }, h.t.clock.now());
    await h.loop.beatNow();
    expect(h.beats().map((c) => c.args.p_lease_id)).toEqual([LEASE, LEASE_2]);
    expect(h.acquires()).toHaveLength(1);
  });

  it('suspend cancels timers; resume beats at once and restarts the cadence', async () => {
    h.t.rpc.handle('vault_session_heartbeat', () => okBeat());
    h.startConfirmed();
    await h.t.clock.advance(HEARTBEAT_MS);
    h.t.power.suspend();
    expect(h.t.clock.pending()).toBe(0);
    await h.t.clock.advance(10 * HEARTBEAT_MS);
    expect(h.beats()).toHaveLength(1);
    expect(await h.loop.beatNow()).toBeNull();
    h.t.power.resume();
    await h.t.clock.advance(0);
    expect(h.beats()).toHaveLength(2);
    await h.t.clock.advance(HEARTBEAT_MS);
    expect(h.beats()).toHaveLength(3);
  });

  it('T-FS-27: waking after the lease lapsed reports unconfirmed, then lost/expired triggers a normal acquire', async () => {
    h.t.rpc.enqueue('vault_session_heartbeat', okBeat(), lost('expired'));
    h.t.rpc.enqueue('vault_session_acquire', granted(LEASE_2));
    h.startConfirmed();
    await h.t.clock.advance(HEARTBEAT_MS);
    h.loop.suspend();
    h.loop.suspend();
    await h.t.clock.advance(20 * HEARTBEAT_MS);
    h.loop.resume();
    h.loop.resume();
    await h.t.clock.advance(0);
    expect(h.rec.leaseChanged).toEqual([false, true]);
    expect(h.acquires()).toHaveLength(1);
    expect(h.acquires()[0].args.p_takeover).toBe(false);
    expect(h.beats()).toHaveLength(2);
  });

  it('T-FS-27: a displaced answer on waking goes to the displacement handler', async () => {
    h.t.rpc.enqueue('vault_session_heartbeat', displacedAnswer('takeover', 'iPhone'));
    h.startConfirmed();
    h.loop.suspend();
    await h.t.clock.advance(20 * HEARTBEAT_MS);
    h.loop.resume();
    await h.t.clock.advance(0);
    expect(h.rec.displaced).toEqual([['takeover', 'iPhone']]);
    expect(h.acquires()).toHaveLength(0);
  });

  it('a grant that arrives after stop is released at once', async () => {
    const late = deferred<RpcResult>();
    h.t.rpc.handle('vault_session_acquire', () => late.promise);
    h.t.rpc.enqueue('vault_session_release', rpcOk(null));
    h.lease.onAcquire({ kind: 'unconfirmed', reason: 'network', detail: 'network' }, h.t.clock.now());
    h.loop.start();
    const run = h.loop.beatNow();
    h.loop.stop();
    late.resolve(granted(LEASE_2));
    expect(await run).toBeNull();
    const releases = h.t.rpc.callsOf('vault_session_release');
    expect(releases).toHaveLength(1);
    expect(releases[0].args).toMatchObject({ p_lease_id: LEASE_2, p_written_vv: null, p_pending: false });
    expect(h.lease.leaseId()).toBeNull();
  });
});
