/**
 * Explicit sign-out with a personal vault open (spec 6.4 release points): the vault's lease is
 * released while the session can still reach the server, then Supabase signs out. After that the
 * lease RPC has no session, so releasing afterwards would leave the lease to expire instead.
 */

export interface SignOutDeps {
  /** AppSyncManager.signedOut: bounded, and a no-op when no vault is open. */
  releaseVault(): Promise<void>;
  signOut(): Promise<void>;
  /** Saved automatic unlocks on this computer go with the account (docs/AUTO_UNLOCK.md 3.7). */
  forgetSavedUnlocks?(): void;
}

const LOG = '[vault-session]';

export async function signOutReleasingVault(deps: SignOutDeps): Promise<void> {
  try {
    await deps.releaseVault();
  } catch (err) {
    console.error(`${LOG} release before sign-out failed; the lease expires on its own`, {
      name: err instanceof Error ? err.name : 'Error',
    });
  }
  await deps.signOut();
  try {
    deps.forgetSavedUnlocks?.();
  } catch (err) {
    console.error('[auto-unlock] forgetting saved unlocks at sign-out failed', { name: err instanceof Error ? err.name : 'Error' });
  }
}
