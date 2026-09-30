// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LIFE_DEAD, LIFE_REG, regKey, rowKey } from '../catalog.js';
import {
  HighWater,
  WIN_REG_ARGS,
  defaultHwHintSources,
  detectDevCollision,
  loadOrCreateDevice,
  machineIdReader,
  newIncarnation,
  newSessionNonce,
  readHwHint,
  readLinuxMachineId,
  readMacMachineId,
  readWindowsMachineId,
  restampOwnSiblings,
  type MachineIdIo,
} from '../identity.js';
import { vvCovers } from '../sibling.js';
import { StateBuilder, emptyState, getRegister, getRow, makeRegister } from '../state-view.js';
import { SyncCoreError, TBL } from '../types.js';
import type { AppDot, DevRecord, Grave, Hlc, Pmem, RegKey, Sibling, SyncState } from '../types.js';

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const V = 'cd'.repeat(16);

// ---------- Machine ids ----------

function fakeIo(files: Record<string, string>, execOut: Record<string, string> = {}): MachineIdIo & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    readFile: (p) => (p in files ? files[p] : null),
    exec: (file, args) => {
      calls.push([file, ...args]);
      const out = execOut[file];
      if (out === undefined) throw new Error(`no such command ${file}`);
      return out;
    },
  };
}

describe('machine ids and hw_hint (3.1)', () => {
  const MID = '0123456789abcdef0123456789abcdef';

  it('hashes the trimmed id and returns null when there is none', () => {
    expect(readHwHint({ platform: 'linux', readMachineId: () => ` ${MID}\n` })).toBe(sha(MID));
    expect(readHwHint({ platform: 'linux', readMachineId: () => null })).toBeNull();
    expect(readHwHint({ platform: 'linux', readMachineId: () => '  \n' })).toBeNull();
  });

  it('propagates a reader failure instead of silently switching to machine.json', () => {
    expect(() => readHwHint({ platform: 'darwin', readMachineId: () => { throw new Error('ioreg timed out'); } })).toThrow(/ioreg/);
  });

  it('reads /etc/machine-id, then /var/lib/dbus/machine-id, skipping empty or uninitialized ids', () => {
    expect(readLinuxMachineId(fakeIo({ '/etc/machine-id': `${MID}\n` }))).toBe(MID);
    const dbus = 'f'.repeat(32);
    expect(readLinuxMachineId(fakeIo({ '/etc/machine-id': '', '/var/lib/dbus/machine-id': dbus }))).toBe(dbus);
    expect(readLinuxMachineId(fakeIo({ '/etc/machine-id': 'uninitialized\n', '/var/lib/dbus/machine-id': dbus }))).toBe(dbus);
    expect(readLinuxMachineId(fakeIo({}))).toBeNull();
  });

  it('parses IOPlatformUUID from ioreg on macOS', () => {
    const out = '+-o J316sAP  <class IOPlatformExpertDevice>\n  {\n    "IOPlatformUUID" = "A1B2C3D4-0000-1111-2222-333344445555"\n  }\n';
    const io = fakeIo({}, { '/usr/sbin/ioreg': out });
    expect(readMacMachineId(io)).toBe('A1B2C3D4-0000-1111-2222-333344445555');
    expect(readMacMachineId(fakeIo({}, { '/usr/sbin/ioreg': 'nothing here' }))).toBeNull();
  });

  it('parses MachineGuid from the 64-bit registry view on Windows', () => {
    const out = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    9f8e7d6c-0000-1111-2222-333344445555\r\n\r\n';
    const io = fakeIo({}, { reg: out });
    expect(readWindowsMachineId(io)).toBe('9f8e7d6c-0000-1111-2222-333344445555');
    expect(io.calls[0]).toEqual(['reg', ...WIN_REG_ARGS]);
    expect(io.calls[0]).toContain('/reg:64');
  });

  it('picks the reader by platform (other Unix-likes use the Linux files)', () => {
    const io = fakeIo({ '/etc/machine-id': MID }, { reg: 'MachineGuid REG_SZ win-id', '/usr/sbin/ioreg': '"IOPlatformUUID" = "mac-id"' });
    expect(machineIdReader('linux', io)()).toBe(MID);
    expect(machineIdReader('freebsd', io)()).toBe(MID);
    expect(machineIdReader('win32', io)()).toBe('win-id');
    expect(machineIdReader('darwin', io)()).toBe('mac-id');
    expect(readHwHint(defaultHwHintSources('linux', io))).toBe(sha(MID));
  });
});

// ---------- device.json ----------

