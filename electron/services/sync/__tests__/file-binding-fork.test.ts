// @vitest-environment node
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConduitVault } from '../../vault/vault.js';
import { forkAsSeparateVault } from '../file-binding.js';
import { createSharedFile } from '../shared-file.js';
import { loadFile } from '../state-store.js';
import { SyncCoreError } from '../types.js';
import { SimDevice } from './core-e2e-harness.js';
import { publishFile } from './core-e2e-io.js';
import { OLD_PASSWORD, comparableContent, createLegacyVault, decryptAllSecrets, type LegacyFixture } from './core-e2e-fixtures.js';
import { makeTempRoot, makeTestSyncHost, type TestSyncHost } from './host-fakes.js';
import { sha256File } from './file-binding-fixtures.js';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let worldRoot: string;
let legacy: LegacyFixture;
let device: SimDevice;

beforeAll(() => {
  worldRoot = makeTempRoot('fork-world');
  fs.mkdirSync(path.join(worldRoot, 'legacy'));
  legacy = createLegacyVault(path.join(worldRoot, 'legacy'));
  device = new SimDevice({ name: 'A', root: worldRoot, source: legacy.source, now: () => Date.now() });
  device.edit((v) => {
    v.updateEntry(legacy.ids.web, { name: 'web (renamed on A)', notes: 'edited after genesis' });
    v.deleteEntry(legacy.ids.desk);
  });
}, 30_000);

afterAll(() => {
  device.close();
  fs.rmSync(worldRoot, { recursive: true, force: true });
});

