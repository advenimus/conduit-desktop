// @vitest-environment node
// PersonalVaultRuntime (spec 6.2, 6.4, 6.6-6.8, 6.11) on a FakeClock with a
// scripted RPC: the SessionSignals rules, lock order and release payload, quit bounded by its
// timeout, claims displacement scheduled outside the engine's call, the reconnect conflict and
// its 60 s answer timer, the offline badge and lastLimit, and a private vault.
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { flushAsync, makeTempRoot } from '../../sync/__tests__/host-fakes.js';
import { HEARTBEAT_MS, OFFLINE_RETRY_MS } from '../heartbeat.js';
import { LeaseTracker } from '../lease.js';
import { RECONNECT_ANSWER_MS } from '../displacement.js';
import { PersonalVaultRuntime, SERVER_SIDE_FILES_WINDOW_MS, type RuntimeDeps } from '../session-runtime.js';
import { QUIT_RELEASE_TIMEOUT_MS, SessionClient, markerToJson, type AcquireResult } from '../session-client.js';
import type { SessionRowView } from '../../sync/host.js';
import { makeTestSessionHost, rpcOk, type TestSessionHost } from './session-fakes.js';
import { granted as grantedAnswer, denied as deniedAnswer } from './heartbeat-harness.js';
import { row } from './stale-fixtures.js';
import { LINEAGE, NONCE, OTHER, OWN, RuntimeEngine, RuntimeReplica, USER, presence, stateWithClaim, withOwnClaim } from './runtime-fakes.js';

const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

interface Rig {
  readonly t: TestSessionHost;
  readonly lease: LeaseTracker;
  readonly engine: RuntimeEngine;
  readonly replica: RuntimeReplica;
  readonly runtime: PersonalVaultRuntime;
  readonly log: string[];
}

function rig(opts: { signedIn?: boolean; shared?: boolean } = {}): Rig {
  const root = makeTempRoot('runtime');
  roots.push(root);
  const t = makeTestSessionHost(root);
  t.knobs.userId = opts.signedIn === false ? null : USER;
  const lease = new LeaseTracker();
  const log: string[] = [];
  const engine = new RuntimeEngine();
  const replica = new RuntimeReplica(log);
  const shared = opts.shared ?? true;
  const deps: RuntimeDeps = {
    host: t.host,
    config: { syncRoot: root, machineDir: root, dataDir: root, deviceUuid: OWN, sessionNonce: NONCE },
    lineageId: LINEAGE,
    shared,
    fileName: 'Vault.conduit',
    client: new SessionClient(t.rpc, t.host),
    lease,
    replica: shared ? replica.asReplica() : null,
  };
  const runtime = new PersonalVaultRuntime(deps);
  if (shared) runtime.attachEngine(engine.asEngine());
  return { t, lease, engine, replica, runtime, log };
}

function granted(limit = 1, sessions: readonly SessionRowView[] = []): AcquireResult {
  return { kind: 'granted', leaseId: '55555555-5555-4555-8555-555555555555', limit, sessions, serverNowMs: null, deviceCap: null, ownership: null };
}

describe('PersonalVaultRuntime signals', () => {
  it('reports a server side-file flag for 2 hours, never from the future', () => {
    const r = rig();
    const now = r.t.clock.now();
    const flagged = (lastActiveMs: number) => row({ deviceId: OTHER, sideFilesFlag: true, lastActiveMs });
    r.runtime.start(granted(1, [flagged(now - SERVER_SIDE_FILES_WINDOW_MS + 1)]));
    const s = r.runtime.signals();
    expect(s.serverSideFilesFlagRecent(now)).toBe(true);
    expect(s.serverSideFilesFlagRecent(now + 2)).toBe(false);
    r.lease.onAcquire(granted(1, [flagged(now + 10 * 60 * 1000)]), now);
    expect(s.serverSideFilesFlagRecent(now)).toBe(false);
    expect(s.sessions()).toHaveLength(1);
    expect(s.sessionOpen()).toBe(true);
    expect(s.softLocked()).toBe(false);
  });

  it('starts confirmed with the server limit in local.json and no offline badge', () => {
    const r = rig();
    r.runtime.start(granted(-1));
    expect(r.replica.local().lastLimit).toEqual({ value: -1, atMs: r.t.clock.now() });
    expect(r.engine.badges.at(-1)).toBeNull();
    expect(r.runtime.effectiveLimit()).toEqual({ limit: -1, source: 'server' });
  });

  it('a publish marker reaches the next heartbeat soon, outside the engine call', async () => {
    const r = rig();
    r.t.rpc.handle('vault_session_heartbeat', () => rpcOk({ status: 'ok', limit: 1, sessions: [], server_now: new Date(r.t.clock.now()).toISOString() }));
    r.runtime.start(granted());
    r.runtime.signals().published({ dev: 9, ms: 700, c: 1 });
    expect(r.t.rpc.callsOf('vault_session_heartbeat')).toHaveLength(0);
    await r.t.clock.advance(0);
    const beats = r.t.rpc.callsOf('vault_session_heartbeat');
    expect(beats).toHaveLength(1);
    expect(beats[0].args.p_written_vv).toEqual(markerToJson({ dev: 9, ms: 700, c: 1 }));
    expect(r.lease.markerToSend()).toBeNull();
    await r.runtime.lock();
  });
});

