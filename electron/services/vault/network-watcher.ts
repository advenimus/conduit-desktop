/**
 * Network vault watcher.
 *
 * Monitors a vault file for external changes (e.g. another user on a
 * network share edited it). Uses polling for network paths (stat.mtimeMs
 * every 3s) and fs.watch() for local paths with a polling fallback.
 *
 * When a change is detected and we don't hold the write lock,
 * the callback fires so the vault can be reloaded.
 */

import fs from 'node:fs';
import { NetworkLockService } from './network-lock.js';

/** Polling interval for network paths (ms). */
const NETWORK_POLL_MS = 3_000;

/** Polling interval for local fallback (ms). */
const LOCAL_POLL_MS = 5_000;

export class NetworkVaultWatcher {
  private filePath: string;
  private lastMtime: number = 0;
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

    // Read initial mtime
    try {
      const stat = fs.statSync(this.filePath);
      this.lastMtime = stat.mtimeMs;
    } catch {
      this.lastMtime = 0;
    }

    if (this.isNetworkPath) {
      // Network paths: poll-based (fs.watch unreliable on SMB/NFS)
      this.pollTimer = setInterval(() => this.checkMtime(), NETWORK_POLL_MS);
      if (this.pollTimer.unref) this.pollTimer.unref();
    } else {
      // Local paths: use fs.watch with fallback to polling
      try {
        this.fsWatcher = fs.watch(this.filePath, { persistent: false }, (eventType) => {
          if (eventType === 'change') {
            this.handlePotentialChange();
          }
        });

        this.fsWatcher.on('error', () => {
          // Fallback to polling
          this.fsWatcher?.close();
          this.fsWatcher = null;
          this.startPolling(LOCAL_POLL_MS);
        });
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
      // Refresh mtime after our own write
      try {
        const stat = fs.statSync(this.filePath);
        this.lastMtime = stat.mtimeMs;
      } catch {
        // ignore
      }
    }
  }

  // ---------- Internal ----------

  private startPolling(intervalMs: number): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.checkMtime(), intervalMs);
    if (this.pollTimer.unref) this.pollTimer.unref();
  }

  private checkMtime(): void {
    if (this.writeLockHeld) return;

    try {
      const stat = fs.statSync(this.filePath);
      if (stat.mtimeMs > this.lastMtime) {
        this.lastMtime = stat.mtimeMs;
        this.onChange();
      }
    } catch {
      // File may have been deleted or is inaccessible — ignore
    }
  }

  private handlePotentialChange(): void {
    if (this.writeLockHeld) return;

    // Debounce by checking actual mtime change
    try {
      const stat = fs.statSync(this.filePath);
      if (stat.mtimeMs > this.lastMtime) {
        this.lastMtime = stat.mtimeMs;
        this.onChange();
      }
    } catch {
      // ignore
    }
  }
}
