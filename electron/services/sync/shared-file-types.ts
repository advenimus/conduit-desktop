/**
 * Constants and shapes of shared-file.ts (spec 5.2, 5.3). Import through shared-file.ts.
 */

import type { FileKeyMeta } from './key-epoch.js';
import type { FileStat, SyncHost } from './host.js';
import type { ContentSnapshot, LoadedFile } from './types.js';

/** 5.2: unreadable retries at 5, 15 and 45 s after the first observation. */
export const TORN_RETRY_DELAYS_MS = [5_000, 15_000, 45_000] as const;
/** 5.2: quarantine and republish once the same unreadable bytes stayed for 2 minutes. */
export const TORN_QUARANTINE_AFTER_MS = 120_000;
/** 5.3 step 5: Windows EPERM/EBUSY retries before the in-place fallback. */
export const PUBLISH_RETRY_DELAYS_MS = [100, 500, 2_000, 5_000] as const;
/** 5.3 step 4: published mtime = max(now, observed S mtime + 2 s). */
export const PUBLISH_MTIME_BUMP_MS = 2_000;
/** 5.3 step 6: leftover `.~*.tmp` files older than 1 hour are removed at start-up. */
export const PUBLISH_TEMP_MAX_AGE_MS = 60 * 60 * 1000;
/** Staged copies kept in incoming/ besides the ones in use. */
export const STAGED_KEEP = 3;
/** Re-reads when S changed while it was being read (stat before and after differ). */
export const READ_STABLE_ATTEMPTS = 3;
export const SQLITE_MAGIC = 'SQLite format 3\u0000';
export const PUBLISH_RETRY_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY']);

/** S read once: bytes, hash, stat, and its private staged copy under incoming/. */
export interface SharedSnapshot {
  readonly path: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly stat: FileStat;
  /** incoming/<sha256>.conduit (written once per distinct SHA). */
  readonly stagedPath: string;
}

export type SharedReadOutcome =
  | { readonly kind: 'ok'; readonly snapshot: SharedSnapshot }
  /** ENOENT/ENOTDIR on S (the folder is reachable). */
  | { readonly kind: 'missing' }
  /** The folder itself failed (EIO, ETIMEDOUT, EACCES, ENOTCONN...): "Offline". */
  | { readonly kind: 'unreachable'; readonly code: string };

export type UnreadableReason =
  | 'magic'
  | 'page-size'
  | 'page-count'
  | 'open-failed'
  | 'quick-check'
  | 'missing-tables'
  | 'corrupt-sync-state';

export type SharedClass =
  | { readonly kind: 'unreadable'; readonly reason: UnreadableReason }
  | { readonly kind: 'foreign-newer'; readonly syncFormat: number }
  /** Sync tables with another lineage, or no vault_meta salt and verification at all. */
  | { readonly kind: 'foreign-other'; readonly lineageId: string | null; readonly reason: 'lineage' | 'not-conduit' }
  /** No sync tables: G1 or G2 (4.4). `meta` is vault_meta salt/verification. */
  | { readonly kind: 'presync'; readonly content: ContentSnapshot; readonly meta: FileKeyMeta }
  | { readonly kind: 'synced'; readonly file: LoadedFile; readonly meta: FileKeyMeta };

export interface ClassifyExpectation {
  /** W's lineage; null accepts any lineage (the peek before the lineage is known). */
  readonly lineageId: string | null;
}

export type TornVerdict =
  | { readonly kind: 'retry'; readonly atMs: number }
  | { readonly kind: 'quarantine' }
  /** These bytes were already quarantined: republish without copying them again. */
  | { readonly kind: 'republish' };

export interface PublishInput {
  readonly sharedPath: string;
  /** VACUUM INTO output under the lineage tmp/ folder. Removed after the publish attempt. */
  readonly snapshotPath: string;
  /** CAS: the SHA-256 of S that was merged; null means S must not exist (first publish). */
  readonly expectedSha256: string | null;
  /** mtime of S as last observed (for the bump); null when S did not exist. */
  readonly observedMtimeMs: number | null;
}

export type PublishOutcome =
  | { readonly kind: 'published'; readonly sha256: string; readonly mtimeMs: number; readonly inPlace: boolean }
  /** CAS failed: S changed since it was merged (back to the loop). */
  | { readonly kind: 'changed'; readonly currentSha256: string | null }
  | { readonly kind: 'failed'; readonly code: string | null; readonly message: string };

export type SharedFileHost = Pick<SyncHost, 'fs' | 'clock' | 'timers' | 'random' | 'logger' | 'paths'>;
