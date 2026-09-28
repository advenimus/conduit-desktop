/**
 * Materialization (spec 4.6): turns the merged state into content rows legacy apps read.
 * Rows (live, dead, history hidden with its entry), provisional field values, container
 * fallbacks (dangling -> root, cycles -> highest-ranked mover to root, structural conflict),
 * credential_id fallback, NOT NULL fallbacks, updated_at, FK-safe write plan, sync_row
 * bookkeeping (materialized, raw_hash), `mat` overrides, graves, and vault_meta salt,
 * verification and key_source of the current epoch. Pure: returns a WritePlan that
 * state-store.saveState applies.
 */

import {
  CONTAINER_REG,
  CONTAINER_ROOT,
  CREDENTIAL_TYPE,
  EPOCH_ZERO_ISO,
  LIFE_DEAD,
  LIFE_REG,
  META_ROW_ID,
  asText,
  buildContentRow,
  fixedDef,
  isContentTbl,
  readContentRow,
  type RowRead,
} from './catalog.js';
import { rawHash } from './hashing.js';
import {
  collectLiveContent,
  isLiveRow,
  resolveContainersWith,
  type ContainerResolution,
  type LiveContent,
} from './materialize-containers.js';
import { planMeta } from './materialize-meta.js';
import { captureScope, lazyRawHash, type CaptureScope } from './materialize-scope.js';
import {
  applyRequiredFallbacks,
  columnsIdentical,
  matFor,
  readsEqual,
  registerValue,
  rowValues,
  updatedAtFor,
  withMat,
} from './materialize-values.js';
import { compareStr, isRedacted } from './sibling.js';
import { StateBuilder, provisional, rowKeyStr } from './state-view.js';
import {
  TBL,
  type ContentRow,
  type ContentSnapshot,
  type ContentTbl,
  type EntryRow,
  type EpochRecord,
  type FolderRow,
  type Grave,
  type HistoryRow,
  type ImplicitProvider,
  type MaterializeResult,
  type RowCache,
  type RowCacheEntry,
  type RowKey,
  type RowState,
  type SqlValue,
  type SyncState,
  type SyncValue,
} from './types.js';

export { resolveContainers, type ContainerResolution } from './materialize-containers.js';

export interface MaterializeContext {
  readonly implicit: ImplicitProvider;
  /** Current epoch record (salt, verification written to vault_meta); null leaves them untouched. */
  readonly currentEpoch: EpochRecord | null;
  /**
   * CaptureResult.scope of a per-operation capture (captureRows). Omit after a full pass. When
   * given, content rows outside it that changed since the cache are left untouched
   * (materialize-scope.ts), and vault_meta too unless the scope lists the meta row.
   */
  readonly capturedRows?: readonly RowKey[];
}

/** Placeholder while diffing; the real updated_at is derived only for rows that are written. */
const PENDING_UPDATED_AT = '';
const ENTRY_TYPE_DEF = fixedDef(TBL.entries, 'entry_type');
const ENTRY_ID_DEF = fixedDef(TBL.history, 'entry_id');

interface Run {
  readonly state: SyncState;
  readonly current: ContentSnapshot;
  readonly oldCache: RowCache;
  readonly effective: ReadonlyMap<string, string>;
  readonly live: LiveContent;
  readonly history: ReadonlySet<string>;
  readonly credentialOk: Map<string, boolean>;
  readonly builder: StateBuilder;
  readonly cache: Map<string, RowCacheEntry>;
  readonly upserts: { readonly [T in ContentTbl]: ContentRow[] };
  readonly scope: CaptureScope | null;
  /** Rows left exactly as they are (outside the capture scope and changed since the cache). */
  readonly untouched: Set<string>;
}

