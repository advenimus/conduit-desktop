import { describe, expect, it } from 'vitest';
import { handle } from '../../src/api/handler.ts';
import { scoreAbuse } from '../../src/api/rpc/fingerprint.ts';
import { u, World } from './harness.ts';

const submit = (w: World, who: string, ip: string, fp: string, primary: string, event = 'login') =>
  handle(
    { kind: 'rpc', fn: 'submit_fingerprint', args: { fingerprint_hash: fp, primary_hash: primary, platform: 'macos', app_version: '0.19.0', event_type: event } },
    { role: 'authenticated', uid: u(who), email: `${who}@plan.test`, ip },
    { store: w.store, files: w.files, directory: w.directory, effects: w.fx, now: () => w.clock },
  );

describe('submit_fingerprint (conduit-backend /api/fingerprint)', () => {
  it('scores like the backend', () => {
    expect(scoreAbuse({ sharedPrimaryHash: [], sameIpUsers: [], recentRegistrations: 0, ip: null })).toEqual([]);
    expect(scoreAbuse({ sharedPrimaryHash: ['a'], sameIpUsers: [], recentRegistrations: 0, ip: null }).map((s) => s.score)).toEqual([15]);
    expect(scoreAbuse({ sharedPrimaryHash: ['a', 'b', 'c'], sameIpUsers: ['a', 'b', 'c'], recentRegistrations: 5, ip: '1.2.3.4' }).map((s) => s.score)).toEqual([75, 25, 60]);
  });

  it('records the device, flags reuse, and suspends at 100', async () => {
    const w = await World.create();
    for (const n of ['a', 'b', 'c', 'd']) await w.mkUser(n);
    const r1 = await submit(w, 'a', '9.9.9.9', 'fp-a', 'hw-1', 'registration');
    expect(r1.body.data).toEqual({ registered: true, abuse_score: 0, suspended: false, signals_detected: 0 });
    expect(await w.row('user_profiles', { id: u('a') })).toMatchObject({ registration_ip: '9.9.9.9', registration_fingerprint: 'hw-1' });
    await submit(w, 'b', '9.9.9.9', 'fp-b', 'hw-1');
    await submit(w, 'c', '9.9.9.9', 'fp-c', 'hw-1');
    const r4 = await submit(w, 'd', '9.9.9.9', 'fp-d', 'hw-1');
    expect(r4.body.data).toMatchObject({ abuse_score: 100, suspended: true });
    expect(await w.row('user_profiles', { id: u('d') })).toMatchObject({ is_suspended: true, abuse_score: 100 });
    expect((await w.rows('abuse_flags', [{ column: 'user_id', op: 'eq', value: u('d') }])).length).toBe(2);
    expect(await w.rows('device_fingerprints')).toHaveLength(4);
    const again = await submit(w, 'a', '9.9.9.9', 'fp-a', 'hw-1');
    expect(again.body.error).toBeNull();
    expect(await w.rows('device_fingerprints')).toHaveLength(4);
  });
});

describe('abuse scoring switch', () => {
  it('still records devices but scores nothing when off (local stack)', async () => {
    const w = await World.create();
    for (const n of ['a', 'b', 'c', 'd']) await w.mkUser(n);
    let last;
    for (const n of ['a', 'b', 'c', 'd']) {
      last = await handle(
        { kind: 'rpc', fn: 'submit_fingerprint', args: { fingerprint_hash: `fp-${n}`, primary_hash: 'hw-1' } },
        { role: 'authenticated', uid: u(n), email: `${n}@plan.test`, ip: '9.9.9.9' },
        { store: w.store, files: w.files, directory: w.directory, effects: w.fx, now: () => w.clock, abuseChecks: false },
      );
    }
    expect(last!.body.data).toMatchObject({ abuse_score: 0, suspended: false });
    expect(await w.rows('device_fingerprints')).toHaveLength(4);
    expect(await w.rows('abuse_flags')).toEqual([]);
  });
});
