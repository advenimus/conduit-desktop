// Simulated device for the core end-to-end test: a working copy built by genesis from a real
// ConduitVault file, local edits through ConduitVault plus capture-local, publishing with
// VACUUM INTO, and the sync cycle of spec 5.6 without transport, leases or UI. Shapes and file
// helpers live in core-e2e-io.ts.
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ConduitVault } from '../../vault/vault.js';
import { deriveKey } from '../../vault/crypto.js';
import { applyLocalWrites, captureFullPass } from '../capture-local.js';
import { captureLegacy } from '../capture-legacy.js';
import { digestState } from '../digest.js';
import { genesisFromContent } from '../genesis.js';
import { deriveDev, deriveEpochKeys, makeImplicitProvider } from '../hashing.js';
import { HlcClock, maxReceivable, ownStamps, startHlc } from '../hlc.js';
import { detectDevCollision, newIncarnation } from '../identity.js';
import {
  alignEpoch,
  decideUnlock,
  linkMissingWrap,
  redactSuperseded,
  reencryptState,
  requireCurrentEpoch,
  ringOverStates,
  type AlignResult,
} from '../key-epoch.js';
import { materialize } from '../materialize.js';
import { merge } from '../merge.js';
import { absorbLegacyPasswordChange, changePassword } from '../rekey.js';
import { ensureSyncSchema } from '../schema.js';
import { StateBuilder, recoveryFrom } from '../state-view.js';
import { loadContent, loadFile, saveState } from '../state-store.js';
import type {
  AppDot,
  CaptureResult,
  EpochKeys,
  ImplicitProvider,
  KeyRing,
  LoadedFile,
  LocalWrite,
  MaterializeResult,
  StructuralConflict,
  SyncContext,
  SyncState,
  UnlockDecision,
} from '../types.js';
import {
  INCOMING_DIR,
  publishFile,
  readSharedFile,
  ringOf,
  type DeviceOptions,
  type SharedFile,
  type SyncOutcome,
} from './core-e2e-io.js';

export type { DeviceOptions, LegacySource, SharedFile, SyncOutcome } from './core-e2e-io.js';

const SALT_BYTES = 32;


export class SimDevice {
  readonly name: string;
  readonly deviceUuid: string;
  readonly dir: string;
  readonly wPath: string;
  readonly db: Database.Database;
  readonly vault: ConduitVault;
  readonly dev: number;
  /** Digest of the pure genesis result, before this device recorded its own dev. */
  readonly genesisDigest: string;
  private readonly incarnation: string;
  private readonly lineageId: string;
  private readonly now: () => number;
  private readonly clock: HlcClock;
  private ring: KeyRing;
  private loaded: LoadedFile;
  private lastStructural: readonly StructuralConflict[] = [];

  /** G1 on a copy of the legacy bytes: W = genesis state materialized over the file's content. */
  constructor(opts: DeviceOptions) {
    this.name = opts.name;
    this.now = opts.now;
    this.lineageId = opts.source.lineageId;
    this.deviceUuid = crypto.randomUUID();
    this.dir = path.join(opts.root, opts.name);
    fs.mkdirSync(path.join(this.dir, INCOMING_DIR), { recursive: true });
    this.wPath = path.join(this.dir, 'w.conduit');
    fs.writeFileSync(this.wPath, opts.source.bytes);
    this.db = new Database(this.wPath);
    this.db.pragma('foreign_keys = ON');
    ensureSyncSchema(this.db);
    this.ring = ringOf(deriveEpochKeys(opts.source.key, this.lineageId));
    this.incarnation = newIncarnation(crypto.randomBytes);
    this.dev = deriveDev(this.deviceUuid, this.lineageId, this.incarnation);
    const content = loadContent(this.db);
    const g = genesisFromContent({
      content,
      genesisId: opts.source.genesisId,
      lineageId: this.lineageId,
      k0: this.ring.current,
      randomBytes: crypto.randomBytes,
      now: this.now,
    });
    this.genesisDigest = digestState(g.state);
    const b = new StateBuilder(g.state);
    b.addDev({ dev: this.dev, deviceUuid: this.deviceUuid, startedMs: this.now() });
    const m = this.materializeOver(b.build(), g.cache);
    saveState(this.db, { state: m.state, plan: m.plan, cache: m.cache, baseline: null });
    this.loaded = loadFile(this.db);
    this.clock = new HlcClock(this.now, startHlc(this.now(), ownStamps(this.loaded.state, this.deviceUuid)));
    this.vault = new ConduitVault(this.wPath);
    this.vault.unlockWithKey(opts.source.key);
  }

  get state(): SyncState {
    return this.loaded.state;
  }

