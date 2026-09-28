/**
 * Read-only accessors over SyncState (explicit, implicit and empty registers, provisional
 * choice, row life) and StateBuilder, the copy-on-write builder every module uses to produce
 * a new immutable SyncState. Fully implemented; spec 3.4, 4.5 (sibs, provisional value).
 */

import {
  CONTAINER_REG,
  CONTAINER_ROOT,
  IMPLICIT_PMEM,
  LIFE_LIVE,
  LIFE_REG,
  containerTarget,
  epochRegKey,
  regKey,
} from './catalog.js';
import { compareIdentity, compareRank, identityKey, isEligible, pmemEquals, vvJoin } from './sibling.js';
import { TBL, ZERO_PID } from './types.js';
import type {
  Dev,
  DevRecord,
  EpochRecord,
  Grave,
  Hlc,
  ImplicitProvider,
  Pmem,
  RegKey,
  RegisterState,
  RowKey,
  RowState,
  Sibling,
  SyncState,
  SyncValue,
  Tbl,
  WrapRecord,
} from './types.js';

const EMPTY_SIBS: readonly Sibling[] = Object.freeze([]);
const EMPTY_REGS: ReadonlyMap<string, RegisterState> = new Map();

// ---------- Key strings ----------

/** Map key of SyncState.rows. The tbl is one digit, so splitting at the first ':' is unambiguous. */
export function rowKeyStr(key: RowKey): string {
  return `${key.tbl}:${key.rowId}`;
}

export function parseRowKeyStr(s: string): RowKey {
  const i = s.indexOf(':');
  return { tbl: Number(s.slice(0, i)) as Tbl, rowId: s.slice(i + 1) };
}

/** Unambiguous register key string for UI, snooze and local.json use. */
export function regKeyStr(key: RegKey): string {
  return JSON.stringify([key.tbl, key.rowId, key.reg]);
}

export function wrapKeyStr(w: WrapRecord): string {
  return `${w.epochId}:${w.targetEpoch}:${w.wrap}`;
}

export function rowOf(key: RegKey): RowKey {
  return { tbl: key.tbl, rowId: key.rowId };
}

// ---------- Accessors ----------

export function emptyState(lineageId: string, genesisId: string, createdMs: number): SyncState {
  return {
    lineageId,
    genesisId,
    createdMs,
    vv: new Map(),
    devs: new Map(),
    rows: new Map(),
    epochs: new Map(),
    wraps: new Map(),
  };
}

export function getRow(state: SyncState, key: RowKey): RowState | undefined {
  return state.rows.get(rowKeyStr(key));
}

/** The explicit register, or undefined when implicit or when the row is unknown. */
export function getRegister(state: SyncState, key: RegKey): RegisterState | undefined {
  return state.rows.get(rowKeyStr(key))?.regs.get(key.reg);
}

export type RegisterPresence = 'explicit' | 'implicit' | 'empty';

export function registerPresence(state: SyncState, key: RegKey): RegisterPresence {
  const row = state.rows.get(rowKeyStr(key));
  if (!row) return 'empty';
  return row.regs.has(key.reg) ? 'explicit' : 'implicit';
}

/** The explicit sibling with this identityKey, if the state carries it. */
export function findSibling(state: SyncState, key: RegKey, identity: string): Sibling | undefined {
  return getRegister(state, key)?.sibs.find((s) => identityKey(s) === identity);
}

/** ValueRecovery over another replica (usually W) for capture-legacy (att.recover). */
export function recoveryFrom(state: SyncState): (key: RegKey, identity: string) => SyncValue | undefined {
  return (key, identity) => findSibling(state, key, identity)?.value;
}

/** sibs(X, k) of spec 4.5: explicit siblings, [implicit sibling], or []. */
export function sibsOf(state: SyncState, key: RegKey, implicit: ImplicitProvider): readonly Sibling[] {
  const row = state.rows.get(rowKeyStr(key));
  if (!row) return EMPTY_SIBS;
  const reg = row.regs.get(key.reg);
  return reg ? reg.sibs : [implicit(key)];
}

/** pmem(X, k): explicit memory, the implicit memory {0, {zero pid}}, or null for unknown rows. */
export function pmemOf(state: SyncState, key: RegKey): Pmem | null {
  const row = state.rows.get(rowKeyStr(key));
  if (!row) return null;
  const reg = row.regs.get(key.reg);
  return reg ? reg.pmem : IMPLICIT_PMEM;
}

function best(sibs: readonly Sibling[], accept: (s: Sibling) => boolean): Sibling | null {
  let top: Sibling | null = null;
  for (const s of sibs) {
    if (accept(s) && (top === null || compareRank(s, top) > 0)) top = s;
  }
  return top;
}

/**
 * Provisional sibling (4.5): for `_life`, the highest-rank eligible `live` sibling if any;
 * otherwise the highest-rank eligible sibling. Null when every sibling is undecryptable or redacted.
 */
