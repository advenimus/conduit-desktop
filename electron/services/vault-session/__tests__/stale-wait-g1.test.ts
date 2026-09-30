// @vitest-environment node
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyLocalWrites, presenceWrite } from '../../sync/capture-local.js';
import { FakeClock, MemoryLogger, flushAsync, makeTempRoot } from '../../sync/__tests__/host-fakes.js';
import { GENESIS, dot, implicitFor, makeCtx, type TestCtx } from '../../sync/__tests__/capture-fixtures.js';
import type { PresenceEntry } from '../../sync/presence.js';
import { emptyState } from '../../sync/state-view.js';
import type { WaitingState } from '../../sync/host.js';
import type { PresenceValue, SyncState } from '../../sync/types.js';
import { G1_WAIT_MS, STALE_POLL_MS, STALE_STOP_OFFER_MS, StaleWait, signedOutHint, waitForSyncedFile, type SharedProbe } from '../stale-wait.js';
import { AbandonClient, FileLocalReplica, LINEAGE, MAC, NOW, OWN_DEVICE, PHONE, RecordingStatus, marker, row } from './stale-fixtures.js';

const DEV_MAC = 202;

function presence(patch: Partial<PresenceValue>): PresenceValue {
  return {
    platform: 'macos',
    name: 'MacBook',
    app_version: '0.18.0',
    first_seen_ms: NOW - 3_600_000,
    last_active_ms: NOW - 60_000,
    session_open: 1,
    session_since_ms: NOW - 600_000,
    account_hint: null,
    file_hint: null,
    side_files_seen_ms: null,
    ...patch,
  };
}

function entry(deviceUuid: string, patch: Partial<PresenceValue>, d: PresenceEntry['dot'] = null): PresenceEntry {
  return { deviceUuid, value: presence(patch), dot: d };
}

describe('waitForSyncedFile (4.4 G1)', () => {
  let clock: FakeClock;
  let logger: MemoryLogger;
  let shown: (WaitingState | null)[];

  beforeEach(() => {
    clock = new FakeClock(NOW);
    logger = new MemoryLogger();
    shown = [];
  });

  afterEach(() => {
    expect(clock.pending()).toBe(0);
    expect(logger.unprefixed()).toEqual([]);
  });

  async function start(
    probes: (() => SharedProbe | Promise<SharedProbe>)[],
    fallback: SharedProbe,
    cont: Promise<void> = new Promise(() => undefined),
    cancel?: Promise<void>,
  ) {
    let calls = 0;
    const probe = async (): Promise<SharedProbe> => {
      const next = probes[calls++];
      return next === undefined ? fallback : next();
    };
    const sessions = [row({ deviceId: MAC, marker: marker(DEV_MAC, NOW - 1_000), writtenAtMs: NOW - 1_000 })];
    const result = waitForSyncedFile({
      sessions,
      probe,
      host: { clock, timers: clock, logger },
      waiting: (w) => shown.push(w),
      continueRequested: cont,
      cancelRequested: cancel,
    });
    await flushAsync();
    return { result, probes: () => calls };
  }

  it('is not needed when no session carries a marker', async () => {
    let probed = false;
    const outcome = await waitForSyncedFile({
      sessions: [row({ deviceId: MAC })],
      probe: async () => {
        probed = true;
        return 'presync';
      },
      host: { clock, timers: clock, logger },
      waiting: (w) => shown.push(w),
      continueRequested: new Promise(() => undefined),
    });
    expect(outcome).toBe('not-needed');
    expect(probed).toBe(false);
    expect(shown).toEqual([]);
  });

  it('polls every 2 s until the synced file arrives', async () => {
    const run = await start([() => 'presync', () => 'missing', () => 'synced'], 'presync');
    await clock.advance(2 * STALE_POLL_MS);
    expect(await run.result).toBe('synced');
    expect(run.probes()).toBe(3);
    expect(shown[0]).toEqual({
      purpose: 'first-genesis',
      devices: [{ deviceId: MAC, deviceName: 'MacBook', savedAtMs: NOW - 1_000 }],
      blocking: true,
      stopOffered: false,
      sinceMs: NOW,
    });
    expect(shown[shown.length - 1]).toBeNull();
  });

  it('times out after 2 minutes', async () => {
    const run = await start([], 'presync');
    await clock.advance(G1_WAIT_MS);
    expect(await run.result).toBe('timeout');
    expect(run.probes()).toBe(G1_WAIT_MS / STALE_POLL_MS + 1);
    expect(shown[shown.length - 1]).toBeNull();
  });

  it('[Continue anyway] ends the wait without waiting for the next poll', async () => {
    let resolveContinue: () => void = () => undefined;
    const cont = new Promise<void>((resolve) => {
      resolveContinue = resolve;
    });
    const run = await start([], 'presync', cont);
    await clock.advance(STALE_POLL_MS + 500);
    resolveContinue();
    expect(await run.result).toBe('continued');
    expect(run.probes()).toBe(2);
    expect(shown[shown.length - 1]).toBeNull();
  });

  it('a lock during the wait cancels it at once (the open then fails, nothing is created)', async () => {
    let cancel: () => void = () => undefined;
    const cancelled = new Promise<void>((resolve) => {
      cancel = resolve;
    });
    const run = await start([], 'presync', undefined, cancelled);
    await clock.advance(STALE_POLL_MS + 500);
    cancel();
    expect(await run.result).toBe('cancelled');
    expect(run.probes()).toBe(2);
    expect(shown[shown.length - 1]).toBeNull();
  });

  it('a failing probe is logged and the wait goes on', async () => {
    const run = await start(
      [
        () => {
          throw new Error('EIO');
        },
        () => 'synced',
      ],
      'presync',
    );
    await clock.advance(STALE_POLL_MS);
    expect(await run.result).toBe('synced');
    expect(logger.messages('warn')).toContain('[vault-session] synced-file probe failed');
  });
});

