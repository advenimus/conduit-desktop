// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { IMPLICIT_PMEM, fixedDef, implicitSiblingOf, metaRegKey, regKey, rowKey } from '../catalog.js';
import {
  checkInvariants,
  checkMergePreconditions,
  covered,
  isConflict,
  merge,
  mergeGrave,
  mergeRegister,
  type RegisterSide,
} from '../merge.js';
import { makePmem, identityKey } from '../sibling.js';
import { StateBuilder, emptyState, getRegister, makeRegister, registerPresence, rowKeyStr } from '../state-view.js';
import {
  SIB_REDACTED,
  SIB_UNDECRYPTABLE,
  SyncCoreError,
  TBL,
  ZERO_PID,
  ZERO_VHASH,
  type Hlc,
  type Pmem,
  type RegKey,
  type Sibling,
  type SyncState,
} from '../types.js';
import { appSib, cloneState, dumpState, fakeImplicit, pidOfText, pseudoSib, vh } from './merge-fixtures.js';

const HOST = regKey(TBL.entries, 'e1', 'host');
const LIFE = regKey(TBL.entries, 'e1', '_life');
const E1 = rowKey(TBL.entries, 'e1');

function vvOf(...entries: [number, number, number][]): Map<number, Hlc> {
  return new Map(entries.map(([dev, ms, c]) => [dev, { ms, c }]));
}

function side(sibs: Sibling[], pmem: RegisterSide['pmem'], vv = vvOf()): RegisterSide {
  return { sibs: [...sibs].sort((x, y) => (identityKey(x) < identityKey(y) ? -1 : 1)), pmem, vv };
}

function ids(sibs: readonly Sibling[]): string[] {
  return sibs.map(identityKey).sort();
}

const hostApp = (dev: number, ms: number, value: string): Sibling => appSib(dev, ms, 0, value, vh(HOST, value));
const hostPseudo = (ms: number, value: string, base = 'none'): Sibling =>
  pseudoSib(ms, pidOfText(`${value}|${base}`), value, vh(HOST, value));

describe('covered (4.5)', () => {
  it('uses vv for app siblings and pmem for pseudo siblings, including implicit and unknown rows', () => {
    const b = new StateBuilder(emptyState('L', 'G', 0));
    b.ensureRow(E1);
    b.joinVv(1, { ms: 10, c: 2 });
    const x = b.build();
    expect(covered(x, HOST, appSib(1, 10, 2, 'a', 'v'))).toBe(true);
    expect(covered(x, HOST, appSib(1, 10, 3, 'a', 'v'))).toBe(false);
    expect(covered(x, HOST, appSib(2, 1, 0, 'a', 'v'))).toBe(false);
    expect(covered(x, HOST, fakeImplicit(HOST))).toBe(true);
    expect(covered(x, HOST, hostPseudo(1, 'h'))).toBe(false);
    expect(covered(x, regKey(TBL.entries, 'unknown', 'host'), fakeImplicit(HOST))).toBe(false);
  });
});

