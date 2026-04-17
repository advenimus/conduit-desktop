/**
 * Team vault lifecycle manager.
 *
 * Orchestrates creation, opening, member management, and VEK rotation
 * for team-shared vaults. Coordinates between the local ConduitVault,
 * Supabase cloud state, and TeamSyncService.
 */

import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ConduitVault } from './vault.js';
import { TeamSyncService } from './team-sync.js';
import {
  generateVEK,
  wrapVEK,
  unwrapVEK,
  loadPrivateKey,
  derivePublicKey,
} from './team-crypto.js';
import type { AuthService } from '../auth/supabase.js';
import type { VaultLockService } from './vault-lock.js';
import { getDataDir } from '../env-config.js';

// ---------- Types ----------

export interface TeamVaultInfo {
  id: string;
  teamId: string;
  name: string;
  description: string | null;
  keyVersion: number;
  rotationPending: boolean;
  createdAt: string;
}

export interface TeamVaultMemberInfo {
  user_id: string;
  role: 'admin' | 'editor' | 'viewer';
  user_display_name?: string;
  user_email?: string;
  created_at: string;
}

// ---------- Manager ----------

export class TeamVaultManager {
  private authService: AuthService;
  private vaultLock: VaultLockService | null = null;
  private activeSync: TeamSyncService | null = null;
  private activeVault: ConduitVault | null = null;
  private activeVaultId: string | null = null;
  private activeTeamId: string | null = null;

  constructor(authService: AuthService) {
    this.authService = authService;
  }

  /** Set the vault lock service reference (called after construction). */
  setVaultLockService(lockService: VaultLockService): void {
    this.vaultLock = lockService;
  }

  /** Get the currently open team vault's ID (null if none open). */
  getActiveVaultId(): string | null {
    return this.activeVaultId;
  }

  /** Get the team ID for the currently open team vault (null if none open). */
  getActiveTeamId(): string | null {
    return this.activeTeamId;
  }

  /** Get the currently open team vault instance (null if none open). */
  getActiveVault(): ConduitVault | null {
    return this.activeVault;
  }

  /** Get the currently active team sync service. */
  getActiveSync(): TeamSyncService | null {
    return this.activeSync;
  }

