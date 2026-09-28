// @vitest-environment node
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConduitVault } from '../../vault/vault.js';
import { deriveKey } from '../../vault/crypto.js';
import { presenceWrite } from '../capture-local.js';
import { digestState } from '../digest.js';
import { deriveEpochKeys, epochIdOf, genesisIdOf } from '../hashing.js';
import type { Kdf, VaultMutationInfo } from '../host.js';
import { INVALID_PASSWORD_MESSAGE, type ReplicaPort } from '../replica.js';
import { StateBuilder, rowLife } from '../state-view.js';
import { loadFile } from '../state-store.js';
import { TBL, type KeyRing, type PresenceValue, type RowKey, type SyncState } from '../types.js';
import { NEW_PASSWORD, OLD_PASSWORD, createLegacyVault, type LegacyFixture } from './core-e2e-fixtures.js';
import type { TestWorkingCopy } from './host-fakes.js';
import { makeTempRoot } from './host-fakes.js';
import {
  editInPlace,
  entryReg,
  insertEntry,
  makeDevice,
  newVaultSeed,
  open,
  provisionalOf,
  type DeviceOptions,
  type TestDevice,
} from './replica-fixtures.js';

let fixtureDir: string;
let legacy: LegacyFixture;

beforeAll(() => {
  fixtureDir = makeTempRoot('replica-commit-fixture');
  legacy = createLegacyVault(fixtureDir);
});

