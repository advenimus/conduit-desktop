/**
 * Other copies of the vault in S's folder (spec 5.8, 12 rows 9/20/42): at unlock, on
 * directory change and every 5 minutes, list every `*.conduit` next to S, stage each as a
 * private copy, skip other lineages and ignored SHA-256s, and classify same-lineage copies:
 * 1 in use elsewhere, 2 nothing new, 3 safe provider copy (only uncovered app dots AND a
 * provider conflict name: merged automatically, toast, copy stays in place, SHA ignored),
 * 4 everything else (notice + candidate review). Also the same-device copy prompt. Nothing
 * is moved or deleted without a click ([Move to Trash] = shell.trashItem).
 * Classification lives in copy-scanner-classify.ts.
 */

import path from 'node:path';
import type { CandidateQueuePort } from './candidate-queue.js';
import {
  assessCopy,
  inUseBy,
  type AssessEnv,
  type CopyAssessment,
  type CopyClass,
  type CopyContribution,
  type SameLineageClass,
} from './copy-scanner-classify.js';
import { hasVaultExtension, lineageOfClass, providerConflictPattern, stemOf, type FileBindingPort } from './file-binding.js';
import { merge } from './merge.js';
import type { NoticesPort } from './notices.js';
import { isPublishTempName } from './paths.js';
import type { CommitOutcome, ReplicaPort } from './replica.js';
import type { SharedFilePort, SharedSnapshot } from './shared-file.js';
import type { SnapshotStorePort } from './snapshots.js';
import { loadContent } from './state-store.js';
import { takeMassSnapshot } from './sync-mass-snapshot.js';
import { SYNC_LOG_PREFIX, type SessionSignals, type SyncHost } from './host.js';
import type { ContentSnapshot } from './types.js';

export { copyHostNames, type CopyClass, type CopyContribution } from './copy-scanner-classify.js';
export { isProviderConflictName } from './file-binding-names.js';

export const COPY_SCAN_INTERVAL_MS = 5 * 60 * 1000;
/** ignored_copies keeps the newest SHAs only; a very old ignored copy would simply be offered again. */
export const IGNORED_COPIES_KEEP = 1000;

const TEMP_RAND_BYTES = 6;
const REVIEW_COPY_PREFIX = 'copy-';
const PROVIDER_OF_PATTERN = { 'conflicted-copy': 'dropbox', 'sync-conflict': 'syncthing', 'host-suffix': 'onedrive' } as const;

export interface ScannedCopy {
  readonly path: string;
  readonly name: string;
  readonly sha256: string;
  readonly lineageId: string;
  readonly cls: CopyClass;
  readonly contribution: CopyContribution;
  /** isProviderConflictName() matched. */
  readonly providerPattern: boolean;
  /** Class 1: the device whose file_hint names this copy. */
  readonly inUseBy: string | null;
}

export interface CopyScanResult {
  readonly copies: readonly ScannedCopy[];
  /** Files skipped: other lineage, ignored SHA, unreadable, publish temps. */
  readonly skipped: number;
}

export interface CopyScannerPort {
  /** Read-only scan and classification against the replica's current state. Never merges. */
  scan(): Promise<CopyScanResult>;
  /** Class 3: merge via replica.commitWith, SHA into ignoredCopies, toast 'copy-merged'. */
  mergeSafe(copy: ScannedCopy): Promise<CommitOutcome | null>;
  /** Class 4 / same-device copy [Review...]: stage into the candidate queue; returns the candidate id. */
  queueForReview(copy: ScannedCopy): Promise<string>;
  /** [Ignore this copy]: SHA into ignoredCopies. */
  ignore(sha256: string): void;
  /** [Move to Trash] after a click: shell.trashItem. */
  trash(path: string): Promise<void>;
  /** Last scan result (Sync panel "Other copies of this vault"). */
  last(): CopyScanResult | null;
}

export interface CopyScannerDeps {
  readonly replica: ReplicaPort;
  readonly binding: Pick<FileBindingPort, 'sharedPath' | 'binding'>;
  readonly shared: Pick<SharedFilePort, 'read' | 'classify'>;
  readonly candidates: Pick<CandidateQueuePort, 'addFile'>;
  readonly notices: Pick<NoticesPort, 'toast' | 'list' | 'addFromCapture'>;
  readonly session: Pick<SessionSignals, 'sessions'>;
  readonly host: Pick<SyncHost, 'fs' | 'clock' | 'random' | 'logger' | 'shell'>;
  /** 5.10: an automatic copy merge that deletes or changes many rows is snapshotted first. */
  readonly snapshots: Pick<SnapshotStorePort, 'take' | 'list'>;
}

interface Staged {
  readonly snapshot: SharedSnapshot;
  readonly cls: SameLineageClass;
}

function errCode(err: unknown): string | null {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : null;
}

export class CopyScanner implements CopyScannerPort {
  private lastResult: CopyScanResult | null = null;
  /** SHA -> assessment against W.gen `generation` (absorbing a copy is the expensive part). */
  private readonly cache = new Map<string, { readonly generation: number; readonly assessment: CopyAssessment }>();
  /** SHA -> staged private copy of the last scan (queueForReview copies it). */
  private readonly stagedBySha = new Map<string, string>();

