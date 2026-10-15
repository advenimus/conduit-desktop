// Copied from appwrite/src/client/index.ts; a test keeps the two identical.
// Client for the Conduit api function. It keeps the supabase-js call shape the apps already use
// (from().select().eq()..., rpc(), storage.from()) and sends one JSON request per call through a
// transport, so the same code runs in Electron, Next.js and tests.

export interface Transport {
  (body: string, signal?: AbortSignal): Promise<{ status: number; body: string }>;
}

export interface DbError {
  message: string;
  code: string;
  details: string | null;
  hint: string | null;
}

export interface DbResult<T> {
  data: T | null;
  error: DbError | null;
  count: number | null;
  status: number;
}

type FilterOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'is' | 'isnot';
interface Filter {
  column: string;
  op: FilterOp;
  value: unknown;
}

const networkError = (e: unknown): DbError => ({
  message: e instanceof Error ? e.message : String(e),
  code: e instanceof Error && e.name === 'AbortError' ? 'ABORT' : 'NETWORK',
  details: null,
  hint: null,
});

async function send<T>(transport: Transport, payload: unknown, signal?: AbortSignal): Promise<DbResult<T>> {
  try {
    const res = await transport(JSON.stringify(payload), signal);
    let parsed: { data?: T; error?: DbError | null; count?: number | null } = {};
    try {
      parsed = res.body ? JSON.parse(res.body) : {};
    } catch {
      return { data: null, error: { message: `bad response (${res.status})`, code: 'BAD_RESPONSE', details: res.body.slice(0, 200), hint: null }, count: null, status: res.status };
    }
    // A crashed or timed-out execution answers 500 with an empty body; that must never read as success.
    if (!parsed.error && (res.status < 200 || res.status >= 300)) {
      return { data: null, error: { message: `api call failed (HTTP ${res.status})`, code: res.status >= 500 ? 'XX000' : String(res.status), details: null, hint: null }, count: null, status: res.status };
    }
    return { data: (parsed.data ?? null) as T | null, error: parsed.error ?? null, count: parsed.count ?? null, status: res.status };
  } catch (e) {
    return { data: null, error: networkError(e), count: null, status: 0 };
  }
}

type Op = 'select' | 'insert' | 'upsert' | 'update' | 'delete';

export class QueryBuilder<T = any> implements PromiseLike<DbResult<T>> {
  private readonly transport: Transport;
  private readonly table: string;
  private op: Op = 'select';
  private columns: string | undefined;
  private filters: Filter[] = [];
  private orders: { column: string; ascending: boolean; nullsFirst?: boolean }[] = [];
  private limitN: number | undefined;
  private offsetN: number | undefined;
  private countMode: 'exact' | undefined;
  private headOnly = false;
  private singleMode: 'one' | 'maybe' | undefined;
  private rows: unknown;
  private values: unknown;
  private onConflict: string | undefined;
  private ignoreDuplicates = false;
  private returning = false;
  private signal: AbortSignal | undefined;

  constructor(transport: Transport, table: string) {
    this.transport = transport;
    this.table = table;
  }

