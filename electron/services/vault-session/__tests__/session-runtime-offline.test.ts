// @vitest-environment node
// The runtime when the server goes away (spec 6.3 step 5, 6.8): a heartbeat landing during the
// sign-out release never acquires a lease nobody releases; [Use here instead] that cannot reach
// the server never soft-locks as "unanswered" and a later denial asks again; a limit the server
// keeps confirming stays fresh in local.json, so going offline after days of uptime keeps it.
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempRoot } from '../../sync/__tests__/host-fakes.js';
import type { LocalJson } from '../../sync/types.js';
import { RECONNECT_ANSWER_MS } from '../displacement.js';
import { LAST_LIMIT_REFRESH_MS, LIMIT_CACHE_MAX_AGE_MS } from '../effective-limit.js';
import { HEARTBEAT_MS, OFFLINE_RETRY_MS } from '../heartbeat.js';
import { LeaseTracker } from '../lease.js';
import { PersonalVaultRuntime } from '../session-runtime.js';
import { SessionClient, type AcquireResult } from '../session-client.js';
import type { RpcResult } from '../host.js';
import { deferred, denied, granted as grantedAnswer, lost } from './heartbeat-harness.js';
import { LINEAGE, NONCE, OWN, RuntimeEngine, RuntimeReplica, USER } from './runtime-fakes.js';
import { makeTestSessionHost, rpcFail, rpcOk, type TestSessionHost } from './session-fakes.js';

const LEASE = '55555555-5555-4555-8555-555555555555';
const LATE_LEASE = '66666666-6666-4666-8666-000000000009';
const DAY_MS = 24 * 60 * 60 * 1000;
const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

interface Rig {
  readonly t: TestSessionHost;
  readonly lease: LeaseTracker;
  readonly replica: RuntimeReplica;
  readonly runtime: PersonalVaultRuntime;
  /** local.json writes that changed lastLimit. */
  readonly limitWrites: () => number;
}

function rig(): Rig {
  const root = makeTempRoot('runtime-offline');
  roots.push(root);
  const t = makeTestSessionHost(root);
  t.knobs.userId = USER;
  const lease = new LeaseTracker();
  const replica = new RuntimeReplica();
  let writes = 0;
  const update = replica.updateLocal.bind(replica);
  replica.updateLocal = (fn: (l: LocalJson) => LocalJson): LocalJson => {
    const before = replica.local().lastLimit;
    const after = update(fn);
    if (after.lastLimit !== before) writes += 1;
    return after;
  };
  const runtime = new PersonalVaultRuntime({
    host: t.host,
    config: { syncRoot: root, machineDir: root, dataDir: root, deviceUuid: OWN, sessionNonce: NONCE },
    lineageId: LINEAGE,
    shared: true,
    fileName: 'Vault.conduit',
    client: new SessionClient(t.rpc, t.host),
    lease,
    replica: replica.asReplica(),
  });
  runtime.attachEngine(new RuntimeEngine().asEngine());
  return { t, lease, replica, runtime, limitWrites: () => writes };
}

function granted(limit: number): AcquireResult {
  return { kind: 'granted', leaseId: LEASE, limit, sessions: [], serverNowMs: null, deviceCap: null, ownership: null };
}

describe('sign-out while a heartbeat is due', () => {
  it('a beat that would land during the release neither runs nor acquires a new lease', async () => {
    const r = rig();
    const slowRelease = deferred<RpcResult>();
    r.t.rpc.handle('vault_session_release', () => slowRelease.promise);
    r.t.rpc.handle('vault_session_heartbeat', () => lost('released'));
    r.t.rpc.handle('vault_session_acquire', () => grantedAnswer(LATE_LEASE));
    r.runtime.start(granted(1));
    await r.t.clock.advance(HEARTBEAT_MS - 1_000);
    const signingOut = r.runtime.signedOut();
    await r.t.clock.advance(2_000);
    slowRelease.resolve(rpcOk(null));
    await signingOut;
    r.t.knobs.userId = null;
    expect(r.t.rpc.callsOf('vault_session_acquire')).toEqual([]);
    expect(r.t.rpc.callsOf('vault_session_heartbeat')).toEqual([]);
    expect(r.t.rpc.callsOf('vault_session_release').map((c) => c.args.p_lease_id)).toEqual([LEASE]);
    expect(r.lease.state()).toEqual({ kind: 'none' });
  });
});

describe('reconnect conflict answered while the server is unreachable', () => {
  it('[Use here instead] that gets no answer never soft-locks; the next denial asks again', async () => {
    const r = rig();
    r.t.rpc.enqueue('vault_session_acquire', denied(), rpcFail({ kind: 'network' }), denied());
    r.runtime.start({ kind: 'unconfirmed', reason: 'network', detail: 'network' });
    await r.t.clock.advance(OFFLINE_RETRY_MS);
    expect(r.t.sessionEvents.of('vault:session-conflict')).toHaveLength(1);
    await r.runtime.answerConflict('use-here');
    expect(r.t.rpc.callsOf('vault_session_acquire')[1]?.args.p_takeover).toBe(true);
    await r.t.clock.advance(RECONNECT_ANSWER_MS);
    expect(r.t.sessionEvents.of('vault:session-displaced')).toEqual([]);
    expect(r.t.access.log).toEqual([]);
    expect(r.runtime.isSoftLocked()).toBe(false);
    const again = r.t.sessionEvents.of('vault:session-conflict');
    expect(again).toHaveLength(2);
    expect(again[1]?.answerByMs).toBe(r.t.clock.now() + RECONNECT_ANSWER_MS);
    await r.runtime.lock();
  });
});

describe('offline limit after long uptime (6.8)', () => {
  it('a Pro limit confirmed minutes before going offline still applies after days of uptime', async () => {
    const r = rig();
    let online = true;
    r.t.rpc.handle('vault_session_heartbeat', () =>
      online ? rpcOk({ status: 'ok', limit: -1, sessions: [], server_now: new Date(r.t.clock.now()).toISOString() }) : rpcFail({ kind: 'network' }),
    );
    r.runtime.start(granted(-1));
    const uptimeMs = LIMIT_CACHE_MAX_AGE_MS + DAY_MS;
    for (let t = 0; t < uptimeMs; t += DAY_MS) await r.t.clock.advance(DAY_MS);
    expect(r.runtime.effectiveLimit()).toEqual({ limit: -1, source: 'server' });
    online = false;
    await r.t.clock.advance(2 * 60_000);
    expect(r.runtime.effectiveLimit()).toEqual({ limit: -1, source: 'local-json' });
    expect(r.t.clock.now() - (r.replica.local().lastLimit?.atMs ?? 0)).toBeLessThanOrEqual(LAST_LIMIT_REFRESH_MS + 2 * 60_000 + HEARTBEAT_MS);
    expect(r.limitWrites()).toBeLessThanOrEqual(Math.ceil(uptimeMs / LAST_LIMIT_REFRESH_MS) + 2);
    await r.runtime.lock();
  }, 60_000);
});