/** Deterministic: the same state and content always produce the same plan, cache and state. */
export function materialize(
  state: SyncState,
  current: ContentSnapshot,
  cache: RowCache,
  mctx: MaterializeContext,
): MaterializeResult {
  const live = collectLiveContent(state);
  const containers: ContainerResolution = resolveContainersWith(state, live);
  const run: Run = {
    state,
    current,
    oldCache: cache,
    effective: containers.effective,
    live,
    history: materializedHistory(state, live),
    credentialOk: new Map(),
    builder: new StateBuilder(state),
    cache: new Map(),
    upserts: { 1: [], 2: [], 3: [] },
    scope: captureScope(mctx.capturedRows, cache),
    untouched: new Set(),
  };
  for (const row of state.rows.values()) visitRow(run, row);
  const deletes = planDeletes(run);
  const metaLeft = run.scope !== null && !run.scope.metaCaptured;
  const meta = metaLeft ? new Map<string, string | null>() : planMeta(state, current, run.builder, mctx.currentEpoch);
  const upserts = { 1: sortById(run.upserts[1]), 2: sortById(run.upserts[2]), 3: sortById(run.upserts[3]) };
  return {
    state: run.builder.build(),
    plan: {
      upsertFolders: upserts[2] as FolderRow[],
      upsertEntries: upserts[1] as EntryRow[],
      upsertHistory: upserts[3] as HistoryRow[],
      deleteHistory: deletes[3],
      deleteEntries: deletes[1],
      deleteFolders: deletes[2],
      meta,
    },
    cache: finishCache(cache, run.cache),
    structural: containers.cycles,
    changedRows: changedRowsOf(upserts, deletes),
  };
}

/**
 * updated_at of a row whose content changes: ISO of the largest provisional app-dot ms or
 * pseudo lt among the row's explicit registers; `storedText` when that is 0; else the fallback.
 */
export function computeUpdatedAt(state: SyncState, rowKey: string, storedText: string | null, fallback: string): string {
  return updatedAtFor(state.rows.get(rowKey), storedText, fallback);
}

// ---------- Row status ----------

/** History rows are visible only while live and attached to a live (materialized) entry. */
function materializedHistory(state: SyncState, live: LiveContent): Set<string> {
  const out = new Set<string>();
  for (const row of state.rows.values()) {
    if (row.key.tbl !== TBL.history || !isLiveRow(row)) continue;
    const entryId = asText(registerValue(ENTRY_ID_DEF, row.regs.get(ENTRY_ID_DEF.reg)));
    if (entryId !== null && live.entries.has(entryId)) out.add(row.key.rowId);
  }
  return out;
}

function isMaterialized(run: Run, tbl: ContentTbl, rowId: string): boolean {
  if (tbl === TBL.folders) return run.live.folders.has(rowId);
  if (tbl === TBL.entries) return run.live.entries.has(rowId);
  return run.history.has(rowId);
}

function visitRow(run: Run, row: RowState): void {
  const tbl = row.key.tbl;
  if (isContentTbl(tbl)) {
    if (isMaterialized(run, tbl, row.key.rowId)) materializeRow(run, tbl, row);
    else retireRow(run, row);
    return;
  }
  if (tbl === TBL.meta && row.key.rowId === META_ROW_ID) return;
  clearMats(run.builder, row);
}

// ---------- Materialized rows ----------

function materializeRow(run: Run, tbl: ContentTbl, row: RowState): void {
  const cur = currentRow(run.current, tbl, row.key.rowId);
  const curHash = lazyRawHash(tbl, cur);
  if (run.scope?.leaves(row.key, cur, curHash)) return leaveUntouched(run, row.key);
  const values = rowValues(tbl, row);
  applyOverrides(run, tbl, row, values);
  applyRequiredFallbacks(tbl, values);
  const desired = buildContentRow(tbl, row.key.rowId, values, PENDING_UPDATED_AT);
  const keptRead = cur ? keepCurrent(run, tbl, desired, cur) : null;
  let finalRow: ContentRow;
  let read: RowRead;
  if (cur && keptRead) {
    finalRow = cur;
    read = keptRead;
  } else {
    finalRow = withUpdatedAt(tbl, desired, row, cur);
    read = readContentRow(tbl, finalRow);
    run.upserts[tbl].push(finalRow);
  }
  setMats(run.builder, row, read.values);
  if (row.grave !== null) run.builder.setGrave(row.key, null);
  setCache(run, row.key, true, finalRow === cur ? curHash() : rawHash(tbl, finalRow));
}

