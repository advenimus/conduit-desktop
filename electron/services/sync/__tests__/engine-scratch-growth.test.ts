// @vitest-environment node
// The engine's private folders stay bounded while it runs for days (5.2, 5.3, 12 fault
// injection): a torn S is quarantined once however long publishing stays paused, incoming/
// is pruned after every cycle, and tmp/ leftovers of a crash or an abandoned publish go at
// the next start.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCRATCH_MAX_AGE_MS } from '../housekeeping-files.js';
import type { ReplicaPort } from '../replica.js';
import { STAGED_KEEP } from '../shared-file.js';
import { assembleSyncEngine, nullSessionSignals, type SyncEngine } from '../sync-engine.js';
import { TBL } from '../types.js';
import { flushAsync, makeTempRoot } from './host-fakes.js';
import { bindingFor, makeDevice, newVaultSeed, open, sha256, type TestDevice } from './replica-fixtures.js';

const ISO = '2026-09-25T12:00:00.000Z';
const MIN = 60_000;

let root: string;
let sharedPath: string;
const engines: SyncEngine[] = [];
const replicas: ReplicaPort[] = [];

beforeEach(() => {
  root = makeTempRoot('engine-scratch');
  sharedPath = path.join(root, 'cloud', 'Vault.conduit');
  fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
});

afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop();
  for (const r of replicas.splice(0)) r.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function firstDevice(): Promise<{ d: TestDevice; r: ReplicaPort; e: SyncEngine; fileId: string; lineageId: string; key: Buffer }> {
  const d = makeDevice(root, { hw8: 'aaaaaaaa' });
  const nv = newVaultSeed(d);
  const binding = bindingFor(sharedPath);
  const r = (await open(d, nv.lineageId, nv.key, nv.seed, binding)).replica;
  replicas.push(r);
  const e = assembleSyncEngine({ host: d.t.host, replica: r, session: nullSessionSignals(), realpath: sharedPath });
  engines.push(e);
  expect(await e.publishInitial()).toBe(true);
  return { d, r, e, fileId: binding.fileId, lineageId: nv.lineageId, key: nv.key };
}

async function run(d: TestDevice, e: SyncEngine, ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 1000) {
    await d.t.clock.advance(1000);
    await flushAsync(5);
    await e.whenIdle();
  }
}

describe('engine scratch folders', { timeout: 30_000 }, () => {
  it('quarantines a torn S once while publishing stays paused by side files', async () => {
    const { d, r, e } = await firstDevice();
    e.start();
    await flushAsync(20);
    await e.whenIdle();
    const bytes = fs.readFileSync(sharedPath);
    fs.writeFileSync(sharedPath, bytes.subarray(0, bytes.length - 100));
    fs.writeFileSync(`${sharedPath}-wal`, Buffer.alloc(0));
    fs.writeFileSync(`${sharedPath}-shm`, Buffer.alloc(32768));
    await run(d, e, 3 * MIN);
    expect(fs.readdirSync(r.paths.quarantine)).toHaveLength(1);
    await run(d, e, 30 * MIN);
    expect(fs.readdirSync(r.paths.quarantine)).toHaveLength(1);
  });

  it('prunes incoming/ after every cycle while remote publishes keep arriving', async () => {
    const a = await firstDevice();
    const bytes = fs.readFileSync(sharedPath);
    const dB = makeDevice(root, { hw8: 'bbbbbbbb' });
    const seed = { kind: 'adopt', sharedBytes: bytes, sharedSha256: sha256(bytes), sharedMtimeMs: fs.statSync(sharedPath).mtimeMs, holdLegacy: false } as const;
    const rB = (await open(dB, a.lineageId, a.key, seed, bindingFor(sharedPath, a.fileId))).replica;
    replicas.push(rB);
    const eB = assembleSyncEngine({ host: dB.t.host, replica: rB, session: nullSessionSignals(), realpath: sharedPath });
    engines.push(eB);
    eB.start();
    await flushAsync(20);
    await eB.whenIdle();
    const wcA = a.d.t.workingCopy.last();
    for (let i = 0; i < 12; i++) {
      wcA.mutate((db) => {
        db.prepare(`INSERT INTO entries (id, name, entry_type, config, created_at, updated_at) VALUES (?, ?, 'ssh', '{}', ?, ?)`).run(`e${i}`, `S ${i}`, ISO, ISO);
      }, { rows: [{ tbl: TBL.entries, rowId: `e${i}` }], interactive: true });
      expect((await a.e.runCycle('shared-changed')).kind).toBe('published');
      await eB.runCycle('shared-changed');
    }
    const staged = fs.readdirSync(rB.paths.incoming).filter((n) => n.endsWith('.conduit'));
    expect(staged.length).toBeLessThanOrEqual(STAGED_KEEP + 3);
    expect(staged).toContain(`${rB.local().lastMergedSha256}.conduit`);
  });

  it('removes tmp/ leftovers of an earlier session at start and keeps fresh files', async () => {
    const { d, r, e } = await firstDevice();
    fs.mkdirSync(r.paths.tmp, { recursive: true });
    const old = path.join(r.paths.tmp, 'publish-abandoned.conduit');
    const fresh = path.join(r.paths.tmp, 'publish-fresh.conduit');
    fs.writeFileSync(old, 'W copy');
    fs.writeFileSync(fresh, 'W copy');
    const at = (d.t.clock.now() - 2 * SCRATCH_MAX_AGE_MS) / 1000;
    fs.utimesSync(old, at, at);
    const now = d.t.clock.now() / 1000;
    fs.utimesSync(fresh, now, now);
    e.start();
    await flushAsync(20);
    await e.whenIdle();
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});
