// @vitest-environment node
// Review findings on values a replica cannot read (SIB_VALUE_UNKNOWN): a malformed family
// column (finding 1), a legacy delete absorbed by a device that never saw the row (finding 3)
// and a kept w that cannot be recovered (finding 6). One identity always keeps one value (4.5).
import { afterEach, describe, expect, it } from 'vitest';
import { regKey, requireDef, rowKey } from '../catalog.js';
import { makeImplicitProvider, vhashOfValue } from '../hashing.js';
import { isConflict, merge } from '../merge.js';
import { isEligible, pickIdentityCopy, withValueUnknown } from '../sibling.js';
import { StateBuilder, emptyState, getRegister, makeRegister, provisional, rowLife } from '../state-view.js';
import { restoreWrites } from '../tombstones.js';
import { SIB_VALUE_UNKNOWN, TBL, type RegisterDef, type Sibling, type SyncState } from '../types.js';
import { entryRow } from './core-e2e-fixtures.js';
import { addDevice, advance, converge, exchange, olderApp, rawShared, setupWorld, teardownWorld, type World } from './sim-world.js';

let w: World | null = null;
afterEach(() => {
  teardownWorld(w);
  w = null;
});

const E = TBL.entries;
const ek = (id: string, reg: string) => regKey(E, id, reg);

function values(state: SyncState, id: string, reg: string): unknown[] {
  return (getRegister(state, ek(id, reg))?.sibs ?? []).map((s) => s.value);
}

function configOf(row: Record<string, unknown> | undefined): unknown {
  return JSON.parse(String(row?.config));
}

describe('SIB_VALUE_UNKNOWN primitives', () => {
  const key = ek('e', 'host');
  const known: Sibling = { dev: 7, ms: 10, c: 0, pid: '', lt: 0, vhash: vhashOfValue(key, 'h'), flags: 0, value: 'h', prevVhash: null };
  const unknown = withValueUnknown(known);

  it('never lets a copy without its value replace one that has it, in either merge order', () => {
    expect(unknown).toMatchObject({ value: null, flags: SIB_VALUE_UNKNOWN, vhash: known.vhash });
    expect(pickIdentityCopy(known, unknown)).toBe(known);
    expect(pickIdentityCopy(unknown, known)).toBe(known);
  });

  it('merge prefers a copy whose value matches its vhash over an unflagged stale copy, in both orders', () => {
    const stateWith = (s: Sibling): SyncState => {
      const b = new StateBuilder(emptyState('lineage', 'genesis', 0));
      b.ensureRow({ tbl: E, rowId: 'e' });
      b.setRegister(makeRegister(key, [s], null));
      b.joinVv(known.dev, known);
      return b.build();
    };
    const implicit = makeImplicitProvider(Buffer.alloc(32, 1));
    const good = stateWith(known);
    const stale = stateWith({ ...known, value: null });
    expect(getRegister(merge(good, stale, implicit).state, key)!.sibs.map((s) => s.value)).toEqual(['h']);
    expect(getRegister(merge(stale, good, implicit).state, key)!.sibs.map((s) => s.value)).toEqual(['h']);
  });

  it('is never provisional and never a version in the conflict test', () => {
    const def: RegisterDef = requireDef(key);
    const other: Sibling = { ...known, dev: 8, vhash: vhashOfValue(key, 'x'), value: 'x' };
    expect(isEligible(unknown)).toBe(false);
    expect(provisional('host', [unknown, other])).toBe(other);
    expect(isConflict(def, 'host', [unknown, other])).toBe(false);
    expect(isConflict(def, 'host', [known, other])).toBe(true);
  });
});

