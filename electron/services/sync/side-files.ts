/**
 * Legacy side files next to S (spec 5.5, 4.3 rule 2, 12 rows 13/14/32/49/51): the none /
 * present / confirmed state per observed (exists, size, mtime) tuples of S-wal and S-shm, the
 * one-time user confirmation (moves them into {lineage}/sidefiles-<ts>/, kept 30 days), the
 * "[Review unsaved changes first]" private S + S-wal copy (the only way a WAL is ever applied),
 * the upgrade wording, the daily reminder, and the server flag for heartbeats. Reading and
 * merging S continue in every state; only publishing pauses and legacy deletes and stale
 * reverts are held.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { isErrno, sideFilesDirName } from './paths.js';
import type { ReplicaPort } from './replica.js';
import { SYNC_LOG_PREFIX, type SyncFs, type SyncHost } from './host.js';
import type { LocalJson, SideFileTuple } from './types.js';

/** 5.5: moved-aside side files are kept 30 days. */
export const SIDE_FILES_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** 5.5: "A reminder shows once a day." */
export const SIDE_FILES_REMINDER_MS = 24 * 60 * 60 * 1000;
export const WAL_SUFFIX = '-wal';
export const SHM_SUFFIX = '-shm';

/** Another process (a live legacy connection, a cloud client) holds the file: the move waits. */
const MOVE_HELD_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY']);
const SIDEFILES_DIR_RE = /^sidefiles-(\d+)$/;
const WAL_COPY_PREFIX = 'wal-';
const VAULT_EXTENSION = '.conduit';
const FRESH_DIR_ATTEMPTS = 1000;
const SIDE_FILE_NAMES: readonly SideFileTuple['name'][] = ['wal', 'shm'];

export type SideFileState = 'none' | 'present' | 'confirmed';

export interface SideFilesView {
  readonly state: SideFileState;
  readonly tuples: readonly SideFileTuple[];
  /** S-wal exists with size > 0: confirmation must review it first. */
  readonly walNonEmpty: boolean;
  /** 5.5 upgrade wording: settings list this vault and the files predate this build's first launch. */
  readonly upgradeWording: boolean;
  /** state !== 'present'. */
  readonly publishAllowed: boolean;
  /** Local hold input of 4.3 rule 2: state === 'present'. */
  readonly holdLegacy: boolean;
}

function absentTuple(name: SideFileTuple['name']): SideFileTuple {
  return Object.freeze({ name, exists: false, size: 0, mtimeMs: 0 });
}

/** Exactly one tuple per side file, in wal, shm order (a missing entry reads as absent). */
function normalizeTuples(tuples: readonly SideFileTuple[]): readonly SideFileTuple[] {
  return Object.freeze(
    SIDE_FILE_NAMES.map((name) => {
      const t = tuples.find((x) => x.name === name);
      return t === undefined ? absentTuple(name) : Object.freeze({ name, exists: t.exists, size: t.size, mtimeMs: t.mtimeMs });
    }),
  );
}

function sameTuples(a: readonly SideFileTuple[], b: readonly SideFileTuple[]): boolean {
  const na = normalizeTuples(a);
  const nb = normalizeTuples(b);
  return na.every((t, i) => {
    const u = nb[i];
    return u !== undefined && t.exists === u.exists && t.size === u.size && t.mtimeMs === u.mtimeMs;
  });
}

/** Pure 5.5 table: none (no files), confirmed (stored confirmation matches these tuples exactly), else present. */
export function deriveSideFileState(tuples: readonly SideFileTuple[], stored: LocalJson['sideFiles']): SideFileState {
  if (!tuples.some((t) => t.exists)) return 'none';
  if (stored !== null && stored.confirmedAtMs !== null && sameTuples(stored.tuples, tuples)) return 'confirmed';
  return 'present';
}

export function sideFilePaths(sharedPath: string): { readonly wal: string; readonly shm: string } {
  return { wal: `${sharedPath}${WAL_SUFFIX}`, shm: `${sharedPath}${SHM_SUFFIX}` };
}

/**
 * Stats S-wal and S-shm once (the tuples file-watch reports every poll). Callers that must know
 * the state before the watcher's first poll (the unlock cycle, the adopt seed) use this.
 */
export async function statSideFileTuples(sharedPath: string, fs: Pick<SyncFs, 'stat'>): Promise<readonly SideFileTuple[]> {
  const paths = sideFilePaths(sharedPath);
  const out: SideFileTuple[] = [];
  for (const name of SIDE_FILE_NAMES) {
    const st = await fs.stat(name === 'wal' ? paths.wal : paths.shm);
    out.push(st === null ? absentTuple(name) : { name, exists: true, size: st.size, mtimeMs: st.mtimeMs });
  }
  return normalizeTuples(out);
}