describe('loadOrCreateDevice (3.1)', () => {
  let root: string;
  let n: number;
  const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const HINT = sha('platform-id');
  const deviceFile = (hint: string): string => path.join(root, `m-${hint.slice(0, 8)}`, 'device.json');

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-sync-identity-'));
    n = 0;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates device.json under m-<hw8> once and reuses it', () => {
    const first = loadOrCreateDevice(root, HINT, uuid);
    expect(first).toEqual({ deviceUuid: '00000000-0000-4000-8000-000000000001', hwHint: HINT, created: true, reason: 'missing' });
    expect(JSON.parse(fs.readFileSync(deviceFile(HINT), 'utf8'))).toEqual({ device_uuid: first.deviceUuid, hw_hint: HINT });
    const again = loadOrCreateDevice(root, HINT, uuid);
    expect(again).toEqual({ deviceUuid: first.deviceUuid, hwHint: HINT, created: false, reason: 'existing' });
    expect(fs.readdirSync(path.dirname(deviceFile(HINT)))).toEqual(['device.json']);
  });

  it('regenerates the device uuid when device.json is corrupt or names another hw_hint', () => {
    const first = loadOrCreateDevice(root, HINT, uuid);
    fs.writeFileSync(deviceFile(HINT), '{ not json');
    const corrupt = loadOrCreateDevice(root, HINT, uuid);
    expect(corrupt.reason).toBe('corrupt');
    expect(corrupt.deviceUuid).not.toBe(first.deviceUuid);

    fs.writeFileSync(deviceFile(HINT), JSON.stringify({ device_uuid: 'nope', hw_hint: HINT }));
    expect(loadOrCreateDevice(root, HINT, uuid).reason).toBe('corrupt');

    const sibling = HINT.slice(0, 8) + 'f'.repeat(56);
    fs.writeFileSync(deviceFile(HINT), JSON.stringify({ device_uuid: first.deviceUuid, hw_hint: sibling }));
    const moved = loadOrCreateDevice(root, HINT, uuid);
    expect(moved.reason).toBe('hw-changed');
    expect(moved.created).toBe(true);
    expect(moved.deviceUuid).not.toBe(first.deviceUuid);
  });

  it('keeps separate identities per machine folder', () => {
    const a = loadOrCreateDevice(root, HINT, uuid);
    const b = loadOrCreateDevice(root, sha('other-machine'), uuid);
    expect(a.deviceUuid).not.toBe(b.deviceUuid);
    expect(loadOrCreateDevice(root, HINT, uuid).deviceUuid).toBe(a.deviceUuid);
  });

  it('falls back to a random id in machine.json when the platform has none', () => {
    const a = loadOrCreateDevice(root, null, uuid);
    const machine = JSON.parse(fs.readFileSync(path.join(root, 'machine.json'), 'utf8')) as { machine_id: string };
    expect(a.hwHint).toBe(sha(machine.machine_id));
    expect(fs.existsSync(deviceFile(a.hwHint))).toBe(true);
    const b = loadOrCreateDevice(root, null, uuid);
    expect(b).toMatchObject({ deviceUuid: a.deviceUuid, hwHint: a.hwHint, created: false });

    fs.writeFileSync(path.join(root, 'machine.json'), '[]');
    const c = loadOrCreateDevice(root, null, uuid);
    expect(c.hwHint).not.toBe(a.hwHint);
    expect(c.created).toBe(true);
  });

  it('rejects malformed hints and generators', () => {
    expect(() => loadOrCreateDevice(root, 'ABC', uuid)).toThrow();
    expect(() => loadOrCreateDevice(root, HINT, () => 'not-a-uuid')).toThrow(/UUID/);
    expect(fs.existsSync(deviceFile(HINT))).toBe(false);
  });
});

describe('per-launch ids', () => {
  it('makes a 32-hex incarnation from 16 random bytes', () => {
    expect(newIncarnation(() => Buffer.alloc(16, 0xab))).toBe('ab'.repeat(16));
    expect(() => newIncarnation(() => Buffer.alloc(8))).toThrow();
  });

  it('returns a validated session nonce', () => {
    const id = '11111111-2222-4333-8444-555555555555';
    expect(newSessionNonce(() => id)).toBe(id);
    expect(() => newSessionNonce(() => 'x')).toThrow();
  });
});

// ---------- High-water ----------

