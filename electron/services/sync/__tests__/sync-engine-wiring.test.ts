// @vitest-environment node
// The engine wired to the real replica and file modules by assembleSyncEngine (real W through
// the test working copy, real watcher, side files, binding, scanner, snapshots, status and
// notices), with a scripted cycle body: what the engine does around cycles on real files.
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { STAT_POLL_MS, SharedFileWatcher } from '../file-watch.js';
import { LOCAL_EDIT_IDLE_MS, SyncEngine, assembleSyncEngine, nullSessionSignals } from '../sync-engine.js';
import { readLocalJson } from '../local-state.js';
import { loadFile } from '../state-store.js';
import { rowLife } from '../state-view.js';
import { TBL } from '../types.js';
import type { ReplicaPort } from '../replica.js';
import type { SyncEngineDeps } from '../sync-engine-types.js';
import { flushAsync, makeTempRoot } from './host-fakes.js';
import { ScriptedBody, TestBackoff, TestRegressions, TestTorn, TestVerifier, UP_TO_DATE, deferred } from './engine-fakes.js';
import { bindingFor, editInPlace, insertEntry, makeDevice, newVaultSeed, open, type TestDevice } from './replica-fixtures.js';

const roots: string[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

interface Wired {
  readonly d: TestDevice;
  readonly replica: ReplicaPort;
  readonly engine: SyncEngine;
  readonly body: ScriptedBody;
  readonly sharedPath: string;
  readonly root: string;
  readonly key: Buffer;
  /** Waits for the watcher polls already running (real file IO, not a fixed number of ticks). */
  readonly watchSettled: () => Promise<void>;
}

async function wired(): Promise<Wired> {
  const root = makeTempRoot('engine-wiring');
  roots.push(root);
  const d = makeDevice(root);
  const nv = newVaultSeed(d);
  const cloud = path.join(root, 'cloud');
  fs.mkdirSync(cloud, { recursive: true });
  const sharedPath = path.join(cloud, 'Vault.conduit');
  const replica = (await open(d, nv.lineageId, nv.key, nv.seed, bindingFor(sharedPath))).replica;
  return wire(d, replica, sharedPath, root, nv.key);
}

/** A second device that adopts S (already on disk) while side files are reported: legacy deletes are held. */
async function adoptWithHold(w: Wired): Promise<Wired> {
  const d = makeDevice(w.root, { hw8: 'bbbbbbbb' });
  const bytes = fs.readFileSync(w.sharedPath);
  const seed = {
    kind: 'adopt',
    sharedBytes: bytes,
    sharedSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    sharedMtimeMs: fs.statSync(w.sharedPath).mtimeMs,
    holdLegacy: true,
  } as const;
  const replica = (await open(d, w.replica.lineageId, w.key, seed, bindingFor(w.sharedPath))).replica;
  return wire(d, replica, w.sharedPath, w.root, w.key);
}

function wire(d: TestDevice, replica: ReplicaPort, sharedPath: string, root: string, key: Buffer): Wired {
  const assembled = assembleSyncEngine({ host: d.t.host, replica, session: nullSessionSignals(), realpath: sharedPath });
  const body = new ScriptedBody(() => d.t.clock.now());
  const watchers: SharedFileWatcher[] = [];
  const createWatcher: SyncEngineDeps['createWatcher'] = (p, listener) => {
    const w = new SharedFileWatcher(p, d.t.host, listener);
    watchers.push(w);
    return w;
  };
  const engine = new SyncEngine({ ...assembled.parts(), createWatcher }, {
    runCycleBody: body.run,
    errorBackoff: new TestBackoff(),
    verifier: new TestVerifier(),
    regressions: new TestRegressions(),
    torn: new TestTorn(),
  });
  cleanups.push(async () => {
    await engine.stop();
    replica.close();
    expect(d.t.logger.unprefixed()).toEqual([]);
  });
  const watchSettled = async () => {
    await Promise.all(watchers.map((w) => w.settled()));
  };
  return { d, replica, engine, body, sharedPath, root, key, watchSettled };
}

function mutateEntry(w: Wired, id: string): void {
  w.d.t.workingCopy.last().mutate((db) => insertEntry(db, id, `Server ${id}`), {
    rows: [{ tbl: TBL.entries, rowId: id }],
    interactive: true,
  });
}

describe('engine wired to the real modules', () => {
  it('a ConduitVault mutation reaches the engine through the replica hooks (2 s idle)', async () => {
    const w = await wired();
    w.engine.start();
    // Start-up cleanup and the first copy scan run in the lane on real files first.
    await w.engine.whenIdle();
    const t0 = w.d.t.clock.now();
    mutateEntry(w, 'e1');
    expect(w.engine.parts().status.snapshot()).toMatchObject({ kind: 'pending', unsyncedOps: 1 });
    await w.d.t.clock.advance(LOCAL_EDIT_IDLE_MS);
    expect(w.body.calls.filter((c) => c.reason === 'local-edit').map((c) => c.atMs - t0)).toEqual([LOCAL_EDIT_IDLE_MS]);
  });

  it('T-RACE-1 engine side: a mutation while a cycle runs is committed and gets its own cycle', async () => {
    const w = await wired();
    w.engine.start();
    await w.engine.whenIdle();
    const gate = deferred();
    const entered = deferred();
    w.body.then(async (env) => {
      entered.resolve();
      await gate.promise;
      env.checkAlive();
      return UP_TO_DATE;
    });
    const running = w.engine.runCycle('shared-changed');
    await entered.promise;
    const gen = w.replica.generation();
    mutateEntry(w, 'e2');
    expect(w.replica.generation()).toBe(gen + 1);
    gate.resolve();
    await running;
    await w.d.t.clock.advance(LOCAL_EDIT_IDLE_MS);
    expect(w.body.reasons()).toEqual(['shared-changed', 'local-edit']);
    expect(w.replica.state().rows.has('1:e2')).toBe(true);
  });

  it('the real watcher reports a new S and side files next to it', async () => {
    const w = await wired();
    w.engine.start();
    await w.engine.whenIdle();
    await w.d.t.clock.advance(STAT_POLL_MS);
    await w.watchSettled();
    expect(w.body.calls).toEqual([]);
    fs.writeFileSync(w.sharedPath, 'not yet a vault');
    fs.writeFileSync(`${w.sharedPath}-wal`, '');
    await w.d.t.clock.advance(STAT_POLL_MS);
    await w.watchSettled();
    await w.engine.whenIdle();
    expect(w.body.reasons()).toContain('shared-changed');
    const status = w.engine.parts().status.snapshot();
    expect(status.prompts.map((p) => p.kind)).toEqual(['side-files']);
    expect(w.d.t.events.of('sync:notice').filter((e) => e.notice.kind === 'side-files-reminder')).toHaveLength(1);
    fs.rmSync(`${w.sharedPath}-wal`);
    await w.d.t.clock.advance(STAT_POLL_MS);
    await w.watchSettled();
    await w.engine.whenIdle();
    expect(w.engine.parts().status.snapshot().prompts).toEqual([]);
  });

  it('exports W as a real vault file under exports/', async () => {
    const w = await wired();
    mutateEntry(w, 'e3');
    const out = await w.engine.exportUnsynced();
    expect(path.dirname(out)).toBe(w.replica.paths.exports);
    const db = new Database(out, { readonly: true });
    try {
      expect(db.prepare('SELECT name FROM entries WHERE id = ?').get('e3')).toEqual({ name: 'Server e3' });
      expect(loadFile(db).state.lineageId).toBe(w.replica.lineageId);
    } finally {
      db.close();
    }
  });

  it('makes a separate vault from W without changing W', async () => {
    const w = await wired();
    mutateEntry(w, 'e4');
    const gen = w.replica.generation();
    const target = path.join(path.dirname(w.sharedPath), 'Vault separate.conduit');
    const fork = await w.engine.makeSeparateVault(target);
    expect(fork.path).toBe(target);
    expect(fork.lineageId).not.toBe(w.replica.lineageId);
    expect(w.replica.generation()).toBe(gen);
    const db = new Database(target, { readonly: true });
    try {
      expect(loadFile(db).state.lineageId).toBe(fork.lineageId);
      expect(db.prepare('SELECT id FROM entries').all()).toEqual([{ id: 'e4' }]);
    } finally {
      db.close();
    }
    expect(fs.readdirSync(w.replica.paths.tmp).filter((n) => n.startsWith('fork-'))).toEqual([]);
  });

  it('stop leaves no timers, keeps W open, and pending_publish persisted by the final cycle', async () => {
    const w = await wired();
    w.engine.start();
    await w.engine.whenIdle();
    mutateEntry(w, 'e5');
    w.body.then(() => new Promise(() => undefined));
    const fin = w.engine.finalCycle('lock');
    await flushAsync();
    await w.d.t.clock.advance(3_000);
    await expect(fin).resolves.toMatchObject({ timedOut: true, pendingPublish: true });
    await w.engine.stop();
    expect(w.d.t.clock.pending()).toBe(0);
    expect(w.replica.state().rows.has('1:e5')).toBe(true);
    expect(readLocalJson(w.replica.paths.dir, w.d.t.clock.now()).value?.pendingPublish).toBe(true);
    expect(w.d.t.logger.unprefixed()).toEqual([]);
  });

  it('same-device copy [Use as a separate vault]: forks the copy and ignores its SHA-256', async () => {
    const w = await wired();
    mutateEntry(w, 'e6');
    const copy = await w.engine.exportUnsynced();
    const target = path.join(path.dirname(w.sharedPath), 'Copy separate.conduit');
    await w.engine.resolveSameDeviceCopy('separate', copy, target);
    const db = new Database(target, { readonly: true });
    try {
      expect(loadFile(db).state.lineageId).not.toBe(w.replica.lineageId);
    } finally {
      db.close();
    }
    const copySha = crypto.createHash('sha256').update(fs.readFileSync(copy)).digest('hex');
    expect(w.replica.local().ignoredCopies).toContain(copySha);
  });

  it('publishInitial writes S once, with the binding file_id and the marker recorded', async () => {
    const w = await wired();
    mutateEntry(w, 'e7');
    await expect(w.engine.publishInitial()).resolves.toBe(true);
    const bytes = fs.readFileSync(w.sharedPath);
    const local = w.replica.local();
    expect(local.pendingPublish).toBe(false);
    expect(local.lastPublished?.sha256).toBe(crypto.createHash('sha256').update(bytes).digest('hex'));
    const copy = path.join(w.replica.paths.tmp, 'check.conduit');
    fs.writeFileSync(copy, bytes);
    const db = new Database(copy);
    try {
      const s = loadFile(db);
      expect(s.state.lineageId).toBe(w.replica.lineageId);
      expect(s.fileId).toBe(local.binding?.fileId);
      expect(s.state.vv.get(w.replica.dev())).toEqual({ ms: local.lastPublished?.markerDot.ms, c: local.lastPublished?.markerDot.c });
    } finally {
      db.close();
    }
    await expect(w.engine.publishInitial()).resolves.toBe(false);
  });

  it('[Save a new copy here] publishes W to a new path and rebinds with a new file_id', async () => {
    const w = await wired();
    await w.engine.publishInitial();
    const oldFileId = w.replica.local().binding?.fileId;
    fs.rmSync(w.sharedPath);
    const target = path.join(path.dirname(w.sharedPath), 'Vault here.conduit');
    await expect(w.engine.saveNewCopyHere(target)).resolves.toBe(true);
    const binding = w.replica.local().binding;
    expect(binding?.sharedPath).toBe(target);
    expect(binding?.fileId).not.toBe(oldFileId);
    expect(fs.existsSync(w.sharedPath)).toBe(false);
    expect(w.engine.parts().status.snapshot().fileName).toBe('Vault here.conduit');
  });

  it('held legacy delete [Apply these changes]: applied in one commit, list and prompt cleared, then a cycle', async () => {
    const b = await heldDelete();
    b.engine.parts().status.setPrompt({ kind: 'held-legacy', id: 'held-legacy', deletes: 1, reverts: 0 });
    const out = await b.engine.applyHeld();
    expect(out).not.toBeNull();
    expect(rowLife(b.replica.state(), { tbl: TBL.entries, rowId: 'h1' })).toBe('dead');
    expect(b.replica.local().heldLegacy).toEqual([]);
    expect(b.engine.parts().status.snapshot().prompts).toEqual([]);
    await flushAsync();
    await b.engine.whenIdle();
    expect(b.body.reasons()).toEqual(['sync-now']);
  });

  it('held legacy delete [Keep my versions]: the row stays live under a new interactive dot', async () => {
    const b = await heldDelete();
    const gen = b.replica.generation();
    const out = await b.engine.keepHeld();
    expect(out?.generation).toBe(gen + 1);
    expect(rowLife(b.replica.state(), { tbl: TBL.entries, rowId: 'h1' })).toBe('live');
    expect(b.replica.local().heldLegacy).toEqual([]);
  });
});

/** A: vault with h1, S = a VACUUM of A's W; an older app deletes h1 in S; B adopts with the hold rule on. */
async function heldDelete(): Promise<Wired> {
  const a = await wired();
  mutateEntry(a, 'h1');
  fs.copyFileSync(await a.engine.exportUnsynced(), a.sharedPath);
  editInPlace(a.sharedPath, (db) => db.prepare(`DELETE FROM entries WHERE id = 'h1'`).run());
  const b = await adoptWithHold(a);
  expect(b.replica.local().heldLegacy.map((h) => h.kind)).toEqual(['delete']);
  expect(rowLife(b.replica.state(), { tbl: TBL.entries, rowId: 'h1' })).toBe('live');
  return b;
}