export type ConfirmOutcome =
  /** Moved aside (movedTo null when no side file was left to move). */
  | { readonly kind: 'confirmed'; readonly movedTo: string | null }
  /**
   * Another program still has a side file open (EPERM/EBUSY): nothing was recorded, publishing
   * stays paused and legacy deletes stay held; the move is retried on the next polls.
   */
  | { readonly kind: 'held-open'; readonly code: string }
  /** S-wal is non-empty: run stageWalCopy() and review the candidate first. */
  | { readonly kind: 'review-first' }
  /** The tuples changed since the prompt was shown: show it again. */
  | { readonly kind: 'changed' };

export interface SideFilesPort {
  /** Records one poll's tuples (file-watch); updates local.json sideFiles when the state changes. */
  observe(tuples: readonly SideFileTuple[]): SideFilesView;
  view(): SideFilesView;
  /**
   * [Conduit is closed on my other computers] / [Continue] for exactly `shown` tuples.
   * `walReviewed`: the WAL copy was reviewed (candidate applied or discarded), so a non-empty
   * S-wal no longer returns 'review-first'.
   */
  confirm(shown: readonly SideFileTuple[], walReviewed: boolean): Promise<ConfirmOutcome>;
  /**
   * [Review unsaved changes first]: copies S and S-wal into incoming/wal-<ts>.conduit(-wal),
   * opens that private copy read-write so SQLite applies the WAL, checkpoints, switches it to
   * journal_mode=DELETE, closes; returns its path (a candidate, or the genesis source).
   */
  stageWalCopy(): Promise<string>;
  /** Heartbeat flags value: 'present' while state === 'present'. */
  heartbeatFlag(): 'present' | null;
  /** Last time side files were seen (presence side_files_seen_ms), else null. */
  lastSeenMs(): number | null;
  /** Removes sidefiles-<ts> folders older than SIDE_FILES_KEEP_MS; returns the count. */
  cleanup(nowMs: number): Promise<number>;
  /** A confirmed move that found a side file held open, still to retry (null when none is due). */
  pendingRetry(): SideFileRetry | null;
  setSharedPath(sharedPath: string): void;
}

/** The user's confirmation, kept in memory only, for the tuples left after a held-open move. */
export interface SideFileRetry {
  readonly tuples: readonly SideFileTuple[];
  readonly walReviewed: boolean;
}

export interface SideFilesDeps {
  readonly replica: Pick<ReplicaPort, 'paths' | 'local' | 'updateLocal'>;
  readonly host: Pick<SyncHost, 'fs' | 'clock' | 'logger' | 'app'>;
  /** Realpath of S (settings lookup for the upgrade wording). */
  readonly realpath: string;
}

function errCode(err: unknown): string | null {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : null;
}

/** SQLite applies S-wal on open of the private copy; the checkpoint folds it into the main file. */
function applyWalInPlace(copyPath: string): void {
  const db = new Database(copyPath, { fileMustExist: true });
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.pragma('journal_mode = DELETE');
  } finally {
    db.close();
  }
}

export class SideFiles implements SideFilesPort {
  private tuples: readonly SideFileTuple[] = normalizeTuples([]);
  private seenMs: number | null = null;
  private retry: SideFileRetry | null = null;
  private realpath: string;

  constructor(
    private sharedPath: string,
    private readonly deps: SideFilesDeps,
  ) {
    this.realpath = deps.realpath;
  }

  observe(tuples: readonly SideFileTuple[]): SideFilesView {
    this.tuples = normalizeTuples(tuples);
    if (this.tuples.some((t) => t.exists)) this.seenMs = this.deps.host.clock.now();
    const stored = this.deps.replica.local().sideFiles;
    const state = deriveSideFileState(this.tuples, stored);
    // A confirmation covers one exact set of tuples: any change (or the files going away) ends it.
    if (stored !== null && state !== 'confirmed') this.clearStored('tuples-changed');
    if (this.retry !== null && !sameTuples(this.retry.tuples, this.tuples)) this.retry = null;
    return this.buildView(state);
  }

  view(): SideFilesView {
    return this.buildView(deriveSideFileState(this.tuples, this.deps.replica.local().sideFiles));
  }

