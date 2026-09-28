// Fixtures for the replica tests: one simulated device (machine folder, device uuid, registry,
// test host with a TestWorkingCopyHost) and helpers to build open inputs, write legacy edits
// into a shared file in place, and read registers.
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { deriveEpochKeys } from '../hashing.js';
import type { Kdf, SyncHost } from '../host.js';
import { makeVerificationToken } from '../key-epoch.js';
import { IncarnationRegistry, openReplica, type ReplicaDeps, type ReplicaOpenInput, type ReplicaOpenResult, type ReplicaSeed } from '../replica.js';
import { getRegister, provisional } from '../state-view.js';
import { TBL, type FileBinding, type RegisterState, type Sibling, type SyncState } from '../types.js';
import { makeTestSyncHost, type TestSyncHost } from './host-fakes.js';

export interface TestDevice {
  readonly t: TestSyncHost;
  readonly deps: ReplicaDeps;
  readonly registry: IncarnationRegistry;
  readonly syncRoot: string;
  readonly machineDir: string;
  readonly deviceUuid: string;
}

export interface DeviceOptions {
  readonly hw8?: string;
  readonly kdf?: Kdf;
  readonly verifyCommits?: boolean;
  readonly host?: Partial<SyncHost>;
}

export function makeDevice(root: string, opts: DeviceOptions = {}): TestDevice {
  const t = makeTestSyncHost(root, { ...(opts.kdf ? { kdf: opts.kdf } : {}), ...(opts.host ?? {}) });
  const registry = new IncarnationRegistry();
  const syncRoot = path.join(root, 'sync');
  const machineDir = path.join(syncRoot, `m-${opts.hw8 ?? 'aaaaaaaa'}`);
  const deps: ReplicaDeps = { host: t.host, incarnations: registry, verifyCommits: opts.verifyCommits ?? true };
  return { t, deps, registry, syncRoot, machineDir, deviceUuid: crypto.randomUUID() };
}

export function bindingFor(sharedPath: string, fileId: string = crypto.randomUUID()): FileBinding {
  return { sharedPath, realpath: sharedPath, fileId };
}

export function openInput(d: TestDevice, lineageId: string, key: Buffer, seed: ReplicaSeed, binding: FileBinding | null): ReplicaOpenInput {
  return { syncRoot: d.syncRoot, machineDir: d.machineDir, deviceUuid: d.deviceUuid, lineageId, key, seed, binding };
}

export function open(d: TestDevice, lineageId: string, key: Buffer, seed: ReplicaSeed, binding: FileBinding | null): Promise<ReplicaOpenResult> {
  return openReplica(openInput(d, lineageId, key, seed, binding), d.deps);
}

export interface NewVaultSeed {
  readonly lineageId: string;
  readonly key: Buffer;
  readonly seed: ReplicaSeed;
}

/** A brand-new vault's seed with the device's kdf (password 'pw'). */
export function newVaultSeed(d: TestDevice, password = 'pw'): NewVaultSeed {
  const lineageId = crypto.randomUUID();
  const salt = crypto.randomBytes(32).toString('base64');
  const key = d.deps.host.kdf.deriveKey(password, salt);
  const verification = makeVerificationToken(deriveEpochKeys(key, lineageId), (n) => crypto.randomBytes(n));
  return { lineageId, key, seed: { kind: 'new-vault', salt, verification, vaultId: crypto.randomUUID() } };
}

/** An older app editing S in place (rollback journal, no side files left behind). */
export function editInPlace(file: string, edit: (db: Database.Database) => void): void {
  const db = new Database(file);
  try {
    db.pragma('journal_mode = DELETE');
    edit(db);
  } finally {
    db.close();
  }
}

export function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function entryReg(state: SyncState, rowId: string, reg: string): RegisterState | undefined {
  return getRegister(state, { tbl: TBL.entries, rowId, reg });
}

export function provisionalOf(state: SyncState, rowId: string, reg: string): Sibling | null {
  const r = entryReg(state, rowId, reg);
  return r === undefined ? null : provisional(reg, r.sibs);
}

const INSERT_ENTRY = `INSERT INTO entries (id, name, entry_type, host, created_at, updated_at)
  VALUES (?, ?, 'ssh', ?, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`;

export function insertEntry(db: Database.Database, id: string, name: string, host = '10.1.1.1'): void {
  db.prepare(INSERT_ENTRY).run(id, name, host);
}

export function copyToTemp(dir: string, bytes: Buffer, name: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}
