/**
 * Pending candidates (spec 4.4 G2 step 3 and G3 step 3, 4.9, 5.5 WAL review, 5.8 class 4 and
 * same-device copies, 7.3 "Candidate"): files or row sets waiting for the user's
 * [Merge and review] / [Don't merge]. Each pending candidate is persisted under
 * {lineage}/candidates/ (a private file copy, or a JSON of CandidateRows encoded with
 * value-codec) plus a small meta JSON, so nothing waits only in memory. Previews and merges
 * run against the replica's current state through core candidates.ts; applying commits
 * through the replica and records the candidate label in local.json candidateLabels.
 * After a password change, rows move to the new epoch and file copies are sealed under its
 * key (candidate-queue-seal.ts), so the old password opens neither.
 * Parts: candidate-queue-store.ts (files), candidate-queue-compute.ts (previews),
 * candidate-queue-seal.ts (sealed file copies).
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { classifyCandidate, deleteMissingWrites, type CandidateFileInfo } from './candidates.js';
import { IGNORED_COPIES_KEEP } from './copy-scanner.js';
import { merge } from './merge.js';
import { computeCandidate, rowsUnderRing } from './candidate-queue-compute.js';
import { replaceDurably, sealFile, withOpenedFile, type SealIo } from './candidate-queue-seal.js';
import { FILE_SUFFIX, ROWS_SUFFIX, decodeMeta, decodeRows, encodeMeta, encodeRows, idOfMetaName, isCandidateId, metaName } from './candidate-queue-store.js';
import type { CommitOutcome, ReplicaPort } from './replica.js';
import type { NoticesPort } from './notices.js';
import type { SharedClass, SharedFilePort } from './shared-file.js';
import { SYNC_LOG_PREFIX, type SyncHost } from './host.js';
import type { CandidateKind, CandidatePreview, CandidateRows, CandidateSource, KeyRing, RowKey } from './types.js';

export const CANDIDATES_DIR = 'candidates';

export type PendingPayload =
  /** A private SQLite copy owned by the queue (copied or moved into candidates/). */
  | { readonly kind: 'file'; readonly path: string; readonly sha256: string }
  /** G3 leftovers: row values (secrets as ciphertext under `epochId`). */
  | { readonly kind: 'rows'; readonly path: string; readonly epochId: string };

export interface PendingCandidate {
  readonly id: string;
  readonly source: CandidateSource;
  readonly label: string;
  /** Replica or synthetic, decided at add time (candidates.classifyCandidate) for files; rows are synthetic. */
  readonly kind: CandidateKind;
  /** 1.0.5 sandbox, pre-sync files, G3 leftovers: newer-only filter (4.9). */
  readonly staleByNature: boolean;
  readonly payload: PendingPayload;
  readonly createdMs: number;
}

export interface AddFileInput {
  /** Private copy to take over (moved into candidates/); never a user file in place. */
  readonly path: string;
  readonly source: CandidateSource;
  readonly label: string;
  readonly staleByNature: boolean;
}

export interface AddRowsInput {
  readonly rows: CandidateRows;
  readonly epochId: string;
  readonly source: CandidateSource;
  readonly label: string;
}

export interface ApplyChoice {
  /** "Items missing from this copy" the user chose [Delete them too] for. */
  readonly deleteMissing: readonly RowKey[];
}

export interface CandidateRekeyReport {
  /** Payloads now under the ring's current epoch (rows re-encrypted, files sealed). */
  readonly rekeyed: number;
  /** Removed: no key of the ring opens them any more. */
  readonly dropped: readonly PendingCandidate[];
  /** Left as they were after an error (logged). */
  readonly failed: number;
}

