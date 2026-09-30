// A hand-built state that covers every storage case of spec 3.3: implicit and explicit
// registers, derived and explicit pmem, carriers (mat, dead-redacted, hidden history, _sync,
// vault_meta), grave row_json, redacted and undecryptable siblings, epochs and wraps.
import { META_ROW_ID, SYNC_ROW, rowKey } from '../catalog.js';
import { SIB_REDACTED, SIB_UNDECRYPTABLE, TBL, ZERO_PID, ZERO_VHASH, type RowKey, type SyncState } from '../types.js';
import { app, bytes, derived, hex, materializeRows, newState, pseudo, setRow, type Materialized } from './state-store-fixtures.js';

export const E0 = hex('epoch-0');
export const E1 = hex('epoch-1');

export const LIVE_ROWS: readonly RowKey[] = [
  rowKey(TBL.folders, 'f1'),
  rowKey(TBL.folders, 'f2'),
  rowKey(TBL.entries, 'c1'),
  rowKey(TBL.entries, 'e1'),
  rowKey(TBL.entries, 'e2'),
  rowKey(TBL.history, 'h2'),
  rowKey(TBL.meta, META_ROW_ID),
];

const e1Name = pseudo(0, 'e1name', 'web box', { lt: 400 });
const e1Type = pseudo(0, 'e1type', 'ssh');
const e1User = pseudo(5000, 'e1user', 'root', { lt: 5000 });
const undecPw = pseudo(0, 'undec', bytes('old-ct'), { flags: SIB_UNDECRYPTABLE });
const epochSib = pseudo(0, 'epoch', E0);

function contentRows(b: ReturnType<typeof newState>): void {
  setRow(b, {
    tbl: TBL.folders,
    id: 'f1',
    regs: { _life: { sibs: [app(1, 1000, 'live')] }, name: { sibs: [app(1, 1000, 'Servers')] }, icon: { sibs: [app(2, 1500, 'server')] } },
  });
  setRow(b, { tbl: TBL.folders, id: 'f2', regs: {} });
  setRow(b, {
    tbl: TBL.entries,
    id: 'c1',
    regs: {
      _life: { sibs: [app(1, 1000, 'live')] },
      name: { sibs: [pseudo(0, 'c1name', 'Cred', { lt: 500 })] },
      entry_type: { sibs: [pseudo(0, 'c1type', 'credential')] },
      password: { sibs: [app(1, 1000, bytes('c1-pw'), { prev: hex('p', 16) })] },
    },
  });
  setRow(b, {
    tbl: TBL.entries,
    id: 'e1',
    regs: {
      _life: { sibs: [app(1, 1100, 'live')] },
      name: { sibs: [e1Name], pmem: derived(e1Name) },
      entry_type: { sibs: [e1Type] },
      container: { sibs: [app(1, 1100, 'f:f1')] },
      host: { sibs: [app(1, 1200, 'a.example'), app(2, 1300, 'b.example', { prev: hex('h', 16) })], pmem: { ms: 0, ids: [ZERO_PID] } },
      port: { sibs: [app(1, 1100, 22)] },
      username: { sibs: [e1User], pmem: { ms: 5000, ids: [e1User.pid, hex('pid:other')].sort() } },
      credential_id: { sibs: [app(1, 1100, 'c1')] },
      password: { sibs: [app(2, 1300, bytes('e1-pw')), undecPw], pmem: derived(undecPw) },
      'config.theme': { sibs: [app(1, 1100, '"dark"')] },
      'config.opts': { sibs: [app(1, 1100, '{"a":1,"b":[true,null]}')] },
      'tag:prod': { sibs: [app(1, 1100, 1)] },
      'tag:old': { sibs: [app(1, 1150, null)] },
      notes: { sibs: [app(1, 1100, '')] },
      is_favorite: { sibs: [app(1, 1100, 1)] },
      created_at: { sibs: [pseudo(0, 'e1created', '2025-01-02 03:04:05')] },
    },
  });
  setRow(b, {
    tbl: TBL.entries,
    id: 'e2',
    regs: {
      _life: { sibs: [app(1, 1100, 'live')] },
      name: { sibs: [app(1, 1100, 'dangling')] },
      entry_type: { sibs: [app(1, 1100, 'web')] },
      container: { sibs: [app(1, 1100, 'f:gone')], mat: { value: 'r' } },
      credential_id: { sibs: [app(1, 1100, 'dX')], mat: { value: null } },
    },
  });
}

