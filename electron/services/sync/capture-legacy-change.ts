/**
 * One legacy register change (spec 4.3): builds the deterministic pseudo sibling p and applies
 * the drop rule, the hold rule, the stale-revert rule or the "otherwise" replacement. Where a
 * rule keeps w, w's value is made trustworthy first (att.recover). When this device cannot
 * recover it, w is still kept, flagged SIB_VALUE_UNKNOWN with a 'value-unrecoverable' notice:
 * dropping w from a state whose vv covers it would erase it on the device that owns it.
 */

import { LIFE_REG, isContentTbl } from './catalog.js';
import { sealValue, siblingConsistent, type Observation, type SecretKeys } from './capture-local-observe.js';
import { makeNotice, type Tally } from './capture-local-result.js';
import { cursorOf, withoutSeenValue, type RegisterCursor } from './capture-local-write.js';
import { isDroppedChange, isStaleRevert, secretRevertPrevs, type LegacyTime } from './capture-legacy-rules.js';
import { baseRefOf, pidOf, vrefPlain, vrefSecret } from './hashing.js';
import { identityKey, isPseudo, isUndecryptable, pmemJoin, withValueUnknown } from './sibling.js';
import { makeRegister, provisional, rowKeyStr, rowOf, type StateBuilder } from './state-view.js';
import {
  PSEUDO_DEV,
  type ImplicitProvider,
  type LegacyAttribution,
  type Pmem,
  type RegKey,
  type RegisterDef,
  type RowCache,
  type RowKey,
  type Sibling,
  type SyncContext,
  type SyncState,
  type SyncValue,
} from './types.js';

/** Rule R input: the largest ms and lt among one row's new edit siblings. */
export interface Contribution {
  readonly row: RowKey;
  readonly ms: number;
  readonly lt: number;
}

/** Everything one legacy absorption shares; the maps and tally are fresh per call. */
export interface LegacyEnv {
  readonly b: StateBuilder;
  /** X before the capture. */
  readonly base: SyncState;
  readonly cache: RowCache;
  readonly implicit: ImplicitProvider;
  readonly att: LegacyAttribution;
  readonly ctx: SyncContext;
  readonly keys: SecretKeys;
  readonly holdActive: boolean;
  readonly tally: Tally;
  readonly contrib: Map<string, Contribution>;
  /** Rows whose `_life` got a pseudo sibling or a held change in this absorption. */
  readonly lifeTouched: Set<string>;
  readonly changedRows: Map<string, RowKey>;
}

export type ChangeKind = 'edit' | 'delete';
export type ChangeOutcome = 'applied' | 'stale-revert' | 'held' | 'dropped';

export interface LegacyChange {
  readonly key: RegKey;
  readonly def: RegisterDef;
  readonly obs: Observation;
  readonly kind: ChangeKind;
  /** Pseudo time of this change given the register's pmem ms (null = empty memory). */
  readonly timeFor: (pmemMs: number | null) => LegacyTime;
  /** Provisional entry_type of the row in X (drop rule), null for other tables. */
  readonly entryType: SyncValue;
}

function secretBytes(value: SyncValue): Uint8Array | null {
  return value instanceof Uint8Array ? value : null;
}

function makePseudo(env: LegacyEnv, ch: LegacyChange, w: Sibling | null, time: LegacyTime): Sibling {
  const vref = ch.def.secret ? vrefSecret(secretBytes(ch.obs.value)) : vrefPlain(ch.key, ch.obs.value);
  return {
    dev: PSEUDO_DEV,
    ms: time.ms,
    c: 0,
    pid: pidOf(ch.key, vref, baseRefOf(w), env.att.absorbKeys.kPid),
    lt: time.lt,
    vhash: ch.obs.vhash,
    flags: ch.obs.flags,
    value: sealValue(ch.obs, env.keys, env.ctx),
    prevVhash: null,
  };
}

