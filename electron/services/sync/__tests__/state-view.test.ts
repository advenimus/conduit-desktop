// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { IMPLICIT_PMEM, epochRegKey, implicitSiblingOf, regKey, rowKey } from '../catalog.js';
import {
  StateBuilder,
  containerChain,
  currentEpochId,
  emptyState,
  isImplicitEquivalent,
  recoveryFrom,
  getRegister,
  headOf,
  makeRegister,
  parseRowKeyStr,
  pmemOf,
  provisional,
  provisionalValue,
  registerPresence,
  rowKeyStr,
  rowLife,
  sibsOf,
} from '../state-view.js';
import { SIB_REDACTED, SIB_UNDECRYPTABLE, TBL, type ImplicitProvider, type Sibling } from '../types.js';

const V = 'ab'.repeat(16);
const implicit: ImplicitProvider = (key) => implicitSiblingOf(key, V);

function app(dev: number, ms: number, value: Sibling['value'], flags = 0): Sibling {
  return { dev, ms, c: 0, pid: '', lt: 0, vhash: V, flags, value, prevVhash: null };
}

describe('register presence (3.4)', () => {
  const host = regKey(TBL.entries, 'e1', 'host');
  const base = emptyState('L', 'G', 0);

  it('distinguishes empty, implicit and explicit registers', () => {
    expect(registerPresence(base, host)).toBe('empty');
    expect(sibsOf(base, host, implicit)).toEqual([]);
    expect(pmemOf(base, host)).toBeNull();

    const b = new StateBuilder(base);
    b.ensureRow(rowKey(TBL.entries, 'e1'));
    const known = b.build();
    expect(registerPresence(known, host)).toBe('implicit');
    expect(sibsOf(known, host, implicit)).toEqual([implicitSiblingOf(host, V)]);
    expect(pmemOf(known, host)).toBe(IMPLICIT_PMEM);
    expect(provisionalValue(known, host, null)).toBeNull();
    expect(rowLife(known, rowKey(TBL.entries, 'e1'))).toBe('live');

    const b2 = new StateBuilder(known);
    b2.setRegister(makeRegister(host, [app(1, 5, 'h')], IMPLICIT_PMEM));
    const explicit = b2.build();
    expect(registerPresence(explicit, host)).toBe('explicit');
    expect(provisionalValue(explicit, host, null)).toBe('h');
    expect(getRegister(explicit, host)?.sibs).toHaveLength(1);
  });

  it('round-trips row key strings', () => {
    const k = rowKey(TBL.history, 'a:b:c');
    expect(parseRowKeyStr(rowKeyStr(k))).toEqual(k);
  });
});

describe('provisional choice (4.5)', () => {
  it('keeps _life live while any sibling is live', () => {
    const sibs = [app(1, 9, 'dead'), app(2, 3, 'live')];
    expect(provisional('_life', sibs)?.value).toBe('live');
    expect(provisional('_life', [app(1, 9, 'dead')])?.value).toBe('dead');
  });

  it('skips undecryptable and redacted siblings', () => {
    const sibs = [app(1, 9, 'x', SIB_UNDECRYPTABLE), app(2, 8, null, SIB_REDACTED), app(3, 1, 'ok')];
    expect(provisional('password', sibs)?.value).toBe('ok');
    expect(provisional('password', sibs.slice(0, 2))).toBeNull();
    expect(headOf('password', sibs.slice(0, 2))?.dev).toBe(1);
  });

  it('reports dead rows', () => {
    const b = new StateBuilder(emptyState('L', 'G', 0));
    b.setRegister(makeRegister(regKey(TBL.folders, 'f', '_life'), [app(1, 1, 'dead')], null));
    expect(rowLife(b.build(), rowKey(TBL.folders, 'f'))).toBe('dead');
    expect(rowLife(b.build(), rowKey(TBL.folders, 'g'))).toBe('unknown');
  });
});

