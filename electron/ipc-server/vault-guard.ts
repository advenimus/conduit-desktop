/**
 * Personal-vault sync facts for the MCP request handlers (spec 6.6, 7.2): the locked error says
 * so when this device was displaced (soft lock, reason open_elsewhere), and entry reads report
 * whether the entry has unresolved sync conflicts. Team vaults never get either.
 */

export const OPEN_ELSEWHERE_REASON = 'open_elsewhere';
export const OPEN_ELSEWHERE_MESSAGE = 'This vault is open on another device. Open it here to use it.';
export const VAULT_LOCKED_CODE = 'VAULT_LOCKED';

export interface VaultLockedPayload {
  readonly code: typeof VAULT_LOCKED_CODE;
  readonly message: string;
  readonly reason?: typeof OPEN_ELSEWHERE_REASON;
}

export interface GuardedErrorResponse {
  readonly type: 'Error';
  readonly payload: VaultLockedPayload | { readonly code: string; readonly message: string };
}

/** The slice of AppState these checks read. */
export interface VaultGuardState {
  readonly vault: object;
  readonly personalLockReason?: string | null;
  getActiveVault(): object;
  readonly appSync?: { hasConflictForEntry(entryId: string): boolean };
}

function personalVaultActive(state: VaultGuardState): boolean {
  return state.getActiveVault() === state.vault;
}

export function isOpenElsewhere(state: VaultGuardState): boolean {
  return personalVaultActive(state) && state.personalLockReason === OPEN_ELSEWHERE_REASON;
}

/** A read or write that raced the displacement (ConduitVault blocks access before the soft lock). */
export function isOpenElsewhereError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { reason?: unknown }).reason === OPEN_ELSEWHERE_REASON;
}

export function lockedResponse(state: VaultGuardState, message: string): GuardedErrorResponse {
  if (isOpenElsewhere(state)) {
    return { type: 'Error', payload: { code: VAULT_LOCKED_CODE, message: OPEN_ELSEWHERE_MESSAGE, reason: OPEN_ELSEWHERE_REASON } };
  }
  return { type: 'Error', payload: { code: VAULT_LOCKED_CODE, message } };
}

/** The error of a failed vault call: the locked error when it raced a displacement. */
export function vaultFailure(code: string, err: unknown): GuardedErrorResponse {
  if (isOpenElsewhereError(err)) {
    return { type: 'Error', payload: { code: VAULT_LOCKED_CODE, message: OPEN_ELSEWHERE_MESSAGE, reason: OPEN_ELSEWHERE_REASON } };
  }
  return { type: 'Error', payload: { code, message: String(err) } };
}

/** `has_conflict` of entry_info and credential_read: false for team vaults and when no engine runs. */
export function hasConflict(state: VaultGuardState, entryId: string): boolean {
  if (!personalVaultActive(state) || state.appSync === undefined) return false;
  try {
    return state.appSync.hasConflictForEntry(entryId);
  } catch (err) {
    console.warn('[sync] has_conflict lookup failed:', (err as Error)?.name ?? 'Error');
    return false;
  }
}
