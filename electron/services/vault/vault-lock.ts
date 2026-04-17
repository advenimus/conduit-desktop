/**
 * Cloud-based vault locking service.
 *
 * Provides exclusive-access locking for Pro plan users via Supabase.
 * Team plan users skip locking entirely (concurrent access allowed).
 *
 * Lock lifecycle:
 *   acquireCloudLock() → heartbeat every 30s → releaseCloudLock()
 *
 * Lock expiry: 60s. Heartbeat extends by 60s each tick.
 * If the app crashes, the lock auto-expires and others can acquire it.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthService } from '../auth/supabase.js';
import { getOrCreateDeviceId } from './team-crypto.js';

/** How long a lock is valid before it expires (ms). */
const LOCK_TTL_MS = 60_000;

/** How often to renew the lock (ms). */
const HEARTBEAT_INTERVAL_MS = 30_000;

export interface LockStatus {
  isLocked: boolean;
  lockedBy: string | null;
  userEmail: string | null;
  lockedAt: string | null;
  expiresAt: string | null;
  isOwnLock: boolean;
}

export interface AcquireLockResult {
  success: boolean;
  /** If locked by someone else, their info. */
  lockedBy?: string;
  userEmail?: string;
  lockedAt?: string;
}

export class VaultLockService {
  private authService: AuthService;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lockedVaultId: string | null = null;

  constructor(authService: AuthService) {
    this.authService = authService;
  }

  /**
   * Try to acquire an exclusive cloud lock on a vault.
   *
   * - If no lock exists or the existing lock is expired, acquires it.
   * - If locked by someone else and not expired, returns failure with lock info.
   * - Starts heartbeat on success.
   */
  async acquireCloudLock(vaultId: string): Promise<AcquireLockResult> {
    const supabase = this.authService.getSupabaseClient();
    const userId = this.requireUserId();
    const userEmail = this.authService.getAuthState().user?.email ?? 'unknown';
    const deviceId = getOrCreateDeviceId(userId);

    const now = new Date();
    const newExpiry = new Date(now.getTime() + LOCK_TTL_MS).toISOString();
    const lockRow = {
      vault_id: vaultId,
      locked_by: userId,
      locked_at: now.toISOString(),
      expires_at: newExpiry,
      device_id: deviceId,
      user_email: userEmail,
    };

    // Attempt atomic INSERT first — succeeds if no lock row exists
    const { error: insertError } = await supabase
      .from('vault_locks')
      .insert(lockRow);

    if (!insertError) {
      // No existing lock — we acquired it
      this.lockedVaultId = vaultId;
      this.startHeartbeat(supabase, vaultId, userId);
      return { success: true };
    }

    // INSERT failed (unique constraint) — a lock row exists. Fetch it.
    const { data: existing } = await supabase
      .from('vault_locks')
      .select('*')
      .eq('vault_id', vaultId)
      .single();

    if (!existing) {
      // Row disappeared between INSERT failure and SELECT — retry once
      const { error: retryError } = await supabase
        .from('vault_locks')
        .insert(lockRow);

      if (retryError) {
        return { success: false };
      }

      this.lockedVaultId = vaultId;
      this.startHeartbeat(supabase, vaultId, userId);
      return { success: true };
    }

    const isOwnLock = existing.locked_by === userId;
    const expiresAt = new Date(existing.expires_at as string);
    const isExpired = expiresAt < now;

    if (!isExpired && !isOwnLock) {
      // Locked by someone else and not expired
      return {
        success: false,
        lockedBy: existing.locked_by as string,
        userEmail: existing.user_email as string | undefined,
        lockedAt: existing.locked_at as string,
      };
    }

    if (isOwnLock) {
      // Our own lock — update expiry
      const { error: updateError } = await supabase
        .from('vault_locks')
        .update({
          locked_at: now.toISOString(),
          expires_at: newExpiry,
          device_id: deviceId,
        })
        .eq('vault_id', vaultId)
        .eq('locked_by', userId);

      if (updateError) {
        return { success: false };
      }
    } else {
      // Expired lock held by someone else — delete then insert
      const { error: deleteError } = await supabase
        .from('vault_locks')
        .delete()
        .eq('vault_id', vaultId)
        .eq('locked_by', existing.locked_by as string);

      if (deleteError) {
        return { success: false };
      }

      const { error: reinsertError } = await supabase
        .from('vault_locks')
        .insert(lockRow);

      if (reinsertError) {
        // Another process grabbed it between delete and insert
        return { success: false };
      }
    }

    // Success — start heartbeat
    this.lockedVaultId = vaultId;
    this.startHeartbeat(supabase, vaultId, userId);

    return { success: true };
  }

  /**
   * Release the cloud lock for a vault.
   */
  async releaseCloudLock(vaultId?: string): Promise<void> {
    const id = vaultId ?? this.lockedVaultId;
    if (!id) return;

    this.stopHeartbeat();

    try {
      const supabase = this.authService.getSupabaseClient();
      const userId = this.requireUserId();

      await supabase
        .from('vault_locks')
        .delete()
        .eq('vault_id', id)
        .eq('locked_by', userId);
    } catch (err) {
      console.warn('[vault-lock] Failed to release lock:', err);
    }

    this.lockedVaultId = null;
  }

  /**
   * Check the lock status for a vault without acquiring.
   */
  async checkLock(vaultId: string): Promise<LockStatus> {
    const supabase = this.authService.getSupabaseClient();
    const userId = this.getUserId();

    const { data } = await supabase
      .from('vault_locks')
      .select('*')
      .eq('vault_id', vaultId)
      .single();

    if (!data) {
      return {
        isLocked: false,
        lockedBy: null,
        userEmail: null,
        lockedAt: null,
        expiresAt: null,
        isOwnLock: false,
      };
    }

    const expiresAt = new Date(data.expires_at as string);
    const isExpired = expiresAt < new Date();

    if (isExpired) {
      return {
        isLocked: false,
        lockedBy: null,
        userEmail: null,
        lockedAt: null,
        expiresAt: null,
        isOwnLock: false,
      };
    }

    return {
      isLocked: true,
      lockedBy: data.locked_by as string,
      userEmail: data.user_email as string | null,
      lockedAt: data.locked_at as string,
      expiresAt: data.expires_at as string,
      isOwnLock: data.locked_by === userId,
    };
  }

  /** Get the currently held lock vault ID. */
  getLockedVaultId(): string | null {
    return this.lockedVaultId;
  }

  /** Stop heartbeat and clean up (for app quit). */
  cleanup(): void {
    this.stopHeartbeat();
    this.lockedVaultId = null;
  }

  // ---------- Internal ----------

  private startHeartbeat(supabase: SupabaseClient, vaultId: string, userId: string): void {
    this.stopHeartbeat();

    this.heartbeatTimer = setInterval(async () => {
      try {
        const newExpiry = new Date(Date.now() + LOCK_TTL_MS).toISOString();
        await supabase
          .from('vault_locks')
          .update({ expires_at: newExpiry })
          .eq('vault_id', vaultId)
          .eq('locked_by', userId);
      } catch (err) {
        console.warn('[vault-lock] Heartbeat failed:', err);
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

  private requireUserId(): string {
    const state = this.authService.getAuthState();
    if (!state.isAuthenticated || !state.user) {
      throw new Error('Not authenticated');
    }
    return state.user.id;
  }

  private getUserId(): string | null {
    const state = this.authService.getAuthState();
    return state.user?.id ?? null;
  }
}
