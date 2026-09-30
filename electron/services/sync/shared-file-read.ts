/**
 * Reading S (spec 5.2): stat, bytes, stat again (re-read while S changes underneath), the
 * SHA-256, and the private staged copy incoming/<sha>.conduit. Also the quarantine copy of a
 * torn file and the pruning of staged copies. S-wal and S-shm are never read.
 * Import through shared-file.ts.
 */

import path from 'node:path';
import { sha256 } from './hashing.js';
import { SYNC_LOG_PREFIX, type FileStat } from './host.js';
import {
  PUBLISH_TEMP_MAX_AGE_MS,
  READ_STABLE_ATTEMPTS,
  STAGED_KEEP,
  type SharedFileHost,
  type SharedReadOutcome,
  type SharedSnapshot,
} from './shared-file-types.js';

const STAGED_EXT = '.conduit';
const STAGED_NAME_RE = /^[0-9a-f]{64}\.conduit$/;
const STAGING_TEMP_RE = /^\.[0-9a-f]{64}\.[0-9a-f]+\.tmp$/;
/** SQLite companions a classify may leave next to a staged copy after a crash. */
const STAGED_COMPANIONS = ['-wal', '-shm', '-journal'] as const;
const TEMP_RAND_BYTES = 6;
const SHA8 = 8;
const MISSING_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

export function sha256Hex(bytes: Uint8Array): string {
  return sha256(bytes).toString('hex');
}

