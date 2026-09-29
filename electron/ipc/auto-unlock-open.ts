/**
 * vault_auto_unlock (docs/AUTO_UNLOCK.md 4.2 to 4.4): opens the startup vault with its saved
 * password through the same open path as a typed password, so every gate still runs. Main picks
 * the file; the renderer never names it. The first try never takes over; a click in a fallback
 * dialog may retry while the attempt is open. A saved password that no longer works is forgotten
 * at once and never retried by itself.
 */

import type { PersonalOpenRequest } from '../services/sync/app-sync-manager.js';
import type { AutoUnlockStore } from '../services/vault/auto-unlock-store.js';
import {
  INVALID_PASSWORD_MESSAGE,
  OPEN_CANCELLED_MESSAGE,
  PersonalVaultOpenError,
  VAULT_NOT_FOUND_MESSAGE,
} from '../services/vault-session/open-errors.js';
import type { StartupAttempt, StartupVault } from './startup-vault-core.js';
import type { OpenRefusedHook } from './vault-unlock.js';

export type AutoUnlockFallback = 'stale' | 'unreadable' | 'account' | 'not-allowed' | 'missing-file';

export type AutoUnlockResult = { readonly ok: true } | { readonly ok: false; readonly fallback: AutoUnlockFallback };

export interface AutoUnlockArgs {
  readonly takeover: boolean;
  readonly recoverWorkingCopy: boolean;
  readonly previousPassword: string | null;
  /** A password typed in a fallback dialog; the held saved password then stands in as the previous one. */
  readonly password: string | null;
}

export interface AutoUnlockDeps {
  readonly store: AutoUnlockStore;
  readonly attempt: StartupAttempt;
  readStartup(): StartupVault | null;
  authInitialized(): boolean;
  userId(): string | null;
  currentPath(): string;
  /** Lock whatever is open, switch to `path`, record it as recent. */
  prepare(path: string): Promise<void>;
  open(req: PersonalOpenRequest, onRefused: OpenRefusedHook): Promise<unknown>;
  holdMcp(): void;
}

const LOG = '[auto-unlock]';

function text(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

export function parseAutoUnlockArgs(args: unknown): AutoUnlockArgs {
  const a = typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  return {
    takeover: a.takeover === true,
    recoverWorkingCopy: a.recoverWorkingCopy === true,
    previousPassword: text(a.previousPassword),
    password: text(a.password),
  };
}

function isStale(err: unknown): boolean {
  if (err instanceof PersonalVaultOpenError) return err.payload.code === 'VAULT_PASSWORD_CHANGED_ELSEWHERE';
  return err instanceof Error && err.message === INVALID_PASSWORD_MESSAGE;
}

async function openTyped(deps: AutoUnlockDeps, sv: StartupVault | null, a: AutoUnlockArgs, password: string): Promise<AutoUnlockResult> {
  const path = deps.currentPath();
  const held = deps.attempt.isOpen() && sv?.kind === 'personal' && sv.path === path ? deps.attempt.savedPassword() : null;
  await deps.open(
    { path, password, previousPassword: a.previousPassword ?? held, takeover: a.takeover, recoverWorkingCopy: a.recoverWorkingCopy, source: 'vault_unlock' },
    async () => undefined,
  );
  return { ok: true };
}

type SavedPassword = { readonly password: string } | AutoUnlockResult;

async function firstPassword(deps: AutoUnlockDeps, sv: Extract<StartupVault, { kind: 'personal' }>, lineageId: string): Promise<SavedPassword> {
  const read = deps.store.readPassword(lineageId);
  if (read.kind === 'missing') {
    deps.attempt.finish();
    return { ok: false, fallback: 'not-allowed' };
  }
  await deps.prepare(sv.path);
  if (read.kind === 'unreadable') {
    deps.attempt.finish();
    return { ok: false, fallback: 'unreadable' };
  }
  if (!deps.authInitialized() || read.userId !== deps.userId()) {
    deps.store.removeAll();
    deps.attempt.finish();
    console.warn(`${LOG} saved unlock belongs to another account; forgotten`);
    return { ok: false, fallback: 'account' };
  }
  deps.attempt.holdPassword(read.password);
  return { password: read.password };
}

export async function runAutoUnlock(deps: AutoUnlockDeps, a: AutoUnlockArgs): Promise<AutoUnlockResult> {
  const sv = deps.readStartup();
  if (a.password !== null) return openTyped(deps, sv, a, a.password);
  const kind = deps.attempt.attemptKind();
  if (sv?.kind !== 'personal' || sv.lineageId === null || kind === null) return { ok: false, fallback: 'not-allowed' };
  let password: string;
  if (kind === 'first') {
    const got = await firstPassword(deps, sv, sv.lineageId);
    if (!('password' in got)) return got;
    password = got.password;
  } else {
    const held = deps.attempt.savedPassword();
    if (held === null || deps.currentPath() !== sv.path) return { ok: false, fallback: 'not-allowed' };
    password = held;
  }

  let stale = false;
  const onRefused: OpenRefusedHook = async (err) => {
    if (!isStale(err)) return;
    stale = true;
    deps.store.removeAll();
    console.info(`${LOG} the saved password no longer opens the vault; forgotten`);
  };
  try {
    await deps.open(
      {
        path: sv.path,
        password,
        previousPassword: a.previousPassword,
        takeover: kind === 'retry' && a.takeover,
        recoverWorkingCopy: a.recoverWorkingCopy,
        source: 'auto_unlock',
      },
      onRefused,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (message === OPEN_CANCELLED_MESSAGE) {
      deps.attempt.finish();
      throw err;
    }
    deps.attempt.markFailed();
    if (message === VAULT_NOT_FOUND_MESSAGE) return { ok: false, fallback: 'missing-file' };
    if (stale && message === INVALID_PASSWORD_MESSAGE) return { ok: false, fallback: 'stale' };
    throw err;
  }
  deps.attempt.succeeded();
  deps.holdMcp();
  return { ok: true };
}
