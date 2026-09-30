// @vitest-environment node
// Spec 12 rows about master-password changes (key epochs) across devices and older apps, through
// the REAL SyncEngine, replica (changePassword, setRing) and shared-file layers on real files:
// T-FS-15, 16, 17, 59, 64, 65, and the tampered-wrap half of 70. The 0.17 password change uses
// the real ConduitVault with the real 600k-round PBKDF2, so those devices use the real kdf.
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveKey } from '../../../vault/crypto.js';
import { deriveEpochKeys } from '../../hashing.js';
import { buildKeyRing, decideUnlock } from '../../key-epoch.js';
import { currentEpochId } from '../../state-view.js';
import { TBL, type SyncState } from '../../types.js';
import { OLD_PASSWORD, createLegacyVault } from '../core-e2e-fixtures.js';
import { SyncHarness } from './sync-harness.js';
import { LegacyDesktop, withSimDate } from './legacy-desktop.js';
import { fieldConflict, fileSha, SCENARIO_TIMEOUT_MS } from './scenario-helpers.js';
import { open as openSecret, withCopy } from './vault-ops.js';
import type { Kdf } from '../../host.js';
import type { HarnessDevice } from './harness-device.js';

const PBKDF2_TIMEOUT_MS = 30_000;

/** The vault's real PBKDF2 (600k rounds), needed wherever ConduitVault derived the key. */
const realKdf: Kdf = { deriveKey: (password, saltB64) => deriveKey(password, Buffer.from(saltB64, 'base64')) };

let h: SyncHarness;

afterEach(async () => {
  for (const d of h.devices) expect(d.logger.unprefixed()).toEqual([]);
  expect(await h.dispose()).toEqual([]);
});

async function pair(label: string): Promise<[HarnessDevice, HarnessDevice]> {
  h = new SyncHarness(label);
  const a = await h.create({ name: 'mac', start: false });
  a.insert({ id: 'e1', password: 'p1', notes: 'n0' });
  await h.syncAll();
  const b = await h.join({ name: 'pc', start: false });
  await h.syncAll();
  return [a, b];
}

function secret(d: HarnessDevice, id: string): string | null {
  return openSecret(d.replica.ring().current.kEpoch, (d.row(id)?.password_encrypted as Buffer | null) ?? null);
}

function metaOf(file: string, scratch: string): { salt: string; verification: string } {
  return withCopy(file, scratch, (db) => {
    const get = (k: string) => (db.prepare('SELECT value FROM vault_meta WHERE key = ?').get(k) as { value: string }).value;
    return { salt: get('salt'), verification: get('verification') };
  });
}

function epochOf(state: SyncState, id: string) {
  return state.epochs.get(id);
}

/** A rotates the password and publishes; B receives it while holding offline edits. */
async function rotateOnA(a: HarnessDevice, b: HarnessDevice, newPassword: string, erase = false): Promise<void> {
  a.replica.changePassword('pw', newPassword, erase);
  expect((await a.sync()).kind).toBe('published');
  h.cloud.upload('mac');
  h.cloud.download('pc');
  expect(await b.sync()).toEqual({ kind: 'paused', reason: 'epoch-newer' });
}

