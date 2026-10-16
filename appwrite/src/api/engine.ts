import { Permission, Role } from 'node-appwrite';
import { TABLES, tableSpec } from '../schema/tables.ts';
import type { OnDelete, TableSpec } from '../schema/types.ts';
import { checkRow, coerce, defaultFor, rowIdFor, singleKey } from './codec.ts';
import type { Ctx } from './context.ts';
import { ApiError, denied } from './errors.ts';
import { type Filter, type Order, type Row, sortRows, validateFilters, validateOrder } from './filters.ts';
import { policyFor } from './policies.ts';
import { type Projection, parseSelect, project } from './select.ts';
import { type Effects, hooksFor, insertScopes } from './triggers.ts';

export type SingleMode = 'one' | 'maybe' | undefined;

export interface QueryRequest {
  op: 'select' | 'insert' | 'upsert' | 'update' | 'delete';
  table: string;
  select?: string;
  filters?: unknown;
  order?: unknown;
  limit?: number;
  offset?: number;
  count?: 'exact';
  head?: boolean;
  single?: SingleMode;
  rows?: unknown;
  values?: unknown;
  onConflict?: string;
  ignoreDuplicates?: boolean;
  /** Write requests return rows only when the client chained .select(). */
  returning?: boolean;
}

export interface QueryResult {
  data: unknown;
  count: number | null;
}

/** Tables the apps may name in a query. The guard and file tables stay internal. */
const CLIENT_TABLES = new Set(TABLES.map((t) => t.name).filter((n) => n !== 'cloud_files'));

const REFERENCED_BY: Map<string, { spec: TableSpec; column: string; onDelete: OnDelete }[]> = (() => {
  const m = new Map<string, { spec: TableSpec; column: string; onDelete: OnDelete }[]>();
  for (const spec of TABLES) {
    for (const fk of spec.foreignKeys ?? []) {
      const list = m.get(fk.references) ?? [];
      list.push({ spec, column: fk.column, onDelete: fk.onDelete });
      m.set(fk.references, list);
    }
  }
  return m;
})();

/** Row IDs, and unique indexes whose columns are all required, are enforced by Appwrite itself. */
export function enforcedByIndex(spec: TableSpec, cols: readonly string[]): boolean {
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((c) => b.includes(c));
  if (same(cols, spec.primaryKey)) return true;
  return (spec.unique ?? []).some((u) => same(u, cols)) && cols.every((c) => !spec.columns[c]!.nullable);
}

export function realtimePermissions(spec: TableSpec, row: Row): string[] | undefined {
  const col = spec.realtimeColumn;
  if (!spec.realtime || !col || typeof row[col] !== 'string') return undefined;
  const id = row[col] as string;
  return [Permission.read(spec.realtime === 'vault' ? Role.team(id) : Role.user(id))];
}

function normalizeFilters(spec: TableSpec, filters: Filter[]): Filter[] {
  return filters.map((f) => {
    if (f.op === 'is' || f.op === 'isnot') return f;
    if (f.op === 'in') return { ...f, value: (f.value as unknown[]).map((v) => coerce(spec, f.column, v)) };
    return { ...f, value: coerce(spec, f.column, f.value) };
  });
}

function coerceInput(spec: TableSpec, input: unknown): Row {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError('PGRST102', 'row must be an object');
  const out: Row = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) out[k] = coerce(spec, k, v);
  return out;
}

export class Engine {
  readonly ctx: Ctx;
  readonly fx: Effects;

  constructor(ctx: Ctx, fx: Effects) {
    this.ctx = ctx;
    this.fx = fx;
  }

  private get uow() {
    return this.ctx.uow;
  }

  async query(req: QueryRequest): Promise<QueryResult> {
    if (typeof req.table !== 'string' || !CLIENT_TABLES.has(req.table)) {
      throw new ApiError('42P01', `relation "public.${String(req.table)}" does not exist`);
    }
    const spec = tableSpec(req.table);
    switch (req.op) {
      case 'select':
        return this.select(spec, req);
      case 'insert':
      case 'upsert':
        return this.insert(spec, req);
      case 'update':
        return this.update(spec, req);
      case 'delete':
        return this.remove(spec, req);
      default:
        throw new ApiError('PGRST100', `unknown op ${String(req.op)}`);
    }
  }

