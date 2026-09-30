// @vitest-environment node
// 6.10 / 6.11 signed out: a days-old session_open = 1 (an iPhone that went to the background, a
// device that crashed or was retired) neither shows the blocking wait nor polls S every 2 s.
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempRoot } from '../../sync/__tests__/host-fakes.js';
import { LeaseTracker } from '../lease.js';
import { PersonalVaultRuntime } from '../session-runtime.js';
import { SessionClient } from '../session-client.js';
import { LINEAGE, NONCE, OWN, RuntimeEngine, RuntimeReplica, presence, stateWithClaim } from './runtime-fakes.js';
import { makeTestSessionHost } from './session-fakes.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

function startSignedOut(lastActiveAgoMs: number) {
  const root = makeTempRoot('runtime-hint');
  roots.push(root);
  const t = makeTestSessionHost(root);
  t.knobs.userId = null;
  const engine = new RuntimeEngine();
  engine.shared = stateWithClaim(presence('iPhone', t.clock.now() - lastActiveAgoMs, 1), false);
  const runtime = new PersonalVaultRuntime({
    host: t.host,
    config: { syncRoot: root, machineDir: root, dataDir: root, deviceUuid: OWN, sessionNonce: NONCE },
    lineageId: LINEAGE,
    shared: true,
    fileName: 'Vault.conduit',
    client: new SessionClient(t.rpc, t.host),
    lease: new LeaseTracker(),
    replica: new RuntimeReplica().asReplica(),
  });
  runtime.attachEngine(engine.asEngine());
  runtime.start(null);
  return { t, engine, runtime };
}

describe('signed-out stale hint at start', () => {
  it('a 3-day-old session_open = 1 shows no wait and triggers no reads', async () => {
    const { t, engine, runtime } = startSignedOut(3 * DAY_MS);
    expect(engine.waits.filter((w) => w !== null)).toEqual([]);
    await t.clock.advance(60 * 60 * 1000);
    expect(engine.calls.filter((c) => c === 'trigger:session-hint')).toEqual([]);
    await runtime.lock();
  });

  it('a recently active device still gets the hint, and its polling stops after two minutes', async () => {
    const { t, engine, runtime } = startSignedOut(60_000);
    expect(engine.waits.at(-1)).toMatchObject({ purpose: 'stale-file', blocking: true, stopOffered: false });
    await t.clock.advance(60 * 60 * 1000);
    expect(engine.calls.filter((c) => c === 'trigger:session-hint').length).toBeLessThanOrEqual(60);
    expect(engine.waits.at(-1)).toMatchObject({ stopOffered: true });
    await runtime.lock();
  });
});
