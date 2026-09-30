/**
 * The cloud backup plan gate as the backup IPC handlers and CloudSyncService apply it: on
 * enable, on every restore, when the service is configured at unlock and before each upload,
 * so a downgraded account stops uploading (spec 8.2). The check itself is backup-tier's
 * (live profile, else a cached copy at most 7 days old and not future-dated).
 */

import type { CachedTierFields } from '../auth/tier-cache.js';
import { cloudBackupAllowed, type TierAuthState } from './backup-tier.js';

export { CLOUD_BACKUP_PLAN_MESSAGE, CLOUD_RESTORE_PLAN_MESSAGE } from './backup-tier.js';

export function cloudBackupPlanAllows(auth: TierAuthState, settings: CachedTierFields, nowMs: number): boolean {
  return cloudBackupAllowed(auth, settings, nowMs);
}

export function requireCloudBackupPlan(auth: TierAuthState, settings: CachedTierFields, message: string): void {
  if (!cloudBackupPlanAllows(auth, settings, Date.now())) throw new Error(message);
}
