/**
 * The app's facade over personal-vault sync (spec 5.11, 6.3, 6.4, 6.6, 7.x, 11.2):
 * owns the per-launch identity (device.json, session nonce, incarnation registry), the Electron
 * hosts, the dev device-limit override, and the one open PersonalVaultRuntime with its engine.
 * The nine unlock paths call openPersonalVault; lock, quit and sign-out run the bounded release
 * points; IPC reaches review and file actions through engineVault() (app-sync-review.ts,
 * app-sync-actions.ts); password change, backup snapshot and rename are in app-sync-flows.ts.
 * Integration layer: it may import vault-session, the engine never does. Team vaults never come
 * here.
 */

import path from 'node:path';
import {
  openPersonalVault,
  type OpenDeps,
  type OpenedPersonalVault,
  type OpenPersonalVaultInput,
  type OpenProgress,
  type UnlockSource,
} from '../vault-session/open-personal-vault.js';
import { resolveVaultLocation } from '../vault-session/open-location.js';
import { QUIT_RELEASE_TIMEOUT_MS } from '../vault-session/session-client.js';
import type { ConflictChoice, PersonalVaultRuntime } from '../vault-session/session-runtime.js';
import {
  createElectronSessionHost,
  createFocusTracker,
  type BusySources,
  type FocusTracker,
  type SupabaseSource,
} from '../vault-session/host-electron.js';
import type { SessionHost, VaultAccessHost } from '../vault-session/host.js';
import { createConsoleLogger, nodeRandom } from './host-node.js';
import { createElectronSyncHost, sendToAll, allWindows, type AuthSource, type SyncableVault, type WindowList } from './host-electron.js';
import { PERSONAL_SYNC_SETTING, personalSyncEnabled, type SettingsSource } from './host-electron-settings.js';
import { SYNC_LOG_PREFIX, type SyncHost, type SyncLogger, type WaitingState } from './host.js';
import { FINAL_CYCLE_CAP_MS } from './sync-engine.js';
import { hasConflict } from './conflicts.js';
import { TBL } from './types.js';
import { loadLaunchIdentity, type LaunchIdentity } from './app-sync-identity.js';
import { openInPlace } from './app-sync-open.js';
import { devDeviceLimitOverride, devLimitCollaborators } from './app-sync-dev.js';
import { exportClosedLineage, lineageForPath, pendingVaults, type LineageLookupDeps } from './app-sync-lineage.js';
import { exportUnsynced as exportOpen, sideFileTuples } from './app-sync-actions.js';
import { changeEnginePassword, renameEngineShared, snapshotEngineVault } from './app-sync-flows.js';
import { InvalidSyncRequest, requireString } from './app-sync-dto-map.js';
import type { EngineVault } from './app-sync-review.js';
import type * as Dto from './app-sync-dto.js';
import { OPEN_IN_PROGRESS_MESSAGE, VaultSlot } from './app-sync-slot.js';
import { OwnCopyTickets } from '../vault-session/own-copy-tickets.js';
import { makeOwnCopy } from './app-sync-own-copy.js';
import { followSharedPath, type SharedPathChange } from './app-sync-binding.js';

/** Event sent while an unlock waits for the cloud drive (4.4 G1), before the vault is open. */
export const OPEN_WAITING_EVENT = 'sync:open-waiting';
/** User-facing error when a sync action needs an open, syncing vault. */
export const SYNC_NOT_RUNNING_MESSAGE = 'Sync is not running for this vault. Unlock it and try again.';
export { OPEN_IN_PROGRESS_MESSAGE, VAULT_ALREADY_OPEN_MESSAGE } from './app-sync-slot.js';
export { WRONG_CURRENT_PASSWORD_MESSAGE } from './app-sync-flows.js';
/** before-quit: final cycle cap + release timeout + a margin for teardown. */
export const QUIT_FLUSH_CAP_MS = FINAL_CYCLE_CAP_MS + QUIT_RELEASE_TIMEOUT_MS + 1000;

export interface SettingsStore extends SettingsSource {
  /** Merge `patch` into settings.json (readSettings + writeSettings). */
  update(patch: Readonly<Record<string, unknown>>): void;
}

