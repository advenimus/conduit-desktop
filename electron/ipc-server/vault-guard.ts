/**
 * Personal-vault sync facts for the MCP request handlers (spec 6.6, 7.2; docs/PLAN_ENFORCEMENT.md
 * S19, S20): the locked error says why when this device was soft-locked (open on another device,
 * owned by another account, or an app update needed), and entry reads report whether the entry
 * has unresolved sync conflicts. Team vaults never get either.
 */

export const OPEN_ELSEWHERE_REASON = 'open_elsewhere';
export const NOT_OWNER_REASON = 'not_owner';
export const UPDATE_REQUIRED_REASON = 'update_required';
export const OPEN_ELSEWHERE_MESSAGE = 'This vault is open on another device. Open it here to use it.';
export const NOT_OWNER_MESSAGE = 'The vault is locked: it belongs to another Conduit account.';
export const UPDATE_REQUIRED_MESSAGE = 'The vault is locked: update Conduit to use it.';
export const VAULT_LOCKED_CODE = 'VAULT_LOCKED';

export type LockedReasonCode = typeof OPEN_ELSEWHERE_REASON | typeof NOT_OWNER_REASON | typeof UPDATE_REQUIRED_REASON;

const LOCKED_MESSAGES: Readonly<Record<LockedReasonCode, string>> = {
  [OPEN_ELSEWHERE_REASON]: OPEN_ELSEWHERE_MESSAGE,
  [NOT_OWNER_REASON]: NOT_OWNER_MESSAGE,
  [UPDATE_REQUIRED_REASON]: UPDATE_REQUIRED_MESSAGE,
};

export interface VaultLockedPayload {
  readonly code: typeof VAULT_LOCKED_CODE;
  readonly message: string;
  readonly reason?: LockedReasonCode;
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

function isLockedReason(v: unknown): v is LockedReasonCode {
  return typeof v === 'string' && Object.hasOwn(LOCKED_MESSAGES, v);
}

function personalVaultActive(state: VaultGuardState): boolean {
  return state.getActiveVault() === state.vault;
}

/** The soft-lock reason of the active personal vault, or null. */
export function softLockReason(state: VaultGuardState): LockedReasonCode | null {
  return personalVaultActive(state) && isLockedReason(state.personalLockReason) ? state.personalLockReason : null;
}

export function isOpenElsewhere(state: VaultGuardState): boolean {
  return softLockReason(state) === OPEN_ELSEWHERE_REASON;
}

/** A read or write that raced the displacement (ConduitVault blocks access before the soft lock). */
export function isOpenElsewhereError(err: unknown): boolean {
  return lockedReasonOf(err) === OPEN_ELSEWHERE_REASON;
}

function lockedReasonOf(err: unknown): LockedReasonCode | null {
  if (typeof err !== 'object' || err === null) return null;
  const reason = (err as { reason?: unknown }).reason;
  return isLockedReason(reason) ? reason : null;
}

function locked(reason: LockedReasonCode): GuardedErrorResponse {
  return { type: 'Error', payload: { code: VAULT_LOCKED_CODE, message: LOCKED_MESSAGES[reason], reason } };
}

export function lockedResponse(state: VaultGuardState, message: string): GuardedErrorResponse {
  const reason = softLockReason(state);
  if (reason !== null) return locked(reason);
  return { type: 'Error', payload: { code: VAULT_LOCKED_CODE, message } };
}

/** The error of a failed vault call: the locked error when it raced a displacement. */
export function vaultFailure(code: string, err: unknown): GuardedErrorResponse {
  const reason = lockedReasonOf(err);
  if (reason !== null) return locked(reason);
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
