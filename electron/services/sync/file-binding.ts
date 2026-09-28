/**
 * Binding between a lineage and its shared file (spec 3.1 file_id, 3.2 local.json binding,
 * 5.8 file_hint and location, 5.9, 12 rows 19/20/52/58): file_id adopt or mint, provider kind
 * and location, the 30 s missing-file debounce with a directory listing, automatic rebind only
 * to exactly one same-lineage file with a normal name (with Undo), [Locate...], renaming inside
 * the app, and "make a separate vault": a NEW file with a new lineage, genesis and vault_id
 * written from a chosen state, the original left untouched. Never recreates S at the old path.
 * Split into file-binding-provider.ts, file-binding-names.ts and file-binding-fork.ts.
 */

import path from 'node:path';
import { hasVaultExtension, isConflictLikeName, stemOf } from './file-binding-names.js';
import { fileHintOf } from './file-binding-provider.js';
import { lineageIdFromSalt } from './hashing.js';
import { isErrno, isPublishTempName } from './paths.js';
import type { ReplicaPort } from './replica.js';
import type { SharedClass, SharedFilePort } from './shared-file.js';
import { SYNC_LOG_PREFIX, type SyncHost } from './host.js';
import type { FileBinding, FileHint } from './types.js';

export {
  FILE_NAME_MAX_LEN,
  LOCATION_MAX_LEN,
  fileHintOf,
  locationKind,
  locationOf,
  providerKindOf,
  truncateChars,
  type ProviderKind,
} from './file-binding-provider.js';
export {
  VAULT_EXTENSION,
  hasVaultExtension,
  isConflictLikeName,
  isProviderConflictName,
  providerConflictPattern,
  stemOf,
  type ConflictPattern,
} from './file-binding-names.js';
export { forkAsSeparateVault, type ForkHost, type ForkInput, type ForkResult } from './file-binding-fork.js';

/** 5.9: missing means missing for 30 s of repeated stat calls plus a directory listing. */
export const MISSING_DEBOUNCE_MS = 30_000;

const CASE_INSENSITIVE_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(['win32', 'darwin']);

export type MissingVerdict =
  | { readonly kind: 'present' }
  | { readonly kind: 'waiting'; readonly sinceMs: number }
  | { readonly kind: 'missing'; readonly sinceMs: number };

export type MissingResolution =
  /** The original name came back during the debounce (OneDrive rename dance). */
  | { readonly kind: 'back' }
  /**
   * Exactly one same-lineage file, synced (its sync_state names this lineage) and with a
   * non-conflict name: rebound (toast with [Undo]). A pre-sync match (same salt) is only ever
   * offered in the prompt: an old backup or copy must never be published over without a click (3.1).
   */
  | { readonly kind: 'rebound'; readonly from: string; readonly to: string }
  /** Anything else: [Locate...] [Keep working on this device] [Save a new copy here]. */
  | { readonly kind: 'prompt'; readonly sameLineage: readonly string[] };

export type LocateOutcome =
  | { readonly kind: 'bound'; readonly binding: FileBinding }
  | { readonly kind: 'other-lineage'; readonly lineageId: string | null }
  | { readonly kind: 'unreadable' };

export interface FileBindingPort {
  binding(): FileBinding;
  /** Path of S for every read, publish and watch: the binding's realpath (a symlinked path stays a symlink). */
  sharedPath(): string;
  fileHint(): FileHint;
  /**
   * 3.1: adopt S's sync_state.file_id, or mint a random one when S has none, or when
   * `seenAtOtherPath` (the same file_id is already bound or reported at another path).
   * Persists the binding; the next publish writes it into S.
   */
  ensureFileId(sFileId: string | null, seenAtOtherPath: boolean): FileBinding;
  /** S stat said missing at nowMs. */
  observeMissing(nowMs: number): MissingVerdict;
  observePresent(): void;
  /** After MISSING_DEBOUNCE_MS: list the folder and rebind or prompt (5.9). */
  resolveMissing(): Promise<MissingResolution>;
  /** [Undo] of the last automatic rebind. */
  undoRebind(): Promise<boolean>;
  /** [Locate...]: the user picked a file; must hold this lineage. */
  locate(path: string): Promise<LocateOutcome>;
  /** Renaming inside the app: renames S only (no side files) and updates the binding. */
  renameShared(newName: string): Promise<FileBinding>;
  /** Listener for binding changes (watcher and side-files follow the new path). */
  onChange(listener: (b: FileBinding) => void): () => void;
}

