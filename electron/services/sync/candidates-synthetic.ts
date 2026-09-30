/**
 * Synthetic candidates (spec 4.9): content without matching sync tables (pre-sync files, the
 * iOS 1.0.5 sandbox, copies with another genesis, G3 leftovers) is diffed against M and every
 * difference is minted as an app sibling of a fresh dev_syn at (dev_syn, 0, 0). Never mints a
 * delete. Import through candidates.ts.
 */

import { LIFE_LIVE, LIFE_REG, isContentTbl, isDefaultValue, readContentRow, regKey, registerDef, rowKey } from './catalog.js';
import { compareRowKeys, isItemTbl, previewField, previewRow, provisionalView, regKeyOf, rowTitle } from './candidates-shared.js';
import { contentRowTime, contentTable, forEachContentRow, isGenesisSibling } from './genesis.js';
import { deriveSyntheticDev, vhashOfSecret, vhashOfValue, vhashUndecryptable } from './hashing.js';
import { encryptSecret, readSecret } from './key-epoch.js';
import { isPseudo, vvJoin } from './sibling.js';
import { makeRegister, pmemOf, provisional, rowKeyStr, rowLife, sibsOf, type RowLife } from './state-view.js';
import {
  SIB_UNDECRYPTABLE,
  SyncCoreError,
  type AppDot,
  type CandidatePreview,
  type CandidateRowValues,
  type CandidateRows,
  type CandidateSource,
  type CandidateValue,
  type ContentSnapshot,
  type ContentTbl,
  type Dev,
  type ImplicitProvider,
  type PreviewField,
  type PreviewRow,
  type RegKey,
  type RegisterState,
  type RowKey,
  type RowState,
  type Sibling,
  type SyncContext,
  type SyncState,
  type SyncValue,
} from './types.js';

const SYN_RANDOM_LEN = 16;
const SYN_DEV_ATTEMPTS = 3;
const GENESIS_LEFTOVERS: CandidateSource = 'genesis-leftovers';

export interface SyntheticOptions {
  readonly source: CandidateSource;
  readonly label: string;
  /** 1.0.5 sandbox, pre-sync files and G3 leftovers: only rows newer than M's row count. */
  readonly staleByNature: boolean;
}

export interface SyntheticCandidate {
  readonly dev: Dev;
  /** (dev_syn, 0, 0): one dot for the whole import. */
  readonly dot: AppDot;
  /** M restricted to the touched rows plus the minted siblings (see buildSyntheticFromRows). */
  readonly state: SyncState;
  readonly preview: CandidatePreview;
}

// ---------- Reading candidate content ----------

/**
 * Reads candidate content into CandidateRows: catalog values per row, vhash under the current
 * epoch (secrets decrypted with ctx.keys ring and re-encrypted under the current epoch;
 * undecryptable ones flagged), rowTimeMs = parsed updated_at (changed_at for history).
 * vault_meta is not read: a copy never overrides the vault's id or backup setting.
 */
export function candidateRowsFromContent(candidate: ContentSnapshot, ctx: SyncContext): CandidateRows {
  const out = new Map<string, CandidateRowValues>();
  forEachContentRow(candidate, (tbl, row) => {
    const key = rowKey(tbl, row.id);
    const values = new Map<string, CandidateValue>();
    for (const [reg, v] of readContentRow(tbl, row).values) {
      const rk = regKey(tbl, row.id, reg);
      const def = registerDef(rk);
      if (!def) continue;
      values.set(reg, def.secret ? secretCandidateValue(rk, v, ctx) : { value: v, vhash: vhashOfValue(rk, v), flags: 0 });
    }
    out.set(rowKeyStr(key), { row: key, rowTimeMs: contentRowTime(tbl, row), values });
  });
  return out;
}

function secretCandidateValue(key: RegKey, v: SyncValue, ctx: SyncContext): CandidateValue {
  const current = ctx.keys.current;
  if (!(v instanceof Uint8Array) || v.length === 0) {
    return { value: null, vhash: vhashOfSecret(key, null, current.kSync), flags: 0 };
  }
  const read = readSecret(v, ctx.keys);
  if (read.kind === 'undecryptable') return { value: v, vhash: vhashUndecryptable(v), flags: SIB_UNDECRYPTABLE };
  const value = read.kind === 'current' ? v : encryptSecret(read.plaintext, current, ctx.randomBytes);
  return { value, vhash: vhashOfSecret(key, read.plaintext, current.kSync), flags: 0 };
}

// ---------- Minting ----------

interface MintEnv {
  readonly m: SyncState;
  readonly mContent: ContentSnapshot;
  readonly implicit: ImplicitProvider;
  readonly dot: AppDot;
  readonly staleByNature: boolean;
  /**
   * G3 leftovers: staleness is judged per register against the time of M's value (which came
   * from the shared file), not M's row time, which includes W's own edits since its genesis.
   */
  readonly perRegister: boolean;
}

interface MintedRow {
  readonly row: RowState;
  /** 'new': unknown in M; 'restore': dead in M; 'edit': live in M. */
  readonly kind: 'new' | 'restore' | 'edit';
  readonly fields: readonly PreviewField[];
}

