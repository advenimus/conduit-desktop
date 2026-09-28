/**
 * Device and replica identity (spec 3.1, 4.1): device.json with hw_hint regeneration,
 * machine.json fallback, per-launch session nonce and incarnation, the in-memory high-water
 * check, and the dev-collision guard that re-stamps own siblings. Machine-id reading lives in
 * identity-machine.ts and is re-exported here.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LIFE_REG } from './catalog.js';
import { LINEAGE_FILES, isErrno, machineDir, writeFileAtomic } from './paths.js';
import { compareHlc, compareIdentity, identityKey, vvCovers } from './sibling.js';
import { StateBuilder, makeRegister } from './state-view.js';
import { HLC_MAX_COUNTER, SyncCoreError } from './types.js';
import type { AppDot, Dev, DevRecord, Grave, Hlc, RegisterState, RowState, Sibling, SyncState, VersionVector } from './types.js';

export * from './identity-machine.js';

export type DeviceIdentityReason = 'existing' | 'missing' | 'corrupt' | 'hw-changed';

export interface DeviceIdentity {
  readonly deviceUuid: string;
  /** Lowercase hex SHA-256 of the platform machine id, or of machine.json's random id. */
  readonly hwHint: string;
  /** true when device.json was (re)created this launch. */
  readonly created: boolean;
  /** Why device.json was (re)created, or 'existing'. */
  readonly reason: DeviceIdentityReason;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HW_HINT_RE = /^[0-9a-f]{64}$/;
const INCARNATION_BYTES = 16;
const JSON_INDENT = 2;

interface DeviceFile {
  readonly device_uuid: string;
  readonly hw_hint: string;
}

type ParsedFile<T> = { readonly kind: 'ok'; readonly value: T } | { readonly kind: 'missing' | 'corrupt' };

// ---------- device.json and machine.json ----------

/**
 * Loads {syncRoot}/m-<hw8>/device.json, creating it (new device_uuid) when missing or when its
 * hw_hint differs. With no platform hint, uses a random id kept in {syncRoot}/machine.json.
 */
export function loadOrCreateDevice(
  root: string,
  hwHint: string | null,
  randomUuid: () => string,
): DeviceIdentity {
  if (hwHint !== null && !HW_HINT_RE.test(hwHint)) throw new Error('identity: hw_hint must be 64 lowercase hex');
  const hint = hwHint ?? machineJsonHint(root, randomUuid);
  const dir = machineDir(root, hint);
  const file = path.join(dir, LINEAGE_FILES.device);
  const parsed = readJsonFile(file, parseDeviceFile);
  if (parsed.kind === 'ok' && parsed.value.hw_hint === hint) {
    return { deviceUuid: parsed.value.device_uuid, hwHint: hint, created: false, reason: 'existing' };
  }
  const deviceUuid = requireUuid(randomUuid());
  fs.mkdirSync(dir, { recursive: true });
  writeJsonFile(file, { device_uuid: deviceUuid, hw_hint: hint } satisfies DeviceFile);
  const reason: DeviceIdentityReason = parsed.kind === 'ok' ? 'hw-changed' : parsed.kind;
  return { deviceUuid, hwHint: hint, created: true, reason };
}

/** SHA-256 hex of the random id in {root}/machine.json, created when missing or corrupt. */
function machineJsonHint(root: string, randomUuid: () => string): string {
  const file = path.join(root, LINEAGE_FILES.machine);
  const parsed = readJsonFile(file, parseMachineFile);
  let id: string;
  if (parsed.kind === 'ok') {
    id = parsed.value;
  } else {
    id = requireUuid(randomUuid());
    fs.mkdirSync(root, { recursive: true });
    writeJsonFile(file, { machine_id: id });
  }
  return createHash('sha256').update(id, 'utf8').digest('hex');
}

function parseDeviceFile(raw: unknown): DeviceFile | null {
  if (!isRecord(raw)) return null;
  const { device_uuid: uuid, hw_hint: hint } = raw;
  if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) return null;
  if (typeof hint !== 'string' || !HW_HINT_RE.test(hint)) return null;
  return { device_uuid: uuid, hw_hint: hint };
}

function parseMachineFile(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const id = raw.machine_id;
  return typeof id === 'string' && UUID_RE.test(id) ? id : null;
}

