/**
 * Candidate previews against the replica's current state (spec 4.9): a replica
 * copy is absorbed against its own tables under its own epoch (absorbReplicaCandidate); a
 * synthetic file is diffed from its content; G3 leftovers come from their rows, their secrets
 * re-encrypted into the current epoch when a password change happened since they were queued.
 * Always recomputed, never cached across commits. Import through candidate-queue.ts.
 */

import Database from 'better-sqlite3';
import { absorbReplicaCandidate, buildSyntheticCandidate, buildSyntheticFromRows } from './candidates.js';
import { registerDef } from './catalog.js';
import { vhashOfSecret } from './hashing.js';
import { encryptSecret, readSecret } from './key-epoch.js';
import { loadContent, loadFile } from './state-store.js';
import { currentEpochId, recoveryFrom } from './state-view.js';
import type { PendingCandidate } from './candidate-queue.js';
import type { ReplicaPort } from './replica.js';
import {
  SIB_UNDECRYPTABLE,
  SyncCoreError,
  type CandidatePreview,
  type CandidateRowValues,
  type CandidateRows,
  type CandidateValue,
  type ContentSnapshot,
  type KeyRing,
  type LoadedFile,
  type RowKey,
  type SyncState,
} from './types.js';

export interface Computed {
  readonly preview: CandidatePreview;
  /** Merged into W by apply (commitWith(w => merge(w, state))). */
  readonly state: SyncState;
  /** dev_syn of a synthetic candidate (its label goes to candidateLabels), else null. */
  readonly syntheticDev: number | null;
}

export interface ComputeInput {
  readonly replica: ReplicaPort;
  readonly candidate: PendingCandidate;
  /** mtime of a file payload (legacy delete times), ignored for rows. */
  readonly fileMtimeMs: number;
  /** Decoded rows payload for rows candidates. */
  readonly rows: CandidateRows | null;
}

function withPrivateDb<T>(file: string, fn: (db: Database.Database) => T): T {
  const db = new Database(file, { fileMustExist: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function loadCandidateFile(file: string): LoadedFile {
  return withPrivateDb(file, (db) => loadFile(db));
}

export function loadCandidateContent(file: string): ContentSnapshot {
  return withPrivateDb(file, (db) => loadContent(db));
}

function rekeyValue(row: RowKey, reg: string, v: CandidateValue, replica: ReplicaPort, ring: KeyRing): CandidateValue {
  const key = { tbl: row.tbl, rowId: row.rowId, reg };
  const def = registerDef(key);
  if (def === null || !def.secret || !(v.value instanceof Uint8Array) || (v.flags & SIB_UNDECRYPTABLE) !== 0) return v;
  const read = readSecret(v.value, ring);
  if (read.kind === 'undecryptable') return { ...v, flags: v.flags | SIB_UNDECRYPTABLE };
  const rand = (n: number): Buffer => replica.context().randomBytes(n);
  return { value: encryptSecret(read.plaintext, ring.current, rand), vhash: vhashOfSecret(key, read.plaintext, ring.current.kSync), flags: v.flags };
}

/** Rows queued under another epoch: secrets re-encrypted and re-hashed under the current one. */
export function rowsInCurrentEpoch(rows: CandidateRows, epochId: string, replica: ReplicaPort): CandidateRows {
  const ring = replica.ring();
  if (epochId === ring.current.epochId) return rows;
  const out = new Map<string, CandidateRowValues>();
  for (const [k, r] of rows) {
    const values = new Map<string, CandidateValue>();
    for (const [reg, v] of r.values) values.set(reg, rekeyValue(r.row, reg, v, replica, ring));
    out.set(k, { ...r, values });
  }
  return out;
}

function computeReplica(input: ComputeInput, file: LoadedFile, m: SyncState): Computed {
  const { replica, candidate } = input;
  const epoch = currentEpochId(file.state);
  const absorbKeys = epoch === null ? undefined : replica.ring().byEpoch.get(epoch);
  if (absorbKeys === undefined) throw new SyncCoreError('KEY_MISMATCH', 'the candidate is under a key epoch this device cannot reach');
  if (candidate.payload.kind !== 'file') throw new Error('[sync] a replica candidate needs a file payload');
  const att = {
    kind: 'legacy',
    observedMtimeMs: Math.floor(input.fileMtimeMs),
    sideFilesPresent: false,
    serverSideFilesFlagRecent: false,
    absorbKeys,
    sourceSha256: candidate.payload.sha256,
    recover: recoveryFrom(m),
  } as const;
  const meta = { source: candidate.source, label: candidate.label };
  const res = absorbReplicaCandidate(file, m, att, meta, replica.context(), replica.implicit());
  return { preview: res.preview, state: res.state, syntheticDev: null };
}

/** Preview and mergeable state of one pending candidate against W as it is now. */
export function computeCandidate(input: ComputeInput): Computed {
  const { replica, candidate } = input;
  const m = replica.state();
  const ctx = replica.context();
  const implicit = replica.implicit();
  const opts = { source: candidate.source, label: candidate.label, staleByNature: candidate.staleByNature };
  const mContent = loadContent(replica.database());
  const payload = candidate.payload;
  if (payload.kind === 'rows') {
    const rows = rowsInCurrentEpoch(input.rows ?? new Map(), payload.epochId, replica);
    const syn = buildSyntheticFromRows(m, mContent, rows, opts, ctx, implicit);
    return { preview: syn.preview, state: syn.state, syntheticDev: syn.dev };
  }
  if (candidate.kind === 'replica') return computeReplica(input, loadCandidateFile(payload.path), m);
  const syn = buildSyntheticCandidate(m, mContent, loadCandidateContent(payload.path), opts, ctx, implicit);
  return { preview: syn.preview, state: syn.state, syntheticDev: syn.dev };
}
