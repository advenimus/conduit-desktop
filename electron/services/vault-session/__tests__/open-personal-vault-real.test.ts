// @vitest-environment node
// openPersonalVault over the real shared-file, replica, session-client, effective-limit, claims
// and file-binding modules, with real files (TestWorkingCopyHost stands in for ConduitVault).
// The engine, the session runtime, presence building and epoch adoption stay faked here.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deviceRegKey, ownerRegKey } from '../../sync/catalog.js';
import { accountHint, lineageIdFromSalt } from '../../sync/hashing.js';
import { getRegister } from '../../sync/state-view.js';
import { lineagePaths } from '../../sync/paths.js';
import { hasSyncTables } from '../../sync/schema.js';
import { loadFile } from '../../sync/state-store.js';
import { makeTempRoot } from '../../sync/__tests__/host-fakes.js';
import { snapshot, verificationToken, writeLegacyVault } from '../../sync/__tests__/genesis-fixtures.js';
import { fakeDerive } from '../../sync/__tests__/key-epoch-fixtures.js';
import { rpcFail, rpcOk } from './session-fakes.js';
import { REAL_COLLABORATORS } from '../open-deps.js';
import { openPersonalVault, PersonalVaultOpenError, type OpenDeps } from '../open-personal-vault.js';
import { IncarnationRegistry, type ReplicaPort } from '../../sync/replica.js';
import { listFiles, makeOpenHarness, openInput, type OpenHarness } from './open-harness.js';

const SALT = Buffer.alloc(32, 6).toString('base64');
const LINEAGE = lineageIdFromSalt(SALT);
const LEASE = 'b1b2b3b4-0000-4000-8000-000000000001';

let root: string;
let h: OpenHarness;
let deps: OpenDeps;
let vaultPath: string;
const opened: ReplicaPort[] = [];

function writePresync(file: string, password: string): void {
  writeLegacyVault(file, snapshot({ meta: { salt: SALT, verification: verificationToken(fakeDerive(password)(SALT)) } }));
}

function scriptServer(limit: number): void {
  h.t.rpc.handle('vault_session_peek', () => rpcOk({ limit, holders: [] }));
  h.t.rpc.handle('vault_session_acquire', () =>
    rpcOk({ granted: true, lease_id: LEASE, limit, sessions: [], server_now: new Date(h.t.clock.now()).toISOString() }),
  );
  h.t.rpc.handle('vault_session_release', () => rpcOk(null));
}

beforeEach(() => {
  root = makeTempRoot('open-real');
  h = makeOpenHarness(root);
  const fake = h.deps.collaborators ?? {};
  deps = {
    ...h.deps,
    verifyCommits: true,
    incarnations: new IncarnationRegistry(),
    collaborators: {
      ...REAL_COLLABORATORS,
      createRuntime: fake.createRuntime,
      readPresence: fake.readPresence,
      buildPresence: fake.buildPresence,
      adoptEpochAtOpen: fake.adoptEpochAtOpen,
    },
  };
  vaultPath = path.join(root, 'cloud', 'Vault.conduit');
  writePresync(vaultPath, 'pw1');
  h.t.knobs.userId = 'user-1';
  scriptServer(1);
});

