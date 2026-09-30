// @vitest-environment node
// 5.10 with 4.8: a mass delete that arrives together with a password change (S newer while
// running, S newer at unlock, concurrent changes, a 0.17 change) gets the same pre-merge
// snapshot and 'mass-change' notice as a plain merge, so [Undo] brings the items back with their
// passwords. Moving W to the new epoch alone is not a mass change.
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveKey } from '../../../vault/crypto.js';
import { decideUnlock } from '../../key-epoch.js';
import { SnapshotStore } from '../../snapshots.js';
import { adoptEpochAtOpen, enterNewPassword } from '../../sync-epoch.js';
import { SyncHarness } from './sync-harness.js';
import { LegacyDesktop } from './legacy-desktop.js';
import { fileSha, SCENARIO_TIMEOUT_MS } from './scenario-helpers.js';
import { open as openSecret, withCopy } from './vault-ops.js';
import type { Kdf } from '../../host.js';
import type { SnapshotStorePort } from '../../snapshots.js';
import type { HarnessDevice } from './harness-device.js';

const PBKDF2_TIMEOUT_MS = 30_000;
const IDS = Array.from({ length: 12 }, (_, i) => `m${i}`);

const realKdf: Kdf = { deriveKey: (password, saltB64) => deriveKey(password, Buffer.from(saltB64, 'base64')) };

let h: SyncHarness;

afterEach(async () => {
  for (const d of h.devices) expect(d.logger.unprefixed()).toEqual([]);
  expect(await h.dispose()).toEqual([]);
});

async function pairWithSecrets(label: string): Promise<[HarnessDevice, HarnessDevice]> {
  h = new SyncHarness(label);
  const a = await h.create({ name: 'mac', start: false });
  for (const id of IDS) a.insert({ id, password: `pw-${id}` });
  await h.syncAll();
  const b = await h.join({ name: 'pc', start: false });
  await h.syncAll();
  return [a, b];
}

function secret(d: HarnessDevice, id: string): string | null {
  return openSecret(d.replica.ring().current.kEpoch, (d.row(id)?.password_encrypted as Buffer | null) ?? null);
}

function metaOf(file: string): { salt: string; verification: string } {
  return withCopy(file, `${h.root}/peek`, (db) => {
    const get = (k: string) => (db.prepare('SELECT value FROM vault_meta WHERE key = ?').get(k) as { value: string }).value;
    return { salt: get('salt'), verification: get('verification') };
  });
}

/** A deletes the 12 items and changes the password in one go; B receives both. */
async function deleteAndRotateOnA(a: HarnessDevice, b: HarnessDevice, newPassword: string): Promise<void> {
  a.remove(IDS);
  a.replica.changePassword('pw', newPassword, false);
  expect((await a.sync()).kind).toBe('published');
  h.cloud.upload('mac');
  h.cloud.download('pc');
}

async function massNotices(d: HarnessDevice) {
  return d.replica.local().notices.filter((n) => n.kind === 'mass-change');
}

/** One snapshot under `epochId` behind one 'mass-change' notice, and Undo restores the 12 with their passwords. */
async function expectUndoable(d: HarnessDevice, epochId: string, sourceSha256: string): Promise<void> {
  expect(IDS.filter((id) => d.live(id))).toEqual([]);
  const snapshots = d.engine.parts().snapshots;
  const snaps = await snapshots.list();
  expect(snaps).toHaveLength(1);
  const snap = snaps[0];
  expect(snap.meta).toMatchObject({ deleted: IDS.length, changedRows: 0, epochId, sourceSha256 });
  expect(await massNotices(d)).toEqual([expect.objectContaining({ id: snap.meta.noticeId, count: IDS.length, sourceSha256 })]);
  const { replica } = d;
  const preview = await snapshots.undoPreview(snap.id, replica.state(), replica.implicit(), replica.ring());
  expect(preview.rows.filter((r) => r.stillDeleted)).toHaveLength(IDS.length);
  expect(preview.fields).toEqual([]);
  d.write(await snapshots.undoWrites(snap.id, replica.state(), { rows: preview.rows.map((r) => r.row), fields: [] }, replica.ring(), replica.context()));
  for (const id of IDS) expect(secret(d, id)).toBe(`pw-${id}`);
}