function deadAndHiddenRows(b: ReturnType<typeof newState>): void {
  setRow(b, {
    tbl: TBL.entries,
    id: 'd1',
    regs: {
      _life: { sibs: [app(1, 2000, 'dead')] },
      name: { sibs: [app(1, 1000, 'Old')] },
      entry_type: { sibs: [app(1, 1000, 'rdp')] },
      password: { sibs: [app(1, 1000, bytes('d1-pw'))] },
      port: { sibs: [app(1, 1000, 3389)] },
    },
    grave: { diedMs: 2000, diedC: 0, diedDev: 1, redacted: false },
  });
  const redacted = { flags: SIB_REDACTED, vhash: ZERO_VHASH };
  setRow(b, {
    tbl: TBL.entries,
    id: 'r1',
    regs: {
      _life: { sibs: [app(1, 2100, 'dead')] },
      name: { sibs: [app(1, 1000, null, redacted)] },
      host: { sibs: [app(1, 1000, null, redacted), app(2, 1050, null, redacted)] },
    },
    grave: { diedMs: 2100, diedC: 0, diedDev: 1, redacted: true },
  });
  setRow(b, {
    tbl: TBL.history,
    id: 'h1',
    regs: {
      _life: { sibs: [app(1, 1000, 'live')] },
      entry_id: { sibs: [app(1, 1000, 'd1')] },
      password: { sibs: [app(1, 1000, bytes('h1-pw'))] },
      changed_at: { sibs: [app(1, 1000, '2026-01-01T00:00:00.000Z')] },
    },
  });
  setRow(b, {
    tbl: TBL.history,
    id: 'h2',
    regs: {
      entry_id: { sibs: [pseudo(0, 'h2e', 'e1')] },
      username: { sibs: [pseudo(0, 'h2u', 'root')] },
      password: { sibs: [pseudo(0, 'h2p', bytes('h2-pw'))] },
      changed_at: { sibs: [pseudo(0, 'h2c', '2025-06-01T10:00:00.000Z')] },
    },
  });
}

function vaultRows(b: ReturnType<typeof newState>): void {
  setRow(b, {
    tbl: TBL.meta,
    id: META_ROW_ID,
    regs: {
      vault_id: { sibs: [app(1, 1000, 'vault-uuid-1')] },
      cloud_sync_enabled: { sibs: [app(1, 1000, 'true')], mat: { value: null } },
    },
  });
  setRow(b, { tbl: TBL.sync, id: SYNC_ROW.key, regs: { epoch: { sibs: [epochSib], pmem: derived(epochSib) } } });
  setRow(b, { tbl: TBL.sync, id: SYNC_ROW.owner, regs: { owner: { sibs: [app(1, 1000, '{"a":null,"d":"uuid-1"}')] } } });
  setRow(b, { tbl: TBL.sync, id: SYNC_ROW.device, regs: { 'uuid-1': { sibs: [app(1, 1000, '{"name":"Mac"}')] } } });
  setRow(b, { tbl: TBL.sync, id: SYNC_ROW.dismiss, regs: { [hex('dismiss')]: { sibs: [app(2, 1300, 1)] } } });
}

export function richState(): SyncState {
  const b = newState();
  contentRows(b);
  deadAndHiddenRows(b);
  vaultRows(b);
  b.joinVv(1, { ms: 2100, c: 0 });
  b.joinVv(2, { ms: 1500, c: 3 });
  b.addDev({ dev: 1, deviceUuid: 'uuid-1', startedMs: 900 });
  b.addDev({ dev: 2, deviceUuid: 'uuid-2', startedMs: 950 });
  b.setEpoch({ epochId: E0, parent: null, salt: 'c2FsdA==', verification: 'dG9rZW4=', createdMs: 0 });
  b.setEpoch({ epochId: E1, parent: E0, salt: null, verification: null, createdMs: 1500 });
  b.addWrap({ epochId: E1, targetEpoch: E0, wrap: bytes('wrap', 60).toString('hex') });
  return b.build();
}

export function richFixture(): { readonly state: SyncState } & Materialized {
  const state = richState();
  return { state, ...materializeRows(state, LIVE_ROWS) };
}
