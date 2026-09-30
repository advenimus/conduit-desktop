/**
 * What happens to a saved unlock when the rest of the app changes (docs/AUTO_UNLOCK.md 3.6, 3.7):
 * password changes re-seal it, sign-out and any change of account forget it, release and Make my
 * own copy move or drop it. Everything here is best effort: it logs, tells the renderer, and never
 * throws into the flow that called it.
 */

import type { AutoUnlockStore } from '../services/vault/auto-unlock-store.js';
import { vaultDisplayName, type StartupVault } from './startup-vault-core.js';

export type ForgetReason = 'sign-out' | 'account' | 'release' | 'own-copy';

export type AutoUnlockEvent =
  | { readonly kind: 'forgotten'; readonly reason: ForgetReason; readonly name: string | null }
  | { readonly kind: 'resealed'; readonly name: string }
  | { readonly kind: 'reseal-failed'; readonly name: string };

export interface LifecycleDeps {
  readonly store: AutoUnlockStore;
  readStartup(): StartupVault | null;
  writeStartup(next: StartupVault | null): void;
  notify(event: AutoUnlockEvent): void;
  lineageForPath(vaultPath: string): Promise<string | null>;
  currentLineageId(): string | null;
  currentPath(): string;
  userId(): string | null;
}

const LOG = '[auto-unlock]';

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'Error';
}

function savedStartup(deps: LifecycleDeps): { readonly path: string; readonly lineageId: string } | null {
  const sv = deps.readStartup();
  if (sv?.kind !== 'personal' || sv.lineageId === null) return null;
  return deps.store.hasEntry(sv.lineageId) ? { path: sv.path, lineageId: sv.lineageId } : null;
}

/** Captured before a password change: the open vault has the saved unlock. */
export function savedUnlockForCurrent(deps: LifecycleDeps): boolean {
  try {
    return savedStartup(deps)?.path === deps.currentPath();
  } catch (err) {
    console.warn(`${LOG} could not check the saved unlock`, { name: errName(err) });
    return false;
  }
}

async function currentLineage(deps: LifecycleDeps): Promise<string | null> {
  try {
    return (await deps.lineageForPath(deps.currentPath())) ?? deps.currentLineageId();
  } catch {
    return deps.currentLineageId();
  }
}

/**
 * After a password change on this device or learned through sync: seal the new password under
 * the vault's current lineage (a private vault's lineage follows its salt) and move the startup
 * vault to it. A refused seal forgets the old entry and says so.
 */
export async function resealAfterPasswordChange(deps: LifecycleDeps, wasOn: boolean, next: string): Promise<void> {
  if (!wasOn) return;
  const name = vaultDisplayName(deps.currentPath());
  try {
    const lineageId = await currentLineage(deps);
    if (lineageId === null) throw new Error('the vault lineage is unknown');
    const sealed = await deps.store.sealPassword(lineageId, deps.userId(), next);
    if (!sealed.ok) throw new Error(`seal refused: ${sealed.reason}`);
    deps.writeStartup({ kind: 'personal', path: deps.currentPath(), lineageId });
    console.info(`${LOG} saved unlock updated after a password change`);
    deps.notify({ kind: 'resealed', name });
  } catch (err) {
    deps.store.removeAll();
    console.warn(`${LOG} saved unlock could not follow the password change; forgotten`, { name: errName(err), message: err instanceof Error ? err.message : '' });
    deps.notify({ kind: 'reseal-failed', name });
  }
}

/** Sign-out or an account change: every saved unlock goes. True when one existed. */
export function forgetAll(deps: LifecycleDeps, reason: 'sign-out' | 'account'): boolean {
  try {
    const removed = deps.store.removeAll();
    if (removed === 0) return false;
    console.info(`${LOG} saved unlock forgotten`, { reason });
    deps.notify({ kind: 'forgotten', reason, name: null });
    return true;
  } catch (err) {
    console.warn(`${LOG} forgetting saved unlocks failed`, { reason, name: errName(err) });
    return false;
  }
}

/** The open vault was released: it stops opening at startup here and its saved unlock goes. */
export function afterRelease(deps: LifecycleDeps, releasedPath: string): void {
  try {
    const sv = deps.readStartup();
    if (sv?.kind !== 'personal' || sv.path !== releasedPath) return;
    deps.store.removeAll();
    deps.writeStartup({ kind: 'hub' });
    deps.notify({ kind: 'forgotten', reason: 'release', name: vaultDisplayName(releasedPath) });
  } catch (err) {
    console.warn(`${LOG} release follow-up failed`, { name: errName(err) });
  }
}

/** Make my own copy of the startup vault: the copy opens at startup instead, with no saved unlock. */
export function afterOwnCopy(deps: LifecycleDeps, originalPath: string, copy: { readonly path: string; readonly lineageId: string }): void {
  try {
    const sv = deps.readStartup();
    if (sv?.kind !== 'personal' || sv.path !== originalPath) return;
    const hadSaved = deps.store.removeAll() > 0;
    deps.writeStartup({ kind: 'personal', path: copy.path, lineageId: copy.lineageId });
    if (hadSaved) deps.notify({ kind: 'forgotten', reason: 'own-copy', name: vaultDisplayName(originalPath) });
  } catch (err) {
    console.warn(`${LOG} own copy follow-up failed`, { name: errName(err) });
  }
}

export interface AccountSource {
  onInitialized(cb: () => void): void;
  onStateChange(cb: () => void): void;
  hasInitialized(): boolean;
}

/**
 * Any change of signed-in user id after sign-in settled (A to null, A to B, null to A) forgets
 * every saved unlock. Changes while auth is still starting are the session being restored.
 */
export function watchAccountChange(auth: AccountSource, deps: LifecycleDeps): void {
  let baseline: string | null | undefined;
  auth.onInitialized(() => {
    baseline ??= deps.userId();
  });
  auth.onStateChange(() => {
    if (!auth.hasInitialized() || baseline === undefined) return;
    const next = deps.userId();
    if (next === baseline) return;
    const reason = next === null ? 'sign-out' : 'account';
    baseline = next;
    forgetAll(deps, reason);
  });
}
