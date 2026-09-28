// @vitest-environment node
// Spec 12 rows about desktop 0.17 (the real ConduitVault editing S in place, idle open
// connections, quits that leave -wal/-shm) and its side files, through the REAL SyncEngine,
// side-files and replica on real files: T-FS-13, 14, 32, 49, 50, 51.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SyncHarness } from './sync-harness.js';
import { LegacyDesktop } from './legacy-desktop.js';
import { Ios105 } from './legacy-ios.js';
import { fileSha, itemOf, SCENARIO_TIMEOUT_MS } from './scenario-helpers.js';
import { insertEntry, isoOf } from './vault-ops.js';
import type { HarnessDevice } from './harness-device.js';
import type { AppFacts } from '../../host.js';

const SEC = 1000;
const MIN = 60 * SEC;
const DAY = 24 * 60 * MIN;

let h: SyncHarness;

afterEach(async () => {
  for (const d of h.devices) expect(d.logger.unprefixed()).toEqual([]);
  expect(await h.dispose()).toEqual([]);
});

/** mac (new build) holding e1 and e2, published and uploaded. */
async function mac(label: string, start: boolean, app?: AppFacts): Promise<HarnessDevice> {
  h = new SyncHarness(label);
  const a = await h.create({ name: 'mac', start, ...(app ? { app } : {}) });
  a.insert({ id: 'e1', host: 'h0', notes: 'n0' });
  a.insert({ id: 'e2', host: 'h2' });
  if (start) await h.advance(3 * SEC);
  else await a.sync();
  h.cloud.upload('mac');
  return a;
}

function legacyOn(mirror: string): LegacyDesktop {
  h.cloud.download(mirror);
  return new LegacyDesktop(h.cloud.sharedPath(mirror), h.requireVault().key, () => h.clock.now());
}

function heldCounts(d: HarnessDevice): { deletes: number; reverts: number } | null {
  const p = d.status().prompts.find((x) => x.kind === 'held-legacy');
  return p?.kind === 'held-legacy' ? { deletes: p.deletes, reverts: p.reverts } : null;
}

function sideFilesIn(dir: string): string[] {
  return fs.readdirSync(dir).filter((n) => n.endsWith('-wal') || n.endsWith('-shm'));
}

