/**
 * Cloud chat sync service.
 *
 * Orchestrates debounced upload of encrypted chat conversations to the
 * Conduit backend, download for restore, and state broadcasting to the renderer.
 *
 * Uses version-based conflict resolution: client version > server version wins,
 * otherwise the server version is pulled down.
 */

import { encryptForCloudChat, decryptFromCloudChat } from './chat-crypto.js';
import type { ChatStore } from './chat-store.js';
import { AppState } from '../state.js';
import type { AuthService } from '../auth/supabase.js';
import { getBackendUrl, getBackendHeaders } from '../constants.js';

/** Debounce delay after last mutation before uploading (ms). */
const DEBOUNCE_MS = 5_000;

/** Maximum conversations per sync batch. */
const MAX_BATCH_SIZE = 10;

/** Validate UUID format to prevent URL path injection. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validateUuid(id: string): string {
  if (!UUID_RE.test(id)) throw new Error(`Invalid conversation ID format: ${id}`);
  return id;
}

export type ChatCloudSyncStatus = 'idle' | 'syncing' | 'synced' | 'error' | 'disabled';

export interface ChatCloudSyncState {
  status: ChatCloudSyncStatus;
  lastSyncedAt: string | null;
  error: string | null;
  enabled: boolean;
}

export class ChatCloudSyncService {
  private authService: AuthService;
  private chatStore: ChatStore | null = null;
  private masterPasswordBuf: Buffer | null = null;
  private enabled = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private uploading = false;
  private dirtyIds: Set<string> = new Set();

  private state: ChatCloudSyncState = {
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
   */
  configure(opts: {
    chatStore: ChatStore;
    masterPassword: string;
    enabled: boolean;
  }): void {
    this.chatStore = opts.chatStore;
    if (this.masterPasswordBuf) this.masterPasswordBuf.fill(0);
    this.masterPasswordBuf = Buffer.from(opts.masterPassword, 'utf-8');
    this.enabled = opts.enabled;

    if (opts.enabled) {
      this.updateState({ status: 'idle', enabled: true, error: null });
    } else {
      this.updateState({ status: 'disabled', enabled: false, error: null });
    }
  }

  /**
   * Disable cloud sync and clear internal state.
   */
  disable(): void {
    this.clearDebounce();
    this.enabled = false;
    if (this.masterPasswordBuf) {
      this.masterPasswordBuf.fill(0);
      this.masterPasswordBuf = null;
    }
    this.chatStore = null;
    this.dirtyIds.clear();
    this.updateState({ status: 'disabled', enabled: false, error: null });
  }

  /**
   * Called by engine IPC handlers when a conversation is mutated.
   * Marks the conversation dirty and schedules a debounced sync.
   */
  notifyMutation(conversationId: string): void {
    if (!this.enabled) return;

    this.dirtyIds.add(conversationId);
    this.clearDebounce();

    if (this.uploading) return;

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.doSync().catch((err) => {
        console.error('[chat-cloud-sync] Sync failed:', err);
      });
    }, DEBOUNCE_MS);
  }

  /**
   * Force an immediate sync of all dirty conversations.
   */
  async syncNow(): Promise<void> {
    if (!this.enabled) {
      throw new Error('Chat cloud sync is not enabled');
    }
    this.clearDebounce();
    await this.doSync();
  }

  /**
   * Full sync: compare local vs cloud, upload missing/newer, download missing/newer.
   * Called on first enable or when restoring on a new device.
   */
  async fullSync(): Promise<void> {
    if (!this.enabled || !this.chatStore?.isUnlocked() || !this.masterPasswordBuf) return;

    this.updateState({ status: 'syncing', error: null });

    try {
      const accessToken = await this.authService.getAccessToken();
      if (!accessToken) throw new Error('Not authenticated');

      const masterPassword = this.masterPasswordBuf.toString('utf-8');

      // 1. Fetch cloud conversation metadata
      const response = await fetch(`${getBackendUrl()}/api/chats`, {
        headers: { 'Authorization': `Bearer ${accessToken}`, ...getBackendHeaders() },
      });

      if (!response.ok) {
        const text = await response.text().catch(() => 'unknown');
        throw new Error(`Failed to fetch cloud conversations: ${response.status} ${text}`);
      }

      const { conversations: cloudConvs } = await response.json() as {
        conversations: { id: string; version: number }[];
      };

      // 2. Get local conversations
      const localConvs = this.chatStore.listConversations({ limit: 10000 });

      // Build maps for comparison
      const cloudMap = new Map(cloudConvs.map((c) => [c.id, c.version]));
      const localMap = new Map(localConvs.map((c) => [c.id, c.version]));

      // 3. Identify what to upload (local newer or missing from cloud)
      const toUpload: string[] = [];
      for (const local of localConvs) {
        const cloudVersion = cloudMap.get(local.id);
        if (cloudVersion === undefined || local.version > cloudVersion) {
          toUpload.push(local.id);
        }
      }

      // 4. Identify what to download (cloud newer or missing locally)
      const toDownload: string[] = [];
      for (const cloud of cloudConvs) {
        const localVersion = localMap.get(cloud.id);
        if (localVersion === undefined || cloud.version > localVersion) {
          toDownload.push(cloud.id);
        }
      }

      // 5. Upload in batches
      for (let i = 0; i < toUpload.length; i += MAX_BATCH_SIZE) {
        const batch = toUpload.slice(i, i + MAX_BATCH_SIZE);
        await this.uploadBatch(batch, accessToken, masterPassword);
      }

      // 6. Download missing conversations
      for (const id of toDownload) {
        await this.downloadConversation(id, accessToken, masterPassword);
      }

      const now = new Date().toISOString();
      this.updateState({ status: 'synced', lastSyncedAt: now, error: null });
      console.log(`[chat-cloud-sync] Full sync complete: ${toUpload.length} up, ${toDownload.length} down`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Full sync failed';
      console.error('[chat-cloud-sync] Full sync error:', msg);
      this.updateState({ status: 'error', error: msg });
    }
  }

  /**
   * Delete all cloud chat data for the current user.
   */
  async deleteCloudData(): Promise<void> {
    const accessToken = await this.authService.getAccessToken();
    if (!accessToken) throw new Error('Not authenticated');

    // Fetch all cloud conversations and delete each
    const response = await fetch(`${getBackendUrl()}/api/chats?include_deleted=false`, {
      headers: { 'Authorization': `Bearer ${accessToken}`, ...getBackendHeaders() },
    });

    if (!response.ok) {
      throw new Error('Failed to fetch cloud conversations for deletion');
    }

    const { conversations } = await response.json() as {
      conversations: { id: string }[];
    };

    let deleted = 0;
    for (const conv of conversations) {
      try {
        const safeId = validateUuid(conv.id);
        const res = await fetch(`${getBackendUrl()}/api/chats/${safeId}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${accessToken}`, ...getBackendHeaders() },
        });
        if (res.ok) deleted++;
        else console.warn(`[chat-cloud-sync] Failed to delete ${safeId}: ${res.status}`);
      } catch (err) {
        console.warn(`[chat-cloud-sync] Error deleting ${conv.id}:`, err);
      }
    }

    console.log(`[chat-cloud-sync] Deleted ${deleted}/${conversations.length} cloud conversations`);
  }

  /**
   * Get the current sync state.
   */
  getState(): ChatCloudSyncState {
    return { ...this.state };
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private async doSync(): Promise<void> {
    const chatStore = this.chatStore;
    const masterPasswordBuf = this.masterPasswordBuf;

    if (!chatStore?.isUnlocked() || !masterPasswordBuf) return;

    // Grab and clear dirty set
    const ids = [...this.dirtyIds];
    this.dirtyIds.clear();

    if (ids.length === 0) return;

    this.uploading = true;
    this.updateState({ status: 'syncing', error: null });

    try {
      const accessToken = await this.authService.getAccessToken();
      if (!accessToken) throw new Error('Not authenticated');

      const masterPassword = masterPasswordBuf.toString('utf-8');

      // Upload in batches
      for (let i = 0; i < ids.length; i += MAX_BATCH_SIZE) {
        const batch = ids.slice(i, i + MAX_BATCH_SIZE);
        await this.uploadBatch(batch, accessToken, masterPassword);
      }

      const now = new Date().toISOString();
      this.updateState({ status: 'synced', lastSyncedAt: now, error: null });
      console.log(`[chat-cloud-sync] Synced ${ids.length} conversations`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sync failed';
      console.error('[chat-cloud-sync] Sync error:', msg);
      this.updateState({ status: 'error', error: msg });
      // Put IDs back in dirty set for retry
      for (const id of ids) {
        this.dirtyIds.add(id);
      }
    } finally {
      this.uploading = false;

      // If new mutations arrived during upload, schedule another sync
      if (this.dirtyIds.size > 0 && this.enabled) {
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          this.doSync().catch((err) => {
            console.error('[chat-cloud-sync] Retry sync failed:', err);
          });
        }, DEBOUNCE_MS);
      }
    }
  }

  private async uploadBatch(
    ids: string[],
    accessToken: string,
    masterPassword: string,
  ): Promise<void> {
    const chatStore = this.chatStore;
    if (!chatStore?.isUnlocked()) return;

    const items: {
      id: string;
      version: number;
      encrypted_blob: string;
      title_hint?: string;
      provider?: string;
      model?: string;
      message_count?: number;
    }[] = [];

    for (const id of ids) {
      const conv = chatStore.getConversation(id);
      if (!conv) continue;

      // Get the raw blob (already field-encrypted) and encrypt again for cloud
      const blobJson = chatStore.getConversationBlob(id);
      if (!blobJson) continue;

      // Use current version + 1 for the upload request — only persist after success
      const currentVersion = chatStore.getConversationVersion(id);

      const encryptedBlob = encryptForCloudChat(blobJson, masterPassword);

      items.push({
        id,
        version: currentVersion + 1,
        encrypted_blob: encryptedBlob,
        provider: conv.provider,
        model: conv.model,
        message_count: conv.messageCount,
      });
    }

    if (items.length === 0) return;

    const response = await fetch(`${getBackendUrl()}/api/chats/sync`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...getBackendHeaders(),
      },
      body: JSON.stringify({ conversations: items }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown');
      throw new Error(`Sync upload failed: ${response.status} ${text}`);
    }

    const result = await response.json() as {
      synced: string[];
      conflicts: { id: string; server_version: number; client_version: number }[];
    };

    // Only increment version for successfully synced conversations
    for (const syncedId of result.synced) {
      chatStore.incrementVersion(syncedId);
    }

    // Handle conflicts by downloading server version
    if (result.conflicts.length > 0) {
      console.warn(`[chat-cloud-sync] ${result.conflicts.length} conflicts, downloading server versions`);
      for (const conflict of result.conflicts) {
        await this.downloadConversation(conflict.id, accessToken, masterPassword);
      }
    }
  }

  private async downloadConversation(
    id: string,
    accessToken: string,
    masterPassword: string,
  ): Promise<void> {
    const chatStore = this.chatStore;
    if (!chatStore?.isUnlocked()) return;

    const safeId = validateUuid(id);
    const response = await fetch(`${getBackendUrl()}/api/chats/${safeId}`, {
      headers: { 'Authorization': `Bearer ${accessToken}`, ...getBackendHeaders() },
    });

    if (!response.ok) {
      console.warn(`[chat-cloud-sync] Failed to download conversation ${safeId}: ${response.status}`);
      return;
    }

    const data = await response.json() as {
      encrypted_blob: string;
      version: number;
    };

    // Decrypt the cloud blob to get the raw conversation JSON
    const blobJson = decryptFromCloudChat(data.encrypted_blob, masterPassword);

    // Load into local store
    chatStore.loadConversationBlob(id, blobJson);

    console.log(`[chat-cloud-sync] Downloaded conversation ${id} (v${data.version})`);
  }

  private updateState(partial: Partial<ChatCloudSyncState>): void {
    this.state = { ...this.state, ...partial };
    this.notifyRenderer();
  }

  private notifyRenderer(): void {
    const win = AppState.getInstance().getMainWindow();
    if (win) {
      win.webContents.send('chat-sync:state-changed', this.state);
    }
  }

  private clearDebounce(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}
