// @vitest-environment node
// sync-absorb.ts on real files (spec 4.1 dev collision, 4.4 G2, 4.8 alignEpoch): a pre-sync S
// without a baseline becomes one candidate however often it is read, a pre-sync S no key opens
// pauses as a legacy password change, a synced S under a newer epoch pauses with the device name,
// and a colliding dev starts a new incarnation with W re-stamped.
import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveEpochKeys } from '../hashing.js';
import { makeVerificationToken } from '../key-epoch.js';
import { StateBuilder } from '../state-view.js';
import { guardDevCollision, prepareIncoming, PRESYNC_CANDIDATE_LABEL, type AbsorbInput } from '../sync-absorb.js';
import type { SharedClass, SharedSnapshot } from '../shared-file.js';
import { CycleWorld, insert, toPresync, type CycleDev } from './cycle-fixtures.js';

let world: CycleWorld;

afterEach(async () => {
  expect(await world.dispose()).toEqual([]);
});

async function readS(x: CycleDev): Promise<{ readonly snapshot: SharedSnapshot; readonly cls: SharedClass }> {
  const { shared } = x.engine.parts();
  const read = await shared.read(x.sharedPath, x.replica.paths.incoming);
  if (read.kind !== 'ok') throw new Error(`read ${read.kind}`);
  return { snapshot: read.snapshot, cls: shared.classify(read.snapshot, { lineageId: x.replica.lineageId }) };
}

function input(x: CycleDev, snapshot: SharedSnapshot, cls: SharedClass): AbsorbInput {
  if (cls.kind !== 'presync' && cls.kind !== 'synced') throw new Error(`unexpected ${cls.kind}`);
  return {
    replica: x.replica,
    snapshot,
    cls,
    sideFilesPresent: false,
    serverSideFilesFlagRecent: false,
    baseline: null,
    candidates: x.engine.parts().candidates,
    host: x.d.t.host,
  };
}

describe('prepareIncoming', () => {
  it('G2 without a baseline: one candidate per distinct pre-sync file, however often it is read', async () => {
    world = new CycleWorld();
    const a = await world.solo('absorb-presync');
    toPresync(a.sharedPath);
    const { snapshot, cls } = await readS(a);
    expect(cls.kind).toBe('presync');
    const first = await prepareIncoming(input(a, snapshot, cls));
    const again = await prepareIncoming(input(a, snapshot, cls));
    expect(first.kind).toBe('queued');
    expect(again).toEqual(first);
    expect(a.engine.parts().candidates.list()).toMatchObject([{ source: 'presync-no-baseline', label: PRESYNC_CANDIDATE_LABEL, staleByNature: true }]);
  });

  it('G2 key check: a pre-sync S no known key opens is a legacy password change, never another vault', async () => {
    world = new CycleWorld();
    const a = await world.solo('absorb-legacy');
    const salt = crypto.randomBytes(32).toString('base64');
    const key = a.d.t.host.kdf.deriveKey('another password', salt);
    toPresync(a.sharedPath, { salt, verification: makeVerificationToken(deriveEpochKeys(key, a.replica.lineageId), (n) => crypto.randomBytes(n)) });
    const { snapshot, cls } = await readS(a);
    expect(await prepareIncoming(input(a, snapshot, cls))).toMatchObject({ kind: 'paused', reason: 'epoch-legacy', prompt: { kind: 'epoch-legacy' } });
    expect(a.engine.parts().candidates.list()).toEqual([]);
  });

  it('a synced S under a newer epoch pauses, naming the device that changed the password', async () => {
    world = new CycleWorld();
    const a = await world.solo('absorb-newer');
    const b = await world.join(a);
    b.replica.changePassword('pw', 'pw2', false);
    expect((await b.engine.runCycle('local-edit')).kind).toBe('published');
    const { snapshot, cls } = await readS(a);
    const res = await prepareIncoming(input(a, snapshot, cls));
    expect(res).toMatchObject({ kind: 'paused', reason: 'epoch-newer', prompt: { kind: 'epoch-newer', changedByDeviceName: 'Test Mac' } });
  });

  it('a synced S of the same epoch is absorbed for a merge', async () => {
    world = new CycleWorld();
    const a = await world.solo('absorb-merge');
    const b = await world.join(a);
    insert(b, ['from-b']);
    expect((await b.engine.runCycle('local-edit')).kind).toBe('published');
    const { snapshot, cls } = await readS(a);
    const res = await prepareIncoming(input(a, snapshot, cls));
    expect(res).toMatchObject({ kind: 'merge', relation: 'same' });
  });
});

describe('guardDevCollision (4.1)', () => {
  it('does nothing without a collision', async () => {
    world = new CycleWorld();
    const a = await world.solo('collision-none');
    expect(guardDevCollision(a.replica, a.replica.state())).toEqual({ kind: 'none' });
  });

  it('S ahead of W for the current dev starts a new incarnation and re-stamps W', async () => {
    world = new CycleWorld();
    const a = await world.solo('collision');
    insert(a, ['mine']);
    const oldDev = a.replica.dev();
    const ahead = new StateBuilder(a.replica.state());
    ahead.joinVv(oldDev, { ms: a.d.t.clock.now() + 60_000, c: 0 });
    const res = guardDevCollision(a.replica, ahead.build());
    expect(res).toMatchObject({ kind: 'restamped', oldDev });
    expect(a.replica.dev()).not.toBe(oldDev);
    expect(res.kind === 'restamped' && res.newDev).toBe(a.replica.dev());
    expect(a.replica.local().dev).toBe(a.replica.dev());
  });
});
