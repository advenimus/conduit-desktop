// @vitest-environment node
// Engine lifecycle with fakes: the final cycle and its caps, start/stop, the watcher and side
// files, copy scans, exports and user actions.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DISPLACED_FINAL_CYCLE_CAP_MS, FINAL_CYCLE_CAP_MS, LOCAL_EDIT_MAX_MS, type CycleOutcome } from '../sync-engine.js';
import { readLocalJson } from '../local-state.js';
import { flushAsync, makeTempRoot } from './host-fakes.js';
import {
  LINEAGE,
  MARKER,
  UP_TO_DATE,
  blocked,
  deferred,
  makeHarness,
  outcome,
  publishes,
  type Harness,
} from './engine-fakes.js';

const roots: string[] = [];
const harnesses: Harness[] = [];

function harness(opts: { journalMode?: 'wal' | 'delete' } = {}): Harness {
  const root = makeTempRoot('engine');
  roots.push(root);
  const h = makeHarness(root, opts);
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.engine.stop();
    expect(h.t.logger.unprefixed()).toEqual([]);
  }
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

function toasts(h: Harness, kind: string): number {
  return h.t.events.of('sync:notice').filter((e) => !e.persisted && e.notice.kind === kind).length;
}

describe('final cycle (5.6, 6.4, 6.6)', () => {
  it('lock: a stuck cycle is abandoned at 3 s with pending_publish persisted', async () => {
    const h = harness();
    h.engine.start();
    await h.engine.runCycle('unlock');
    h.replica.mutate();
    h.body.then(() => new Promise<CycleOutcome>(() => undefined));
    let done = false;
    const fin = h.engine.finalCycle('lock').finally(() => (done = true));
    await h.t.clock.advance(FINAL_CYCLE_CAP_MS - 1);
    expect(done).toBe(false);
    expect(h.body.calls[h.body.calls.length - 1]).toMatchObject({ reason: 'final', closing: true });
    await h.t.clock.advance(1);
    await expect(fin).resolves.toEqual({ published: false, timedOut: true, pendingPublish: true, marker: null });
    expect(readLocalJson(h.replica.paths.dir, h.t.clock.now()).value?.pendingPublish).toBe(true);
    await h.engine.stop();
    expect(h.t.clock.pending()).toBe(0);
  });

  it('displaced: up to 15 s; a publish inside the cap clears pending_publish and returns the marker', async () => {
    const h = harness();
    h.engine.start();
    await h.engine.runCycle('unlock');
    h.replica.mutate();
    h.body.then(async (env, reason) => {
      await env.deps.host.timers.sleep(10_000);
      env.checkAlive();
      return publishes()(env, reason);
    });
    const fin = h.engine.finalCycle('displaced');
    await flushAsync();
    await h.t.clock.advance(10_000);
    await expect(fin).resolves.toEqual({ published: true, timedOut: false, pendingPublish: false, marker: MARKER });
    expect(readLocalJson(h.replica.paths.dir, h.t.clock.now()).value?.pendingPublish).toBe(false);
  });

  it('displaced: the cap is 15 s, not 3 s', async () => {
    const h = harness();
    h.body.then(outcome({ kind: 'merged-not-published', reason: 'side-files' }));
    await h.engine.runCycle('unlock');
    h.body.then(() => new Promise<CycleOutcome>(() => undefined));
    let done = false;
    const fin = h.engine.finalCycle('displaced').finally(() => (done = true));
    await h.t.clock.advance(DISPLACED_FINAL_CYCLE_CAP_MS - 1);
    expect(done).toBe(false);
    await h.t.clock.advance(1);
    await expect(fin).resolves.toMatchObject({ timedOut: true, pendingPublish: true });
  });

  it('a cycle that resumes after the deadline aborts at its next check and publishes nothing', async () => {
    const h = harness();
    h.engine.start();
    await h.engine.runCycle('unlock');
    h.replica.mutate();
    const gate = deferred();
    let published = false;
    h.body.then(async (env) => {
      await gate.promise;
      env.checkAlive();
      published = true;
      return UP_TO_DATE;
    });
    const fin = h.engine.finalCycle('quit');
    await h.t.clock.advance(FINAL_CYCLE_CAP_MS);
    await expect(fin).resolves.toMatchObject({ timedOut: true, pendingPublish: true });
    gate.resolve();
    await flushAsync();
    expect(published).toBe(false);
  });

  it('nothing unpublished and up to date: pending_publish stays false and no new cycles start', async () => {
    const h = harness();
    h.engine.start();
    await h.engine.runCycle('unlock');
    const fin = await h.engine.finalCycle('lock');
    expect(fin).toEqual({ published: false, timedOut: false, pendingPublish: false, marker: null });
    h.engine.trigger('shared-changed');
    h.replica.mutate();
    await h.t.clock.advance(LOCAL_EDIT_MAX_MS);
    expect(h.body.reasons()).toEqual(['unlock', 'final']);
    expect(h.status.snapshot().unsyncedOps).toBe(1);
  });
});

