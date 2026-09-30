// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { epochRegKey, regKey } from '../catalog.js';
import { buildConfigText } from '../catalog-rows.js';
import {
  CHANGED_BY_CONFLICT,
  discardUndecryptable,
  listConflicts,
  recoverUndecryptable,
  resolveAppearance,
  resolveBulk,
  resolveCycle,
  resolveEditDelete,
  resolveField,
  resolveFolderDelete,
  revealSecret,
  type ConflictContext,
} from '../conflicts.js';
import { vhashOfSecret, vhashUndecryptable } from '../hashing.js';
import { encryptSecret } from '../key-epoch.js';
import { identityKey, isUndecryptable } from '../sibling.js';
import { getRegister, provisionalValue, rowLife } from '../state-view.js';
import { SIB_UNDECRYPTABLE, TBL, type LocalWrite, type Sibling, type SyncState } from '../types.js';
import {
  NOW_MS,
  app,
  applyResolution,
  entryKey,
  fakeDerive,
  folderKey,
  implicitFor,
  keysFor,
  makeCtx,
  pseudo,
  ringOf,
  secretApp,
  seqRandom,
  stateOf,
} from './conflicts-fixtures.js';

const K = keysFor('pw', 'salt-2');
const OLD = keysFor('old', 'salt-1');
const ctx = makeCtx(ringOf(K));
const E1 = { tbl: TBL.entries, rowId: 'e1' } as const;
const cctx: ConflictContext = {
  implicit: implicitFor(ctx),
  structural: [],
  snoozed: new Set(),
  candidateLabels: new Map(),
  repairedKeys: new Set(),
};

function valuesOf(state: SyncState, key: ReturnType<typeof entryKey>): unknown[] {
  return getRegister(state, key)?.sibs.map((s) => s.value) ?? [];
}

function historyRows(state: SyncState): string[] {
  return [...state.rows.values()].filter((r) => r.key.tbl === TBL.history).map((r) => r.key.rowId);
}

