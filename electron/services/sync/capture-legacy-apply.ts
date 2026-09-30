/**
 * Legacy attribution of a row pass (spec 4.3): per-row pseudo edit and delete times, the
 * filter hooks, cascade rule H, rule R re-assertions with pseudo dots (at most one new pseudo
 * sibling per `_life` register, at the largest contributing ms), and value repair for rows
 * whose head values the loader could only read from content that changed, vanished or did not
 * parse. A head whose value cannot be recovered keeps its identity flagged SIB_VALUE_UNKNOWN,
 * so merge takes the value from a replica that has it instead of a null.
 */

import { LIFE_DEAD, LIFE_LIVE, LIFE_REG, fixedDef, registerDef, regKey, requireDef } from './catalog.js';
import type { CaptureInput } from './capture-local.js';
import type { Diffs, RowDiff } from './capture-local-diff.js';
import { resealStaleValues, siblingConsistent, type Observation, type SecretKeys } from './capture-local-observe.js';
import { noDots } from './capture-local-apply.js';
import { buildResult, makeNotice, newTally } from './capture-local-result.js';
import {
  cursorOf,
  historyDeleteRecorded,
  keptSiblings,
  lifeKey,
  ruleRTargets,
  type RuleHContext,
} from './capture-local-write.js';
import { applyLegacyChange, type Contribution, type LegacyChange, type LegacyEnv } from './capture-legacy-change.js';
import { legacyDeleteTime, legacyEditTime, rowTimeValue, type LegacyTime } from './capture-legacy-rules.js';
import { baseRefOf, pidOf, vhashOfValue, vrefPlain } from './hashing.js';
import { identityKey, isValueUnknown, pmemJoin, withValueUnknown } from './sibling.js';
import { StateBuilder, headOf, makeRegister, provisional, provisionalValue, rowKeyStr } from './state-view.js';
import {
  PSEUDO_DEV,
  SIB_VALUE_UNKNOWN,
  TBL,
  type CaptureResult,
  type LegacyAttribution,
  type RegisterDef,
  type RegisterState,
  type RowKey,
  type Sibling,
  type SqlValue,
  type SyncContext,
  type SyncState,
  type SyncValue,
} from './types.js';

const NO_PMEM_MS = -1;

function newEnv(input: CaptureInput, base: SyncState, att: LegacyAttribution, ctx: SyncContext, keys: SecretKeys): LegacyEnv {
  return {
    b: new StateBuilder(base),
    base,
    cache: input.cache,
    implicit: input.implicit,
    att,
    ctx,
    keys,
    holdActive: att.sideFilesPresent || att.serverSideFilesFlagRecent,
    tally: newTally(),
    contrib: new Map(),
    lifeTouched: new Set(),
    changedRows: new Map(),
  };
}

function editTimeFor(updatedAt: SqlValue): (pmemMs: number | null) => LegacyTime {
  return (pmemMs) => legacyEditTime(updatedAt, pmemMs);
}

function deleteTimeFor(env: LegacyEnv): (pmemMs: number | null) => LegacyTime {
  return (pmemMs) => {
    const t = legacyDeleteTime(pmemMs, env.att.observedMtimeMs, env.ctx.now());
    return { ms: t, lt: t };
  };
}

function lifeObservation(row: RowKey, value: string): Observation {
  return { vhash: vhashOfValue(lifeKey(row), value), flags: 0, value, reseal: null, plaintext: null };
}

function lifeChange(row: RowKey, value: string, kind: 'edit' | 'delete', timeFor: LegacyChange['timeFor']): LegacyChange {
  const key = lifeKey(row);
  return { key, def: requireDef(key), obs: lifeObservation(row, value), kind, timeFor, entryType: null };
}

function entryTypeOf(env: LegacyEnv, row: RowKey): SyncValue {
  if (row.tbl !== TBL.entries) return null;
  const def = fixedDef(TBL.entries, 'entry_type');
  return provisionalValue(env.base, regKey(TBL.entries, row.rowId, def.reg), def.defaultValue) ?? null;
}

