/**
 * Watching the shared file (spec 5.4, 5.5, 12 row 33): fs.watch on S's folder (catches
 * rename-replace), a 3-second stat poll on (size, mtimeMs, ino) compared with !==, a content
 * hash every 60 s, and the side-file tuples (exists, size, mtime) of S-wal and S-shm recorded
 * on every poll. Replaces network-watcher.ts's `>` test for personal vaults. Merge results never
 * depend on mtimes; this module only decides WHEN to look.
 */

import path from 'node:path';
import { sha256 } from './hashing.js';
import { isPublishTempName } from './paths.js';
import { SYNC_LOG_PREFIX, type FileStat, type SyncHost, type TimerHandle, type WatchHandle } from './host.js';
import type { SideFileTuple } from './types.js';

export const STAT_POLL_MS = 3_000;
export const HASH_POLL_MS = 60_000;
/** fs.watch fires bursts (rename dance, temp files); events are coalesced for this long. */
export const DIR_EVENT_SETTLE_MS = 250;

const VAULT_EXT = '.conduit';
const SIDE_FILES: ReadonlyArray<SideFileTuple['name']> = ['wal', 'shm'];

export interface FileSignature {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: string;
}

export type ChangeReason = 'dir-event' | 'stat' | 'hash' | 'appeared' | 'vanished';

export interface FileWatchListener {
  /** S may have changed; the engine runs a cycle. Never called for acknowledged signatures/hashes. */
  sharedChanged(reason: ChangeReason): void;
  /** Every stat poll: S-wal and S-shm tuples (side-files.ts decides the state). */
  sideFilesObserved(tuples: readonly SideFileTuple[]): void;
  /** Another entry of S's folder changed (the copy scanner re-scans; `fileName` may be null). */
  directoryChanged(fileName: string | null): void;
  /** fs.watch failed; polling continues. */
  watchError(err: Error): void;
}