/** A row a writer that skipped the hook changed: no write, no delete, cache entry as it was. */
function leaveUntouched(run: Run, key: RowKey): void {
  const k = rowKeyStr(key);
  const old = run.oldCache.get(k);
  if (old !== undefined) run.cache.set(k, old);
  run.untouched.add(k);
}

function applyOverrides(run: Run, tbl: ContentTbl, row: RowState, values: Map<string, SyncValue>): void {
  if (tbl === TBL.history) return;
  values.set(CONTAINER_REG, run.effective.get(rowKeyStr(row.key)) ?? CONTAINER_ROOT);
  if (tbl !== TBL.entries) return;
  const cred = asText(values.get('credential_id') ?? null);
  values.set('credential_id', cred !== null && cred.length > 0 && isCredential(run, cred) ? cred : null);
}

function isCredential(run: Run, entryId: string): boolean {
  const memo = run.credentialOk.get(entryId);
  if (memo !== undefined) return memo;
  const target = run.state.rows.get(rowKeyStr({ tbl: TBL.entries, rowId: entryId }));
  const ok =
    run.live.entries.has(entryId) &&
    target !== undefined &&
    registerValue(ENTRY_TYPE_DEF, target.regs.get(ENTRY_TYPE_DEF.reg)) === CREDENTIAL_TYPE;
  run.credentialOk.set(entryId, ok);
  return ok;
}

function currentRow(current: ContentSnapshot, tbl: ContentTbl, rowId: string): ContentRow | undefined {
  if (tbl === TBL.entries) return current.entries.get(rowId);
  if (tbl === TBL.folders) return current.folders.get(rowId);
  return current.history.get(rowId);
}

/**
 * The current row is kept (no write, updated_at untouched) when every register reads back
 * canonically equal and none of its FK columns points at a row that will not exist.
 * Returns the current row's read when kept, else null.
 */
function keepCurrent(run: Run, tbl: ContentTbl, desired: ContentRow, cur: ContentRow): RowRead | null {
  if (!fkTargetsMaterialized(run, tbl, cur)) return null;
  const curRead = readContentRow(tbl, cur);
  if (columnsIdentical(tbl, desired, cur)) return curRead;
  return readsEqual(tbl, readContentRow(tbl, desired), curRead) ? curRead : null;
}

function fkTargetsMaterialized(run: Run, tbl: ContentTbl, cur: ContentRow): boolean {
  const ok = (v: SqlValue, target: ContentTbl): boolean => {
    const id = asText(v);
    return id === null || isMaterialized(run, target, id);
  };
  if (tbl === TBL.folders) return ok((cur as FolderRow).parent_id, TBL.folders);
  if (tbl === TBL.history) return ok((cur as HistoryRow).entry_id, TBL.entries);
  const e = cur as EntryRow;
  return ok(e.folder_id, TBL.folders) && ok(e.parent_entry_id, TBL.entries) && ok(e.credential_id, TBL.entries);
}

function withUpdatedAt(tbl: ContentTbl, desired: ContentRow, row: RowState, cur: ContentRow | undefined): ContentRow {
  if (tbl === TBL.history) return desired;
  const stored = cur ? asText((cur as EntryRow | FolderRow).updated_at) : null;
  const fallback = asText((desired as EntryRow | FolderRow).created_at) ?? EPOCH_ZERO_ISO;
  return { ...(desired as EntryRow | FolderRow), updated_at: updatedAtFor(row, stored, fallback) };
}

function setMats(builder: StateBuilder, row: RowState, readBack: ReadonlyMap<string, SyncValue>): void {
  for (const [name, reg] of row.regs) {
    const next = withMat(reg, matFor(reg, readBack.get(name) ?? null));
    if (next !== reg) builder.setRegister(next);
  }
}

function clearMats(builder: StateBuilder, row: RowState): void {
  for (const reg of row.regs.values()) {
    if (reg.mat !== undefined) builder.setRegister(withMat(reg, undefined));
  }
}

// ---------- Rows that do not materialize ----------

