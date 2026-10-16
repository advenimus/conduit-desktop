import { describe, it, expect } from 'vitest';
import { applyUpdateChannel, getEffectiveBetaUpdates, isPrereleaseVersion } from '../update-channel.js';

describe('isPrereleaseVersion', () => {
  it.each([
    ['0.19.0-beta.1', true],
    ['0.19.0-alpha', true],
    ['1.0.0-rc.2', true],
    ['v0.19.0-beta.1', true],
    ['0.19.0-beta.1+build.7', true],
    ['0.19.0', false],
    ['v0.18.1', false],
    ['0.19.0+build.7', false],
    ['', false],
    ['beta', false],
    ['0.19-beta.1', false],
  ])('%s -> %s', (version, expected) => {
    expect(isPrereleaseVersion(version)).toBe(expected);
  });
});

describe('getEffectiveBetaUpdates', () => {
  it('follows the running version when the setting was never saved', () => {
    expect(getEffectiveBetaUpdates(undefined, '0.19.0-beta.1')).toBe(true);
    expect(getEffectiveBetaUpdates(undefined, '0.18.1')).toBe(false);
  });

  it('uses the saved choice over the running version', () => {
    expect(getEffectiveBetaUpdates(false, '0.19.0-beta.1')).toBe(false);
    expect(getEffectiveBetaUpdates(true, '0.18.1')).toBe(true);
  });

  it('treats a non-boolean stored value as never saved', () => {
    expect(getEffectiveBetaUpdates('yes' as unknown as boolean, '0.18.1')).toBe(false);
    expect(getEffectiveBetaUpdates(null as unknown as boolean, '0.19.0-beta.1')).toBe(true);
  });
});

describe('applyUpdateChannel', () => {
  it('turns prereleases on and keeps downgrades off', () => {
    const updater = { allowPrerelease: false, allowDowngrade: true };
    applyUpdateChannel(updater, true);
    expect(updater).toEqual({ allowPrerelease: true, allowDowngrade: false });
  });

  it('turns prereleases off even when the updater turned them on for a beta build', () => {
    const updater = { allowPrerelease: true, allowDowngrade: false };
    applyUpdateChannel(updater, false);
    expect(updater).toEqual({ allowPrerelease: false, allowDowngrade: false });
  });

  it('never sets a channel', () => {
    const updater: { allowPrerelease: boolean; allowDowngrade: boolean; channel?: string | null } = {
      allowPrerelease: false,
      allowDowngrade: false,
    };
    applyUpdateChannel(updater, true);
    expect('channel' in updater).toBe(false);
  });
});
