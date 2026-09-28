// @vitest-environment node
// 4.8: adopting a password change made on another device (new password entered while running,
// at unlock, concurrent changes, a 0.17 change) moves this device's private copies off the old
// password the same way a local change does: snapshot diffs re-encrypted and their copies of W
// removed, genesis.conduit, quarantine/, sidefiles-<ts>/ and staged copies removed. At unlock
// there is no engine yet, so local.json notes it and the engine does it when it starts.
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveKey } from '../../../vault/crypto.js';
import { decideUnlock } from '../../key-epoch.js';
import { SnapshotStore } from '../../snapshots.js';
import { adoptEpochAtOpen } from '../../sync-epoch.js';
import { SyncHarness } from './sync-harness.js';
import { LegacyDesktop } from './legacy-desktop.js';
import { expectSealed, plantCopies } from './local-copies-helpers.js';
import { fileSha, SCENARIO_TIMEOUT_MS } from './scenario-helpers.js';
import { withCopy } from './vault-ops.js';
import type { Kdf } from '../../host.js';
import type { HarnessDevice } from './harness-device.js';

const PBKDF2_TIMEOUT_MS = 30_000;
const IDS = Array.from({ length: 12 }, (_, i) => `m${i}`);
const realKdf: Kdf = { deriveKey: (password, saltB64) => deriveKey(password, Buffer.from(saltB64, 'base64')) };

let h: SyncHarness;

afterEach(async () => {
  for (const d of h.devices) expect(d.logger.unprefixed()).toEqual([]);
  expect(await h.dispose()).toEqual([]);
});

function scratch(): string {
  return `${h.root}/peek`;
}

/** A and B share a vault; A deleted 12 items, so B holds a pre-merge snapshot under the old key, plus planted copies. */
async function pairWithCopiesOnB(label: string): Promise<{ a: HarnessDevice; b: HarnessDevice; oldKey: Buffer }> {
  h = new SyncHarness(label);
  const a = await h.create({ name: 'mac', start: false });
  for (const id of IDS) a.insert({ id, password: `pw-${id}` });
  await h.syncAll();
  const b = await h.join({ name: 'pc', start: false });
  await h.syncAll();
  a.remove(IDS);
  await h.syncAll();
  expect(await b.engine.parts().snapshots.list()).toHaveLength(1);
  plantCopies(b);
  return { a, b, oldKey: b.replica.ring().current.kEpoch };
}

async function rotateOnA(a: HarnessDevice, newPassword: string): Promise<void> {
  a.replica.changePassword('pw', newPassword, false);
  expect((await a.sync()).kind).toBe('published');
  h.cloud.upload('mac');
  h.cloud.download('pc');
}

function metaOf(file: string): { salt: string; verification: string } {
  return withCopy(file, scratch(), (db) => {
    const get = (k: string) => (db.prepare('SELECT value FROM vault_meta WHERE key = ?').get(k) as { value: string }).value;
    return { salt: get('salt'), verification: get('verification') };
  });
}

describe('adopting a password change moves local copies off the old password (4.8)', { timeout: SCENARIO_TIMEOUT_MS }, () => {
  it('"Enter the new password" while running', async () => {
    const { a, b, oldKey } = await pairWithCopiesOnB('adopt-copies-newer');
    await rotateOnA(a, 'pw2');
    expect(await b.sync()).toEqual({ kind: 'paused', reason: 'epoch-newer' });
    expect((await b.engine.enterNewPassword('pw2')).ok).toBe(true);
    await h.idle();
    await expectSealed(b, oldKey, scratch());
  });

  it('at unlock: local.json notes it and the engine does it when it starts', async () => {
    const { a, b, oldKey } = await pairWithCopiesOnB('adopt-copies-open');
    await b.lock();
    await rotateOnA(a, 'pw2');
    const s = h.peek(b.sharedPath);
    const meta = metaOf(b.sharedPath);
    const newKey = b.host.kdf.deriveKey('pw2', meta.salt);
    await b.open(b.lineageId, newKey, { kind: 'existing' }, null);
    const unlock = decideUnlock({ lineageId: b.lineageId, deriveFromSalt: (salt) => b.host.kdf.deriveKey('pw2', salt), w: b.state(), s: { state: s.state, meta } });
    if (!unlock.decision.ok) throw new Error('the new password was refused');
    await adoptEpochAtOpen(
      {
        replica: b.replica,
        shared: { file: s, meta, sha256: fileSha(b.sharedPath), mtimeMs: fs.statSync(b.sharedPath).mtimeMs },
        decision: unlock.decision,
        key: newKey,
        previousKey: null,
        sideFilesPresent: false,
        serverSideFilesFlagRecent: false,
        snapshots: new SnapshotStore(b.replica.paths.snapshots, b.host),
      },
      b.host,
    );
    expect(b.replica.local().sealLocalCopiesPending).toBe(true);
    await b.unlock(false, true);
    await expectSealed(b, oldKey, scratch());
  });

  it('concurrent changes: picking the other password', async () => {
    const { a, b, oldKey } = await pairWithCopiesOnB('adopt-copies-concurrent');
    a.replica.changePassword('pw', 'pwA', false);
    b.replica.changePassword('pw', 'pwB', false);
    const aEpoch = a.replica.ring().current.epochId;
    expect((await a.sync()).kind).toBe('published');
    expect((await b.sync()).kind).toBe('published');
    h.cloud.upload('mac');
    h.cloud.download('pc');
    expect(await b.sync()).toEqual({ kind: 'paused', reason: 'epoch-concurrent' });
    await b.engine.resolveConcurrentEpoch('pwA', aEpoch);
    await h.idle();
    await expectSealed(b, oldKey, scratch());
  });

  it(
    'a 0.17 password change, including the copy of W its own pre-merge snapshot took',
    async () => {
      h = new SyncHarness('adopt-copies-legacy');
      const a = await h.create({ name: 'mac', start: false, kdf: realKdf }, 'old');
      for (const id of IDS) a.insert({ id, password: `pw-${id}` });
      expect((await a.sync()).kind).toBe('published');
      plantCopies(a);
      const oldKey = a.replica.ring().current.kEpoch;
      h.cloud.upload('mac');
      h.cloud.download('win017');
      const legacy = new LegacyDesktop(h.cloud.sharedPath('win017'), h.requireVault().key, () => h.clock.now());
      legacy.changePassword('old', 'new');
      legacy.edit((v) => IDS.forEach((id) => v.deleteEntry(id)));
      legacy.close();
      h.cloud.upload('win017');
      h.cloud.download('mac');
      expect(await a.sync()).toEqual({ kind: 'paused', reason: 'epoch-legacy' });
      await a.engine.adoptLegacyPasswordChange('new', 'old');
      await h.idle();
      expect(await a.engine.parts().snapshots.list()).toHaveLength(1);
      await expectSealed(a, oldKey, scratch());
    },
    PBKDF2_TIMEOUT_MS,
  );
});
