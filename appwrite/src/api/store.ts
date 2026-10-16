import { AppwriteException, Query, type TablesDB } from 'node-appwrite';
import { DATABASE_ID, GUARDS_TABLE } from '../schema/tables.ts';
import type { TableSpec } from '../schema/types.ts';
import { decode, encode, hashId, singleKey } from './codec.ts';
import { ConflictError } from './errors.ts';
import { type Filter, type Order, type Row, matches, sortRows } from './filters.ts';

export interface Write {
  kind: 'create' | 'update' | 'delete';
  spec: TableSpec;
  rowId: string;
  row: Row | null;
  permissions?: string[];
  /** Update only these columns; absent means the whole row. */
  columns?: string[];
}

export interface ListOptions {
  order?: readonly Order[];
  limit?: number;
}

/** Committed state. All writes go through commit() so they land in one transaction. */
export interface Store {
  list(spec: TableSpec, filters: readonly Filter[], opts?: ListOptions): Promise<Row[]>;
  get(spec: TableSpec, rowId: string): Promise<Row | null>;
  latestGuard(scope: string): Promise<number>;
  /** Throws ConflictError when a guard revision was taken or a touched row changed. */
  commit(writes: readonly Write[], guards: ReadonlyMap<string, number>): Promise<void>;
}

const PAGE = 500;
const MAX_TX_OPS = 100;

function toQueries(spec: TableSpec, filters: readonly Filter[]): string[] {
  const key = singleKey(spec);
  const attr = (c: string) => (c === key ? '$id' : c);
  const q: string[] = [];
  for (const f of filters) {
    const a = attr(f.column);
    switch (f.op) {
      case 'eq':
        q.push(f.value === null ? Query.isNull(a) : Query.equal(a, [f.value as string]));
        break;
      case 'neq':
        q.push(Query.notEqual(a, f.value as string), Query.isNotNull(a));
        break;
      case 'gt':
        q.push(Query.greaterThan(a, f.value as string));
        break;
      case 'gte':
        q.push(Query.greaterThanEqual(a, f.value as string));
        break;
      case 'lt':
        q.push(Query.lessThan(a, f.value as string));
        break;
      case 'lte':
        q.push(Query.lessThanEqual(a, f.value as string));
        break;
      case 'in':
        // An empty IN list matches nothing; Appwrite rejects empty value lists.
        q.push((f.value as unknown[]).length ? Query.equal(a, f.value as string[]) : Query.equal('$id', ['~none~']));
        break;
      case 'is':
        q.push(f.value === null ? Query.isNull(a) : Query.equal(a, [f.value as boolean]));
        break;
      case 'isnot':
        q.push(f.value === null ? Query.isNotNull(a) : Query.notEqual(a, f.value as boolean));
        break;
    }
  }
  return q;
}

// A 404 at commit means a row this unit read was deleted by another writer since: retry like a clash.
const isConflict = (e: unknown): boolean => e instanceof AppwriteException && (e.code === 409 || e.code === 404 || /conflict/i.test(e.type ?? ''));

export class AppwriteStore implements Store {
  private readonly db: TablesDB;

  constructor(db: TablesDB) {
    this.db = db;
  }

  async list(spec: TableSpec, filters: readonly Filter[], opts: ListOptions = {}): Promise<Row[]> {
    const base = toQueries(spec, filters);
    const out: Row[] = [];
    let cursor: string | undefined;
    for (;;) {
      const queries = [...base, Query.limit(PAGE), Query.orderAsc('$id'), ...(cursor ? [Query.cursorAfter(cursor)] : [])];
      const page = await this.db.listRows({ databaseId: DATABASE_ID, tableId: spec.name, queries, total: false });
      for (const r of page.rows) out.push(decode(spec, r as unknown as Record<string, unknown>));
      if (page.rows.length < PAGE) break;
      cursor = page.rows[page.rows.length - 1]!.$id;
    }
    // Filters are re-applied in memory so SQL NULL rules and type coercion stay exact.
    const kept = sortRows(spec, out.filter((r) => matches(spec, r, filters)), opts.order ?? []);
    return opts.limit === undefined ? kept : kept.slice(0, opts.limit);
  }

  async get(spec: TableSpec, rowId: string): Promise<Row | null> {
    try {
      const r = await this.db.getRow({ databaseId: DATABASE_ID, tableId: spec.name, rowId });
      return decode(spec, r as unknown as Record<string, unknown>);
    } catch (e) {
      if (e instanceof AppwriteException && e.code === 404) return null;
      throw e;
    }
  }