describe('resolveField (7.3)', () => {
  const host = entryKey('e1', 'host');
  const hostState = stateOf([{ key: host, sibs: [app(host, 1, 5, 'a'), app(host, 2, 6, 'b')] }]);

  it('[Use this] copies the chosen version, replacing every sibling', () => {
    const writes = resolveField(hostState, host, { kind: 'version', versionId: 'a:1:5:0' }, ctx);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ key: host, value: 'a', mode: 'replace-all' });
    const next = applyResolution(hostState, writes, ctx);
    expect(valuesOf(next, host)).toEqual(['a']);
    expect(listConflicts(next, cctx)).toEqual([]);
  });

  it('[Enter a different value] writes the new value; unknown or unreadable versions throw', () => {
    const next = applyResolution(hostState, resolveField(hostState, host, { kind: 'value', value: 'c' }, ctx), ctx);
    expect(valuesOf(next, host)).toEqual(['c']);
    expect(() => resolveField(hostState, host, { kind: 'version', versionId: 'a:9:9:9' }, ctx)).toThrow(/not found/);
    const bad: Sibling = { ...app(host, 3, 7, 'x'), flags: SIB_UNDECRYPTABLE };
    const s = stateOf([{ key: host, sibs: [app(host, 1, 5, 'a'), bad] }]);
    expect(() => resolveField(s, host, { kind: 'version', versionId: identityKey(bad) }, ctx)).toThrow(/undecryptable/);
    expect(() => resolveField(hostState, host, { kind: 'keep-both', copyNames: new Map() }, ctx)).toThrow(/Keep both/);
  });

  it('a setting only takes valid JSON, so the entry config column stays readable', () => {
    const content = entryKey('e1', 'config.content');
    const s = stateOf([{ key: content, sibs: [app(content, 1, 5, '"alpha runbook"'), app(content, 2, 6, '"beta runbook"')] }]);
    expect(() => resolveField(s, content, { kind: 'value', value: 'hello world' }, ctx)).toThrow(/not valid JSON/);
    const next = applyResolution(s, resolveField(s, content, { kind: 'value', value: JSON.stringify('hello world') }, ctx), ctx);
    expect(valuesOf(next, content)).toEqual(['"hello world"']);
    expect(buildConfigText(new Map([['config.content', '"hello world"']]))).toBe('{"content":"hello world"}');
  });

  it('copies each losing distinct password to password_history', () => {
    const pw = entryKey('e1', 'password');
    const user = entryKey('e1', 'username');
    const s = stateOf([
      { key: user, sibs: [app(user, 1, 1, 'root')] },
      {
        key: pw,
        sibs: [secretApp(pw, 1, 5, 'p1', K), secretApp(pw, 2, 6, 'p2', K), secretApp(pw, 3, 7, 'p2', K), secretApp(pw, 4, 8, 'p3', K)],
      },
    ]);
    const writes = resolveField(s, pw, { kind: 'version', versionId: 'a:4:8:0' }, ctx);
    const next = applyResolution(s, writes, ctx);
    const rows = historyRows(next);
    expect(rows).toHaveLength(2);
    const saved = rows.map((id) => {
      const k = (reg: string) => regKey(TBL.history, id, reg);
      expect(provisionalValue(next, k('entry_id'), null)).toBe('e1');
      expect(provisionalValue(next, k('username'), null)).toBe('root');
      expect(provisionalValue(next, k('changed_by'), null)).toBe(CHANGED_BY_CONFLICT);
      expect(provisionalValue(next, k('changed_at'), null)).toBe(new Date(NOW_MS).toISOString());
      expect(rowLife(next, { tbl: TBL.history, rowId: id })).toBe('live');
      const sib = getRegister(next, k('password'))?.sibs[0];
      expect(sib?.vhash).toBe(vhashOfSecret(k('password'), revealSecret(sib as Sibling, ctx.keys), K.kSync));
      return revealSecret(sib as Sibling, ctx.keys);
    });
    expect(saved.sort()).toEqual(['p1', 'p2']);
    expect(getRegister(next, pw)?.sibs).toHaveLength(1);
  });

  it('a new secret value is encrypted under the current key', () => {
    const pw = entryKey('e1', 'password');
    const s = stateOf([{ key: pw, sibs: [secretApp(pw, 1, 5, 'p1', K), secretApp(pw, 2, 6, 'p2', K)] }]);
    const writes = resolveField(s, pw, { kind: 'value', value: null, plaintext: 'fresh' }, ctx);
    expect(writes[0].vhash).toBe(vhashOfSecret(pw, 'fresh', K.kSync));
    expect(writes.filter((w) => w.key.tbl === TBL.history && w.key.reg === 'password')).toHaveLength(2);
  });

  it('[Keep both] keeps the provisional notes and copies the entry for the other version', () => {
    const notes = entryKey('e1', 'notes');
    const hostK = entryKey('e1', 'host');
    const name = entryKey('e1', 'name');
    const pw = entryKey('e1', 'password');
    const s = stateOf([
      { key: name, sibs: [app(name, 1, 1, 'Doc')] },
      { key: hostK, sibs: [app(hostK, 1, 1, 'h')] },
      { key: pw, sibs: [secretApp(pw, 1, 1, 'secret', K)] },
      { key: notes, sibs: [app(notes, 1, 5, 'mine'), app(notes, 2, 6, 'theirs')] },
    ]);
    const writes = resolveField(s, notes, { kind: 'keep-both', copyNames: new Map([['a:1:5:0', 'Doc (from iPhone)']]) }, ctx);
    const next = applyResolution(s, writes, ctx);
    expect(valuesOf(next, notes)).toEqual(['theirs']);
    const copies = [...next.rows.values()].filter((r) => r.key.tbl === TBL.entries && r.key.rowId !== 'e1');
    expect(copies).toHaveLength(1);
    const id = copies[0].key.rowId;
    expect(provisionalValue(next, entryKey(id, 'name'), '')).toBe('Doc (from iPhone)');
    expect(provisionalValue(next, entryKey(id, 'notes'), null)).toBe('mine');
    expect(provisionalValue(next, entryKey(id, 'host'), null)).toBe('h');
    const copiedPw = getRegister(next, entryKey(id, 'password'))?.sibs[0] as Sibling;
    expect(revealSecret(copiedPw, ctx.keys)).toBe('secret');
    expect(copiedPw.vhash).toBe(vhashOfSecret(entryKey(id, 'password'), 'secret', K.kSync));
  });
});

