/**
 * The open replica of one lineage (spec 4.1, 4.2, 5.6 W.gen): the
 * in-memory W snapshot and generation, commits over W's single connection, the capture hooks
 * ConduitVault calls inside each mutator, the HLC, the high-water check, the key ring and
 * local.json. Built by replica-open.ts; import through replica.ts.
 */

import type Database from 'better-sqlite3';
import { applyLocalWrites, captureFullPass, captureRows } from './capture-local.js';
import { makeImplicitProvider } from './hashing.js';
import { HlcClock, maxReceivable } from './hlc.js';
import type { HighWaterVerdict } from './identity.js';
import { SYNC_LOG_PREFIX, type JournalMode, type VaultMutationInfo, type VaultSyncHooks, type WorkingCopyHandle } from './host.js';
import { writeLocalJson } from './local-state.js';
import type { LineagePaths } from './paths.js';
import { changePassword as rekeyChangePassword, verifyCurrentPassword } from './rekey.js';
import { ownVvReader, sameHlc } from './replica-commit.js';
import { ReplicaEvents } from './replica-events.js';
import { WorkingState } from './replica-memory.js';
import {
  NEW_SALT_BYTES,
  type ApplyOptions,
  type CommitOptions,
  type CommitOutcome,
  type IncarnationReason,
  type LineageIncarnation,
  type ReplicaDeps,
  type ReplicaInit,
  type ReplicaPort,
  type WorkingSnapshot,
} from './replica-types.js';
import { currentEpochId, rowKeyStr } from './state-view.js';
import { loadContent, loadContentRows } from './state-store.js';
import { SyncCoreError } from './types.js';
import type {
  AppDot,
  CaptureResult,
  Dev,
  Hlc,
  ImplicitProvider,
  KeyRing,
  LocalJson,
  LocalWrite,
  RowKey,
  StructuralConflict,
  SyncContext,
  SyncState,
} from './types.js';

export { INVALID_PASSWORD_MESSAGE } from './rekey.js';

function errName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

export class Replica implements ReplicaPort {
  readonly lineageId: string;
  readonly deviceUuid: string;
  readonly paths: LineagePaths;
  readonly journalMode: JournalMode;
  readonly handle: WorkingCopyHandle;
  private readonly deps: ReplicaDeps;
  private readonly db: Database.Database;
  private readonly readOwnVv: (dev: Dev) => Hlc | null;
  private readonly clock: HlcClock;
  private readonly events: ReplicaEvents;
  private readonly hookSet: VaultSyncHooks;
  private readonly work: WorkingState;
  private ringNow: KeyRing;
  private inc: LineageIncarnation;
  private localNow: LocalJson;
  private ctxCache: SyncContext | null = null;
  private implicitCache: ImplicitProvider | null = null;
  private closed = false;

  constructor(init: ReplicaInit) {
    this.lineageId = init.lineageId;
    this.deviceUuid = init.deviceUuid;
    this.paths = init.paths;
    this.journalMode = init.journalMode;
    this.handle = init.handle;
    this.deps = init.deps;
    this.db = init.handle.db;
    this.readOwnVv = ownVvReader(this.db);
    this.ringNow = init.ring;
    this.inc = init.incarnation;
    this.localNow = init.local;
    this.clock = new HlcClock(() => this.deps.host.clock.now(), init.clockStart);
    this.events = new ReplicaEvents(this.deps.host.logger);
    this.work = new WorkingState(
      {
        db: this.db,
        lineageId: this.lineageId,
        logger: this.deps.host.logger,
        verifyCommits: this.deps.verifyCommits === true,
        ringEpochId: () => this.ringNow.current.epochId,
        implicit: () => this.implicit(),
        saved: (state) => this.stampHighWater(state),
        contentChanged: (rows) => this.handle.contentChanged(rows),
        catchUp: () => this.catchUpSkippedWrites(),
      },
      init.snapshot,
      init.structural,
    );
    this.hookSet = {
      captureInTransaction: (m) => this.captureInTransaction(m),
      afterCommit: (m) => this.afterCommit(m),
      requestFullPass: (reason) => this.events.fullPassRequested(reason),
    };
  }

  // ---------- Accessors ----------

  database(): Database.Database {
    return this.open().db;
  }

  dev(): Dev {
    return this.open().inc.dev;
  }

  incarnation(): string {
    return this.open().inc.incarnation;
  }

  context(): SyncContext {
    this.open();
    this.ctxCache ??= {
      deviceUuid: this.deviceUuid,
      lineageId: this.lineageId,
      dev: this.inc.dev,
      incarnation: this.inc.incarnation,
      keys: this.ringNow,
      now: () => this.deps.host.clock.now(),
      randomBytes: (n) => this.deps.host.random.bytes(n),
    };
    return this.ctxCache;
  }

