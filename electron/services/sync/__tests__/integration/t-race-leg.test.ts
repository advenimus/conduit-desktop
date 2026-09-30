// @vitest-environment node
// Race and legacy-writer endurance tests of spec 13.2 on the REAL SyncEngine and replica:
// T-RACE-1 (a local edit committed between merge compute and commit; also spec 12 row 47 on the
// desktop), two devices importing the same candidate, and T-LEG-1 (iOS 1.0.5 editing
// continuously against a running desktop, bounded to about 60 s of simulated time).
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SYNC_FORMAT_KEY, SYNC_TABLES } from '../../schema.js';
import { getRegister } from '../../state-view.js';
import { SyncEngine } from '../../sync-engine.js';
import type { ReplicaPort } from '../../replica.js';
import { SyncHarness } from './sync-harness.js';
import { Ios105 } from './legacy-ios.js';
import { entryReg, SCENARIO_TIMEOUT_MS } from './scenario-helpers.js';
import { contentOf } from './vault-ops.js';
import type { HarnessDevice } from './harness-device.js';

const SEC = 1000;
const LEG_SECONDS = 60;
const IOS_POLL_EVERY_S = 5;
const IOS_EDIT_EVERY_S = 4;
const DESK_EDIT_EVERY_S = 3;
/** Longer than the 5-minute maximum regression back-off of spec 5.7. */
const IDLE_LIMIT_S = 8 * 60;
const LEG_TIMEOUT_MS = 60_000;

let h: SyncHarness;

afterEach(async () => {
  for (const d of h.devices) expect(d.logger.unprefixed()).toEqual([]);
  expect(await h.dispose()).toEqual([]);
});