function readJsonFile<T>(file: string, parse: (raw: unknown) => T | null): ParsedFile<T> {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return { kind: 'missing' };
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: 'corrupt' };
  }
  const value = parse(raw);
  return value === null ? { kind: 'corrupt' } : { kind: 'ok', value };
}

function writeJsonFile(file: string, value: object): void {
  writeFileAtomic(file, `${JSON.stringify(value, null, JSON_INDENT)}\n`);
}

function requireUuid(v: string): string {
  if (!UUID_RE.test(v)) throw new Error('identity: randomUuid() did not return a UUID');
  return v;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------- Per-launch ids ----------

/** Random UUIDv4, memory only, one per app launch. */
export function newSessionNonce(randomUuid: () => string): string {
  return requireUuid(randomUuid());
}

/** 128 random bits as 32 hex chars. */
export function newIncarnation(randomBytes: (n: number) => Buffer): string {
  const bytes = randomBytes(INCARNATION_BYTES);
  if (bytes.length !== INCARNATION_BYTES) throw new Error('identity: randomBytes returned the wrong length');
  return bytes.toString('hex');
}

// ---------- High-water mark (4.1) ----------

export type HighWaterVerdict = 'ok' | 'new-incarnation';

/**
 * Per-process high-water mark (4.1). The engine keeps one per lineage, in memory only.
 * It tracks the current dev only: stamping a dot of another dev (after a new incarnation)
 * starts over, and checks against another dev pass.
 */
export class HighWater {
  private last: AppDot | null = null;

  /** Record a dot this process just stamped. */
  stamp(dot: AppDot): void {
    if (!Number.isSafeInteger(dot.dev) || dot.dev <= 0) throw new Error('identity: stamped dot needs dev > 0');
    const last = this.last;
    if (last === null || last.dev !== dot.dev || compareHlc(dot, last) > 0) {
      this.last = { dev: dot.dev, ms: dot.ms, c: dot.c };
    }
  }

  /** The last stamped dot, or null. */
  lastStamped(): AppDot | null {
    return this.last;
  }

  /** At unlock and before each capture: W.vv[dev] < hwm means W was replaced under us. */
  checkWorking(wVv: VersionVector, dev: Dev): HighWaterVerdict {
    const last = this.last;
    if (last === null || last.dev !== dev) return 'ok';
    return vvCovers(wVv, dev, last) ? 'ok' : 'new-incarnation';
  }
}

// ---------- Dev collision (4.1) ----------

export type DevCollisionReason = 'none' | 'vv-ahead' | 'dev-record' | 'uncovered-sibling';

export interface DevCollision {
  readonly collided: boolean;
  /** true when S.vv[dev] > W.vv[dev]; otherwise `reason` says which other test fired. */
  readonly vvAhead: boolean;
  readonly reason: DevCollisionReason;
}

/**
 * Before every merge (4.1): S.vv[dev] > W.vv[dev]; or S records `dev` as minted by another
 * install or launch (sync_dev differs); or S holds a sibling with `dev` that W lacks and does
 * not cover. A sibling W lacks but covers is one W superseded, which is normal after a publish.
 */
export function detectDevCollision(s: SyncState, w: SyncState, dev: Dev): DevCollision {
  const sStamp = s.vv.get(dev);
  if (sStamp !== undefined && !vvCovers(w.vv, dev, sStamp)) return collision('vv-ahead');
  if (devRecordDiffers(s.devs.get(dev), w.devs.get(dev))) return collision('dev-record');
  if (hasUncoveredSibling(s, w, dev)) return collision('uncovered-sibling');
  return { collided: false, vvAhead: false, reason: 'none' };
}

function collision(reason: Exclude<DevCollisionReason, 'none'>): DevCollision {
  return { collided: true, vvAhead: reason === 'vv-ahead', reason };
}

function devRecordDiffers(sRec: DevRecord | undefined, wRec: DevRecord | undefined): boolean {
  if (sRec === undefined) return false;
  return wRec === undefined || sRec.deviceUuid !== wRec.deviceUuid || sRec.startedMs !== wRec.startedMs;
}

function hasUncoveredSibling(s: SyncState, w: SyncState, dev: Dev): boolean {
  for (const [rk, row] of s.rows) {
    for (const reg of row.regs.values()) {
      for (const sib of reg.sibs) {
        if (sib.dev !== dev || vvCovers(w.vv, dev, sib)) continue;
        if (!registerHas(w.rows.get(rk), reg.key.reg, identityKey(sib))) return true;
      }
    }
  }
  return false;
}

function registerHas(row: RowState | undefined, reg: string, identity: string): boolean {
  const r = row?.regs.get(reg);
  return r !== undefined && r.sibs.some((x) => identityKey(x) === identity);
}

// ---------- Re-stamping own siblings ----------

/**
 * Collision repair: every sibling of `oldDev` in W that S lacks is re-stamped under `newDot`
 * (same value and vhash, prev kept); vv[newDot.dev] = newDot. Reported as sync.dev_collision.
 * A register holding several such siblings gets consecutive dots after `newDot` so identities
 * stay unique; vv then records the last one. `newDevRecord` defaults to W's record of oldDev
 * with startedMs = newDot.ms.
 */
export function restampOwnSiblings(
  w: SyncState,
  s: SyncState,
  oldDev: Dev,
  newDot: AppDot,
  newDevRecord?: DevRecord,
): SyncState {
  requireFreshDot(w, oldDev, newDot);
  const record = newDevRecord ?? defaultDevRecord(w, oldDev, newDot);
  const b = new StateBuilder(w);
  let top: Hlc = newDot;
  for (const [rk, row] of w.rows) {
    const sRow = s.rows.get(rk);
    for (const reg of row.regs.values()) {
      const stale = reg.sibs.filter((x) => x.dev === oldDev && !registerHas(sRow, reg.key.reg, identityKey(x)));
      if (stale.length === 0) continue;
      const result = restampRegister(reg, stale, newDot);
      b.setRegister(result.register);
      if (compareHlc(result.last, top) > 0) top = result.last;
      if (reg.key.reg === LIFE_REG && row.grave !== null) {
        const grave = remapGrave(row.grave, oldDev, result.moved);
        if (grave !== row.grave) b.setGrave(row.key, grave);
      }
    }
  }
  b.joinVv(newDot.dev, top);
  b.addDev(record);
  return b.build();
}

interface RestampResult {
  readonly register: RegisterState;
  readonly last: Hlc;
  /** old identity dot "ms:c" -> new dot */
  readonly moved: ReadonlyMap<string, AppDot>;
}

function restampRegister(reg: RegisterState, stale: readonly Sibling[], newDot: AppDot): RestampResult {
  const staleSet = new Set(stale);
  const kept = reg.sibs.filter((x) => !staleSet.has(x));
  const moved = new Map<string, AppDot>();
  let dot: AppDot = newDot;
  const restamped = [...stale].sort(compareIdentity).map((x, i) => {
    if (i > 0) dot = nextDot(dot);
    moved.set(`${x.ms}:${x.c}`, dot);
    return { ...x, dev: dot.dev, ms: dot.ms, c: dot.c, pid: '', lt: 0 };
  });
  const base = makeRegister(reg.key, [...kept, ...restamped], reg.pmem);
  const register: RegisterState = reg.mat === undefined ? base : { ...base, mat: reg.mat };
  return { register, last: dot, moved };
}

/** The grave follows its died dot when that `_life` sibling moved. */
function remapGrave(grave: Grave, oldDev: Dev, moved: ReadonlyMap<string, AppDot>): Grave {
  if (grave.diedDev !== oldDev) return grave;
  const to = moved.get(`${grave.diedMs}:${grave.diedC}`);
  return to === undefined ? grave : { ...grave, diedMs: to.ms, diedC: to.c, diedDev: to.dev };
}

function nextDot(d: AppDot): AppDot {
  return d.c >= HLC_MAX_COUNTER ? { dev: d.dev, ms: d.ms + 1, c: 0 } : { dev: d.dev, ms: d.ms, c: d.c + 1 };
}

function requireFreshDot(w: SyncState, oldDev: Dev, newDot: AppDot): void {
  if (!Number.isSafeInteger(newDot.dev) || newDot.dev <= 0 || newDot.dev === oldDev) {
    throw new Error('identity: restamp needs a new dev > 0 that differs from the old one');
  }
  if (w.vv.has(newDot.dev)) {
    throw new SyncCoreError('DEV_COLLISION', 'restamp target dev already has dots in W');
  }
}

function defaultDevRecord(w: SyncState, oldDev: Dev, newDot: AppDot): DevRecord {
  const old = w.devs.get(oldDev);
  if (old === undefined) throw new Error('identity: W has no sync_dev record for the old dev; pass newDevRecord');
  return { dev: newDot.dev, deviceUuid: old.deviceUuid, startedMs: newDot.ms };
}
