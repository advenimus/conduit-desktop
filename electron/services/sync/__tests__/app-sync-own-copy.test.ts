// @vitest-environment node
// "Make my own copy" (docs/PLAN_ENFORCEMENT.md 4.5; tests D9, D9b): the copy comes from this
// device's working copy when it exists (so an edit that never reached the shared file is in it),
// else from the shared or private file; the ticket is used up and its key zeroed; an expired
// ticket or an unreadable source is refused with plain text. W one key epoch behind S (the password
// changed on another device) falls back to S unless the unlock also had W's previous key. A failed
// copy keeps the ticket, so the next try works.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConduitVault } from '../../vault/vault.js';
import { OwnCopyTickets } from '../../vault-session/own-copy-tickets.js';
import { makeOwnCopy, OWN_COPY_EXPIRED_MESSAGE, OWN_COPY_UNREADABLE_MESSAGE, type OwnCopyDeps } from '../app-sync-own-copy.js';
import { lineagePaths } from '../paths.js';
import { vacuumInto } from '../shared-file.js';
import { SimDevice } from './core-e2e-harness.js';
import { publishFile } from './core-e2e-io.js';
import { NEW_PASSWORD, OLD_PASSWORD, createLegacyVault, type LegacyFixture } from './core-e2e-fixtures.js';
import { makeTempRoot, makeTestSyncHost, type TestSyncHost } from './host-fakes.js';

let worldRoot: string;
let legacy: LegacyFixture;
let device: SimDevice;

beforeAll(() => {
  worldRoot = makeTempRoot('own-copy-world');
  fs.mkdirSync(path.join(worldRoot, 'legacy'));
  legacy = createLegacyVault(path.join(worldRoot, 'legacy'));
  device = new SimDevice({ name: 'A', root: worldRoot, source: legacy.source, now: () => Date.now() });
}, 30_000);

afterAll(() => {
  device.close();
  fs.rmSync(worldRoot, { recursive: true, force: true });
});

function entryNames(file: string, scratch: string, password = OLD_PASSWORD): string[] {
  const probe = path.join(scratch, `probe-${path.basename(file)}`);
  fs.copyFileSync(file, probe);
  const vault = new ConduitVault(probe);
  vault.unlock(password);
  const names = vault.listEntries().map((e: { name: string }) => e.name);
  vault.lock();
  return names;
}

