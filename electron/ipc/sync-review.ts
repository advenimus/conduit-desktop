/**
 * IPC channels of personal-vault review (docs/MULTI_DEVICE_SYNC.md 4.7, 4.9, 5.10, 7; channel
 * list in 11.1): the conflict queue, secrets reveal and recovery, candidate merges, held changes from older apps, targeted
 * undo and Recently deleted. Every write runs in the engine's lane (app-sync-review.ts). The
 * argument object is validated here; keys and choices are validated again in app-sync-dto-map.
 */

import { ipcMain } from 'electron';
import * as review from '../services/sync/app-sync-review.js';
import type { EngineVault } from '../services/sync/app-sync-review.js';
import { AppState } from '../services/state.js';
import {
  InvalidSyncRequest,
  oneOf,
  optionalBoolean,
  optionalList,
  requireFilePath,
  requireList,
  requirePassword,
  requireRecord,
  requireString,
  type IpcArgs,
} from './sync-args.js';
import { handleChannel, type ChannelHandler, type IpcRegistrar } from './sync-errors.js';

export interface SyncReviewDeps {
  /** The open engine-managed vault, else throws the "sync is not running" message. */
  engineVault(): EngineVault;
}

const HELD_CHOICES = ['apply', 'keep-mine'] as const;

function defaultDeps(): SyncReviewDeps {
  const state = AppState.getInstance();
  return { engineVault: () => state.appSync.engineVault() };
}

/** Chosen rows, or everything in Recently deleted with `all`. */
async function deletePermanently(v: EngineVault, a: IpcArgs): Promise<void> {
  const all = optionalBoolean(a.all, 'all');
  const rows = all ? undefined : optionalList(a.rows, 'rows');
  if (!all && (rows === undefined || rows.length === 0)) throw new InvalidSyncRequest('rows');
  await review.deleteForever(v, rows, all);
}

export function registerSyncReviewHandlers(deps: SyncReviewDeps = defaultDeps(), ipc: IpcRegistrar = ipcMain): void {
  const on = (channel: string, fn: ChannelHandler): void => handleChannel(ipc, channel, fn);
  const v = (): EngineVault => deps.engineVault();

  on('sync_list_conflicts', () => review.listConflictGroups(v()));
  on('sync_resolve', (a) => review.resolve(v(), requireRecord(a.request, 'request')));
  on('sync_resolve_group', (a) => review.resolveGroup(v(), requireRecord(a.request, 'request')));
  on('sync_snooze', (a) => review.snooze(v(), requireString(a.snoozeKey, 'snooze key')));
  on('sync_reveal_secret', (a) => ({
    plaintext: review.reveal(v(), requireRecord(a.key, 'field'), requireString(a.versionId, 'version')),
  }));
  on('sync_recover_undecryptable', async (a) => ({
    ok: await review.recoverSecret(v(), requireRecord(a.key, 'field'), requireString(a.versionId, 'version'), requirePassword(a.oldPassword, 'password')),
  }));
  on('sync_candidate_list', () => review.listCandidates(v()));
  on('sync_candidate_preview', (a) => review.candidatePreview(v(), requireString(a.id, 'candidate')));
  on('sync_candidate_apply', (a) => review.candidateApply(v(), requireString(a.id, 'candidate'), optionalList(a.deleteMissing, 'rows')));
  on('sync_candidate_discard', (a) => review.candidateDiscard(v(), requireString(a.id, 'candidate')));
  on('sync_candidate_add_file', async (a) => ({ candidateId: await review.candidateAddFile(v(), requireFilePath(a.path, 'file')) }));
  on('sync_held_apply', (a) => review.heldApply(v(), oneOf(a.choice, HELD_CHOICES, 'held choice')));
  on('sync_list_snapshots', () => review.listSnapshots(v()));
  on('sync_undo_preview', (a) => review.undoPreview(v(), requireString(a.snapshotId, 'snapshot')));
  on('sync_undo_apply', (a) =>
    review.undoApply(v(), requireString(a.snapshotId, 'snapshot'), optionalList(a.rows, 'rows') ?? [], optionalList(a.fields, 'fields') ?? []),
  );
  on('sync_recently_deleted', (a) => review.recentlyDeleted(v(), optionalBoolean(a.showAll, 'show all')));
  on('sync_restore_deleted', (a) => review.restoreDeleted(v(), requireList(a.rows, 'rows')));
  on('sync_delete_permanently', (a) => deletePermanently(v(), a));
}
