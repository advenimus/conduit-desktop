/**
 * Network vault watcher.
 *
 * Monitors a vault file for external changes (e.g. another user on a
 * network share edited it). Uses polling for network paths (stat.mtimeMs
 * every 3s) and fs.watch() for local paths with a polling fallback.
 *
 * When a change is detected and we don't hold the write lock,
 * the callback fires so the vault can be reloaded. A change is any difference in
 * (mtime, size, inode), so a file replaced by rename or set back to an older mtime by a
 * cloud drive counts too (spec 5.4 / 11.4). Vaults the sync engine manages never use this
 * watcher (sync/file-watch.ts watches their shared file).
 */

import fs from 'node:fs';
import { NetworkLockService } from './network-lock.js';

/** Polling interval for network paths (ms). */
const NETWORK_POLL_MS = 3_000;

/** Polling interval for local fallback (ms). */
const LOCAL_POLL_MS = 5_000;

export class NetworkVaultWatcher {
  private filePath: string;
  private lastSignature: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private fsWatcher: fs.FSWatcher | null = null;
  private onChange: () => void;
  private isNetworkPath: boolean;
  /** While true, we skip change detection (we're the one writing). */
  private writeLockHeld = false;

  constructor(filePath: string, onChange: () => void) {
    this.filePath = filePath;
    this.onChange = onChange;
    this.isNetworkPath = NetworkLockService.isNetworkPath(filePath);
  }

  /** Start watching for external changes. */
  start(): void {
    this.stop();

    this.lastSignature = this.readSignature();

    if (this.isNetworkPath) {
      // Network paths: poll-based (fs.watch unreliable on SMB/NFS)
      this.pollTimer = setInterval(() => this.checkForChange(), NETWORK_POLL_MS);
      if (this.pollTimer.unref) this.pollTimer.unref();
    } else {
      // Local paths: use fs.watch with fallback to polling
      try {
        this.fsWatcher = fs.watch(this.filePath, { persistent: false }, (eventType) => {
          if (eventType === 'change') {
            this.checkForChange();
          } else if (eventType === 'rename') {
            // The watched inode is gone (replaced by rename): poll the path from now on.
            this.fallBackToPolling();
            this.checkForChange();
          }
        });

        this.fsWatcher.on('error', () => this.fallBackToPolling());
      } catch {
        // fs.watch not available, fall back to polling
        this.startPolling(LOCAL_POLL_MS);
      }
    }
  }

  /** Stop watching. */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }
  }

  /** Signal that we're about to write (suppress change detection). */
  setWriteLock(held: boolean): void {
    this.writeLockHeld = held;
    if (!held) {
      // Our own write changed the file: take its new signature as the baseline.
      this.lastSignature = this.readSignature();
    }
  }

  // ---------- Internal ----------

  private startPolling(intervalMs: number): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.checkForChange(), intervalMs);
    if (this.pollTimer.unref) this.pollTimer.unref();
  }

  private fallBackToPolling(): void {
    this.fsWatcher?.close();
    this.fsWatcher = null;
    this.startPolling(LOCAL_POLL_MS);
  }

  /** (mtime, size, inode) of the file, or null when it is missing or unreadable. */
  private readSignature(): string | null {
    try {
      const stat = fs.statSync(this.filePath);
      return `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
    } catch {
      return null;
    }
  }

  private checkForChange(): void {
    if (this.writeLockHeld) return;
    const signature = this.readSignature();
    // Missing or inaccessible (mid-replace): keep the old baseline and look again later.
    if (signature === null || signature === this.lastSignature) return;
    this.lastSignature = signature;
    this.onChange();
  }
}