describe('mergeRegister: register-sim single-register cases', () => {
  it('keeps two concurrent app writes (a conflict), in either order', () => {
    const a = side([hostApp(1, 5, 'x')], IMPLICIT_PMEM, vvOf([1, 5, 0]));
    const b = side([hostApp(2, 6, 'y')], IMPLICIT_PMEM, vvOf([2, 6, 0]));
    expect(ids(mergeRegister(a, b).sibs)).toEqual(['a:1:5:0', 'a:2:6:0']);
    expect(ids(mergeRegister(b, a).sibs)).toEqual(['a:1:5:0', 'a:2:6:0']);
  });

  it('drops a write the other side has seen and superseded', () => {
    const a = side([hostApp(1, 5, 'x')], IMPLICIT_PMEM, vvOf([1, 5, 0]));
    const b = side([hostApp(2, 6, 'y')], IMPLICIT_PMEM, vvOf([1, 5, 0], [2, 6, 0]));
    const m = mergeRegister(a, b);
    expect(ids(m.sibs)).toEqual(['a:2:6:0']);
    expect(m.violation).toBe(false);
  });

  it('legacy partial replacement keeps the concurrent app sibling and drops the replaced one', () => {
    // Replica A had [x (dev1), y (dev2)] and absorbed a legacy edit p that replaced provisional y.
    const x = hostApp(1, 5, 'x');
    const y = hostApp(2, 6, 'y');
    const p = hostPseudo(9, 'z', identityKey(y));
    const a = side([x, p], makePmem(9, [p.pid]), vvOf([1, 5, 0], [2, 6, 0]));
    const b = side([x, y], IMPLICIT_PMEM, vvOf([1, 5, 0], [2, 6, 0]));
    expect(ids(mergeRegister(a, b).sibs)).toEqual(ids([x, p]));
  });

  it('two genesis versions (ms 0, different pids) are both kept', () => {
    const g1 = hostPseudo(0, 'g1');
    const g2 = hostPseudo(0, 'g2');
    const m = mergeRegister(side([g1], makePmem(0, [g1.pid])), side([g2], makePmem(0, [g2.pid])));
    expect(ids(m.sibs)).toEqual(ids([g1, g2]));
    expect(m.pmem).toEqual(makePmem(0, [g1.pid, g2.pid]));
  });

  it('two legacy apps resolve by the legacy clock (larger pseudo ms wins)', () => {
    const p5 = hostPseudo(5, 'a');
    const p7 = hostPseudo(7, 'b');
    const m = mergeRegister(side([p5], makePmem(5, [p5.pid])), side([p7], makePmem(7, [p7.pid])));
    expect(ids(m.sibs)).toEqual(ids([p7]));
    expect(m.pmem).toEqual(makePmem(7, [p7.pid]));
  });

  it('identical legacy edits on two replicas count as one sibling', () => {
    const p = hostPseudo(4, 'same');
    const m = mergeRegister(side([p], makePmem(4, [p.pid])), side([{ ...p }], makePmem(4, [p.pid])));
    expect(m.sibs).toHaveLength(1);
  });

  it('keeps a pseudo sibling against an app write that did not see it', () => {
    const p = hostPseudo(3, 'legacy');
    const x = hostApp(1, 2, 'app');
    const m = mergeRegister(side([p], makePmem(3, [p.pid])), side([x], IMPLICIT_PMEM, vvOf([1, 2, 0])));
    expect(ids(m.sibs)).toEqual(ids([p, x]));
  });

  it('is commutative, associative and idempotent on a small corpus', () => {
    const x = hostApp(1, 5, 'x');
    const y = hostApp(2, 6, 'y');
    const p = hostPseudo(7, 'p');
    const sides = [
      side([x], IMPLICIT_PMEM, vvOf([1, 5, 0])),
      side([y], IMPLICIT_PMEM, vvOf([1, 5, 0], [2, 6, 0])),
      side([x, p], makePmem(7, [p.pid]), vvOf([1, 5, 0])),
      side([fakeImplicit(HOST)], IMPLICIT_PMEM),
    ];
    const asSide = (m: ReturnType<typeof mergeRegister>, s1: RegisterSide, s2: RegisterSide): RegisterSide => ({
      sibs: m.sibs,
      pmem: m.pmem,
      vv: new Map([...s1.vv, ...s2.vv]),
    });
    for (const a of sides) {
      expect(ids(mergeRegister(a, a).sibs)).toEqual(ids(a.sibs));
      for (const b of sides) {
        expect(ids(mergeRegister(a, b).sibs)).toEqual(ids(mergeRegister(b, a).sibs));
        for (const c of sides) {
          const ab = asSide(mergeRegister(a, b), a, b);
          const bc = asSide(mergeRegister(b, c), b, c);
          expect(ids(mergeRegister(ab, c).sibs)).toEqual(ids(mergeRegister(a, bc).sibs));
        }
      }
    }
  });
});

