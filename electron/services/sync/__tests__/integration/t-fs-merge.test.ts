// @vitest-environment node
// Spec 12 rows about merging edits of new-build devices, end to end through the REAL SyncEngine,
// replica and shared-file layers on real files: T-FS-1, 2, 3, 4, 5, 6, 21, 23, 31, 36, 38, 40.
import { afterEach, describe, expect, it } from 'vitest';
import { resolveField } from '../../conflicts.js';
import { digestState } from '../../digest.js';
import { TBL } from '../../types.js';
import { SyncHarness } from './sync-harness.js';
import { contentOf } from './vault-ops.js';
import { conflictLines, entryReg, fieldConflict, itemOf, SCENARIO_TIMEOUT_MS } from './scenario-helpers.js';
import type { HarnessDevice } from './harness-device.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Longer than the 10-minute regression window of spec 5.7. */
const REGRESSION_QUIET_MS = 11 * 60 * 1000;

let h: SyncHarness;

afterEach(async () => {
  for (const d of h.devices) expect(d.logger.unprefixed()).toEqual([]);
  expect(await h.dispose()).toEqual([]);
});

/** mac and pc on one vault, engines not started (explicit cycles only), both holding `seed`. */
async function pair(label: string, seed: (a: HarnessDevice) => void = () => undefined): Promise<[HarnessDevice, HarnessDevice]> {
  h = new SyncHarness(label);
  const a = await h.create({ name: 'mac', start: false });
  seed(a);
  await h.syncAll();
  const b = await h.join({ name: 'pc', start: false });
  await h.syncAll();
  return [a, b];
}