/** Node errno code of an error, or null. */
export function errnoCodeOf(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

export function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sameStat(a: FileStat, b: FileStat): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

interface RawRead {
  readonly bytes: Buffer;
  readonly stat: FileStat;
  readonly stable: boolean;
}

type ReadStep = { readonly kind: 'read'; readonly value: RawRead } | Exclude<SharedReadOutcome, { kind: 'ok' }>;

function failureOf(err: unknown): Exclude<SharedReadOutcome, { kind: 'ok' }> {
  const code = errnoCodeOf(err);
  if (code !== null && MISSING_CODES.has(code)) return { kind: 'missing' };
  return { kind: 'unreachable', code: code ?? 'UNKNOWN' };
}

async function readOnce(sharedPath: string, host: SharedFileHost): Promise<ReadStep> {
  try {
    const before = await host.fs.stat(sharedPath);
    if (before === null) return { kind: 'missing' };
    const bytes = await host.fs.readFile(sharedPath);
    const after = await host.fs.stat(sharedPath);
    if (after === null) return { kind: 'missing' };
    return { kind: 'read', value: { bytes, stat: after, stable: sameStat(before, after) && after.size === bytes.length } };
  } catch (err) {
    return failureOf(err);
  }
}

/**
 * Reads S (stat, bytes, stat again; re-read up to READ_STABLE_ATTEMPTS when S changed during
 * the read), hashes it and stages the bytes as incoming/<sha>.conduit. Never touches S-wal/S-shm.
 */
export async function readShared(sharedPath: string, incomingDir: string, host: SharedFileHost): Promise<SharedReadOutcome> {
  let last: RawRead | null = null;
  for (let attempt = 0; attempt < READ_STABLE_ATTEMPTS; attempt++) {
    const step = await readOnce(sharedPath, host);
    if (step.kind !== 'read') return step;
    last = step.value;
    if (last.stable) break;
    host.logger.debug(`${SYNC_LOG_PREFIX} shared file changed while it was read; reading again`, { attempt });
  }
  if (last === null) throw new Error(`${SYNC_LOG_PREFIX} readShared made no attempt`);
  const sha = sha256Hex(last.bytes);
  const stagedPath = await stageBytes(incomingDir, sha, last.bytes, host);
  const snapshot: SharedSnapshot = { path: sharedPath, bytes: last.bytes, sha256: sha, stat: last.stat, stagedPath };
  return { kind: 'ok', snapshot };
}

/** incoming/<sha>.conduit via tmp + rename; an existing staged copy of the same SHA is reused. */
async function stageBytes(incomingDir: string, sha: string, bytes: Buffer, host: SharedFileHost): Promise<string> {
  const staged = path.join(incomingDir, `${sha}${STAGED_EXT}`);
  const existing = await host.fs.stat(staged);
  if (existing !== null && existing.isFile && existing.size === bytes.length) return staged;
  await host.fs.mkdir(incomingDir);
  const tmp = path.join(incomingDir, `.${sha}.${host.random.bytes(TEMP_RAND_BYTES).toString('hex')}.tmp`);
  try {
    await host.fs.writeFile(tmp, bytes);
    await host.fs.rename(tmp, staged);
  } catch (err) {
    host.logger.error(`${SYNC_LOG_PREFIX} staging the shared file failed`, { code: errnoCodeOf(err), sha8: sha.slice(0, SHA8) });
    await removeQuietly(tmp, host);
    throw err;
  }
  return staged;
}

/** Best-effort removal after a failure; the original error is what the caller reports. */
export async function removeQuietly(p: string, host: SharedFileHost): Promise<void> {
  try {
    await host.fs.rm(p, { recursive: false, force: true });
  } catch (err) {
    host.logger.warn(`${SYNC_LOG_PREFIX} could not remove a temporary file`, { file: path.basename(p), code: errnoCodeOf(err) });
  }
}

/** Copies the staged bytes to quarantine/<ts>-<sha8>.conduit once per SHA-256; returns the path. */
export async function quarantine(snapshot: SharedSnapshot, quarantineDir: string, host: SharedFileHost): Promise<string> {
  const existing = await findQuarantined(quarantineDir, snapshot, host);
  if (existing !== null) return existing;
  await host.fs.mkdir(quarantineDir);
  const target = path.join(quarantineDir, `${host.clock.now()}-${snapshot.sha256.slice(0, SHA8)}${STAGED_EXT}`);
  if ((await host.fs.stat(target)) !== null) return target;
  await host.fs.writeFileDurable(target, snapshot.bytes);
  host.logger.warn(`${SYNC_LOG_PREFIX} unreadable shared file quarantined`, {
    sha8: snapshot.sha256.slice(0, SHA8),
    size: snapshot.bytes.length,
  });
  return target;
}

/** A quarantined copy of exactly these bytes (the name carries only 8 hex of the SHA-256). */
async function findQuarantined(dir: string, snapshot: SharedSnapshot, host: SharedFileHost): Promise<string | null> {
  const names = await listDir(dir, host);
  if (names === null) return null;
  const suffix = `-${snapshot.sha256.slice(0, SHA8)}${STAGED_EXT}`;
  for (const name of names) {
    if (!name.endsWith(suffix)) continue;
    const p = path.join(dir, name);
    const st = await host.fs.stat(p);
    if (st === null || st.size !== snapshot.bytes.length) continue;
    if (sha256Hex(await host.fs.readFile(p)) === snapshot.sha256) return p;
  }
  return null;
}

interface StagedEntry {
  readonly name: string;
  readonly sha: string;
  readonly mtimeMs: number;
}

/** Removes staged copies in incoming/ except `keep` SHAs and the STAGED_KEEP newest; returns the count. */
export async function cleanupIncoming(incomingDir: string, keep: readonly string[], host: SharedFileHost): Promise<number> {
  const names = await listDir(incomingDir, host);
  if (names === null) return 0;
  const keepSet = new Set(keep);
  const staged: StagedEntry[] = [];
  let removed = 0;
  for (const name of names) {
    if (STAGING_TEMP_RE.test(name)) {
      removed += await removeOldTemp(path.join(incomingDir, name), host);
      continue;
    }
    if (!STAGED_NAME_RE.test(name)) continue;
    const sha = name.slice(0, -STAGED_EXT.length);
    if (keepSet.has(sha)) continue;
    const st = await host.fs.stat(path.join(incomingDir, name));
    if (st !== null) staged.push({ name, sha, mtimeMs: st.mtimeMs });
  }
  staged.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : 1));
  for (const entry of staged.slice(STAGED_KEEP)) {
    if (await removeStaged(path.join(incomingDir, entry.name), host)) removed++;
  }
  return removed;
}

/** Entry names, or null when the folder does not exist. Other failures are logged and rethrown. */
export async function listDir(dir: string, host: SharedFileHost): Promise<string[] | null> {
  try {
    return await host.fs.readdir(dir);
  } catch (err) {
    const code = errnoCodeOf(err);
    if (code !== null && MISSING_CODES.has(code)) return null;
    host.logger.warn(`${SYNC_LOG_PREFIX} could not list a folder`, { folder: path.basename(dir), code });
    throw err;
  }
}

async function removeOldTemp(p: string, host: SharedFileHost): Promise<number> {
  const st = await host.fs.stat(p);
  if (st === null || host.clock.now() - st.mtimeMs <= PUBLISH_TEMP_MAX_AGE_MS) return 0;
  return (await removeStaged(p, host)) ? 1 : 0;
}

async function removeStaged(p: string, host: SharedFileHost): Promise<boolean> {
  try {
    await host.fs.rm(p, { recursive: false, force: true });
    for (const suffix of STAGED_COMPANIONS) await host.fs.rm(`${p}${suffix}`, { recursive: false, force: true });
    return true;
  } catch (err) {
    host.logger.warn(`${SYNC_LOG_PREFIX} could not remove a staged copy`, { file: path.basename(p), code: errnoCodeOf(err) });
    return false;
  }
}
