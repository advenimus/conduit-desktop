// @vitest-environment node
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { makeVerificationToken } from '../../sync/key-epoch.js';
import { LINEAGE, epochKeysFor, makeState } from '../../sync/__tests__/key-epoch-fixtures.js';
import type { SyncState } from '../../sync/types.js';
import { openPersonalVault, PersonalVaultOpenError } from '../open-personal-vault.js';
import { OTHER_UUID, holder, listFiles, openInput, presenceOf, presyncClass, syncedClass, type OpenHarness } from './open-harness.js';
import { E1, E2, R1, R2, S_BYTES, S_E1, S_E2, rand, refusal, sharedScenario, stagingFiles as stagingOf, until, withW as withWFor } from './open-scenario.js';

let root: string;
let h: OpenHarness;
let vaultPath: string;

beforeEach(() => {
  ({ root, h, vaultPath } = sharedScenario('open-vault'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const withW = (state?: SyncState): string => withWFor(h, state);
const stagingFiles = (): string[] => stagingOf(h);

describe('early in-use check (6.3 step 3)', () => {
  it('refuses from the server peek before any password work', async () => {
    h.client.peekResult = { kind: 'ok', limit: 1, holders: [holder('MacBook', 'icloud:Vaults')] };
    const err = await refusal(openPersonalVault(openInput(vaultPath), h.deps));
    expect(err).toBeInstanceOf(PersonalVaultOpenError);
    expect(JSON.parse(err.message)).toEqual({
      code: 'VAULT_OPEN_ELSEWHERE',
      holders: [holder('MacBook', 'icloud:Vaults')],
      limit: 1,
      fileName: 'Vault.conduit',
      locationDiffers: true,
      via: 'server',
    });
    expect(h.kdf.calls).toBe(0);
    expect(h.client.of('peek')[0]).toMatchObject({ args: { vaultKey: LINEAGE, deviceId: h.config.deviceUuid }, timeoutMs: 3_000 });
    expect(h.client.of('acquire')).toHaveLength(0);
    expect(h.replicas.opened).toHaveLength(0);
    expect(stagingFiles()).toEqual([]);
  });

  it('reports a holder in the same location without the location note, and allows unlimited plans', async () => {
    h.client.peekResult = { kind: 'ok', limit: 1, holders: [holder('MacBook', 'local:cloud')] };
    const err = await refusal(openPersonalVault(openInput(vaultPath), h.deps));
    expect(JSON.parse(err.message)).toMatchObject({ locationDiffers: false });
    h.client.peekResult = { kind: 'ok', limit: -1, holders: [holder('MacBook')] };
    h.client.acquireResult = { kind: 'granted', leaseId: 'l', limit: -1, sessions: [], serverNowMs: null };
    await expect(openPersonalVault(openInput(vaultPath), h.deps)).resolves.toMatchObject({ shared: true });
  });

  it('gives the peek 3 s, then continues unconfirmed', async () => {
    h.client.peekResult = new Promise(() => undefined);
    let settled = false;
    const p = openPersonalVault(openInput(vaultPath), h.deps).finally(() => {
      settled = true;
    });
    await until(() => h.client.of('peek').length === 1);
    expect(settled).toBe(false);
    await h.t.clock.advance(2_999);
    expect(settled).toBe(false);
    await h.t.clock.advance(1);
    const opened = await p;
    expect(opened.shared).toBe(true);
    expect(h.client.of('acquire')).toHaveLength(1);
  });

  it('server unreachable: a recent owner claim of another device refuses (12 row 35)', async () => {
    h.client.peekResult = { kind: 'unconfirmed', reason: 'server', detail: '503' };
    const presence = presenceOf('iPad', { file_hint: { file_id: 'f', location: 'icloud:Vaults', file_name: 'Vault.conduit' } });
    h.verdict = { kind: 'other', claimantUuid: OTHER_UUID, presence, recentlyActive: true };
    const err = await refusal(openPersonalVault(openInput(vaultPath), h.deps));
    expect(JSON.parse(err.message)).toEqual({
      code: 'VAULT_OPEN_ELSEWHERE',
      holders: [
        {
          deviceId: OTHER_UUID,
          deviceName: 'iPad',
          platform: 'macos',
          fileName: 'Vault.conduit',
          fileId: 'f',
          location: 'icloud:Vaults',
          lastActiveMs: 1_000,
          busySessions: 0,
          busyJobs: 0,
        },
      ],
      limit: 1,
      fileName: 'Vault.conduit',
      locationDiffers: true,
      via: 'claim',
    });
    expect(h.kdf.calls).toBe(0);
  });

  it('a stale claim of another device is claimed silently', async () => {
    h.client.peekResult = { kind: 'unconfirmed', reason: 'network', detail: '' };
    h.verdict = { kind: 'other', claimantUuid: OTHER_UUID, presence: presenceOf('iPad'), recentlyActive: false };
    await openPersonalVault(openInput(vaultPath), h.deps);
    expect(h.replicas.last().applied[0]?.writes).toHaveLength(2);
  });

  it('signed out: no server calls, the claim decides, and take-over claims anyway (12 row 28)', async () => {
    h.t.knobs.userId = null;
    h.verdict = { kind: 'other', claimantUuid: OTHER_UUID, presence: presenceOf('iPad'), recentlyActive: true };
    const err = await refusal(openPersonalVault(openInput(vaultPath), h.deps));
    expect(JSON.parse(err.message)).toMatchObject({ code: 'VAULT_OPEN_ELSEWHERE', via: 'claim', limit: 1 });
    expect(h.client.calls).toEqual([]);

    const opened = await openPersonalVault(openInput(vaultPath, { takeover: true }), h.deps);
    expect(opened.shared).toBe(true);
    expect(h.client.calls).toEqual([]);
    const applied = h.replicas.last().applied;
    expect(applied).toHaveLength(1);
    expect(applied[0]?.writes).toHaveLength(2);
    expect(applied[0]).toMatchObject({ interactive: true, ruleR: false });
    expect(h.runtimes[h.runtimes.length - 1]?.started).toBeNull();
  });

  it('a Pro limit cached offline skips claims entirely', async () => {
    h.client.peekResult = { kind: 'unconfirmed', reason: 'network', detail: '' };
    h.client.acquireResult = { kind: 'unconfirmed', reason: 'network', detail: '' };
    h.t.tierCache.value = { vaultMaxOpenDevices: -1, timestampMs: h.t.clock.now() };
    h.verdict = { kind: 'other', claimantUuid: OTHER_UUID, presence: presenceOf('iPad'), recentlyActive: true };
    await openPersonalVault(openInput(vaultPath), h.deps);
    expect(h.replicas.last().applied[0]?.writes).toHaveLength(1);
  });

  it('take-over skips the peek and acquires with takeover', async () => {
    h.client.peekResult = { kind: 'ok', limit: 1, holders: [holder('MacBook')] };
    await openPersonalVault(openInput(vaultPath, { takeover: true }), h.deps);
    expect(h.client.of('peek')).toHaveLength(0);
    expect(h.client.of('acquire')[0]?.args).toMatchObject({ takeover: true });
  });
});

describe('password (6.3 step 4, 4.8)', () => {
  it('a wrong password has no side effects', async () => {
    const wPath = withW();
    const sBefore = fs.statSync(vaultPath);
    const err = await refusal(openPersonalVault(openInput(vaultPath, { password: 'typo' }), h.deps));
    expect(err).not.toBeInstanceOf(PersonalVaultOpenError);
    expect(err.message).toBe('Invalid master password');
    expect(h.client.of('acquire')).toHaveLength(0);
    expect(h.replicas.opened).toHaveLength(0);
    expect(fs.readFileSync(vaultPath).equals(S_BYTES)).toBe(true);
    expect(fs.statSync(vaultPath).mtimeMs).toBe(sBefore.mtimeMs);
    expect(fs.readFileSync(wPath, 'utf8')).toBe('W bytes');
    expect(listFiles(path.dirname(wPath))).toEqual(['w.conduit']);
    expect(listFiles(path.dirname(vaultPath))).toEqual(['Vault.conduit']);
    expect(stagingFiles()).toEqual([]);
    expect(h.t.access.log).toEqual([]);
  });

  it('the old password after a rotation is VAULT_PASSWORD_CHANGED_ELSEWHERE (12 row 59)', async () => {
    h.shared.set(vaultPath, { kind: 'ok', bytes: S_BYTES, cls: syncedClass(S_E2, 'file-1') });
    h.presence.set('device-a', presenceOf('MacBook'));
    const bio = await refusal(openPersonalVault(openInput(vaultPath, { source: 'biometric_unlock' }), h.deps));
    expect(JSON.parse(bio.message)).toEqual({
      code: 'VAULT_PASSWORD_CHANGED_ELSEWHERE',
      changedByDeviceName: 'MacBook',
      changedMs: 5_000,
      needsPreviousPassword: false,
      deleteBiometric: true,
    });
    const typed = await refusal(openPersonalVault(openInput(vaultPath), h.deps));
    expect(JSON.parse(typed.message)).toMatchObject({ deleteBiometric: false });
    expect(h.client.of('acquire')).toHaveLength(0);
  });

  it("S newer and reachable: W adopts S's epoch before anything runs", async () => {
    withW(S_E1);
    h.shared.set(vaultPath, { kind: 'ok', bytes: S_BYTES, cls: syncedClass(S_E2, 'file-1') });
    h.replicas.aligned = false;
    h.replicas.keys = E2;
    const opened = await openPersonalVault(openInput(vaultPath, { password: 'pw2' }), h.deps);
    expect(opened.unlock).toEqual({ ok: true, epochId: E2.epochId, via: 's-newer' });
    expect(h.replicas.opened[0]?.key.equals(E2.kEpoch)).toBe(true);
    expect(h.replicas.adopted).toHaveLength(1);
    expect(h.replicas.adopted[0]).toMatchObject({ previousKey: null, sideFilesPresent: false, serverSideFilesFlagRecent: false });
    expect(h.engines[0]?.calls[0]).toBe('runCycle:unlock');
  });

  it('a missing wrap asks for the previous password once, then links it (12 row 64)', async () => {
    withW(S_E1);
    const noWrap = makeState({ current: E2, records: [R1, R2], epochMs: 5_000 });
    h.shared.set(vaultPath, { kind: 'ok', bytes: S_BYTES, cls: syncedClass(noWrap, 'file-1') });
    h.presence.set('device-a', presenceOf('MacBook'));
    const ask = await refusal(openPersonalVault(openInput(vaultPath, { password: 'pw2' }), h.deps));
    expect(JSON.parse(ask.message)).toEqual({
      code: 'VAULT_PASSWORD_CHANGED_ELSEWHERE',
      changedByDeviceName: 'MacBook',
      changedMs: 5_000,
      needsPreviousPassword: true,
      deleteBiometric: false,
    });
    expect(h.client.of('acquire')).toHaveLength(0);

    const wrongPrev = await refusal(openPersonalVault(openInput(vaultPath, { password: 'pw2', previousPassword: 'nope' }), h.deps));
    expect(wrongPrev.message).toBe('Invalid master password');

    h.replicas.aligned = false;
    h.replicas.keys = E2;
    const opened = await openPersonalVault(openInput(vaultPath, { password: 'pw2', previousPassword: 'pw1' }), h.deps);
    expect(opened.unlock?.via).toBe('needs-wrap');
    expect(h.replicas.adopted[0]?.previousKey?.equals(E1.kEpoch)).toBe(true);
  });

  it('a legacy password change on a synced S opens with the new password (previous one optional)', async () => {
    withW(S_E1);
    const EL = epochKeysFor('pw-legacy', 'salt-legacy');
    const legacyMeta = { salt: 'salt-legacy', verification: makeVerificationToken(EL, rand) };
    h.shared.set(vaultPath, { kind: 'ok', bytes: S_BYTES, cls: syncedClass(S_E1, 'file-1', legacyMeta) });
    h.replicas.aligned = false;
    h.replicas.keys = EL;
    const opened = await openPersonalVault(openInput(vaultPath, { password: 'pw-legacy' }), h.deps);
    expect(opened.unlock?.via).toBe('legacy-change');
    expect(h.replicas.adopted[0]?.previousKey).toBeNull();
    h.replicas.aligned = false;
    await openPersonalVault(openInput(vaultPath, { password: 'pw-legacy', previousPassword: 'pw1' }), h.deps);
    expect(h.replicas.adopted[1]?.previousKey?.equals(E1.kEpoch)).toBe(true);
  });

  it('a legacy change on a pre-sync S over W needs the previous password and opens W under its own key', async () => {
    withW(S_E1);
    const EL = epochKeysFor('pw-legacy', 'salt-legacy');
    const legacyMeta = { salt: 'salt-legacy', verification: makeVerificationToken(EL, rand) };
    h.bound.set(vaultPath, LINEAGE);
    h.shared.set(vaultPath, { kind: 'ok', bytes: S_BYTES, cls: presyncClass(legacyMeta) });
    const ask = await refusal(openPersonalVault(openInput(vaultPath, { password: 'pw-legacy' }), h.deps));
    expect(JSON.parse(ask.message)).toMatchObject({ code: 'VAULT_PASSWORD_CHANGED_ELSEWHERE', needsPreviousPassword: true });
    const opened = await openPersonalVault(openInput(vaultPath, { password: 'pw-legacy', previousPassword: 'pw1' }), h.deps);
    expect(opened.unlock).toEqual({ ok: true, epochId: E1.epochId, via: 'w-current' });
    expect(h.replicas.opened[0]?.key.equals(E1.kEpoch)).toBe(true);
    expect(h.replicas.opened[0]?.seed).toEqual({ kind: 'existing' });
    expect(h.replicas.adopted).toHaveLength(0);
    expect(h.engines[0]?.calls).toEqual(['runCycle:unlock', 'adoptLegacy:pw-legacy:pw1', 'start', 'trigger:local-edit']);
  });
});

describe('shared file classes at open (5.2)', () => {
  const cases = [
    { name: 'newer format', file: { kind: 'ok' as const, bytes: S_BYTES, cls: { kind: 'foreign-newer' as const, syncFormat: 2 } }, want: { code: 'VAULT_FOREIGN_FILE', fileName: 'Vault.conduit', kind: 'newer-format', syncFormat: 2 } },
    { name: 'not a vault', file: { kind: 'ok' as const, bytes: S_BYTES, cls: { kind: 'foreign-other' as const, lineageId: null, reason: 'not-conduit' as const } }, want: { code: 'VAULT_FOREIGN_FILE', fileName: 'Vault.conduit', kind: 'other-vault', syncFormat: null } },
    { name: 'torn', file: { kind: 'ok' as const, bytes: S_BYTES, cls: { kind: 'unreadable' as const, reason: 'page-count' as const } }, want: { code: 'VAULT_FILE_UNREADABLE', fileName: 'Vault.conduit', reason: 'page-count' } },
    { name: 'unreachable', file: { kind: 'unreachable' as const, code: 'ETIMEDOUT' }, want: { code: 'VAULT_FILE_UNREADABLE', fileName: 'Vault.conduit', reason: 'unreachable' } },
  ];

  for (const c of cases) {
    it(`${c.name} with no working copy is a structured error before any server call`, async () => {
      h.shared.set(vaultPath, c.file);
      const err = await refusal(openPersonalVault(openInput(vaultPath), h.deps));
      expect(err).toBeInstanceOf(PersonalVaultOpenError);
      expect(JSON.parse(err.message)).toEqual(c.want);
      expect(h.client.calls).toEqual([]);
      expect(h.kdf.calls).toBe(0);
    });
  }

  it("a missing file with no working copy keeps today's message", async () => {
    h.shared.set(vaultPath, { kind: 'missing' });
    const err = await refusal(openPersonalVault(openInput(vaultPath), h.deps));
    expect(err.message).toBe('Vault file not found');
  });

  it('a torn S with a working copy opens from W (offline file mode)', async () => {
    withW(S_E1);
    h.bound.set(vaultPath, LINEAGE);
    h.shared.set(vaultPath, { kind: 'ok', bytes: S_BYTES, cls: { kind: 'unreadable', reason: 'page-count' } });
    const opened = await openPersonalVault(openInput(vaultPath), h.deps);
    expect(opened.lineageId).toBe(LINEAGE);
    expect(opened.unlock?.via).toBe('w-current');
    expect(h.replicas.opened[0]?.seed).toEqual({ kind: 'existing' });
  });
});