describe('spec 12: desktop 0.17 and its side files', { timeout: SCENARIO_TIMEOUT_MS }, () => {
  it('T-FS-13: 0.17 editing S on another computer: edits absorbed, publishing paused, deletes held, our edits kept in W', async () => {
    const a = await mac('fs13', true);
    const legacy = legacyOn('win017');
    legacy.edit((v) => {
      v.updateEntry('e1', { host: 'from 0.17' });
      v.deleteEntry('e2');
    });
    // Side files arrive first and are seen by a poll; then S (the other order is the race test below).
    expect(h.cloud.copySideFiles('win017', 'mac')).toBe(2);
    await h.advance(4 * SEC);
    h.cloud.upload('win017');
    h.cloud.download('mac');
    const delivered = fileSha(a.sharedPath);
    a.insert({ id: 'mine' });
    await h.advance(5 * SEC);
    expect(a.row('e1')?.host).toBe('from 0.17');
    expect(a.live('e2')).toBe(true);
    expect(heldCounts(a)).toEqual({ deletes: 1, reverts: 0 });
    expect(a.status().pauseReason).toBe('side-files');
    expect(fileSha(a.sharedPath)).toBe(delivered);
    expect(a.live('mine')).toBe(true);

    await a.engine.applyHeld();
    await h.advance(3 * SEC);
    expect(a.live('e2')).toBe(false);
    expect(fileSha(a.sharedPath)).toBe(delivered);

    legacy.close();
    h.cloud.removeSideFiles('mac');
    await h.advance(5 * SEC);
    const s = h.peek(a.sharedPath);
    expect([s.content.entries.has('mine'), s.content.entries.get('e1')?.host, s.content.entries.has('e2')]).toEqual([true, 'from 0.17', false]);
  });

  // Guards a gap in the cycle contract (it passes only the side-file view and the server flag
  // as hold inputs): once the side files go, re-absorbing the SAME S with the hold off
  // would apply the held delete without review, although 5.5 says held changes wait for the user.
  it('T-FS-13 (held): held deletes keep waiting for the user after the side files go away', async () => {
    const a = await mac('fs13-held', true);
    const legacy = legacyOn('win017');
    legacy.edit((v) => v.deleteEntry('e2'));
    h.cloud.copySideFiles('win017', 'mac');
    await h.advance(4 * SEC);
    h.cloud.upload('win017');
    h.cloud.download('mac');
    await h.advance(5 * SEC);
    expect(heldCounts(a)?.deletes).toBe(1);
    legacy.close();
    h.cloud.removeSideFiles('mac');
    await h.advance(5 * SEC);
    expect(a.live('e2')).toBe(true);
  });

  it('T-FS-14: 0.17 quit unlocked on this computer: upgrade wording; a non-empty WAL is reviewed first, then [Continue] moves the files and publishes', async () => {
    let firstLaunch = Number.MAX_SAFE_INTEGER;
    const app: AppFacts = { settingsListsVault: () => true, thisBuildFirstLaunchMs: () => firstLaunch };
    const a = await mac('fs14', true, app);
    await a.lock();
    const legacy = new LegacyDesktop(a.sharedPath, h.requireVault().key, () => h.clock.now());
    legacy.crashWithWal((db) => insertEntry(db, { id: 'walrow', host: 'only in the WAL' }, isoOf(h.clock.now()), null));
    expect(fs.statSync(`${a.sharedPath}-wal`).size).toBeGreaterThan(0);
    await h.jump(MIN);
    firstLaunch = h.clock.now();
    await a.relaunch();
    const view = a.engine.parts().sideFiles.view();
    expect(view).toMatchObject({ state: 'present', upgradeWording: true, walNonEmpty: true, publishAllowed: false });
    expect(a.status().prompts.find((p) => p.kind === 'side-files')).toMatchObject({ upgradeWording: true, walNonEmpty: true });
    expect(a.live('walrow')).toBe(false);

    expect(await a.engine.confirmSideFiles(view.tuples, false)).toEqual({ kind: 'review-first' });
    const id = await a.engine.reviewSideFileWal();
    const preview = await a.engine.parts().candidates.preview(id);
    expect(preview.onlyInCopy.map((r) => r.row.rowId)).toEqual(['walrow']);
    await a.engine.parts().candidates.apply(id, { deleteMissing: [] });
    const res = await a.engine.confirmSideFiles(a.engine.parts().sideFiles.view().tuples, true);
    expect(res.kind).toBe('confirmed');
    await h.advance(3 * SEC);
    expect(sideFilesIn(path.dirname(a.sharedPath))).toEqual([]);
    const moved = fs.readdirSync(a.replica.paths.dir).filter((n) => n.startsWith('sidefiles-'));
    expect(moved).toHaveLength(1);
    expect(fs.readdirSync(path.join(a.replica.paths.dir, moved[0] as string)).sort()).toEqual(['Vault.conduit-shm', 'Vault.conduit-wal']);
    expect(h.peek(a.sharedPath).content.entries.get('walrow')?.host).toBe('only in the WAL');
  });

  it('T-FS-14 (empty WAL): [Continue] moves the side files aside and publishes at once', async () => {
    const a = await mac('fs14-empty', true);
    await a.lock();
    new LegacyDesktop(a.sharedPath, h.requireVault().key, () => h.clock.now()).crashWithWal(() => undefined);
    expect(fs.statSync(`${a.sharedPath}-wal`).size).toBe(0);
    await a.relaunch();
    a.insert({ id: 'after-upgrade' });
    await h.advance(3 * SEC);
    expect(a.status().pauseReason).toBe('side-files');
    expect(h.peek(a.sharedPath).content.entries.has('after-upgrade')).toBe(false);
    const res = await a.engine.confirmSideFiles(a.engine.parts().sideFiles.view().tuples, false);
    expect(res.kind).toBe('confirmed');
    await h.advance(3 * SEC);
    expect(sideFilesIn(path.dirname(a.sharedPath))).toEqual([]);
    expect(h.peek(a.sharedPath).content.entries.has('after-upgrade')).toBe(true);
  });

  it('T-FS-32: a stale -wal from another machine next to a newer S is never read; publishing pauses until it is moved aside', async () => {
    const a = await mac('fs32', true);
    const legacy = legacyOn('win017');
    legacy.crashWithWal((db) => {
      db.prepare("DELETE FROM entries WHERE id = 'e1'").run();
      insertEntry(db, { id: 'walonly' }, isoOf(h.clock.now()), null);
    });
    a.insert({ id: 'newer' });
    await h.advance(3 * SEC);
    const newerSha = fileSha(a.sharedPath);
    expect(h.cloud.copySideFiles('win017', 'mac')).toBe(2);
    await h.advance(4 * SEC);
    a.update('e2', { host: 'paused edit' });
    await h.advance(5 * SEC);
    expect(a.status().pauseReason).toBe('side-files');
    expect(fileSha(a.sharedPath)).toBe(newerSha);
    expect([a.live('walonly'), a.live('e1')]).toEqual([false, true]);
    const view = a.engine.parts().sideFiles.view();
    expect(await a.engine.confirmSideFiles(view.tuples, false)).toEqual({ kind: 'review-first' });
    const res = await a.engine.confirmSideFiles(view.tuples, true);
    expect(res.kind).toBe('confirmed');
    await h.advance(3 * SEC);
    const s = h.peek(a.sharedPath);
    expect([s.content.entries.get('e2')?.host, s.content.entries.has('walonly'), s.content.entries.has('e1')]).toEqual(['paused edit', false, true]);
  });

  it('T-FS-49: 0.17 WAL folded by iPad 1.0.5 into a mixed file: the Mac with side files holds its delete; the server flag holds it too', async () => {
    const a = await mac('fs49', true);
    const b = await h.join({ name: 'mac2', start: false });
    const legacy = legacyOn('win017');
    legacy.crashWithWal((db) => {
      db.prepare("DELETE FROM entries WHERE id = 'e2'").run();
      db.prepare("UPDATE entries SET host = 'from wal', updated_at = ? WHERE id = 'e1'").run(isoOf(h.clock.now()));
    });
    h.cloud.download('ipad');
    h.cloud.copySideFiles('win017', 'ipad');
    h.cloud.copySideFiles('win017', 'mac');
    const ios = new Ios105(h.cloud.sharedPath('ipad'), path.join(h.root, 'ipad-sandbox'), h.requireVault().key, () => h.clock.now());
    ios.stage();
    expect(ios.row('e2')).toBeUndefined();
    await h.jump(MIN);
    ios.save('e1', { notes: 'from iPad' });
    ios.writeBack();
    expect(sideFilesIn(path.dirname(ios.source))).toEqual([]);
    h.cloud.upload('ipad');
    h.cloud.download('mac');
    await h.advance(5 * SEC);
    expect(a.row('e1')).toMatchObject({ host: 'from wal', notes: 'from iPad' });
    expect(a.live('e2')).toBe(true);
    expect(heldCounts(a)?.deletes).toBe(1);

    b.session.sideFlagRecent = true;
    h.cloud.download('mac2');
    await b.sync();
    expect(b.row('e1')?.notes).toBe('from iPad');
    expect(b.live('e2')).toBe(true);
    expect(b.replica.local().heldLegacy.map((x) => x.kind)).toEqual(['delete']);
  });

  it('T-FS-50: an iPhone 1.0.5 edit, then a stale 0.17 delete two minutes later: the delete follows the legacy clock and wins', async () => {
    const a = await mac('fs50', false);
    h.cloud.download('iphone');
    const legacy = legacyOn('win017');
    const ios = new Ios105(h.cloud.sharedPath('iphone'), path.join(h.root, 'iphone-sandbox'), h.requireVault().key, () => h.clock.now());
    ios.stage();
    ios.save('e1', { notes: 'edited on iPhone' });
    ios.writeBack();
    h.cloud.upload('iphone');
    h.cloud.download('mac');
    await a.sync();
    expect(a.row('e1')?.notes).toBe('edited on iPhone');
    await h.jump(2 * MIN);
    legacy.edit((v) => v.deleteEntry('e1'));
    legacy.close();
    h.cloud.upload('win017');
    h.cloud.download('mac');
    await a.sync();
    expect(a.live('e1')).toBe(false);
    expect(itemOf(a.conflicts(), 'e1', 'edit-delete')).toBeNull();
  });

  it('T-FS-51: 0.17 left unlocked over a weekend: publishing stays paused, S is never replaced under its live connection', async () => {
    const a = await mac('fs51', true);
    const legacy = new LegacyDesktop(a.sharedPath, h.requireVault().key, () => h.clock.now());
    legacy.edit((v) => v.updateEntry('e1', { notes: 'friday edit in 0.17' }));
    const inode = fs.statSync(a.sharedPath).ino;
    await h.advance(4 * SEC);
    a.insert({ id: 'mine' });
    await h.advance(5 * SEC);
    expect(a.status().pauseReason).toBe('side-files');
    expect(a.row('e1')?.notes).toBe('friday edit in 0.17');
    const fin = await a.lock();
    expect(fin.pendingPublish).toBe(true);
    await h.jump(2.5 * DAY);
    await a.relaunch();
    await h.advance(5 * SEC);
    expect(a.status().pauseReason).toBe('side-files');
    expect(fs.statSync(a.sharedPath).ino).toBe(inode);
    expect(h.peek(a.sharedPath).content.entries.has('mine')).toBe(false);
    legacy.edit((v) => v.updateEntry('e2', { notes: 'monday edit in 0.17' }));
    await h.advance(65 * SEC);
    expect(a.row('e2')?.notes).toBe('monday edit in 0.17');
    expect(fs.statSync(a.sharedPath).ino).toBe(inode);
    legacy.close();
    await h.advance(5 * SEC);
    expect(sideFilesIn(path.dirname(a.sharedPath))).toEqual([]);
    const s = h.peek(a.sharedPath);
    expect([s.content.entries.has('mine'), s.content.entries.get('e2')?.notes]).toEqual([true, 'monday edit in 0.17']);
  });

  // Guard a gap in the cycle contract: with only the watcher's 3 s stat poll feeding side-files, a
  // cycle triggered by a folder event, a local edit, the safety poll or a verify check within one
  // poll of 0.17 opening S would rename a new S over its live connection and apply its deletes.
  // The cycle must re-stat S-wal/S-shm (sideFiles.observe) right after reading S.
  it('T-FS-13 (race): S and its side files delivered together: the folder-event cycle must already hold deletes and pause', async () => {
    const a = await mac('fs13-race', true);
    await h.advance(60 * SEC);
    const legacy = legacyOn('win017');
    legacy.edit((v) => v.deleteEntry('e2'));
    h.cloud.upload('win017');
    h.cloud.download('mac');
    h.cloud.copySideFiles('win017', 'mac');
    const delivered = fileSha(a.sharedPath);
    a.insert({ id: 'mine' });
    await h.advance(5 * SEC);
    legacy.close();
    expect({ e2Live: a.live('e2'), untouched: fileSha(a.sharedPath) === delivered }).toEqual({ e2Live: true, untouched: true });
  });

  it('T-FS-51 (race): side files that appeared less than one poll ago still pause publishing and hold deletes', async () => {
    const a = await mac('fs51-race', true);
    await h.advance(60 * SEC);
    const legacy = new LegacyDesktop(a.sharedPath, h.requireVault().key, () => h.clock.now());
    legacy.edit((v) => v.deleteEntry('e2'));
    const inode = fs.statSync(a.sharedPath).ino;
    a.insert({ id: 'mine' });
    await h.advance(2 * SEC);
    const published = fs.statSync(a.sharedPath).ino !== inode;
    legacy.close();
    expect({ published, e2Live: a.live('e2') }).toEqual({ published: false, e2Live: true });
  });
});