afterEach(() => {
  for (const r of opened.splice(0)) r.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function open(over: Parameters<typeof openInput>[1] = {}) {
  const res = await openPersonalVault(openInput(vaultPath, over), deps);
  if (res.replica !== null) opened.push(res.replica);
  return res;
}

describe('openPersonalVault with the real file, replica and session modules', () => {
  it('first open of a pre-sync vault: G1 genesis, binding, presence and owner claim; S untouched', async () => {
    const before = fs.readFileSync(vaultPath);
    const res = await open();
    expect(res).toMatchObject({ lineageId: LINEAGE, shared: true, firstCyclePending: false });
    expect(res.unlock?.via).toBe('no-w');
    const lp = lineagePaths(h.config.machineDir, LINEAGE);
    expect(fs.existsSync(lp.working)).toBe(true);
    expect(fs.readFileSync(lp.genesis).equals(before)).toBe(true);
    const local = JSON.parse(fs.readFileSync(lp.local, 'utf8')) as { binding: { realpath: string; sharedPath: string } };
    expect(local.binding).toMatchObject({ realpath: vaultPath, sharedPath: vaultPath });
    const state = res.replica?.state();
    if (state === undefined) throw new Error('expected a replica');
    const claim = getRegister(state, ownerRegKey())?.sibs[0]?.value;
    expect(JSON.parse(String(claim))).toEqual({ a: accountHint(LINEAGE, 'user-1'), d: h.config.deviceUuid });
    const presence = getRegister(state, deviceRegKey(h.config.deviceUuid))?.sibs[0]?.value;
    expect(JSON.parse(String(presence))).toMatchObject({ session_open: 1, session_since_ms: h.t.clock.now() });
    const acquire = h.t.rpc.callsOf('vault_session_acquire')[0];
    expect(acquire?.args).toMatchObject({ p_vault_key: LINEAGE, p_device_id: h.config.deviceUuid, p_location: 'local:cloud', p_takeover: false });
    expect(fs.readFileSync(vaultPath).equals(before)).toBe(true);
    expect(listFiles(path.dirname(vaultPath))).toEqual(['Vault.conduit']);
    expect(listFiles(path.join(h.config.syncRoot, 'tmp'))).toEqual([]);
    expect(h.t.logger.unprefixed()).toEqual([]);
  });

  it('a wrong password writes nothing: no lineage folder, no lease, S unchanged', async () => {
    const before = fs.readFileSync(vaultPath);
    await expect(open({ password: 'typo' })).rejects.toThrow('Invalid master password');
    expect(fs.existsSync(path.join(h.config.machineDir, LINEAGE))).toBe(false);
    expect(h.t.rpc.callsOf('vault_session_acquire')).toHaveLength(0);
    expect(fs.readFileSync(vaultPath).equals(before)).toBe(true);
    expect(listFiles(path.join(h.config.syncRoot, 'tmp'))).toEqual([]);
  });

  it('reopening after a lock uses the existing W and keeps the binding', async () => {
    const first = await open();
    first.replica?.close();
    opened.length = 0;
    const second = await open();
    expect(second.unlock?.via).toBe('w-current');
    expect(second.replica?.lineageId).toBe(LINEAGE);
    expect(second.replica?.local().binding?.realpath).toBe(vaultPath);
  });

  it('a torn S with W opens from W; with no W it is VAULT_FILE_UNREADABLE', async () => {
    const first = await open();
    first.replica?.close();
    opened.length = 0;
    const bytes = fs.readFileSync(vaultPath);
    fs.writeFileSync(vaultPath, bytes.subarray(0, bytes.length - 100));
    const again = await open();
    expect(again.unlock?.via).toBe('w-current');

    const other = path.join(root, 'cloud', 'Torn.conduit');
    fs.writeFileSync(other, bytes.subarray(0, bytes.length - 100));
    const err = await openPersonalVault(openInput(other), deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PersonalVaultOpenError);
    expect(JSON.parse((err as Error).message)).toMatchObject({ code: 'VAULT_FILE_UNREADABLE', fileName: 'Torn.conduit' });
  });

  it('a newer sync_format with no W is VAULT_FOREIGN_FILE newer-format', async () => {
    const db = new Database(vaultPath);
    db.prepare("INSERT INTO vault_meta(key, value) VALUES ('sync_format', '2')").run();
    db.close();
    const err = await open().catch((e: unknown) => e);
    expect(JSON.parse((err as Error).message)).toEqual({ code: 'VAULT_FOREIGN_FILE', fileName: 'Vault.conduit', kind: 'newer-format', syncFormat: 2 });
  });

  it('server down: opens unconfirmed with the claim (12 row 35)', async () => {
    h.t.rpc.handle('vault_session_peek', () => rpcFail({ kind: 'http', status: 503 }));
    h.t.rpc.handle('vault_session_acquire', () => rpcFail({ kind: 'network' }));
    const res = await open();
    expect(res.shared).toBe(true);
    expect(h.runtimes[0]?.started).toMatchObject({ kind: 'unconfirmed' });
    const w = new Database(lineagePaths(h.config.machineDir, LINEAGE).working, { readonly: true });
    try {
      expect(hasSyncTables(w)).toBe(true);
    } finally {
      w.close();
    }
    const state = res.replica?.state();
    expect(state && getRegister(state, ownerRegKey())).toBeDefined();
  });

  it('a default.conduit symlinked into a cloud folder is shared (12 row 63)', async () => {
    const link = path.join(h.config.dataDir, 'default.conduit');
    fs.symlinkSync(vaultPath, link);
    const res = await openPersonalVault(openInput(link), deps);
    if (res.replica !== null) opened.push(res.replica);
    expect(res.shared).toBe(true);
    expect(res.replica?.local().binding).toMatchObject({ realpath: vaultPath, sharedPath: link });
    expect(h.t.access.privateOpens).toEqual([]);
  });

  it('the file written by genesis loads with this lineage', async () => {
    await open();
    const db = new Database(lineagePaths(h.config.machineDir, LINEAGE).working, { readonly: true });
    try {
      expect(loadFile(db).state.lineageId).toBe(LINEAGE);
    } finally {
      db.close();
    }
  });
});