  /**
   * Create a new team vault.
   *
   * 1. Generate VEK
   * 2. Create local vault with initializeWithKey()
   * 3. Wrap VEK for creator
   * 4. Register in Supabase (team_vaults, vault_key_wraps, team_vault_members)
   * 5. Initial entry upload via TeamSyncService
   */
  async createTeamVault(name: string, teamId: string, description?: string): Promise<TeamVaultInfo> {
    const supabase = this.authService.getSupabaseClient();
    const userId = this.requireUserId();

    // Load identity key pair
    const privateDer = loadPrivateKey(userId);
    if (!privateDer) {
      throw new Error('No identity key found. Set up your identity key first.');
    }
    const publicDer = derivePublicKey(privateDer);

    // 1. Generate VEK
    const vek = generateVEK();

    // 2. Register in Supabase first (to get the vault ID)
    const { data: vaultRow, error: createError } = await supabase
      .from('team_vaults')
      .insert({
        team_id: teamId,
        name,
        description: description ?? null,
        created_by: userId,
      })
      .select()
      .single();

    if (createError || !vaultRow) {
      throw new Error(`Failed to create team vault: ${createError?.message ?? 'unknown error'}`);
    }

    const teamVaultId = vaultRow.id as string;

    try {
      // 3. Add creator as vault admin first (must precede key wrap insert for RLS)
      const { error: memberError } = await supabase
        .from('team_vault_members')
        .insert({
          team_vault_id: teamVaultId,
          user_id: userId,
          role: 'admin',
          added_by: userId,
        });

      if (memberError) throw new Error(`Failed to add vault membership: ${memberError.message}`);

      // 4. Wrap VEK for creator and store
      const wrapped = wrapVEK(vek, publicDer);

      const { error: wrapError } = await supabase
        .from('vault_key_wraps')
        .insert({
          team_vault_id: teamVaultId,
          user_id: userId,
          ephemeral_public_key_b64: wrapped.ephemeralPublicKeyB64,
          encrypted_vek_b64: wrapped.encryptedVekB64,
          key_version: 1,
        });

      if (wrapError) throw new Error(`Failed to store key wrap: ${wrapError.message}`);

      // 5. Auto-enroll all other team admins (VEK is still in memory)
      const { data: teamAdmins } = await supabase
        .from('team_members')
        .select('user_id')
        .eq('team_id', teamId)
        .eq('role', 'admin')
        .neq('user_id', userId);

      if (teamAdmins) {
        for (const admin of teamAdmins) {
          try {
            const { data: adminKey } = await supabase
              .from('user_public_keys')
              .select('public_key_b64')
              .eq('user_id', admin.user_id)
              .eq('is_active', true)
              .limit(1)
              .single();

            if (!adminKey) continue; // Skip admins without identity keys

            const adminPubDer = Buffer.from(adminKey.public_key_b64 as string, 'base64');
            const adminWrapped = wrapVEK(vek, adminPubDer);

            await supabase.from('team_vault_members').insert({
              team_vault_id: teamVaultId,
              user_id: admin.user_id,
              role: 'admin',
              added_by: userId,
            });
            await supabase.from('vault_key_wraps').insert({
              team_vault_id: teamVaultId,
              user_id: admin.user_id,
              ephemeral_public_key_b64: adminWrapped.ephemeralPublicKeyB64,
              encrypted_vek_b64: adminWrapped.encryptedVekB64,
              key_version: 1,
            });
          } catch (err) {
            console.warn(`[team-vault] Auto-enroll admin ${admin.user_id} failed:`, err);
          }
        }
      }

      // 6. Create local vault file
      const localPath = this.getTeamVaultLocalPath(teamVaultId);
      const vault = new ConduitVault(localPath);
      vault.initializeWithKey(vek);
      vault.setTeamVaultId(teamVaultId);
      vault.lock();

      return {
        id: teamVaultId,
        teamId,
        name,
        description: description ?? null,
        keyVersion: 1,
        rotationPending: false,
        createdAt: vaultRow.created_at as string,
      };
    } catch (err) {
      // Cleanup on failure
      await supabase.from('team_vaults').delete().eq('id', teamVaultId);
      throw err;
    } finally {
      vek.fill(0);
    }
  }

