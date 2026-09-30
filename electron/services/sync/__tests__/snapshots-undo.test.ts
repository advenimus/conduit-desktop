// @vitest-environment node
// Targeted undo (spec 5.10, red team #5, 12 row 43): only the rows the merge deleted and still
// dead are re-created, with the snapshot's values; a changed field is reverted only while it
// still holds the merged value; nothing else changes. One interactive dot.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSecret } from '../key-epoch.js';
import { merge } from '../merge.js';
import { deletePermanently, restoreWrites } from '../tombstones.js';
import { SnapshotStore, countUndone, diffMerge, isMassChange } from '../snapshots.js';
import type { SyncState } from '../types.js';
import { makeTempRoot, makeTestSyncHost, type TestSyncHost } from './host-fakes.js';
import {
  HOUR_MS,
  IMPLICIT,
  MAC,
  ME,
  NOW_MS,
  PC,
  RING,
  apply,
  deleteWrites,
  ek,
  entry,
  entryId,
  hostOf,
  isLive,
  passwordOf,
  scratchDb,
  secretWrite,
  seedEntries,
  write,
} from './snapshots-fixtures.js';

const SHA = 'c3'.repeat(32);

function passwordsOf(state: SyncState, id: string): string[] {
  const sibs = state.rows.get(`1:${id}`)?.regs.get('password')?.sibs ?? [];
  return sibs
    .map((s) => {
      const read = readSecret(s.value as Uint8Array, RING);
      return read.kind === 'undecryptable' ? '?' : read.plaintext;
    })
    .sort();
}

function hostsOf(state: SyncState, id: string): string[] {
  return (state.rows.get(`1:${id}`)?.regs.get('host')?.sibs ?? []).map((s) => String(s.value)).sort();
}

