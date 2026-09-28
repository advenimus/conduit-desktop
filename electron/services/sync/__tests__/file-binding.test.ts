// @vitest-environment node
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  FILE_NAME_MAX_LEN,
  FileBindingTracker,
  LOCATION_MAX_LEN,
  MISSING_DEBOUNCE_MS,
  fileHintOf,
  findSameLineageFiles,
  locationOf,
  newBinding,
  providerKindOf,
  type FileBindingDeps,
} from '../file-binding.js';
import { createSharedFile } from '../shared-file.js';
import type { FileBinding } from '../types.js';
import { SimDevice } from './core-e2e-harness.js';
import { createLegacyVault, type LegacyFixture } from './core-e2e-fixtures.js';
import { makeTempRoot, makeTestSyncHost, type TestSyncHost } from './host-fakes.js';
import { DEVICE_UUID, LocalReplica } from './file-binding-fixtures.js';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const never = (): boolean => false;
const always = (): boolean => true;

describe('providerKindOf', () => {
  const darwin: Array<[string, string]> = [
    ['/Users/c/Library/Mobile Documents/com~apple~CloudDocs/Vault.conduit', 'icloud'],
    ['/Users/c/Library/Mobile Documents/com~apple~CloudDocs/Work/Vault.conduit', 'icloud'],
    ['/Users/c/Library/CloudStorage/OneDrive-Personal/Vault.conduit', 'onedrive'],
    ['/Users/c/OneDrive - Contoso/Vault.conduit', 'onedrive'],
    ['/Users/c/Library/CloudStorage/Dropbox/Vault.conduit', 'dropbox'],
    ['/Users/c/Library/CloudStorage/Dropbox-Personal/Vault.conduit', 'dropbox'],
    ['/Users/c/Dropbox/Work/Vault.conduit', 'dropbox'],
    ['/Users/c/Dropbox (Acme)/Vault.conduit', 'dropbox'],
    ['/Users/c/Library/CloudStorage/GoogleDrive-c@example.com/My Drive/Vault.conduit', 'gdrive'],
    ['/Users/c/Google Drive/Vault.conduit', 'gdrive'],
    ['/Users/c/Library/CloudStorage/Box-Box/Vault.conduit', 'box'],
    ['/Users/c/Box Sync/Vault.conduit', 'box'],
    ['/Users/c/Box/Vault.conduit', 'box'],
    ['/users/c/dropbox/Vault.conduit', 'dropbox'],
    ['/Users/c/Documents/Vault.conduit', 'local'],
    ['/Users/c/Documents/Dropbox.conduit', 'local'],
  ];
  it.each(darwin)('darwin %s -> %s', (p, kind) => {
    expect(providerKindOf(p, 'darwin', never)).toBe(kind);
  });

  const win32: Array<[string, string]> = [
    ['C:\\Users\\c\\OneDrive - Contoso\\Vault.conduit', 'onedrive'],
    ['C:\\Users\\c\\OneDrive\\Documents\\Vault.conduit', 'onedrive'],
    ['C:\\Users\\c\\iCloudDrive\\Vault.conduit', 'icloud'],
    ['C:\\Users\\c\\iCloud Drive\\Vault.conduit', 'icloud'],
    ['C:\\Users\\c\\Dropbox\\Vault.conduit', 'dropbox'],
    ['C:\\Users\\c\\dropbox\\Vault.conduit', 'dropbox'],
    ['C:\\Users\\c\\Google Drive\\Vault.conduit', 'gdrive'],
    ['C:\\Users\\c\\Box\\Vault.conduit', 'box'],
    ['\\\\nas\\home\\Vault.conduit', 'smb'],
    ['//nas/home/Vault.conduit', 'smb'],
    ['C:\\Users\\c\\Documents\\Vault.conduit', 'local'],
  ];
  it.each(win32)('win32 %s -> %s', (p, kind) => {
    expect(providerKindOf(p, 'win32', never)).toBe(kind);
  });

  it('uses isNetworkPath for /Volumes mounts and other network paths', () => {
    expect(providerKindOf('/Volumes/share/Vault.conduit', 'darwin', always)).toBe('smb');
    expect(providerKindOf('/Volumes/share/Vault.conduit', 'darwin', never)).toBe('local');
    expect(providerKindOf('/mnt/nas/Vault.conduit', 'linux', always)).toBe('other');
    expect(providerKindOf('Z:\\x\\Vault.conduit', 'win32', always)).toBe('other');
    expect(providerKindOf('/Users/c/Library/CloudStorage/Dropbox/Vault.conduit', 'darwin', always)).toBe('dropbox');
  });

  it('folds case only on win32 and darwin', () => {
    expect(providerKindOf('/home/c/dropbox/Vault.conduit', 'linux', never)).toBe('local');
    expect(providerKindOf('/home/c/Dropbox/Vault.conduit', 'linux', never)).toBe('dropbox');
  });
});

