/**
 * Network share advisory locking.
 *
 * Uses a `.lock` file alongside the vault file to prevent concurrent
 * access on network shares. The lock file contains JSON metadata
 * including a heartbeat timestamp for stale lock detection.
 *
 * Protocol:
 *   1. Check if .lock file exists
 *   2. If exists and heartbeat > 60s ago → stale, delete and acquire
 *   3. If exists and fresh → blocked (Pro) or proceed (Team)
 *   4. Acquire: write .lock.tmp → rename atomically → verify
 *   5. Heartbeat: update heartbeat_at every 30s
 *   6. Release: delete .lock file on vault lock / app quit
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** How often to update the heartbeat (ms). */
const HEARTBEAT_INTERVAL_MS = 30_000;

/** How old a heartbeat must be to consider the lock stale (ms). */
const STALE_THRESHOLD_MS = 60_000;

export interface NetworkLockInfo {
  locked_by: string;
  device_name: string;
  pid: number;
  locked_at: string;
  heartbeat_at: string;
}

export interface NetworkLockStatus {
  isLocked: boolean;
  isStale: boolean;
  isOwnLock: boolean;
  info: NetworkLockInfo | null;
}

export interface AcquireNetworkLockResult {
  success: boolean;
  info?: NetworkLockInfo;
}

export class NetworkLockService {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lockedPath: string | null = null;
  private lockFilePath: string | null = null;

  /**
   * Check if a path is on a network share.
   */
  static isNetworkPath(filePath: string): boolean {
    // UNC paths (Windows network shares)
    if (filePath.startsWith('\\\\') || filePath.startsWith('//')) {
      return true;
    }

    // macOS /Volumes/ (external/network mounts)
    if (filePath.startsWith('/Volumes/')) {
      return true;
    }

    // Windows mapped drives (Z:\, etc.) — heuristic
    if (/^[A-Z]:\\/i.test(filePath) && process.platform === 'win32') {
      // Could be local or mapped — we'll be conservative and check
      // For now, treat all non-C: drives as potentially network
      const drive = filePath[0].toUpperCase();
      if (drive !== 'C') {
        return true;
      }
    }

    // Linux common network mount points
    if (filePath.startsWith('/mnt/') || filePath.startsWith('/media/')) {
      return true;
    }

    // Cloud-synced folders — fs.watch is unreliable because sync services
    // atomically replace files (inode swap), breaking the watcher.
    // Use polling instead for reliable change detection.
    if (filePath.includes('/Mobile Documents/') || filePath.includes('/CloudDocs/')) {
      return true; // macOS iCloud Drive
    }
    if (filePath.includes('OneDrive') || filePath.includes('Google Drive') || filePath.includes('Dropbox')) {
      return true;
    }

    return false;
  }

  /**
   * Check the lock status for a vault file.
   */
  checkLock(vaultPath: string, userId?: string): NetworkLockStatus {
    const lockPath = this.getLockPath(vaultPath);

    if (!fs.existsSync(lockPath)) {
      return { isLocked: false, isStale: false, isOwnLock: false, info: null };
    }

    try {
      const raw = fs.readFileSync(lockPath, 'utf-8');
      const info = JSON.parse(raw) as NetworkLockInfo;

      const heartbeatAge = Date.now() - new Date(info.heartbeat_at).getTime();
      const isStale = heartbeatAge > STALE_THRESHOLD_MS;
      const isOwnLock = userId ? info.locked_by === userId : false;

      return {
        isLocked: !isStale,
        isStale,
        isOwnLock,
        info,
      };
    } catch {
      // Corrupt lock file — treat as stale
      return { isLocked: false, isStale: true, isOwnLock: false, info: null };
    }
  }

  /**
   * Try to acquire an advisory lock on the vault file.
   *
   * Returns success: false if another user holds a fresh lock.
   */
  acquireLock(vaultPath: string, userId: string): AcquireNetworkLockResult {
    const lockPath = this.getLockPath(vaultPath);
    const status = this.checkLock(vaultPath, userId);

    if (status.isLocked && !status.isOwnLock) {
      return { success: false, info: status.info ?? undefined };
    }

    // If stale or own lock, delete first
    if (fs.existsSync(lockPath)) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // May fail on network shares — try to proceed
      }
    }

    // Write lock atomically: write .tmp then rename
    const info: NetworkLockInfo = {
      locked_by: userId,
      device_name: os.hostname(),
      pid: process.pid,
      locked_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
    };

    const tmpPath = lockPath + '.tmp';

    try {
      // Ensure parent directory exists
      const dir = path.dirname(lockPath);
      fs.mkdirSync(dir, { recursive: true });

      fs.writeFileSync(tmpPath, JSON.stringify(info, null, 2), 'utf-8');
      fs.renameSync(tmpPath, lockPath);

      // Verify we own the lock (race protection)
      const verifyRaw = fs.readFileSync(lockPath, 'utf-8');
      const verify = JSON.parse(verifyRaw) as NetworkLockInfo;
      if (verify.locked_by !== userId || verify.pid !== process.pid) {
        return { success: false, info: verify };
      }
    } catch (err) {
      // Cleanup tmp if it exists
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
      console.warn('[network-lock] Failed to acquire lock:', err);
      return { success: false };
    }

    // Start heartbeat
    this.lockedPath = vaultPath;
    this.lockFilePath = lockPath;
    this.startHeartbeat(lockPath, userId);

    return { success: true };
  }

  /**
   * Release the advisory lock.
   */
  releaseLock(vaultPath?: string): void {
    const targetPath = vaultPath ?? this.lockedPath;
    if (!targetPath) return;

    this.stopHeartbeat();

    const lockPath = vaultPath ? this.getLockPath(vaultPath) : this.lockFilePath;
    if (lockPath && fs.existsSync(lockPath)) {
      try {
        fs.unlinkSync(lockPath);
      } catch (err) {
        console.warn('[network-lock] Failed to release lock:', err);
      }
    }

    this.lockedPath = null;
    this.lockFilePath = null;
  }

  /** Clean up on app quit. */
  cleanup(): void {
    this.releaseLock();
  }

  // ---------- Internal ----------

  private getLockPath(vaultPath: string): string {
    return vaultPath + '.lock';
  }

  private startHeartbeat(lockPath: string, userId: string): void {
    this.stopHeartbeat();

    this.heartbeatTimer = setInterval(() => {
      try {
        if (!fs.existsSync(lockPath)) {
          this.stopHeartbeat();
          return;
        }

        const raw = fs.readFileSync(lockPath, 'utf-8');
        const info = JSON.parse(raw) as NetworkLockInfo;

        // Only update if we still own the lock
        if (info.locked_by !== userId) {
          this.stopHeartbeat();
          return;
        }

        info.heartbeat_at = new Date().toISOString();
        fs.writeFileSync(lockPath, JSON.stringify(info, null, 2), 'utf-8');
      } catch (err) {
        console.warn('[network-lock] Heartbeat failed:', err);
      }
    }, HEARTBEAT_INTERVAL_MS);

    if (this.heartbeatTimer.unref) {
      this.heartbeatTimer.unref();
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
