// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { makeTempRoot } from '../../sync/__tests__/host-fakes.js';
import { makeTestSessionHost, rpcFail, rpcOk, type ScriptedRpc, type TestSessionHost } from './session-fakes.js';
import {
  EARLY_CHECK_TIMEOUT_MS,
  FALLBACK_DEVICE_NAME,
  QUIT_RELEASE_TIMEOUT_MS,
  RPC_TIMEOUT_MS,
  SessionClient,
  classifyFailure,
  type AcquireArgs,
  type HeartbeatArgs,
} from '../session-client.js';
import { DEVICE, FILE_ID, LEASE, NONCE, OTHER, TS, TS_MS, USER, VAULT, failure, holderRow, sessionRow } from './session-client-fixtures.js';

const acquireArgs = (overrides: Partial<AcquireArgs> = {}): AcquireArgs => ({
  vaultKey: VAULT,
  deviceId: DEVICE,
  sessionNonce: NONCE,
  deviceName: 'Test Mac',
  platform: 'macos',
  appVersion: '0.18.0',
  fileName: 'Vault.conduit',
  fileId: FILE_ID,
  location: 'Dropbox',
  takeover: false,
  claim: true,
  ...overrides,
});

const heartbeatArgs = (overrides: Partial<HeartbeatArgs> = {}): HeartbeatArgs => ({
  vaultKey: VAULT,
  deviceId: DEVICE,
  leaseId: LEASE,
  active: true,
  busy: { sessions: 2, jobs: 0 },
  flags: { sideFiles: false },
  fileName: 'Vault.conduit',
  fileId: FILE_ID,
  location: 'Dropbox',
  marker: null,
  pending: false,
  ...overrides,
});

describe('classifyFailure', () => {
  it.each([
    [failure({ kind: 'network' }), 'network'],
    [failure({ kind: 'timeout' }), 'timeout'],
    [failure({ kind: 'http', status: 503 }), 'server'],
    [failure({ kind: 'http', status: 404 }), 'server'],
    [failure({ kind: 'postgres', status: 400, code: '23514' }), 'constraint'],
    [failure({ kind: 'postgres', status: 401, code: '28000' }), 'auth'],
    [failure({ kind: 'postgres', status: 400, code: '22023' }), 'sql'],
    [failure({ kind: 'postgres', status: 400, code: null }), 'sql'],
  ])('%j -> %s', (f, expected) => {
    expect(classifyFailure(f)).toBe(expected);
  });
});