describe('locationOf and fileHintOf', () => {
  it('is <kind>:<parent folder>', () => {
    expect(locationOf('/Users/c/Dropbox/Work/Vault.conduit', 'darwin', never)).toBe('dropbox:Work');
    expect(locationOf('\\\\nas\\home\\Vault.conduit', 'win32', never)).toBe('smb:home');
    expect(locationOf('C:\\Users\\c\\OneDrive\\Vault.conduit', 'win32', never)).toBe('onedrive:OneDrive');
  });

  it('truncates to the column limits in code points', () => {
    const longParent = '\u{1F510}'.repeat(200);
    const loc = locationOf(`/Users/c/${longParent}/Vault.conduit`, 'darwin', never);
    expect(Array.from(loc)).toHaveLength(LOCATION_MAX_LEN);
    expect(loc.startsWith('local:')).toBe(true);
    const name = `${'v'.repeat(300)}.conduit`;
    const b: FileBinding = { sharedPath: `/x/${name}`, realpath: `/x/${name}`, fileId: 'f' };
    const hint = fileHintOf(b, 'linux', never);
    expect(hint.file_name).toHaveLength(FILE_NAME_MAX_LEN);
    expect(hint).toMatchObject({ file_id: 'f', location: 'local:x' });
  });

  it('names the realpath, not a symlinked shared path', () => {
    const b: FileBinding = { sharedPath: '/data/default.conduit', realpath: '/Users/c/Dropbox/Vault.conduit', fileId: 'f' };
    expect(fileHintOf(b, 'darwin', never)).toEqual({ file_id: 'f', location: 'dropbox:Dropbox', file_name: 'Vault.conduit' });
  });
});

// ---------- Tracker over real files ----------

let worldRoot: string;
let legacy: LegacyFixture;
let syncedBytes: Buffer;
let otherLineageBytes: Buffer;

function writeSynced(p: string, fileId: string | null = null): void {
  fs.writeFileSync(p, syncedBytes);
  if (fileId === null) return;
  const db = new Database(p);
  db.prepare("INSERT OR REPLACE INTO sync_state(key, value) VALUES ('file_id', ?)").run(fileId);
  db.close();
}

beforeAll(() => {
  worldRoot = makeTempRoot('file-binding-world');
  fs.mkdirSync(path.join(worldRoot, 'legacy'));
  fs.mkdirSync(path.join(worldRoot, 'other'));
  legacy = createLegacyVault(path.join(worldRoot, 'legacy'));
  otherLineageBytes = createLegacyVault(path.join(worldRoot, 'other')).source.bytes;
  const a = new SimDevice({ name: 'A', root: worldRoot, source: legacy.source, now: () => Date.now() });
  const published = path.join(worldRoot, 'published.conduit');
  a.publish(published);
  a.close();
  syncedBytes = fs.readFileSync(published);
}, 30_000);

afterAll(() => {
  fs.rmSync(worldRoot, { recursive: true, force: true });
});

