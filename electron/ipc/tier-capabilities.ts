/**
 * The tier capabilities the renderer gates on (`ai_get_tier_capabilities`). The same object is
 * cached in settings.json, where the sync layer reads `vault_max_open_devices` (offline device
 * limit, spec 6.8) and `personal_sync` (kill switch, spec 8.1) when the profile is not loaded.
 */

export type PersonalSyncSwitch = 'on' | 'paused';

export interface TierCapabilities {
  readonly cli_agents_enabled: boolean;
  readonly mcp_enabled: boolean;
  readonly cloud_sync_enabled: boolean;
  readonly shared_vaults: boolean;
  readonly tier_name: string;
  readonly tier_display_name: string;
  readonly is_team_member: boolean;
  /** Present only when the tier defines it (-1 unlimited). */
  readonly vault_max_open_devices?: number;
  /** Devices with any personal vault open, per account (-1 no cap); display only, the server decides. */
  readonly account_max_active_devices?: number;
  readonly personal_sync?: PersonalSyncSwitch;
}

export interface TierProfileLike {
  readonly is_team_member: boolean;
  readonly tier?: {
    readonly name: string;
    readonly display_name: string;
    readonly features: Readonly<Record<string, unknown>>;
  };
}

export const PERSONAL_SYNC_ON: PersonalSyncSwitch = 'on';
export const PERSONAL_SYNC_PAUSED: PersonalSyncSwitch = 'paused';

/** Signed out or no profile yet: no sync keys, so the tier cache is never overwritten with guesses. */
export const NO_PROFILE_CAPABILITIES: TierCapabilities = Object.freeze({
  cli_agents_enabled: false,
  mcp_enabled: false,
  cloud_sync_enabled: false,
  shared_vaults: false,
  tier_name: 'free',
  tier_display_name: 'Free',
  is_team_member: false,
});

function deviceLimitFeature(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && (v === -1 || v >= 1) ? v : undefined;
}

function personalSyncFeature(v: unknown): PersonalSyncSwitch {
  return v === PERSONAL_SYNC_PAUSED ? PERSONAL_SYNC_PAUSED : PERSONAL_SYNC_ON;
}

export function buildTierCapabilities(profile: TierProfileLike): TierCapabilities {
  const features = profile.tier?.features ?? {};
  // Team members are unlimited whatever their tier row says (server vault_device_limit agrees).
  const limit = profile.is_team_member ? -1 : deviceLimitFeature(features.vault_max_open_devices);
  const deviceCap = deviceLimitFeature(features.account_max_active_devices);
  return {
    cli_agents_enabled: !!features.cli_agents_enabled,
    mcp_enabled: !!features.mcp_enabled,
    cloud_sync_enabled: !!features.cloud_sync_enabled,
    shared_vaults: !!features.shared_vaults,
    tier_name: profile.tier?.name ?? 'free',
    tier_display_name: profile.tier?.display_name ?? 'Free',
    is_team_member: profile.is_team_member,
    ...(limit === undefined ? {} : { vault_max_open_devices: limit }),
    ...(deviceCap === undefined ? {} : { account_max_active_devices: deviceCap }),
    personal_sync: personalSyncFeature(features.personal_sync),
  };
}
