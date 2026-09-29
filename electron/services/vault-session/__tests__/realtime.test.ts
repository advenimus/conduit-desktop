// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { makeTempRoot } from '../../sync/__tests__/host-fakes.js';
import { makeTestSessionHost, type TestSessionHost } from './session-fakes.js';
import { SessionRealtime, classifyRealtimeRow } from '../realtime.js';
import { LeaseTracker } from '../lease.js';
import type { SessionRowView } from '../../sync/host.js';
import type { DisplacementReason, RealtimeHost } from '../host.js';

const VAULT = '22222222-2222-4222-8222-222222222222';
const OTHER_VAULT = '22222222-2222-4222-8222-999999999999';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const IPHONE = '44444444-4444-4444-8444-444444444444';
const LEASE = '55555555-5555-4555-8555-555555555551';
const NEW_LEASE = '55555555-5555-4555-8555-555555555552';
const NONCE = '66666666-6666-4666-8666-666666666661';
const OTHER_NONCE = '66666666-6666-4666-8666-666666666662';

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user_id: '11111111-1111-4111-8111-111111111111',
    vault_key: VAULT,
    device_id: DEVICE,
    lease_id: LEASE,
    session_nonce: NONCE,
    status: 'active',
    displaced_by_device: null,
    displaced_reason: null,
    ...overrides,
  };
}

const displacedRow = (reason: string, by: string | null = IPHONE): Record<string, unknown> =>
  row({ status: 'displaced', displaced_reason: reason, displaced_by_device: by });

const iphoneSession: SessionRowView = {
  deviceId: IPHONE,
  deviceName: "Chris's iPhone",
  platform: 'ios',
  fileName: null,
  fileId: null,
  location: null,
  status: 'active',
  lastActiveMs: null,
  busySessions: 0,
  busyJobs: 0,
  heartbeatAtMs: null,
  sideFilesFlag: false,
  marker: null,
  writtenAtMs: null,
  pendingChanges: false,
  abandoned: false,
};

describe('classifyRealtimeRow', () => {
  it.each([
    ['another vault', row({ vault_key: OTHER_VAULT }), LEASE, null, { kind: 'ignore' }],
    ['our lease unknown', row({ lease_id: NEW_LEASE }), null, null, { kind: 'ignore' }],
    ['no lease id on the row', row({ lease_id: undefined }), LEASE, null, { kind: 'ignore' }],
    ['our own heartbeat', row(), LEASE, NONCE, { kind: 'ignore' }],
    ['released with our lease', row({ status: 'released' }), LEASE, null, { kind: 'ignore' }],
    ['a new lease from another running copy', row({ lease_id: NEW_LEASE, session_nonce: OTHER_NONCE }), LEASE, NONCE, { kind: 'superseded' }],
    ['a new lease without nonce guard', row({ lease_id: NEW_LEASE }), LEASE, null, { kind: 'superseded' }],
    ['our own re-acquire racing its answer', row({ lease_id: NEW_LEASE }), LEASE, NONCE, { kind: 'ignore' }],
    ['take-over', displacedRow('takeover'), LEASE, NONCE, { kind: 'displaced', reason: 'takeover', byDeviceId: IPHONE }],
    ['plan limit', displacedRow('plan_limit', null), LEASE, NONCE, { kind: 'displaced', reason: 'plan_limit', byDeviceId: null }],
    ['displaced by a malformed id', displacedRow('takeover', 'phone'), LEASE, null, { kind: 'displaced', reason: 'takeover', byDeviceId: null }],
    ['displaced with an unknown reason', displacedRow('owner_claim'), LEASE, null, { kind: 'ignore' }],
    ['upper-case ids', row({ vault_key: VAULT.toUpperCase(), lease_id: LEASE.toUpperCase(), status: 'displaced', displaced_reason: 'takeover' }), LEASE, null, { kind: 'displaced', reason: 'takeover', byDeviceId: null }],
  ])('%s', (_label, r, leaseId, nonce, expected) => {
    expect(classifyRealtimeRow(r, VAULT, leaseId, nonce)).toEqual(expected);
  });
});