  /**
   * Open an existing team vault.
   *
   * 1. Fetch wrapped VEK from Supabase
   * 2. Unwrap with local private key
   * 3. Create/open local cache file
   * 4. unlockWithKey()
   * 5. Start TeamSyncService
   */
  async openTeamVault(teamVaultId: string): Promise<ConduitVault> {
    // Close any currently open team vault first
    this.closeTeamVault();

    const supabase = this.authService.getSupabaseClient();
    const userId = this.requireUserId();

    // Load identity key pair
    const privateDer = loadPrivateKey(userId);
    if (!privateDer) {
      throw new Error('No identity key found. Set up your identity key first.');
    }
    const publicDer = derivePublicKey(privateDer);

    // 1. Fetch vault info
    const { data: vaultRow, error: vaultError } = await supabase
      .from('team_vaults')
      .select('*')
      .eq('id', teamVaultId)
      .single();

    if (vaultError || !vaultRow) {
      throw new Error(`Team vault not found: ${vaultError?.message ?? 'unknown'}`);
    }

    // 1b. Lock acquisition for Pro users (non-team-tier)
    // Team-tier users have concurrent access; Pro users need exclusive locks.
    if (this.vaultLock) {
      const profile = this.authService.getAuthState().profile;
      const isTeamTier = profile?.is_team_member === true;

      if (!isTeamTier) {
        const lockResult = await this.vaultLock.acquireCloudLock(teamVaultId);
        if (!lockResult.success) {
          throw new Error(JSON.stringify({
            type: 'VAULT_LOCKED',
            lockedByEmail: lockResult.userEmail ?? 'another user',
            lockedAt: lockResult.lockedAt ?? new Date().toISOString(),
          }));
        }
      }
    }

    // 2. Fetch wrapped VEK for this user
    const { data: wrapRow, error: wrapError } = await supabase
      .from('vault_key_wraps')
      .select('*')
      .eq('team_vault_id', teamVaultId)
      .eq('user_id', userId)
      .eq('key_version', vaultRow.key_version)
      .single();

    if (wrapError || !wrapRow) {
      // Distinguish "not a vault member" from "member without key wrap"
      const { data: membership } = await supabase
        .from('team_vault_members')
        .select('user_id')
        .eq('team_vault_id', teamVaultId)
        .eq('user_id', userId)
        .single();

      if (!membership) {
        throw new Error('You are not a member of this vault. Ask a vault admin to open it first so you can be auto-enrolled.');
      }
      throw new Error('Your key wrap is missing or outdated. Ask a vault admin to open the vault to trigger re-enrollment, or contact your team admin.');
    }

    // 3. Unwrap VEK
    const vek = unwrapVEK(
      {
        ephemeralPublicKeyB64: wrapRow.ephemeral_public_key_b64 as string,
        encryptedVekB64: wrapRow.encrypted_vek_b64 as string,
      },
      privateDer,
      publicDer,
    );

    try {
      // 4. Open/create local vault cache
      const localPath = this.getTeamVaultLocalPath(teamVaultId);
      const vault = new ConduitVault(localPath);

      if (vault.exists()) {
        vault.unlockWithKey(vek);
      } else {
        vault.initializeWithKey(vek);
        vault.setTeamVaultId(teamVaultId);
      }

      // 4b. Auto-enroll unenrolled team admins (catch-up for late identity key setup)
      try {
        const teamId = vaultRow.team_id as string;
        const keyVersion = vaultRow.key_version as number;

        // Get all team admins except the current user
        const { data: teamAdmins } = await supabase
          .from('team_members')
          .select('user_id')
          .eq('team_id', teamId)
          .eq('role', 'admin')
          .neq('user_id', userId);

        if (teamAdmins?.length) {
          // Get existing vault members
          const { data: existingMembers } = await supabase
            .from('team_vault_members')
            .select('user_id')
            .eq('team_vault_id', teamVaultId);

          const memberSet = new Set((existingMembers ?? []).map((m: Record<string, unknown>) => m.user_id));

          for (const admin of teamAdmins) {
            if (memberSet.has(admin.user_id)) continue;

            // Check if they have an active public key
            const { data: pubKey } = await supabase
              .from('user_public_keys')
              .select('public_key_b64')
              .eq('user_id', admin.user_id)
              .eq('is_active', true)
              .limit(1)
              .single();

            if (!pubKey) continue;

            const adminPubDer = Buffer.from(pubKey.public_key_b64 as string, 'base64');
            const wrapped = wrapVEK(vek, adminPubDer);

            await supabase.from('vault_key_wraps').insert({
              team_vault_id: teamVaultId,
              user_id: admin.user_id,
              ephemeral_public_key_b64: wrapped.ephemeralPublicKeyB64,
              encrypted_vek_b64: wrapped.encryptedVekB64,
              key_version: keyVersion,
            });

            await supabase.from('team_vault_members').insert({
              team_vault_id: teamVaultId,
              user_id: admin.user_id,
              role: 'admin',
              added_by: userId,
            });

            console.log(`[team-vault] Auto-enrolled admin ${admin.user_id} in vault ${teamVaultId}`);
          }
        }
      } catch (err) {
        console.warn('[team-vault] Auto-enrollment of missing admins failed (non-blocking):', err);
      }

      // 5. Start sync service
      const syncService = new TeamSyncService(this.authService);
      syncService.start(vault, vek, teamVaultId);

      // Wire mutation callback to sync
      vault.setOnMutation((mutation) => {
        syncService.onMutation(mutation);
      });

      this.activeVault = vault;
      this.activeVaultId = teamVaultId;
      this.activeTeamId = vaultRow.team_id as string;
      this.activeSync = syncService;

      return vault;
    } finally {
      // Zero the VEK copy (sync service has its own copy)
      vek.fill(0);
    }
  }