describe('signedOutHint (6.11 signed out)', () => {
  it('picks the most recently active other device with session_open = 1', () => {
    const list = [
      entry(OWN_DEVICE, { last_active_ms: NOW }),
      entry(MAC, { last_active_ms: NOW - 60_000 }),
      entry(PHONE, { name: 'iPhone', last_active_ms: NOW - 10_000 }),
      entry('66666666-6666-4666-8666-666666666666', { session_open: 0, last_active_ms: NOW - 1_000 }),
    ];
    expect(signedOutHint(list, OWN_DEVICE.toUpperCase(), NOW)?.deviceUuid).toBe(PHONE);
  });

  it('null when no other device has the vault open', () => {
    expect(signedOutHint([entry(OWN_DEVICE, {}), entry(MAC, { session_open: 0 })], OWN_DEVICE, NOW)).toBeNull();
    expect(signedOutHint([], OWN_DEVICE, NOW)).toBeNull();
  });

  it('a stale session_open = 1 never prompts (6.10): activity within 15 minutes, future times ignored', () => {
    const backgrounded = entry(PHONE, { name: 'iPhone', last_active_ms: NOW - 3 * 24 * 60 * 60_000 });
    const retired = entry(MAC, { last_active_ms: NOW - 90 * 24 * 60 * 60_000 });
    const future = entry('66666666-6666-4666-8666-666666666666', { last_active_ms: NOW + 60 * 60_000 });
    expect(signedOutHint([backgrounded, retired, future], OWN_DEVICE, NOW)).toBeNull();
    expect(signedOutHint([backgrounded, entry(MAC, { last_active_ms: NOW - 14 * 60_000 })], OWN_DEVICE, NOW)?.deviceUuid).toBe(MAC);
  });
});

describe('StaleWait.beginSignedOut', () => {
  const macCtx: TestCtx = { ...makeCtx({ dev: DEV_MAC, nowMs: NOW }), deviceUuid: MAC };
  const implicit = implicitFor(macCtx);
  const base = emptyState(LINEAGE, GENESIS, 0);
  const withMacPresence = (p: Partial<PresenceValue>, ms: number): SyncState =>
    applyLocalWrites(base, [presenceWrite(presence(p), macCtx)], { kind: 'local', dot: dot(DEV_MAC, ms), interactive: true }, macCtx, implicit, {
      ruleR: false,
    }).state;

  let root: string;
  let clock: FakeClock;
  let status: RecordingStatus;
  let reads: number;
  let wait: StaleWait;

  beforeEach(() => {
    root = makeTempRoot('stale-signed-out');
    clock = new FakeClock(NOW);
    status = new RecordingStatus();
    reads = 0;
    wait = new StaleWait({
      ids: { vaultKey: LINEAGE, deviceId: OWN_DEVICE },
      client: new AbandonClient(),
      replica: new FileLocalReplica(root),
      status,
      host: { clock, timers: clock, logger: new MemoryLogger() },
      requestRead: () => {
        reads++;
      },
    });
  });

  afterEach(() => {
    wait.dispose();
    expect(clock.pending()).toBe(0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const seen = entry(MAC, { last_active_ms: NOW - 60_000 }, dot(DEV_MAC, NOW - 60_000));

  it('shows a blocking wait on that device and polls', async () => {
    wait.beginSignedOut(seen);
    expect(status.last()).toEqual({
      purpose: 'stale-file',
      devices: [{ deviceId: MAC, deviceName: 'MacBook', savedAtMs: NOW - 60_000 }],
      blocking: true,
      stopOffered: false,
      sinceMs: NOW,
    });
    await clock.advance(STALE_POLL_MS);
    expect(reads).toBe(1);
  });

  it('keeps waiting on the same presence, ends on a newer presence dot', () => {
    wait.beginSignedOut(seen);
    wait.onSharedRead(withMacPresence({ last_active_ms: NOW - 60_000 }, NOW - 60_000));
    expect(wait.active()).toBe(true);
    wait.onSharedRead(withMacPresence({ last_active_ms: NOW - 1_000 }, NOW - 1_000));
    expect(wait.active()).toBe(false);
    expect(status.last()).toBeNull();
  });

  it('ends when that device shows session_open = 0', () => {
    wait.beginSignedOut(seen);
    wait.onSharedRead(withMacPresence({ session_open: 0 }, NOW - 60_000));
    expect(wait.active()).toBe(false);
  });

  it('stops polling after two minutes and relies on the engine\'s own reads', async () => {
    wait.beginSignedOut(seen);
    await clock.advance(STALE_STOP_OFFER_MS);
    const polled = reads;
    expect(polled).toBe(STALE_STOP_OFFER_MS / STALE_POLL_MS);
    expect(status.last()).toMatchObject({ purpose: 'stale-file', blocking: true, stopOffered: true });
    await clock.advance(60 * 60_000);
    expect(reads).toBe(polled);
    expect(clock.pending()).toBe(0);
    wait.onSharedRead(withMacPresence({ session_open: 0 }, NOW - 60_000));
    expect(wait.active()).toBe(false);
  });

  it('[Use here] (openNow) and [Stop waiting] end it without any server call', async () => {
    wait.beginSignedOut(seen);
    wait.openNow();
    expect(wait.active()).toBe(false);
    wait.beginSignedOut(seen);
    await wait.stopWaiting(MAC);
    expect(wait.active()).toBe(false);
  });
});
