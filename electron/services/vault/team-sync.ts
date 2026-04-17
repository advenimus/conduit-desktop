/**
 * Entry-level cloud sync service for team vaults.
 *
 * Subscribes to Supabase Realtime for live updates and debounces
 * local mutations for upload. Handles offline queuing, conflict
 * detection (last-write-wins), and reconnection with exponential backoff.
 *
 * Upload path: local mutation → dirty set → debounce → encrypt → upsert
 * Download path: Realtime event → decrypt → upsert local SQLite → notify renderer
 */

import { BrowserWindow } from 'electron';
import type { SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
import { encrypt, decrypt } from './crypto.js';
import { OfflineQueue, type QueuedMutation } from './offline-queue.js';
import type { ConduitVault, VaultMutation } from './vault.js';
import type { AuthService } from '../auth/supabase.js';

/** Debounce delay after last mutation before uploading (ms). */
const UPLOAD_DEBOUNCE_MS = 2_000;

/** Full reconciliation interval (ms). */
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

/** Max reconnection backoff (ms). */
const MAX_BACKOFF_MS = 30_000;

export type TeamSyncStatus = 'idle' | 'syncing' | 'synced' | 'error' | 'offline' | 'disconnected';

export interface TeamSyncState {
  status: TeamSyncStatus;
  lastSyncedAt: string | null;
  error: string | null;
  pendingChanges: number;
}

/**
 * Module-level set of entry IDs that failed to decrypt.
 * Persists across TeamSyncService instances (e.g. React StrictMode
 * double-invocation creates multiple instances) so each failing
 * entry is logged only once per app session.
 */
const decryptFailedEntries = new Set<string>();

export class TeamSyncService {
  private authService: AuthService;
  private vault: ConduitVault | null = null;
  private vek: Buffer | null = null;
  private teamVaultId: string | null = null;
  private userId: string | null = null;

  private supabase: SupabaseClient | null = null;
  private channel: RealtimeChannel | null = null;
  private offlineQueue = new OfflineQueue();
  private dirtySet = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private backoffMs = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private uploading = false;
  private reconciling = false;
  private applyingRemoteChange = false;
  private destroyed = false;
  private lastSubscribeLogAt = 0;
  /** Tracks per-item upload backoff state. */
  private uploadBackoff = new Map<string, { failures: number; retryAfter: number }>();

  /** Backoff schedule in ms: 1min, 5min, 30min, 2hr, then cap at 2hr */
  private static readonly BACKOFF_SCHEDULE = [60_000, 300_000, 1_800_000, 7_200_000];

  private state: TeamSyncState = {
    status: 'disconnected',
    lastSyncedAt: null,
    error: null,
    pendingChanges: 0,
  };

  constructor(authService: AuthService) {
    this.authService = authService;
  }

  /**
   * Start syncing for a team vault.
   *
   * @param skipInitialReconcile — If true, skip the initial reconcile. Used after VEK
   *   rotation where forceUploadAll() must run first to avoid downloading stale-VEK data.
   */
  start(vault: ConduitVault, vek: Buffer, teamVaultId: string, skipInitialReconcile = false): void {
    this.vault = vault;
    this.vek = Buffer.from(vek);
    this.teamVaultId = teamVaultId;
    this.destroyed = false;

    const authState = this.authService.getAuthState();
    this.userId = authState.user?.id ?? null;
    this.supabase = this.authService.getSupabaseClient();

    this.subscribe();
    this.startReconcileTimer();
    this.setState({ status: 'syncing' });

    if (!skipInitialReconcile) {
      // Initial full download
      this.reconcile().catch((err) => {
        console.error('[team-sync] Initial reconcile failed:', err);
      });
    }
  }

  /** Stop syncing and clean up. */
  stop(): void {
    this.destroyed = true;

    if (this.channel) {
      this.supabase?.removeChannel(this.channel);
      this.channel = null;
    }
    this.lastSubscribeLogAt = 0;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.vek) {
      this.vek.fill(0);
      this.vek = null;
    }

    this.vault = null;
    this.offlineQueue.clear();
    this.dirtySet.clear();
    this.uploadBackoff.clear();
    this.notifyRenderer('vault:sync-failures', { count: 0 });
    this.setState({ status: 'disconnected', pendingChanges: 0 });
  }

  /** Handle a local vault mutation (called from the vault mutation callback). */
  onMutation(mutation: VaultMutation): void {
    if (this.destroyed || !this.teamVaultId) return;
    if (this.applyingRemoteChange) return; // Skip mutations triggered by remote sync

    const key = `${mutation.type}:${mutation.id}`;

    if (this.offlineQueue.isOffline) {
      this.offlineQueue.enqueue({
        entityType: mutation.type,
        action: mutation.action,
        entityId: mutation.id,
        timestamp: Date.now(),
      });
      this.setState({ pendingChanges: this.offlineQueue.size });
      return;
    }

    this.dirtySet.add(key);
    this.scheduleDebouncedUpload();
  }

  /** Get current sync state. */
  getState(): TeamSyncState {
    return { ...this.state };
  }

  /** Force a full reconciliation now. */
  async syncNow(): Promise<void> {
    await this.reconcile();
  }

  /**
   * Force-upload ALL local entries and folders to the cloud.
   *
   * Used after VEK rotation to re-encrypt cloud data with the new VEK.
   * Unlike reconcile() (download path), this reads all local data and
   * upserts it to the cloud encrypted with the current VEK.
   */
  async forceUploadAll(): Promise<void> {
    if (!this.vault || !this.vek || !this.supabase || !this.teamVaultId) {
      throw new Error('Cannot force upload: sync service is not initialized');
    }
    if (this.reconciling) {
      throw new Error('Cannot force upload: reconcile is in progress');
    }
    this.uploading = true;
    this.setState({ status: 'syncing' });

    try {
      // Upload all folders
      const folders = this.vault.listFolders();
      for (const folder of folders) {
        if (this.destroyed) break;
        await this.uploadFolder(folder.id);
      }

      // Upload all entries
      const entries = this.vault.listEntries();
      for (const entry of entries) {
        if (this.destroyed) break;
        await this.uploadEntry(entry.id);
      }

      // Upload all password history
      const db = this.vault.getDatabase();
      const historyRows = db.listAllPasswordHistory();
      for (const row of historyRows) {
        if (this.destroyed) break;
        await this.uploadPasswordHistory(row.id);
      }

      this.setState({
        status: 'synced',
        lastSyncedAt: new Date().toISOString(),
        error: null,
        pendingChanges: 0,
      });

      console.log(`[team-sync] Force-uploaded ${entries.length} entries, ${folders.length} folders`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[team-sync] Force upload error:', msg);
      this.setState({ status: 'error', error: msg });
      throw err;
    } finally {
      this.uploading = false;
    }
  }

  // ---------- Upload path ----------

  private scheduleDebouncedUpload(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.flushDirtySet().catch((err) => {
        console.error('[team-sync] Upload failed:', err);
      });
    }, UPLOAD_DEBOUNCE_MS);
  }

  private async flushDirtySet(): Promise<void> {
    if (this.uploading || this.reconciling || this.destroyed || !this.vault || !this.vek || !this.supabase) return;
    this.uploading = true;
    this.setState({ status: 'syncing' });

    try {
      const items = Array.from(this.dirtySet);
      this.dirtySet.clear();

      let hadError = false;
      for (const key of items) {
        // Skip items that are in backoff
        const backoff = this.uploadBackoff.get(key);
        if (backoff && Date.now() < backoff.retryAfter) {
          // Re-add to dirty set so it gets picked up on next flush
          this.dirtySet.add(key);
          hadError = true;
          continue;
        }

        const [type, id] = key.split(':');
        try {
          if (type === 'entry') {
            await this.uploadEntry(id);
          } else if (type === 'folder') {
            await this.uploadFolder(id);
          } else if (type === 'password_history') {
            await this.uploadPasswordHistory(id);
          }
          // Clear backoff on success
          this.uploadBackoff.delete(key);
        } catch (err) {
          hadError = true;
          const prev = this.uploadBackoff.get(key);
          const failures = (prev?.failures ?? 0) + 1;
          const scheduleIdx = Math.min(failures - 1, TeamSyncService.BACKOFF_SCHEDULE.length - 1);
          const delay = TeamSyncService.BACKOFF_SCHEDULE[scheduleIdx];
          this.uploadBackoff.set(key, { failures, retryAfter: Date.now() + delay });

          const msg = err instanceof Error ? err.message : String(err);
          const delayLabel = delay < 60_000 ? `${delay / 1000}s`
            : delay < 3_600_000 ? `${delay / 60_000}m`
            : `${delay / 3_600_000}h`;

          if (failures <= 3) {
            console.warn(`[team-sync] Upload failed for ${key} (attempt ${failures}, retry in ${delayLabel}):`, msg);
          } else if (failures === 4) {
            console.warn(`[team-sync] Upload for ${key} entering long backoff (retry every ${delayLabel}):`, msg);
          }

          // Re-add to dirty set so reconcile/flush can retry later
          this.dirtySet.add(key);

          // If network error, go offline immediately
          if (this.isNetworkError(err)) {
            this.goOffline();
            break;
          }
        }
      }

      // Emit sync failure count to renderer
      const backedOffCount = Array.from(this.uploadBackoff.values()).filter(b => b.retryAfter > Date.now()).length;
      this.notifyRenderer('vault:sync-failures', { count: backedOffCount });

      this.setState({
        status: hadError ? 'error' : 'synced',
        lastSyncedAt: new Date().toISOString(),
        error: hadError ? 'Some items failed to upload' : null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[team-sync] Upload error:', msg);
      this.setState({ status: 'error', error: msg });
    } finally {
      this.uploading = false;
    }
  }

  private async uploadEntry(entryId: string): Promise<void> {
    if (!this.vault || !this.vek || !this.supabase || !this.teamVaultId) return;

    let entry;
    try {
      entry = this.vault.getEntry(entryId);
    } catch {
      // Entry was deleted — mark as soft-deleted in cloud
      await this.supabase
        .from('vault_entries')
        .update({ deleted_at: new Date().toISOString(), updated_by: this.userId })
        .eq('id', entryId)
        .eq('vault_id', this.teamVaultId);
      return;
    }

    // Encrypt sensitive fields with VEK
    const passwordEncrypted = entry.password
      ? encrypt(Buffer.from(entry.password, 'utf-8'), this.vek).toString('base64')
      : null;
    const privateKeyEncrypted = entry.private_key
      ? encrypt(Buffer.from(entry.private_key, 'utf-8'), this.vek).toString('base64')
      : null;
    const totpSecretEncrypted = entry.totp_secret
      ? encrypt(Buffer.from(entry.totp_secret, 'utf-8'), this.vek).toString('base64')
      : null;
    const configEncrypted = Object.keys(entry.config).length > 0
      ? encrypt(Buffer.from(JSON.stringify(entry.config), 'utf-8'), this.vek).toString('base64')
      : null;
    const tagsEncrypted = entry.tags.length > 0
      ? encrypt(Buffer.from(JSON.stringify(entry.tags), 'utf-8'), this.vek).toString('base64')
      : null;

    // Use the versioned upsert RPC for optimistic concurrency
    const { data, error } = await this.supabase.rpc('upsert_vault_entry_versioned', {
      p_id: entry.id,
      p_vault_id: this.teamVaultId,
      p_name: entry.name,
      p_entry_type: entry.entry_type,
      p_folder_id: entry.folder_id,
      p_sort_order: entry.sort_order,
      p_host: entry.host,
      p_port: entry.port,
      p_username: entry.username,
      p_domain: entry.domain,
      p_icon: entry.icon,
      p_color: entry.color,
      p_notes: entry.notes,
      p_password_encrypted: passwordEncrypted,
      p_private_key_encrypted: privateKeyEncrypted,
      p_config_encrypted: configEncrypted,
      p_tags_encrypted: tagsEncrypted,
      p_is_favorite: entry.is_favorite,
      p_totp_secret_encrypted: totpSecretEncrypted,
      p_expected_version: 0, // For new entries, any version works; for existing, we accept last-write-wins
      p_updated_by: this.userId,
      p_credential_type: entry.credential_type ?? null,
    });

    if (error) {
      console.error('[team-sync] Failed to upload entry:', error.message);
      throw error;
    }

    // Check if there was a conflict (version mismatch)
    if (data && Array.isArray(data) && data.length > 0 && !data[0].success) {
      this.notifyRenderer('vault:sync-conflict', {
        entityType: 'entry',
        entityId: entry.id,
        entityName: entry.name,
      });
    }
  }

  private async uploadFolder(folderId: string): Promise<void> {
    if (!this.vault || !this.supabase || !this.teamVaultId) return;

    const folders = this.vault.listFolders();
    const folder = folders.find(f => f.id === folderId);

    if (!folder) {
      // Folder was deleted — soft-delete in cloud
      await this.supabase
        .from('vault_folders')
        .update({ deleted_at: new Date().toISOString(), updated_by: this.userId })
        .eq('id', folderId)
        .eq('vault_id', this.teamVaultId);
      return;
    }

    await this.supabase
      .from('vault_folders')
      .upsert({
        id: folder.id,
        vault_id: this.teamVaultId,
        name: folder.name,
        parent_id: folder.parent_id,
        sort_order: folder.sort_order,
        icon: folder.icon,
        color: folder.color,
        updated_by: this.userId,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' });
  }

  private async uploadPasswordHistory(historyId: string): Promise<void> {
    if (!this.vault || !this.vek || !this.supabase || !this.teamVaultId) return;

    let historyEntry;
    try {
      historyEntry = this.vault.getPasswordHistoryEntry(historyId);
    } catch {
      // Entry was deleted — soft-delete in cloud
      await this.supabase
        .from('vault_password_history')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', historyId)
        .eq('vault_id', this.teamVaultId);
      return;
    }

    if (!historyEntry) {
      // Deleted locally — soft-delete in cloud
      await this.supabase
        .from('vault_password_history')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', historyId)
        .eq('vault_id', this.teamVaultId);
      return;
    }

    const passwordEncrypted = historyEntry.password
      ? encrypt(Buffer.from(historyEntry.password, 'utf-8'), this.vek).toString('base64')
      : null;

    const { error } = await this.supabase
      .from('vault_password_history')
      .upsert({
        id: historyEntry.id,
        vault_id: this.teamVaultId,
        entry_id: historyEntry.entry_id,
        username: historyEntry.username,
        password_encrypted: passwordEncrypted,
        changed_at: historyEntry.changed_at,
        changed_by: this.userId,
      }, { onConflict: 'id' });

    if (error) {
      console.error('[team-sync] Failed to upload password history:', error.message);
      throw error;
    }
  }

  // ---------- Download path (Realtime) ----------

  private subscribe(): void {
    if (!this.supabase || !this.teamVaultId) return;

    const channelName = `vault:${this.teamVaultId}`;

    this.channel = this.supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'vault_entries',
          filter: `vault_id=eq.${this.teamVaultId}`,
        },
        (payload) => {
          this.handleEntryChange(payload).catch((err) => {
            const entryId = ((payload as { new?: { id?: string } }).new)?.id;
            if (entryId && decryptFailedEntries.has(entryId)) return;
            if (entryId) decryptFailedEntries.add(entryId);
            console.warn('[team-sync] Failed to handle entry change:', err);
          });
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'vault_folders',
          filter: `vault_id=eq.${this.teamVaultId}`,
        },
        (payload) => {
          this.handleFolderChange(payload).catch((err) => {
            console.error('[team-sync] Failed to handle folder change:', err);
          });
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'vault_password_history',
          filter: `vault_id=eq.${this.teamVaultId}`,
        },
        (payload) => {
          this.handlePasswordHistoryChange(payload).catch((err) => {
            console.warn('[team-sync] Failed to handle password history change:', err);
          });
        },
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          this.backoffMs = 1000;
          const now = Date.now();
          if (now - this.lastSubscribeLogAt > 60_000) {
            this.lastSubscribeLogAt = now;
            console.log('[team-sync] Subscribed to Realtime channel:', channelName);
          }
        } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
          if (!this.destroyed) {
            this.scheduleReconnect();
          }
        }
      });
  }

  private async handleEntryChange(payload: Record<string, unknown>): Promise<void> {
    if (!this.vault || !this.vek) return;

    const record = (payload as { new?: Record<string, unknown> }).new;
    if (!record) return;

    // Skip own changes
    if (record.updated_by === this.userId) return;

    // Handle soft-delete
    if (record.deleted_at) {
      try {
        this.vault.deleteEntry(record.id as string);
      } catch {
        // Already deleted locally
      }
      this.notifyRenderer('vault:entry-changed', { id: record.id, action: 'delete' });
      return;
    }

    // Decrypt sensitive fields
    const password = record.password_encrypted
      ? decrypt(Buffer.from(record.password_encrypted as string, 'base64'), this.vek).toString('utf-8')
      : null;
    const privateKey = record.private_key_encrypted
      ? decrypt(Buffer.from(record.private_key_encrypted as string, 'base64'), this.vek).toString('utf-8')
      : null;
    const totpSecret = record.totp_secret_encrypted
      ? decrypt(Buffer.from(record.totp_secret_encrypted as string, 'base64'), this.vek).toString('utf-8')
      : null;
    const config = record.config_encrypted
      ? JSON.parse(decrypt(Buffer.from(record.config_encrypted as string, 'base64'), this.vek).toString('utf-8'))
      : {};
    const tags = record.tags_encrypted
      ? JSON.parse(decrypt(Buffer.from(record.tags_encrypted as string, 'base64'), this.vek).toString('utf-8'))
      : [];

    // Upsert into local vault (without triggering another sync via mutation callback)
    this.applyingRemoteChange = true;
    try {
      try {
        this.vault.getEntryMeta(record.id as string);
        // Exists — update
        this.vault.updateEntry(record.id as string, {
          name: record.name as string,
          entry_type: record.entry_type as 'ssh' | 'rdp' | 'vnc' | 'web' | 'credential',
          folder_id: (record.folder_id as string) ?? null,
          sort_order: (record.sort_order as number) ?? 0,
          host: (record.host as string) ?? null,
          port: (record.port as number) ?? null,
          username: (record.username as string) ?? null,
          domain: (record.domain as string) ?? null,
          icon: (record.icon as string) ?? null,
          color: (record.color as string) ?? null,
          notes: (record.notes as string) ?? null,
          password,
          private_key: privateKey,
          totp_secret: totpSecret,
          config,
          tags,
          is_favorite: record.is_favorite as boolean,
        });
      } catch {
        // Doesn't exist — create
        // Note: createEntry generates a new ID, but we need the cloud ID.
        // We need to use the database directly for this.
        const db = this.vault.getDatabase();
        const key = this.vault.getEncryptionKey();

        const passwordEnc = password ? encrypt(Buffer.from(password, 'utf-8'), key) : null;
        const privateKeyEnc = privateKey ? encrypt(Buffer.from(privateKey, 'utf-8'), key) : null;
        const totpSecretEnc = totpSecret ? encrypt(Buffer.from(totpSecret, 'utf-8'), key) : null;

        db.insertEntry({
          id: record.id as string,
          name: record.name as string,
          entry_type: record.entry_type as string,
          folder_id: (record.folder_id as string) ?? null,
          sort_order: (record.sort_order as number) ?? 0,
          host: (record.host as string) ?? null,
          port: (record.port as number) ?? null,
          credential_id: (record.credential_id as string) ?? null,
          username: (record.username as string) ?? null,
          password_encrypted: passwordEnc,
          domain: (record.domain as string) ?? null,
          private_key_encrypted: privateKeyEnc,
          totp_secret_encrypted: totpSecretEnc,
          icon: (record.icon as string) ?? null,
          color: (record.color as string) ?? null,
          config: JSON.stringify(config),
          tags: JSON.stringify(tags),
          is_favorite: record.is_favorite ? 1 : 0,
          notes: (record.notes as string) ?? null,
          credential_type: (record.credential_type as string) ?? null,
          created_at: (record.created_at as string) ?? new Date().toISOString(),
          updated_at: (record.updated_at as string) ?? new Date().toISOString(),
        });
      }
    } finally {
      this.applyingRemoteChange = false;
    }

    this.notifyRenderer('vault:entry-changed', {
      id: record.id,
      action: (payload as { eventType?: string }).eventType === 'INSERT' ? 'create' : 'update',
    });
  }

  private async handleFolderChange(payload: Record<string, unknown>): Promise<void> {
    if (!this.vault) return;

    const record = (payload as { new?: Record<string, unknown> }).new;
    if (!record) return;

    // Skip own changes
    if (record.updated_by === this.userId) return;

    // Handle soft-delete
    if (record.deleted_at) {
      try {
        this.vault.deleteFolder(record.id as string);
      } catch {
        // Already deleted locally
      }
      this.notifyRenderer('vault:folder-changed', { id: record.id, action: 'delete' });
      return;
    }

    // Upsert into local vault
    this.applyingRemoteChange = true;
    try {
      const folders = this.vault.listFolders();
      const existing = folders.find(f => f.id === record.id);
      if (existing) {
        this.vault.updateFolder(record.id as string, {
          name: record.name as string,
          parent_id: (record.parent_id as string) ?? null,
          sort_order: (record.sort_order as number) ?? 0,
          icon: (record.icon as string) ?? null,
          color: (record.color as string) ?? null,
        });
      } else {
        // Create with specific ID via database
        const db = this.vault.getDatabase();
        db.insertFolder({
          id: record.id as string,
          name: record.name as string,
          parent_id: (record.parent_id as string) ?? null,
          sort_order: (record.sort_order as number) ?? 0,
          icon: (record.icon as string) ?? null,
          color: (record.color as string) ?? null,
          created_at: (record.created_at as string) ?? new Date().toISOString(),
          updated_at: (record.updated_at as string) ?? new Date().toISOString(),
        });
      }
    } catch (err) {
      console.error('[team-sync] Failed to upsert folder locally:', err);
    } finally {
      this.applyingRemoteChange = false;
    }

    this.notifyRenderer('vault:folder-changed', {
      id: record.id,
      action: (payload as { eventType?: string }).eventType === 'INSERT' ? 'create' : 'update',
    });
  }

  private async handlePasswordHistoryChange(payload: Record<string, unknown>): Promise<void> {
    if (!this.vault || !this.vek) return;

    const record = (payload as { new?: Record<string, unknown> }).new;
    if (!record) return;

    // Skip own changes
    if (record.changed_by === this.userId) return;

    // Handle soft-delete
    if (record.deleted_at) {
      try {
        this.vault.deletePasswordHistory(record.id as string);
      } catch {
        // Already deleted locally
      }
      return;
    }

    // Decrypt password
    const password = record.password_encrypted
      ? decrypt(Buffer.from(record.password_encrypted as string, 'base64'), this.vek).toString('utf-8')
      : null;

    // Upsert into local vault
    this.applyingRemoteChange = true;
    try {
      const existing = this.vault.getPasswordHistoryEntry(record.id as string);
      if (!existing) {
        // Insert via database directly to preserve cloud ID
        const db = this.vault.getDatabase();
        const key = this.vault.getEncryptionKey();
        const passwordEnc = password ? encrypt(Buffer.from(password, 'utf-8'), key) : null;

        db.insertPasswordHistory({
          id: record.id as string,
          entry_id: record.entry_id as string,
          username: (record.username as string) ?? null,
          password_encrypted: passwordEnc,
          changed_at: (record.changed_at as string) ?? new Date().toISOString(),
          changed_by: (record.changed_by as string) ?? null,
        });
      }
    } catch (err) {
      console.error('[team-sync] Failed to upsert password history locally:', err);
    } finally {
      this.applyingRemoteChange = false;
    }
  }

  // ---------- Reconciliation ----------

  private startReconcileTimer(): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
    }
    this.reconcileTimer = setInterval(() => {
      this.reconcile().catch((err) => {
        console.error('[team-sync] Periodic reconcile failed:', err);
      });
    }, RECONCILE_INTERVAL_MS);
    if (this.reconcileTimer.unref) {
      this.reconcileTimer.unref();
    }
  }

  /** Full reconciliation: download all cloud entries and merge. */
  private async reconcile(): Promise<void> {
    if (this.reconciling || this.uploading || !this.vault || !this.vek || !this.supabase || !this.teamVaultId) return;
    this.reconciling = true;
    this.setState({ status: 'syncing' });

    try {
      // Download all cloud entries
      const { data: cloudEntries, error: entriesError } = await this.supabase
        .from('vault_entries')
        .select('*')
        .eq('vault_id', this.teamVaultId)
        .is('deleted_at', null);

      if (entriesError) throw entriesError;

      // Download all cloud folders
      const { data: cloudFolders, error: foldersError } = await this.supabase
        .from('vault_folders')
        .select('*')
        .eq('vault_id', this.teamVaultId)
        .is('deleted_at', null);

      if (foldersError) throw foldersError;

      // Bail out if stopped while awaiting queries
      if (this.destroyed || !this.vault) return;

      // Merge folders first (entries may reference them)
      if (cloudFolders) {
        this.applyingRemoteChange = true;
        try {
          for (const cf of cloudFolders) {
            if (this.destroyed || !this.vault) break;
            try {
              const folders = this.vault.listFolders();
              const existing = folders.find(f => f.id === cf.id);
              if (existing) {
                // Update if cloud is newer
                if (new Date(cf.updated_at) > new Date(existing.updated_at)) {
                  this.vault.updateFolder(cf.id, {
                    name: cf.name,
                    parent_id: cf.parent_id,
                    sort_order: cf.sort_order,
                    icon: cf.icon,
                    color: cf.color,
                  });
                }
              } else {
                const db = this.vault.getDatabase();
                db.insertFolder({
                  id: cf.id,
                  name: cf.name,
                  parent_id: cf.parent_id,
                  sort_order: cf.sort_order ?? 0,
                  icon: cf.icon,
                  color: cf.color,
                  created_at: cf.created_at,
                  updated_at: cf.updated_at,
                });
              }
            } catch (err) {
              console.error('[team-sync] Reconcile folder error:', cf.id, err);
            }
          }
        } finally {
          this.applyingRemoteChange = false;
        }
      }

      // Download and merge password history
      const { data: cloudHistory, error: historyError } = await this.supabase
        .from('vault_password_history')
        .select('*')
        .eq('vault_id', this.teamVaultId)
        .is('deleted_at', null);

      if (historyError) {
        console.warn('[team-sync] Failed to download password history:', historyError.message);
      }

      if (cloudHistory && this.vault && !this.destroyed) {
        this.applyingRemoteChange = true;
        try {
          for (const ch of cloudHistory) {
            if (this.destroyed || !this.vault) break;
            try {
              const existing = this.vault.getPasswordHistoryEntry(ch.id);
              if (!existing) {
                const password = ch.password_encrypted
                  ? decrypt(Buffer.from(ch.password_encrypted as string, 'base64'), this.vek!).toString('utf-8')
                  : null;
                const db = this.vault.getDatabase();
                const key = this.vault.getEncryptionKey();
                const passwordEnc = password ? encrypt(Buffer.from(password, 'utf-8'), key) : null;

                db.insertPasswordHistory({
                  id: ch.id,
                  entry_id: ch.entry_id,
                  username: ch.username ?? null,
                  password_encrypted: passwordEnc,
                  changed_at: ch.changed_at ?? new Date().toISOString(),
                  changed_by: ch.changed_by ?? null,
                });
              }
            } catch (err) {
              console.warn('[team-sync] Reconcile password history error:', ch.id, err);
            }
          }
        } finally {
          this.applyingRemoteChange = false;
        }
      }

      // Merge entries
      if (cloudEntries) {
        for (const ce of cloudEntries) {
          if (this.destroyed || !this.vault) break;
          try {
            await this.mergeCloudEntry(ce);
          } catch (err) {
            // Log each failing entry only once per app session
            if (!decryptFailedEntries.has(ce.id)) {
              decryptFailedEntries.add(ce.id);
              const isSqlite = err instanceof Error && err.message.includes('SQLITE');
              const label = isSqlite ? 'schema error' : 'decrypt failure (stale VEK?)';
              console.warn(`[team-sync] Skipping entry ${ce.id} — ${label}:`, err);
            }
          }
        }
      }

      // Upload local-only entries/folders that are missing from cloud.
      // This handles entries created locally while offline or cleaned up from cloud.
      // Exclude entries that were soft-deleted in cloud by other members (to avoid
      // resurrecting intentionally deleted data).
      if (this.vault && !this.destroyed) {
        const cloudEntryIds = new Set((cloudEntries ?? []).map((ce: Record<string, unknown>) => ce.id as string));
        const cloudFolderIds = new Set((cloudFolders ?? []).map((cf: Record<string, unknown>) => cf.id as string));

        // Fetch IDs of soft-deleted entries/folders so we don't re-upload them
        const deletedEntryIds = new Set<string>();
        const deletedFolderIds = new Set<string>();
        try {
          const { data: deletedEntries } = await this.supabase
            .from('vault_entries')
            .select('id')
            .eq('vault_id', this.teamVaultId)
            .not('deleted_at', 'is', null);
          if (deletedEntries) {
            for (const de of deletedEntries) deletedEntryIds.add(de.id as string);
          }

          const { data: deletedFolders } = await this.supabase
            .from('vault_folders')
            .select('id')
            .eq('vault_id', this.teamVaultId)
            .not('deleted_at', 'is', null);
          if (deletedFolders) {
            for (const df of deletedFolders) deletedFolderIds.add(df.id as string);
          }
        } catch {
          // If we can't fetch deleted IDs, skip the local-only upload to be safe
        }

        if (this.vault && !this.destroyed) {
          const localFolders = this.vault.listFolders();
          for (const lf of localFolders) {
            if (this.destroyed) break;
            const key = `folder:${lf.id}`;
            const backoff = this.uploadBackoff.get(key);
            const inBackoff = backoff != null && Date.now() < backoff.retryAfter;
            if (!cloudFolderIds.has(lf.id) && !deletedFolderIds.has(lf.id) && !inBackoff) {
              this.dirtySet.add(key);
            }
          }

          const localEntries = this.vault.listEntries();
          for (const le of localEntries) {
            if (this.destroyed) break;
            const key = `entry:${le.id}`;
            const backoff = this.uploadBackoff.get(key);
            const inBackoff = backoff != null && Date.now() < backoff.retryAfter;
            if (!cloudEntryIds.has(le.id) && !deletedEntryIds.has(le.id) && !inBackoff) {
              this.dirtySet.add(key);
            }
          }

          if (this.dirtySet.size > 0) {
            console.log(`[team-sync] Uploading ${this.dirtySet.size} local-only items to cloud:`, Array.from(this.dirtySet));
            this.scheduleDebouncedUpload();
          }
        }
      }

      // Flush offline queue if we had pending changes
      if (this.offlineQueue.size > 0) {
        this.offlineQueue.setOffline(false);
        const pending = this.offlineQueue.drain();
        for (const m of pending) {
          const key = `${m.entityType}:${m.entityId}`;
          this.dirtySet.add(key);
        }
        if (this.dirtySet.size > 0) {
          this.scheduleDebouncedUpload();
        }
      }

      // Emit sync failure count after reconcile
      const backedOffCount = Array.from(this.uploadBackoff.values()).filter(b => b.retryAfter > Date.now()).length;
      this.notifyRenderer('vault:sync-failures', { count: backedOffCount });

      this.setState({
        status: 'synced',
        lastSyncedAt: new Date().toISOString(),
        error: null,
        pendingChanges: 0,
      });

      this.notifyRenderer('vault:entries-refreshed', {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[team-sync] Reconcile error:', msg);
      this.setState({ status: 'error', error: msg });

      if (this.isNetworkError(err)) {
        this.goOffline();
      }
    } finally {
      this.reconciling = false;
    }
  }

  private async mergeCloudEntry(cloudEntry: Record<string, unknown>): Promise<void> {
    if (!this.vault || !this.vek) return;

    // Decrypt sensitive fields
    const password = cloudEntry.password_encrypted
      ? decrypt(Buffer.from(cloudEntry.password_encrypted as string, 'base64'), this.vek).toString('utf-8')
      : null;
    const privateKey = cloudEntry.private_key_encrypted
      ? decrypt(Buffer.from(cloudEntry.private_key_encrypted as string, 'base64'), this.vek).toString('utf-8')
      : null;
    const totpSecret = cloudEntry.totp_secret_encrypted
      ? decrypt(Buffer.from(cloudEntry.totp_secret_encrypted as string, 'base64'), this.vek).toString('utf-8')
      : null;
    const config = cloudEntry.config_encrypted
      ? JSON.parse(decrypt(Buffer.from(cloudEntry.config_encrypted as string, 'base64'), this.vek).toString('utf-8'))
      : {};
    const tags = cloudEntry.tags_encrypted
      ? JSON.parse(decrypt(Buffer.from(cloudEntry.tags_encrypted as string, 'base64'), this.vek).toString('utf-8'))
      : [];

    this.applyingRemoteChange = true;
    try {
      try {
        const existing = this.vault.getEntryMeta(cloudEntry.id as string);
        // Update if cloud is newer (last-write-wins)
        if (new Date(cloudEntry.updated_at as string) > new Date(existing.updated_at)) {
          this.vault.updateEntry(cloudEntry.id as string, {
            name: cloudEntry.name as string,
            entry_type: cloudEntry.entry_type as 'ssh' | 'rdp' | 'vnc' | 'web' | 'credential',
            folder_id: (cloudEntry.folder_id as string) ?? null,
            sort_order: (cloudEntry.sort_order as number) ?? 0,
            host: (cloudEntry.host as string) ?? null,
            port: (cloudEntry.port as number) ?? null,
            username: (cloudEntry.username as string) ?? null,
            domain: (cloudEntry.domain as string) ?? null,
            icon: (cloudEntry.icon as string) ?? null,
            color: (cloudEntry.color as string) ?? null,
            notes: (cloudEntry.notes as string) ?? null,
            password,
            private_key: privateKey,
            totp_secret: totpSecret,
            config,
            tags,
            is_favorite: cloudEntry.is_favorite as boolean,
          });
        }
      } catch {
        // Entry doesn't exist locally — create via database for preserving cloud ID
        const db = this.vault.getDatabase();
        const key = this.vault.getEncryptionKey();

        const passwordEnc = password ? encrypt(Buffer.from(password, 'utf-8'), key) : null;
        const privateKeyEnc = privateKey ? encrypt(Buffer.from(privateKey, 'utf-8'), key) : null;
        const totpSecretEnc = totpSecret ? encrypt(Buffer.from(totpSecret, 'utf-8'), key) : null;

        db.insertEntry({
          id: cloudEntry.id as string,
          name: cloudEntry.name as string,
          entry_type: cloudEntry.entry_type as string,
          folder_id: (cloudEntry.folder_id as string) ?? null,
          sort_order: (cloudEntry.sort_order as number) ?? 0,
          host: (cloudEntry.host as string) ?? null,
          port: (cloudEntry.port as number) ?? null,
          credential_id: (cloudEntry.credential_id as string) ?? null,
          username: (cloudEntry.username as string) ?? null,
          password_encrypted: passwordEnc,
          domain: (cloudEntry.domain as string) ?? null,
          private_key_encrypted: privateKeyEnc,
          totp_secret_encrypted: totpSecretEnc,
          icon: (cloudEntry.icon as string) ?? null,
          color: (cloudEntry.color as string) ?? null,
          config: JSON.stringify(config),
          tags: JSON.stringify(tags),
          is_favorite: cloudEntry.is_favorite ? 1 : 0,
          notes: (cloudEntry.notes as string) ?? null,
          credential_type: (cloudEntry.credential_type as string) ?? null,
          created_at: (cloudEntry.created_at as string) ?? new Date().toISOString(),
          updated_at: (cloudEntry.updated_at as string) ?? new Date().toISOString(),
        });
      }
    } finally {
      this.applyingRemoteChange = false;
    }
  }

  // ---------- Offline / Reconnect ----------

  private goOffline(): void {
    this.offlineQueue.setOffline(true);
    this.setState({ status: 'offline' });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.attemptReconnect();
    }, this.backoffMs);

    // Exponential backoff
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  private attemptReconnect(): void {
    if (this.destroyed) return;

    // Re-subscribe to Realtime
    if (this.channel) {
      this.supabase?.removeChannel(this.channel);
      this.channel = null;
    }
    this.subscribe();

    // Attempt reconciliation
    this.reconcile().catch(() => {
      // Will retry via backoff
    });
  }

  // ---------- Helpers ----------

  private isNetworkError(err: unknown): boolean {
    if (err instanceof Error) {
      const msg = err.message.toLowerCase();
      return msg.includes('network') || msg.includes('fetch') || msg.includes('timeout')
        || msg.includes('econnrefused') || msg.includes('enotfound');
    }
    return false;
  }

  private setState(partial: Partial<TeamSyncState>): void {
    this.state = { ...this.state, ...partial };
    this.notifyRenderer('vault:sync-state-changed', this.state);
  }

  private notifyRenderer(channel: string, data: unknown): void {
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      try {
        win.webContents.send(channel, data);
      } catch {
        // Window may be destroyed
      }
    }
  }
}