describe('StateBuilder', () => {
  function seeded() {
    const b = new StateBuilder(emptyState('L', 'G', 0));
    b.setRegister(makeRegister(regKey(TBL.entries, 'a', 'name'), [app(1, 1, 'A')], null));
    b.setRegister(makeRegister(regKey(TBL.entries, 'b', 'name'), [app(1, 2, 'B')], null));
    b.joinVv(1, { ms: 2, c: 0 });
    return b.build();
  }

  it('returns the base state when nothing changed', () => {
    const s = seeded();
    const b = new StateBuilder(s);
    b.joinVv(1, { ms: 1, c: 0 });
    b.ensureRow(rowKey(TBL.entries, 'a'));
    b.setRegister(getRegister(s, regKey(TBL.entries, 'a', 'name'))!);
    expect(b.build()).toBe(s);
  });

  it('keeps untouched rows and registers by reference', () => {
    const s = seeded();
    const b = new StateBuilder(s);
    b.setRegister(makeRegister(regKey(TBL.entries, 'a', 'host'), [app(1, 3, 'h')], null));
    b.joinVv(1, { ms: 3, c: 0 });
    const next = b.build();
    expect(next).not.toBe(s);
    expect(next.rows.get('1:b')).toBe(s.rows.get('1:b'));
    expect(next.rows.get('1:a')).not.toBe(s.rows.get('1:a'));
    expect(next.rows.get('1:a')!.regs.get('name')).toBe(s.rows.get('1:a')!.regs.get('name'));
    expect(s.rows.get('1:a')!.regs.has('host')).toBe(false);
    expect(next.vv.get(1)).toEqual({ ms: 3, c: 0 });
    expect(s.vv.get(1)).toEqual({ ms: 2, c: 0 });
  });

  it('sees pending writes and removes registers to implicit', () => {
    const s = seeded();
    const b = new StateBuilder(s);
    const key = regKey(TBL.entries, 'a', 'name');
    b.removeRegister(key);
    expect(b.register(key)).toBeUndefined();
    expect(b.hasRow(rowKey(TBL.entries, 'a'))).toBe(true);
    b.ensureRow(rowKey(TBL.folders, 'new'));
    expect(b.row(rowKey(TBL.folders, 'new'))?.regs.size).toBe(0);
    const next = b.build();
    expect(registerPresence(next, key)).toBe('implicit');
    expect(next.rows.has('2:new')).toBe(true);
  });

  it('records graves, devices, epochs and wraps without touching the base', () => {
    const s = seeded();
    const b = new StateBuilder(s);
    b.setGrave(rowKey(TBL.entries, 'a'), { diedMs: 5, diedC: 0, diedDev: 1, redacted: false });
    b.addDev({ dev: 1, deviceUuid: 'd', startedMs: 0 });
    b.setEpoch({ epochId: 'e', parent: null, salt: 's', verification: 'v', createdMs: 0 });
    b.addWrap({ epochId: 'e2', targetEpoch: 'e', wrap: 'ff' });
    b.addWrap({ epochId: 'e2', targetEpoch: 'e', wrap: 'ff' });
    const next = b.build();
    expect(next.rows.get('1:a')!.grave?.diedMs).toBe(5);
    expect(s.rows.get('1:a')!.grave).toBeNull();
    expect(next.devs.size).toBe(1);
    expect(next.epochs.size).toBe(1);
    expect(next.wraps.size).toBe(1);
    expect(s.devs.size + s.epochs.size + s.wraps.size).toBe(0);
  });
});

describe('findSibling and recoveryFrom', () => {
  it('finds explicit siblings by identity', () => {
    const b = new StateBuilder(emptyState('L', 'G', 0));
    const key = regKey(TBL.entries, 'e', 'host');
    b.setRegister(makeRegister(key, [app(4, 9, 'old'), app(5, 1, 'other')], null));
    const s = b.build();
    expect(recoveryFrom(s)(key, 'a:4:9:0')).toBe('old');
    expect(recoveryFrom(s)(key, 'a:4:9:1')).toBeUndefined();
    expect(recoveryFrom(s)(regKey(TBL.entries, 'x', 'host'), 'a:4:9:0')).toBeUndefined();
  });
});

describe('currentEpochId, isImplicitEquivalent, containerChain', () => {
  it('reads the epoch register and detects implicit-equivalent registers', () => {
    const b = new StateBuilder(emptyState('L', 'G', 0));
    expect(currentEpochId(b.build())).toBeNull();
    b.setRegister(makeRegister(epochRegKey(), [app(1, 1, 'e1')], null));
    expect(currentEpochId(b.build())).toBe('e1');
    const key = regKey(TBL.entries, 'e', 'host');
    expect(isImplicitEquivalent(makeRegister(key, [implicitSiblingOf(key, V)], IMPLICIT_PMEM))).toBe(true);
    expect(isImplicitEquivalent(makeRegister(key, [implicitSiblingOf(key, V)], null))).toBe(false);
  });

  it('walks live ancestors and stops at dead targets and cycles', () => {
    const b = new StateBuilder(emptyState('L', 'G', 0));
    const set = (tbl: 1 | 2, id: string, container: string) =>
      b.setRegister(makeRegister(regKey(tbl, id, 'container'), [app(1, 1, container)], null));
    set(TBL.entries, 'leaf', 'e:parent');
    set(TBL.entries, 'parent', 'f:F1');
    set(TBL.folders, 'F1', 'f:F2');
    b.ensureRow(rowKey(TBL.folders, 'F2'));
    set(TBL.folders, 'A', 'f:B');
    set(TBL.folders, 'B', 'f:A');
    set(TBL.entries, 'orphan', 'f:DEAD');
    b.setRegister(makeRegister(regKey(TBL.folders, 'DEAD', '_life'), [app(1, 2, 'dead')], null));
    const s = b.build();
    expect(containerChain(s, rowKey(TBL.entries, 'leaf')).map((r) => r.rowId)).toEqual(['parent', 'F1', 'F2']);
    expect(containerChain(s, rowKey(TBL.folders, 'A')).map((r) => r.rowId)).toEqual(['B']);
    expect(containerChain(s, rowKey(TBL.entries, 'orphan'))).toEqual([]);
    expect(containerChain(s, rowKey(TBL.history, 'h'))).toEqual([]);
  });
});
