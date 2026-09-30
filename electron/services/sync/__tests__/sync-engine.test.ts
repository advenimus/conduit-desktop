// @vitest-environment node
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL_EDIT_IDLE_MS, LOCAL_EDIT_MAX_MS, type CycleOutcome } from '../sync-engine.js';
import { MISSING_RECHECK_MS } from '../sync-engine-outcome.js';
import { emptyState } from '../state-view.js';
import { flushAsync, makeTempRoot } from './host-fakes.js';
import {
  LINEAGE,
  MARKER,
  SHA_P,
  UP_TO_DATE,
  blocked,
  deferred,
  makeHarness,
  outcome,
  publishes,
  reads,
  type Harness,
} from './engine-fakes.js';

const roots: string[] = [];
const harnesses: Harness[] = [];

function harness(opts: { journalMode?: 'wal' | 'delete' } = {}): Harness {
  const root = makeTempRoot('engine');
  roots.push(root);
  const h = makeHarness(root, opts);
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.engine.stop();
    expect(h.t.logger.unprefixed()).toEqual([]);
  }
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const S_STATE = emptyState(LINEAGE, 'd'.repeat(64), 1);
const REGRESSION: CycleOutcome = { kind: 'merged-not-published', reason: 'regression-backoff' };

function kinds(h: Harness): string[] {
  return h.t.events.of('sync:state-changed').map((s) => s.kind);
}

function toasts(h: Harness, kind: string): number {
  return h.t.events.of('sync:notice').filter((e) => !e.persisted && e.notice.kind === kind).length;
}

describe('single flight and the lane', () => {
  it('N triggers during a cycle cost exactly one follow-up, shared by every caller', async () => {
    const h = harness();
    const gate = deferred();
    h.body.then(blocked(gate));
    const first = h.engine.runCycle('unlock');
    await flushAsync();
    expect(h.body.calls).toHaveLength(1);
    const a = h.engine.runCycle('shared-changed');
    const b = h.engine.runCycle('focus');
    h.engine.trigger('session-hint');
    h.engine.trigger('safety-poll');
    expect(b).toBe(a);
    gate.resolve();
    await Promise.all([first, a, b]);
    await h.engine.whenIdle();
    expect(h.body.reasons()).toEqual(['unlock', 'shared-changed']);
  });

  it('calls made before the lane starts a cycle coalesce into it', async () => {
    const h = harness();
    const p = [h.engine.runCycle('unlock'), h.engine.runCycle('focus'), h.engine.runCycle('sync-now')];
    await Promise.all(p);
    expect(h.body.calls).toHaveLength(1);
  });

  it('exclusive actions wait for the running cycle and cycles wait for actions', async () => {
    const h = harness();
    const gate = deferred();
    const order: string[] = [];
    h.body.then(async (env) => {
      await gate.promise;
      env.checkAlive();
      order.push('cycle-1');
      return UP_TO_DATE;
    });
    h.body.fallback = async () => {
      order.push('cycle-2');
      return UP_TO_DATE;
    };
    const c1 = h.engine.runCycle('unlock');
    await flushAsync();
    const action = h.engine.exclusive(() => order.push('action'));
    const c2 = h.engine.runCycle('focus');
    await flushAsync();
    expect(order).toEqual([]);
    gate.resolve();
    await Promise.all([c1, action, c2]);
    expect(order).toEqual(['cycle-1', 'action', 'cycle-2']);
  });
});