/**
 * The synthetic rules of 4.9 over register values. The returned state is M restricted to the
 * touched rows (their RowStates copied, so no implicit register asserts a default) plus one
 * minted sibling (dev_syn, 0, 0) per differing register, vv = M.vv + {dev_syn: (0, 0)},
 * devs = M.devs + dev_syn. `mContent` gives M's row times (updated_at). Only content rows
 * (tbl 1-3) are considered. For stale-by-nature candidates a row M holds (live or dead) counts
 * only when the candidate's row time is newer than M's; rows M never saw always count.
 */
export function buildSyntheticFromRows(
  m: SyncState,
  mContent: ContentSnapshot,
  rows: CandidateRows,
  opts: SyntheticOptions,
  ctx: SyncContext,
  implicit: ImplicitProvider,
): SyntheticCandidate {
  const dev = freshSyntheticDev(m, ctx);
  const dot: AppDot = { dev, ms: 0, c: 0 };
  const perRegister = opts.staleByNature && opts.source === GENESIS_LEFTOVERS;
  const env: MintEnv = { m, mContent, implicit, dot, staleByNature: opts.staleByNature, perRegister };
  const outRows = new Map<string, RowState>();
  const changedFields: PreviewField[] = [];
  const onlyInCopy: PreviewRow[] = [];
  for (const [k, cand] of rows) {
    if (!isContentTbl(cand.row.tbl)) continue;
    const minted = mintRow(cand, env);
    if (!minted) continue;
    outRows.set(k, minted.row);
    if (minted.kind === 'edit') changedFields.push(...minted.fields);
    else if (isItemTbl(cand.row.tbl)) onlyInCopy.push(previewRow(cand.row, candidateTitle(m, cand)));
  }
  const state: SyncState = {
    lineageId: m.lineageId,
    genesisId: m.genesisId,
    createdMs: m.createdMs,
    vv: vvJoin(m.vv, new Map([[dev, { ms: dot.ms, c: dot.c }]])),
    devs: new Map(m.devs).set(dev, { dev, deviceUuid: ctx.deviceUuid, startedMs: ctx.now() }),
    rows: outRows,
    epochs: m.epochs,
    wraps: m.wraps,
  };
  const missingFromCopy = opts.source === GENESIS_LEFTOVERS ? [] : missingRows(m, rows);
  const preview: CandidatePreview = {
    kind: 'synthetic',
    source: opts.source,
    label: opts.label,
    changedFields,
    onlyInCopy,
    missingFromCopy,
    deletions: [],
    needsReview: true,
  };
  return { dev, dot, state, preview };
}

/** candidateRowsFromContent + buildSyntheticFromRows. */
export function buildSyntheticCandidate(
  m: SyncState,
  mContent: ContentSnapshot,
  candidate: ContentSnapshot,
  opts: SyntheticOptions,
  ctx: SyncContext,
  implicit: ImplicitProvider,
): SyntheticCandidate {
  return buildSyntheticFromRows(m, mContent, candidateRowsFromContent(candidate, ctx), opts, ctx, implicit);
}

/** Any existing vv entry for dev_syn would cover (dev_syn, 0, 0) and silently drop every minted sibling. */
function freshSyntheticDev(m: SyncState, ctx: SyncContext): Dev {
  for (let i = 0; i < SYN_DEV_ATTEMPTS; i++) {
    const dev = deriveSyntheticDev(ctx.deviceUuid, ctx.randomBytes(SYN_RANDOM_LEN));
    if (!m.vv.has(dev) && !m.devs.has(dev)) return dev;
  }
  throw new SyncCoreError('DEV_COLLISION', 'synthetic candidate: no fresh dev_syn');
}

/** Whole-row staleness: every stale-by-nature row, and G3 rows M holds dead (the delete is newer). */
function staleRow(env: MintEnv, cand: CandidateRowValues, life: RowLife): boolean {
  if (!env.staleByNature || (env.perRegister && life === 'live')) return false;
  return cand.rowTimeMs <= mRowTime(env, cand.row, life);
}

function mintRow(cand: CandidateRowValues, env: MintEnv): MintedRow | null {
  const life = rowLife(env.m, cand.row);
  if (life === 'unknown') return mintNewRow(cand, env);
  if (staleRow(env, cand, life)) return null;
  const mRow = env.m.rows.get(rowKeyStr(cand.row)) as RowState;
  const regs = new Map(mRow.regs);
  const fields: PreviewField[] = [];
  const title = rowTitle(env.m, cand.row);
  const genesisMs = env.perRegister ? rowGenesisTime(mRow) : 0;
  for (const [reg, cv] of cand.values) {
    if (reg === LIFE_REG) continue;
    const key = regKeyOf(cand.row, reg);
    const cur = registerDef(key) ? provisionalView(env.m, key, env.implicit) : null;
    if (!cur || cur.vhash === cv.vhash) continue;
    if (env.perRegister && cand.rowTimeMs <= registerTime(mRow, reg, genesisMs)) continue;
    regs.set(reg, withMinted(key, env, mintedSibling(cv, cand.rowTimeMs, env.dot)));
    fields.push(previewField(key, title, cur.value, cv.value));
  }
  if (life === 'dead') {
    const lifeKey = regKeyOf(cand.row, LIFE_REG);
    regs.set(LIFE_REG, withMinted(lifeKey, env, liveSibling(lifeKey, cand.rowTimeMs, env.dot)));
    return { row: { key: mRow.key, regs, grave: mRow.grave }, kind: 'restore', fields };
  }
  return fields.length === 0 ? null : { row: { key: mRow.key, regs, grave: mRow.grave }, kind: 'edit', fields };
}

