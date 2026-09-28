// @vitest-environment node
// Merge performance (spec 13.3) and whole-state cases that need larger fixtures: states that
// restrict rows but carry a full vv (synthetic candidates) must not lose unseen siblings.
import { describe, expect, it } from 'vitest';
import { IMPLICIT_PMEM, regKey } from '../catalog.js';
import { merge } from '../merge.js';
import { makePmem } from '../sibling.js';
import { StateBuilder, emptyState, getRegister, makeRegister, rowKeyStr } from '../state-view.js';
import { TBL, type RegKey, type Sibling, type SyncState } from '../types.js';
import { appSib, cloneState, fakeImplicit, pidOfText, pseudoSib, vh } from './merge-fixtures.js';

const ENTRIES = 5000;
const REGS = ['name', 'host', 'port', 'username', 'domain', 'notes', 'icon', 'color', 'entry_type', 'credential_type'];
const BUDGET_MS = 150;
const SLACK = 3;
const CHANGED = 50;
const STRIDE = 97;
const LATER_MS = 1_000_000;

function sibFor(key: RegKey, dev: number, ms: number, value: string): Sibling {
  return appSib(dev, ms, 0, value, vh(key, value));
}

function bigState(): SyncState {
  const b = new StateBuilder(emptyState('L', 'G', 0));
  let ms = 1;
  for (let i = 0; i < ENTRIES; i++) {
    for (const reg of REGS) {
      const key = regKey(TBL.entries, `e${i}`, reg);
      b.ensureRow({ tbl: TBL.entries, rowId: key.rowId });
      b.setRegister(makeRegister(key, [sibFor(key, 1, ms, `${reg}${i}`)], IMPLICIT_PMEM));
      ms++;
    }
  }
  b.joinVv(1, { ms, c: 0 });
  return b.build();
}

function timed<T>(f: () => T): { result: T; ms: number } {
  const t0 = performance.now();
  const result = f();
  return { result, ms: performance.now() - t0 };
}

describe('merge performance (13.3)', () => {
  it('merges two near-identical 5,000-entry states (no shared objects) within budget', () => {
    const w = bigState();
    const b = new StateBuilder(cloneState(w));
    for (let i = 0; i < CHANGED; i++) {
      const key = regKey(TBL.entries, `e${i * STRIDE}`, 'host');
      b.setRegister(makeRegister(key, [sibFor(key, 2, LATER_MS + i, 'changed')], IMPLICIT_PMEM));
      b.joinVv(2, { ms: LATER_MS + i, c: 0 });
    }
    const s = b.build();
    merge(w, s, fakeImplicit);
    const { result, ms } = timed(() => merge(w, s, fakeImplicit));
    expect(result.report.invariantViolations).toHaveLength(0);
    expect(ms).toBeLessThan(BUDGET_MS * SLACK);
    const changedRow = result.state.rows.get(rowKeyStr({ tbl: TBL.entries, rowId: 'e0' }));
    expect(changedRow).not.toBe(w.rows.get(rowKeyStr({ tbl: TBL.entries, rowId: 'e0' })));
    expect(result.state.rows.get(rowKeyStr({ tbl: TBL.entries, rowId: 'e1' }))).toBe(w.rows.get(rowKeyStr({ tbl: TBL.entries, rowId: 'e1' })));
  });

  it('adopts every row of a fresh file into an empty working state within budget', () => {
    const s = bigState();
    const { result, ms } = timed(() => merge(emptyState('L', 'G', 0), s, fakeImplicit));
    expect(result.state.rows.size).toBe(ENTRIES);
    expect(ms).toBeLessThan(BUDGET_MS * SLACK);
  });
});

describe('rows known to one side only', () => {
  it('a state restricted to some rows with a full vv adds its siblings and drops nothing else', () => {
    const host = regKey(TBL.entries, 'e1', 'host');
    const name = regKey(TBL.entries, 'e2', 'name');
    const w = sibFor(host, 1, 5, 'new');
    const p = pseudoSib(9, pidOfText('stale'), 'old', vh(host, 'old'), { lt: 9 });
    const m = new StateBuilder(emptyState('L', 'G', 0));
    m.ensureRow({ tbl: TBL.entries, rowId: 'e1' });
    m.setRegister(makeRegister(host, [w, p], makePmem(9, [p.pid])));
    m.setRegister(makeRegister(name, [sibFor(name, 1, 6, 'n')], IMPLICIT_PMEM));
    m.joinVv(1, { ms: 6, c: 0 });
    const mState = m.build();

    const syn = 777;
    const c = new StateBuilder(emptyState('L', 'G', 0));
    c.setRegister(makeRegister(name, [sibFor(name, 1, 6, 'n'), sibFor(name, syn, 0, 'copy')], IMPLICIT_PMEM));
    c.joinVvAll(mState.vv);
    c.joinVv(syn, { ms: 0, c: 0 });
    const candidate = c.build();

    const r = merge(mState, candidate, fakeImplicit);
    expect(r.report.invariantViolations).toHaveLength(0);
    expect(r.state.rows.get(rowKeyStr({ tbl: TBL.entries, rowId: 'e1' }))).toBe(mState.rows.get(rowKeyStr({ tbl: TBL.entries, rowId: 'e1' })));
    expect(getRegister(r.state, host)?.sibs).toEqual([p, w]);
    expect(getRegister(r.state, name)?.sibs.map((s) => s.value)).toEqual(['n', 'copy']);
  });
});