  /** Close the currently open team vault. */
  closeTeamVault(): void {
    if (this.activeSync) {
      this.activeSync.stop();
      this.activeSync = null;
    }

    if (this.activeVault) {
      this.activeVault.lock();
      this.activeVault = null;
    }

    // Release any held cloud lock
    if (this.activeVaultId && this.vaultLock) {
      this.vaultLock.releaseCloudLock(this.activeVaultId).catch((err) => {
        console.warn('[team-vault] Failed to release cloud lock on close:', err);
      });
    }

    this.activeVaultId = null;
    this.activeTeamId = null;
  }

  /**
   * Add a member to a team vault.
   *
   * 1. Fetch member's public key
   * 2. Unwrap our copy of the VEK
   * 3. Re-wrap for the new member
   * 4. Insert vault_key_wraps + team_vault_members
   */
  async addMember(
    teamVaultId: string,
    targetUserId: string,
    role: 'admin' | 'editor' | 'viewer' = 'editor',
  ): Promise<void> {
    const supabase = this.authService.getSupabaseClient();
    const userId = this.requireUserId();

    // Verify we're an admin of this vault
    await this.requireVaultAdmin(supabase, teamVaultId, userId);

    // Load our identity key pair
    const privateDer = loadPrivateKey(userId);
    if (!privateDer) {
      throw new Error('No identity key found.');
    }
    const publicDer = derivePublicKey(privateDer);

    // Fetch the vault's current key version
    const { data: vaultRow } = await supabase
      .from('team_vaults')
      .select('key_version')
      .eq('id', teamVaultId)
      .single();

    if (!vaultRow) throw new Error('Team vault not found');
    const keyVersion = vaultRow.key_version as number;

    // Fetch our wrapped VEK
    const { data: ourWrap } = await supabase
      .from('vault_key_wraps')
      .select('*')
      .eq('team_vault_id', teamVaultId)
      .eq('user_id', userId)
      .eq('key_version', keyVersion)
      .single();

    if (!ourWrap) throw new Error('Cannot find your key wrap for this vault');

    // Unwrap our VEK
    const vek = unwrapVEK(
      {
        ephemeralPublicKeyB64: ourWrap.ephemeral_public_key_b64 as string,
        encryptedVekB64: ourWrap.encrypted_vek_b64 as string,
      },
      privateDer,
      publicDer,
    );

    try {
      // Fetch target user's public key
      const { data: targetKey } = await supabase
        .from('user_public_keys')
        .select('public_key_b64')
        .eq('user_id', targetUserId)
        .eq('is_active', true)
        .limit(1)
        .single();

      if (!targetKey) {
        throw new Error('Target user has not set up their identity key yet.');
      }

      const targetPubDer = Buffer.from(targetKey.public_key_b64 as string, 'base64');

      // Wrap VEK for new member
      const wrapped = wrapVEK(vek, targetPubDer);

      // Insert key wrap
      const { error: wrapError } = await supabase
        .from('vault_key_wraps')
        .insert({
          team_vault_id: teamVaultId,
          user_id: targetUserId,
          ephemeral_public_key_b64: wrapped.ephemeralPublicKeyB64,
          encrypted_vek_b64: wrapped.encryptedVekB64,
          key_version: keyVersion,
        });

      if (wrapError) throw new Error(`Failed to store key wrap: ${wrapError.message}`);

      // Insert vault membership
      const { error: memberError } = await supabase
        .from('team_vault_members')
        .insert({
          team_vault_id: teamVaultId,
          user_id: targetUserId,
          role,
          added_by: userId,
        });

      if (memberError) throw new Error(`Failed to add vault membership: ${memberError.message}`);
    } finally {
      vek.fill(0);
    }
  }

  /**
   * Remove a member from a team vault.
   * Deletes their key wrap and membership, flags rotation pending.
   */
  async removeMember(teamVaultId: string, targetUserId: string): Promise<void> {
    const supabase = this.authService.getSupabaseClient();
    const userId = this.requireUserId();

    await this.requireVaultAdmin(supabase, teamVaultId, userId);

    // Cannot remove yourself
    if (targetUserId === userId) {
      throw new Error('Cannot remove yourself from the vault');
    }

    // Delete key wrap
    await supabase
      .from('vault_key_wraps')
      .delete()
      .eq('team_vault_id', teamVaultId)
      .eq('user_id', targetUserId);

    // Delete vault membership
    await supabase
      .from('team_vault_members')
      .delete()
      .eq('team_vault_id', teamVaultId)
      .eq('user_id', targetUserId);

    // Flag rotation pending
    await supabase
      .from('team_vaults')
      .update({ rotation_pending: true })
      .eq('id', teamVaultId);
  }

