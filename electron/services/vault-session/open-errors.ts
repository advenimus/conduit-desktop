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
  | 'VAULT_WORKING_COPY_DAMAGED';

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
    };

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
}

export function openElsewhereError(input: OpenElsewhereInput): PersonalVaultOpenError {
  const own = input.ownLocation.toLowerCase();
  const locationDiffers = input.holders.some((h) => h.location !== null && h.location.toLowerCase() !== own);
  return new PersonalVaultOpenError({
    code: 'VAULT_OPEN_ELSEWHERE',
    holders: input.holders,
    limit: input.limit,
    fileName: input.fileName,
    locationDiffers,
    via: input.via,
  });
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