export interface AppSyncManagerDeps {
  readonly isPackaged: boolean;
  readonly appVersion: string;
  /** env-config getDataDir(). */
  readonly dataDir: string;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** AppState.vault at call time (the personal ConduitVault). */
  readonly vault: () => SyncableVault;
  /** AppState.authService. */
  readonly auth: AuthSource & SupabaseSource;
  readonly settings: SettingsStore;
  readonly busy: BusySources;
  /** Soft lock and in-place opens (main-process vault IPC module). */
  readonly access: VaultAccessHost;
  readonly windows?: WindowList;
  readonly logger?: SyncLogger;
  /** The open vault's shared file moved (rebind, Locate, rename): the app's vault path follows. */
  readonly onSharedPathChanged?: (change: SharedPathChange) => void;
}

export interface PersonalOpenRequest {
  readonly path: string;
  readonly password: string;
  readonly previousPassword?: string | null;
  readonly source: UnlockSource;
  readonly takeover?: boolean;
  readonly create?: boolean;
  readonly recoverWorkingCopy?: boolean;
}

export interface PersonalOpenOutcome {
  readonly lineageId: string;
  readonly shared: boolean;
  /** The merge engine runs for this vault. */
  readonly engine: boolean;
  readonly firstCyclePending: boolean;
}

interface Started {
  readonly identity: LaunchIdentity;
  readonly syncHost: SyncHost;
  readonly sessionHost: SessionHost;
  readonly focus: FocusTracker;
  readonly devLimit: number | null;
  readonly lookup: LineageLookupDeps;
}

export class AppSyncManager {
  private started: Started | null = null;
  private readonly slot: VaultSlot<OpenedPersonalVault>;
  private openedPath: string | null = null;
  private continueWaiters: (() => void)[] = [];
  /** Lineages whose unsynced changes were exported this launch (5.11 turn-off rule). */
  private readonly exported = new Set<string>();
  private readonly logger: SyncLogger;
  /** "Make my own copy" keys (memory only), cleared on lock, sign-out and quit. */
  private readonly tickets = new OwnCopyTickets();

  constructor(private readonly deps: AppSyncManagerDeps) {
    this.logger = deps.logger ?? createConsoleLogger();
    this.slot = new VaultSlot(this.logger);
  }

  /** The open or soft-locked vault (null while opening or closing). */
  private get opened(): OpenedPersonalVault | null {
    return this.slot.current();
  }

  /** Once, after app 'ready' (powerMonitor and window events need it). */
  start(): void {
    if (this.started !== null) return;
    const { deps, logger } = this;
    const identity = loadLaunchIdentity({
      dataDir: deps.dataDir,
      platform: process.platform,
      home: deps.home,
      env: deps.env,
      appVersion: deps.appVersion,
      nowMs: Date.now(),
      randomUuid: () => nodeRandom.uuid(),
      logger,
    });
    const syncHost = createElectronSyncHost({ ...deps, firstLaunchMs: () => identity.firstLaunchMs, logger });
    const focus = createFocusTracker(syncHost.clock, logger);
    const sessionHost = createElectronSessionHost(syncHost, { supabase: deps.auth, settings: deps.settings, busy: deps.busy, access: deps.access, focus, windows: deps.windows });
    focus.onFocus(() => this.triggerFocus());
    sessionHost.power.onResume(() => this.triggerFocus());
    const lookup: LineageLookupDeps = {
      machineDir: identity.machineDir,
      stagingDir: path.join(identity.syncRoot, 'tmp'),
      replicaDeps: { host: syncHost, incarnations: identity.incarnations },
      host: syncHost,
    };
    this.started = { identity, syncHost, sessionHost, focus, devLimit: devDeviceLimitOverride(deps.isPackaged, deps.env, logger), lookup };
    logger.info(`${SYNC_LOG_PREFIX} sync manager started`, { enabled: this.isEnabled() });
  }

  /** settings personal_sync_enabled (on by default; no UI, support can turn it off). */
  isEnabled(): boolean {
    try {
      return personalSyncEnabled(this.deps.settings.read());
    } catch (err) {
      this.logger.warn(`${SYNC_LOG_PREFIX} settings unreadable; sync stays on`, { name: (err as Error)?.name ?? 'Error' });
      return true;
    }
  }