  /**
   * Update a member's vault role.
   * Only vault admins can change roles. Cannot change your own role.
   * Cascades: prunes folder permissions that exceed the new ceiling.
   */
  async updateMemberRole(
    teamVaultId: string,
    targetUserId: string,
    newRole: 'admin' | 'editor' | 'viewer',
  ): Promise<void> {
    const supabase = this.authService.getSupabaseClient();
    const userId = this.requireUserId();
    await this.requireVaultAdmin(supabase, teamVaultId, userId);

    if (targetUserId === userId) throw new Error('Cannot change your own vault role');

    // Protect against demoting the last admin
    if (newRole !== 'admin') {
      const { data: admins } = await supabase
        .from('team_vault_members')
        .select('user_id')
        .eq('team_vault_id', teamVaultId)
        .eq('role', 'admin');

      const adminCount = admins?.length ?? 0;
      const isTargetAdmin = admins?.some((a) => a.user_id === targetUserId);
      if (isTargetAdmin && adminCount <= 1) {
        throw new Error('Cannot demote the last vault admin');
      }
    }

    const { error } = await supabase
      .from('team_vault_members')
      .update({ role: newRole })
      .eq('team_vault_id', teamVaultId)
      .eq('user_id', targetUserId);

    if (error) throw new Error(`Failed to update member role: ${error.message}`);

    // Cascade: prune folder permissions that exceed the new ceiling
    if (newRole !== 'admin') {
      const rolesToRemove = newRole === 'viewer' ? ['admin', 'editor'] : ['admin'];
      await supabase
        .from('vault_folder_permissions')
        .delete()
        .eq('vault_id', teamVaultId)
        .eq('user_id', targetUserId)
        .in('role', rolesToRemove);
    }
  }

  /**
   * Enroll a user as admin in all team vaults they're not already a member of.
   * For vaults where they're already a member, upgrade their role to admin.
   * Used when promoting a team member to team admin.
   */
  async enrollAdminInAllVaults(teamId: string, targetUserId: string): Promise<void> {
    const supabase = this.authService.getSupabaseClient();
    const userId = this.requireUserId();

    // Fetch all team vaults
    const { data: vaults } = await supabase
      .from('team_vaults')
      .select('id')
      .eq('team_id', teamId);

    if (!vaults || vaults.length === 0) return;

    for (const vault of vaults) {
      const vaultId = vault.id as string;

      // Check if target is already a member
      const { data: existing } = await supabase
        .from('team_vault_members')
        .select('role')
        .eq('team_vault_id', vaultId)
        .eq('user_id', targetUserId)
        .single();

      if (existing) {
        // Already a member — upgrade to admin if not already
        if (existing.role !== 'admin') {
          await supabase
            .from('team_vault_members')
            .update({ role: 'admin' })
            .eq('team_vault_id', vaultId)
            .eq('user_id', targetUserId);
        }
      } else {
        // Not a member — add them with VEK wrap
        try {
          await this.addMember(vaultId, targetUserId, 'admin');
        } catch (err) {
          console.warn(`[team-vault] Failed to enroll admin ${targetUserId} in vault ${vaultId}:`, err);
        }
      }
    }
  }

