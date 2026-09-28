/**
 * Register writes shared by capture: the register cursor (explicit, implicit or empty as of
 * the operation's base state), the app-sibling writer with its three replacement modes
 * (4.2 step 5), rule R targets (4.2 step 4) and cascade rule H (4.2 step 3).
 */

import {
  IMPLICIT_PMEM,
  LIFE_LIVE,
  LIFE_REG,
  asText,
  isContentTbl,
  referencedRows,
  regKey,
  rowKey,
} from './catalog.js';
import { prevOf, vhashOfValue } from './hashing.js';
import { identityKey } from './sibling.js';
import {
  StateBuilder,
  containerChain,
  getRegister,
  headOf,
  makeRegister,
  parseRowKeyStr,
  provisional,
  provisionalValue,
  rowKeyStr,
  rowLife,
  rowOf,
} from './state-view.js';
import {
  TBL,
  type AppDot,
  type ImplicitProvider,
  type Pmem,
  type RegKey,
  type RegisterState,
  type RowCache,
  type RowKey,
  type Sibling,
  type SyncContext,
  type SyncState,
  type SyncValue,
  type WriteMode,
} from './types.js';

// ---------- Register cursor ----------

export interface RegisterCursor {
  /** The explicit register, undefined when implicit or empty. */
  readonly reg: RegisterState | undefined;
  readonly sibs: readonly Sibling[];
  readonly pmem: Pmem | null;
}

const EMPTY_CURSOR: RegisterCursor = { reg: undefined, sibs: [], pmem: null };

/**
 * sibs and pmem of a register as the operation sees it. A row unknown in `base` stays empty
 * for every register of the operation, even after an earlier write of the same operation
 * created it (pmem starts from pmemOf BEFORE the write).
 */
export function cursorOf(b: StateBuilder, base: SyncState, key: RegKey, implicit: ImplicitProvider): RegisterCursor {
  const reg = b.register(key);
  if (reg) return { reg, sibs: reg.sibs, pmem: reg.pmem };
  if (!base.rows.has(rowKeyStr(key))) return EMPTY_CURSOR;
  return { reg: undefined, sibs: [implicit(key)], pmem: IMPLICIT_PMEM };
}

export function lifeKey(row: RowKey): RegKey {
  return regKey(row.tbl, row.rowId, LIFE_REG);
}

export function regId(key: RegKey): string {
  return `${rowKeyStr(key)}\u001f${key.reg}`;
}

/**
 * `sibs` without `w` and without every other sibling holding w's value (equal vhash). A writer
 * that saw w saw those too (they are in its state, so its vv or pmem covers them); leaving one
 * behind would keep the replaced value alive, e.g. turn a plain delete of a row two devices
 * re-asserted into an edit-versus-delete conflict (4.2 step 5, 4.3 rule 4).
 */
export function withoutSeenValue(sibs: readonly Sibling[], w: Sibling | null): readonly Sibling[] {
  return w === null ? sibs : sibs.filter((s) => s !== w && s.vhash !== w.vhash);
}

/** Siblings a new app sibling leaves in place, per WriteMode (spec 4.2 step 5). */
export function keptSiblings(mode: WriteMode, sibs: readonly Sibling[], prov: Sibling | null): readonly Sibling[] {
  switch (mode) {
    case 'replace-all':
      return [];
    case 'replace-provisional':
      return withoutSeenValue(sibs, prov);
    case 'reassert':
      return sibs.filter((s) => s.value !== LIFE_LIVE);
  }
}

// ---------- App writer ----------

/** Writes app siblings for one operation under one dot, into one StateBuilder. */
export class AppWriter {
  readonly builder: StateBuilder;
  private readonly base: SyncState;
  private readonly dot: AppDot;
  private readonly implicit: ImplicitProvider;
  private readonly written = new Set<string>();
  private readonly rows = new Map<string, RowKey>();

  constructor(base: SyncState, dot: AppDot, implicit: ImplicitProvider) {
    this.base = base;
    this.dot = dot;
    this.implicit = implicit;
    this.builder = new StateBuilder(base);
  }

  get count(): number {
    return this.written.size;
  }

  hasWritten(key: RegKey): boolean {
    return this.written.has(regId(key));
  }

  /** One new app sibling at the operation's dot; prevVhash = prev of the replaced provisional. */
  write(key: RegKey, value: SyncValue, vhash: string, flags: number, mode: WriteMode): void {
    const id = regId(key);
    if (this.written.has(id)) throw new Error(`sync capture: register written twice in one operation: ${id}`);
    const cur = cursorOf(this.builder, this.base, key, this.implicit);
    const prov = provisional(key.reg, cur.sibs);
    const s: Sibling = {
      dev: this.dot.dev,
      ms: this.dot.ms,
      c: this.dot.c,
      pid: '',
      lt: 0,
      vhash,
      flags,
      value,
      prevVhash: prov ? prevOf(prov.vhash) : null,
    };
    const sid = identityKey(s);
    const kept = keptSiblings(mode, cur.sibs, prov).filter((x) => identityKey(x) !== sid);
    this.builder.setRegister(makeRegister(key, [...kept, s], cur.pmem));
    this.written.add(id);
    this.rows.set(rowKeyStr(key), rowOf(key));
  }

