// @vitest-environment node
// 5.10: the 'mass-change' notice (and its [Undo]) never exists without the pre-merge snapshot
// behind it. A take that fails records nothing and fails the merge; the retry takes it.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SnapshotStore } from '../snapshots.js';
import { assembleSyncEngine, nullSessionSignals } from '../sync-engine.js';
import { takeMassSnapshot, type MassSnapshotDeps } from '../sync-mass-snapshot.js';
import { rowLife } from '../state-view.js';
import { TBL, type LocalNotice, type SyncState } from '../types.js';
import { makeTempRoot, makeTestSyncHost, type TestSyncHost } from './host-fakes.js';
import { bindingFor, makeDevice, newVaultSeed, open, sha256 } from './replica-fixtures.js';
import { IMPLICIT, MAC, NOW_MS, RING, apply, deleteWrites, entryId, scratchDb, seedEntries } from './snapshots-fixtures.js';

const SHA = 'd4'.repeat(32);
const ISO = '2026-09-25T12:00:00.000Z';

describe('takeMassSnapshot', () => {
  let root: string;
  let t: TestSyncHost;
  let db: Database.Database;
  let notices: LocalNotice[];
  let deps: MassSnapshotDeps;
  let w: SyncState;
  let m: SyncState;

  beforeEach(() => {
    root = makeTempRoot('mass-snapshot');
    t = makeTestSyncHost(root);
    db = scratchDb(root);
    notices = [];
    deps = {
      replica: { implicit: () => IMPLICIT, database: () => db, ring: () => RING },
      snapshots: new SnapshotStore(path.join(root, 'snapshots'), t.host),
      notices: {
        list: () => notices,
        addFromCapture: (add) => {
          notices.push(...add);
          return add;
        },
      },
      host: t.host,
    };
    w = seedEntries(12);
    m = apply(w, deleteWrites(Array.from({ length: 12 }, (_, i) => entryId(i)), MAC), MAC, NOW_MS);
  });

  afterEach(() => {
    db.close();
    expect(t.logger.unprefixed()).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('records the notice only after the snapshot exists, and only once', async () => {
    t.fs.inject({ op: 'mkdir', match: /snapshots$/, code: 'ENOSPC' });
    await expect(takeMassSnapshot(deps, w, m, SHA)).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(notices).toEqual([]);
    expect(await takeMassSnapshot(deps, w, m, SHA)).toBe(true);
    const snaps = await deps.snapshots.list();
    expect(snaps).toHaveLength(1);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: 'mass-change', key: null, sourceSha256: SHA, count: 12 });
    expect(snaps[0]?.meta.noticeId).toBe(notices[0]?.id);
    expect(await takeMassSnapshot(deps, w, m, SHA)).toBe(true);
    expect(await deps.snapshots.list()).toHaveLength(1);
    expect(notices).toHaveLength(1);
  });

  it('takes the snapshot a stored notice is missing (a failure before this build)', async () => {
    notices.push({ id: 'old-notice', kind: 'mass-change', key: null, createdMs: 1, sourceSha256: SHA, count: 12 });
    expect(await takeMassSnapshot(deps, w, m, SHA)).toBe(true);
    const snaps = await deps.snapshots.list();
    expect(snaps.map((s) => s.meta.noticeId)).toEqual(['old-notice']);
    expect(notices).toHaveLength(1);
  });

  it('does nothing for a merge that is not a mass change', async () => {
    expect(await takeMassSnapshot(deps, w, w, SHA)).toBe(false);
    expect(await deps.snapshots.list()).toEqual([]);
    expect(notices).toEqual([]);
  });
});

describe('the cycle after a failed pre-merge snapshot', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot('mass-snapshot-cycle');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('commits the mass delete only with its snapshot', async () => {
    const sharedPath = path.join(root, 'cloud', 'Vault.conduit');
    fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
    const dA = makeDevice(root, { hw8: 'aaaaaaaa' });
    const nv = newVaultSeed(dA);
    const bA = bindingFor(sharedPath);
    const rA = (await open(dA, nv.lineageId, nv.key, nv.seed, bA)).replica;
    const eA = assembleSyncEngine({ host: dA.t.host, replica: rA, session: nullSessionSignals(), realpath: sharedPath });
    expect(await eA.publishInitial()).toBe(true);
    const bytes = fs.readFileSync(sharedPath);
    const dB = makeDevice(root, { hw8: 'bbbbbbbb' });
    const seed = { kind: 'adopt', sharedBytes: bytes, sharedSha256: sha256(bytes), sharedMtimeMs: fs.statSync(sharedPath).mtimeMs, holdLegacy: false } as const;
    const rB = (await open(dB, nv.lineageId, nv.key, seed, bindingFor(sharedPath, bA.fileId))).replica;
    const eB = assembleSyncEngine({ host: dB.t.host, replica: rB, session: nullSessionSignals(), realpath: sharedPath });
    try {
      const ids = Array.from({ length: 12 }, (_, i) => `m${i}`);
      const rows = ids.map((rowId) => ({ tbl: TBL.entries, rowId }));
      const wcA = dA.t.workingCopy.last();
      wcA.mutate((db) => {
        const st = db.prepare(`INSERT INTO entries (id, name, entry_type, config, created_at, updated_at) VALUES (?, ?, 'ssh', '{}', ?, ?)`);
        for (const id of ids) st.run(id, `S ${id}`, ISO, ISO);
      }, { rows, interactive: true });
      expect((await eA.runCycle('shared-changed')).kind).toBe('published');
      await eB.runCycle('shared-changed');
      wcA.mutate((db) => {
        for (const id of ids) db.prepare('DELETE FROM entries WHERE id = ?').run(id);
      }, { rows, interactive: true });
      expect((await eA.runCycle('shared-changed')).kind).toBe('published');

      dB.t.fs.inject({ op: 'mkdir', match: /snapshots$/, code: 'ENOSPC' });
      expect((await eB.runCycle('shared-changed')).kind).toBe('error');
      expect(rB.local().notices.filter((n) => n.kind === 'mass-change')).toEqual([]);
      expect(ids.every((id) => rowLife(rB.state(), { tbl: TBL.entries, rowId: id }) === 'live')).toBe(true);

      expect((await eB.runCycle('retry')).kind).toBe('up-to-date');
      const snaps = await eB.parts().snapshots.list();
      const notice = rB.local().notices.find((n) => n.kind === 'mass-change');
      expect(snaps).toHaveLength(1);
      expect(snaps[0]?.meta.noticeId).toBe(notice?.id);
      expect(ids.every((id) => rowLife(rB.state(), { tbl: TBL.entries, rowId: id }) === 'dead')).toBe(true);
    } finally {
      await eA.stop();
      await eB.stop();
      rA.close();
      rB.close();
    }
  });
});
