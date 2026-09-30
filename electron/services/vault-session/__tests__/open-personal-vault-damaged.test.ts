// @vitest-environment node
// A damaged working copy (clobbered header, bad disk block, partial restore) never makes the
// vault unopenable: the open fails with VAULT_WORKING_COPY_DAMAGED (JSON in Error.message), and
// with recoverWorkingCopy the damaged W is parked and W is seeded again from the shared file.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lineageIdFromSalt } from '../../sync/hashing.js';
import { lineagePaths } from '../../sync/paths.js';
import { IncarnationRegistry, type ReplicaPort } from '../../sync/replica.js';
import { snapshot, verificationToken, writeLegacyVault } from '../../sync/__tests__/genesis-fixtures.js';
import { makeTempRoot } from '../../sync/__tests__/host-fakes.js';
import { fakeDerive } from '../../sync/__tests__/key-epoch-fixtures.js';
import { REAL_COLLABORATORS } from '../open-deps.js';
import { openPersonalVault, PersonalVaultOpenError, type OpenDeps } from '../open-personal-vault.js';
import { makeOpenHarness, openInput, type OpenHarness } from './open-harness.js';
import { rpcOk } from './session-fakes.js';

const SALT = Buffer.alloc(32, 6).toString('base64');
const LINEAGE = lineageIdFromSalt(SALT);
const LEASE = 'b1b2b3b4-0000-4000-8000-000000000001';

let root: string;
let h: OpenHarness;
let deps: OpenDeps;
let vaultPath: string;
const opened: ReplicaPort[] = [];

beforeEach(() => {
  root = makeTempRoot('open-damaged');
  h = makeOpenHarness(root);
  const fake = h.deps.collaborators ?? {};
  deps = {
    ...h.deps,
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
  writeLegacyVault(vaultPath, snapshot({ meta: { salt: SALT, verification: verificationToken(fakeDerive('pw1')(SALT)) } }));
  h.t.knobs.userId = 'user-1';
  h.t.rpc.handle('vault_session_peek', () => rpcOk({ limit: 1, holders: [] }));
  h.t.rpc.handle('vault_session_acquire', () =>
    rpcOk({ granted: true, lease_id: LEASE, limit: 1, sessions: [], server_now: new Date(h.t.clock.now()).toISOString() }),
  );
  h.t.rpc.handle('vault_session_release', () => rpcOk(null));
});

afterEach(() => {
  for (const r of opened.splice(0)) r.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function openOnce(over: Parameters<typeof openInput>[1] = {}) {
  const res = await openPersonalVault(openInput(vaultPath, over), deps);
  if (res.replica !== null) opened.push(res.replica);
  return res;
}

async function damageW(): Promise<Buffer> {
  (await openOnce()).replica?.close();
  opened.splice(0);
  const lp = lineagePaths(h.config.machineDir, LINEAGE);
  const w = fs.readFileSync(lp.working);
  w.fill(0x41, 0, 100);
  fs.writeFileSync(lp.working, w);
  return w;
}

describe('a damaged working copy', () => {
  it('fails with a structured error that offers recovery, and leaves W alone', async () => {
    const damaged = await damageW();
    const err = await openOnce().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PersonalVaultOpenError);
    expect(JSON.parse((err as Error).message)).toEqual({ code: 'VAULT_WORKING_COPY_DAMAGED', fileName: 'Vault.conduit', recoverable: true });
    expect(fs.readFileSync(lineagePaths(h.config.machineDir, LINEAGE).working).equals(damaged)).toBe(true);
    expect(h.t.rpc.callsOf('vault_session_acquire')).toHaveLength(1);
  });

  it('recoverWorkingCopy parks the damaged file and seeds W again from the shared file', async () => {
    const damaged = await damageW();
    const res = await openOnce({ recoverWorkingCopy: true });
    expect(res.replica?.lineageId).toBe(LINEAGE);
    const lp = lineagePaths(h.config.machineDir, LINEAGE);
    const parked = fs.readdirSync(lp.parked).filter((n) => n.startsWith('w-') && n.endsWith('.conduit'));
    expect(parked).toHaveLength(1);
    expect(fs.readFileSync(path.join(lp.parked, parked[0] as string)).equals(damaged)).toBe(true);
    expect(fs.readFileSync(lp.working).subarray(0, 15).toString('latin1')).toBe('SQLite format 3');
  });

  it('is not recoverable when the shared file is gone', async () => {
    await damageW();
    fs.rmSync(vaultPath);
    const err = await openOnce({ recoverWorkingCopy: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PersonalVaultOpenError);
    expect(JSON.parse((err as Error).message)).toMatchObject({ code: 'VAULT_WORKING_COPY_DAMAGED', recoverable: false });
    expect(fs.existsSync(lineagePaths(h.config.machineDir, LINEAGE).working)).toBe(true);
  });
});