describe('password change plus mass delete (5.10 with 4.8)', { timeout: SCENARIO_TIMEOUT_MS }, () => {
  it('S newer while running: "Enter the new password" snapshots the mass delete first, and Undo works', async () => {
    const [a, b] = await pairWithSecrets('epoch-snap-newer');
    await deleteAndRotateOnA(a, b, 'pw2');
    expect(await b.sync()).toEqual({ kind: 'paused', reason: 'epoch-newer' });
    expect(await b.engine.parts().snapshots.list()).toEqual([]);
    const sha = fileSha(b.sharedPath);
    expect((await b.engine.enterNewPassword('pw2')).ok).toBe(true);
    await h.idle();
    expect(b.replica.ring().current.epochId).toBe(a.replica.ring().current.epochId);
    await expectUndoable(b, a.replica.ring().current.epochId, sha);
  });

  it('S newer while running, password change only: no snapshot and no mass-change notice', async () => {
    const [a, b] = await pairWithSecrets('epoch-snap-only');
    a.replica.changePassword('pw', 'pw2', false);
    expect((await a.sync()).kind).toBe('published');
    h.cloud.upload('mac');
    h.cloud.download('pc');
    expect(await b.sync()).toEqual({ kind: 'paused', reason: 'epoch-newer' });
    expect((await b.engine.enterNewPassword('pw2')).ok).toBe(true);
    await h.idle();
    expect(await b.engine.parts().snapshots.list()).toEqual([]);
    expect(await massNotices(b)).toEqual([]);
    for (const id of IDS) expect(secret(b, id)).toBe(`pw-${id}`);
  });

  it('an edit made while the snapshot is written survives: the merge is rebuilt from W as it is then', async () => {
    const [a, b] = await pairWithSecrets('epoch-snap-edit');
    await deleteAndRotateOnA(a, b, 'pw2');
    const s = h.peek(b.sharedPath);
    const shared = { file: s, meta: metaOf(b.sharedPath), sha256: fileSha(b.sharedPath), mtimeMs: fs.statSync(b.sharedPath).mtimeMs };
    const store = b.engine.parts().snapshots;
    let takes = 0;
    const snapshots: Pick<SnapshotStorePort, 'take' | 'list'> = {
      list: () => store.list(),
      take: async (input) => {
        takes++;
        const ref = await store.take(input);
        b.insert({ id: 'typed meanwhile', password: 'fresh' });
        return ref;
      },
    };
    const d = await enterNewPassword(b.replica, shared, 'pw2', b.host, { snapshots, notices: b.engine.parts().notices });
    expect(d.ok).toBe(true);
    expect(takes).toBe(1);
    expect(b.live('typed meanwhile')).toBe(true);
    expect(secret(b, 'typed meanwhile')).toBe('fresh');
    await expectUndoable(b, a.replica.ring().current.epochId, shared.sha256);
  });

  it('S newer at unlock: adopting the epoch at open snapshots the mass delete first', async () => {
    const [a, b] = await pairWithSecrets('epoch-snap-open');
    await b.lock();
    await deleteAndRotateOnA(a, b, 'pw2');
    const s = h.peek(b.sharedPath);
    const meta = metaOf(b.sharedPath);
    const newKey = b.host.kdf.deriveKey('pw2', meta.salt);
    await b.open(b.lineageId, newKey, { kind: 'existing' }, null);
    expect(b.replica.epochAligned()).toBe(false);
    const unlock = decideUnlock({
      lineageId: b.lineageId,
      deriveFromSalt: (salt) => b.host.kdf.deriveKey('pw2', salt),
      w: b.state(),
      s: { state: s.state, meta },
    });
    if (!unlock.decision.ok) throw new Error('the new password was refused');
    const sha = fileSha(b.sharedPath);
    await adoptEpochAtOpen(
      {
        replica: b.replica,
        shared: { file: s, meta, sha256: sha, mtimeMs: fs.statSync(b.sharedPath).mtimeMs },
        decision: unlock.decision,
        key: newKey,
        previousKey: null,
        sideFilesPresent: false,
        serverSideFilesFlagRecent: false,
        snapshots: new SnapshotStore(b.replica.paths.snapshots, b.host),
      },
      b.host,
    );
    expect(b.replica.epochAligned()).toBe(true);
    await expectUndoable(b, a.replica.ring().current.epochId, sha);
  });

  it('concurrent changes: resolving to the other password snapshots its mass delete first', async () => {
    const [a, b] = await pairWithSecrets('epoch-snap-concurrent');
    a.remove(IDS);
    a.replica.changePassword('pw', 'pwA', false);
    b.replica.changePassword('pw', 'pwB', false);
    const aEpoch = a.replica.ring().current.epochId;
    expect((await a.sync()).kind).toBe('published');
    expect((await b.sync()).kind).toBe('published');
    h.cloud.upload('mac');
    h.cloud.download('pc');
    expect(await b.sync()).toEqual({ kind: 'paused', reason: 'epoch-concurrent' });
    const sha = fileSha(b.sharedPath);
    await b.engine.resolveConcurrentEpoch('pwA', aEpoch);
    await h.idle();
    expect(b.replica.ring().current.epochId).toBe(aEpoch);
    await expectUndoable(b, aEpoch, sha);
  });

  it(
    'a 0.17 password change that also deleted 12 items: adopting it snapshots the deletes first',
    async () => {
      h = new SyncHarness('epoch-snap-legacy');
      const a = await h.create({ name: 'mac', start: false, kdf: realKdf }, 'old');
      for (const id of IDS) a.insert({ id, password: `pw-${id}` });
      expect((await a.sync()).kind).toBe('published');
      h.cloud.upload('mac');
      h.cloud.download('win017');
      const legacy = new LegacyDesktop(h.cloud.sharedPath('win017'), h.requireVault().key, () => h.clock.now());
      legacy.changePassword('old', 'new');
      legacy.edit((v) => IDS.forEach((id) => v.deleteEntry(id)));
      legacy.close();
      h.cloud.upload('win017');
      h.cloud.download('mac');
      expect(await a.sync()).toEqual({ kind: 'paused', reason: 'epoch-legacy' });
      const sha = fileSha(a.sharedPath);
      await a.engine.adoptLegacyPasswordChange('new', 'old');
      await h.idle();
      await expectUndoable(a, a.replica.ring().current.epochId, sha);
    },
    PBKDF2_TIMEOUT_MS,
  );
});
