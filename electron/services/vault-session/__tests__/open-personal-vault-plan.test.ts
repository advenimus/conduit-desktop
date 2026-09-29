// @vitest-environment node
// Plan enforcement at open (docs/PLAN_ENFORCEMENT.md 3.4, 4.3; tests D3 and D5): the peek refuses
// an old app and a full device cap before any password work; the acquire refuses a vault another
// account owns (with a "Make my own copy" ticket), an old app and a full device cap, and nothing
// opens; a grant for the owner writes the owner tag; offline and signed out, the owner tag
// decides before the owner claims.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ownerTagRegKey } from '../../sync/catalog.js';
import { vhashOfValue } from '../../sync/hashing.js';
import { defaultLocalJson, serializeLocalJson } from '../../sync/local-state.js';
import { lineagePaths } from '../../sync/paths.js';
import { LINEAGE, appSib, withRegister } from '../../sync/__tests__/key-epoch-fixtures.js';
import type { OwnerCheck, SyncState } from '../../sync/types.js';
import { openPersonalVault } from '../open-personal-vault.js';
import { OwnCopyTickets } from '../own-copy-tickets.js';
import { ownerHint } from '../owner-tag.js';
import { holder, openInput, syncedClass, type OpenHarness } from './open-harness.js';
import { S_BYTES, S_E1, refusal, sharedScenario, withW } from './open-scenario.js';

let root: string;
let h: OpenHarness;
let vaultPath: string;
let tickets: OwnCopyTickets;

const USER = 'user-1';
const OTHER_HINT = ownerHint(LINEAGE, 'someone-else');
const TAG_MS = 40_000;

beforeEach(() => {
  ({ root, h, vaultPath } = sharedScenario('open-plan'));
  tickets = new OwnCopyTickets(() => 'ticket-1');
  Object.assign(h.deps, { tickets });
});

afterEach(() => {
  tickets.clear();
  fs.rmSync(root, { recursive: true, force: true });
});

const OWNER = { kind: 'owner', releaseAfterMs: null, sharedUntilMs: null } as const;

function tagged(state: SyncState, a: string | null, ms = TAG_MS): SyncState {
  const key = ownerTagRegKey();
  const value = JSON.stringify({ a });
  return withRegister(state, key, [appSib(7, ms, value, vhashOfValue(key, value))]);
}

function sharedWithTag(a: string | null): void {
  h.shared.set(vaultPath, { kind: 'ok', bytes: S_BYTES, cls: syncedClass(tagged(S_E1, a), 'file-1') });
}

function localWith(ownerCheck: OwnerCheck | null): void {
  const lp = lineagePaths(h.config.machineDir, LINEAGE);
  fs.mkdirSync(lp.dir, { recursive: true });
  fs.writeFileSync(lp.local, serializeLocalJson({ ...defaultLocalJson(LINEAGE, 3, 'ab'.repeat(16)), ownerCheck }));
}

function payloadOf(err: Error): Record<string, unknown> {
  return JSON.parse(err.message) as Record<string, unknown>;
}

describe('peek refusals (before the password)', () => {
  it('update required', async () => {
    h.client.peekResult = { kind: 'ok', limit: -1, deviceCap: 5, holders: [], refusal: { kind: 'update-required', minVersion: '0.19.0' } };
    const err = await refusal(openPersonalVault(openInput(vaultPath), h.deps));
    expect(payloadOf(err)).toEqual({ code: 'VAULT_UPDATE_REQUIRED', fileName: 'Vault.conduit', minVersion: '0.19.0' });
    expect(h.kdf.calls).toBe(0);
    expect(h.client.of('acquire')).toHaveLength(0);
  });

  it('device cap names the device a take-over locks', async () => {
    const devices = [holder('Old PC'), holder('iPad')];
    h.client.peekResult = { kind: 'ok', limit: -1, deviceCap: 2, holders: [], refusal: { kind: 'device-cap', deviceCap: 2, devices } };
    const err = await refusal(openPersonalVault(openInput(vaultPath), h.deps));
    expect(payloadOf(err)).toMatchObject({ code: 'VAULT_OPEN_ELSEWHERE', cause: 'device_cap', deviceCap: 2, displaceDeviceName: 'Old PC', holders: devices, locationDiffers: false });
    expect(h.kdf.calls).toBe(0);
  });
});

