// @vitest-environment node
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { digestState } from '../digest.js';
import { genesisFromContent } from '../genesis.js';
import { deriveEpochKeys } from '../hashing.js';
import { lineagePaths } from '../paths.js';
import {
  GENESIS_BASELINE_KEEP_MS,
  findBoundLineage,
  hasWorkingCopy,
  readPendingSummaries,
  type ReplicaPort,
} from '../replica.js';
import { ensureSyncSchema } from '../schema.js';
import { publishIfUnchanged, vacuumInto } from '../shared-file.js';
import { StateBuilder, rowLife } from '../state-view.js';
import { loadContent, loadFile } from '../state-store.js';
import { TBL } from '../types.js';
import { createLegacyVault, type LegacyFixture } from './core-e2e-fixtures.js';
import { makeTempRoot } from './host-fakes.js';
import { bindingFor, editInPlace, makeDevice, newVaultSeed, open, provisionalOf, sha256, type TestDevice } from './replica-fixtures.js';
import { sideFilesNextTo } from './shared-file-fixtures.js';

let fixtureDir: string;
let legacy: LegacyFixture;

beforeAll(() => {
  fixtureDir = makeTempRoot('replica-fixture');
  legacy = createLegacyVault(fixtureDir);
});

afterAll(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

let root: string;
let sharedPath: string;
const opened: ReplicaPort[] = [];
const devices: TestDevice[] = [];

beforeEach(() => {
  root = makeTempRoot('replica-open');
  fs.mkdirSync(path.join(root, 'cloud'));
  sharedPath = path.join(root, 'cloud', 'Vault.conduit');
});

afterEach(() => {
  for (const r of opened.splice(0)) r.close();
  for (const d of devices.splice(0)) expect(d.t.logger.unprefixed()).toEqual([]);
  fs.rmSync(root, { recursive: true, force: true });
});

function device(hw8 = 'aaaaaaaa'): TestDevice {
  const d = makeDevice(root, { hw8 });
  devices.push(d);
  return d;
}

function track(r: ReplicaPort): ReplicaPort {
  opened.push(r);
  return r;
}

function lineage(): string {
  return legacy.source.lineageId;
}

async function genesisOpen(d: TestDevice): Promise<ReplicaPort> {
  fs.writeFileSync(sharedPath, legacy.source.bytes);
  const res = await open(d, lineage(), legacy.source.key, { kind: 'genesis', sharedBytes: legacy.source.bytes }, bindingFor(sharedPath));
  return track(res.replica);
}

function expectedGenesisDigest(dev: number, deviceUuid: string, startedMs: number): string {
  const probe = path.join(root, 'probe.conduit');
  fs.writeFileSync(probe, legacy.source.bytes);
  const db = new Database(probe);
  ensureSyncSchema(db);
  const content = loadContent(db);
  db.close();
  const k0 = deriveEpochKeys(legacy.source.key, lineage());
  const g = genesisFromContent({ content, genesisId: legacy.source.genesisId, lineageId: lineage(), k0 });
  const b = new StateBuilder(g.state);
  b.addDev({ dev, deviceUuid, startedMs });
  return digestState(b.build());
}

describe('openReplica: G1 genesis', () => {
  it('equals the harness genesis, keeps genesis.conduit, and never touches S', async () => {
    const d = device();
    fs.writeFileSync(sharedPath, legacy.source.bytes);
    const res = await open(d, lineage(), legacy.source.key, { kind: 'genesis', sharedBytes: legacy.source.bytes }, bindingFor(sharedPath));
    const r = track(res.replica);
    expect(res.created).toBe(true);
    expect(res.seeded).toBe('genesis');
    expect(digestState(r.state())).toBe(expectedGenesisDigest(r.dev(), d.deviceUuid, d.t.clock.now()));
    const paths = lineagePaths(d.machineDir, lineage());
    expect(fs.readFileSync(paths.genesis).equals(legacy.source.bytes)).toBe(true);
    expect(r.paths.working).toBe(paths.working);
    expect(r.paths.working).not.toBe(sharedPath);
    expect(r.epochAligned()).toBe(true);
    expect(d.t.workingCopy.last().hooks).not.toBeNull();
    expect(r.local()).toMatchObject({ pendingPublish: true, dev: r.dev(), incarnation: r.incarnation() });
    expect(r.local().binding?.sharedPath).toBe(sharedPath);
    expect(fs.readFileSync(sharedPath).equals(legacy.source.bytes)).toBe(true);
    expect(sideFilesNextTo(sharedPath)).toEqual([]);
  });

  it('refuses a binding that points at W or into its lineage folder', async () => {
    const d = device();
    const paths = lineagePaths(d.machineDir, lineage());
    const seed = { kind: 'genesis', sharedBytes: legacy.source.bytes } as const;
    await expect(open(d, lineage(), legacy.source.key, seed, bindingFor(paths.working))).rejects.toThrow(/\[sync\] the shared file cannot be/);
    await expect(open(d, lineage(), legacy.source.key, seed, bindingFor(path.join(paths.dir, 'incoming', 'x.conduit')))).rejects.toThrow(
      /\[sync\] the shared file cannot be/,
    );
    expect(fs.existsSync(paths.working)).toBe(false);
  });

  it('refuses a seed that does not match whether W exists, and a wrong key', async () => {
    const d = device();
    await expect(open(d, lineage(), legacy.source.key, { kind: 'existing' }, null)).rejects.toThrow(/no working copy/);
    const wrongKey = crypto.randomBytes(32);
    await expect(open(d, lineage(), wrongKey, { kind: 'genesis', sharedBytes: legacy.source.bytes }, null)).rejects.toMatchObject({
      code: 'KEY_MISMATCH',
    });
    expect(fs.existsSync(lineagePaths(d.machineDir, lineage()).working)).toBe(false);
    const r = await genesisOpen(d);
    r.close();
    await expect(open(d, lineage(), legacy.source.key, { kind: 'genesis', sharedBytes: legacy.source.bytes }, null)).rejects.toThrow(
      /already exists/,
    );
  });

  it('replaces a genesis.conduit left by an earlier working copy', async () => {
    const d = device();
    const paths = lineagePaths(d.machineDir, lineage());
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.genesis, Buffer.from('older baseline'));
    await genesisOpen(d);
    expect(fs.readFileSync(paths.genesis).equals(legacy.source.bytes)).toBe(true);
  });

  it('removes genesis.conduit once it is older than 180 days', async () => {
    const d = device();
    const r = await genesisOpen(d);
    r.close();
    const genesisFile = lineagePaths(d.machineDir, lineage()).genesis;
    const old = (d.t.clock.now() - GENESIS_BASELINE_KEEP_MS - 60_000) / 1000;
    fs.utimesSync(genesisFile, old, old);
    track((await open(d, lineage(), legacy.source.key, { kind: 'existing' }, null)).replica);
    expect(fs.existsSync(genesisFile)).toBe(false);
  });
});

