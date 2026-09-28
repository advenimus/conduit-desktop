/**
 * Pre-merge snapshots and targeted undo (spec 5.10, 12 rows 34/43): before committing a merge
 * that deletes 10 or more live rows, or changes 25% or more of them (minimum 10), VACUUM INTO
 * a copy of W in snapshots/<id>/ with diff.json (the rows this merge deleted, with values, and
 * the fields it changed, before and after); keep the last 5 for 30 days. Undo re-creates only
 * those rows (interactive `live` plus the snapshot's values) and writes an old field value only
 * where the field still holds the merged value. Shared-file merges are never blocked.
 * Values in diff.json are value-codec encoded; secrets stay ciphertext (never plaintext).
 * Parts: snapshots-types, snapshots-diff (pure diff), snapshots-codec (ids, diff.json),
 * snapshots-undo (preview and writes).
 */

import path from 'node:path';
import type Database from 'better-sqlite3';
import { SYNC_LOG_PREFIX, type SyncHost } from './host.js';
import { isErrno } from './paths.js';
import { vacuumInto } from './shared-file.js';
import {
  SHA256_HEX_RE,
  SNAPSHOT_TMP_PREFIX,
  encodeSnapshotFile,
  idTimeMs,
  isSnapshotId,
  parseSnapshotFile,
  snapshotIdFor,
  type SnapshotFile,
} from './snapshots-codec.js';
import { buildUndoPreview, buildUndoWrites } from './snapshots-undo.js';
import {
  SNAPSHOT_DB_FILE,
  SNAPSHOT_DIFF_FILE,
  SNAPSHOT_KEEP,
  SNAPSHOT_MAX_AGE_MS,
  type MergeDiff,
  type SnapshotMeta,
  type SnapshotRef,
  type SnapshotStorePort,
  type TakeSnapshotInput,
  type UndoChoice,
  type UndoPreview,
} from './snapshots-types.js';
import type { ImplicitProvider, KeyRing, LocalWrite, SyncContext, SyncState } from './types.js';

export * from './snapshots-types.js';
export { diffMerge, isMassChange } from './snapshots-diff.js';
export { isSnapshotId, SNAPSHOT_TMP_PREFIX } from './snapshots-codec.js';
export { countUndone } from './snapshots-undo.js';

/** Same-millisecond snapshots of the same S get `-2`, `-3`, ... suffixes. */
const MAX_ID_ATTEMPTS = 100;

export type VacuumInto = (db: Database.Database, target: string) => void;
type StoreHost = Pick<SyncHost, 'fs' | 'clock' | 'random' | 'logger'>;

export class SnapshotStore implements SnapshotStorePort {
  private readonly inProgress = new Set<string>();

  constructor(
    private readonly snapshotsDir: string,
    private readonly host: StoreHost,
    private readonly vacuum: VacuumInto = (db, target) => vacuumInto(db, target, host.logger),
  ) {}

  async take(input: TakeSnapshotInput): Promise<SnapshotRef> {
    if (!SHA256_HEX_RE.test(input.sourceSha256)) throw new Error(`${SYNC_LOG_PREFIX} snapshot: invalid source SHA-256`);
    const createdMs = this.host.clock.now();
    await this.host.fs.mkdir(this.snapshotsDir);
    const id = await this.freshId(createdMs, input.sourceSha256);
    const meta = metaOf(id, createdMs, input);
    const dir = this.dirOf(id);
    const tmp = this.dirOf(SNAPSHOT_TMP_PREFIX + id);
    this.inProgress.add(tmp);
    try {
      await this.writeSnapshot(tmp, input, { meta, diff: input.diff });
      await this.host.fs.rename(tmp, dir);
      await this.host.fs.fsyncDir(this.snapshotsDir);
    } catch (err) {
      this.host.logger.error(`${SYNC_LOG_PREFIX} snapshot failed`, { id, code: errorCode(err) });
      await this.remove(tmp);
      throw err;
    } finally {
      this.inProgress.delete(tmp);
    }
    this.host.logger.info(`${SYNC_LOG_PREFIX} snapshot taken`, { id, deleted: meta.deleted, changedRows: meta.changedRows });
    await this.pruneAfterTake(createdMs);
    return { id, dir, meta };
  }

  async list(): Promise<readonly SnapshotRef[]> {
    const refs: SnapshotRef[] = [];
    for (const name of await this.names()) {
      if (!isSnapshotId(name)) continue;
      const file = await this.tryRead(name);
      if (file !== null) refs.push(this.refOf(file.meta));
    }
    return refs.sort(newestFirst);
  }

  async loadDiff(id: string): Promise<{ readonly meta: SnapshotMeta; readonly diff: MergeDiff }> {
    if (!isSnapshotId(id)) throw new Error(`${SYNC_LOG_PREFIX} snapshot id is invalid`);
    let text: string;
    try {
      text = (await this.host.fs.readFile(path.join(this.dirOf(id), SNAPSHOT_DIFF_FILE))).toString('utf8');
    } catch (err) {
      if (isErrno(err, 'ENOENT')) throw new Error(`${SYNC_LOG_PREFIX} snapshot not found: ${id}`);
      throw err;
    }
    const file = parseSnapshotFile(text);
    if (file.meta.id !== id) throw new Error(`${SYNC_LOG_PREFIX} snapshot diff.json is invalid: meta.id`);
    return file;
  }

