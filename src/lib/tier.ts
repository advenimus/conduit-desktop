import type { UserProfile } from '../types/auth';

/**
 * Check if a user profile has access to a specific feature.
 * Feature access is determined by the user's subscription tier.
 */
export function canAccessFeature(
  profile: UserProfile | null,
  feature: string
): boolean {
  if (!profile) return false;
  if (!profile.tier?.features) return false;
  return !!profile.tier.features[feature];
}

/**
 * Get the password history limit for the current tier.
 * Free/local = 3 most recent, Pro/Teams = unlimited (-1).
 */
export function getPasswordHistoryLimit(
  profile: UserProfile | null,
  authMode: string | null
): number {
  if (!profile || authMode === 'local') return 3;
  // Check explicit feature flag first
  const limit = profile.tier?.features?.password_history_limit;
  if (typeof limit === 'number') return limit;
  // Pro and Teams tiers get unlimited even without the feature flag
  const tierName = profile.tier?.name?.toLowerCase();
  if (tierName === 'pro' || tierName === 'team' || tierName === 'teams') return -1;
  return 3;
}

/**
 * Get the numeric limit for a feature (e.g. max_connections).
 * Returns -1 for unlimited, 0 if feature unavailable.
 */
export function getFeatureLimit(
  profile: UserProfile | null,
  feature: string
): number {
  if (!profile) return 0;
  if (!profile.tier?.features) return 0;
  const value = profile.tier.features[feature];
  if (typeof value === 'number') return value;
  return 0;
}

/**
 * Calculate the number of days remaining in a trial period.
 * Returns -1 if not trialing (no trial_ends_at value).
 */
export function getTrialDaysRemaining(trialEndsAt: string | null | undefined): number {
  if (!trialEndsAt) return -1;
  return Math.max(0, Math.ceil((new Date(trialEndsAt).getTime() - Date.now()) / 86400000));
}
