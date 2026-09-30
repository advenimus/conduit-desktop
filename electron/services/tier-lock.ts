/**
 * The plan lock on connection entries, the rule of src/stores/tierStore.ts recompute: with a
 * max_connections limit, the oldest connection entries stay open and the rest are locked. The
 * renderer is the main gate; this is the main-process check for secrets of a locked entry.
 */

export interface TierEntry {
  readonly id: string;
  readonly entry_type: string;
  readonly created_at: string;
}

export interface TierLockState {
  readonly teamVaultManager: { getActiveVaultId(): string | null };
  readonly authService?: {
    getAuthState(): { authMode?: string; profile: { tier?: { features?: Record<string, unknown> } | null } | null };
  } | null;
  getActiveVault(): { listEntries(): readonly TierEntry[] };
}

export const ENTRY_TIER_LOCKED_MESSAGE = 'This entry is locked. Upgrade your plan to access it.';

const UNCOUNTED_TYPES: ReadonlySet<string> = new Set(['credential', 'document']);

export function tierLockedEntryIds(entries: readonly TierEntry[], maxConnections: number): Set<string> {
  if (maxConnections < 0) return new Set();
  const connections = entries
    .filter((e) => !UNCOUNTED_TYPES.has(e.entry_type))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  return new Set(connections.slice(maxConnections).map((e) => e.id));
}

/** Team vaults, local mode and a missing limit are never locked here (fail open). */
export function isEntryTierLocked(state: TierLockState, entryId: string): boolean {
  if (state.teamVaultManager.getActiveVaultId() !== null) return false;
  const auth = state.authService?.getAuthState();
  if (!auth || auth.authMode === 'local' || !auth.profile) return false;
  const limit = auth.profile.tier?.features?.max_connections;
  if (typeof limit !== 'number' || limit < 0) return false;
  return tierLockedEntryIds(state.getActiveVault().listEntries(), limit).has(entryId);
}