describe('openReplica: adopt a synced S', () => {
  async function publishedByA(): Promise<void> {
    const a = device('aaaaaaaa');
    const ra = await genesisOpen(a);
    const snapshot = path.join(ra.paths.tmp, 'publish.conduit');
    vacuumInto(ra.database(), snapshot, a.t.logger);
    const before = fs.readFileSync(sharedPath);
    const res = await publishIfUnchanged(
      { sharedPath, snapshotPath: snapshot, expectedSha256: sha256(before), observedMtimeMs: fs.statSync(sharedPath).mtimeMs },
      a.t.host,
    );
    expect(res.kind).toBe('published');
  }

  function adoptSeed(holdLegacy: boolean) {
    const bytes = fs.readFileSync(sharedPath);
    return { kind: 'adopt', sharedBytes: bytes, sharedSha256: sha256(bytes), sharedMtimeMs: fs.statSync(sharedPath).mtimeMs, holdLegacy } as const;
  }

  it('absorbs a legacy edit made in place as a pseudo sibling, not an app dot', async () => {
    await publishedByA();
    editInPlace(sharedPath, (db) =>
      db.prepare("UPDATE entries SET host = '10.9.9.9', updated_at = '2026-09-25T13:00:00.000Z' WHERE id = ?").run(legacy.ids.web),
    );
    const b = device('bbbbbbbb');
    const res = await open(b, lineage(), legacy.source.key, adoptSeed(false), bindingFor(sharedPath));
    const r = track(res.replica);
    expect(res.seeded).toBe('adopt');
    const prov = provisionalOf(r.state(), legacy.ids.web, 'host');
    expect(prov).toMatchObject({ dev: 0, value: '10.9.9.9' });
    expect(prov?.ms).toBeGreaterThan(0);
    expect(r.state().rows.size).toBeGreaterThan(0);
    const w = new Database(r.paths.working, { readonly: true });
    const row = w.prepare('SELECT host FROM entries WHERE id = ?').get(legacy.ids.web) as { host: string };
    w.close();
    expect(row.host).toBe('10.9.9.9');
    expect(r.local().pendingPublish).toBe(true);
    expect(sideFilesNextTo(sharedPath)).toEqual([]);
  });

  it('holds a legacy delete while side files are reported (4.3 rule 2)', async () => {
    await publishedByA();
    editInPlace(sharedPath, (db) => db.prepare('DELETE FROM entries WHERE id = ?').run(legacy.ids.desk));
    const b = device('bbbbbbbb');
    const r = track((await open(b, lineage(), legacy.source.key, adoptSeed(true), bindingFor(sharedPath))).replica);
    expect(rowLife(r.state(), { tbl: TBL.entries, rowId: legacy.ids.desk })).toBe('live');
    expect(r.local().heldLegacy.map((h) => h.kind)).toEqual(['delete']);
  });
});