describe('mergeRegister: identity copies and the guard', () => {
  it('redacted wins, then decryptable over undecryptable, then the smaller value', () => {
    const base = hostApp(1, 5, 'x');
    const redacted = { ...base, value: null, vhash: ZERO_VHASH, flags: SIB_REDACTED };
    const undecryptable = { ...base, vhash: 'f'.repeat(32), flags: SIB_UNDECRYPTABLE };
    const vv = vvOf([1, 5, 0]);
    expect(mergeRegister(side([base], null, vv), side([redacted], null, vv)).sibs[0]).toBe(redacted);
    expect(mergeRegister(side([redacted], null, vv), side([base], null, vv)).sibs[0]).toBe(redacted);
    expect(mergeRegister(side([undecryptable], null, vv), side([base], null, vv)).sibs[0]).toBe(base);
    const c1 = { ...base, value: Uint8Array.from([2]) };
    const c2 = { ...base, value: Uint8Array.from([1]) };
    expect(mergeRegister(side([c1], null, vv), side([c2], null, vv)).sibs[0]).toBe(c2);
    expect(mergeRegister(side([c2], null, vv), side([c1], null, vv)).sibs[0]).toBe(c2);
  });

  it('keeps a ∪ b and reports a violation when every sibling is covered by the other side', () => {
    const x = hostApp(1, 5, 'x');
    const y = hostApp(2, 6, 'y');
    const vv = vvOf([1, 5, 0], [2, 6, 0]);
    const m = mergeRegister(side([x], null, vv), side([y], null, vv));
    expect(m.violation).toBe(true);
    expect(ids(m.sibs)).toEqual(ids([x, y]));
  });

  it('returns the first side array itself when nothing changes', () => {
    const a = side([hostApp(1, 5, 'x')], IMPLICIT_PMEM, vvOf([1, 5, 0]));
    const m = mergeRegister(a, { ...a, sibs: a.sibs.map((s) => ({ ...s })) });
    expect(m.sibs).toBe(a.sibs);
    expect(m.pmem).toBe(a.pmem);
  });

  it('rejects a register holding one identity twice', () => {
    const x = hostApp(1, 5, 'x');
    expect(() => mergeRegister({ sibs: [x, { ...x }], pmem: null, vv: vvOf() }, side([], null))).toThrow(SyncCoreError);
  });
});

// ---------- Whole states ----------

function stateWith(build: (b: StateBuilder) => void, base = emptyState('L', 'G', 0)): SyncState {
  const b = new StateBuilder(base);
  build(b);
  return b.build();
}

function writeApp(b: StateBuilder, key: RegKey, dev: number, ms: number, value: string, pmem: Pmem | null = IMPLICIT_PMEM): void {
  b.ensureRow({ tbl: key.tbl, rowId: key.rowId });
  b.setRegister(makeRegister(key, [appSib(dev, ms, 0, value, vh(key, value))], pmem));
  b.joinVv(dev, { ms, c: 0 });
}