export interface CandidateQueuePort {
  addFile(input: AddFileInput): Promise<PendingCandidate>;
  addRows(input: AddRowsInput): Promise<PendingCandidate>;
  list(): readonly PendingCandidate[];
  /** Recomputed against the replica's current state on every call (never cached across commits). */
  preview(id: string): Promise<CandidatePreview>;
  /**
   * [Merge and review]: replica absorb (absorbReplicaCandidate) or synthetic mint
   * (buildSyntheticCandidate / buildSyntheticFromRows), merge via replica.commitWith, then the
   * deleteMissing writes (one interactive dot), label into candidateLabels, payload removed.
   */
  apply(id: string, choice: ApplyChoice): Promise<CommitOutcome>;
  /** [Don't merge] / [Discard]: removes the payload; a copy's SHA-256 goes to ignoredCopies. */
  discard(id: string): Promise<void>;
  /** Rediscovers pending candidates from candidates/ at start. Corrupt entries are parked. */
  load(): Promise<void>;
  /** load() once for this queue: the unlock cycle runs before start's housekeeping loads it. */
  ensureLoaded(): Promise<void>;
  /** 4.8 after a password change: every payload moved to ring.current (rows) or sealed under it (files). Never throws. */
  rekey(ring: KeyRing): Promise<CandidateRekeyReport>;
}

export interface CandidateQueueDeps {
  readonly replica: ReplicaPort;
  readonly shared: Pick<SharedFilePort, 'classify'>;
  readonly notices: Pick<NoticesPort, 'add'>;
  readonly host: Pick<SyncHost, 'fs' | 'clock' | 'random' | 'logger'>;
}

function errCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

/** What classifyCandidate needs; files that are not a readable Conduit vault are refused. */
function fileInfo(cls: SharedClass): CandidateFileInfo | null {
  if (cls.kind === 'synced') return { hasSyncTables: true, lineageId: cls.file.state.lineageId, genesisId: cls.file.state.genesisId };
  if (cls.kind === 'presync') return { hasSyncTables: false, lineageId: null, genesisId: null };
  if (cls.kind === 'foreign-other' && cls.reason === 'lineage') return { hasSyncTables: true, lineageId: cls.lineageId, genesisId: null };
  return null;
}

export class CandidateQueue implements CandidateQueuePort {
  private readonly pending = new Map<string, PendingCandidate>();
  private loaded: Promise<void> | null = null;

  constructor(private readonly deps: CandidateQueueDeps) {}

  private dir(): string {
    return path.join(this.deps.replica.paths.dir, CANDIDATES_DIR);
  }

  async addFile(input: AddFileInput): Promise<PendingCandidate> {
    const { host, shared, replica } = this.deps;
    const id = host.random.uuid();
    await host.fs.mkdir(this.dir());
    const target = path.join(this.dir(), `${id}${FILE_SUFFIX}`);
    await this.move(input.path, target);
    const bytes = await host.fs.readFile(target);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const stat = await host.fs.stat(target);
    if (stat === null) throw new Error(`${SYNC_LOG_PREFIX} the candidate copy vanished`);
    const cls = shared.classify({ path: target, bytes, sha256, stat, stagedPath: target }, { lineageId: null });
    const info = fileInfo(cls);
    if (info === null) {
      await this.park([target]);
      throw new Error(`${SYNC_LOG_PREFIX} the candidate is not a readable Conduit vault (${cls.kind})`);
    }
    const c: PendingCandidate = Object.freeze({
      id,
      source: input.source,
      label: input.label,
      kind: classifyCandidate(info, replica.state()),
      staleByNature: input.staleByNature,
      payload: Object.freeze({ kind: 'file', path: target, sha256 }),
      createdMs: host.clock.now(),
    });
    return this.remember(c);
  }

  async addRows(input: AddRowsInput): Promise<PendingCandidate> {
    const { host } = this.deps;
    const id = host.random.uuid();
    await host.fs.mkdir(this.dir());
    const file = path.join(this.dir(), `${id}${ROWS_SUFFIX}`);
    await host.fs.writeFileDurable(file, encodeRows(input.rows));
    const c: PendingCandidate = Object.freeze({
      id,
      source: input.source,
      label: input.label,
      kind: 'synthetic',
      staleByNature: true,
      payload: Object.freeze({ kind: 'rows', path: file, epochId: input.epochId }),
      createdMs: host.clock.now(),
    });
    return this.remember(c);
  }

  list(): readonly PendingCandidate[] {
    return Object.freeze([...this.pending.values()]);
  }

  async preview(id: string): Promise<CandidatePreview> {
    return (await this.compute(this.require(id))).preview;
  }

