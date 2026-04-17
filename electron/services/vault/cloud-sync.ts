/**
 * Cloud vault sync service.
 *
 * Orchestrates debounced upload of the encrypted vault to Supabase Storage,
 * download for restore, versioned backup snapshots, and state broadcasting
 * to the renderer.
 */

import fs from 'node:fs';
import { encryptForCloud, decryptFromCloud } from './cloud-crypto.js';
import { AppState } from '../state.js';
import type { AuthService } from '../auth/supabase.js';

/** Maximum vault file size for cloud upload (10 MB). */
const MAX_VAULT_SIZE = 10 * 1024 * 1024;

/** Debounce delay after last mutation before uploading (ms). */
const DEBOUNCE_MS = 5_000;

/** Supabase Storage bucket name. */
const BUCKET = 'vaults';

/** File name within the user's folder. */
const VAULT_FILENAME = 'vault.enc';

/** Subfolder for versioned backup snapshots. */
const BACKUPS_FOLDER = 'backups';

export type CloudSyncStatus = 'idle' | 'syncing' | 'synced' | 'error' | 'disabled';

export interface CloudSyncState {
  status: CloudSyncStatus;
  lastSyncedAt: string | null;
  error: string | null;
  enabled: boolean;
}

export interface CloudBackupEntry {
  name: string;
  path: string;
  created_at: string;
  size: number;
  vaultId: string;
  vaultName: string;
}

/** Manifest tracking all backed-up vaults for a user. */
export interface CloudManifest {
  vaults: Record<string, {
    name: string;
    lastSyncedAt: string | null;
    size: number;
  }>;
}

const MANIFEST_FILENAME = 'manifest.json';

export class CloudSyncService {
  private authService: AuthService;
  private userId: string | null = null;
  private vaultId: string | null = null;
  private masterPasswordBuf: Buffer | null = null;
  private vaultPath: string | null = null;
  private enabled = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private uploading = false;
  private pendingMutation = false;

  private state: CloudSyncState = {
    status: 'disabled',
    lastSyncedAt: null,
    error: null,
    enabled: false,
  };

  constructor(authService: AuthService) {
    this.authService = authService;
  }

  /**
   * Configure the sync service after vault unlock.
   * If enabled=true, starts watching for mutations and hydrates last sync time.
   */
  configure(opts: {
    userId: string;
    vaultId: string;
    masterPassword: string;
    vaultPath: string;
    enabled: boolean;
  }): void {
    this.userId = opts.userId;
    this.vaultId = opts.vaultId;
    // Store as Buffer so we can zero it on disable
    if (this.masterPasswordBuf) this.masterPasswordBuf.fill(0);
    this.masterPasswordBuf = Buffer.from(opts.masterPassword, 'utf-8');
    this.vaultPath = opts.vaultPath;
    this.enabled = opts.enabled;

    if (opts.enabled) {
      this.updateState({ status: 'idle', enabled: true, error: null });
      // Fire-and-forget: hydrate lastSyncedAt from cloud metadata
      this.hydrateLastSyncedAt().catch(() => {});
    } else {
      this.updateState({ status: 'disabled', enabled: false, error: null });
    }
  }

  /**
   * Disable cloud sync and clear internal state.
   * Called on vault lock or when user disables sync.
   */
  disable(): void {
    this.clearDebounce();
    this.enabled = false;
    if (this.masterPasswordBuf) {
      this.masterPasswordBuf.fill(0);
      this.masterPasswordBuf = null;
    }
    this.userId = null;
    this.vaultId = null;
    this.vaultPath = null;
    this.updateState({ status: 'disabled', enabled: false, error: null });
  }

