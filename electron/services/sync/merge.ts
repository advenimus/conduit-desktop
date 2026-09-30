/**
 * The state merge of spec 4.5: coverage, mergeRegister (the rule proven by register-sim.mjs,
 * extended to implicit and empty registers, identity copies and redaction), merge(A, B) over
 * whole states (vv, devs, rows, registers, graves, epochs, wraps), the invariant guard, and the
 * conflict test. Pure: no SQL, no clock, no randomness. Provisional choice lives in
 * state-view.ts and is re-exported here.
 */

import { LIFE_DEAD, LIFE_LIVE, LIFE_REG, registerDef } from './catalog.js';
import { vhashOfValue } from './hashing.js';
import { mergeDevs, mergeEpochs, mergeGrave, mergeVv, mergeWraps } from './merge-meta.js';
import {
  implicitSide,
  isImplicitForm,
  mergeSides,
  resolveStubs,
  type MergedRegister,
  type RegisterSide,
} from './merge-register.js';
import { compareIdentity, isPseudo, isRedacted, isUndecryptable, isValueUnknown, pmemCovers, pmemEquals, vvCovers } from './sibling.js';
import { isImplicitEquivalent, pmemOf } from './state-view.js';
import { SyncCoreError } from './types.js';
import type {
  ImplicitProvider,
  MergeResult,
  RegKey,
  RegisterDef,
  RegisterState,
  RowState,
  Sibling,
  SyncState,
} from './types.js';

export { headOf, provisional } from './state-view.js';
export { mergeRegister, type MergedRegister, type RegisterSide } from './merge-register.js';
export { mergeGrave } from './merge-meta.js';

/** covered(X, k, s) of 4.5 over a whole state (implicit pmem for known rows, null for unknown). */
export function covered(x: SyncState, key: RegKey, s: Sibling): boolean {
  return isPseudo(s) ? pmemCovers(pmemOf(x, key), s) : vvCovers(x.vv, s.dev, s);
}

/**
 * Throws SyncCoreError('MERGE_PRECONDITION') unless lineage and genesis ids match. The caller
 * guarantees both states' secrets are under the same key epoch (alignEpoch, 4.8); the epoch
 * registers themselves merge like any other register and are not compared here.
 */
export function checkMergePreconditions(a: SyncState, b: SyncState): void {
  if (a.lineageId !== b.lineageId) {
    throw new SyncCoreError('MERGE_PRECONDITION', 'cannot merge states of different lineages');
  }
  if (a.genesisId !== b.genesisId) {
    throw new SyncCoreError('MERGE_PRECONDITION', 'cannot merge states of different genesis ids');
  }
}

interface MergeEnv {
  readonly implicit: ImplicitProvider;
  readonly sideA: RegisterSide;
  readonly sideB: RegisterSide;
  readonly violations: RegKey[];
}

const NO_VIOLATIONS: readonly RegKey[] = Object.freeze([]);

/**
 * merge(A, B) of 4.5. Commutative, associative and idempotent on the logical state
 * (everything digest.ts covers). Preserves A's RowState/RegisterState objects wherever the
 * merged value equals A's, so save diffs stay small when A is W. Drops `mat` on changed
 * registers; materialize recomputes it.
 *
 * A row known to only one side is taken from that side unchanged (B's without `mat`). For
 * states reachable through capture and merge this equals applying the other side's coverage
 * (a replica whose vv covers a sibling knows its row); it also keeps states that restrict rows
 * but carry a full vv (synthetic candidates, G3 remainders) from dropping siblings they never saw.
 */
export function merge(a: SyncState, b: SyncState, implicit: ImplicitProvider): MergeResult {
  checkMergePreconditions(a, b);
  if (a === b) return { state: a, report: { invariantViolations: NO_VIOLATIONS } };
  const env: MergeEnv = { implicit, sideA: implicitSide(a.vv), sideB: implicitSide(b.vv), violations: [] };
  const rows = mergeRows(a, b, env);
  const vv = mergeVv(a.vv, b.vv);
  const devs = mergeDevs(a.devs, b.devs);
  const epochs = mergeEpochs(a.epochs, b.epochs);
  const wraps = mergeWraps(a.wraps, b.wraps);
  const createdMs = Math.min(a.createdMs, b.createdMs);
  const report = { invariantViolations: env.violations.length > 0 ? env.violations : NO_VIOLATIONS };
  const same =
    rows === a.rows && vv === a.vv && devs === a.devs && epochs === a.epochs && wraps === a.wraps && createdMs === a.createdMs;
  if (same) return { state: a, report };
  return {
    state: { lineageId: a.lineageId, genesisId: a.genesisId, createdMs, vv, devs, rows, epochs, wraps },
    report,
  };
}

function mergeRows(a: SyncState, b: SyncState, env: MergeEnv): ReadonlyMap<string, RowState> {
  if (a.rows === b.rows) return a.rows;
  let out: Map<string, RowState> | null = null;
  for (const [k, rb] of b.rows) {
    const ra = a.rows.get(k);
    if (ra === rb) continue;
    const next = ra === undefined ? adoptRow(rb) : mergeKnownRow(ra, rb, env);
    if (next === ra) continue;
    out ??= new Map(a.rows);
    out.set(k, next);
  }
  return out ?? a.rows;
}

function adoptRow(rb: RowState): RowState {
  let regs: Map<string, RegisterState> | null = null;
  for (const [name, reg] of rb.regs) {
    if (reg.mat === undefined) continue;
    regs ??= new Map(rb.regs);
    regs.set(name, { key: reg.key, sibs: reg.sibs, pmem: reg.pmem });
  }
  return regs === null ? rb : { key: rb.key, regs, grave: rb.grave };
}