export interface FileBindingDeps {
  readonly replica: Pick<ReplicaPort, 'lineageId' | 'paths' | 'local' | 'updateLocal'>;
  readonly shared: Pick<SharedFilePort, 'read' | 'classify'>;
  readonly host: Pick<SyncHost, 'fs' | 'clock' | 'random' | 'logger' | 'paths'>;
}

type ProbeDeps = Pick<FileBindingDeps, 'shared' | 'host' | 'replica'>;

function errCode(err: unknown): string | null {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : null;
}

function foldFor(platform: NodeJS.Platform): (s: string) => string {
  return CASE_INSENSITIVE_PLATFORMS.has(platform) ? (s) => s.toLowerCase() : (s) => s;
}

/** Lineage a classified file belongs to: sync_state for synced files, the salt for pre-sync ones. */
export function lineageOfClass(cls: SharedClass): string | null {
  if (cls.kind === 'synced') return cls.file.state.lineageId;
  if (cls.kind === 'presync') return cls.meta.salt === null ? null : lineageIdFromSalt(cls.meta.salt);
  if (cls.kind === 'foreign-other') return cls.lineageId;
  return null;
}

/** Reads and classifies a file through a private staged copy; null when it cannot be read. */
async function probeFile(p: string, deps: ProbeDeps): Promise<SharedClass | null> {
  try {
    const read = await deps.shared.read(p, deps.replica.paths.incoming);
    if (read.kind !== 'ok') return null;
    return deps.shared.classify(read.snapshot, { lineageId: null });
  } catch (err) {
    deps.host.logger.warn(`${SYNC_LOG_PREFIX} file binding: probing a file failed`, { file: path.basename(p), code: errCode(err) });
    return null;
  }
}

function existsError(target: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`${SYNC_LOG_PREFIX} file binding: a file named ${path.basename(target)} already exists`);
  err.code = 'EEXIST';
  return err;
}

function requirePlainName(name: string): void {
  if (name === '' || name === '.' || name === '..' || /[\\/]/.test(name) || path.basename(name) !== name) {
    throw new Error(`${SYNC_LOG_PREFIX} file binding: a vault file name must be a plain name`);
  }
}

export class FileBindingTracker implements FileBindingPort {
  private missingSinceMs: number | null = null;
  private previous: FileBinding | null = null;
  /** Folded realpaths whose automatic rebind the user undid: ask instead next time. */
  private readonly declined = new Set<string>();
  private readonly listeners = new Set<(b: FileBinding) => void>();

  constructor(private readonly deps: FileBindingDeps) {}

  binding(): FileBinding {
    const b = this.deps.replica.local().binding;
    if (b === null) throw new Error(`${SYNC_LOG_PREFIX} file binding: this lineage has no bound shared file`);
    return b;
  }

  sharedPath(): string {
    return this.binding().realpath;
  }

  fileHint(): FileHint {
    const { platform, isNetworkPath } = this.deps.host.paths;
    return fileHintOf(this.binding(), platform, (p) => isNetworkPath(p));
  }

  ensureFileId(sFileId: string | null, seenAtOtherPath: boolean): FileBinding {
    const current = this.binding();
    const collides = sFileId === null || sFileId === current.fileId;
    const fileId = seenAtOtherPath ? (collides ? this.deps.host.random.uuid() : current.fileId) : (sFileId ?? current.fileId);
    if (fileId === current.fileId) return current;
    const next: FileBinding = { ...current, fileId };
    this.persist(next, seenAtOtherPath ? 'file-id-minted' : 'file-id-adopted');
    return next;
  }