describe('HighWater (4.1)', () => {
  const vv = (entries: [number, Hlc][]): ReadonlyMap<number, Hlc> => new Map(entries);

  it('passes before anything is stamped', () => {
    const hw = new HighWater();
    expect(hw.lastStamped()).toBeNull();
    expect(hw.checkWorking(vv([]), 7)).toBe('ok');
  });

  it('asks for a new incarnation when W fell behind the last stamp', () => {
    const hw = new HighWater();
    hw.stamp({ dev: 7, ms: 100, c: 2 });
    hw.stamp({ dev: 7, ms: 90, c: 0 });
    expect(hw.lastStamped()).toEqual({ dev: 7, ms: 100, c: 2 });
    expect(hw.checkWorking(vv([[7, { ms: 100, c: 2 }]]), 7)).toBe('ok');
    expect(hw.checkWorking(vv([[7, { ms: 101, c: 0 }]]), 7)).toBe('ok');
    expect(hw.checkWorking(vv([[7, { ms: 100, c: 1 }]]), 7)).toBe('new-incarnation');
    expect(hw.checkWorking(vv([]), 7)).toBe('new-incarnation');
  });

  it('follows the current dev after a new incarnation', () => {
    const hw = new HighWater();
    hw.stamp({ dev: 7, ms: 100, c: 0 });
    expect(hw.checkWorking(vv([]), 8)).toBe('ok');
    hw.stamp({ dev: 8, ms: 50, c: 0 });
    expect(hw.lastStamped()).toEqual({ dev: 8, ms: 50, c: 0 });
    expect(hw.checkWorking(vv([[8, { ms: 50, c: 0 }]]), 8)).toBe('ok');
    expect(() => hw.stamp({ dev: 0, ms: 1, c: 0 })).toThrow();
  });
});

// ---------- State fixtures ----------

function app(dev: number, ms: number, c: number, value: Sibling['value'], over: Partial<Sibling> = {}): Sibling {
  return { dev, ms, c, pid: '', lt: 0, vhash: V, flags: 0, value, prevVhash: null, ...over };
}

interface RegSpec {
  readonly key: RegKey;
  readonly sibs: readonly Sibling[];
  readonly pmem?: Pmem | null;
  readonly mat?: { value: Sibling['value'] };
}

function build(
  regs: readonly RegSpec[],
  vv: readonly [number, Hlc][],
  devs: readonly DevRecord[],
  graves: readonly [string, Grave][] = [],
): SyncState {
  const b = new StateBuilder(emptyState('L', 'G', 0));
  for (const r of regs) {
    const reg = makeRegister(r.key, r.sibs, r.pmem ?? null);
    b.setRegister(r.mat ? { ...reg, mat: r.mat } : reg);
  }
  for (const [dev, stamp] of vv) b.joinVv(dev, stamp);
  for (const d of devs) b.addDev(d);
  for (const [rowId, g] of graves) b.setGrave(rowKey(TBL.entries, rowId), g);
  return b.build();
}

const OWN = 7;
const OTHER = 9;
const REC_A: DevRecord = { dev: OWN, deviceUuid: 'uuid-a', startedMs: 50 };
const REC_OTHER: DevRecord = { dev: OTHER, deviceUuid: 'uuid-b', startedMs: 10 };
const NAME = regKey(TBL.entries, 'e1', 'name');
const HOST = regKey(TBL.entries, 'e1', 'host');

