import { create } from 'zustand';
import { useAuthStore } from './authStore';
import { useEntryStore } from './entryStore';
import { useSessionStore } from './sessionStore';
import { canAccessFeature, getFeatureLimit, getTrialDaysRemaining } from '../lib/tier';
import { toast } from '../components/common/Toast';

interface TierStoreState {
  accessibleEntryIds: Set<string>;
  lockedEntryIds: Set<string>;
  maxConnections: number; // -1 = unlimited

  // Feature flags
  cliAgentsEnabled: boolean;
  mcpEnabled: boolean;
  mcpDailyQuota: number; // -1 = unlimited
  cloudSyncEnabled: boolean;
  chatCloudSyncEnabled: boolean;
  sharedVaults: boolean;

  // Trial state
  isTrialing: boolean;
  trialDaysRemaining: number;
  trialEligible: boolean;
  trialUrgency: 'none' | 'subtle' | 'moderate' | 'urgent';

  // Actions
  recompute: () => void;
  isEntryLocked: (id: string) => boolean;
  canCreateEntry: () => boolean;
}

// Track previous locked set for session cleanup diffing
let previousLockedIds = new Set<string>();
let subscriptionsInitialized = false;

export const useTierStore = create<TierStoreState>((set, get) => ({
  accessibleEntryIds: new Set<string>(),
  lockedEntryIds: new Set<string>(),
  maxConnections: -1,

  cliAgentsEnabled: true, // free tier supports BYOK CLI agents
  mcpEnabled: true, // free tier has MCP with daily quota
  mcpDailyQuota: 50,
  cloudSyncEnabled: false, // Team-only
  chatCloudSyncEnabled: false, // Team-only
  sharedVaults: false, // Team-only

  isTrialing: false,
  trialDaysRemaining: -1,
  trialEligible: false,
  trialUrgency: 'none' as const,

  recompute: () => {
    const { profile, authMode } = useAuthStore.getState();
    const { entries } = useEntryStore.getState();

    // Local mode or no profile → unlimited connections, no AI/MCP/cloud features
    if (authMode === 'local' || !profile) {
      const allIds = new Set(
        entries.filter((e) => e.entry_type !== 'credential' && e.entry_type !== 'document').map((e) => e.id)
      );
      previousLockedIds = new Set<string>();
      set({
        accessibleEntryIds: allIds,
        lockedEntryIds: new Set<string>(),
        maxConnections: -1,
        cliAgentsEnabled: true,
        mcpEnabled: true,
        mcpDailyQuota: 50,
        cloudSyncEnabled: false,
        chatCloudSyncEnabled: false,
        sharedVaults: false,
        isTrialing: false,
        trialDaysRemaining: -1,
        trialEligible: false,
        trialUrgency: 'none' as const,
      });
      return;
    }

    const maxConnections = getFeatureLimit(profile, 'max_connections');

    // Filter to non-credential entries and sort by created_at ascending (oldest first)
    const connectionEntries = entries
      .filter((e) => e.entry_type !== 'credential' && e.entry_type !== 'document')
      .sort((a, b) => a.created_at.localeCompare(b.created_at));

    const accessibleEntryIds = new Set<string>();
    const lockedEntryIds = new Set<string>();

    if (maxConnections === -1) {
      // Unlimited
      for (const e of connectionEntries) {
        accessibleEntryIds.add(e.id);
      }
    } else {
      for (let i = 0; i < connectionEntries.length; i++) {
        if (i < maxConnections) {
          accessibleEntryIds.add(connectionEntries[i].id);
        } else {
          lockedEntryIds.add(connectionEntries[i].id);
        }
      }
    }

    // Derive feature flags
    const cliAgentsEnabled = canAccessFeature(profile, 'cli_agents_enabled');
    const mcpEnabled = canAccessFeature(profile, 'mcp_enabled');
    const mcpDailyQuota = getFeatureLimit(profile, 'mcp_daily_quota') || 50;
    const cloudSyncEnabled = canAccessFeature(profile, 'cloud_sync_enabled');
    const chatCloudSyncEnabled = canAccessFeature(profile, 'chat_cloud_sync_enabled');
    const sharedVaults = canAccessFeature(profile, 'shared_vaults');

    // Trial state
    const isTrialing = profile.subscription_status === 'trialing';
    const trialDaysRemaining = getTrialDaysRemaining(profile.trial_ends_at);
    const tierName = profile.tier?.name?.toLowerCase() || '';
    const trialEligible = authMode === 'authenticated' &&
      !profile.has_used_trial &&
      !profile.is_team_member &&
      !['pro', 'team'].includes(tierName) &&
      !['active', 'trialing'].includes(profile.subscription_status || '');

    let trialUrgency: 'none' | 'subtle' | 'moderate' | 'urgent' = 'none';
    if (isTrialing && trialDaysRemaining >= 0) {
      if (trialDaysRemaining <= 3) trialUrgency = 'urgent';
      else if (trialDaysRemaining <= 7) trialUrgency = 'moderate';
      else trialUrgency = 'subtle';
    }

    // Session cleanup: close sessions for newly locked entries
    const newlyLocked = new Set<string>();
    for (const id of lockedEntryIds) {
      if (!previousLockedIds.has(id)) {
        newlyLocked.add(id);
      }
    }

    if (newlyLocked.size > 0) {
      const sessionStore = useSessionStore.getState();
      for (const session of sessionStore.sessions) {
        if (session.entryId && newlyLocked.has(session.entryId)) {
          sessionStore.closeSession(session.id).catch((err) => {
            console.error(`[tier] Failed to close session ${session.id}:`, err);
          });
          toast.warning(`Session "${session.title}" disconnected due to plan change.`, {
            actions: [{ label: 'Relaunch', onClick: () => window.electron?.invoke('app_relaunch') }],
          });
        }
      }
    }

    previousLockedIds = new Set(lockedEntryIds);

    set({
      accessibleEntryIds,
      lockedEntryIds,
      maxConnections,
      cliAgentsEnabled,
      mcpEnabled,
      mcpDailyQuota,
      cloudSyncEnabled,
      chatCloudSyncEnabled,
      sharedVaults,
      isTrialing,
      trialDaysRemaining,
      trialEligible,
      trialUrgency,
    });
  },

  isEntryLocked: (id: string) => {
    return get().lockedEntryIds.has(id);
  },

  canCreateEntry: () => {
    const { maxConnections } = get();
    if (maxConnections === -1) return true;

    const { entries } = useEntryStore.getState();
    const connectionCount = entries.filter((e) => e.entry_type !== 'credential' && e.entry_type !== 'document').length;
    return connectionCount < maxConnections;
  },
}));

/**
 * Initialize subscriptions to authStore and entryStore for auto-recompute.
 * Called from App.tsx after all stores are created to ensure modules are fully loaded.
 * ES module live bindings handle the circular import (tierStore ↔ entryStore) —
 * the stores are only accessed at runtime via getState(), not at import time.
 */
export function initTierSubscriptions(): void {
  if (subscriptionsInitialized) return;
  subscriptionsInitialized = true;

  useAuthStore.subscribe((state, prevState) => {
    if (state.profile !== prevState.profile || state.authMode !== prevState.authMode) {
      useTierStore.getState().recompute();
    }
  });

  useEntryStore.subscribe((state, prevState) => {
    if (state.entries !== prevState.entries) {
      useTierStore.getState().recompute();
    }
  });

  // Run initial computation
  useTierStore.getState().recompute();
}