describe('openReplica: new vault and existing', () => {
  it('creates a new vault and reopens it as existing with the same dev in one launch', async () => {
    const d = device();
    const nv = newVaultSeed(d);
    const res = await open(d, nv.lineageId, nv.key, nv.seed, bindingFor(sharedPath));
    const r = res.replica;
    expect(res.created).toBe(true);
    const dev = r.dev();
    expect(r.state().vv.get(dev)).toBeDefined();
    const meta = new Map(
      (r.database().prepare('SELECT key, value FROM vault_meta').all() as Array<{ key: string; value: string }>).map((x) => [x.key, x.value]),
    );
    expect(meta.get('salt')).toBe(nv.seed.kind === 'new-vault' ? nv.seed.salt : null);
    expect(meta.get('vault_id')).toBe(nv.seed.kind === 'new-vault' ? nv.seed.vaultId : null);
    expect(meta.get('sync_format')).toBe('1');
    const digest = digestState(r.state());
    r.close();
    const again = track((await open(d, nv.lineageId, nv.key, { kind: 'existing' }, null)).replica);
    expect(again.dev()).toBe(dev);
    expect(digestState(again.state())).toBe(digest);
    expect(again.local().binding?.sharedPath).toBe(sharedPath);
    expect(fs.existsSync(sharedPath)).toBe(false);
  });

  it('parks a corrupt local.json and rebuilds it', async () => {
    const d = device();
    const r = await genesisOpen(d);
    const lineageDir = r.paths.dir;
    r.close();
    opened.splice(0);
    fs.writeFileSync(path.join(lineageDir, 'local.json'), '{"version": 1, "broken": ');
    const b = bindingFor(sharedPath);
    const res = await open(d, lineage(), legacy.source.key, { kind: 'existing' }, b);
    track(res.replica);
    expect(res.localRebuilt).toBe(true);
    expect(fs.readdirSync(path.join(lineageDir, 'parked')).some((n) => n.startsWith('local-'))).toBe(true);
    const disk = JSON.parse(fs.readFileSync(path.join(lineageDir, 'local.json'), 'utf8'));
    expect(disk).toMatchObject({ lineageId: lineage(), pendingPublish: true, binding: b });
  });

  it('uses DELETE journal mode when the sync root is on a network path', async () => {
    const d = device();
    d.t.knobs.networkPrefixes.push(fs.realpathSync(root));
    const nv = newVaultSeed(d);
    const r = track((await open(d, nv.lineageId, nv.key, nv.seed, null)).replica);
    expect(r.journalMode).toBe('delete');
    expect(r.database().pragma('journal_mode', { simple: true })).toBe('delete');
  });
});

describe('machine folder scans', () => {
  it('finds the bound lineage, W presence and pending summaries without touching bad files', async () => {
    const d = device();
    const r = await genesisOpen(d);
    const bogusDir = path.join(d.machineDir, 'not-a-lineage');
    fs.mkdirSync(bogusDir);
    fs.writeFileSync(path.join(bogusDir, 'local.json'), 'garbage');
    expect(await findBoundLineage(d.machineDir, sharedPath, d.deps)).toBe(lineage());
    if (process.platform === 'darwin') expect(await findBoundLineage(d.machineDir, sharedPath.toUpperCase(), d.deps)).toBe(lineage());
    expect(await findBoundLineage(d.machineDir, path.join(root, 'elsewhere.conduit'), d.deps)).toBeNull();
    expect(await hasWorkingCopy(d.machineDir, lineage(), d.deps)).toBe(true);
    expect(await hasWorkingCopy(d.machineDir, crypto.randomUUID(), d.deps)).toBe(false);
    expect(await hasWorkingCopy(d.machineDir, '../escape', d.deps)).toBe(false);
    expect(await readPendingSummaries(d.machineDir, d.deps)).toEqual([{ lineageId: lineage(), sharedPath, pendingPublish: true }]);
    expect(fs.readFileSync(path.join(bogusDir, 'local.json'), 'utf8')).toBe('garbage');
    expect(await readPendingSummaries(path.join(root, 'missing'), d.deps)).toEqual([]);
    expect(r.lineageId).toBe(lineage());
  });

  it('W reloaded from disk carries the lineage it was opened for', async () => {
    const d = device();
    const r = await genesisOpen(d);
    const f = loadFile(r.database());
    expect(f.state.lineageId).toBe(lineage());
    expect(f.state.genesisId).toBe(legacy.source.genesisId);
  });
});
