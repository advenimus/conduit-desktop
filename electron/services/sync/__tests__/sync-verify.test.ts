// @vitest-environment node
// sync-verify.ts (spec 5.6 back-off, 5.7, 12 rows 7/8): the covers(S, P) verdicts after a
// publish, one counted loss per lost publish, the regression back-off (more than 3 in 10 min,
// 5 s doubling to 5 min, settle), and the generic error back-off.
import { describe, expect, it } from 'vitest';
import {
  Backoff,
  COVERS_CHECK_DELAYS_MS,
  PublishVerifier,
  REGRESSION_BACKOFF_MAX_MS,
  REGRESSION_BACKOFF_START_MS,
  REGRESSION_LIMIT,
  REGRESSION_WINDOW_MS,
  RegressionTracker,
} from '../sync-verify.js';
import { E1_FIXTURE, stateWithPresence } from './presence-fixtures.js';

const UUID = 'aaaaaaaa-0000-4000-8000-000000000001';
const P = stateWithPresence(E1_FIXTURE, UUID, '{"v":1}', { dev: 11, ms: 500 });
const P2 = stateWithPresence(E1_FIXTURE, UUID, '{"v":2}', { dev: 11, ms: 900 });

function record(state = P, atMs = 1_000, sha256 = 'a'.repeat(64)) {
  return { sha256, marker: { dev: 11, ms: 500, c: 0 }, state, atMs };
}

describe('PublishVerifier (5.7)', () => {
  it('schedules the covers checks at +15 s and +60 s', () => {
    const v = new PublishVerifier();
    expect(v.recordPublish(record())).toEqual(COVERS_CHECK_DELAYS_MS.map((d) => 1_000 + d));
    expect(v.last()?.atMs).toBe(1_000);
  });

  it('reports no-publish, covered and regressed', () => {
    const v = new PublishVerifier();
    expect(v.check(P)).toBe('no-publish');
    v.recordPublish(record());
    expect(v.check(P)).toBe('covered');
    expect(v.check(P2)).toBe('covered');
    expect(v.check(E1_FIXTURE)).toBe('regressed');
  });

  it('counts a lost publish once, however often the old copy is read again', () => {
    const v = new PublishVerifier();
    expect(v.claimLoss()).toBe(false);
    v.recordPublish(record());
    expect(v.claimLoss()).toBe(true);
    expect(v.claimLoss()).toBe(false);
    v.recordPublish(record(P2, 2_000, 'b'.repeat(64)));
    expect(v.claimLoss()).toBe(true);
  });
});

describe('RegressionTracker (5.7)', () => {
  it('backs off on the regression after the third within 10 minutes, doubling up to 5 minutes', () => {
    const r = new RegressionTracker();
    for (let i = 0; i < REGRESSION_LIMIT; i++) expect(r.record(i * 1_000)).toBeNull();
    expect(r.blockedUntil(3_000)).toBeNull();
    expect(r.record(3_000)).toBe(3_000 + REGRESSION_BACKOFF_START_MS);
    expect(r.blockedUntil(3_001)).toBe(3_000 + REGRESSION_BACKOFF_START_MS);
    expect(r.blockedUntil(3_000 + REGRESSION_BACKOFF_START_MS)).toBeNull();
    let delay = REGRESSION_BACKOFF_START_MS;
    for (let i = 4; i < 20; i++) {
      delay = Math.min(delay * 2, REGRESSION_BACKOFF_MAX_MS);
      expect(r.record(i * 1_000)).toBe(i * 1_000 + delay);
    }
    expect(delay).toBe(REGRESSION_BACKOFF_MAX_MS);
  });

  it('forgets regressions older than the window, and settle() resets the step', () => {
    const r = new RegressionTracker();
    for (let i = 0; i < REGRESSION_LIMIT; i++) r.record(0);
    expect(r.record(REGRESSION_WINDOW_MS)).toBeNull();
    for (let i = 1; i < REGRESSION_LIMIT; i++) expect(r.record(REGRESSION_WINDOW_MS + 1)).toBeNull();
    expect(r.record(REGRESSION_WINDOW_MS + 2)).toBe(REGRESSION_WINDOW_MS + 2 + REGRESSION_BACKOFF_START_MS);
    expect(r.record(REGRESSION_WINDOW_MS + 3)).toBe(REGRESSION_WINDOW_MS + 3 + 2 * REGRESSION_BACKOFF_START_MS);
    r.settle();
    for (let i = 0; i < REGRESSION_LIMIT; i++) expect(r.record(REGRESSION_WINDOW_MS + 4)).toBeNull();
    expect(r.record(REGRESSION_WINDOW_MS + 5)).toBe(REGRESSION_WINDOW_MS + 5 + REGRESSION_BACKOFF_START_MS);
  });
});

describe('Backoff (5.6)', () => {
  it('doubles from the start delay up to the cap and resets', () => {
    const b = new Backoff(5_000, 600_000);
    expect(b.active()).toBe(false);
    const delays = Array.from({ length: 10 }, () => b.next());
    expect(delays.slice(0, 4)).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(delays.at(-1)).toBe(600_000);
    expect(b.active()).toBe(true);
    b.reset();
    expect(b.active()).toBe(false);
    expect(b.next()).toBe(5_000);
  });
});
