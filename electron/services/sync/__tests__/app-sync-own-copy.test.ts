// @vitest-environment node
// "Make my own copy" (docs/PLAN_ENFORCEMENT.md 4.5; tests D9, D9b): the copy comes from this
// device's working copy when it exists (so an edit that never reached the shared file is in it),
// else from the shared or private file; the ticket is used up and its key zeroed; an expired
// ticket or an unreadable source is refused with plain text.
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
import { OLD_PASSWORD, createLegacyVault, type LegacyFixture } from './core-e2e-fixtures.js';
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

function entryNames(file: string, scratch: string): string[] {
  const probe = path.join(scratch, `probe-${path.basename(file)}`);
  fs.copyFileSync(file, probe);
  const vault = new ConduitVault(probe);
  vault.unlock(OLD_PASSWORD);
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
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('D9b: with a working copy, the copy holds an edit that never reached the shared file', async () => {
    device.edit((v) => v.updateEntry(legacy.ids.web, { name: 'only in W' }));
    const w = lineagePaths(deps.machineDir, legacy.source.lineageId).working;
    fs.mkdirSync(path.dirname(w), { recursive: true });
    vacuumInto(device.db, w, t.logger);
    const key = Buffer.from(legacy.source.key);
    const id = tickets.register({ source: { kind: 'working', lineageId: legacy.source.lineageId }, key, lineageId: legacy.source.lineageId, nowMs: t.clock.now() });
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
    const id = tickets.register({ source: { kind: 'shared', path: shared }, key, lineageId: legacy.source.lineageId, nowMs: t.clock.now() });
    const taken: Buffer[] = [];
    const original = tickets.take.bind(tickets);
    tickets.take = (ticketId, nowMs) => {
      const got = original(ticketId, nowMs);
      if (got !== null) taken.push(got.key);
      return got;
    };
    const target = path.join(root, 'share', 'From S.conduit');
    await makeOwnCopy(id, target, deps);
    expect(entryNames(target, root).length).toBeGreaterThan(0);
    expect(taken[0]?.every((b) => b === 0)).toBe(true);
  });

  it('D9: a private (pre-sync) file forks too', async () => {
    const privateFile = path.join(root, 'Private.conduit');
    fs.writeFileSync(privateFile, legacy.source.bytes);
    const id = tickets.register({ source: { kind: 'shared', path: privateFile }, key: legacy.source.key, lineageId: legacy.source.lineageId, nowMs: t.clock.now() });
    const target = path.join(root, 'Private copy.conduit');
    await makeOwnCopy(id, target, deps);
    expect(entryNames(target, root).length).toBeGreaterThan(0);
  });

  it('refuses an unknown or expired ticket, and an unreadable source', async () => {
    await expect(makeOwnCopy('nope', path.join(root, 'x.conduit'), deps)).rejects.toThrow(OWN_COPY_EXPIRED_MESSAGE);
    const gone = tickets.register({ source: { kind: 'shared', path: path.join(root, 'missing.conduit') }, key: legacy.source.key, lineageId: legacy.source.lineageId, nowMs: t.clock.now() });
    await expect(makeOwnCopy(gone, path.join(root, 'y.conduit'), deps)).rejects.toThrow(OWN_COPY_UNREADABLE_MESSAGE);
    const noW = tickets.register({ source: { kind: 'working', lineageId: '00000000-0000-4000-8000-000000000000' }, key: legacy.source.key, lineageId: legacy.source.lineageId, nowMs: t.clock.now() });
    await expect(makeOwnCopy(noW, path.join(root, 'z.conduit'), deps)).rejects.toThrow(OWN_COPY_UNREADABLE_MESSAGE);
    expect(fs.existsSync(path.join(root, 'y.conduit'))).toBe(false);
  });
});
