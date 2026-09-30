// @vitest-environment node
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LINEAGE } from '../../sync/__tests__/key-epoch-fixtures.js';
import { flushAsync } from '../../sync/__tests__/host-fakes.js';
import { openPersonalVault } from '../open-personal-vault.js';
import { FakeEngine, holder, openInput, presyncClass, sessionRow, syncedClass, type OpenHarness } from './open-harness.js';
import { E1, R1, S_BYTES, S_E1, refusal, sharedScenario, stagingFiles as stagingOf, until } from './open-scenario.js';

let root: string;
let h: OpenHarness;
let vaultPath: string;

beforeEach(() => {
  ({ root, h, vaultPath } = sharedScenario('open-lease'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const stagingFiles = (): string[] => stagingOf(h);

describe('acquire (6.3 step 5)', () => {
  it('granted: Free writes presence and the owner claim after the unlock cycle, then starts', async () => {
    const opened = await openPersonalVault(openInput(vaultPath), h.deps);
    expect(opened).toMatchObject({ lineageId: LINEAGE, shared: true, firstCyclePending: false });
    expect(opened.unlock).toEqual({ ok: true, epochId: E1.epochId, via: 'no-w' });
    expect(h.client.of('acquire')[0]?.args).toMatchObject({
      vaultKey: LINEAGE,
      deviceId: h.config.deviceUuid,
      sessionNonce: h.config.sessionNonce,
      fileName: 'Vault.conduit',
      fileId: 'file-1',
      location: 'local:cloud',
      takeover: false,
    });
    const replica = h.replicas.last();
    expect(h.replicas.opened[0]?.seed).toMatchObject({ kind: 'adopt', sharedBytes: S_BYTES, holdLegacy: false });
    expect(h.replicas.opened[0]?.binding).toEqual({ sharedPath: vaultPath, realpath: vaultPath, fileId: 'file-1' });
    expect(replica.applied).toHaveLength(1);
    expect(replica.applied[0]?.writes.map((w) => w.key.reg)).toEqual([h.config.deviceUuid, 'owner']);
    expect(h.engines[0]?.calls).toEqual(['runCycle:unlock', 'start', 'trigger:local-edit']);
    const runtime = h.runtimes[0];
    expect(runtime?.calls).toEqual(['attachEngine', 'start']);
    expect(runtime?.started).toEqual(h.client.acquireResult);
    expect(runtime?.deps).toMatchObject({ lineageId: LINEAGE, shared: true, fileName: 'Vault.conduit' });
    expect(replica.closed).toBe(false);
    expect(h.client.of('release')).toHaveLength(0);
    expect(stagingFiles()).toEqual([]);
  });

  it('granted on Pro: presence only', async () => {
    h.client.acquireResult = { kind: 'granted', leaseId: 'l', limit: -1, sessions: [], serverNowMs: null, deviceCap: null, ownership: null };
    await openPersonalVault(openInput(vaultPath), h.deps);
    expect(h.replicas.last().applied[0]?.writes).toHaveLength(1);
  });

  it('denied after the peek (a race) shows the dialog again and opens nothing', async () => {
    h.client.acquireResult = { kind: 'denied', cause: 'vault_limit', limit: 1, deviceCap: null, holders: [holder('MacBook')], alsoLocks: null, sessions: [], serverNowMs: null };
    const err = await refusal(openPersonalVault(openInput(vaultPath), h.deps));
    expect(JSON.parse(err.message)).toMatchObject({ code: 'VAULT_OPEN_ELSEWHERE', via: 'server', holders: [holder('MacBook')] });
    expect(h.replicas.opened).toHaveLength(0);
    expect(h.client.of('release')).toHaveLength(0);
  });

  it('a server error continues unconfirmed and claims (never a denial)', async () => {
    h.client.acquireResult = { kind: 'unconfirmed', reason: 'server', detail: '503' };
    const opened = await openPersonalVault(openInput(vaultPath), h.deps);
    expect(opened.shared).toBe(true);
    expect(h.runtimes[0]?.started).toEqual({ kind: 'unconfirmed', reason: 'server', detail: '503' });
    expect(h.replicas.last().applied[0]?.writes).toHaveLength(2);
  });

  it('offline: every call fails and the vault still opens', async () => {
    h.client.peekResult = { kind: 'unconfirmed', reason: 'network', detail: '' };
    h.client.acquireResult = { kind: 'unconfirmed', reason: 'network', detail: '' };
    const opened = await openPersonalVault(openInput(vaultPath), h.deps);
    expect(opened.shared).toBe(true);
    expect(h.runtimes[0]?.started).toMatchObject({ kind: 'unconfirmed' });
  });

  it('a failure after the replica opened closes it and releases the lease', async () => {
    h.engineFactory = () => {
      throw new Error('engine assembly failed');
    };
    const err = await refusal(openPersonalVault(openInput(vaultPath), h.deps));
    expect(err.message).toBe('engine assembly failed');
    expect(h.replicas.last().closed).toBe(true);
    expect(h.client.of('release')[0]?.args).toMatchObject({ vaultKey: LINEAGE, leaseId: 'lease-1', marker: null, pending: false });
    expect(stagingFiles()).toEqual([]);
  });
});

describe('stale-file wait inputs (6.11, 12 rows 8/26)', () => {
  for (const [plan, limit] of [['Free', 1], ['Pro', -1]] as const) {
    it(`${plan}: the runtime starts with the acquire sessions, and our file id matches their markers`, async () => {
      const rows = [sessionRow({ fileId: 'file-1', marker: { dev: 9, ms: 700, c: 0 } })];
      h.client.acquireResult = { kind: 'granted', leaseId: 'l', limit, sessions: rows, serverNowMs: null, deviceCap: null, ownership: null };
      await openPersonalVault(openInput(vaultPath), h.deps);
      const runtime = h.runtimes[0];
      expect(runtime?.started).toMatchObject({ kind: 'granted', limit, sessions: rows });
      expect(runtime?.calls).toEqual(['attachEngine', 'start']);
      expect(h.engines[0]?.calls.indexOf('start')).toBeLessThan(h.engines[0]?.calls.length ?? 0);
      expect(h.replicas.last().local().binding?.fileId).toBe('file-1');
    });
  }
});

describe('seeding W (6.3 step 6, 4.4 G1)', () => {
  const presyncMeta = { salt: 'salt1', verification: R1.verification };

  it('pre-sync S, no W, no marker: genesis on the exact bytes', async () => {
    h.shared.set(vaultPath, { kind: 'ok', bytes: S_BYTES, cls: presyncClass(presyncMeta) });
    h.bound.set(vaultPath, LINEAGE);
    const opened = await openPersonalVault(openInput(vaultPath), h.deps);
    expect(opened.unlock?.via).toBe('no-w');
    expect(h.replicas.opened[0]?.seed).toEqual({ kind: 'genesis', sharedBytes: S_BYTES });
    expect(h.waits[0]?.sessions).toEqual([]);
  });

  it('G1 wait: sessions with a marker are passed; a synced file that arrives is adopted', async () => {
    const synced = Buffer.from('synced bytes');
    h.shared.set(
      vaultPath,
      { kind: 'ok', bytes: S_BYTES, cls: presyncClass(presyncMeta) },
      { kind: 'ok', bytes: synced, cls: syncedClass(S_E1, 'file-9') },
    );
    h.bound.set(vaultPath, LINEAGE);
    const sessions = [sessionRow()];
    h.client.acquireResult = { kind: 'granted', leaseId: 'l', limit: 1, sessions, serverNowMs: null, deviceCap: null, ownership: null };
    h.g1Outcome = 'synced';
    await openPersonalVault(openInput(vaultPath), h.deps);
    expect(h.waits[0]?.sessions).toEqual(sessions);
    expect(h.replicas.opened[0]?.seed).toMatchObject({ kind: 'adopt', sharedBytes: synced });
    expect(h.replicas.opened[0]?.binding?.fileId).toBe('file-9');
  });

  it('G1 wait timing out falls back to genesis', async () => {
    h.shared.set(vaultPath, { kind: 'ok', bytes: S_BYTES, cls: presyncClass(presyncMeta) });
    h.client.acquireResult = { kind: 'granted', leaseId: 'l', limit: 1, sessions: [sessionRow()], serverNowMs: null, deviceCap: null, ownership: null };
    h.g1Outcome = 'timeout';
    await openPersonalVault(openInput(vaultPath), h.deps);
    expect(h.replicas.opened[0]?.seed).toEqual({ kind: 'genesis', sharedBytes: S_BYTES });
  });

  it('adoption holds legacy changes when side files sit next to S or the server flag is recent', async () => {
    fs.writeFileSync(`${vaultPath}-wal`, '');
    await openPersonalVault(openInput(vaultPath), h.deps);
    expect(h.replicas.opened[0]?.seed).toMatchObject({ kind: 'adopt', holdLegacy: true });
    fs.rmSync(`${vaultPath}-wal`);
    const now = h.t.clock.now();
    const recent = sessionRow({ sideFilesFlag: true, lastActiveMs: now - 60 * 60 * 1000 });
    h.client.acquireResult = { kind: 'granted', leaseId: 'l', limit: 1, sessions: [recent], serverNowMs: null, deviceCap: null, ownership: null };
    await openPersonalVault(openInput(vaultPath), h.deps);
    expect(h.replicas.opened[1]?.seed).toMatchObject({ holdLegacy: true });
    const old = sessionRow({ sideFilesFlag: true, lastActiveMs: now - 3 * 60 * 60 * 1000 });
    h.client.acquireResult = { kind: 'granted', leaseId: 'l', limit: 1, sessions: [old], serverNowMs: null, deviceCap: null, ownership: null };
    await openPersonalVault(openInput(vaultPath), h.deps);
    expect(h.replicas.opened[2]?.seed).toMatchObject({ holdLegacy: false });
  });
});

describe('unlock cycle budget (6.3 step 7)', () => {
  it('a slow first cycle returns after 3 s; presence waits for it in the lane', async () => {
    let finish: () => void = () => undefined;
    h.engineFactory = () => {
      const e = new FakeEngine();
      e.cycle = new Promise((resolve) => {
        finish = () => resolve({ kind: 'up-to-date', merged: true });
      });
      return e;
    };
    const p = openPersonalVault(openInput(vaultPath), h.deps);
    await until(() => (h.engines[0]?.calls.length ?? 0) > 0);
    await h.t.clock.advance(3_000);
    const opened = await p;
    expect(opened.firstCyclePending).toBe(true);
    expect(h.engines[0]?.calls).toEqual(['runCycle:unlock', 'exclusive', 'start']);
    expect(h.replicas.last().applied).toHaveLength(0);
    finish();
    await flushAsync();
    expect(h.replicas.last().applied).toHaveLength(1);
  });
});
