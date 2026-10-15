import { randomUUID } from 'node:crypto';
import { tableSpec } from '../schema/tables.ts';
import { rowIdFor } from './codec.ts';
import type { Ctx } from './context.ts';
import type { Engine } from './engine.ts';
import { ApiError } from './errors.ts';
import type { Row } from './filters.ts';

// Port of the storage.objects policies for buckets "vaults" and "feedback-logs". File bytes live in
// an Appwrite bucket under a random file ID; cloud_files maps the old path to it and backs list().
// Execution bodies are capped near 10 MB of base64, so bigger files skip the body: the client puts
// the bytes in the "uploads" bucket and passes the file ID, and downloads them straight from storage.

export interface FileStore {
  put(bucket: string, fileId: string, name: string, bytes: Buffer, mimeType: string): Promise<void>;
  get(bucket: string, fileId: string): Promise<Buffer | null>;
  delete(bucket: string, fileId: string): Promise<void>;
  /** A file the caller put in the uploads bucket: its bytes and the user who created it. */
  staged(fileId: string): Promise<{ bytes: Buffer; owner: string | null } | null>;
  allowRead(bucket: string, fileId: string, userId: string): Promise<void>;
}

export const STAGING_BUCKET = 'uploads';
/** Bigger files go through the uploads bucket and direct download instead of the request body. */
export const INLINE_MAX_BYTES = 6 * 1024 * 1024;

const FILES = tableSpec('cloud_files');
const BUCKETS = new Set(['vaults', 'feedback-logs']);
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const MAX_BYTES = 10 * 1024 * 1024;

export interface StorageRequest {
  action: 'upload' | 'download' | 'list' | 'remove';
  bucket: string;
  path?: string;
  paths?: string[];
  /** base64 */
  body?: string;
  /** File ID in the uploads bucket, instead of body. */
  staged?: string;
  upsert?: boolean;
  contentType?: string;
  limit?: number;
  offset?: number;
  search?: string;
  sortBy?: { column?: string; order?: string };
}

const storageError = (status: number, error: string, message: string) => new ApiError(String(status), message, status, error);

function cleanPath(p: unknown): string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 512) throw storageError(400, 'InvalidKey', 'Invalid key');
  const path = p.replace(/^\/+/, '');
  if (path.split('/').some((s) => s === '' || s === '.' || s === '..')) throw storageError(400, 'InvalidKey', `Invalid key: ${p}`);
  return path;
}

const firstSegment = (path: string) => path.split('/')[0];

export class Storage {
  readonly ctx: Ctx;
  readonly engine: Engine;
  readonly files: FileStore;

  /** engine runs as definer; the bucket rules below are the policy check. */
  constructor(ctx: Ctx, engine: Engine, files: FileStore) {
    this.ctx = ctx;
    this.engine = engine;
    this.files = files;
  }

  private get uow() {
    return this.ctx.uow;
  }

  private async rowFor(bucket: string, path: string): Promise<Row | null> {
    return this.uow.get(FILES, rowIdFor(FILES, { bucket, path }));
  }

  private async objects(bucket: string, prefix: string): Promise<Row[]> {
    const owner = new RegExp(`^(${UUID})/`).exec(prefix)?.[1];
    const rows = await this.uow.list(FILES, [
      { column: 'bucket', op: 'eq', value: bucket },
      ...(owner ? [{ column: 'owner_id', op: 'eq' as const, value: owner }] : []),
    ]);
    return rows.filter((r) => String(r.path).startsWith(prefix));
  }

  private ownFolder(path: string): boolean {
    return this.ctx.isService || (this.ctx.uid !== null && firstSegment(path) === this.ctx.uid);
  }

  /** cloud_backup_allowed */
  private async backupAllowed(): Promise<boolean> {
    const profile = await this.ctx.profile(this.ctx.uid);
    if (!profile) return false;
    if (profile.is_team_member === true) return true;
    const tier = await this.ctx.tierOf(this.ctx.uid);
    return (tier?.features as Record<string, unknown> | undefined)?.cloud_sync_enabled === true;
  }