function notice(env: LegacyEnv, kind: 'dropped-setting' | 'value-unrecoverable', key: RegKey): void {
  env.tally.notices.push(makeNotice(kind, key, 1, env.att.sourceSha256, env.ctx.now()));
}

/** w with its recovered value, or w flagged SIB_VALUE_UNKNOWN (with a notice) when recovery fails. */
function trustworthyW(env: LegacyEnv, ch: LegacyChange, w: Sibling): Sibling {
  const value = env.att.recover?.(ch.key, identityKey(w));
  if (value !== undefined) {
    const fixed: Sibling = { ...w, value };
    if (siblingConsistent(ch.key, ch.def, fixed, env.keys)) return fixed;
  }
  notice(env, 'value-unrecoverable', ch.key);
  return withValueUnknown(w);
}

/**
 * The register's siblings with w's value made trustworthy. Implicit and genesis-built values
 * are already consistent and are returned untouched.
 */
function keptWithW(env: LegacyEnv, ch: LegacyChange, cur: RegisterCursor, w: Sibling | null): readonly Sibling[] {
  if (w === null || !cur.reg || siblingConsistent(ch.key, ch.def, w, env.keys)) return cur.sibs;
  const fixed = trustworthyW(env, ch, w);
  return cur.sibs.map((s) => (s === w ? fixed : s));
}

function contribute(env: LegacyEnv, row: RowKey, s: Sibling): void {
  const ks = rowKeyStr(row);
  const prev = env.contrib.get(ks);
  env.contrib.set(ks, { row, ms: Math.max(prev?.ms ?? s.ms, s.ms), lt: Math.max(prev?.lt ?? s.lt, s.lt) });
}

function place(env: LegacyEnv, ch: LegacyChange, kept: readonly Sibling[], pmem: Pmem | null, s: Sibling): void {
  env.b.setRegister(makeRegister(ch.key, [...kept, s], pmemJoin(pmem, { ms: s.ms, ids: [s.pid] })));
  const row = rowOf(ch.key);
  const ks = rowKeyStr(row);
  env.changedRows.set(ks, row);
  if (ch.key.reg === LIFE_REG) env.lifeTouched.add(ks);
  if (ch.kind === 'delete') env.tally.legacyDeletes++;
  else env.tally.legacyEdits++;
  if (ch.kind === 'edit' && isContentTbl(row.tbl)) contribute(env, row, s);
  if (isUndecryptable(s)) env.tally.undecryptable++;
}

/** Rule 4: p removes w, every sibling holding w's value and every pseudo sibling; other app siblings stay. */
function replaceW(env: LegacyEnv, ch: LegacyChange, cur: RegisterCursor, w: Sibling | null, s: Sibling): ChangeOutcome {
  place(env, ch, withoutSeenValue(cur.sibs, w).filter((x) => !isPseudo(x)), cur.pmem, s);
  return 'applied';
}

/** Identity keys of the other app siblings holding w's value: rule 4 replaces them with w (applyHeld). */
function equalValueIds(cur: RegisterCursor, w: Sibling | null): readonly string[] {
  if (w === null) return [];
  return cur.sibs.filter((x) => x !== w && !isPseudo(x) && x.vhash === w.vhash).map(identityKey);
}

function keepRegister(env: LegacyEnv, ch: LegacyChange, cur: RegisterCursor, kept: readonly Sibling[]): void {
  if (kept !== cur.sibs) env.b.setRegister(makeRegister(ch.key, kept, cur.pmem));
}

function dropChange(env: LegacyEnv, ch: LegacyChange, cur: RegisterCursor, w: Sibling | null): ChangeOutcome {
  keepRegister(env, ch, cur, keptWithW(env, ch, cur, w));
  env.tally.legacyDropped++;
  env.tally.contentRepairNeeded = true;
  notice(env, 'dropped-setting', ch.key);
  return 'dropped';
}

