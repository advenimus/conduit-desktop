// @vitest-environment node
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { genesisFromContent } from '../../sync/genesis.js';
import { deriveEpochKeys, lineageIdFromSalt, makeImplicitProvider } from '../../sync/hashing.js';
import { currentEpochId, verifyKey } from '../../sync/key-epoch.js';
import { defaultLocalJson, writeLocalJson } from '../../sync/local-state.js';
import { materialize } from '../../sync/materialize.js';
import { lineagePaths } from '../../sync/paths.js';
import { ensureSyncSchema } from '../../sync/schema.js';
import { loadContent, saveState } from '../../sync/state-store.js';
import { makeTempRoot } from '../../sync/__tests__/host-fakes.js';
import { snapshot, verificationToken, writeLegacyVault } from '../../sync/__tests__/genesis-fixtures.js';
import { LINEAGE, epochKeysFor, fakeDerive, makeState, recordFor, seqRandom } from '../../sync/__tests__/key-epoch-fixtures.js';
import { openPersonalVault, PersonalVaultOpenError } from '../open-personal-vault.js';
import { resolveVaultLocation } from '../open-location.js';
import { readPrivateVaultFile, readWorkingStateCopy } from '../open-staging.js';
import { holder, listFiles, makeOpenHarness, openInput, syncedClass, type OpenHarness } from './open-harness.js';

const STORED_ID = '5e1f0000-aaaa-4bbb-8ccc-dddddddddddd';
const PRIVATE_SALT = Buffer.alloc(32, 4).toString('base64');
const PRIVATE_LINEAGE = lineageIdFromSalt(PRIVATE_SALT);

let root: string;
let h: OpenHarness;