function metaValue(db: Database.Database, key: string): string | undefined {
  return (db.prepare('SELECT value FROM vault_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
}

describe('forkAsSeparateVault (5.9, 12 row 20)', () => {
  let root: string;
  let t: TestSyncHost;
  let source: string;
  let workDir: string;
  let targetDir: string;

  beforeEach(() => {
    root = makeTempRoot('fork');
    t = makeTestSyncHost(root);
    fs.mkdirSync(path.join(root, 'share'));
    source = path.join(root, 'share', 'Vault.conduit');
    publishFile(device.db, source);
    workDir = path.join(root, 'lineage', 'tmp');
    targetDir = path.join(root, 'elsewhere');
    fs.mkdirSync(targetDir);
  });

  afterEach(() => {
    expect(t.logger.unprefixed()).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes a new file with a new lineage, genesis and vault_id, the same content, and leaves the source untouched', async () => {
    const sourceSha = sha256File(source);
    const sourceDb = new Database(source, { readonly: true });
    const sourceContent = comparableContent(sourceDb);
    const sourceVaultId = metaValue(sourceDb, 'vault_id');
    const sourceGenesis = loadFile(sourceDb).state.genesisId;
    sourceDb.close();

    const target = path.join(targetDir, 'Separate Vault.conduit');
    const res = await forkAsSeparateVault({ sourcePath: source, key: legacy.source.key, targetPath: target, workDir }, t.host);
    expect(fs.readdirSync(targetDir)).toEqual(['Separate Vault.conduit']);

    expect(res.path).toBe(target);
    expect(res.lineageId).toMatch(UUID_V4_RE);
    expect(res.lineageId).not.toBe(legacy.source.lineageId);
    expect(res.genesisId).toMatch(/^[0-9a-f]{64}$/);
    expect(res.genesisId).not.toBe(sourceGenesis);
    expect(res.vaultId).toMatch(UUID_V4_RE);
    expect(res.vaultId).not.toBe(sourceVaultId);

    // A read-only connection cannot remove the -wal/-shm a WAL-mode file needs, so inspect a copy.
    const inspected = path.join(workDir, 'inspect.conduit');
    fs.copyFileSync(target, inspected);
    const forkDb = new Database(inspected, { readonly: true });
    const loaded = loadFile(forkDb);
    expect(loaded.state.lineageId).toBe(res.lineageId);
    expect(loaded.state.genesisId).toBe(res.genesisId);
    expect(loaded.state.devs.size).toBe(0);
    expect(metaValue(forkDb, 'vault_id')).toBe(res.vaultId);
    expect(metaValue(forkDb, 'sync_format')).toBe('1');
    const forkContent = comparableContent(forkDb) as { meta: Record<string, string> };
    const expected = sourceContent as { meta: Record<string, string> };
    expect({ ...forkContent, meta: undefined }).toEqual({ ...expected, meta: undefined });
    expect(forkContent.meta.salt).toBe(expected.meta.salt);
    expect(forkContent.meta.verification).toBe(expected.meta.verification);
    expect(decryptAllSecrets(forkDb, legacy.source.key).size).toBeGreaterThan(0);
    forkDb.close();

    expect([...fs.readFileSync(target).subarray(18, 20)]).toEqual([2, 2]);
    expect(sha256File(source)).toBe(sourceSha);
    expect(fs.readdirSync(path.join(root, 'share'))).toEqual(['Vault.conduit']);
    fs.rmSync(inspected);
    expect(fs.readdirSync(workDir).filter((n) => !n.startsWith('inspect.conduit'))).toEqual([]);

    const cls = createSharedFile(t.host).classify(
      { path: target, bytes: fs.readFileSync(target), sha256: sha256File(target), stat: (await t.host.fs.stat(target))!, stagedPath: target },
      { lineageId: null },
    );
    expect(cls.kind === 'synced' && cls.file.state.lineageId).toBe(res.lineageId);
  });

  it('opens with the same master password', async () => {
    const target = path.join(targetDir, 'Separate.conduit');
    await forkAsSeparateVault({ sourcePath: source, key: legacy.source.key, targetPath: target, workDir }, t.host);
    const probe = path.join(root, 'probe.conduit');
    fs.copyFileSync(target, probe);
    const vault = new ConduitVault(probe);
    vault.unlock(OLD_PASSWORD);
    expect(vault.isUnlocked()).toBe(true);
    const names = vault.listEntries().map((e: { name: string }) => e.name);
    expect(names).toContain('web (renamed on A)');
    vault.lock();
  });

  it('forks a pre-sync backup too (restore as a new vault)', async () => {
    const backup = path.join(root, 'backup.conduit');
    fs.writeFileSync(backup, legacy.source.bytes);
    const target = path.join(targetDir, 'Restored.conduit');
    const res = await forkAsSeparateVault({ sourcePath: backup, key: legacy.source.key, targetPath: target, workDir }, t.host);
    const db = new Database(target, { readonly: true });
    expect(loadFile(db).state.lineageId).toBe(res.lineageId);
    db.close();
    expect(Buffer.compare(fs.readFileSync(backup), legacy.source.bytes)).toBe(0);
  });

  it('never overwrites an existing target', async () => {
    const target = path.join(targetDir, 'Taken.conduit');
    fs.writeFileSync(target, 'keep me');
    await expect(forkAsSeparateVault({ sourcePath: source, key: legacy.source.key, targetPath: target, workDir }, t.host)).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(fs.readFileSync(target, 'utf8')).toBe('keep me');
    expect(fs.readdirSync(targetDir)).toEqual(['Taken.conduit']);
  });

  it('refuses a key that does not open the source and leaves nothing behind', async () => {
    const target = path.join(targetDir, 'Wrong.conduit');
    const err = await forkAsSeparateVault({ sourcePath: source, key: crypto.randomBytes(32), targetPath: target, workDir }, t.host).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncCoreError);
    expect((err as SyncCoreError).code).toBe('KEY_MISMATCH');
    expect(fs.readdirSync(targetDir)).toEqual([]);
    expect(fs.readdirSync(workDir)).toEqual([]);
    expect(t.logger.messages('error').some((m) => m.startsWith('[sync] fork'))).toBe(true);
  });

  it('removes its temp file when the final rename fails', async () => {
    const target = path.join(targetDir, 'Fails.conduit');
    t.fs.inject({ op: 'rename', match: /\.tmp$/, code: 'EIO' });
    await expect(forkAsSeparateVault({ sourcePath: source, key: legacy.source.key, targetPath: target, workDir }, t.host)).rejects.toMatchObject({
      code: 'EIO',
    });
    expect(fs.readdirSync(targetDir)).toEqual([]);
  });
});
