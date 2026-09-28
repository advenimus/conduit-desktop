// Shapes and file helpers of the core end-to-end harness (core-e2e-harness.ts): what a
// simulated device knows about the legacy source, a staged shared file, the outcome of one
// sync cycle, publishing with VACUUM INTO and staging S into incoming/ (5.2, 5.3).
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AlignResult, FileKeyMeta } from '../key-epoch.js';
import { loadFile } from '../state-store.js';
import type { EpochKeys, KeyRing, LoadedFile } from '../types.js';

/** What every device knows about the legacy file both devices migrate. */
export interface LegacySource {
  readonly bytes: Buffer;
  readonly key: Buffer;
  readonly lineageId: string;
  readonly genesisId: string;
}

export interface SharedFile {
  readonly file: LoadedFile;
  readonly sha256: string;
  readonly mtimeMs: number;
  readonly meta: FileKeyMeta;
}

export type SyncOutcome =
  | {
      readonly kind: 'merged';
      /** The full capture pass before the merge recorded a change (it should not). */
      readonly prePassChanged: boolean;
      /** Absorbing S against its own tables found legacy edits (a sync-aware publisher leaves none). */
      readonly absorbChanged: boolean;
      /** digest(M) == digest(S1): nothing to publish (5.6 termination). */
      readonly upToDate: boolean;
      readonly invariantViolations: number;
    }
  | { readonly kind: 'paused'; readonly align: Exclude<AlignResult, { kind: 'proceed' }> };

export interface DeviceOptions {
  readonly name: string;
  readonly root: string;
  readonly source: LegacySource;
  readonly now: () => number;
}

export const INCOMING_DIR = 'incoming';
const TMP_SUFFIX_BYTES = 4;

export function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function ringOf(current: EpochKeys): KeyRing {
  return { current, byEpoch: new Map([[current.epochId, current]]) };
}

function metaOf(file: LoadedFile): FileKeyMeta {
  return { salt: file.content.meta.get('salt') ?? null, verification: file.content.meta.get('verification') ?? null };
}

function sqlQuote(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

/** 5.3 without the CAS and mtime rules: VACUUM INTO a temp file, then rename over S. */
export function publishFile(db: Database.Database, sharedPath: string): void {
  const tmp = `${sharedPath}.${crypto.randomBytes(TMP_SUFFIX_BYTES).toString('hex')}.tmp`;
  db.exec(`VACUUM INTO ${sqlQuote(tmp)}`);
  fs.renameSync(tmp, sharedPath);
}

/** 5.2: stage S's bytes into `{deviceDir}/incoming/` and load the staged copy read-only. */
export function readSharedFile(deviceDir: string, sharedPath: string): SharedFile {
  const bytes = fs.readFileSync(sharedPath);
  const sha256 = sha256Hex(bytes);
  const staged = path.join(deviceDir, INCOMING_DIR, `${sha256}.conduit`);
  fs.writeFileSync(staged, bytes);
  const sdb = new Database(staged, { readonly: true, fileMustExist: true });
  try {
    const file = loadFile(sdb);
    return { file, sha256, mtimeMs: fs.statSync(sharedPath).mtimeMs, meta: metaOf(file) };
  } finally {
    sdb.close();
  }
}