  async apply(id: string, choice: ApplyChoice): Promise<CommitOutcome> {
    const c = this.require(id);
    const { replica } = this.deps;
    const computed = await this.compute(c);
    let out = replica.commitWith((w) => merge(w, computed.state, replica.implicit()).state);
    const writes = deleteMissingWrites(out.state, choice.deleteMissing, replica.context());
    if (writes.length > 0) {
      replica.applyWrites(writes, { interactive: true });
      out = { ...out, state: replica.state(), generation: replica.generation() };
    }
    if (computed.syntheticDev !== null) {
      const dev = String(computed.syntheticDev);
      replica.updateLocal((l) => ({ ...l, candidateLabels: { ...l.candidateLabels, [dev]: c.label } }));
    }
    await this.remove(c);
    this.deps.host.logger.info(`${SYNC_LOG_PREFIX} candidate merged`, { source: c.source, kind: c.kind, deletes: writes.length });
    return out;
  }

  async discard(id: string): Promise<void> {
    const c = this.require(id);
    if (c.payload.kind === 'file' && c.source === 'copy') {
      const sha = c.payload.sha256;
      this.deps.replica.updateLocal((l) =>
        l.ignoredCopies.includes(sha) ? l : { ...l, ignoredCopies: [...l.ignoredCopies, sha].slice(-IGNORED_COPIES_KEEP) },
      );
    }
    await this.remove(c);
    this.deps.host.logger.info(`${SYNC_LOG_PREFIX} candidate discarded`, { source: c.source });
  }

  ensureLoaded(): Promise<void> {
    this.loaded ??= this.load().catch((err: unknown) => {
      this.loaded = null;
      throw err;
    });
    return this.loaded;
  }

  async load(): Promise<void> {
    const { host } = this.deps;
    await host.fs.mkdir(this.dir());
    const names = await host.fs.readdir(this.dir());
    const found: PendingCandidate[] = [];
    for (const name of names) {
      const id = idOfMetaName(name);
      if (id === null || this.pending.has(id)) continue;
      const c = await this.readEntry(id);
      if (c !== null) found.push(c);
    }
    for (const c of found.sort((a, b) => a.createdMs - b.createdMs)) this.pending.set(c.id, c);
    await this.parkOrphans(new Set(names));
  }

  async rekey(ring: KeyRing): Promise<CandidateRekeyReport> {
    let rekeyed = 0;
    let failed = 0;
    const dropped: PendingCandidate[] = [];
    for (const c of this.list()) {
      try {
        const outcome = c.payload.kind === 'rows' ? await this.rekeyRows(c, c.payload, ring) : await sealFile(this.sealIo(), c.payload.path, ring);
        if (outcome === 'unreachable') {
          await this.remove(c);
          dropped.push(c);
        } else if (outcome === 'rekeyed') {
          rekeyed++;
        }
      } catch (err) {
        failed++;
        this.deps.host.logger.error(`${SYNC_LOG_PREFIX} candidate not moved to the new password`, { source: c.source, code: errCode(err) });
      }
    }
    if (dropped.length > 0) this.deps.host.logger.warn(`${SYNC_LOG_PREFIX} candidates no key opens were removed`, { count: dropped.length });
    return { rekeyed, dropped, failed };
  }

  // ---------- internals ----------

  private async rekeyRows(c: PendingCandidate, payload: Extract<PendingPayload, { kind: 'rows' }>, ring: KeyRing): Promise<'rekeyed' | 'current'> {
    if (payload.epochId === ring.current.epochId) return 'current';
    const io = this.sealIo();
    const rows = decodeRows((await io.host.fs.readFile(payload.path)).toString('utf8'));
    await replaceDurably(io, payload.path, encodeRows(rowsUnderRing(rows, payload.epochId, ring, (n) => io.host.random.bytes(n))));
    const next: PendingCandidate = Object.freeze({ ...c, payload: Object.freeze({ ...payload, epochId: ring.current.epochId }) });
    await replaceDurably(io, path.join(this.dir(), metaName(c.id)), encodeMeta(next));
    this.pending.set(c.id, next);
    return 'rekeyed';
  }

  private sealIo(): SealIo {
    return { host: this.deps.host, replica: this.deps.replica, dir: this.dir() };
  }