describe('start and stop', () => {
  it('stop aborts the in-flight cycle, cancels every timer and ignores later triggers', async () => {
    const h = harness();
    h.engine.start();
    const gate = deferred();
    h.body.then(blocked(gate));
    const c = h.engine.runCycle('unlock');
    // Start-up housekeeping and the first copy scan run in the lane first (real file IO).
    for (let i = 0; i < 100 && h.body.calls.length === 0; i++) await flushAsync();
    expect(h.body.calls).toHaveLength(1);
    const stopping = h.engine.stop();
    gate.resolve();
    await expect(c).resolves.toEqual({ kind: 'skipped', reason: 'stopped' });
    await stopping;
    expect(h.watcher().stopped).toBe(true);
    expect(h.t.clock.pending()).toBe(0);
    expect(h.replica.listenerCount()).toBe(0);
    h.engine.trigger('sync-now');
    h.replica.mutate();
    await expect(h.engine.runCycle('focus')).resolves.toEqual({ kind: 'skipped', reason: 'stopped' });
    await expect(h.engine.exclusive(() => 1)).rejects.toThrow('[sync] engine stopped');
    expect(h.body.calls).toHaveLength(1);
    expect(h.status.snapshot().kind).not.toBe('syncing');
  });

  it('the watcher and the safety poll trigger cycles; a rebind moves the watcher', async () => {
    const h = harness();
    h.engine.start();
    h.watcher().listener.sharedChanged('stat');
    await flushAsync();
    await h.engine.whenIdle();
    await h.t.clock.advance(60_000);
    expect(h.body.reasons()).toEqual(['shared-changed', 'safety-poll']);
    const moved = path.join(path.dirname(h.sharedPath), 'Renamed.conduit');
    for (const l of h.bindingListeners) l({ sharedPath: moved, realpath: moved, fileId: '33333333-4444-4555-8666-777777777777' });
    expect(h.watcher().paths).toEqual([h.sharedPath, moved]);
    expect(h.status.snapshot().fileName).toBe('Renamed.conduit');
  });

  it('side files: prompt and one reminder while present, a cycle when publishing may resume', async () => {
    const h = harness();
    h.engine.start();
    const present = [{ name: 'wal', exists: true, size: 0, mtimeMs: 1 }] as const;
    h.watcher().listener.sideFilesObserved(present);
    h.watcher().listener.sideFilesObserved(present);
    expect(h.status.snapshot().prompts).toEqual([{ kind: 'side-files', id: 'side-files', upgradeWording: false, walNonEmpty: false }]);
    expect(toasts(h, 'side-files-reminder')).toBe(1);
    expect(h.session.log).toContain('sideFiles:true');
    h.watcher().listener.sideFilesObserved([{ name: 'wal', exists: false, size: 0, mtimeMs: 0 }]);
    await flushAsync();
    await h.engine.whenIdle();
    expect(h.status.snapshot().prompts).toEqual([]);
    expect(h.session.log).toContain('sideFiles:false');
    expect(h.body.reasons()).toEqual(['shared-changed']);
  });

  it('confirming side files runs a cycle that can publish', async () => {
    const h = harness();
    h.engine.start();
    h.watcher().listener.sideFilesObserved([{ name: 'wal', exists: true, size: 0, mtimeMs: 1 }]);
    const res = await h.engine.confirmSideFiles([], false);
    expect(res).toEqual({ kind: 'confirmed', movedTo: null });
    await flushAsync();
    await h.engine.whenIdle();
    expect(h.body.reasons()).toEqual(['sync-now']);
    expect(h.status.snapshot().prompts).toEqual([]);
  });

  it('network root: status flag and one warning per launch', () => {
    const h = harness({ journalMode: 'delete' });
    h.engine.start();
    expect(h.status.snapshot().networkRoot).toBe(true);
    expect(toasts(h, 'network-root')).toBe(1);
  });
});

