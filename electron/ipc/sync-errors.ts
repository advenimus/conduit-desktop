/**
 * Errors of the sync and restore channels. The renderer shows Error.message in a toast, so
 * only messages written for people reach it: known plain messages, InvalidSyncRequest, errors
 * raised as UserFacingError, and the structured unlock errors (JSON, parsed by the renderer).
 * Everything else becomes a short generic message; main logs the detail under [sync].
 */

import { InvalidSyncRequest } from '../services/sync/app-sync-dto-map.js';
import { NO_UNSYNCED_CHANGES_MESSAGE } from '../services/sync/app-sync-lineage.js';
import { OWN_COPY_EXPIRED_MESSAGE, OWN_COPY_UNREADABLE_MESSAGE } from '../services/sync/app-sync-own-copy.js';
import {
  OPEN_IN_PROGRESS_MESSAGE,
  SYNC_NOT_RUNNING_MESSAGE,
  VAULT_ALREADY_OPEN_MESSAGE,
  WRONG_CURRENT_PASSWORD_MESSAGE,
} from '../services/sync/app-sync-manager.js';
import { SyncCoreError, type SyncErrorCode } from '../services/sync/types.js';
import {
  INVALID_PASSWORD_MESSAGE,
  OPEN_CANCELLED_MESSAGE,
  PersonalVaultOpenError,
  VAULT_EXISTS_MESSAGE,
  VAULT_NOT_FOUND_MESSAGE,
} from '../services/vault-session/open-personal-vault.js';
import {
  CLOUD_BACKUP_DAMAGED_MESSAGE,
  CLOUD_BACKUP_TOO_LARGE_MESSAGE,
  CLOUD_BACKUP_WRONG_PASSWORD_MESSAGE,
} from '../services/vault/cloud-crypto.js';
import { LOCAL_BACKUP_WRONG_PASSWORD_MESSAGE } from '../services/vault/local-backup-crypto.js';
import { CLOUD_BACKUP_PLAN_MESSAGE, CLOUD_RESTORE_PLAN_MESSAGE } from '../services/vault/backup-tier.js';
import { argsObject, type IpcArgs } from './sync-args.js';

export const GENERIC_SYNC_ERROR_MESSAGE = 'Sync could not finish that. Try again.';
const MAX_LOGGED_MESSAGE = 300;
const OPEN_ERROR_JSON_PREFIX = '{"code":"VAULT_';

/** An error whose message is written for the user and may be shown as is. */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserFacingError';
  }
}

const PASS_THROUGH: ReadonlySet<string> = new Set([
  SYNC_NOT_RUNNING_MESSAGE,
  VAULT_ALREADY_OPEN_MESSAGE,
  OPEN_IN_PROGRESS_MESSAGE,
  OPEN_CANCELLED_MESSAGE,
  WRONG_CURRENT_PASSWORD_MESSAGE,
  INVALID_PASSWORD_MESSAGE,
  VAULT_NOT_FOUND_MESSAGE,
  VAULT_EXISTS_MESSAGE,
  CLOUD_BACKUP_PLAN_MESSAGE,
  CLOUD_RESTORE_PLAN_MESSAGE,
  CLOUD_BACKUP_TOO_LARGE_MESSAGE,
  CLOUD_BACKUP_DAMAGED_MESSAGE,
  NO_UNSYNCED_CHANGES_MESSAGE,
  CLOUD_BACKUP_WRONG_PASSWORD_MESSAGE,
  LOCAL_BACKUP_WRONG_PASSWORD_MESSAGE,
  OWN_COPY_EXPIRED_MESSAGE,
  OWN_COPY_UNREADABLE_MESSAGE,
  'Not authenticated',
]);

const CORE_MESSAGES: Partial<Record<SyncErrorCode, string>> = {
  KEY_MISMATCH: 'That password does not open this vault.',
  UNSUPPORTED_FORMAT: 'That file is not a vault this version of Conduit can read.',
  MERGE_PRECONDITION: 'That file belongs to a different vault.',
};

const FS_MESSAGES: Readonly<Record<string, string>> = {
  ENOENT: 'That file or folder was not found.',
  EACCES: 'Conduit does not have permission to use that file or folder.',
  EPERM: 'Conduit does not have permission to use that file or folder.',
  ENOSPC: 'The disk is full.',
  EEXIST: 'A file with that name already exists.',
  EBUSY: 'That file is in use. Try again in a moment.',
};

function isOpenError(err: Error): boolean {
  return err instanceof PersonalVaultOpenError || err.message.startsWith(OPEN_ERROR_JSON_PREFIX);
}

function isExpected(err: Error): boolean {
  return err instanceof UserFacingError || err instanceof InvalidSyncRequest || isOpenError(err) || PASS_THROUGH.has(err.message);
}

function errnoCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

/** The text the renderer may show for `err`. */
export function userMessage(err: unknown, generic: string = GENERIC_SYNC_ERROR_MESSAGE): string {
  if (!(err instanceof Error)) return generic;
  if (isExpected(err)) return err.message;
  if (err instanceof SyncCoreError) return CORE_MESSAGES[err.code] ?? generic;
  const code = errnoCode(err);
  return (code !== null ? FS_MESSAGES[code] : undefined) ?? generic;
}

function logFailure(prefix: string, channel: string, err: unknown): void {
  if (!(err instanceof Error)) {
    console.error(`${prefix} ${channel} failed with a non-error value`);
    return;
  }
  const message = isOpenError(err) ? '(structured unlock error)' : err.message.slice(0, MAX_LOGGED_MESSAGE);
  const detail = { name: err.name, code: errnoCode(err), message };
  if (isExpected(err)) console.warn(`${prefix} ${channel} refused`, detail);
  else console.error(`${prefix} ${channel} failed`, detail, err.stack);
}

export interface ChannelOptions {
  /** Log prefix (default [sync]). */
  readonly prefix?: string;
  /** Shown when the error has no user-facing text. */
  readonly genericMessage?: string;
}

/** Logs the detail and returns the error to throw back over IPC. */
export function toIpcError(channel: string, err: unknown, opts: ChannelOptions = {}): Error {
  logFailure(opts.prefix ?? '[sync]', channel, err);
  return new Error(userMessage(err, opts.genericMessage));
}

export type ChannelHandler = (args: IpcArgs) => unknown;

/** The part of ipcMain the registrars use (tests pass a fake). */
export interface IpcRegistrar {
  handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void;
}

/** Registers `fn` with argument-object validation and user-safe errors. */
export function handleChannel(ipc: IpcRegistrar, channel: string, fn: ChannelHandler, opts: ChannelOptions = {}): void {
  ipc.handle(channel, async (_event: unknown, raw: unknown) => {
    try {
      return await fn(argsObject(raw));
    } catch (err) {
      throw toIpcError(channel, err, opts);
    }
  });
}