  async prune(nowMs: number): Promise<number> {
    const doomed: string[] = [];
    const valid: SnapshotRef[] = [];
    for (const name of await this.names()) {
      if (name.startsWith(SNAPSHOT_TMP_PREFIX)) {
        if (!this.inProgress.has(this.dirOf(name))) doomed.push(name);
        continue;
      }
      if (!isSnapshotId(name)) continue;
      const file = await this.tryRead(name);
      if (file !== null) valid.push(this.refOf(file.meta));
      else if (isExpired(idTimeMs(name) ?? 0, nowMs)) doomed.push(name);
    }
    valid.sort(newestFirst).forEach((ref, i) => {
      if (i >= SNAPSHOT_KEEP || isExpired(ref.meta.createdMs, nowMs)) doomed.push(ref.id);
    });
    let removed = 0;
    for (const name of doomed) {
      if (await this.remove(this.dirOf(name))) removed++;
    }
    if (removed > 0) this.host.logger.info(`${SYNC_LOG_PREFIX} snapshots pruned`, { removed });
    return removed;
  }

  async undoPreview(id: string, current: SyncState, _implicit: ImplicitProvider, ring?: KeyRing): Promise<UndoPreview> {
    return buildUndoPreview(id, await this.loadDiff(id), current, ring);
  }

  async undoWrites(id: string, current: SyncState, choice: UndoChoice, ring: KeyRing, ctx: SyncContext): Promise<readonly LocalWrite[]> {
    const res = buildUndoWrites(await this.loadDiff(id), current, choice, ring, ctx);
    if (res.unreadableSecrets > 0) {
      this.host.logger.warn(`${SYNC_LOG_PREFIX} undo skipped secrets no key could open`, { id, count: res.unreadableSecrets });
    }
    if (res.ignored > 0) this.host.logger.info(`${SYNC_LOG_PREFIX} undo skipped choices with nothing to undo`, { id, count: res.ignored });
    return res.writes;
  }

  /** The snapshot is already durable: a failed prune must not fail the take (the next start prunes). */
  private async pruneAfterTake(nowMs: number): Promise<void> {
    try {
      await this.prune(nowMs);
    } catch (err) {
      this.host.logger.warn(`${SYNC_LOG_PREFIX} snapshot prune failed`, { code: errorCode(err) });
    }
  }

  private async writeSnapshot(tmp: string, input: TakeSnapshotInput, file: SnapshotFile): Promise<void> {
    await this.host.fs.mkdir(tmp);
    this.vacuum(input.db, path.join(tmp, SNAPSHOT_DB_FILE));
    await this.host.fs.writeFileDurable(path.join(tmp, SNAPSHOT_DIFF_FILE), encodeSnapshotFile(file));
  }

  private async freshId(createdMs: number, sourceSha256: string): Promise<string> {
    for (let attempt = 1; attempt <= MAX_ID_ATTEMPTS; attempt++) {
      const id = snapshotIdFor(createdMs, sourceSha256, attempt);
      const taken = (await this.host.fs.stat(this.dirOf(id))) ?? (await this.host.fs.stat(this.dirOf(SNAPSHOT_TMP_PREFIX + id)));
      if (taken === null) return id;
    }
    throw new Error(`${SYNC_LOG_PREFIX} snapshot: no free id`);
  }

  private async names(): Promise<readonly string[]> {
    try {
      return await this.host.fs.readdir(this.snapshotsDir);
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return [];
      this.host.logger.error(`${SYNC_LOG_PREFIX} snapshots folder unreadable`, { code: errorCode(err) });
      throw err;
    }
  }

  /** diff.json of a snapshot folder, or null (logged) when it cannot be read or parsed. */
  private async tryRead(name: string): Promise<SnapshotFile | null> {
    try {
      return await this.loadDiff(name);
    } catch (err) {
      this.host.logger.warn(`${SYNC_LOG_PREFIX} snapshot unreadable`, { id: name, code: errorCode(err) });
      return null;
    }
  }

  /** Removes a folder; failures are logged and reported as false. */
  private async remove(dir: string): Promise<boolean> {
    try {
      await this.host.fs.rm(dir, { recursive: true, force: true });
      return true;
    } catch (err) {
      this.host.logger.error(`${SYNC_LOG_PREFIX} snapshot folder not removed`, { name: path.basename(dir), code: errorCode(err) });
      return false;
    }
  }

  private dirOf(name: string): string {
    return path.join(this.snapshotsDir, name);
  }

  private refOf(meta: SnapshotMeta): SnapshotRef {
    return { id: meta.id, dir: this.dirOf(meta.id), meta };
  }
}

function metaOf(id: string, createdMs: number, input: TakeSnapshotInput): SnapshotMeta {
  return {
    id,
    createdMs,
    sourceSha256: input.sourceSha256,
    noticeId: input.noticeId,
    epochId: input.epochId,
    deleted: input.diff.deleted.length,
    changedRows: input.diff.changedRows,
    byDeviceUuid: input.diff.byDeviceUuid,
  };
}

function isExpired(createdMs: number, nowMs: number): boolean {
  return nowMs - createdMs > SNAPSHOT_MAX_AGE_MS;
}

function newestFirst(a: SnapshotRef, b: SnapshotRef): number {
  if (a.meta.createdMs !== b.meta.createdMs) return b.meta.createdMs - a.meta.createdMs;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code;
  return err instanceof Error ? err.name : 'unknown';
}