  /** cloud_backup_name_ok */
  private nameOk(path: string): boolean {
    const uid = this.ctx.uid ?? '';
    return new RegExp(`^${uid}/(((${UUID})/)?(vault\\.enc|backups/vault_[0-9A-Za-z._-]{1,80}\\.enc)|manifest\\.json)$`).test(path);
  }

  /** cloud_backup_slot_free */
  private async slotFree(path: string): Promise<boolean> {
    const uid = this.ctx.uid!;
    const profile = await this.ctx.profile(uid);
    if (profile?.is_team_member === true) return true;
    const f = ((await this.ctx.tierOf(uid))?.features ?? {}) as Record<string, unknown>;
    const cap = typeof f.max_cloud_backups === 'number' ? Math.trunc(f.max_cloud_backups) : null;
    const vcap = typeof f.max_cloud_backup_vaults === 'number' ? Math.trunc(f.max_cloud_backup_vaults) : null;
    const mine = await this.objects('vaults', `${uid}/`);

    const vault = new RegExp(`^[^/]+/([0-9a-f-]{36})/`).exec(path)?.[1];
    if (vault && vcap !== null && vcap !== -1 && !mine.some((o) => String(o.path).startsWith(`${uid}/${vault}/`))) {
      const vaults = new Set(mine.map((o) => new RegExp(`^${uid}/([0-9a-f-]{36})/`).exec(String(o.path))?.[1]).filter(Boolean));
      if (vaults.size >= vcap) return false;
    }

    const dir = /^(.*\/backups\/)[^/]+$/.exec(path)?.[1];
    if (!dir || cap === null || cap === -1) return true;
    const inDir = mine.filter((o) => {
      const p = String(o.path);
      return p.startsWith(dir) && !p.slice(dir.length).includes('/') && p !== path;
    });
    return inDir.length < cap;
  }

  private async mayWrite(bucket: string, path: string): Promise<boolean> {
    if (this.ctx.isService) return true;
    if (!this.ownFolder(path)) return false;
    if (bucket === 'feedback-logs') return true;
    return (await this.backupAllowed()) && this.nameOk(path) && (await this.slotFree(path));
  }

  private mayRead(bucket: string, path: string): boolean {
    if (this.ctx.isService) return true;
    return bucket === 'vaults' && this.ownFolder(path);
  }

  async run(req: StorageRequest): Promise<unknown> {
    if (!BUCKETS.has(req.bucket)) throw storageError(404, 'Bucket not found', 'Bucket not found');
    if (!this.ctx.isService && !this.ctx.uid) throw storageError(401, 'Unauthorized', 'not authenticated');
    switch (req.action) {
      case 'upload':
        return this.upload(req);
      case 'download':
        return this.download(req);
      case 'list':
        return this.list(req);
      case 'remove':
        return this.remove(req);
      default:
        throw storageError(400, 'InvalidRequest', `unknown storage action ${String(req.action)}`);
    }
  }

  private async upload(req: StorageRequest): Promise<{ path: string; id: string; fullPath: string }> {
    const path = cleanPath(req.path);
    const bytes = await this.uploadBytes(req);
    if (bytes.length > MAX_BYTES) throw storageError(413, 'Payload too large', 'The object exceeded the maximum allowed size');
    const owner = firstSegment(path)!;
    await this.uow.guard(`files:${req.bucket}:${owner}`);
    const existing = await this.rowFor(req.bucket, path);
    if (existing && !req.upsert) throw storageError(409, 'Duplicate', 'The resource already exists');
    if (!(await this.mayWrite(req.bucket, path))) throw storageError(403, 'Unauthorized', 'new row violates row-level security policy');

    const fileId = randomUUID().replace(/-/g, '');
    const mimeType = req.contentType ?? 'application/octet-stream';
    await this.files.put(req.bucket, fileId, path, bytes, mimeType);
    const now = this.uow.nowIso();
    const ownerId = /^[0-9a-f-]{36}$/.test(owner) ? owner : this.ctx.uid;
    if (existing) {
      await this.engine.updateRow(FILES, existing, { file_id: fileId, size: bytes.length, mime_type: mimeType, updated_at: now });
    } else {
      await this.engine.insertRow(FILES, { bucket: req.bucket, path, owner_id: ownerId, file_id: fileId, size: bytes.length, mime_type: mimeType });
    }
    return { path, id: fileId, fullPath: `${req.bucket}/${path}` };
  }

