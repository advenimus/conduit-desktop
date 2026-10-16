import { createHash, randomUUID } from 'node:crypto';
import type { ColumnSpec, TableSpec } from '../schema/types.ts';
import { ApiError } from './errors.ts';
import type { Row } from './filters.ts';

const APPWRITE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const hashId = (...parts: readonly unknown[]): string =>
  createHash('sha256').update(parts.map((p) => String(p)).join('|')).digest('hex').slice(0, 32);

/** Appwrite row ID: the key itself for a single-column key, else a hash of the key parts. */
export function rowIdFor(spec: TableSpec, row: Row): string {
  const parts = spec.primaryKey.map((c) => row[c]);
  if (parts.some((p) => p === null || p === undefined)) {
    throw new ApiError('23502', `null value in column "${spec.primaryKey.join(', ')}" of relation "${spec.name}" violates not-null constraint`);
  }
  if (spec.primaryKey.length === 1) {
    const id = String(parts[0]);
    if (!APPWRITE_ID.test(id)) throw new ApiError('22P02', `invalid key for ${spec.name}: ${id}`);
    return id;
  }
  return hashId(spec.name, ...parts);
}

export const singleKey = (spec: TableSpec): string | null => (spec.primaryKey.length === 1 ? spec.primaryKey[0]! : null);

/** Coerces a client value to the column's type, or throws 22P02 like Postgres does for bad input. */
export function coerce(spec: TableSpec, column: string, value: unknown): unknown {
  const col = spec.columns[column];
  if (!col) throw new ApiError('PGRST204', `Could not find the '${column}' column of '${spec.name}' in the schema cache`);
  if (value === null || value === undefined) return null;
  const bad = (): never => {
    throw new ApiError('22P02', `invalid input syntax for type ${col.type} (${spec.name}.${column}): ${JSON.stringify(value).slice(0, 80)}`);
  };
  switch (col.type) {
    case 'uuid':
      return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : bad();
    case 'varchar':
    case 'text':
    case 'longtext':
      return typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : bad();
    case 'int':
    case 'bigint': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      return typeof n === 'number' && Number.isInteger(n) ? n : bad();
    }
    case 'float': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      return typeof n === 'number' && Number.isFinite(n) ? n : bad();
    }
    case 'bool':
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 'false') return value === 'true';
      return bad();
    case 'datetime': {
      const t = typeof value === 'string' || typeof value === 'number' ? Date.parse(String(value)) : NaN;
      return Number.isNaN(t) ? bad() : new Date(t).toISOString();
    }
    case 'json':
      return structuredClone(value);
    case 'text[]':
      return Array.isArray(value) && value.every((v) => typeof v === 'string') ? [...value] : bad();
  }
}

export function defaultFor(col: ColumnSpec, nowMs: number): unknown {
  const d = col.default;
  if (!d) return null;
  if (d.kind === 'uuid') return randomUUID();
  if (d.kind === 'now') return new Date(nowMs + (d.plusSeconds ?? 0) * 1000).toISOString();
  return structuredClone(d.value);
}

/** CHECK, NOT NULL and length rules from the old schema. */
export function checkRow(spec: TableSpec, row: Row): void {
  for (const [name, col] of Object.entries(spec.columns)) {
    const v = row[name];
    if (v === null || v === undefined) {
      if (!col.nullable) {
        throw new ApiError('23502', `null value in column "${name}" of relation "${spec.name}" violates not-null constraint`);
      }
      continue;
    }
    const violation = (): never => {
      throw new ApiError('23514', `new row for relation "${spec.name}" violates check constraint "${spec.name}_${name}_check"`);
    };
    if (col.oneOf && !col.oneOf.includes(String(v))) violation();
    if (typeof v === 'string') {
      if (col.maxLength !== undefined && [...v].length > col.maxLength) violation();
      if (col.minLength !== undefined && [...v].length < col.minLength) violation();
      if (col.type === 'varchar' && col.size !== undefined && [...v].length > col.size) {
        throw new ApiError('22001', `value too long for type character varying(${col.size})`);
      }
    }
    if (col.type === 'json' && col.maxJsonBytes !== undefined) {
      if (typeof v !== 'object' || Array.isArray(v) || Buffer.byteLength(JSON.stringify(v)) > col.maxJsonBytes) violation();
    }
  }
}

/** Record to Appwrite row data. The single key column lives in $id, so it is left out. */
export function encode(spec: TableSpec, row: Row): Record<string, unknown> {
  const key = singleKey(spec);
  const out: Record<string, unknown> = {};
  for (const [name, col] of Object.entries(spec.columns)) {
    if (name === key || !(name in row)) continue;
    const v = row[name];
    out[name] = v === null || v === undefined ? null : col.type === 'json' ? JSON.stringify(v) : v;
  }
  return out;
}

export function decode(spec: TableSpec, data: Record<string, unknown>): Row {
  const key = singleKey(spec);
  const out: Row = {};
  for (const [name, col] of Object.entries(spec.columns)) {
    if (name === key) {
      out[name] = data.$id;
      continue;
    }
    const v = data[name];
    if (v === null || v === undefined) {
      out[name] = null;
    } else if (col.type === 'json') {
      out[name] = typeof v === 'string' ? JSON.parse(v) : v;
    } else if (col.type === 'datetime') {
      out[name] = new Date(String(v)).toISOString();
    } else {
      out[name] = v;
    }
  }
  return out;
}
