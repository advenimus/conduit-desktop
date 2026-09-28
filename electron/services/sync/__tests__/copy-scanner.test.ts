// @vitest-environment node
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddFileInput, PendingCandidate } from '../candidate-queue.js';
import { CopyScanner, copyHostNames, isProviderConflictName, type CopyScannerDeps, type ScannedCopy } from '../copy-scanner.js';
import { isConflictLikeName, stemOf } from '../file-binding.js';
import { genesisIdOf } from '../hashing.js';
import { createSharedFile } from '../shared-file.js';
import { SnapshotStore } from '../snapshots.js';
import { provisionalValue } from '../state-view.js';
import { regKey } from '../catalog.js';
import type { SessionRowView, TransientNotice } from '../host.js';
import type { FileBinding } from '../types.js';
import { SimDevice } from './core-e2e-harness.js';
import { createLegacyVault, type LegacyFixture } from './core-e2e-fixtures.js';
import { makeTempRoot, makeTestSyncHost, type TestSyncHost } from './host-fakes.js';
import { LocalReplica, dirFingerprint, presenceValue, sha256File, simReplica, writePresence } from './file-binding-fixtures.js';

const DROPBOX = 'Vault (conflicted copy 2026-09-25).conduit';
const DROPBOX_NAMED = "Vault (Chris's conflicted copy 2026-09-25).conduit";
const SYNCTHING = 'Vault.sync-conflict-20260925-120000-ABCDEFG.conduit';
const ONEDRIVE = 'Vault-DESKTOP-ABC.conduit';

describe('provider conflict patterns (5.8)', () => {
  const hosts = new Set(['DESKTOP-ABC']);
  const matching: Array<[string, string]> = [
    ['Dropbox', DROPBOX],
    ['Dropbox with a name', DROPBOX_NAMED],
    ['Dropbox with a typographic apostrophe', 'Vault (Chris’s conflicted copy 2026-09-25).conduit'],
    ['Dropbox without a date', 'Vault (conflicted copy).conduit'],
    ['Dropbox, other case', 'vault (CONFLICTED COPY 2026-09-25).CONDUIT'],
    ['Syncthing', SYNCTHING],
    ['Syncthing, other case', 'VAULT.SYNC-CONFLICT-20260925-120000-X.conduit'],
    ['OneDrive -HOST', ONEDRIVE],
    ['OneDrive -host in another case', 'Vault-desktop-abc.conduit'],
  ];
  it.each(matching)('%s: %s matches', (_label, name) => {
    expect(isProviderConflictName(name, 'Vault', hosts)).toBe(true);
    expect(isConflictLikeName(name, 'Vault')).toBe(true);
  });

  const notMatching: Array<[string, string, ReadonlySet<string>]> = [
    ['iCloud and Finder "Keep Both" duplicate', 'Vault 2.conduit', hosts],
    ['Google Drive and browser download duplicate', 'Vault (1).conduit', hosts],
    ['Files "Duplicate"', 'Vault copy.conduit', hosts],
    ['OneDrive suffix with an unknown host', 'Vault-LAPTOP-9.conduit', hosts],
    ['OneDrive suffix with no presence at all', ONEDRIVE, new Set<string>()],
    ['the vault itself', 'Vault.conduit', hosts],
    ['another stem', 'Other (conflicted copy 2026-09-25).conduit', hosts],
    ['no .conduit extension', 'Vault (conflicted copy 2026-09-25)', hosts],
    ['a -wal side file', 'Vault.conduit-wal', hosts],
    ['a space is not the host separator', 'Vault DESKTOP-ABC.conduit', hosts],
  ];
  it.each(notMatching)('%s: %s does not match', (_label, name, h) => {
    expect(isProviderConflictName(name, 'Vault', h)).toBe(false);
  });

  it('treats any <stem>-<token> as conflict-like for the rebind rule only', () => {
    expect(isConflictLikeName('Vault-LAPTOP-9.conduit', 'Vault')).toBe(true);
    expect(isConflictLikeName('Vault 2.conduit', 'Vault')).toBe(false);
    expect(isConflictLikeName('Vault (1).conduit', 'Vault')).toBe(false);
    expect(isConflictLikeName('Vault copy.conduit', 'Vault')).toBe(false);
    expect(isConflictLikeName('Vault-.conduit', 'Vault')).toBe(false);
    expect(stemOf('Vault.CONDUIT')).toBe('Vault');
    expect(stemOf('Vault')).toBe('Vault');
  });
});

