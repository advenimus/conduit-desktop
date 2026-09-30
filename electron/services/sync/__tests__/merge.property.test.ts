// @vitest-environment node
// Property tests for merge (spec 4.5, 13.1): commutativity, associativity, idempotence,
// convergence under random gossip and the no-lost-write oracle, over whole states with 2 to 6
// replicas. Two broken variants ("collapse equal values", "reuse dev after restore") must fail.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { rowKey } from '../catalog.js';
import { checkInvariants, merge } from '../merge.js';
import { compareRank, identityKey, isPseudo } from '../sibling.js';
import { StateBuilder, isImplicitEquivalent, makeRegister, rowLife, sibsOf } from '../state-view.js';
import { TBL, type RegKey, type Sibling, type SyncState } from '../types.js';
import { dumpState, fakeImplicit } from './merge-fixtures.js';
import { maximalWrites } from './merge-oracle.js';
import { GENESIS_CELLS, GENESIS_ROWS, applyOp, genesisReplica, type MergeFn, type OpKind, type SimOp, type World } from './merge-sim.js';
import { clonedSnapshot } from './merge-sim-graves.js';

const MIN_REPLICAS = 2;
const MAX_REPLICAS = 6;
const IDX = 63;
const MAX_HINT = 40;
const CORRECT_RUNS = 600;
const DELETE_RUNS = 300;
const REGRESSION_RUNS = 400;
const REGRESSION_SEED = 20261008;

type Weights = readonly (readonly [OpKind, number])[];

const OP_WEIGHTS: Weights = [
  ['app', 5],
  ['insert', 1],
  ['delete', 2],
  ['revive', 1],
  ['legacy', 3],
  ['legacy-delete', 1],
  ['merge', 7],
  ['redact', 1],
  ['reencrypt', 1],
  ['stale-key', 1],
  ['snapshot', 1],
  ['restore', 1],
  ['tick', 3],
];

/** Restores only lose writes when snapshots, gossip and later writes line up: weight them up. */
const RESTORE_WEIGHTS: Weights = [
  ['app', 5],
  ['merge', 6],
  ['snapshot', 3],
  ['restore', 3],
  ['tick', 3],
  ['legacy', 1],
];

/** Concurrent re-assertions followed by non-interactive and legacy deletes and revivals. */
const DELETE_WEIGHTS: Weights = [
  ['app', 5],
  ['delete', 4],
  ['revive', 2],
  ['legacy', 2],
  ['legacy-delete', 3],
  ['merge', 7],
  ['redact', 1],
  ['tick', 2],
];

function opArb(weights: Weights): fc.Arbitrary<SimOp> {
  return fc.record({
    kind: fc.oneof(...weights.map(([kind, weight]) => ({ arbitrary: fc.constant(kind), weight }))),
    r: fc.nat(IDX),
    j: fc.nat(IDX),
    row: fc.nat(IDX),
    reg: fc.nat(IDX),
    value: fc.nat(IDX),
    hint: fc.nat(MAX_HINT),
    flag: fc.boolean(),
  });
}

interface Step {
  readonly op: SimOp;
  readonly law: readonly [number, number, number];
  readonly clone: boolean;
}

interface Scenario {
  readonly replicas: number;
  readonly sameGenesis: boolean;
  readonly genesis: readonly (readonly number[])[];
  readonly steps: readonly Step[];
}

const cellsArb = fc.array(fc.nat(IDX), { minLength: GENESIS_CELLS, maxLength: GENESIS_CELLS });
function scenarioArb(weights: Weights = OP_WEIGHTS): fc.Arbitrary<Scenario> {
  return fc.record({
    replicas: fc.integer({ min: MIN_REPLICAS, max: MAX_REPLICAS }),
    sameGenesis: fc.boolean(),
    genesis: fc.array(cellsArb, { minLength: MAX_REPLICAS, maxLength: MAX_REPLICAS }),
    steps: fc.array(
      fc.record({ op: opArb(weights), law: fc.tuple(fc.nat(IDX), fc.nat(IDX), fc.nat(IDX)), clone: fc.boolean() }),
      { minLength: 8, maxLength: 40 },
    ),
  });
}

interface Variant {
  readonly mergeFn: MergeFn;
  readonly reuseDevOnRestore: boolean;
  /** 'identity' compares sibling identities with maximal writes; 'value' only their values (register-sim). */
  readonly oracle: 'identity' | 'value';
  readonly strict: boolean;
}

function correctMerge(a: SyncState, b: SyncState): SyncState {
  const r = merge(a, b, fakeImplicit);
  if (r.report.invariantViolations.length > 0) throw new Error('unexpected invariant violation');
  return r.state;
}