describe('finding 1: malformed config or tags columns', () => {
  it('an older app writing unparseable config and tags never erases them (every merge order)', () => {
    w = setupWorld();
    const { a, b } = w;
    const { web } = w.fixture.ids;
    converge(w);
    advance(w);
    a.publish(w.shared);
    advance(w);
    rawShared(w, `UPDATE entries SET config = '[]', tags = '{"a":1}', updated_at = ? WHERE id = ?`, new Date(w.now).toISOString(), web);
    advance(w);
    expect(b.sync(w.shared).kind).toBe('merged');
    expect(configOf(entryRow(b.db, web))).toEqual({ keepalive: 30 });
    expect(entryRow(b.db, web)?.tags).toBe('["prod"]');
    expect(values(b.state, web, 'config.keepalive')).toEqual(['30']);
    exchange(w, b, a);
    expect(configOf(entryRow(a.db, web))).toEqual({ keepalive: 30 });
    expect(entryRow(a.db, web)?.tags).toBe('["prod"]');
    expect(a.fullPass()).toBe(false);
  });

  it('a device that cannot recover them keeps them unknown, and the owner keeps the values', () => {
    w = setupWorld();
    const { a } = w;
    const c = addDevice(w, 'ipad');
    let id = '';
    a.edit((v) => {
      id = v.createEntry({ name: 'fresh rdp', entry_type: 'rdp', host: 'r.local', config: { resolution: '1080p' }, tags: ['lab'] }).id;
    });
    a.publish(w.shared);
    advance(w);
    rawShared(w, `UPDATE entries SET config = '[]', tags = '{"a":1}', updated_at = ? WHERE id = ?`, new Date(w.now).toISOString(), id);
    advance(w);
    expect(c.sync(w.shared).kind).toBe('merged');
    expect(getRegister(c.state, ek(id, 'config.resolution'))?.sibs.map((s) => s.flags)).toEqual([SIB_VALUE_UNKNOWN]);
    c.publish(w.shared);
    advance(w);
    a.sync(w.shared);
    expect(configOf(entryRow(a.db, id))).toEqual({ resolution: '1080p' });
    expect(entryRow(a.db, id)?.tags).toBe('["lab"]');
    exchange(w, a, c);
    expect(configOf(entryRow(c.db, id))).toEqual({ resolution: '1080p' });
    expect(getRegister(c.state, ek(id, 'config.resolution'))?.sibs.map((s) => s.flags)).toEqual([0]);
  });
});

describe('finding 3: a legacy delete absorbed by a device that never saw the row', () => {
  function deletedByOlderApp(world: World, editOnA: boolean): string {
    const { a, b } = world;
    converge(world);
    advance(world);
    let id = '';
    a.edit((v) => {
      id = v.createEntry({ name: 'fresh', entry_type: 'ssh', host: 'fresh.host', username: 'me', password: 'pw' }).id;
    });
    a.publish(world.shared);
    advance(world);
    olderApp(world, (v) => v.deleteEntry(id));
    advance(world, 1_000);
    b.sync(world.shared);
    expect(getRegister(b.state, ek(id, 'name'))?.sibs.map((s) => [s.value, s.flags])).toEqual([[null, SIB_VALUE_UNKNOWN]]);
    b.publish(world.shared);
    advance(world);
    if (editOnA) a.edit((v) => v.updateEntry(id, { notes: 'edited on A meanwhile' }));
    advance(world, 1_000);
    a.sync(world.shared);
    return id;
  }

  it('keeps the real values on the device that has them, and restore brings them back', () => {
    w = setupWorld();
    const id = deletedByOlderApp(w, false);
    const { a } = w;
    expect(rowLife(a.state, rowKey(E, id))).toBe('dead');
    expect(values(a.state, id, 'name')).toEqual(['fresh']);
    expect(values(a.state, id, 'host')).toEqual(['fresh.host']);
    advance(w);
    a.write(restoreWrites(a.state, [rowKey(E, id)], a.ctx));
    expect(entryRow(a.db, id)).toMatchObject({ name: 'fresh', entry_type: 'ssh', host: 'fresh.host', username: 'me' });
    expect(a.vault.getEntry(id)?.password).toBe('pw');
  });

  it('edit versus delete keeps the item visible with every field (4.7)', () => {
    w = setupWorld();
    const id = deletedByOlderApp(w, true);
    expect(entryRow(w.a.db, id)).toMatchObject({ name: 'fresh', host: 'fresh.host', username: 'me', notes: 'edited on A meanwhile' });
    exchange(w, w.a, w.b);
    expect(entryRow(w.b.db, id)).toMatchObject({ name: 'fresh', host: 'fresh.host', username: 'me' });
  });
});

describe('finding 6: an unrecoverable w kept by the stale-revert rule', () => {
  function staleRevertOnS(world: World): void {
    const { a } = world;
    converge(world);
    advance(world);
    a.edit((v) => v.updateEntry(world.fixture.ids.web, { host: 'a-new' }));
    a.publish(world.shared);
    advance(world);
    olderApp(world, (v) => v.updateEntry(world.fixture.ids.web, { host: '10.0.0.1' }));
    advance(world, 1_000);
  }

  const hostValues = (state: SyncState, web: string) => values(state, web, 'host').sort();

  it('ends in the same stale-revert conflict whichever device absorbs S first', () => {
    w = setupWorld();
    const { a, b } = w;
    const { web } = w.fixture.ids;
    staleRevertOnS(w);
    b.sync(w.shared);
    expect(getRegister(b.state, ek(web, 'host'))?.sibs.map((s) => [s.value, s.flags])).toEqual([
      ['10.0.0.1', 0],
      [null, SIB_VALUE_UNKNOWN],
    ]);
    b.publish(w.shared);
    advance(w, 1_000);
    a.sync(w.shared);
    expect(hostValues(a.state, web)).toEqual(['10.0.0.1', 'a-new']);
    exchange(w, a, b);
    expect(hostValues(b.state, web)).toEqual(['10.0.0.1', 'a-new']);
  });
});