describe('FileBindingTracker', () => {
  let root: string;
  let t: TestSyncHost;
  let share: string;
  let S: string;
  let replica: LocalReplica;
  let tracker: FileBindingTracker;
  let changes: FileBinding[];

  beforeEach(async () => {
    root = makeTempRoot('file-binding');
    t = makeTestSyncHost(root);
    share = path.join(root, 'share');
    fs.mkdirSync(share);
    S = path.join(share, 'Vault.conduit');
    writeSynced(S);
    const binding = await newBinding(S, t.host);
    replica = new LocalReplica(root, legacy.source.lineageId, DEVICE_UUID, binding);
    const deps: FileBindingDeps = { replica, shared: createSharedFile(t.host), host: t.host };
    tracker = new FileBindingTracker(deps);
    changes = [];
    tracker.onChange((b) => changes.push(b));
  });

  afterEach(() => {
    expect(t.logger.unprefixed()).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('newBinding resolves the realpath (also for a file that does not exist yet) and mints a v4 file_id', async () => {
    const b = await newBinding(S, t.host);
    expect(b).toMatchObject({ sharedPath: S, realpath: fs.realpathSync(S) });
    expect(b.fileId).toMatch(UUID_V4_RE);
    const fresh = await newBinding(path.join(share, 'New.conduit'), t.host);
    expect(fresh.realpath).toBe(path.join(fs.realpathSync(share), 'New.conduit'));
  });

  it('reads and writes S through the realpath', () => {
    expect(tracker.sharedPath()).toBe(fs.realpathSync(S));
    expect(tracker.fileHint()).toEqual({ file_id: tracker.binding().fileId, location: 'local:share', file_name: 'Vault.conduit' });
  });

  describe('ensureFileId (3.1)', () => {
    it('adopts S file_id, keeps its own when S has none, and writes only on change', () => {
      const minted = tracker.binding().fileId;
      expect(tracker.ensureFileId(null, false).fileId).toBe(minted);
      expect(replica.writes).toBe(0);
      const theirs = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
      expect(tracker.ensureFileId(theirs, false).fileId).toBe(theirs);
      expect(replica.writes).toBe(1);
      expect(tracker.ensureFileId(theirs, false).fileId).toBe(theirs);
      expect(replica.writes).toBe(1);
      expect((replica.onDisk() as { binding: FileBinding }).binding.fileId).toBe(theirs);
      expect(changes.map((c) => c.fileId)).toEqual([theirs]);
    });

    it('mints a new id when the same file_id is seen at another path', () => {
      const current = tracker.binding().fileId;
      const next = tracker.ensureFileId(current, true);
      expect(next.fileId).not.toBe(current);
      expect(next.fileId).toMatch(UUID_V4_RE);
      expect(tracker.ensureFileId(current, true).fileId).toBe(next.fileId);
      const other = '0f0f0f0f-1e1e-4d2d-8c3c-4b4b4b4b4b4b';
      expect(tracker.ensureFileId(other, true).fileId).toBe(next.fileId);
    });
  });

  it('debounces a missing file for 30 s and resets when it is present again', async () => {
    const t0 = t.clock.now();
    expect(tracker.observeMissing(t0)).toEqual({ kind: 'waiting', sinceMs: t0 });
    await t.clock.advance(MISSING_DEBOUNCE_MS - 1);
    expect(tracker.observeMissing(t.clock.now())).toEqual({ kind: 'waiting', sinceMs: t0 });
    await t.clock.advance(1);
    expect(tracker.observeMissing(t.clock.now())).toEqual({ kind: 'missing', sinceMs: t0 });
    tracker.observePresent();
    expect(tracker.observeMissing(t.clock.now())).toEqual({ kind: 'waiting', sinceMs: t.clock.now() });
  });

  it('never rebinds to a conflict name during the OneDrive rename dance (12 row 58)', async () => {
    const before = tracker.binding();
    fs.renameSync(S, path.join(share, 'Vault-PC1.conduit'));
    const res = await tracker.resolveMissing();
    expect(res).toEqual({ kind: 'prompt', sameLineage: [path.join(share, 'Vault-PC1.conduit')] });
    expect(tracker.binding()).toEqual(before);
    writeSynced(S);
    expect(await tracker.resolveMissing()).toEqual({ kind: 'back' });
    expect(tracker.binding()).toEqual(before);
    expect(changes).toEqual([]);
  });

  it('rebinds to the one same-lineage file with a normal name, keeps the file_id, and undoes (12 row 19)', async () => {
    const before = tracker.binding();
    fs.writeFileSync(path.join(share, 'Notes.conduit'), 'not a vault at all');
    fs.writeFileSync(path.join(share, 'Other.conduit'), otherLineageBytes);
    fs.renameSync(S, path.join(share, 'Work Vault.conduit'));
    const res = await tracker.resolveMissing();
    const moved = fs.realpathSync(path.join(share, 'Work Vault.conduit'));
    expect(res).toEqual({ kind: 'rebound', from: before.realpath, to: moved });
    expect(tracker.binding()).toEqual({ sharedPath: path.join(share, 'Work Vault.conduit'), realpath: moved, fileId: before.fileId });
    expect((replica.onDisk() as { binding: FileBinding }).binding.realpath).toBe(moved);
    expect(changes.map((c) => c.realpath)).toEqual([moved]);
    expect(fs.existsSync(S)).toBe(false);

    expect(await tracker.undoRebind()).toBe(true);
    expect(tracker.binding()).toEqual(before);
    expect(await tracker.undoRebind()).toBe(false);
    const again = await tracker.resolveMissing();
    expect(again).toEqual({ kind: 'prompt', sameLineage: [path.join(share, 'Work Vault.conduit')] });
    expect(fs.existsSync(S)).toBe(false);
  });

  it('allows "<stem> 2" and "<stem> (1)" as user renames but asks when there are two candidates', async () => {
    fs.renameSync(S, path.join(share, 'Vault 2.conduit'));
    const one = await tracker.resolveMissing();
    expect(one.kind).toBe('rebound');
    await tracker.undoRebind();
    const tracker2 = new FileBindingTracker({ replica, shared: createSharedFile(t.host), host: t.host });
    writeSynced(path.join(share, 'Vault (1).conduit'));
    const two = await tracker2.resolveMissing();
    expect(two).toEqual({ kind: 'prompt', sameLineage: [path.join(share, 'Vault (1).conduit'), path.join(share, 'Vault 2.conduit')] });
  });

  it('counts pre-sync files of the lineage (salt) and skips publish temps, but never rebinds to one (3.1)', async () => {
    const before = tracker.binding();
    fs.rmSync(S);
    const legacyCopy = path.join(share, 'Vault backup.conduit');
    fs.writeFileSync(legacyCopy, legacy.source.bytes);
    fs.writeFileSync(path.join(share, '.~Vault.conduit.abc123.tmp'), syncedBytes);
    const found = await findSameLineageFiles(share, legacy.source.lineageId, null, { replica, shared: createSharedFile(t.host), host: t.host });
    expect(found).toEqual([legacyCopy]);
    expect(await tracker.resolveMissing()).toEqual({ kind: 'prompt', sameLineage: [legacyCopy] });
    expect(tracker.binding()).toEqual(before);
    expect(changes).toEqual([]);
    expect(fs.readFileSync(legacyCopy).equals(legacy.source.bytes)).toBe(true);
  });

  it('asks instead of rebinding when a synced match sits next to a pre-sync one', async () => {
    fs.renameSync(S, path.join(share, 'Work Vault.conduit'));
    fs.writeFileSync(path.join(share, 'Vault backup.conduit'), legacy.source.bytes);
    const res = await tracker.resolveMissing();
    expect(res).toEqual({ kind: 'prompt', sameLineage: [path.join(share, 'Vault backup.conduit'), path.join(share, 'Work Vault.conduit')] });
  });

  it('prompts with nothing when the folder itself is gone', async () => {
    fs.rmSync(share, { recursive: true });
    expect(await tracker.resolveMissing()).toEqual({ kind: 'prompt', sameLineage: [] });
  });

  describe('locate', () => {
    it('refuses a file of another vault (12 row 52), a non-vault and an unreadable file', async () => {
      const before = tracker.binding();
      const other = path.join(share, 'Other.conduit');
      fs.writeFileSync(other, otherLineageBytes);
      const res = await tracker.locate(other);
      expect(res.kind).toBe('other-lineage');
      expect(res.kind === 'other-lineage' && res.lineageId).not.toBe(legacy.source.lineageId);
      const plain = path.join(share, 'plain.conduit');
      const db = new Database(plain);
      db.exec('CREATE TABLE x (a)');
      db.close();
      expect(await tracker.locate(plain)).toEqual({ kind: 'other-lineage', lineageId: null });
      const torn = path.join(share, 'torn.conduit');
      fs.writeFileSync(torn, syncedBytes.subarray(0, 1000));
      expect(await tracker.locate(torn)).toEqual({ kind: 'unreadable' });
      expect(await tracker.locate(path.join(share, 'missing.conduit'))).toEqual({ kind: 'unreadable' });
      expect(tracker.binding()).toEqual(before);
    });

    it('binds a moved file and adopts its file_id', async () => {
      const dest = path.join(root, 'moved', 'Vault.conduit');
      fs.mkdirSync(path.dirname(dest));
      const theirs = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
      writeSynced(dest, theirs);
      fs.rmSync(S);
      const res = await tracker.locate(dest);
      expect(res).toEqual({ kind: 'bound', binding: { sharedPath: dest, realpath: fs.realpathSync(dest), fileId: theirs } });
      expect(tracker.binding().fileId).toBe(theirs);
      expect(changes).toHaveLength(1);
    });

    it('gives a copy its own file_id while the old path still holds the vault', async () => {
      const before = tracker.binding();
      const copy = path.join(share, 'Vault copy.conduit');
      writeSynced(copy, before.fileId);
      const res = await tracker.locate(copy);
      expect(res.kind).toBe('bound');
      const fileId = res.kind === 'bound' ? res.binding.fileId : '';
      expect(fileId).not.toBe(before.fileId);
      expect(fileId).toMatch(UUID_V4_RE);
      const saved = path.join(share, 'Saved here.conduit');
      const own = 'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb';
      writeSynced(saved, own);
      const res2 = await tracker.locate(saved);
      expect(res2.kind === 'bound' && res2.binding.fileId).toBe(own);
    });

    it('binds a pre-sync file whose salt gives this lineage and keeps the file_id', async () => {
      const before = tracker.binding();
      const pre = path.join(root, 'Restored.conduit');
      fs.writeFileSync(pre, legacy.source.bytes);
      fs.rmSync(S);
      const res = await tracker.locate(pre);
      expect(res).toEqual({ kind: 'bound', binding: { sharedPath: pre, realpath: fs.realpathSync(pre), fileId: before.fileId } });
    });
  });

  describe('renameShared', () => {
    it('renames S only and updates the binding', async () => {
      fs.writeFileSync(`${S}-shm`, 'shm');
      const before = tracker.binding();
      const next = await tracker.renameShared('Team Vault.conduit');
      const target = path.join(fs.realpathSync(share), 'Team Vault.conduit');
      expect(next).toEqual({ sharedPath: target, realpath: target, fileId: before.fileId });
      expect(fs.existsSync(target)).toBe(true);
      expect(fs.existsSync(S)).toBe(false);
      expect(fs.existsSync(`${S}-shm`)).toBe(true);
      expect(changes).toEqual([next]);
    });

    it('refuses an existing target and names that are not plain', async () => {
      fs.writeFileSync(path.join(share, 'Taken.conduit'), 'x');
      await expect(tracker.renameShared('Taken.conduit')).rejects.toMatchObject({ code: 'EEXIST' });
      await expect(tracker.renameShared('../escape.conduit')).rejects.toThrow('[sync]');
      await expect(tracker.renameShared('')).rejects.toThrow('[sync]');
      expect(fs.existsSync(S)).toBe(true);
    });
  });

  it('throws a prefixed error when the lineage has no binding', () => {
    replica.updateLocal((l) => ({ ...l, binding: null }));
    expect(() => tracker.binding()).toThrow('[sync]');
  });
});