function applyLegacyRow(env: LegacyEnv, d: RowDiff, lived: Set<string>): void {
  const timeFor = d.content === null ? deleteTimeFor(env) : editTimeFor(rowTimeValue(d.row.tbl, d.content));
  if (d.kind === 'insert' || d.kind === 'resurrect') {
    const outcome = applyLegacyChange(env, lifeChange(d.row, LIFE_LIVE, 'edit', timeFor));
    if (outcome !== 'held') lived.add(rowKeyStr(d.row));
  }
  const entryType = entryTypeOf(env, d.row);
  for (const c of d.changes) {
    applyLegacyChange(env, { key: c.key, def: c.def, obs: c.obs, kind: 'edit', timeFor, entryType });
  }
}

/**
 * Deletes (entries and folders first). A captured delete, applied, held or turned into a
 * conflict, counts as "died in this capture" for rule H: the history rows vanished by cascade.
 */
function applyLegacyDeletes(env: LegacyEnv, deletes: readonly RowKey[], lived: ReadonlySet<string>): void {
  const allowed = (row: RowKey): boolean => env.att.filter?.allowDelete?.(row) !== false;
  const died = new Set<string>();
  for (const row of deletes) {
    if (row.tbl === TBL.history || !allowed(row)) continue;
    applyLegacyChange(env, lifeChange(row, LIFE_DEAD, 'delete', deleteTimeFor(env)));
    died.add(rowKeyStr(row));
  }
  const ruleH: RuleHContext = { state: env.base, cache: env.cache, diedNow: died, livedNow: lived };
  for (const row of deletes) {
    if (row.tbl !== TBL.history || !allowed(row) || !historyDeleteRecorded(ruleH, row)) continue;
    applyLegacyChange(env, lifeChange(row, LIFE_DEAD, 'delete', deleteTimeFor(env)));
  }
}

function reassertPseudo(env: LegacyEnv, target: Contribution): void {
  const key = lifeKey(target.row);
  const cur = cursorOf(env.b, env.base, key, env.implicit);
  const w = provisional(LIFE_REG, cur.sibs);
  const ms = Math.max(target.ms, (cur.pmem?.ms ?? NO_PMEM_MS) + 1);
  const s: Sibling = {
    dev: PSEUDO_DEV,
    ms,
    c: 0,
    pid: pidOf(key, vrefPlain(key, LIFE_LIVE), baseRefOf(w), env.att.absorbKeys.kPid),
    lt: target.lt,
    vhash: vhashOfValue(key, LIFE_LIVE),
    flags: 0,
    value: LIFE_LIVE,
    prevVhash: null,
  };
  const kept = keptSiblings('reassert', cur.sibs, w);
  env.b.setRegister(makeRegister(key, [...kept, s], pmemJoin(cur.pmem, { ms, ids: [s.pid] })));
  const ks = rowKeyStr(target.row);
  env.changedRows.set(ks, target.row);
  env.lifeTouched.add(ks);
}

/** Rule R with pseudo dots: contributions merge per target into the largest ms and lt. */
function applyLegacyRuleR(env: LegacyEnv): void {
  if (env.contrib.size === 0) return;
  const after = env.b.snapshot();
  const targets = new Map<string, Contribution>();
  for (const c of env.contrib.values()) {
    for (const t of ruleRTargets(after, c.row)) {
      const ks = rowKeyStr(t);
      const prev = targets.get(ks);
      targets.set(ks, { row: t, ms: Math.max(prev?.ms ?? c.ms, c.ms), lt: Math.max(prev?.lt ?? c.lt, c.lt) });
    }
  }
  for (const [ks, t] of targets) {
    if (!env.lifeTouched.has(ks)) reassertPseudo(env, t);
  }
}

/** The recovered value of a head, or undefined when `att.recover` has none that matches its vhash. */
function recoveredHead(env: LegacyEnv, def: RegisterDef, reg: RegisterState, head: Sibling): Sibling | undefined {
  const value = env.att.recover?.(reg.key, identityKey(head));
  if (value === undefined) return undefined;
  const fixed: Sibling = { ...head, value, flags: head.flags & ~SIB_VALUE_UNKNOWN };
  return siblingConsistent(reg.key, def, fixed, env.keys) ? fixed : undefined;
}