function mergeKnownRow(ra: RowState, rb: RowState, env: MergeEnv): RowState {
  let regs: Map<string, RegisterState> | null = null;
  for (const [name, regA] of ra.regs) {
    const regB = rb.regs.get(name);
    if (regA === regB) continue;
    const next = mergeRegisterStates(regA, regB, env);
    if (next === regA) continue;
    regs ??= new Map(ra.regs);
    if (next === null) regs.delete(name);
    else regs.set(name, next);
  }
  for (const [name, regB] of rb.regs) {
    if (ra.regs.has(name)) continue;
    const next = mergeRegisterStates(undefined, regB, env);
    if (next === null) continue;
    regs ??= new Map(ra.regs);
    regs.set(name, next);
  }
  const grave = mergeGrave(ra.grave, rb.grave);
  if (regs === null && grave === ra.grave) return ra;
  return { key: ra.key, regs: regs ?? ra.regs, grave };
}

/** One register of a row both sides know; `undefined` = implicit on that side, null result = implicit. */
function mergeRegisterStates(
  regA: RegisterState | undefined,
  regB: RegisterState | undefined,
  env: MergeEnv,
): RegisterState | null {
  const key = (regA ?? regB)?.key;
  if (key === undefined) return null;
  const sideA = regA ? { sibs: regA.sibs, pmem: regA.pmem, vv: env.sideA.vv } : env.sideA;
  const sideB = regB ? { sibs: regB.sibs, pmem: regB.pmem, vv: env.sideB.vv } : env.sideB;
  const resolve = (): Sibling => env.implicit(key);
  const m = mergeSides(sideA, sideB, resolve, (s) => plainValueConsistent(key, s));
  if (m.violation) env.violations.push(key);
  if (isImplicitForm(key, m)) return null;
  if (regA && m.sibs === regA.sibs && pmemEquals(m.pmem, regA.pmem)) return regA;
  if (regB && regB.mat === undefined && sameAsRegister(m, regB)) return regB;
  return { key, sibs: resolveStubs(m.sibs, resolve), pmem: m.pmem };
}

/**
 * Whether a copy's value is the one its vhash describes, for non-secret registers (secret
 * vhashes are keyed; merge holds no keys, so secrets count as consistent). Only consulted when
 * two copies of one identity differ, so the common merge path never hashes.
 */
function plainValueConsistent(key: RegKey, s: Sibling): boolean {
  const def = registerDef(key);
  if (def === null || def.secret || isRedacted(s) || isValueUnknown(s)) return true;
  try {
    return vhashOfValue(key, s.value) === s.vhash;
  } catch {
    // canon() rejects the value, so it cannot be the value its vhash was computed over.
    return false;
  }
}

function sameAsRegister(m: MergedRegister, reg: RegisterState): boolean {
  if (!pmemEquals(m.pmem, reg.pmem) || m.sibs.length !== reg.sibs.length) return false;
  return m.sibs.every((s, i) => s === reg.sibs[i]);
}

/**
 * Conflict test of 4.5 for prompt and groupA registers: more than one distinct vhash among
 * eligible siblings; any undecryptable sibling; or `_life` holding both live and dead.
 * Always false for auto registers. For 'special' (the epoch register) the same value test applies.
 * Redacted siblings and siblings whose value this replica lacks never count; equal values in
 * different identities are not a conflict.
 */
export function isConflict(def: RegisterDef, reg: string, sibs: readonly Sibling[]): boolean {
  if (def.cls === 'auto') return false;
  let firstVhash: string | null = null;
  let live = false;
  let dead = false;
  for (const s of sibs) {
    if (isRedacted(s) || isValueUnknown(s)) continue;
    if (isUndecryptable(s)) return true;
    if (reg === LIFE_REG) {
      live ||= s.value === LIFE_LIVE;
      dead ||= s.value === LIFE_DEAD;
    } else if (firstVhash === null) {
      firstVhash = s.vhash;
    } else if (s.vhash !== firstVhash) {
      return true;
    }
  }
  return live && dead;
}

export interface InvariantReport {
  /** I1: app siblings not covered by X.vv. */
  readonly uncoveredApp: readonly RegKey[];
  /** I2: pseudo siblings not covered by X.pmem(k). */
  readonly uncoveredPseudo: readonly RegKey[];
  /** Explicit registers not in canonical form: equal to their implicit form, empty, or not identity-sorted. */
  readonly nonCanonical: readonly RegKey[];
}

/** Checks I1, I2 and canonical form over a whole state (tests and debug builds). */
export function checkInvariants(state: SyncState): InvariantReport {
  const uncoveredApp: RegKey[] = [];
  const uncoveredPseudo: RegKey[] = [];
  const nonCanonical: RegKey[] = [];
  for (const row of state.rows.values()) {
    for (const reg of row.regs.values()) {
      if (reg.sibs.some((s) => !isPseudo(s) && !vvCovers(state.vv, s.dev, s))) uncoveredApp.push(reg.key);
      if (reg.sibs.some((s) => isPseudo(s) && !pmemCovers(reg.pmem, s))) uncoveredPseudo.push(reg.key);
      if (!isCanonicalRegister(reg)) nonCanonical.push(reg.key);
    }
  }
  return { uncoveredApp, uncoveredPseudo, nonCanonical };
}

function isCanonicalRegister(reg: RegisterState): boolean {
  if (reg.sibs.length === 0 || isImplicitEquivalent(reg)) return false;
  for (let i = 1; i < reg.sibs.length; i++) {
    if (compareIdentity(reg.sibs[i - 1], reg.sibs[i]) >= 0) return false;
  }
  return true;
}
