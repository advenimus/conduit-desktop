// One simulated new-build device of the SyncHarness: its own syncRoot with device.json, machine
// folder and lineage folder, W (TestWorkingCopy, the hook contract of ConduitVault), the REAL
// replica and the REAL SyncEngine from assembleSyncEngine, bound to the device's mirror of S.
// Opening follows 7.2 steps 6 to 8 without the lease: openReplica, side-file observation, the
// unlock cycle, the session-open presence, engine.start().
import crypto from 'node:crypto';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { listConflicts } from '../../conflicts.js';
import { newBinding } from '../../file-binding.js';
import { deriveEpochKeys } from '../../hashing.js';
import { loadOrCreateDevice } from '../../identity.js';
import { makeVerificationToken } from '../../key-epoch.js';
import { machineDir } from '../../paths.js';
import { IncarnationRegistry, openReplica, type ReplicaOpenResult, type ReplicaPort, type ReplicaSeed } from '../../replica.js';
import { statSideFileTuples } from '../../side-files.js';
import { regKeyStr, rowLife } from '../../state-view.js';
import { SyncEngine, assembleSyncEngine, type CycleOutcome, type FinalOutcome } from '../../sync-engine.js';
import { writePresence } from '../../sync-engine-presence.js';
import { TBL, type ConflictGroup, type FileBinding, type LocalWrite, type RowKey, type SyncState } from '../../types.js';
import type { AppFacts, DeviceInfo, Kdf } from '../../host.js';
import type { FakeClock, TestWorkingCopy } from '../host-fakes.js';
import { FakeSession, makeDeviceHost, type DeviceHost } from './harness-host.js';
import {
  deleteEntries,
  deleteFolderRecursive,
  entryRow,
  insertEntry,
  insertFolder,
  isoOf,
  updateEntry,
  updateFolder,
  type EntrySpec,
  type FolderSpec,
  type Row,
} from './vault-ops.js';

export interface DeviceSpec {
  readonly name: string;
  readonly platform?: DeviceInfo['platform'];
  readonly kdf?: Kdf;
  readonly skewMs?: number;
  readonly app?: AppFacts;
  /** Start the engine (watcher, timers, scans) after opening; default true. */
  readonly start?: boolean;
  /** Mirror folder name (default: the device name). */
  readonly mirror?: string;
  /** Another device's syncRoot (roaming profile, 12 row 53) or a cloned one (row 55). */
  readonly syncRoot?: string;
  /** 64 hex; default derived from the device name. The same hint on a copied syncRoot = a clone. */
  readonly hwHint?: string;
  /** S as this device opens it (a symlink, 12 row 63); default the mirror's S. */
  readonly sharedPath?: string;
}

export interface NewVault {
  readonly lineageId: string;
  readonly key: Buffer;
  readonly salt: string;
  readonly password: string;
}

export const entryKey = (rowId: string): RowKey => ({ tbl: TBL.entries, rowId });
export const folderKey = (rowId: string): RowKey => ({ tbl: TBL.folders, rowId });

export class HarnessDevice {
  readonly dh: DeviceHost;
  readonly session = new FakeSession();
  readonly syncRoot: string;
  readonly machineDir: string;
  readonly deviceUuid: string;
  registry = new IncarnationRegistry();
  replica!: ReplicaPort;
  engine!: SyncEngine;
  wc!: TestWorkingCopy;
  lineageId = '';
  key: Buffer = Buffer.alloc(0);
  openResult: ReplicaOpenResult | null = null;
  closed = true;
  readonly hwHint: string;

  constructor(
    readonly spec: DeviceSpec,
    readonly root: string,
    readonly sharedPath: string,
    clock: FakeClock,
  ) {
    this.dh = makeDeviceHost(path.join(root, 'devices', spec.name), spec, clock);
    this.dh.clock.offsetMs = spec.skewMs ?? 0;
    this.syncRoot = spec.syncRoot ?? path.join(root, 'devices', spec.name, 'sync');
    this.hwHint = spec.hwHint ?? crypto.createHash('sha256').update(`hw:${root}:${spec.name}`).digest('hex');
    this.deviceUuid = loadOrCreateDevice(this.syncRoot, this.hwHint, () => crypto.randomUUID()).deviceUuid;
    this.machineDir = machineDir(this.syncRoot, this.hwHint);
  }

  get mirror(): string {
    return this.spec.mirror ?? this.spec.name;
  }

  get name(): string {
    return this.spec.name;
  }

  get host() {
    return this.dh.host;
  }

  get logger() {
    return this.dh.t.logger;
  }

  get events() {
    return this.dh.t.events;
  }

  get fs() {
    return this.dh.t.fs;
  }

  now(): number {
    return this.dh.clock.now();
  }

  /** A brand-new vault's seed (password based, this device's kdf). */
  newVault(password = 'pw'): NewVault & { readonly seed: ReplicaSeed } {
    const lineageId = crypto.randomUUID();
    const salt = crypto.randomBytes(32).toString('base64');
    const key = this.host.kdf.deriveKey(password, salt);
    const verification = makeVerificationToken(deriveEpochKeys(key, lineageId), (n) => crypto.randomBytes(n));
    return { lineageId, key, salt, password, seed: { kind: 'new-vault', salt, verification, vaultId: crypto.randomUUID() } };
  }

  async bindingFor(fileId: string | null): Promise<FileBinding> {
    const b = await newBinding(this.sharedPath, this.host);
    return fileId === null ? b : { ...b, fileId };
  }

