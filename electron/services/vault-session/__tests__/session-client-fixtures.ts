// Ids, timestamps and server-shaped rows shared by the session-client, heartbeat and realtime
// tests (shapes of vault_sessions_for / vault_session_holders in the 9.4 SQL).
import type { RpcFailure } from '../host.js';

export const USER = '11111111-1111-4111-8111-111111111111';
export const VAULT = '22222222-2222-4222-8222-222222222222';
export const DEVICE = '33333333-3333-4333-8333-333333333333';
export const OTHER = '44444444-4444-4444-8444-444444444444';
export const LEASE = '55555555-5555-4555-8555-555555555555';
export const LEASE_2 = '55555555-5555-4555-8555-555555555552';
export const NONCE = '66666666-6666-4666-8666-666666666666';
export const FILE_ID = '77777777-7777-4777-8777-777777777777';
export const TS = '2026-09-25T12:00:00.123456+00:00';
export const TS_MS = Date.parse(TS);
/** A later heartbeat of the same row (heartbeat_at moves on every beat, last_active_at only when active). */
export const HB_TS = '2026-09-25T12:00:30.500000+00:00';
export const HB_TS_MS = Date.parse(HB_TS);

export const failure = (f: Partial<RpcFailure> & Pick<RpcFailure, 'kind'>): RpcFailure => ({ status: null, code: null, message: f.kind, ...f });

export function holderRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    device_id: OTHER,
    device_name: "Chris's MacBook",
    platform: 'macos',
    file_name: 'Vault.conduit',
    file_id: FILE_ID,
    location: 'Dropbox',
    last_active_at: TS,
    busy: { sessions: 3, jobs: 1 },
    ...overrides,
  };
}

export function sessionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...holderRow(),
    status: 'active',
    heartbeat_at: HB_TS,
    flags: { side_files: 'present' },
    written_vv: { '12345': [1_790_000_000_000, 2] },
    written_at: TS,
    pending_changes: false,
    abandoned: false,
    ...overrides,
  };
}
