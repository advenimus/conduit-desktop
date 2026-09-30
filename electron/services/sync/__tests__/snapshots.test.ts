// @vitest-environment node
// Pre-merge snapshots (spec 5.10, 12 row 34): mass-change thresholds, the merge diff, diff.json
// on disk (never plaintext), ids, listing, and keep-last-5-for-30-days pruning.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SNAPSHOT_DB_FILE,
  SNAPSHOT_DIFF_FILE,
  SNAPSHOT_KEEP,
  SnapshotStore,
  diffMerge,
  isMassChange,
  type MergeDiff,
} from '../snapshots.js';
import { encodeValue } from '../value-codec.js';
import { makeTempRoot, makeTestSyncHost, type TestSyncHost } from './host-fakes.js';
import {
  HOUR_MS,
  IMPLICIT,
  MAC,
  NOW_MS,
  PC,
  apply,
  deleteWrites,
  ek,
  entryId,
  scratchDb,
  seedEntries,
  secretWrite,
  write,
} from './snapshots-fixtures.js';

const SHA_A = 'a1'.repeat(32);
const SHA_B = 'b2'.repeat(32);
const DAY_MS = 24 * HOUR_MS;

function diffOf(over: Partial<MergeDiff>): MergeDiff {
  return { liveBefore: 100, deleted: [], changed: [], changedRows: 0, byDeviceUuid: null, ...over };
}

function deletedRows(n: number): MergeDiff['deleted'] {
  return Array.from({ length: n }, (_, i) => ({ row: { tbl: 1 as const, rowId: `r${i}` }, title: '', values: {} }));
}

describe('isMassChange (5.10 thresholds)', () => {
  it('10 or more deleted rows is a mass change whatever the vault size', () => {
    expect(isMassChange(diffOf({ deleted: deletedRows(9), liveBefore: 1000 }))).toBe(false);
    expect(isMassChange(diffOf({ deleted: deletedRows(10), liveBefore: 1000 }))).toBe(true);
  });

  it('changed rows need 25 % of the live rows, and at least 10', () => {
    expect(isMassChange(diffOf({ liveBefore: 100, changedRows: 24 }))).toBe(false);
    expect(isMassChange(diffOf({ liveBefore: 100, changedRows: 25 }))).toBe(true);
    expect(isMassChange(diffOf({ liveBefore: 41, changedRows: 10 }))).toBe(false);
    expect(isMassChange(diffOf({ liveBefore: 41, changedRows: 11 }))).toBe(true);
    expect(isMassChange(diffOf({ liveBefore: 12, changedRows: 9 }))).toBe(false);
    expect(isMassChange(diffOf({ liveBefore: 12, changedRows: 10 }))).toBe(true);
  });
});

describe('diffMerge', () => {
  const before = seedEntries(12);

  it('records deleted rows with their values (secrets as ciphertext) and the deleting device', () => {
    const after = apply(before, deleteWrites([entryId(0), entryId(1)], MAC), MAC, NOW_MS);
    const diff = diffMerge(before, after, IMPLICIT);
    expect(diff.liveBefore).toBe(13);
    expect(diff.deleted.map((d) => d.row.rowId)).toEqual([entryId(0), entryId(1)]);
    expect(diff.deleted[0].title).toBe('server 0');
    const values = diff.deleted[0].values;
    expect(Object.keys(values).sort()).toEqual(['container', 'entry_type', 'host', 'name', 'password']);
    expect(values.host).toBe('10.0.0.0');
    expect(values.password).toEqual({ $b64: expect.any(String) });
    expect(diff.changed).toEqual([]);
    expect(diff.byDeviceUuid).toBe('device-mac');
  });

  it('records changed fields before and after, excluding _life, and counts distinct rows', () => {
    const writes = [
      write(ek(entryId(2), 'host'), 'new-host', MAC),
      write(ek(entryId(2), 'notes'), 'added', MAC),
      write(ek(entryId(3), 'host'), 'other-host', MAC),
      secretWrite(ek(entryId(4), 'password'), 'rotated', MAC),
    ];
    const after = apply(before, writes, MAC, NOW_MS);
    const diff = diffMerge(before, after, IMPLICIT);
    expect(diff.deleted).toEqual([]);
    expect(diff.changedRows).toBe(3);
    const byReg = diff.changed.map((c) => `${c.key.rowId}/${c.key.reg}`);
    expect(byReg).toEqual([`${entryId(2)}/host`, `${entryId(2)}/notes`, `${entryId(3)}/host`, `${entryId(4)}/password`]);
    expect(diff.changed[0]).toMatchObject({ before: '10.0.0.2', after: 'new-host', secret: false });
    expect(diff.changed[1]).toMatchObject({ before: null, after: 'added' });
    expect(diff.changed[3].secret).toBe(true);
  });

  it('a re-write of the same value is not a change; rows new in M are not counted', () => {
    const writes = [write(ek(entryId(5), 'host'), '10.0.0.5', MAC), write(ek('fresh', 'name'), 'fresh', MAC)];
    const after = apply(before, writes, MAC, NOW_MS);
    const diff = diffMerge(before, after, IMPLICIT);
    expect(diff.changed).toEqual([]);
    expect(diff.liveBefore).toBe(13);
  });

  it('has no single deleting device when two devices deleted rows', () => {
    const one = apply(before, deleteWrites([entryId(0)], MAC), MAC, NOW_MS);
    const two = apply(one, deleteWrites([entryId(1)], PC), PC, NOW_MS + 1);
    expect(diffMerge(before, two, IMPLICIT).byDeviceUuid).toBeNull();
  });

  it('diffs 5,000 entries with 42 deletes quickly', () => {
    const big = seedEntries(5000);
    const after = apply(big, deleteWrites(Array.from({ length: 42 }, (_, i) => entryId(i * 100)), MAC), MAC, NOW_MS);
    const t0 = performance.now();
    const diff = diffMerge(big, after, IMPLICIT);
    const elapsed = performance.now() - t0;
    expect(diff.deleted).toHaveLength(42);
    expect(isMassChange(diff)).toBe(true);
    expect(elapsed).toBeLessThan(300);
  });
});