// ---------- Scanner over real files ----------

let worldRoot: string;
let legacy: LegacyFixture;
let otherLineageBytes: Buffer;

beforeAll(() => {
  worldRoot = makeTempRoot('copy-scanner-world');
  fs.mkdirSync(path.join(worldRoot, 'legacy'));
  fs.mkdirSync(path.join(worldRoot, 'other'));
  legacy = createLegacyVault(path.join(worldRoot, 'legacy'));
  otherLineageBytes = createLegacyVault(path.join(worldRoot, 'other')).source.bytes;
}, 30_000);

afterAll(() => {
  fs.rmSync(worldRoot, { recursive: true, force: true });
});

describe('CopyScanner', () => {
  let root: string;
  let t: TestSyncHost;
  let share: string;
  let S: string;
  let A: SimDevice;
  let B: SimDevice;
  let local: LocalReplica;
  let sessions: SessionRowView[];
  let added: AddFileInput[];
  let toasts: { kind: string; params: TransientNotice['params'] }[];
  let scanner: CopyScanner;

  function sqlOn(p: string, fn: (db: Database.Database) => void): void {
    const db = new Database(p);
    try {
      fn(db);
    } finally {
      db.close();
    }
  }

  function setFileId(p: string, fileId: string): void {
    sqlOn(p, (db) => db.prepare("INSERT OR REPLACE INTO sync_state(key, value) VALUES ('file_id', ?)").run(fileId));
  }

  function byName(copies: readonly ScannedCopy[], name: string): ScannedCopy {
    const c = copies.find((x) => x.name === name);
    if (c === undefined) throw new Error(`no copy named ${name}`);
    return c;
  }

  function notes(dev: SimDevice): unknown {
    return provisionalValue(dev.state, regKey(1, legacy.ids.db, 'notes'), null);
  }

  beforeEach(async () => {
    root = makeTempRoot('copy-scanner');
    t = makeTestSyncHost(root);
    share = path.join(root, 'share');
    fs.mkdirSync(share);
    S = path.join(share, 'Vault.conduit');
    A = new SimDevice({ name: 'A', root, source: legacy.source, now: () => t.clock.now() });
    B = new SimDevice({ name: 'B', root, source: legacy.source, now: () => t.clock.now() + 60_000 });
    A.publish(S);
    const binding: FileBinding = { sharedPath: S, realpath: fs.realpathSync(S), fileId: 'aaaaaaaa-0000-4000-8000-000000000001' };
    setFileId(S, binding.fileId);
    local = new LocalReplica(root, legacy.source.lineageId, A.deviceUuid, binding);
    sessions = [];
    added = [];
    toasts = [];
    const deps: CopyScannerDeps = {
      replica: simReplica(A, local),
      binding: { sharedPath: () => binding.realpath, binding: () => local.local().binding as FileBinding },
      shared: createSharedFile(t.host),
      candidates: {
        addFile: async (input: AddFileInput): Promise<PendingCandidate> => {
          added.push(input);
          return {
            id: `cand-${added.length}`,
            source: input.source,
            label: input.label,
            kind: 'replica',
            staleByNature: input.staleByNature,
            payload: { kind: 'file', path: input.path, sha256: sha256File(input.path) },
            createdMs: t.clock.now(),
          };
        },
      },
      notices: {
        toast: (kind, params) => {
          toasts.push({ kind, params });
          return { id: 'toast', kind, createdMs: t.clock.now(), params };
        },
        list: () => [],
        addFromCapture: (n) => n,
      },
      session: { sessions: () => sessions },
      host: t.host,
      snapshots: new SnapshotStore(path.join(root, 'snapshots'), t.host),
    };
    scanner = new CopyScanner(deps);
  });

  afterEach(() => {
    A.close();
    B.close();
    expect(t.logger.unprefixed()).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** B makes one app edit and names itself in its presence, then publishes to `name`. */
  function bPublishes(name: string, host = 'DESKTOP-ABC'): string {
    B.edit((v) => v.updateEntry(legacy.ids.db, { notes: `edited on ${host}` }));
    writePresence(B, presenceValue(host, { file_id: 'aaaaaaaa-0000-4000-8000-000000000001', location: 'onedrive:x', file_name: 'Vault.conduit' }, t.clock.now()));
    const p = path.join(share, name);
    B.publish(p);
    return p;
  }

  it('class 2: an exact copy is nothing new', async () => {
    fs.copyFileSync(S, path.join(share, 'Vault 2.conduit'));
    const res = await scanner.scan();
    expect(res.copies).toHaveLength(1);
    expect(res.copies[0]).toMatchObject({ name: 'Vault 2.conduit', cls: 'nothing-new', providerPattern: false, inUseBy: null });
    expect(res.copies[0]?.contribution).toMatchObject({ legacyEdits: 0, presync: false, otherGenesis: false });
    expect(scanner.last()).toBe(res);
  });

  it('class 2: a copy another device only had open (its presence, no edits) is nothing new, never a review', async () => {
    writePresence(B, presenceValue('LAPTOP-9', { file_id: 'bbbbbbbb-0000-4000-8000-000000000009', location: 'local:share', file_name: 'Vault 2.conduit' }, t.clock.now()));
    B.publish(path.join(share, 'Vault 2.conduit'));
    const copy = byName((await scanner.scan()).copies, 'Vault 2.conduit');
    expect(copy).toMatchObject({ cls: 'nothing-new', inUseBy: null });
    expect(copy.contribution).toMatchObject({ changedFields: 0, onlyInCopy: 0, deletions: 0, legacyEdits: 0 });
  });

  it.each([ONEDRIVE, DROPBOX, DROPBOX_NAMED, SYNCTHING])('class 3: %s with only app dots is a safe provider copy (12 row 9)', async (name) => {
    bPublishes(name);
    const res = await scanner.scan();
    expect(byName(res.copies, name)).toMatchObject({ cls: 'safe-provider-copy', providerPattern: true });
    expect(byName(res.copies, name).contribution).toMatchObject({ appDotsOnly: true, legacyEdits: 0 });
    expect(notes(A)).not.toBe('edited on DESKTOP-ABC');
  });

  it('class 3 merge keeps the copy in place, ignores its SHA and toasts', async () => {
    const p = bPublishes(ONEDRIVE);
    const before = sha256File(p);
    const copy = byName((await scanner.scan()).copies, ONEDRIVE);
    const outcome = await scanner.mergeSafe(copy);
    expect(outcome).not.toBeNull();
    expect(notes(A)).toBe('edited on DESKTOP-ABC');
    expect(fs.existsSync(p)).toBe(true);
    expect(sha256File(p)).toBe(before);
    expect(local.local().ignoredCopies).toEqual([copy.sha256]);
    expect(toasts).toEqual([{ kind: 'copy-merged', params: { name: ONEDRIVE, provider: 'onedrive' } }]);
    expect(scanner.last()?.copies).toEqual([]);
    const again = await scanner.scan();
    expect(again.copies).toEqual([]);
    expect(again.skipped).toBe(1);
  });

  it('class 4: app dots under a name that is not a provider pattern need review', async () => {
    for (const name of ['Vault 2.conduit', 'Vault (1).conduit', 'Vault-LAPTOP-9.conduit']) bPublishes(name);
    const res = await scanner.scan();
    for (const name of ['Vault 2.conduit', 'Vault (1).conduit', 'Vault-LAPTOP-9.conduit']) {
      expect(byName(res.copies, name)).toMatchObject({ cls: 'needs-review', providerPattern: false });
      expect(byName(res.copies, name).contribution.appDotsOnly).toBe(true);
    }
  });

  it('class 4: "Vault 2" with legacy deletes is reviewed, never merged or moved (12 row 42)', async () => {
    const copy = path.join(share, 'Vault 2.conduit');
    fs.copyFileSync(S, copy);
    sqlOn(copy, (db) => db.prepare('DELETE FROM entries WHERE id IN (?, ?)').run(legacy.ids.desk, legacy.ids.web));
    const stateBefore = A.state;
    const fingerprint = dirFingerprint(share);
    const res = await scanner.scan();
    const c = byName(res.copies, 'Vault 2.conduit');
    expect(c.cls).toBe('needs-review');
    expect(c.contribution.appDotsOnly).toBe(false);
    expect(c.contribution.legacyEdits).toBeGreaterThan(0);
    expect(c.contribution.deletions).toBe(2);
    expect(A.state).toBe(stateBefore);
    expect(dirFingerprint(share)).toEqual(fingerprint);
    expect(await scanner.mergeSafe(c)).toBeNull();
    expect(A.state).toBe(stateBefore);
  });

  it('class 4: a provider-pattern name with legacy edits still needs review', async () => {
    const copy = path.join(share, DROPBOX);
    fs.copyFileSync(S, copy);
    sqlOn(copy, (db) => db.prepare('UPDATE entries SET notes = ?, updated_at = ? WHERE id = ?').run('legacy edit', '2026-09-25T13:00:00.000Z', legacy.ids.db));
    const c = byName((await scanner.scan()).copies, DROPBOX);
    expect(c).toMatchObject({ cls: 'needs-review', providerPattern: true });
    expect(c.contribution.legacyEdits).toBe(1);
  });

  it('class 4: pre-sync copies and copies of another genesis', async () => {
    fs.writeFileSync(path.join(share, 'Vault old.conduit'), legacy.source.bytes);
    const modified = path.join(root, 'modified.conduit');
    fs.writeFileSync(modified, legacy.source.bytes);
    sqlOn(modified, (db) => db.prepare('UPDATE entries SET name = ? WHERE id = ?').run('renamed before genesis', legacy.ids.desk));
    const bytes = fs.readFileSync(modified);
    const C = new SimDevice({ name: 'C', root, source: { ...legacy.source, bytes, genesisId: genesisIdOf(bytes) }, now: () => t.clock.now() });
    C.publish(path.join(share, 'Vault C.conduit'));
    C.close();
    const res = await scanner.scan();
    expect(byName(res.copies, 'Vault old.conduit')).toMatchObject({ cls: 'needs-review' });
    expect(byName(res.copies, 'Vault old.conduit').contribution).toMatchObject({ presync: true, otherGenesis: false });
    expect(byName(res.copies, 'Vault C.conduit')).toMatchObject({ cls: 'needs-review' });
    expect(byName(res.copies, 'Vault C.conduit').contribution).toMatchObject({ presync: false, otherGenesis: true });
    expect(byName(res.copies, 'Vault C.conduit').contribution.changedFields).toBeGreaterThan(0);
  });

  it('class 1: a session row naming the copy, or a presence hint with its file_id, marks it in use elsewhere', async () => {
    fs.copyFileSync(S, path.join(share, 'Vault 2.conduit'));
    const other = path.join(share, 'Office.conduit');
    fs.copyFileSync(S, other);
    setFileId(other, 'bbbbbbbb-0000-4000-8000-000000000002');
    sessions = [
      {
        deviceId: 'dddddddd-0000-4000-8000-000000000004',
        deviceName: 'Office PC',
        platform: 'windows',
        fileName: 'vault 2.CONDUIT',
        fileId: null,
        location: 'onedrive:x',
        status: 'active',
        lastActiveMs: t.clock.now(),
        busySessions: 0,
        busyJobs: 0,
        heartbeatAtMs: null,
        sideFilesFlag: false,
        marker: null,
        writtenAtMs: null,
        pendingChanges: false,
        abandoned: false,
      },
    ];
    writePresence(B, presenceValue('Studio Mac', { file_id: 'bbbbbbbb-0000-4000-8000-000000000002', location: 'local:x', file_name: 'Studio.conduit' }, t.clock.now()));
    B.publish(S);
    A.sync(S);
    writePresence(A, presenceValue('This Mac', { file_id: 'cccccccc-0000-4000-8000-000000000003', location: 'local:x', file_name: 'Vault 2.conduit' }, t.clock.now()));
    const res = await scanner.scan();
    expect(byName(res.copies, 'Vault 2.conduit')).toMatchObject({ cls: 'in-use-elsewhere', inUseBy: 'Office PC' });
    expect(byName(res.copies, 'Office.conduit')).toMatchObject({ cls: 'in-use-elsewhere', inUseBy: 'Studio Mac' });
  });

  it('a device on our own file_id does not make a copy in use', async () => {
    fs.copyFileSync(S, path.join(share, 'Vault 2.conduit'));
    writePresence(B, presenceValue('Studio Mac', { file_id: 'aaaaaaaa-0000-4000-8000-000000000001', location: 'local:x', file_name: 'Vault 2.conduit' }, t.clock.now()));
    B.publish(S);
    A.sync(S);
    expect(byName((await scanner.scan()).copies, 'Vault 2.conduit').cls).not.toBe('in-use-elsewhere');
  });

  it('skips other vaults, ignored SHAs, unreadable files and publish temps, and changes nothing', async () => {
    fs.writeFileSync(path.join(share, 'Other.conduit'), otherLineageBytes);
    fs.writeFileSync(path.join(share, 'Torn.conduit'), fs.readFileSync(S).subarray(0, 2048));
    fs.writeFileSync(path.join(share, '.~Vault.conduit.abc123.tmp'), fs.readFileSync(S));
    fs.writeFileSync(path.join(share, 'notes.txt'), 'hello');
    fs.writeFileSync(`${S}-shm`, 'shm');
    const ignored = path.join(share, 'Vault 3.conduit');
    fs.copyFileSync(S, ignored);
    const copy = path.join(share, 'Vault 2.conduit');
    bPublishes('Vault 2.conduit');
    scanner.ignore(sha256File(ignored));
    const fingerprint = dirFingerprint(share);
    const res = await scanner.scan();
    expect(res.copies.map((c) => c.name)).toEqual(['Vault 2.conduit']);
    expect(res.skipped).toBe(4);
    expect(dirFingerprint(share)).toEqual(fingerprint);
    expect(fs.existsSync(copy)).toBe(true);
    expect(t.shell.trashed).toEqual([]);
  });

  it('queues a copy for review as a private file, never the user file', async () => {
    fs.writeFileSync(path.join(share, 'Vault old.conduit'), legacy.source.bytes);
    const c = byName((await scanner.scan()).copies, 'Vault old.conduit');
    const id = await scanner.queueForReview(c);
    expect(id).toBe('cand-1');
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ source: 'copy', label: 'Vault old.conduit', staleByNature: true });
    const privatePath = added[0]?.path as string;
    expect(path.dirname(privatePath)).toBe(local.paths.tmp);
    expect(sha256File(privatePath)).toBe(c.sha256);
    expect(fs.existsSync(path.join(share, 'Vault old.conduit'))).toBe(true);
  });

  it('refuses to queue a copy that changed since the scan once its staged bytes are gone', async () => {
    const p = path.join(share, 'Vault 2.conduit');
    fs.copyFileSync(S, p);
    const c = byName((await scanner.scan()).copies, 'Vault 2.conduit');
    fs.rmSync(local.paths.incoming, { recursive: true, force: true });
    fs.writeFileSync(p, legacy.source.bytes);
    await expect(scanner.queueForReview(c)).rejects.toThrow('[sync]');
    expect(added).toEqual([]);
  });

  it('moves a copy to the Trash only through the shell, and never S', async () => {
    const p = path.join(share, 'Vault 2.conduit');
    fs.copyFileSync(S, p);
    await scanner.scan();
    await expect(scanner.trash(S)).rejects.toThrow('[sync]');
    expect(fs.existsSync(S)).toBe(true);
    await scanner.trash(p);
    expect(t.shell.trashed).toEqual([p]);
    expect(fs.existsSync(p)).toBe(false);
    expect(scanner.last()?.copies).toEqual([]);
  });

  it('reads host names from the copy presence', () => {
    writePresence(B, presenceValue('DESKTOP-ABC', null, t.clock.now()));
    expect([...copyHostNames(B.state)]).toEqual(['DESKTOP-ABC']);
    expect([...copyHostNames(A.state)]).toEqual([]);
  });
});