describe('detectDevCollision (4.1)', () => {
  it('does not fire when W superseded a sibling it published earlier', () => {
    const s = build([{ key: NAME, sibs: [app(OWN, 100, 0, 'a')] }], [[OWN, { ms: 100, c: 0 }]], [REC_A]);
    const w = build([{ key: NAME, sibs: [app(OWN, 200, 0, 'b')] }], [[OWN, { ms: 200, c: 0 }]], [REC_A]);
    expect(detectDevCollision(s, w, OWN)).toEqual({ collided: false, vvAhead: false, reason: 'none' });
  });

  it('fires when S has seen more of the dev than W', () => {
    const s = build([{ key: NAME, sibs: [app(OWN, 300, 0, 'a')] }], [[OWN, { ms: 300, c: 0 }]], [REC_A]);
    const w = build([{ key: NAME, sibs: [app(OWN, 200, 0, 'b')] }], [[OWN, { ms: 200, c: 0 }]], [REC_A]);
    expect(detectDevCollision(s, w, OWN)).toEqual({ collided: true, vvAhead: true, reason: 'vv-ahead' });
    expect(detectDevCollision(s, build([], [], []), OWN).reason).toBe('vv-ahead');
  });

  it('fires when S records the dev as minted by another install or launch', () => {
    const w = build([{ key: NAME, sibs: [app(OWN, 200, 0, 'b')] }], [[OWN, { ms: 200, c: 0 }]], [REC_A]);
    const foreign = build([{ key: HOST, sibs: [app(OWN, 100, 0, 'h')] }], [[OWN, { ms: 100, c: 0 }]], [{ ...REC_A, deviceUuid: 'uuid-z' }]);
    expect(detectDevCollision(foreign, w, OWN)).toEqual({ collided: true, vvAhead: false, reason: 'dev-record' });
    const otherLaunch = build([], [[OWN, { ms: 100, c: 0 }]], [{ ...REC_A, startedMs: 99 }]);
    expect(detectDevCollision(otherLaunch, w, OWN).reason).toBe('dev-record');
    const wNoRecord = build([], [[OWN, { ms: 200, c: 0 }]], []);
    expect(detectDevCollision(build([], [[OWN, { ms: 1, c: 0 }]], [REC_A]), wNoRecord, OWN).reason).toBe('dev-record');
  });

  it('fires on an S sibling of the dev that W neither holds nor covers', () => {
    const s = build([{ key: HOST, sibs: [app(OWN, 250, 0, 'h')] }], [[OWN, { ms: 100, c: 0 }]], [REC_A]);
    const w = build([], [[OWN, { ms: 200, c: 0 }]], [REC_A]);
    expect(detectDevCollision(s, w, OWN)).toEqual({ collided: true, vvAhead: false, reason: 'uncovered-sibling' });
    const wHolds = build([{ key: HOST, sibs: [app(OWN, 250, 0, 'h')] }], [[OWN, { ms: 200, c: 0 }]], [REC_A]);
    expect(detectDevCollision(s, wHolds, OWN).collided).toBe(false);
  });

  it('ignores other devs', () => {
    const s = build([{ key: NAME, sibs: [app(OTHER, 900, 0, 'x')] }], [[OTHER, { ms: 900, c: 0 }]], [REC_OTHER]);
    const w = build([], [[OWN, { ms: 1, c: 0 }]], [REC_A]);
    expect(detectDevCollision(s, w, OWN).collided).toBe(false);
  });
});

// ---------- Re-stamp ----------

