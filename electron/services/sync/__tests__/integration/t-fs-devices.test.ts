// @vitest-environment node
// Spec 12 rows about devices over time: restores and clones, launches, clocks, mass deletes and
// undo, migrating legacy files, the kill switch and owner claims, through the REAL SyncEngine,
// replica, snapshots and claims modules on real files: T-FS-28, 29 (data side), 30, 34, 37, 39,
// 43, 54, 55, 69, 70 (presence half).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claimWrites, evaluateClaims, readOwnerClaim, shouldDisplace } from '../../../vault-session/claims.js';
import { loadOrCreateDevice } from '../../identity.js';
import { isRecentlyActive, readPresence } from '../../presence.js';
import { readPendingSummaries } from '../../replica.js';
import { writePresence } from '../../sync-engine-presence.js';
import { undoApply } from '../../app-sync-review.js';
import { restoreWrites } from '../../tombstones.js';
import { createLegacyVault } from '../core-e2e-fixtures.js';
import { SyncHarness } from './sync-harness.js';
import { LegacyDesktop, withSimDate } from './legacy-desktop.js';
import { conflictLines, fieldConflict, SCENARIO_TIMEOUT_MS } from './scenario-helpers.js';
import { entryKey, type HarnessDevice } from './harness-device.js';
import { contentOf } from './vault-ops.js';

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const LAUNCHES = 40;
const MEASURE_FROM = 9;
const LAUNCH_TEST_TIMEOUT_MS = 30_000;
/** One vv row plus one sync_dev row per launch is about 70 bytes; allow page-granular slack. */
const MAX_BYTES_PER_LAUNCH = 250;

let h: SyncHarness;

afterEach(async () => {
  for (const d of h.devices) expect(d.logger.unprefixed()).toEqual([]);
  expect(await h.dispose()).toEqual([]);
});

async function pair(label: string, seed: (a: HarnessDevice) => void = () => undefined): Promise<[HarnessDevice, HarnessDevice]> {
  h = new SyncHarness(label);
  const a = await h.create({ name: 'mac', start: false });
  seed(a);
  await h.syncAll();
  const b = await h.join({ name: 'pc', start: false });
  await h.syncAll();
  return [a, b];
}

/** Time Machine copy of W and local.json (taken while the vault is locked). */
function backupW(d: HarnessDevice): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const p of [d.replica.paths.working, d.replica.paths.local]) out.set(p, fs.readFileSync(p));
  return out;
}

function restoreW(files: Map<string, Buffer>): void {
  for (const [p, bytes] of files) {
    for (const suffix of ['-wal', '-shm']) fs.rmSync(`${p}${suffix}`, { force: true });
    fs.writeFileSync(p, bytes);
  }
}

function ids(n: number, prefix: string): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