  /**
   * Rotate the VEK for a team vault.
   *
   * 1. Generate new VEK
   * 2. Re-encrypt all local entries with new VEK
   * 3. Re-wrap for all remaining members
   * 4. Update key version, re-upload all entries
   */
  async rotateVEK(teamVaultId: string): Promise<void> {
    const supabase = this.authService.getSupabaseClient();
    const userId = this.requireUserId();

    await this.requireVaultAdmin(supabase, teamVaultId, userId);

    // Ensure the vault is currently open
    if (this.activeVaultId !== teamVaultId || !this.activeVault) {
      throw new Error('Vault must be open to rotate keys');
    }

    // Load our identity key
    const privateDer = loadPrivateKey(userId);
    if (!privateDer) throw new Error('No identity key found.');
    const publicDer = derivePublicKey(privateDer);

    // Generate new VEK
    const newVek = generateVEK();

    try {
      // Fetch all prerequisite cloud data BEFORE rekeying the local vault.
      // If any fetch fails, we haven't modified the local vault yet.

      // Get current key version
      const { data: vaultRow } = await supabase
        .from('team_vaults')
        .select('key_version')
        .eq('id', teamVaultId)
        .single();

      if (!vaultRow) throw new Error('Vault not found');
      const newKeyVersion = (vaultRow.key_version as number) + 1;

      // Fetch all current vault members
      const { data: members } = await supabase
        .from('team_vault_members')
        .select('user_id')
        .eq('team_vault_id', teamVaultId);

      if (!members) throw new Error('Cannot fetch vault members');

      // Fetch all member public keys upfront
      const memberKeys: Array<{ userId: string; pubDer: Buffer }> = [];
      for (const member of members) {
        const { data: memberKey } = await supabase
          .from('user_public_keys')
          .select('public_key_b64')
          .eq('user_id', member.user_id)
          .eq('is_active', true)
          .limit(1)
          .single();

        if (!memberKey) {
          console.warn(`[team-vault] Skipping key wrap for user ${member.user_id} — no public key`);
          continue;
        }

        memberKeys.push({
          userId: member.user_id as string,
          pubDer: Buffer.from(memberKey.public_key_b64 as string, 'base64'),
        });
      }

      // All prerequisite data validated — now rekey the local vault
      this.activeVault.rekey(newVek);

      // Post-rekey cloud operations: wrap and upload
      try {
        // Re-wrap VEK for each member
        for (const { userId: memberId, pubDer } of memberKeys) {
          const wrapped = wrapVEK(newVek, pubDer);

          await supabase
            .from('vault_key_wraps')
            .insert({
              team_vault_id: teamVaultId,
              user_id: memberId,
              ephemeral_public_key_b64: wrapped.ephemeralPublicKeyB64,
              encrypted_vek_b64: wrapped.encryptedVekB64,
              key_version: newKeyVersion,
            });
        }

        // Update vault key version and clear rotation flag
        await supabase
          .from('team_vaults')
          .update({
            key_version: newKeyVersion,
            rotation_pending: false,
            updated_at: new Date().toISOString(),
          })
          .eq('id', teamVaultId);
      } catch (postRekeyErr) {
        // Safety net: vault is already rekeyed but cloud wraps may be incomplete.
        // At minimum, wrap the new VEK for the current user so they can still access it.
        console.error('[team-vault] Post-rekey cloud operations failed, wrapping VEK for current user as safety net:', postRekeyErr);
        try {
          const wrapped = wrapVEK(newVek, publicDer);
          await supabase
            .from('vault_key_wraps')
            .upsert({
              team_vault_id: teamVaultId,
              user_id: userId,
              ephemeral_public_key_b64: wrapped.ephemeralPublicKeyB64,
              encrypted_vek_b64: wrapped.encryptedVekB64,
              key_version: newKeyVersion,
            });
        } catch (safetyErr) {
          console.error('[team-vault] Safety-net key wrap also failed:', safetyErr);
        }
        throw postRekeyErr;
      }

      // Restart sync with new VEK (skip initial reconcile — we must upload first
      // to replace old-VEK cloud data before downloading anything).
      if (this.activeSync) {
        this.activeSync.stop();
      }
      this.activeSync = new TeamSyncService(this.authService);
      this.activeSync.start(this.activeVault, newVek, teamVaultId, true);

      this.activeVault.setOnMutation((mutation) => {
        this.activeSync?.onMutation(mutation);
      });

      // Force re-upload ALL entries/folders encrypted with the new VEK.
      // This replaces the old cloud data (encrypted with old VEK) so
      // other members can decrypt with their new key wraps.
      await this.activeSync.forceUploadAll();

      // Now safe to reconcile (cloud data is encrypted with new VEK)
      await this.activeSync.syncNow();
    } finally {
      newVek.fill(0);
    }
  }