function holdChange(env: LegacyEnv, ch: LegacyChange, cur: RegisterCursor, w: Sibling | null, p: () => Sibling): ChangeOutcome {
  keepRegister(env, ch, cur, keptWithW(env, ch, cur, w));
  const s = p();
  const equal = equalValueIds(cur, w);
  env.tally.held.push({
    key: ch.key,
    kind: ch.kind === 'delete' ? 'delete' : 'stale-revert',
    sibling: s,
    replaces: w ? identityKey(w) : null,
    ...(equal.length > 0 ? { replacesEqual: equal } : {}),
    pmemAdd: { ms: s.ms, ids: [s.pid] },
    sourceSha256: env.att.sourceSha256,
    heldAtMs: env.ctx.now(),
  });
  env.tally.legacyHeld++;
  env.tally.contentRepairNeeded = true;
  if (ch.key.reg === LIFE_REG) env.lifeTouched.add(rowKeyStr(ch.key));
  return 'held';
}

function staleRevert(env: LegacyEnv, ch: LegacyChange, cur: RegisterCursor, w: Sibling | null, p: () => Sibling): ChangeOutcome {
  const kept = keptWithW(env, ch, cur, w);
  place(env, ch, kept.filter((x) => !isPseudo(x)), cur.pmem, p());
  env.tally.staleReverts++;
  return 'stale-revert';
}

function isStaleChange(env: LegacyEnv, ch: LegacyChange, w: Sibling | null): boolean {
  if (isStaleRevert(w, ch.obs.vhash)) return true;
  if (!ch.def.secret || ch.obs.plaintext === null || w === null || isPseudo(w) || w.prevVhash === null) return false;
  return isStaleRevert(w, ch.obs.vhash, secretRevertPrevs(ch.key, ch.obs.plaintext, env.keys.ring));
}

/**
 * 4.8: a legacy secret no key opens sits beside the readable values (it is never provisional);
 * replacing w would leave the register with nothing readable. [Discard] or the old password settles it.
 */
function keepBeside(env: LegacyEnv, ch: LegacyChange, cur: RegisterCursor, w: Sibling | null, s: Sibling): ChangeOutcome {
  place(env, ch, keptWithW(env, ch, cur, w), cur.pmem, s);
  return 'applied';
}

/**
 * The pseudo time of 4.3. A stale revert is capped at w's time (still above the register's pseudo
 * memory) so the value it reverts stays provisional (12 row 45). Deterministic: pid includes w.
 */
function pseudoTime(ch: LegacyChange, cur: RegisterCursor, w: Sibling | null, stale: boolean): LegacyTime {
  const pmemMs = cur.pmem?.ms ?? null;
  const t = ch.timeFor(pmemMs);
  if (!stale || w === null) return t;
  return { ms: Math.max((pmemMs ?? -1) + 1, Math.min(t.ms, w.ms)), lt: t.lt };
}

/** Applies one legacy change to X per 4.3 rules 1-4, in that order. */
export function applyLegacyChange(env: LegacyEnv, ch: LegacyChange): ChangeOutcome {
  const cur = cursorOf(env.b, env.base, ch.key, env.implicit);
  const w = provisional(ch.key.reg, cur.sibs);
  if (ch.kind === 'edit' && isDroppedChange(ch.key, ch.obs.value, w, ch.entryType)) return dropChange(env, ch, cur, w);
  const stale = isStaleChange(env, ch, w);
  let made: Sibling | null = null;
  const p = (): Sibling => (made ??= makePseudo(env, ch, w, pseudoTime(ch, cur, w, stale)));
  if ((ch.kind === 'delete' || stale) && env.holdActive) return holdChange(env, ch, cur, w, p);
  if (stale) return staleRevert(env, ch, cur, w, p);
  const s = p();
  if (isUndecryptable(s)) return keepBeside(env, ch, cur, w, s);
  return replaceW(env, ch, cur, w, s);
}