  /**
   * The vault at `vaultPath` would be engine-managed once opened (shared, sync on). Restores
   * use it to refuse a whole-file replace that the next merge would undo (5.10).
   */
  async syncsWhenOpened(vaultPath: string): Promise<boolean> {
    if (!this.isEnabled()) return false;
    const s = this.requireStarted();
    const loc = await resolveVaultLocation(requireString(vaultPath, 'vault path'), { host: s.sessionHost, config: s.identity.config });
    return loc.shared;
  }

  // ---------- Open, lock, quit ----------

  /**
   * Replaces the body of all nine personal unlock paths. Errors keep openPersonalVault's
   * messages; a lock or quit during the open ends it with OPEN_CANCELLED_MESSAGE.
   */
  async openPersonalVault(req: PersonalOpenRequest): Promise<PersonalOpenOutcome> {
    const s = this.requireStarted();
    // Refused before the try: the finally below would answer the running open's waits.
    if (this.slot.isOpening()) throw new Error(OPEN_IN_PROGRESS_MESSAGE);
    const input: OpenPersonalVaultInput = {
      path: requireString(req.path, 'vault path'),
      password: req.password,
      previousPassword: req.previousPassword ?? null,
      source: req.source,
      takeover: req.takeover === true,
      create: req.create === true,
      recoverWorkingCopy: req.recoverWorkingCopy === true,
    };
    const openDeps: OpenDeps = {
      host: s.sessionHost,
      config: s.identity.config,
      progress: this.progress(),
      incarnations: s.identity.incarnations,
      tickets: this.tickets,
      collaborators: devLimitCollaborators(s.devLimit),
    };
    try {
      const opened = await this.slot.open(() => (this.isEnabled() ? openPersonalVault(input, openDeps) : openInPlace(input, openDeps)));
      this.openedPath = path.resolve(input.path);
      this.followBinding(opened);
      return { lineageId: opened.lineageId, shared: opened.shared, engine: opened.engine !== null, firstCyclePending: opened.firstCyclePending };
    } finally {
      this.releaseContinueWaiters();
    }
  }

  /**
   * 6.4 lock: final cycle (3 s), presence closed, release, W closed (ConduitVault.lock). An open
   * in progress is cancelled and closed first; a displaced save in progress is awaited.
   */
  async lock(): Promise<void> {
    this.tickets.clear();
    await this.slot.close('lock');
    this.logger.info(`${SYNC_LOG_PREFIX} vault locked`);
  }

