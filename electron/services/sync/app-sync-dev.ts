/**
 * Dev-only device limit override: CONDUIT_DEV_VAULT_DEVICE_LIMIT (for example -1) forces the
 * effective device limit wherever the client computes it (signed out, local mode, unconfirmed
 * lease), so two signed-out dev builds on two machines can exercise Pro-style concurrent sync
 * without Supabase. Packaged builds ignore it. A confirmed server answer (peek, acquire,
 * heartbeat) still decides for signed-in devices.
 */

import { FREE_LIMIT, isValidLimit, type EffectiveLimit } from '../vault-session/effective-limit.js';
import type { OpenCollaborators } from '../vault-session/open-personal-vault.js';
import { PersonalVaultRuntime, type RuntimeDeps } from '../vault-session/session-runtime.js';
import { SYNC_LOG_PREFIX, type SyncLogger } from './host.js';

export const DEV_DEVICE_LIMIT_ENV = 'CONDUIT_DEV_VAULT_DEVICE_LIMIT';

/** The override, or null (packaged, unset, or not -1 / an integer >= 1). */
export function devDeviceLimitOverride(
  isPackaged: boolean,
  env: Readonly<Record<string, string | undefined>>,
  logger: SyncLogger,
): number | null {
  const raw = env[DEV_DEVICE_LIMIT_ENV]?.trim();
  if (raw === undefined || raw === '') return null;
  if (isPackaged) {
    logger.warn(`${SYNC_LOG_PREFIX} ${DEV_DEVICE_LIMIT_ENV} is ignored in packaged builds`);
    return null;
  }
  const value = Number(raw);
  if (!isValidLimit(value)) {
    logger.warn(`${SYNC_LOG_PREFIX} ${DEV_DEVICE_LIMIT_ENV} must be -1 or a whole number from ${FREE_LIMIT}`);
    return null;
  }
  logger.warn(`${SYNC_LOG_PREFIX} dev override: the device limit is forced`, { limit: value });
  return value;
}

/** The runtime's effectiveLimit() drives claims and the stale-wait mode; the override replaces it. */
export class DevLimitRuntime extends PersonalVaultRuntime {
  private readonly forced: EffectiveLimit;

  constructor(deps: RuntimeDeps, limit: number) {
    super(deps);
    this.forced = Object.freeze({ limit, source: 'default' });
  }

  override effectiveLimit(): EffectiveLimit {
    return this.forced;
  }
}

/** openPersonalVault collaborators that apply the override (empty when there is none). */
export function devLimitCollaborators(limit: number | null): Partial<OpenCollaborators> {
  if (limit === null) return {};
  return {
    effectiveLimit: () => ({ limit, source: 'default' }),
    createRuntime: (deps) => new DevLimitRuntime(deps, limit),
  };
}
