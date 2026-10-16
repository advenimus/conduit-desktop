// @vitest-environment node
// Dev owner tag bypass (OpenDeps.ignoreOwnerTag): the unlock-time owner tag check is skipped and
// the open never writes the owner tag, so the file keeps its real owner.
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ownerTagRegKey } from '../../sync/catalog.js';
import { vhashOfValue } from '../../sync/hashing.js';
import { LINEAGE, appSib, withRegister } from '../../sync/__tests__/key-epoch-fixtures.js';
import type { SyncState } from '../../sync/types.js';
import { openPersonalVault } from '../open-personal-vault.js';
import { ownerHint } from '../owner-tag.js';
import { openInput, syncedClass, type OpenHarness } from './open-harness.js';
import { S_BYTES, S_E1, refusal, sharedScenario } from './open-scenario.js';

let root: string;
let h: OpenHarness;
let vaultPath: string;

const USER = 'user-1';
const OTHER_HINT = ownerHint(LINEAGE, 'someone-else');
const OWNER = { kind: 'owner', releaseAfterMs: null, sharedUntilMs: null } as const;

beforeEach(() => {
  ({ root, h, vaultPath } = sharedScenario('open-bypass'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function tagged(state: SyncState, a: string | null): SyncState {
  const key = ownerTagRegKey();
  const value = JSON.stringify({ a });
  return withRegister(state, key, [appSib(7, 40_000, value, vhashOfValue(key, value))]);
}

function sharedWithTag(a: string | null): void {
  h.shared.set(vaultPath, { kind: 'ok', bytes: S_BYTES, cls: syncedClass(tagged(S_E1, a), 'file-1') });
}

function tagWrites(): readonly string[] {
  return h.replicas
    .last()
    .applied.flatMap((a) => a.writes)
    .filter((w) => w.key.reg === 'account')
    .map((w) => String(w.value));
}

describe('without the bypass', () => {
  it('signed out with a tag, the open is refused (control)', async () => {
    h.t.knobs.userId = null;
    sharedWithTag(OTHER_HINT);
    const err = await refusal(openPersonalVault(openInput(vaultPath), h.deps));
    expect(JSON.parse(err.message)).toMatchObject({ code: 'VAULT_SIGN_IN_REQUIRED' });
  });
});

describe('with the bypass', () => {
  beforeEach(() => {
    Object.assign(h.deps, { ignoreOwnerTag: true });
  });

  it('signed out, a tagged vault opens', async () => {
    h.t.knobs.userId = null;
    sharedWithTag(OTHER_HINT);
    await expect(openPersonalVault(openInput(vaultPath), h.deps)).resolves.toMatchObject({ shared: true });
    expect(tagWrites()).toEqual([]);
  });

  it('offline as another account, a tagged vault opens', async () => {
    h.client.peekResult = { kind: 'unconfirmed', reason: 'network', detail: 'x' };
    h.client.acquireResult = { kind: 'unconfirmed', reason: 'network', detail: 'x' };
    sharedWithTag(OTHER_HINT);
    await expect(openPersonalVault(openInput(vaultPath), h.deps)).resolves.toMatchObject({ shared: true });
  });

  it('a grant as owner of the local lineage writes no tag', async () => {
    sharedWithTag(OTHER_HINT);
    h.client.acquireResult = { kind: 'granted', leaseId: 'l', limit: -1, deviceCap: 5, ownership: OWNER, sessions: [], serverNowMs: null };
    await openPersonalVault(openInput(vaultPath), h.deps);
    expect(tagWrites()).toEqual([]);
  });

  it('a grant as owner still writes the tag when the bypass is off', async () => {
    Object.assign(h.deps, { ignoreOwnerTag: false });
    h.client.acquireResult = { kind: 'granted', leaseId: 'l', limit: -1, deviceCap: 5, ownership: OWNER, sessions: [], serverNowMs: null };
    await openPersonalVault(openInput(vaultPath), h.deps);
    expect(tagWrites()).toEqual([`{"a":"${ownerHint(LINEAGE, USER)}"}`]);
  });
});
