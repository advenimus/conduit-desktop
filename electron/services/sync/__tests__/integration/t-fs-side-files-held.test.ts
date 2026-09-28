// @vitest-environment node
// 5.5 / 2.1: a side file another program still holds (EPERM/EBUSY on the move) is never
// recorded as confirmed. Publishing stays paused, and the engine retries the move on later
// polls; the new S is published only once both side files are gone.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SyncHarness } from './sync-harness.js';
import { LegacyDesktop } from './legacy-desktop.js';
import { SCENARIO_TIMEOUT_MS } from './scenario-helpers.js';

const SEC = 1000;

let h: SyncHarness;

afterEach(async () => {
  for (const d of h.devices) expect(d.logger.unprefixed()).toEqual([]);
  expect(await h.dispose()).toEqual([]);
});

function sideFilesIn(dir: string): string[] {
  return fs.readdirSync(dir).filter((n) => n.endsWith('-wal') || n.endsWith('-shm'));
}

describe('side files held open at confirmation', { timeout: SCENARIO_TIMEOUT_MS }, () => {
  it('stays paused while the move is refused, retries on later polls, then publishes', async () => {
    h = new SyncHarness('held-open');
    const a = await h.create({ name: 'mac', start: true });
    a.insert({ id: 'e1' });
    await h.advance(3 * SEC);
    await a.lock();
    new LegacyDesktop(a.sharedPath, h.requireVault().key, () => h.clock.now()).crashWithWal(() => undefined);
    await a.relaunch();
    a.insert({ id: 'after-upgrade' });
    await h.advance(3 * SEC);
    expect(a.status().pauseReason).toBe('side-files');

    a.fs.inject({ op: 'rename', match: /-shm$/, code: 'EBUSY', times: 3 });
    const res = await a.engine.confirmSideFiles(a.engine.parts().sideFiles.view().tuples, false);
    expect(res).toEqual({ kind: 'held-open', code: 'EBUSY' });
    expect(a.engine.parts().sideFiles.view()).toMatchObject({ state: 'present', publishAllowed: false });
    expect(a.replica.local().sideFiles).toBeNull();
    await h.advance(3 * SEC);
    expect(h.peek(a.sharedPath).content.entries.has('after-upgrade')).toBe(false);

    await h.advance(12 * SEC);
    expect(sideFilesIn(path.dirname(a.sharedPath))).toEqual([]);
    expect(h.peek(a.sharedPath).content.entries.has('after-upgrade')).toBe(true);
    const folders = fs.readdirSync(a.replica.paths.dir).filter((n) => n.startsWith('sidefiles-'));
    const moved = folders.flatMap((f) => fs.readdirSync(path.join(a.replica.paths.dir, f)));
    expect(moved.sort()).toEqual(['Vault.conduit-shm', 'Vault.conduit-wal']);
  });
});
