/**
 * The single-register merge rule of spec 4.5 (the rule register-sim.mjs checks), extended to
 * implicit registers (a lazily built implicit sibling), identity copies (pickIdentityCopy,
 * redaction wins) and the invariant guard. Import through merge.ts.
 */

import { IMPLICIT_PMEM } from './catalog.js';
import {
  compareIdentity,
  isPseudo,
  pickIdentityCopy,
  pmemCovers,
  pmemEquals,
  pmemJoin,
  vvCovers,
  type CopyCheck,
} from './sibling.js';
import { isImplicitEquivalent } from './state-view.js';
import { SyncCoreError, ZERO_PID, type Pmem, type RegKey, type Sibling, type VersionVector } from './types.js';

/** One side of a register merge. `pmem` null = empty memory; `vv` is that side's whole vv. */
export interface RegisterSide {
  /** Sorted by compareIdentity (the RegisterState invariant); unsorted input is sorted first. */
  readonly sibs: readonly Sibling[];
  readonly pmem: Pmem | null;
  readonly vv: VersionVector;
}

export interface MergedRegister {
  /** Sorted by compareIdentity. Empty only when both inputs were empty. */
  readonly sibs: readonly Sibling[];
  readonly pmem: Pmem | null;
  /** keep was empty while a ∪ b was not: kept a ∪ b instead (sync.invariant_violation). */
  readonly violation: boolean;
}

/**
 * Placeholder with the implicit sibling's identity. Merge swaps in the provider's sibling only
 * when the placeholder survives into an explicit register, so a covered implicit sibling never
 * costs a (possibly keyed) hash.
 */
export const IMPLICIT_STUB: Sibling = Object.freeze({
  dev: 0,
  ms: 0,
  c: 0,
  pid: ZERO_PID,
  lt: 0,
  vhash: '',
  flags: 0,
  value: null,
  prevVhash: null,
});

const IMPLICIT_STUB_SIBS: readonly Sibling[] = Object.freeze([IMPLICIT_STUB]);

/** Side of a register that is implicit in a known row: [implicit sibling], IMPLICIT_PMEM. */
export function implicitSide(vv: VersionVector): RegisterSide {
  return { sibs: IMPLICIT_STUB_SIBS, pmem: IMPLICIT_PMEM, vv };
}

/** covered(X, k, s) of 4.5 for one side: pseudo via its pmem, app via its vv. */
export function coveredBySide(side: RegisterSide, s: Sibling): boolean {
  return isPseudo(s) ? pmemCovers(side.pmem, s) : vvCovers(side.vv, s.dev, s);
}

type ImplicitResolver = () => Sibling;

function noImplicit(): Sibling {
  throw new Error('mergeRegister: implicit placeholder without a provider');
}

/** mergeRegister(A, B, k) of 4.5, with pickIdentityCopy for identities on both sides. */
export function mergeRegister(a: RegisterSide, b: RegisterSide, consistent?: CopyCheck): MergedRegister {
  const m = mergeSides(a, b, noImplicit, consistent);
  return { sibs: resolveStubs(m.sibs, noImplicit), pmem: m.pmem, violation: m.violation };
}

/** How identity copies are chosen: the implicit sibling source and an optional value check. */
interface CopyEnv {
  readonly resolve: ImplicitResolver;
  readonly consistent: CopyCheck | undefined;
}

/**
 * Core merge-join over identity-sorted sides. The result may still contain IMPLICIT_STUB;
 * callers decide whether the register is implicit before resolving it. Returns `a.sibs` itself
 * when the kept list equals it element by element (reference preservation). `consistent`
 * lets a copy whose value hashes to its vhash win over one that does not (pickIdentityCopy).
 */