/**
 * Makes a head's value trustworthy: the recovered value, or else the same identity flagged
 * SIB_VALUE_UNKNOWN (never provisional, never materialized, loses every merge to a copy that
 * has the value). Returns false when the value stays unknown.
 */
function repairHead(env: LegacyEnv, reg: RegisterState): boolean {
  const def = registerDef(reg.key);
  const head = headOf(reg.key.reg, reg.sibs);
  if (def === null || head === null || siblingConsistent(reg.key, def, head, env.keys)) return true;
  const fixed = recoveredHead(env, def, reg, head) ?? withValueUnknown(head);
  if (fixed !== head) env.b.setRegister({ key: reg.key, sibs: reg.sibs.map((s) => (s === head ? fixed : s)), pmem: reg.pmem });
  return !isValueUnknown(fixed);
}

type RegisterFilter = (def: RegisterDef) => boolean;

const ALL_REGISTERS: RegisterFilter = () => true;
const FAMILY_REGISTERS: RegisterFilter = (def) => def.family !== null;

/**
 * Rows the capture did not rewrite although their content changed, vanished or did not parse
 * (deleted, rule-H hidden, filtered, malformed family column): their head values may have
 * been loaded from that content. Returns how many values stayed unknown.
 */
function repairRows(env: LegacyEnv, rows: readonly RowKey[], accept: RegisterFilter): number {
  const seen = new Set<string>();
  let lost = 0;
  for (const row of rows) {
    const ks = rowKeyStr(row);
    if (seen.has(ks)) continue;
    seen.add(ks);
    const regs = [...(env.b.row(row)?.regs.values() ?? [])];
    for (const reg of regs) {
      const def = registerDef(reg.key);
      if (reg.key.reg === LIFE_REG || def === null || !accept(def)) continue;
      if (!repairHead(env, reg)) lost++;
    }
  }
  return lost;
}

function repairAll(env: LegacyEnv, diffs: Diffs): void {
  const lost =
    repairRows(env, [...diffs.deletes, ...diffs.skipped], ALL_REGISTERS) + repairRows(env, diffs.malformed, FAMILY_REGISTERS);
  if (lost > 0) env.tally.notices.push(makeNotice('value-unrecoverable', null, lost, env.att.sourceSha256, env.ctx.now()));
  // Older apps keep seeing the unparseable column until a publish rewrites it from the kept values.
  if (diffs.malformed.length > 0) env.tally.contentRepairNeeded = true;
}

export function applyLegacyDiffs(
  input: CaptureInput,
  diffs: Diffs,
  att: LegacyAttribution,
  ctx: SyncContext,
  keys: SecretKeys,
): CaptureResult {
  const nothing =
    diffs.rows.length === 0 &&
    diffs.deletes.length === 0 &&
    diffs.skipped.length === 0 &&
    diffs.malformed.length === 0 &&
    diffs.reseals.length === 0;
  if (nothing) return noDots(input.state, diffs.base);
  const env = newEnv(input, diffs.base, att, ctx, keys);
  const lived = new Set<string>();
  for (const d of diffs.rows) applyLegacyRow(env, d, lived);
  applyLegacyDeletes(env, diffs.deletes, lived);
  applyLegacyRuleR(env);
  repairAll(env, diffs);
  // Republish once, so the absorbed file stops holding stale-key bytes that would be re-sealed
  // with a fresh nonce on every absorption.
  if (resealStaleValues(env.b, diffs.reseals, keys, ctx) > 0) env.tally.contentRepairNeeded = true;
  if (env.tally.undecryptable > 0) {
    env.tally.notices.push(makeNotice('undecryptable-secrets', null, env.tally.undecryptable, att.sourceSha256, ctx.now()));
  }
  return buildResult(input.state, env.b.build(), [...env.changedRows.values()], env.tally);
}
