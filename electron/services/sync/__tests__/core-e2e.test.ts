// @vitest-environment node
// End-to-end over the sync core: two simulated devices migrate the same real ConduitVault file
// (G1 on both), edit their working copies through ConduitVault plus capture-local, publish with
// VACUUM INTO, absorb and merge each other's file, and materialize. After every exchange both
// working copies must hold identical content, identical digests and the same conflict list.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConduitVault } from '../../vault/vault.js';
import { regKey, rowKey } from '../catalog.js';
import {
  CHANGED_BY_CONFLICT,
  listConflicts,
  resolveCycle,
  resolveEditDelete,
  resolveField,
  type ConflictContext,
} from '../conflicts.js';
import { canonicalDump, digestState } from '../digest.js';
import { currentEpochId } from '../key-epoch.js';
import { checkInvariants } from '../merge.js';
import { getRegister } from '../state-view.js';
import { listRecentlyDeleted } from '../tombstones.js';
import { TBL, type ConflictGroup, type CycleConflict, type SyncState } from '../types.js';
import { SimDevice, type SyncOutcome } from './core-e2e-harness.js';
import {
  NEW_PASSWORD,
  OLD_PASSWORD,
  comparableContent,
  conflictSummary,
  contentProblems,
  createLegacyVault,
  decryptAllSecrets,
  entryRow,
  folderParent,
  historyIds,
  type LegacyFixture,
} from './core-e2e-fixtures.js';

const T_LEGACY = Date.UTC(2026, 8, 20, 8, 0, 0);
const T_START = Date.UTC(2026, 8, 25, 9, 0, 0);
const STEP_MS = 60_000;
const PUBLISH_GAP_MS = 1_000;
const PBKDF2_TEST_TIMEOUT_MS = 60_000;

let legacyDir = '';
let fixture: LegacyFixture;
let root = '';
let shared = '';
let world = { now: T_START };
let a: SimDevice;
let b: SimDevice;

function advance(ms = STEP_MS): void {
  world.now += ms;
  vi.setSystemTime(world.now);
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T_LEGACY);
  legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-sync-e2e-legacy-'));
  fixture = createLegacyVault(legacyDir);
});

afterAll(() => {
  vi.useRealTimers();
  fs.rmSync(legacyDir, { recursive: true, force: true });
});

beforeEach(() => {
  world = { now: T_START };
  vi.setSystemTime(world.now);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-sync-e2e-'));
  fs.mkdirSync(path.join(root, 'cloud'));
  shared = path.join(root, 'cloud', 'Vault.conduit');
  a = new SimDevice({ name: 'mac', root, source: fixture.source, now: () => world.now });
  advance(PUBLISH_GAP_MS);
  b = new SimDevice({ name: 'pc', root, source: fixture.source, now: () => world.now });
});