describe('targeted undo', () => {
  let root: string;
  let t: TestSyncHost;
  let db: Database.Database;
  let store: SnapshotStore;

  beforeEach(() => {
    root = makeTempRoot('snapshots-undo');
    t = makeTestSyncHost(root);
    db = scratchDb(root);
    store = new SnapshotStore(`${root}/snapshots`, t.host);
  });

  afterEach(() => {
    db.close();
    expect(t.logger.unprefixed()).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function snapshotOf(before: SyncState, after: SyncState): Promise<string> {
    const diff = diffMerge(before, after, IMPLICIT);
    expect(isMassChange(diff)).toBe(true);
    return (await store.take({ db, diff, sourceSha256: SHA, noticeId: 'n1', epochId: RING.current.epochId })).id;
  }

  it('re-creates only the rows that merge deleted and are still dead, with their values', async () => {
    const before = seedEntries(14);
    const deleted = Array.from({ length: 11 }, (_, i) => entryId(i));
    const merged = apply(before, deleteWrites(deleted, MAC), MAC, NOW_MS);
    const id = await snapshotOf(before, merged);
    // Two days later: someone restored e003 already, and an unrelated row was edited.
    const restored = apply(merged, restoreWrites(merged, [entry(entryId(3))], ME), ME, NOW_MS + 48 * HOUR_MS);
    const current = apply(restored, [write(ek(entryId(12), 'host'), 'edited later', PC)], PC, NOW_MS + 49 * HOUR_MS);

    const preview = await store.undoPreview(id, current, IMPLICIT, RING);
    expect(preview.rows.map((r) => r.row.rowId)).toEqual(deleted);
    expect(preview.rows.filter((r) => !r.stillDeleted).map((r) => r.row.rowId)).toEqual([entryId(3)]);
    expect(preview.rows[0].title).toBe('server 0');
    expect(preview.fields).toEqual([]);

    const writes = await store.undoWrites(id, current, { rows: preview.rows.map((r) => r.row), fields: [] }, RING, ME);
    expect(new Set(writes.map((w) => w.key.rowId))).toEqual(new Set(deleted.filter((d) => d !== entryId(3))));
    expect(writes.filter((w) => w.key.reg === '_life').every((w) => w.mode === 'replace-all')).toBe(true);
    expect(writes.filter((w) => w.key.reg !== '_life').every((w) => w.mode === 'replace-provisional')).toBe(true);
    expect(writes.length).toBeGreaterThan(10);
    expect(countUndone(writes)).toBe(10);
    const undone = apply(current, writes, ME, NOW_MS + 50 * HOUR_MS);
    for (let i = 0; i < 11; i++) {
      expect(isLive(undone, entryId(i))).toBe(true);
      expect(passwordOf(undone, entryId(i))).toBe(`pw-${i}`);
      expect(hostOf(undone, entryId(i))).toBe(`10.0.0.${i}`);
    }
    expect(hostOf(undone, entryId(12))).toBe('edited later');
    expect(undone.rows.get(`1:${entryId(13)}`)).toBe(current.rows.get(`1:${entryId(13)}`));
    expect(t.logger.messages('info')).toContain('[sync] undo skipped choices with nothing to undo');
  });

  it('never brings back rows the user deleted permanently since the snapshot', async () => {
    const before = seedEntries(14);
    const deleted = Array.from({ length: 12 }, (_, i) => entryId(i));
    const merged = apply(before, deleteWrites(deleted, MAC), MAC, NOW_MS);
    const id = await snapshotOf(before, merged);
    const erased = [entryId(2), entryId(5)];
    const current = deletePermanently(merged, erased.map(entry));

    const preview = await store.undoPreview(id, current, IMPLICIT, RING);
    expect(preview.rows.map((r) => r.row.rowId)).toEqual(deleted.filter((d) => !erased.includes(d)));

    const all = { rows: deleted.map(entry), fields: [] };
    const writes = await store.undoWrites(id, current, all, RING, ME);
    expect(writes.some((w) => erased.includes(w.key.rowId))).toBe(false);
    const undone = apply(current, writes, ME, NOW_MS + HOUR_MS);
    for (const e of erased) expect(isLive(undone, e)).toBe(false);
    expect(isLive(undone, entryId(0))).toBe(true);
  });

  it('re-creating a deleted row keeps the conflicts its tombstone still holds (4.7)', async () => {
    const base = seedEntries(12);
    const id0 = entryId(0);
    const mac = apply(base, [secretWrite(ek(id0, 'password'), 'mac-pw', MAC), write(ek(id0, 'host'), 'mac-host', MAC)], MAC, NOW_MS - 5 * HOUR_MS);
    const pc = apply(base, [secretWrite(ek(id0, 'password'), 'pc-pw', PC), write(ek(id0, 'host'), 'pc-host', PC)], PC, NOW_MS - 5 * HOUR_MS + 1);
    const w = merge(mac, pc, IMPLICIT).state;
    expect(passwordsOf(w, id0)).toEqual(['mac-pw', 'pc-pw']);
    const ids = Array.from({ length: 12 }, (_, i) => entryId(i));
    const merged = merge(w, apply(w, deleteWrites(ids, PC), PC, NOW_MS - HOUR_MS), IMPLICIT).state;
    expect(passwordsOf(merged, id0)).toEqual(['mac-pw', 'pc-pw']);
    const id = await snapshotOf(w, merged);

    const writes = await store.undoWrites(id, merged, { rows: [entry(id0)], fields: [] }, RING, ME);
    const undone = apply(merged, writes, ME, NOW_MS);
    expect(isLive(undone, id0)).toBe(true);
    expect(passwordsOf(undone, id0)).toEqual(['mac-pw', 'pc-pw']);
    expect(hostsOf(undone, id0)).toEqual(['mac-host', 'pc-host']);
    expect(passwordOf(undone, id0)).toBe('pc-pw');
  });

  it('reverts a changed field only while it still holds the merged value', async () => {
    // 39 entries + 1 folder: 10 changed rows is exactly 25 %.
    const before = seedEntries(39);
    const changedIds = Array.from({ length: 10 }, (_, i) => entryId(i));
    const merged = apply(
      before,
      [...changedIds.map((id) => write(ek(id, 'host'), `moved-${id}`, MAC)), secretWrite(ek(entryId(5), 'password'), 'mac-pw', MAC)],
      MAC,
      NOW_MS,
    );
    const id = await snapshotOf(before, merged);
    // Later: e001's host edited again here, e002 deleted elsewhere, e009's host re-typed to the same value.
    let current = apply(merged, [write(ek(entryId(1), 'host'), 'mine', ME)], ME, NOW_MS + HOUR_MS);
    current = apply(current, deleteWrites([entryId(2)], PC), PC, NOW_MS + 2 * HOUR_MS);
    current = apply(current, [write(ek(entryId(9), 'host'), `moved-${entryId(9)}`, PC)], PC, NOW_MS + 3 * HOUR_MS);

    const preview = await store.undoPreview(id, current, IMPLICIT, RING);
    const stale = preview.fields.filter((f) => !f.stillMerged).map((f) => f.key.rowId);
    expect(stale).toEqual([entryId(1), entryId(2)]);
    const secret = preview.fields.find((f) => f.key.reg === 'password');
    expect(secret).toMatchObject({ label: 'Password', secret: true, stillMerged: true });

    const writes = await store.undoWrites(id, current, { rows: [], fields: preview.fields.map((f) => f.key) }, RING, ME);
    expect(writes).toHaveLength(9);
    expect(countUndone(writes)).toBe(9);
    const undone = apply(current, writes, ME, NOW_MS + 4 * HOUR_MS);
    for (const i of [0, 3, 4, 5, 6, 7, 8, 9]) expect(hostOf(undone, entryId(i))).toBe(`10.0.0.${i}`);
    expect(hostOf(undone, entryId(1))).toBe('mine');
    expect(isLive(undone, entryId(2))).toBe(false);
    expect(passwordOf(undone, entryId(5))).toBe('pw-5');
    expect(hostOf(undone, entryId(20))).toBe('10.0.0.20');
  });

  it('a secret re-encrypted since the merge counts as merged only when the ring shows the same plaintext', async () => {
    const before = seedEntries(10);
    const rotated = Array.from({ length: 10 }, (_, i) => secretWrite(ek(entryId(i), 'password'), `mac-${i}`, MAC));
    const merged = apply(before, rotated, MAC, NOW_MS);
    const id = await snapshotOf(before, merged);
    // Same plaintext, new ciphertext (fresh nonce) for e000; a different password for e001.
    const current = apply(
      merged,
      [secretWrite(ek(entryId(0), 'password'), 'mac-0', ME), secretWrite(ek(entryId(1), 'password'), 'mine', ME)],
      ME,
      NOW_MS + HOUR_MS,
    );
    const noRing = await store.undoPreview(id, current, IMPLICIT);
    expect(noRing.fields.filter((f) => !f.stillMerged).map((f) => f.key.rowId)).toEqual([entryId(0), entryId(1)]);
    const withRing = await store.undoPreview(id, current, IMPLICIT, RING);
    expect(withRing.fields.filter((f) => !f.stillMerged).map((f) => f.key.rowId)).toEqual([entryId(1)]);

    const writes = await store.undoWrites(id, current, { rows: [], fields: withRing.fields.map((f) => f.key) }, RING, ME);
    const undone = apply(current, writes, ME, NOW_MS + 2 * HOUR_MS);
    expect(passwordOf(undone, entryId(0))).toBe('pw-0');
    expect(passwordOf(undone, entryId(1))).toBe('mine');
  });

  it('skips a snapshot secret no ring key can open, and choices outside the snapshot', async () => {
    const before = seedEntries(12);
    const deleted = Array.from({ length: 10 }, (_, i) => entryId(i));
    const merged = apply(before, deleteWrites(deleted, MAC), MAC, NOW_MS);
    const id = await snapshotOf(before, merged);
    const otherRing = { current: { ...RING.current, kEpoch: Buffer.alloc(32, 99) }, byEpoch: new Map() };
    const choice = { rows: [entry(entryId(0)), entry('not-in-snapshot')], fields: [ek(entryId(11), 'host')] };
    const writes = await store.undoWrites(id, merged, choice, otherRing, ME);
    expect(writes.map((w) => w.key.reg).sort()).toEqual(['_life', 'container', 'entry_type', 'host', 'name']);
    expect(t.logger.entries.find((e) => e.message === '[sync] undo skipped secrets no key could open')?.meta).toEqual({ id, count: 1 });
    expect(t.logger.entries.find((e) => e.message === '[sync] undo skipped choices with nothing to undo')?.meta).toEqual({ id, count: 2 });
  });
});
