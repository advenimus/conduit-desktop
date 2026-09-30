// @vitest-environment node
// Spec 12 rows about iOS 1.0.5 (the emulator: sandbox staging with companion folding, stale
// editor saves with rebuilt config, in-place writeBack with removeCompanions) against the REAL
// SyncEngine on real files: T-FS-10, 11, 12, 45, 46, 56.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { genesisIdOf } from '../../hashing.js';
import { getRegister } from '../../state-view.js';
import { createLegacyVault } from '../core-e2e-fixtures.js';
import { SyncHarness } from './sync-harness.js';
import { Ios105 } from './legacy-ios.js';
import { withSimDate } from './legacy-desktop.js';
import { entryReg, fieldConflict, prov, SCENARIO_TIMEOUT_MS } from './scenario-helpers.js';
import { open as openSecret } from './vault-ops.js';
import type { HarnessDevice } from './harness-device.js';

const SEC = 1000;
const MIN = 60 * SEC;

let h: SyncHarness;

afterEach(async () => {
  for (const d of h.devices) expect(d.logger.unprefixed()).toEqual([]);
  expect(await h.dispose()).toEqual([]);
});

interface Setup {
  readonly a: HarnessDevice;
  readonly ios: Ios105;
}

/** mac (new build, explicit cycles) plus an iPhone 1.0.5 whose sandbox holds the published S. */
async function withIphone(label: string, seed: (a: HarnessDevice) => void): Promise<Setup> {
  h = new SyncHarness(label);
  const a = await h.create({ name: 'mac', start: false });
  seed(a);
  await a.sync();
  h.cloud.upload('mac');
  h.cloud.download('iphone');
  const ios = new Ios105(h.cloud.sharedPath('iphone'), path.join(h.root, 'iphone-sandbox'), h.requireVault().key, () => h.clock.now());
  ios.stage();
  return { a, ios };
}

/** iPhone writes back, the cloud carries it to the Mac, the Mac runs one cycle. */
async function deliverToMac(a: HarnessDevice): Promise<string> {
  h.cloud.upload('iphone');
  h.cloud.download('mac');
  return (await a.sync()).kind;
}

