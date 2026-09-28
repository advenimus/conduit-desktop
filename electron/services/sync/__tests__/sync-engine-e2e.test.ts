// @vitest-environment node
// End to end on real files: two devices' engines (assembleSyncEngine, the real cycle, absorb,
// verification and presence) sharing one folder. T-RACE-1, termination, content repair once
// per S, the kill switch, the final cycle's closed presence and the regression back-off.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SyncEngine, assembleSyncEngine, nullSessionSignals, type CycleOutcome } from '../sync-engine.js';
import { writePresence } from '../sync-engine-presence.js';
import { readPresence } from '../presence.js';
import { readLocalJson } from '../local-state.js';
import { loadFile } from '../state-store.js';
import { rowLife } from '../state-view.js';
import { TBL, type LoadedFile } from '../types.js';
import type { ReplicaPort } from '../replica.js';
import type { SnapshotStorePort } from '../snapshots.js';
import type { TestWorkingCopy } from './host-fakes.js';
import { makeTempRoot } from './host-fakes.js';
import { bindingFor, editInPlace, makeDevice, newVaultSeed, open, sha256, type TestDevice } from './replica-fixtures.js';

const ISO = '2026-09-25T12:00:00.000Z';
const MASS_ROWS = 12;

interface Dev {
  readonly d: TestDevice;
  readonly replica: ReplicaPort;
  readonly wc: TestWorkingCopy;
  engine: SyncEngine;
}

interface Pair {
  readonly a: Dev;
  readonly b: Dev;
  readonly sharedPath: string;
  /** S right after A's first publish (the "older version" a cloud drive can restore). */
  readonly initialBytes: Buffer;
}

const roots: string[] = [];
const devs: Dev[] = [];

