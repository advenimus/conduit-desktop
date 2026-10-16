/**
 * Dev-only owner tag bypass: CONDUIT_DEV_IGNORE_OWNER_TAG=1 skips the unlock-time owner tag
 * check (docs/PLAN_ENFORCEMENT.md 3.4) so a developer can open a vault owned by another
 * account against the preview stack. While it is on, this device never writes the owner tag.
 * Packaged builds and production builds ignore it; the server still decides leases, device
 * limits, backup and team vaults.
 */

import { resolveEnvironment } from '../vault-session/effective-limit.js';
import { SYNC_LOG_PREFIX, type SyncLogger } from './host.js';

export const DEV_IGNORE_OWNER_TAG_ENV = 'CONDUIT_DEV_IGNORE_OWNER_TAG';

/** True only for an unpackaged preview build with the variable set to exactly 1. */
export function devIgnoreOwnerTag(
  isPackaged: boolean,
  env: Readonly<Record<string, string | undefined>>,
  logger: SyncLogger,
): boolean {
  const raw = env[DEV_IGNORE_OWNER_TAG_ENV]?.trim();
  if (raw === undefined || raw === '' || raw === '0') return false;
  if (isPackaged) {
    logger.warn(`${SYNC_LOG_PREFIX} ${DEV_IGNORE_OWNER_TAG_ENV} is ignored in packaged builds`);
    return false;
  }
  if (resolveEnvironment(isPackaged, env.CONDUIT_ENV) !== 'preview') {
    logger.warn(`${SYNC_LOG_PREFIX} ${DEV_IGNORE_OWNER_TAG_ENV} is ignored against production`);
    return false;
  }
  if (raw !== '1') {
    logger.warn(`${SYNC_LOG_PREFIX} ${DEV_IGNORE_OWNER_TAG_ENV} must be 1`);
    return false;
  }
  logger.warn(`${SYNC_LOG_PREFIX} dev override: the owner tag check is skipped and the owner tag is never written`);
  return true;
}