  get keys(): KeyRing {
    return this.ring;
  }

  get ctx(): SyncContext {
    return {
      deviceUuid: this.deviceUuid,
      lineageId: this.lineageId,
      dev: this.dev,
      incarnation: this.incarnation,
      keys: this.ring,
      now: this.now,
      randomBytes: crypto.randomBytes,
    };
  }

  get implicit(): ImplicitProvider {
    return makeImplicitProvider(this.ring.current.kSync);
  }

  get structural(): readonly StructuralConflict[] {
    return this.lastStructural;
  }

  tick(): AppDot {
    const h = this.clock.tick();
    return { dev: this.dev, ms: h.ms, c: h.c };
  }

  /** An app mutation on W through ConduitVault, captured with one new dot (4.2). */
  edit(mutate: (vault: ConduitVault) => void, interactive = false): CaptureResult {
    mutate(this.vault);
    const res = this.capture(interactive);
    if (res.changed) this.commit(res.state);
    return res;
  }

  /** Explicit register writes (resolutions, restores) as one interactive operation. */
  write(writes: readonly LocalWrite[]): CaptureResult {
    const att = { kind: 'local', dot: this.tick(), interactive: true } as const;
    const res = applyLocalWrites(this.state, writes, att, this.ctx, this.implicit);
    this.commit(res.state);
    return res;
  }

  /** 5.3 without the CAS and mtime rules: VACUUM INTO a temp file, then rename over S. */
  publish(sharedPath: string): void {
    publishFile(this.db, sharedPath);
  }

  /** One sync cycle against the shared file (5.6): full pass, absorb, align, collision check, merge. */
  sync(sharedPath: string): SyncOutcome {
    const prePassChanged = this.fullPass();
    const s = this.readShared(sharedPath);
    const absorbKeys = this.ring.byEpoch.get(requireCurrentEpoch(s.file.state, 'shared'));
    if (absorbKeys === undefined) return this.paused(alignEpoch(s.file.state, s.meta, this.state, this.ring));
    const absorbed = this.absorb(s, absorbKeys);
    const aligned = alignEpoch(absorbed.state, s.meta, this.state, this.ring);
    if (aligned.kind !== 'proceed') return this.paused(aligned);
    return this.mergeIn(this.state, aligned.state, { prePassChanged, absorbChanged: absorbed.changed });
  }

  /** New-build password change on this device (4.8), then a relock with the new key. */
  changePassword(newPassword: string): void {
    const saltBytes = crypto.randomBytes(SALT_BYTES);
    const newKey = deriveKey(newPassword, saltBytes);
    const input = {
      state: this.state,
      ring: this.ring,
      newKey,
      newSalt: saltBytes.toString('base64'),
      dot: this.tick(),
      eraseRecentlyDeleted: false,
    };
    const res = changePassword(input, this.ctx);
    this.ring = res.ring;
    this.commit(res.state);
    this.relock(newKey);
  }

  /**
   * "Enter the new password to keep syncing" (4.8, S newer): the unlock policy accepts it,
   * the new key must reach W's epoch through S's valid wraps, W is re-encrypted up to S's
   * epoch in memory (no new dots), then merged with S absorbed under its own epoch.
   */
  enterNewPassword(sharedPath: string, password: string): UnlockDecision {
    const s = this.readShared(sharedPath);
    const outcome = decideUnlock({
      lineageId: this.lineageId,
      deriveFromSalt: (salt) => deriveKey(password, Buffer.from(salt, 'base64')),
      w: this.state,
      s: { state: s.file.state, meta: s.meta },
    });
    if (!outcome.decision.ok || outcome.key === null) return outcome.decision;
    const next = deriveEpochKeys(outcome.key, this.lineageId);
    // This device is unlocked, so it holds W's key and can add the wrap a keyless absorb could not.
    const base =
      outcome.decision.via === 'needs-wrap'
        ? linkMissingWrap(this.state, s.file.state, next, this.ring.current, crypto.randomBytes)
        : this.state;
    const ring = ringOverStates(next, [s.file.state, base], this.lineageId);
    if (!ring.byEpoch.has(requireCurrentEpoch(base, 'working'))) {
      throw new Error(`${this.name}: the new key does not reach this device's epoch`);
    }
    const moved = reencryptState(base, ring, next).state;
    this.ring = ring;
    const absorbed = this.absorb(s, next, moved);
    const merged = merge(moved, absorbed.state, this.implicit).state;
    this.commit(redactSuperseded(merged, ring));
    this.relock(outcome.key);
    return outcome.decision;
  }

