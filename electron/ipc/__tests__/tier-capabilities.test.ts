// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildTierCapabilities, NO_PROFILE_CAPABILITIES } from '../tier-capabilities.js';

function profile(features: Record<string, unknown>) {
  return { is_team_member: false, tier: { name: 'pro', display_name: 'Pro', features } };
}

describe('tier capabilities', () => {
  it('adds the device limit only when the tier defines a valid one', () => {
    expect(buildTierCapabilities(profile({ vault_max_open_devices: -1 })).vault_max_open_devices).toBe(-1);
    expect(buildTierCapabilities(profile({ vault_max_open_devices: 1 })).vault_max_open_devices).toBe(1);
    expect('vault_max_open_devices' in buildTierCapabilities(profile({}))).toBe(false);
    expect('vault_max_open_devices' in buildTierCapabilities(profile({ vault_max_open_devices: 0 }))).toBe(false);
    expect('vault_max_open_devices' in buildTierCapabilities(profile({ vault_max_open_devices: '2' }))).toBe(false);
  });

  it('caches unlimited devices for a team member on a Free tier row (spec 6.8, like the server)', () => {
    const free = { is_team_member: true, tier: { name: 'free', display_name: 'Free', features: { vault_max_open_devices: 1 } } };
    expect(buildTierCapabilities(free).vault_max_open_devices).toBe(-1);
  });

  it('reports the personal sync switch, on unless paused', () => {
    expect(buildTierCapabilities(profile({})).personal_sync).toBe('on');
    expect(buildTierCapabilities(profile({ personal_sync: 'paused' })).personal_sync).toBe('paused');
    expect(buildTierCapabilities(profile({ personal_sync: 'anything' })).personal_sync).toBe('on');
  });

  it('keeps the existing flags', () => {
    const caps = buildTierCapabilities(profile({ cloud_sync_enabled: true, mcp_enabled: true }));
    expect(caps).toMatchObject({ cloud_sync_enabled: true, mcp_enabled: true, cli_agents_enabled: false, tier_name: 'pro' });
  });

  it('adds no sync keys without a profile', () => {
    expect('vault_max_open_devices' in NO_PROFILE_CAPABILITIES).toBe(false);
    expect('personal_sync' in NO_PROFILE_CAPABILITIES).toBe(false);
  });
});