describe('group A, edit-delete, folders and cycles (7.3)', () => {
  it('appearance: keep newest, or a chosen version per register', () => {
    const icon = entryKey('e1', 'icon');
    const tag = entryKey('e1', 'tag:x');
    const s = stateOf([
      { key: icon, sibs: [app(icon, 1, 5, 'star'), app(icon, 2, 6, 'moon')] },
      { key: tag, sibs: [app(tag, 1, 7, 1), app(tag, 2, 3, null)] },
    ]);
    const newest = applyResolution(s, resolveAppearance(s, E1, 'keep-newest', ctx), ctx);
    expect(valuesOf(newest, icon)).toEqual(['moon']);
    expect(valuesOf(newest, tag)).toEqual([1]);
    const picked = resolveAppearance(s, E1, new Map([['icon', 'a:1:5:0']]), ctx);
    expect(picked.map((w) => [w.key.reg, w.value])).toEqual([['icon', 'star']]);
  });

  it('edit versus delete writes live or dead', () => {
    const life = entryKey('e1', '_life');
    const s = stateOf([{ key: life, sibs: [app(life, 1, 5, 'live'), app(life, 2, 6, 'dead')] }]);
    expect(rowLife(applyResolution(s, resolveEditDelete(s, E1, 'delete', ctx), ctx), E1)).toBe('dead');
    const kept = applyResolution(s, resolveEditDelete(s, E1, 'keep', ctx), ctx);
    expect(valuesOf(kept, life)).toEqual(['live']);
  });

  function folderState(): SyncState {
    const fLife = folderKey('f1', '_life');
    const deletedChild = entryKey('e2', '_life');
    const otherDead = entryKey('e3', '_life');
    const liveChild = entryKey('e4', 'container');
    const deletedIn = entryKey('e2', 'container');
    return stateOf([
      { key: fLife, sibs: [app(fLife, 1, 5, 'live'), app(fLife, 2, 6, 'dead')] },
      { key: deletedChild, sibs: [app(deletedChild, 2, 6, 'dead')] },
      { key: deletedIn, sibs: [app(deletedIn, 1, 1, 'f:f1')] },
      { key: otherDead, sibs: [app(otherDead, 3, 9, 'dead')] },
      { key: liveChild, sibs: [app(liveChild, 1, 5, 'f:f1')] },
    ]);
  }
  const F1 = { tbl: TBL.folders, rowId: 'f1' } as const;
  const rowsOf = (writes: LocalWrite[]) => writes.map((w) => [w.key.rowId, w.value]);

  it('folder delete: keep with changed items, delete all, restore everything', () => {
    const s = folderState();
    expect(rowsOf(resolveFolderDelete(s, F1, 'keep-with-changed', ctx, implicitFor(ctx)))).toEqual([['f1', 'live']]);
    expect(rowsOf(resolveFolderDelete(s, F1, 'delete-all', ctx, implicitFor(ctx)))).toEqual([
      ['f1', 'dead'],
      ['e4', 'dead'],
    ]);
    const restore = resolveFolderDelete(s, F1, 'restore-all', ctx, implicitFor(ctx));
    expect(rowsOf(restore)).toEqual([
      ['f1', 'live'],
      ['e2', 'live'],
    ]);
    const next = applyResolution(s, restore, ctx);
    expect(rowLife(next, { tbl: TBL.entries, rowId: 'e2' })).toBe('live');
    expect(rowLife(next, { tbl: TBL.entries, rowId: 'e3' })).toBe('dead');
  });

  it('cycles: put one under the other (the other goes to the top), or all at the top', () => {
    const cycle = { kind: 'cycle' as const, tbl: TBL.folders as 2, rowIds: ['x', 'y'], movedToRoot: 'y' };
    expect(rowsOf(resolveCycle(cycle, { kind: 'put-under', child: 'x', parent: 'y' }, ctx))).toEqual([
      ['x', 'f:y'],
      ['y', 'r'],
    ]);
    expect(rowsOf(resolveCycle(cycle, { kind: 'all-root' }, ctx))).toEqual([
      ['x', 'r'],
      ['y', 'r'],
    ]);
    const entries = { ...cycle, tbl: TBL.entries as 1 };
    expect(resolveCycle(entries, { kind: 'put-under', child: 'y', parent: 'x' }, ctx)[0].value).toBe('e:x');
    expect(() => resolveCycle(cycle, { kind: 'put-under', child: 'x', parent: 'z' }, ctx)).toThrow();
  });
});