export function provisional(reg: string, sibs: readonly Sibling[]): Sibling | null {
  if (reg === LIFE_REG) {
    const live = best(sibs, (s) => isEligible(s) && s.value === LIFE_LIVE);
    if (live) return live;
  }
  return best(sibs, isEligible);
}

/** The sibling stored in sync_reg: the provisional one, else the highest-rank sibling. */
export function headOf(reg: string, sibs: readonly Sibling[]): Sibling | null {
  return provisional(reg, sibs) ?? best(sibs, () => true);
}

/**
 * Provisional logical value of a register: undefined when the row is unknown, the catalog
 * default when implicit or when no sibling is eligible (redacted-only registers, 4.7).
 */
export function provisionalValue(state: SyncState, key: RegKey, defaultValue: SyncValue): SyncValue | undefined {
  const row = state.rows.get(rowKeyStr(key));
  if (!row) return undefined;
  const reg = row.regs.get(key.reg);
  if (!reg) return defaultValue;
  const p = provisional(key.reg, reg.sibs);
  return p === null ? defaultValue : p.value;
}

export type RowLife = 'live' | 'dead' | 'unknown';

/** Provisional `_life` of a row (implicit `_life` is live). */
export function rowLife(state: SyncState, key: RowKey): RowLife {
  const row = state.rows.get(rowKeyStr(key));
  if (!row) return 'unknown';
  const reg = row.regs.get(LIFE_REG);
  if (!reg) return 'live';
  return provisional(LIFE_REG, reg.sibs)?.value === LIFE_LIVE ? 'live' : 'dead';
}

/** Provisional value of `_sync/key/epoch`, or null when the state has no epoch register. */
export function currentEpochId(state: SyncState): string | null {
  const v = provisionalValue(state, epochRegKey(), null);
  return typeof v === 'string' ? v : null;
}

/**
 * True when an explicit register carries exactly the implicit form (one unredacted
 * genesis sibling with the zero pid and pmem {0, {zero pid}}). Such registers must be
 * stored as implicit (removed from RowState.regs) so equal states compare equal.
 */
export function isImplicitEquivalent(reg: RegisterState): boolean {
  if (reg.sibs.length !== 1) return false;
  const s = reg.sibs[0];
  return s.dev === 0 && s.ms === 0 && s.pid === ZERO_PID && s.flags === 0 && pmemEquals(reg.pmem, IMPLICIT_PMEM);
}

/**
 * Rule R container chain (4.2 step 4): the live ancestors of a folder or entry, following
 * provisional `container` values. Stops at root, at a target that is not live (it would
 * materialize at root) and at a repeated node (a cycle), so it matches what materializes.
 */
export function containerChain(state: SyncState, row: RowKey): RowKey[] {
  const out: RowKey[] = [];
  if (row.tbl !== TBL.entries && row.tbl !== TBL.folders) return out;
  const seen = new Set([rowKeyStr(row)]);
  let cur: RowKey = row;
  for (;;) {
    const target = containerTarget(provisionalValue(state, regKey(cur.tbl, cur.rowId, CONTAINER_REG), CONTAINER_ROOT) ?? null);
    if (target === null) return out;
    const k = rowKeyStr(target);
    if (seen.has(k) || rowLife(state, target) !== 'live') return out;
    seen.add(k);
    out.push(target);
    cur = target;
  }
}

// ---------- Builder ----------

interface PendingRow {
  readonly key: RowKey;
  readonly base: RowState | undefined;
  regs: Map<string, RegisterState> | null;
  grave: Grave | null | undefined;
}

/**
 * Copy-on-write builder. Reads see pending writes. build() returns `base` itself when nothing
 * changed, and keeps every untouched RowState object, so state-store can diff by reference.
 */
export class StateBuilder {
  private readonly base: SyncState;
  private readonly pending = new Map<string, PendingRow>();
  private vv: Map<Dev, Hlc> | null = null;
  private devs: Map<Dev, DevRecord> | null = null;
  private epochs: Map<string, EpochRecord> | null = null;
  private wraps: Map<string, WrapRecord> | null = null;
  private header: Pick<SyncState, 'lineageId' | 'genesisId' | 'createdMs'> | null = null;

  constructor(base: SyncState) {
    this.base = base;
  }

  row(key: RowKey): RowState | undefined {
    const k = rowKeyStr(key);
    const p = this.pending.get(k);
    if (!p) return this.base.rows.get(k);
    if (p.base && p.regs === null && p.grave === undefined) return p.base;
    return {
      key: p.key,
      regs: p.regs ?? p.base?.regs ?? EMPTY_REGS,
      grave: p.grave === undefined ? p.base?.grave ?? null : p.grave,
    };
  }

  hasRow(key: RowKey): boolean {
    return this.pending.has(rowKeyStr(key)) || this.base.rows.has(rowKeyStr(key));
  }

  register(key: RegKey): RegisterState | undefined {
    const p = this.pending.get(rowKeyStr(key));
    if (p?.regs) return p.regs.get(key.reg);
    return (p ? p.base : this.base.rows.get(rowKeyStr(key)))?.regs.get(key.reg);
  }