afterAll(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

let root: string;
const opened: ReplicaPort[] = [];
const devices: TestDevice[] = [];

beforeEach(() => {
  root = makeTempRoot('replica-commit');
});

afterEach(() => {
  for (const r of opened.splice(0)) r.close();
  for (const d of devices.splice(0)) expect(d.t.logger.unprefixed()).toEqual([]);
  fs.rmSync(root, { recursive: true, force: true });
});

function device(opts: DeviceOptions = {}): TestDevice {
  const d = makeDevice(root, opts);
  devices.push(d);
  return d;
}

interface Opened {
  readonly d: TestDevice;
  readonly r: ReplicaPort;
  readonly h: TestWorkingCopy;
  readonly lineageId: string;
  readonly key: Buffer;
}

async function newVault(opts: DeviceOptions = {}): Promise<Opened> {
  const d = device(opts);
  const nv = newVaultSeed(d);
  const r = (await open(d, nv.lineageId, nv.key, nv.seed, null)).replica;
  opened.push(r);
  return { d, r, h: d.t.workingCopy.last(), lineageId: nv.lineageId, key: nv.key };
}

function entryRow(id: string): RowKey {
  return { tbl: TBL.entries, rowId: id };
}

function insertThroughHook(o: Opened, id: string, name: string, interactive = true): void {
  o.h.mutate((db) => insertEntry(db, id, name), { rows: [entryRow(id)], interactive });
}

function contentHas(o: Opened, id: string): boolean {
  return o.r.database().prepare('SELECT 1 FROM entries WHERE id = ?').get(id) !== undefined;
}

/** `w` with its epoch register pointing at another epoch (a state W's ring cannot materialize). */
function withForeignEpoch(w: SyncState, epochId: string): SyncState {
  const reg = w.rows.get(`${TBL.sync}:key`)?.regs.get('epoch');
  const sib = reg?.sibs[0];
  if (reg === undefined || sib === undefined) throw new Error('test: no epoch register');
  const b = new StateBuilder(w);
  b.setRegister({ ...reg, sibs: [{ ...sib, value: epochId }] });
  return b.build();
}

function foreignRing(lineageId: string): KeyRing {
  const k = deriveEpochKeys(crypto.randomBytes(32), lineageId);
  return { current: k, byEpoch: new Map([[k.epochId, k]]) };
}

describe('hook path', () => {
  it('captures the touched rows in the mutator transaction, bumps the generation and notifies after commit', async () => {
    const o = await newVault();
    o.r.updateLocal((l) => ({ ...l, pendingPublish: false }));
    const commits: VaultMutationInfo[] = [];
    o.r.onLocalCommit((m) => commits.push(m));
    const gen0 = o.r.generation();
    const id = crypto.randomUUID();
    insertThroughHook(o, id, 'web box');
    expect(o.r.generation()).toBe(gen0 + 1);
    expect(provisionalOf(o.r.state(), id, 'name')).toMatchObject({ dev: o.r.dev(), value: 'web box' });
    expect(entryReg(o.r.state(), id, '_life')?.sibs[0]?.value).toBe('live');
    expect(commits).toEqual([{ rows: [entryRow(id)], interactive: true }]);
    expect(o.r.local().pendingPublish).toBe(true);
    const disk = loadFile(o.r.database());
    expect(digestState(disk.state)).toBe(digestState(o.r.state()));
  });

  it('refuses to capture while the epoch is not aligned, which rolls the mutation back', async () => {
    const o = await newVault();
    const ring = o.r.ring();
    o.r.setRing(foreignRing(o.lineageId), crypto.randomBytes(32));
    expect(o.r.epochAligned()).toBe(false);
    const gen0 = o.r.generation();
    const id = crypto.randomUUID();
    expect(() => insertThroughHook(o, id, 'blocked')).toThrow(/not aligned/);
    expect(contentHas(o, id)).toBe(false);
    expect(o.r.generation()).toBe(gen0);
    expect(() => o.r.fullPass()).toThrow(/key ring/);
    expect(() => o.r.applyWrites([], { interactive: true })).toThrow(/key ring/);
    o.r.setRing(ring, ring.current.kEpoch);
    insertThroughHook(o, id, 'allowed');
    expect(contentHas(o, id)).toBe(true);
    expect(o.h.keys.length).toBe(3);
  });

  it('reloads W when a captured mutation was rolled back without afterCommit', async () => {
    const o = await newVault();
    const id = crypto.randomUUID();
    const info = { rows: [entryRow(id)], interactive: true };
    expect(() =>
      o.r.database().transaction(() => {
        insertEntry(o.r.database(), id, 'rolled back');
        o.h.hooks?.captureInTransaction(info);
        throw new Error('mutator failed after the capture');
      })(),
    ).toThrow('mutator failed');
    expect(contentHas(o, id)).toBe(false);
    expect(o.r.fullPass().changed).toBe(false);
    expect(rowLife(o.r.state(), entryRow(id))).toBe('unknown');
    expect(o.d.t.logger.messages('warn')).toContain('[sync] reloading the working copy from disk');
    expect(digestState(loadFile(o.r.database()).state)).toBe(digestState(o.r.state()));
  });

  it('forwards full-pass requests, and a full pass catches writes that skipped the hooks', async () => {
    const o = await newVault();
    const id = crypto.randomUUID();
    insertThroughHook(o, id, 'svc');
    const reasons: string[] = [];
    o.r.onFullPassRequest((reason) => reasons.push(reason));
    o.h.hooks?.requestFullPass('import');
    expect(reasons).toEqual(['import']);
    o.r.database().prepare("UPDATE entries SET host = '10.2.2.2' WHERE id = ?").run(id);
    const res = o.r.fullPass();
    expect(res.changed).toBe(true);
    expect(provisionalOf(o.r.state(), id, 'host')).toMatchObject({ dev: o.r.dev(), value: '10.2.2.2' });
    expect(o.r.fullPass().changed).toBe(false);
  });

  it('a throwing listener is logged and does not undo the committed mutation', async () => {
    const o = await newVault();
    o.r.onLocalCommit(() => {
      throw new Error('listener');
    });
    const id = crypto.randomUUID();
    insertThroughHook(o, id, 'kept');
    expect(contentHas(o, id)).toBe(true);
    expect(o.d.t.logger.messages('error')).toContain('[sync] replica listener failed');
  });
});

describe('generation-checked commits', () => {
  it('commitIfGeneration writes nothing after an interleaved mutation', async () => {
    const o = await newVault();
    const gen0 = o.r.generation();
    const w0 = o.r.state();
    const id = crypto.randomUUID();
    insertThroughHook(o, id, 'interleaved');
    expect(o.r.commitIfGeneration(w0, gen0)).toBeNull();
    expect(contentHas(o, id)).toBe(true);
    expect(rowLife(o.r.state(), entryRow(id))).toBe('live');
    const out = o.r.commitIfGeneration(o.r.state(), o.r.generation());
    expect(out?.generation).toBe(gen0 + 2);
  });

  it('commitWith sees the current W and rolls back everything when it fails', async () => {
    const o = await newVault();
    const id = crypto.randomUUID();
    insertThroughHook(o, id, 'seen');
    let seen = false;
    o.r.commitWith((w) => {
      seen = w.rows.has(`${TBL.entries}:${id}`);
      return w;
    });
    expect(seen).toBe(true);
    const gen = o.r.generation();
    const digest = digestState(o.r.state());
    const stray = crypto.randomUUID();
    const foreign = foreignRing(o.lineageId);
    expect(() =>
      o.r.commitWith((w) => {
        insertEntry(o.r.database(), stray, 'raw write inside the transaction');
        return withForeignEpoch(w, foreign.current.epochId);
      }),
    ).toThrow(/another key epoch/);
    expect(() => o.r.commitWith(() => { throw new Error('boom'); })).toThrow('boom');
    expect(contentHas(o, stray)).toBe(false);
    expect(o.r.generation()).toBe(gen);
    expect(digestState(o.r.state())).toBe(digest);
  });

  it('a state of another key epoch is never materialized', async () => {
    const o = await newVault();
    const foreign = foreignRing(o.lineageId);
    const gen = o.r.generation();
    expect(() => o.r.commit(withForeignEpoch(o.r.state(), foreign.current.epochId))).toThrow(/another key epoch/);
    expect(o.r.generation()).toBe(gen);
  });
});

describe('explicit writes', () => {
  function presence(): PresenceValue {
    return {
      platform: 'macos', name: 'Test Mac', app_version: '0.18.0', first_seen_ms: 1, last_active_ms: 2,
      session_open: 1, session_since_ms: 1, account_hint: null, file_hint: null, side_files_seen_ms: null,
    };
  }

  it('applyWrites commits under one dot and always stamps file_id when given', async () => {
    const o = await newVault();
    const commits: VaultMutationInfo[] = [];
    o.r.onLocalCommit((m) => commits.push(m));
    const fileId = crypto.randomUUID();
    const res = o.r.applyWrites([presenceWrite(presence(), o.r.context())], { interactive: true, ruleR: false, fileId });
    expect(res.changed).toBe(true);
    expect(o.r.current().fileId).toBe(fileId);
    expect(loadFile(o.r.database()).fileId).toBe(fileId);
    expect(commits).toHaveLength(1);
    const other = crypto.randomUUID();
    const none = o.r.applyWrites([], { interactive: true, fileId: other });
    expect(none.changed).toBe(false);
    expect(loadFile(o.r.database()).fileId).toBe(other);
    expect(commits).toHaveLength(1);
  });
});

describe('identity', () => {
  it('keeps the dev on a same-launch reopen and starts a new incarnation when an older W is restored', async () => {
    const o = await newVault();
    const dev = o.r.dev();
    const wPath = o.r.paths.working;
    o.r.close();
    const backup = path.join(root, 'w-backup.conduit');
    fs.copyFileSync(wPath, backup);
    const again = (await open(o.d, o.lineageId, o.key, { kind: 'existing' }, null)).replica;
    expect(again.dev()).toBe(dev);
    const h = o.d.t.workingCopy.last();
    const id = crypto.randomUUID();
    h.mutate((db) => insertEntry(db, id, 'after backup'), { rows: [entryRow(id)], interactive: true });
    again.close();
    fs.copyFileSync(backup, wPath);
    const restored = (await open(o.d, o.lineageId, o.key, { kind: 'existing' }, null)).replica;
    opened.push(restored);
    expect(restored.dev()).not.toBe(dev);
    expect(restored.local().dev).toBe(restored.dev());
    expect(o.d.t.logger.messages('warn')).toContain('[sync] new incarnation for this lineage');
    const idNew = crypto.randomUUID();
    o.d.t.workingCopy.last().mutate((db) => insertEntry(db, idNew, 'new dev'), { rows: [entryRow(idNew)], interactive: true });
    expect(provisionalOf(restored.state(), idNew, 'name')?.dev).toBe(restored.dev());
  });

  it('startNewIncarnation switches dev and context, and receive ignores far-future dots of other installs', async () => {
    const o = await newVault();
    const before = o.r.dev();
    const change = o.r.startNewIncarnation('dev-collision');
    expect(change.oldDev).toBe(before);
    expect(change.newDev).toBe(o.r.dev());
    expect(o.r.context().dev).toBe(o.r.dev());
    expect(o.r.local().dev).toBe(o.r.dev());
    const now = o.d.t.clock.now();
    const far = now + 2 * 24 * 60 * 60 * 1000;
    const other = new StateBuilder(o.r.state());
    other.joinVv(424242, { ms: far, c: 0 });
    o.r.receive(other.build());
    expect(o.r.tick().ms).toBeLessThan(far);
    const own = new StateBuilder(o.r.state());
    own.joinVv(o.r.dev(), { ms: far, c: 3 });
    o.r.receive(own.build());
    expect(o.r.tick()).toMatchObject({ ms: far, c: 4 });
  });

  it('close is idempotent, removes the hooks and makes later calls throw', async () => {
    const o = await newVault();
    o.r.close();
    o.r.close();
    opened.splice(0);
    expect(o.h.closed).toBe(true);
    expect(o.h.hooks).toBeNull();
    expect(() => o.r.state()).toThrow('[sync] replica closed');
  });
});

describe('password change (4.8, new build)', () => {
  const realKdf: Kdf = { deriveKey: (password, saltB64) => deriveKey(password, Buffer.from(saltB64, 'base64')) };

  it('rekeys W so ConduitVault opens it with the new password only', async () => {
    const d = device({ kdf: realKdf });
    const shared = path.join(root, 'cloud', 'Vault.conduit');
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.writeFileSync(shared, legacy.source.bytes);
    const seed = { kind: 'genesis', sharedBytes: legacy.source.bytes } as const;
    const r = (await open(d, legacy.source.lineageId, legacy.source.key, seed, null)).replica;
    opened.push(r);
    const h = d.t.workingCopy.last();
    expect(() => r.changePassword('not the password', NEW_PASSWORD, false)).toThrow(INVALID_PASSWORD_MESSAGE);
    const commits: VaultMutationInfo[] = [];
    r.onLocalCommit((m) => commits.push(m));
    r.changePassword(OLD_PASSWORD, NEW_PASSWORD, false);
    expect(commits).toHaveLength(1);
    expect(r.epochAligned()).toBe(true);
    const newKey = h.keys[h.keys.length - 1];
    expect(newKey).toBeDefined();
    if (newKey === undefined) return;
    expect(epochIdOf(newKey)).toBe(r.ring().current.epochId);
    expect(r.ring().byEpoch.size).toBe(2);
    const wPath = r.paths.working;
    r.close();
    opened.splice(0);
    const vault = new ConduitVault(wPath);
    expect(() => vault.unlock(OLD_PASSWORD)).toThrow('Invalid master password');
    vault.unlock(NEW_PASSWORD);
    expect(vault.getEntry(legacy.ids.web).password).toBe('pw-web');
    vault.lock();
    expect(fs.readFileSync(shared).equals(legacy.source.bytes)).toBe(true);
  }, 30_000);
});

describe('performance (13.3)', () => {
  it('captures one mutation in a 5,000-entry vault well within the budget', async () => {
    const bytes = (() => {
      const file = path.join(root, 'big.conduit');
      fs.writeFileSync(file, legacy.source.bytes);
      editInPlace(file, (db: Database.Database) => {
        const insert = db.transaction(() => {
          for (let i = 0; i < 5_000; i++) insertEntry(db, `big-${i}`, `host ${i}`, `10.0.${i % 250}.${i % 200}`);
        });
        insert();
      });
      return fs.readFileSync(file);
    })();
    const d = device({ verifyCommits: false });
    const r = (await open(d, legacy.source.lineageId, legacy.source.key, { kind: 'genesis', sharedBytes: bytes }, null)).replica;
    opened.push(r);
    expect(r.state().genesisId).toBe(genesisIdOf(bytes));
    const h = d.t.workingCopy.last();
    const edit = (n: number) =>
      h.mutate((db) => db.prepare('UPDATE entries SET name = ? WHERE id = ?').run(`renamed ${n}`, 'big-42'), {
        rows: [entryRow('big-42')],
        interactive: true,
      });
    edit(0);
    const times: number[] = [];
    for (let n = 1; n <= 5; n++) {
      const t0 = performance.now();
      edit(n);
      times.push(performance.now() - t0);
    }
    const best = Math.min(...times);
    expect(provisionalOf(r.state(), 'big-42', 'name')?.value).toBe('renamed 5');
    expect(best).toBeLessThan(50);
  }, 60_000);
});