describe('spec 12: master-password changes', { timeout: SCENARIO_TIMEOUT_MS }, () => {
  it('T-FS-15: password changed on A while B has 5 unsynced edits: B pauses publishing, keeps working, and keeps all 5 after the new password', async () => {
    const [a, b] = await pair('fs15');
    b.insert({ id: 'x1' });
    b.insert({ id: 'x2' });
    b.insert({ id: 'x3' });
    b.update('e1', { notes: 'from pc' });
    b.update('e1', { password: 'pc secret' });
    await rotateOnA(a, b, 'pw2');
    const prompt = b.status().prompts.find((p) => p.kind === 'epoch-newer');
    expect(prompt).toMatchObject({ kind: 'epoch-newer', changedByDeviceName: 'mac' });
    const paused = fileSha(b.sharedPath);
    b.insert({ id: 'x4' });
    expect(await b.sync()).toEqual({ kind: 'paused', reason: 'epoch-newer' });
    expect(fileSha(b.sharedPath)).toBe(paused);
    expect((await b.engine.enterNewPassword('pw2')).ok).toBe(true);
    await h.idle();
    expect(b.replica.ring().current.epochId).toBe(a.replica.ring().current.epochId);
    await h.syncAll();
    for (const d of [a, b]) {
      expect(['x1', 'x2', 'x3', 'x4'].every((id) => d.live(id))).toBe(true);
      expect(d.row('e1')?.notes).toBe('from pc');
      expect(secret(d, 'e1')).toBe('pc secret');
    }
  });

  it('T-FS-59: after a rotation the old password no longer opens anything; old verifiers are redacted from the file', async () => {
    const [a, b] = await pair('fs59');
    const e1 = a.replica.ring().current.epochId;
    await rotateOnA(a, b, 'pw2');
    expect((await b.engine.enterNewPassword('pw2')).ok).toBe(true);
    await h.idle();
    await h.syncAll();
    for (const s of [a.state(), b.state(), h.peek(a.sharedPath).state]) {
      expect(epochOf(s, e1)?.verification).toBeNull();
      expect(decideUnlock({ lineageId: a.lineageId, deriveFromSalt: (salt) => a.host.kdf.deriveKey('pw', salt), w: s, s: null }).decision.ok).toBe(false);
      expect(decideUnlock({ lineageId: a.lineageId, deriveFromSalt: (salt) => a.host.kdf.deriveKey('pw2', salt), w: s, s: null }).decision.ok).toBe(true);
    }
  });

  it('T-FS-65: rotate and erase Recently deleted: new epoch, old verification and salt redacted, graves erased everywhere', async () => {
    const [a, b] = await pair('fs65');
    const e1 = a.replica.ring().current.epochId;
    a.insert({ id: 'gone', password: 'leaked' });
    a.remove(['gone']);
    await h.syncAll();
    await rotateOnA(a, b, 'pw2', true);
    expect((await b.engine.enterNewPassword('pw2')).ok).toBe(true);
    await h.idle();
    await h.syncAll();
    for (const s of [a.state(), b.state(), h.peek(b.sharedPath).state]) {
      expect(currentEpochId(s)).not.toBe(e1);
      expect(epochOf(s, e1)).toMatchObject({ salt: null, verification: null });
      expect(s.rows.get(`${TBL.entries}:gone`)?.grave?.redacted).toBe(true);
    }
  });

  it('T-FS-17: both devices change the password offline: the epoch register conflicts, B pauses, enters the other password once and picks', async () => {
    const [a, b] = await pair('fs17');
    b.insert({ id: 'from-b' });
    a.replica.changePassword('pw', 'pwA', false);
    b.replica.changePassword('pw', 'pwB', false);
    const aEpoch = a.replica.ring().current.epochId;
    expect((await a.sync()).kind).toBe('published');
    expect((await b.sync()).kind).toBe('published');
    h.cloud.upload('mac');
    h.cloud.download('pc');
    const paused = await b.sync();
    expect(paused).toEqual({ kind: 'paused', reason: 'epoch-concurrent' });
    expect(b.status().prompts.find((p) => p.kind === 'epoch-concurrent')).toMatchObject({ epochIds: [b.replica.ring().current.epochId, aEpoch] });
    await b.engine.resolveConcurrentEpoch('pwA', aEpoch);
    await h.idle();
    expect(b.replica.ring().current.epochId).toBe(aEpoch);
    await h.syncAll();
    for (const d of [a, b]) {
      expect(currentEpochId(d.state())).toBe(aEpoch);
      expect(d.live('from-b')).toBe(true);
      expect(secret(d, 'e1')).toBe('p1');
    }
  });

  it(
    'T-FS-16: password changed on 0.17; a device with only the new password keeps non-secret edits precisely and its unreadable secrets as undecryptable siblings',
    async () => {
      h = new SyncHarness('fs16');
      const a = await h.create({ name: 'mac', start: false, kdf: realKdf }, 'old');
      a.insert({ id: 'e1', password: 'p1' });
      a.insert({ id: 'e2', host: 'h0' });
      await a.sync();
      h.cloud.upload('mac');
      h.cloud.download('win017');
      const legacy = new LegacyDesktop(h.cloud.sharedPath('win017'), h.requireVault().key, () => h.clock.now());
      legacy.changePassword('old', 'new');
      legacy.edit((v) => v.updateEntry('e2', { host: 'from 0.17' }));
      legacy.close();
      h.cloud.upload('win017');
      a.update('e1', { password: 'unsynced secret' });
      a.update('e2', { notes: 'unsynced notes' });
      h.cloud.download('mac');
      expect(await a.sync()).toEqual({ kind: 'paused', reason: 'epoch-legacy' });
      await a.engine.adoptLegacyPasswordChange('new', null);
      await h.idle();
      expect(a.row('e2')).toMatchObject({ host: 'from 0.17', notes: 'unsynced notes' });
      expect(secret(a, 'e1')).toBe('p1');
      const f = fieldConflict(a.conflicts(), 'e1', 'password');
      const hidden = f?.versions.find((v) => v.masked && !v.provisional);
      expect(f).not.toBeNull();
      expect(hidden).toBeDefined();
      const newKey = realKdf.deriveKey('new', metaOf(a.sharedPath, `${h.root}/peek`).salt);
      expect(deriveEpochKeys(newKey, a.lineageId).epochId).toBe(a.replica.ring().current.epochId);
    },
    PBKDF2_TIMEOUT_MS,
  );

  it(
    'T-FS-64: 0.17 changes the password before the first publish: the G2 salt check pauses; S is never republished with the old salt',
    async () => {
      h = new SyncHarness('fs64');
      const fx = withSimDate(h.clock.now(), () => createLegacyVault(h.cloud.mirror('mac')));
      h.cloud.touch(h.cloud.sharedPath('mac'));
      const a = await h.genesis({ name: 'mac', start: false, kdf: realKdf }, fx.source.key, { download: false, unlockCycle: false });
      const legacy = new LegacyDesktop(a.sharedPath, fx.source.key, () => h.clock.now());
      legacy.changePassword(OLD_PASSWORD, 'brand new password');
      legacy.close();
      const changed = fileSha(a.sharedPath);
      const newSalt = metaOf(a.sharedPath, `${h.root}/peek`).salt;
      for (let i = 0; i < 3; i++) expect(await a.sync()).toEqual({ kind: 'paused', reason: 'epoch-legacy' });
      expect(fileSha(a.sharedPath)).toBe(changed);
      expect(metaOf(a.sharedPath, `${h.root}/peek`).salt).toBe(newSalt);
      expect(a.status().prompts.map((p) => p.kind)).toContain('epoch-legacy');
    },
    PBKDF2_TIMEOUT_MS,
  );

  // 12 row 64: a legacy change found in a pre-sync S (G2 salt check) is adopted by W joining the
  // new epoch; S's content then goes through G2 and W publishes under the new salt.
  it(
    'T-FS-64 (adopt): entering the new password keeps the change and republishes S under the new salt',
    async () => {
      h = new SyncHarness('fs64-adopt');
      const fx = withSimDate(h.clock.now(), () => createLegacyVault(h.cloud.mirror('mac')));
      h.cloud.touch(h.cloud.sharedPath('mac'));
      const a = await h.genesis({ name: 'mac', start: false, kdf: realKdf }, fx.source.key, { download: false, unlockCycle: false });
      const legacy = new LegacyDesktop(a.sharedPath, fx.source.key, () => h.clock.now());
      legacy.changePassword(OLD_PASSWORD, 'brand new password');
      legacy.close();
      const newSalt = metaOf(a.sharedPath, `${h.root}/peek`).salt;
      expect(await a.sync()).toEqual({ kind: 'paused', reason: 'epoch-legacy' });
      await a.engine.adoptLegacyPasswordChange('brand new password', OLD_PASSWORD);
      await h.idle();
      expect(h.classify(a.sharedPath).kind).toBe('synced');
      expect(metaOf(a.sharedPath, `${h.root}/peek`).salt).toBe(newSalt);
    },
    PBKDF2_TIMEOUT_MS,
  );

  it('T-FS-70 (wraps): a tampered wrap in S is ignored; the valid wrap still reaches the old key and the password still unlocks', async () => {
    const [a, b] = await pair('fs70-wrap');
    const e1 = a.replica.ring().current.epochId;
    await rotateOnA(a, b, 'pw2');
    expect((await b.engine.enterNewPassword('pw2')).ok).toBe(true);
    await h.idle();
    await h.syncAll();
    const e2 = a.replica.ring().current.epochId;
    const s = new Database(a.sharedPath);
    s.pragma('journal_mode = DELETE');
    s.prepare('INSERT INTO sync_key_wrap (epoch_id, target_epoch, wrap) VALUES (?, ?, ?)').run(e2, e1, crypto.randomBytes(60));
    s.close();
    h.cloud.touch(a.sharedPath);
    h.cloud.upload('mac');
    h.cloud.download('pc');
    await b.sync();
    const state = b.state();
    expect([...state.wraps.values()].filter((w) => w.epochId === e2 && w.targetEpoch === e1)).toHaveLength(2);
    const k2 = deriveEpochKeys(b.replica.ring().current.kEpoch, b.lineageId);
    expect(buildKeyRing(state, k2, b.lineageId).byEpoch.has(e1)).toBe(true);
    expect(decideUnlock({ lineageId: b.lineageId, deriveFromSalt: (salt) => b.host.kdf.deriveKey('pw2', salt), w: state, s: null }).decision.ok).toBe(true);
    expect(secret(b, 'e1')).toBe('p1');
  });
});