/** Regression variant: normalize equal values inside the state (app beats pseudo, then max dot). */
function collapseMerge(a: SyncState, b: SyncState): SyncState {
  const m = merge(a, b, fakeImplicit).state;
  const builder = new StateBuilder(m);
  for (const row of m.rows.values()) {
    for (const reg of row.regs.values()) {
      const byValue = new Map<string, Sibling>();
      for (const s of reg.sibs) {
        const cur = byValue.get(s.vhash);
        const better = !cur || (isPseudo(cur) !== isPseudo(s) ? !isPseudo(s) : compareRank(s, cur) > 0);
        if (better) byValue.set(s.vhash, s);
      }
      if (byValue.size === reg.sibs.length) continue;
      const next = makeRegister(reg.key, [...byValue.values()], reg.pmem);
      if (isImplicitEquivalent(next)) builder.removeRegister(reg.key);
      else builder.setRegister(next);
    }
  }
  return builder.build();
}

const CORRECT: Variant = { mergeFn: correctMerge, reuseDevOnRestore: false, oracle: 'identity', strict: true };
const COLLAPSE: Variant = { mergeFn: collapseMerge, reuseDevOnRestore: false, oracle: 'value', strict: false };
const REUSE_DEV: Variant = { mergeFn: correctMerge, reuseDevOnRestore: true, oracle: 'value', strict: false };

function newWorld(sc: Scenario, v: Variant): World {
  const world: World = {
    replicas: [],
    snapshots: Array.from({ length: sc.replicas }, () => []),
    writes: new Map(),
    clock: 1,
    nextDev: sc.replicas + 1,
    nextWrite: 1,
    nextRow: 1,
    nextNonce: 1,
    mergeFn: v.mergeFn,
    reuseDevOnRestore: v.reuseDevOnRestore,
  };
  world.replicas = Array.from({ length: sc.replicas }, (_, i) =>
    genesisReplica(world, i + 1, sc.sameGenesis ? sc.genesis[0] : sc.genesis[i]),
  );
  return world;
}

function checkLaws(world: World, step: Step): string | null {
  const n = world.replicas.length;
  const [a, b, c] = step.law.map((x) => world.replicas[x % n].state);
  const m = world.mergeFn;
  const b2 = step.clone ? clonedSnapshot(b) : b;
  if (dumpState(m(a, b2)) !== dumpState(m(b2, a))) return 'commutativity';
  if (dumpState(m(m(a, b), c)) !== dumpState(m(a, m(b, c)))) return 'associativity';
  if (dumpState(m(a, clonedSnapshot(a))) !== dumpState(a)) return 'idempotence';
  return null;
}

function invariantFailure(world: World): string | null {
  for (const r of world.replicas) {
    const rep = checkInvariants(r.state);
    if (rep.uncoveredApp.length + rep.uncoveredPseudo.length + rep.nonCanonical.length > 0) {
      return `invariants ${JSON.stringify(rep)}`;
    }
  }
  return null;
}