  // ---- reads -------------------------------------------------------------------------------------

  async canSee(spec: TableSpec, row: Row): Promise<boolean> {
    if (this.ctx.isService) return true;
    const check = policyFor(spec.name).select;
    return check ? check(row, this.ctx) : false;
  }

  async visible(spec: TableSpec, filters: readonly Filter[], order: readonly Order[] = []): Promise<Row[]> {
    const rows = await this.uow.list(spec, filters, { order });
    const out: Row[] = [];
    for (const r of rows) if (await this.canSee(spec, r)) out.push(r);
    return out;
  }

  async shape(rows: Row[], p: Projection): Promise<Row[]> {
    const out: Row[] = [];
    for (const row of rows) {
      const shaped = project(row, p);
      for (const e of p.embeds) {
        const fk = row[e.column];
        const target = typeof fk === 'string' ? await this.uow.get(e.table, fk) : null;
        shaped[e.alias] = target && (await this.canSee(e.table, target)) ? (await this.shape([target], e.select))[0] : null;
      }
      out.push(shaped);
    }
    return out;
  }

  private finish(rows: Row[], single: SingleMode, count: number | null, head = false): QueryResult {
    if (head) return { data: null, count };
    if (single === 'one' || single === 'maybe') {
      if (rows.length === 1) return { data: rows[0], count };
      if (rows.length === 0 && single === 'maybe') return { data: null, count };
      throw new ApiError('PGRST116', 'JSON object requested, multiple (or no) rows returned', 406, `The result contains ${rows.length} rows`);
    }
    return { data: rows, count };
  }

  private async select(spec: TableSpec, req: QueryRequest): Promise<QueryResult> {
    const p = parseSelect(spec, req.select);
    const filters = normalizeFilters(spec, validateFilters(spec, req.filters));
    const order = validateOrder(spec, req.order);
    const rows = await this.visible(spec, filters, order);
    const offset = Math.max(0, Number(req.offset ?? 0));
    const sliced = req.limit === undefined ? rows.slice(offset) : rows.slice(offset, offset + Math.max(0, Number(req.limit)));
    const count = req.count === 'exact' ? rows.length : null;
    return this.finish(req.head ? [] : await this.shape(sliced, p), req.single, count, req.head);
  }

  // ---- constraint checks -------------------------------------------------------------------------

  /**
   * Guards for unique sets the database cannot enforce: Appwrite enforces row IDs and unique indexes
   * on required columns itself (a racing write fails at commit and the operation retries), so only
   * sets with a nullable column need a guard.
   */
  private uniqueScopes(spec: TableSpec, row: Row): string[] {
    return (spec.unique ?? [])
      .filter((cols) => !enforcedByIndex(spec, cols))
      .filter((cols) => cols.every((c) => row[c] !== null && row[c] !== undefined))
      .map((cols) => `uq:${spec.name}:${cols.join(',')}:${cols.map((c) => String(row[c])).join('|')}`);
  }

  private async checkUnique(spec: TableSpec, row: Row, selfId: string | null): Promise<void> {
    const rowId = rowIdFor(spec, row);
    if (rowId !== selfId && (await this.uow.get(spec, rowId))) {
      throw new ApiError('23505', `duplicate key value violates unique constraint "${spec.name}_pkey"`);
    }
    for (const cols of spec.unique ?? []) {
      if (cols.some((c) => row[c] === null || row[c] === undefined)) continue;
      const hits = await this.uow.list(spec, cols.map((c) => ({ column: c, op: 'eq' as const, value: row[c] })));
      if (hits.some((h) => rowIdFor(spec, h) !== (selfId ?? rowId))) {
        throw new ApiError('23505', `duplicate key value violates unique constraint "${spec.name}_${cols.join('_')}_key"`);
      }
    }
  }