describe('SnapshotStore', () => {
  let root: string;
  let t: TestSyncHost;
  let db: Database.Database;
  let store: SnapshotStore;
  let snapshotsDir: string;
  const before = seedEntries(12);
  const massDelete = diffMerge(before, apply(before, deleteWrites(Array.from({ length: 11 }, (_, i) => entryId(i)), MAC), MAC, NOW_MS), IMPLICIT);

  beforeEach(() => {
    root = makeTempRoot('snapshots');
    t = makeTestSyncHost(root);
    db = scratchDb(root);
    snapshotsDir = path.join(root, 'lineage', 'snapshots');
    store = new SnapshotStore(snapshotsDir, t.host);
  });

  afterEach(() => {
    db.close();
    expect(t.logger.unprefixed()).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const take = (sha = SHA_A) => store.take({ db, diff: massDelete, sourceSha256: sha, noticeId: 'notice-1', epochId: 'ep'.repeat(16) });

  it('writes a VACUUM INTO copy and diff.json {meta, diff} with value-codec values', async () => {
    const ref = await take();
    expect(ref.id).toBe(`${t.clock.now()}-${SHA_A.slice(0, 8)}`);
    expect(ref.dir).toBe(path.join(snapshotsDir, ref.id));
    const copy = new Database(path.join(ref.dir, SNAPSHOT_DB_FILE), { readonly: true });
    expect(copy.prepare('SELECT x FROM t').get()).toEqual({ x: 'hello' });
    copy.close();
    const json = JSON.parse(fs.readFileSync(path.join(ref.dir, SNAPSHOT_DIFF_FILE), 'utf8'));
    expect(json.meta).toEqual({
      id: ref.id,
      createdMs: t.clock.now(),
      sourceSha256: SHA_A,
      noticeId: 'notice-1',
      epochId: 'ep'.repeat(16),
      deleted: 11,
      changedRows: 0,
      byDeviceUuid: 'device-mac',
    });
    expect(json.diff).toEqual(JSON.parse(JSON.stringify(massDelete)));
    expect(json.diff.deleted[0].values.password).toEqual(encodeValue(Buffer.from(json.diff.deleted[0].values.password.$b64, 'base64')));
  });

  it('diff.json never contains plaintext secrets', async () => {
    const ref = await take();
    const text = fs.readFileSync(path.join(ref.dir, SNAPSHOT_DIFF_FILE), 'utf8');
    for (let i = 0; i < 12; i++) expect(text).not.toContain(`pw-${i}`);
    expect(text).toContain('$b64');
  });

  it('loadDiff round-trips; list is newest first; same millisecond and S gets a suffix', async () => {
    const a = await take();
    const b = await take();
    expect(b.id).toBe(`${a.id}-2`);
    await t.clock.advance(1000);
    const c = await take(SHA_B);
    expect((await store.list()).map((r) => r.id)).toEqual([c.id, b.id, a.id]);
    const loaded = await store.loadDiff(a.id);
    expect(loaded.meta).toEqual(a.meta);
    expect(loaded.diff).toEqual(JSON.parse(JSON.stringify(massDelete)));
  });

  it('keeps the 5 newest snapshots', async () => {
    const ids: string[] = [];
    for (let i = 0; i < SNAPSHOT_KEEP + 2; i++) {
      ids.push((await take()).id);
      await t.clock.advance(DAY_MS);
    }
    const listed = (await store.list()).map((r) => r.id);
    expect(listed).toEqual(ids.slice(2).reverse());
    expect(fs.readdirSync(snapshotsDir).sort()).toEqual([...ids.slice(2)].sort());
  });

  it('removes snapshots older than 30 days even among the 5 newest', async () => {
    const start = t.clock.now();
    for (let i = 0; i < 4; i++) {
      await take();
      await t.clock.advance(DAY_MS);
    }
    const removed = await store.prune(start + 30 * DAY_MS + DAY_MS);
    expect(removed).toBe(1);
    expect((await store.list()).map((r) => r.meta.createdMs)).toEqual([3, 2, 1].map((d) => start + d * DAY_MS));
  });

  it('prune removes leftover temp folders and old unreadable ones, keeps recent unreadable ones', async () => {
    await take();
    const now = t.clock.now();
    fs.mkdirSync(path.join(snapshotsDir, '.tmp-123-abcdef01'));
    const oldBroken = `${now - 31 * DAY_MS}-deadbeef`;
    const newBroken = `${now - DAY_MS}-deadbeef`;
    for (const name of [oldBroken, newBroken]) {
      fs.mkdirSync(path.join(snapshotsDir, name));
      fs.writeFileSync(path.join(snapshotsDir, name, SNAPSHOT_DIFF_FILE), '{broken');
    }
    fs.writeFileSync(path.join(snapshotsDir, 'README.txt'), 'not a snapshot');
    expect(await store.prune(now)).toBe(2);
    expect(fs.readdirSync(snapshotsDir).sort()).toEqual([`${now}-${SHA_A.slice(0, 8)}`, newBroken, 'README.txt'].sort());
    expect((await store.list()).map((r) => r.id)).toEqual([`${now}-${SHA_A.slice(0, 8)}`]);
    expect(t.logger.messages('warn')).toContain('[sync] snapshot unreadable');
  });

  it('a failed write leaves no folder behind and rethrows', async () => {
    t.fs.inject({ op: 'writeFileDurable', match: /diff\.json$/, code: 'ENOSPC' });
    await expect(take()).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(fs.readdirSync(snapshotsDir)).toEqual([]);
    expect(t.logger.messages('error')).toContain('[sync] snapshot failed');
  });

  it('a prune failure after a durable snapshot does not fail the take', async () => {
    t.fs.inject({ op: 'readdir', match: /snapshots$/, code: 'EIO' });
    const ref = await take();
    expect(fs.existsSync(path.join(ref.dir, SNAPSHOT_DIFF_FILE))).toBe(true);
    expect(t.logger.messages('warn')).toContain('[sync] snapshot prune failed');
    expect(t.logger.messages('error')).toContain('[sync] snapshots folder unreadable');
  });

  it('refuses invalid ids and unknown snapshots; an empty or missing folder lists nothing', async () => {
    expect(await store.list()).toEqual([]);
    expect(await store.prune(t.clock.now())).toBe(0);
    await expect(store.loadDiff('../../etc')).rejects.toThrow('[sync] snapshot id is invalid');
    await expect(store.loadDiff(`${t.clock.now()}-00000000`)).rejects.toThrow('[sync] snapshot not found');
    await expect(store.take({ db, diff: massDelete, sourceSha256: 'nope', noticeId: 'n', epochId: 'e' })).rejects.toThrow(
      '[sync] snapshot: invalid source SHA-256',
    );
  });

  it('rejects a diff.json whose content does not validate', async () => {
    const ref = await take();
    const file = path.join(ref.dir, SNAPSHOT_DIFF_FILE);
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    json.diff.deleted[0].row.tbl = 3;
    fs.writeFileSync(file, JSON.stringify(json));
    await expect(store.loadDiff(ref.id)).rejects.toThrow('[sync] snapshot diff.json is invalid: row.tbl');
    json.diff.deleted[0].row.tbl = 1;
    json.diff.changed = [{ key: { tbl: 1, rowId: 'x', reg: 'host' }, before: { $b64: 'AA', extra: 1 }, after: null, secret: false }];
    fs.writeFileSync(file, JSON.stringify(json));
    await expect(store.loadDiff(ref.id)).rejects.toThrow('[sync] snapshot diff.json is invalid: value');
    expect(await store.list()).toEqual([]);
  });
});