describe('local-edit trigger', () => {
  it('runs 2 s after the last edit of a burst', async () => {
    const h = harness();
    h.engine.start();
    await h.engine.whenIdle();
    const t0 = h.t.clock.now();
    h.replica.mutate();
    await h.t.clock.advance(1_000);
    h.replica.mutate();
    await h.t.clock.advance(LOCAL_EDIT_IDLE_MS - 1);
    expect(h.body.calls).toHaveLength(0);
    expect(h.status.snapshot()).toMatchObject({ kind: 'pending', unsyncedOps: 2 });
    await h.t.clock.advance(1);
    expect(h.body.calls).toEqual([{ reason: 'local-edit', atMs: t0 + 1_000 + LOCAL_EDIT_IDLE_MS, closing: false }]);
    expect(h.status.snapshot()).toMatchObject({ kind: 'up-to-date', unsyncedOps: 0 });
  });

  it('runs no later than 10 s after the first edit of a continuous burst', async () => {
    const h = harness();
    h.engine.start();
    await h.engine.whenIdle();
    const t0 = h.t.clock.now();
    for (let i = 0; i < 12; i++) {
      h.replica.mutate();
      await h.t.clock.advance(1_000);
    }
    expect(h.body.calls[0]).toEqual({ reason: 'local-edit', atMs: t0 + LOCAL_EDIT_MAX_MS, closing: false });
  });

  it('a cycle that starts covers the pending burst (no extra cycle)', async () => {
    const h = harness();
    h.engine.start();
    await h.engine.whenIdle();
    h.replica.mutate();
    await h.engine.runCycle('shared-changed');
    await h.t.clock.advance(LOCAL_EDIT_MAX_MS);
    expect(h.body.reasons()).toEqual(['shared-changed']);
  });

  it('a full-pass request runs the pass in the lane, then a cycle', async () => {
    const h = harness();
    h.engine.start();
    h.replica.fullPassChanges = true;
    h.replica.requestFullPass();
    await flushAsync();
    await h.engine.whenIdle();
    expect(h.replica.fullPasses).toBe(1);
    expect(h.body.reasons()).toEqual(['full-pass']);
  });
});

describe('publish verification and regression back-off (5.7)', () => {
  it('schedules covers checks at +15 s and +60 s and settles after the last covered check', async () => {
    const h = harness();
    h.engine.start();
    await h.engine.whenIdle();
    await h.t.clock.advance(1_000);
    h.body.then(publishes());
    h.body.fallback = reads(S_STATE);
    const t0 = h.t.clock.now();
    await expect(h.engine.runCycle('local-edit')).resolves.toMatchObject({ kind: 'published', sha256: SHA_P });
    expect(h.session.log).toContain(`published:${MARKER.dev}:${MARKER.ms}`);
    await h.t.clock.advance(60_000);
    const verify = h.body.calls.filter((c) => c.reason === 'verify').map((c) => c.atMs - t0);
    expect(verify).toEqual([15_000, 60_000]);
    expect(h.regressions.settled).toBe(1);
  });

  it('does not settle when the last check finds a regression', async () => {
    const h = harness();
    h.engine.start();
    await h.engine.whenIdle();
    await h.t.clock.advance(1_000);
    h.body.then(publishes());
    h.body.fallback = reads(S_STATE);
    h.verifier.verdict = 'regressed';
    await h.engine.runCycle('local-edit');
    await h.t.clock.advance(60_000);
    expect(h.regressions.settled).toBe(0);
  });

  it('a regression back-off pauses publishing, retries at its end and toasts once per back-off', async () => {
    const h = harness();
    const until = h.t.clock.now() + 5_000;
    h.regressions.blocked = until;
    h.body.then(outcome(REGRESSION), outcome(REGRESSION));
    await h.engine.runCycle('shared-changed');
    expect(h.status.snapshot()).toMatchObject({ kind: 'paused', pauseReason: 'regression-backoff', backoffUntilMs: until });
    await h.engine.runCycle('shared-changed');
    expect(toasts(h, 'regression-backoff')).toBe(1);
    h.body.then(async (env) => {
      h.regressions.blocked = null;
      return publishes()(env, 'retry');
    });
    await h.t.clock.advance(5_000);
    expect(h.body.calls[2]).toMatchObject({ reason: 'retry', atMs: until });
    expect(h.status.snapshot()).toMatchObject({ kind: 'up-to-date', pauseReason: null, backoffUntilMs: null });
    h.regressions.blocked = h.t.clock.now() + 10_000;
    h.body.then(outcome(REGRESSION));
    await h.engine.runCycle('shared-changed');
    expect(toasts(h, 'regression-backoff')).toBe(2);
  });
});