describe('merge (whole states)', () => {
  it('checks lineage and genesis preconditions', () => {
    const a = emptyState('L', 'G', 0);
    expect(() => checkMergePreconditions(a, emptyState('L2', 'G', 0))).toThrow(SyncCoreError);
    expect(() => merge(a, emptyState('L', 'G2', 0), fakeImplicit)).toThrow(/genesis/);
    try {
      merge(a, emptyState('L2', 'G', 0), fakeImplicit);
    } catch (e) {
      expect((e as SyncCoreError).code).toBe('MERGE_PRECONDITION');
    }
  });

  it('merges an explicit write against an implicit register without calling the provider', () => {
    const known = stateWith((b) => b.ensureRow(E1));
    const written = stateWith((b) => writeApp(b, HOST, 1, 5, 'h'), known);
    const provider = vi.fn(fakeImplicit);
    const m = merge(known, written, provider).state;
    expect(getRegister(m, HOST)?.sibs.map((s) => s.value)).toEqual(['h']);
    expect(provider).not.toHaveBeenCalled();
    const back = merge(written, known, provider).state;
    expect(back).toBe(written);
    expect(provider).not.toHaveBeenCalled();
  });

  it('keeps an implicit register implicit when the other side knows nothing newer', () => {
    const a = stateWith((b) => b.ensureRow(E1));
    const b2 = stateWith((b) => {
      b.ensureRow(E1);
      b.joinVv(3, { ms: 1, c: 0 });
    });
    const m = merge(a, b2, fakeImplicit).state;
    expect(registerPresence(m, HOST)).toBe('implicit');
  });

  it('makes a register implicit again when only the implicit sibling survives with implicit memory', () => {
    const implicitCopy = implicitSiblingOf(HOST, vh(HOST, null));
    const explicitImplicit = stateWith((b) => {
      b.ensureRow(E1);
      b.setRegister(makeRegister(HOST, [implicitCopy], IMPLICIT_PMEM));
    });
    const a = stateWith((b) => b.ensureRow(E1));
    expect(registerPresence(merge(a, explicitImplicit, fakeImplicit).state, HOST)).toBe('implicit');
    expect(registerPresence(merge(explicitImplicit, a, fakeImplicit).state, HOST)).toBe('implicit');
  });

  it('keeps a genesis value conflicting with a concurrent implicit default, calling the provider once', () => {
    const g = hostPseudo(0, 'genesis-host');
    const a = stateWith((b) => b.ensureRow(E1));
    const b2 = stateWith((b) => {
      b.ensureRow(E1);
      b.setRegister(makeRegister(HOST, [g], makePmem(0, [g.pid])));
    });
    const provider = vi.fn(fakeImplicit);
    const reg = getRegister(merge(a, b2, provider).state, HOST);
    expect(reg?.sibs.map(identityKey).sort()).toEqual([identityKey(g), `p:0:${ZERO_PID}`].sort());
    expect(reg?.pmem).toEqual(makePmem(0, [g.pid, ZERO_PID]));
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('adopts rows only one side knows, without mat', () => {
    const a = emptyState('L', 'G', 0);
    const b2 = stateWith((b) => {
      writeApp(b, HOST, 1, 5, 'h', null);
      const reg = getRegister(b.snapshot(), HOST);
      if (reg) b.setRegister({ ...reg, mat: { value: 'materialized' } });
    });
    const m = merge(a, b2, fakeImplicit).state;
    expect(getRegister(m, HOST)?.mat).toBeUndefined();
    expect(getRegister(m, HOST)?.sibs[0].value).toBe('h');
    expect(merge(b2, a, fakeImplicit).state).toBe(b2);
  });

  it('drops mat on changed registers and keeps it on unchanged ones', () => {
    const base = stateWith((b) => {
      writeApp(b, HOST, 1, 5, 'h');
      const reg = getRegister(b.snapshot(), HOST);
      if (reg) b.setRegister({ ...reg, mat: { value: 'r' } });
    });
    const newer = stateWith((b) => writeApp(b, HOST, 2, 9, 'n'));
    expect(getRegister(merge(base, cloneState(base), fakeImplicit).state, HOST)?.mat).toEqual({ value: 'r' });
    const m = merge(base, newer, fakeImplicit).state;
    expect(getRegister(m, HOST)?.sibs.map((s) => s.value)).toEqual(['h', 'n']);
    expect(getRegister(m, HOST)?.mat).toBeUndefined();
  });

  it('preserves references: merge(w, w), merge(w, clone), merge(w, older)', () => {
    const older = stateWith((b) => writeApp(b, HOST, 1, 5, 'old'));
    const w = stateWith((b) => {
      writeApp(b, HOST, 1, 7, 'new');
      writeApp(b, regKey(TBL.entries, 'e2', 'name'), 1, 8, 'n');
    }, older);
    expect(merge(w, w, fakeImplicit).state).toBe(w);
    expect(merge(w, cloneState(w), fakeImplicit).state).toBe(w);
    expect(merge(w, older, fakeImplicit).state).toBe(w);
    const m = merge(w, stateWith((b) => writeApp(b, regKey(TBL.entries, 'e3', 'name'), 2, 1, 'z'), cloneState(w)), fakeImplicit);
    expect(m.state).not.toBe(w);
    expect(m.state.rows.get(rowKeyStr(E1))).toBe(w.rows.get(rowKeyStr(E1)));
  });

  it('merges vv, devs, epochs, wraps and header', () => {
    const a = stateWith((b) => {
      b.joinVv(1, { ms: 5, c: 1 });
      b.addDev({ dev: 1, deviceUuid: 'b-uuid', startedMs: 10 });
      b.setEpoch({ epochId: 'E1', parent: null, salt: 's', verification: 'v', createdMs: 50 });
      b.addWrap({ epochId: 'E2', targetEpoch: 'E1', wrap: 'aa' });
      b.setHeader({ lineageId: 'L', genesisId: 'G', createdMs: 7 });
    });
    const b2 = stateWith((b) => {
      b.joinVv(1, { ms: 5, c: 3 });
      b.joinVv(2, { ms: 1, c: 0 });
      b.addDev({ dev: 1, deviceUuid: 'a-uuid', startedMs: 99 });
      b.setEpoch({ epochId: 'E1', parent: 'E0', salt: null, verification: 'v', createdMs: 40 });
      b.addWrap({ epochId: 'E2', targetEpoch: 'E1', wrap: 'bb' });
      b.setHeader({ lineageId: 'L', genesisId: 'G', createdMs: 3 });
    });
    const m = merge(a, b2, fakeImplicit).state;
    expect(dumpState(m)).toBe(dumpState(merge(b2, a, fakeImplicit).state));
    expect(m.vv.get(1)).toEqual({ ms: 5, c: 3 });
    expect(m.vv.get(2)).toEqual({ ms: 1, c: 0 });
    expect(m.devs.get(1)?.deviceUuid).toBe('a-uuid');
    expect(m.epochs.get('E1')).toEqual({ epochId: 'E1', parent: 'E0', salt: null, verification: 'v', createdMs: 40 });
    expect(m.wraps.size).toBe(2);
    expect(m.createdMs).toBe(3);
  });

  it('merges graves: redacted wins, else the larger died dot', () => {
    const g = (ms: number, c: number, dev: number, redacted = false) => ({ diedMs: ms, diedC: c, diedDev: dev, redacted });
    expect(mergeGrave(null, g(1, 0, 1))).toEqual(g(1, 0, 1));
    expect(mergeGrave(g(5, 0, 1), g(5, 1, 1))).toEqual(g(5, 1, 1));
    expect(mergeGrave(g(9, 0, 1), g(1, 0, 2, true))).toEqual(g(1, 0, 2, true));
    expect(mergeGrave(g(1, 0, 2, true), g(9, 0, 1))).toEqual(g(1, 0, 2, true));
    expect(mergeGrave(g(5, 0, 3), g(5, 0, 2))).toEqual(g(5, 0, 3));
  });

  it('reports invariant violations per register', () => {
    const a = stateWith((b) => {
      writeApp(b, HOST, 1, 5, 'x');
      b.joinVv(2, { ms: 6, c: 0 });
    });
    const b2 = stateWith((b) => {
      writeApp(b, HOST, 2, 6, 'y');
      b.joinVv(1, { ms: 5, c: 0 });
    });
    const r = merge(a, b2, fakeImplicit);
    expect(r.report.invariantViolations).toEqual([HOST]);
    expect(getRegister(r.state, HOST)?.sibs).toHaveLength(2);
  });
});

describe('isConflict (4.5)', () => {
  const hostDef = fixedDef(TBL.entries, 'host');
  const lifeDef = fixedDef(TBL.entries, '_life');
  const sortDef = fixedDef(TBL.entries, 'sort_order');

  it('needs two distinct eligible vhashes', () => {
    expect(isConflict(hostDef, 'host', [hostApp(1, 1, 'a'), hostApp(2, 2, 'a')])).toBe(false);
    expect(isConflict(hostDef, 'host', [hostApp(1, 1, 'a'), hostApp(2, 2, 'b')])).toBe(true);
  });

  it('ignores redacted siblings and flags any undecryptable one', () => {
    const red = { ...hostApp(2, 2, 'b'), flags: SIB_REDACTED, vhash: ZERO_VHASH, value: null };
    expect(isConflict(hostDef, 'host', [hostApp(1, 1, 'a'), red])).toBe(false);
    expect(isConflict(hostDef, 'host', [{ ...hostApp(1, 1, 'a'), flags: SIB_UNDECRYPTABLE }])).toBe(true);
  });

  it('flags _life only with both live and dead', () => {
    const live = appSib(1, 1, 0, 'live', vh(LIFE, 'live'));
    const dead = appSib(2, 2, 0, 'dead', vh(LIFE, 'dead'));
    expect(isConflict(lifeDef, '_life', [live, dead])).toBe(true);
    expect(isConflict(lifeDef, '_life', [live, { ...live, dev: 3 }])).toBe(false);
  });

  it('is always false for auto registers', () => {
    const k = regKey(TBL.entries, 'e1', 'sort_order');
    expect(isConflict(sortDef, 'sort_order', [appSib(1, 1, 0, 1, vh(k, 1)), appSib(2, 1, 0, 2, vh(k, 2))])).toBe(false);
    const meta = metaRegKey('vault_id');
    expect(isConflict(fixedDef(TBL.meta, 'vault_id'), meta.reg, [appSib(1, 1, 0, 'a', 'x'), appSib(2, 1, 0, 'b', 'y')])).toBe(false);
  });
});

describe('checkInvariants', () => {
  it('reports I1, I2 and non-canonical registers', () => {
    const p = hostPseudo(3, 'p');
    const s = stateWith((b) => {
      b.ensureRow(E1);
      b.setRegister(makeRegister(HOST, [hostApp(1, 5, 'x')], null));
      b.setRegister(makeRegister(regKey(TBL.entries, 'e1', 'name'), [p], null));
      b.setRegister(makeRegister(regKey(TBL.entries, 'e1', 'notes'), [implicitSiblingOf(HOST, 'v')], IMPLICIT_PMEM));
    });
    const r = checkInvariants(s);
    expect(r.uncoveredApp).toEqual([HOST]);
    expect(r.uncoveredPseudo.map((k) => k.reg)).toEqual(['name']);
    expect(r.nonCanonical.map((k) => k.reg)).toEqual(['notes']);
  });
});