describe('SessionRealtime', () => {
  let root: string;
  let t: TestSessionHost;
  let lease: LeaseTracker;
  let displaced: [DisplacementReason, string | null][];
  let rt: SessionRealtime;

  function make(realtime: RealtimeHost = t.realtime): SessionRealtime {
    return new SessionRealtime({
      realtime,
      vaultKey: VAULT,
      deviceId: DEVICE,
      lease,
      host: t.host,
      sessionNonce: NONCE,
      deviceName: (id, sessions) => sessions.find((s) => s.deviceId === id)?.deviceName ?? null,
      onDisplaced: (reason, by) => displaced.push([reason, by]),
    });
  }

  beforeEach(() => {
    root = makeTempRoot('realtime');
    t = makeTestSessionHost(root);
    lease = new LeaseTracker();
    lease.onAcquire({ kind: 'granted', leaseId: LEASE, limit: 1, sessions: [iphoneSession], serverNowMs: null, deviceCap: null, ownership: null }, t.clock.now());
    displaced = [];
    rt = make();
  });

  afterEach(() => {
    rt.stop();
    expect(t.realtime.activeCount()).toBe(0);
    expect(t.logger.unprefixed()).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('subscribes on start and unsubscribes on stop, idempotently', () => {
    rt.start();
    rt.start();
    expect(t.realtime.activeCount()).toBe(1);
    rt.stop();
    rt.stop();
    expect(t.realtime.activeCount()).toBe(0);
  });

  it('ignores our own heartbeat updates and other vaults', () => {
    rt.start();
    t.realtime.push(row());
    t.realtime.push(row({ vault_key: OTHER_VAULT, lease_id: NEW_LEASE, session_nonce: OTHER_NONCE }));
    expect(displaced).toEqual([]);
  });

  it('T-FS-55: a second running copy with this device identity supersedes this one', () => {
    rt.start();
    t.realtime.push(row({ lease_id: NEW_LEASE, session_nonce: OTHER_NONCE }));
    expect(displaced).toEqual([['superseded', null]]);
    expect(lease.state()).toEqual({ kind: 'displaced', reason: 'superseded', byDeviceName: null, leaseId: null });
    expect(t.logger.messages('warn')).toHaveLength(1);
  });

  it('take-over names the displacing device through the last sessions list', () => {
    rt.start();
    t.realtime.push(displacedRow('takeover'));
    expect(displaced).toEqual([['takeover', "Chris's iPhone"]]);
  });

  describe('a device the sessions list does not know yet (its first take-over)', () => {
    const MINI = '77777777-7777-4777-8777-777777777777';
    const withLookup = (lookupName: (id: string) => Promise<string | null>) =>
      new SessionRealtime({
        realtime: t.realtime,
        vaultKey: VAULT,
        deviceId: DEVICE,
        lease,
        host: t.host,
        sessionNonce: NONCE,
        deviceName: (id, sessions) => sessions.find((s) => s.deviceId === id)?.deviceName ?? null,
        lookupName,
        onDisplaced: (reason, by) => displaced.push([reason, by]),
      });

    it('asks the server for its name before the displacement', async () => {
      const asked: string[] = [];
      rt = withLookup(async (id) => {
        asked.push(id);
        return 'Mac Mini';
      });
      rt.start();
      t.realtime.push(displacedRow('takeover', MINI));
      expect(displaced).toEqual([]);
      await new Promise((r) => setImmediate(r));
      expect(asked).toEqual([MINI]);
      expect(displaced).toEqual([['takeover', 'Mac Mini']]);
    });

    it('still displaces, without a name, when the lookup fails', async () => {
      rt = withLookup(async () => {
        throw new Error('offline');
      });
      rt.start();
      t.realtime.push(displacedRow('takeover', MINI));
      await new Promise((r) => setImmediate(r));
      expect(displaced).toEqual([['takeover', null]]);
      expect(t.logger.messages('warn').some((m) => m.includes("looking up the other device's name failed"))).toBe(true);
    });

    it('does nothing once stopped while the lookup runs', async () => {
      let answer: (name: string | null) => void = () => undefined;
      rt = withLookup(() => new Promise((r) => (answer = r)));
      rt.start();
      t.realtime.push(displacedRow('takeover', MINI));
      rt.stop();
      answer('Mac Mini');
      await new Promise((r) => setImmediate(r));
      expect(displaced).toEqual([]);
    });
  });

  it('plan limit with an unknown device reports no name', () => {
    rt.start();
    t.realtime.push(displacedRow('plan_limit', '99999999-9999-4999-8999-999999999999'));
    expect(displaced).toEqual([['plan_limit', null]]);
  });

  it('reports one displacement per subscription', () => {
    rt.start();
    t.realtime.push(displacedRow('takeover'));
    t.realtime.push(displacedRow('takeover'));
    t.realtime.push(row({ lease_id: NEW_LEASE, session_nonce: OTHER_NONCE }));
    expect(displaced).toHaveLength(1);
  });

  it('ignores rows delivered after stop', () => {
    let deliver: ((r: Record<string, unknown>) => void) | null = null;
    const leaky: RealtimeHost = {
      subscribeOwnSessionRows: (_id, handlers) => {
        deliver = (r) => handlers.onUpdate(r);
        return { unsubscribe: () => undefined };
      },
    };
    rt = make(leaky);
    rt.start();
    rt.stop();
    deliver!(displacedRow('takeover'));
    expect(displaced).toEqual([]);
  });

  it('logs status changes only', () => {
    rt.start();
    t.realtime.status('subscribed');
    t.realtime.status('timed-out');
    expect(t.logger.messages('info')).toContain('[vault-session] realtime subscribed');
    expect(t.logger.messages('warn')).toContain('[vault-session] realtime timed-out');
    expect(displaced).toEqual([]);
  });

  it('a failing subscribe is logged; the heartbeat stays the fallback', () => {
    rt = make({
      subscribeOwnSessionRows: () => {
        throw new Error('socket closed');
      },
    });
    rt.start();
    rt.stop();
    expect(t.logger.messages('error')).toEqual(['[vault-session] realtime subscribe failed; the heartbeat remains the displacement signal']);
  });

  it('a throwing displacement handler is logged, not thrown into the adapter', () => {
    rt = new SessionRealtime({
      realtime: t.realtime,
      vaultKey: VAULT,
      deviceId: DEVICE,
      lease,
      host: t.host,
      deviceName: () => null,
      onDisplaced: () => {
        throw new Error('runtime gone');
      },
    });
    rt.start();
    expect(() => t.realtime.push(displacedRow('takeover'))).not.toThrow();
    expect(t.logger.messages('error')).toEqual(['[vault-session] realtime update handling failed']);
  });

  it('ignores everything while our lease is unknown', () => {
    lease.onHeartbeat({ kind: 'lost', reason: 'expired' }, t.clock.now());
    rt.start();
    t.realtime.push(row({ lease_id: NEW_LEASE }));
    expect(displaced).toEqual([]);
  });
});