describe('makeOwnCopy', () => {
  let root: string;
  let t: TestSyncHost;
  let tickets: OwnCopyTickets;
  let deps: OwnCopyDeps;
  let shared: string;

  beforeEach(() => {
    root = makeTempRoot('own-copy');
    t = makeTestSyncHost(root);
    tickets = new OwnCopyTickets();
    deps = { tickets, machineDir: path.join(root, 'm-aaaaaaaa'), workDir: path.join(root, 'tmp'), host: t.host };
    fs.mkdirSync(path.join(root, 'share'));
    shared = path.join(root, 'share', 'Vault.conduit');
    publishFile(device.db, shared);
  });

  afterEach(() => {
    tickets.clear();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function working(): { kind: 'working'; lineageId: string; sharedPath: string } {
    return { kind: 'working', lineageId: legacy.source.lineageId, sharedPath: shared };
  }

  it('D9b: with a working copy, the copy holds an edit that never reached the shared file', async () => {
    device.edit((v) => v.updateEntry(legacy.ids.web, { name: 'only in W' }));
    const w = lineagePaths(deps.machineDir, legacy.source.lineageId).working;
    fs.mkdirSync(path.dirname(w), { recursive: true });
    vacuumInto(device.db, w, t.logger);
    const key = Buffer.from(legacy.source.key);
    const id = tickets.register({ source: working(), keys: [key], lineageId: legacy.source.lineageId, nowMs: t.clock.now() });
    const target = path.join(root, 'share', 'Mine.conduit');
    const made = await makeOwnCopy(id, target, deps);
    expect(made.path).toBe(target);
    expect(made.lineageId).not.toBe(legacy.source.lineageId);
    expect(entryNames(target, root)).toContain('only in W');
    expect(entryNames(shared, root)).not.toContain('only in W');
    expect(fs.readdirSync(deps.workDir).filter((n) => n.startsWith('own-copy-'))).toEqual([]);
    expect(tickets.size()).toBe(0);
  });

  it('D9: without a working copy the shared file is forked, and the key is zeroed after use', async () => {
    const key = Buffer.from(legacy.source.key);
    const id = tickets.register({ source: { kind: 'shared', path: shared }, keys: [key], lineageId: legacy.source.lineageId, nowMs: t.clock.now() });
    const held = tickets.get(id, t.clock.now())?.keys[0];
    const target = path.join(root, 'share', 'From S.conduit');
    await makeOwnCopy(id, target, deps);
    expect(entryNames(target, root).length).toBeGreaterThan(0);
    expect(held?.every((b) => b === 0)).toBe(true);
    expect(tickets.size()).toBe(0);
  });

  it('D9: a private (pre-sync) file forks too', async () => {
    const privateFile = path.join(root, 'Private.conduit');
    fs.writeFileSync(privateFile, legacy.source.bytes);
    const id = tickets.register({ source: { kind: 'shared', path: privateFile }, keys: [legacy.source.key], lineageId: legacy.source.lineageId, nowMs: t.clock.now() });
    const target = path.join(root, 'Private copy.conduit');
    await makeOwnCopy(id, target, deps);
    expect(entryNames(target, root).length).toBeGreaterThan(0);
  });

  it('refuses an unknown or expired ticket, and an unreadable source', async () => {
    await expect(makeOwnCopy('nope', path.join(root, 'x.conduit'), deps)).rejects.toThrow(OWN_COPY_EXPIRED_MESSAGE);
    const missing = path.join(root, 'missing.conduit');
    const gone = tickets.register({ source: { kind: 'shared', path: missing }, keys: [legacy.source.key], lineageId: legacy.source.lineageId, nowMs: t.clock.now() });
    await expect(makeOwnCopy(gone, path.join(root, 'y.conduit'), deps)).rejects.toThrow(OWN_COPY_UNREADABLE_MESSAGE);
    const noWNoS = { kind: 'working', lineageId: '00000000-0000-4000-8000-000000000000', sharedPath: missing } as const;
    const neither = tickets.register({ source: noWNoS, keys: [legacy.source.key], lineageId: legacy.source.lineageId, nowMs: t.clock.now() });
    await expect(makeOwnCopy(neither, path.join(root, 'z.conduit'), deps)).rejects.toThrow(OWN_COPY_UNREADABLE_MESSAGE);
    expect(fs.existsSync(path.join(root, 'y.conduit'))).toBe(false);
  });

  it('without a working copy on disk, a working ticket forks the shared file', async () => {
    const id = tickets.register({ source: working(), keys: [legacy.source.key], lineageId: legacy.source.lineageId, nowMs: t.clock.now() });
    const target = path.join(root, 'share', 'From S.conduit');
    await makeOwnCopy(id, target, deps);
    expect(entryNames(target, root).length).toBeGreaterThan(0);
  });

  it('a failed copy keeps the ticket, so the next try works', async () => {
    const id = tickets.register({ source: { kind: 'shared', path: shared }, keys: [legacy.source.key], lineageId: legacy.source.lineageId, nowMs: t.clock.now() });
    const taken = path.join(root, 'share', 'Taken.conduit');
    fs.writeFileSync(taken, 'already here');
    await expect(makeOwnCopy(id, taken, deps)).rejects.toThrow();
    expect(tickets.size()).toBe(1);
    const target = path.join(root, 'share', 'Second try.conduit');
    await makeOwnCopy(id, target, deps);
    expect(entryNames(target, root).length).toBeGreaterThan(0);
    expect(tickets.size()).toBe(0);
  });

  describe('W one key epoch behind S (the password changed on another device)', () => {
    let world: string;
    let changer: SimDevice;
    let behind: SimDevice;
    let newKey: Buffer;

    beforeEach(() => {
      world = makeTempRoot('own-copy-epoch');
      changer = new SimDevice({ name: 'A', root: world, source: legacy.source, now: () => Date.now() });
      behind = new SimDevice({ name: 'B', root: world, source: legacy.source, now: () => Date.now() });
      changer.changePassword(NEW_PASSWORD);
      changer.publish(shared);
      newKey = Buffer.from(changer.keys.current.kEpoch);
      behind.edit((v) => v.updateEntry(legacy.ids.web, { name: 'only in old W' }));
      const w = lineagePaths(deps.machineDir, legacy.source.lineageId).working;
      fs.mkdirSync(path.dirname(w), { recursive: true });
      vacuumInto(behind.db, w, t.logger);
    });

    afterEach(() => {
      changer.close();
      behind.close();
      fs.rmSync(world, { recursive: true, force: true });
    });

    it('only the new key: the copy is made from S and opens with the new password', async () => {
      const id = tickets.register({ source: working(), keys: [newKey], lineageId: legacy.source.lineageId, nowMs: t.clock.now() });
      const target = path.join(root, 'share', 'Mine.conduit');
      await makeOwnCopy(id, target, deps);
      const names = entryNames(target, root, NEW_PASSWORD);
      expect(names.length).toBeGreaterThan(0);
      expect(names).not.toContain('only in old W');
      expect(tickets.size()).toBe(0);
    });

    it("with W's previous key too: the copy is made from W and keeps its edit", async () => {
      const keys = [newKey, Buffer.from(legacy.source.key)];
      const id = tickets.register({ source: working(), keys, lineageId: legacy.source.lineageId, nowMs: t.clock.now() });
      const target = path.join(root, 'share', 'Mine.conduit');
      await makeOwnCopy(id, target, deps);
      expect(entryNames(target, root, OLD_PASSWORD)).toContain('only in old W');
    });
  });
});