describe('SessionClient', () => {
  let root: string;
  let t: TestSessionHost;
  let rpc: ScriptedRpc;
  let client: SessionClient;

  beforeEach(() => {
    root = makeTempRoot('session-client');
    t = makeTestSessionHost(root);
    t.knobs.userId = USER;
    rpc = t.rpc;
    client = new SessionClient(rpc, t.host);
  });

  afterEach(() => {
    expect(t.logger.unprefixed()).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('never calls the server when signed out', async () => {
    t.knobs.userId = null;
    const results = [
      await client.peek({ vaultKey: VAULT, deviceId: DEVICE }),
      await client.acquire(acquireArgs()),
      await client.heartbeat(heartbeatArgs()),
      await client.release({ vaultKey: VAULT, deviceId: DEVICE, leaseId: LEASE, marker: null, pending: false }),
      await client.abandon({ vaultKey: VAULT, deviceId: DEVICE, targetDeviceId: OTHER }),
    ];
    for (const r of results) expect(r).toMatchObject({ kind: 'unconfirmed', reason: 'signed-out' });
    expect(rpc.calls).toEqual([]);
  });

  describe('peek', () => {
    it('sends the SQL parameter names with the early-check timeout', async () => {
      rpc.enqueue('vault_session_peek', rpcOk({ limit: 1, holders: [holderRow()] }));
      const res = await client.peek({ vaultKey: VAULT, deviceId: DEVICE });
      expect(rpc.calls).toEqual([
        {
          fn: 'vault_session_peek',
          args: { p_vault_key: VAULT, p_device_id: DEVICE, p_platform: 'macos', p_app_version: '0.18.0' },
          timeoutMs: EARLY_CHECK_TIMEOUT_MS,
        },
      ]);
      expect(res).toMatchObject({ kind: 'ok', limit: 1, holders: [{ deviceId: OTHER, busySessions: 3, busyJobs: 1 }] });
    });

    it('accepts an unlimited plan with no holders', async () => {
      rpc.enqueue('vault_session_peek', rpcOk({ limit: -1, holders: [] }));
      expect(await client.peek({ vaultKey: VAULT, deviceId: DEVICE }, 500)).toEqual({ kind: 'ok', limit: -1, deviceCap: null, holders: [], refusal: null });
      expect(rpc.calls[0].timeoutMs).toBe(500);
    });

    it('treats a null answer (not authenticated server-side) as unconfirmed auth', async () => {
      rpc.enqueue('vault_session_peek', rpcOk(null));
      expect(await client.peek({ vaultKey: VAULT, deviceId: DEVICE })).toMatchObject({ kind: 'unconfirmed', reason: 'auth' });
    });

    it.each([
      ['limit 0', { limit: 0, holders: [] }],
      ['limit text', { limit: '1', holders: [] }],
      ['holders missing', { limit: 1 }],
      ['array answer', []],
    ])('treats %s as malformed', async (_label, data) => {
      rpc.enqueue('vault_session_peek', rpcOk(data));
      expect(await client.peek({ vaultKey: VAULT, deviceId: DEVICE })).toMatchObject({ kind: 'unconfirmed', reason: 'malformed' });
    });
  });

  describe('acquire', () => {
    it('maps every argument to its SQL parameter', async () => {
      rpc.enqueue('vault_session_acquire', rpcOk({ granted: true, lease_id: LEASE, limit: 1, sessions: [], server_now: TS }));
      await client.acquire(acquireArgs({ takeover: true }));
      expect(rpc.calls).toEqual([
        {
          fn: 'vault_session_acquire',
          timeoutMs: RPC_TIMEOUT_MS,
          args: {
            p_vault_key: VAULT,
            p_device_id: DEVICE,
            p_session_nonce: NONCE,
            p_device_name: 'Test Mac',
            p_platform: 'macos',
            p_app_version: '0.18.0',
            p_file_name: 'Vault.conduit',
            p_file_id: FILE_ID,
            p_location: 'Dropbox',
            p_takeover: true,
            p_claim: true,
          },
        },
      ]);
    });

    it('sends a fallback name when the host name is empty (the column requires 1-120 characters)', async () => {
      rpc.enqueue('vault_session_acquire', rpcOk({ granted: true, lease_id: LEASE, limit: 1, sessions: [], server_now: TS }));
      await client.acquire(acquireArgs({ deviceName: '   ' }));
      expect(rpc.calls[0].args.p_device_name).toBe(FALLBACK_DEVICE_NAME);
    });

    it('parses a grant', async () => {
      rpc.enqueue('vault_session_acquire', rpcOk({ granted: true, lease_id: LEASE, limit: 1, ttl_seconds: 90, heartbeat_seconds: 30, sessions: [sessionRow()], server_now: TS }));
      const res = await client.acquire(acquireArgs());
      expect(res).toMatchObject({ kind: 'granted', leaseId: LEASE, limit: 1, serverNowMs: TS_MS, deviceCap: null, ownership: null });
      expect(res.kind === 'granted' && res.sessions).toHaveLength(1);
    });

    it('parses a denial with holders and sessions', async () => {
      rpc.enqueue('vault_session_acquire', rpcOk({ granted: false, limit: 1, holders: [holderRow()], sessions: [sessionRow()], server_now: TS }));
      const res = await client.acquire(acquireArgs());
      expect(res).toMatchObject({ kind: 'denied', limit: 1, holders: [{ deviceId: OTHER, deviceName: "Chris's MacBook" }], serverNowMs: TS_MS });
    });

    it('treats too_many_sessions as unconfirmed, never a denial', async () => {
      rpc.enqueue('vault_session_acquire', rpcOk({ granted: false, error: 'too_many_sessions' }));
      expect(await client.acquire(acquireArgs())).toMatchObject({ kind: 'unconfirmed', reason: 'too-many-sessions' });
      expect(t.logger.messages('warn').some((m) => m.includes('too many sessions'))).toBe(true);
    });

    it.each([
      ['a denial without holders', { granted: false, limit: 1, holders: [], sessions: [], server_now: TS }],
      ['a denial whose holders are all invalid', { granted: false, limit: 1, holders: [{ device_id: 'x' }], sessions: [], server_now: TS }],
      ['a grant without lease id', { granted: true, limit: 1, sessions: [], server_now: TS }],
      ['a grant with a bad lease id', { granted: true, lease_id: 'lease', limit: 1, sessions: [], server_now: TS }],
      ['a grant with limit 0', { granted: true, lease_id: LEASE, limit: 0, sessions: [], server_now: TS }],
      ['a grant without sessions', { granted: true, lease_id: LEASE, limit: 1, server_now: TS }],
      ['a grant with a bad server_now', { granted: true, lease_id: LEASE, limit: 1, sessions: [], server_now: 'soon' }],
      ['granted as text', { granted: 'true', lease_id: LEASE, limit: 1, sessions: [] }],
      ['null', null],
    ])('treats %s as malformed', async (_label, data) => {
      rpc.enqueue('vault_session_acquire', rpcOk(data));
      expect(await client.acquire(acquireArgs())).toMatchObject({ kind: 'unconfirmed', reason: 'malformed' });
    });

    it('logs skipped rows', async () => {
      rpc.enqueue('vault_session_acquire', rpcOk({ granted: true, lease_id: LEASE, limit: -1, sessions: [sessionRow(), { junk: true }], server_now: TS }));
      const res = await client.acquire(acquireArgs());
      expect(res.kind === 'granted' && res.sessions).toHaveLength(1);
      expect(t.logger.entries.find((e) => e.message.includes('skipped invalid rows'))?.meta).toEqual({ skipped: 1 });
    });

    it.each([
      [failure({ kind: 'network' }), 'network'],
      [failure({ kind: 'timeout' }), 'timeout'],
      [failure({ kind: 'http', status: 502 }), 'server'],
      [failure({ kind: 'postgres', code: '22023' }), 'sql'],
      [failure({ kind: 'postgres', code: '28000' }), 'auth'],
    ])('maps %j to unconfirmed %s', async (f, reason) => {
      rpc.enqueue('vault_session_acquire', { ok: false, failure: f });
      expect(await client.acquire(acquireArgs())).toEqual({ kind: 'unconfirmed', reason, detail: expect.any(String) });
    });

    it('keeps SQL error text out of the detail', async () => {
      rpc.enqueue('vault_session_acquire', rpcFail({ kind: 'postgres', status: 400, code: '22023', message: 'missing id for Vault.conduit' }));
      const res = await client.acquire(acquireArgs());
      expect(res).toEqual({ kind: 'unconfirmed', reason: 'sql', detail: 'postgres 400 22023' });
    });

    it('turns a throwing caller into unconfirmed network', async () => {
      rpc.handle('vault_session_acquire', () => {
        throw new Error('boom');
      });
      expect(await client.acquire(acquireArgs())).toMatchObject({ kind: 'unconfirmed', reason: 'network' });
      expect(t.logger.messages('error')).toHaveLength(1);
    });
  });

  describe('heartbeat', () => {
    it('maps every argument, busy, flags and the marker', async () => {
      rpc.enqueue('vault_session_heartbeat', rpcOk({ status: 'ok', limit: 1, sessions: [], server_now: TS }));
      await client.heartbeat(heartbeatArgs({ flags: { sideFiles: true }, marker: { dev: 42, ms: 1000, c: 3 }, pending: true }));
      expect(rpc.calls).toEqual([
        {
          fn: 'vault_session_heartbeat',
          timeoutMs: RPC_TIMEOUT_MS,
          args: {
            p_vault_key: VAULT,
            p_device_id: DEVICE,
            p_lease_id: LEASE,
            p_active: true,
            p_busy: { sessions: 2, jobs: 0 },
            p_flags: { side_files: 'present' },
            p_file_name: 'Vault.conduit',
            p_file_id: FILE_ID,
            p_location: 'Dropbox',
            p_written_vv: { '42': [1000, 3] },
            p_pending: true,
          },
        },
      ]);
    });

    it('sends {} for no side files and null for kept values', async () => {
      rpc.enqueue('vault_session_heartbeat', rpcOk({ status: 'ok', limit: 1, sessions: [], server_now: TS }));
      rpc.enqueue('vault_session_heartbeat', rpcOk({ status: 'ok', limit: 1, sessions: [], server_now: TS }));
      await client.heartbeat(heartbeatArgs({ flags: { sideFiles: false } }));
      await client.heartbeat(heartbeatArgs({ flags: null, busy: null, fileName: null, fileId: null, location: null, pending: null }));
      expect(rpc.calls[0].args).toMatchObject({ p_flags: {}, p_written_vv: null });
      expect(rpc.calls[1].args).toMatchObject({ p_flags: null, p_busy: null, p_file_name: null, p_file_id: null, p_location: null, p_pending: null });
    });

    it('sanitizes busy counts before they reach the jsonb column', async () => {
      rpc.enqueue('vault_session_heartbeat', rpcOk({ status: 'ok', limit: 1, sessions: [], server_now: TS }));
      await client.heartbeat(heartbeatArgs({ busy: { sessions: Number.NaN, jobs: 2.7 } }));
      expect(rpc.calls[0].args.p_busy).toEqual({ sessions: 0, jobs: 2 });
    });

    it.each([
      [{ status: 'ok', limit: -1, sessions: [sessionRow()], server_now: TS }, { kind: 'ok', limit: -1, serverNowMs: TS_MS }],
      [{ status: 'displaced', reason: 'takeover', by: 'iPhone' }, { kind: 'displaced', reason: 'takeover', byDeviceName: 'iPhone', minVersion: null, released: false }],
      [{ status: 'displaced', reason: 'plan_limit', by: null }, { kind: 'displaced', reason: 'plan_limit', byDeviceName: null, minVersion: null, released: false }],
      [{ status: 'lost', reason: 'unknown' }, { kind: 'lost', reason: 'unknown' }],
      [{ status: 'lost', reason: 'superseded' }, { kind: 'lost', reason: 'superseded' }],
      [{ status: 'lost', reason: 'released' }, { kind: 'lost', reason: 'released' }],
      [{ status: 'lost', reason: 'expired' }, { kind: 'lost', reason: 'expired' }],
    ])('parses %j', async (data, expected) => {
      rpc.enqueue('vault_session_heartbeat', rpcOk(data));
      expect(await client.heartbeat(heartbeatArgs())).toMatchObject(expected);
    });

    it.each([
      ['unknown status', { status: 'weird' }],
      ['displaced with an unknown reason', { status: 'displaced', reason: 'owner_claim', by: null }],
      ['displaced with a numeric by', { status: 'displaced', reason: 'takeover', by: 7 }],
      ['lost with an unknown reason', { status: 'lost', reason: 'stolen' }],
      ['ok without sessions', { status: 'ok', limit: 1, server_now: TS }],
      ['ok with a bad limit', { status: 'ok', limit: 2.5, sessions: [], server_now: TS }],
      ['a string', 'ok'],
    ])('treats %s as malformed', async (_label, data) => {
      rpc.enqueue('vault_session_heartbeat', rpcOk(data));
      expect(await client.heartbeat(heartbeatArgs())).toMatchObject({ kind: 'unconfirmed', reason: 'malformed' });
    });

    it('treats an oversize payload (check constraint 23514) as unconfirmed, never a denial', async () => {
      rpc.enqueue('vault_session_heartbeat', rpcFail({ kind: 'postgres', status: 400, code: '23514' }));
      expect(await client.heartbeat(heartbeatArgs())).toEqual({ kind: 'unconfirmed', reason: 'constraint', detail: 'postgres 400 23514' });
    });

    it('treats 5xx as unconfirmed server', async () => {
      rpc.enqueue('vault_session_heartbeat', rpcFail({ kind: 'http', status: 503 }));
      expect(await client.heartbeat(heartbeatArgs())).toEqual({ kind: 'unconfirmed', reason: 'server', detail: 'http 503' });
      expect(t.logger.messages('warn')).toEqual(['[vault-session] vault_session_heartbeat unconfirmed']);
    });
  });

  describe('release and abandon', () => {
    it('release sends the marker and the pending flag; void answers are ok', async () => {
      rpc.enqueue('vault_session_release', rpcOk(null));
      const res = await client.release({ vaultKey: VAULT, deviceId: DEVICE, leaseId: LEASE, marker: { dev: 9, ms: 5, c: 0 }, pending: true }, QUIT_RELEASE_TIMEOUT_MS);
      expect(res).toEqual({ kind: 'ok' });
      expect(rpc.calls).toEqual([
        {
          fn: 'vault_session_release',
          timeoutMs: QUIT_RELEASE_TIMEOUT_MS,
          args: { p_vault_key: VAULT, p_device_id: DEVICE, p_lease_id: LEASE, p_written_vv: { '9': [5, 0] }, p_pending: true },
        },
      ]);
    });

    it('release defaults to the general timeout and a null marker', async () => {
      rpc.enqueue('vault_session_release', rpcOk(null));
      await client.release({ vaultKey: VAULT, deviceId: DEVICE, leaseId: LEASE, marker: null, pending: false });
      expect(rpc.calls[0]).toMatchObject({ timeoutMs: RPC_TIMEOUT_MS, args: { p_written_vv: null, p_pending: false } });
    });

    it('release failures are unconfirmed', async () => {
      rpc.enqueue('vault_session_release', rpcFail({ kind: 'timeout' }));
      expect(await client.release({ vaultKey: VAULT, deviceId: DEVICE, leaseId: LEASE, marker: null, pending: false })).toMatchObject({
        kind: 'unconfirmed',
        reason: 'timeout',
      });
    });

    it('abandon sends the target device', async () => {
      rpc.enqueue('vault_session_abandon', rpcOk(null));
      expect(await client.abandon({ vaultKey: VAULT, deviceId: DEVICE, targetDeviceId: OTHER })).toEqual({ kind: 'ok' });
      expect(rpc.calls).toEqual([
        { fn: 'vault_session_abandon', timeoutMs: RPC_TIMEOUT_MS, args: { p_vault_key: VAULT, p_device_id: DEVICE, p_target_device_id: OTHER } },
      ]);
    });

    it('abandon failures are unconfirmed', async () => {
      rpc.enqueue('vault_session_abandon', rpcFail({ kind: 'postgres', code: '28000' }));
      expect(await client.abandon({ vaultKey: VAULT, deviceId: DEVICE, targetDeviceId: OTHER })).toMatchObject({ kind: 'unconfirmed', reason: 'auth' });
    });
  });
});