afterEach(async () => {
  for (const x of devs.splice(0)) {
    await x.engine.stop();
    x.replica.close();
    expect(x.d.t.logger.unprefixed()).toEqual([]);
  }
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

function engineFor(d: TestDevice, replica: ReplicaPort, sharedPath: string): SyncEngine {
  return assembleSyncEngine({ host: d.t.host, replica, session: nullSessionSignals(), realpath: sharedPath });
}

async function pair(): Promise<Pair> {
  const root = makeTempRoot('engine-e2e');
  roots.push(root);
  const sharedPath = path.join(root, 'cloud', 'Vault.conduit');
  fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
  const dA = makeDevice(root, { hw8: 'aaaaaaaa' });
  const nv = newVaultSeed(dA);
  const bindingA = bindingFor(sharedPath);
  const rA = (await open(dA, nv.lineageId, nv.key, nv.seed, bindingA)).replica;
  const a: Dev = { d: dA, replica: rA, wc: dA.t.workingCopy.last(), engine: engineFor(dA, rA, sharedPath) };
  devs.push(a);
  expect(await a.engine.publishInitial()).toBe(true);
  const initialBytes = fs.readFileSync(sharedPath);
  const dB = makeDevice(root, { hw8: 'bbbbbbbb' });
  const seed = {
    kind: 'adopt',
    sharedBytes: initialBytes,
    sharedSha256: sha256(initialBytes),
    sharedMtimeMs: fs.statSync(sharedPath).mtimeMs,
    holdLegacy: false,
  } as const;
  const rB = (await open(dB, nv.lineageId, nv.key, seed, bindingFor(sharedPath, bindingA.fileId))).replica;
  const b: Dev = { d: dB, replica: rB, wc: dB.t.workingCopy.last(), engine: engineFor(dB, rB, sharedPath) };
  devs.push(b);
  return { a, b, sharedPath, initialBytes };
}

function insert(x: Dev, ids: readonly string[], config = '{}'): void {
  x.wc.mutate(
    (db) => {
      const stmt = db.prepare(
        `INSERT INTO entries (id, name, entry_type, config, created_at, updated_at) VALUES (?, ?, 'ssh', ?, ?, ?)`,
      );
      for (const id of ids) stmt.run(id, `Server ${id}`, config, ISO, ISO);
    },
    { rows: ids.map((rowId) => ({ tbl: TBL.entries, rowId })), interactive: true },
  );
}

function remove(x: Dev, ids: readonly string[]): void {
  x.wc.mutate(
    (db) => {
      for (const id of ids) db.prepare('DELETE FROM entries WHERE id = ?').run(id);
    },
    { rows: ids.map((rowId) => ({ tbl: TBL.entries, rowId })), interactive: true },
  );
}

/** Loads S through a private copy (never opens the shared file in place). */
function loadShared(sharedPath: string, scratch: string): LoadedFile {
  const copy = path.join(scratch, `s-${Date.now()}-${Math.random().toString(16).slice(2)}.conduit`);
  fs.copyFileSync(sharedPath, copy);
  const db = new Database(copy);
  try {
    return loadFile(db);
  } finally {
    db.close();
    fs.rmSync(copy, { force: true });
  }
}

function live(x: Dev, id: string): boolean {
  return rowLife(x.replica.state(), { tbl: TBL.entries, rowId: id }) === 'live';
}

async function cycle(x: Dev): Promise<CycleOutcome['kind']> {
  return (await x.engine.runCycle('shared-changed')).kind;
}

describe('sync engine end to end (real cycle)', { timeout: 30_000 }, () => {
  it('termination: a quiet pair stops publishing after at most two cycles each', async () => {
    const { a, b } = await pair();
    insert(a, ['a1']);
    insert(b, ['b1']);
    const kinds: string[][] = [];
    for (let round = 0; round < 4; round++) kinds.push([await cycle(a), await cycle(b)]);
    const publishes = (i: 0 | 1) => kinds.filter((k) => k[i] === 'published').length;
    expect(publishes(0)).toBeLessThanOrEqual(2);
    expect(publishes(1)).toBeLessThanOrEqual(2);
    expect(kinds.slice(2)).toEqual([
      ['up-to-date', 'up-to-date'],
      ['up-to-date', 'up-to-date'],
    ]);
    for (const x of [a, b]) expect([live(x, 'a1'), live(x, 'b1')]).toEqual([true, true]);
  });

  it('T-RACE-1: a local edit committed between merge and commit survives and is published', async () => {
    const { a, b, sharedPath } = await pair();
    const ids = Array.from({ length: MASS_ROWS }, (_, i) => `m${i}`);
    insert(a, ids);
    expect(await cycle(a)).toBe('published');
    await cycle(b);
    expect(ids.every((id) => live(b, id))).toBe(true);
    remove(a, ids);
    expect(await cycle(a)).toBe('published');
    const parts = b.engine.parts();
    const inner = parts.snapshots;
    let interleaved = 0;
    const snapshots: SnapshotStorePort = {
      take: async (input) => {
        if (interleaved++ === 0) insert(b, ['mid']);
        return inner.take(input);
      },
      list: () => inner.list(),
      loadDiff: (id) => inner.loadDiff(id),
      prune: (now) => inner.prune(now),
      undoPreview: (id, current, implicit) => inner.undoPreview(id, current, implicit),
      undoWrites: (id, current, choice, ring, ctx) => inner.undoWrites(id, current, choice, ring, ctx),
    };
    await b.engine.stop();
    b.engine = new SyncEngine({ ...parts, snapshots });
    expect(await cycle(b)).toBe('published');
    expect(interleaved).toBe(1);
    expect(ids.some((id) => live(b, id))).toBe(false);
    expect(live(b, 'mid')).toBe(true);
    expect(b.replica.local().notices.map((n) => n.kind)).toContain('mass-change');
    await cycle(a);
    expect(live(a, 'mid')).toBe(true);
    const s = loadShared(sharedPath, a.replica.paths.tmp);
    expect(rowLife(s.state, { tbl: TBL.entries, rowId: 'mid' })).toBe('live');
  });

  it('content repair: a dropped legacy change is published over once, then the pair is quiet', async () => {
    const { a, sharedPath } = await pair();
    insert(a, ['e1'], '{"color":"red"}');
    expect(await cycle(a)).toBe('published');
    editInPlace(sharedPath, (db) => db.prepare(`UPDATE entries SET config = '{}', updated_at = ? WHERE id = 'e1'`).run(ISO));
    const legacySha = sha256(fs.readFileSync(sharedPath));
    expect(await cycle(a)).toBe('published');
    expect(a.replica.local().contentRepairShas).toContain(legacySha);
    expect(a.replica.local().notices.map((n) => n.kind)).toContain('dropped-setting');
    expect(await cycle(a)).toBe('up-to-date');
    const db = new Database(sharedPath, { readonly: true });
    try {
      expect(db.prepare(`SELECT config FROM entries WHERE id = 'e1'`).get()).toEqual({ config: '{"color":"red"}' });
    } finally {
      db.close();
    }
  });

  it('kill switch: personal_sync paused merges and publishes nothing; lifting it publishes', async () => {
    const { a, sharedPath } = await pair();
    insert(a, ['k1']);
    const before = sha256(fs.readFileSync(sharedPath));
    a.d.t.knobs.personalSyncPaused = true;
    await expect(a.engine.runCycle('local-edit')).resolves.toEqual({ kind: 'skipped', reason: 'kill-switch' });
    expect(sha256(fs.readFileSync(sharedPath))).toBe(before);
    expect(a.engine.parts().status.snapshot()).toMatchObject({ kind: 'paused', pauseReason: 'kill-switch' });
    a.d.t.knobs.personalSyncPaused = false;
    expect(await cycle(a)).toBe('published');
    expect(a.engine.parts().status.snapshot()).toMatchObject({ kind: 'up-to-date', pauseReason: null });
  });

  it('final cycle on lock publishes the closed presence and clears pending_publish', async () => {
    const { a, sharedPath } = await pair();
    writePresence(
      { host: a.d.t.host, replica: a.replica, sideFiles: a.engine.parts().sideFiles },
      { sessionOpen: true, sessionSinceMs: a.d.t.clock.now(), fileHint: a.engine.parts().binding.fileHint() },
    );
    expect(await cycle(a)).toBe('published');
    const fin = await a.engine.finalCycle('lock');
    expect(fin).toMatchObject({ published: true, timedOut: false, pendingPublish: false });
    const s = loadShared(sharedPath, a.replica.paths.tmp);
    expect(readPresence(s.state, a.replica.deviceUuid)?.value.session_open).toBe(0);
    const vv = s.state.vv.get(a.replica.dev());
    expect(fin.marker).toEqual({ dev: a.replica.dev(), ms: vv?.ms, c: vv?.c });
    expect(readLocalJson(a.replica.paths.dir, a.d.t.clock.now()).value?.pendingPublish).toBe(false);
  });

  it('regression back-off after 4 silent overwrites within 10 minutes, with one toast', async () => {
    const { a, sharedPath, initialBytes } = await pair();
    insert(a, ['r1']);
    expect(await cycle(a)).toBe('published');
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i++) {
      fs.writeFileSync(sharedPath, initialBytes);
      outcomes.push(await cycle(a));
    }
    expect(outcomes).toEqual(['published', 'published', 'published', 'merged-not-published']);
    expect(a.engine.parts().status.snapshot()).toMatchObject({ kind: 'paused', pauseReason: 'regression-backoff' });
    const toasts = a.d.t.events.of('sync:notice').filter((e) => e.notice.kind === 'regression-backoff');
    expect(toasts).toHaveLength(1);
  });
});
