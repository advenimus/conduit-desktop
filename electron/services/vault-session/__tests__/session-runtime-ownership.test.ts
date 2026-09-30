// @vitest-environment node
// Ownership in the running session (docs/PLAN_ENFORCEMENT.md 3.2, 3.3, 4.7; test D7): the
// ownerCheck follows confirmed answers and is never cleared by a sign-out; the owner writes the tag
// once; a release writes {"a": null} and clears the check only on `released: true`; a
// not-owner displacement clears the check; [Use here instead] claims.
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { flushAsync, makeTempRoot } from '../../sync/__tests__/host-fakes.js';
import { HEARTBEAT_MS } from '../heartbeat.js';
import { LeaseTracker } from '../lease.js';
import { ownerHint } from '../owner-tag.js';
import { PersonalVaultRuntime, type RuntimeDeps } from '../session-runtime.js';
import { SessionClient, type AcquireResult, type Ownership } from '../session-client.js';
import { makeTestSessionHost, rpcFail, rpcOk, type TestSessionHost } from './session-fakes.js';
import { LINEAGE, NONCE, OWN, RuntimeEngine, RuntimeReplica, USER } from './runtime-fakes.js';

const roots: string[] = [];
const HINT = ownerHint(LINEAGE, USER);
const TS = '2026-10-13T12:00:00.000Z';

afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

function rig() {
  const root = makeTempRoot('runtime-owner');
  roots.push(root);
  const t: TestSessionHost = makeTestSessionHost(root);
  t.knobs.userId = USER;
  const lease = new LeaseTracker();
  const engine = new RuntimeEngine();
  const replica = new RuntimeReplica();
  const deps: RuntimeDeps = {
    host: t.host,
    config: { syncRoot: root, machineDir: root, dataDir: root, deviceUuid: OWN, sessionNonce: NONCE },
    lineageId: LINEAGE,
    shared: true,
    fileName: 'Vault.conduit',
    client: new SessionClient(t.rpc, t.host),
    lease,
    replica: replica.asReplica(),
  };
  const runtime = new PersonalVaultRuntime(deps);
  runtime.attachEngine(engine.asEngine());
  return { t, lease, engine, replica, runtime };
}

function granted(ownership: Ownership | null): AcquireResult {
  return { kind: 'granted', leaseId: '55555555-5555-4555-8555-555555555555', limit: -1, deviceCap: 5, ownership, sessions: [], serverNowMs: null };
}

const OWNER: Ownership = { kind: 'owner', releaseAfterMs: null, sharedUntilMs: null };

function tagWrites(replica: RuntimeReplica): string[] {
  return replica.writes.flat().filter((w) => w.key.reg === 'account').map((w) => String(w.value));
}

describe('ownerCheck (3.3)', () => {
  it('a grant records the owner check; a grace heartbeat replaces it with the grace end', async () => {
    const r = rig();
    r.runtime.start(granted(OWNER));
    expect(r.replica.local().ownerCheck).toEqual({ hint: HINT, kind: 'owner', untilMs: null, atMs: r.t.clock.now() });
    r.t.rpc.handle('vault_session_heartbeat', () => rpcOk({ status: 'ok', limit: -1, sessions: [], server_now: TS, ownership: 'grace', grace_until: TS }));
    await r.t.clock.advance(HEARTBEAT_MS);
    await flushAsync();
    expect(r.replica.local().ownerCheck).toMatchObject({ hint: HINT, kind: 'grace', untilMs: Date.parse(TS) });
    await r.runtime.lock();
  });

  it('unowned and unknown answers keep the stored check', () => {
    const r = rig();
    r.runtime.start(granted({ kind: 'unowned' }));
    expect(r.replica.local().ownerCheck).toBeNull();
  });

  it('is never cleared by a sign-out', async () => {
    const r = rig();
    r.t.rpc.handle('vault_session_release', () => rpcOk(null));
    r.runtime.start(granted(OWNER));
    await r.runtime.signedOut();
    expect(r.replica.local().ownerCheck).toMatchObject({ kind: 'owner', hint: HINT });
  });

  it('a not-owner displacement clears it', async () => {
    const r = rig();
    r.t.rpc.handle('vault_session_release', () => rpcOk(null));
    r.runtime.start(granted(OWNER));
    await r.runtime.displace('not_owner', null, { minVersion: null, released: false });
    expect(r.replica.local().ownerCheck).toBeNull();
  });
});

