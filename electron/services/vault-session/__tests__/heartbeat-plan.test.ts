// @vitest-environment node
// Plan enforcement in the lease loop, Realtime and displacement (docs/PLAN_ENFORCEMENT.md 4.3,
// 4.4; test D6): every background re-acquire sends p_claim false; not-owner and update-required
// answers displace with their reason and detail; a device-cap denial is the reconnect conflict
// with its cause (S3); Realtime rows of the new reasons; the soft-lock reason per displacement.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HEARTBEAT_MS } from '../heartbeat.js';
import { Displacement, lockedReasonFor } from '../displacement.js';
import { classifyRealtimeRow } from '../realtime.js';
import type { DisplacedDetail, DisplacementReason, Holder, LockedReason, SessionDisplacedEvent } from '../host.js';
import type { DenialCause, Ownership } from '../session-client.js';
import { LEASE, LEASE_2, TS, VAULT, holderRow } from './session-client-fixtures.js';
import { HeartbeatHarness, lost, okBeat } from './heartbeat-harness.js';
import { rpcOk } from './session-fakes.js';

describe('HeartbeatLoop: plan enforcement', () => {
  let h: HeartbeatHarness;
  const displaced: [DisplacementReason, string | null, DisplacedDetail | undefined][] = [];
  const conflicts: [readonly Holder[], DenialCause | undefined, number | null | undefined][] = [];
  const ownership: (Ownership | null)[] = [];

  beforeEach(() => {
    displaced.length = 0;
    conflicts.length = 0;
    ownership.length = 0;
    h = new HeartbeatHarness();
    h.loop = h.makeLoop({
      events: {
        displaced: (reason, by, detail) => displaced.push([reason, by, detail]),
        reconnectConflict: (holders, cause, cap) => conflicts.push([holders, cause, cap]),
        leaseChanged: () => undefined,
        limitChanged: () => undefined,
        limitConfirmed: () => undefined,
        ownershipConfirmed: (o) => ownership.push(o),
      },
    });
  });

  afterEach(() => {
    h.dispose();
  });

  it('re-acquires after a lost lease with p_claim false even when the runtime passes true', async () => {
    h.t.rpc.enqueue('vault_session_heartbeat', lost('expired'));
    h.t.rpc.enqueue('vault_session_acquire', rpcOk({ granted: true, lease_id: LEASE_2, limit: -1, sessions: [], server_now: TS, ownership: 'unowned' }));
    h.startConfirmed();
    await h.t.clock.advance(HEARTBEAT_MS);
    expect(h.acquires()[0]?.args).toMatchObject({ p_claim: false, p_takeover: false });
    expect(ownership).toEqual([{ kind: 'unowned' }]);
  });

  it('reports each confirmed heartbeat ownership', async () => {
    h.t.rpc.enqueue('vault_session_heartbeat', rpcOk({ status: 'ok', limit: -1, sessions: [], server_now: TS, ownership: 'grace', grace_until: TS }), okBeat());
    h.startConfirmed();
    await h.t.clock.advance(HEARTBEAT_MS);
    await h.t.clock.advance(HEARTBEAT_MS);
    expect(ownership).toEqual([{ kind: 'grace', untilMs: Date.parse(TS) }, null]);
  });

  it.each([
    ['not_owner', { reason: 'not_owner', by: null, released: true }, { minVersion: null, released: true }],
    ['update_required', { reason: 'update_required', by: null, min_version: '0.19.0' }, { minVersion: '0.19.0', released: false }],
    ['device_cap', { reason: 'device_cap', by: 'New PC' }, { minVersion: null, released: false }],
  ])('a displaced %s heartbeat displaces with its detail', async (reason, extra, detail) => {
    h.t.rpc.enqueue('vault_session_heartbeat', rpcOk({ status: 'displaced', ...extra }));
    h.startConfirmed();
    await h.t.clock.advance(HEARTBEAT_MS);
    expect(displaced).toEqual([[reason, (extra as { by: string | null }).by, detail]]);
  });

  it('a re-acquire refused as not owner or update required displaces (never the conflict dialog)', async () => {
    h.t.rpc.enqueue('vault_session_heartbeat', lost('expired'));
    h.t.rpc.enqueue('vault_session_acquire', rpcOk({ granted: false, reason: 'not_owner', released: false, holders: [], sessions: [], server_now: TS }));
    h.startConfirmed();
    await h.t.clock.advance(HEARTBEAT_MS);
    expect(displaced).toEqual([['not_owner', null, { minVersion: null, released: false }]]);
    expect(conflicts).toEqual([]);
  });

  it('an update-required re-acquire displaces with the minimum version', async () => {
    h.t.rpc.enqueue('vault_session_heartbeat', lost('expired'));
    h.t.rpc.enqueue('vault_session_acquire', rpcOk({ granted: false, reason: 'update_required', min_version: '2.0.0', holders: [], sessions: [], server_now: TS }));
    h.startConfirmed();
    await h.t.clock.advance(HEARTBEAT_MS);
    expect(displaced).toEqual([['update_required', null, { minVersion: '2.0.0', released: false }]]);
  });

  it('a device-cap denial on re-acquire is the reconnect conflict with its cause (S3)', async () => {
    h.t.rpc.enqueue('vault_session_heartbeat', lost('expired'));
    h.t.rpc.enqueue(
      'vault_session_acquire',
      rpcOk({ granted: false, reason: 'device_cap', limit: -1, device_cap: 5, holders: [holderRow({ vaults: 2 })], sessions: [], server_now: TS }),
    );
    h.startConfirmed();
    await h.t.clock.advance(HEARTBEAT_MS);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.[1]).toBe('device_cap');
    expect(conflicts[0]?.[2]).toBe(5);
    expect(displaced).toEqual([]);
  });
});