  /** A view of the state as built so far, for accessors like sibsOf(). O(rows) per call. */
  snapshot(): SyncState {
    return this.build();
  }

  ensureRow(key: RowKey): void {
    this.touch(key);
  }

  setRegister(reg: RegisterState): void {
    const p = this.touch(reg.key);
    if (p.regs === null) p.regs = new Map(p.base?.regs ?? EMPTY_REGS);
    p.regs.set(reg.key.reg, reg);
  }

  /** Makes the register implicit again (the row stays known). */
  removeRegister(key: RegKey): void {
    const p = this.touch(key);
    if (p.regs === null) p.regs = new Map(p.base?.regs ?? EMPTY_REGS);
    p.regs.delete(key.reg);
  }

  setGrave(key: RowKey, grave: Grave | null): void {
    this.touch(key).grave = grave;
  }

  /** vv[dev] = max(vv[dev], stamp). */
  joinVv(dev: Dev, stamp: Hlc): void {
    const cur = (this.vv ?? this.base.vv).get(dev);
    if (cur && (cur.ms > stamp.ms || (cur.ms === stamp.ms && cur.c >= stamp.c))) return;
    if (this.vv === null) this.vv = new Map(this.base.vv);
    this.vv.set(dev, { ms: stamp.ms, c: stamp.c });
  }

  joinVvAll(vv: ReadonlyMap<Dev, Hlc>): void {
    const joined = vvJoin(this.vv ?? this.base.vv, vv);
    if (joined !== (this.vv ?? this.base.vv)) this.vv = new Map(joined);
  }

  addDev(rec: DevRecord): void {
    if ((this.devs ?? this.base.devs).has(rec.dev)) return;
    if (this.devs === null) this.devs = new Map(this.base.devs);
    this.devs.set(rec.dev, rec);
  }

  setEpoch(rec: EpochRecord): void {
    if (this.epochs === null) this.epochs = new Map(this.base.epochs);
    this.epochs.set(rec.epochId, rec);
  }

  addWrap(rec: WrapRecord): void {
    const k = wrapKeyStr(rec);
    if ((this.wraps ?? this.base.wraps).has(k)) return;
    if (this.wraps === null) this.wraps = new Map(this.base.wraps);
    this.wraps.set(k, rec);
  }

  setHeader(header: Pick<SyncState, 'lineageId' | 'genesisId' | 'createdMs'>): void {
    this.header = header;
  }

  build(): SyncState {
    const rows = this.buildRows();
    const unchanged =
      rows === this.base.rows && !this.vv && !this.devs && !this.epochs && !this.wraps && !this.header;
    if (unchanged) return this.base;
    return {
      lineageId: this.header?.lineageId ?? this.base.lineageId,
      genesisId: this.header?.genesisId ?? this.base.genesisId,
      createdMs: this.header?.createdMs ?? this.base.createdMs,
      vv: this.vv ? new Map(this.vv) : this.base.vv,
      devs: this.devs ? new Map(this.devs) : this.base.devs,
      rows,
      epochs: this.epochs ? new Map(this.epochs) : this.base.epochs,
      wraps: this.wraps ? new Map(this.wraps) : this.base.wraps,
    };
  }

  private touch(key: RowKey): PendingRow {
    const k = rowKeyStr(key);
    let p = this.pending.get(k);
    if (!p) {
      p = { key: { tbl: key.tbl, rowId: key.rowId }, base: this.base.rows.get(k), regs: null, grave: undefined };
      this.pending.set(k, p);
    }
    return p;
  }

  private buildRows(): ReadonlyMap<string, RowState> {
    let out: Map<string, RowState> | null = null;
    for (const [k, p] of this.pending) {
      const next = finishRow(p);
      if (next === p.base) continue;
      if (out === null) out = new Map(this.base.rows);
      out.set(k, next);
    }
    return out ?? this.base.rows;
  }
}

function finishRow(p: PendingRow): RowState {
  const baseRegs = p.base?.regs;
  let regs: ReadonlyMap<string, RegisterState>;
  if (p.regs === null) regs = baseRegs ?? new Map();
  else if (baseRegs && sameRegs(baseRegs, p.regs)) regs = baseRegs;
  else regs = new Map(p.regs);
  const grave = p.grave === undefined ? p.base?.grave ?? null : p.grave;
  if (p.base && regs === p.base.regs && grave === p.base.grave) return p.base;
  return { key: p.key, regs, grave };
}

function sameRegs(a: ReadonlyMap<string, RegisterState>, b: ReadonlyMap<string, RegisterState>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of b) {
    if (a.get(k) !== v) return false;
  }
  return true;
}

/** Builds a RegisterState with siblings in canonical order. */
export function makeRegister(key: RegKey, sibs: readonly Sibling[], pmem: Pmem | null): RegisterState {
  return { key, sibs: [...sibs].sort(compareIdentity), pmem };
}
