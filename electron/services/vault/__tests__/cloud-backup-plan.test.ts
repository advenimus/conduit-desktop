// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CLOUD_BACKUP_PLAN_MESSAGE, CLOUD_RESTORE_PLAN_MESSAGE, cloudBackupPlanAllows, requireCloudBackupPlan } from '../cloud-backup-plan.js';
import * as tier from '../backup-tier.js';

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

function profile(cloud: unknown) {
  return { profile: { tier: { features: { cloud_sync_enabled: cloud } } } };
}

function cached(cloud: boolean, atMs: number) {
  return { cached_tier_capabilities: { cloud_sync_enabled: cloud }, cached_tier_timestamp: new Date(atMs).toISOString() };
}

describe('cloud backup plan gate', () => {
  it('follows the live profile when it is loaded', () => {
    expect(cloudBackupPlanAllows(profile(true), cached(false, NOW), NOW)).toBe(true);
    expect(cloudBackupPlanAllows(profile(false), cached(true, NOW), NOW)).toBe(false);
    expect(cloudBackupPlanAllows({ profile: { tier: null } }, cached(true, NOW), NOW)).toBe(false);
  });

  it('uses the cached copy only while it is sane', () => {
    const offline = { profile: null };
    expect(cloudBackupPlanAllows(offline, cached(true, NOW - DAY), NOW)).toBe(true);
    expect(cloudBackupPlanAllows(offline, cached(true, NOW - 8 * DAY), NOW)).toBe(false);
    expect(cloudBackupPlanAllows(offline, cached(true, NOW + DAY), NOW)).toBe(false);
    expect(cloudBackupPlanAllows(offline, {}, NOW)).toBe(false);
  });

  it('throws the given message, which names both paid plans', () => {
    expect(() => requireCloudBackupPlan(profile(false), {}, CLOUD_RESTORE_PLAN_MESSAGE)).toThrow('Cloud backup restore needs the Pro or Team plan.');
    expect(() => requireCloudBackupPlan(profile(true), {}, CLOUD_RESTORE_PLAN_MESSAGE)).not.toThrow();
    expect(CLOUD_BACKUP_PLAN_MESSAGE).toBe('Cloud backup needs the Pro or Team plan.');
  });

  it('has one source for the plan messages (backup-tier)', () => {
    expect(CLOUD_BACKUP_PLAN_MESSAGE).toBe(tier.CLOUD_BACKUP_PLAN_MESSAGE);
    expect(CLOUD_RESTORE_PLAN_MESSAGE).toBe(tier.CLOUD_RESTORE_PLAN_MESSAGE);
  });
});