describe('copies and exports', () => {
  const copy = (cls: string, sha: string) => ({
    path: `/cloud/${sha.slice(0, 4)}.conduit`,
    name: `${sha.slice(0, 4)}.conduit`,
    sha256: sha,
    lineageId: LINEAGE,
    cls,
    contribution: { appDotsOnly: false, legacyEdits: 1, changedFields: 2, onlyInCopy: 3, deletions: 4, presync: false, otherGenesis: false },
    providerPattern: false,
    inUseBy: null,
  });

  it('class 4 becomes a review prompt, class 2 is listed, a merged class 3 triggers a cycle', async () => {
    const h = harness();
    let merged = 0;
    (h.deps.scanner as unknown as { mergeSafe: () => Promise<unknown> }).mergeSafe = async () => {
      merged += 1;
      return {};
    };
    h.scan = { copies: [copy('needs-review', '1'.repeat(64)), copy('nothing-new', '2'.repeat(64)), copy('safe-provider-copy', '3'.repeat(64))], skipped: 0 };
    await h.engine.scanCopies();
    await flushAsync();
    await h.engine.whenIdle();
    const snap = h.status.snapshot();
    expect(snap.prompts.map((p) => p.id)).toEqual([`copy-review:${'1'.repeat(64)}`]);
    expect(snap.otherCopies.map((c) => [c.cls, c.changes, c.deletions])).toEqual([
      ['needs-review', 9, 4],
      ['nothing-new', 9, 4],
    ]);
    expect(merged).toBe(1);
    expect(h.body.reasons()).toEqual(['local-edit']);
    h.scan = { copies: [], skipped: 0 };
    await h.engine.scanCopies();
    expect(h.status.snapshot().prompts).toEqual([]);
  });

  it('exports W under exports/ with a free name', async () => {
    const h = harness();
    const first = await h.engine.exportUnsynced();
    const second = await h.engine.exportUnsynced();
    expect(path.basename(first)).toBe('Vault (unsynced changes).conduit');
    expect(path.basename(second)).toBe('Vault (unsynced changes) 2.conduit');
    expect(path.dirname(first)).toBe(h.replica.paths.exports);
    expect(h.vacuums).toEqual([first, second]);
  });

  it('held changes: nothing held returns null and clears the prompt', async () => {
    const h = harness();
    h.status.setPrompt({ kind: 'held-legacy', id: 'held-legacy', deletes: 1, reverts: 0 });
    await expect(h.engine.applyHeld()).resolves.toBeNull();
    expect(h.status.snapshot().prompts).toEqual([]);
    await expect(h.engine.keepHeld()).resolves.toBeNull();
  });
});

describe('user actions', () => {
  it('locate: a bound file clears the missing and foreign prompts and runs a cycle; another vault is refused', async () => {
    const h = harness();
    h.status.setPrompt({ kind: 'file-missing', id: 'file-missing', path: h.sharedPath });
    h.status.setPrompt({ kind: 'foreign-other-vault', id: 'foreign-other-vault', path: h.sharedPath });
    h.status.update({ fileMissing: true });
    h.locate = { kind: 'other-lineage', lineageId: null };
    await expect(h.engine.locate('/elsewhere/Other.conduit')).resolves.toBe(false);
    expect(h.status.snapshot().prompts).toHaveLength(2);
    const found = path.join(path.dirname(h.sharedPath), 'Found.conduit');
    h.locate = { kind: 'bound', binding: { sharedPath: found, realpath: found, fileId: '33333333-4444-4555-8666-777777777777' } };
    await expect(h.engine.locate(found)).resolves.toBe(true);
    await flushAsync();
    await h.engine.whenIdle();
    expect(h.status.snapshot()).toMatchObject({ kind: 'up-to-date', prompts: [], fileName: 'Found.conduit' });
    expect(h.body.reasons()).toEqual(['sync-now']);
  });

  it('[Review unsaved changes first] queues the WAL copy as a candidate prompt', async () => {
    const h = harness();
    const id = await h.engine.reviewSideFileWal();
    expect(h.queued).toEqual([{ path: '/tmp/wal-copy.conduit', source: 'leftover-wal', label: 'Unsaved changes found next to the vault file' }]);
    expect(h.status.snapshot().prompts).toEqual([
      { kind: 'candidate', id: `candidate:${id}`, candidateId: id, label: 'Unsaved changes found next to the vault file' },
    ]);
  });

  it('same-device copy [It is the same vault, merge]: private copy queued, binding moved back, prompt cleared', async () => {
    const h = harness();
    const original = path.join(path.dirname(h.sharedPath), 'Original.conduit');
    fs.writeFileSync(original, 'copy bytes');
    h.status.setPrompt({
      kind: 'same-device-copy',
      id: `same-device-copy:${original}`,
      copy: { path: original, name: 'Original.conduit', sha256: 'e'.repeat(64), cls: 'needs-review', changes: 0, deletions: 0 },
    });
    h.locate = { kind: 'bound', binding: { sharedPath: original, realpath: original, fileId: '33333333-4444-4555-8666-777777777777' } };
    await h.engine.resolveSameDeviceCopy('merge', original, null);
    expect(h.queued).toHaveLength(1);
    expect(path.dirname(h.queued[0]?.path ?? '')).toBe(h.replica.paths.tmp);
    expect(fs.readFileSync(h.queued[0]?.path ?? '', 'utf8')).toBe('copy bytes');
    expect(h.located).toEqual([original]);
    expect(h.status.snapshot().prompts.map((p) => p.kind)).toEqual(['candidate']);
    await expect(h.engine.resolveSameDeviceCopy('separate', original, null)).rejects.toThrow('[sync] a separate vault needs a target path');
    expect(h.t.logger.messages('warn')).toContain('[sync] user action failed');
  });
});