describe('acquire refusals (after the password)', () => {
  it('not owner: a copy ticket for the shared file, the original folder, nothing opened or leased', async () => {
    h.client.acquireResult = { kind: 'not-owner', graceEndedMs: 5_000, released: false, serverNowMs: null };
    const err = await refusal(openPersonalVault(openInput(vaultPath), h.deps));
    expect(payloadOf(err)).toEqual({
      code: 'VAULT_NOT_OWNER',
      fileName: 'Vault.conduit',
      offline: false,
      graceEndedMs: 5_000,
      released: false,
      copyTicket: 'ticket-1',
      copyDir: path.dirname(vaultPath),
    });
    expect(h.client.of('acquire')[0]?.args).toMatchObject({ claim: true, takeover: false });
    expect(h.replicas.opened).toHaveLength(0);
    expect(h.client.of('release')).toHaveLength(0);
    const ticket = tickets.take('ticket-1', h.t.clock.now());
    expect(ticket?.source).toEqual({ kind: 'shared', path: vaultPath });
    expect(ticket?.lineageId).toBe(LINEAGE);
    expect(ticket?.key.equals(h.kdf.deriveKey('pw1', 'salt1'))).toBe(true);
  });

  it('not owner with a working copy: the ticket forks W; released carries S8b', async () => {
    withW(h);
    h.client.acquireResult = { kind: 'not-owner', graceEndedMs: null, released: true, serverNowMs: null };
    const err = await refusal(openPersonalVault(openInput(vaultPath), h.deps));
    expect(payloadOf(err)).toMatchObject({ code: 'VAULT_NOT_OWNER', released: true, copyTicket: 'ticket-1' });
    expect(tickets.take('ticket-1', h.t.clock.now())?.source).toEqual({ kind: 'working', lineageId: LINEAGE });
  });

  it('update required at acquire', async () => {
    h.client.acquireResult = { kind: 'update-required', minVersion: '1.0.0', serverNowMs: null };
    const err = await refusal(openPersonalVault(openInput(vaultPath), h.deps));
    expect(payloadOf(err)).toEqual({ code: 'VAULT_UPDATE_REQUIRED', fileName: 'Vault.conduit', minVersion: '1.0.0' });
    expect(h.replicas.opened).toHaveLength(0);
  });

  it('device cap at acquire, and a vault-limit denial that also locks another device (S1b)', async () => {
    h.client.acquireResult = {
      kind: 'denied',
      cause: 'device_cap',
      limit: -1,
      deviceCap: 5,
      holders: [holder('Old PC')],
      alsoLocks: null,
      sessions: [],
      serverNowMs: null,
    };
    expect(payloadOf(await refusal(openPersonalVault(openInput(vaultPath), h.deps)))).toMatchObject({ cause: 'device_cap', displaceDeviceName: 'Old PC' });
    h.client.acquireResult = {
      kind: 'denied',
      cause: 'vault_limit',
      limit: 1,
      deviceCap: 5,
      holders: [holder('MacBook')],
      alsoLocks: { deviceId: 'x', deviceName: 'Old PC' },
      sessions: [],
      serverNowMs: null,
    };
    expect(payloadOf(await refusal(openPersonalVault(openInput(vaultPath), h.deps)))).toMatchObject({ cause: 'vault_limit', alsoLockDeviceName: 'Old PC' });
  });
});

describe('the owner tag at a grant (3.2)', () => {
  it('the owner writes its hint with presence; grace writes none', async () => {
    h.client.acquireResult = { kind: 'granted', leaseId: 'l', limit: -1, deviceCap: 5, ownership: OWNER, sessions: [], serverNowMs: null };
    await openPersonalVault(openInput(vaultPath), h.deps);
    const writes = h.replicas.last().applied[0]?.writes ?? [];
    const tag = writes.find((w) => w.key.reg === 'account');
    expect(tag?.value).toBe(`{"a":"${ownerHint(LINEAGE, USER)}"}`);
  });

  it('grace and unknown ownership write no tag', async () => {
    for (const ownership of [{ kind: 'grace', untilMs: 9 } as const, null]) {
      h.client.acquireResult = { kind: 'granted', leaseId: 'l', limit: -1, deviceCap: 5, ownership, sessions: [], serverNowMs: null };
      await openPersonalVault(openInput(vaultPath), h.deps);
      expect((h.replicas.last().applied[0]?.writes ?? []).some((w) => w.key.reg === 'account')).toBe(false);
    }
  });
});

describe('the owner tag at unlock (3.4, D5)', () => {
  it('offline, another account in the tag: S5 before any password work, before the claims', async () => {
    h.client.peekResult = { kind: 'unconfirmed', reason: 'network', detail: 'x' };
    h.verdict = { kind: 'other', claimantUuid: 'aaaaaaaa-0000-4000-8000-000000000000', presence: null, recentlyActive: true };
    sharedWithTag(OTHER_HINT);
    const err = await refusal(openPersonalVault(openInput(vaultPath), h.deps));
    expect(payloadOf(err)).toMatchObject({ code: 'VAULT_NOT_OWNER', offline: true, copyTicket: null });
    expect(h.kdf.calls).toBe(0);
  });

  it('offline during a cached grace: opens', async () => {
    h.client.peekResult = { kind: 'unconfirmed', reason: 'network', detail: 'x' };
    h.client.acquireResult = { kind: 'unconfirmed', reason: 'network', detail: 'x' };
    sharedWithTag(OTHER_HINT);
    localWith({ hint: ownerHint(LINEAGE, USER), kind: 'grace', untilMs: h.t.clock.now() + 60_000, atMs: h.t.clock.now() });
    await expect(openPersonalVault(openInput(vaultPath), h.deps)).resolves.toMatchObject({ shared: true });
  });

  it('signed out with an account in the tag: S6; the owner device with its cache opens', async () => {
    h.t.knobs.userId = null;
    sharedWithTag(ownerHint(LINEAGE, USER));
    const err = await refusal(openPersonalVault(openInput(vaultPath), h.deps));
    expect(payloadOf(err)).toEqual({ code: 'VAULT_SIGN_IN_REQUIRED', fileName: 'Vault.conduit' });
    localWith({ hint: ownerHint(LINEAGE, USER), kind: 'owner', untilMs: null, atMs: 1 });
    await expect(openPersonalVault(openInput(vaultPath), h.deps)).resolves.toMatchObject({ shared: true });
  });

  it('a take-over skips the early check (the user already chose)', async () => {
    h.client.peekResult = { kind: 'unconfirmed', reason: 'network', detail: 'x' };
    h.client.acquireResult = { kind: 'unconfirmed', reason: 'network', detail: 'x' };
    sharedWithTag(OTHER_HINT);
    await expect(openPersonalVault(openInput(vaultPath, { takeover: true }), h.deps)).resolves.toMatchObject({ shared: true });
  });
});
