// @vitest-environment node
// The 5.5 server side-file flag in PersonalVaultRuntime: a flag reported (heartbeat_at, else
// last_active_at) at or before this device's confirmation (on the server's clock) no longer
// pauses publishing, a later report still does, and a flag that clears at a heartbeat starts a
// cycle at once instead of at the safety poll.
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempRoot } from '../../sync/__tests__/host-fakes.js';
import { HEARTBEAT_MS } from '../heartbeat.js';
import { LeaseTracker } from '../lease.js';
import { PersonalVaultRuntime } from '../session-runtime.js';
import { SessionClient, type AcquireResult } from '../session-client.js';
import type { SessionRowView } from '../../sync/host.js';
import { makeTestSessionHost, rpcOk, type TestSessionHost } from './session-fakes.js';
import { sessionRow } from './session-client-fixtures.js';
import { row } from './stale-fixtures.js';
import { LINEAGE, NONCE, OTHER, OWN, RuntimeEngine, RuntimeReplica, USER } from './runtime-fakes.js';

const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

function rig() {
  const root = makeTempRoot('runtime-side-files');
  roots.push(root);
  const t: TestSessionHost = makeTestSessionHost(root);
  t.knobs.userId = USER;
  const lease = new LeaseTracker();
  const engine = new RuntimeEngine();
  const replica = new RuntimeReplica();
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
  runtime.attachEngine(engine.asEngine());
  return { t, lease, engine, replica, runtime };
}

function granted(sessions: readonly SessionRowView[], serverNowMs: number | null = null): AcquireResult {
  return { kind: 'granted', leaseId: '55555555-5555-4555-8555-555555555555', limit: -1, sessions, serverNowMs };
}

/** The other device's flagged row; `heartbeatAtMs` null is a server that does not report it. */
const flagged = (lastActiveMs: number, heartbeatAtMs: number | null = null) => row({ deviceId: OTHER, sideFilesFlag: true, lastActiveMs, heartbeatAtMs });

/** Heartbeat answers with the other device's row, flagged or not, last active (and beating) at `lastActiveMs`. */
function answerBeats(t: TestSessionHost, next: () => { flag: boolean; lastActiveMs: number }): void {
  t.rpc.handle('vault_session_heartbeat', () => {
    const { flag, lastActiveMs } = next();
    const at = new Date(lastActiveMs).toISOString();
    const other = sessionRow({
      device_id: OTHER,
      last_active_at: at,
      heartbeat_at: at,
      flags: flag ? { side_files: 'present' } : {},
      written_vv: {},
    });
    return rpcOk({ status: 'ok', limit: -1, sessions: [other], server_now: new Date(t.clock.now()).toISOString() });
  });
}

const hints = (engine: RuntimeEngine) => engine.calls.filter((c) => c === 'trigger:session-hint').length;

describe('server side-file flag and the confirmation on this device (5.5)', () => {
  it('an idle device that reports the flag again after the click pauses again (heartbeat_at is the report time)', async () => {
    const r = rig();
    const now = r.t.clock.now();
    r.runtime.start(granted([flagged(now - 60_000, now - 60_000)]));
    r.replica.updateLocal((l) => ({ ...l, sideFilesConfirmedAtMs: now - 30_000 }));
    const s = r.runtime.signals();
    expect(s.serverSideFilesFlagRecent(now)).toBe(false);
    // Idle: last_active_at stays before the click, but its heartbeat carried the flag after it.
    r.lease.onAcquire(granted([flagged(now - 60_000, now - 10_000)]), now);
    expect(s.serverSideFilesFlagRecent(now)).toBe(true);
    await r.runtime.lock();
  });

  it('an idle device still reporting the flag keeps it recent after 2 hours without activity', async () => {
    const r = rig();
    const now = r.t.clock.now();
    r.runtime.start(granted([flagged(now - 3 * 60 * 60 * 1000, now - 10_000)]));
    expect(r.runtime.signals().serverSideFilesFlagRecent(now)).toBe(true);
    r.lease.onAcquire(granted([flagged(now - 3 * 60 * 60 * 1000, null)]), now);
    expect(r.runtime.signals().serverSideFilesFlagRecent(now)).toBe(false);
    await r.runtime.lock();
  });

  it('without heartbeat_at (older server) the last activity is the report time: at or before the click is covered', async () => {
    const r = rig();
    const now = r.t.clock.now();
    r.runtime.start(granted([flagged(now - 5_000)]));
    const s = r.runtime.signals();
    expect(s.serverSideFilesFlagRecent(now)).toBe(true);
    r.replica.updateLocal((l) => ({ ...l, sideFilesConfirmedAtMs: now - 5_000 }));
    expect(s.serverSideFilesFlagRecent(now)).toBe(false);
    r.lease.onAcquire(granted([flagged(now - 4_999)]), now);
    expect(s.serverSideFilesFlagRecent(now)).toBe(true);
    await r.runtime.lock();
  });

  it('compares on the server clock: a report before the click is covered although the server runs ahead', async () => {
    const r = rig();
    const now = r.t.clock.now();
    // The server is 3 s ahead: its 2 s-ahead report came 1 s before a click at our `now`.
    r.runtime.start(granted([flagged(now + 2_000)], now + 3_000));
    r.replica.updateLocal((l) => ({ ...l, sideFilesConfirmedAtMs: now }));
    expect(r.runtime.signals().serverSideFilesFlagRecent(now)).toBe(false);
    r.lease.onAcquire(granted([flagged(now + 3_500)], now + 3_000), now);
    expect(r.runtime.signals().serverSideFilesFlagRecent(now)).toBe(true);
    await r.runtime.lock();
  });

  it('an older local.json without a confirmation leaves every recent flag in force', async () => {
    const r = rig();
    const now = r.t.clock.now();
    r.replica.updateLocal((l) => Object.fromEntries(Object.entries(l).filter(([k]) => k !== 'sideFilesConfirmedAtMs')) as typeof l);
    r.runtime.start(granted([flagged(now - 60_000)]));
    expect(r.runtime.signals().serverSideFilesFlagRecent(now)).toBe(true);
    await r.runtime.lock();
  });

  it('starts a cycle when the flag clears at a heartbeat, and only then', async () => {
    const r = rig();
    const start = r.t.clock.now();
    const answers = [
      { flag: true, lastActiveMs: start },
      { flag: false, lastActiveMs: start + HEARTBEAT_MS },
      { flag: false, lastActiveMs: start + 2 * HEARTBEAT_MS },
    ];
    answerBeats(r.t, () => answers.shift() ?? { flag: false, lastActiveMs: start });
    r.runtime.start(granted([flagged(start - 1_000)]));
    await r.t.clock.advance(HEARTBEAT_MS);
    expect(hints(r.engine)).toBe(0);
    await r.t.clock.advance(HEARTBEAT_MS);
    expect(hints(r.engine)).toBe(1);
    await r.t.clock.advance(HEARTBEAT_MS);
    expect(hints(r.engine)).toBe(1);
    await r.runtime.lock();
  });

  it('starts no cycle when the flag was never set', async () => {
    const r = rig();
    answerBeats(r.t, () => ({ flag: false, lastActiveMs: r.t.clock.now() }));
    r.runtime.start(granted([]));
    await r.t.clock.advance(3 * HEARTBEAT_MS);
    expect(hints(r.engine)).toBe(0);
    await r.runtime.lock();
  });
});