describe('bulk, discard and old-password recovery', () => {
  const host = entryKey('e1', 'host');
  const port = entryKey('e1', 'port');
  const pw = entryKey('e1', 'password');
  const epoch = epochRegKey();
  const ct = encryptSecret('from-old-key', OLD, seqRandom(99));
  const undecryptable: Sibling = {
    dev: 0,
    ms: 4,
    c: 0,
    pid: 'c3'.repeat(16),
    lt: 4,
    vhash: vhashUndecryptable(ct),
    flags: SIB_UNDECRYPTABLE,
    value: ct,
    prevVhash: null,
  };

  function bulkState(): SyncState {
    return stateOf(
      [
        { key: host, sibs: [app(host, 1, 5, 'a'), pseudo(host, 7, 'd4'.repeat(16), 'b')], pmem: { ms: 7, ids: ['d4'.repeat(16)] } },
        { key: port, sibs: [app(port, 1, 5, 22), app(port, 2, 6, 2222)] },
        { key: pw, sibs: [secretApp(pw, 1, 5, 'p1', K), undecryptable], pmem: { ms: 4, ids: [undecryptable.pid] } },
        { key: epoch, sibs: [app(epoch, 1, 5, 'E2a'), app(epoch, 2, 6, 'E2b')] },
      ],
      (b) => {
        b.setEpoch({ epochId: OLD.epochId, parent: null, salt: 'salt-1', verification: null, createdMs: 0 });
        b.setEpoch({ epochId: K.epochId, parent: OLD.epochId, salt: 'salt-2', verification: 'v', createdMs: 1 });
      },
    );
  }

  it('keep newest for all skips undecryptable and epoch registers; older-apps only takes pseudo changes', () => {
    const s = bulkState();
    expect(resolveBulk(s, 'keep-newest-all', cctx, ctx).map((w) => [w.key.reg, w.value])).toEqual([
      ['host', 'b'],
      ['port', 2222],
    ]);
    expect(resolveBulk(s, 'keep-newest-older-apps', cctx, ctx).map((w) => w.key.reg)).toEqual(['host']);
  });

  it('[Discard] keeps the provisional value only', () => {
    const s = bulkState();
    const next = applyResolution(s, discardUndecryptable(s, pw, ctx), ctx);
    expect(getRegister(next, pw)?.sibs).toHaveLength(1);
    expect(revealSecret(getRegister(next, pw)?.sibs[0] as Sibling, ctx.keys)).toBe('p1');
  });

  it('[Enter old password] wraps the old key and makes the version readable', () => {
    const s = bulkState();
    expect(recoverUndecryptable(s, pw, identityKey(undecryptable), fakeDerive('wrong'), ctx)).toBeNull();
    const r = recoverUndecryptable(s, pw, identityKey(undecryptable), fakeDerive('old'), ctx);
    expect(r?.recovered.epochId).toBe(OLD.epochId);
    const state = r?.state as SyncState;
    expect([...state.wraps.values()].map((w) => [w.epochId, w.targetEpoch])).toEqual([[K.epochId, OLD.epochId]]);
    const sibs = getRegister(state, pw)?.sibs ?? [];
    const recovered = sibs.find((x) => identityKey(x) === identityKey(undecryptable)) as Sibling;
    expect(isUndecryptable(recovered)).toBe(false);
    expect(revealSecret(recovered, ctx.keys)).toBe('from-old-key');
    expect(recovered.vhash).toBe(vhashOfSecret(pw, 'from-old-key', K.kSync));
    expect(() => recoverUndecryptable(s, pw, 'a:1:5:0', fakeDerive('old'), ctx)).toThrow(/not an undecryptable/);
  });
});
