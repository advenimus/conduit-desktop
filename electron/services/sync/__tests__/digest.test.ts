// @vitest-environment node
import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { IMPLICIT_PMEM, regKey, rowKey } from '../catalog.js';
import { canonicalDump, covers, coversIgnoringPresence, digestState } from '../digest.js';
import { jcs } from '../jcs.js';
import { compareIdentity, identityKey, makePmem } from '../sibling.js';
import { StateBuilder, emptyState, isImplicitEquivalent, makeRegister, wrapKeyStr } from '../state-view.js';
import {
  SIB_REDACTED,
  TBL,
  ZERO_PID,
  ZERO_VHASH,
  type EpochRecord,
  type Grave,
  type Pmem,
  type Sibling,
  type SyncState,
  type Tbl,
} from '../types.js';

const hex = (n: number): string => n.toString(16).padStart(32, '0');

function app(dev: number, ms: number, c: number, extra: Partial<Sibling> = {}): Sibling {
  return { dev, ms, c, pid: '', lt: 0, vhash: hex(dev * 1000 + ms + c), flags: 0, value: `v${ms}`, prevVhash: null, ...extra };
}

function pseudo(ms: number, pidN: number, extra: Partial<Sibling> = {}): Sibling {
  return { dev: 0, ms, c: 0, pid: hex(pidN), lt: ms, vhash: hex(900 + pidN), flags: 0, value: `p${pidN}`, prevVhash: null, ...extra };
}

const IMPLICIT_SIB: Sibling = { dev: 0, ms: 0, c: 0, pid: ZERO_PID, lt: 0, vhash: hex(1), flags: 0, value: null, prevVhash: null };

interface RegSpec {
  readonly tbl?: Tbl;
  readonly row: string;
  readonly reg: string;
  readonly sibs: readonly Sibling[];
  readonly pmem: Pmem | null;
}

interface StateSpec {
  readonly regs?: readonly RegSpec[];
  readonly rows?: ReadonlyArray<readonly [Tbl, string]>;
  readonly graves?: ReadonlyArray<readonly [string, Grave]>;
  readonly vv?: ReadonlyArray<readonly [number, number, number]>;
  readonly devs?: readonly number[];
  readonly epochs?: readonly EpochRecord[];
  readonly wraps?: ReadonlyArray<readonly [string, string, string]>;
  readonly header?: readonly [string, string, number];
}

function build(spec: StateSpec): SyncState {
  const [lineage, genesis, created] = spec.header ?? ['lin', 'gen', 0];
  const b = new StateBuilder(emptyState(lineage, genesis, created));
  for (const [tbl, id] of spec.rows ?? []) b.ensureRow(rowKey(tbl, id));
  for (const r of spec.regs ?? []) b.setRegister(makeRegister(regKey(r.tbl ?? TBL.entries, r.row, r.reg), r.sibs, r.pmem));
  for (const [id, g] of spec.graves ?? []) b.setGrave(rowKey(TBL.entries, id), g);
  for (const [dev, ms, c] of spec.vv ?? []) b.joinVv(dev, { ms, c });
  for (const dev of spec.devs ?? []) b.addDev({ dev, deviceUuid: `uuid-${dev}`, startedMs: dev });
  for (const e of spec.epochs ?? []) b.setEpoch(e);
  for (const [epochId, targetEpoch, wrap] of spec.wraps ?? []) b.addWrap({ epochId, targetEpoch, wrap });
  return b.build();
}

const epoch = (id: string, extra: Partial<EpochRecord> = {}): EpochRecord => ({
  epochId: id, parent: null, salt: 's', verification: 'v', createdMs: 0, ...extra,
});

const BASE: StateSpec = {
  regs: [
    { row: 'e1', reg: 'name', sibs: [app(1, 10, 0), pseudo(5, 7)], pmem: makePmem(5, [hex(7)]) },
    { row: 'e1', reg: '_life', sibs: [app(1, 10, 0, { value: 'live' })], pmem: IMPLICIT_PMEM },
    { tbl: TBL.folders, row: 'f1', reg: 'name', sibs: [pseudo(0, 3)], pmem: makePmem(0, [hex(3)]) },
    { tbl: TBL.sync, row: 'key', reg: 'epoch', sibs: [app(2, 4, 1)], pmem: null },
  ],
  rows: [[TBL.entries, 'e2']],
  graves: [['e2', { diedMs: 9, diedC: 1, diedDev: 2, redacted: false }]],
  vv: [[1, 10, 0], [2, 4, 1]],
  devs: [1, 2],
  epochs: [epoch('ep1'), epoch('ep2', { parent: 'ep1', createdMs: 5 })],
  wraps: [['ep2', 'ep1', 'aabb']],
};

