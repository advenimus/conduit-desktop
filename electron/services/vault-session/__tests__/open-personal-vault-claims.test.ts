// @vitest-environment node
// 6.7 Free device switch over the REAL openPersonalVault, runtime, engine, replica and claims:
// device A opens and locks; hours later device B opens the same shared file. A's claim is
// stale, so B claims silently and is never displaced by it (12 row 28), signed out or with a
// granted lease of limit 1.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { snapshot, verificationToken, writeLegacyVault } from '../../sync/__tests__/genesis-fixtures.js';
import { flushAsync, makeTempRoot } from '../../sync/__tests__/host-fakes.js';
import { fakeDerive } from '../../sync/__tests__/key-epoch-fixtures.js';
import { IncarnationRegistry } from '../../sync/replica.js';
import { readOwnerClaim } from '../claims.js';
import { REAL_COLLABORATORS } from '../open-deps.js';
import { openPersonalVault, type OpenDeps, type OpenedPersonalVault } from '../open-personal-vault.js';
import { makeOpenHarness, openInput, type OpenHarness } from './open-harness.js';
import { rpcOk } from './session-fakes.js';

const SALT = Buffer.alloc(32, 6).toString('base64');
const DEVICE_B = '9f8e7d6c-5555-4666-8777-888899990000';
const NONCE_B = 'aaaaaaaa-1234-4234-8234-123456789abc';
const HOUR_MS = 60 * 60 * 1000;
const roots: string[] = [];
const open: OpenedPersonalVault[] = [];

afterEach(async () => {
  for (const v of open.splice(0)) await v.runtime.lock();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

async function settle<T>(p: Promise<T>, h: OpenHarness): Promise<T> {
  let done = false;
  let value: T | undefined;
  let error: unknown = null;
  void p.then(
    (v) => {
      done = true;
      value = v;
    },
    (e: unknown) => {
      done = true;
      error = e;
    },
  );
  for (let i = 0; i < 2000 && !done; i++) {
    await flushAsync();
    if (!done) await h.t.clock.advance(1);
  }
  if (!done) throw new Error('did not settle');
  if (error !== null) throw error;
  return value as T;
}

function devices(h: OpenHarness): { a: OpenDeps; b: OpenDeps } {
  const base: OpenDeps = { host: h.t.host, config: h.config, progress: h.deps.progress, verifyCommits: true };
  return {
    a: { ...base, incarnations: new IncarnationRegistry(), collaborators: { ...REAL_COLLABORATORS } },
    b: {
      ...base,
      config: { ...h.config, deviceUuid: DEVICE_B, machineDir: path.join(h.config.syncRoot, 'm-bbbbbbbb'), sessionNonce: NONCE_B },
      incarnations: new IncarnationRegistry(),
      collaborators: { ...REAL_COLLABORATORS },
    },
  };
}

async function switchDevices(h: OpenHarness): Promise<OpenedPersonalVault> {
  const vaultPath = path.join(h.root, 'cloud', 'Vault.conduit');
  writeLegacyVault(vaultPath, snapshot({ meta: { salt: SALT, verification: verificationToken(fakeDerive('pw1')(SALT)) } }));
  const deps = devices(h);
  const a = await settle(openPersonalVault(openInput(vaultPath), deps.a), h);
  await settle(a.runtime.lock(), h);
  await h.t.clock.advance(3 * HOUR_MS);
  const b = await settle(openPersonalVault(openInput(vaultPath), deps.b), h);
  open.push(b);
  expect(readOwnerClaim(b.replica!.state())?.value.d).toBe(DEVICE_B);
  for (let i = 0; i < 400; i++) await h.t.clock.advance(100);
  return b;
}

describe('Free device switch (6.7)', () => {
  it('signed out: B claims silently and is not displaced by A\'s old claim', async () => {
    const root = makeTempRoot('open-claims-out');
    roots.push(root);
    const h = makeOpenHarness(root);
    h.t.knobs.userId = null;
    const b = await switchDevices(h);
    expect(h.t.sessionEvents.of('vault:session-displaced')).toEqual([]);
    expect(h.t.access.log).toEqual([]);
    expect(b.runtime.isSoftLocked()).toBe(false);
  });

  it('signed in with a granted lease of limit 1: B is not displaced by A\'s old claim', async () => {
    const root = makeTempRoot('open-claims-in');
    roots.push(root);
    const h = makeOpenHarness(root);
    h.t.knobs.userId = 'user-1';
    let n = 0;
    const serverNow = (): string => new Date(h.t.clock.now()).toISOString();
    h.t.rpc.handle('vault_session_peek', () => rpcOk({ limit: 1, holders: [] }));
    h.t.rpc.handle('vault_session_acquire', () =>
      rpcOk({ granted: true, lease_id: `b1b2b3b4-0000-4000-8000-00000000000${++n}`, limit: 1, sessions: [], server_now: serverNow() }),
    );
    h.t.rpc.handle('vault_session_heartbeat', () => rpcOk({ status: 'ok', limit: 1, sessions: [], server_now: serverNow() }));
    h.t.rpc.handle('vault_session_release', () => rpcOk(null));
    const b = await switchDevices(h);
    expect(h.t.sessionEvents.of('vault:session-displaced')).toEqual([]);
    expect(b.runtime.isSoftLocked()).toBe(false);
  });
});