  private async uploadBytes(req: StorageRequest): Promise<Buffer> {
    if (typeof req.body === 'string') return Buffer.from(req.body, 'base64');
    if (typeof req.staged !== 'string' || !/^[A-Za-z0-9_.-]{1,36}$/.test(req.staged)) throw storageError(400, 'InvalidRequest', 'missing body');
    const staged = await this.files.staged(req.staged);
    if (!staged || (!this.ctx.isService && staged.owner !== this.ctx.uid)) throw storageError(404, 'not_found', 'Staged upload not found');
    const fileId = req.staged;
    this.uow.afterCommit(() => this.files.delete(STAGING_BUCKET, fileId));
    return staged.bytes;
  }

  private async download(req: StorageRequest): Promise<{ body: string; contentType: string } | { bucket: string; fileId: unknown; contentType: string }> {
    const path = cleanPath(req.path);
    const row = this.mayRead(req.bucket, path) ? await this.rowFor(req.bucket, path) : null;
    if (!row) throw storageError(404, 'not_found', 'Object not found');
    const contentType = (row.mime_type as string | null) ?? 'application/octet-stream';
    if (Number(row.size) > INLINE_MAX_BYTES && !this.ctx.isService) {
      await this.files.allowRead(req.bucket, row.file_id as string, this.ctx.uid!);
      return { bucket: req.bucket, fileId: row.file_id, contentType };
    }
    const bytes = await this.files.get(req.bucket, row.file_id as string);
    if (!bytes) throw storageError(404, 'not_found', 'Object not found');
    return { body: bytes.toString('base64'), contentType };
  }

  private async list(req: StorageRequest): Promise<unknown[]> {
    const prefix = typeof req.path === 'string' && req.path.length > 0 ? `${cleanPath(req.path)}/` : '';
    if (!this.ctx.isService && !this.mayRead(req.bucket, `${prefix}x`)) return [];
    const children = new Map<string, Row | null>();
    for (const o of await this.objects(req.bucket, prefix)) {
      const rest = String(o.path).slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) children.set(rest, o);
      else if (!children.has(rest.slice(0, slash))) children.set(rest.slice(0, slash), null);
    }
    let entries = [...children.entries()].map(([name, o]) =>
      o
        ? {
            name, id: o.file_id, created_at: o.created_at, updated_at: o.updated_at, last_accessed_at: o.updated_at,
            metadata: { size: Number(o.size), mimetype: o.mime_type, contentLength: Number(o.size), lastModified: o.updated_at },
          }
        : { name, id: null, created_at: null, updated_at: null, last_accessed_at: null, metadata: null },
    );
    if (req.search) entries = entries.filter((e) => e.name.includes(req.search!));
    const column = req.sortBy?.column ?? 'name';
    const dir = req.sortBy?.order === 'desc' ? -1 : 1;
    entries.sort((a, b) => {
      const x = String((a as Record<string, unknown>)[column] ?? '');
      const y = String((b as Record<string, unknown>)[column] ?? '');
      return x < y ? -dir : x > y ? dir : 0;
    });
    const offset = Math.max(0, Number(req.offset ?? 0));
    return entries.slice(offset, offset + Math.max(0, Number(req.limit ?? 100)));
  }

  private async remove(req: StorageRequest): Promise<unknown[]> {
    const paths = (req.paths ?? []).map(cleanPath);
    const removed: unknown[] = [];
    for (const path of paths) {
      if (!this.ctx.isService && (req.bucket !== 'vaults' || !this.ownFolder(path))) continue;
      const row = await this.rowFor(req.bucket, path);
      if (!row) continue;
      await this.engine.deleteRow(FILES, row);
      removed.push({ name: path, id: row.file_id, bucket_id: req.bucket });
    }
    return removed;
  }
}
