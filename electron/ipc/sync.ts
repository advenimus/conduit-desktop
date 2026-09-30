/**
 * IPC channels of personal-vault sync (docs/MULTI_DEVICE_SYNC.md 11.1): status, Sync now,
 * devices, other copies, side files, file binding, export, turning sync off (support only, no
 * UI), the password flows after a change on another device, the device-session answers, and
 * vault ownership (release, "Make my own copy"; docs/PLAN_ENFORCEMENT.md 4.5, 4.7).
 * Review channels are in sync-review.ts. Every channel takes one argument object, validated here and again in the
 * sync layer; errors reach the renderer as short text (sync-errors.ts).
 */

import path from 'node:path';
import { ipcMain, shell } from 'electron';
import * as actions from '../services/sync/app-sync-actions.js';
import type { AppSyncManager } from '../services/sync/app-sync-manager.js';
import type { EngineVault } from '../services/sync/app-sync-review.js';
import type * as Dto from '../services/sync/app-sync-dto.js';
import { AppState } from '../services/state.js';
import {
  optionalBoolean,
  optionalPassword,
  optionalString,
  requireBoolean,
  requireFilePath,
  requireList,
  requirePassword,
  requireString,
  requireVaultTarget,
  oneOf,
  type IpcArgs,
} from './sync-args.js';
import { handleChannel, UserFacingError, type ChannelHandler, type IpcRegistrar } from './sync-errors.js';
import { applyVaultPasswordChange } from './sync-password.js';

export type AppSyncFacade = Pick<
  AppSyncManager,
  | 'getState'
  | 'engineVault'
  | 'runtime'
  | 'exportUnsynced'
  | 'setEnabled'
  | 'answerConflict'
  | 'stopWaiting'
  | 'openNow'
  | 'releaseOwnership'
  | 'makeOwnCopy'
>;

export interface SyncIpcDeps {
  appSync(): AppSyncFacade;
  /** The vault password changed through a sync flow: backups, chat store, biometric follow. */
  passwordChanged(password: string): Promise<void>;
  showItemInFolder(filePath: string): void;
  /** The open vault was released: a saved unlock and startup choice for it go (docs/AUTO_UNLOCK.md 3.7). */
  released?(): void;
  /** Make my own copy succeeded: the startup choice moves to the copy. */
  ownCopyMade?(copy: Dto.ForkResultDto): void;
}

export const COPY_ACTIONS: readonly Dto.CopyAction[] = ['trash', 'ignore', 'review', 'merge', 'separate'];
export const COPY_GONE_MESSAGE = 'That copy is no longer next to the vault. Check for copies again.';

function defaultDeps(): SyncIpcDeps {
  const state = AppState.getInstance();
  return {
    appSync: () => state.appSync,
    passwordChanged: (password) => applyVaultPasswordChange(state, password),
    showItemInFolder: (filePath) => shell.showItemInFolder(filePath),
    released: () => void followOwnership((l, d) => l.afterRelease(d, state.currentVaultPath)),
    ownCopyMade: (copy) => void followOwnership((l, d) => l.afterOwnCopy(d, state.currentVaultPath, copy)),
  };
}

type Lifecycle = typeof import('./auto-unlock-lifecycle.js');
type LifecycleDepsOf = import('./auto-unlock-lifecycle.js').LifecycleDeps;

async function followOwnership(run: (l: Lifecycle, d: LifecycleDepsOf) => void): Promise<void> {
  try {
    const [lifecycle, { lifecycleDeps }] = await Promise.all([import('./auto-unlock-lifecycle.js'), import('./startup-vault.js')]);
    run(lifecycle, lifecycleDeps());
  } catch (err) {
    console.warn('[sync] startup vault follow-up failed', { name: err instanceof Error ? err.name : 'Error' });
  }
}

async function releaseOwnership(deps: SyncIpcDeps): Promise<Dto.ReleaseOwnershipResult> {
  const res = await deps.appSync().releaseOwnership();
  if (res.released) deps.released?.();
  return res;
}

async function makeOwnCopy(deps: SyncIpcDeps, a: IpcArgs): Promise<Dto.ForkResultDto> {
  const copy = await deps.appSync().makeOwnCopy(requireString(a.ticket, 'ticket'), requireVaultTarget(a.targetPath, 'target path'));
  deps.ownCopyMade?.(copy);
  return copy;
}

/** Copies the engine knows about (scan result, status list, copy prompts), by resolved path. */
function knownCopies(v: EngineVault): ReadonlyMap<string, string> {
  const { scanner, status } = v.engine.parts();
  const snap = status.snapshot();
  const prompted = snap.prompts.flatMap((p) => (p.kind === 'copy-review' || p.kind === 'same-device-copy' ? [p.copy.path] : []));
  const all = [...(scanner.last()?.copies ?? []).map((c) => c.path), ...snap.otherCopies.map((c) => c.path), ...prompted];
  return new Map(all.map((p) => [path.resolve(p), p] as const));
}