function retireRow(run: Run, row: RowState): void {
  const tbl = row.key.tbl as ContentTbl;
  const cur = currentRow(run.current, tbl, row.key.rowId);
  const left = cur !== undefined && run.scope?.leaves(row.key, cur, lazyRawHash(tbl, cur)) === true;
  if (left) return leaveUntouched(run, row.key);
  clearMats(run.builder, row);
  const grave = graveFor(row);
  if (grave !== row.grave) run.builder.setGrave(row.key, grave);
  setCache(run, row.key, false, null);
}

/**
 * Dead rows get a grave at their provisional dead dot. A redacted grave stays redacted while
 * every value sibling is still redacted (a concurrent second delete keeps it; a value written
 * after the redaction clears it), so row_json is never dropped for a value that still exists.
 */
function graveFor(row: RowState): Grave | null {
  const reg = row.regs.get(LIFE_REG);
  const p = reg ? provisional(LIFE_REG, reg.sibs) : null;
  if (p === null || p.value !== LIFE_DEAD) return null;
  const old = row.grave;
  const redacted = old !== null && old.redacted && allValuesRedacted(row);
  const same = old !== null && old.diedMs === p.ms && old.diedC === p.c && old.diedDev === p.dev && old.redacted === redacted;
  return same ? old : { diedMs: p.ms, diedC: p.c, diedDev: p.dev, redacted };
}

function allValuesRedacted(row: RowState): boolean {
  for (const [name, reg] of row.regs) {
    if (name !== LIFE_REG && !reg.sibs.every(isRedacted)) return false;
  }
  return true;
}

function planDeletes(run: Run): { readonly [T in ContentTbl]: string[] } {
  const pick = (tbl: ContentTbl, rows: ReadonlyMap<string, ContentRow>): string[] => {
    const out: string[] = [];
    for (const [id, cur] of rows) {
      if (!isMaterialized(run, tbl, id) && !isLeftAlone(run, tbl, id, cur)) out.push(id);
    }
    return out.sort(compareStr);
  };
  return {
    1: pick(TBL.entries, run.current.entries),
    2: pick(TBL.folders, run.current.folders),
    3: pick(TBL.history, run.current.history),
  };
}

/** Outside the capture scope: rows judged untouched, and rows the state does not know yet (inserts). */
function isLeftAlone(run: Run, tbl: ContentTbl, id: string, cur: ContentRow): boolean {
  if (run.scope === null) return false;
  const key = { tbl, rowId: id };
  const k = rowKeyStr(key);
  if (run.untouched.has(k)) return true;
  return !run.state.rows.has(k) && run.scope.leaves(key, cur, lazyRawHash(tbl, cur));
}

// ---------- Bookkeeping ----------

function setCache(run: Run, key: RowKey, materialized: boolean, hash: string | null): void {
  const k = rowKeyStr(key);
  const old = run.oldCache.get(k);
  const reuse = old !== undefined && old.materialized === materialized && old.rawHash === hash;
  run.cache.set(k, reuse ? old : { materialized, rawHash: hash });
}

function finishCache(old: RowCache, next: Map<string, RowCacheEntry>): RowCache {
  if (old.size !== next.size) return next;
  for (const [k, v] of next) {
    if (old.get(k) !== v) return next;
  }
  return old;
}

function sortById<T extends ContentRow>(rows: T[]): T[] {
  return rows.sort((a, b) => compareStr(a.id, b.id));
}

function changedRowsOf(
  upserts: { readonly [T in ContentTbl]: readonly ContentRow[] },
  deletes: { readonly [T in ContentTbl]: readonly string[] },
): RowKey[] {
  const out: RowKey[] = [];
  const push = (tbl: ContentTbl, ids: Iterable<string>): void => {
    for (const rowId of ids) out.push({ tbl, rowId });
  };
  push(TBL.folders, upserts[2].map((r) => r.id));
  push(TBL.entries, upserts[1].map((r) => r.id));
  push(TBL.history, upserts[3].map((r) => r.id));
  push(TBL.history, deletes[3]);
  push(TBL.entries, deletes[1]);
  push(TBL.folders, deletes[2]);
  return out;
}