  /**
   * Called by the vault mutation hook. Debounces: waits 5s after the
   * last mutation before uploading.
   */
  notifyMutation(): void {
    if (!this.enabled) return;

    this.clearDebounce();

    if (this.uploading) {
      // An upload is in progress; flag that we need to re-upload when done
      this.pendingMutation = true;
      return;
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.doUpload().catch((err) => {
        console.error('[cloud-sync] Upload failed:', err);
      });
    }, DEBOUNCE_MS);
  }

  /**
   * Force an immediate sync (no debounce).
   */
  async syncNow(): Promise<void> {
    if (!this.enabled) {
      throw new Error('Cloud sync is not enabled');
    }
    this.clearDebounce();
    await this.doUpload();
  }

  /**
   * Check if a cloud vault exists for the given user.
   * Checks manifest first (per-vault layout), then falls back to legacy path.
   */
  async hasCloudVault(userId?: string): Promise<boolean> {
    const uid = userId ?? this.userId;
    if (!uid) return false;

    // Check manifest first (per-vault layout)
    const manifest = await this.readManifest(uid);
    if (manifest && Object.keys(manifest.vaults).length > 0) {
      return true;
    }

    // Legacy fallback: check for vault.enc at {userId}/vault.enc
    const supabase = this.authService.getSupabaseClient();
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .list(uid, { limit: 1, search: VAULT_FILENAME });

    if (error) {
      console.warn('[cloud-sync] Failed to check cloud vault:', error.message);
      return false;
    }

    return data.some((f) => f.name === VAULT_FILENAME);
  }

  /**
   * Download and decrypt the cloud vault.
   * Tries per-vault path from manifest first, then falls back to legacy path.
   * Returns the raw SQLite file bytes.
   */
  async downloadVault(masterPassword: string, userId?: string): Promise<Buffer> {
    const uid = userId ?? this.userId;
    if (!uid) throw new Error('No user ID for cloud vault download');

    const supabase = this.authService.getSupabaseClient();

    // Try manifest first — download the first (or most recently synced) vault
    const manifest = await this.readManifest(uid);
    if (manifest && Object.keys(manifest.vaults).length > 0) {
      // Pick the most recently synced vault
      const entries = Object.entries(manifest.vaults);
      entries.sort((a, b) => {
        const aTime = a[1].lastSyncedAt ?? '';
        const bTime = b[1].lastSyncedAt ?? '';
        return bTime.localeCompare(aTime);
      });
      const [vId] = entries[0];
      const storagePath = `${uid}/${vId}/${VAULT_FILENAME}`;

      const { data, error } = await supabase.storage
        .from(BUCKET)
        .download(storagePath);

      if (!error && data) {
        const blob = Buffer.from(await data.arrayBuffer());
        return decryptFromCloud(blob, masterPassword);
      }
      // Fall through to legacy if per-vault download fails
    }

    // Legacy path
    const storagePath = `${uid}/${VAULT_FILENAME}`;
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .download(storagePath);

    if (error) {
      throw new Error(`Failed to download cloud vault: ${error.message}`);
    }

    const blob = Buffer.from(await data.arrayBuffer());
    return decryptFromCloud(blob, masterPassword);
  }

  /**
   * Delete the cloud vault and all backup snapshots for the current vault.
   * Removes from per-vault path + legacy path, and updates the manifest.
   */
  async deleteCloudVault(): Promise<void> {
    if (!this.userId) throw new Error('No user ID for cloud vault deletion');

    const supabase = this.authService.getSupabaseClient();
    const filesToDelete: string[] = [];

    // Delete per-vault files if we have a vaultId
    if (this.vaultId) {
      const prefix = `${this.userId}/${this.vaultId}`;
      filesToDelete.push(`${prefix}/${VAULT_FILENAME}`);

      const { data: backups } = await supabase.storage
        .from(BUCKET)
        .list(`${prefix}/${BACKUPS_FOLDER}`, { limit: 1000 });

      if (backups?.length) {
        for (const file of backups) {
          filesToDelete.push(`${prefix}/${BACKUPS_FOLDER}/${file.name}`);
        }
      }
    }

    // Also delete legacy path files
    filesToDelete.push(`${this.userId}/${VAULT_FILENAME}`);

    const { data: legacyBackups } = await supabase.storage
      .from(BUCKET)
      .list(`${this.userId}/${BACKUPS_FOLDER}`, { limit: 1000 });

    if (legacyBackups?.length) {
      for (const file of legacyBackups) {
        filesToDelete.push(`${this.userId}/${BACKUPS_FOLDER}/${file.name}`);
      }
    }

    if (filesToDelete.length > 0) {
      const { error } = await supabase.storage
        .from(BUCKET)
        .remove(filesToDelete);

      if (error) {
        throw new Error(`Failed to delete cloud vault: ${error.message}`);
      }
    }

    // Remove this vault from the manifest
    if (this.vaultId) {
      await this.removeFromManifest(this.userId, this.vaultId);
    }
  }

  /**
   * List versioned backup snapshots for the current vault, sorted newest-first.
   * Uses per-vault path if vaultId is set, otherwise legacy path.
   */
  async listBackups(): Promise<CloudBackupEntry[]> {
    const uid = this.userId;
    if (!uid) return [];

    const supabase = this.authService.getSupabaseClient();
    const vid = this.vaultId;
    const backupsPrefix = vid
      ? `${uid}/${vid}/${BACKUPS_FOLDER}`
      : `${uid}/${BACKUPS_FOLDER}`;

    const { data, error } = await supabase.storage
      .from(BUCKET)
      .list(backupsPrefix, {
        limit: 200,
        sortBy: { column: 'created_at', order: 'desc' },
      });

    if (error) {
      console.warn('[cloud-sync] Failed to list backups:', error.message);
      return [];
    }

    return (data ?? [])
      .filter((f) => f.name.endsWith('.enc'))
      .map((f) => ({
        name: f.name,
        path: `${backupsPrefix}/${f.name}`,
        created_at: f.created_at ?? f.updated_at ?? '',
        size: f.metadata?.size ?? 0,
        vaultId: vid ?? 'legacy',
        vaultName: this.getCurrentVaultName(),
      }));
  }

  /**
   * List backup snapshots from ALL cloud-backed vaults, grouped by vault.
   *
   * Reads the manifest (if present) to discover per-vault backup folders.
   * Falls back to the single-vault legacy layout when no manifest exists.
   */
  async listAllVaultBackups(): Promise<CloudBackupEntry[]> {
    const uid = this.userId;
    if (!uid) return [];

    const supabase = this.authService.getSupabaseClient();

    // Try to read the manifest to discover all vaults
    const manifest = await this.readManifest(uid);

    if (manifest && Object.keys(manifest.vaults).length > 0) {
      // Per-vault storage layout: {userId}/{vaultId}/backups/
      const allBackups: CloudBackupEntry[] = [];

      for (const [vaultId, meta] of Object.entries(manifest.vaults)) {
        const { data, error } = await supabase.storage
          .from(BUCKET)
          .list(`${uid}/${vaultId}/${BACKUPS_FOLDER}`, {
            limit: 200,
            sortBy: { column: 'created_at', order: 'desc' },
          });

        if (error) {
          console.warn(`[cloud-sync] Failed to list backups for vault ${vaultId}:`, error.message);
          continue;
        }

        const vaultBackups = (data ?? [])
          .filter((f) => f.name.endsWith('.enc'))
          .map((f) => ({
            name: f.name,
            path: `${uid}/${vaultId}/${BACKUPS_FOLDER}/${f.name}`,
            created_at: f.created_at ?? f.updated_at ?? '',
            size: f.metadata?.size ?? 0,
            vaultId,
            vaultName: meta.name,
          }));

        allBackups.push(...vaultBackups);
      }

      // Also include any legacy backups at {userId}/backups/ (pre-migration)
      const { data: legacyData } = await supabase.storage
        .from(BUCKET)
        .list(`${uid}/${BACKUPS_FOLDER}`, {
          limit: 200,
          sortBy: { column: 'created_at', order: 'desc' },
        });

      if (legacyData?.length) {
        const legacyBackups = legacyData
          .filter((f) => f.name.endsWith('.enc'))
          .map((f) => ({
            name: f.name,
            path: `${uid}/${BACKUPS_FOLDER}/${f.name}`,
            created_at: f.created_at ?? f.updated_at ?? '',
            size: f.metadata?.size ?? 0,
            vaultId: 'legacy',
            vaultName: 'Previous backups',
          }));
        allBackups.push(...legacyBackups);
      }

      return allBackups;
    }

    // No manifest: legacy single-vault layout at {userId}/backups/
    return this.listLegacyBackups(uid);
  }

  /**
   * List backups from the legacy flat layout at {userId}/backups/.
   */
  private async listLegacyBackups(userId: string): Promise<CloudBackupEntry[]> {
    const supabase = this.authService.getSupabaseClient();
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .list(`${userId}/${BACKUPS_FOLDER}`, {
        limit: 200,
        sortBy: { column: 'created_at', order: 'desc' },
      });

    if (error) {
      console.warn('[cloud-sync] Failed to list legacy backups:', error.message);
      return [];
    }

    return (data ?? [])
      .filter((f) => f.name.endsWith('.enc'))
      .map((f) => ({
        name: f.name,
        path: `${userId}/${BACKUPS_FOLDER}/${f.name}`,
        created_at: f.created_at ?? f.updated_at ?? '',
        size: f.metadata?.size ?? 0,
        vaultId: 'legacy',
        vaultName: this.getCurrentVaultName(),
      }));
  }

  /**
   * Download and decrypt a specific backup snapshot.
   */
  async downloadBackup(storagePath: string, masterPassword: string): Promise<Buffer> {
    const supabase = this.authService.getSupabaseClient();

    const { data, error } = await supabase.storage
      .from(BUCKET)
      .download(storagePath);

    if (error) {
      throw new Error(`Failed to download backup: ${error.message}`);
    }

    const blob = Buffer.from(await data.arrayBuffer());
    return decryptFromCloud(blob, masterPassword);
  }

  /**
   * Get the backup_retention_days from the user's tier profile.
   * Returns -1 for unlimited, 0 if unavailable.
   */
  async getBackupRetentionDays(): Promise<number> {
    const authState = this.authService.getAuthState();
    const profile = authState.profile;
    if (!profile) return 0;
    const days = profile.tier?.features?.backup_retention_days;
    if (typeof days === 'number') return days;
    return 0;
  }

  /**
   * Get the current sync state.
   */
  getState(): CloudSyncState {
    return { ...this.state };
  }

  // ── Private helpers ──────────────────────────────────────

  /**
   * Derive a display name for the currently configured vault from its file path.
   * e.g. "/path/to/Work.conduit" → "Work", "/path/to/default.conduit" → "default"
   */
  private getCurrentVaultName(): string {
    if (!this.vaultPath) return 'Vault';
    const filename = this.vaultPath.split('/').pop() ?? this.vaultPath.split('\\').pop() ?? 'Vault';
    return filename.replace(/\.conduit$/, '') || 'Vault';
  }

  /**
   * Try to read the cloud manifest (manifest.json) for the given user.
   * Returns null if the manifest doesn't exist or can't be parsed.
   */
  private async readManifest(userId: string): Promise<CloudManifest | null> {
    const supabase = this.authService.getSupabaseClient();
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .download(`${userId}/${MANIFEST_FILENAME}`);

    if (error || !data) return null;

    try {
      const text = await data.text();
      return JSON.parse(text) as CloudManifest;
    } catch {
      console.warn('[cloud-sync] Failed to parse manifest.json');
      return null;
    }
  }

  /**
   * Create or update the manifest with the current vault's info.
   */
  private async updateManifest(
    userId: string,
    vaultId: string,
    vaultName: string,
    lastSyncedAt: string,
    size: number,
  ): Promise<void> {
    // Read existing manifest or create new
    const manifest = (await this.readManifest(userId)) ?? { vaults: {} };

    manifest.vaults[vaultId] = { name: vaultName, lastSyncedAt, size };

    const supabase = this.authService.getSupabaseClient();
    const blob = Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8');

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(`${userId}/${MANIFEST_FILENAME}`, blob, {
        upsert: true,
        contentType: 'application/octet-stream',
      });

    if (error) {
      console.warn('[cloud-sync] Failed to update manifest:', error.message);
    } else {
      console.log('[cloud-sync] Manifest updated for vault:', vaultName);
    }
  }

  /**
   * Remove a vault entry from the manifest.
   */
  private async removeFromManifest(userId: string, vaultId: string): Promise<void> {
    const manifest = await this.readManifest(userId);
    if (!manifest) return;

    delete manifest.vaults[vaultId];

    const supabase = this.authService.getSupabaseClient();
    const blob = Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8');

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(`${userId}/${MANIFEST_FILENAME}`, blob, {
        upsert: true,
        contentType: 'application/octet-stream',
      });

    if (error) {
      console.warn('[cloud-sync] Failed to update manifest after removal:', error.message);
    }
  }

  /**
   * Hydrate lastSyncedAt from the cloud vault.enc metadata.
   * Checks per-vault path first, then legacy. Non-blocking, failure is non-fatal.
   */
  private async hydrateLastSyncedAt(): Promise<void> {
    const uid = this.userId;
    if (!uid) return;

    const supabase = this.authService.getSupabaseClient();

    // Try per-vault path first
    if (this.vaultId) {
      const { data, error } = await supabase.storage
        .from(BUCKET)
        .list(`${uid}/${this.vaultId}`, { limit: 1, search: VAULT_FILENAME });

      if (!error && data?.length) {
        const vaultFile = data.find((f) => f.name === VAULT_FILENAME);
        if (vaultFile) {
          const updatedAt = vaultFile.updated_at ?? vaultFile.created_at;
          if (updatedAt) {
            this.updateState({ status: 'synced', lastSyncedAt: updatedAt });
            console.log('[cloud-sync] Hydrated lastSyncedAt from per-vault path:', updatedAt);
            return;
          }
        }
      }
    }

    // Legacy fallback
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .list(uid, { limit: 1, search: VAULT_FILENAME });

    if (error || !data?.length) return;

    const vaultFile = data.find((f) => f.name === VAULT_FILENAME);
    if (!vaultFile) return;

    const updatedAt = vaultFile.updated_at ?? vaultFile.created_at;
    if (updatedAt) {
      this.updateState({ status: 'synced', lastSyncedAt: updatedAt });
      console.log('[cloud-sync] Hydrated lastSyncedAt from legacy path:', updatedAt);
    }
  }

  /**
   * Upload a timestamped backup snapshot after the main vault.enc upload.
   * Uses per-vault path: {userId}/{vaultId}/backups/
   */
  private async uploadVersionedSnapshot(userId: string, vaultId: string, blob: Buffer): Promise<void> {
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const filename = `vault_${ts}.enc`;
    const storagePath = `${userId}/${vaultId}/${BACKUPS_FOLDER}/${filename}`;

    const supabase = this.authService.getSupabaseClient();
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, blob, {
        contentType: 'application/octet-stream',
      });

    if (error) {
      throw new Error(`Snapshot upload failed: ${error.message}`);
    }

    console.log('[cloud-sync] Versioned snapshot uploaded:', storagePath);
  }

  /**
   * Delete backup snapshots older than the tier's retention period.
   */
  private async pruneOldBackups(userId: string): Promise<void> {
    const retentionDays = await this.getBackupRetentionDays();
    if (retentionDays === -1) return; // unlimited
    if (retentionDays <= 0) return; // no access or unknown

    const backups = await this.listBackups();
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    const toDelete = backups
      .filter((b) => b.created_at && new Date(b.created_at) < cutoff)
      .map((b) => b.path);

    if (toDelete.length === 0) return;

    const supabase = this.authService.getSupabaseClient();
    const { error } = await supabase.storage
      .from(BUCKET)
      .remove(toDelete);

    if (error) {
      console.warn('[cloud-sync] Failed to prune old backups:', error.message);
    } else {
      console.log(`[cloud-sync] Pruned ${toDelete.length} backup(s) older than ${retentionDays} day(s)`);
    }
  }

  private async doUpload(): Promise<void> {
    // Snapshot values at call time to avoid races with disable()
    const userId = this.userId;
    const vaultId = this.vaultId;
    const masterPasswordBuf = this.masterPasswordBuf;
    const vaultPath = this.vaultPath;

    if (!userId || !vaultId || !masterPasswordBuf || !vaultPath) {
      return;
    }

    this.uploading = true;
    this.pendingMutation = false;
    this.updateState({ status: 'syncing', error: null });

    try {
      // Read the vault file
      const fileBuffer = fs.readFileSync(vaultPath);

      if (fileBuffer.length > MAX_VAULT_SIZE) {
        throw new Error('Vault exceeds 10MB cloud limit');
      }

      // Encrypt for cloud (pass password as string for PBKDF2)
      const blob = encryptForCloud(fileBuffer, masterPasswordBuf.toString('utf-8'));

      // Upload to Supabase Storage at per-vault path: {userId}/{vaultId}/vault.enc
      const supabase = this.authService.getSupabaseClient();
      const storagePath = `${userId}/${vaultId}/${VAULT_FILENAME}`;

      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, blob, {
          upsert: true,
          contentType: 'application/octet-stream',
        });

      if (error) {
        throw new Error(error.message);
      }

      const now = new Date().toISOString();
      this.updateState({ status: 'synced', lastSyncedAt: now, error: null });
      console.log('[cloud-sync] Upload complete at', now, `(vault: ${vaultId})`);

      // Update manifest + versioned snapshot + prune (async, best-effort)
      const vaultName = this.getCurrentVaultName();
      this.updateManifest(userId, vaultId, vaultName, now, blob.length)
        .then(() => this.uploadVersionedSnapshot(userId, vaultId, blob))
        .then(() => this.pruneOldBackups(userId))
        .catch((err) => console.warn('[cloud-sync] Manifest/snapshot/prune failed:', err));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed';
      console.error('[cloud-sync] Upload error:', msg);
      this.updateState({ status: 'error', error: msg });
    } finally {
      this.uploading = false;

      // If a mutation arrived during upload, schedule another upload
      if (this.pendingMutation && this.enabled) {
        this.pendingMutation = false;
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          this.doUpload().catch((err) => {
            console.error('[cloud-sync] Retry upload failed:', err);
          });
        }, DEBOUNCE_MS);
      }
    }
  }

  private updateState(partial: Partial<CloudSyncState>): void {
    this.state = { ...this.state, ...partial };
    this.notifyRenderer();
  }

  private notifyRenderer(): void {
    const win = AppState.getInstance().getMainWindow();
    if (win) {
      win.webContents.send('cloud-sync:state-changed', this.state);
    }
  }

  private clearDebounce(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}
