/**
 * Validation of the argument objects the renderer sends to the sync and restore channels
 * (system boundary). Every channel takes one plain object; anything malformed is rejected with
 * InvalidSyncRequest before it reaches the sync layer, which validates keys and choices again.
 */

import path from 'node:path';
import { InvalidSyncRequest, oneOf, requireString } from '../services/sync/app-sync-dto-map.js';

export type IpcArgs = Readonly<Record<string, unknown>>;

export const MAX_PATH_LENGTH = 4096;
export const MAX_PASSWORD_LENGTH = 4096;
export const MAX_LIST_LENGTH = 10_000;
export const VAULT_FILE_EXTENSION = '.conduit';

export { InvalidSyncRequest, oneOf, requireString };

function isPlainObject(v: unknown): v is IpcArgs {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The channel's argument object; a channel called without arguments gets an empty one. */
export function argsObject(raw: unknown): IpcArgs {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) throw new InvalidSyncRequest('arguments');
  return raw;
}

/** Missing means false. */
export function optionalBoolean(v: unknown, what: string): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v !== 'boolean') throw new InvalidSyncRequest(what);
  return v;
}

export function requireBoolean(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') throw new InvalidSyncRequest(what);
  return v;
}

export function optionalString(v: unknown, what: string): string | null {
  return v === undefined || v === null ? null : requireString(v, what);
}

export function requirePassword(v: unknown, what: string): string {
  if (typeof v !== 'string' || v === '' || v.length > MAX_PASSWORD_LENGTH) throw new InvalidSyncRequest(what);
  return v;
}

export function optionalPassword(v: unknown, what: string): string | null {
  return v === undefined || v === null ? null : requirePassword(v, what);
}

/** An absolute local path (from a file dialog), normalized. */
export function requireFilePath(v: unknown, what: string): string {
  if (typeof v !== 'string' || v === '' || v.length > MAX_PATH_LENGTH || v.includes('\0')) throw new InvalidSyncRequest(what);
  if (!path.isAbsolute(v)) throw new InvalidSyncRequest(what);
  return path.resolve(v);
}

export const VAULT_EXTENSION_REQUIRED = 'the file name must end in .conduit';

/**
 * A path Conduit will create a vault at: absolute and ending in .conduit, so a request can
 * never write a vault over another kind of file. Some Linux save dialogs return the typed
 * name without the filter's extension, so a name without any extension gets it.
 */
export function requireVaultTarget(v: unknown, what: string): string {
  const p = requireFilePath(v, what);
  const ext = path.extname(p).toLowerCase();
  if (ext === VAULT_FILE_EXTENSION) return p;
  if (ext === '') return `${p}${VAULT_FILE_EXTENSION}`;
  throw new InvalidSyncRequest(VAULT_EXTENSION_REQUIRED);
}

export function optionalVaultTarget(v: unknown, what: string): string | null {
  return v === undefined || v === null ? null : requireVaultTarget(v, what);
}

export function requireList(v: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(v) || v.length > MAX_LIST_LENGTH) throw new InvalidSyncRequest(what);
  return v;
}

export function optionalList(v: unknown, what: string): readonly unknown[] | undefined {
  return v === undefined || v === null ? undefined : requireList(v, what);
}

export function requireRecord(v: unknown, what: string): IpcArgs {
  if (!isPlainObject(v)) throw new InvalidSyncRequest(what);
  return v;
}