  constructor(private readonly deps: CopyScannerDeps) {}

  async scan(): Promise<CopyScanResult> {
    const sharedPath = this.deps.binding.sharedPath();
    const dir = path.dirname(sharedPath);
    let names: string[];
    try {
      names = [...(await this.deps.host.fs.readdir(dir))].sort();
    } catch (err) {
      this.deps.host.logger.warn(`${SYNC_LOG_PREFIX} copy scanner: listing the shared folder failed`, { code: errCode(err) });
      throw err;
    }
    const ignored = new Set(this.deps.replica.local().ignoredCopies);
    const wContent = this.lazyWContent();
    const copies: ScannedCopy[] = [];
    let skipped = 0;
    const seen = new Set<string>();
    for (const name of names) {
      if (isPublishTempName(name)) {
        skipped++;
        continue;
      }
      if (!hasVaultExtension(name) || (await this.isOwnFile(dir, name, sharedPath))) continue;
      const copy = await this.scanOne(path.join(dir, name), name, ignored, wContent, seen);
      if (copy === null) skipped++;
      else copies.push(copy);
    }
    this.forgetExcept(seen);
    const result: CopyScanResult = Object.freeze({ copies: Object.freeze(copies), skipped });
    this.lastResult = result;
    return result;
  }

  async mergeSafe(copy: ScannedCopy): Promise<CommitOutcome | null> {
    const staged = await this.restage(copy);
    if (staged === null || staged.cls.kind !== 'synced') return null;
    const assessment = assessCopy(copy.name, staged.snapshot, staged.cls, this.assessEnv(this.lazyWContent()));
    const absorbed = assessment.absorbed;
    if (assessment.cls !== 'safe-provider-copy' || absorbed === null) {
      this.deps.host.logger.info(`${SYNC_LOG_PREFIX} copy scanner: a copy is no longer safe to merge automatically`, { cls: assessment.cls });
      return null;
    }
    const { replica } = this.deps;
    const implicit = replica.implicit();
    const w = replica.state();
    await takeMassSnapshot(this.deps, w, merge(w, absorbed, implicit).state, copy.sha256);
    const outcome = replica.commitWith((cur) => merge(cur, absorbed, implicit).state);
    replica.receive(outcome.state);
    this.ignore(copy.sha256);
    const pattern = providerConflictPattern(copy.name, this.ownStem(), () => true);
    this.deps.notices.toast('copy-merged', { name: copy.name, provider: pattern === null ? null : PROVIDER_OF_PATTERN[pattern] });
    this.deps.host.logger.info(`${SYNC_LOG_PREFIX} copy scanner: merged a provider conflict copy`, { sha8: copy.sha256.slice(0, 8) });
    return outcome;
  }

  async queueForReview(copy: ScannedCopy): Promise<string> {
    const { fs, random, logger } = this.deps.host;
    const source = await this.stagedPathFor(copy);
    const tmpDir = this.deps.replica.paths.tmp;
    await fs.mkdir(tmpDir);
    const privateCopy = path.join(tmpDir, `${REVIEW_COPY_PREFIX}${random.bytes(TEMP_RAND_BYTES).toString('hex')}.conduit`);
    await fs.copyFile(source, privateCopy);
    try {
      const pending = await this.deps.candidates.addFile({
        path: privateCopy,
        source: 'copy',
        label: copy.name,
        staleByNature: copy.contribution.presync,
      });
      return pending.id;
    } catch (err) {
      logger.error(`${SYNC_LOG_PREFIX} copy scanner: queueing a copy for review failed`, { code: errCode(err) });
      await fs.rm(privateCopy, { recursive: false, force: true });
      throw err;
    }
  }

  ignore(sha256: string): void {
    this.deps.replica.updateLocal((l) =>
      l.ignoredCopies.includes(sha256) ? l : { ...l, ignoredCopies: [...l.ignoredCopies, sha256].slice(-IGNORED_COPIES_KEEP) },
    );
    this.dropFromLast((c) => c.sha256 === sha256);
  }

  async trash(p: string): Promise<void> {
    const own = [this.deps.binding.sharedPath(), this.deps.binding.binding().sharedPath].map((x) => path.resolve(x).toLowerCase());
    if (own.includes(path.resolve(p).toLowerCase())) {
      throw new Error(`${SYNC_LOG_PREFIX} copy scanner: refusing to trash the bound shared file`);
    }
    try {
      await this.deps.host.shell.trashItem(p);
    } catch (err) {
      this.deps.host.logger.error(`${SYNC_LOG_PREFIX} copy scanner: moving a copy to the Trash failed`, { code: errCode(err) });
      throw err;
    }
    this.deps.host.logger.info(`${SYNC_LOG_PREFIX} copy scanner: moved a copy to the Trash`, { file: path.basename(p) });
    this.dropFromLast((c) => c.path === p);
  }

  last(): CopyScanResult | null {
    return this.lastResult;
  }