  async latestGuard(scope: string): Promise<number> {
    const r = await this.db.listRows({
      databaseId: DATABASE_ID,
      tableId: GUARDS_TABLE,
      queries: [Query.equal('scope', [scope]), Query.orderDesc('rev'), Query.limit(1)],
      total: false,
    });
    return (r.rows[0] as unknown as { rev?: number } | undefined)?.rev ?? 0;
  }

  async commit(writes: readonly Write[], guards: ReadonlyMap<string, number>): Promise<void> {
    const ops: object[] = [];
    for (const [scope, rev] of guards) {
      ops.push({ action: 'create', databaseId: DATABASE_ID, tableId: GUARDS_TABLE, rowId: hashId(scope, rev + 1), data: { scope, rev: rev + 1 } });
    }
    for (const w of writes) {
      if (w.kind === 'delete') {
        ops.push({ action: 'delete', databaseId: DATABASE_ID, tableId: w.spec.name, rowId: w.rowId });
        continue;
      }
      const data: Record<string, unknown> = encode(w.spec, w.columns ? Object.fromEntries(w.columns.map((c) => [c, w.row![c]])) : w.row!);
      if (w.permissions) data.$permissions = w.permissions;
      ops.push({ action: w.kind, databaseId: DATABASE_ID, tableId: w.spec.name, rowId: w.rowId, data });
    }
    if (ops.length === 0) return;
    // Guards ride in the first chunk, so a lost race stops before anything lands. Only huge cascades
    // spill into later chunks, and those are not atomic: if a later chunk fails, the operation is
    // retried from the top, rereads what already landed and writes the rest.
    for (let i = 0; i < ops.length; i += MAX_TX_OPS) {
      const chunk = ops.slice(i, i + MAX_TX_OPS);
      const tx = await this.db.createTransaction({ ttl: 60 });
      try {
        await this.db.createOperations({ transactionId: tx.$id, operations: chunk });
        await this.db.updateTransaction({ transactionId: tx.$id, commit: true });
      } catch (e) {
        await this.db.updateTransaction({ transactionId: tx.$id, rollback: true }).catch(() => undefined);
        if (isConflict(e) || i > 0) throw new ConflictError(e instanceof Error ? e.message : 'conflict');
        throw e;
      }
    }
  }
}

/** In-memory Store for unit tests. Same guard semantics as Appwrite: a revision can be taken once. */
export class MemoryStore implements Store {
  readonly tables = new Map<string, Map<string, Row>>();
  readonly guardRows = new Map<string, number>();
  commits = 0;

  private table(name: string): Map<string, Row> {
    let t = this.tables.get(name);
    if (!t) this.tables.set(name, (t = new Map()));
    return t;
  }

  async list(spec: TableSpec, filters: readonly Filter[], opts: ListOptions = {}): Promise<Row[]> {
    const rows = [...this.table(spec.name).values()].filter((r) => matches(spec, r, filters)).map((r) => structuredClone(r));
    const sorted = sortRows(spec, rows, opts.order ?? []);
    return opts.limit === undefined ? sorted : sorted.slice(0, opts.limit);
  }

  async get(spec: TableSpec, rowId: string): Promise<Row | null> {
    const r = this.table(spec.name).get(rowId);
    return r ? structuredClone(r) : null;
  }

  async latestGuard(scope: string): Promise<number> {
    return this.guardRows.get(scope) ?? 0;
  }

  async commit(writes: readonly Write[], guards: ReadonlyMap<string, number>): Promise<void> {
    for (const [scope, rev] of guards) {
      if ((this.guardRows.get(scope) ?? 0) !== rev) throw new ConflictError(`guard ${scope}`);
    }
    // Like Appwrite: an existing row ID or a clash on a unique index of required columns fails the commit.
    for (const w of writes) {
      if (w.kind === 'create' && this.table(w.spec.name).has(w.rowId)) throw new ConflictError(`duplicate id ${w.rowId}`);
      if (w.kind === 'delete' || !w.row) continue;
      for (const cols of w.spec.unique ?? []) {
        if (cols.some((c) => w.spec.columns[c]!.nullable)) continue;
        for (const [id, other] of this.table(w.spec.name)) {
          if (id !== w.rowId && cols.every((c) => other[c] === w.row![c])) throw new ConflictError(`duplicate ${cols.join(',')}`);
        }
      }
    }
    for (const [scope, rev] of guards) this.guardRows.set(scope, rev + 1);
    for (const w of writes) {
      const t = this.table(w.spec.name);
      if (w.kind === 'delete') t.delete(w.rowId);
      else if (w.columns && t.has(w.rowId)) t.set(w.rowId, { ...t.get(w.rowId)!, ...structuredClone(Object.fromEntries(w.columns.map((c) => [c, w.row![c]]))) });
      else t.set(w.rowId, structuredClone(w.row!));
    }
    this.commits++;
  }
}
