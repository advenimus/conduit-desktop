/**
 * The shared file S as whole bytes (spec 5.2, 5.3, 12 rows 18/22/33/44/52/60): read S into
 * `incoming/` (never its -wal/-shm), classify it (unreadable / foreign newer format / foreign
 * other vault / pre-sync / synced), the torn-file retry and quarantine rule, VACUUM INTO of W,
 * the CAS publish (re-read and compare SHA-256, tmp + fsync + mtime bump + rename + dir fsync,
 * EPERM/EBUSY retries, in-place fallback) and cleanup of publish temps and staged copies.
 * A file is only ever replaced because it is unreadable, never because it is unexpected.
 *
 * Parts: shared-file-types.ts (constants, shapes), shared-file-read.ts (read, stage,
 * quarantine, incoming cleanup), shared-file-classify.ts (header, classify, torn rule),
 * shared-file-publish.ts (VACUUM INTO, CAS publish, temp cleanup).
 */

import type Database from 'better-sqlite3';
import { classifyStaged } from './shared-file-classify.js';
import { cleanupPublishTemps, publishIfUnchanged, vacuumInto } from './shared-file-publish.js';
import { cleanupIncoming, quarantine, readShared } from './shared-file-read.js';
import type {
  ClassifyExpectation,
  PublishInput,
  PublishOutcome,
  SharedClass,
  SharedFileHost,
  SharedReadOutcome,
  SharedSnapshot,
} from './shared-file-types.js';

export * from './shared-file-types.js';
export { TornTracker, checkHeader, classifyStaged } from './shared-file-classify.js';
export { cleanupPublishTemps, publishIfUnchanged, publishMtime, vacuumInto } from './shared-file-publish.js';
export { cleanupIncoming, quarantine, readShared, sha256Hex } from './shared-file-read.js';

/** The functions above as one injectable object (the engine's dependency). */
export interface SharedFilePort {
  read(sharedPath: string, incomingDir: string): Promise<SharedReadOutcome>;
  classify(snapshot: SharedSnapshot, expect: ClassifyExpectation): SharedClass;
  vacuumInto(db: Database.Database, target: string): void;
  publish(input: PublishInput): Promise<PublishOutcome>;
  quarantine(snapshot: SharedSnapshot, quarantineDir: string): Promise<string>;
  cleanupPublishTemps(sharedDir: string, nowMs: number): Promise<number>;
  cleanupIncoming(incomingDir: string, keep: readonly string[]): Promise<number>;
}

export function createSharedFile(host: SharedFileHost): SharedFilePort {
  return {
    read: (sharedPath, incomingDir) => readShared(sharedPath, incomingDir, host),
    classify: (snapshot, expect) => classifyStaged(snapshot, expect),
    vacuumInto: (db, target) => vacuumInto(db, target, host.logger),
    publish: (input) => publishIfUnchanged(input, host),
    quarantine: (snapshot, dir) => quarantine(snapshot, dir, host),
    cleanupPublishTemps: (dir, nowMs) => cleanupPublishTemps(dir, nowMs, host),
    cleanupIncoming: (dir, keep) => cleanupIncoming(dir, keep, host),
  };
}
