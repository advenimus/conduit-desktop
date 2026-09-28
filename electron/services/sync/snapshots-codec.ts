/**
 * Snapshot ids and the diff.json codec (spec 5.10). diff.json = {meta, diff} with
 * value-codec values; it is read back from disk, so every field is validated on load.
 * Import through snapshots.ts.
 */

import { decodeValue, type EncodedValue } from './value-codec.js';
import type {
  ChangedFieldRecord,
  DeletedRowRecord,
  MergeDiff,
  SnapshotMeta,
} from './snapshots-types.js';
import { TBL, type RegKey, type RowKey } from './types.js';

/** `<createdMs>-<first 8 hex of the S SHA-256>`, plus `-<n>` when that folder already exists. */
export const SNAPSHOT_ID_RE = /^\d{1,16}-[0-9a-f]{8}(?:-\d{1,3})?$/;
/** Folder of a snapshot still being written; renamed to the id once diff.json is durable. */
export const SNAPSHOT_TMP_PREFIX = '.tmp-';
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const SHA_PREFIX_LEN = 8;
const JSON_INDENT = 2;
const B64_KEY = '$b64';

export interface SnapshotFile {
  readonly meta: SnapshotMeta;
  readonly diff: MergeDiff;
}

export function isSnapshotId(name: string): boolean {
  return SNAPSHOT_ID_RE.test(name);
}

export function snapshotIdFor(createdMs: number, sourceSha256: string, attempt: number): string {
  const base = `${Math.trunc(createdMs)}-${sourceSha256.slice(0, SHA_PREFIX_LEN)}`;
  return attempt <= 1 ? base : `${base}-${attempt}`;
}

/** Creation time encoded in a snapshot folder name, or null. */
export function idTimeMs(name: string): number | null {
  const m = /^(\d{1,16})-/.exec(name);
  return m === null ? null : Number(m[1]);
}

export function encodeSnapshotFile(file: SnapshotFile): string {
  return `${JSON.stringify({ meta: file.meta, diff: file.diff }, null, JSON_INDENT)}\n`;
}

/** Parses and validates diff.json; throws `[sync] ...` on anything unexpected. */
export function parseSnapshotFile(text: string): SnapshotFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid('not JSON');
  }
  const root = obj(parsed, 'root');
  return { meta: parseMeta(obj(root.meta, 'meta')), diff: parseDiff(obj(root.diff, 'diff')) };
}

function parseMeta(m: Record<string, unknown>): SnapshotMeta {
  const id = str(m.id, 'meta.id');
  if (!isSnapshotId(id)) throw invalid('meta.id');
  const sourceSha256 = str(m.sourceSha256, 'meta.sourceSha256');
  if (!SHA256_HEX_RE.test(sourceSha256)) throw invalid('meta.sourceSha256');
  return {
    id,
    createdMs: count(m.createdMs, 'meta.createdMs'),
    sourceSha256,
    noticeId: str(m.noticeId, 'meta.noticeId'),
    epochId: str(m.epochId, 'meta.epochId'),
    deleted: count(m.deleted, 'meta.deleted'),
    changedRows: count(m.changedRows, 'meta.changedRows'),
    byDeviceUuid: strOrNull(m.byDeviceUuid, 'meta.byDeviceUuid'),
  };
}

function parseDiff(d: Record<string, unknown>): MergeDiff {
  return {
    liveBefore: count(d.liveBefore, 'diff.liveBefore'),
    deleted: arr(d.deleted, 'diff.deleted').map(parseDeleted),
    changed: arr(d.changed, 'diff.changed').map(parseChanged),
    changedRows: count(d.changedRows, 'diff.changedRows'),
    byDeviceUuid: strOrNull(d.byDeviceUuid, 'diff.byDeviceUuid'),
  };
}

function parseDeleted(x: unknown): DeletedRowRecord {
  const r = obj(x, 'deleted[]');
  const values = obj(r.values, 'deleted[].values');
  const entries = Object.entries(values).map(([reg, v]) => [nonEmpty(reg, 'deleted[].values key'), encoded(v)] as const);
  return { row: rowKeyOf(r.row), title: str(r.title, 'deleted[].title'), values: Object.fromEntries(entries) };
}

function parseChanged(x: unknown): ChangedFieldRecord {
  const c = obj(x, 'changed[]');
  if (typeof c.secret !== 'boolean') throw invalid('changed[].secret');
  return { key: regKeyOf(c.key), before: encoded(c.before), after: encoded(c.after), secret: c.secret };
}

function rowKeyOf(x: unknown): RowKey {
  const r = obj(x, 'row');
  const tbl = r.tbl;
  if (tbl !== TBL.entries && tbl !== TBL.folders) throw invalid('row.tbl');
  return { tbl, rowId: nonEmpty(r.rowId, 'row.rowId') };
}

function regKeyOf(x: unknown): RegKey {
  const row = rowKeyOf(x);
  return { tbl: row.tbl, rowId: row.rowId, reg: nonEmpty(obj(x, 'key').reg, 'key.reg') };
}

function encoded(x: unknown): EncodedValue {
  if (x !== null && typeof x === 'object') {
    const keys = Object.keys(x);
    if (keys.length !== 1 || keys[0] !== B64_KEY) throw invalid('value');
  }
  if (typeof x === 'number' && !Number.isFinite(x)) throw invalid('value');
  try {
    decodeValue(x);
  } catch {
    throw invalid('value');
  }
  return x as EncodedValue;
}

function obj(x: unknown, what: string): Record<string, unknown> {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) throw invalid(what);
  return x as Record<string, unknown>;
}

function arr(x: unknown, what: string): unknown[] {
  if (!Array.isArray(x)) throw invalid(what);
  return x;
}

function str(x: unknown, what: string): string {
  if (typeof x !== 'string') throw invalid(what);
  return x;
}

function nonEmpty(x: unknown, what: string): string {
  const s = str(x, what);
  if (s.length === 0) throw invalid(what);
  return s;
}

function strOrNull(x: unknown, what: string): string | null {
  return x === null ? null : str(x, what);
}

function count(x: unknown, what: string): number {
  if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < 0) throw invalid(what);
  return x;
}

function invalid(what: string): Error {
  return new Error(`[sync] snapshot diff.json is invalid: ${what}`);
}