  /**
   * 4.8 legacy password change found in S (an older desktop changed the password in place):
   * absorbed with the new password, with or without the old key, then merged and committed.
   */
  adoptLegacyPasswordChange(sharedPath: string, newPassword: string, withOldKey: boolean): void {
    const s = this.readShared(sharedPath);
    if (s.meta.salt === null) throw new Error(`${this.name}: the shared file has no salt`);
    const newKey = deriveKey(newPassword, Buffer.from(s.meta.salt, 'base64'));
    const input = {
      s: s.file,
      w: this.state,
      newKey,
      oldRing: withOldKey ? this.ring : null,
      observedMtimeMs: s.mtimeMs,
      sourceSha256: s.sha256,
    };
    const res = absorbLegacyPasswordChange(input, this.ctx);
    this.ring = res.ring;
    this.commit(merge(res.w, res.s1, this.implicit).state);
    this.relock(newKey);
  }

  /** Opens W with a fresh ConduitVault and a typed password (checks materialized vault_meta). */
  opensWithPassword(password: string): boolean {
    const probe = new ConduitVault(this.wPath);
    try {
      probe.unlock(password);
      return true;
    } catch {
      return false;
    } finally {
      if (probe.isUnlocked()) probe.lock();
    }
  }

  /** The 5.6 pre-merge full capture pass; returns whether it recorded anything. */
  fullPass(): boolean {
    const res = this.capture(false);
    if (res.changed) this.commit(res.state);
    return res.changed;
  }

  close(): void {
    if (this.vault.isUnlocked()) this.vault.lock();
    if (this.db.open) this.db.close();
  }

  private capture(interactive: boolean): CaptureResult {
    const input = { state: this.state, content: loadContent(this.db), cache: this.loaded.cache, implicit: this.implicit };
    return captureFullPass(input, { kind: 'local', dot: this.tick(), interactive }, this.ctx);
  }

  private paused(align: AlignResult): SyncOutcome {
    if (align.kind === 'proceed') throw new Error(`${this.name}: no key for the shared file's epoch`);
    return { kind: 'paused', align };
  }

  private mergeIn(
    w: SyncState,
    s1: SyncState,
    flags: { readonly prePassChanged: boolean; readonly absorbChanged: boolean },
  ): SyncOutcome {
    const collision = detectDevCollision(s1, w, this.dev);
    if (collision.collided) throw new Error(`${this.name}: dev collision (${collision.reason})`);
    const merged = merge(w, s1, this.implicit);
    this.commit(merged.state);
    this.clock.receive(maxReceivable(this.state, this.now(), new Set([this.dev])));
    return {
      kind: 'merged',
      ...flags,
      upToDate: digestState(this.state) === digestState(s1),
      invariantViolations: merged.report.invariantViolations.length,
    };
  }

  /** capture(S, Legacy(S)) against S's own tables, under S's own epoch (4.3); W recovers vanished values. */
  private absorb(s: SharedFile, keys: EpochKeys, recoverFrom: SyncState = this.state): CaptureResult {
    const input = { state: s.file.state, content: s.file.content, cache: s.file.cache, implicit: makeImplicitProvider(keys.kSync) };
    const att = {
      kind: 'legacy',
      observedMtimeMs: s.mtimeMs,
      sideFilesPresent: false,
      serverSideFilesFlagRecent: false,
      absorbKeys: keys,
      sourceSha256: s.sha256,
      recover: recoveryFrom(recoverFrom),
    } as const;
    return captureLegacy(input, att, this.ctx);
  }

  /** 5.2: stage S's bytes into incoming/ and load the staged copy read-only. */
  private readShared(sharedPath: string): SharedFile {
    return readSharedFile(this.dir, sharedPath);
  }

  private materializeOver(state: SyncState, cache: LoadedFile['cache']): MaterializeResult {
    const epoch = state.epochs.get(requireCurrentEpoch(state, 'working')) ?? null;
    const m = materialize(state, loadContent(this.db), cache, { implicit: this.implicit, currentEpoch: epoch });
    this.lastStructural = m.structural;
    return m;
  }

  /** Materialize, save (diffed against what the file held) and reload; the reload must round-trip. */
  commit(state: SyncState): MaterializeResult {
    const m = this.materializeOver(state, this.loaded.cache);
    saveState(this.db, { state: m.state, plan: m.plan, cache: m.cache, baseline: this.loaded });
    this.loaded = loadFile(this.db);
    if (digestState(this.loaded.state) !== digestState(m.state)) {
      throw new Error(`${this.name}: the saved state does not load back identically`);
    }
    return m;
  }

  /** ConduitVault caches the key; secrets re-encrypted by sync need a fresh unlock. */
  private relock(key: Buffer): void {
    this.vault.lock();
    this.vault.unlockWithKey(key);
  }
}