function referenceDump(s: SyncState): string {
  const byKey = <T>(a: readonly [string, T], b: readonly [string, T]): number => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return jcs({
    h: [s.lineageId, s.genesisId, s.createdMs],
    vv: [...s.vv].sort((a, b) => a[0] - b[0]).map(([d, h]) => [d, h.ms, h.c]),
    devs: [...s.devs.values()].sort((a, b) => a.dev - b.dev).map((d) => [d.dev, d.deviceUuid, d.startedMs]),
    rows: [...s.rows].sort(byKey).map(([k, r]) => [
      k,
      r.grave ? [r.grave.diedMs, r.grave.diedC, r.grave.diedDev, r.grave.redacted ? 1 : 0] : null,
      [...r.regs]
        .sort(byKey)
        .filter(([, reg]) => !isImplicitEquivalent(reg))
        .map(([name, reg]) => [
          name,
          reg.pmem ? [reg.pmem.ms, [...reg.pmem.ids]] : null,
          [...reg.sibs].sort(compareIdentity).map((x) => [identityKey(x), x.lt, x.vhash, x.flags]),
        ]),
    ]),
    epochs: [...s.epochs.values()].sort((a, b) => (a.epochId < b.epochId ? -1 : 1)).map((e) => [e.epochId, e.parent, e.salt, e.verification, e.createdMs]),
    wraps: [...s.wraps.values()].map(wrapKeyStr).sort(),
  });
}

describe('canonicalDump and digestState', () => {
  it('is exactly the JCS text of the contract structure', () => {
    const s = build(BASE);
    expect(canonicalDump(s)).toBe(referenceDump(s));
    expect(digestState(s)).toBe(crypto.createHash('sha256').update(canonicalDump(s)).digest('hex'));
    expect(canonicalDump(emptyState('a', 'b', 3))).toBe('{"devs":[],"epochs":[],"h":["a","b",3],"rows":[],"vv":[],"wraps":[]}');
  });

  it('does not depend on insertion order', () => {
    const reversed: StateSpec = {
      ...BASE,
      regs: [...(BASE.regs ?? [])].reverse().map((r) => ({ ...r, sibs: [...r.sibs].reverse() })),
      vv: [...(BASE.vv ?? [])].reverse(),
      devs: [...(BASE.devs ?? [])].reverse(),
      epochs: [...(BASE.epochs ?? [])].reverse(),
    };
    expect(digestState(build(reversed))).toBe(digestState(build(BASE)));
  });

  it('excludes values, prevVhash and mat', () => {
    const s = build(BASE);
    const b = new StateBuilder(s);
    const reg = makeRegister(regKey(TBL.entries, 'e1', 'name'), [app(1, 10, 0, { value: 'other', prevVhash: 'ab'.repeat(8) }), pseudo(5, 7, { value: null })], makePmem(5, [hex(7)]));
    b.setRegister({ ...reg, mat: { value: 'materialized' } });
    expect(digestState(b.build())).toBe(digestState(s));
  });

  it('treats an implicit-equivalent explicit register like an implicit one', () => {
    const withImplicitForm = build({ ...BASE, regs: [...(BASE.regs ?? []), { row: 'e2', reg: 'host', sibs: [IMPLICIT_SIB], pmem: IMPLICIT_PMEM }] });
    expect(digestState(withImplicitForm)).toBe(digestState(build(BASE)));
  });

  const variants: ReadonlyArray<readonly [string, StateSpec]> = [
    ['vhash', { ...BASE, regs: [{ row: 'e1', reg: 'name', sibs: [app(1, 10, 0, { vhash: hex(5) }), pseudo(5, 7)], pmem: makePmem(5, [hex(7)]) }, ...(BASE.regs ?? []).slice(1)] }],
    ['flags', { ...BASE, regs: [{ row: 'e1', reg: 'name', sibs: [app(1, 10, 0, { flags: SIB_REDACTED }), pseudo(5, 7)], pmem: makePmem(5, [hex(7)]) }, ...(BASE.regs ?? []).slice(1)] }],
    ['lt', { ...BASE, regs: [{ row: 'e1', reg: 'name', sibs: [app(1, 10, 0), pseudo(5, 7, { lt: 1 })], pmem: makePmem(5, [hex(7)]) }, ...(BASE.regs ?? []).slice(1)] }],
    ['pmem', { ...BASE, regs: [{ row: 'e1', reg: 'name', sibs: [app(1, 10, 0), pseudo(5, 7)], pmem: makePmem(6, [hex(7)]) }, ...(BASE.regs ?? []).slice(1)] }],
    ['grave', { ...BASE, graves: [['e2', { diedMs: 9, diedC: 1, diedDev: 2, redacted: true }]] }],
    ['known row', { ...BASE, rows: [[TBL.entries, 'e2'], [TBL.folders, 'f9']] }],
    ['vv', { ...BASE, vv: [[1, 10, 1], [2, 4, 1]] }],
    ['devs', { ...BASE, devs: [1, 2, 3] }],
    ['epochs', { ...BASE, epochs: [epoch('ep1', { salt: null }), epoch('ep2', { parent: 'ep1', createdMs: 5 })] }],
    ['wraps', { ...BASE, wraps: [['ep2', 'ep1', 'aabc']] }],
    ['header', { ...BASE, header: ['lin', 'gen', 1] }],
  ];

  it.each(variants)('changes when %s changes', (_name, spec) => {
    expect(digestState(build(spec))).not.toBe(digestState(build(BASE)));
  });

  it('dumps 5,000 entries quickly', () => {
    const s = bigState(5000);
    const t0 = performance.now();
    const d = digestState(s);
    const elapsed = performance.now() - t0;
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(elapsed).toBeLessThan(300);
  });
});

