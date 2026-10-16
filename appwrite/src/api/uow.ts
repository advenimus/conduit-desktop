import type { TableSpec } from '../schema/types.ts';
import { hashId, rowIdFor } from './codec.ts';
import { type Filter, type Row, matches, sortRows } from './filters.ts';
import type { ListOptions, Store, Write } from './store.ts';

type Pending = { kind: 'create' | 'update' | 'delete'; spec: TableSpec; row: Row | null; permissions?: string[]; base?: Row };

const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * One API operation. Reads see committed rows plus this operation's own pending writes; commit()
 * sends every write, and the guard revisions taken at the start, in one transaction.
 */
export class UnitOfWork {
  readonly store: Store;
  readonly now: number;
  private readonly pending = new Map<string, Map<string, Pending>>();
  private readonly order: { table: string; rowId: string }[] = [];
  private readonly guards = new Map<string, number>();
  private readonly after: (() => Promise<void>)[] = [];
  // Committed reads, per table. Row rules ask the same membership questions for every row of a result.
  private readonly reads = new Map<string, Map<string, Promise<Row[] | Row | null>>>();

  constructor(store: Store, now = Date.now()) {
    this.store = store;
    this.now = now;
  }

  nowIso(plusSeconds = 0): string {
    return new Date(this.now + plusSeconds * 1000).toISOString();
  }

  /** Serializes writers of one scope. Call it before reading the state the rule depends on. */
  async guard(name: string): Promise<void> {
    const scope = name.length > 200 ? `h:${hashId(name)}` : name;
    if (this.guards.has(scope)) return;
    this.guards.set(scope, await this.store.latestGuard(scope));
    // Anything read before the guard may predate the writer it serializes against.
    this.reads.clear();
  }

  private cached<T extends Row[] | Row | null>(table: string, key: string, load: () => Promise<T>): Promise<T> {
    let t = this.reads.get(table);
    if (!t) this.reads.set(table, (t = new Map()));
    let hit = t.get(key) as Promise<T> | undefined;
    if (!hit) {
      hit = load();
      t.set(key, hit);
      hit.catch(() => t!.delete(key));
    }
    return hit.then((v) => structuredClone(v));
  }

  private committedList(spec: TableSpec, filters: readonly Filter[]): Promise<Row[]> {
    return this.cached(spec.name, `l:${JSON.stringify(filters)}`, () => this.store.list(spec, filters));
  }

  afterCommit(fn: () => Promise<void>): void {
    this.after.push(fn);
  }

  private table(name: string): Map<string, Pending> {
    let t = this.pending.get(name);
    if (!t) this.pending.set(name, (t = new Map()));
    return t;
  }

  async list(spec: TableSpec, filters: readonly Filter[], opts: ListOptions = {}): Promise<Row[]> {
    const overlay = this.pending.get(spec.name);
    const committed = await this.committedList(spec, filters);
    if (!overlay || overlay.size === 0) {
      const sorted = sortRows(spec, committed, opts.order ?? []);
      return opts.limit === undefined ? sorted : sorted.slice(0, opts.limit);
    }
    const out: Row[] = [];
    for (const r of committed) {
      if (!overlay.has(rowIdFor(spec, r))) out.push(r);
    }
    for (const p of overlay.values()) {
      if (p.row && matches(spec, p.row, filters)) out.push(structuredClone(p.row));
    }
    const sorted = sortRows(spec, out, opts.order ?? []);
    return opts.limit === undefined ? sorted : sorted.slice(0, opts.limit);
  }

  async get(spec: TableSpec, rowId: string): Promise<Row | null> {
    const p = this.pending.get(spec.name)?.get(rowId);
    if (p) return p.row ? structuredClone(p.row) : null;
    return this.cached(spec.name, `g:${rowId}`, () => this.store.get(spec, rowId));
  }

  async first(spec: TableSpec, filters: readonly Filter[]): Promise<Row | null> {
    return (await this.list(spec, filters, { limit: 1 }))[0] ?? null;
  }

  async exists(spec: TableSpec, filters: readonly Filter[]): Promise<boolean> {
    return (await this.first(spec, filters)) !== null;
  }

  /** For an update, `base` is the row as read; only the columns that differ from it are written. */
  stage(kind: 'create' | 'update' | 'delete', spec: TableSpec, row: Row, permissions?: string[], base?: Row): void {
    const rowId = rowIdFor(spec, row);
    const t = this.table(spec.name);
    const prev = t.get(rowId);
    let next: Pending;
    if (kind === 'delete') {
      // Deleting a row this operation created leaves nothing to write.
      next = prev?.kind === 'create' ? { kind: 'delete', spec, row: null, permissions: ['__drop__'] } : { kind: 'delete', spec, row: null };
    } else if (prev?.kind === 'create' || (prev?.kind === 'delete' && kind === 'create')) {
      next = { kind: prev.kind === 'delete' ? 'update' : 'create', spec, row: structuredClone(row), ...(permissions ? { permissions } : {}) };
    } else {
      next = { kind, spec, row: structuredClone(row), ...(permissions ?? prev?.permissions ? { permissions: permissions ?? prev?.permissions } : {}) };
      const firstBase = prev ? prev.base : base;
      if (kind === 'update' && firstBase) next.base = structuredClone(firstBase);
    }
    if (!prev) this.order.push({ table: spec.name, rowId });
    t.set(rowId, next);
  }

  hasWrites(): boolean {
    return this.order.length > 0 || this.guards.size > 0;
  }

  async commit(): Promise<void> {
    const writes: Write[] = [];
    for (const { table, rowId } of this.order) {
      const p = this.pending.get(table)!.get(rowId)!;
      if (p.kind === 'delete' && p.permissions?.[0] === '__drop__') continue;
      let columns: string[] | undefined;
      if (p.kind === 'update' && p.base) {
        // A partial update keeps a concurrent writer's change to another column of the same row.
        columns = Object.keys(p.spec.columns).filter((c) => !same(p.base![c], p.row![c]));
        if (columns.length === 0) continue;
      }
      writes.push({ kind: p.kind, spec: p.spec, rowId, row: p.row, ...(p.permissions ? { permissions: p.permissions } : {}), ...(columns ? { columns } : {}) });
    }
    if (writes.length > 0 || this.guards.size > 0) await this.store.commit(writes, this.guards);
    for (const fn of this.after) {
      try {
        await fn();
      } catch (e) {
        console.error('[api] after-commit step failed:', e instanceof Error ? e.message : e);
      }
    }
  }
}