  private require(id: string): PendingCandidate {
    const c = isCandidateId(id) ? this.pending.get(id) : undefined;
    if (c === undefined) throw new Error(`${SYNC_LOG_PREFIX} unknown candidate`);
    return c;
  }

  private async remember(c: PendingCandidate): Promise<PendingCandidate> {
    await this.deps.host.fs.writeFileDurable(path.join(this.dir(), metaName(c.id)), encodeMeta(c));
    this.pending.set(c.id, c);
    this.deps.host.logger.info(`${SYNC_LOG_PREFIX} candidate queued`, { source: c.source, kind: c.kind });
    return c;
  }

  private async compute(c: PendingCandidate) {
    const { host, replica } = this.deps;
    const payload = c.payload;
    if (payload.kind === 'rows') {
      const rows = decodeRows((await host.fs.readFile(payload.path)).toString('utf8'));
      return computeCandidate({ replica, candidate: c, fileMtimeMs: 0, rows });
    }
    const st = await host.fs.stat(payload.path);
    if (st === null) throw new Error(`${SYNC_LOG_PREFIX} the candidate file is missing`);
    return withOpenedFile(this.sealIo(), payload.path, (plainPath) =>
      computeCandidate({ replica, candidate: { ...c, payload: { ...payload, path: plainPath } }, fileMtimeMs: st.mtimeMs, rows: null }),
    );
  }

  /** Moves a private copy into candidates/ (copy + remove across volumes). */
  private async move(from: string, to: string): Promise<void> {
    const { fs } = this.deps.host;
    try {
      await fs.rename(from, to);
    } catch (err) {
      if (errCode(err) !== 'EXDEV') throw err;
      await fs.copyFile(from, to);
      await fs.rm(from, { recursive: false, force: true });
    }
  }

  private async remove(c: PendingCandidate): Promise<void> {
    const { fs } = this.deps.host;
    this.pending.delete(c.id);
    await fs.rm(path.join(this.dir(), metaName(c.id)), { recursive: false, force: true });
    await fs.rm(c.payload.path, { recursive: false, force: true });
  }

  private async readEntry(id: string): Promise<PendingCandidate | null> {
    const { fs, logger } = this.deps.host;
    const metaPath = path.join(this.dir(), metaName(id));
    let c: PendingCandidate | null = null;
    try {
      c = decodeMeta((await fs.readFile(metaPath)).toString('utf8'), id, this.dir());
      if (c !== null && (await fs.stat(c.payload.path)) === null) c = null;
    } catch (err) {
      logger.warn(`${SYNC_LOG_PREFIX} candidate entry could not be read`, { code: errCode(err) });
      c = null;
    }
    if (c !== null) return c;
    logger.warn(`${SYNC_LOG_PREFIX} a corrupt pending candidate was parked`, { id });
    await this.park([metaPath, path.join(this.dir(), `${id}${FILE_SUFFIX}`), path.join(this.dir(), `${id}${ROWS_SUFFIX}`)]);
    return null;
  }

  /** Payloads whose meta is gone are parked, never deleted (they may hold the only copy of a change). */
  private async parkOrphans(names: ReadonlySet<string>): Promise<void> {
    const orphans: string[] = [];
    for (const name of names) {
      const id = name.endsWith(ROWS_SUFFIX) ? name.slice(0, -ROWS_SUFFIX.length) : name.endsWith(FILE_SUFFIX) ? name.slice(0, -FILE_SUFFIX.length) : null;
      if (id !== null && isCandidateId(id) && !this.pending.has(id) && !names.has(metaName(id))) orphans.push(path.join(this.dir(), name));
    }
    if (orphans.length > 0) await this.park(orphans);
  }

  private async park(files: readonly string[]): Promise<void> {
    const { fs, clock, logger } = this.deps.host;
    const parked = this.deps.replica.paths.parked;
    await fs.mkdir(parked);
    for (const file of files) {
      if ((await fs.stat(file)) === null) continue;
      const target = path.join(parked, `${clock.now()}-${path.basename(file)}`);
      try {
        await fs.rename(file, target);
      } catch (err) {
        logger.error(`${SYNC_LOG_PREFIX} could not park a candidate file`, { file: path.basename(file), code: errCode(err) });
      }
    }
  }
}
