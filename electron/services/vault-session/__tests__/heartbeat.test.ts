// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTIVE_WINDOW_MS, HEARTBEAT_MS, OFFLINE_RETRY_MS, isActive } from '../heartbeat.js';
import type { RpcResult } from '../host.js';
import { FILE_ID, LEASE, VAULT, DEVICE } from './session-client-fixtures.js';
import { HeartbeatHarness, deferred, offline, okBeat } from './heartbeat-harness.js';

describe('isActive', () => {
  const now = 1_000_000;
  it.each([
    ['focused now', 500, true, null, true],
    ['idle under 60 s', 59, false, null, true],
    ['idle exactly 60 s', 60, false, null, false],
    ['focused 60 s ago', 500, false, now - ACTIVE_WINDOW_MS, true],
    ['focused 61 s ago', 500, false, now - ACTIVE_WINDOW_MS - 1000, false],
    ['never focused and idle', 500, false, null, false],
    ['idle time unknown', Number.NaN, false, null, false],
  ])('%s', (_label, idle, focused, lastFocus, expected) => {
    expect(isActive(now, idle as number, focused as boolean, lastFocus as number | null)).toBe(expected);
  });
});

describe('HeartbeatLoop: cadence and payload', () => {
  let h: HeartbeatHarness;

  beforeEach(() => {
    h = new HeartbeatHarness();
  });

  afterEach(() => {
    h.dispose();
  });

  it('beats every 30 s with the lease, activity, busy counts, flags, file hint and pending flag', async () => {
    h.t.rpc.handle('vault_session_heartbeat', () => okBeat());
    h.t.busy.report = { sessions: 3, jobs: 1 };
    h.startConfirmed();
    await h.t.clock.advance(HEARTBEAT_MS - 1);
    expect(h.beats()).toHaveLength(0);
    await h.t.clock.advance(1);
    expect(h.beats()).toHaveLength(1);
    await h.t.clock.advance(2 * HEARTBEAT_MS);
    expect(h.beats()).toHaveLength(3);
    expect(h.beats()[0].args).toEqual({
      p_vault_key: VAULT,
      p_device_id: DEVICE,
      p_lease_id: LEASE,
      p_active: true,
      p_busy: { sessions: 3, jobs: 1 },
      p_flags: {},
      p_file_name: 'Vault.conduit',
      p_file_id: FILE_ID,
      p_location: 'Dropbox',
      p_written_vv: null,
      p_pending: false,
    });
    expect(h.acquires()).toHaveLength(0);
  });

  it('reports inactivity, side files and pending changes from the host and context', async () => {
    h.t.rpc.handle('vault_session_heartbeat', () => okBeat());
    h.t.activity.focused = false;
    h.t.activity.lastFocus = h.t.clock.now() - 5 * ACTIVE_WINDOW_MS;
    h.t.power.idleSeconds = 600;
    h.ctx = { ...h.ctx, sideFilesPresent: true, pendingChanges: true };
    h.startConfirmed();
    await h.loop.beatNow();
    expect(h.beats()[0].args).toMatchObject({ p_active: false, p_flags: { side_files: 'present' }, p_pending: true });
  });

  it('keeps stored values when the context throws, and logs it', async () => {
    h.t.rpc.handle('vault_session_heartbeat', () => okBeat());
    h.loop = h.makeLoop({
      context: () => {
        throw new Error('replica closed');
      },
    });
    h.startConfirmed();
    await h.loop.beatNow();
    expect(h.beats()[0].args).toMatchObject({ p_flags: null, p_pending: null, p_file_name: null, p_busy: { sessions: 0, jobs: 0 } });
    expect(h.t.logger.messages('error')).toContain('[vault-session] heartbeat context unavailable');
  });

  it('emits limitChanged only when the server limit changes (plan upgrade, 6.9)', async () => {
    h.t.rpc.enqueue('vault_session_heartbeat', okBeat(1), okBeat(-1), okBeat(-1));
    h.startConfirmed();
    await h.t.clock.advance(3 * HEARTBEAT_MS);
    expect(h.rec.limits).toEqual([-1]);
  });

  it('emits limitConfirmed on every good answer, changed or not (6.8 lastLimit freshness)', async () => {
    h.t.rpc.enqueue('vault_session_heartbeat', okBeat(-1), offline(), okBeat(-1));
    h.startConfirmed();
    await h.t.clock.advance(3 * HEARTBEAT_MS);
    expect(h.rec.confirmedLimits).toEqual([-1, -1]);
  });

  it('sends a publish marker until acknowledged, then never again', async () => {
    h.t.rpc.handle('vault_session_heartbeat', () => okBeat());
    h.startConfirmed();
    h.lease.markerPublished({ dev: 42, ms: 1000, c: 1 });
    await h.loop.beatNow();
    await h.loop.beatNow();
    expect(h.beats().map((c) => c.args.p_written_vv)).toEqual([{ '42': [1000, 1] }, null]);
    expect(h.lease.markerToSend()).toBeNull();
  });

  it('keeps an unacknowledged marker when the heartbeat fails', async () => {
    h.t.rpc.enqueue('vault_session_heartbeat', offline(), okBeat());
    h.startConfirmed();
    h.lease.markerPublished({ dev: 42, ms: 1000, c: 1 });
    await h.loop.beatNow();
    await h.loop.beatNow();
    expect(h.beats().map((c) => c.args.p_written_vv)).toEqual([{ '42': [1000, 1] }, { '42': [1000, 1] }]);
    expect(h.lease.markerToSend()).toBeNull();
  });

  it('beats are single flight: triggers during a beat share one follow-up', async () => {
    const first = deferred<RpcResult>();
    let n = 0;
    h.t.rpc.handle('vault_session_heartbeat', () => (++n === 1 ? first.promise : okBeat()));
    h.startConfirmed();
    const a = h.loop.beatNow();
    const b = h.loop.beatNow();
    const c = h.loop.beatNow();
    expect(b).toBe(c);
    first.resolve(okBeat());
    await Promise.all([a, b, c]);
    expect(h.beats()).toHaveLength(2);
    await h.t.clock.advance(HEARTBEAT_MS);
    expect(h.beats()).toHaveLength(3);
  });

  it('stop is idempotent, leaves no timers or power listeners, and ignores late answers', async () => {
    const late = deferred<RpcResult>();
    h.t.rpc.handle('vault_session_heartbeat', () => late.promise);
    h.startConfirmed();
    const pending = h.loop.beatNow();
    h.loop.stop();
    h.loop.stop();
    expect(h.t.clock.pending()).toBe(0);
    late.resolve(okBeat(-1));
    await pending;
    expect(h.rec.limits).toEqual([]);
    expect(h.lease.serverLimit()).toBe(1);
    h.t.power.resume();
    await h.t.clock.advance(5 * HEARTBEAT_MS);
    expect(h.beats()).toHaveLength(1);
    expect(await h.loop.beatNow()).toBeNull();
  });

  it('a throwing event handler is logged and the loop keeps going', async () => {
    h.t.rpc.enqueue('vault_session_heartbeat', okBeat(-1), okBeat(-1));
    h.loop = h.makeLoop({
      events: {
        displaced: () => undefined,
        reconnectConflict: () => undefined,
        leaseChanged: () => undefined,
        limitChanged: () => {
          throw new Error('renderer gone');
        },
        limitConfirmed: () => undefined,
      },
    });
    h.startConfirmed();
    await h.t.clock.advance(2 * HEARTBEAT_MS);
    expect(h.beats()).toHaveLength(2);
    expect(h.t.logger.messages('error')).toContain('[vault-session] heartbeat limitChanged handler failed');
  });

  it('does nothing without a lease (signed out)', async () => {
    h.lease.signedOut();
    h.loop.start();
    await h.t.clock.advance(5 * OFFLINE_RETRY_MS);
    expect(h.t.rpc.calls).toEqual([]);
    expect(await h.loop.beatNow()).toBeNull();
  });
});