describe('spec 12: devices over time', { timeout: SCENARIO_TIMEOUT_MS }, () => {
  it('T-FS-30: a working copy restored under a running app, or at a new launch, gets a new incarnation; no dot is reused', async () => {
    h = new SyncHarness('fs30');
    const a = await h.create({ name: 'mac', start: false });
    a.insert({ id: 'x1' });
    await a.sync();
    await a.lock();
    const backup = backupW(a);
    const devBefore = (await a.relaunch(), a.replica.dev());
    a.insert({ id: 'x2' });
    await a.sync();
    await a.lock();
    restoreW(backup);
    await a.open(a.lineageId, a.key, { kind: 'existing' }, null);
    await a.unlock(false);
    const devSameLaunch = a.replica.dev();
    expect(devSameLaunch).not.toBe(devBefore);
    a.insert({ id: 'x3' });
    await a.sync();
    expect(['x1', 'x2', 'x3'].every((id) => a.live(id))).toBe(true);
    expect(a.toasts('dev-collision')).toEqual([]);
    await a.lock();
    restoreW(backup);
    await a.relaunch();
    expect([devBefore, devSameLaunch]).not.toContain(a.replica.dev());
    expect(['x1', 'x2', 'x3'].every((id) => a.live(id))).toBe(true);

    const clone = path.join(h.root, 'cloned-mac', 'sync');
    fs.cpSync(a.syncRoot, clone, { recursive: true });
    const otherHw = crypto.createHash('sha256').update('another machine').digest('hex');
    expect(loadOrCreateDevice(clone, otherHw, () => crypto.randomUUID()).deviceUuid).not.toBe(a.deviceUuid);
    expect(loadOrCreateDevice(clone, a.hwHint, () => crypto.randomUUID()).deviceUuid).toBe(a.deviceUuid);
  });

  it('T-FS-34: a real mass delete of 42 items takes a snapshot with a diff and a notice; Undo re-creates exactly those 42', async () => {
    const all = ids(50, 'm');
    const [a, b] = await pair('fs34', (a) => all.forEach((id) => a.insert({ id })));
    a.remove(all.slice(0, 42));
    await a.sync();
    h.cloud.upload('mac');
    h.cloud.download('pc');
    await b.sync();
    const notice = b.replica.local().notices.find((n) => n.kind === 'mass-change');
    expect(notice?.count).toBe(42);
    const snaps = await b.engine.parts().snapshots.list();
    expect(snaps.map((s) => [s.meta.deleted, s.meta.byDeviceUuid])).toEqual([[42, a.deviceUuid]]);
    const snap = snaps[0];
    if (snap === undefined) return;
    const preview = await b.engine.parts().snapshots.undoPreview(snap.id, b.state(), b.replica.implicit(), b.replica.ring());
    expect(preview.rows.filter((r) => r.stillDeleted)).toHaveLength(42);
    // [Undo selected] through the IPC entry point: the toast counts the 42 items, not register writes.
    expect(await undoApply({ replica: b.replica, engine: b.engine }, snap.id, preview.rows.map((r) => r.row), [])).toEqual({ applied: 42 });
    await h.syncAll();
    for (const d of [a, b]) expect(all.every((id) => d.live(id))).toBe(true);
  });

  it('T-FS-43: Undo two days later offers back only what the merge deleted and leaves later edits elsewhere untouched', async () => {
    const all = ids(50, 'm');
    const [a, b] = await pair('fs43', (a) => all.forEach((id) => a.insert({ id, host: 'h0' })));
    a.remove(all.slice(0, 42));
    await a.sync();
    h.cloud.upload('mac');
    h.cloud.download('pc');
    await b.sync();
    await h.jump(2 * DAY);
    a.write(restoreWrites(a.state(), [entryKey('m0')], a.replica.context()));
    a.update('m45', { host: 'edited later on mac' });
    await h.syncAll();
    const snap = (await b.engine.parts().snapshots.list())[0];
    if (snap === undefined) throw new Error('no snapshot');
    const preview = await b.engine.parts().snapshots.undoPreview(snap.id, b.state(), b.replica.implicit(), b.replica.ring());
    expect(preview.rows.filter((r) => !r.stillDeleted).map((r) => r.row.rowId)).toEqual(['m0']);
    const chosen = preview.rows.filter((r) => r.stillDeleted).map((r) => r.row);
    b.write(await b.engine.parts().snapshots.undoWrites(snap.id, b.state(), { rows: chosen, fields: [] }, b.replica.ring(), b.replica.context()));
    await h.syncAll();
    for (const d of [a, b]) {
      expect(all.every((id) => d.live(id))).toBe(true);
      expect(d.row('m45')?.host).toBe('edited later on mac');
    }
  });

  it('T-FS-37: two devices migrating the same legacy bytes get the same genesis; different versions: the shared genesis wins, newer differences become a candidate', async () => {
    h = new SyncHarness('fs37');
    const fx = withSimDate(h.clock.now(), () => createLegacyVault(h.cloud.mirror('seed')));
    h.cloud.touch(h.cloud.sharedPath('seed'));
    h.cloud.upload('seed');
    h.cloud.download('mac');
    h.cloud.download('pc');
    const a = await h.genesis({ name: 'mac', start: false }, fx.source.key, { download: false });
    const b = await h.genesis({ name: 'pc', start: false }, fx.source.key, { download: false });
    expect(b.state().genesisId).toBe(a.state().genesisId);
    await h.syncAll();
    expect(conflictLines(a.conflicts())).toEqual([]);
    expect(JSON.stringify(contentOf(a.wc.db))).toBe(JSON.stringify(contentOf(b.wc.db)));

    h.cloud.download('ipad', { version: 1 });
    h.cloud.download('win', { version: 1 });
    await h.jump(MIN);
    const onWin = new LegacyDesktop(h.cloud.sharedPath('win'), fx.source.key, () => h.clock.now());
    onWin.edit((v) => v.updateEntry(fx.ids.desk, { host: 'desk v2' }));
    onWin.close();
    await h.jump(MIN);
    const onIpad = new LegacyDesktop(h.cloud.sharedPath('ipad'), fx.source.key, () => h.clock.now());
    onIpad.edit((v) => v.updateEntry(fx.ids.web, { notes: 'newer in v3' }));
    onIpad.close();
    const w = await h.genesis({ name: 'win', start: false }, fx.source.key, { download: false });
    const i = await h.genesis({ name: 'ipad', start: false }, fx.source.key, { download: false });
    expect(w.state().genesisId).not.toBe(i.state().genesisId);
    h.cloud.upload('win');
    h.cloud.download('ipad');
    await i.sync();
    expect(i.state().genesisId).toBe(w.state().genesisId);
    expect(i.row(fx.ids.desk)?.host).toBe('desk v2');
    const pending = i.engine.parts().candidates.list();
    expect(pending.map((c) => c.source)).toEqual(['genesis-leftovers']);
    const preview = await i.engine.parts().candidates.preview(pending[0]?.id ?? '');
    expect(preview.changedFields.map((f) => [f.key.rowId, f.key.reg])).toContainEqual([fx.ids.web, 'notes']);
    await i.engine.parts().candidates.apply(pending[0]?.id ?? '', { deleteMissing: [] });
    expect(fieldConflict(i.conflicts(), fx.ids.web, 'notes')?.versions.map((v) => v.value)).toContain('newer in v3');
  });

  it('T-FS-39: a Monday Time Machine restore of W and the cloud folder, offline Tuesday edits, then the real S: nothing vanishes', async () => {
    const [a, b] = await pair('fs39');
    a.insert({ id: 'mon1' });
    await h.syncAll();
    await a.lock();
    const monday = backupW(a);
    const mondayMirror = h.cloud.snapshotMirror('mac');
    await a.relaunch();
    const mondayDev = a.replica.dev();
    await h.jump(4 * 60 * MIN);
    a.insert({ id: 'mon2' });
    await h.syncAll();
    await a.lock();
    await h.jump(DAY);
    restoreW(monday);
    h.cloud.restoreMirror('mac', mondayMirror);
    await a.relaunch();
    expect(a.replica.dev()).not.toBe(mondayDev);
    expect(a.live('mon2')).toBe(false);
    a.insert({ id: 'tue1' });
    await a.sync();
    h.cloud.download('mac');
    await a.sync();
    await h.syncAll();
    for (const d of [a, b]) expect(['mon1', 'mon2', 'tue1'].map((id) => d.live(id))).toEqual([true, true, true]);
    expect(a.toasts('dev-collision')).toEqual([]);
  });

  it('T-FS-54: a day of edits under the kill switch stays pending, can be exported, and publishes when sync is back', async () => {
    h = new SyncHarness('fs54');
    const a = await h.create({ name: 'mac', start: false });
    a.dh.t.knobs.personalSyncPaused = true;
    a.insert({ id: 'k1' });
    expect(await a.sync()).toEqual({ kind: 'skipped', reason: 'kill-switch' });
    await h.jump(DAY);
    a.insert({ id: 'k2' });
    expect(await a.sync()).toEqual({ kind: 'skipped', reason: 'kill-switch' });
    const pending = await readPendingSummaries(a.machineDir, { host: a.host, incarnations: a.registry });
    expect(pending).toEqual([{ lineageId: a.lineageId, sharedPath: a.sharedPath, pendingPublish: true }]);
    const exported = await a.engine.exportUnsynced();
    expect(path.basename(exported)).toBe('Vault (unsynced changes).conduit');
    const copy = h.peek(exported);
    expect([copy.content.entries.has('k1'), copy.content.entries.has('k2')]).toEqual([true, true]);
    expect(h.peek(a.sharedPath).content.entries.has('k1')).toBe(false);
    a.dh.t.knobs.personalSyncPaused = false;
    expect((await a.engine.syncNow()).kind).toBe('published');
    expect(a.replica.local().pendingPublish).toBe(false);
  });

  it('T-FS-55: a VM cloned after Conduit ran (same machine id): both copies launch with their own dev; nothing collides or is lost', async () => {
    h = new SyncHarness('fs55');
    const a = await h.create({ name: 'vm1', start: false });
    a.insert({ id: 'e1', host: 'h0' });
    await a.sync();
    h.cloud.upload('vm1');
    await a.lock();
    const cloneRoot = path.join(h.root, 'devices', 'vm2', 'sync');
    fs.cpSync(a.syncRoot, cloneRoot, { recursive: true });
    fs.copyFileSync(a.sharedPath, h.cloud.sharedPath('vm2'));
    await a.relaunch();
    const b = h.add({ name: 'vm2', start: false, syncRoot: cloneRoot, hwHint: a.hwHint });
    expect(b.deviceUuid).toBe(a.deviceUuid);
    // The clone's local.json names the original's path; on its own disk that is its own file.
    await b.open(a.lineageId, a.key, { kind: 'existing' }, await b.bindingFor(a.replica.local().binding?.fileId ?? null));
    await b.unlock(true);
    expect(b.replica.dev()).not.toBe(a.replica.dev());
    a.update('e1', { host: 'vm1 value' });
    b.update('e1', { host: 'vm2 value' });
    await h.syncAll();
    for (const d of [a, b]) {
      expect(fieldConflict(d.conflicts(), 'e1', 'host')?.versions.map((v) => v.value).sort()).toEqual(['vm1 value', 'vm2 value']);
      expect(d.toasts('dev-collision')).toEqual([]);
    }
  });

  it(
    'T-FS-69: many launches grow the file by one vv entry each (a few dozen bytes); the reported marker stays one dot',
    async () => {
      h = new SyncHarness('fs69');
      const a = await h.create({ name: 'mac', start: false });
      a.insert({ id: 'e1', host: 'h0' });
      await a.sync();
      let sizeAtStart = 0;
      for (let i = 0; i < LAUNCHES; i++) {
        await a.crash();
        await a.relaunch(false);
        a.update('e1', { host: `launch ${i}` });
        await a.sync();
        if (i === MEASURE_FROM) sizeAtStart = fs.statSync(a.sharedPath).size;
      }
      const s = h.peek(a.sharedPath).state;
      expect(s.vv.size).toBe(LAUNCHES + 1);
      const perLaunch = (fs.statSync(a.sharedPath).size - sizeAtStart) / (LAUNCHES - 1 - MEASURE_FROM);
      expect(perLaunch).toBeLessThan(MAX_BYTES_PER_LAUNCH);
      const marker = a.replica.local().lastPublished?.markerDot;
      expect(marker).toEqual({ dev: a.replica.dev(), ms: s.vv.get(a.replica.dev())?.ms, c: s.vv.get(a.replica.dev())?.c });
    },
    LAUNCH_TEST_TIMEOUT_MS,
  );

  it('T-FS-70 (presence): a device clock 30 days fast once: its future activity is ignored for prompts; its later presence still wins by dot', async () => {
    const [a, b] = await pair('fs70-presence');
    const fast = 30 * DAY;
    b.dh.clock.offsetMs = fast;
    const parts = b.engine.parts();
    writePresence({ host: b.host, replica: b.replica, sideFiles: parts.sideFiles }, { sessionOpen: true, sessionSinceMs: b.now(), fileHint: parts.binding.fileHint() });
    await h.syncAll();
    const future = readPresence(a.state(), b.deviceUuid);
    expect(future?.value.last_active_ms).toBeGreaterThan(a.now() + DAY);
    expect(future && isRecentlyActive(future.value, a.now())).toBe(false);
    b.dh.clock.offsetMs = 0;
    writePresence({ host: b.host, replica: b.replica, sideFiles: parts.sideFiles }, { sessionOpen: true, sessionSinceMs: b.now(), fileHint: parts.binding.fileHint() });
    await h.syncAll();
    const fixed = readPresence(a.state(), b.deviceUuid);
    expect(fixed?.value.last_active_ms).toBe(a.now());
    expect(fixed && isRecentlyActive(fixed.value, a.now())).toBe(true);
    expect((fixed?.dot?.ms ?? 0) >= (future?.dot?.ms ?? Infinity)).toBe(true);
  });

  it('T-FS-28 (data side): two signed-out Free devices claim minutes apart: the later claim wins everywhere and displaces the other', async () => {
    const [a, b] = await pair('fs28');
    a.write(claimWrites(null, a.replica.context()));
    await h.jump(2 * MIN);
    b.write(claimWrites(null, b.replica.context()));
    await h.syncAll();
    for (const d of [a, b]) expect(readOwnerClaim(d.state())?.value.d).toBe(b.deviceUuid);
    const verdict = (d: HarnessDevice) =>
      evaluateClaims({ state: d.state(), ownDeviceUuid: d.deviceUuid, effectiveLimit: 1, shared: true, leaseConfirmed: false, sessions: [], nowMs: d.now() });
    expect(shouldDisplace(verdict(a))).toBe(true);
    expect(verdict(b).kind).toBe('ours');
  });

  it('T-FS-29 (data side): a signed-out iPad claim (a = null) displaces a signed-in desktop whose lease is confirmed', async () => {
    const [desk, ipad] = await pair('fs29');
    desk.write(claimWrites('acct-hint', desk.replica.context()));
    await h.syncAll();
    await h.jump(MIN);
    ipad.write(claimWrites(null, ipad.replica.context()));
    await h.syncAll();
    expect(readOwnerClaim(desk.state())?.value).toEqual({ a: null, d: ipad.deviceUuid });
    const v = evaluateClaims({ state: desk.state(), ownDeviceUuid: desk.deviceUuid, effectiveLimit: 1, shared: true, leaseConfirmed: true, sessions: [], nowMs: desk.now() });
    expect(v.kind).toBe('other');
    expect(shouldDisplace(v)).toBe(true);
  });

  it('T-FS-27 (engine side): a displaced device saves with the 15 s final cycle, then its engine stays soft-locked', async () => {
    const [a, b] = await pair('fs27');
    a.insert({ id: 'before-takeover' });
    const fin = await a.engine.finalCycle('displaced');
    expect(fin).toMatchObject({ published: true, timedOut: false, pendingPublish: false });
    a.session.softLock = true;
    expect(await a.engine.runCycle('safety-poll')).toEqual({ kind: 'skipped', reason: 'soft-locked' });
    await a.engine.stop();
    h.cloud.upload('mac');
    h.cloud.download('pc');
    await b.sync();
    expect(b.live('before-takeover')).toBe(true);
    expect(readPresence(b.state(), a.deviceUuid)?.value.session_open).toBe(0);
  });

  it('T-FS-62 (data side): both devices unconfirmed (Supabase blocked): same-account claims are honored, one device at a time', async () => {
    const [a, b] = await pair('fs62');
    a.write(claimWrites('same-account', a.replica.context()));
    await h.syncAll();
    await h.jump(MIN);
    b.write(claimWrites('same-account', b.replica.context()));
    await h.syncAll();
    const verdict = (d: HarnessDevice) =>
      evaluateClaims({ state: d.state(), ownDeviceUuid: d.deviceUuid, effectiveLimit: 1, shared: true, leaseConfirmed: false, sessions: [], nowMs: d.now() });
    expect(shouldDisplace(verdict(a))).toBe(true);
    expect(shouldDisplace(verdict(b))).toBe(false);
  });
});
