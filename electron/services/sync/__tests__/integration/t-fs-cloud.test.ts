// @vitest-environment node
// Spec 12 rows about what cloud drives do to S, through the REAL SyncEngine with its watcher,
// timers and CAS publish on real files, driven by the FakeCloud adversary: T-FS-7 (and the 5.7
// regression back-off), 8, 18, 22, 26, 33, 44, 52, 60.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { vvCovers } from '../../sibling.js';
import { SyncHarness } from './sync-harness.js';
import { Ios105 } from './legacy-ios.js';
import { fileSha, SCENARIO_TIMEOUT_MS } from './scenario-helpers.js';
import type { HarnessDevice } from './harness-device.js';

const SEC = 1000;
const MIN = 60 * SEC;
const DAY = 24 * 60 * MIN;
/** The publish temp next to S (.~<name>.<rand>.tmp), not the private staging temps. */
const PUBLISH_TEMP_IN_MIRROR = /mirrors[\\/]mac[\\/]\.~.*\.tmp$/;

let h: SyncHarness;

afterEach(async () => {
  for (const d of h.devices) expect(d.logger.unprefixed()).toEqual([]);
  expect(await h.dispose()).toEqual([]);
});

async function pair(label: string, start: boolean): Promise<[HarnessDevice, HarnessDevice]> {
  h = new SyncHarness(label);
  const a = await h.create({ name: 'mac', start });
  a.insert({ id: 'e1', host: 'h0', notes: 'aaaa' });
  if (start) await h.advance(3 * SEC);
  else await a.sync();
  h.cloud.upload('mac');
  const b = await h.join({ name: 'pc', start });
  await h.idle();
  return [a, b];
}

/** In-place edit of a file by an older app (rollback journal, no side files left). */
function editInPlace(file: string, sql: string): void {
  const db = new Database(file);
  try {
    db.pragma('journal_mode = DELETE');
    db.exec(sql);
  } finally {
    db.close();
  }
}

