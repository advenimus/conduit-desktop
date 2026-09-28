// @vitest-environment node
// 5.9 / 3.1: S goes missing and the only same-salt file in the folder is the user's pre-sync
// backup. It is offered in the prompt, never rebound to automatically, and never published over.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLegacyVault } from '../core-e2e-fixtures.js';
import { withSimDate } from './legacy-desktop.js';
import { SCENARIO_TIMEOUT_MS } from './scenario-helpers.js';
import { SyncHarness } from './sync-harness.js';

const SEC = 1000;

let h: SyncHarness;

afterEach(async () => {
  for (const d of h.devices) expect(d.logger.unprefixed()).toEqual([]);
  expect(await h.dispose()).toEqual([]);
});

function sha(p: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

describe('missing S next to a pre-sync backup', { timeout: SCENARIO_TIMEOUT_MS }, () => {
  it('prompts instead of rebinding, and leaves the backup untouched', async () => {
    h = new SyncHarness('rebind-presync');
    const fx = withSimDate(h.clock.now(), () => createLegacyVault(h.cloud.mirror('seed')));
    h.cloud.touch(h.cloud.sharedPath('seed'));
    h.cloud.upload('seed');
    h.cloud.download('mac');
    const dir = h.cloud.mirror('mac');
    const S = h.cloud.sharedPath('mac');
    const backup = path.join(dir, 'Vault backup.conduit');
    fs.copyFileSync(S, backup);
    const backupSha = sha(backup);
    const a = await h.genesis({ name: 'mac', start: true }, fx.source.key, { download: false });
    expect(h.classify(S).kind).toBe('synced');

    fs.mkdirSync(path.join(dir, 'Archive'));
    fs.renameSync(S, path.join(dir, 'Archive', 'Vault.conduit'));
    await h.advance(45 * SEC);

    expect(path.basename(a.engine.parts().binding.sharedPath())).toBe('Vault.conduit');
    expect(sha(backup)).toBe(backupSha);
    expect(h.classify(backup).kind).toBe('presync');
    expect(a.status().prompts.some((p) => p.kind === 'file-missing')).toBe(true);
  });
});
