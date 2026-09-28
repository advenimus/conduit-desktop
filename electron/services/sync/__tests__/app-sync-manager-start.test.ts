// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { AppSyncManager } from '../app-sync-manager.js';

interface StartProbe {
  started: unknown;
  start: () => void;
  requireStarted: () => unknown;
}

describe('AppSyncManager start', () => {
  it('retries a start that failed at launch instead of refusing every unlock until a restart', () => {
    const m = Object.create(AppSyncManager.prototype) as unknown as StartProbe;
    const started = { lookup: {} };
    let attempts = 0;
    m.started = null;
    m.start = () => {
      attempts += 1;
      if (attempts === 1) throw new Error('ENOSPC: no space left on device');
      m.started = started;
    };
    expect(() => m.requireStarted()).toThrow('ENOSPC');
    expect(m.requireStarted()).toBe(started);
    expect(attempts).toBe(2);
  });
});