describe('error back-off', () => {
  it('retries at 5 s doubling; Sync now clears it', async () => {
    const h = harness();
    h.body.fallback = outcome({ kind: 'error', message: 'Error' });
    const t0 = h.t.clock.now();
    await h.engine.runCycle('unlock');
    expect(h.status.snapshot()).toMatchObject({ kind: 'error', backoffUntilMs: t0 + 5_000 });
    await h.t.clock.advance(5_000 + 10_000 + 20_000);
    expect(h.body.calls.map((c) => [c.reason, c.atMs - t0])).toEqual([
      ['unlock', 0],
      ['retry', 5_000],
      ['retry', 15_000],
      ['retry', 35_000],
    ]);
    const now = h.t.clock.now();
    await h.engine.syncNow();
    expect(h.status.snapshot().backoffUntilMs).toBe(now + 5_000);
    h.body.fallback = async () => UP_TO_DATE;
    await h.t.clock.advance(5_000);
    expect(h.status.snapshot()).toMatchObject({ kind: 'up-to-date', backoffUntilMs: null });
    expect(h.backoff.active()).toBe(false);
  });

  it('three lost CAS attempts retry at the outcome time', async () => {
    const h = harness();
    const at = h.t.clock.now() + 7_000;
    h.body.then(outcome({ kind: 'backoff', untilMs: at }));
    await h.engine.runCycle('local-edit');
    expect(h.status.snapshot().backoffUntilMs).toBe(at);
    await h.t.clock.advance(7_000);
    expect(h.body.calls[1]).toMatchObject({ reason: 'retry', atMs: at });
  });

  it('a thrown cycle body is logged and becomes an error outcome', async () => {
    const h = harness();
    h.body.then(async () => {
      throw Object.assign(new Error('boom'), { code: 'EIO' });
    });
    await expect(h.engine.runCycle('unlock')).resolves.toEqual({ kind: 'error', message: 'Error' });
    expect(h.t.logger.messages('error')).toContain('[sync] cycle failed');
    expect(h.t.logger.unprefixed()).toEqual([]);
  });
});

describe('status transitions', () => {
  it('maps outcomes to kinds and schedules re-checks', async () => {
    const h = harness();
    const gate = deferred();
    h.body.then(blocked(gate));
    const c = h.engine.runCycle('unlock');
    await flushAsync();
    expect(h.status.snapshot().kind).toBe('syncing');
    gate.resolve();
    await c;
    expect(h.status.snapshot()).toMatchObject({ kind: 'up-to-date', lastSyncedMs: h.t.clock.now() });
    const steps: [CycleOutcome, string][] = [
      [{ kind: 'missing', debounced: true }, 'file-not-found'],
      [{ kind: 'unreachable', code: 'EIO' }, 'offline'],
      [{ kind: 'paused', reason: 'epoch-newer' }, 'paused'],
      [{ kind: 'skipped', reason: 'kill-switch' }, 'paused'],
      [{ kind: 'skipped', reason: 'soft-locked' }, 'paused'],
      [{ kind: 'merged-not-published', reason: 'side-files' }, 'paused'],
      [UP_TO_DATE, 'up-to-date'],
    ];
    for (const [o, kind] of steps) {
      h.body.then(outcome(o));
      await h.engine.runCycle('shared-changed');
      expect(h.status.snapshot().kind).toBe(kind);
    }
    expect(h.t.events.of('sync:state-changed').map((s) => s.pauseReason).filter((r) => r !== null)).toEqual([
      'epoch-newer',
      'kill-switch',
      'displaced',
      'side-files',
    ]);
    expect(kinds(h)[0]).toBe('syncing');
  });

  it('kill switch: nothing publishes, edits keep counting, the pause lifts with the switch', async () => {
    const h = harness();
    h.engine.start();
    await h.engine.whenIdle();
    h.body.then(outcome({ kind: 'skipped', reason: 'kill-switch' }));
    h.replica.mutate();
    await h.t.clock.advance(LOCAL_EDIT_IDLE_MS);
    expect(h.status.snapshot()).toMatchObject({ kind: 'paused', pauseReason: 'kill-switch', unsyncedOps: 1, pendingPublish: true });
    h.body.then(publishes());
    await h.engine.syncNow();
    expect(h.status.snapshot()).toMatchObject({ kind: 'up-to-date', pauseReason: null, unsyncedOps: 0 });
  });

  it('a missing file not yet debounced is looked at again; a torn file at its retry time', async () => {
    const h = harness();
    const t0 = h.t.clock.now();
    h.body.then(outcome({ kind: 'missing', debounced: false }), outcome({ kind: 'unreadable', retryAtMs: t0 + MISSING_RECHECK_MS + 5_000 }));
    await h.engine.runCycle('shared-changed');
    await h.t.clock.advance(MISSING_RECHECK_MS);
    expect(h.status.snapshot()).toMatchObject({ kind: 'paused', pauseReason: 'unreadable' });
    await h.t.clock.advance(5_000);
    expect(h.body.calls.map((c) => [c.reason, c.atMs - t0])).toEqual([
      ['shared-changed', 0],
      ['retry', MISSING_RECHECK_MS],
      ['retry', MISSING_RECHECK_MS + 5_000],
    ]);
  });
});
