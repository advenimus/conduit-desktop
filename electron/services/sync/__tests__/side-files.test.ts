// @vitest-environment node
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SIDE_FILES_KEEP_MS,
  SideFiles,
  deriveSideFileState,
  sideFilePaths,
  statSideFileTuples,
  type SideFilesDeps,
} from '../side-files.js';
import type { AppFacts } from '../host.js';
import type { SideFileTuple } from '../types.js';
import { makeTempRoot, makeTestSyncHost, type TestSyncHost } from './host-fakes.js';
import { LocalReplica } from './file-binding-fixtures.js';

const WAL: SideFileTuple = { name: 'wal', exists: true, size: 0, mtimeMs: 1000 };
const SHM: SideFileTuple = { name: 'shm', exists: true, size: 32768, mtimeMs: 1000 };
const NO_WAL: SideFileTuple = { name: 'wal', exists: false, size: 0, mtimeMs: 0 };
const NO_SHM: SideFileTuple = { name: 'shm', exists: false, size: 0, mtimeMs: 0 };

describe('deriveSideFileState (5.5 table)', () => {
  it('walks none -> present -> confirmed -> tuples change -> present', () => {
    expect(deriveSideFileState([NO_WAL, NO_SHM], null)).toBe('none');
    expect(deriveSideFileState([WAL, SHM], null)).toBe('present');
    const stored = { tuples: [WAL, SHM], confirmedAtMs: 5000 };
    expect(deriveSideFileState([WAL, SHM], stored)).toBe('confirmed');
    expect(deriveSideFileState([SHM, WAL], stored)).toBe('confirmed');
    expect(deriveSideFileState([{ ...WAL, size: 4096 }, SHM], stored)).toBe('present');
    expect(deriveSideFileState([WAL, { ...SHM, mtimeMs: 2000 }], stored)).toBe('present');
    expect(deriveSideFileState([NO_WAL, NO_SHM], stored)).toBe('none');
  });

  it('a stored record without a confirmation time is not a confirmation', () => {
    expect(deriveSideFileState([WAL, SHM], { tuples: [WAL, SHM], confirmedAtMs: null })).toBe('present');
  });

  it('names the side files next to S', () => {
    expect(sideFilePaths('/x/Vault.conduit')).toEqual({ wal: '/x/Vault.conduit-wal', shm: '/x/Vault.conduit-shm' });
  });
});