  observeMissing(nowMs: number): MissingVerdict {
    if (this.missingSinceMs === null) this.missingSinceMs = nowMs;
    const sinceMs = this.missingSinceMs;
    return nowMs - sinceMs >= MISSING_DEBOUNCE_MS ? { kind: 'missing', sinceMs } : { kind: 'waiting', sinceMs };
  }

  observePresent(): void {
    this.missingSinceMs = null;
  }

  async resolveMissing(): Promise<MissingResolution> {
    const current = this.binding();
    const dir = path.dirname(current.realpath);
    const name = path.basename(current.realpath);
    const names = await this.listFolder(dir);
    if (names === null) return this.prompt([], 'folder-missing');
    if (names.some((n) => this.fold(n) === this.fold(name))) {
      this.missingSinceMs = null;
      this.deps.host.logger.info(`${SYNC_LOG_PREFIX} file binding: the shared file came back`, { file: name });
      return { kind: 'back' };
    }
    const same = await findSameLineageMatches(dir, this.deps.replica.lineageId, name, this.deps);
    const only = same.length === 1 && same[0]?.synced === true ? same[0].path : undefined;
    if (only !== undefined && this.mayRebindTo(only, name)) return this.rebindTo(current, only);
    return this.prompt(same.map((m) => m.path), same.length === 0 ? 'none-found' : 'not-automatic');
  }

  async undoRebind(): Promise<boolean> {
    const prev = this.previous;
    if (prev === null) return false;
    const current = this.binding();
    this.previous = null;
    this.declined.add(this.fold(current.realpath));
    this.missingSinceMs = null;
    this.persist(prev, 'rebind-undone');
    return true;
  }

  async locate(picked: string): Promise<LocateOutcome> {
    const cls = await probeFile(picked, this.deps);
    if (cls === null || cls.kind === 'unreadable' || cls.kind === 'foreign-newer') return { kind: 'unreadable' };
    const lineageId = lineageOfClass(cls);
    if (lineageId !== this.deps.replica.lineageId) {
      this.deps.host.logger.warn(`${SYNC_LOG_PREFIX} file binding: the located file holds another vault`, { file: path.basename(picked) });
      return { kind: 'other-lineage', lineageId };
    }
    const current = this.binding();
    const realpath = await this.deps.host.fs.realpath(picked);
    const moved = this.fold(realpath) !== this.fold(current.realpath);
    // The old path still holding this lineage makes the picked file a copy: it needs its own file_id.
    const oldStillHolds = moved && (await this.holdsLineage(current.realpath));
    const sFileId = cls.kind === 'synced' ? cls.file.fileId : null;
    const distinct = sFileId !== null && sFileId !== current.fileId;
    const fileId = oldStillHolds ? (distinct ? sFileId : this.deps.host.random.uuid()) : (sFileId ?? current.fileId);
    const next: FileBinding = { sharedPath: picked, realpath, fileId };
    this.previous = null;
    this.missingSinceMs = null;
    this.declined.delete(this.fold(realpath));
    this.persist(next, 'located');
    return { kind: 'bound', binding: next };
  }

  async renameShared(newName: string): Promise<FileBinding> {
    requirePlainName(newName);
    const current = this.binding();
    const target = path.join(path.dirname(current.realpath), newName);
    if (target === current.realpath) return current;
    const caseOnly = this.fold(target) === this.fold(current.realpath);
    if (!caseOnly && (await this.deps.host.fs.stat(target)) !== null) throw existsError(target);
    try {
      await this.deps.host.fs.rename(current.realpath, target);
    } catch (err) {
      this.deps.host.logger.error(`${SYNC_LOG_PREFIX} file binding: renaming the shared file failed`, { code: errCode(err) });
      throw err;
    }
    const next: FileBinding = { sharedPath: target, realpath: await this.deps.host.fs.realpath(target), fileId: current.fileId };
    this.previous = null;
    this.persist(next, 'renamed');
    return next;
  }

