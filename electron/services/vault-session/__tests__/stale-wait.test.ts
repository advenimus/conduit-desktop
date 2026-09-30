// @vitest-environment node
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock, MemoryLogger, makeTempRoot } from '../../sync/__tests__/host-fakes.js';
import { emptyState } from '../../sync/state-view.js';
import type { Hlc, SyncState } from '../../sync/types.js';
import {
  ABANDONED_WAITS_KEEP,
  STALE_POLL_MS,
  STALE_STOP_OFFER_MS,
  StaleWait,
  abandonedKey,
  expectedMarkers,
  uncoveredMarkers,
  type ExpectedMarker,
} from '../stale-wait.js';
import {
  AbandonClient,
  FILE_ID,
  FileLocalReplica,
  LINEAGE,
  MAC,
  NOW,
  OTHER_FILE_ID,
  OWN_DEVICE,
  PHONE,
  RecordingStatus,
  marker,
  row,
} from './stale-fixtures.js';

const GENESIS = 'ab'.repeat(32);
const DEV_MAC = 202;
const DEV_PHONE = 303;

function sharedWith(entries: readonly (readonly [number, Hlc])[]): SyncState {
  return { ...emptyState(LINEAGE, GENESIS, 0), vv: new Map(entries) };
}

const macMarker: ExpectedMarker = { deviceId: MAC, deviceName: 'MacBook', marker: marker(DEV_MAC, NOW - 120_000, 2), writtenAtMs: NOW - 120_000 };
const phoneMarker: ExpectedMarker = { deviceId: PHONE, deviceName: 'iPhone', marker: marker(DEV_PHONE, NOW - 30_000), writtenAtMs: NOW - 30_000 };

describe('markers', () => {
  it('abandonedKey is <deviceId>|<dev>:<ms>:<c> with a lowercase device id', () => {
    expect(abandonedKey({ deviceId: MAC.toUpperCase(), marker: marker(7, 1000, 3) })).toBe(`${MAC}|7:1000:3`);
  });

  it('keeps markers of the same file id that are not abandoned (6.11)', () => {
    const m = marker(DEV_MAC, NOW - 5_000);
    const sessions = [
      row({ deviceId: MAC, marker: m, writtenAtMs: NOW - 5_000, fileId: FILE_ID.toUpperCase() }),
      row({ deviceId: PHONE, marker: marker(DEV_PHONE, NOW), fileId: OTHER_FILE_ID }),
      row({ deviceId: PHONE, marker: marker(DEV_PHONE, NOW), fileId: null }),
      row({ deviceId: PHONE, marker: marker(DEV_PHONE, NOW), abandoned: true }),
      row({ deviceId: PHONE, marker: null }),
    ];
    expect(expectedMarkers(sessions, FILE_ID, [])).toEqual([{ deviceId: MAC, deviceName: 'MacBook', marker: m, writtenAtMs: NOW - 5_000 }]);
    expect(expectedMarkers(sessions, null, [])).toEqual([]);
  });

  it('skips markers in abandoned_waits until the device reports a new one', () => {
    const old = marker(DEV_MAC, NOW - 5_000);
    const abandoned = [abandonedKey({ deviceId: MAC, marker: old })];
    expect(expectedMarkers([row({ deviceId: MAC, marker: old })], FILE_ID, abandoned)).toEqual([]);
    const fresh = marker(DEV_MAC, NOW - 5_000, 1);
    expect(expectedMarkers([row({ deviceId: MAC, marker: fresh })], FILE_ID, abandoned)).toHaveLength(1);
  });

  it('uncoveredMarkers compares with S.vv (equal counts as covered)', () => {
    const covered = sharedWith([[DEV_MAC, { ms: NOW - 120_000, c: 2 }]]).vv;
    expect(uncoveredMarkers([macMarker, phoneMarker], covered)).toEqual([phoneMarker]);
    const behind = sharedWith([[DEV_MAC, { ms: NOW - 120_000, c: 1 }]]).vv;
    expect(uncoveredMarkers([macMarker], behind)).toEqual([macMarker]);
  });
});

