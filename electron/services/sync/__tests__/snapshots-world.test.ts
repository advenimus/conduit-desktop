// @vitest-environment node
// T-FS-34 and T-FS-43 on real vault files: a real mass delete of 42 items made on another
// device is snapshotted (VACUUM INTO of W before the merge, diff.json without plaintext), and
// Undo two days later re-creates only those 42 with their passwords; a later edit elsewhere
// stays, and the other device gets the items back through the normal sync.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureLegacy } from '../capture-legacy.js';
import { makeImplicitProvider } from '../hashing.js';
import { alignEpoch, requireCurrentEpoch } from '../key-epoch.js';
import { merge } from '../merge.js';
import { SNAPSHOT_DB_FILE, SNAPSHOT_DIFF_FILE, SnapshotStore, diffMerge, isMassChange } from '../snapshots.js';
import { recoveryFrom } from '../state-view.js';
import type { SyncState } from '../types.js';
import type { SimDevice } from './core-e2e-harness.js';
import { entryRow } from './core-e2e-fixtures.js';
import { readSharedFile } from './core-e2e-io.js';
import { makeTestSyncHost } from './host-fakes.js';
import { advance, converge, setupWorld, teardownWorld, type World } from './sim-world.js';

const MASS = 42;
const TWO_DAYS_MS = 48 * 60 * 60 * 1000;

let w: World | null = null;
afterEach(() => {
  teardownWorld(w);
  w = null;
});

/** The engine's merge of S into W, computed but not committed (the snapshot must precede the commit). */
function mergeFromShared(dev: SimDevice, sharedPath: string): { readonly merged: SyncState; readonly sha256: string } {
  const s = readSharedFile(dev.dir, sharedPath);
  const keys = dev.keys.byEpoch.get(requireCurrentEpoch(s.file.state, 'shared'));
  if (keys === undefined) throw new Error('no key for the shared epoch');
  const input = { state: s.file.state, content: s.file.content, cache: s.file.cache, implicit: makeImplicitProvider(keys.kSync) };
  const att = {
    kind: 'legacy',
    observedMtimeMs: s.mtimeMs,
    sideFilesPresent: false,
    serverSideFilesFlagRecent: false,
    absorbKeys: keys,
    sourceSha256: s.sha256,
    recover: recoveryFrom(dev.state),
  } as const;
  const absorbed = captureLegacy(input, att, dev.ctx);
  const aligned = alignEpoch(absorbed.state, s.meta, dev.state, dev.keys);
  if (aligned.kind !== 'proceed') throw new Error(`unexpected epoch relation ${aligned.kind}`);
  return { merged: merge(dev.state, aligned.state, dev.implicit).state, sha256: s.sha256 };
}

describe('T-FS-34 / T-FS-43: mass delete snapshot and targeted undo', { timeout: 30_000 }, () => {
  it('snapshots 42 remote deletes and undoes exactly those two days later', async () => {
    w = setupWorld();
    const { a, b } = w;
    const { web } = w.fixture.ids;
    const ids: string[] = [];
    advance(w);
    a.edit((v) => {
      for (let i = 0; i < MASS; i++) {
        ids.push(v.createEntry({ name: `old ${i}`, entry_type: 'ssh', host: `192.168.1.${i}`, username: 'ops', password: `old-pw-${i}` }).id);
      }
    });
    converge(w);
    expect(b.vault.getEntry(ids[7]).password).toBe('old-pw-7');

    advance(w);
    a.edit((v) => ids.forEach((id) => v.deleteEntry(id)), true);
    a.publish(w.shared);
    advance(w, 1000);
    expect(b.fullPass()).toBe(false);
    const { merged, sha256 } = mergeFromShared(b, w.shared);
    const diff = diffMerge(b.state, merged, b.implicit);
    expect(diff.deleted).toHaveLength(MASS);
    expect(diff.changedRows).toBe(0);
    expect(diff.byDeviceUuid).toBe(a.deviceUuid);
    expect(isMassChange(diff)).toBe(true);

    const t = makeTestSyncHost(w.root);
    const store = new SnapshotStore(path.join(w.root, 'b-snapshots'), t.host);
    const ref = await store.take({ db: b.db, diff, sourceSha256: sha256, noticeId: 'notice-42', epochId: b.keys.current.epochId });
    b.commit(merged);
    expect(entryRow(b.db, ids[0])).toBeUndefined();

    const copy = new Database(path.join(ref.dir, SNAPSHOT_DB_FILE), { readonly: true });
    const saved = copy.prepare(`SELECT COUNT(*) AS n FROM entries WHERE id IN (${ids.map(() => '?').join(',')})`).get(...ids) as { n: number };
    copy.close();
    expect(saved.n).toBe(MASS);
    const text = fs.readFileSync(path.join(ref.dir, SNAPSHOT_DIFF_FILE), 'utf8');
    for (let i = 0; i < MASS; i++) expect(text).not.toContain(`old-pw-${i}`);
    expect(ref.meta).toMatchObject({ deleted: MASS, byDeviceUuid: a.deviceUuid, sourceSha256: sha256, noticeId: 'notice-42' });

    advance(w, TWO_DAYS_MS);
    b.edit((v) => v.updateEntry(web, { host: '10.9.9.9' }), true);
    const preview = await store.undoPreview(ref.id, b.state, b.implicit, b.keys);
    expect(preview.rows).toHaveLength(MASS);
    expect(preview.rows.every((r) => r.stillDeleted)).toBe(true);
    expect(preview.fields).toEqual([]);

    const writes = await store.undoWrites(ref.id, b.state, { rows: preview.rows.map((r) => r.row), fields: [] }, b.keys, b.ctx);
    expect(new Set(writes.map((x) => x.key.rowId))).toEqual(new Set(ids));
    b.write(writes);
    for (let i = 0; i < MASS; i++) {
      expect(b.vault.getEntry(ids[i])).toMatchObject({ name: `old ${i}`, host: `192.168.1.${i}`, username: 'ops', password: `old-pw-${i}` });
    }
    expect(entryRow(b.db, web)).toMatchObject({ host: '10.9.9.9' });

    converge(w);
    expect(a.vault.getEntry(ids[41]).password).toBe('old-pw-41');
    expect(entryRow(a.db, web)).toMatchObject({ host: '10.9.9.9' });
    expect(t.logger.unprefixed()).toEqual([]);
  });
});
