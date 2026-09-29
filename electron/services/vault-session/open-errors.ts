/**
 * Errors of openPersonalVault (spec 6.3 "Errors reach the renderer as structured JSON", 6.5,
 * 4.8 unlock policy, 5.2 classes). Structured errors carry their payload as JSON in
 * Error.message (the renderer parses it like TeamVaultUnlock.tsx). A wrong password and a
 * missing file keep today's plain messages. Re-exported by open-personal-vault.ts.
 */

import type { ClaimVerdict } from './claims.js';
import type { Holder } from './host.js';

export type OpenErrorCode =
  | 'VAULT_OPEN_ELSEWHERE'
  | 'VAULT_PASSWORD_CHANGED_ELSEWHERE'
  | 'VAULT_FILE_UNREADABLE'
  | 'VAULT_FOREIGN_FILE'
  | 'VAULT_WORKING_COPY_DAMAGED'
  | 'VAULT_NOT_OWNER'
  | 'VAULT_SIGN_IN_REQUIRED'
  | 'VAULT_UPDATE_REQUIRED';

export type OpenErrorPayload =
  | {
      readonly code: 'VAULT_OPEN_ELSEWHERE';
      readonly holders: readonly Holder[];
      readonly limit: number;
      readonly fileName: string;
      /** A holder's location differs from ours (5.9 take-over wording, [Use as a separate vault...]). */
      readonly locationDiffers: boolean;
      /** 'server' (lease) or 'claim' (in-file owner claim, signed out or unconfirmed). */
      readonly via: 'server' | 'claim';
      /** 'device_cap': the account's device cap (plan enforcement S1); holders are then devices. */
      readonly cause: 'vault_limit' | 'device_cap';
      readonly deviceCap: number | null;
      /** device_cap: the device a take-over locks (holders[0]). */
      readonly displaceDeviceName: string | null;
      /** vault_limit whose take-over also locks another device for the cap (S1b); '' when unnamed. */
      readonly alsoLockDeviceName: string | null;
    }
  | {
      readonly code: 'VAULT_PASSWORD_CHANGED_ELSEWHERE';
      readonly changedByDeviceName: string | null;
      readonly changedMs: number;
      /** 'needs-wrap' without the previous password: ask for it and call again. */
      readonly needsPreviousPassword: boolean;
      /** The password came from biometrics and is superseded: delete the biometric entry. */
      readonly deleteBiometric: boolean;
    }
  | { readonly code: 'VAULT_FILE_UNREADABLE'; readonly fileName: string; readonly reason: string }
  | {
      readonly code: 'VAULT_FOREIGN_FILE';
      readonly fileName: string;
      readonly kind: 'newer-format' | 'other-vault';
      readonly syncFormat: number | null;
    }
  | {
      readonly code: 'VAULT_WORKING_COPY_DAMAGED';
      readonly fileName: string;
      /** The shared file is usable: open again with recoverWorkingCopy to park W and start from it. */
      readonly recoverable: boolean;
    }
  | {
      readonly code: 'VAULT_NOT_OWNER';
      readonly fileName: string;
      /** The owner tag refused offline (S5): no copy ticket. */
      readonly offline: boolean;
      readonly graceEndedMs: number | null;
      /** This account released the vault earlier (S8b). */
      readonly released: boolean;
      /** "Make my own copy" ticket (sync_make_own_copy); null offline or without a key. */
      readonly copyTicket: string | null;
      /** The original's folder: the Save dialog's default. */
      readonly copyDir: string | null;
    }
  | { readonly code: 'VAULT_SIGN_IN_REQUIRED'; readonly fileName: string }
  | { readonly code: 'VAULT_UPDATE_REQUIRED'; readonly fileName: string; readonly minVersion: string };

/** Error whose message is the JSON payload (vaultStore parses it like TeamVaultUnlock.tsx does). */
export class PersonalVaultOpenError extends Error {
  readonly payload: OpenErrorPayload;

  constructor(payload: OpenErrorPayload) {
    super(JSON.stringify(payload));
    this.name = 'PersonalVaultOpenError';
    this.payload = payload;
  }
}

/** The existing wrong-password message; a typo is never a structured error. */
export const INVALID_PASSWORD_MESSAGE = 'Invalid master password';
/** The existing message of ConduitVault.unlock for a missing file. */
export const VAULT_NOT_FOUND_MESSAGE = 'Vault file not found';
/** The existing message of ConduitVault.initialize for an existing file. */
export const VAULT_EXISTS_MESSAGE = 'Vault file already exists';
/** The vault was locked (or the app quit) while it was still opening; nothing stays open. */
export const OPEN_CANCELLED_MESSAGE = 'The vault was locked before it finished opening.';