describe('SideFiles', () => {
  let root: string;
  let t: TestSyncHost;
  let replica: LocalReplica;
  let shared: string;
  let app: { listed: boolean; firstLaunch: number | null };

  function make(): SideFiles {
    const facts: AppFacts = { settingsListsVault: () => app.listed, thisBuildFirstLaunchMs: () => app.firstLaunch };
    const deps: SideFilesDeps = { replica, host: { ...t.host, app: facts }, realpath: shared };
    return new SideFiles(shared, deps);
  }

  async function poll(sf: SideFiles) {
    return sf.observe(await statSideFileTuples(shared, t.host.fs));
  }

  function writeSideFiles(walBytes: number): void {
    fs.writeFileSync(`${shared}-wal`, Buffer.alloc(walBytes, 7));
    fs.writeFileSync(`${shared}-shm`, Buffer.alloc(32768, 1));
  }

  beforeEach(() => {
    root = makeTempRoot('side-files');
    t = makeTestSyncHost(root);
    replica = new LocalReplica(root);
    fs.mkdirSync(path.join(root, 'share'));
    shared = path.join(root, 'share', 'Vault.conduit');
    fs.writeFileSync(shared, 'not needed for these tests');
    app = { listed: false, firstLaunch: null };
  });

  afterEach(() => {
    expect(t.logger.unprefixed()).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports none with no side files and present when they appear', async () => {
    const sf = make();
    const none = await poll(sf);
    expect(none).toMatchObject({ state: 'none', publishAllowed: true, holdLegacy: false, walNonEmpty: false });
    expect(sf.heartbeatFlag()).toBeNull();
    expect(sf.lastSeenMs()).toBeNull();
    writeSideFiles(0);
    const present = await poll(sf);
    expect(present).toMatchObject({ state: 'present', publishAllowed: false, holdLegacy: true, walNonEmpty: false });
    expect(sf.heartbeatFlag()).toBe('present');
    expect(sf.lastSeenMs()).toBe(t.clock.now());
    expect(replica.local().sideFiles).toBeNull();
  });

  it('confirm moves both side files into sidefiles-<ts> and never deletes them', async () => {
    const sf = make();
    writeSideFiles(0);
    const shown = (await poll(sf)).tuples;
    const out = await sf.confirm(shown, false);
    expect(out.kind).toBe('confirmed');
    const movedTo = out.kind === 'confirmed' ? out.movedTo : null;
    expect(movedTo).toBe(path.join(replica.paths.dir, `sidefiles-${t.clock.now()}`));
    expect(fs.existsSync(`${shared}-wal`)).toBe(false);
    expect(fs.existsSync(`${shared}-shm`)).toBe(false);
    expect(fs.readdirSync(movedTo as string).sort()).toEqual(['Vault.conduit-shm', 'Vault.conduit-wal']);
    expect(fs.statSync(path.join(movedTo as string, 'Vault.conduit-shm')).size).toBe(32768);
    expect(sf.view().state).toBe('none');
    expect(replica.local().sideFiles).toBeNull();
    expect(replica.local().sideFilesConfirmedAtMs).toBe(t.clock.now());
  });

  it('records the confirmation once the move is done, and not while a file is held open (5.5 server flag)', async () => {
    const sf = make();
    writeSideFiles(0);
    const shown = (await poll(sf)).tuples;
    t.fs.inject({ op: 'rename', match: /-shm$/, code: 'EBUSY', times: 1 });
    expect((await sf.confirm(shown, false)).kind).toBe('held-open');
    expect(replica.local().sideFilesConfirmedAtMs ?? null).toBeNull();
    await t.clock.advance(3_000);
    expect((await sf.confirm(sf.pendingRetry()!.tuples, false)).kind).toBe('confirmed');
    expect(replica.local().sideFilesConfirmedAtMs).toBe(t.clock.now());
  });

  it('returns changed when the tuples moved on since the prompt was shown', async () => {
    const sf = make();
    writeSideFiles(0);
    const shown = (await poll(sf)).tuples;
    fs.appendFileSync(`${shared}-wal`, Buffer.alloc(100));
    expect(await sf.confirm(shown, false)).toEqual({ kind: 'changed' });
    expect(fs.existsSync(`${shared}-wal`)).toBe(true);
  });

  it('asks to review a non-empty WAL first, and moves after the review', async () => {
    const sf = make();
    writeSideFiles(4096);
    const view = await poll(sf);
    expect(view.walNonEmpty).toBe(true);
    expect(await sf.confirm(view.tuples, false)).toEqual({ kind: 'review-first' });
    expect(fs.existsSync(`${shared}-wal`)).toBe(true);
    const out = await sf.confirm(view.tuples, true);
    expect(out.kind === 'confirmed' && out.movedTo !== null).toBe(true);
    expect(fs.existsSync(`${shared}-wal`)).toBe(false);
  });

  it('never records a confirmation when a side file is held open (EPERM); publishing stays paused', async () => {
    const sf = make();
    writeSideFiles(0);
    const shown = (await poll(sf)).tuples;
    t.fs.inject({ op: 'rename', match: /-shm$/, code: 'EPERM', times: Infinity });
    const out = await sf.confirm(shown, false);
    expect(out).toEqual({ kind: 'held-open', code: 'EPERM' });
    expect(replica.local().sideFiles).toBeNull();
    expect(fs.existsSync(`${shared}-wal`)).toBe(false);
    expect(fs.existsSync(`${shared}-shm`)).toBe(true);
    expect(sf.view()).toMatchObject({ state: 'present', publishAllowed: false, holdLegacy: true });
    expect((await poll(sf)).state).toBe('present');
    expect(t.logger.messages('warn').some((m) => m.includes('held open by another program'))).toBe(true);
  });

  it('keeps the confirmation in memory and moves the held file on a later retry', async () => {
    const sf = make();
    writeSideFiles(0);
    const shown = (await poll(sf)).tuples;
    t.fs.inject({ op: 'rename', match: /-shm$/, code: 'EBUSY', times: 3 });
    expect((await sf.confirm(shown, false)).kind).toBe('held-open');
    const intent = sf.pendingRetry();
    expect(intent?.tuples.filter((x) => x.exists).map((x) => x.name)).toEqual(['shm']);
    expect((await sf.confirm(intent!.tuples, intent!.walReviewed)).kind).toBe('held-open');
    expect((await sf.confirm(sf.pendingRetry()!.tuples, false)).kind).toBe('held-open');
    const folders = fs.readdirSync(replica.paths.dir).filter((n) => n.startsWith('sidefiles-'));
    expect(folders).toHaveLength(1);
    const done = await sf.confirm(sf.pendingRetry()!.tuples, false);
    expect(done.kind).toBe('confirmed');
    expect(sf.pendingRetry()).toBeNull();
    expect(sf.view().state).toBe('none');
    expect(fs.existsSync(`${shared}-shm`)).toBe(false);
  });

  it('drops the retry when the held files change (the other program wrote to them)', async () => {
    const sf = make();
    writeSideFiles(0);
    const shown = (await poll(sf)).tuples;
    t.fs.inject({ op: 'rename', code: 'EBUSY', times: Infinity });
    expect((await sf.confirm(shown, false)).kind).toBe('held-open');
    expect(sf.pendingRetry()).not.toBeNull();
    fs.appendFileSync(`${shared}-wal`, Buffer.alloc(100));
    await poll(sf);
    expect(sf.pendingRetry()).toBeNull();
    expect(sf.view().state).toBe('present');
    expect(fs.readdirSync(replica.paths.dir).filter((n) => n.startsWith('sidefiles-'))).toEqual([]);
  });

  it('a non-empty WAL held open after review is never left next to a published S (2.1)', async () => {
    fs.rmSync(shared);
    const legacy = new Database(shared);
    legacy.pragma('journal_mode = WAL');
    legacy.pragma('wal_autocheckpoint = 0');
    legacy.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t VALUES (1, 'a');");
    legacy.pragma('wal_checkpoint(TRUNCATE)');
    legacy.exec("UPDATE t SET v = 'stale-wal' WHERE id = 1");
    const sf = make();
    const view = await poll(sf);
    expect(view).toMatchObject({ state: 'present', walNonEmpty: true });
    t.fs.inject({ op: 'rename', match: /-wal$/, code: 'EBUSY', times: Infinity });
    expect(await sf.confirm(view.tuples, true)).toEqual({ kind: 'held-open', code: 'EBUSY' });
    legacy.close();
    expect(sf.view()).toMatchObject({ state: 'present', publishAllowed: false, holdLegacy: true });
    expect(sf.pendingRetry()?.walReviewed).toBe(true);
  });

  it('copies and removes across devices (EXDEV)', async () => {
    const sf = make();
    writeSideFiles(0);
    const shown = (await poll(sf)).tuples;
    t.fs.inject({ op: 'rename', code: 'EXDEV', times: 2 });
    const out = await sf.confirm(shown, false);
    expect(out.kind === 'confirmed' && out.movedTo !== null).toBe(true);
    expect(fs.existsSync(`${shared}-shm`)).toBe(false);
    expect(fs.readdirSync((out as { movedTo: string }).movedTo).length).toBe(2);
  });

  it('propagates other move errors with a log line', async () => {
    const sf = make();
    writeSideFiles(0);
    const shown = (await poll(sf)).tuples;
    t.fs.inject({ op: 'rename', code: 'EIO', times: 1 });
    await expect(sf.confirm(shown, false)).rejects.toMatchObject({ code: 'EIO' });
    expect(t.logger.messages('error').some((m) => m.includes('moving a side file aside failed'))).toBe(true);
  });

  it('uses the upgrade wording only when settings list the vault and the files predate this build', async () => {
    const sf = make();
    writeSideFiles(0);
    const mtime = Math.max(fs.statSync(`${shared}-wal`).mtimeMs, fs.statSync(`${shared}-shm`).mtimeMs);
    expect((await poll(sf)).upgradeWording).toBe(false);
    app = { listed: true, firstLaunch: null };
    expect((await poll(sf)).upgradeWording).toBe(false);
    app = { listed: true, firstLaunch: mtime + 60_000 };
    expect((await poll(sf)).upgradeWording).toBe(true);
    app = { listed: false, firstLaunch: mtime + 60_000 };
    expect((await poll(sf)).upgradeWording).toBe(false);
    app = { listed: true, firstLaunch: mtime - 60_000 };
    expect((await poll(sf)).upgradeWording).toBe(false);
  });

  it('cleans up sidefiles folders older than 30 days only', async () => {
    const sf = make();
    const now = t.clock.now();
    const old = path.join(replica.paths.dir, `sidefiles-${now - SIDE_FILES_KEEP_MS - 1}`);
    const recent = path.join(replica.paths.dir, `sidefiles-${now - 1000}`);
    for (const d of [old, recent]) {
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'Vault.conduit-wal'), 'x');
    }
    expect(await sf.cleanup(now)).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
  });

  it('forgets a stored confirmation when S moves to another path', async () => {
    const sf = make();
    writeSideFiles(0);
    const shown = (await poll(sf)).tuples;
    replica.updateLocal((l) => ({ ...l, sideFiles: { tuples: shown, confirmedAtMs: 1 } }));
    expect((await poll(sf)).state).toBe('confirmed');
    sf.setSharedPath(path.join(root, 'share', 'Other.conduit'));
    expect(replica.local().sideFiles).toBeNull();
    expect(sf.view().state).toBe('none');
  });

  it('logs and keeps working when clearing the stored confirmation fails', async () => {
    const sf = make();
    replica.updateLocal((l) => ({ ...l, sideFiles: { tuples: [WAL, SHM], confirmedAtMs: 1 } }));
    replica.failNextWrite = true;
    expect((await poll(sf)).state).toBe('none');
    expect(t.logger.messages('error').some((m) => m.includes('clearing the stored confirmation failed'))).toBe(true);
    expect((await poll(sf)).state).toBe('none');
    expect(replica.local().sideFiles).toBeNull();
  });

  it('stages S plus S-wal privately and recovers rows written only to the WAL (12 row 14)', async () => {
    fs.rmSync(shared);
    const writer = new Database(shared);
    writer.pragma('journal_mode = WAL');
    writer.pragma('wal_autocheckpoint = 0');
    writer.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    writer.pragma('wal_checkpoint(TRUNCATE)');
    const insert = writer.prepare('INSERT INTO t (v) VALUES (?)');
    for (let i = 0; i < 25; i++) insert.run(`row ${i}`);
    expect(fs.statSync(`${shared}-wal`).size).toBeGreaterThan(0);

    const mainOnly = path.join(root, 'main-only.conduit');
    fs.copyFileSync(shared, mainOnly);
    const probe = new Database(mainOnly, { readonly: true });
    expect((probe.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n).toBe(0);
    probe.close();

    const sf = make();
    const copy = await sf.stageWalCopy();
    writer.close();
    expect(path.dirname(copy)).toBe(replica.paths.incoming);
    expect(fs.existsSync(`${copy}-wal`)).toBe(false);
    expect(fs.existsSync(`${copy}-shm`)).toBe(false);
    const header = fs.readFileSync(copy).subarray(18, 20);
    expect([...header]).toEqual([1, 1]);
    const db = new Database(copy, { readonly: true });
    expect((db.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n).toBe(25);
    db.close();
  });
});