describe('Realtime rows of the new reasons', () => {
  const row = (reason: string) => ({ vault_key: VAULT, lease_id: LEASE, status: 'displaced', displaced_reason: reason, displaced_by_device: null });

  it('device_cap displaces like a take-over; not_owner and update_required ask for a heartbeat', () => {
    expect(classifyRealtimeRow(row('device_cap'), VAULT, LEASE)).toEqual({ kind: 'displaced', reason: 'device_cap', byDeviceId: null });
    expect(classifyRealtimeRow(row('not_owner'), VAULT, LEASE)).toEqual({ kind: 'refused', reason: 'not_owner' });
    expect(classifyRealtimeRow(row('update_required'), VAULT, LEASE)).toEqual({ kind: 'refused', reason: 'update_required' });
    expect(classifyRealtimeRow(row('geo'), VAULT, LEASE)).toEqual({ kind: 'ignore' });
  });
});

describe('Displacement soft-lock reason and notice detail', () => {
  it('maps not_owner and update_required to their own lock reason, everything else to open_elsewhere', () => {
    expect(lockedReasonFor('not_owner')).toBe('not_owner');
    expect(lockedReasonFor('update_required')).toBe('update_required');
    for (const r of ['device_cap', 'takeover', 'plan_limit', 'owner_claim', 'superseded', 'reconnect_unanswered', 'yielded'] as const) {
      expect(lockedReasonFor(r)).toBe('open_elsewhere');
    }
  });

  it('soft-locks with the reason and sends minVersion, released and the device cap', async () => {
    const blocked: LockedReason[] = [];
    const locked: LockedReason[] = [];
    const events: SessionDisplacedEvent[] = [];
    const d = new Displacement({
      lineageId: VAULT,
      fileName: 'Vault.conduit',
      host: {
        access: {
          blockAccess: (r) => blocked.push(r),
          softLock: (r) => locked.push(r),
          openPrivateInPlace: async () => undefined,
          createPrivateInPlace: async () => undefined,
        },
        sessionEvents: { emit: (name: string, payload: unknown) => (name === 'vault:session-displaced' ? events.push(payload as SessionDisplacedEvent) : 0) } as never,
        busy: { busy: () => ({ sessions: 0, jobs: 0 }) },
        clock: { now: () => 0 },
        timers: { setTimeout: (fn: () => void) => ({ cancel: () => undefined, fn }) } as never,
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
      },
      finalSync: null,
      release: async () => undefined,
      teardown: async () => undefined,
      deviceCap: () => 5,
    });
    await d.displace('update_required', null, { minVersion: '0.19.0', released: false });
    expect(blocked).toEqual(['update_required']);
    expect(locked).toEqual(['update_required']);
    expect(events[0]).toMatchObject({ reason: 'update_required', minVersion: '0.19.0', released: false, deviceCap: 5 });
  });
});
