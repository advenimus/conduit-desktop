// Two simulated devices sharing one cloud-folder file, for end-to-end regression tests of the
// sync core (the SimDevice harness), plus the older-app writers those tests need.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { ConduitVault } from '../../vault/vault.js';
import { SimDevice, type SyncOutcome } from './core-e2e-harness.js';
import { createLegacyVault, type LegacyFixture } from './core-e2e-fixtures.js';

export const T_LEGACY = Date.UTC(2026, 8, 20, 8, 0, 0);
export const T_START = Date.UTC(2026, 8, 25, 9, 0, 0);
const DEFAULT_STEP_MS = 60_000;
const PUBLISH_STEP_MS = 1_000;

export interface World {
  now: number;
  readonly fixture: LegacyFixture;
  readonly root: string;
  readonly shared: string;
  readonly a: SimDevice;
  readonly b: SimDevice;
  /** Extra devices made with addDevice; closed by teardown. */
  readonly extra: SimDevice[];
  readonly legacyDir: string;
}

export function setupWorld(): World {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T_LEGACY);
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-world-legacy-'));
  const fixture = createLegacyVault(legacyDir);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-world-'));
  fs.mkdirSync(path.join(root, 'cloud'));
  const clock = { now: T_START };
  vi.setSystemTime(clock.now);
  const now = (): number => clock.now;
  const a = new SimDevice({ name: 'mac', root, source: fixture.source, now });
  clock.now += PUBLISH_STEP_MS;
  vi.setSystemTime(clock.now);
  const b = new SimDevice({ name: 'pc', root, source: fixture.source, now });
  const world: World = {
    get now() {
      return clock.now;
    },
    set now(v: number) {
      clock.now = v;
    },
    fixture,
    root,
    shared: path.join(root, 'cloud', 'Vault.conduit'),
    a,
    b,
    extra: [],
    legacyDir,
  };
  advance(world, PUBLISH_STEP_MS);
  return world;
}

export function addDevice(w: World, name: string): SimDevice {
  const dev = new SimDevice({ name, root: w.root, source: w.fixture.source, now: () => w.now });
  w.extra.push(dev);
  return dev;
}

export function advance(w: World, ms = DEFAULT_STEP_MS): void {
  w.now += ms;
  vi.setSystemTime(w.now);
}

export function exchange(w: World, from: SimDevice, to: SimDevice): SyncOutcome {
  from.publish(w.shared);
  advance(w, PUBLISH_STEP_MS);
  return to.sync(w.shared);
}

export function converge(w: World): SyncOutcome[] {
  return [exchange(w, w.a, w.b), exchange(w, w.b, w.a), exchange(w, w.a, w.b)];
}

/** An older app (desktop 0.17) opens the shared file in place and runs one mutation. */
export function olderApp(w: World, mutate: (vault: ConduitVault) => void): void {
  const older = new ConduitVault(w.shared);
  older.unlockWithKey(w.fixture.source.key);
  try {
    mutate(older);
  } finally {
    older.lock();
  }
  touch(w);
}

/** Raw SQL on the shared file, as an older app or a foreign writer would do it. */
export function rawShared(w: World, sql: string, ...params: unknown[]): void {
  const db = new Database(w.shared);
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
  touch(w);
}

function touch(w: World): void {
  const t = new Date(w.now);
  fs.utimesSync(w.shared, t, t);
}

export function teardownWorld(w: World | null): void {
  if (w === null) return;
  for (const dev of [w.a, w.b, ...w.extra]) dev.close();
  fs.rmSync(w.root, { recursive: true, force: true });
  fs.rmSync(w.legacyDir, { recursive: true, force: true });
  vi.useRealTimers();
}