  /** `_life = live|dead` for a row. */
  writeLife(row: RowKey, value: string, mode: WriteMode): void {
    const key = lifeKey(row);
    this.write(key, value, vhashOfValue(key, value), 0, mode);
  }

  /** vv[dot.dev] = dot and the dev record, once anything was written. */
  finish(ctx: Pick<SyncContext, 'deviceUuid' | 'now'>): { readonly state: SyncState; readonly changedRows: readonly RowKey[] } {
    if (this.written.size > 0) {
      this.builder.joinVv(this.dot.dev, this.dot);
      this.builder.addDev({ dev: this.dot.dev, deviceUuid: ctx.deviceUuid, startedMs: ctx.now() });
    }
    return { state: this.builder.build(), changedRows: [...this.rows.values()] };
  }
}

// ---------- Rule R ----------

function liveReferences(state: SyncState, row: RowKey): RowKey[] {
  const reg = row.tbl === TBL.entries ? 'credential_id' : row.tbl === TBL.history ? 'entry_id' : null;
  if (reg === null) return [];
  const value = provisionalValue(state, regKey(row.tbl, row.rowId, reg), null) ?? null;
  return referencedRows(row.tbl, new Map([[reg, value]])).filter((t) => rowLife(state, t) === 'live');
}

/**
 * Rule R targets of one row the operation left live, over the state after its register
 * changes: the row, its container chain as materialized, and the LIVE rows it references
 * (a dead reference materializes as NULL, so re-asserting it would resurrect a row the
 * operation never showed). Empty when the row is not a live content row.
 */
export function ruleRTargets(state: SyncState, row: RowKey): RowKey[] {
  if (!isContentTbl(row.tbl) || rowLife(state, row) !== 'live') return [];
  return [row, ...containerChain(state, row), ...liveReferences(state, row)];
}

/** Rule R for app writes: one `reassert` `_life = live` per target row not already written. */
export function applyAppRuleR(w: AppWriter, sources: Iterable<RowKey>): void {
  const list = [...sources];
  if (list.length === 0) return;
  const after = w.builder.snapshot();
  const done = new Set<string>();
  for (const src of list) {
    for (const t of ruleRTargets(after, src)) {
      const ks = rowKeyStr(t);
      if (done.has(ks)) continue;
      done.add(ks);
      if (!w.hasWritten(lifeKey(t))) w.writeLife(t, LIFE_LIVE, 'reassert');
    }
  }
}

// ---------- Rule H ----------

export interface RuleHContext {
  /** The state before the capture. */
  readonly state: SyncState;
  readonly cache: RowCache;
  /** Entries that died (or whose delete was held) in this capture. */
  readonly diedNow: ReadonlySet<string>;
  /** Entries inserted or resurrected in this capture. */
  readonly livedNow: ReadonlySet<string>;
}

const HISTORY_ENTRY_REG = 'entry_id';

/**
 * The entry a history row belongs to. A vanished row's entry_id head may hold a value the
 * loader read from content that is gone, so a head whose value does not hash to its vhash is
 * matched by hash against the entries that died in this capture.
 */
function historyEntry(ctx: RuleHContext, history: RowKey): RowKey | null {
  const key = regKey(TBL.history, history.rowId, HISTORY_ENTRY_REG);
  const reg = getRegister(ctx.state, key);
  const head = reg ? headOf(HISTORY_ENTRY_REG, reg.sibs) : null;
  if (head === null) return null;
  const id = asText(head.value);
  if (id && vhashOfValue(key, id) === head.vhash) return rowKey(TBL.entries, id);
  for (const ks of ctx.diedNow) {
    const row = parseRowKeyStr(ks);
    if (row.tbl === TBL.entries && vhashOfValue(key, row.rowId) === head.vhash) return row;
  }
  return null;
}

/**
 * Cascade rule H: a vanished password_history row counts as deleted only while its entry
 * stays live and materialized after this capture; otherwise its visibility follows the entry.
 */
export function historyDeleteRecorded(ctx: RuleHContext, history: RowKey): boolean {
  const entry = historyEntry(ctx, history);
  if (entry === null) return true;
  const ks = rowKeyStr(entry);
  if (ctx.diedNow.has(ks)) return false;
  if (ctx.livedNow.has(ks)) return true;
  if (rowLife(ctx.state, entry) !== 'live') return false;
  return ctx.cache.get(ks)?.materialized === true;
}
