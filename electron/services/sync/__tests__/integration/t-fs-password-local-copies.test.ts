// @vitest-environment node
// 4.8 after a password change on this device: the copies it keeps beside W stop opening with the
// old password. Snapshot diffs are re-encrypted under the new epoch and their copies of W removed
// (Undo still works for rows and fields); genesis.conduit, quarantine/ and the staged copies of S
// in incoming/ are removed, including the pre-change S the next cycle stages before it publishes.
// W, local.json and the shared file stay. A copy that cannot be removed only logs.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSecret, verifyKey } from '../../key-epoch.js';
import { SNAPSHOT_DIFF_FILE, SNAPSHOT_DB_FILE } from '../../snapshots.js';
import { decodeValue, type EncodedValue } from '../../value-codec.js';
import { SyncHarness } from './sync-harness.js';
import { fileSha, SCENARIO_TIMEOUT_MS } from './scenario-helpers.js';
import { withCopy } from './vault-ops.js';
import type { HarnessDevice } from './harness-device.js';

const IDS = Array.from({ length: 12 }, (_, i) => `m${i}`);

let h: SyncHarness;

afterEach(async () => {
  for (const d of h.devices) expect(d.logger.unprefixed()).toEqual([]);
  expect(await h.dispose()).toEqual([]);
});

/** B makes a mass change (`change`) and A merges it: A holds one pre-merge snapshot under the old epoch. */
async function massSnapshotOnA(label: string, change: (b: HarnessDevice) => void): Promise<HarnessDevice> {
  h = new SyncHarness(label);
  const a = await h.create({ name: 'mac', start: false });
  for (const id of IDS) a.insert({ id, password: `pw-${id}` });
  await h.syncAll();
  const b = await h.join({ name: 'pc', start: false });
  await h.syncAll();
  change(b);
  await h.syncAll();
  const snaps = await a.engine.parts().snapshots.list();
  expect(snaps).toHaveLength(1);
  expect(fs.existsSync(path.join(snaps[0].dir, SNAPSHOT_DB_FILE))).toBe(true);
  return a;
}

function secret(d: HarnessDevice, id: string): string | null {
  const ct = (d.row(id)?.password_encrypted as Buffer | null) ?? null;
  return ct === null ? null : (openSecret(ct, d.replica.ring().current.kEpoch)?.toString('utf8') ?? null);
}

function plain(enc: EncodedValue | undefined, key: Buffer): string | null {
  const ct = decodeValue(enc ?? null);
  if (!(ct instanceof Uint8Array)) throw new Error('expected a ciphertext');
  return openSecret(ct, key)?.toString('utf8') ?? null;
}

/** Vault files in `dir` whose vault_meta verification the key opens. */
function openedBy(dir: string, key: Buffer): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.conduit'))
    .filter((name) =>
      withCopy(path.join(dir, name), `${h.root}/peek`, (db) => {
        const row = db.prepare("SELECT value FROM vault_meta WHERE key = 'verification'").get() as { value: string } | undefined;
        return row !== undefined && verifyKey(key, row.value);
      }),
    );
}