  /** List members of a team vault. Returns snake_case keys matching the frontend TeamVaultMember type. */
  async listMembers(teamVaultId: string): Promise<TeamVaultMemberInfo[]> {
    const supabase = this.authService.getSupabaseClient();

    // Fetch vault members
    const { data, error } = await supabase
      .from('team_vault_members')
      .select('user_id, role, created_at')
      .eq('team_vault_id', teamVaultId)
      .order('created_at');

    if (error || !data) {
      console.error('[team-vault] Failed to list members:', error?.message);
      return [];
    }
    if (data.length === 0) return [];

    // Resolve display names via the team_id → get_team_members_with_email RPC
    // (direct user_profiles queries are blocked by RLS)
    const { data: vault } = await supabase
      .from('team_vaults')
      .select('team_id')
      .eq('id', teamVaultId)
      .single();

    const profileMap = new Map<string, { display_name?: string; email?: string }>();

    if (vault?.team_id) {
      const { data: teamMembers } = await supabase
        .rpc('get_team_members_with_email', { p_team_id: vault.team_id });

      if (teamMembers) {
        for (const tm of teamMembers as Record<string, unknown>[]) {
          profileMap.set(tm.user_id as string, {
            display_name: tm.user_display_name as string | undefined,
            email: tm.user_email as string | undefined,
          });
        }
      }
    }

    return data.map((m: Record<string, unknown>) => {
      const profile = profileMap.get(m.user_id as string);
      return {
        user_id: m.user_id as string,
        role: m.role as 'admin' | 'editor' | 'viewer',
        user_display_name: profile?.display_name,
        user_email: profile?.email,
        created_at: m.created_at as string,
      };
    });
  }

  // ---------- Helpers ----------

  private getTeamVaultLocalPath(teamVaultId: string): string {
    const dataDir = getDataDir();
    return path.join(dataDir, 'team-vaults', `${teamVaultId}.conduit`);
  }

  private requireUserId(): string {
    const state = this.authService.getAuthState();
    if (!state.isAuthenticated || !state.user) {
      throw new Error('Not authenticated');
    }
    return state.user.id;
  }

  private async requireVaultAdmin(
    supabase: SupabaseClient,
    teamVaultId: string,
    userId: string,
  ): Promise<void> {
    const { data } = await supabase
      .from('team_vault_members')
      .select('role')
      .eq('team_vault_id', teamVaultId)
      .eq('user_id', userId)
      .single();

    if (!data || data.role !== 'admin') {
      throw new Error('You must be a vault admin to perform this action');
    }
  }

  /** Require vault admin OR team admin role. */
  private async requireVaultOrTeamAdmin(
    supabase: SupabaseClient,
    teamVaultId: string,
    userId: string,
  ): Promise<void> {
    // Check vault-level admin first
    const { data: vaultMember } = await supabase
      .from('team_vault_members')
      .select('role')
      .eq('team_vault_id', teamVaultId)
      .eq('user_id', userId)
      .single();

    if (vaultMember?.role === 'admin') return;

    // Fall back to team-level admin
    const { data: vault } = await supabase
      .from('team_vaults')
      .select('team_id')
      .eq('id', teamVaultId)
      .single();

    if (vault?.team_id) {
      const { data: teamMember } = await supabase
        .from('team_members')
        .select('role')
        .eq('team_id', vault.team_id as string)
        .eq('user_id', userId)
        .single();

      if (teamMember?.role === 'admin') return;
    }

    throw new Error('You must be a vault admin or team admin to rename this vault');
  }

  /** Rename a team vault (update name in Supabase). */
  async renameTeamVault(teamVaultId: string, newName: string): Promise<void> {
    const trimmed = newName.trim();
    if (!trimmed) throw new Error('Vault name cannot be empty');
    if (trimmed.length > 100) throw new Error('Vault name must be 100 characters or fewer');

    const userId = this.requireUserId();
    const supabase = this.authService.getSupabaseClient();

    await this.requireVaultOrTeamAdmin(supabase, teamVaultId, userId);

    const { error } = await supabase
      .from('team_vaults')
      .update({ name: trimmed })
      .eq('id', teamVaultId);

    if (error) throw new Error(`Failed to rename vault: ${error.message}`);
  }
}