function bigState(entries: number): SyncState {
  const b = new StateBuilder(emptyState('lin', 'gen', 0));
  const regs = ['_life', 'name', 'entry_type', 'host', 'port', 'username', 'password', 'container', 'notes', 'created_at'];
  for (let i = 0; i < entries; i++) {
    for (const [j, reg] of regs.entries()) {
      b.setRegister(makeRegister(regKey(TBL.entries, `entry-${i}`, reg), [app(1 + (j % 3), 1000 + i, j)], IMPLICIT_PMEM));
    }
  }
  b.joinVv(1, { ms: 10_000_000, c: 0 });
  b.joinVv(2, { ms: 10_000_000, c: 0 });
  b.joinVv(3, { ms: 10_000_000, c: 0 });
  return b.build();
}

describe('covers (5.7)', () => {
  const p = build(BASE);

  it('holds for the same state and for an equal copy', () => {
    expect(covers(p, p)).toBe(true);
    expect(covers(build(BASE), p)).toBe(true);
  });

  it('holds when S has moved on (newer app dot superseding P, extra rows)', () => {
    const s = build({
      ...BASE,
      regs: [{ row: 'e1', reg: 'name', sibs: [app(3, 20, 0)], pmem: makePmem(5, [hex(7)]) }, ...(BASE.regs ?? []).slice(1)],
      rows: [[TBL.entries, 'e2'], [TBL.entries, 'e3']],
      vv: [[1, 10, 0], [2, 4, 1], [3, 20, 0]],
      devs: [1, 2, 3],
    });
    expect(covers(s, p)).toBe(true);
    expect(covers(p, s)).toBe(false);
  });

  it('fails when S lacks a vv entry, a row, a dev, an epoch or a wrap', () => {
    expect(covers(build({ ...BASE, vv: [[1, 10, 0]] }), p)).toBe(false);
    expect(covers(build({ ...BASE, rows: [], graves: [] }), p)).toBe(false);
    expect(covers(build({ ...BASE, devs: [1] }), p)).toBe(false);
    expect(covers(build({ ...BASE, epochs: [epoch('ep1')] }), p)).toBe(false);
    expect(covers(build({ ...BASE, wraps: [] }), p)).toBe(false);
    expect(covers(build({ ...BASE, header: ['lin', 'other', 0] }), p)).toBe(false);
  });

  it('coversIgnoringPresence: another device\'s presence and owner claim are not news; content, epochs and wraps are', () => {
    const withPresence = build({
      ...BASE,
      regs: [...(BASE.regs ?? []), { tbl: TBL.sync, row: 'device', reg: 'dev-9-uuid', sibs: [app(9, 50, 0)], pmem: null }, { tbl: TBL.sync, row: 'owner', reg: 'owner', sibs: [app(9, 51, 0)], pmem: null }],
      vv: [...(BASE.vv ?? []), [9, 51, 0]],
      devs: [...(BASE.devs ?? []), 9],
    });
    expect(covers(p, withPresence)).toBe(false);
    expect(coversIgnoringPresence(p, withPresence)).toBe(true);
    const withEdit = build({ ...BASE, regs: [{ row: 'e1', reg: 'name', sibs: [app(9, 60, 0)], pmem: null }, ...(BASE.regs ?? []).slice(1)], vv: [...(BASE.vv ?? []), [9, 60, 0]] });
    expect(coversIgnoringPresence(p, withEdit)).toBe(false);
    expect(coversIgnoringPresence(build({ ...BASE, epochs: [epoch('ep1')] }), p)).toBe(false);
    expect(coversIgnoringPresence(build({ ...BASE, wraps: [] }), p)).toBe(false);
    expect(coversIgnoringPresence(build({ ...BASE, rows: [], graves: [] }), p)).toBe(false);
  });

  it('fails when S lost an epoch redaction but not the other way round', () => {
    const redacted = build({ ...BASE, epochs: [epoch('ep1', { salt: null, verification: null }), epoch('ep2', { parent: 'ep1', createdMs: 5 })] });
    expect(covers(p, redacted)).toBe(false);
    expect(covers(redacted, p)).toBe(true);
  });

  it('fails when a pseudo sibling of P is neither present nor covered by S pseudo memory', () => {
    const s = build({ ...BASE, regs: [{ row: 'e1', reg: 'name', sibs: [app(1, 10, 0)], pmem: makePmem(5, [hex(8)]) }, ...(BASE.regs ?? []).slice(1)] });
    expect(covers(s, p)).toBe(false);
    const later = build({ ...BASE, regs: [{ row: 'e1', reg: 'name', sibs: [app(1, 10, 0)], pmem: makePmem(6, [hex(8)]) }, ...(BASE.regs ?? []).slice(1)] });
    expect(covers(later, p)).toBe(true);
  });

  it('checks implicit registers of P against explicit registers of S', () => {
    const pImplicit = build({ rows: [[TBL.entries, 'e1']] });
    const sAsserted = build({ regs: [{ row: 'e1', reg: 'host', sibs: [app(1, 1, 0)], pmem: IMPLICIT_PMEM }], vv: [[1, 1, 0]] });
    const sInserted = build({ regs: [{ row: 'e1', reg: 'host', sibs: [app(1, 1, 0)], pmem: null }], vv: [[1, 1, 0]] });
    expect(covers(sAsserted, pImplicit)).toBe(true);
    expect(covers(sInserted, pImplicit)).toBe(false);
    const pImplicitForm = build({ regs: [{ row: 'e1', reg: 'host', sibs: [IMPLICIT_SIB], pmem: IMPLICIT_PMEM }] });
    expect(covers(pImplicit, pImplicitForm)).toBe(true);
  });

  it('fails when S lost a redaction of a sibling or a grave', () => {
    const redactedSib = app(1, 10, 0, { flags: SIB_REDACTED, vhash: ZERO_VHASH, value: null });
    const pRedacted = build({ ...BASE, regs: [{ row: 'e1', reg: 'name', sibs: [redactedSib, pseudo(5, 7)], pmem: makePmem(5, [hex(7)]) }, ...(BASE.regs ?? []).slice(1)] });
    expect(covers(p, pRedacted)).toBe(false);
    expect(covers(pRedacted, p)).toBe(true);
    const pGrave = build({ ...BASE, graves: [['e2', { diedMs: 9, diedC: 1, diedDev: 2, redacted: true }]] });
    expect(covers(p, pGrave)).toBe(false);
    expect(covers(pGrave, p)).toBe(true);
  });

  it('checks 5,000 entries quickly', () => {
    const s = bigState(5000);
    const copy = bigState(5000);
    const t0 = performance.now();
    expect(covers(s, copy)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(300);
  });

  it('is reflexive and holds between rebuilt copies of random states (property)', () => {
    const sibArb = fc.oneof(
      fc.record({ dev: fc.integer({ min: 1, max: 3 }), ms: fc.integer({ min: 1, max: 5 }), c: fc.integer({ min: 0, max: 2 }) }).map((d) => app(d.dev, d.ms, d.c)),
      fc.record({ ms: fc.integer({ min: 0, max: 5 }), pid: fc.integer({ min: 1, max: 4 }) }).map((d) => pseudo(d.ms, d.pid)),
    );
    const regArb = fc.record({
      row: fc.constantFrom('a', 'b', 'c'),
      reg: fc.constantFrom('name', 'host', 'port'),
      sibs: fc.uniqueArray(sibArb, { minLength: 1, maxLength: 3, selector: identityKey }),
    });
    fc.assert(
      fc.property(fc.array(regArb, { maxLength: 8 }), (regs) => {
        const specRegs = regs.map((r) => ({ ...r, pmem: makePmem(5, r.sibs.filter((x) => x.dev === 0).map((x) => x.pid)) }));
        const spec: StateSpec = { regs: specRegs, vv: [[1, 5, 2], [2, 5, 2], [3, 5, 2]], devs: [1, 2, 3] };
        const a = build(spec);
        const b = build(spec);
        expect(covers(a, b)).toBe(true);
        expect(digestState(a)).toBe(digestState(b));
      }),
    );
  });
});
