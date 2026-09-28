// @vitest-environment node
// The error back-off (5.6 "backoff 5 s doubling to 10 min") holds against the 60 s safety poll:
// a shared folder that refuses writes costs a publish attempt per back-off step, not per poll,
// and one publish-failed toast per failure episode. "Sync now" is an explicit request, so its
// failure is reported again; a settled cycle ends the episode.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ERROR_BACKOFF_MAX_MS, ERROR_BACKOFF_START_MS } from '../sync-engine-constants.js';
import { inErrorBackoff } from '../sync-engine-outcome.js';
import type { ReplicaPort } from '../replica.js';
import { assembleSyncEngine, nullSessionSignals, type SyncEngine } from '../sync-engine.js';
import { TBL } from '../types.js';
import { flushAsync, makeTempRoot } from './host-fakes.js';
import { bindingFor, insertEntry, makeDevice, newVaultSeed, open, type TestDevice } from './replica-fixtures.js';

const MIN = 60_000;
const RUN_MS = 30 * MIN;
const PUBLISH_TEMP = /(^|\/)\.~[^/]*\.tmp$/;

let root: string;
let sharedPath: string;
const engines: SyncEngine[] = [];
const replicas: ReplicaPort[] = [];

beforeEach(() => {
  root = makeTempRoot('engine-backoff');
  sharedPath = path.join(root, 'cloud', 'Vault.conduit');
  fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
});

afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop();
  for (const r of replicas.splice(0)) r.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function device(): Promise<{ d: TestDevice; r: ReplicaPort; e: SyncEngine }> {
  const d = makeDevice(root, { hw8: 'aaaaaaaa' });
  const nv = newVaultSeed(d);
  const r = (await open(d, nv.lineageId, nv.key, nv.seed, bindingFor(sharedPath))).replica;
  replicas.push(r);
  const e = assembleSyncEngine({ host: d.t.host, replica: r, session: nullSessionSignals(), realpath: sharedPath });
  engines.push(e);
  expect(await e.publishInitial()).toBe(true);
  e.start();
  await flushAsync(20);
  await e.whenIdle();
  return { d, r, e };
}

async function run(d: TestDevice, e: SyncEngine, ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 5_000) {
    await d.t.clock.advance(5_000);
    await flushAsync(10);
    await e.whenIdle();
  }
}

function publishFailedToasts(d: TestDevice): number {
  return d.t.events.of('sync:notice').filter((x) => !x.persisted && x.notice.kind === 'publish-failed').length;
}

function publishAttempts(d: TestDevice): number {
  return d.t.fs.calls.filter((c) => c.op === 'writeFileDurable' && PUBLISH_TEMP.test(c.path)).length;
}

/** Attempts the back-off allows in `ms` after the first failure: 5 s, 10 s, ... capped at 10 min. */
function backoffAttempts(ms: number): number {
  let n = 1;
  let at = 0;
  for (let delay = ERROR_BACKOFF_START_MS; at + delay <= ms; delay = Math.min(delay * 2, ERROR_BACKOFF_MAX_MS)) {
    at += delay;
    n += 1;
  }
  return n;
}

describe('error back-off against the safety poll', () => {
  it('a folder that refuses writes: attempts follow the back-off and one toast per episode', async () => {
    const { d, r, e } = await device();
    d.t.fs.inject({ op: 'writeFileDurable', match: PUBLISH_TEMP, code: 'EACCES', times: Infinity });
    d.t.workingCopy.last().mutate((db) => insertEntry(db, 'e1', 'Server 1'), { rows: [{ tbl: TBL.entries, rowId: 'e1' }], interactive: true });
    await run(d, e, RUN_MS);
    expect(publishFailedToasts(d)).toBe(1);
    expect(publishAttempts(d)).toBeGreaterThanOrEqual(2);
    expect(publishAttempts(d)).toBeLessThanOrEqual(backoffAttempts(RUN_MS) + 1);
    expect(r.local().pendingPublish).toBe(true);

    expect((await e.syncNow()).kind).toBe('error');
    expect(publishFailedToasts(d)).toBe(2);

    d.t.fs.clearFaults();
    expect((await e.syncNow()).kind).toBe('published');
    d.t.fs.inject({ op: 'writeFileDurable', match: PUBLISH_TEMP, code: 'EACCES', times: Infinity });
    d.t.workingCopy.last().mutate((db) => insertEntry(db, 'e2', 'Server 2'), { rows: [{ tbl: TBL.entries, rowId: 'e2' }], interactive: true });
    await run(d, e, MIN);
    expect(publishFailedToasts(d)).toBe(3);
  }, 60_000);
});

describe('inErrorBackoff', () => {
  it('only a failed cycle with its retry still scheduled holds the safety poll', () => {
    expect(inErrorBackoff({ kind: 'error', message: 'EACCES' }, 5_000)).toBe(true);
    expect(inErrorBackoff({ kind: 'backoff', untilMs: 5_000 }, 5_000)).toBe(true);
    expect(inErrorBackoff({ kind: 'error', message: 'EACCES' }, null)).toBe(false);
    expect(inErrorBackoff({ kind: 'unreadable', retryAtMs: 5_000 }, 5_000)).toBe(false);
    expect(inErrorBackoff(null, 5_000)).toBe(false);
  });
});
