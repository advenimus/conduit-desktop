import type { TableSpec } from '../schema/types.ts';
import { ApiError } from './errors.ts';

export type FilterOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'is' | 'isnot';

export interface Filter {
  column: string;
  op: FilterOp;
  value: unknown;
}

export interface Order {
  column: string;
  ascending: boolean;
  nullsFirst?: boolean;
}

export type Row = Record<string, unknown>;

const OPS: ReadonlySet<string> = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'isnot']);

export function validateFilters(spec: TableSpec, filters: unknown): Filter[] {
  if (filters === undefined || filters === null) return [];
  if (!Array.isArray(filters)) throw new ApiError('PGRST100', 'filters must be an array');
  return filters.map((f) => {
    if (!f || typeof f !== 'object') throw new ApiError('PGRST100', 'bad filter');
    const { column, op, value } = f as Record<string, unknown>;
    if (typeof column !== 'string' || !(column in spec.columns)) {
      throw new ApiError('42703', `column ${spec.name}.${String(column)} does not exist`);
    }
    if (typeof op !== 'string' || !OPS.has(op)) throw new ApiError('PGRST100', `unsupported operator ${String(op)}`);
    if (op === 'in' && !Array.isArray(value)) throw new ApiError('PGRST100', '"in" needs a list');
    if ((op === 'is' || op === 'isnot') && !(value === null || value === true || value === false)) {
      throw new ApiError('PGRST100', '"is" takes null, true or false');
    }
    return { column, op: op as FilterOp, value };
  });
}

export function validateOrder(spec: TableSpec, order: unknown): Order[] {
  if (order === undefined || order === null) return [];
  if (!Array.isArray(order)) throw new ApiError('PGRST100', 'order must be an array');
  return order.map((o) => {
    const { column, ascending, nullsFirst } = (o ?? {}) as Record<string, unknown>;
    if (typeof column !== 'string' || !(column in spec.columns)) {
      throw new ApiError('42703', `column ${spec.name}.${String(column)} does not exist`);
    }
    return { column, ascending: ascending !== false, ...(typeof nullsFirst === 'boolean' ? { nullsFirst } : {}) };
  });
}

function comparable(spec: TableSpec, column: string, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  const type = spec.columns[column]?.type;
  if (type === 'datetime') {
    const t = Date.parse(String(v));
    return Number.isNaN(t) ? null : t;
  }
  if (type === 'int' || type === 'bigint' || type === 'float') return Number(v);
  if (type === 'uuid') return String(v).toLowerCase();
  return v;
}

/** SQL three-valued logic collapsed to "row passes": comparisons with NULL never pass. */
export function matches(spec: TableSpec, row: Row, filters: readonly Filter[]): boolean {
  return filters.every((f) => {
    const actual = comparable(spec, f.column, row[f.column]);
    switch (f.op) {
      case 'is':
        return f.value === null ? actual === null : actual === f.value;
      case 'isnot':
        return f.value === null ? actual !== null : actual !== f.value;
      case 'in':
        return actual !== null && (f.value as unknown[]).some((v) => comparable(spec, f.column, v) === actual);
      default: {
        const want = comparable(spec, f.column, f.value);
        if (actual === null || want === null) return false;
        if (f.op === 'eq') return actual === want;
        if (f.op === 'neq') return actual !== want;
        const a = actual as number | string;
        const b = want as number | string;
        if (f.op === 'gt') return a > b;
        if (f.op === 'gte') return a >= b;
        if (f.op === 'lt') return a < b;
        return a <= b;
      }
    }
  });
}

export function sortRows(spec: TableSpec, rows: Row[], order: readonly Order[]): Row[] {
  if (order.length === 0) return rows;
  return [...rows].sort((x, y) => {
    for (const o of order) {
      const a = comparable(spec, o.column, x[o.column]);
      const b = comparable(spec, o.column, y[o.column]);
      if (a === b) continue;
      // Postgres default: NULLS LAST for ASC, NULLS FIRST for DESC.
      const nullsFirst = o.nullsFirst ?? !o.ascending;
      if (a === null) return nullsFirst ? -1 : 1;
      if (b === null) return nullsFirst ? 1 : -1;
      const cmp = (a as number | string) < (b as number | string) ? -1 : 1;
      return o.ascending ? cmp : -cmp;
    }
    return 0;
  });
}
