// @vitest-environment node
// sync-cycle.ts on real files (spec 5.2, 5.3, 5.5, 5.6, 5.9): the publish
// block precedence, commitMerge under an interleaved local edit (12 row 47), and the outcomes of
// one cycle for a missing, foreign, torn, side-filed or kill-switched shared file, a failed
// publish, and the publish marker that must not count as a user edit.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { merge } from '../merge.js';
import { MISSING_DEBOUNCE_MS } from '../file-binding.js';
import { TORN_QUARANTINE_AFTER_MS } from '../shared-file.js';
import { commitMerge, publishBlockReason, type PublishBlockInput } from '../sync-cycle.js';
import { LOCAL_EDIT_IDLE_MS } from '../sync-engine.js';
import type { ReplicaPort } from '../replica.js';
import { TBL } from '../types.js';
import { flushAsync } from './host-fakes.js';
import { CycleWorld, insert, loadVault } from './cycle-fixtures.js';
import { editInPlace } from './replica-fixtures.js';

let world: CycleWorld;

afterEach(async () => {
  expect(await world.dispose()).toEqual([]);
});

function sha(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

describe('publishBlockReason (5.6)', () => {
  const open: PublishBlockInput = {
    killSwitch: false,
    softLocked: false,
    sideFilesPublishAllowed: true,
    serverSideFilesFlagRecent: false,
    epochPaused: false,
    foreign: false,
    regressionBlockedUntilMs: null,
    nowMs: 1_000,
  };

  it('returns the first applicable reason in precedence order', () => {
    world = new CycleWorld();
    expect(publishBlockReason(open)).toBeNull();
    const all = { ...open, killSwitch: true, softLocked: true, sideFilesPublishAllowed: false, epochPaused: true, foreign: true, regressionBlockedUntilMs: 5_000 };
    expect(publishBlockReason(all)).toBe('kill-switch');
    expect(publishBlockReason({ ...all, killSwitch: false })).toBe('displaced');
    expect(publishBlockReason({ ...all, killSwitch: false, softLocked: false })).toBe('side-files');
    expect(publishBlockReason({ ...open, serverSideFilesFlagRecent: true })).toBe('side-files');
    expect(publishBlockReason({ ...open, epochPaused: true, foreign: true })).toBe('epoch-newer');
    expect(publishBlockReason({ ...open, foreign: true })).toBe('foreign-other-vault');
    expect(publishBlockReason({ ...open, regressionBlockedUntilMs: 5_000 })).toBe('regression-backoff');
    expect(publishBlockReason({ ...open, regressionBlockedUntilMs: 1_000 })).toBeNull();
  });
});

describe('commitMerge (5.6, 12 row 47)', () => {
  it('re-joins with a local edit committed between merge and commit, then falls back to one transaction', async () => {
    world = new CycleWorld();
    const a = await world.solo('commit-merge');
    const b = await world.join(a);
    insert(b, ['from-b']);
    const s1 = b.replica.state();
    const m = merge(a.replica.state(), s1, a.replica.implicit()).state;
    let interleaved = 0;
    const racing: ReplicaPort = new Proxy(a.replica, {
      get(target, prop, receiver) {
        if (prop !== 'commitIfGeneration') return Reflect.get(target, prop, receiver);
        return (next: Parameters<ReplicaPort['commitIfGeneration']>[0], gen: number) => {
          insert(a, [`race-${interleaved++}`]);
          return target.commitIfGeneration(next, gen);
        };
      },
    });
    const out = commitMerge(racing, m, a.replica.generation());
    expect(interleaved).toBe(3);
    const live = (id: string) => out.state.rows.get(`${TBL.entries}:${id}`) !== undefined;
    expect(['from-b', 'race-0', 'race-1', 'race-2'].every(live)).toBe(true);
    expect(out.generation).toBe(a.replica.generation());
  });
});

describe('one sync cycle', () => {
  it('missing S: waits out the 30 s debounce, then prompts and never recreates the file', async () => {
    world = new CycleWorld();
    const a = await world.solo('missing');
    fs.renameSync(a.sharedPath, path.join(a.root, 'elsewhere.conduit'));
    expect(await a.engine.runCycle('safety-poll')).toEqual({ kind: 'missing', debounced: false });
    await a.d.t.clock.advance(MISSING_DEBOUNCE_MS);
    expect(await a.engine.runCycle('safety-poll')).toEqual({ kind: 'missing', debounced: true });
    expect(a.engine.parts().status.snapshot().prompts.map((p) => p.kind)).toContain('file-missing');
    expect(fs.existsSync(a.sharedPath)).toBe(false);
  });

  it('a newer sync_format is foreign: paused with a prompt, never written (12 row 44)', async () => {
    world = new CycleWorld();
    const a = await world.solo('foreign');
    editInPlace(a.sharedPath, (db) => db.prepare(`UPDATE vault_meta SET value = '2' WHERE key = 'sync_format'`).run());
    const before = sha(a.sharedPath);
    insert(a, ['local']);
    expect(await a.engine.runCycle('shared-changed')).toEqual({ kind: 'paused', reason: 'foreign-newer-format' });
    expect(sha(a.sharedPath)).toBe(before);
    expect(a.engine.parts().status.snapshot().prompts.map((p) => p.kind)).toContain('foreign-newer-format');
  });

  it('a torn S is retried, then quarantined and republished from W after 2 minutes (12 row 18)', async () => {
    world = new CycleWorld();
    const a = await world.solo('torn');
    const bytes = fs.readFileSync(a.sharedPath);
    fs.writeFileSync(a.sharedPath, bytes.subarray(0, Math.floor(bytes.length / 2)));
    const first = await a.engine.runCycle('shared-changed');
    expect(first).toEqual({ kind: 'unreadable', retryAtMs: a.d.t.clock.now() + 5_000 });
    // The engine's own retries (5, 15, 45 s, then the 2-minute mark) quarantine and republish.
    await a.d.t.clock.advance(TORN_QUARANTINE_AFTER_MS);
    await a.engine.whenIdle();
    expect((await a.engine.runCycle('retry')).kind).toBe('up-to-date');
    expect(fs.readdirSync(a.replica.paths.quarantine)).toHaveLength(1);
    expect(loadVault(a.sharedPath, path.join(a.root, 'peek')).state.lineageId).toBe(a.replica.lineageId);
  });

  it('side files next to S: merged but not published (12 row 51)', async () => {
    world = new CycleWorld();
    const a = await world.solo('sidefiles');
    fs.writeFileSync(`${a.sharedPath}-wal`, '');
    fs.writeFileSync(`${a.sharedPath}-shm`, Buffer.alloc(32768));
    const before = sha(a.sharedPath);
    insert(a, ['local']);
    expect(await a.engine.runCycle('local-edit')).toEqual({ kind: 'merged-not-published', reason: 'side-files' });
    expect(sha(a.sharedPath)).toBe(before);
    expect(a.engine.parts().status.snapshot().prompts.map((p) => p.kind)).toContain('side-files');
  });

  it('the kill switch skips the cycle and leaves S alone', async () => {
    world = new CycleWorld();
    const a = await world.solo('kill');
    a.d.t.knobs.personalSyncPaused = true;
    insert(a, ['local']);
    expect(await a.engine.runCycle('local-edit')).toEqual({ kind: 'skipped', reason: 'kill-switch' });
  });

  it('a failed publish is an error with a toast; W keeps the edit and the next cycle publishes', async () => {
    world = new CycleWorld();
    const a = await world.solo('publish-fail');
    insert(a, ['local']);
    a.d.t.fs.inject({ op: 'writeFileDurable', match: /\.~/, code: 'ENOSPC' });
    expect(await a.engine.runCycle('local-edit')).toEqual({ kind: 'error', message: 'ENOSPC' });
    expect(a.d.t.events.of('sync:notice').map((e) => e.notice.kind)).toContain('publish-failed');
    expect(a.replica.local().pendingPublish).toBe(true);
    expect((await a.engine.syncNow()).kind).toBe('published');
    expect(loadVault(a.sharedPath, path.join(a.root, 'peek')).content.entries.has('local')).toBe(true);
  });

  it("the cycle's publish marker is not a user edit: no extra cycle 2 s after a publish", async () => {
    world = new CycleWorld();
    const a = await world.solo('marker');
    a.engine.start();
    await a.engine.whenIdle();
    insert(a, ['local']);
    await a.d.t.clock.advance(LOCAL_EDIT_IDLE_MS);
    await a.engine.whenIdle();
    const cycles = () => a.d.t.logger.messages('debug').filter((m) => m.includes('cycle done')).length;
    const after = cycles();
    expect(a.engine.parts().status.snapshot()).toMatchObject({ unsyncedOps: 0, pendingPublish: false });
    await a.d.t.clock.advance(LOCAL_EDIT_IDLE_MS * 2);
    await flushAsync();
    expect(cycles()).toBe(after);
  });
});
