// @vitest-environment node
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushAsync, makeTempRoot } from '../../sync/__tests__/host-fakes.js';
import type { FinalOutcome } from '../../sync/sync-engine.js';
import type { AppDot } from '../../sync/types.js';
import {
  DISPLACED_FINAL_SYNC_CAP_MS,
  Displacement,
  FINAL_SYNC_BACKSTOP_MS,
  RECONNECT_ANSWER_MS,
  STEP_BACKSTOP_MS,
  type DisplacementDeps,
} from '../displacement.js';
import type { LockedReason, SessionDisplacedEvent, SessionEventMap, VaultAccessHost } from '../host.js';
import { makeTestSessionHost, type TestSessionHost } from './session-fakes.js';

const LINEAGE = '0b8f3d52-6c41-4f0e-9d7e-1c2a3b4c5d6e';
const MARKER: AppDot = { dev: 101, ms: Date.UTC(2026, 8, 25, 12, 0, 1), c: 0 };
const PUBLISHED: FinalOutcome = { published: true, timedOut: false, pendingPublish: false, marker: MARKER };
const NOT_PUBLISHED: FinalOutcome = { published: false, timedOut: true, pendingPublish: true, marker: null };

/** Records every step of the sequence in one trace. */
class Trace {
  readonly steps: string[] = [];
  readonly releases: { readonly marker: AppDot | null; readonly pending: boolean }[] = [];
  readonly events: SessionDisplacedEvent[] = [];
  readonly displacing: SessionEventMap['vault:session-displacing'][] = [];
  /** Stand-in for LeaseTracker's marker rule: the engine's publish sets it, release sends it. */
  markerToSend: AppDot | null = null;

  access(): VaultAccessHost {
    return {
      blockAccess: (reason: LockedReason) => this.steps.push(`block:${reason}`),
      softLock: (reason: LockedReason) => this.steps.push(`soft-lock:${reason}`),
      openPrivateInPlace: async () => undefined,
      createPrivateInPlace: async () => undefined,
    };
  }

  emitter(): TestSessionHost['host']['sessionEvents'] {
    return {
      emit: <K extends keyof SessionEventMap & string>(channel: K, payload: SessionEventMap[K]) => {
        this.steps.push(`event:${channel}`);
        if (channel === 'vault:session-displacing') this.displacing.push(payload as SessionEventMap['vault:session-displacing']);
        else this.events.push(payload as SessionDisplacedEvent);
      },
    };
  }
}