describe('PersonalVaultRuntime lock and quit (6.4)', () => {
  it('lock: final cycle, stop, release with the marker and pending flag, then W closes', async () => {
    const r = rig();
    r.t.rpc.handle('vault_session_release', () => {
      r.log.push('release');
      return rpcOk(null);
    });
    r.runtime.start(granted());
    r.lease.markerPublished({ dev: 9, ms: 800, c: 0 });
    r.engine.final = { published: false, timedOut: true, pendingPublish: true, marker: null };
    const out = await r.runtime.lock();
    expect(out).toEqual({ published: false, pendingPublish: true, released: true });
    expect(r.engine.calls.slice(0, 2)).toEqual(['final:lock', 'stop']);
    expect(r.log).toEqual(['release', 'close']);
    const release = r.t.rpc.callsOf('vault_session_release')[0];
    expect(release.args).toMatchObject({ p_written_vv: markerToJson({ dev: 9, ms: 800, c: 0 }), p_pending: true });
    expect(r.runtime.signals().sessionOpen()).toBe(false);
    expect(r.lease.state()).toEqual({ kind: 'lost', reason: 'released' });
    expect(await r.runtime.lock()).toBe(out);
    expect(r.t.clock.pending()).toBe(0);
  });

  it('quit is bounded by the quit release timeout when the server never answers', async () => {
    const r = rig();
    r.t.rpc.handle('vault_session_release', () => new Promise(() => undefined));
    r.runtime.start(granted());
    let done = false;
    const quitting = r.runtime.quit().then((o) => {
      done = true;
      return o;
    });
    // The final cycle and the stop settle first; then the release call waits on its timeout.
    await flushAsync();
    expect(r.t.rpc.callsOf('vault_session_release')).toHaveLength(1);
    await r.t.clock.advance(QUIT_RELEASE_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    await r.t.clock.advance(1);
    expect(await quitting).toEqual({ published: true, pendingPublish: false, released: false });
    expect(r.replica.closed).toBe(1);
    expect(r.t.rpc.callsOf('vault_session_release')[0].timeoutMs).toBe(QUIT_RELEASE_TIMEOUT_MS);
  });

  it('a private vault releases its lease without any final cycle', async () => {
    const r = rig({ shared: false });
    r.t.rpc.handle('vault_session_release', () => rpcOk(null));
    r.runtime.start(granted());
    expect(await r.runtime.lock()).toEqual({ published: true, pendingPublish: false, released: true });
    expect(r.engine.calls).toEqual([]);
  });
});

describe('PersonalVaultRuntime claims and conflicts', () => {
  it('another active claimant displaces this device after the merge call returned (6.7)', async () => {
    const r = rig({ signedIn: false });
    r.runtime.start(null);
    const state = stateWithClaim(presence('iPad', r.t.clock.now()), true);
    r.replica.current = state;
    r.runtime.signals().afterMerge(state);
    expect(r.t.access.log).toEqual([]);
    await r.t.clock.advance(0);
    expect(r.t.access.log).toEqual(['block:open_elsewhere', 'soft-lock:open_elsewhere']);
    expect(r.t.sessionEvents.last('vault:session-displaced')).toMatchObject({ reason: 'owner_claim', byDeviceName: 'iPad', changesSaved: true });
    expect(r.engine.calls).toContain('final:displaced');
    expect(r.runtime.isSoftLocked()).toBe(true);
    expect(await r.runtime.lock()).toMatchObject({ released: false });
  });

  it('claims are not checked before start: the unlock merge precedes this device\'s own claim (6.7)', async () => {
    const r = rig({ signedIn: false });
    const old = stateWithClaim(presence('iPad', r.t.clock.now()), true);
    r.replica.current = old;
    r.runtime.signals().afterMerge(old);
    await r.t.clock.advance(0);
    await flushAsync();
    expect(r.t.access.log).toEqual([]);
    expect(r.t.clock.pending()).toBe(0);
    r.replica.current = withOwnClaim(old);
    r.runtime.start(null);
    r.runtime.signals().afterMerge(old);
    await r.t.clock.advance(0);
    await flushAsync();
    expect(r.t.access.log).toEqual([]);
    expect(r.runtime.isSoftLocked()).toBe(false);
    await r.runtime.lock();
  });

  it('the check reads W when it runs, after the work already queued in the lane', async () => {
    const r = rig({ signedIn: false });
    r.runtime.start(null);
    const old = stateWithClaim(presence('iPad', r.t.clock.now()), true);
    r.replica.current = old;
    r.runtime.signals().afterMerge(old);
    r.replica.current = withOwnClaim(old);
    await r.t.clock.advance(0);
    await flushAsync();
    expect(r.engine.calls).toContain('exclusive');
    expect(r.t.access.log).toEqual([]);
    await r.runtime.lock();
  });

  it('no displacement when this device holds the claim or claims do not apply', async () => {
    const r = rig();
    r.runtime.start(granted(-1));
    r.runtime.signals().afterMerge(stateWithClaim(presence('iPad', r.t.clock.now()), true));
    await r.t.clock.advance(0);
    expect(r.t.access.log).toEqual([]);
    await r.runtime.lock();
  });

  it('reconnect conflict: the dialog event carries the answer time; no answer in 60 s soft-locks (6.8)', async () => {
    const r = rig();
    r.t.rpc.enqueue('vault_session_acquire', deniedAnswer());
    r.runtime.start({ kind: 'unconfirmed', reason: 'network', detail: 'network' });
    expect(r.engine.badges.at(-1)).toBe('offline-device-check');
    await r.t.clock.advance(OFFLINE_RETRY_MS);
    const conflict = r.t.sessionEvents.last('vault:session-conflict');
    expect(conflict?.answerByMs).toBe(r.t.clock.now() + RECONNECT_ANSWER_MS);
    await r.t.clock.advance(RECONNECT_ANSWER_MS);
    expect(r.t.sessionEvents.last('vault:session-displaced')).toMatchObject({ reason: 'reconnect_unanswered' });
  });

  it('[Use here instead] takes over, cancels the timer and writes the owner claim', async () => {
    const r = rig();
    r.t.rpc.enqueue('vault_session_acquire', deniedAnswer(), grantedAnswer('55555555-5555-4555-8555-555555555556'));
    r.t.rpc.handle('vault_session_heartbeat', () => rpcOk({ status: 'ok', limit: 1, sessions: [], server_now: new Date(r.t.clock.now()).toISOString() }));
    r.t.rpc.handle('vault_session_release', () => rpcOk(null));
    r.runtime.start({ kind: 'unconfirmed', reason: 'network', detail: 'network' });
    await r.t.clock.advance(OFFLINE_RETRY_MS);
    await r.runtime.answerConflict('use-here');
    expect(r.t.rpc.callsOf('vault_session_acquire').at(-1)?.args.p_takeover).toBe(true);
    expect(r.replica.writes).toHaveLength(1);
    expect(r.engine.badges.at(-1)).toBeNull();
    await r.t.clock.advance(RECONNECT_ANSWER_MS + HEARTBEAT_MS);
    expect(r.t.sessionEvents.of('vault:session-displaced')).toEqual([]);
    await r.runtime.lock();
  });

  it('[Lock here] displaces at once with the holder name', async () => {
    const r = rig();
    r.t.rpc.enqueue('vault_session_acquire', deniedAnswer());
    r.runtime.start({ kind: 'unconfirmed', reason: 'network', detail: 'network' });
    await r.t.clock.advance(OFFLINE_RETRY_MS);
    await r.runtime.answerConflict('lock-here');
    expect(r.t.sessionEvents.last('vault:session-displaced')).toMatchObject({ reason: 'yielded' });
  });

  it('signed out mid-session: releases, stops the heartbeat and falls back to limit 1', async () => {
    const r = rig();
    r.t.rpc.handle('vault_session_release', () => rpcOk(null));
    r.runtime.start(granted(-1));
    await r.runtime.signedOut();
    r.t.knobs.userId = null;
    expect(r.t.rpc.callsOf('vault_session_release')).toHaveLength(1);
    expect(r.lease.state()).toEqual({ kind: 'none' });
    expect(r.runtime.effectiveLimit()).toEqual({ limit: 1, source: 'default' });
    await r.t.clock.advance(HEARTBEAT_MS * 2);
    expect(r.t.rpc.callsOf('vault_session_heartbeat')).toHaveLength(0);
  });

  it('explicit sign-out then the auth hook: one release while signed in, and the badge clears', async () => {
    const r = rig();
    r.t.rpc.handle('vault_session_release', () => rpcOk(null));
    r.runtime.start(granted(-1));
    await Promise.all([r.runtime.signedOut(), r.runtime.signedOut()]);
    expect(r.t.rpc.callsOf('vault_session_release')).toHaveLength(1);
    r.t.knobs.userId = null;
    await r.runtime.signedOut();
    expect(r.t.rpc.callsOf('vault_session_release')).toHaveLength(1);
    expect(r.lease.state()).toEqual({ kind: 'none' });
    expect(r.engine.badges.at(-1)).toBeNull();
  });
});
