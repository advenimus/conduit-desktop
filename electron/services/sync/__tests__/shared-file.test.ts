// @vitest-environment node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PUBLISH_MTIME_BUMP_MS,
  PUBLISH_RETRY_DELAYS_MS,
  PUBLISH_TEMP_MAX_AGE_MS,
  STAGED_KEEP,
  TORN_QUARANTINE_AFTER_MS,
  TornTracker,
  checkHeader,
  cleanupIncoming,
  cleanupPublishTemps,
  createSharedFile,
  publishMtime,
  type SharedFileHost,
  type SharedFilePort,
  type SharedSnapshot,
} from '../shared-file.js';
import type { Timers } from '../host.js';
import { createLegacyVault, type LegacyFixture } from './core-e2e-fixtures.js';
import { makeTempRoot, makeTestSyncHost, type TestSyncHost } from './host-fakes.js';
import {
  editedBytes,
  journalBytes,
  makeSyncedBytes,
  notAVaultBytes,
  pageSizeOf,
  sideFilesNextTo,
} from './shared-file-fixtures.js';

const OTHER_LINEAGE = '11111111-2222-4333-8444-555555555555';

let fixtureDir: string;
let legacy: LegacyFixture;
let synced: Buffer;

beforeAll(() => {
  fixtureDir = makeTempRoot('shared-fixture');
  legacy = createLegacyVault(fixtureDir);
  synced = makeSyncedBytes(fixtureDir, legacy.source);
});

