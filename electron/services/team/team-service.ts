/**
 * Team management service for the Electron main process.
 *
 * Provides team CRUD, membership management, invitation handling,
 * and audit logging. Follows the AuthService pattern.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthService } from '../auth/supabase.js';

// ---------- Types ----------

export interface Team {
  id: string;
  name: string;
  slug: string;
  owner_id: string;
  max_seats: number;
  created_at: string;
  updated_at: string;
}

export interface TeamMember {
  id: string;
  team_id: string;
  user_id: string;
  role: 'admin' | 'member';
  joined_at: string;
  user_email?: string;
  user_display_name?: string;
}

export interface TeamInvitation {
  id: string;
  team_id: string;
  email: string;
  invited_by: string;
  role: 'admin' | 'member';
  status: 'pending' | 'accepted' | 'declined' | 'expired';
  token: string;
  expires_at: string;
  created_at: string;
  responded_at: string | null;
  team_name?: string;
}

export interface TeamVaultSummary {
  id: string;
  team_id: string;
  name: string;
  description: string | null;
  created_by: string;
  member_count: number;
  created_at: string;
  updated_at: string;
}

export interface AuditLogEntry {
  id: string;
  team_id: string;
  team_vault_id: string | null;
  actor_id: string;
  actor_email: string;
  actor_display_name?: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  target_name: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

// ---------- Service ----------

export class TeamService {
  private authService: AuthService;

  constructor(authService: AuthService) {
    this.authService = authService;
  }

  private getSupabase(): SupabaseClient {
    return this.authService.getSupabaseClient();
  }

  private getUserId(): string {
    const state = this.authService.getAuthState();
    if (!state.isAuthenticated || !state.user) {
      throw new Error('Not authenticated');
    }
    return state.user.id;
  }

  // ---------- Team queries ----------

  /** Get the user's team (from primary_team_id on profile). */
  async getTeam(): Promise<Team | null> {
    const userId = this.getUserId();
    const supabase = this.getSupabase();

    // Get primary team ID from profile
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('primary_team_id')
      .eq('id', userId)
      .single();

    if (profileError) {
      console.error('[team-service] Failed to fetch profile:', profileError.message, profileError.code);
    }

    if (!profile?.primary_team_id) {
      // Fallback: find first team via membership
      const { data: membership, error: memberError } = await supabase
        .from('team_members')
        .select('team_id')
        .eq('user_id', userId)
        .limit(1)
        .maybeSingle();

      if (memberError) {
        console.error('[team-service] Failed to fetch membership:', memberError.message, memberError.code);
      }

      if (!membership) return null;

      const { data: team, error: teamError } = await supabase
        .from('teams')
        .select('*')
        .eq('id', membership.team_id)
        .single();

      if (teamError) {
        console.error('[team-service] Failed to fetch team (fallback):', teamError.message, teamError.code);
      }

      return team ?? null;
    }

    const { data: team, error: teamError } = await supabase
      .from('teams')
      .select('*')
      .eq('id', profile.primary_team_id)
      .single();

    if (teamError) {
      console.error('[team-service] Failed to fetch team:', teamError.message, teamError.code);
    }

    return team ?? null;
  }

  /** Get all members of the user's team. */
  async getMembers(): Promise<TeamMember[]> {
    const team = await this.getTeam();
    if (!team) return [];

    const supabase = this.getSupabase();
    const { data: members, error } = await supabase
      .rpc('get_team_members_with_email', { p_team_id: team.id });

    if (error) {
      console.error('[team-service] Failed to fetch members:', error.message, error.code);
      return [];
    }
    if (!members) return [];

    return (members as Record<string, unknown>[]).map((m) => ({
      id: m.id as string,
      team_id: m.team_id as string,
      user_id: m.user_id as string,
      role: m.role as 'admin' | 'member',
      joined_at: m.joined_at as string,
      user_email: m.user_email as string | undefined,
      user_display_name: m.user_display_name as string | undefined,
    }));
  }

  /** Get the current user's role in their team. */
  async getMyRole(): Promise<'admin' | 'member' | null> {
    const team = await this.getTeam();
    if (!team) return null;

    const userId = this.getUserId();
    const supabase = this.getSupabase();

    const { data } = await supabase
      .from('team_members')
      .select('role')
      .eq('team_id', team.id)
      .eq('user_id', userId)
      .single();

    return (data?.role as 'admin' | 'member') ?? null;
  }

  // ---------- Invitations ----------

  /** Get pending invitations for the current user (by email). */
  async getPendingInvitations(): Promise<TeamInvitation[]> {
    const state = this.authService.getAuthState();
    if (!state.isAuthenticated || !state.user) return [];

    const supabase = this.getSupabase();
    const { data, error } = await supabase
      .from('team_invitations')
      .select(`
        *,
        team:teams ( name )
      `)
      .eq('email', state.user.email)
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString());

    if (error || !data) return [];

    return data.map((inv: Record<string, unknown>) => ({
      ...inv,
      team_name: (inv.team as Record<string, unknown> | null)?.name as string | undefined,
    })) as TeamInvitation[];
  }

  /** Accept a team invitation. */
  async acceptInvitation(invitationId: string): Promise<void> {
    const userId = this.getUserId();
    const supabase = this.getSupabase();

    // Get the invitation
    const { data: invitation, error: fetchError } = await supabase
      .from('team_invitations')
      .select('*')
      .eq('id', invitationId)
      .single();

    if (fetchError || !invitation) {
      throw new Error('Invitation not found');
    }

    if (invitation.status !== 'pending') {
      throw new Error(`Invitation already ${invitation.status}`);
    }

    // Defense-in-depth: verify the invitation email matches the current user
    const currentEmail = this.authService.getAuthState().user?.email;
    if (!currentEmail || invitation.email.toLowerCase() !== currentEmail.toLowerCase()) {
      throw new Error('This invitation was sent to a different email address');
    }

    // Add user as team member
    const { error: memberError } = await supabase
      .from('team_members')
      .insert({
        team_id: invitation.team_id,
        user_id: userId,
        role: invitation.role,
      });

    if (memberError) {
      throw new Error(`Failed to join team: ${memberError.message}`);
    }

    // Update invitation status
    await supabase
      .from('team_invitations')
      .update({
        status: 'accepted',
        responded_at: new Date().toISOString(),
      })
      .eq('id', invitationId);

    // Set primary team if not set
    await supabase
      .from('user_profiles')
      .update({ primary_team_id: invitation.team_id })
      .eq('id', userId)
      .is('primary_team_id', null);
  }

  /** Decline a team invitation. */
  async declineInvitation(invitationId: string): Promise<void> {
    const supabase = this.getSupabase();

    await supabase
      .from('team_invitations')
      .update({
        status: 'declined',
        responded_at: new Date().toISOString(),
      })
      .eq('id', invitationId);
  }

  // ---------- Team vaults ----------

  /** List all team vaults the user has access to. */
  async listTeamVaults(): Promise<TeamVaultSummary[]> {
    const team = await this.getTeam();
    if (!team) return [];

    const supabase = this.getSupabase();
    const { data, error } = await supabase
      .from('team_vaults')
      .select('*')
      .eq('team_id', team.id)
      .order('name');

    if (error || !data) return [];

    // Fetch member counts for all vaults in one query
    const vaultIds = data.map((v: Record<string, unknown>) => v.id as string);
    const memberCounts = new Map<string, number>();
    if (vaultIds.length > 0) {
      const { data: members } = await supabase
        .from('team_vault_members')
        .select('team_vault_id')
        .in('team_vault_id', vaultIds);
      if (members) {
        for (const m of members as { team_vault_id: string }[]) {
          memberCounts.set(m.team_vault_id, (memberCounts.get(m.team_vault_id) ?? 0) + 1);
        }
      }
    }

    return data.map((v: Record<string, unknown>) => ({
      id: v.id as string,
      team_id: v.team_id as string,
      name: v.name as string,
      description: v.description as string | null,
      created_by: v.created_by as string,
      member_count: memberCounts.get(v.id as string) ?? 0,
      created_at: v.created_at as string,
      updated_at: v.updated_at as string,
    }));
  }

  // ---------- Audit ----------

  /** Record an audit event. */
  async recordAuditEvent(event: {
    teamId: string;
    teamVaultId?: string;
    action: string;
    targetType?: string;
    targetId?: string;
    targetName?: string;
    details?: Record<string, unknown>;
  }): Promise<void> {
    const state = this.authService.getAuthState();
    if (!state.isAuthenticated || !state.user) return;

    const supabase = this.getSupabase();
    await supabase
      .from('vault_audit_log')
      .insert({
        team_id: event.teamId,
        team_vault_id: event.teamVaultId ?? null,
        actor_id: state.user.id,
        actor_email: state.user.email,
        action: event.action,
        target_type: event.targetType ?? null,
        target_id: event.targetId ?? null,
        target_name: event.targetName ?? null,
        details: event.details ?? {},
      });
  }

  /** Fetch audit log entries for the team. */
  async getAuditLog(params: {
    teamId: string;
    teamVaultId?: string;
    actions?: string[];
    limit?: number;
    offset?: number;
  }): Promise<AuditLogEntry[]> {
    const supabase = this.getSupabase();

    let query = supabase
      .from('vault_audit_log')
      .select('*')
      .eq('team_id', params.teamId)
      .order('created_at', { ascending: false })
      .range(params.offset ?? 0, (params.offset ?? 0) + (params.limit ?? 50) - 1);

    if (params.teamVaultId) {
      query = query.eq('team_vault_id', params.teamVaultId);
    }

    if (params.actions && params.actions.length > 0) {
      query = query.in('action', params.actions);
    }

    const { data, error } = await query;
    if (error || !data) return [];

    const entries = data as AuditLogEntry[];

    // Enrich entries with display names via team RPC (direct user_profiles blocked by RLS)
    const { data: teamMembers } = await supabase
      .rpc('get_team_members_with_email', { p_team_id: params.teamId });

    if (teamMembers) {
      const nameMap = new Map<string, string>();
      for (const tm of teamMembers as Record<string, unknown>[]) {
        if (tm.user_display_name) {
          nameMap.set(tm.user_id as string, tm.user_display_name as string);
        }
      }
      for (const entry of entries) {
        const name = nameMap.get(entry.actor_id);
        if (name) entry.actor_display_name = name;
      }
    }

    return entries;
  }
}