describe('restampOwnSiblings (4.1)', () => {
  const NOTES = regKey(TBL.entries, 'e1', 'notes');
  const OTHER_ROW = regKey(TBL.entries, 'e2', 'name');
  const LIFE3 = regKey(TBL.entries, 'e3', LIFE_REG);
  const PMEM: Pmem = { ms: 3, ids: ['ab'.repeat(16)] };
  const NEW: AppDot = { dev: 42, ms: 1000, c: 5 };

  function fixture(): { w: SyncState; s: SyncState } {
    const w = build(
      [
        { key: NAME, sibs: [app(OWN, 100, 0, 'x', { prevVhash: '1234567890abcdef', flags: 0 })], pmem: PMEM, mat: { value: 'X' } },
        { key: HOST, sibs: [app(OWN, 100, 0, 'h')] },
        { key: NOTES, sibs: [app(OWN, 95, 0, 'n2'), app(OWN, 90, 0, 'n1'), app(OTHER, 80, 0, 'o')] },
        { key: OTHER_ROW, sibs: [app(OTHER, 70, 0, 'y')] },
        { key: LIFE3, sibs: [app(OWN, 120, 0, LIFE_DEAD)] },
      ],
      [
        [OWN, { ms: 120, c: 0 }],
        [OTHER, { ms: 80, c: 0 }],
      ],
      [REC_A, REC_OTHER],
      [['e3', { diedMs: 120, diedC: 0, diedDev: OWN, redacted: true }]],
    );
    const s = build([{ key: HOST, sibs: [app(OWN, 100, 0, 'h')] }], [[OWN, { ms: 100, c: 0 }]], [REC_A]);
    return { w, s };
  }

  it('moves every own sibling S lacks to the new dot, keeping values, hashes, prev and flags', () => {
    const { w, s } = fixture();
    const out = restampOwnSiblings(w, s, OWN, NEW);
    const name = getRegister(out, NAME)!;
    expect(name.sibs).toEqual([app(42, 1000, 5, 'x', { prevVhash: '1234567890abcdef' })]);
    expect(name.pmem).toBe(PMEM);
    expect(name.mat).toEqual({ value: 'X' });
    expect(getRegister(out, HOST)).toBe(getRegister(w, HOST));
    expect(getRow(out, rowKey(TBL.entries, 'e2'))).toBe(getRow(w, rowKey(TBL.entries, 'e2')));
    for (const sib of name.sibs) expect(vvCovers(s.vv, sib.dev, sib)).toBe(false);
  });

  it('gives several own siblings of one register consecutive dots and records the last in vv', () => {
    const { w, s } = fixture();
    const out = restampOwnSiblings(w, s, OWN, NEW);
    expect(getRegister(out, NOTES)!.sibs).toEqual([app(OTHER, 80, 0, 'o'), app(42, 1000, 5, 'n1'), app(42, 1000, 6, 'n2')]);
    expect(out.vv.get(42)).toEqual({ ms: 1000, c: 6 });
    expect(out.vv.get(OWN)).toEqual({ ms: 120, c: 0 });
  });

  it('rolls the counter over into the next millisecond', () => {
    const { w, s } = fixture();
    const out = restampOwnSiblings(w, s, OWN, { dev: 42, ms: 1000, c: 65535 });
    expect(getRegister(out, NOTES)!.sibs.map((x) => [x.ms, x.c])).toEqual([[80, 0], [1000, 65535], [1001, 0]]);
    expect(out.vv.get(42)).toEqual({ ms: 1001, c: 0 });
  });

  it('moves a grave with its dead sibling and keeps redaction', () => {
    const { w, s } = fixture();
    const out = restampOwnSiblings(w, s, OWN, NEW);
    expect(getRegister(out, LIFE3)!.sibs).toEqual([app(42, 1000, 5, LIFE_DEAD)]);
    expect(getRow(out, rowKey(TBL.entries, 'e3'))!.grave).toEqual({ diedMs: 1000, diedC: 5, diedDev: 42, redacted: true });
  });

  it('adds a sync_dev record for the new dev', () => {
    const { w, s } = fixture();
    expect(restampOwnSiblings(w, s, OWN, NEW).devs.get(42)).toEqual({ dev: 42, deviceUuid: 'uuid-a', startedMs: 1000 });
    const rec = { dev: 42, deviceUuid: 'uuid-a', startedMs: 7 };
    expect(restampOwnSiblings(w, s, OWN, NEW, rec).devs.get(42)).toBe(rec);
  });

  it('still records the new dot when nothing needs moving', () => {
    const s = build([{ key: HOST, sibs: [app(OWN, 100, 0, 'h')] }], [[OWN, { ms: 100, c: 0 }]], [REC_A]);
    const w = build([{ key: HOST, sibs: [app(OWN, 100, 0, 'h')] }], [[OWN, { ms: 100, c: 0 }]], [REC_A]);
    const out = restampOwnSiblings(w, s, OWN, NEW);
    expect(out.rows).toBe(w.rows);
    expect(out.vv.get(42)).toEqual({ ms: 1000, c: 5 });
  });

  it('keeps invariant I1: every app sibling covered by vv', () => {
    const { w, s } = fixture();
    const out = restampOwnSiblings(w, s, OWN, NEW);
    for (const row of out.rows.values()) {
      for (const reg of row.regs.values()) {
        for (const sib of reg.sibs) expect(vvCovers(out.vv, sib.dev, sib)).toBe(true);
      }
    }
  });

  it('refuses a stale or reused dev', () => {
    const { w, s } = fixture();
    expect(() => restampOwnSiblings(w, s, OWN, { dev: OWN, ms: 1, c: 0 })).toThrow();
    expect(() => restampOwnSiblings(w, s, OWN, { dev: 0, ms: 1, c: 0 })).toThrow();
    expect(() => restampOwnSiblings(w, s, OWN, { dev: OTHER, ms: 5000, c: 0 })).toThrow(SyncCoreError);
    const noRecord = build([{ key: NAME, sibs: [app(OWN, 1, 0, 'x')] }], [[OWN, { ms: 1, c: 0 }]], []);
    expect(() => restampOwnSiblings(noRecord, s, OWN, NEW)).toThrow(/newDevRecord/);
  });
});

describe('performance (13.3)', () => {
  const ENTRIES = 5000;
  const REGS = ['name', 'host', 'port', 'username', 'notes', 'icon', 'color', 'domain', 'sort_order', 'created_at'];
  const BUDGET_MS = 150;

  function big(dev: number, ms: number): SyncState {
    const b = new StateBuilder(emptyState('L', 'G', 0));
    for (let i = 0; i < ENTRIES; i++) {
      for (const reg of REGS) b.setRegister(makeRegister(regKey(TBL.entries, `e${i}`, reg), [app(dev, ms, 0, `${reg}${i}`)], null));
    }
    b.joinVv(dev, { ms, c: 0 });
    b.addDev({ dev, deviceUuid: 'uuid-a', startedMs: 1 });
    return b.build();
  }

  it('checks for a dev collision over 50,000 registers within budget', () => {
    const w = big(OWN, 200);
    const s = big(OWN, 100);
    const t0 = performance.now();
    const res = detectDevCollision(s, w, OWN);
    const elapsed = performance.now() - t0;
    expect(res.collided).toBe(false);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });
});