describe('spec 12: cloud drive behavior', { timeout: SCENARIO_TIMEOUT_MS }, () => {
  it('T-FS-7: a silent overwrite is found on the next read or covers check; A merges and republishes; nothing lost', async () => {
    const [a, b] = await pair('fs7', true);
    a.insert({ id: 'a1' });
    b.insert({ id: 'b1' });
    await h.advance(3 * SEC);
    const aPublishes = a.session.markers.length;
    h.cloud.upload('mac');
    h.cloud.upload('pc');
    h.cloud.download('mac');
    await h.advance(20 * SEC);
    expect(a.session.markers.length).toBe(aPublishes + 1);
    const s = h.peek(a.sharedPath);
    expect([s.content.entries.has('a1'), s.content.entries.has('b1')]).toEqual([true, true]);
    h.cloud.sync('mac');
    await h.advance(65 * SEC);
    for (const d of [a, b]) expect([d.live('a1'), d.live('b1')]).toEqual([true, true]);
    expect(b.status().kind).toBe('up-to-date');
  });

  it('T-FS-7 (5.7): more than 3 regressions in 10 minutes back off publishing with one toast', async () => {
    const [a] = await pair('fs7-backoff', false);
    const initial = h.cloud.current();
    a.insert({ id: 'r1' });
    expect((await a.sync()).kind).toBe('published');
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i++) {
      h.cloud.download('mac', { version: initial?.id, mtime: 'now' });
      await h.jump(10 * SEC);
      outcomes.push((await a.sync()).kind);
    }
    expect(outcomes).toEqual(['published', 'published', 'published', 'merged-not-published']);
    expect(a.status()).toMatchObject({ kind: 'paused', pauseReason: 'regression-backoff' });
    expect(a.toasts('regression-backoff')).toHaveLength(1);
    expect(a.live('r1')).toBe(true);
  });

  // Guards a gap in the verify contract (a regression recorded on every read of S): an old copy
  // that sticks after the back-off started would renew the back-off at every read, so the device
  // would never republish. One regression per lost publish lets it recover once the block ends.
  it('T-FS-7 (stuck): after the back-off, an old copy that stays in place is replaced once the block ends', async () => {
    const [a] = await pair('fs7-stuck', true);
    const initial = h.cloud.current();
    a.insert({ id: 'r1' });
    await h.advance(3 * SEC);
    for (let i = 0; i < 4; i++) {
      h.cloud.download('mac', { version: initial?.id, mtime: 'now' });
      await h.advance(5 * SEC);
    }
    expect(a.status().pauseReason).toBe('regression-backoff');
    expect(h.peek(a.sharedPath).content.entries.has('r1')).toBe(false);
    await h.advance(2 * MIN);
    expect(h.peek(a.sharedPath).content.entries.has('r1')).toBe(true);
    expect(a.status().kind).toBe('up-to-date');
    expect(a.toasts('regression-backoff')).toHaveLength(1);
  });

  it('T-FS-8: A closed for a week after the cloud kept B version: its edits wait in W and publish at the next unlock', async () => {
    const [a, b] = await pair('fs8', false);
    a.insert({ id: 'a1' });
    await a.sync();
    b.insert({ id: 'b1' });
    await b.sync();
    h.cloud.upload('mac');
    h.cloud.upload('pc');
    const fin = await a.lock();
    expect(fin.pendingPublish).toBe(false);
    for (let day = 0; day < 7; day++) {
      await h.jump(DAY);
      h.cloud.download('pc');
      await b.sync();
      expect(b.live('a1')).toBe(false);
    }
    h.cloud.download('mac');
    expect((await a.relaunch())?.kind).toBe('published');
    expect([a.live('a1'), a.live('b1')]).toEqual([true, true]);
    h.cloud.sync('mac');
    await b.sync();
    expect(b.live('a1')).toBe(true);
  });

  it('T-FS-18: torn S is retried at 5, 15 and 45 s, quarantined after 2 minutes and republished from W; B republishes its own edits', async () => {
    const [a, b] = await pair('fs18', true);
    b.insert({ id: 'b1' });
    await h.advance(3 * SEC);
    h.cloud.upload('pc');
    h.cloud.tornDownload('mac', 0.5);
    await h.advance(4 * SEC);
    expect(a.status().pauseReason).toBe('unreadable');
    expect(fs.readdirSync(a.replica.paths.quarantine)).toEqual([]);
    await h.advance(125 * SEC);
    expect(fs.readdirSync(a.replica.paths.quarantine)).toHaveLength(1);
    expect(h.classify(a.sharedPath).kind).toBe('synced');
    expect(a.live('b1')).toBe(false);
    h.cloud.upload('mac');
    h.cloud.download('pc');
    await h.advance(5 * SEC);
    h.cloud.upload('pc');
    h.cloud.download('mac');
    await h.advance(5 * SEC);
    for (const d of [a, b]) expect(d.live('b1')).toBe(true);
  });

  it('T-FS-22: a failed publish leaves S and W intact; stale temps are cleaned at start; hook-skipping writes are captured at start', async () => {
    const [a] = await pair('fs22', false);
    a.insert({ id: 'x1' });
    const before = fileSha(a.sharedPath);
    a.fs.inject({ op: 'writeFileDurable', match: /\.tmp$/, code: 'ENOSPC' });
    expect(['error', 'backoff']).toContain((await a.sync()).kind);
    expect(fileSha(a.sharedPath)).toBe(before);
    expect(fs.readdirSync(path.dirname(a.sharedPath)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(a.toasts('publish-failed')).toHaveLength(1);
    expect(a.replica.local().pendingPublish).toBe(true);
    expect((await a.sync()).kind).toBe('published');

    const stale = path.join(path.dirname(a.sharedPath), '.~Vault.conduit.abc123.tmp');
    fs.writeFileSync(stale, 'partial');
    h.cloud.touch(stale, h.clock.now() - 2 * 60 * MIN);
    await a.crash();
    const w = new Database(a.replica.paths.working);
    w.prepare("UPDATE entries SET host = 'raw write' WHERE id = 'e1'").run();
    w.close();
    expect((await a.relaunch(true, true))?.kind).toBe('published');
    await h.idle();
    expect(fs.existsSync(stale)).toBe(false);
    expect(h.peek(a.sharedPath).content.entries.get('e1')?.host).toBe('raw write');
  });

  it('5.3 on Windows: rename over S fails with EPERM/EBUSY (OneDrive holds it): retried, then written in place; S stays valid', async () => {
    const [a] = await pair('publish-eperm', false);
    a.insert({ id: 'x1' });
    a.fs.inject({ op: 'rename', match: PUBLISH_TEMP_IN_MIRROR, code: 'EPERM', times: 2 });
    expect((await h.whileAdvancing(a.sync())).kind).toBe('published');
    const inode = fs.statSync(a.sharedPath).ino;
    a.insert({ id: 'x2' });
    a.fs.inject({ op: 'rename', match: PUBLISH_TEMP_IN_MIRROR, code: 'EBUSY', times: 5 });
    expect((await h.whileAdvancing(a.sync())).kind).toBe('published');
    expect(fs.statSync(a.sharedPath).ino).toBe(inode);
    expect(fs.readdirSync(path.dirname(a.sharedPath)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(h.classify(a.sharedPath).kind).toBe('synced');
    const s = h.peek(a.sharedPath).content.entries;
    expect([s.has('x1'), s.has('x2')]).toEqual([true, true]);
    expect((await a.sync()).kind).toBe('up-to-date');
  });

  it('T-FS-26 (engine side): B reads S before A publish arrives: the marker is uncovered, then covered on delivery', async () => {
    const [a, b] = await pair('fs26', false);
    a.insert({ id: 'late' });
    await a.sync();
    const marker = a.session.markers.at(-1);
    expect(marker).toBeDefined();
    if (marker === undefined) return;
    await b.sync();
    const stale = b.session.sharedStates.at(-1);
    expect(stale && vvCovers(stale.vv, marker.dev, marker)).toBe(false);
    h.cloud.sync('mac');
    await b.sync();
    const fresh = b.session.sharedStates.at(-1);
    expect(fresh && vvCovers(fresh.vv, marker.dev, marker)).toBe(true);
    expect(b.live('late')).toBe(true);
  });

  it('T-FS-33: a replaced S with an older mtime is caught by the stat poll; equal size, mtime and inode by the 60 s hash', async () => {
    const [a, b] = await pair('fs33', true);
    const t0 = h.startMs;
    b.update('e1', { host: 'from pc' });
    await h.advance(3 * SEC);
    h.cloud.upload('pc');
    h.cloud.download('mac', { mtime: 'older' });
    await h.advance(4 * SEC);
    expect(a.row('e1')?.host).toBe('from pc');

    // Past the publish verify checks, and just after a 60 s poll tick of A's engine.
    await h.advance(70 * SEC);
    await h.advance(t0 + Math.ceil((h.clock.now() - t0) / MIN) * MIN + SEC - h.clock.now());
    const st = fs.statSync(a.sharedPath);
    editInPlace(a.sharedPath, "UPDATE entries SET notes = 'bbbb' WHERE id = 'e1'");
    h.cloud.touch(a.sharedPath, st.mtimeMs);
    const after = fs.statSync(a.sharedPath);
    expect([after.size, after.mtimeMs, after.ino]).toEqual([st.size, st.mtimeMs, st.ino]);
    await h.advance(50 * SEC);
    expect(a.row('e1')?.notes).toBe('aaaa');
    await h.advance(15 * SEC);
    expect(a.row('e1')?.notes).toBe('bbbb');
  });

  it('T-FS-44: a sync_format 2 file is foreign: the device stops publishing to it and never overwrites it', async () => {
    const [a, b] = await pair('fs44', false);
    await b.lock();
    editInPlace(b.sharedPath, "UPDATE vault_meta SET value = '2' WHERE key = 'sync_format'");
    h.cloud.touch(b.sharedPath);
    h.cloud.upload('pc');
    h.cloud.download('mac');
    const foreignSha = fileSha(a.sharedPath);
    a.update('e1', { host: 'kept on this device' });
    for (let i = 0; i < 3; i++) {
      expect(await a.sync()).toEqual({ kind: 'paused', reason: 'foreign-newer-format' });
      await h.jump(MIN);
    }
    expect(fileSha(a.sharedPath)).toBe(foreignSha);
    expect(h.cloud.upload('mac')).toBeNull();
    expect(a.status().prompts.map((p) => p.kind)).toContain('foreign-newer-format');
    expect(a.row('e1')?.host).toBe('kept on this device');
  });

  it('T-FS-52: a file of another vault at the bound path is never overwritten; Locate is offered', async () => {
    const [a] = await pair('fs52', false);
    const other = h.add({ name: 'other', start: false });
    const nv = other.newVault();
    await other.open(nv.lineageId, nv.key, nv.seed, await other.bindingFor(null));
    expect(await other.engine.publishInitial()).toBe(true);
    fs.copyFileSync(other.sharedPath, a.sharedPath);
    h.cloud.touch(a.sharedPath);
    const foreignSha = fileSha(a.sharedPath);
    a.update('e1', { host: 'mine' });
    for (let i = 0; i < 3; i++) expect(await a.sync()).toEqual({ kind: 'paused', reason: 'foreign-other-vault' });
    expect(fileSha(a.sharedPath)).toBe(foreignSha);
    expect(a.status().prompts.map((p) => p.kind)).toContain('foreign-other-vault');
    expect(a.row('e1')?.host).toBe('mine');
  });

  it('T-FS-60: a desktop clock 5 minutes behind still publishes with mtime >= S mtime + 2 s, so iOS 1.0.5 pulls it', async () => {
    const [a] = await pair('fs60', false);
    a.dh.clock.offsetMs = -5 * MIN;
    h.cloud.download('iphone');
    const ios = new Ios105(h.cloud.sharedPath('iphone'), path.join(h.root, 'ios-sandbox'), h.requireVault().key, () => h.clock.now());
    ios.stage();
    ios.save('e1', { notes: 'from iPhone' });
    ios.writeBack();
    const iosMtime = fs.statSync(ios.source).mtimeMs;
    h.cloud.upload('iphone');
    h.cloud.download('mac');
    a.update('e1', { host: 'desk' });
    expect((await a.sync()).kind).toBe('published');
    expect(fs.statSync(a.sharedPath).mtimeMs).toBeGreaterThanOrEqual(iosMtime + 2 * SEC);
    h.cloud.upload('mac');
    h.cloud.download('iphone');
    expect(ios.poll()).toBe(true);
    expect(ios.row('e1')).toMatchObject({ host: 'desk', notes: 'from iPhone' });
  });
});