describe('Displacement (6.6)', () => {
  let root: string;
  let t: TestSessionHost;
  let trace: Trace;

  beforeEach(() => {
    root = makeTempRoot('displacement');
    trace = new Trace();
    t = makeTestSessionHost(root, { access: trace.access(), sessionEvents: trace.emitter() });
  });

  afterEach(() => {
    expect(t.clock.pending()).toBe(0);
    expect(t.logger.unprefixed()).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  function make(patch: Partial<DisplacementDeps> = {}): Displacement {
    return new Displacement({
      lineageId: LINEAGE,
      fileName: 'Vault.conduit',
      host: t.host,
      finalSync: async () => {
        trace.steps.push('final-sync');
        trace.markerToSend = MARKER;
        return PUBLISHED;
      },
      release: async (pending) => {
        trace.steps.push(`release:pending=${pending}`);
        trace.releases.push({ marker: trace.markerToSend, pending });
      },
      teardown: async () => {
        trace.steps.push('teardown');
      },
      ...patch,
    });
  }

  it('runs block, final sync, release, teardown, soft lock, modal event in that order (12 row 66)', async () => {
    t.busy.report = { sessions: 3, jobs: 1 };
    const d = make();
    const outcome = await d.displace('takeover', 'iPhone');
    expect(trace.steps).toEqual([
      'block:open_elsewhere',
      'event:vault:session-displacing',
      'final-sync',
      'release:pending=false',
      'teardown',
      'soft-lock:open_elsewhere',
      'event:vault:session-displaced',
    ]);
    expect(trace.releases).toEqual([{ marker: MARKER, pending: false }]);
    expect(outcome).toEqual({ reason: 'takeover', byDeviceName: 'iPhone', changesSaved: true });
    expect(trace.displacing).toEqual([{ lineageId: LINEAGE, reason: 'takeover', byDeviceName: 'iPhone' }]);
    const event = trace.events[0]!;
    expect(event).toEqual({
      lineageId: LINEAGE,
      reason: 'takeover',
      byDeviceName: 'iPhone',
      openConnections: 3,
      runningJobs: 1,
      changesSaved: true,
      fileName: 'Vault.conduit',
    });
    expect(d.softLocked()).toBe(true);
    expect(d.inProgress()).toBe(false);
  });

  it('blocks access at once, before the final sync finishes (overlay first)', async () => {
    let finish: (o: FinalOutcome) => void = () => undefined;
    const d = make({ finalSync: () => new Promise<FinalOutcome>((resolve) => (finish = resolve)) });
    const running = d.displace('owner_claim', 'iPad');
    expect(trace.steps).toEqual(['block:open_elsewhere', 'event:vault:session-displacing']);
    expect(d.inProgress()).toBe(true);
    expect(d.softLocked()).toBe(false);
    await t.clock.advance(DISPLACED_FINAL_SYNC_CAP_MS - 1);
    expect(trace.steps).toEqual(['block:open_elsewhere', 'event:vault:session-displacing']);
    finish(PUBLISHED);
    await running;
    expect(d.softLocked()).toBe(true);
  });

  it('runs once: later calls return the first promise', async () => {
    const d = make();
    const first = d.displace('takeover', 'iPhone');
    const second = d.displace('plan_limit', null);
    expect(second).toBe(first);
    await first;
    expect(await d.displace('superseded', null)).toEqual({ reason: 'takeover', byDeviceName: 'iPhone', changesSaved: true });
    expect(trace.steps.filter((s) => s.startsWith('soft-lock'))).toHaveLength(1);
    expect(trace.events).toHaveLength(1);
  });

  it('a failing final sync still soft-locks, releases with pending = true (12 row 27)', async () => {
    const d = make({
      finalSync: async () => {
        throw new Error('EIO');
      },
    });
    const outcome = await d.displace('takeover', 'iPhone');
    expect(outcome.changesSaved).toBe(false);
    expect(trace.releases[0].pending).toBe(true);
    expect(trace.steps.slice(-2)).toEqual(['soft-lock:open_elsewhere', 'event:vault:session-displaced']);
    expect(trace.events[0]).toMatchObject({ reason: 'takeover', changesSaved: false });
    expect(t.logger.messages('error')).toContain('[vault-session] displacement step failed: final sync');
  });

  it('a final cycle that hit the engine cap without publishing counts as not saved', async () => {
    const d = make({
      finalSync: async () => {
        await t.clock.sleep(DISPLACED_FINAL_SYNC_CAP_MS);
        return NOT_PUBLISHED;
      },
    });
    const running = d.displace('plan_limit', 'MacBook');
    await t.clock.advance(DISPLACED_FINAL_SYNC_CAP_MS);
    expect((await running).changesSaved).toBe(false);
    expect(trace.releases[0].pending).toBe(true);
    expect(t.logger.messages('warn')).toContain('[vault-session] final sync hit its cap');
  });

  it('an up-to-date final cycle (nothing to publish) counts as saved', async () => {
    const d = make({ finalSync: async () => ({ published: false, timedOut: false, pendingPublish: false, marker: null }) });
    expect((await d.displace('takeover', 'iPhone')).changesSaved).toBe(true);
  });

  it('a hung final sync is cut off by the backstop and the soft lock happens regardless', async () => {
    const d = make({ finalSync: () => new Promise<FinalOutcome>(() => undefined) });
    const running = d.displace('takeover', 'iPhone');
    await t.clock.advance(FINAL_SYNC_BACKSTOP_MS - 1);
    expect(d.softLocked()).toBe(false);
    await t.clock.advance(1);
    const outcome = await running;
    expect(outcome.changesSaved).toBe(false);
    expect(d.softLocked()).toBe(true);
    expect(trace.releases[0].pending).toBe(true);
  });

  it('private vaults have nothing to publish: saved, release pending = false', async () => {
    const d = make({ finalSync: null });
    expect((await d.displace('takeover', 'iPhone')).changesSaved).toBe(true);
    expect(trace.steps[2]).toBe('release:pending=false');
  });

  it('every failing step is logged and the sequence continues', async () => {
    t = makeTestSessionHost(root, {
      access: {
        ...trace.access(),
        blockAccess: () => {
          throw new Error('renderer gone');
        },
      },
      sessionEvents: {
        emit: () => {
          throw new Error('no window');
        },
      },
    });
    t.busy.busy = () => {
      throw new Error('busy probe');
    };
    const d = make({
      release: async () => {
        throw new Error('network');
      },
      teardown: async () => {
        throw new Error('engine');
      },
    });
    const outcome = await d.displace('superseded', null);
    expect(outcome).toEqual({ reason: 'superseded', byDeviceName: null, changesSaved: true });
    expect(trace.steps).toEqual(['final-sync', 'soft-lock:open_elsewhere']);
    expect(t.logger.messages('error')).toEqual([
      '[vault-session] displacement step failed: block access',
      '[vault-session] displacement step failed: displacing event',
      '[vault-session] displacement step failed: release',
      '[vault-session] displacement step failed: teardown',
      '[vault-session] busy report failed',
      '[vault-session] displacement step failed: displaced event',
    ]);
  });

  it('a hung teardown is cut off after the step backstop', async () => {
    const d = make({ teardown: () => new Promise<void>(() => undefined) });
    const running = d.displace('takeover', 'iPhone');
    await flushAsync();
    await t.clock.advance(STEP_BACKSTOP_MS);
    await running;
    expect(d.softLocked()).toBe(true);
    expect(t.logger.messages('warn')).toContain('[vault-session] displacement step timed out: teardown');
  });
});

describe('Displacement reconnect timer (6.8)', () => {
  let root: string;
  let t: TestSessionHost;
  let trace: Trace;
  let d: Displacement;

  beforeEach(() => {
    root = makeTempRoot('displacement-reconnect');
    trace = new Trace();
    t = makeTestSessionHost(root, { access: trace.access(), sessionEvents: trace.emitter() });
    d = new Displacement({
      lineageId: LINEAGE,
      fileName: 'Vault.conduit',
      host: t.host,
      finalSync: async () => PUBLISHED,
      release: async () => undefined,
      teardown: async () => undefined,
    });
  });

  afterEach(() => {
    expect(t.clock.pending()).toBe(0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('soft-locks with reconnect_unanswered after 60 s without an answer', async () => {
    const answerBy = d.armReconnectTimer('MacBook');
    expect(answerBy).toBe(t.clock.now() + RECONNECT_ANSWER_MS);
    await t.clock.advance(RECONNECT_ANSWER_MS - 1);
    expect(trace.steps).toEqual([]);
    await t.clock.advance(1);
    expect(d.softLocked()).toBe(true);
    expect(trace.events[0]).toMatchObject({ reason: 'reconnect_unanswered', byDeviceName: 'MacBook' });
  });

  it('a repeated conflict keeps the first deadline', async () => {
    const first = d.armReconnectTimer('MacBook');
    await t.clock.advance(30_000);
    expect(d.armReconnectTimer('MacBook')).toBe(first);
    await t.clock.advance(30_000);
    expect(d.softLocked()).toBe(true);
  });

  it('an answer cancels the timer', async () => {
    d.armReconnectTimer('MacBook');
    d.cancelReconnectTimer();
    await t.clock.advance(2 * RECONNECT_ANSWER_MS);
    expect(trace.steps).toEqual([]);
  });

  it('[Lock here] displaces as yielded and the timer never fires', async () => {
    d.armReconnectTimer('MacBook');
    await d.displace('yielded', 'MacBook');
    await t.clock.advance(RECONNECT_ANSWER_MS);
    expect(trace.events.map((e) => e.reason)).toEqual(['yielded']);
    expect(d.armReconnectTimer('MacBook')).toBe(t.clock.now());
  });
});