  /**
   * 6.4 before-quit: the same flush and release, never longer than QUIT_FLUSH_CAP_MS. The focus
   * tracker stays armed: a failed update install keeps the app running.
   */
  async quit(): Promise<void> {
    this.tickets.clear();
    if (!this.slot.isBusy()) return;
    let timer: NodeJS.Timeout | undefined;
    const cap = new Promise<'cap'>((resolve) => {
      timer = setTimeout(() => resolve('cap'), QUIT_FLUSH_CAP_MS);
    });
    try {
      const res = await Promise.race([this.slot.close('quit'), cap]);
      if (res === 'cap') this.logger.warn(`${SYNC_LOG_PREFIX} quit flush hit its cap; unsynced changes publish at the next unlock`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Opening, closing, open or soft-locked: a lock must run and before-quit must flush. */
  hasSession(): boolean {
    return this.slot.isBusy();
  }

  isOpening(): boolean {
    return this.slot.isOpening();
  }

  /** Signed out while a vault is open: release the lease; owner claims apply from now on. */
  async signedOut(): Promise<void> {
    this.tickets.clear();
    await this.opened?.runtime.signedOut();
  }

  // ---------- Current vault ----------

  isOpen(): boolean {
    return this.opened !== null && !this.opened.runtime.isSoftLocked();
  }

  isSoftLocked(): boolean {
    return this.opened?.runtime.isSoftLocked() ?? false;
  }

  /** The engine runs for the open vault (backups snapshot W; no file watcher or reloadFromDisk). */
  isEngineManaged(): boolean {
    return this.isOpen() && this.opened?.engine !== null;
  }

  currentLineageId(): string | null {
    return this.opened?.lineageId ?? null;
  }

  /** The open engine-managed vault, or a user-facing error. */
  engineVault(): EngineVault {
    const o = this.opened;
    if (o === null || o.engine === null || o.replica === null || o.runtime.isSoftLocked()) throw new Error(SYNC_NOT_RUNNING_MESSAGE);
    return { replica: o.replica, engine: o.engine };
  }

  runtime(): PersonalVaultRuntime {
    if (this.opened === null) throw new Error(SYNC_NOT_RUNNING_MESSAGE);
    return this.opened.runtime;
  }

  deviceLimit(): Dto.DeviceLimit | null {
    const o = this.opened;
    if (o === null) return null;
    const forced = this.started?.devLimit ?? null;
    if (forced !== null) return { limit: forced, source: 'dev-override' };
    const e = o.runtime.effectiveLimit();
    return { limit: e.limit, source: e.source };
  }

  async getState(): Promise<Dto.SyncStateResponse> {
    const s = this.requireStarted();
    const o = this.opened;
    const soft = o?.runtime.isSoftLocked() ?? false;
    const live = o !== null && !soft && o.engine !== null && o.replica !== null ? { engine: o.engine, replica: o.replica } : null;
    return {
      enabled: this.isEnabled(),
      killSwitch: s.syncHost.flags.personalSyncPaused(),
      vault: o === null ? null : this.vaultInfo(o, live !== null),
      status: live?.engine.parts().status.snapshot() ?? null,
      deviceLimit: this.deviceLimit(),
      sideFiles: live === null ? [] : sideFileTuples(live),
      notices: live?.replica.local().notices ?? [],
      pendingVaults: await pendingVaults(s.lookup),
      softLocked: soft,
      ownership: this.ownership(o, soft),
      deviceCap: o?.runtime.ownershipView().deviceCap ?? null,
    };
  }

  /** Plan enforcement 4.7: the runtime's last confirmed answer; 'unknown' signed out, soft-locked or unconfirmed. */
  private ownership(o: OpenedPersonalVault | null, soft: boolean): Dto.VaultOwnership | null {
    if (o === null) return null;
    const view = o.runtime.ownershipView();
    const signedIn = this.started?.syncHost.account.userId() !== null;
    if (!signedIn || soft || !view.confirmed || view.ownership === null) return { kind: 'unknown' };
    return view.ownership;
  }

  /** Sync settings [Release this vault...]: vault_owner_release for the open vault. */
  releaseOwnership(): Promise<Dto.ReleaseOwnershipResult> {
    if (this.opened === null || this.opened.runtime.isSoftLocked()) throw new Error(SYNC_NOT_RUNNING_MESSAGE);
    return this.opened.runtime.releaseOwnership();
  }

  /** S4 [Make my own copy]: forks the refused vault with the ticket's key into `targetPath`. */
  makeOwnCopy(ticket: string, targetPath: string): Promise<Dto.ForkResultDto> {
    const s = this.requireStarted();
    return makeOwnCopy(requireString(ticket, 'ticket'), targetPath, {
      tickets: this.tickets,
      machineDir: s.identity.machineDir,
      workDir: path.join(s.identity.syncRoot, 'tmp'),
      host: s.syncHost,
    });
  }

  private vaultInfo(o: OpenedPersonalVault, engine: boolean): Dto.OpenVaultInfo {
    const p = this.openedPath ?? '';
    return { lineageId: o.lineageId, path: p, fileName: path.basename(p), shared: o.shared, engine };
  }

  /** MCP entry_info / credential_read has_conflict (7.2). */
  hasConflictForEntry(entryId: string): boolean {
    if (!this.isEngineManaged()) return false;
    const v = this.engineVault();
    return hasConflict(v.replica.state(), { tbl: TBL.entries, rowId: entryId }, v.replica.implicit());
  }

  // ---------- Waits and session answers ----------

  /** [Open now]: ends a stale-file wait, or continues a first-open wait (G1). */
  openNow(): void {
    if (this.slot.isOpening()) this.releaseContinueWaiters();
    else this.opened?.runtime.openNow();
  }

  async stopWaiting(deviceId: unknown): Promise<void> {
    await this.runtime().stopWaiting(requireString(deviceId, 'device'));
  }

  /** 6.8 reconnect conflict: [Use here instead] or [Lock here]. */
  async answerConflict(choice: ConflictChoice): Promise<void> {
    await this.runtime().answerConflict(choice);
  }

  // ---------- Turning sync off (5.11; support only, no UI) ----------

  /** Takes effect at the next unlock. Turning off is refused while changes exist only on this device. */
  async setEnabled(enabled: unknown): Promise<Dto.SetEnabledResult> {
    if (typeof enabled !== 'boolean') throw new InvalidSyncRequest('enabled');
    const s = this.requireStarted();
    if (!enabled) {
      const pending = (await pendingVaults(s.lookup)).filter((p) => !this.exported.has(p.lineageId));
      const held = this.isEngineManaged() ? this.engineVault().replica.local().heldLegacy.length : 0;
      if (pending.length > 0 || held > 0) return { ok: false, reason: 'pending', pendingVaults: pending, heldChanges: held };
    }
    this.deps.settings.update({ [PERSONAL_SYNC_SETTING]: enabled });
    this.logger.info(`${SYNC_LOG_PREFIX} multi-device sync setting changed`, { enabled });
    return { ok: true, enabled };
  }

  /** [Export unsynced changes]: the open vault's W, or a closed lineage's (sync off). Returns the file. */
  async exportUnsynced(lineageId?: unknown): Promise<string> {
    const s = this.requireStarted();
    const id = lineageId === undefined || lineageId === null ? this.currentLineageId() : requireString(lineageId, 'vault');
    if (id === null) throw new InvalidSyncRequest('no vault to export');
    const target = this.isEngineManaged() && id === this.currentLineageId() ? await exportOpen(this.engineVault()) : await exportClosedLineage(id, s.lookup);
    this.exported.add(id);
    return target;
  }

  // ---------- Hooks for existing flows ----------

  /** vault_change_password on an engine-managed vault (4.8): one W transaction, new epoch. */
  changePassword(currentPassword: string, newPassword: string, eraseRecentlyDeleted: boolean): Promise<void> {
    return changeEnginePassword(this.engineVault(), currentPassword, newPassword, eraseRecentlyDeleted);
  }

  /** Cloud and local backups of an engine-managed vault: a VACUUM INTO snapshot of W at `target`. */
  snapshotForBackup(target: string): Promise<void> {
    return snapshotEngineVault(this.engineVault(), target, this.logger);
  }

  /** vault_rename on an engine-managed vault: renames S only and rebinds; returns the new path. */
  async renameShared(newFileName: string): Promise<string> {
    const sharedPath = await renameEngineShared(this.engineVault(), newFileName);
    this.openedPath = sharedPath;
    return sharedPath;
  }

  /** Biometric key lookup before unlock (5.9: keyed by lineage). */
  lineageForPath(vaultPath: string): Promise<string | null> {
    return lineageForPath(vaultPath, this.requireStarted().lookup);
  }

  // ---------- Internals ----------

  private followBinding(opened: OpenedPersonalVault): void {
    const binding = opened.engine?.parts().binding;
    if (!binding) return;
    followSharedPath(binding, () => (this.opened === opened ? this.openedPath : null), (change) => {
      this.openedPath = change.to;
      this.logger.info(`${SYNC_LOG_PREFIX} the open vault's shared file moved`, { file: path.basename(change.to) });
      this.deps.onSharedPathChanged?.(change);
    }, this.logger);
  }

  private requireStarted(): Started {
    // A start that failed at launch (disk full, unwritable data folder) is retried, so fixing the
    // cause needs no restart and its real error reaches the unlock screen.
    if (this.started === null) this.start();
    if (this.started === null) throw new Error(`${SYNC_LOG_PREFIX} the sync manager was not started`);
    return this.started;
  }

  private triggerFocus(): void {
    if (this.isEngineManaged()) this.opened?.engine?.trigger('focus');
  }

  private progress(): OpenProgress {
    return {
      waiting: (state: WaitingState | null) => sendToAll(this.deps.windows ?? allWindows, this.logger, OPEN_WAITING_EVENT, { waiting: state }),
      continueRequested: () => new Promise<void>((resolve) => this.continueWaiters.push(resolve)),
      cancelRequested: () => this.slot.cancelRequested(),
    };
  }

  private releaseContinueWaiters(): void {
    const waiters = this.continueWaiters;
    this.continueWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