  ring(): KeyRing {
    return this.open().ringNow;
  }

  implicit(): ImplicitProvider {
    this.open();
    this.implicitCache ??= makeImplicitProvider(this.ringNow.current.kSync);
    return this.implicitCache;
  }

  current(): WorkingSnapshot {
    return this.open().work.snapshot();
  }

  state(): SyncState {
    return this.open().work.snapshot().state;
  }

  generation(): number {
    return this.open().work.generation();
  }

  structural(): readonly StructuralConflict[] {
    return this.open().work.structural();
  }

  epochAligned(): boolean {
    return currentEpochId(this.open().work.snapshot().state) === this.ringNow.current.epochId;
  }

  local(): LocalJson {
    return this.open().localNow;
  }

  hooks(): VaultSyncHooks {
    return this.hookSet;
  }

  onLocalCommit(listener: (m: VaultMutationInfo) => void): () => void {
    return this.events.onLocalCommit(listener);
  }

  onFullPassRequest(listener: (reason: string) => void): () => void {
    return this.events.onFullPassRequest(listener);
  }

  // ---------- Clock and identity ----------

  tick(): AppDot {
    this.open();
    const h = this.clock.tick();
    return { dev: this.inc.dev, ms: h.ms, c: h.c };
  }

  receive(merged: SyncState): void {
    this.open();
    const own = new Set<Dev>([this.inc.dev]);
    for (const rec of merged.devs.values()) if (rec.deviceUuid === this.deviceUuid) own.add(rec.dev);
    this.clock.receive(maxReceivable(merged, this.deps.host.clock.now(), own));
  }

  highWaterCheck(): HighWaterVerdict {
    this.open();
    const onDisk = this.readOwnVv(this.inc.dev);
    if (!sameHlc(onDisk, this.state().vv.get(this.inc.dev))) this.work.reload('own version vector differs from memory');
    const vv = new Map(onDisk === null ? [] : [[this.inc.dev, onDisk] as const]);
    const verdict = this.inc.highWater.checkWorking(vv, this.inc.dev);
    if (verdict === 'new-incarnation') this.startNewIncarnation('high-water');
    return verdict;
  }

  startNewIncarnation(reason: IncarnationReason): { readonly oldDev: Dev; readonly newDev: Dev } {
    this.open();
    const oldDev = this.inc.dev;
    this.inc = this.deps.incarnations.renew(this.lineageId, this.deviceUuid, this.deps.host.random);
    this.ctxCache = null;
    this.deps.host.logger.warn(`${SYNC_LOG_PREFIX} new incarnation for this lineage`, { reason });
    this.updateLocal((l) => ({ ...l, dev: this.inc.dev, incarnation: this.inc.incarnation }));
    return { oldDev, newDev: this.inc.dev };
  }

  // ---------- Captures and writes ----------

  fullPass(): CaptureResult {
    this.ready();
    this.highWaterCheck();
    const content = loadContent(this.db);
    const snap = this.work.snapshot();
    const att = { kind: 'local', dot: this.tick(), interactive: false } as const;
    const res = captureFullPass({ state: snap.state, content, cache: snap.cache, implicit: this.implicit() }, att, this.context());
    if (res.changed) {
      this.work.commit(res.state, { content });
      this.markPending();
    }
    return res;
  }

  applyWrites(writes: readonly LocalWrite[], opts: ApplyOptions): CaptureResult {
    this.ready();
    this.catchUpSkippedWrites();
    this.highWaterCheck();
    const att = { kind: 'local', dot: this.tick(), interactive: opts.interactive } as const;
    const options = opts.ruleR === undefined ? undefined : { ruleR: opts.ruleR };
    const res = applyLocalWrites(this.state(), writes, att, this.context(), this.implicit(), options);
    if (!res.changed && opts.fileId === undefined) return res;
    this.work.commit(res.state, opts.fileId === undefined ? {} : { fileId: opts.fileId });
    if (res.changed) {
      this.markPending();
      this.events.localCommitted({ rows: res.changedRows, interactive: opts.interactive });
    }
    return res;
  }

  changePassword(currentPassword: string, newPassword: string, eraseRecentlyDeleted: boolean): void {
    this.ready();
    verifyCurrentPassword(this.state(), this.ringNow, this.deps.host.kdf, currentPassword);
    this.catchUpSkippedWrites();
    this.highWaterCheck();
    const newSalt = this.deps.host.random.bytes(NEW_SALT_BYTES).toString('base64');
    const newKey = this.deps.host.kdf.deriveKey(newPassword, newSalt);
    const input = { state: this.state(), ring: this.ringNow, newKey, newSalt, dot: this.tick(), eraseRecentlyDeleted };
    const res = rekeyChangePassword(input, this.context());
    const previous = this.ringNow;
    this.setRing(res.ring, newKey);
    let out: CommitOutcome;
    try {
      out = this.commit(res.state);
    } catch (err) {
      this.setRing(previous, previous.current.kEpoch);
      throw err;
    }
    this.markPending();
    this.events.localCommitted({ rows: out.changedRows, interactive: true });
  }

