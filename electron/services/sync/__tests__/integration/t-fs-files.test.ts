// @vitest-environment node
// Spec 12 rows about files next to S and where S lives: conflict copies, renames and moves, the
// OneDrive rename dance, same-device copies, copies on other devices, roaming profiles and a
// symlinked default.conduit, through the REAL SyncEngine, copy scanner, file binding and
// divergence modules on real files: T-FS-9, 19, 20, 42, 48, 53, 58, 63.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyKey } from '../../key-epoch.js';
import { deriveEpochKeys } from '../../hashing.js';
import { SyncHarness } from './sync-harness.js';
import { copyName } from './fake-cloud.js';
import { Ios105 } from './legacy-ios.js';
import { fileSha, SCENARIO_TIMEOUT_MS } from './scenario-helpers.js';
import { withCopy } from './vault-ops.js';
import type { SessionRowView } from '../../host.js';

const SEC = 1000;

let h: SyncHarness;

afterEach(async () => {
  for (const d of h.devices) expect(d.logger.unprefixed()).toEqual([]);
  expect(await h.dispose()).toEqual([]);
});

function names(dir: string): string[] {
  return fs.readdirSync(dir).filter((n) => n.endsWith('.conduit')).sort();
}

describe('spec 12: copies, renames and where S lives', { timeout: SCENARIO_TIMEOUT_MS }, () => {
  it('T-FS-9: a OneDrive copy "Vault-DESKTOP-ABC.conduit" holding only uncovered app dots is merged automatically and left in place', async () => {
    h = new SyncHarness('fs9');
    const a = await h.create({ name: 'mac', start: false });
    const b = await h.join({ name: 'DESKTOP-ABC', start: false });
    b.insert({ id: 'p1', host: 'from the PC' });
    expect((await b.sync()).kind).toBe('published');
    const copy = h.cloud.conflictCopy('mac', 'onedrive-host', fs.readFileSync(b.sharedPath), 'DESKTOP-ABC');
    expect(path.basename(copy)).toBe('Vault-DESKTOP-ABC.conduit');
    const copySha = fileSha(copy);
    const scan = await a.engine.scanCopies();
    expect(scan.copies.map((c) => [c.name, c.cls])).toEqual([['Vault-DESKTOP-ABC.conduit', 'safe-provider-copy']]);
    expect(a.live('p1')).toBe(true);
    expect(a.toasts('copy-merged')).toHaveLength(1);
    expect(fileSha(copy)).toBe(copySha);
    expect(a.replica.local().ignoredCopies).toContain(copySha);
    expect((await a.engine.scanCopies()).copies).toEqual([]);
    await h.idle();
    expect(h.peek(a.sharedPath).content.entries.get('p1')?.host).toBe('from the PC');
  });

  it('T-FS-42: "Vault 2.conduit" with 15 iOS 1.0.5 deletes is a class 4 copy: a review notice, nothing merged or moved', async () => {
    h = new SyncHarness('fs42');
    const a = await h.create({ name: 'mac', start: false });
    const ids = Array.from({ length: 20 }, (_, i) => `d${i}`);
    for (const id of ids) a.insert({ id });
    await a.sync();
    const copy = path.join(path.dirname(a.sharedPath), copyName('Vault', 'user-2'));
    fs.copyFileSync(a.sharedPath, copy);
    const ios = new Ios105(copy, path.join(h.root, 'files-sandbox'), h.requireVault().key, () => h.clock.now());
    ios.stage();
    for (const id of ids.slice(0, 15)) ios.remove(id);
    ios.writeBack();
    const copySha = fileSha(copy);
    const scan = await a.engine.scanCopies();
    expect(scan.copies.map((c) => [c.name, c.cls, c.contribution.deletions])).toEqual([['Vault 2.conduit', 'needs-review', 15]]);
    const prompt = a.status().prompts.find((p) => p.kind === 'copy-review');
    expect(prompt?.kind === 'copy-review' ? prompt.copy.deletions : null).toBe(15);
    expect(ids.every((id) => a.live(id))).toBe(true);
    expect(fileSha(copy)).toBe(copySha);
    expect(names(path.dirname(a.sharedPath))).toEqual(['Vault 2.conduit', 'Vault.conduit']);
  });

  it('T-FS-19: a rename made on another device: after 30 s the single same-lineage file is rebound (toast, Undo); never recreated', async () => {
    h = new SyncHarness('fs19');
    const a = await h.create({ name: 'mac', start: true });
    const oldPath = a.sharedPath;
    h.cloud.renameEverywhere('Vault renamed.conduit');
    a.insert({ id: 'during' });
    await h.advance(10 * SEC);
    expect(a.status().kind).not.toBe('file-not-found');
    expect(fs.existsSync(oldPath)).toBe(false);
    await h.advance(35 * SEC);
    const bound = a.engine.parts().binding.sharedPath();
    expect(path.basename(bound)).toBe('Vault renamed.conduit');
    expect(a.toasts('rebound')).toHaveLength(1);
    expect(fs.existsSync(oldPath)).toBe(false);
    expect(h.peek(bound).content.entries.has('during')).toBe(true);
    expect(await a.engine.parts().binding.undoRebind()).toBe(true);
    expect(a.engine.parts().binding.sharedPath()).toBe(oldPath);
  });

  it('T-FS-19 (two files): with two same-lineage files the user is asked to locate; edits stay in W', async () => {
    h = new SyncHarness('fs19-two');
    const a = await h.create({ name: 'mac', start: true });
    const dir = path.dirname(a.sharedPath);
    fs.copyFileSync(a.sharedPath, path.join(dir, 'Vault 2.conduit'));
    h.cloud.renameEverywhere('Vault moved.conduit');
    a.insert({ id: 'kept' });
    await h.advance(45 * SEC);
    expect(a.status().prompts.map((p) => p.kind)).toContain('file-missing');
    expect(a.status().kind).toBe('file-not-found');
    expect(a.toasts('rebound')).toEqual([]);
    expect(fs.existsSync(a.sharedPath)).toBe(false);
    expect(a.live('kept')).toBe(true);
  });

  it('T-FS-58: the OneDrive rename dance: the original name returns within 30 s and nothing is rebound to the conflict name', async () => {
    h = new SyncHarness('fs58');
    const a = await h.create({ name: 'mac', start: true });
    h.cloud.renameDance('mac', 'PC1');
    await h.advance(10 * SEC);
    h.cloud.putBack('mac');
    await h.advance(35 * SEC);
    expect(a.engine.parts().binding.sharedPath()).toBe(a.sharedPath);
    expect(a.toasts('rebound')).toEqual([]);
    expect(a.status().prompts.map((p) => p.kind)).not.toContain('file-missing');
  });

  it('T-FS-58 (never back): only a conflict-named file remains: prompt, never an automatic rebind', async () => {
    h = new SyncHarness('fs58-gone');
    const a = await h.create({ name: 'mac', start: true });
    h.cloud.renameDance('mac', 'PC1');
    await h.advance(45 * SEC);
    expect(a.engine.parts().binding.sharedPath()).toBe(a.sharedPath);
    expect(a.toasts('rebound')).toEqual([]);
    expect(a.status().prompts.map((p) => p.kind)).toContain('file-missing');
  });

  it('T-FS-20: [Use as a separate vault] on a same-device copy writes a new file with a new lineage; the copy is untouched', async () => {
    h = new SyncHarness('fs20');
    const a = await h.create({ name: 'mac', start: false });
    a.insert({ id: 'x' });
    await a.sync();
    const dir = path.dirname(a.sharedPath);
    const copy = path.join(dir, copyName('Vault', 'user-backup'));
    fs.copyFileSync(a.sharedPath, copy);
    const before = fileSha(copy);
    const target = path.join(dir, 'Vault separate.conduit');
    await a.engine.resolveSameDeviceCopy('separate', copy, target);
    expect(fileSha(copy)).toBe(before);
    const forked = h.peek(target);
    expect(forked.state.lineageId).not.toBe(a.lineageId);
    expect(forked.content.entries.has('x')).toBe(true);
    const verification = forked.content.meta.get('verification') ?? '';
    expect(verifyKey(deriveEpochKeys(h.requireVault().key, forked.state.lineageId).kEpoch, verification)).toBe(true);
    expect(a.state().lineageId).toBe(a.lineageId);
  });

  it('T-FS-48: another device syncing a different copy in another provider raises "These are separate copies"', async () => {
    h = new SyncHarness('fs48');
    const a = await h.create({ name: 'mac', start: false });
    const row: SessionRowView = {
      deviceId: '11111111-2222-4333-8444-555555555555',
      deviceName: 'Windows PC',
      platform: 'windows',
      fileName: 'Vault.conduit',
      fileId: '99999999-8888-4777-8666-555555555555',
      location: 'onedrive:Documents',
      status: 'active',
      lastActiveMs: h.clock.now(),
      busySessions: 0,
      busyJobs: 0,
      heartbeatAtMs: null,
      sideFilesFlag: false,
      marker: null,
      writtenAtMs: null,
      pendingChanges: false,
      abandoned: false,
    };
    a.session.rows = [row];
    a.insert({ id: 'x' });
    await a.sync();
    const prompt = a.status().prompts.find((p) => p.kind === 'different-copies');
    expect(prompt).toMatchObject({ kind: 'different-copies', deviceName: 'Windows PC', theirs: { location: 'onedrive:Documents' } });
  });

  it('T-FS-53: two machines on one roaming profile keep separate machine folders, device ids and working copies', async () => {
    h = new SyncHarness('fs53');
    const a = await h.create({ name: 'pc-office', start: false });
    const b = await h.join({ name: 'pc-home', start: false, syncRoot: a.syncRoot });
    expect(b.syncRoot).toBe(a.syncRoot);
    expect(b.machineDir).not.toBe(a.machineDir);
    expect(b.deviceUuid).not.toBe(a.deviceUuid);
    expect(b.replica.paths.working).not.toBe(a.replica.paths.working);
    a.insert({ id: 'office' });
    b.insert({ id: 'home' });
    await h.syncAll();
    for (const d of [a, b]) expect([d.live('office'), d.live('home')]).toEqual([true, true]);
  });

  it('T-FS-63: a default.conduit symlinked into Dropbox is shared: W and the engine apply; publishing replaces the target, not the link', async () => {
    h = new SyncHarness('fs63');
    await h.create({ name: 'mac', start: false });
    h.cloud.download('pc');
    const appData = path.join(h.root, 'pc-appdata');
    fs.mkdirSync(appData, { recursive: true });
    const link = path.join(appData, 'default.conduit');
    fs.symlinkSync(h.cloud.sharedPath('pc'), link);
    const b = await h.join({ name: 'pc', start: false, sharedPath: link }, { download: false });
    expect(fs.existsSync(b.replica.paths.working)).toBe(true);
    b.insert({ id: 'via-link' });
    expect((await b.sync()).kind).toBe('published');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe(h.cloud.sharedPath('pc'));
    expect(withCopy(h.cloud.sharedPath('pc'), path.join(h.root, 'peek'), (db) => db.prepare("SELECT id FROM entries WHERE id = 'via-link'").get())).toBeDefined();
  });
});