describe('spec 12: merging edits of new-build devices', { timeout: SCENARIO_TIMEOUT_MS }, () => {
  it('T-FS-1: offline edits of one field conflict; the higher rank shows everywhere; one choice resolves both', async () => {
    const [a, b] = await pair('fs1', (a) => a.insert({ id: 'e1', host: '10.0.0.1' }));
    await h.jump(DAY);
    a.update('e1', { host: '10.0.0.A' });
    await h.jump(DAY);
    b.update('e1', { host: '10.0.0.B' });
    await h.jump(DAY);
    await h.syncAll();
    for (const d of [a, b]) {
      const f = fieldConflict(d.conflicts(), 'e1', 'host');
      expect(f?.versions.map((v) => [v.value, v.provisional])).toEqual([
        ['10.0.0.B', true],
        ['10.0.0.A', false],
      ]);
      expect(d.row('e1')?.host).toBe('10.0.0.B');
    }
    const chosen = fieldConflict(a.conflicts(), 'e1', 'host')?.versions.find((v) => v.value === '10.0.0.A');
    a.write(resolveField(a.state(), entryReg('e1', 'host'), { kind: 'version', versionId: chosen?.id ?? '' }, a.replica.context()));
    await h.syncAll();
    for (const d of [a, b]) {
      expect(conflictLines(d.conflicts())).toEqual([]);
      expect(d.row('e1')?.host).toBe('10.0.0.A');
    }
  });

  it('T-FS-2: edits of different fields both apply, no conflict; updated_at is the later dot', async () => {
    const [a, b] = await pair('fs2', (a) => a.insert({ id: 'e1', host: 'h0', notes: 'n0' }));
    await h.jump(HOUR);
    a.update('e1', { host: 'h1' });
    await h.jump(HOUR);
    b.update('e1', { notes: 'n1' });
    const later = new Date(b.now()).toISOString();
    await h.syncAll();
    for (const d of [a, b]) {
      expect(conflictLines(d.conflicts())).toEqual([]);
      expect(d.row('e1')).toMatchObject({ host: 'h1', notes: 'n1', updated_at: later });
    }
  });

  it('T-FS-3: delete on A versus rename on B keeps E visible with B name and an edit-delete review', async () => {
    const [a, b] = await pair('fs3', (a) => a.insert({ id: 'e1', name: 'Old' }));
    a.remove(['e1']);
    await h.jump(HOUR);
    b.update('e1', { name: 'Renamed on B' });
    await h.syncAll();
    for (const d of [a, b]) {
      expect(d.live('e1')).toBe(true);
      expect(d.row('e1')?.name).toBe('Renamed on B');
      expect(itemOf(d.conflicts(), 'e1', 'edit-delete')).not.toBeNull();
    }
  });

  it('T-FS-4: recursive folder delete versus a new entry inside keeps the folder with the entry; other deletions stay', async () => {
    const [a, b] = await pair('fs4', (a) => {
      a.addFolder({ id: 'F', name: 'Servers' });
      a.addFolder({ id: 'F2', name: 'Old', parent_id: 'F' });
      a.insert({ id: 'e1', folder_id: 'F' });
      a.insert({ id: 'e2', folder_id: 'F' });
      a.insert({ id: 'e3', folder_id: 'F2' });
    });
    a.deleteFolder('F');
    await h.jump(HOUR);
    b.insert({ id: 'n1', folder_id: 'F' });
    await h.syncAll();
    for (const d of [a, b]) {
      expect(d.live('F', TBL.folders)).toBe(true);
      expect(d.live('n1')).toBe(true);
      expect(d.row('n1')?.folder_id).toBe('F');
      expect([d.live('F2', TBL.folders), d.live('e1'), d.live('e2'), d.live('e3')]).toEqual([false, false, false, false]);
      expect(itemOf(d.conflicts(), 'F', 'folder-delete')).not.toBeNull();
    }
  });

  it('T-FS-5: crossing moves form a cycle; the highest-rank mover goes to the top level, identically everywhere', async () => {
    const [a, b] = await pair('fs5', (a) => {
      a.addFolder({ id: 'X' });
      a.addFolder({ id: 'Y' });
    });
    a.updateFolder('X', { parent_id: 'Y' });
    await h.jump(HOUR);
    b.updateFolder('Y', { parent_id: 'X' });
    await h.syncAll();
    const parents = (d: HarnessDevice) => d.wc.db.prepare("SELECT id, parent_id FROM folders WHERE id IN ('X','Y') ORDER BY id").all();
    for (const d of [a, b]) {
      expect(parents(d)).toEqual([
        { id: 'X', parent_id: 'Y' },
        { id: 'Y', parent_id: null },
      ]);
      expect(itemOf(d.conflicts(), 'X', 'cycle')).toMatchObject({ movedToRoot: 'Y' });
    }
  });

  it('T-FS-6: a clock 2 hours fast wins provisional picks but conflicts are still found; others follow its clock', async () => {
    const [a, b] = await pair('fs6', (a) => a.insert({ id: 'e1', host: 'h0' }));
    a.dh.clock.offsetMs = 2 * HOUR;
    a.update('e1', { host: 'fast' });
    await h.jump(HOUR);
    b.update('e1', { host: 'right' });
    await h.syncAll();
    for (const d of [a, b]) {
      const f = fieldConflict(d.conflicts(), 'e1', 'host');
      expect(f?.versions.map((v) => [v.value, v.provisional])).toEqual([
        ['fast', true],
        ['right', false],
      ]);
    }
    const fastMs = a.state().vv.get(a.replica.dev())?.ms ?? 0;
    b.insert({ id: 'e2' });
    expect(b.state().vv.get(b.replica.dev())?.ms).toBeGreaterThanOrEqual(fastMs);
    expect(Date.parse(String(b.row('e1')?.updated_at))).toBeGreaterThan(b.now());
  });

  it('T-FS-21: two folders named Servers created on two devices are both kept', async () => {
    const [a, b] = await pair('fs21');
    a.addFolder({ id: 'fa', name: 'Servers' });
    b.addFolder({ id: 'fb', name: 'Servers' });
    await h.syncAll();
    for (const d of [a, b]) {
      expect([d.live('fa', TBL.folders), d.live('fb', TBL.folders)]).toEqual([true, true]);
      expect(conflictLines(d.conflicts())).toEqual([]);
    }
  });

  it('T-FS-23: three devices editing and gossiping in random orders converge to the same rows and conflicts', async () => {
    for (const seed of [7, 42]) {
      if (seed !== 7) expect(await h.dispose()).toEqual([]);
      h = new SyncHarness(`fs23-${seed}`);
      const first = await h.create({ name: 'mac', start: false });
      first.insert({ id: 's1', host: 'h0' });
      first.insert({ id: 's2', host: 'h0' });
      await h.syncAll();
      const devs = [first, await h.join({ name: 'win', start: false }), await h.join({ name: 'iphone', start: false })];
      await h.syncAll();
      let rnd = seed;
      const next = (n: number): number => {
        rnd = (rnd * 1103515245 + 12345) % 2147483648;
        return rnd % n;
      };
      for (let step = 0; step < 18; step++) {
        const d = devs[next(devs.length)] as HarnessDevice;
        const op = next(4);
        if (op === 0) d.insert({ id: `n${step}`, host: `h${step}` });
        if (op === 1 && d.live('s1')) d.update('s1', { host: `${d.name}-${step}` });
        if (op === 2 && d.live('s2')) d.update('s2', { notes: `${d.name}-${step}` });
        if (op === 3 && d.live(`n${step - 1}`)) d.remove([`n${step - 1}`]);
        await h.jump(1000 + next(5000));
        const from = devs[next(devs.length)] as HarnessDevice;
        const to = devs[next(devs.length)] as HarnessDevice;
        await from.sync();
        h.cloud.upload(from.mirror);
        if (next(2) === 0) {
          h.cloud.download(to.mirror, { mtime: 'now' });
          await to.sync();
        }
      }
      // Random silent overwrites trip the 5.7 regression back-off; let it expire before gossiping to quiet.
      await h.jump(REGRESSION_QUIET_MS);
      expect((await h.syncAll(8)).at(-1)?.every((k) => k === 'up-to-date')).toBe(true);
      expect(new Set(devs.map((d) => digestState(d.state()))).size).toBe(1);
      expect(new Set(devs.map((d) => JSON.stringify(contentOf(d.wc.db)))).size).toBe(1);
      expect(new Set(devs.map((d) => JSON.stringify(conflictLines(d.conflicts())))).size).toBe(1);
      for (const d of h.devices) expect(d.logger.unprefixed()).toEqual([]);
    }
  });

  it('T-FS-31: deleting a credential versus linking it keeps the credential live and the link working', async () => {
    const [a, b] = await pair('fs31', (a) => {
      a.insert({ id: 'cred', entry_type: 'credential', username: 'admin' });
      a.insert({ id: 'k', entry_type: 'ssh', host: 'h' });
    });
    a.remove(['cred']);
    await h.jump(HOUR);
    b.update('k', { credential_id: 'cred' });
    await h.syncAll();
    for (const d of [a, b]) {
      expect(d.live('cred')).toBe(true);
      expect(d.row('k')?.credential_id).toBe('cred');
      expect(itemOf(d.conflicts(), 'cred', 'edit-delete')).not.toBeNull();
    }
  });

  it('T-FS-36: the same document edited on two devices conflicts; [Keep both] creates "Doc (from iPhone)"', async () => {
    const [a, b] = await pair('fs36', (a) => a.insert({ id: 'doc', name: 'Doc', entry_type: 'document', config: { content: 'v0' } }));
    b.update('doc', { config: { content: 'from iPhone' } });
    await h.jump(HOUR);
    a.update('doc', { config: { content: 'from mac' } });
    await h.syncAll();
    const f = fieldConflict(a.conflicts(), 'doc', 'config.content');
    expect(f?.keepBothOffered).toBe(true);
    const other = f?.versions.find((v) => !v.provisional);
    const names = new Map([[other?.id ?? '', 'Doc (from iPhone)']]);
    a.write(resolveField(a.state(), entryReg('doc', 'config.content'), { kind: 'keep-both', copyNames: names }, a.replica.context()));
    await h.syncAll();
    for (const d of [a, b]) {
      const docs = d.wc.db.prepare("SELECT name, config FROM entries WHERE entry_type = 'document' ORDER BY name").all();
      expect(docs).toEqual([
        { name: 'Doc', config: JSON.stringify({ content: 'from mac' }) },
        { name: 'Doc (from iPhone)', config: JSON.stringify({ content: 'from iPhone' }) },
      ]);
      expect(conflictLines(d.conflicts())).toEqual([]);
    }
  });

  it('T-FS-38: a device back after 7 months with an edit to a row deleted elsewhere restores it as a conflict', async () => {
    const [a, b] = await pair('fs38', (a) => a.insert({ id: 'e1', host: 'h0' }));
    await b.lock();
    a.remove(['e1']);
    await h.syncAll();
    await h.jump(210 * DAY);
    await b.relaunch();
    expect(b.live('e1')).toBe(true);
    b.update('e1', { host: 'edited after 7 months' });
    await h.syncAll();
    for (const d of [a, b]) {
      expect(d.live('e1')).toBe(true);
      expect(d.row('e1')?.host).toBe('edited after 7 months');
      expect(itemOf(d.conflicts(), 'e1', 'edit-delete')).not.toBeNull();
    }
  });

  it('T-FS-40: no time-based purge: a year later the tombstone is still there and a late edit conflicts', async () => {
    const [a, b] = await pair('fs40', (a) => a.insert({ id: 'e1', host: 'h0' }));
    await b.lock();
    a.remove(['e1']);
    await h.syncAll();
    for (let i = 0; i < 4; i++) {
      await h.jump(100 * DAY);
      a.insert({ id: `x${i}` });
      await h.syncAll();
    }
    expect(h.peek(a.sharedPath).state.rows.get(`${TBL.entries}:e1`)?.grave).not.toBeNull();
    await b.relaunch();
    b.update('e1', { host: 'late edit' });
    await h.syncAll();
    for (const d of [a, b]) {
      expect(d.live('e1')).toBe(true);
      expect(itemOf(d.conflicts(), 'e1', 'edit-delete')).not.toBeNull();
    }
  });
});
