/**
 * Pending file candidates after a password change (spec 4.8, 4.9): the copy is a whole vault
 * file under whatever key its writer used, which cannot be re-keyed without rewriting its sync
 * history, so it is sealed instead: `<id>.conduit` becomes AES-GCM of the file's bytes under the
 * current epoch key (the vault's field format, nonce || ct || tag). The old password cannot
 * open it; the queue opens it into a private temp copy for each preview and merge. A sealed file
 * is told apart from a plain one by the SQLite header. Used only by candidate-queue.ts.
 */

import path from 'node:path';
import { FILE_SUFFIX } from './candidate-queue-store.js';
import { openSecret, ringOrder, sealSecretBytes } from './key-epoch.js';
import type { ReplicaPort } from './replica.js';
import { SYNC_LOG_PREFIX, type SyncHost } from './host.js';
import { SyncCoreError, type KeyRing } from './types.js';

/** Payloads are rewritten through this file and a rename, so a crash leaves the old or the new one. */
const REKEY_TMP_SUFFIX = '.rekey-tmp';
const OPEN_COPY_PREFIX = 'candidate-open-';
const TEMP_RAND_BYTES = 8;

/** What the file steps touch: the host, the replica's ring and tmp/, and candidates/. */
export interface SealIo {
  readonly host: Pick<SyncHost, 'fs' | 'random'>;
  readonly replica: Pick<ReplicaPort, 'ring' | 'paths'>;
  readonly dir: string;
}

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

/** Writes `data` over `file` through a durable temp file and a rename. */
export async function replaceDurably(io: SealIo, file: string, data: Uint8Array | string): Promise<void> {
  const { fs } = io.host;
  const tmp = `${file}${REKEY_TMP_SUFFIX}`;
  try {
    await fs.writeFileDurable(tmp, data);
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { recursive: false, force: true });
    throw err;
  }
  await fs.fsyncDir(io.dir);
}

/** A file payload sealed under ring.current. The mtime is kept: a replica candidate's legacy edits are dated by it. */
export async function sealFile(io: SealIo, file: string, ring: KeyRing): Promise<'rekeyed' | 'current' | 'unreachable'> {
  const { fs, random } = io.host;
  const st = await fs.stat(file);
  if (st === null) throw new Error(`${SYNC_LOG_PREFIX} the candidate file is missing`);
  const sealed = sealPayload(await fs.readFile(file), ring, (n) => random.bytes(n));
  if (sealed.kind !== 'sealed') return sealed.kind;
  await replaceDurably(io, file, sealed.bytes);
  await fs.utimes(file, st.mtimeMs, st.mtimeMs);
  return 'rekeyed';
}

/** `fn` on the plain vault file: the payload itself, or a private temp copy of it unsealed (removed afterwards). */
export async function withOpenedFile<T>(io: SealIo, file: string, fn: (plainPath: string) => T): Promise<T> {
  const { fs, random } = io.host;
  const bytes = await fs.readFile(file);
  const opened = openPayload(bytes, io.replica.ring());
  if (opened === null) throw new SyncCoreError('KEY_MISMATCH', 'the candidate copy is sealed under a key this device cannot reach');
  if (opened === bytes) return fn(file);
  const tmpDir = io.replica.paths.tmp;
  await fs.mkdir(tmpDir);
  const plainPath = path.join(tmpDir, `${OPEN_COPY_PREFIX}${random.bytes(TEMP_RAND_BYTES).toString('hex')}${FILE_SUFFIX}`);
  await fs.writeFile(plainPath, opened);
  try {
    return fn(plainPath);
  } finally {
    await fs.rm(plainPath, { recursive: false, force: true });
  }
}
