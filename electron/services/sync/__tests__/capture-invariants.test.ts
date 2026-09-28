// @vitest-environment node
// Property test: random desktop and legacy edits on a real vault, absorbed by alternating local
// and legacy captures, never break invariants I1/I2 or canonical form, and a local capture is
// idempotent once the cache matches the content it produced.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { captureFullPass } from '../capture-local.js';
import { captureLegacy } from '../capture-legacy.js';
import { checkInvariants } from '../merge.js';
import { recoveryFrom } from '../state-view.js';
import type { RowCache, SyncState } from '../types.js';
import {
  DEV_A,
  cacheFor,
  createVault,
  dot,
  grdb,
  implicitFor,
  initialState,
  iosSaveEntry,
  legacyAtt,
  makeCtx,
  readContent,
  simulateLoad,
  type VaultFixture,
} from './capture-fixtures.js';

const ctx = makeCtx();
const implicit = implicitFor(ctx);
const RUNS = 25;
/** Each run builds a real vault; under a fully parallel suite the default 5 s is too tight. */
const PROPERTY_TIMEOUT_MS = 30_000;
const T0 = Date.parse('2026-09-20T00:00:00.000Z');

type Cmd =
  | { readonly op: 'edit'; readonly i: number; readonly host: string }
  | { readonly op: 'move'; readonly i: number; readonly j: number }
  | { readonly op: 'delete'; readonly i: number }
  | { readonly op: 'create'; readonly name: string }
  | { readonly op: 'ios-notes'; readonly i: number; readonly notes: string }
  | { readonly op: 'ios-config'; readonly i: number }
  | { readonly op: 'ios-folder-delete'; readonly j: number }
  | { readonly op: 'capture-local'; readonly interactive: boolean }
  | { readonly op: 'capture-legacy'; readonly hold: boolean };

const small = fc.nat({ max: 9 });
const word = fc.constantFrom('a', 'b', 'c', '');
const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
  fc.record({ op: fc.constant('edit' as const), i: small, host: word }),
  fc.record({ op: fc.constant('move' as const), i: small, j: small }),
  fc.record({ op: fc.constant('delete' as const), i: small }),
  fc.record({ op: fc.constant('create' as const), name: word }),
  fc.record({ op: fc.constant('ios-notes' as const), i: small, notes: word }),
  fc.record({ op: fc.constant('ios-config' as const), i: small }),
  fc.record({ op: fc.constant('ios-folder-delete' as const), j: small }),
  fc.record({ op: fc.constant('capture-local' as const), interactive: fc.boolean() }),
  fc.record({ op: fc.constant('capture-legacy' as const), hold: fc.boolean() }),
);

interface World {
  readonly v: VaultFixture;
  state: SyncState;
  cache: RowCache;
  clock: number;
}

const ids = (v: VaultFixture, table: string): string[] =>
  (v.raw.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as Array<{ id: string }>).map((r) => r.id);

function pick<T>(list: readonly T[], i: number): T | undefined {
  return list.length === 0 ? undefined : list[i % list.length];
}

function applyEdit(w: World, cmd: Cmd): void {
  const entries = ids(w.v, 'entries');
  const folders = ids(w.v, 'folders');
  if (cmd.op === 'edit') { const id = pick(entries, cmd.i); if (id) w.v.vault.updateEntry(id, { host: cmd.host || null }); }
  if (cmd.op === 'move') { const id = pick(entries, cmd.i); if (id) w.v.vault.moveEntry(id, pick(folders, cmd.j) ?? null); }
  if (cmd.op === 'delete') { const id = pick(entries, cmd.i); if (id) w.v.vault.deleteEntry(id); }
  if (cmd.op === 'create') w.v.vault.createEntry({ name: cmd.name || 'n', entry_type: 'rdp', password: 'p', config: { r: 1 } });
  if (cmd.op === 'ios-notes') { const id = pick(entries, cmd.i); if (id) iosSaveEntry(w.v.raw, id, { notes: cmd.notes }, T0 + ++w.clock); }
  if (cmd.op === 'ios-config') { const id = pick(entries, cmd.i); if (id) iosSaveEntry(w.v.raw, id, { config: '{}' }, T0 + ++w.clock); }
  if (cmd.op === 'ios-folder-delete') { const id = pick(folders, cmd.j); if (id) w.v.raw.prepare('DELETE FROM folders WHERE id = ?').run(id); }
}

function capture(w: World, cmd: Cmd): void {
  const content = readContent(w.v.raw);
  if (cmd.op === 'capture-local') {
    const att = { kind: 'local', dot: dot(DEV_A, 10_000 + ++w.clock), interactive: cmd.interactive } as const;
    w.state = captureFullPass({ state: w.state, content, cache: w.cache, implicit }, att, ctx).state;
    w.cache = cacheFor(content);
    const again = captureFullPass({ state: w.state, content, cache: w.cache, implicit }, { ...att, dot: dot(DEV_A, 10_000 + ++w.clock) }, ctx);
    expect(again.state).toBe(w.state);
  } else if (cmd.op === 'capture-legacy') {
    const x = simulateLoad(w.state, content, w.cache);
    const att = legacyAtt(ctx, { recover: recoveryFrom(w.state), sideFilesPresent: cmd.hold });
    w.state = captureLegacy({ state: x, content, cache: w.cache, implicit }, att, ctx).state;
    w.cache = cacheFor(content);
  }
  const report = checkInvariants(w.state);
  expect(report).toEqual({ uncoveredApp: [], uncoveredPseudo: [], nonCanonical: [] });
}

function seedWorld(): World {
  const v = createVault();
  const f1 = v.vault.createFolder({ name: 'f1' });
  const f2 = v.vault.createFolder({ name: 'f2', parent_id: f1.id });
  const e1 = v.vault.createEntry({ name: 'e1', entry_type: 'ssh', folder_id: f1.id, host: 'h', password: 'pw' });
  v.vault.createEntry({ name: 'e2', entry_type: 'rdp', folder_id: f2.id, config: { res: '1080p' } });
  v.vault.createEntry({ name: 'e3', entry_type: 'ssh', parent_entry_id: e1.id, notes: grdb(T0) });
  v.vault.recordPasswordHistory(e1.id, 'u', 'old', 'user');
  const init = initialState(readContent(v.raw), ctx);
  return { v, state: init.state, cache: init.cache, clock: 0 };
}

describe('capture invariants under random desktop and legacy edits', () => {
  it('keeps I1, I2 and canonical form; local capture is idempotent', () => {
    fc.assert(
      fc.property(fc.array(cmdArb, { minLength: 1, maxLength: 14 }), (cmds) => {
        const w = seedWorld();
        try {
          for (const cmd of cmds) {
            if (cmd.op === 'capture-local' || cmd.op === 'capture-legacy') capture(w, cmd);
            else applyEdit(w, cmd);
          }
          capture(w, { op: 'capture-local', interactive: false });
        } finally {
          w.v.close();
        }
      }),
      { numRuns: RUNS },
    );
  }, PROPERTY_TIMEOUT_MS);
});
