// @vitest-environment node
// The stale-file wait an open starts (6.11, 12 rows 8/26): Free gets a blocking dialog, Pro a
// banner. Runs the real PersonalVaultRuntime and LeaseTracker behind openPersonalVault.
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WaitingState } from '../../sync/host.js';
import { REAL_COLLABORATORS } from '../open-deps.js';
import { openPersonalVault } from '../open-personal-vault.js';
import { FakeEngine, openInput, sessionRow, type OpenHarness } from './open-harness.js';
import { S_E1, sharedScenario } from './open-scenario.js';

let root: string;
let h: OpenHarness;
let vaultPath: string;
let waits: (WaitingState | null)[];

beforeEach(() => {
  ({ root, h, vaultPath } = sharedScenario('open-runtime'));
  waits = [];
  const fake = h.deps.collaborators ?? {};
  Object.assign(h, {
    deps: { ...h.deps, collaborators: { ...fake, createRuntime: REAL_COLLABORATORS.createRuntime, createLease: REAL_COLLABORATORS.createLease } },
  });
  h.engineFactory = () => {
    const e = new FakeEngine();
    e.sharedState = S_E1;
    e.onStatus = (name, args) => {
      if (name === 'setWaiting') waits.push(args[0] as WaitingState | null);
    };
    return e;
  };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('stale-file wait started by the open (real runtime)', () => {
  for (const [plan, limit, blocking] of [['Free', 1, true], ['Pro', -1, false]] as const) {
    it(`${plan}: an uncovered marker of the same file starts a ${blocking ? 'dialog' : 'banner'}`, async () => {
      const row = sessionRow({ fileId: 'file-1', marker: { dev: 9, ms: 700, c: 0 }, writtenAtMs: 700 });
      h.client.acquireResult = { kind: 'granted', leaseId: 'l', limit, sessions: [row], serverNowMs: null, deviceCap: null, ownership: null };
      const opened = await openPersonalVault(openInput(vaultPath), h.deps);
      expect(opened.shared).toBe(true);
      const started = waits.find((w) => w !== null);
      expect(started).toMatchObject({ purpose: 'stale-file', blocking, stopOffered: false });
      expect(started?.devices.map((d) => d.deviceName)).toEqual(['MacBook']);
    });
  }
});