describe('spec 12: iOS 1.0.5 as a legacy writer', { timeout: SCENARIO_TIMEOUT_MS }, () => {
  it('T-FS-10: an iOS 1.0.5 notes edit is a pseudo sibling; with a concurrent desktop edit it is a conflict', async () => {
    const { a, ios } = await withIphone('fs10', (a) => {
      a.insert({ id: 'e1', notes: 'n1' });
      a.insert({ id: 'e2', notes: 'n2' });
    });
    await h.jump(MIN);
    a.update('e2', { notes: 'from desktop' });
    await h.jump(MIN);
    ios.save('e1', { notes: 'from iPhone' });
    ios.save('e2', { notes: 'also from iPhone' });
    ios.writeBack();
    await deliverToMac(a);
    expect(a.row('e1')?.notes).toBe('from iPhone');
    const e1 = getRegister(a.state(), entryReg('e1', 'notes'))?.sibs ?? [];
    expect(e1.map((s) => [s.dev, s.value])).toEqual([[0, 'from iPhone']]);
    expect(fieldConflict(a.conflicts(), 'e1', 'notes')).toBeNull();
    const e2 = fieldConflict(a.conflicts(), 'e2', 'notes');
    expect(e2?.versions.map((v) => [v.value, v.pseudo]).sort()).toEqual([
      ['also from iPhone', true],
      ['from desktop', false],
    ]);
  });

  it('T-FS-11: a blind iOS write of a stale sandbox plus one edit keeps the newer desktop dots; the republish reaches iOS', async () => {
    const { a, ios } = await withIphone('fs11', (a) => {
      a.insert({ id: 'e1', host: 'h0' });
      a.insert({ id: 'e2', notes: 'n0' });
    });
    await h.jump(MIN);
    a.update('e1', { host: 'newer on desktop' });
    expect((await a.sync()).kind).toBe('published');
    h.cloud.upload('mac');
    h.cloud.download('iphone');
    await h.jump(MIN);
    ios.save('e2', { notes: 'from stale iPhone' });
    ios.writeBack();
    const iosMtime = fs.statSync(ios.source).mtimeMs;
    expect(await deliverToMac(a)).toBe('published');
    expect(a.row('e1')?.host).toBe('newer on desktop');
    expect(a.row('e2')?.notes).toBe('from stale iPhone');
    expect(fs.statSync(a.sharedPath).mtimeMs).toBeGreaterThanOrEqual(iosMtime + 2 * SEC);
    h.cloud.upload('mac');
    h.cloud.download('iphone');
    expect(ios.poll()).toBe(true);
    expect(ios.row('e1')).toMatchObject({ host: 'newer on desktop', notes: null });
    expect(ios.row('e2')?.notes).toBe('from stale iPhone');
  });

  it('T-FS-12: iOS 1.0.5 saves a password under the old key after a rotation: opened through the wrap chain, kept under the new key', async () => {
    const { a, ios } = await withIphone('fs12', (a) => {
      a.insert({ id: 'e1', password: 'p1' });
      a.insert({ id: 'e2', password: 'q1' });
    });
    a.replica.changePassword('pw', 'pw2', false);
    expect((await a.sync()).kind).toBe('published');
    h.cloud.upload('mac');
    h.cloud.download('iphone');
    expect(ios.poll()).toBe(true);
    ios.save('e1', { password: 'saved on iPhone with the old key' });
    const unknownKey = crypto.randomBytes(32);
    const keep = ios.key;
    ios.key = unknownKey;
    ios.save('e2', { password: 'sealed with a key nobody has' });
    ios.key = keep;
    ios.writeBack();
    await deliverToMac(a);
    const k2 = a.replica.ring().current.kEpoch;
    expect(openSecret(k2, a.row('e1')?.password_encrypted as Buffer)).toBe('saved on iPhone with the old key');
    expect(fieldConflict(a.conflicts(), 'e1', 'password')).toBeNull();
    const undecryptable = a.conflicts().flatMap((g) => g.items).filter((i) => i.kind === 'undecryptable');
    expect(undecryptable.map((i) => (i.kind === 'undecryptable' ? i.field.key.rowId : ''))).toEqual(['e2']);
    expect(a.replica.local().notices.map((n) => n.kind)).toContain('undecryptable-secrets');
  });

  // 4.8: an unreadable legacy secret is an undecryptable sibling that is never provisional and sits
  // beside the readable value, so [Discard] leaves the Mac's 'q1' in place.
  it('T-FS-12 (no key): the readable value stays provisional next to the undecryptable sibling', async () => {
    const { a, ios } = await withIphone('fs12-nokey', (a) => a.insert({ id: 'e2', password: 'q1' }));
    ios.key = crypto.randomBytes(32);
    ios.save('e2', { password: 'sealed with a key nobody has' });
    ios.writeBack();
    await deliverToMac(a);
    expect(fieldConflict(a.conflicts(), 'e2', 'password')).not.toBeNull();
    expect(openSecret(a.replica.ring().current.kEpoch, a.row('e2')?.password_encrypted as Buffer)).toBe('q1');
  });

  it('T-FS-45: a stale iOS editor snapshot writing back an old host becomes a stale-revert conflict', async () => {
    const { a, ios } = await withIphone('fs45', (a) => a.insert({ id: 'e1', host: '10.0.0.5', notes: 'n0' }));
    const editor = ios.openEditor('e1');
    await h.jump(MIN);
    a.update('e1', { host: '10.0.0.9' });
    await a.sync();
    h.cloud.upload('mac');
    h.cloud.download('iphone');
    expect(ios.poll()).toBe(true);
    await h.jump(MIN);
    ios.saveEditor(editor, { notes: 'notes typed on the phone' });
    ios.writeBack();
    await deliverToMac(a);
    const f = fieldConflict(a.conflicts(), 'e1', 'host');
    expect(f?.staleRevert).toBe(true);
    expect(f?.versions.map((v) => v.value).sort()).toEqual(['10.0.0.5', '10.0.0.9']);
    expect(a.row('e1')?.notes).toBe('notes typed on the phone');
  });

  // 12 row 45: the stale pseudo sibling's time is capped at the Mac edit's, so the Mac's value
  // stays provisional (connections, MCP and older apps keep using the newer host).
  it("T-FS-45 (provisional): the Mac's newer value stays provisional after a stale revert", async () => {
    const { a, ios } = await withIphone('fs45-prov', (a) => a.insert({ id: 'e1', host: '10.0.0.5' }));
    const editor = ios.openEditor('e1');
    await h.jump(MIN);
    a.update('e1', { host: '10.0.0.9' });
    await a.sync();
    h.cloud.upload('mac');
    h.cloud.download('iphone');
    ios.poll();
    await h.jump(MIN);
    ios.saveEditor(editor, { notes: 'x' });
    ios.writeBack();
    await deliverToMac(a);
    expect(fieldConflict(a.conflicts(), 'e1', 'host')?.staleRevert).toBe(true);
    expect(a.row('e1')?.host).toBe('10.0.0.9');
  });

  it('T-FS-46: renaming a document on iOS 1.0.5 (config becomes {}) keeps the text, adds a notice and repairs S once', async () => {
    const { a, ios } = await withIphone('fs46', (a) => a.insert({ id: 'doc', name: 'Runbook', entry_type: 'document', config: { content: 'hello' } }));
    ios.save('doc', { name: 'Runbook (renamed)' });
    ios.writeBack();
    expect(await deliverToMac(a)).toBe('published');
    expect(a.row('doc')).toMatchObject({ name: 'Runbook (renamed)', config: JSON.stringify({ content: 'hello' }) });
    expect(a.replica.local().notices.map((n) => n.kind)).toContain('dropped-setting');
    expect(h.peek(a.sharedPath).content.entries.get('doc')?.config).toBe(JSON.stringify({ content: 'hello' }));
    expect((await a.sync()).kind).toBe('up-to-date');
  });

  it('T-FS-56: iOS 1.0.5 writes a pre-sync sandbox over S after the first genesis: G2 baseline absorb, no resurrection', async () => {
    h = new SyncHarness('fs56');
    const fx = withSimDate(h.clock.now(), () => createLegacyVault(h.cloud.mirror('seed')));
    h.cloud.touch(h.cloud.sharedPath('seed'));
    h.cloud.upload('seed');
    h.cloud.download('iphone');
    const ios = new Ios105(h.cloud.sharedPath('iphone'), path.join(h.root, 'iphone-sandbox'), fx.source.key, () => h.clock.now());
    ios.stage();
    const a = await h.genesis({ name: 'mac', start: false }, fx.source.key);
    expect(h.classify(a.sharedPath).kind).toBe('synced');
    a.remove([fx.ids.desk]);
    await a.sync();
    h.cloud.upload('mac');
    h.cloud.download('iphone');
    await h.jump(MIN);
    ios.save(fx.ids.web, { notes: 'edited in the old sandbox' });
    ios.writeBack();
    expect(h.classify(ios.source).kind).toBe('presync');
    expect(await deliverToMac(a)).toBe('published');
    expect(a.live(fx.ids.desk)).toBe(false);
    expect(a.row(fx.ids.web)?.notes).toBe('edited in the old sandbox');
    expect(a.state().genesisId).toBe(genesisIdOf(fx.source.bytes));
    expect(h.classify(a.sharedPath).kind).toBe('synced');
    expect(prov(a.state(), entryReg(fx.ids.desk, '_life'))).toBe('dead');
  });
});