  async confirm(shown: readonly SideFileTuple[], walReviewed: boolean): Promise<ConfirmOutcome> {
    const outcome = await this.confirmShown(shown, walReviewed);
    if (outcome.kind === 'confirmed') this.recordConfirmation();
    return outcome;
  }

  pendingRetry(): SideFileRetry | null {
    return this.retry;
  }

  async stageWalCopy(): Promise<string> {
    const { fs, clock, logger } = this.deps.host;
    const incoming = this.deps.replica.paths.incoming;
    await fs.mkdir(incoming);
    const target = path.join(incoming, `${WAL_COPY_PREFIX}${clock.now()}${VAULT_EXTENSION}`);
    const walTarget = `${target}${WAL_SUFFIX}`;
    try {
      await fs.copyFile(this.sharedPath, target);
      await this.copyWalIfPresent(walTarget);
      applyWalInPlace(target);
    } catch (err) {
      logger.error(`${SYNC_LOG_PREFIX} side files: staging the WAL copy failed`, { code: errCode(err), file: path.basename(this.sharedPath) });
      await this.removeQuietly([target, walTarget, `${target}${SHM_SUFFIX}`]);
      throw err;
    }
    await this.removeQuietly([walTarget, `${target}${SHM_SUFFIX}`]);
    logger.info(`${SYNC_LOG_PREFIX} side files: WAL applied to a private copy`, { copy: path.basename(target) });
    return target;
  }

  heartbeatFlag(): 'present' | null {
    return this.view().state === 'present' ? 'present' : null;
  }

  lastSeenMs(): number | null {
    return this.seenMs;
  }