/** A row M has never seen: every non-default register plus `_life = live`, pmem empty. */
function mintNewRow(cand: CandidateRowValues, env: MintEnv): MintedRow {
  const regs = new Map<string, RegisterState>();
  for (const [reg, cv] of cand.values) {
    if (reg === LIFE_REG) continue;
    const key = regKeyOf(cand.row, reg);
    const def = registerDef(key);
    if (!def) continue;
    const isDefault = def.secret ? cv.vhash === env.implicit(key).vhash : isDefaultValue(def, cv.value);
    if (!isDefault) regs.set(reg, makeRegister(key, [mintedSibling(cv, cand.rowTimeMs, env.dot)], null));
  }
  const lifeKey = regKeyOf(cand.row, LIFE_REG);
  regs.set(LIFE_REG, makeRegister(lifeKey, [liveSibling(lifeKey, cand.rowTimeMs, env.dot)], null));
  return { row: { key: cand.row, regs, grave: null }, kind: 'new', fields: [] };
}

/** M's siblings (the implicit one included, so merging never drops it) plus the minted one; pmem unchanged. */
function withMinted(key: RegKey, env: MintEnv, minted: Sibling): RegisterState {
  return makeRegister(key, [...sibsOf(env.m, key, env.implicit), minted], pmemOf(env.m, key));
}

/** lt carries the candidate row's time (4.9); ms 0 keeps M's values provisional over app edits. */
function mintedSibling(cv: CandidateValue, lt: number, dot: AppDot): Sibling {
  return { dev: dot.dev, ms: dot.ms, c: dot.c, pid: '', lt, vhash: cv.vhash, flags: cv.flags, value: cv.value, prevVhash: null };
}

function liveSibling(lifeKey: RegKey, lt: number, dot: AppDot): Sibling {
  return mintedSibling({ value: LIFE_LIVE, vhash: vhashOfValue(lifeKey, LIFE_LIVE), flags: 0 }, lt, dot);
}

// ---------- Row times and preview ----------

/** M's row time: content updated_at (changed_at for history); graves: died ms. */
function mRowTime(env: MintEnv, row: RowKey, life: RowLife): number {
  const mRow = env.m.rows.get(rowKeyStr(row));
  if (!mRow) return 0;
  if (life === 'dead') return mRow.grave?.diedMs ?? deadSiblingMs(mRow);
  const content = contentTable(env.mContent, row.tbl as ContentTbl).get(row.rowId);
  return content ? contentRowTime(row.tbl as ContentTbl, content) : stateRowTime(mRow);
}

function siblingTime(s: Sibling): number {
  return isPseudo(s) ? s.lt : s.ms;
}

/** Time of M's value of one register: its provisional sibling, or the row's genesis time when implicit. */
function registerTime(row: RowState, reg: string, genesisMs: number): number {
  const state = row.regs.get(reg);
  if (!state) return genesisMs;
  const p = provisional(reg, state.sibs);
  return p ? siblingTime(p) : 0;
}

/** The row's pre-sync time in M's genesis: the largest lt among its genesis pseudo siblings. */
function rowGenesisTime(row: RowState): number {
  let t = 0;
  for (const reg of row.regs.values()) {
    for (const s of reg.sibs) if (isGenesisSibling(s)) t = Math.max(t, s.lt);
  }
  return t;
}

function deadSiblingMs(row: RowState): number {
  const reg = row.regs.get(LIFE_REG);
  return reg ? provisional(LIFE_REG, reg.sibs)?.ms ?? 0 : 0;
}

/** Same rule materialize uses for updated_at: max provisional app ms or pseudo lt. */
function stateRowTime(row: RowState): number {
  let t = 0;
  for (const reg of row.regs.values()) {
    const p = provisional(reg.key.reg, reg.sibs);
    if (p) t = Math.max(t, siblingTime(p));
  }
  return t;
}

function candidateTitle(m: SyncState, cand: CandidateRowValues): string {
  const own = rowTitle(m, cand.row);
  if (own.length > 0) return own;
  const name = cand.values.get('name')?.value;
  return typeof name === 'string' ? name : '';
}

/** Live items of M the candidate does not have ("Items missing from this copy"). */
function missingRows(m: SyncState, rows: CandidateRows): PreviewRow[] {
  const out: RowKey[] = [];
  for (const [k, row] of m.rows) {
    if (isItemTbl(row.key.tbl) && !rows.has(k) && rowLife(m, row.key) === 'live') out.push(row.key);
  }
  return out.sort(compareRowKeys).map((r) => previewRow(r, rowTitle(m, r)));
}
