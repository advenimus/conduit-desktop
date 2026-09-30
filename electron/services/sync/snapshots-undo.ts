/**
 * Targeted undo of one merge (spec 5.10, red team #5, 12 row 43): only the rows that merge
 * deleted (when still dead) and only the fields it changed (when they still hold the merged
 * value). Everything else stays as it is. Pure over the loaded diff; import through snapshots.ts.
 */

import { canonEqual } from './canonical.js';
import { LIFE_LIVE, LIFE_REG, asBlob, registerDef, registerLabel } from './catalog.js';
import { prepareWrite } from './capture-local.js';
import { readSecret } from './key-epoch.js';
import { getRegister, provisional, regKeyStr, rowKeyStr, rowLife, rowOf } from './state-view.js';
import { decodeValue, type EncodedValue } from './value-codec.js';
import type { SnapshotFile } from './snapshots-codec.js';
import type { ChangedFieldRecord, DeletedRowRecord, UndoChoice, UndoPreview } from './snapshots-types.js';
import type { KeyRing, LocalWrite, RegKey, RowKey, SyncContext, SyncState, SyncValue, WriteMode } from './types.js';

const REPLACE_ALL = 'replace-all';
/**
 * A dead row keeps every sibling of its registers (4.7), open conflicts included; a re-created
 * row replaces only the provisional value, as "Recently deleted" does, so they survive the undo.
 */
const RESTORED_VALUE_MODE = 'replace-provisional';

export interface UndoWritesResult {
  readonly writes: readonly LocalWrite[];
  /** Snapshot secrets no ring key could open: skipped. */
  readonly unreadableSecrets: number;
  /** Chosen rows or fields not in the snapshot, rows live again, or fields no longer merged. */
  readonly ignored: number;
}

export function buildUndoPreview(snapshotId: string, file: SnapshotFile, current: SyncState, ring?: KeyRing): UndoPreview {
  return {
    snapshotId,
    rows: file.diff.deleted
      .filter((r) => !erasedForever(current, r.row))
      .map((r) => ({ row: r.row, title: r.title, stillDeleted: rowLife(current, r.row) !== 'live' })),
    fields: file.diff.changed.map((c) => ({
      key: c.key,
      label: registerLabel(c.key),
      stillMerged: isStillMerged(current, c, ring),
      secret: c.secret,
    })),
  };
}

export function buildUndoWrites(
  file: SnapshotFile,
  current: SyncState,
  choice: UndoChoice,
  ring: KeyRing,
  ctx: SyncContext,
): UndoWritesResult {
  const out = new UndoWriter(ring, ctx);
  const deletedByRow = new Map(file.diff.deleted.map((r) => [rowKeyStr(r.row), r] as const));
  const changedByKey = new Map(file.diff.changed.map((c) => [regKeyStr(c.key), c] as const));
  let ignored = 0;
  for (const k of new Set(choice.rows.map(rowKeyStr))) {
    const rec = deletedByRow.get(k);
    if (rec === undefined || rowLife(current, rec.row) === 'live' || erasedForever(current, rec.row)) ignored++;
    else out.restoreRow(rec);
  }
  for (const k of new Set(choice.fields.map(regKeyStr))) {
    const rec = changedByKey.get(k);
    if (rec === undefined || !isStillMerged(current, rec, ring)) ignored++;
    else out.value(rec.key, rec.before);
  }
  return { writes: out.writes, unreadableSecrets: out.unreadable, ignored: ignored + out.unknownRegisters };
}

/**
 * What the user undid, counted as they chose it: one per re-created row (its `_life` write plus
 * every value write of that row) and one per reverted field. writes.length counts registers.
 */
export function countUndone(writes: readonly LocalWrite[]): number {
  const rows = new Set(writes.filter((w) => w.key.reg === LIFE_REG).map((w) => rowKeyStr(w.key)));
  return rows.size + writes.filter((w) => !rows.has(rowKeyStr(w.key))).length;
}

/** "Delete permanently" (4.7) redacted the row's grave: the snapshot must not bring it back. */
function erasedForever(current: SyncState, row: RowKey): boolean {
  return current.rows.get(rowKeyStr(row))?.grave?.redacted === true;
}

/** The field's row is live and its current provisional value equals the merged value. */
function isStillMerged(current: SyncState, rec: ChangedFieldRecord, ring?: KeyRing): boolean {
  const def = registerDef(rec.key);
  if (def === null || rowLife(current, rowOf(rec.key)) !== 'live') return false;
  const value = currentValue(current, rec.key, def.defaultValue);
  if (value === undefined) return false;
  const after = decodeValue(rec.after);
  return def.secret ? secretEqual(value, after, ring) : canonEqual(def, value, after);
}

/** Provisional value as materialize sees it; undefined for unknown rows or no eligible sibling. */
function currentValue(state: SyncState, key: RegKey, defaultValue: SyncValue): SyncValue | undefined {
  if (!state.rows.has(rowKeyStr(key))) return undefined;
  const reg = getRegister(state, key);
  if (reg === undefined) return defaultValue;
  const p = provisional(key.reg, reg.sibs);
  return p === null ? undefined : p.value;
}

/** Same ciphertext bytes, or (with a ring) the same plaintext; empty and NULL are equal. */
function secretEqual(a: SyncValue, b: SyncValue, ring?: KeyRing): boolean {
  const ca = asBlob(a);
  const cb = asBlob(b);
  if (ca === null && cb === null) return true;
  if (ca !== null && cb !== null && Buffer.from(ca).equals(Buffer.from(cb))) return true;
  if (ring === undefined) return false;
  const pa = plaintextOf(ca, ring);
  return pa !== null && pa === plaintextOf(cb, ring);
}

/** '' for no secret, null when no ring key opens it. */
function plaintextOf(ct: Uint8Array | null, ring: KeyRing): string | null {
  if (ct === null) return '';
  const read = readSecret(ct, ring);
  return read.kind === 'undecryptable' ? null : read.plaintext;
}

class UndoWriter {
  readonly writes: LocalWrite[] = [];
  unreadable = 0;
  unknownRegisters = 0;

  constructor(
    private readonly ring: KeyRing,
    private readonly ctx: SyncContext,
  ) {}

  restoreRow(rec: DeletedRowRecord): void {
    const row: RowKey = rec.row;
    this.writes.push(prepareWrite({ tbl: row.tbl, rowId: row.rowId, reg: LIFE_REG }, { value: LIFE_LIVE }, this.ctx, REPLACE_ALL));
    for (const [reg, enc] of Object.entries(rec.values)) {
      if (reg === LIFE_REG) continue;
      this.value({ tbl: row.tbl, rowId: row.rowId, reg }, enc, RESTORED_VALUE_MODE);
    }
  }

  value(key: RegKey, enc: EncodedValue, mode: WriteMode = REPLACE_ALL): void {
    const def = registerDef(key);
    if (def === null) {
      this.unknownRegisters++;
      return;
    }
    const decoded = decodeValue(enc);
    if (!def.secret) {
      this.writes.push(prepareWrite(key, { value: decoded }, this.ctx, mode));
      return;
    }
    const ct = asBlob(decoded);
    const plaintext = ct === null ? null : plaintextOf(ct, this.ring);
    if (ct !== null && plaintext === null) {
      this.unreadable++;
      return;
    }
    this.writes.push(prepareWrite(key, { plaintext }, this.ctx, mode));
  }
}