/** Why S cannot be used for this open (5.2 classes plus missing and unreachable). */
export type FileProblem =
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreachable'; readonly code: string }
  | { readonly kind: 'unreadable'; readonly reason: string }
  | { readonly kind: 'foreign-newer'; readonly syncFormat: number }
  | { readonly kind: 'foreign-other' };

/** The error an open with no working copy raises for a file it cannot use. */
export function fileProblemError(problem: FileProblem, fileName: string): Error {
  switch (problem.kind) {
    case 'missing':
      return new Error(VAULT_NOT_FOUND_MESSAGE);
    case 'unreachable':
      return new PersonalVaultOpenError({ code: 'VAULT_FILE_UNREADABLE', fileName, reason: 'unreachable' });
    case 'unreadable':
      return new PersonalVaultOpenError({ code: 'VAULT_FILE_UNREADABLE', fileName, reason: problem.reason });
    case 'foreign-newer':
      return new PersonalVaultOpenError({ code: 'VAULT_FOREIGN_FILE', fileName, kind: 'newer-format', syncFormat: problem.syncFormat });
    case 'foreign-other':
      return new PersonalVaultOpenError({ code: 'VAULT_FOREIGN_FILE', fileName, kind: 'other-vault', syncFormat: null });
  }
}

/** This device's working copy cannot be read (open-damaged.ts). */
export function workingCopyDamagedError(fileName: string, recoverable: boolean): PersonalVaultOpenError {
  return new PersonalVaultOpenError({ code: 'VAULT_WORKING_COPY_DAMAGED', fileName, recoverable });
}

export interface OpenElsewhereInput {
  readonly holders: readonly Holder[];
  readonly limit: number;
  readonly fileName: string;
  /** Our location (file-binding.locationOf). */
  readonly ownLocation: string;
  readonly via: 'server' | 'claim';
  /** Absent: the per-vault limit. */
  readonly cause?: 'vault_limit' | 'device_cap';
  readonly deviceCap?: number | null;
  readonly alsoLockDeviceName?: string | null;
}

export function openElsewhereError(input: OpenElsewhereInput): PersonalVaultOpenError {
  const own = input.ownLocation.toLowerCase();
  const locationDiffers = input.holders.some((h) => h.location !== null && h.location.toLowerCase() !== own);
  const cause = input.cause ?? 'vault_limit';
  return new PersonalVaultOpenError({
    code: 'VAULT_OPEN_ELSEWHERE',
    holders: input.holders,
    limit: input.limit,
    fileName: input.fileName,
    locationDiffers: cause === 'vault_limit' && locationDiffers,
    via: input.via,
    cause,
    deviceCap: input.deviceCap ?? null,
    displaceDeviceName: cause === 'device_cap' ? (input.holders[0]?.deviceName ?? null) : null,
    alsoLockDeviceName: input.alsoLockDeviceName ?? null,
  });
}

export interface NotOwnerInput {
  readonly fileName: string;
  readonly offline: boolean;
  readonly graceEndedMs: number | null;
  readonly released: boolean;
  readonly copyTicket: string | null;
  readonly copyDir: string | null;
}

export function notOwnerError(input: NotOwnerInput): PersonalVaultOpenError {
  return new PersonalVaultOpenError({ code: 'VAULT_NOT_OWNER', ...input });
}

export function signInRequiredError(fileName: string): PersonalVaultOpenError {
  return new PersonalVaultOpenError({ code: 'VAULT_SIGN_IN_REQUIRED', fileName });
}

export function updateRequiredError(fileName: string, minVersion: string): PersonalVaultOpenError {
  return new PersonalVaultOpenError({ code: 'VAULT_UPDATE_REQUIRED', fileName, minVersion });
}

export interface ChangedElsewhereInput {
  readonly changedByDeviceName: string | null;
  readonly changedMs: number;
  readonly needsPreviousPassword: boolean;
  readonly deleteBiometric: boolean;
}

export function changedElsewhereError(input: ChangedElsewhereInput): PersonalVaultOpenError {
  return new PersonalVaultOpenError({ code: 'VAULT_PASSWORD_CHANGED_ELSEWHERE', ...input });
}

/** The take-over dialog's holder for an in-file owner claim (6.7 prompt at unlock). */
export function holderFromClaim(verdict: Extract<ClaimVerdict, { kind: 'other' }>): Holder {
  const p = verdict.presence;
  return {
    deviceId: verdict.claimantUuid,
    deviceName: p?.name ?? '',
    platform: p?.platform ?? '',
    fileName: p?.file_hint?.file_name ?? null,
    fileId: p?.file_hint?.file_id ?? null,
    location: p?.file_hint?.location ?? null,
    lastActiveMs: p?.last_active_ms ?? null,
    busySessions: 0,
    busyJobs: 0,
  };
}
