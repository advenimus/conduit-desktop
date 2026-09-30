/**
 * Local folder backup service for the vault.
 *
 * Orchestrates debounced encrypted backups to a user-chosen directory,
 * retention-based pruning, and state broadcasting to the renderer.
 */

import fs from 'node:fs';
import path from 'node:path';
import { encryptForLocalBackup, decryptFromLocalBackup } from './local-backup-crypto.js';
import { readBackupBytes, type SnapshotWriter } from './backup-snapshot.js';
import { AppState } from '../state.js';

/** Debounce delay after last mutation before writing backup (ms). */
const DEBOUNCE_MS = 5_000;

/** Interval for periodic prune of old backups (ms) — 6 hours. */
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Vault backup filename prefix. */
const VAULT_PREFIX = 'conduit-vault-';

/**
 * Legacy chat backup filename prefix. Kept only for cleanup of pre-existing
 * files left behind after chat history was removed from the app.
 */
const LEGACY_CHAT_PREFIX = 'conduit-chat-';

/** Encrypted file extension. */
const ENC_EXT = '.enc';

export type LocalBackupStatus = 'idle' | 'backing-up' | 'backed-up' | 'error' | 'disabled';

export interface LocalBackupState {
  status: LocalBackupStatus;
  lastBackedUpAt: string | null;
  error: string | null;
  enabled: boolean;
  backupPath: string | null;
  retentionDays: number;
}

export interface LocalBackupEntry {
  name: string;
  fullPath: string;
  created_at: string;
  size: number;
  type: 'vault';
}

export class LocalBackupService {
  private masterPasswordBuf: Buffer | null = null;
  private vaultPath: string | null = null;
  private snapshot: SnapshotWriter | null = null;
  private enabled = false;
  private backupPath: string | null = null;
  private retentionDays = 30;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private backingUp = false;
  private pendingMutation = false;

  private state: LocalBackupState = {
    status: 'disabled',
    lastBackedUpAt: null,
    error: null,
    enabled: false,
    backupPath: null,
    retentionDays: 30,
  };

  /**
   * Configure the local backup service after vault unlock. `snapshot` (vaults the sync engine
   * manages) backs up a snapshot of the working copy instead of reading `vaultPath`.
   */
  configure(opts: {
    masterPassword: string;
    vaultPath: string;
    enabled: boolean;
    backupPath: string | null;
    retentionDays: number;
    snapshot?: SnapshotWriter | null;
  }): void {
    if (this.masterPasswordBuf) this.masterPasswordBuf.fill(0);
    this.masterPasswordBuf = Buffer.from(opts.masterPassword, 'utf-8');
    this.vaultPath = opts.vaultPath;
    this.snapshot = opts.snapshot ?? null;
    this.enabled = opts.enabled;
    this.backupPath = opts.backupPath;
    this.retentionDays = opts.retentionDays;

    if (opts.enabled && opts.backupPath) {
      this.updateState({
        status: 'idle',
        enabled: true,
        error: null,
        backupPath: opts.backupPath,
        retentionDays: opts.retentionDays,
      });

      // Prune old backups on startup
      this.pruneOldBackups().catch(() => {});

      // Set up periodic prune
      this.clearPruneTimer();
      this.pruneTimer = setInterval(() => {
        this.pruneOldBackups().catch(() => {});
      }, PRUNE_INTERVAL_MS);
    } else {
      this.updateState({
        status: 'disabled',
        enabled: false,
        error: null,
        backupPath: opts.backupPath,
        retentionDays: opts.retentionDays,
      });
    }
  }

  /**
   * Disable local backup and clear internal state.
   */
  disable(): void {
    this.clearDebounce();
    this.clearPruneTimer();
    this.enabled = false;
    if (this.masterPasswordBuf) {
      this.masterPasswordBuf.fill(0);
      this.masterPasswordBuf = null;
    }
    this.vaultPath = null;
    this.snapshot = null;
    this.updateState({ status: 'disabled', enabled: false, error: null });
  }

  /**
   * Update settings without full reconfigure (for retention changes).
   */
  updateSettings(opts: { retentionDays?: number }): void {
    if (opts.retentionDays !== undefined) {
      this.retentionDays = opts.retentionDays;
    }
    this.updateState({
      retentionDays: this.retentionDays,
    });
  }

