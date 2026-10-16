// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEV_IGNORE_OWNER_TAG_ENV, devIgnoreOwnerTag } from '../app-sync-dev-owner.js';
import { MemoryLogger } from './host-fakes.js';

const ON = { [DEV_IGNORE_OWNER_TAG_ENV]: '1' };

describe('dev owner tag bypass', () => {
  it('is off when unset, empty or 0, without a warning', () => {
    const logger = new MemoryLogger();
    for (const env of [{}, { [DEV_IGNORE_OWNER_TAG_ENV]: '' }, { [DEV_IGNORE_OWNER_TAG_ENV]: '0' }]) {
      expect(devIgnoreOwnerTag(false, env, logger)).toBe(false);
    }
    expect(logger.unprefixed()).toEqual([]);
  });

  it('is on for an unpackaged preview build, and says so loudly', () => {
    const logger = new MemoryLogger();
    expect(devIgnoreOwnerTag(false, ON, logger)).toBe(true);
    expect(devIgnoreOwnerTag(false, { ...ON, CONDUIT_ENV: 'preview' }, logger)).toBe(true);
    expect(logger.messages('warn').length > 0).toBe(true);
  });

  it('is ignored with a warning in a packaged build, whatever CONDUIT_ENV says', () => {
    for (const conduitEnv of [undefined, 'preview', 'production']) {
      const logger = new MemoryLogger();
      expect(devIgnoreOwnerTag(true, { ...ON, CONDUIT_ENV: conduitEnv }, logger)).toBe(false);
      expect(logger.messages('warn').some((m) => m.includes('packaged'))).toBe(true);
    }
  });

  it('is ignored with a warning against production', () => {
    const logger = new MemoryLogger();
    expect(devIgnoreOwnerTag(false, { ...ON, CONDUIT_ENV: 'production' }, logger)).toBe(false);
    expect(logger.messages('warn').some((m) => m.includes('production'))).toBe(true);
  });

  it('only the exact value 1 turns it on', () => {
    const logger = new MemoryLogger();
    for (const raw of ['true', 'yes', '2', '-1']) {
      expect(devIgnoreOwnerTag(false, { [DEV_IGNORE_OWNER_TAG_ENV]: raw }, logger)).toBe(false);
    }
  });
});