  onChange(listener: (b: FileBinding) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private fold(s: string): string {
    return foldFor(this.deps.host.paths.platform)(s);
  }

  private mayRebindTo(candidate: string, originalName: string): boolean {
    if (this.declined.has(this.fold(candidate))) return false;
    return !isConflictLikeName(path.basename(candidate), stemOf(originalName));
  }

  private async rebindTo(current: FileBinding, target: string): Promise<MissingResolution> {
    const realpath = await this.deps.host.fs.realpath(target);
    this.previous = current;
    this.missingSinceMs = null;
    this.persist({ sharedPath: target, realpath, fileId: current.fileId }, 'rebound');
    return { kind: 'rebound', from: current.realpath, to: realpath };
  }

  private prompt(sameLineage: readonly string[], reason: string): MissingResolution {
    this.deps.host.logger.info(`${SYNC_LOG_PREFIX} file binding: the shared file is missing; asking the user`, {
      reason,
      candidates: sameLineage.length,
    });
    return { kind: 'prompt', sameLineage };
  }

  private async holdsLineage(p: string): Promise<boolean> {
    const cls = await probeFile(p, this.deps);
    return cls !== null && lineageOfClass(cls) === this.deps.replica.lineageId;
  }

  private async listFolder(dir: string): Promise<string[] | null> {
    try {
      return await this.deps.host.fs.readdir(dir);
    } catch (err) {
      if (isErrno(err, 'ENOENT') || isErrno(err, 'ENOTDIR')) return null;
      this.deps.host.logger.error(`${SYNC_LOG_PREFIX} file binding: listing the shared folder failed`, { code: errCode(err) });
      throw err;
    }
  }

  private persist(next: FileBinding, reason: string): void {
    this.deps.replica.updateLocal((l) => ({ ...l, binding: next }));
    this.deps.host.logger.info(`${SYNC_LOG_PREFIX} file binding: binding changed`, { reason, file: path.basename(next.realpath) });
    for (const listener of [...this.listeners]) {
      try {
        listener(next);
      } catch (err) {
        this.deps.host.logger.error(`${SYNC_LOG_PREFIX} file binding: a binding listener failed`, { code: errCode(err) });
      }
    }
  }
}

/** Builds a new binding for a path (realpath + random file_id); no IO besides realpath. */
export async function newBinding(sharedPath: string, host: Pick<SyncHost, 'fs' | 'random'>): Promise<FileBinding> {
  let realpath: string;
  try {
    realpath = await host.fs.realpath(sharedPath);
  } catch (err) {
    if (!isErrno(err, 'ENOENT')) throw err;
    realpath = path.join(await host.fs.realpath(path.dirname(sharedPath)), path.basename(sharedPath));
  }
  return { sharedPath, realpath, fileId: host.random.uuid() };
}

/** A same-lineage file: `synced` when its sync_state names the lineage, false for a pre-sync salt match. */
export interface LineageMatch {
  readonly path: string;
  readonly synced: boolean;
}

/** `*.conduit` files in `dir` (excluding publish temps and `excludeName`) whose lineage is `lineageId`. */
export async function findSameLineageMatches(
  dir: string,
  lineageId: string,
  excludeName: string | null,
  deps: Pick<FileBindingDeps, 'shared' | 'host' | 'replica'>,
): Promise<readonly LineageMatch[]> {
  const fold = foldFor(deps.host.paths.platform);
  const names = [...(await deps.host.fs.readdir(dir))].sort();
  const out: LineageMatch[] = [];
  for (const name of names) {
    if (!hasVaultExtension(name) || isPublishTempName(name)) continue;
    if (excludeName !== null && fold(name) === fold(excludeName)) continue;
    const p = path.join(dir, name);
    const cls = await probeFile(p, deps);
    if (cls === null || (cls.kind !== 'synced' && cls.kind !== 'presync') || lineageOfClass(cls) !== lineageId) continue;
    out.push({ path: p, synced: cls.kind === 'synced' });
  }
  return out;
}

/** Paths of findSameLineageMatches (synced and pre-sync alike). */
export async function findSameLineageFiles(
  dir: string,
  lineageId: string,
  excludeName: string | null,
  deps: Pick<FileBindingDeps, 'shared' | 'host' | 'replica'>,
): Promise<readonly string[]> {
  return (await findSameLineageMatches(dir, lineageId, excludeName, deps)).map((m) => m.path);
}