  /**
   * Called by the vault mutation hook. Debounces: waits 5s after last mutation.
   */
  notifyMutation(): void {
    if (!this.enabled) return;

    this.clearDebounce();

    if (this.backingUp) {
      this.pendingMutation = true;
      return;
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.doBackup().catch((err) => {
        console.error('[local-backup] Backup failed:', err);
      });
    }, DEBOUNCE_MS);
  }

  /**
   * Force an immediate backup (no debounce).
   */
  async backupNow(): Promise<void> {
    if (!this.enabled) {
      throw new Error('Local backup is not enabled');
    }
    this.clearDebounce();
    await this.doBackup();
  }

  /**
   * List all backup files in the backup directory.
   */
  listBackups(): LocalBackupEntry[] {
    if (!this.backupPath) return [];

    try {
      if (!fs.existsSync(this.backupPath)) return [];

      const files = fs.readdirSync(this.backupPath);
      const entries: LocalBackupEntry[] = [];

      for (const name of files) {
        if (!name.endsWith(ENC_EXT)) continue;
        if (!name.startsWith(VAULT_PREFIX)) continue;

        const fullPath = path.join(this.backupPath, name);
        try {
          const stat = fs.statSync(fullPath);
          entries.push({
            name,
            fullPath,
            created_at: stat.mtime.toISOString(),
            size: stat.size,
            type: 'vault',
          });
        } catch {
          // Skip files we can't stat
        }
      }

      // Sort newest first
      entries.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      return entries;
    } catch (err) {
      console.warn('[local-backup] Failed to list backups:', err);
      return [];
    }
  }

  /**
   * Delete a specific backup file.
   */
  deleteBackup(fullPath: string): void {
    // Safety: only delete files within the configured backup directory
    if (!this.backupPath) throw new Error('No backup path configured');
    const resolved = path.resolve(fullPath);
    const resolvedBase = path.resolve(this.backupPath);
    if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
      throw new Error('Invalid backup path');
    }

    fs.unlinkSync(resolved);
  }

  /**
   * Restore vault from a local backup file.
   * Returns the decrypted raw vault bytes.
   */
  restoreFromLocalBackup(backupFilePath: string, masterPassword: string): Buffer {
    const blob = fs.readFileSync(backupFilePath);
    return decryptFromLocalBackup(blob, masterPassword);
  }

  /**
   * Get the current state.
   */
  getState(): LocalBackupState {
    return { ...this.state };
  }

  // ── Private helpers ──────────────────────────────────────

  private async doBackup(): Promise<void> {
    const masterPasswordBuf = this.masterPasswordBuf;
    const vaultPath = this.vaultPath;
    const snapshot = this.snapshot;
    const backupDir = this.backupPath;

    if (!masterPasswordBuf || !vaultPath || !backupDir) {
      return;
    }

    this.backingUp = true;
    this.pendingMutation = false;
    this.updateState({ status: 'backing-up', error: null });

    try {
      // Ensure backup directory exists
      fs.mkdirSync(backupDir, { recursive: true });

      const now = new Date();
      const ts = this.formatTimestamp(now);
      const masterPassword = masterPasswordBuf.toString('utf-8');

      const vaultBuffer = await readBackupBytes({ vaultPath, snapshot });
      const encryptedVault = encryptForLocalBackup(vaultBuffer, masterPassword);
      const vaultFilename = `${VAULT_PREFIX}${ts}${ENC_EXT}`;
      this.atomicWrite(path.join(backupDir, vaultFilename), encryptedVault);

      const nowStr = now.toISOString();
      this.updateState({ status: 'backed-up', lastBackedUpAt: nowStr, error: null });
      console.log('[local-backup] Backup complete at', nowStr);

      // Prune old backups after successful backup
      this.pruneOldBackups().catch((err) => {
        console.warn('[local-backup] Prune failed:', err);
      });
    } catch (err) {
      const msg = this.describeError(err);
      console.error('[local-backup] Backup error:', msg);
      this.updateState({ status: 'error', error: msg });
    } finally {
      this.backingUp = false;

      // If a mutation arrived during backup, schedule another
      if (this.pendingMutation && this.enabled) {
        this.pendingMutation = false;
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          this.doBackup().catch((err) => {
            console.error('[local-backup] Retry backup failed:', err);
          });
        }, DEBOUNCE_MS);
      }
    }
  }

  private async pruneOldBackups(): Promise<void> {
    if (!this.backupPath || this.retentionDays <= 0) return;

    const cutoff = new Date(Date.now() - this.retentionDays * 24 * 60 * 60 * 1000);
    const backups = this.listBackups();

    let pruned = 0;
    for (const backup of backups) {
      if (new Date(backup.created_at) < cutoff) {
        try {
          fs.unlinkSync(backup.fullPath);
          pruned++;
        } catch {
          // Skip files we can't delete
        }
      }
    }

    if (pruned > 0) {
      console.log(`[local-backup] Pruned ${pruned} backup(s) older than ${this.retentionDays} day(s)`);
    }

    this.cleanupLegacyChatBackups();
  }

  /**
   * Sweep any pre-existing `conduit-chat-*.enc` files left behind from when
   * chat history was backed up. Runs every prune cycle (best-effort).
   */
  private cleanupLegacyChatBackups(): void {
    if (!this.backupPath) return;
    try {
      if (!fs.existsSync(this.backupPath)) return;
      const files = fs.readdirSync(this.backupPath);
      let removed = 0;
      for (const name of files) {
        if (!name.startsWith(LEGACY_CHAT_PREFIX) || !name.endsWith(ENC_EXT)) continue;
        try {
          fs.unlinkSync(path.join(this.backupPath, name));
          removed++;
        } catch {
          // Skip files we can't delete
        }
      }
      if (removed > 0) {
        console.log(`[local-backup] Removed ${removed} legacy chat backup file(s)`);
      }
    } catch {
      // Best-effort cleanup
    }
  }

  private atomicWrite(filePath: string, data: Buffer): void {
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, data);
    fs.renameSync(tmpPath, filePath);
  }

  private formatTimestamp(date: Date): string {
    return date.toISOString()
      .replace(/[:.]/g, '-')
      .replace('T', '_')
      .slice(0, 19);
  }

  private describeError(err: unknown): string {
    if (!(err instanceof Error)) return 'Backup failed';
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'Backup folder not found. It may have been deleted.';
    if (code === 'EACCES') return 'Permission denied. Cannot write to backup folder.';
    if (code === 'ENOSPC') return 'Disk full. Not enough space for backup.';
    return err.message;
  }

  private updateState(partial: Partial<LocalBackupState>): void {
    this.state = { ...this.state, ...partial };
    this.notifyRenderer();
  }

  private notifyRenderer(): void {
    const win = AppState.getInstance().getMainWindow();
    if (win) {
      win.webContents.send('local-backup:state-changed', this.state);
    }
  }

  private clearDebounce(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private clearPruneTimer(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }
}