  /** openReplica + assembleSyncEngine + side-file observation (7.2 step 6). */
  async open(lineageId: string, key: Buffer, seed: ReplicaSeed, binding: FileBinding | null): Promise<ReplicaOpenResult> {
    this.lineageId = lineageId;
    this.key = key;
    const input = { syncRoot: this.syncRoot, machineDir: this.machineDir, deviceUuid: this.deviceUuid, lineageId, key, seed, binding };
    const res = await openReplica(input, { host: this.host, incarnations: this.registry, verifyCommits: true });
    this.openResult = res;
    this.closed = false;
    this.replica = res.replica;
    this.wc = this.dh.t.workingCopy.last();
    this.engine = assembleSyncEngine({ host: this.host, replica: this.replica, session: this.session, realpath: this.sharedPath });
    const parts = this.engine.parts();
    parts.sideFiles.observe(await statSideFileTuples(this.sharedPath, this.host.fs));
    if (res.notices.length > 0) parts.notices.addFromCapture(res.notices);
    return res;
  }

  /** 7.2 steps 7 and 8: the unlock cycle, the session-open presence, then start. */
  async unlock(runCycle = true, start = this.spec.start !== false): Promise<CycleOutcome | null> {
    const first = runCycle ? await this.engine.runCycle('unlock') : null;
    const parts = this.engine.parts();
    writePresence(
      { host: this.host, replica: this.replica, sideFiles: parts.sideFiles },
      { sessionOpen: true, sessionSinceMs: this.now(), fileHint: parts.binding.fileHint() },
    );
    if (start) this.engine.start();
    await this.engine.whenIdle();
    return first;
  }

  /** One cycle now (as the watcher would trigger it). */
  sync(): Promise<CycleOutcome> {
    return this.engine.runCycle('shared-changed');
  }

  async idle(): Promise<void> {
    await this.engine.whenIdle();
  }

  /** Lock: final cycle (3 s cap), stop, close W. */
  async lock(): Promise<FinalOutcome> {
    this.session.open = false;
    const out = await this.engine.finalCycle('lock');
    await this.engine.stop();
    this.replica.close();
    this.closed = true;
    return out;
  }

  /** Quit without a final cycle (crash or kill). */
  async crash(): Promise<void> {
    await this.engine.stop();
    this.replica.close();
    this.closed = true;
  }

  /** A new app launch (new incarnation registry) opening the existing W. */
  async relaunch(runCycle = true, start = this.spec.start !== false): Promise<CycleOutcome | null> {
    this.registry = new IncarnationRegistry();
    this.session.open = true;
    await this.open(this.lineageId, this.key, { kind: 'existing' }, null);
    return this.unlock(runCycle, start);
  }

  // ---------- edits on W (ConduitVault's hook contract) ----------

  mutate(write: (db: Database.Database) => void, rows: readonly RowKey[], interactive = true): void {
    this.wc.mutate(write, { rows, interactive });
  }

  private iso(): string {
    return isoOf(this.now());
  }

  private secretKey(): Buffer {
    return this.replica.ring().current.kEpoch;
  }

  insert(e: EntrySpec): void {
    this.mutate((db) => insertEntry(db, e, this.iso(), this.secretKey()), [entryKey(e.id)]);
  }

  update(id: string, patch: Row, interactive = true): void {
    this.mutate((db) => updateEntry(db, id, patch, this.iso(), this.secretKey()), [entryKey(id)], interactive);
  }

  remove(ids: readonly string[]): void {
    this.mutate((db) => deleteEntries(db, ids), ids.map(entryKey));
  }

  addFolder(f: FolderSpec): void {
    this.mutate((db) => insertFolder(db, f, this.iso()), [folderKey(f.id)]);
  }

  updateFolder(id: string, patch: Row): void {
    this.mutate((db) => updateFolder(db, id, patch, this.iso()), [folderKey(id)]);
  }

  /** Recursive folder delete in one operation (one dot). */
  deleteFolder(id: string): void {
    let rows: RowKey[] = [];
    this.wc.db.transaction(() => {
      const res = deleteFolderRecursive(this.wc.db, id);
      rows = [...res.folders.map(folderKey), ...res.entries.map(entryKey)];
      this.wc.hooks?.captureInTransaction({ rows, interactive: true });
    })();
    this.wc.hooks?.afterCommit({ rows, interactive: true });
  }

  /** Explicit register writes (resolutions, restores) under one interactive dot. */
  write(writes: readonly LocalWrite[]): void {
    this.replica.applyWrites(writes, { interactive: true });
  }

  // ---------- reads ----------

  state(): SyncState {
    return this.replica.state();
  }

  row(id: string): Row | undefined {
    return entryRow(this.wc.db, id);
  }

  live(id: string, tbl: 1 | 2 = TBL.entries): boolean {
    return rowLife(this.state(), { tbl, rowId: id }) === 'live';
  }

  conflicts(): ConflictGroup[] {
    const local = this.replica.local();
    return listConflicts(this.state(), {
      implicit: this.replica.implicit(),
      structural: this.replica.structural(),
      snoozed: new Set(local.snoozed.map((s) => s.key)),
      candidateLabels: new Map(Object.entries(local.candidateLabels).map(([k, v]) => [Number(k), v] as const)),
      repairedKeys: new Set(local.notices.flatMap((n) => (n.kind === 'invariant-repair' && n.key !== null ? [regKeyStr(n.key)] : []))),
      keys: this.replica.ring(),
    });
  }

  status() {
    return this.engine.parts().status.snapshot();
  }

  toasts(kind?: string): string[] {
    return this.events
      .of('sync:notice')
      .filter((e) => !e.persisted && (kind === undefined || e.notice.kind === kind))
      .map((e) => e.notice.kind);
  }
}
