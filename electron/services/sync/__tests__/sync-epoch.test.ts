// @vitest-environment node
// sync-epoch.ts through the real engine and replica (spec 4.8, 12 rows 15/59/64): the running
// "Enter the new password" flow (the old password is refused as superseded), the legacy change
// found in a pre-sync S before the first publish (W joins the new epoch and S is republished
// under the new salt), and the guards of the concurrent-change flow.
import crypto from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveEpochKeys, epochIdOf } from '../hashing.js';
import { makeVerificationToken } from '../key-epoch.js';
import { currentEpochId } from '../state-view.js';
import { adoptPresyncPasswordChange, resolveConcurrentEpoch, type SharedForEpoch } from '../sync-epoch.js';
import { SyncCoreError } from '../types.js';
import { CycleWorld, insert, loadVault, toPresync, type CycleDev } from './cycle-fixtures.js';

let world: CycleWorld;

afterEach(async () => {
  expect(await world.dispose()).toEqual([]);
});

/** B changes the password and publishes; A then sees S under a newer epoch. */
async function rotated(label: string): Promise<{ a: CycleDev; b: CycleDev }> {
  world = new CycleWorld();
  const a = await world.solo(label);
  const b = await world.join(a);
  b.replica.changePassword('pw', 'pw2', false);
  expect((await b.engine.runCycle('local-edit')).kind).toBe('published');
  expect(await a.engine.runCycle('shared-changed')).toEqual({ kind: 'paused', reason: 'epoch-newer' });
  return { a, b };
}

/** 0.17 changed the password of S before A's next publish: S is pre-sync under a new salt. */
function legacyPresync(a: CycleDev, password: string): { readonly salt: string; readonly key: Buffer; readonly verification: string } {
  const salt = crypto.randomBytes(32).toString('base64');
  const key = a.d.t.host.kdf.deriveKey(password, salt);
  const verification = makeVerificationToken(deriveEpochKeys(key, a.replica.lineageId), (n) => crypto.randomBytes(n));
  toPresync(a.sharedPath, { salt, verification });
  return { salt, key, verification };
}

describe('enterNewPassword (4.8 S newer)', () => {
  it("refuses this device's own (superseded) password and changes nothing", async () => {
    const { a, b } = await rotated('epoch-own');
    const before = a.replica.ring().current.epochId;
    const d = await a.engine.enterNewPassword('pw');
    expect(d).toMatchObject({ ok: false, reason: 'superseded' });
    expect(a.replica.ring().current.epochId).toBe(before);
    expect(a.engine.parts().status.snapshot().prompts.map((p) => p.kind)).toContain('epoch-newer');
    expect(b.replica.ring().current.epochId).not.toBe(before);
  });

  it('the new password moves W to the newer epoch and syncing resumes (12 row 15)', async () => {
    const { a, b } = await rotated('epoch-new');
    insert(a, ['kept']);
    expect(await a.engine.enterNewPassword('pw2')).toMatchObject({ ok: true, via: 's-newer' });
    await a.engine.whenIdle();
    expect(a.replica.ring().current.epochId).toBe(b.replica.ring().current.epochId);
    expect((await a.engine.syncNow()).kind).toMatch(/published|up-to-date/);
    expect(loadVault(a.sharedPath, path.join(a.root, 'peek')).content.entries.has('kept')).toBe(true);
  });
});

describe('legacy change in a pre-sync S (12 row 64)', () => {
  it('pauses, then with both passwords W joins the new epoch and S is republished under the new salt', async () => {
    world = new CycleWorld();
    const a = await world.solo('epoch-presync');
    insert(a, ['mine']);
    const oldEpoch = a.replica.ring().current.epochId;
    const { salt, key } = legacyPresync(a, 'brand new');
    expect(await a.engine.runCycle('shared-changed')).toEqual({ kind: 'paused', reason: 'epoch-legacy' });
    await a.engine.adoptLegacyPasswordChange('brand new', 'pw');
    await a.engine.whenIdle();
    expect(a.replica.ring().current.epochId).toBe(epochIdOf(key));
    expect(a.replica.ring().byEpoch.has(oldEpoch)).toBe(true);
    expect(a.replica.state().epochs.get(epochIdOf(key))?.parent).toBe(oldEpoch);
    expect((await a.engine.syncNow()).kind).toMatch(/published|up-to-date/);
    const s = loadVault(a.sharedPath, path.join(a.root, 'peek'));
    expect(currentEpochId(s.state)).toBe(epochIdOf(key));
    expect(s.content.meta.get('salt')).toBe(salt);
    expect(s.content.entries.has('mine')).toBe(true);
    expect(a.engine.parts().candidates.list().map((c) => c.source)).toEqual(['presync-no-baseline']);
  });

  it('a wrong new password is refused and W stays as it was', async () => {
    world = new CycleWorld();
    const a = await world.solo('epoch-presync-wrong');
    const before = a.replica.ring().current.epochId;
    const { salt, verification } = legacyPresync(a, 'brand new');
    const meta = { salt, verification };
    expect(() => adoptPresyncPasswordChange({ replica: a.replica, meta, sha256: 'a'.repeat(64), newPassword: 'nope', previousKey: null }, a.d.t.host)).toThrow(SyncCoreError);
    expect(a.replica.ring().current.epochId).toBe(before);
  });
});

describe('resolveConcurrentEpoch guards', () => {
  it('refuses a winner that is neither branch, and a wrong other password', async () => {
    const { a } = await rotated('epoch-concurrent');
    const s = loadVault(a.sharedPath, path.join(a.root, 'peek'));
    const shared: SharedForEpoch = { file: s, meta: { salt: s.content.meta.get('salt') ?? null, verification: s.content.meta.get('verification') ?? null }, sha256: 'a'.repeat(64), mtimeMs: 0 };
    const host = a.d.t.host;
    expect(() => resolveConcurrentEpoch({ replica: a.replica, shared, otherPassword: 'pw2', winnerEpochId: 'f'.repeat(32) }, host)).toThrow(SyncCoreError);
    expect(() => resolveConcurrentEpoch({ replica: a.replica, shared, otherPassword: 'wrong', winnerEpochId: a.replica.ring().current.epochId }, host)).toThrow(SyncCoreError);
  });
});
