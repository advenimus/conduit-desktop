// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { markerFromJson, markerToJson, parseHolders, parseSessions } from '../session-client.js';
import { DEVICE, FILE_ID, HB_TS_MS, OTHER, TS_MS, holderRow, sessionRow } from './session-client-fixtures.js';

describe('markers', () => {
  it('encodes one entry and round-trips', () => {
    const marker = { dev: 281_474_976_710_655, ms: 1_790_000_000_000, c: 65535 };
    const json = markerToJson(marker);
    expect(json).toEqual({ '281474976710655': [1_790_000_000_000, 65535] });
    expect(markerFromJson(JSON.parse(JSON.stringify(json)))).toEqual(marker);
  });

  it.each([
    ['empty object', {}],
    ['null', null],
    ['array', [[1, 2]]],
    ['two entries', { '1': [1, 0], '2': [1, 0] }],
    ['dev 0', { '0': [1, 0] }],
    ['leading zero', { '01': [1, 0] }],
    ['dev beyond 48 bits', { '281474976710656': [1, 0] }],
    ['negative ms', { '5': [-1, 0] }],
    ['fractional ms', { '5': [1.5, 0] }],
    ['counter too large', { '5': [1, 65536] }],
    ['pair of three', { '5': [1, 0, 0] }],
    ['not a pair', { '5': 7 }],
    ['string numbers', { '5': ['1', '0'] }],
  ])('rejects %s', (_label, raw) => {
    expect(markerFromJson(raw)).toBeNull();
  });
});

describe('parseSessions / parseHolders', () => {
  it('parses a full vault_sessions_for row', () => {
    expect(parseSessions([sessionRow()])).toEqual([
      {
        deviceId: OTHER,
        deviceName: "Chris's MacBook",
        platform: 'macos',
        fileName: 'Vault.conduit',
        fileId: FILE_ID,
        location: 'Dropbox',
        status: 'active',
        lastActiveMs: TS_MS,
        heartbeatAtMs: HB_TS_MS,
        busySessions: 3,
        busyJobs: 1,
        sideFilesFlag: true,
        marker: { dev: 12345, ms: 1_790_000_000_000, c: 2 },
        writtenAtMs: TS_MS,
        pendingChanges: false,
        abandoned: false,
      },
    ]);
  });

  it('reads no heartbeat time from a server older than 20260927234038 (the flag falls back to last activity)', () => {
    const [row] = parseSessions([sessionRow({ heartbeat_at: undefined })]);
    expect(row).toMatchObject({ lastActiveMs: TS_MS, heartbeatAtMs: null });
  });

  it('parses every server status', () => {
    const statuses = ['active', 'released', 'expired', 'displaced'];
    expect(parseSessions(statuses.map((status) => sessionRow({ status }))).map((r) => r.status)).toEqual(statuses);
  });

  it('defaults nullable and client-written fields', () => {
    const [row] = parseSessions([
      sessionRow({ file_name: null, file_id: null, location: null, busy: { sessions: 'x', jobs: -2 }, flags: {}, written_vv: {}, written_at: null }),
    ]);
    expect(row).toMatchObject({ fileName: null, fileId: null, location: null, busySessions: 0, busyJobs: 0, sideFilesFlag: false, marker: null, writtenAtMs: null });
  });

  it.each([
    ['bad device id', { device_id: 'not-a-uuid' }],
    ['empty device name', { device_name: '' }],
    ['unknown status', { status: 'zombie' }],
    ['bad timestamp', { last_active_at: '2026' }],
    ['bad written_at', { written_at: 'yesterday' }],
    ['bad heartbeat_at', { heartbeat_at: 42 }],
    ['bad file id', { file_id: 'abc' }],
    ['file name not text', { file_name: 7 }],
    ['pending not boolean', { pending_changes: 'no' }],
    ['abandoned missing', { abandoned: undefined }],
  ])('skips a row with %s', (_label, overrides) => {
    expect(parseSessions([sessionRow(overrides), sessionRow({ device_id: DEVICE })])).toHaveLength(1);
  });

  it('returns nothing for a non-array', () => {
    expect(parseSessions({})).toEqual([]);
    expect(parseHolders(null)).toEqual([]);
  });

  it('parses holders and lower-cases ids', () => {
    expect(parseHolders([holderRow({ device_id: OTHER.toUpperCase() }), 'junk'])).toEqual([
      {
        deviceId: OTHER,
        deviceName: "Chris's MacBook",
        platform: 'macos',
        fileName: 'Vault.conduit',
        fileId: FILE_ID,
        location: 'Dropbox',
        lastActiveMs: TS_MS,
        busySessions: 3,
        busyJobs: 1,
      },
    ]);
  });
});