  select(columns = '*', opts: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean } = {}): this {
    if (this.op === 'select') {
      this.columns = columns;
      if (opts.count) this.countMode = 'exact';
      this.headOnly = opts.head === true;
    } else {
      this.returning = true;
      this.columns = columns;
    }
    return this;
  }

  insert(rows: unknown): this {
    this.op = 'insert';
    this.rows = rows;
    return this;
  }

  upsert(rows: unknown, opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}): this {
    this.op = 'upsert';
    this.rows = rows;
    this.onConflict = opts.onConflict;
    this.ignoreDuplicates = opts.ignoreDuplicates === true;
    return this;
  }

  update(values: unknown): this {
    this.op = 'update';
    this.values = values;
    return this;
  }

  delete(): this {
    this.op = 'delete';
    return this;
  }

  private add(column: string, op: FilterOp, value: unknown): this {
    this.filters.push({ column, op, value });
    return this;
  }

  eq(column: string, value: unknown): this {
    return this.add(column, 'eq', value);
  }
  neq(column: string, value: unknown): this {
    return this.add(column, 'neq', value);
  }
  gt(column: string, value: unknown): this {
    return this.add(column, 'gt', value);
  }
  gte(column: string, value: unknown): this {
    return this.add(column, 'gte', value);
  }
  lt(column: string, value: unknown): this {
    return this.add(column, 'lt', value);
  }
  lte(column: string, value: unknown): this {
    return this.add(column, 'lte', value);
  }
  in(column: string, values: readonly unknown[]): this {
    return this.add(column, 'in', [...values]);
  }
  is(column: string, value: null | boolean): this {
    return this.add(column, 'is', value);
  }
  not(column: string, operator: 'is', value: null | boolean): this {
    if (operator !== 'is') throw new Error(`not(${operator}) is not supported`);
    return this.add(column, 'isnot', value);
  }
  match(query: Record<string, unknown>): this {
    for (const [k, v] of Object.entries(query)) this.add(k, 'eq', v);
    return this;
  }
  order(column: string, opts: { ascending?: boolean; nullsFirst?: boolean } = {}): this {
    this.orders.push({ column, ascending: opts.ascending !== false, ...(opts.nullsFirst === undefined ? {} : { nullsFirst: opts.nullsFirst }) });
    return this;
  }
  limit(n: number): this {
    this.limitN = n;
    return this;
  }
  range(from: number, to: number): this {
    this.offsetN = from;
    this.limitN = to - from + 1;
    return this;
  }
  single(): QueryBuilder<any> {
    this.singleMode = 'one';
    return this;
  }
  maybeSingle(): QueryBuilder<any> {
    this.singleMode = 'maybe';
    return this;
  }
  abortSignal(signal: AbortSignal): this {
    this.signal = signal;
    return this;
  }

  private payload(): Record<string, unknown> {
    return {
      kind: 'query',
      op: this.op,
      table: this.table,
      select: this.columns,
      filters: this.filters,
      order: this.orders,
      limit: this.limitN,
      offset: this.offsetN,
      count: this.countMode,
      head: this.headOnly,
      single: this.singleMode,
      rows: this.rows,
      values: this.values,
      onConflict: this.onConflict,
      ignoreDuplicates: this.ignoreDuplicates,
      returning: this.returning,
    };
  }

  then<R1 = DbResult<T>, R2 = never>(
    onfulfilled?: ((value: DbResult<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return send<T>(this.transport, this.payload(), this.signal).then(onfulfilled, onrejected);
  }
}

export class RpcCall<T = any> implements PromiseLike<DbResult<T>> {
  private readonly transport: Transport;
  private readonly fn: string;
  private readonly args: Record<string, unknown>;
  private signal: AbortSignal | undefined;

  constructor(transport: Transport, fn: string, args: Record<string, unknown>) {
    this.transport = transport;
    this.fn = fn;
    this.args = args;
  }

  abortSignal(signal: AbortSignal): this {
    this.signal = signal;
    return this;
  }

  then<R1 = DbResult<T>, R2 = never>(
    onfulfilled?: ((value: DbResult<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return send<T>(this.transport, { kind: 'rpc', fn: this.fn, args: this.args }, this.signal).then(onfulfilled, onrejected);
  }
}

export interface StorageError {
  name: 'StorageError';
  message: string;
  statusCode: string;
}

export interface FileObject {
  name: string;
  id: string | null;
  created_at: string;
  updated_at: string;
  last_accessed_at: string;
  metadata: Record<string, any>;
}

/** Same discriminated shape as supabase-js: data is set exactly when error is null. */
export type StorageResult<T> = { data: T; error: null } | { data: null; error: StorageError };

type Body = Buffer | Uint8Array | ArrayBuffer | Blob | string;

async function toBytes(body: Body): Promise<Buffer> {
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (typeof Blob !== 'undefined' && body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  return Buffer.from(body as Uint8Array);
}

/** Same limit as the api function: bigger files skip the request body (see DirectFiles). */
export const INLINE_MAX_BYTES = 6 * 1024 * 1024;

/** Straight-to-storage calls for files too big for a request body, made with the user's session. */
export interface DirectFiles {
  /** Puts bytes in the uploads bucket and returns the file ID. */
  stage(bytes: Buffer, contentType: string): Promise<string>;
  fetch(bucket: string, fileId: string): Promise<Buffer>;
}

export class BucketApi {
  private readonly transport: Transport;
  private readonly bucket: string;
  private readonly files: DirectFiles | undefined;

  constructor(transport: Transport, bucket: string, files?: DirectFiles) {
    this.transport = transport;
    this.bucket = bucket;
    this.files = files;
  }

  private async staged<T>(fn: () => Promise<T>): Promise<StorageResult<T>> {
    try {
      return { data: await fn(), error: null };
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      return { data: null, error: { name: 'StorageError', message: e instanceof Error ? e.message : String(e), statusCode: typeof code === 'number' ? String(code) : 'NETWORK' } };
    }
  }

  private async call<T>(payload: Record<string, unknown>): Promise<StorageResult<T>> {
    const r = await send<T>(this.transport, { kind: 'storage', bucket: this.bucket, ...payload });
    if (r.error) return { data: null, error: { name: 'StorageError', message: r.error.message, statusCode: r.error.code } };
    return { data: r.data as T, error: null };
  }

  async upload(path: string, body: Body, opts: { upsert?: boolean; contentType?: string } = {}) {
    const bytes = await toBytes(body);
    const common = { action: 'upload', path, upsert: opts.upsert === true, contentType: opts.contentType };
    if (bytes.length > INLINE_MAX_BYTES && this.files) {
      const files = this.files;
      const staged = await this.staged(() => files.stage(bytes, opts.contentType ?? 'application/octet-stream'));
      if (staged.error) return staged;
      return this.call<{ path: string; id: string; fullPath: string }>({ ...common, staged: staged.data });
    }
    return this.call<{ path: string; id: string; fullPath: string }>({ ...common, body: bytes.toString('base64') });
  }

  async download(path: string): Promise<StorageResult<Blob>> {
    const r = await this.call<{ body?: string; bucket?: string; fileId?: string; contentType: string }>({ action: 'download', path });
    if (r.error) return r;
    const { body, bucket, fileId, contentType } = r.data;
    if (typeof body === 'string') return { data: new Blob([Buffer.from(body, 'base64')], { type: contentType }), error: null };
    const files = this.files;
    if (!files || !bucket || !fileId) return { data: null, error: { name: 'StorageError', message: 'file too large for this client', statusCode: '413' } };
    const bytes = await this.staged(() => files.fetch(bucket, fileId));
    if (bytes.error) return bytes;
    return { data: new Blob([new Uint8Array(bytes.data)], { type: contentType }), error: null };
  }

  async list(path = '', opts: { limit?: number; offset?: number; search?: string; sortBy?: { column?: string; order?: string } } = {}) {
    return this.call<FileObject[]>({ action: 'list', path, ...opts });
  }

  async remove(paths: string[]) {
    return this.call<FileObject[]>({ action: 'remove', paths });
  }
}

export class ConduitDb {
  private readonly transport: Transport;
  readonly storage: { from: (bucket: string) => BucketApi };

  constructor(transport: Transport, files?: DirectFiles) {
    this.transport = transport;
    this.storage = { from: (bucket: string) => new BucketApi(transport, bucket, files) };
  }

  from<T = any>(table: string): QueryBuilder<T> {
    return new QueryBuilder<T>(this.transport, table);
  }

  rpc<T = any>(fn: string, args: Record<string, unknown> = {}): RpcCall<T> {
    return new RpcCall<T>(this.transport, fn, args);
  }
}