/** Only a copy the engine found can be trashed, merged or forked (never an arbitrary path). */
async function copyAction(v: EngineVault, a: IpcArgs): Promise<Dto.CopyActionResult> {
  const requested = requireFilePath(a.path, 'copy path');
  const action = oneOf(a.action, COPY_ACTIONS, 'copy action');
  const copyPath = knownCopies(v).get(requested);
  if (copyPath === undefined) throw new UserFacingError(COPY_GONE_MESSAGE);
  const target = action === 'separate' ? requireVaultTarget(a.targetPath, 'target path') : null;
  return actions.copyAction(v, copyPath, action, target);
}

async function exportUnsynced(deps: SyncIpcDeps, a: IpcArgs): Promise<{ path: string }> {
  const file = await deps.appSync().exportUnsynced(optionalString(a.lineageId, 'vault') ?? undefined);
  deps.showItemInFolder(file);
  return { path: file };
}

async function followPassword(deps: SyncIpcDeps, res: Dto.PasswordFlowResult, password: string | null): Promise<Dto.PasswordFlowResult> {
  if (res.ok && password !== null) await deps.passwordChanged(password);
  return res;
}

async function enterNewPassword(deps: SyncIpcDeps, a: IpcArgs): Promise<Dto.PasswordFlowResult> {
  const password = requirePassword(a.password, 'password');
  return followPassword(deps, await actions.enterNewPassword(deps.appSync().engineVault(), password), password);
}

async function adoptLegacyPassword(deps: SyncIpcDeps, a: IpcArgs): Promise<Dto.PasswordFlowResult> {
  const next = requirePassword(a.newPassword, 'password');
  const previous = optionalPassword(a.previousPassword, 'previous password');
  return followPassword(deps, await actions.adoptLegacyPassword(deps.appSync().engineVault(), next, previous), next);
}

/** The app follows the other password only when its epoch won. */
async function resolveConcurrentEpoch(deps: SyncIpcDeps, a: IpcArgs): Promise<Dto.PasswordFlowResult> {
  const other = requirePassword(a.otherPassword, 'password');
  const winner = requireString(a.winnerEpochId, 'epoch');
  const v = deps.appSync().engineVault();
  const ownEpoch = v.replica.ring().current.epochId;
  const res = await actions.resolveConcurrentEpoch(v, other, winner);
  return followPassword(deps, res, winner === ownEpoch ? null : other);
}

export function registerSyncHandlers(deps: SyncIpcDeps = defaultDeps(), ipc: IpcRegistrar = ipcMain): void {
  const on = (channel: string, fn: ChannelHandler): void => handleChannel(ipc, channel, fn);
  const v = (): EngineVault => deps.appSync().engineVault();

  on('sync_get_state', () => deps.appSync().getState());
  on('sync_now', () => actions.syncNow(v()));
  on('sync_list_devices', () => actions.listDevices(v(), deps.appSync().runtime().signals().sessions()));
  on('sync_list_copies', (a) => actions.listCopies(v(), optionalBoolean(a.rescan, 'rescan')));
  on('sync_copy_action', (a) => copyAction(v(), a));
  on('sync_confirm_side_files', (a) =>
    actions.confirmSideFiles(v(), requireList(a.tuples, 'side files'), optionalBoolean(a.walReviewed, 'wal reviewed')),
  );
  on('sync_review_side_file_wal', async () => ({ candidateId: await v().engine.reviewSideFileWal() }));
  on('sync_locate_file', (a) => actions.locate(v(), requireFilePath(a.path, 'file')));
  on('sync_save_new_copy', (a) => actions.saveNewCopy(v(), requireVaultTarget(a.path, 'file')));
  on('sync_undo_rebind', () => actions.undoRebind(v()));
  on('sync_make_separate_vault', (a) =>
    actions.makeSeparateVault(v(), requireVaultTarget(a.targetPath, 'target path'), optionalString(a.promptId, 'prompt')),
  );
  on('sync_export_unsynced', (a) => exportUnsynced(deps, a));
  on('sync_dismiss_prompt', (a) => actions.dismissPrompt(v(), requireString(a.promptId, 'prompt')));
  on('sync_dismiss_notice', (a) => actions.dismissNotice(v(), requireString(a.noticeId, 'notice')));
  on('sync_set_enabled', (a) => deps.appSync().setEnabled(requireBoolean(a.enabled, 'enabled')));
  on('sync_enter_new_password', (a) => enterNewPassword(deps, a));
  on('sync_adopt_legacy_password', (a) => adoptLegacyPassword(deps, a));
  on('sync_resolve_concurrent_epoch', (a) => resolveConcurrentEpoch(deps, a));
  on('vault_session_takeover', () => deps.appSync().answerConflict('use-here'));
  on('vault_session_lock_here', () => deps.appSync().answerConflict('lock-here'));
  on('vault_session_stop_waiting', (a) => deps.appSync().stopWaiting(requireString(a.deviceId, 'device')));
  on('vault_session_open_now', () => deps.appSync().openNow());
  on('sync_release_ownership', () => releaseOwnership(deps));
  on('sync_make_own_copy', (a) => makeOwnCopy(deps, a));
}
