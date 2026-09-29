// @vitest-environment node
// lease.ts (spec 6.2, 6.8, 6.11 markers): confirmed within 90 s of the last
// good answer, every transition of acquire and heartbeat answers, and the marker rule (sent
// until acknowledged, never again, so an abandon stays in force, 12 row 67).
import { describe, expect, it } from 'vitest';
import { LEASE_TTL_MS, LeaseTracker } from '../lease.js';
import type { AcquireResult, HeartbeatResult } from '../session-client.js';
import { row } from './stale-fixtures.js';

const MAC = '22222222-2222-4222-8222-222222222222';
const granted = (leaseId = 'lease-1', limit = 1): AcquireResult => ({ kind: 'granted', leaseId, limit, sessions: [row({ deviceId: MAC })], serverNowMs: null, deviceCap: null, ownership: null });
const unconfirmed: AcquireResult = { kind: 'unconfirmed', reason: 'network', detail: 'network' };
const ok = (limit = 1): HeartbeatResult => ({ kind: 'ok', limit, deviceCap: null, ownership: null, sessions: [], serverNowMs: null });

describe('LeaseTracker', () => {
  it('starts with no lease (signed out)', () => {
    const l = new LeaseTracker();
    expect(l.state()).toEqual({ kind: 'none' });
    expect(l.leaseId()).toBeNull();
    expect(l.isConfirmed(0)).toBe(false);
    expect(l.serverLimit()).toBeNull();
    expect(l.sessions()).toEqual([]);
  });

  it('a grant is confirmed for 90 s; a heartbeat ok extends it', () => {
    const l = new LeaseTracker();
    l.onAcquire(granted(), 1_000);
    expect(l.state()).toEqual({ kind: 'confirmed', leaseId: 'lease-1', lastOkMs: 1_000 });
    expect(l.serverLimit()).toBe(1);
    expect(l.sessions().map((s) => s.deviceId)).toEqual([MAC]);
    expect(l.isConfirmed(1_000 + LEASE_TTL_MS)).toBe(true);
    expect(l.isConfirmed(1_001 + LEASE_TTL_MS)).toBe(false);
    l.onHeartbeat(ok(-1), 50_000);
    expect(l.isConfirmed(50_000 + LEASE_TTL_MS)).toBe(true);
    expect(l.serverLimit()).toBe(-1);
    expect(l.sessions()).toEqual([]);
  });

  it('maps this device\'s clock to the server\'s from the last answer that carried server_now', () => {
    const l = new LeaseTracker();
    expect(l.toServerMs(10_000)).toBe(10_000);
    l.onAcquire({ ...granted(), serverNowMs: 13_000 } as AcquireResult, 10_000);
    expect(l.toServerMs(20_000)).toBe(23_000);
    l.onHeartbeat(ok(), 30_000);
    expect(l.toServerMs(20_000)).toBe(23_000);
    l.onHeartbeat({ kind: 'ok', limit: 1, deviceCap: null, ownership: null, sessions: [], serverNowMs: 29_000 }, 30_000);
    expect(l.toServerMs(20_000)).toBe(19_000);
  });

  it('unconfirmed answers keep the lease id and the first unconfirmed time; a denial changes nothing', () => {
    const l = new LeaseTracker();
    l.onAcquire(unconfirmed, 10);
    expect(l.state()).toMatchObject({ kind: 'unconfirmed', leaseId: null, sinceMs: 10 });
    l.onAcquire(granted(), 20);
    l.onHeartbeat({ kind: 'unconfirmed', reason: 'timeout', detail: 't' }, 30);
    l.onHeartbeat({ kind: 'unconfirmed', reason: 'server', detail: '503' }, 40);
    expect(l.state()).toEqual({ kind: 'unconfirmed', leaseId: 'lease-1', sinceMs: 30, reason: 'server' });
    l.onAcquire({ kind: 'denied', cause: 'vault_limit', limit: 1, deviceCap: null, holders: [], alsoLocks: null, sessions: [], serverNowMs: null }, 50);
    expect(l.leaseId()).toBe('lease-1');
    l.onHeartbeat(ok(), 60);
    expect(l.state()).toEqual({ kind: 'confirmed', leaseId: 'lease-1', lastOkMs: 60 });
  });

  it('maps displaced, superseded, lost and released', () => {
    const l = new LeaseTracker();
    l.onAcquire(granted(), 0);
    l.onHeartbeat({ kind: 'displaced', reason: 'plan_limit', byDeviceName: 'MacBook', minVersion: null, released: false }, 1);
    expect(l.state()).toEqual({ kind: 'displaced', reason: 'plan_limit', byDeviceName: 'MacBook', leaseId: 'lease-1' });
    expect(l.leaseId()).toBeNull();
    expect(l.releaseLeaseId()).toBe('lease-1');
    l.onAcquire(granted('lease-2'), 2);
    l.onHeartbeat({ kind: 'lost', reason: 'superseded' }, 3);
    expect(l.state()).toEqual({ kind: 'displaced', reason: 'superseded', byDeviceName: null, leaseId: null });
    expect(l.releaseLeaseId()).toBeNull();
    l.onAcquire(granted('lease-3'), 4);
    l.onHeartbeat({ kind: 'lost', reason: 'expired' }, 5);
    expect(l.state()).toEqual({ kind: 'lost', reason: 'expired' });
    expect(l.leaseId()).toBeNull();
    l.onAcquire(granted('lease-4'), 6);
    l.onSuperseded();
    expect(l.state()).toMatchObject({ kind: 'displaced', reason: 'superseded' });
    expect(l.releaseLeaseId()).toBeNull();
    l.onReleased();
    expect(l.state()).toEqual({ kind: 'lost', reason: 'released' });
    l.signedOut();
    expect(l.state()).toEqual({ kind: 'none' });
    expect(l.serverLimit()).toBeNull();
  });

  it('a heartbeat ok without a known lease id does not invent a lease', () => {
    const l = new LeaseTracker();
    l.onHeartbeat(ok(), 1);
    expect(l.state()).toEqual({ kind: 'none' });
  });

  it('sends a marker until it is acknowledged, then never again (12 row 67)', () => {
    const l = new LeaseTracker();
    const m1 = { dev: 5, ms: 100, c: 0 };
    const m2 = { dev: 5, ms: 200, c: 1 };
    expect(l.markerToSend()).toBeNull();
    l.markerPublished(m1);
    expect(l.markerToSend()).toEqual(m1);
    l.markerPublished(m2);
    expect(l.markerToSend()).toEqual(m2);
    l.markerPublished(m1);
    expect(l.markerToSend()).toEqual(m2);
    l.markerAcknowledged(m1);
    expect(l.markerToSend()).toEqual(m2);
    l.markerAcknowledged({ ...m2 });
    expect(l.markerToSend()).toBeNull();
  });

  it('a marker of a new incarnation (another dev) replaces the pending one', () => {
    const l = new LeaseTracker();
    l.markerPublished({ dev: 5, ms: 900, c: 0 });
    l.markerPublished({ dev: 6, ms: 100, c: 0 });
    expect(l.markerToSend()).toEqual({ dev: 6, ms: 100, c: 0 });
  });
});