export function signatureOf(stat: FileStat | null): FileSignature | null {
  return stat === null ? null : { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
}

/** != on size, mtimeMs and ino; null versus non-null differs. */
export function signaturesDiffer(a: FileSignature | null, b: FileSignature | null): boolean {
  if (a === null || b === null) return a !== b;
  return a.size !== b.size || a.mtimeMs !== b.mtimeMs || a.ino !== b.ino;
}

export interface FileWatcherPort {
  start(): void;
  stop(): void;
  /** After our own read or publish: this signature and hash are known, not a change. */
  acknowledge(signature: FileSignature | null, sha256: string | null): void;
  /** After a cycle that chose not to read S (kill switch): what the polls saw so far is known, not a change. */
  acknowledgeObserved(): void;
  /** After a rebind or rename (5.9). */
  setSharedPath(sharedPath: string): void;
  /** One stat poll now (tests, focus trigger). */
  pollNow(): Promise<void>;
  /** One hash poll now (tests). */
  hashNow(): Promise<void>;
}

export type FileWatchHost = Pick<SyncHost, 'fs' | 'timers' | 'clock' | 'logger'>;

function errorOf(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function codeOf(err: unknown): string {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : 'UNKNOWN';
}

function reasonFor(before: FileSignature | null, now: FileSignature | null): ChangeReason {
  if (before === null) return 'appeared';
  return now === null ? 'vanished' : 'stat';
}

export class SharedFileWatcher implements FileWatcherPort {
  private running = false;
  private stopped = false;
  private watch: WatchHandle | null = null;
  private rewatch = false;
  private timers: TimerHandle[] = [];
  private settle: TimerHandle | null = null;
  private settleShared = false;
  private readonly settleNames = new Set<string | null>();
  /** undefined: nothing acknowledged or observed yet (the first observation becomes the baseline). */
  private ackSig: FileSignature | null | undefined = undefined;
  private ackSha: string | null = null;
  /** The last stat signature and content hash the polls saw (undefined / null: none yet). */
  private seenSig: FileSignature | null | undefined = undefined;
  private seenSha: string | null = null;
  private polling: Promise<void> | null = null;
  private hashing: Promise<void> | null = null;
  private dirFlush: Promise<void> | null = null;
  private lastStatError: string | null = null;

  constructor(
    private sharedPath: string,
    private readonly host: FileWatchHost,
    private readonly listener: FileWatchListener,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.openWatch();
    this.timers = [
      this.host.timers.setInterval(() => void this.pollNow(), STAT_POLL_MS),
      this.host.timers.setInterval(() => void this.hashNow(), HASH_POLL_MS),
    ];
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.running = false;
    for (const t of this.timers) t.cancel();
    this.timers = [];
    this.settle?.cancel();
    this.settle = null;
    this.settleNames.clear();
    this.settleShared = false;
    this.closeWatch();
  }

  acknowledge(signature: FileSignature | null, sha256: string | null): void {
    this.ackSig = signature === null ? null : { size: signature.size, mtimeMs: signature.mtimeMs, ino: signature.ino };
    if (sha256 !== null) this.ackSha = sha256;
  }

  acknowledgeObserved(): void {
    if (this.seenSig !== undefined) this.ackSig = this.seenSig;
    if (this.seenSha !== null) this.ackSha = this.seenSha;
  }

  setSharedPath(sharedPath: string): void {
    if (sharedPath === this.sharedPath) return;
    const dirChanged = path.dirname(sharedPath) !== path.dirname(this.sharedPath);
    this.sharedPath = sharedPath;
    this.ackSig = undefined;
    this.ackSha = null;
    this.seenSig = undefined;
    this.seenSha = null;
    this.lastStatError = null;
    if (dirChanged && this.running) {
      this.closeWatch();
      this.openWatch();
    }
  }

  pollNow(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.polling ??= this.statPoll().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  hashNow(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.hashing ??= this.hashPoll().finally(() => {
      this.hashing = null;
    });
    return this.hashing;
  }

  /** Resolves once the polls and folder-event check already running are done; starts none (tests). */
  async settled(): Promise<void> {
    for (;;) {
      const running = [this.polling, this.hashing, this.dirFlush].filter((p): p is Promise<void> => p !== null);
      if (running.length === 0) return;
      await Promise.all(running);
    }
  }

  // ---------- Directory watch ----------

  private openWatch(): void {
    const dir = path.dirname(this.sharedPath);
    try {
      this.watch = this.host.fs.watchDir(
        dir,
        (_type, fileName) => this.onDirEvent(fileName),
        (err) => this.onWatchError(err),
      );
      this.rewatch = false;
    } catch (err) {
      this.watch = null;
      this.onWatchError(errorOf(err));
    }
  }

  private closeWatch(): void {
    const w = this.watch;
    this.watch = null;
    if (w === null) return;
    try {
      w.close();
    } catch (err) {
      this.host.logger.warn(`${SYNC_LOG_PREFIX} closing the folder watch failed`, { code: codeOf(err) });
    }
  }

  private onWatchError(err: Error): void {
    this.host.logger.warn(`${SYNC_LOG_PREFIX} folder watch failed; polling continues`, { code: codeOf(err) });
    this.closeWatch();
    this.rewatch = true;
    this.listener.watchError(err);
  }

  private onDirEvent(fileName: string | null): void {
    if (this.stopped) return;
    const sharedName = path.basename(this.sharedPath);
    if (fileName === sharedName) {
      this.settleShared = true;
    } else if (fileName === null) {
      this.settleShared = true;
      this.settleNames.add(null);
    } else if (!isPublishTempName(fileName) && fileName.toLowerCase().endsWith(VAULT_EXT)) {
      this.settleNames.add(fileName);
    } else {
      return;
    }
    this.settle ??= this.host.timers.setTimeout(() => {
      this.dirFlush = this.flushDirEvents().finally(() => {
        this.dirFlush = null;
      });
    }, DIR_EVENT_SETTLE_MS);
  }

  private async flushDirEvents(): Promise<void> {
    this.settle = null;
    const names = [...this.settleNames];
    const shared = this.settleShared;
    this.settleNames.clear();
    this.settleShared = false;
    for (const name of names) this.listener.directoryChanged(name);
    if (!shared) return;
    const sig = await this.statShared();
    if (sig === undefined || this.stopped) return;
    if (this.compare(sig) !== null) this.listener.sharedChanged('dir-event');
  }

  // ---------- Polls ----------

  /** The signature of S, or undefined when the stat itself failed (logged once per error code). */
  private async statShared(): Promise<FileSignature | null | undefined> {
    try {
      const sig = signatureOf(await this.host.fs.stat(this.sharedPath));
      this.lastStatError = null;
      return sig;
    } catch (err) {
      const code = codeOf(err);
      if (code !== this.lastStatError) {
        this.host.logger.warn(`${SYNC_LOG_PREFIX} cannot stat the shared file`, { code });
        this.lastStatError = code;
      }
      return undefined;
    }
  }

  /** The change reason versus the acknowledged signature; the first observation is the silent baseline. */
  private compare(sig: FileSignature | null): ChangeReason | null {
    this.seenSig = sig;
    if (this.ackSig === undefined) {
      this.ackSig = sig;
      return null;
    }
    return signaturesDiffer(this.ackSig, sig) ? reasonFor(this.ackSig, sig) : null;
  }

  private async statPoll(): Promise<void> {
    if (this.rewatch && this.running) this.openWatch();
    const sig = await this.statShared();
    const tuples = await this.sideFileTuples();
    if (this.stopped) return;
    if (sig !== undefined) {
      const reason = this.compare(sig);
      if (reason !== null) this.listener.sharedChanged(reason);
    }
    if (tuples !== null) this.listener.sideFilesObserved(tuples);
  }

  private async sideFileTuples(): Promise<SideFileTuple[] | null> {
    try {
      const out: SideFileTuple[] = [];
      for (const name of SIDE_FILES) {
        const st = await this.host.fs.stat(`${this.sharedPath}-${name}`);
        out.push(st === null ? { name, exists: false, size: 0, mtimeMs: 0 } : { name, exists: true, size: st.size, mtimeMs: st.mtimeMs });
      }
      return out;
    } catch (err) {
      this.host.logger.warn(`${SYNC_LOG_PREFIX} cannot stat the side files`, { code: codeOf(err) });
      return null;
    }
  }

  private async hashPoll(): Promise<void> {
    let bytes: Buffer;
    try {
      bytes = await this.host.fs.readFile(this.sharedPath);
    } catch (err) {
      const code = codeOf(err);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        this.host.logger.warn(`${SYNC_LOG_PREFIX} cannot read the shared file for the hash poll`, { code });
      }
      return;
    }
    if (this.stopped) return;
    const sha = sha256(bytes).toString('hex');
    this.seenSha = sha;
    if (this.ackSha === null) {
      this.ackSha = sha;
      return;
    }
    if (sha !== this.ackSha) this.listener.sharedChanged('hash');
  }
}