/** The engine of `d` rebuilt around a replica whose first commitIfGeneration lets `interleave` run first. */
async function withInterleave(d: HarnessDevice, interleave: () => void): Promise<{ calls: () => number }> {
  let calls = 0;
  const real = d.replica;
  const proxy = new Proxy(real, {
    get(target, prop) {
      if (prop === 'commitIfGeneration') {
        return (...args: Parameters<ReplicaPort['commitIfGeneration']>) => {
          if (calls++ === 0) interleave();
          return target.commitIfGeneration(...args);
        };
      }
      const v: unknown = Reflect.get(target, prop, target);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  const parts = d.engine.parts();
  await d.engine.stop();
  d.engine = new SyncEngine({ ...parts, replica: proxy });
  return { calls: () => calls };
}

describe('spec 13.2: races and legacy writers', { timeout: SCENARIO_TIMEOUT_MS }, () => {
  it('T-RACE-1 (row 47): a local edit committed between merge compute and commit survives and is published', async () => {
    h = new SyncHarness('race1');
    const a = await h.create({ name: 'mac', start: false });
    a.insert({ id: 'e1', host: 'h0' });
    await h.syncAll();
    const b = await h.join({ name: 'pc', start: false });
    b.insert({ id: 'from-pc' });
    b.update('e1', { host: 'pc host' });
    await b.sync();
    h.cloud.upload('pc');
    h.cloud.download('mac');
    const hook = await withInterleave(a, () => {
      a.insert({ id: 'mid-merge' });
      a.update('e1', { notes: 'typed during the merge' });
    });
    expect((await a.sync()).kind).toBe('published');
    expect(hook.calls()).toBeGreaterThanOrEqual(2);
    expect([a.live('from-pc'), a.live('mid-merge')]).toEqual([true, true]);
    expect(a.row('e1')).toMatchObject({ host: 'pc host', notes: 'typed during the merge' });
    const s = h.peek(a.sharedPath).content.entries;
    expect([s.has('mid-merge'), s.get('e1')?.notes]).toEqual([true, 'typed during the merge']);
    await h.syncAll();
    expect(b.row('e1')?.notes).toBe('typed during the merge');
    expect(b.live('mid-merge')).toBe(true);
  });

  it('two devices importing the same pre-sync copy mint their own devs: neither import covers the other', async () => {
    h = new SyncHarness('race-import');
    const a = await h.create({ name: 'mac', start: false });
    a.insert({ id: 'e1', host: 'h0' });
    await h.syncAll();
    const b = await h.join({ name: 'pc', start: false });
    const presync = path.join(h.root, 'Old copy.conduit');
    fs.copyFileSync(a.sharedPath, presync);
    const db = new Database(presync);
    db.pragma('journal_mode = DELETE');
    for (const t of SYNC_TABLES) db.exec(`DROP TABLE ${t}`);
    db.prepare('DELETE FROM vault_meta WHERE key = ?').run(SYNC_FORMAT_KEY);
    db.prepare("UPDATE entries SET host = 'from the old copy', updated_at = ? WHERE id = 'e1'").run(new Date(h.clock.now() + 60 * SEC).toISOString());
    db.close();
    for (const d of [a, b]) {
      const priv = path.join(h.root, `${d.name}-import.conduit`);
      fs.copyFileSync(presync, priv);
      const c = await d.engine.parts().candidates.addFile({ path: priv, source: 'user-picked', label: 'Old copy.conduit', staleByNature: false });
      expect(c.kind).toBe('synthetic');
      await d.engine.parts().candidates.apply(c.id, { deleteMissing: [] });
    }
    await h.syncAll();
    for (const d of [a, b]) {
      const sibs = getRegister(d.state(), entryReg('e1', 'host'))?.sibs ?? [];
      const minted = sibs.filter((s) => s.value === 'from the old copy');
      expect(minted).toHaveLength(2);
      expect(new Set(minted.map((s) => s.dev)).size).toBe(2);
    }
  });

  it(
    'T-LEG-1: iOS 1.0.5 editing continuously against a running desktop: nothing lost, and both converge once idle',
    async () => {
      h = new SyncHarness('leg1');
      const a = await h.create({ name: 'mac', start: true });
      const desk = ['d1', 'd2', 'd3'];
      const phone = ['i1', 'i2', 'i3'];
      for (const id of [...desk, ...phone, 'shared']) a.insert({ id, host: 'h0', notes: 'n0' });
      await h.advance(3 * SEC);
      const ios = new Ios105(a.sharedPath, path.join(h.root, 'leg-sandbox'), h.requireVault().key, () => h.clock.now());
      ios.stage();
      const last = new Map<string, string>();
      for (let t = 1; t <= LEG_SECONDS; t++) {
        await h.advance(SEC);
        if (t % DESK_EDIT_EVERY_S === 1) {
          const id = desk[(t / DESK_EDIT_EVERY_S) % desk.length | 0] as string;
          a.update(id, { host: `desk-${t}` });
          last.set(`${id}.host`, `desk-${t}`);
          if (t % 2 === 1) {
            a.update('shared', { host: `shared-desk-${t}` });
            last.set('shared.host', `shared-desk-${t}`);
          }
        }
        if (t % IOS_POLL_EVERY_S === 0) ios.poll();
        if (t % IOS_EDIT_EVERY_S === 2) {
          const id = phone[(t / IOS_EDIT_EVERY_S) % phone.length | 0] as string;
          ios.save(id, { notes: `phone-${t}` });
          last.set(`${id}.notes`, `phone-${t}`);
          if (t % 3 === 0) {
            ios.save('shared', { notes: `shared-phone-${t}` });
            last.set('shared.notes', `shared-phone-${t}`);
          }
        }
        if (t % IOS_EDIT_EVERY_S === 3 && ios.pendingWriteBack) ios.writeBack();
      }
      if (ios.pendingWriteBack) ios.writeBack();
      // Every blind iOS write-back after a desktop publish is a 5.7 regression, so continuous iOS
      // editing backs off desktop publishing (up to 5 min); once idle both sides converge.
      const converged = (): boolean =>
        [...last].every(([field, value]) => {
          const [id, col] = field.split('.') as [string, 'host' | 'notes'];
          return a.row(id)?.[col] === value && ios.row(id)?.[col] === value;
        });
      for (let waited = 0; waited < IDLE_LIMIT_S && !(converged() && a.status().kind === 'up-to-date'); waited += IOS_POLL_EVERY_S) {
        await h.advance(IOS_POLL_EVERY_S * SEC);
        ios.poll();
      }
      for (const [field, value] of last) {
        const [id, col] = field.split('.') as [string, 'host' | 'notes'];
        expect(a.row(id)?.[col]).toBe(value);
        expect(ios.row(id)?.[col]).toBe(value);
      }
      const deskContent = contentOf(a.wc.db).entries.map((r) => [r.id, r.host, r.notes]);
      const sandbox = new Database(ios.sandbox, { readonly: true });
      const phoneContent = contentOf(sandbox).entries.map((r) => [r.id, r.host, r.notes]);
      sandbox.close();
      expect(phoneContent).toEqual(deskContent);
      expect(a.status().kind).toBe('up-to-date');
      expect(a.logger.messages('error')).toEqual([]);
    },
    LEG_TIMEOUT_MS,
  );
});
