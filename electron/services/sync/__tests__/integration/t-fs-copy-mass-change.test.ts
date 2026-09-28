// @vitest-environment node
// 5.8 class 3 / 5.10: a provider conflict copy carrying another device's mass delete is still
// merged automatically, but only after the same pre-merge snapshot and 'mass-change' notice a
// shared-file merge gets, so [Undo] works for it too.
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { SCENARIO_TIMEOUT_MS } from './scenario-helpers.js';
import { SyncHarness } from './sync-harness.js';

let h: SyncHarness;

afterEach(async () => {
  for (const d of h.devices) expect(d.logger.unprefixed()).toEqual([]);
  expect(await h.dispose()).toEqual([]);
});

describe('class 3 provider copy carrying a mass delete', { timeout: SCENARIO_TIMEOUT_MS }, () => {
  it('is snapshotted with a mass-change notice before the automatic merge', async () => {
    h = new SyncHarness('copy-mass');
    const a = await h.create({ name: 'mac', start: false });
    const ids = Array.from({ length: 12 }, (_, i) => `d${i}`);
    for (const id of ids) a.insert({ id });
    expect((await a.sync()).kind).toBe('published');
    h.cloud.upload('mac');
    const b = await h.join({ name: 'DESKTOP-ABC', start: false });
    b.remove(ids);
    expect((await b.sync()).kind).toBe('published');
    h.cloud.conflictCopy('mac', 'onedrive-host', fs.readFileSync(b.sharedPath), 'DESKTOP-ABC');

    const scan = await a.engine.scanCopies();
    expect(scan.copies.map((c) => c.cls)).toEqual(['safe-provider-copy']);
    expect(ids.filter((id) => a.live(id))).toEqual([]);
    const snaps = await a.engine.parts().snapshots.list();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.meta.deleted).toBe(12);
    const notice = a.replica.local().notices.find((n) => n.kind === 'mass-change');
    expect(notice).toMatchObject({ count: 12, sourceSha256: scan.copies[0]?.sha256 });
    expect(snaps[0]?.meta.noticeId).toBe(notice?.id);
  });
});
