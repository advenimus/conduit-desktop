/**
 * Pending file candidates after a password change (spec 4.8, 4.9): the copy is a whole vault
 * file under whatever key its writer used, which cannot be re-keyed without rewriting its sync
 * history, so it is sealed instead: `<id>.conduit` becomes AES-GCM of the file's bytes under the
 * current epoch key (the vault's field format, nonce || ct || tag). The old password cannot
 * open it; the queue opens it into a private temp copy for each preview and merge. A sealed file
 * is told apart from a plain one by the SQLite header. Import through candidate-queue.ts.
 */

import { openSecret, ringOrder, sealSecretBytes } from './key-epoch.js';
import type { KeyRing } from './types.js';

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

export function isPlainVault(bytes: Buffer): boolean {
  return bytes.length >= SQLITE_MAGIC.length && bytes.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC);
}

/** The vault bytes of a candidate payload: as they are, or unsealed with a ring key; null when no key opens them. */
export function openPayload(bytes: Buffer, ring: KeyRing): Buffer | null {
  if (isPlainVault(bytes)) return bytes;
  for (const keys of ringOrder(ring)) {
    const opened = openSecret(bytes, keys.kEpoch);
    if (opened !== null && isPlainVault(opened)) return opened;
  }
  return null;
}

export type SealOutcome =
  | { readonly kind: 'current' }
  | { readonly kind: 'sealed'; readonly bytes: Buffer }
  /** No key of the ring opens it: the copy can no longer be reviewed. */
  | { readonly kind: 'unreachable' };

/** `bytes` sealed under ring.current, or 'current' when they already are. */
export function sealPayload(bytes: Buffer, ring: KeyRing, randomBytes: (n: number) => Buffer): SealOutcome {
  if (!isPlainVault(bytes) && openSecret(bytes, ring.current.kEpoch) !== null) return { kind: 'current' };
  const inner = openPayload(bytes, ring);
  if (inner === null) return { kind: 'unreachable' };
  return { kind: 'sealed', bytes: sealSecretBytes(inner, ring.current.kEpoch, randomBytes) };
}