  private async scanOne(
    p: string,
    name: string,
    ignored: ReadonlySet<string>,
    wContent: () => ContentSnapshot,
    seen: Set<string>,
  ): Promise<ScannedCopy | null> {
    try {
      const staged = await this.stage(p, ignored);
      if (staged === null) return null;
      const { snapshot, cls } = staged;
      seen.add(snapshot.sha256);
      this.stagedBySha.set(snapshot.sha256, snapshot.stagedPath);
      const assessment = this.cachedAssessment(name, snapshot, cls, wContent);
      const ownBinding = this.deps.binding.binding();
      const user = inUseBy({
        copyName: name,
        copyFileId: cls.kind === 'synced' ? cls.file.fileId : null,
        ownFileId: ownBinding.fileId,
        ownDeviceUuid: this.deps.replica.deviceUuid,
        state: this.deps.replica.state(),
        sessions: this.deps.session.sessions(),
      });
      return {
        path: p,
        name,
        sha256: snapshot.sha256,
        lineageId: this.deps.replica.lineageId,
        cls: user !== null ? 'in-use-elsewhere' : assessment.cls,
        contribution: assessment.contribution,
        providerPattern: assessment.providerPattern,
        inUseBy: user,
      };
    } catch (err) {
      this.deps.host.logger.warn(`${SYNC_LOG_PREFIX} copy scanner: a copy could not be classified`, { file: name, code: errCode(err), name: (err as Error).name });
      return null;
    }
  }

  /** Reads and classifies a copy; null when unreadable, ignored, foreign or of another lineage. */
  private async stage(p: string, ignored: ReadonlySet<string>): Promise<Staged | null> {
    const read = await this.deps.shared.read(p, this.deps.replica.paths.incoming);
    if (read.kind !== 'ok' || ignored.has(read.snapshot.sha256)) return null;
    const cls = this.deps.shared.classify(read.snapshot, { lineageId: null });
    if (cls.kind !== 'synced' && cls.kind !== 'presync') return null;
    if (lineageOfClass(cls) !== this.deps.replica.lineageId) return null;
    return { snapshot: read.snapshot, cls };
  }

  /** Re-reads a scanned copy; null when it changed since the scan. */
  private async restage(copy: ScannedCopy): Promise<Staged | null> {
    const staged = await this.stage(copy.path, new Set());
    if (staged === null || staged.snapshot.sha256 !== copy.sha256) {
      this.deps.host.logger.info(`${SYNC_LOG_PREFIX} copy scanner: a copy changed or vanished since the scan`, { file: copy.name });
      return null;
    }
    return staged;
  }

  private async stagedPathFor(copy: ScannedCopy): Promise<string> {
    const known = this.stagedBySha.get(copy.sha256);
    if (known !== undefined && (await this.deps.host.fs.stat(known)) !== null) return known;
    const staged = await this.restage(copy);
    if (staged === null) throw new Error(`${SYNC_LOG_PREFIX} copy scanner: the copy changed since the scan; scan again`);
    return staged.snapshot.stagedPath;
  }

  private cachedAssessment(name: string, snapshot: SharedSnapshot, cls: SameLineageClass, wContent: () => ContentSnapshot): CopyAssessment {
    const generation = this.deps.replica.generation();
    const hit = this.cache.get(snapshot.sha256);
    if (hit !== undefined && hit.generation === generation) return hit.assessment;
    const assessment = assessCopy(name, snapshot, cls, this.assessEnv(wContent));
    this.cache.set(snapshot.sha256, { generation, assessment });
    return assessment;
  }

  private assessEnv(wContent: () => ContentSnapshot): AssessEnv {
    return { replica: this.deps.replica, ownStem: this.ownStem(), logger: this.deps.host.logger, wContent };
  }

  private lazyWContent(): () => ContentSnapshot {
    let content: ContentSnapshot | null = null;
    return () => (content ??= loadContent(this.deps.replica.database()));
  }

  private ownStem(): string {
    return stemOf(path.basename(this.deps.binding.sharedPath()));
  }

  /** Our own S, also when the listing spells it with another case on a case-insensitive volume. */
  private async isOwnFile(dir: string, name: string, sharedPath: string): Promise<boolean> {
    const ownName = path.basename(sharedPath);
    if (name === ownName) return true;
    if (name.toLowerCase() !== ownName.toLowerCase()) return false;
    const [a, b] = await Promise.all([this.deps.host.fs.stat(path.join(dir, name)), this.deps.host.fs.stat(sharedPath)]);
    return a !== null && b !== null && a.ino === b.ino;
  }

  private forgetExcept(seen: ReadonlySet<string>): void {
    for (const sha of [...this.cache.keys()]) if (!seen.has(sha)) this.cache.delete(sha);
    for (const sha of [...this.stagedBySha.keys()]) if (!seen.has(sha)) this.stagedBySha.delete(sha);
  }

  private dropFromLast(match: (c: ScannedCopy) => boolean): void {
    const last = this.lastResult;
    if (last === null || !last.copies.some(match)) return;
    this.lastResult = Object.freeze({ ...last, copies: Object.freeze(last.copies.filter((c) => !match(c))) });
  }
}