describe('local copies after a password change (4.8, 5.10)', { timeout: SCENARIO_TIMEOUT_MS }, () => {
  it('re-encrypts snapshot diffs under the new password and drops their copies of W; Undo restores the deleted items', async () => {
    const a = await massSnapshotOnA('copies-snap-rows', (b) => b.remove(IDS));
    const oldKey = a.replica.ring().current.kEpoch;
    const store = a.engine.parts().snapshots;
    const [before] = await store.list();
    await a.engine.changePassword('pw', 'pw2', false);
    await h.idle();
    const ring = a.replica.ring();
    const [after] = await store.list();
    expect(after.meta).toEqual({ ...before.meta, epochId: ring.current.epochId });
    expect(fs.readdirSync(after.dir)).toEqual([SNAPSHOT_DIFF_FILE]);
    const { diff } = await store.loadDiff(after.id);
    expect(diff.deleted).toHaveLength(IDS.length);
    for (const r of diff.deleted) {
      expect(plain(r.values.password, oldKey)).toBeNull();
      expect(plain(r.values.password, ring.current.kEpoch)).toBe(`pw-${r.row.rowId}`);
    }
    const preview = await store.undoPreview(after.id, a.state(), a.replica.implicit(), ring);
    expect(preview.rows.filter((r) => r.stillDeleted)).toHaveLength(IDS.length);
    a.write(await store.undoWrites(after.id, a.state(), { rows: preview.rows.map((r) => r.row), fields: [] }, ring, a.replica.context()));
    for (const id of IDS) expect(secret(a, id)).toBe(`pw-${id}`);
  });

  it('re-encrypts changed secret fields too; Undo still sees them as merged and sets the old passwords back', async () => {
    const a = await massSnapshotOnA('copies-snap-fields', (b) => IDS.forEach((id) => b.update(id, { password: `new-${id}` })));
    const oldKey = a.replica.ring().current.kEpoch;
    const store = a.engine.parts().snapshots;
    await a.engine.changePassword('pw', 'pw2', false);
    await h.idle();
    const ring = a.replica.ring();
    const [snap] = await store.list();
    const { diff } = await store.loadDiff(snap.id);
    expect(diff.changed.filter((c) => c.secret)).toHaveLength(IDS.length);
    for (const c of diff.changed) {
      expect(plain(c.before, oldKey)).toBeNull();
      expect(plain(c.after, oldKey)).toBeNull();
      expect(plain(c.before, ring.current.kEpoch)).toBe(`pw-${c.key.rowId}`);
      expect(plain(c.after, ring.current.kEpoch)).toBe(`new-${c.key.rowId}`);
    }
    const preview = await store.undoPreview(snap.id, a.state(), a.replica.implicit(), ring);
    expect(preview.fields.filter((f) => f.stillMerged)).toHaveLength(IDS.length);
    a.write(await store.undoWrites(snap.id, a.state(), { rows: [], fields: preview.fields.map((f) => f.key) }, ring, a.replica.context()));
    for (const id of IDS) expect(secret(a, id)).toBe(`pw-${id}`);
  });

  it('removes genesis.conduit, quarantine/ and every staged copy the old password opens; W, local.json and S stay', async () => {
    h = new SyncHarness('copies-files');
    const a = await h.create({ name: 'mac', start: false });
    a.insert({ id: 'e1', password: 'secret' });
    expect((await a.sync()).kind).toBe('published');
    expect((await a.sync()).kind).toBe('up-to-date');
    const { paths } = a.replica;
    const oldKey = a.replica.ring().current.kEpoch;
    fs.copyFileSync(a.sharedPath, paths.genesis);
    fs.mkdirSync(paths.quarantine, { recursive: true });
    fs.copyFileSync(a.sharedPath, path.join(paths.quarantine, `${a.now()}-${fileSha(a.sharedPath).slice(0, 8)}.conduit`));
    expect(openedBy(paths.incoming, oldKey).length).toBeGreaterThan(0);
    const published = fileSha(a.sharedPath);

    await a.engine.changePassword('pw', 'pw2', false);
    await h.idle();

    expect(fs.existsSync(paths.genesis)).toBe(false);
    expect(fs.readdirSync(paths.quarantine)).toEqual([]);
    expect(fileSha(a.sharedPath)).not.toBe(published);
    expect(openedBy(paths.incoming, oldKey)).toEqual([]);
    expect(openedBy(path.dirname(a.sharedPath), oldKey)).toEqual([]);
    expect(fs.existsSync(paths.working)).toBe(true);
    expect(fs.existsSync(paths.local)).toBe(true);
    expect(secret(a, 'e1')).toBe('secret');
  });

  it('a wrong current password changes nothing and keeps every copy', async () => {
    const a = await massSnapshotOnA('copies-wrong', (b) => b.remove(IDS));
    fs.copyFileSync(a.sharedPath, a.replica.paths.genesis);
    const epoch = a.replica.ring().current.epochId;
    const store = a.engine.parts().snapshots;
    const [before] = await store.list();
    await expect(a.engine.changePassword('not it', 'pw2', false)).rejects.toThrow();
    expect(a.replica.ring().current.epochId).toBe(epoch);
    expect(await store.list()).toEqual([before]);
    expect(fs.existsSync(path.join(before.dir, SNAPSHOT_DB_FILE))).toBe(true);
    expect(fs.existsSync(a.replica.paths.genesis)).toBe(true);
  });

  it('a copy that cannot be removed is logged and the password change still succeeds', async () => {
    h = new SyncHarness('copies-fault');
    const a = await h.create({ name: 'mac', start: false });
    expect((await a.sync()).kind).toMatch(/published|up-to-date/);
    fs.copyFileSync(a.sharedPath, a.replica.paths.genesis);
    const epoch = a.replica.ring().current.epochId;
    a.fs.inject({ op: 'rm', match: /genesis\.conduit$/, code: 'EACCES' });
    await a.engine.changePassword('pw', 'pw2', false);
    await h.idle();
    expect(a.replica.ring().current.epochId).not.toBe(epoch);
    expect(fs.existsSync(a.replica.paths.genesis)).toBe(true);
    expect(a.logger.entries.some((e) => e.level === 'warn' && e.message.includes('genesis.conduit'))).toBe(true);
  });
});
