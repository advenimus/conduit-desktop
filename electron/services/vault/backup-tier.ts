/**
 * Plan check for cloud backup and cloud restores (spec 8.1 `cloud_sync_enabled`: Free off,
 * Pro and Team on; a team member always, as the server's cloud_backup_allowed()). The live
 * profile decides; before the profile loads (offline or cached mode) a usable cached tier copy
 * in settings.json decides (7 days, not future-dated).
 */

import { usableCachedTier, type CachedTierFields } from '../auth/tier-cache.js';

export const CLOUD_BACKUP_FEATURE = 'cloud_sync_enabled';
/** The plan messages the backup IPC channels and CloudSyncService show (one source). */
export const CLOUD_BACKUP_PLAN_MESSAGE = 'Cloud backup needs the Pro or Team plan.';
export const CLOUD_RESTORE_PLAN_MESSAGE = 'Cloud backup restore needs the Pro or Team plan.';

/** The parts of AuthState the check reads. */
export interface TierAuthState {
  readonly profile: { readonly tier?: { readonly features?: unknown } | null; readonly is_team_member?: boolean | null } | null;
}

function featureOn(features: unknown): boolean {
  return typeof features === 'object' && features !== null && (features as Record<string, unknown>)[CLOUD_BACKUP_FEATURE] === true;
}

export function cloudBackupAllowed(auth: TierAuthState, settings: CachedTierFields, nowMs: number = Date.now()): boolean {
  if (auth.profile !== null) return auth.profile.is_team_member === true || featureOn(auth.profile.tier?.features);
  return featureOn(usableCachedTier(settings, nowMs));
}