  async cleanup(nowMs: number): Promise<number> {
    const { fs, logger } = this.deps.host;
    const dir = this.deps.replica.paths.dir;
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return 0;
      logger.error(`${SYNC_LOG_PREFIX} side files: listing the lineage folder failed`, { code: errCode(err) });
      throw err;
    }
    let removed = 0;
    for (const name of names) {
      const m = SIDEFILES_DIR_RE.exec(name);
      if (m === null || Number(m[1]) >= nowMs - SIDE_FILES_KEEP_MS) continue;
      try {
        await fs.rm(path.join(dir, name), { recursive: true, force: true });
        removed++;
      } catch (err) {
        logger.warn(`${SYNC_LOG_PREFIX} side files: removing an old sidefiles folder failed`, { folder: name, code: errCode(err) });
      }
    }
    return removed;
  }

  setSharedPath(sharedPath: string): void {
    if (sharedPath === this.sharedPath) return;
    this.sharedPath = sharedPath;
    this.realpath = sharedPath;
    this.tuples = normalizeTuples([]);
    this.retry = null;
    if (this.deps.replica.local().sideFiles !== null) this.clearStored('path-changed');
  }

  private async confirmShown(shown: readonly SideFileTuple[], walReviewed: boolean): Promise<ConfirmOutcome> {
    const view = this.observe(await statSideFileTuples(this.sharedPath, this.deps.host.fs));
    if (!sameTuples(shown, view.tuples)) return { kind: 'changed' };
    this.retry = null;
    if (view.state === 'none') return { kind: 'confirmed', movedTo: null };
    if (view.walNonEmpty && !walReviewed) return { kind: 'review-first' };
    return this.moveAside(view.tuples, walReviewed);
  }

  /** Taken once the files are gone, so every flag another device reported about them is older. */
  private recordConfirmation(): void {
    const atMs = this.deps.host.clock.now();
    try {
      this.deps.replica.updateLocal((l) => ({ ...l, sideFilesConfirmedAtMs: atMs }));
    } catch (err) {
      // Publishing then waits for the other devices' flags to clear at their next heartbeats.
      this.deps.host.logger.error(`${SYNC_LOG_PREFIX} side files: recording the confirmation failed`, { code: errCode(err) });
    }
  }

  private buildView(state: SideFileState): SideFilesView {
    const wal = this.tuples.find((t) => t.name === 'wal');
    return {
      state,
      tuples: this.tuples,
      walNonEmpty: wal !== undefined && wal.exists && wal.size > 0,
      upgradeWording: this.upgradeWording(),
      publishAllowed: state !== 'present',
      holdLegacy: state === 'present',
    };
  }

  private upgradeWording(): boolean {
    const existing = this.tuples.filter((t) => t.exists);
    if (existing.length === 0) return false;
    const firstLaunch = this.deps.host.app.thisBuildFirstLaunchMs();
    if (firstLaunch === null || !this.deps.host.app.settingsListsVault(this.realpath)) return false;
    return Math.max(...existing.map((t) => t.mtimeMs)) < firstLaunch;
  }

  private async moveAside(tuples: readonly SideFileTuple[], walReviewed: boolean): Promise<ConfirmOutcome> {
    const { fs, logger } = this.deps.host;
    const dir = await this.freshSideFilesDir();
    const paths = sideFilePaths(this.sharedPath);
    let moved = 0;
    for (const t of tuples.filter((x) => x.exists)) {
      const src = t.name === 'wal' ? paths.wal : paths.shm;
      try {
        await this.moveFile(src, path.join(dir, path.basename(src)));
        moved++;
      } catch (err) {
        if (isErrno(err, 'ENOENT')) continue;
        const code = errCode(err) ?? '';
        if (MOVE_HELD_CODES.has(code)) return this.heldOpen(code, walReviewed, moved > 0 ? dir : await this.dropEmptyDir(dir));
        logger.error(`${SYNC_LOG_PREFIX} side files: moving a side file aside failed`, { code: errCode(err) });
        throw err;
      }
    }
    this.observe(await statSideFileTuples(this.sharedPath, fs));
    logger.info(`${SYNC_LOG_PREFIX} side files: moved aside after confirmation`, { folder: path.basename(dir) });
    return { kind: 'confirmed', movedTo: dir };
  }

  private async moveFile(src: string, dest: string): Promise<void> {
    const { fs } = this.deps.host;
    try {
      await fs.rename(src, dest);
    } catch (err) {
      if (!isErrno(err, 'EXDEV')) throw err;
      await fs.copyFile(src, dest);
      await fs.rm(src, { recursive: false, force: false });
    }
  }

  /**
   * A side file left next to S would be replayed by the next in-place opener, so a failed move
   * is never recorded as a confirmation (2.1: a foreign -wal is never applied automatically).
   */
  private async heldOpen(code: string, walReviewed: boolean, movedTo: string | null): Promise<ConfirmOutcome> {
    const { fs, logger } = this.deps.host;
    const view = this.observe(await statSideFileTuples(this.sharedPath, fs));
    if (view.state === 'none') return { kind: 'confirmed', movedTo };
    logger.warn(`${SYNC_LOG_PREFIX} side files: a side file is held open by another program; publishing stays paused`, { code });
    this.retry = { tuples: view.tuples, walReviewed };
    return { kind: 'held-open', code };
  }

  /** The retry runs on every poll: a folder nothing was moved into must not pile up. */
  private async dropEmptyDir(dir: string): Promise<null> {
    try {
      await this.deps.host.fs.rm(dir, { recursive: true, force: true });
    } catch (err) {
      this.deps.host.logger.warn(`${SYNC_LOG_PREFIX} side files: removing an unused sidefiles folder failed`, { code: errCode(err) });
    }
    return null;
  }

  private async freshSideFilesDir(): Promise<string> {
    const { fs, clock } = this.deps.host;
    const start = clock.now();
    for (let i = 0; i < FRESH_DIR_ATTEMPTS; i++) {
      const dir = path.join(this.deps.replica.paths.dir, sideFilesDirName(start + i));
      if ((await fs.stat(dir)) !== null) continue;
      await fs.mkdir(dir);
      return dir;
    }
    throw new Error(`${SYNC_LOG_PREFIX} side files: no free sidefiles folder name`);
  }

  private async copyWalIfPresent(walTarget: string): Promise<void> {
    try {
      await this.deps.host.fs.copyFile(sideFilePaths(this.sharedPath).wal, walTarget);
    } catch (err) {
      if (!isErrno(err, 'ENOENT')) throw err;
      this.deps.host.logger.warn(`${SYNC_LOG_PREFIX} side files: no WAL next to S any more; staging S alone`);
    }
  }

  private clearStored(reason: string): void {
    try {
      this.deps.replica.updateLocal((l) => ({ ...l, sideFiles: null }));
    } catch (err) {
      // The in-memory view is already right; the stale confirmation is cleared again on the next poll.
      this.deps.host.logger.error(`${SYNC_LOG_PREFIX} side files: clearing the stored confirmation failed`, { reason, code: errCode(err) });
    }
  }

  private async removeQuietly(paths: readonly string[]): Promise<void> {
    for (const p of paths) {
      try {
        await this.deps.host.fs.rm(p, { recursive: false, force: true });
      } catch (err) {
        this.deps.host.logger.warn(`${SYNC_LOG_PREFIX} side files: removing a staging leftover failed`, { file: path.basename(p), code: errCode(err) });
      }
    }
  }
}
