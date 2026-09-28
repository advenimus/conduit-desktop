// @vitest-environment node
// Self-checks of the integration harness: the engine modules it drives, the
// FakeCloud primitives, the legacy drivers, and a two-device round trip on the real engine.
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { parsePresence } from '../../presence.js';
import { Backoff } from '../../sync-verify.js';
import { publishBlockReason } from '../../sync-cycle.js';
import { prepareIncoming } from '../../sync-absorb.js';
import { enterNewPassword } from '../../sync-epoch.js';
import { SyncHarness } from './sync-harness.js';
import { SCENARIO_TIMEOUT_MS } from './scenario-helpers.js';
import { copyName } from './fake-cloud.js';
import { LegacyDesktop } from './legacy-desktop.js';
import { Ios105, rebuildConfig } from './legacy-ios.js';
import { withCopy } from './vault-ops.js';

let h: SyncHarness;

afterEach(async () => {
  expect(await h.dispose()).toEqual([]);
});

describe('integration harness', { timeout: SCENARIO_TIMEOUT_MS }, () => {
  it('drives the real cycle, absorb, verify, epoch, presence and candidate modules', async () => {
    h = new SyncHarness('self');
    expect(parsePresence('{}')).toBeNull();
    expect(new Backoff(5, 20).next()).toBe(5);
    const open = {
      killSwitch: false,
      softLocked: false,
      sideFilesPublishAllowed: true,
      serverSideFilesFlagRecent: false,
      epochPaused: false,
      foreign: false,
      regressionBlockedUntilMs: null,
      nowMs: 0,
    };
    expect(publishBlockReason(open)).toBeNull();
    expect(publishBlockReason({ ...open, sideFilesPublishAllowed: false })).toBe('side-files');
    const d = await h.create({ name: 'mac', start: false });
    expect(d.engine.parts().candidates.list()).toEqual([]);
    expect(typeof prepareIncoming).toBe('function');
    expect(typeof enterNewPassword).toBe('function');
  });

  it('names conflict copies exactly as the providers do', () => {
    h = new SyncHarness('names');
    expect(copyName('Vault', 'dropbox')).toBe('Vault (conflicted copy 2026-09-25).conduit');
    expect(copyName('Vault', 'dropbox-user')).toBe("Vault (Chris's conflicted copy 2026-09-25).conduit");
    expect(copyName('Vault', 'onedrive-host', 'PC1')).toBe('Vault-PC1.conduit');
    expect(copyName('Vault', 'syncthing')).toBe('Vault.sync-conflict-20260925-120000-ABCDEFG.conduit');
    expect(copyName('Vault', 'user-2')).toBe('Vault 2.conduit');
    expect(copyName('Vault', 'user-paren-1')).toBe('Vault (1).conduit');
    expect(rebuildConfig('document', '{"content":"x"}')).toBe('{}');
    expect(JSON.parse(rebuildConfig('rdp', '{"sharedFolders":["/tmp"],"w":1}'))).toEqual({ sharedFolders: [], w: 1 });
  });

  it('two devices: create, join, edit on both, converge (real engine, real files)', async () => {
    h = new SyncHarness('roundtrip');
    const a = await h.create({ name: 'mac' });
    const b = await h.join({ name: 'pc' });
    a.insert({ id: 'a1', host: '10.0.0.1' });
    b.insert({ id: 'b1', host: '10.0.0.2' });
    expect((await a.sync()).kind).toBe('published');
    h.cloud.sync('mac');
    expect((await b.sync()).kind).toBe('published');
    h.cloud.sync('pc');
    expect((await a.sync()).kind).toBe('up-to-date');
    for (const d of [a, b]) expect([d.live('a1'), d.live('b1')]).toEqual([true, true]);
    expect(a.row('b1')?.host).toBe('10.0.0.2');
    expect(b.row('a1')?.host).toBe('10.0.0.1');
    for (const d of [a, b]) expect(d.logger.unprefixed()).toEqual([]);
  });

  it('legacy drivers: 0.17 leaves side files while open; iOS writes back in place without companions', async () => {
    h = new SyncHarness('drivers');
    const a = await h.create({ name: 'mac' });
    const legacy = new LegacyDesktop(a.sharedPath, h.requireVault().key, () => h.clock.now());
    legacy.edit((v) => v.createEntry({ name: 'from 0.17', entry_type: 'ssh', host: '10.9.9.9' }));
    expect(fs.existsSync(`${a.sharedPath}-wal`)).toBe(true);
    expect(fs.statSync(`${a.sharedPath}-wal`).size).toBe(0);
    legacy.close();
    expect(fs.existsSync(`${a.sharedPath}-wal`)).toBe(false);
    const ios = new Ios105(a.sharedPath, `${h.root}/ios`, h.requireVault().key, () => h.clock.now());
    h.cloud.addSideFiles('mac', 0);
    ios.stage();
    const id = withCopy(ios.sandbox, `${h.root}/tmp`, (db) => (db.prepare("SELECT id FROM entries WHERE name = 'from 0.17'").get() as { id: string }).id);
    ios.save(id, { notes: 'from iOS' });
    const inode = fs.statSync(a.sharedPath).ino;
    ios.writeBack();
    expect(fs.statSync(a.sharedPath).ino).toBe(inode);
    expect(fs.existsSync(`${a.sharedPath}-wal`)).toBe(false);
    expect(withCopy(a.sharedPath, `${h.root}/tmp`, (db) => db.prepare('SELECT notes, updated_at FROM entries WHERE id = ?').get(id))).toMatchObject({
      notes: 'from iOS',
    });
  });
});