export function mergeSides(
  a: RegisterSide,
  b: RegisterSide,
  resolve: ImplicitResolver,
  consistent?: CopyCheck,
): MergedRegister {
  const as = sortedSibs(a.sibs);
  const bs = sortedSibs(b.sibs);
  const pmem = joinPmem(a.pmem, b.pmem);
  const env: CopyEnv = { resolve, consistent };
  const keep = joinKept(as, bs, a, b, env);
  if (keep.length === 0 && as.length + bs.length > 0) {
    return { sibs: unionAll(as, bs, env), pmem, violation: true };
  }
  return { sibs: sameSibs(keep, a.sibs) ? a.sibs : keep, pmem, violation: false };
}

function joinKept(
  as: readonly Sibling[],
  bs: readonly Sibling[],
  a: RegisterSide,
  b: RegisterSide,
  env: CopyEnv,
): Sibling[] {
  const keep: Sibling[] = [];
  let i = 0;
  let j = 0;
  while (i < as.length || j < bs.length) {
    const order = i >= as.length ? 1 : j >= bs.length ? -1 : compareIdentity(as[i], bs[j]);
    if (order === 0) {
      keep.push(pickCopy(as[i++], bs[j++], env));
    } else if (order < 0) {
      const s = as[i++];
      if (!coveredBySide(b, s)) keep.push(s);
    } else {
      const s = bs[j++];
      if (!coveredBySide(a, s)) keep.push(s);
    }
  }
  return keep;
}

function unionAll(as: readonly Sibling[], bs: readonly Sibling[], env: CopyEnv): Sibling[] {
  const out: Sibling[] = [];
  let i = 0;
  let j = 0;
  while (i < as.length || j < bs.length) {
    const order = i >= as.length ? 1 : j >= bs.length ? -1 : compareIdentity(as[i], bs[j]);
    if (order === 0) out.push(pickCopy(as[i++], bs[j++], env));
    else out.push(order < 0 ? as[i++] : bs[j++]);
  }
  return out;
}

function pickCopy(x: Sibling, y: Sibling, env: CopyEnv): Sibling {
  if (x === y) return x;
  const a = x === IMPLICIT_STUB ? env.resolve() : x;
  const b = y === IMPLICIT_STUB ? env.resolve() : y;
  return pickIdentityCopy(a, b, env.consistent);
}

/** Replaces the placeholder with the provider's implicit sibling (at most once per register). */
export function resolveStubs(sibs: readonly Sibling[], resolve: ImplicitResolver): readonly Sibling[] {
  const at = sibs.indexOf(IMPLICIT_STUB);
  if (at < 0) return sibs;
  const out = [...sibs];
  out[at] = resolve();
  return out;
}

/** True when a merged register is exactly the implicit form (store it implicit). */
export function isImplicitForm(key: RegKey, m: Pick<MergedRegister, 'sibs' | 'pmem'>): boolean {
  return isImplicitEquivalent({ key, sibs: m.sibs, pmem: m.pmem });
}

/** pmemJoin that returns `a` itself for equal memories (no allocation on the common path). */
export function joinPmem(a: Pmem | null, b: Pmem | null): Pmem | null {
  return pmemEquals(a, b) ? a : pmemJoin(a, b);
}

function sameSibs(x: readonly Sibling[], y: readonly Sibling[]): boolean {
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) return false;
  }
  return true;
}

function sortedSibs(sibs: readonly Sibling[]): readonly Sibling[] {
  for (let i = 1; i < sibs.length; i++) {
    const order = compareIdentity(sibs[i - 1], sibs[i]);
    if (order === 0) throw new SyncCoreError('CORRUPT_STATE', 'register holds one sibling identity twice');
    if (order > 0) return sortChecked(sibs);
  }
  return sibs;
}

function sortChecked(sibs: readonly Sibling[]): readonly Sibling[] {
  const out = [...sibs].sort(compareIdentity);
  for (let i = 1; i < out.length; i++) {
    if (compareIdentity(out[i - 1], out[i]) === 0) {
      throw new SyncCoreError('CORRUPT_STATE', 'register holds one sibling identity twice');
    }
  }
  return out;
}