describe('ownership events', () => {
  it('a changed ownership reaches the renderer once; an unchanged one is not sent again', async () => {
    const r = rig();
    r.runtime.start(granted(OWNER));
    r.t.rpc.handle('vault_session_heartbeat', () =>
      rpcOk({ status: 'ok', limit: -1, sessions: [], server_now: TS, ownership: 'owner', release_after: null, shared_until: TS }),
    );
    await r.t.clock.advance(HEARTBEAT_MS);
    await flushAsync();
    await r.t.clock.advance(HEARTBEAT_MS);
    await flushAsync();
    expect(r.t.sessionEvents.events.filter((e) => e.channel === 'vault:session-ownership')).toEqual([
      { channel: 'vault:session-ownership', payload: { lineageId: LINEAGE } },
    ]);
    await r.runtime.lock();
  });
});

describe('owner tag while running (3.2)', () => {
  it('a heartbeat ok as owner writes the tag once, grace never', async () => {
    const r = rig();
    r.runtime.start(granted(null));
    r.t.rpc.handle('vault_session_heartbeat', () => rpcOk({ status: 'ok', limit: -1, sessions: [], server_now: TS, ownership: 'owner', release_after: TS }));
    await r.t.clock.advance(HEARTBEAT_MS);
    await flushAsync();
    expect(tagWrites(r.replica)).toEqual([`{"a":"${HINT}"}`]);
    await r.runtime.lock();
  });
});

describe('releaseOwnership (4.7)', () => {
  it('released: writes {"a": null}, clears the check and reads unowned', async () => {
    const r = rig();
    r.t.rpc.handle('vault_owner_release', () => rpcOk({ released: true }));
    r.runtime.start(granted(OWNER));
    expect(await r.runtime.releaseOwnership()).toEqual({ released: true });
    expect(tagWrites(r.replica)).toEqual(['{"a":null}']);
    expect(r.replica.local().ownerCheck).toBeNull();
    expect(r.runtime.ownershipView().ownership).toEqual({ kind: 'unowned' });
    expect(r.t.rpc.callsOf('vault_owner_release')[0]?.args).toEqual({ p_vault_key: LINEAGE });
  });

  it.each([
    ['too_soon', rpcOk({ released: false, reason: 'too_soon', retry_after: TS })],
    ['not_owner', rpcOk({ released: false, reason: 'not_owner' })],
    ['unconfirmed', rpcFail({ kind: 'network' })],
  ])('%s leaves the tag and the check alone', async (_label, answer) => {
    const r = rig();
    r.t.rpc.handle('vault_owner_release', () => answer);
    r.runtime.start(granted(OWNER));
    const before = r.replica.local().ownerCheck;
    const res = await r.runtime.releaseOwnership();
    expect(res.released).toBe(false);
    expect(tagWrites(r.replica)).toEqual([]);
    expect(r.replica.local().ownerCheck).toEqual(before);
  });
});

describe('the reconnect take-over claims (2.3)', () => {
  it('[Use here instead] sends p_claim true and p_takeover true', async () => {
    const r = rig();
    r.t.rpc.handle('vault_session_acquire', () => rpcOk({ granted: true, lease_id: '55555555-5555-4555-8555-555555555556', limit: -1, sessions: [], server_now: TS }));
    r.t.rpc.handle('vault_session_heartbeat', () => rpcOk({ status: 'ok', limit: -1, sessions: [], server_now: TS }));
    r.runtime.start(granted(OWNER));
    await r.runtime.answerConflict('use-here');
    expect(r.t.rpc.callsOf('vault_session_acquire')[0]?.args).toMatchObject({ p_claim: true, p_takeover: true });
    await r.runtime.lock();
  });
});