  private async checkForeignKeys(spec: TableSpec, row: Row, oldRow: Row | null): Promise<void> {
    for (const fk of spec.foreignKeys ?? []) {
      const v = row[fk.column];
      if (v === null || v === undefined || (oldRow && oldRow[fk.column] === v)) continue;
      const ok = fk.references === 'users' ? await this.ctx.directory.exists(String(v)) : (await this.uow.get(tableSpec(fk.references), String(v))) !== null;
      if (!ok) {
        throw new ApiError('23503', `insert or update on table "${spec.name}" violates foreign key constraint "${spec.name}_${fk.column}_fkey"`);
      }
    }
  }

  // ---- writes ------------------------------------------------------------------------------------

  async insertRow(spec: TableSpec, input: Row, opts: { asService?: boolean } = {}): Promise<Row> {
    const row: Row = { ...input };
    for (const [name, col] of Object.entries(spec.columns)) {
      if (!(name in row)) row[name] = defaultFor(col, this.uow.now);
    }
    for (const scope of [...insertScopes(spec.name, row), ...this.uniqueScopes(spec, row)]) await this.uow.guard(scope);
    const hooks = hooksFor(spec.name);
    const final = hooks.beforeInsert ? await hooks.beforeInsert(row, this.ctx) : row;
    if (!this.ctx.isService && !opts.asService) {
      const check = policyFor(spec.name).insert;
      if (!check || !(await check(final, this.ctx))) throw denied(spec.name);
    }
    checkRow(spec, final);
    await this.checkUnique(spec, final, null);
    await this.checkForeignKeys(spec, final, null);
    this.uow.stage('create', spec, final, realtimePermissions(spec, final));
    if (hooks.afterInsert) await hooks.afterInsert(final, this.ctx, this.fx);
    return final;
  }

  async updateRow(spec: TableSpec, oldRow: Row, patch: Row, opts: { asService?: boolean } = {}): Promise<Row> {
    const merged: Row = { ...oldRow, ...patch };
    const selfId = rowIdFor(spec, oldRow);
    const before = new Set(this.uniqueScopes(spec, oldRow));
    for (const scope of this.uniqueScopes(spec, merged)) if (!before.has(scope)) await this.uow.guard(scope);
    const hooks = hooksFor(spec.name);
    const final = hooks.beforeUpdate ? await hooks.beforeUpdate(oldRow, merged, this.ctx) : merged;
    if (!this.ctx.isService && !opts.asService) {
      const policy = policyFor(spec.name);
      const check = policy.updateCheck ?? policy.update;
      if (!check || !(await check(final, this.ctx))) throw denied(spec.name);
    }
    checkRow(spec, final);
    if (rowIdFor(spec, final) !== selfId) throw new ApiError('42501', `the key of ${spec.name} cannot change`);
    await this.checkUnique(spec, final, selfId);
    await this.checkForeignKeys(spec, final, oldRow);
    this.uow.stage('update', spec, final, realtimePermissions(spec, final), oldRow);
    if (hooks.afterUpdate) await hooks.afterUpdate(oldRow, final, this.ctx, this.fx);
    return final;
  }

  async deleteRow(spec: TableSpec, row: Row): Promise<void> {
    this.uow.stage('delete', spec, row);
    const key = singleKey(spec);
    if (key) {
      for (const ref of REFERENCED_BY.get(spec.name) ?? []) {
        const children = await this.uow.list(ref.spec, [{ column: ref.column, op: 'eq', value: row[key] }]);
        for (const child of children) {
          if (ref.spec === spec && rowIdFor(spec, child) === rowIdFor(spec, row)) continue;
          if (ref.onDelete === 'cascade') await this.deleteRow(ref.spec, child);
          else if (ref.onDelete === 'set null') await this.updateRow(ref.spec, child, { [ref.column]: null }, { asService: true });
          else {
            throw new ApiError(
              '23503',
              `update or delete on table "${spec.name}" violates foreign key constraint "${ref.spec.name}_${ref.column}_fkey" on table "${ref.spec.name}"`,
            );
          }
        }
      }
    }
    const hooks = hooksFor(spec.name);
    if (hooks.afterDelete) await hooks.afterDelete(row, this.ctx, this.fx);
  }