beforeEach(() => {
  root = makeTempRoot('open-files');
  h = makeOpenHarness(root);
  h.t.knobs.userId = 'user-1';
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writePresync(file: string, password: string, salt: string): void {
  const key = fakeDerive(password)(salt);
  writeLegacyVault(file, snapshot({ meta: { salt, verification: verificationToken(key) } }));
}

function writeSynced(file: string, password: string, salt: string, lineageId: string): void {
  writePresync(file, password, salt);
  const db = new Database(file);
  try {
    ensureSyncSchema(db);
    const k0 = deriveEpochKeys(fakeDerive(password)(salt), lineageId);
    const content = loadContent(db);
    const g = genesisFromContent({ content, genesisId: 'ab'.repeat(32), lineageId, k0, randomBytes: crypto.randomBytes, now: () => 1_000 });
    const epoch = g.state.epochs.get(currentEpochId(g.state) ?? '') ?? null;
    const m = materialize(g.state, content, g.cache, { implicit: makeImplicitProvider(k0.kSync), currentEpoch: epoch });
    saveState(db, { state: m.state, plan: m.plan, cache: m.cache, baseline: null });
  } finally {
    db.close();
  }
}

async function refusal(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the open to fail');
}

describe('resolveVaultLocation (3.2, 12 row 63)', () => {
  it('private inside the data folder, shared elsewhere, on a network path or through a symlink', async () => {
    const inData = path.join(root, 'data', 'default.conduit');
    const inCloud = path.join(root, 'cloud', 'Vault.conduit');
    writePresync(inData, 'pw', PRIVATE_SALT);
    writePresync(inCloud, 'pw', PRIVATE_SALT);
    expect(await resolveVaultLocation(inData, h.deps)).toEqual({ realpath: inData, shared: false });
    expect(await resolveVaultLocation(inCloud, h.deps)).toEqual({ realpath: inCloud, shared: true });

    const link = path.join(root, 'data', 'linked.conduit');
    fs.symlinkSync(inCloud, link);
    expect(await resolveVaultLocation(link, h.deps)).toEqual({ realpath: inCloud, shared: true });
    const localLink = path.join(root, 'data', 'local-link.conduit');
    fs.symlinkSync(inData, localLink);
    expect(await resolveVaultLocation(localLink, h.deps)).toEqual({ realpath: inData, shared: true });

    h.t.knobs.networkPrefixes.push(path.join(root, 'data'));
    expect((await resolveVaultLocation(inData, h.deps)).shared).toBe(true);
  });

  it('a file that does not exist yet resolves through its parent', async () => {
    const future = path.join(root, 'data', 'new.conduit');
    expect(await resolveVaultLocation(future, h.deps)).toEqual({ realpath: future, shared: false });
  });
});

describe('private vaults (3.2, 7.3)', () => {
  const vault = () => path.join(root, 'data', 'default.conduit');

  it('take the lease but get no working copy; they open in place', async () => {
    writePresync(vault(), 'pw1', PRIVATE_SALT);
    const opened = await openPersonalVault(openInput(vault()), h.deps);
    expect(opened).toMatchObject({ lineageId: PRIVATE_LINEAGE, shared: false, replica: null, engine: null, unlock: null });
    expect(h.client.of('acquire')[0]?.args).toMatchObject({ vaultKey: PRIVATE_LINEAGE, fileId: null, fileName: 'default.conduit' });
    expect(h.t.access.privateOpens).toEqual([{ path: vault(), password: 'pw1' }]);
    expect(h.replicas.opened).toHaveLength(0);
    expect(h.runtimes[0]?.deps).toMatchObject({ shared: false, replica: null, lineageId: PRIVATE_LINEAGE });
    expect(h.runtimes[0]?.started).toEqual(h.client.acquireResult);
    expect(listFiles(h.config.syncRoot)).toEqual([]);
  });

  it('a wrong password leases and opens nothing', async () => {
    writePresync(vault(), 'pw1', PRIVATE_SALT);
    const err = await refusal(openPersonalVault(openInput(vault(), { password: 'typo' }), h.deps));
    expect(err.message).toBe('Invalid master password');
    expect(h.client.of('acquire')).toHaveLength(0);
    expect(h.t.access.privateOpens).toEqual([]);
  });

  it('are refused by the server peek before the password, like shared ones', async () => {
    writePresync(vault(), 'pw1', PRIVATE_SALT);
    h.client.peekResult = { kind: 'ok', limit: 1, holders: [holder('MacBook')] };
    const err = await refusal(openPersonalVault(openInput(vault()), h.deps));
    expect(JSON.parse(err.message)).toMatchObject({ code: 'VAULT_OPEN_ELSEWHERE', via: 'server', fileName: 'default.conduit' });
    expect(h.kdf.calls).toBe(0);
  });

  it('a lease failure after the in-place open is rolled back', async () => {
    writePresync(vault(), 'pw1', PRIVATE_SALT);
    h.t.access.openPrivateInPlace = async () => {
      throw new Error('in-place open failed');
    };
    const err = await refusal(openPersonalVault(openInput(vault()), h.deps));
    expect(err.message).toBe('in-place open failed');
    expect(h.client.of('release')[0]?.args).toMatchObject({ vaultKey: PRIVATE_LINEAGE, leaseId: 'lease-1' });
  });

  it('missing or foreign private files map to the open errors', async () => {
    expect((await refusal(openPersonalVault(openInput(vault()), h.deps))).message).toBe('Vault file not found');
    fs.writeFileSync(vault(), 'not a database at all, just text that is long enough');
    const torn = await refusal(openPersonalVault(openInput(vault()), h.deps));
    expect(JSON.parse(torn.message)).toEqual({ code: 'VAULT_FILE_UNREADABLE', fileName: 'default.conduit', reason: 'open-failed' });
    fs.rmSync(vault());
    const db = new Database(vault());
    db.exec('CREATE TABLE t (x)');
    db.close();
    const other = await refusal(openPersonalVault(openInput(vault()), h.deps));
    expect(other).toBeInstanceOf(PersonalVaultOpenError);
    expect(JSON.parse(other.message)).toEqual({ code: 'VAULT_FOREIGN_FILE', fileName: 'default.conduit', kind: 'other-vault', syncFormat: null });
  });
});

describe('private file reader', () => {
  const stagingDir = () => path.join(root, 'staging');

  beforeEach(() => fs.mkdirSync(stagingDir(), { recursive: true }));

  it('reads the lineage from sync_state, or from the salt, and flags a newer format', async () => {
    const file = path.join(root, 'data', 'v.conduit');
    writeSynced(file, 'pw1', PRIVATE_SALT, LINEAGE);
    expect(await readPrivateVaultFile(file, stagingDir(), h.t.host)).toMatchObject({ kind: 'ok', lineageId: LINEAGE });
    const db = new Database(file);
    db.prepare("UPDATE vault_meta SET value = '2' WHERE key = 'sync_format'").run();
    db.close();
    expect(await readPrivateVaultFile(file, stagingDir(), h.t.host)).toEqual({ kind: 'problem', problem: { kind: 'foreign-newer', syncFormat: 2 } });
    expect(listFiles(stagingDir())).toEqual([]);
  });

  it('sees vault_meta that only reached the -wal (a crash of an older app)', async () => {
    const file = path.join(root, 'data', 'wal.conduit');
    writePresync(file, 'pw1', PRIVATE_SALT);
    const newSalt = Buffer.alloc(32, 8).toString('base64');
    const live = new Database(file);
    live.pragma('journal_mode = WAL');
    live.pragma('wal_autocheckpoint = 0');
    live.prepare("UPDATE vault_meta SET value = ? WHERE key = 'salt'").run(newSalt);
    try {
      expect(fs.existsSync(`${file}-wal`)).toBe(true);
      const read = await readPrivateVaultFile(file, stagingDir(), h.t.host);
      expect(read).toMatchObject({ kind: 'ok', lineageId: lineageIdFromSalt(newSalt), meta: { salt: newSalt } });
    } finally {
      live.close();
    }
  });
});

describe('working copy state read', () => {
  it('reads W through a private copy and leaves W untouched', async () => {
    const lp = lineagePaths(h.config.machineDir, LINEAGE);
    fs.mkdirSync(lp.dir, { recursive: true });
    writeSynced(lp.working, 'pw1', 'c2FsdA==', LINEAGE);
    const before = fs.readFileSync(lp.working);
    const staging = path.join(root, 'staging');
    fs.mkdirSync(staging);
    const state = await readWorkingStateCopy(lp.working, staging, h.t.host);
    expect(state.lineageId).toBe(LINEAGE);
    expect(fs.readFileSync(lp.working).equals(before)).toBe(true);
    expect(listFiles(lp.dir)).toEqual(['w.conduit']);
    expect(listFiles(staging)).toEqual([]);
  });
});

describe('binding at open (5.20 moved or copied)', () => {
  const rand = seqRandom(9);
  const E1 = epochKeysFor('pw1', 'salt1');
  const S_E1 = makeState({ current: E1, records: [recordFor(E1, null, 'salt1', rand)] });
  const bytes = Buffer.from('S');
  let vaultPath: string;

  beforeEach(() => {
    vaultPath = path.join(root, 'cloud', 'Vault.conduit');
    fs.writeFileSync(vaultPath, bytes);
    h.shared.set(vaultPath, { kind: 'ok', bytes, cls: syncedClass(S_E1, 'file-1') });
    h.replicas.state = S_E1;
    h.replicas.keys = E1;
    const lp = lineagePaths(h.config.machineDir, LINEAGE);
    fs.mkdirSync(lp.dir, { recursive: true });
    fs.writeFileSync(lp.working, 'W');
    h.withW.add(LINEAGE);
    h.wStates.set(lp.working, S_E1);
  });

  function storeBinding(sharedPath: string): void {
    const local = { ...defaultLocalJson(LINEAGE, 3, 'cd'.repeat(16)), binding: { sharedPath, realpath: sharedPath, fileId: STORED_ID } };
    writeLocalJson(lineagePaths(h.config.machineDir, LINEAGE).dir, local);
  }

  it('same realpath keeps the stored binding', async () => {
    storeBinding(vaultPath);
    await openPersonalVault(openInput(vaultPath), h.deps);
    expect(h.replicas.opened[0]?.binding).toBeNull();
    expect(h.client.of('acquire')[0]?.args).toMatchObject({ fileId: STORED_ID });
    expect(h.engines[0]?.prompts).toEqual([]);
  });

  it('a moved vault is rebound with the same file id', async () => {
    storeBinding(path.join(root, 'old', 'Vault.conduit'));
    await openPersonalVault(openInput(vaultPath), h.deps);
    expect(h.replicas.opened[0]?.binding).toEqual({ sharedPath: vaultPath, realpath: vaultPath, fileId: STORED_ID });
  });

  it('a copy made on this device gets a new file id and a same-device-copy prompt', async () => {
    const original = path.join(root, 'old', 'Vault.conduit');
    storeBinding(original);
    h.shared.set(original, { kind: 'ok', bytes: Buffer.from('original'), cls: syncedClass(S_E1, STORED_ID) });
    await openPersonalVault(openInput(vaultPath), h.deps);
    const binding = h.replicas.opened[0]?.binding;
    expect(binding?.sharedPath).toBe(vaultPath);
    expect(binding?.fileId).not.toBe(STORED_ID);
    expect(h.engines[0]?.prompts).toEqual([
      expect.objectContaining({ kind: 'same-device-copy', id: `same-device-copy:${original}`, copy: expect.objectContaining({ path: original, name: 'Vault.conduit' }) }),
    ]);
  });
});

describe('create (7.3)', () => {
  it('a shared vault gets a new lineage, a verifiable key, the lease and a first publish', async () => {
    const target = path.join(root, 'cloud', 'New.conduit');
    h.replicas.keys = epochKeysFor('x', 'y');
    h.replicas.state = makeState({ current: h.replicas.keys, records: [] });
    const opened = await openPersonalVault(openInput(target, { create: true, source: 'vault_create', password: 'fresh' }), h.deps);
    const input = h.replicas.opened[0];
    if (input?.seed.kind !== 'new-vault') throw new Error('expected a new-vault seed');
    expect(opened).toMatchObject({ shared: true, unlock: null, lineageId: input.lineageId });
    expect(input.lineageId).not.toBe(LINEAGE);
    expect(verifyKey(fakeDerive('fresh')(input.seed.salt), input.seed.verification)).toBe(true);
    expect(input.key.equals(fakeDerive('fresh')(input.seed.salt))).toBe(true);
    expect(input.binding).toMatchObject({ sharedPath: target, realpath: target });
    expect(h.client.of('acquire')[0]?.args).toMatchObject({ vaultKey: input.lineageId, fileId: input.binding?.fileId });
    expect(h.engines[0]?.calls).toEqual(['publishInitial', 'start', 'trigger:local-edit']);
  });

  it('refuses an existing path', async () => {
    const target = path.join(root, 'cloud', 'Exists.conduit');
    fs.writeFileSync(target, 'x');
    const err = await refusal(openPersonalVault(openInput(target, { create: true }), h.deps));
    expect(err.message).toBe('Vault file already exists');
    expect(h.client.calls).toEqual([]);
  });

  it('a private vault is created in place and leased under its salt lineage', async () => {
    const target = path.join(root, 'data', 'default.conduit');
    h.t.access.createPrivateInPlace = async (p: string, password: string) => {
      writePresync(p, password, PRIVATE_SALT);
    };
    const opened = await openPersonalVault(openInput(target, { create: true, source: 'vault_initialize' }), h.deps);
    expect(opened).toMatchObject({ shared: false, lineageId: PRIVATE_LINEAGE });
    expect(h.client.of('acquire')[0]?.args).toMatchObject({ vaultKey: PRIVATE_LINEAGE });
  });

  it('a failed shared create removes the lineage folder it made', async () => {
    const target = path.join(root, 'cloud', 'New.conduit');
    h.replicas.keys = epochKeysFor('x', 'y');
    h.replicas.state = makeState({ current: h.replicas.keys, records: [] });
    h.engineFactory = () => {
      throw new Error('engine assembly failed');
    };
    const err = await refusal(openPersonalVault(openInput(target, { create: true }), h.deps));
    expect(err.message).toBe('engine assembly failed');
    const lineageId = h.replicas.opened[0]?.lineageId ?? '';
    expect(fs.existsSync(lineagePaths(h.config.machineDir, lineageId).dir)).toBe(false);
    expect(h.replicas.last().closed).toBe(true);
  });
});
