/**
 * Turning automatic unlock on (docs/AUTO_UNLOCK.md 5.4): the open personal vault becomes the
 * startup vault and its master password is sealed, after a fresh proof: a typed or Touch ID
 * unlock of this vault in the last 120 s (the unlock dialog checkbox), the master password again,
 * or Touch ID (Settings). Main seals the password it holds, never one the renderer sends.
 */

import crypto from 'node:crypto';
import type { AutoUnlockStore } from '../services/vault/auto-unlock-store.js';
import type { StartupVault } from './startup-vault-core.js';

export type EnableProof =
  | { readonly kind: 'recent-unlock' }
  | { readonly kind: 'password'; readonly password: string }
  | { readonly kind: 'biometric' };

export const WRONG_PASSWORD_MESSAGE = "That password didn't work.";
export const PROOF_EXPIRED_MESSAGE = 'Unlock the vault again to turn this on.';
export const NOT_UNLOCKED_MESSAGE = 'Unlock a personal vault first.';
export const TOUCH_ID_FAILED_MESSAGE = "Touch ID didn't confirm it's you.";
const BIOMETRIC_REASON = 'Turn on automatic unlock for Conduit';

export interface EnableDeps {
  readonly store: AutoUnlockStore;
  isPersonalUnlocked(): boolean;
  currentPath(): string;
  currentLineage(): Promise<string | null>;
  masterPassword(): string | null;
  /** True (and used up) when a person unlocked this lineage in the last 120 s. */
  consumeRecentUnlock(lineageId: string): boolean;
  biometricEnabledForCurrent(): Promise<boolean>;
  authenticateBiometric(reason: string): Promise<boolean>;
  userId(): string | null;
  writeStartup(next: StartupVault): void;
}

export function parseProof(args: unknown): EnableProof {
  const a = typeof args === 'object' && args !== null ? (args as { proof?: unknown }).proof : null;
  const p = typeof a === 'object' && a !== null ? (a as Record<string, unknown>) : {};
  if (p.kind === 'recent-unlock' || p.kind === 'biometric') return { kind: p.kind };
  if (p.kind === 'password' && typeof p.password === 'string') return { kind: 'password', password: p.password };
  throw new Error('Confirm with your master password first.');
}

export function samePassword(given: string, held: string): boolean {
  const digest = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest();
  return crypto.timingSafeEqual(digest(given), digest(held));
}

function storeRefusal(reason: string, storeName: string): string {
  if (reason === 'write-failed') return "Conduit couldn't save the unlock. Try again.";
  return `Automatic unlock needs the ${storeName}, and it isn't usable on this computer.`;
}

async function checkProof(deps: EnableDeps, proof: EnableProof, lineageId: string, held: string): Promise<void> {
  if (proof.kind === 'recent-unlock') {
    if (!deps.consumeRecentUnlock(lineageId)) throw new Error(PROOF_EXPIRED_MESSAGE);
    return;
  }
  if (proof.kind === 'password') {
    if (!samePassword(proof.password, held)) throw new Error(WRONG_PASSWORD_MESSAGE);
    return;
  }
  if (!(await deps.biometricEnabledForCurrent())) throw new Error(TOUCH_ID_FAILED_MESSAGE);
  if (!(await deps.authenticateBiometric(BIOMETRIC_REASON))) throw new Error(TOUCH_ID_FAILED_MESSAGE);
}

export async function enableAutoUnlock(deps: EnableDeps, proof: EnableProof): Promise<void> {
  const held = deps.masterPassword();
  if (!deps.isPersonalUnlocked() || held === null) throw new Error(NOT_UNLOCKED_MESSAGE);
  const lineageId = await deps.currentLineage();
  if (lineageId === null) throw new Error("Conduit couldn't identify this vault. Try again after it finishes opening.");
  await checkProof(deps, proof, lineageId, held);
  const status = deps.store.status();
  if (!status.usable) throw new Error(storeRefusal(status.reason, status.storeName));
  const sealed = await deps.store.sealPassword(lineageId, deps.userId(), held);
  if (!sealed.ok) throw new Error(storeRefusal(sealed.reason, status.storeName));
  deps.writeStartup({ kind: 'personal', path: deps.currentPath(), lineageId });
  console.info('[auto-unlock] turned on', { proof: proof.kind });
}