  /** What deleting auth.users did through its foreign keys. "restrict" rows are left as they are. */
  async forgetUser(userId: string): Promise<void> {
    for (const ref of REFERENCED_BY.get('users') ?? []) {
      if (ref.onDelete === 'restrict') continue;
      for (const row of await this.uow.list(ref.spec, [{ column: ref.column, op: 'eq', value: userId }])) {
        if ((await this.uow.get(ref.spec, rowIdFor(ref.spec, row))) === null) continue;
        if (ref.onDelete === 'cascade') await this.deleteRow(ref.spec, row);
        else await this.updateRow(ref.spec, row, { [ref.column]: null }, { asService: true });
      }
    }
  }

  private async returning(spec: TableSpec, req: QueryRequest, rows: Row[]): Promise<QueryResult> {
    if (!req.returning) return this.finish([], undefined, null, true);
    for (const r of rows) {
      if (!(await this.canSee(spec, r))) throw denied(spec.name);
    }
    return this.finish(await this.shape(rows, parseSelect(spec, req.select)), req.single, req.count === 'exact' ? rows.length : null);
  }

  private async insert(spec: TableSpec, req: QueryRequest): Promise<QueryResult> {
    const inputs = (Array.isArray(req.rows) ? req.rows : [req.rows]).map((r) => coerceInput(spec, r));
    const out: Row[] = [];
    if (req.op === 'insert') {
      for (const input of inputs) out.push(await this.insertRow(spec, input));
      return this.returning(spec, req, out);
    }
    const target = req.onConflict ? req.onConflict.split(',').map((c) => c.trim()).filter(Boolean) : [...spec.primaryKey];
    for (const c of target) if (!(c in spec.columns)) throw new ApiError('42703', `column ${spec.name}.${c} does not exist`);
    for (const input of inputs) {
      const proposed: Row = { ...input };
      for (const [name, col] of Object.entries(spec.columns)) if (!(name in proposed)) proposed[name] = defaultFor(col, this.uow.now);
      if (target.some((c) => proposed[c] === null || proposed[c] === undefined)) {
        out.push(await this.insertRow(spec, input));
        continue;
      }
      if (!enforcedByIndex(spec, target)) {
        await this.uow.guard(`uq:${spec.name}:${target.join(',')}:${target.map((c) => String(proposed[c])).join('|')}`);
      }
      const existing = await this.uow.first(spec, target.map((c) => ({ column: c, op: 'eq' as const, value: proposed[c] })));
      if (!existing) {
        out.push(await this.insertRow(spec, input));
        continue;
      }
      if (req.ignoreDuplicates) continue;
      if (!this.ctx.isService) {
        const policy = policyFor(spec.name);
        if (!policy.insert || !(await policy.insert(proposed, this.ctx))) throw denied(spec.name);
        if (!(await this.canSee(spec, existing)) || !policy.update || !(await policy.update(existing, this.ctx))) {
          throw new ApiError('42501', `new row violates row-level security policy (USING expression) for table "${spec.name}"`);
        }
      }
      out.push(await this.updateRow(spec, existing, input));
    }
    return this.returning(spec, req, out);
  }

  private async targets(spec: TableSpec, req: QueryRequest, using: 'update' | 'delete'): Promise<Row[]> {
    const filters = normalizeFilters(spec, validateFilters(spec, req.filters));
    let rows = await this.uow.list(spec, filters);
    if (!this.ctx.isService) {
      const check = policyFor(spec.name)[using];
      const kept: Row[] = [];
      for (const r of rows) if (check && (await this.canSee(spec, r)) && (await check(r, this.ctx))) kept.push(r);
      rows = kept;
    }
    const order = validateOrder(spec, req.order);
    const sorted = sortRows(spec, rows, order);
    return req.limit === undefined ? sorted : sorted.slice(0, Number(req.limit));
  }

  private async update(spec: TableSpec, req: QueryRequest): Promise<QueryResult> {
    const patch = coerceInput(spec, req.values);
    const out: Row[] = [];
    for (const row of await this.targets(spec, req, 'update')) out.push(await this.updateRow(spec, row, patch));
    return this.returning(spec, req, out);
  }

  private async remove(spec: TableSpec, req: QueryRequest): Promise<QueryResult> {
    const rows = await this.targets(spec, req, 'delete');
    for (const row of rows) await this.deleteRow(spec, row);
    return this.returning(spec, req, rows);
  }
}