  // ---------- Commits ----------

  commit(next: SyncState, opts: CommitOptions = {}): CommitOutcome {
    this.open().work.confirm();
    return this.work.commit(next, opts);
  }

  commitIfGeneration(next: SyncState, expected: number, opts: CommitOptions = {}): CommitOutcome | null {
    this.open().work.confirm();
    return this.work.commitIfGeneration(next, expected, opts);
  }

  commitWith(fn: (w: SyncState) => SyncState, opts: CommitOptions = {}): CommitOutcome {
    this.open().work.confirm();
    return this.work.commitWith(fn, opts);
  }

  setRing(ring: KeyRing, key: Buffer): void {
    this.open();
    this.handle.setKey(key);
    this.ringNow = ring;
    this.ctxCache = null;
    this.implicitCache = null;
  }

  updateLocal(fn: (l: LocalJson) => LocalJson): LocalJson {
    this.open();
    const next = fn(this.localNow);
    if (next === this.localNow) return next;
    try {
      writeLocalJson(this.paths.dir, next);
    } catch (err) {
      this.deps.host.logger.error(`${SYNC_LOG_PREFIX} writing local.json failed`, { name: errName(err) });
      throw err;
    }
    this.localNow = next;
    return next;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.events.clear();
    try {
      this.handle.setHooks(null);
    } finally {
      this.handle.close();
    }
  }

  // ---------- Internals ----------

  private open(): this {
    if (this.closed) throw new Error(`${SYNC_LOG_PREFIX} replica closed`);
    return this;
  }

  /** Open, confirmed with the disk, and W's epoch is the ring's (captures encrypt with the ring). */
  private ready(): void {
    this.open().work.confirm();
    if (!this.epochAligned()) {
      throw new SyncCoreError('KEY_MISMATCH', `${SYNC_LOG_PREFIX} the working copy is not in the key ring's epoch yet`);
    }
  }

  /** 4.2 step 6: a full pass in the same synchronous section as any non-capture commit (not while W is out of the ring's epoch). */
  private catchUpSkippedWrites(): boolean {
    if (!this.epochAligned()) return false;
    return this.fullPass().changed;
  }

  private stampHighWater(state: SyncState): void {
    const mine = state.vv.get(this.inc.dev);
    if (mine !== undefined) this.inc.highWater.stamp({ dev: this.inc.dev, ms: mine.ms, c: mine.c });
  }

  private markPending(): void {
    if (this.localNow.pendingPublish) return;
    try {
      this.updateLocal((l) => ({ ...l, pendingPublish: true }));
    } catch (err) {
      // The change is committed in W; pending_publish is only a hint (5.11), so the edit stands.
      this.deps.host.logger.warn(`${SYNC_LOG_PREFIX} pending_publish could not be recorded`, { name: errName(err) });
    }
  }

  // ---------- Hooks (called by ConduitVault around each mutator) ----------

  private captureInTransaction(m: VaultMutationInfo): void {
    this.open();
    try {
      if (!this.epochAligned()) {
        throw new SyncCoreError('KEY_MISMATCH', `${SYNC_LOG_PREFIX} capture refused: the working copy key epoch is not aligned yet`);
      }
      this.work.confirm();
      this.highWaterCheck();
      const dot = this.tick();
      const content = loadContentRows(this.db, m.rows);
      const snap = this.work.snapshot();
      const input = { state: snap.state, content, cache: snap.cache, implicit: this.implicit() };
      const res = captureRows(input, m.rows, { kind: 'local', dot, interactive: m.interactive }, this.context());
      if (!res.changed) {
        this.work.bump();
        this.events.captured(false, []);
        return;
      }
      const out = this.work.commit(res.state, { capturedRows: res.scope ?? m.rows, content, notify: false });
      const own = new Set(m.rows.map(rowKeyStr));
      this.events.captured(true, out.changedRows.filter((r: RowKey) => !own.has(rowKeyStr(r))));
    } catch (err) {
      this.deps.host.logger.error(`${SYNC_LOG_PREFIX} capture failed; the mutation is rolled back`, { name: errName(err) });
      throw err;
    }
  }

  private afterCommit(m: VaultMutationInfo): void {
    if (this.closed) return;
    this.work.confirmed();
    const pending = this.events.takeCaptured();
    if (!pending.changed) return;
    if (pending.extraRows.length > 0) this.handle.contentChanged(pending.extraRows);
    this.markPending();
    this.events.localCommitted(m);
  }
}