function parseRegKey(k: string): RegKey {
  const [tbl, rowId, reg] = JSON.parse(k) as [RegKey['tbl'], string, string];
  return { tbl, rowId, reg };
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

function oracleFailure(world: World, all: SyncState, v: Variant): string | null {
  const hist = new Map<string, Set<string>>();
  for (const r of world.replicas) for (const [k, ids] of r.hist) hist.set(k, new Set([...(hist.get(k) ?? []), ...ids]));
  for (const [k, ids] of hist) {
    const writes = world.writes.get(k) ?? new Map();
    const got = sibsOf(all, parseRegKey(k), fakeImplicit);
    const want = maximalWrites(writes, ids);
    const vhashOf = new Map([...writes.values()].map((w) => [w.identity, w.vhash]));
    const project = (identity: string, fallback: string): string =>
      v.oracle === 'identity' ? identity : vhashOf.get(identity) ?? fallback;
    const gotSet = new Set(got.map((s) => project(identityKey(s), s.vhash)));
    const wantSet = new Set(want.map((w) => project(w.identity, w.vhash)));
    if (!sameSet(gotSet, wantSet)) return `oracle ${k}: got ${[...gotSet]} want ${[...wantSet]}`;
  }
  return null;
}

function finalFailure(world: World, v: Variant): string | null {
  const m = world.mergeFn;
  const all = world.replicas.map((r) => r.state).reduce((x, y) => m(x, y));
  const dumps = new Set(world.replicas.map((r) => dumpState(m(r.state, all))));
  if (dumps.size !== 1 || !dumps.has(dumpState(all))) return 'convergence';
  return oracleFailure(world, all, v);
}

/** Runs a scenario; returns a failure description or null. */
function runScenario(sc: Scenario, v: Variant): string | null {
  const world = newWorld(sc, v);
  for (const [i, step] of sc.steps.entries()) {
    applyOp(world, step.op);
    const failure = checkLaws(world, step) ?? (v.strict ? invariantFailure(world) : null);
    if (failure) return `step ${i} (${step.op.kind}): ${failure}`;
  }
  return finalFailure(world, v);
}

function safeRun(sc: Scenario, v: Variant): string | null {
  try {
    return runScenario(sc, v);
  } catch (e) {
    return `threw: ${(e as Error).message}`;
  }
}

function op(kind: OpKind, fields: Partial<SimOp> = {}): Step {
  const base: SimOp = { kind, r: 0, j: 0, row: 0, reg: 0, value: 0, hint: 0, flag: true, ...fields };
  return { op: base, law: [0, 1, 0], clone: false };
}

const HOST_ONLY = 9;
const SAME_GENESIS: Scenario['genesis'] = Array.from({ length: MAX_REPLICAS }, () => Array<number>(GENESIS_CELLS).fill(0));

describe('merge laws over whole states (13.1)', () => {
  it('holds commutativity, associativity, idempotence, convergence and the no-lost-write oracle', () => {
    fc.assert(
      fc.property(scenarioArb(), (sc) => {
        const failure = safeRun(sc, CORRECT);
        if (failure) throw new Error(failure);
      }),
      { numRuns: CORRECT_RUNS },
    );
  });

  it('holds them under delete-heavy gossip (equal-valued siblings replaced by writers that saw them)', () => {
    fc.assert(
      fc.property(scenarioArb(DELETE_WEIGHTS), (sc) => {
        const failure = safeRun(sc, CORRECT);
        if (failure) throw new Error(failure);
      }),
      { numRuns: DELETE_RUNS },
    );
  });

  it('passes the hand-built regression scenarios', () => {
    expect(safeRun(collapseScenario(), CORRECT)).toBeNull();
    expect(safeRun(reuseDevScenario(), CORRECT)).toBeNull();
  });
});

function collapseScenario(): Scenario {
  const steps = [
    op('app', { r: 0, reg: HOST_ONLY, value: 0 }),
    op('app', { r: 1, reg: HOST_ONLY, value: 0 }),
    op('tick'),
    op('merge', { r: 0, j: 1 }),
    op('app', { r: 1, reg: HOST_ONLY, value: 1 }),
    op('merge', { r: 0, j: 1 }),
  ];
  return { replicas: 2, sameGenesis: true, genesis: SAME_GENESIS, steps };
}

function reuseDevScenario(): Scenario {
  const steps = [
    op('snapshot', { r: 0 }),
    op('tick'),
    op('app', { r: 0, reg: HOST_ONLY, value: 0 }),
    op('merge', { r: 1, j: 0 }),
    op('restore', { r: 0, row: 0 }),
    op('tick'),
    op('app', { r: 0, reg: 0, value: 1 }),
    op('merge', { r: 1, j: 0 }),
  ];
  return { replicas: 2, sameGenesis: true, genesis: SAME_GENESIS, steps };
}

/**
 * Two replicas re-assert the same row concurrently (equal `_life` values, two identities), gossip,
 * then one deletes it without the conflict editor: the delete saw both live siblings.
 */
function seenEqualScenario(kind: 'delete' | 'legacy-delete'): Scenario {
  const steps = [
    op('app', { r: 0, reg: HOST_ONLY, value: 0 }),
    op('app', { r: 1, reg: HOST_ONLY, value: 1 }),
    op('tick'),
    op('merge', { r: 0, j: 1 }),
    op('tick'),
    op(kind, { r: 0, flag: false }),
    op('merge', { r: 1, j: 0 }),
  ];
  return { replicas: 2, sameGenesis: true, genesis: SAME_GENESIS, steps };
}

function finalWorld(sc: Scenario): World {
  const world = newWorld(sc, CORRECT);
  for (const step of sc.steps) applyOp(world, step.op);
  return world;
}

describe('writes replace every sibling holding the value they saw (4.2 step 5, 4.3 rule 4)', () => {
  it.each(['delete', 'legacy-delete'] as const)('a non-interactive %s after concurrent re-assertions deletes on every replica', (kind) => {
    const sc = seenEqualScenario(kind);
    expect(safeRun(sc, CORRECT)).toBeNull();
    const row = rowKey(TBL.entries, GENESIS_ROWS[0]);
    for (const r of finalWorld(sc).replicas) expect(rowLife(r.state, row)).toBe('dead');
  });
});

describe('regression variants that must fail (13.1)', () => {
  it('"collapse equal values" loses a concurrent write', () => {
    expect(safeRun(collapseScenario(), COLLAPSE)).toMatch(/oracle|commutativity|associativity|convergence/);
    const details = fc.check(
      fc.property(scenarioArb(), (sc) => safeRun(sc, COLLAPSE) === null),
      { numRuns: REGRESSION_RUNS, seed: REGRESSION_SEED },
    );
    expect(details.failed).toBe(true);
  });

  it('"reuse dev after restore" loses a write the restored replica never saw', () => {
    expect(safeRun(reuseDevScenario(), REUSE_DEV)).toMatch(/oracle|violation|convergence/);
    const details = fc.check(
      fc.property(scenarioArb(RESTORE_WEIGHTS), (sc) => safeRun(sc, REUSE_DEV) === null),
      { numRuns: REGRESSION_RUNS, seed: REGRESSION_SEED },
    );
    expect(details.failed).toBe(true);
  });
});