describe('StaleWait', () => {
  let root: string;
  let clock: FakeClock;
  let logger: MemoryLogger;
  let status: RecordingStatus;
  let client: AbandonClient;
  let replica: FileLocalReplica;
  let reads: number;
  let wait: StaleWait;

  beforeEach(() => {
    root = makeTempRoot('stale-wait');
    clock = new FakeClock(NOW);
    logger = new MemoryLogger();
    status = new RecordingStatus();
    client = new AbandonClient();
    replica = new FileLocalReplica(root);
    reads = 0;
    wait = new StaleWait({
      ids: { vaultKey: LINEAGE, deviceId: OWN_DEVICE },
      client,
      replica,
      status,
      host: { clock, timers: clock, logger },
      requestRead: () => {
        reads++;
      },
    });
  });

  afterEach(() => {
    wait.dispose();
    expect(clock.pending()).toBe(0);
    expect(logger.unprefixed()).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does nothing without uncovered markers', () => {
    expect(wait.begin([], 'dialog')).toBe(false);
    expect(wait.active()).toBe(false);
    expect(status.calls).toEqual([]);
  });

  it('Free: a blocking dialog that polls every 2 s and continues on its own when covered (12 row 26)', async () => {
    expect(wait.begin([macMarker, phoneMarker], 'dialog')).toBe(true);
    expect(status.last()).toEqual({
      purpose: 'stale-file',
      devices: [
        { deviceId: MAC, deviceName: 'MacBook', savedAtMs: NOW - 120_000 },
        { deviceId: PHONE, deviceName: 'iPhone', savedAtMs: NOW - 30_000 },
      ],
      blocking: true,
      stopOffered: false,
      sinceMs: NOW,
    });
    await clock.advance(3 * STALE_POLL_MS);
    expect(reads).toBe(3);
    wait.onSharedRead(sharedWith([[DEV_MAC, { ms: NOW, c: 0 }]]));
    expect(status.last()?.devices.map((d) => d.deviceId)).toEqual([PHONE]);
    expect(wait.active()).toBe(true);
    wait.onSharedRead(sharedWith([[DEV_MAC, { ms: NOW, c: 0 }], [DEV_PHONE, { ms: NOW, c: 0 }]]));
    expect(wait.active()).toBe(false);
    expect(status.last()).toBeNull();
    expect(clock.pending()).toBe(0);
  });

  it('Pro: the same wait as a non-blocking banner', () => {
    wait.begin([macMarker], 'banner');
    expect(status.last()?.blocking).toBe(false);
  });

  it('an S read that covers nothing new changes nothing', () => {
    wait.begin([macMarker], 'dialog');
    const before = status.calls.length;
    wait.onSharedRead(sharedWith([]));
    expect(status.calls.length).toBe(before);
  });

  it('offers [Stop waiting] after 2 minutes and records the markers in abandoned_waits', async () => {
    wait.begin([macMarker, phoneMarker], 'dialog');
    await clock.advance(STALE_STOP_OFFER_MS - 1);
    expect(status.last()?.stopOffered).toBe(false);
    await clock.advance(1);
    expect(status.last()?.stopOffered).toBe(true);
    const keys = [abandonedKey(macMarker), abandonedKey(phoneMarker)];
    expect(replica.onDisk().abandonedWaits).toEqual(keys);
    const later = [row({ deviceId: MAC, marker: macMarker.marker }), row({ deviceId: PHONE, marker: phoneMarker.marker })];
    expect(expectedMarkers(later, FILE_ID, replica.local().abandonedWaits)).toEqual([]);
    expect(wait.active()).toBe(true);
    expect(reads).toBe(STALE_STOP_OFFER_MS / STALE_POLL_MS);
    await clock.advance(10 * STALE_POLL_MS);
    expect(reads).toBe(STALE_STOP_OFFER_MS / STALE_POLL_MS);
    wait.onSharedRead(sharedWith([[DEV_MAC, { ms: NOW, c: 0 }], [DEV_PHONE, { ms: NOW, c: 0 }]]));
    expect(wait.active()).toBe(false);
  });

  it('abandoned_waits keeps the newest 50 entries without duplicates', async () => {
    const old = Array.from({ length: 60 }, (_, i) => `${PHONE}|9:${i}:0`);
    replica = new FileLocalReplica(root, { abandonedWaits: [...old, abandonedKey(macMarker)] });
    wait = new StaleWait({
      ids: { vaultKey: LINEAGE, deviceId: OWN_DEVICE },
      client,
      replica,
      status,
      host: { clock, timers: clock, logger },
      requestRead: () => undefined,
    });
    wait.begin([macMarker, phoneMarker], 'dialog');
    await clock.advance(STALE_STOP_OFFER_MS);
    const stored = replica.onDisk().abandonedWaits;
    expect(stored).toHaveLength(ABANDONED_WAITS_KEEP);
    expect(stored.slice(-2)).toEqual([abandonedKey(macMarker), abandonedKey(phoneMarker)]);
    expect(new Set(stored).size).toBe(stored.length);
  });

  it('[Stop waiting for iPhone] calls vault_session_abandon and drops that device (12 row 67)', async () => {
    wait.begin([macMarker, phoneMarker], 'dialog');
    await clock.advance(STALE_STOP_OFFER_MS);
    await wait.stopWaiting(PHONE.toUpperCase());
    expect(client.calls).toEqual([{ vaultKey: LINEAGE, deviceId: OWN_DEVICE, targetDeviceId: PHONE.toUpperCase() }]);
    expect(status.last()?.devices.map((d) => d.deviceId)).toEqual([MAC]);
    await wait.stopWaiting(MAC);
    expect(wait.active()).toBe(false);
    expect(status.last()).toBeNull();
  });

  it('an unconfirmed abandon is logged, not fatal', async () => {
    client.answer = { kind: 'unconfirmed', reason: 'network', detail: 'offline' };
    wait.begin([phoneMarker], 'dialog');
    await wait.stopWaiting(PHONE);
    expect(wait.active()).toBe(false);
    expect(logger.messages('warn')).toContain('[vault-session] abandon not confirmed');
  });

  it('[Open now] ends the wait at once and dispose clears everything', () => {
    wait.begin([macMarker], 'dialog');
    wait.openNow();
    expect(wait.active()).toBe(false);
    expect(status.last()).toBeNull();
    wait.begin([macMarker], 'banner');
    wait.dispose();
    expect(wait.active()).toBe(false);
    expect(clock.pending()).toBe(0);
  });

  it('a failing read request is logged and polling continues', async () => {
    let calls = 0;
    wait = new StaleWait({
      ids: { vaultKey: LINEAGE, deviceId: OWN_DEVICE },
      client,
      replica,
      status,
      host: { clock, timers: clock, logger },
      requestRead: () => {
        calls++;
        throw new Error('engine stopped');
      },
    });
    wait.begin([macMarker], 'dialog');
    await clock.advance(2 * STALE_POLL_MS);
    expect(calls).toBe(2);
    expect(logger.messages('error')).toContain('[vault-session] stale wait read request failed');
  });
});