afterAll(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

let root: string;
let t: TestSyncHost;
let shared: SharedFilePort;
let sharedDir: string;
let incoming: string;
let sharedPath: string;
let sleeps: number[];

function recordingTimers(base: Timers): Timers {
  return {
    setTimeout: (fn, ms) => base.setTimeout(fn, ms),
    setInterval: (fn, ms) => base.setInterval(fn, ms),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
}

beforeEach(() => {
  root = makeTempRoot('shared-file');
  sleeps = [];
  t = makeTestSyncHost(root);
  const host: SharedFileHost = { ...t.host, timers: recordingTimers(t.clock) };
  shared = createSharedFile(host);
  sharedDir = path.join(root, 'cloud');
  incoming = path.join(root, 'lineage', 'incoming');
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.mkdirSync(incoming, { recursive: true });
  sharedPath = path.join(sharedDir, 'Vault.conduit');
});

afterEach(() => {
  expect(t.logger.unprefixed()).toEqual([]);
  fs.rmSync(root, { recursive: true, force: true });
});

async function readOk(p: string = sharedPath): Promise<SharedSnapshot> {
  const res = await shared.read(p, incoming);
  if (res.kind !== 'ok') throw new Error(`expected ok, got ${res.kind}`);
  return res.snapshot;
}

async function classifyBytes(bytes: Buffer, lineageId: string | null = legacy.source.lineageId) {
  fs.writeFileSync(sharedPath, bytes);
  const snap = await readOk();
  return shared.classify(snap, { lineageId });
}

/** utimes goes through float seconds, so a set mtime can read back a microsecond lower. */
function expectMs(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThan(1);
}

function sha(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function writeSnapshot(bytes: Buffer = synced): string {
  const dir = path.join(root, 'lineage', 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `publish-${crypto.randomBytes(4).toString('hex')}.conduit`);
  fs.writeFileSync(p, bytes);
  return p;
}

function publishTemps(): string[] {
  return fs.readdirSync(sharedDir).filter((n) => n.endsWith('.tmp'));
}

describe('readShared', () => {
  it('stages the bytes under incoming/<sha>.conduit and reports the stat', async () => {
    fs.writeFileSync(sharedPath, legacy.source.bytes);
    const snap = await readOk();
    expect(snap.sha256).toBe(sha(legacy.source.bytes));
    expect(snap.stagedPath).toBe(path.join(incoming, `${snap.sha256}.conduit`));
    expect(fs.readFileSync(snap.stagedPath).equals(legacy.source.bytes)).toBe(true);
    expect(snap.stat.size).toBe(legacy.source.bytes.length);
    expect(t.fs.calls.some((c) => /-(wal|shm)$/.test(c.path))).toBe(false);
  });

  it('reports missing and unreachable separately', async () => {
    expect(await shared.read(sharedPath, incoming)).toEqual({ kind: 'missing' });
    t.fs.inject({ op: 'stat', match: /Vault\.conduit$/, code: 'EIO' });
    expect(await shared.read(sharedPath, incoming)).toEqual({ kind: 'unreachable', code: 'EIO' });
  });

  it('treats ENOENT during the read as missing', async () => {
    fs.writeFileSync(sharedPath, legacy.source.bytes);
    t.fs.inject({ op: 'readFile', match: /Vault\.conduit$/, code: 'ENOENT' });
    expect(await shared.read(sharedPath, incoming)).toEqual({ kind: 'missing' });
  });
});

describe('checkHeader', () => {
  it('passes real files and rejects bad magic, torn sizes and wrong page counts', () => {
    expect(checkHeader(synced)).toBeNull();
    expect(checkHeader(legacy.source.bytes)).toBeNull();
    expect(checkHeader(Buffer.from('not a database at all'))).toBe('magic');
    expect(checkHeader(synced.subarray(0, 50))).toBe('page-size');
    const page = pageSizeOf(synced);
    expect(checkHeader(synced.subarray(0, page + page / 2))).toBe('page-size');
    expect(checkHeader(synced.subarray(0, synced.length - page))).toBe('page-count');
  });
});

describe('classifyStaged', () => {
  it('classifies a synced file of our lineage', async () => {
    const c = await classifyBytes(synced);
    expect(c.kind).toBe('synced');
    if (c.kind !== 'synced') return;
    expect(c.file.state.lineageId).toBe(legacy.source.lineageId);
    expect(c.meta.salt).not.toBeNull();
    expect(c.meta.verification).not.toBeNull();
  });

  it('classifies a WAL-mode pre-sync legacy file without side files next to S', async () => {
    expect(journalBytes(legacy.source.bytes)).toEqual([2, 2]);
    const c = await classifyBytes(legacy.source.bytes);
    expect(c.kind).toBe('presync');
    if (c.kind === 'presync') expect(c.content.entries.size).toBeGreaterThan(0);
    expect(sideFilesNextTo(sharedPath)).toEqual([]);
    expect(fs.readFileSync(sharedPath).equals(legacy.source.bytes)).toBe(true);
  });

  it('accepts any lineage when the expectation is null (peek)', async () => {
    const other = makeSyncedBytes(root, legacy.source, OTHER_LINEAGE);
    const c = await classifyBytes(other, null);
    expect(c.kind).toBe('synced');
  });

  it('reports another lineage as foreign-other', async () => {
    const other = makeSyncedBytes(root, legacy.source, OTHER_LINEAGE);
    expect(await classifyBytes(other)).toEqual({ kind: 'foreign-other', lineageId: OTHER_LINEAGE, reason: 'lineage' });
  });

  it('reports a newer sync_format as foreign-newer', async () => {
    const newer = editedBytes(root, synced, (db) => db.prepare("UPDATE vault_meta SET value = '2' WHERE key = 'sync_format'").run());
    expect(await classifyBytes(newer)).toEqual({ kind: 'foreign-newer', syncFormat: 2 });
  });

  it('reports a non-Conduit SQLite file and a vault_meta without keys as not-conduit', async () => {
    expect(await classifyBytes(notAVaultBytes(root))).toEqual({ kind: 'foreign-other', lineageId: null, reason: 'not-conduit' });
    const keyless = editedBytes(root, legacy.source.bytes, (db) =>
      db.prepare("DELETE FROM vault_meta WHERE key IN ('salt', 'verification')").run(),
    );
    expect(await classifyBytes(keyless)).toEqual({ kind: 'foreign-other', lineageId: null, reason: 'not-conduit' });
  });

  it('treats a missing sync_format as pre-sync even when sync tables exist', async () => {
    const noFormat = editedBytes(root, synced, (db) => db.prepare("DELETE FROM vault_meta WHERE key = 'sync_format'").run());
    expect((await classifyBytes(noFormat)).kind).toBe('presync');
  });

  it('reports torn and damaged files as unreadable', async () => {
    const page = pageSizeOf(synced);
    expect(await classifyBytes(synced.subarray(0, page * 2 + 17))).toEqual({ kind: 'unreadable', reason: 'page-size' });
    expect(await classifyBytes(synced.subarray(0, synced.length - page))).toEqual({ kind: 'unreadable', reason: 'page-count' });
    expect(await classifyBytes(Buffer.alloc(4096, 7))).toEqual({ kind: 'unreadable', reason: 'magic' });
    const dropped = editedBytes(root, synced, (db) => db.exec('DROP TABLE sync_grave'));
    expect(await classifyBytes(dropped)).toEqual({ kind: 'unreadable', reason: 'missing-tables' });
    const noLineage = editedBytes(root, synced, (db) => db.prepare("DELETE FROM sync_state WHERE key = 'lineage_id'").run());
    expect(await classifyBytes(noLineage)).toEqual({ kind: 'unreadable', reason: 'corrupt-sync-state' });
  });

  it('reports a file with a damaged b-tree page as unreadable', async () => {
    const page = pageSizeOf(synced);
    const damaged = Buffer.from(synced);
    for (let p = 1; p < damaged.length / page; p++) damaged.fill(0xff, p * page, p * page + 64);
    const c = await classifyBytes(damaged);
    expect(c.kind).toBe('unreadable');
  });
});

describe('TornTracker', () => {
  it('retries at 5, 15 and 45 s, then quarantines after 2 minutes of the same bytes', () => {
    const torn = new TornTracker();
    const t0 = 1_000_000;
    expect(torn.observe('a', t0)).toEqual({ kind: 'retry', atMs: t0 + 5_000 });
    expect(torn.observe('a', t0 + 5_000)).toEqual({ kind: 'retry', atMs: t0 + 15_000 });
    expect(torn.observe('a', t0 + 15_000)).toEqual({ kind: 'retry', atMs: t0 + 45_000 });
    expect(torn.observe('a', t0 + 45_000)).toEqual({ kind: 'retry', atMs: t0 + TORN_QUARANTINE_AFTER_MS });
    expect(torn.observe('a', t0 + TORN_QUARANTINE_AFTER_MS)).toEqual({ kind: 'quarantine' });
  });

  it('restarts the schedule for new bytes and after reset', () => {
    const torn = new TornTracker();
    torn.observe('a', 0);
    expect(torn.observe('b', 100_000)).toEqual({ kind: 'retry', atMs: 105_000 });
    torn.reset();
    expect(torn.observe('b', 200_000)).toEqual({ kind: 'retry', atMs: 205_000 });
  });

  it('quarantine copies the bytes under quarantine/<now>-<sha8>.conduit', async () => {
    fs.writeFileSync(sharedPath, synced.subarray(0, 1000));
    const snap = await readOk();
    const qdir = path.join(root, 'lineage', 'quarantine');
    const out = await shared.quarantine(snap, qdir);
    expect(path.basename(out)).toBe(`${t.clock.now()}-${snap.sha256.slice(0, 8)}.conduit`);
    expect(fs.readFileSync(out).equals(snap.bytes)).toBe(true);
    expect(fs.readFileSync(sharedPath).equals(snap.bytes)).toBe(true);
  });
});

describe('publishIfUnchanged', () => {
  it('replaces S when it still has the merged SHA, with a WAL-mode file and no side files', async () => {
    fs.writeFileSync(sharedPath, legacy.source.bytes);
    const before = await readOk();
    const snapshot = writeSnapshot();
    const res = await shared.publish({ sharedPath, snapshotPath: snapshot, expectedSha256: before.sha256, observedMtimeMs: before.stat.mtimeMs });
    expect(res).toMatchObject({ kind: 'published', sha256: sha(synced), inPlace: false });
    const now = fs.readFileSync(sharedPath);
    expect(now.equals(synced)).toBe(true);
    expect(journalBytes(now)).toEqual([2, 2]);
    expect(sideFilesNextTo(sharedPath)).toEqual([]);
    expect(publishTemps()).toEqual([]);
    expect(fs.existsSync(snapshot)).toBe(false);
  });

  it('does not write when S changed between the read and the publish (CAS)', async () => {
    fs.writeFileSync(sharedPath, legacy.source.bytes);
    const merged = await readOk();
    const theirs = makeSyncedBytes(root, legacy.source);
    fs.writeFileSync(sharedPath, theirs);
    const snapshot = writeSnapshot();
    const res = await shared.publish({ sharedPath, snapshotPath: snapshot, expectedSha256: merged.sha256, observedMtimeMs: merged.stat.mtimeMs });
    expect(res).toEqual({ kind: 'changed', currentSha256: sha(theirs) });
    expect(fs.readFileSync(sharedPath).equals(theirs)).toBe(true);
    expect(publishTemps()).toEqual([]);
    expect(fs.existsSync(snapshot)).toBe(false);
    const writesToS = t.fs.calls.filter((c) => c.path.startsWith(sharedDir) && (c.op === 'rename' || (c.op === 'writeFileDurable' && c.path === sharedPath)));
    expect(writesToS).toEqual([]);
  });

  it('first publish requires S to be absent; a vanished S is a change', async () => {
    fs.writeFileSync(sharedPath, legacy.source.bytes);
    const res = await shared.publish({ sharedPath, snapshotPath: writeSnapshot(), expectedSha256: null, observedMtimeMs: null });
    expect(res).toEqual({ kind: 'changed', currentSha256: sha(legacy.source.bytes) });
    fs.rmSync(sharedPath);
    const gone = await shared.publish({ sharedPath, snapshotPath: writeSnapshot(), expectedSha256: 'ab'.repeat(32), observedMtimeMs: 1 });
    expect(gone).toEqual({ kind: 'changed', currentSha256: null });
    const first = await shared.publish({ sharedPath, snapshotPath: writeSnapshot(), expectedSha256: null, observedMtimeMs: null });
    expect(first.kind).toBe('published');
    expectMs(fs.statSync(sharedPath).mtimeMs, t.clock.now());
  });

  it('bumps the mtime to observed + 2 s when S is dated in the future, else to now', async () => {
    fs.writeFileSync(sharedPath, legacy.source.bytes);
    const future = t.clock.now() + 3_600_000;
    fs.utimesSync(sharedPath, future / 1000, future / 1000);
    const s1 = await readOk();
    const r1 = await shared.publish({ sharedPath, snapshotPath: writeSnapshot(), expectedSha256: s1.sha256, observedMtimeMs: s1.stat.mtimeMs });
    expect(r1.kind).toBe('published');
    expectMs(fs.statSync(sharedPath).mtimeMs, s1.stat.mtimeMs + PUBLISH_MTIME_BUMP_MS);
    if (r1.kind === 'published') expectMs(r1.mtimeMs, s1.stat.mtimeMs + PUBLISH_MTIME_BUMP_MS);

    const past = t.clock.now() - 3_600_000;
    fs.utimesSync(sharedPath, past / 1000, past / 1000);
    const s2 = await readOk();
    const r2 = await shared.publish({ sharedPath, snapshotPath: writeSnapshot(legacy.source.bytes), expectedSha256: s2.sha256, observedMtimeMs: s2.stat.mtimeMs });
    expect(r2.kind).toBe('published');
    expectMs(fs.statSync(sharedPath).mtimeMs, t.clock.now());
  });

  it('retries EPERM on the rename and then succeeds', async () => {
    fs.writeFileSync(sharedPath, legacy.source.bytes);
    const s = await readOk();
    t.fs.inject({ op: 'rename', match: /\.tmp$/, code: 'EPERM', times: 2 });
    const res = await shared.publish({ sharedPath, snapshotPath: writeSnapshot(), expectedSha256: s.sha256, observedMtimeMs: s.stat.mtimeMs });
    expect(res).toMatchObject({ kind: 'published', inPlace: false });
    expect(sleeps).toEqual([PUBLISH_RETRY_DELAYS_MS[0], PUBLISH_RETRY_DELAYS_MS[1]]);
    expect(fs.readFileSync(sharedPath).equals(synced)).toBe(true);
    expect(publishTemps()).toEqual([]);
  });

  it.each(['EPERM', 'EBUSY'])('falls back to an in-place write after every retry failed (%s)', async (code) => {
    fs.writeFileSync(sharedPath, legacy.source.bytes);
    const s = await readOk();
    t.fs.inject({ op: 'rename', match: /\.tmp$/, code, times: 5 });
    const res = await shared.publish({ sharedPath, snapshotPath: writeSnapshot(), expectedSha256: s.sha256, observedMtimeMs: s.stat.mtimeMs });
    expect(res).toMatchObject({ kind: 'published', sha256: sha(synced), inPlace: true });
    expect(sleeps).toEqual([...PUBLISH_RETRY_DELAYS_MS]);
    expect(fs.readFileSync(sharedPath).equals(synced)).toBe(true);
    expectMs(fs.statSync(sharedPath).mtimeMs, publishMtime(t.clock.now(), s.stat.mtimeMs));
    expect(publishTemps()).toEqual([]);
    expect(sideFilesNextTo(sharedPath)).toEqual([]);
  });

  it.each([0, PUBLISH_RETRY_DELAYS_MS.length - 1])(
    'a version of S that lands while the rename is refused is never overwritten (CAS again after wait %i)',
    async (landsAfter) => {
      fs.writeFileSync(sharedPath, legacy.source.bytes);
      const s = await readOk();
      const theirs = Buffer.from('edit from iOS 1.0.5 written back during the retries');
      let waits = 0;
      const timers: Timers = {
        ...recordingTimers(t.clock),
        sleep: async () => {
          if (waits++ === landsAfter) fs.writeFileSync(sharedPath, theirs);
        },
      };
      const racing = createSharedFile({ ...t.host, timers });
      t.fs.inject({ op: 'rename', match: /\.tmp$/, code: 'EBUSY', times: Infinity });
      const res = await racing.publish({ sharedPath, snapshotPath: writeSnapshot(), expectedSha256: s.sha256, observedMtimeMs: s.stat.mtimeMs });
      expect(res).toEqual({ kind: 'changed', currentSha256: sha(theirs) });
      expect(fs.readFileSync(sharedPath).equals(theirs)).toBe(true);
      expect(publishTemps()).toEqual([]);
      expect(waits).toBe(landsAfter + 1);
    },
  );

  it('checks the CAS after the temp is written, so a version landing during the slow temp write wins', async () => {
    fs.writeFileSync(sharedPath, legacy.source.bytes);
    const s = await readOk();
    const theirs = Buffer.from('a newer version placed by the cloud client');
    const slowFs = {
      ...t.fs,
      writeFileDurable: async (p: string, d: Uint8Array | string) => {
        await t.fs.writeFileDurable(p, d);
        if (p.endsWith('.tmp')) fs.writeFileSync(sharedPath, theirs);
      },
    };
    const racing = createSharedFile({ ...t.host, fs: slowFs, timers: recordingTimers(t.clock) });
    const res = await racing.publish({ sharedPath, snapshotPath: writeSnapshot(), expectedSha256: s.sha256, observedMtimeMs: s.stat.mtimeMs });
    expect(res).toEqual({ kind: 'changed', currentSha256: sha(theirs) });
    expect(fs.readFileSync(sharedPath).equals(theirs)).toBe(true);
    expect(publishTemps()).toEqual([]);
  });

  it('reports other IO errors as failed and leaves no temp behind', async () => {
    fs.writeFileSync(sharedPath, legacy.source.bytes);
    const s = await readOk();
    t.fs.inject({ op: 'writeFileDurable', match: /\.tmp$/, code: 'ENOSPC' });
    const snapshot = writeSnapshot();
    const res = await shared.publish({ sharedPath, snapshotPath: snapshot, expectedSha256: s.sha256, observedMtimeMs: s.stat.mtimeMs });
    expect(res).toMatchObject({ kind: 'failed', code: 'ENOSPC' });
    expect(fs.readFileSync(sharedPath).equals(legacy.source.bytes)).toBe(true);
    expect(publishTemps()).toEqual([]);
    expect(fs.existsSync(snapshot)).toBe(false);
    expect(t.logger.messages('error').some((m) => m.startsWith('[sync] publish failed'))).toBe(true);
  });

  it('still counts as published when the folder sync after the rename fails', async () => {
    fs.writeFileSync(sharedPath, legacy.source.bytes);
    const s = await readOk();
    t.fs.inject({ op: 'fsyncDir', code: 'EIO' });
    const res = await shared.publish({ sharedPath, snapshotPath: writeSnapshot(), expectedSha256: s.sha256, observedMtimeMs: s.stat.mtimeMs });
    expect(res).toMatchObject({ kind: 'published', sha256: sha(synced) });
    expect(fs.readFileSync(sharedPath).equals(synced)).toBe(true);
    expect(t.logger.messages('warn')).toContain('[sync] folder sync after publishing failed');
  });

  it('a non-retry rename error fails without writing S', async () => {
    fs.writeFileSync(sharedPath, legacy.source.bytes);
    const s = await readOk();
    t.fs.inject({ op: 'rename', match: /\.tmp$/, code: 'EACCES' });
    const res = await shared.publish({ sharedPath, snapshotPath: writeSnapshot(), expectedSha256: s.sha256, observedMtimeMs: s.stat.mtimeMs });
    expect(res).toMatchObject({ kind: 'failed', code: 'EACCES' });
    expect(sleeps).toEqual([]);
    expect(fs.readFileSync(sharedPath).equals(legacy.source.bytes)).toBe(true);
    expect(publishTemps()).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('keeps the permissions of S, and a first publish is owner-only', async () => {
    const modeOf = (p: string) => fs.statSync(p).mode & 0o777;
    fs.writeFileSync(sharedPath, legacy.source.bytes);
    fs.chmodSync(sharedPath, 0o600);
    const s = await readOk();
    const res = await shared.publish({ sharedPath, snapshotPath: writeSnapshot(), expectedSha256: s.sha256, observedMtimeMs: s.stat.mtimeMs });
    expect(res.kind).toBe('published');
    expect(modeOf(sharedPath)).toBe(0o600);

    fs.chmodSync(sharedPath, 0o640);
    const s2 = await readOk();
    await shared.publish({ sharedPath, snapshotPath: writeSnapshot(), expectedSha256: s2.sha256, observedMtimeMs: s2.stat.mtimeMs });
    expect(modeOf(sharedPath)).toBe(0o640);

    fs.rmSync(sharedPath);
    const first = await shared.publish({ sharedPath, snapshotPath: writeSnapshot(), expectedSha256: null, observedMtimeMs: null });
    expect(first.kind).toBe('published');
    expect(modeOf(sharedPath)).toBe(0o600);
  });
});

describe('cleanup', () => {
  it('removes publish temps older than one hour only', async () => {
    const now = t.clock.now();
    const old = path.join(sharedDir, '.~Vault.conduit.aaaa.tmp');
    const fresh = path.join(sharedDir, '.~Vault.conduit.bbbb.tmp');
    const unrelated = path.join(sharedDir, 'notes.tmp');
    for (const f of [old, fresh, unrelated]) fs.writeFileSync(f, 'x');
    const oldMs = now - PUBLISH_TEMP_MAX_AGE_MS - 1_000;
    fs.utimesSync(old, oldMs / 1000, oldMs / 1000);
    fs.utimesSync(unrelated, oldMs / 1000, oldMs / 1000);
    fs.utimesSync(fresh, (now - 60_000) / 1000, (now - 60_000) / 1000);
    expect(await shared.cleanupPublishTemps(sharedDir, now)).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
    expect(await cleanupPublishTemps(path.join(root, 'nope'), now, t.host)).toBe(0);
  });

  it('keeps listed staged copies and the newest STAGED_KEEP others', async () => {
    const shas = Array.from({ length: 6 }, (_, i) => String(i).repeat(64));
    shas.forEach((s, i) => {
      const f = path.join(incoming, `${s}.conduit`);
      fs.writeFileSync(f, 'x');
      const ms = t.clock.now() - (10 - i) * 60_000;
      fs.utimesSync(f, ms / 1000, ms / 1000);
    });
    fs.writeFileSync(path.join(incoming, 'wal-123.conduit'), 'x');
    const keep = [shas[0] as string];
    const removed = await cleanupIncoming(incoming, keep, t.host);
    expect(removed).toBe(6 - 1 - STAGED_KEEP);
    const left = fs.readdirSync(incoming).sort();
    expect(left).toEqual([...[shas[0], shas[3], shas[4], shas[5]].map((s) => `${s}.conduit`), 'wal-123.conduit'].sort());
  });
});