afterEach(() => {
  a.close();
  b.close();
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------- Helpers ----------

function exchange(from: SimDevice, to: SimDevice): SyncOutcome {
  from.publish(shared);
  advance(PUBLISH_GAP_MS);
  return to.sync(shared);
}

/** A publishes, B merges and publishes, A merges, then A publishes once more: B must be up to date. */
function converge(): SyncOutcome[] {
  return [exchange(a, b), exchange(b, a), exchange(a, b)];
}

function conflictContext(dev: SimDevice): ConflictContext {
  return {
    implicit: dev.implicit,
    structural: dev.structural,
    snoozed: new Set(),
    candidateLabels: new Map(),
    repairedKeys: new Set(),
    keys: dev.keys,
  };
}

function conflictsOf(dev: SimDevice): ConflictGroup[] {
  return listConflicts(dev.state, conflictContext(dev));
}

function expectInvariants(state: SyncState): void {
  expect(checkInvariants(state)).toEqual({ uncoveredApp: [], uncoveredPseudo: [], nonCanonical: [] });
}

function expectConverged(outcomes: readonly SyncOutcome[]): void {
  for (const o of outcomes) {
    expect(o).toMatchObject({ kind: 'merged', prePassChanged: false, absorbChanged: false, invariantViolations: 0 });
  }
  expect(outcomes[outcomes.length - 1]).toMatchObject({ upToDate: true });
  expect(canonicalDump(a.state)).toBe(canonicalDump(b.state));
  expect(digestState(a.state)).toBe(digestState(b.state));
  expect(comparableContent(a.db)).toEqual(comparableContent(b.db));
  expect(contentProblems(a.db)).toEqual([]);
  expect(contentProblems(b.db)).toEqual([]);
  expectInvariants(a.state);
  expectInvariants(b.state);
  expect(conflictsOf(a)).toEqual(conflictsOf(b));
  expect(a.fullPass()).toBe(false);
  expect(b.fullPass()).toBe(false);
}

const entryKey = (id: string, reg: string) => regKey(TBL.entries, id, reg);

interface PasswordChangeSteps {
  /** Edits B makes before it has seen the change (still under the old key). */
  readonly pending: () => void;
  /** Edits A makes right after changing the password. */
  readonly afterChange: () => void;
  /** Checks while B's merge is paused, before the new password is entered. */
  readonly whilePaused?: () => void;
}

/** A changes the master password while B holds unpublished edits; B enters the new password (4.8). */
function passwordChangeWithPending(steps: PasswordChangeSteps): void {
  advance();
  steps.pending();
  advance();
  a.changePassword(NEW_PASSWORD);
  advance();
  steps.afterChange();
  a.publish(shared);
  advance(PUBLISH_GAP_MS);
  expect(b.sync(shared)).toMatchObject({ kind: 'paused', align: { kind: 'pause-newer', changedByDeviceUuid: a.deviceUuid } });
  steps.whilePaused?.();
  expect(b.enterNewPassword(shared, NEW_PASSWORD)).toMatchObject({ ok: true, via: 's-newer' });
  expectConverged(converge());
}

// ---------- Scenarios ----------

describe('sync core end to end (two devices, real vault files)', () => {
  it('genesis on both devices builds one state and leaves the legacy content as it was', () => {
    expect(a.genesisDigest).toBe(b.genesisDigest);
    const legacyCopy = path.join(root, 'legacy-copy.conduit');
    fs.writeFileSync(legacyCopy, fixture.source.bytes);
    const legacyDb = new Database(legacyCopy, { readonly: true });
    const theirs = comparableContent(legacyDb, true);
    legacyDb.close();
    const mine = comparableContent(a.db, true);
    expect([mine.entries, mine.folders, mine.history].map((rows) => (rows as unknown[]).length)).toEqual([4, 2, 1]);
    expect({ ...mine, meta: undefined }).toEqual({ ...theirs, meta: undefined });
    expect(mine.meta).toMatchObject({ ...(theirs.meta as object), sync_format: '1' });

    expectConverged(converge());
    expect(conflictsOf(a)).toEqual([]);
    expect(a.state.devs.size).toBe(2);
  });

  it('a same-field edit on both devices becomes one conflict, and a resolution propagates', () => {
    const { web } = fixture.ids;
    advance();
    a.edit((v) => v.updateEntry(web, { host: 'a.example' }));
    advance();
    b.edit((v) => v.updateEntry(web, { host: 'b.example' }));

    expectConverged(converge());
    expect(entryRow(a.db, web)?.host).toBe('b.example');
    expect(conflictSummary(conflictsOf(a))).toEqual([
      { row: web, kind: 'field', detail: { reg: 'host', values: ['b.example', 'a.example'] } },
    ]);

    const hostKey = entryKey(web, 'host');
    const field = conflictsOf(a)[0].items[0];
    if (field.kind !== 'field') throw new Error('expected a field conflict');
    const pick = field.field.versions.find((v) => v.value === 'a.example');
    advance();
    a.write(resolveField(a.state, hostKey, { kind: 'version', versionId: pick?.id ?? '' }, a.ctx));

    expectConverged(converge());
    expect(entryRow(b.db, web)?.host).toBe('a.example');
    expect(conflictsOf(b)).toEqual([]);
    expect(getRegister(b.state, hostKey)?.sibs).toHaveLength(1);
  });

  it('edits to different fields of one entry merge without a conflict', () => {
    const { web } = fixture.ids;
    advance();
    a.edit((v) => v.updateEntry(web, { port: 2222, tags: ['prod', 'db'] }));
    advance();
    b.edit((v) => v.updateEntry(web, { username: 'admin', notes: 'rotated keys' }));

    expectConverged(converge());
    for (const dev of [a, b]) {
      expect(entryRow(dev.db, web)).toMatchObject({ host: '10.0.0.1', port: 2222, username: 'admin', notes: 'rotated keys' });
      expect(JSON.parse(String(entryRow(dev.db, web)?.tags))).toEqual(['db', 'prod']);
    }
    expect(conflictsOf(a)).toEqual([]);
  });

  it('an edit against a delete keeps the item with an edit-vs-delete conflict until resolved', () => {
    const { db } = fixture.ids;
    advance();
    a.edit((v) => v.deleteEntry(db), true);
    advance();
    b.edit((v) => v.updateEntry(db, { host: '10.0.0.6' }));

    expectConverged(converge());
    expect(entryRow(a.db, db)?.host).toBe('10.0.0.6');
    expect(conflictSummary(conflictsOf(a))).toEqual([{ row: db, kind: 'edit-delete', detail: { deleted: 1, edited: 1 } }]);

    advance();
    b.write(resolveEditDelete(b.state, rowKey(TBL.entries, db), 'delete', b.ctx));
    expectConverged(converge());
    expect(entryRow(a.db, db)).toBeUndefined();
    expect(conflictsOf(a)).toEqual([]);
    for (const dev of [a, b]) {
      expect(listRecentlyDeleted(dev.state, world.now, true).map((d) => d.row.rowId)).toEqual([db]);
    }
  });

  it('a folder deleted on one device while an item inside is edited on the other', () => {
    const { servers, web, db, webHistory } = fixture.ids;
    advance();
    a.edit((v) => v.deleteFolder(servers), true);
    advance();
    b.edit((v) => v.updateEntry(web, { notes: 'still needed' }));

    expectConverged(converge());
    expect(entryRow(a.db, web)?.notes).toBe('still needed');
    expect(folderParent(a.db, servers)).toBeNull();
    expect(entryRow(a.db, db)).toBeUndefined();
    expect(historyIds(a.db)).toEqual([webHistory]);
    expect(conflictSummary(conflictsOf(a))).toEqual([
      { row: web, kind: 'edit-delete', detail: { deleted: 1, edited: 1 } },
      { row: servers, kind: 'folder-delete', detail: { changedItems: [web] } },
    ]);
  });

  it('two folders moved into each other break the cycle the same way on both devices', () => {
    const { servers, clients } = fixture.ids;
    advance();
    a.edit((v) => v.updateFolder(servers, { parent_id: clients }));
    advance();
    b.edit((v) => v.updateFolder(clients, { parent_id: servers }));

    expectConverged(converge());
    for (const dev of [a, b]) {
      expect(folderParent(dev.db, servers)).toBe(clients);
      expect(folderParent(dev.db, clients)).toBeNull();
    }
    const cycle: CycleConflict = { kind: 'cycle', tbl: TBL.folders, rowIds: [servers, clients].sort(), movedToRoot: clients };
    expect(a.structural).toEqual([cycle]);
    expect(conflictSummary(conflictsOf(b))).toEqual([
      { row: clients, kind: 'cycle', detail: { rowIds: cycle.rowIds, movedToRoot: clients } },
    ]);

    advance();
    a.write(resolveCycle(cycle, { kind: 'put-under', child: servers, parent: clients }, a.ctx));
    expectConverged(converge());
    expect(folderParent(b.db, servers)).toBe(clients);
    expect(folderParent(b.db, clients)).toBeNull();
    expect(b.structural).toEqual([]);
    expect(conflictsOf(b)).toEqual([]);
  });

  it('an older desktop editing the shared file in place is absorbed as legacy edits', () => {
    const { web, desk } = fixture.ids;
    a.publish(shared);
    advance();
    const older = new ConduitVault(shared);
    older.unlockWithKey(fixture.source.key);
    older.updateEntry(web, { host: 'legacy-host' });
    older.deleteEntry(desk);
    older.lock();
    fs.utimesSync(shared, new Date(world.now), new Date(world.now));
    advance(PUBLISH_GAP_MS);

    expect(b.sync(shared)).toMatchObject({ kind: 'merged', absorbChanged: true, invariantViolations: 0 });
    expectConverged(converge());
    for (const dev of [a, b]) {
      expect(entryRow(dev.db, web)?.host).toBe('legacy-host');
      expect(entryRow(dev.db, desk)).toBeUndefined();
      const host = getRegister(dev.state, entryKey(web, 'host'))?.sibs ?? [];
      expect(host.map((s) => [s.dev, s.value])).toEqual([[0, 'legacy-host']]);
      expect(decryptAllSecrets(dev.db, dev.keys.current.kEpoch).get(`entries.${web}.password_encrypted`)).toBe('pw-web');
    }
    expect(conflictsOf(a)).toEqual([]);
  });

  it(
    'a password change on one device keeps the pending edits of the other',
    () => {
      const { web, db, desk, webHistory } = fixture.ids;
      const e0 = currentEpochId(a.state);
      let created = '';
      passwordChangeWithPending({
        pending: () => {
          b.edit((v) => v.updateEntry(web, { host: 'b-host' }));
          b.edit((v) => v.updateEntry(db, { password: 'pw-db-B' }));
          b.edit((v) => {
            created = v.createEntry({ name: 'made on pc', entry_type: 'ssh', folder_id: fixture.ids.clients, password: 'pw-new' }).id;
          });
        },
        afterChange: () => a.edit((v) => v.updateEntry(desk, { notes: 'after change', password: 'pw-desk-A' })),
        whilePaused: () => {
          expect(entryRow(b.db, web)?.host).toBe('b-host');
          expect(b.opensWithPassword(OLD_PASSWORD)).toBe(true);
        },
      });

      const e2 = currentEpochId(a.state);
      expect(e2).not.toBe(e0);
      for (const dev of [a, b]) {
        expect(currentEpochId(dev.state)).toBe(e2);
        expect(dev.state.epochs.get(e0 ?? '')).toMatchObject({ salt: null, verification: null });
        expect(dev.opensWithPassword(NEW_PASSWORD)).toBe(true);
        const secrets = decryptAllSecrets(dev.db, dev.keys.current.kEpoch);
        expect(secrets.get(`entries.${db}.password_encrypted`)).toBe('pw-db-B');
        expect(secrets.get(`entries.${created}.password_encrypted`)).toBe('pw-new');
        expect(secrets.get(`entries.${desk}.password_encrypted`)).toBe('pw-desk-A');
        expect(secrets.get(`entries.${web}.password_encrypted`)).toBe('pw-web');
        expect(secrets.get(`password_history.${webHistory}.password_encrypted`)).toBe('pw-web-old');
        expect(entryRow(dev.db, web)?.host).toBe('b-host');
        expect(entryRow(dev.db, desk)?.notes).toBe('after change');
      }
      expect(a.opensWithPassword(OLD_PASSWORD)).toBe(false);
      expect(conflictsOf(a)).toEqual([]);
    },
    PBKDF2_TEST_TIMEOUT_MS,
  );

  it(
    'a password edited on both sides of a password change conflicts under the new key',
    () => {
      const { desk } = fixture.ids;
      passwordChangeWithPending({
        pending: () => b.edit((v) => v.updateEntry(desk, { password: 'pw-desk-B' })),
        afterChange: () => a.edit((v) => v.updateEntry(desk, { password: 'pw-desk-A' })),
      });
      expect(conflictSummary(conflictsOf(a))).toEqual([{ row: desk, kind: 'field', detail: { reg: 'password', values: [null, null] } }]);
      expect(decryptAllSecrets(b.db, b.keys.current.kEpoch).get(`entries.${desk}.password_encrypted`)).toBe('pw-desk-A');

      const key = entryKey(desk, 'password');
      const item = conflictsOf(b)[0].items[0];
      if (item.kind !== 'field') throw new Error('expected a field conflict');
      const mine = item.field.versions.find((v) => v.dev === b.dev);
      advance();
      b.write(resolveField(b.state, key, { kind: 'version', versionId: mine?.id ?? '' }, b.ctx));
      expectConverged(converge());

      for (const dev of [a, b]) {
        const secrets = decryptAllSecrets(dev.db, dev.keys.current.kEpoch);
        expect(secrets.get(`entries.${desk}.password_encrypted`)).toBe('pw-desk-B');
        const kept = dev.db.prepare('SELECT id, changed_by FROM password_history WHERE entry_id = ?').all(desk) as Array<{ id: string; changed_by: string }>;
        expect(kept.map((h) => [h.changed_by, secrets.get(`password_history.${h.id}.password_encrypted`)])).toEqual([
          [CHANGED_BY_CONFLICT, 'pw-desk-A'],
        ]);
      }
      expect(conflictsOf(a)).toEqual([]);
    },
    PBKDF2_TEST_TIMEOUT_MS,
  );
});
